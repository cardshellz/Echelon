import { type ShipmentUnitSelection } from "@shared/procurement/shipment-unit-selection";
import { toBasePieces } from "@shared/procurement/unit-quantity";
import { lockShipmentCatalogUnit } from "./shipment-unit-selection.repository";
import { Decimal } from "decimal.js";
import { sql } from "drizzle-orm";
import { auditEvents, type InboundShipment, type InboundShipmentLine, type InsertInboundShipmentLine, type PurchaseOrderLine } from "@shared/schema";
import {
  SHIPMENT_LINE_EDITABLE_FIELDS, SHIPMENT_LINE_IMPORT_LIMIT, shipmentLineDeleteSchema, shipmentLineFromPoSchema, shipmentLineEditableSchema,
  shipmentLinePatchSchema, shipmentLineResolveSchema, shipmentLineResourceIdSchema,
  shipmentPackingListImportSchema, shipmentPackingListRowSchema, type ShipmentPackingListRow, type ShipmentLinePacking,
} from "@shared/procurement/shipment-line-command";
import type { ShipmentLineCommand } from "./shipment-line-commands";
import { shipmentLineVersion, versionShipmentLine } from "./shipment-line-version";
import { ShipmentTrackingError } from "./shipment-tracking.service";
import { computeShipmentLinePhysicalTotals } from "./shipment-line-physical-values";
import { lockShipmentSourceCapacity } from "./shipment-source-capacity";
import { lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import type { ShipmentReceivingSetup } from "@shared/procurement/shipment-receiving-setup";

type Dimensions = Pick<InboundShipmentLine, "weightKg" | "lengthCm" | "widthCm" | "heightCm">;
interface LineStorage {
  getInboundShipmentLineById(id: number, tx?: any): Promise<InboundShipmentLine | undefined>;
  getInboundShipmentLines(id: number, tx?: any): Promise<InboundShipmentLine[]>;
  getPurchaseOrderLines(id: number, tx?: any): Promise<PurchaseOrderLine[]>;
  getPurchaseOrderLineById(id: number, tx?: any): Promise<PurchaseOrderLine | undefined>;
  getPurchaseOrderById(id: number, tx?: any): Promise<{ id: number; vendorId: number } | undefined>;
  getProductVariantById(id: number, tx?: any): Promise<{ id: number; sku: string | null; unitsPerVariant: number } | undefined>;
  bulkCreateInboundShipmentLines(lines: InsertInboundShipmentLine[], tx?: any, now?: Date): Promise<InboundShipmentLine[]>;
  updateInboundShipmentLine(id: number, patch: Partial<InsertInboundShipmentLine>, tx?: any, now?: Date): Promise<InboundShipmentLine | null>;
  deleteInboundShipmentLine(id: number, tx?: any): Promise<boolean>;
}
interface Dependencies {
  storage: LineStorage;
  lockShipment(tx: any, id: number): Promise<InboundShipment>;
  resolveDimensions(variantId: number, vendorId: number | undefined, tx: any): Promise<Dimensions>;
  recomputeTotals(id: number, tx: any, now?: Date): Promise<void>;
  materializePhysicalTotals(tx: any, shipment: InboundShipment, lines: InboundShipmentLine[], now: Date, actorId: string): Promise<void>;
  refreshAllocations(tx: any, id: number, shipment: InboundShipment, now?: Date, actorId?: string): Promise<unknown>;
  checkReceivingSetup(tx: any, shipmentId: number, required: boolean, options?: { previous?: ShipmentReceivingSetup; lockEvidence?: boolean }): Promise<ShipmentReceivingSetup>;
}

function reject(message: string, code: string, status = 409): never {
  throw new ShipmentTrackingError(message, status, { code });
}
function receiveVariant(line: PurchaseOrderLine): number | null {
  return line.expectedReceiveVariantId ?? line.productVariantId ?? null;
}
function hasField(object: object, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, field);
}
function editableValues(body: Record<string, unknown>): Partial<InsertInboundShipmentLine> {
  return Object.fromEntries(SHIPMENT_LINE_EDITABLE_FIELDS.filter((field) => hasField(body, field)).map((field) => [field, body[field]]));
}
function physicalChange(before: InboundShipmentLine, patch: Partial<InsertInboundShipmentLine>): boolean {
  return SHIPMENT_LINE_EDITABLE_FIELDS.filter((field) => field !== "notes").some((field) => {
    if (!hasField(patch, field)) return false;
    const previous = before[field];
    const next = patch[field];
    if (previous == null || next == null) return previous !== next;
    return field === "dimensionBasis" ? previous !== next : !new Decimal(String(previous)).eq(String(next));
  });
}

