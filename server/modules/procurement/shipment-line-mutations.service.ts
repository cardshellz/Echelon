import { Decimal } from "decimal.js";
import { sql } from "drizzle-orm";
import { auditEvents, type InboundShipment, type InboundShipmentLine, type InsertInboundShipmentLine, type PurchaseOrderLine } from "@shared/schema";
import {
  SHIPMENT_LINE_EDITABLE_FIELDS, SHIPMENT_LINE_IMPORT_LIMIT, shipmentLineDeleteSchema, shipmentLineFromPoSchema, shipmentLineEditableSchema,
  shipmentLinePatchSchema, shipmentLineResolveSchema, shipmentLineResourceIdSchema,
  shipmentPackingListImportSchema, shipmentPackingListRowSchema, type ShipmentPackingListRow,
} from "@shared/procurement/shipment-line-command";
import type { ShipmentLineCommand } from "./shipment-line-commands";
import { shipmentLineVersion, versionShipmentLine } from "./shipment-line-version";
import { ShipmentTrackingError } from "./shipment-tracking.service";
import { computeShipmentLinePhysicalTotals, validateShipmentPhysicalTotals } from "./shipment-line-physical-values";
import { lockShipmentSourceCapacity } from "./shipment-source-capacity";

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
  refreshAllocations(tx: any, id: number, shipment: InboundShipment, now?: Date): Promise<unknown>;
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
    return !new Decimal(String(previous)).eq(String(next));
  });
}