export async function assertShipmentLineHistoryMutable(tx: any, shipmentId: number) {
  // Receipt provenance can be on the header or directly on a shipment line.
  // Protect both forms, including cancelled receipts and ambiguous source
  // lines, before replacing any part of the shipment's physical history.
  const result = await tx.execute(sql`
    SELECT EXISTS (SELECT 1 FROM procurement.receiving_orders WHERE inbound_shipment_id = ${shipmentId})
      OR EXISTS (SELECT 1 FROM procurement.receiving_lines r
        JOIN procurement.inbound_shipment_lines l ON l.id = r.inbound_shipment_line_id
        WHERE l.inbound_shipment_id = ${shipmentId})
      OR EXISTS (SELECT 1 FROM inventory.inventory_lots WHERE inbound_shipment_id = ${shipmentId})
      OR EXISTS (SELECT 1 FROM procurement.landed_cost_snapshots s
        JOIN procurement.inbound_shipment_lines l ON l.id = s.inbound_shipment_line_id
        WHERE l.inbound_shipment_id = ${shipmentId})
      OR EXISTS (SELECT 1 FROM procurement.landed_cost_adjustments a
        JOIN procurement.inbound_shipment_lines l ON l.id = a.inbound_shipment_line_id
        WHERE l.inbound_shipment_id = ${shipmentId}) AS protected
  `);
  if (result.rows[0]?.protected === true) reject(
    "This shipment has receiving or finalized cost history. Its physical lines cannot be changed here; use the receiving or cost correction workflow.",
    "SHIPMENT_LINE_HISTORY_PROTECTED",
  );
}