export async function assertShipmentLineHistoryMutable(tx: any, shipmentId: number) {
  // Receipts have shipment+PO-line provenance, not a shipment-line FK. An
  // immutable history guard must therefore cover the entire shipment,
  // including cancelled receipts and ambiguous duplicate source lines.
  const result = await tx.execute(sql`
    SELECT EXISTS (SELECT 1 FROM procurement.receiving_orders WHERE inbound_shipment_id = ${shipmentId})
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

  async function createFromSource(tx: any, shipmentId: number, source: PurchaseOrderLine, qty: number): Promise<InsertInboundShipmentLine> {
    const variantId = receiveVariant(source);
    const po = await storage.getPurchaseOrderById(source.purchaseOrderId, tx);
    const dimensions = variantId ? await dependencies.resolveDimensions(variantId, po?.vendorId, tx)
      : { weightKg: null, lengthCm: null, widthCm: null, heightCm: null };
    // Prefer the PO's recorded receive factor. Legacy catalog fallback preserves
    // prior create behavior only; later edits never rederive pieces from packs.
    const variant = variantId ? await storage.getProductVariantById(variantId, tx) : undefined;
    const pack = source.expectedReceiveUnitsPerVariant ?? source.unitsPerUom ?? variant?.unitsPerVariant ?? 1;
    if (!Number.isSafeInteger(pack) || pack < 1) reject("The recorded receive pack is invalid. Review the PO line.", "SHIPMENT_LINE_SOURCE_REVIEW_REQUIRED");
    const cartonCount = pack > 1 ? Math.ceil(qty / pack) : null;
    const line = { inboundShipmentId: shipmentId, purchaseOrderId: source.purchaseOrderId, purchaseOrderLineId: source.id,
      productVariantId: variantId, sku: variant?.sku ?? source.sku, qtyShipped: qty, cartonCount, ...dimensions };
    const validated = shipmentLineEditableSchema.safeParse({ ...dimensions, qtyShipped: qty, cartonCount });
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
    const selectionQty = new Map(data.lineSelections?.map((selection) => [selection.poLineId, selection.qty]));
    const lines: InsertInboundShipmentLine[] = [];
    for (const id of ids) {
      if (existing.some((line) => line.purchaseOrderLineId === id)) continue;
      const capacity = capacities.get(id)!;
      const qty = selectionQty.get(id) ?? capacity.remainingQty;
      if (!data.lineSelections && !data.lineIds && qty === 0) continue;
      if (qty <= 0 || qty > capacity.remainingQty) reject(`PO line ${id} has ${capacity.remainingQty} pieces available for shipment; requested ${qty}.`, "SHIPMENT_LINE_QUANTITY_EXCEEDED");
      lines.push(await createFromSource(tx, shipmentId, capacity.line, qty));
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
      const variantId = source ? receiveVariant(source) : value.productVariantId;
      const variant = variantId ? await storage.getProductVariantById(variantId, tx) : undefined;
      if ((value.purchaseOrderLineId && !source) || (variantId && !variant)
        || (source && value.productVariantId && value.productVariantId !== variantId)
        || ((variant?.sku ?? source?.sku) && value.sku && value.sku !== (variant?.sku ?? source?.sku))) {
        errors.push({ row: index + 1, error: "The supplied PO line, receive variant, and SKU do not identify the same available item.", code: "SHIPMENT_LINE_REFERENCE_INVALID" });
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
        const variantId = source ? receiveVariant(source.line) : value.productVariantId ?? null;
        const variant = variantId ? await storage.getProductVariantById(variantId, tx) : undefined;
        // Revalidate source identities after acquiring the PO locks: an
        // amendment may have changed the receive variant since preflight.
        if ((variantId && !variant) || (source && value.productVariantId && value.productVariantId !== variantId)
          || ((variant?.sku ?? source?.line.sku) && value.sku && value.sku !== (variant?.sku ?? source?.line.sku))) {
          reject("The purchase receive variant or SKU changed. Review this packing-list row.", "SHIPMENT_LINE_REFERENCE_INVALID", 422);
        }
        const line = {
          ...editableValues(value), inboundShipmentId: shipmentId, purchaseOrderId: source?.line.purchaseOrderId ?? null,
          purchaseOrderLineId: value.purchaseOrderLineId ?? null, productVariantId: variantId,
          sku: value.sku ?? variant?.sku ?? source?.line.sku ?? null, qtyShipped: value.qtyShipped,
          cartonCount: value.cartonCount ?? null,
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

  async function executeLineCommandInTransaction(tx: any, command: ShipmentLineCommand, actorId: string, now: Date) {
    shipmentLineResourceIdSchema.parse(command.resourceId);
    if (typeof actorId !== "string" || !actorId.trim()) reject("An authenticated actor is required.", "SHIPMENT_LINE_ACTOR_REQUIRED", 401);
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) reject("A valid command clock is required.", "SHIPMENT_LINE_CLOCK_INVALID", 500);
    const isLine = command.operation === "update" || command.operation === "delete";
    const initial = isLine ? await storage.getInboundShipmentLineById(command.resourceId, tx) : null;
    if (isLine && !initial) reject("Shipment line not found.", "SHIPMENT_LINE_NOT_FOUND", 404);
    const shipmentId = initial?.inboundShipmentId ?? command.resourceId;
    const shipment = await dependencies.lockShipment(tx, shipmentId);
    if (shipment.status === "closed" || shipment.status === "cancelled") reject("Closed or cancelled shipment lines cannot be changed here.", "SHIPMENT_LINE_TERMINAL");
    const before = await storage.getInboundShipmentLines(shipmentId, tx);
    const current = isLine ? before.find((line) => line.id === command.resourceId) : null;
    if (isLine && !current) reject("Shipment line not found.", "SHIPMENT_LINE_NOT_FOUND", 404);
    let createdIds: number[] = [];
    let result: unknown;
    let affectsPhysical = true;
    if (command.operation === "update" || command.operation === "delete") {
      const data = command.operation === "update" ? shipmentLinePatchSchema.parse(command.body) : shipmentLineDeleteSchema.parse(command.body);
      if (shipmentLineVersion(current!) !== data.expectedVersion) reject("This shipment line changed since you opened it. Refresh and review the current quantities and dimensions.", "SHIPMENT_LINE_VERSION_CONFLICT");
      const patch = command.operation === "update" ? editableValues(data) : {};
      affectsPhysical = command.operation === "delete" || physicalChange(current!, patch);
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
        for (const line of before) {
          const po = line.purchaseOrderId ? await storage.getPurchaseOrderById(line.purchaseOrderId, tx) : undefined;
          const dimensions = line.productVariantId ? await dependencies.resolveDimensions(line.productVariantId, po?.vendorId, tx) : null;
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
        result = { updated, total: before.length };
      } else reject("Unsupported shipment line command.", "SHIPMENT_LINE_OPERATION_INVALID", 400);
    }
    if (affectsPhysical) {
      validateShipmentPhysicalTotals(await storage.getInboundShipmentLines(shipmentId, tx));
      await dependencies.recomputeTotals(shipmentId, tx, now);
      await dependencies.refreshAllocations(tx, shipmentId, shipment, now);
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
  return { executeLineCommandInTransaction };
}