export function createShipmentLineMutationOwner(dependencies: Dependencies) {
  const { storage } = dependencies;

  async function lockSourceForRemoval(tx: any, line: InboundShipmentLine) {
    if (!line.purchaseOrderLineId) return;
    const source = await storage.getPurchaseOrderLineById(line.purchaseOrderLineId, tx);
    if (!source) reject("The purchase order line is unavailable. Review its source history.", "SHIPMENT_LINE_SOURCE_REVIEW_REQUIRED");
    await tx.execute(sql`SELECT id FROM procurement.purchase_orders WHERE id = ${source.purchaseOrderId} FOR UPDATE`);
    await tx.execute(sql`SELECT id FROM procurement.purchase_order_lines WHERE id = ${source.id} FOR UPDATE`);
  }

  async function sourceCapacity(tx: any, ids: number[], excludeShipmentLineId?: number) {
    const sources = await Promise.all(ids.map((id) => storage.getPurchaseOrderLineById(id, tx)));
    if (sources.some((line) => !line)) reject("A requested purchase order line was not found.", "SHIPMENT_LINE_REFERENCE_INVALID", 422);
    return lockShipmentSourceCapacity(tx, {
      purchaseOrderIds: [...new Set(sources.map((line) => line!.purchaseOrderId))],
      purchaseOrderLineIds: ids,
      excludeShipmentLineId,
    });
  }

  async function resolveSelection(tx: any, selection: ShipmentUnitSelection, productId: number | null, reviewedPieces?: number) {
    const variant = await lockShipmentCatalogUnit(tx, selection.productVariantId);
    if (!variant || variant.isActive !== true || (productId !== null && variant.productId !== productId)) {
      reject("The selected shipment unit is missing, inactive, or belongs to another product. Refresh the available units.", "SHIPMENT_UNIT_VARIANT_REVIEW_REQUIRED");
    }
    if (variant.unitsPerVariant !== selection.unitsPerVariant) {
      reject("The selected unit's pack factor changed after review. Refresh the available units and review the converted pieces.", "SHIPMENT_UNIT_SOURCE_CHANGED");
    }
    const pieces = toBasePieces(selection.quantity, selection.unitsPerVariant);
    if (reviewedPieces !== undefined && pieces !== reviewedPieces) reject("The selected unit quantity does not match the reviewed piece count.", "SHIPMENT_UNIT_QUANTITY_MISMATCH", 422);
    return { variant, pieces, snapshot: selection.unitsPerVariant };
  }

  async function createFromSource(tx: any, shipmentId: number, source: PurchaseOrderLine, qty: number, selection?: ShipmentUnitSelection, packing?: ShipmentLinePacking): Promise<InsertInboundShipmentLine> {
    if (selection && (!Number.isSafeInteger(source.productId) || Number(source.productId) <= 0)) reject("The purchase line needs a verified product before selecting a shipment unit.", "SHIPMENT_UNIT_PRODUCT_REQUIRED");
    const selected = selection ? await resolveSelection(tx, selection, source.productId, qty) : null;
    const variantId = selected?.variant.id ?? receiveVariant(source);
    const po = await storage.getPurchaseOrderById(source.purchaseOrderId, tx);
    const variant = selected?.variant ?? (variantId ? await storage.getProductVariantById(variantId, tx) : undefined);
    const pack = selected?.snapshot ?? source.expectedReceiveUnitsPerVariant ?? source.unitsPerUom ?? variant?.unitsPerVariant ?? 1;
    if (!Number.isSafeInteger(pack) || pack < 1) reject("The recorded receive pack is invalid. Review the PO line.", "SHIPMENT_LINE_SOURCE_REVIEW_REQUIRED");
    // New reviewed unit entry records contents only. A selected case is not evidence
    // of the physical outer-carton count. Legacy piece-only requests retain their
    // existing initial packaging behavior without changing already stored rows.
    const cartonCount = selected ? null : pack > 1 ? Math.ceil(qty / pack) : null;
    const dimensions = variantId && (!selected || pack === 1)
      ? await dependencies.resolveDimensions(variantId, po?.vendorId, tx)
      : { weightKg: null, lengthCm: null, widthCm: null, heightCm: null };
    // Piece measurements cannot become carton measurements merely by changing
    // the label. A different basis needs its own explicit packing evidence.
    const originalBasis = selected ? "piece" : cartonCount === null ? "piece" : "carton";
    const measured = packing?.dimensionBasis && packing.dimensionBasis !== originalBasis
      ? { weightKg: null, lengthCm: null, widthCm: null, heightCm: null } : dimensions;
    const line = { inboundShipmentId: shipmentId, purchaseOrderId: source.purchaseOrderId, purchaseOrderLineId: source.id,
      productVariantId: variantId, sku: variant?.sku ?? source.sku, qtyShipped: qty, cartonCount,
      unitsPerVariantSnapshot: selected?.snapshot ?? null, dimensionBasis: selected ? "piece" as const : null, ...measured, ...packing };
    const validated = shipmentLineEditableSchema.safeParse({ weightKg: line.weightKg, lengthCm: line.lengthCm, widthCm: line.widthCm, heightCm: line.heightCm,
      qtyShipped: qty, cartonCount: line.cartonCount, dimensionBasis: line.dimensionBasis });
    if (!validated.success) reject("Stored supplier or catalog dimensions cannot be represented on a shipment line. Review their precision and range.", "SHIPMENT_LINE_SOURCE_REVIEW_REQUIRED");
    return { ...line, ...computeShipmentLinePhysicalTotals(line) };
  }

  async function addFromPo(tx: any, shipmentId: number, body: unknown) {
    const data = shipmentLineFromPoSchema.parse(body);
    const candidates = await storage.getPurchaseOrderLines(data.purchaseOrderId, tx);
    const ids = data.lineSelections?.map((selection) => selection.poLineId) ?? data.lineIds ?? candidates.filter((line) => (line.lineType ?? "product") === "product" && ["open", "partially_received"].includes(line.status)).map((line) => line.id);
    if (ids.length > SHIPMENT_LINE_IMPORT_LIMIT) reject("Select at most 500 purchase order lines per command.", "SHIPMENT_LINE_INPUT_INVALID", 400);
    if (ids.length === 0) reject("No purchase order lines were selected.", "SHIPMENT_LINE_INPUT_INVALID", 400);
    if (ids.some((id) => !candidates.some((line) => line.id === id))) reject("A selected line does not belong to this purchase order.", "SHIPMENT_LINE_REFERENCE_INVALID", 422);
    const capacities = await sourceCapacity(tx, ids);
    const existing = await storage.getInboundShipmentLines(shipmentId, tx);
    const selections = new Map(data.lineSelections?.map((selection) => [selection.poLineId, selection]));
    const lines: InsertInboundShipmentLine[] = [];
    for (const id of ids) {
      const existingLine = existing.find((line) => line.purchaseOrderLineId === id);
      if (existingLine) {
        if (data.lineSelections) reject(`This PO line is already in the shipment. Edit shipment line #${existingLine.id} to change its quantity or receive unit.`, "SHIPMENT_LINE_ALREADY_PRESENT");
        continue;
      }
      const capacity = capacities.get(id)!;
      const selected = selections.get(id);
      const qty = selected?.qty ?? capacity.remainingQty;
      if (!data.lineSelections && !data.lineIds && qty === 0) continue;
      if (qty <= 0 || qty > capacity.remainingQty) reject(`PO line ${id} has ${capacity.remainingQty} pieces available for shipment; requested ${qty}.`, "SHIPMENT_LINE_QUANTITY_EXCEEDED");
      lines.push(await createFromSource(tx, shipmentId, capacity.line, qty, selected?.unitSelection, selected?.packing));
    }
    return lines;
  }

  async function importRows(tx: any, shipmentId: number, body: unknown) {
    const { rows } = shipmentPackingListImportSchema.parse(body);
    const errors: Array<{ row: number; error: string; code: string }> = [];
    const valid: Array<{ row: number; value: ShipmentPackingListRow }> = [];
    for (let index = 0; index < rows.length; index++) {
      const parsed = shipmentPackingListRowSchema.safeParse(rows[index]);
      if (!parsed.success) {
        errors.push({ row: index + 1, error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "row"}: ${issue.message}`).join("; "), code: "SHIPMENT_LINE_INPUT_INVALID" });
        continue;
      }
      const value = parsed.data;
      const source = value.purchaseOrderLineId ? await storage.getPurchaseOrderLineById(value.purchaseOrderLineId, tx) : undefined;
      if (value.purchaseOrderLineId && !source) {
        errors.push({ row: index + 1, error: "The supplied purchase order line was not found.", code: "SHIPMENT_LINE_REFERENCE_INVALID" });
        continue;
      }
      valid.push({ row: index + 1, value });
    }
    const sourceIds = [...new Set(valid.flatMap(({ value }) => value.purchaseOrderLineId ? [value.purchaseOrderLineId] : []))].sort((a, b) => a - b);
    const capacities = sourceIds.length ? await sourceCapacity(tx, sourceIds) : new Map();
    const consumed = new Map<number, number>();
    const lines: InsertInboundShipmentLine[] = [];
    for (const { row, value } of valid) {
      try {
        const source = value.purchaseOrderLineId ? capacities.get(value.purchaseOrderLineId) : undefined;
        if (source && value.qtyShipped > source.remainingQty - (consumed.get(source.line.id) ?? 0)) {
          reject(`PO line ${source.line.id} does not have enough remaining pieces for this row.`, "SHIPMENT_LINE_QUANTITY_EXCEEDED");
        }
        if (value.unitSelection && source && (!Number.isSafeInteger(source.line.productId) || Number(source.line.productId) <= 0)) {
          reject("The purchase line needs a verified product before selecting a shipment unit.", "SHIPMENT_UNIT_PRODUCT_REQUIRED");
        }
        const selected = value.unitSelection ? await resolveSelection(tx, value.unitSelection, source?.line.productId ?? null, value.qtyShipped) : null;
        const variantId = selected?.variant.id ?? (source ? receiveVariant(source.line) : value.productVariantId ?? null);
        const variant = selected?.variant ?? (variantId ? await storage.getProductVariantById(variantId, tx) : undefined);
        if ((variantId && !variant) || (value.productVariantId && value.productVariantId !== variantId)
          || ((variant?.sku ?? source?.line.sku) && value.sku && value.sku !== (variant?.sku ?? source?.line.sku))) {
          reject("The purchase receive variant or SKU changed. Review this packing-list row.", "SHIPMENT_LINE_REFERENCE_INVALID", 422);
        }
        const line = {
          ...editableValues(value), inboundShipmentId: shipmentId, purchaseOrderId: source?.line.purchaseOrderId ?? null,
          purchaseOrderLineId: value.purchaseOrderLineId ?? null, productVariantId: variantId,
          sku: value.sku ?? variant?.sku ?? source?.line.sku ?? null, qtyShipped: value.qtyShipped,
          cartonCount: value.cartonCount ?? null, unitsPerVariantSnapshot: selected?.snapshot ?? null,
          dimensionBasis: value.dimensionBasis ?? (selected ? "piece" : null),
        };
        lines.push({ ...line, ...computeShipmentLinePhysicalTotals(line) });
        if (source) consumed.set(source.line.id, (consumed.get(source.line.id) ?? 0) + value.qtyShipped);
      } catch (error) {
        if (!(error instanceof ShipmentTrackingError) || error.statusCode >= 500) throw error;
        errors.push({ row, error: error.message, code: String(error.details?.code ?? "SHIPMENT_LINE_INPUT_INVALID") });
      }
    }
    return { lines, errors: errors.sort((left, right) => left.row - right.row) };
  }

  async function applyLineCommand(tx: any, command: ShipmentLineCommand, actorId: string, now: Date, deferDerivedUpdates = false) {
    shipmentLineResourceIdSchema.parse(command.resourceId);
    if (typeof actorId !== "string" || !actorId.trim()) reject("An authenticated actor is required.", "SHIPMENT_LINE_ACTOR_REQUIRED", 401);
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) reject("A valid command clock is required.", "SHIPMENT_LINE_CLOCK_INVALID", 500);
    // Direct HTTP commands also recalculate allocations. Use graph -> shipment
    // -> PO source order so quantity/value amendments cannot mix source reads.
    await lockInventoryCostGraph(tx);
    const isLine = command.operation === "update" || command.operation === "delete";
    const initial = isLine ? await storage.getInboundShipmentLineById(command.resourceId, tx) : null;
    if (isLine && !initial) reject("Shipment line not found.", "SHIPMENT_LINE_NOT_FOUND", 404);
    const shipmentId = initial?.inboundShipmentId ?? command.resourceId;
    const shipment = await dependencies.lockShipment(tx, shipmentId);
    if (shipment.status === "closed" || shipment.status === "cancelled") reject("Closed or cancelled shipment lines cannot be changed here.", "SHIPMENT_LINE_TERMINAL");
    const guardedSetup = shipment.status === "booked" || shipment.status === "in_transit";
    // This read is only the before/after baseline. Leave source/catalog locking
    // to the write validation, after the PO-capacity locks have been acquired.
    const setupBefore = guardedSetup && !deferDerivedUpdates ? await dependencies.checkReceivingSetup(tx, shipmentId, false, { lockEvidence: false }) : undefined;
    const before = await storage.getInboundShipmentLines(shipmentId, tx);
    const current = isLine ? before.find((line) => line.id === command.resourceId) : null;
    if (isLine && !current) reject("Shipment line not found.", "SHIPMENT_LINE_NOT_FOUND", 404);
    let createdIds: number[] = [];
    let result: unknown;
    let affectsPhysical = true;
    if (command.operation === "update" || command.operation === "delete") {
      const updateData = command.operation === "update" ? shipmentLinePatchSchema.parse(command.body) : null;
      const data = updateData ?? shipmentLineDeleteSchema.parse(command.body);
      if (shipmentLineVersion(current!) !== data.expectedVersion) reject("This shipment line changed since you opened it. Refresh and review the current quantities and dimensions.", "SHIPMENT_LINE_VERSION_CONFLICT");
      const patch: Partial<InsertInboundShipmentLine> = updateData ? editableValues(updateData) : {};
      const selection = updateData?.unitSelection;
      if (selection) {
        const capacity = current!.purchaseOrderLineId ? (await sourceCapacity(tx, [current!.purchaseOrderLineId], current!.id)).get(current!.purchaseOrderLineId)! : null;
        const originalVariant = !capacity && current!.productVariantId ? await lockShipmentCatalogUnit(tx, current!.productVariantId) : null;
        const productId = capacity?.line.productId ?? originalVariant?.productId ?? null;
        if (productId === null) reject("The shipment line has no verified product identity. Review its source before changing its unit.", "SHIPMENT_UNIT_PRODUCT_REQUIRED");
        const selected = await resolveSelection(tx, selection, productId, patch.qtyShipped);
        if (capacity && selected.pieces > capacity.remainingQty) reject(`This PO line has ${capacity.remainingQty} pieces available for this shipment line.`, "SHIPMENT_LINE_QUANTITY_EXCEEDED");
        Object.assign(patch, { qtyShipped: selected.pieces, productVariantId: selected.variant.id,
          unitsPerVariantSnapshot: selected.snapshot, sku: selected.variant.sku ?? current!.sku });
      }
      affectsPhysical = command.operation === "delete" || selection !== undefined || physicalChange(current!, patch);
      if (affectsPhysical) await assertShipmentLineHistoryMutable(tx, shipmentId);
      if (command.operation === "delete") {
        await lockSourceForRemoval(tx, current!);
        if (!await storage.deleteInboundShipmentLine(current!.id, tx)) reject("Shipment line not found.", "SHIPMENT_LINE_NOT_FOUND", 404);
        result = { success: true };
      } else {
        if (patch.qtyShipped !== undefined && patch.qtyShipped !== current!.qtyShipped && current!.purchaseOrderLineId) {
          const capacities = await sourceCapacity(tx, [current!.purchaseOrderLineId], current!.id);
          const remaining = capacities.get(current!.purchaseOrderLineId)!.remainingQty;
          if (patch.qtyShipped > remaining) reject(`This PO line has ${remaining} pieces available for this shipment line.`, "SHIPMENT_LINE_QUANTITY_EXCEEDED");
        }
        const merged = { ...current!, ...patch };
        const updated = await storage.updateInboundShipmentLine(current!.id, {
          ...patch, ...(affectsPhysical ? computeShipmentLinePhysicalTotals(merged) : {}),
        }, tx, now);
        if (!updated) reject("Shipment line not found.", "SHIPMENT_LINE_NOT_FOUND", 404);
      }
    } else {
      await assertShipmentLineHistoryMutable(tx, shipmentId);
      if (command.operation === "add-from-po") {
        const rows = await addFromPo(tx, shipmentId, command.body);
        const created = await storage.bulkCreateInboundShipmentLines(rows, tx, now);
        createdIds = created.map((line) => line.id);
        affectsPhysical = created.length > 0;
      } else if (command.operation === "import") {
        const imported = await importRows(tx, shipmentId, command.body);
        const created = await storage.bulkCreateInboundShipmentLines(imported.lines, tx, now);
        createdIds = created.map((line) => line.id);
        affectsPhysical = created.length > 0;
        result = { imported: created.length, errors: imported.errors };
      } else if (command.operation === "resolve-dimensions") {
        shipmentLineResolveSchema.parse(command.body);
        let updated = 0;
        const reviewRequiredLines: Array<{ lineId: number; code: string; message: string }> = [];
        for (const line of before) {
          const po = line.purchaseOrderId ? await storage.getPurchaseOrderById(line.purchaseOrderId, tx) : undefined;
          const explicitBasis = line.dimensionBasis != null || line.unitsPerVariantSnapshot != null;
          const variant = line.productVariantId ? await lockShipmentCatalogUnit(tx, line.productVariantId) : null;
          const mayFill = !explicitBasis || (line.dimensionBasis === "piece" && variant?.isActive === true && variant.unitsPerVariant === 1);
          if (!mayFill && [line.weightKg, line.lengthCm, line.widthCm, line.heightCm].some((value) => value == null || new Decimal(value).isZero())) {
            reviewRequiredLines.push({ lineId: line.id, code: "SHIPMENT_DIMENSIONS_REQUIRE_PACKING_EVIDENCE",
              message: "Catalog pack dimensions do not establish your shipping-carton dimensions. Enter the measured dimensions and physical carton count on this line." });
          }
          const dimensions = mayFill && line.productVariantId ? await dependencies.resolveDimensions(line.productVariantId, po?.vendorId, tx) : null;
          const patch: Partial<Dimensions> = {};
          for (const field of ["weightKg", "lengthCm", "widthCm", "heightCm"] as const) {
            if ((line[field] == null || new Decimal(line[field]!).isZero()) && dimensions?.[field] != null && new Decimal(dimensions[field]!).isPositive()) patch[field] = dimensions[field];
          }
          const fields = shipmentLineEditableSchema.parse(patch);
          const computed = computeShipmentLinePhysicalTotals({ ...line, ...fields });
          const staleTotals = (["totalWeightKg", "totalVolumeCbm", "chargeableWeightKg"] as const)
            .some((field) => !new Decimal(line[field] ?? "0").eq(computed[field]));
          if (Object.keys(patch).length === 0 && !staleTotals) continue;
          await storage.updateInboundShipmentLine(line.id, { ...fields, ...computed }, tx, now);
          updated++;
        }
        affectsPhysical = updated > 0;
        result = { updated, total: before.length, reviewRequiredLines };
      } else reject("Unsupported shipment line command.", "SHIPMENT_LINE_OPERATION_INVALID", 400);
    }
    if (affectsPhysical && !deferDerivedUpdates) {
      // Drafts may be incomplete. Do not retroactively prevent corrections to
      // delivered history; the operational booking/departure gates own readiness.
      await dependencies.checkReceivingSetup(tx, shipmentId, guardedSetup, { previous: setupBefore });
      await dependencies.materializePhysicalTotals(tx, shipment, await storage.getInboundShipmentLines(shipmentId, tx), now, actorId);
      await dependencies.recomputeTotals(shipmentId, tx, now);
      await dependencies.refreshAllocations(tx, shipmentId, shipment, now, actorId);
    }
    const after = await storage.getInboundShipmentLines(shipmentId, tx);
    await tx.insert(auditEvents).values({
      timestamp: now, level: "AUDIT", actor: actorId, action: `procurement.shipment_line.${command.operation}`,
      target: `shipment:${shipmentId}`, changes: { before, after }, context: { shipmentId, lineId: isLine ? command.resourceId : null },
    });
    if (command.operation === "update") return versionShipmentLine(after.find((line) => line.id === command.resourceId)!);
    const created = after.filter((line) => createdIds.includes(line.id)).map(versionShipmentLine);
    if (command.operation === "add-from-po") return created;
    if (command.operation === "import") return { ...(result as object), lines: created };
    return result;
  }
  async function executeLineCommandInTransaction(tx: any, command: ShipmentLineCommand, actorId: string, now: Date) {
    return applyLineCommand(tx, command, actorId, now);
  }
  /** One editor approval may replace the final line. Recalculate only after the
   * complete set is saved, so an intermediate empty shipment is never allocated. */
  async function executeLineBatchInTransaction(tx: any, shipmentId: number, commands: ShipmentLineCommand[], actorId: string, now: Date) {
    await lockInventoryCostGraph(tx);
    const shipment = await dependencies.lockShipment(tx, shipmentId);
    const guardedSetup = shipment.status === "booked" || shipment.status === "in_transit";
    const setupBefore = guardedSetup ? await dependencies.checkReceivingSetup(tx, shipmentId, false, { lockEvidence: false }) : undefined;
    const results: unknown[] = [];
    for (const command of commands) {
      const line = ["update", "delete"].includes(command.operation) ? await storage.getInboundShipmentLineById(command.resourceId, tx) : null;
      if (line ? line.inboundShipmentId !== shipmentId : command.resourceId !== shipmentId) reject("The edit contains a line from another shipment.", "SHIPMENT_EDITOR_SCOPE");
      results.push(await applyLineCommand(tx, command, actorId, now, true));
    }
    const lines = await storage.getInboundShipmentLines(shipmentId, tx);
    if (!lines.length) reject("A shipment needs at least one line. Cancel the shipment to remove the whole delivery.", "SHIPMENT_EDITOR_EMPTY");
    await dependencies.checkReceivingSetup(tx, shipmentId, guardedSetup, { previous: setupBefore });
    await dependencies.materializePhysicalTotals(tx, shipment, lines, now, actorId);
    await dependencies.recomputeTotals(shipmentId, tx, now);
    await dependencies.refreshAllocations(tx, shipmentId, shipment, now, actorId);
    return results;
  }
  return { executeLineCommandInTransaction, executeLineBatchInTransaction };
}
