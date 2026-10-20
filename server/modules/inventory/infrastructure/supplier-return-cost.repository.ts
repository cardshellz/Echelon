import { sql } from "drizzle-orm";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  supplierReturnCostAdjustmentSchema, supplierReturnCostEntrySchema, supplierReturnInventoryEvidenceSchema,
  supplierReturnStockPreviewLineSchema, type SupplierReturnCostAdjustment, type SupplierReturnCostTotals,
  type SupplierReturnInventoryEvidence, type SupplierReturnStockPreviewLine,
} from "@shared/procurement/supplier-return";
import { CostEvidenceError, costFingerprint, costInteger, lockInventoryCostGraph, type CostEvidenceTransaction } from "./cost-evidence.repository";
import { readLotCostAllocation } from "./cost-quantity.repository";
import { lotCostsForIntervals, moneyToSafeNumber, type LotCostRecord } from "../domain/lot-cost";
import { assertSupplierReturnCostsEqual, supplierReturnCostComponents, supplierReturnCostField, verifySupplierReturnCostHistory } from "../domain/supplier-return-cost";

export const supplierReturnAllocationEvidenceSchema = z.object({
  contractVersion: z.literal(1), sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/), quantityAuthority: z.enum(["pre_opening", "ledger"]),
  previewLine: supplierReturnStockPreviewLineSchema,
}).strict();
const positive = (value: unknown, field: string) => costInteger(value, field, 1);
const occurredAt = (value: unknown) => z.date().parse(value instanceof Date ? value : new Date(String(value))).toISOString();
export const initialSupplierReturnCostPostingKey = (returnId: number, returnLineId: number) => `supplier_return:${returnId}:${returnLineId}:initial`;

function costEntry(row: Record<string, unknown>) {
  return supplierReturnCostEntrySchema.parse({
    id: positive(row.id, "entryId"), returnAllocationId: positive(row.return_allocation_id, "returnAllocationId"), component: row.component,
    previousMills: costInteger(row.previous_mills, "previousMills"), nextMills: costInteger(row.next_mills, "nextMills"),
    deltaMills: costInteger(row.delta_mills, "deltaMills", -Number.MAX_SAFE_INTEGER), postingKey: row.posting_key, reason: row.reason,
    sourceRevisionId: row.source_revision_id == null ? null : positive(row.source_revision_id, "sourceRevisionId"),
    applicationId: row.application_id == null ? null : positive(row.application_id, "applicationId"),
    recordedBy: row.recorded_by, recordedAt: occurredAt(row.recorded_at),
  });
}

export async function recordInitialSupplierReturnCosts(tx: CostEvidenceTransaction, input: {
  returnId: number; returnLineId: number; returnAllocationId: number; costs: SupplierReturnCostTotals; actorId: string; at: Date; reason: string;
}) {
  const entries = [];
  for (const component of supplierReturnCostComponents) {
    const amount = input.costs[supplierReturnCostField[component]];
    const rows = (await tx.execute(sql`INSERT INTO inventory.supplier_return_cost_entries
      (return_allocation_id,component,previous_mills,next_mills,delta_mills,posting_key,reason,recorded_by,recorded_at)
      VALUES (${input.returnAllocationId},${component},0,${amount},${amount},
        ${initialSupplierReturnCostPostingKey(input.returnId, input.returnLineId)},${input.reason},${input.actorId},${input.at}) RETURNING *`)).rows;
    entries.push(costEntry(rows[0]));
  }
  return verifySupplierReturnCostHistory(input.returnAllocationId, input.costs, entries);
}

/** One bounded ledger reader serves detail, list and command replay. Stored
 * snapshots are verified against the actual immutable allocation and movement. */
async function readInventoryEvidenceBatch(tx: CostEvidenceTransaction, rawIds: readonly number[]): Promise<Map<number, SupplierReturnInventoryEvidence>> {
  const ids = z.array(z.number().int().positive().safe()).max(100).parse(rawIds);
  if (new Set(ids).size !== ids.length) throw new Error("Supplier return evidence IDs must be unique.");
  if (ids.length === 0) return new Map();
  const headers = (await tx.execute(sql`SELECT * FROM procurement.supplier_returns WHERE id=ANY(${sql.param(ids)}::integer[]) ORDER BY id`)).rows;
  const rows = (await tx.execute(sql`
    SELECT line.*,owned.id AS return_allocation_id,owned.allocation_id,owned.inventory_transaction_id,
      owned.inventory_lot_id AS owned_lot_id,owned.quantity AS owned_quantity,owned.source_evidence,
      owned.recorded_by AS allocation_actor,owned.recorded_at AS allocation_at,
      custody.inventory_lot_id AS custody_lot_id,custody.quantity AS custody_quantity,custody.direction,custody.intervals,
      custody.source_evidence AS custody_evidence,
      movement.transaction_type,movement.reference_type,movement.reference_id,movement.variant_qty_delta,
      movement.product_variant_id AS movement_variant_id,movement.inventory_lot_id AS movement_lot_id,
      movement.from_location_id,movement.to_location_id,movement.units_per_variant_snapshot,
      movement.source_state,movement.target_state,movement.user_id,movement.created_at,movement.voided_at,
      movement.variant_qty_before,movement.variant_qty_after,
      EXISTS(SELECT 1 FROM inventory.lot_cost_quantity_allocations reversal WHERE reversal.reverses_allocation_id=custody.id) AS reversed
    FROM procurement.supplier_return_lines line
    LEFT JOIN inventory.supplier_return_allocations owned ON owned.supplier_return_line_id=line.id
    LEFT JOIN inventory.lot_cost_quantity_allocations custody ON custody.id=owned.allocation_id
    LEFT JOIN inventory.inventory_transactions movement ON movement.id=owned.inventory_transaction_id
    WHERE line.supplier_return_id=ANY(${sql.param(ids)}::integer[]) ORDER BY line.supplier_return_id,line.id LIMIT 10001
  `)).rows;
  if (rows.length > 10_000) throw new Error("Supplier return evidence exceeds its complete bounded line read.");
  const allocationIds = rows.map(row => positive(row.return_allocation_id, "returnAllocationId"));
  const entryRows = (await tx.execute(sql`SELECT * FROM inventory.supplier_return_cost_entries
    WHERE return_allocation_id=ANY(${sql.param(allocationIds)}::bigint[]) ORDER BY return_allocation_id,id LIMIT 1000001`)).rows;
  if (entryRows.length > 1_000_000) throw new Error("Supplier return value history exceeds its bounded read.");
  const entriesByAllocation = new Map<number, ReturnType<typeof costEntry>[]>();
  for (const raw of entryRows) {
    const entry = costEntry(raw);
    const entries = entriesByAllocation.get(entry.returnAllocationId) ?? [];
    entries.push(entry);
    if (entries.length > 10_000) throw new Error("Supplier return line value history exceeds its bounded read.");
    entriesByAllocation.set(entry.returnAllocationId, entries);
  }
  const commandKeys = headers.map(header => String(header.command_key));
  const needsLedger = rows.some(row => supplierReturnAllocationEvidenceSchema.parse(row.source_evidence).quantityAuthority === "ledger");
  const commands = needsLedger ? (await tx.execute(sql`SELECT command.idempotency_key,command.kind,command.actor,command.reference_type,command.reference_id,command.request_payload,
    (SELECT jsonb_agg(jsonb_build_object('inventoryLotId',entry.inventory_lot_id,'inventoryLevelId',entry.inventory_level_id,
      'productVariantId',entry.product_variant_id,'warehouseLocationId',entry.warehouse_location_id,'warehouseId',entry.warehouse_id,
      'onHand',entry.on_hand_delta,'reserved',entry.reserved_delta,'picked',entry.picked_delta,'packed',entry.packed_delta) ORDER BY entry.inventory_lot_id)
      FROM inventory.quantity_entries entry WHERE entry.command_id=command.id) AS entries
    FROM inventory.quantity_commands command WHERE command.idempotency_key=ANY(${sql.param(commandKeys)}::text[])`)).rows : [];
  const commandByKey = new Map(commands.map(command => [String(command.idempotency_key), command]));
  const output = new Map<number, SupplierReturnInventoryEvidence>();
  for (const header of headers) {
    const returnId = positive(header.id, "returnId");
    const selected = rows.filter(row => Number(row.supplier_return_id) === returnId);
    if (selected.length === 0 || selected.length > 100) throw new Error("Supplier return has incomplete recorded line evidence.");
    const receiptLines = [];
    const valueLines = [];
    let authority: "pre_opening" | "ledger" | undefined;
    for (const row of selected) {
      const line = supplierReturnStockPreviewLineSchema.parse(row.source_snapshot);
      const evidence = supplierReturnAllocationEvidenceSchema.parse(row.source_evidence);
      const origin = line.sourceProof.origin;
      const returnLineId = positive(row.id, "returnLineId"), returnAllocationId = positive(row.return_allocation_id, "returnAllocationId");
      if (evidence.sourceFingerprint !== header.source_fingerprint || evidence.requestFingerprint !== header.request_fingerprint
        || canonicalJson(evidence.previewLine) !== canonicalJson(line)
        || origin.vendorId !== Number(header.vendor_id) || Number(row.inventory_lot_id) !== line.inventoryLotId
        || Number(row.inventory_level_id) !== line.inventoryLevelId || Number(row.warehouse_location_id) !== line.warehouseLocationId
        || Number(row.warehouse_id) !== line.warehouseId || Number(row.product_id) !== line.productId || Number(row.product_variant_id) !== line.productVariantId
        || Number(row.purchase_order_id) !== origin.purchaseOrderId || Number(row.purchase_order_line_id) !== origin.purchaseOrderLineId
        || Number(row.receiving_order_id) !== origin.receivingOrderId || Number(row.receiving_line_id) !== origin.receivingLineId
        || Number(row.origin_lot_id) !== origin.inventoryLotId || Number(row.quantity) !== line.quantity
        || Number(row.units_per_variant) !== line.unitsPerVariant || Number(row.base_pieces) !== line.basePieces
        || Number(row.owned_lot_id) !== line.inventoryLotId || Number(row.owned_quantity) !== line.quantity
        || Number(row.custody_lot_id) !== line.inventoryLotId || Number(row.custody_quantity) !== line.quantity
        || Number(row.direction) !== 1 || row.reversed === true || canonicalJson(row.intervals) !== canonicalJson(line.intervals)
        || row.allocation_actor !== header.recorded_by || occurredAt(row.allocation_at) !== occurredAt(header.recorded_at)
        || row.transaction_type !== "supplier_return" || row.reference_type !== "supplier_return" || row.reference_id !== String(returnLineId)
        || Number(row.variant_qty_delta) !== -line.quantity || Number(row.movement_variant_id) !== line.productVariantId
        || Number(row.movement_lot_id) !== line.inventoryLotId || Number(row.from_location_id) !== line.warehouseLocationId || row.to_location_id !== null
        || Number(row.units_per_variant_snapshot) !== line.unitsPerVariant || row.source_state !== "on_hand" || row.target_state !== "returned_to_supplier"
        || row.user_id !== header.recorded_by || occurredAt(row.created_at) !== occurredAt(header.recorded_at) || row.voided_at !== null
        || authority !== undefined && authority !== evidence.quantityAuthority) {
        throw new Error("Retained supplier return source, quantity and physical movement evidence conflict.");
      }
      const custodyEvidence = z.object({ sourceKind: z.literal("supplier_return"), returnId: z.number(), returnLineId: z.number(),
        sourceFingerprint: z.string() }).strict().parse(row.custody_evidence);
      if (custodyEvidence.returnId !== returnId || custodyEvidence.returnLineId !== returnLineId || custodyEvidence.sourceFingerprint !== header.source_fingerprint) {
        throw new Error("Supplier return allocation belongs to a different command.");
      }
      authority = evidence.quantityAuthority;
      if (authority === "pre_opening") {
        const before = costInteger(row.variant_qty_before, "return.before");
        if (before - line.quantity !== costInteger(row.variant_qty_after, "return.after")) throw new Error("Supplier return physical counter evidence conflicts.");
      } else if (row.variant_qty_before !== null || row.variant_qty_after !== null) throw new Error("Ledger return contains conflicting legacy quantity authority.");
      const history = verifySupplierReturnCostHistory(returnAllocationId, line.costs, entriesByAllocation.get(returnAllocationId) ?? []);
      for (const component of supplierReturnCostComponents) {
        const first = history.entries.find(entry => entry.id === history.initialCostEntryIds[component])!;
        if (first.postingKey !== initialSupplierReturnCostPostingKey(returnId, returnLineId)
          || first.recordedBy !== header.recorded_by || first.recordedAt !== occurredAt(header.recorded_at)
          || first.sourceRevisionId !== null || first.applicationId !== null) throw new Error("Supplier return initial cost evidence conflicts.");
      }
      receiptLines.push({ returnLineId, returnAllocationId, inventoryTransactionId: positive(row.inventory_transaction_id, "inventoryTransactionId"),
        inventoryLotId: line.inventoryLotId, productVariantId: line.productVariantId, warehouseLocationId: line.warehouseLocationId,
        quantity: line.quantity, costQuantityAllocationId: positive(row.allocation_id, "allocationId"), initialCostEntryIds: history.initialCostEntryIds });
      valueLines.push({ returnLineId, currentCosts: history.currentCosts, costEntries: history.entries });
    }
    if (authority === "ledger") {
      const command = commandByKey.get(String(header.command_key));
      const movements = z.array(z.object({ inventoryLotId: z.number(), delta: z.object({ onHand: z.number(), reserved: z.number(), picked: z.number(), packed: z.number() }) }).passthrough())
        .parse(command?.request_payload?.movements);
      if (!command || command.kind !== "supplier_return" || command.actor !== header.recorded_by
        || command.reference_type !== "supplier_return" || command.reference_id !== String(returnId) || movements.length !== receiptLines.length
        || new Set(movements.map(row => row.inventoryLotId)).size !== movements.length
        || receiptLines.some(line => !movements.some(movement => movement.inventoryLotId === line.inventoryLotId
          && movement.delta.onHand === -line.quantity && movement.delta.reserved === 0 && movement.delta.picked === 0 && movement.delta.packed === 0))) {
        throw new Error("Supplier return lacks its original quantity ledger command.");
      }
      const posted = z.array(z.object({ inventoryLotId: z.number(), inventoryLevelId: z.number(), productVariantId: z.number(),
        warehouseLocationId: z.number(), warehouseId: z.number(), onHand: z.number(), reserved: z.number(), picked: z.number(), packed: z.number() }).strict())
        .parse(command.entries);
      if (posted.length !== selected.length || new Set(posted.map(entry => entry.inventoryLotId)).size !== posted.length
        || selected.some(row => !posted.some(entry => entry.inventoryLotId === Number(row.inventory_lot_id)
          && entry.inventoryLevelId === Number(row.inventory_level_id) && entry.productVariantId === Number(row.product_variant_id)
          && entry.warehouseLocationId === Number(row.warehouse_location_id) && entry.warehouseId === Number(row.warehouse_id)
          && entry.onHand === -Number(row.quantity) && entry.reserved === 0 && entry.picked === 0 && entry.packed === 0))) {
        throw new Error("Supplier return quantity journal entries do not match its physical receipt.");
      }
    }
    output.set(returnId, supplierReturnInventoryEvidenceSchema.parse({ receipt: {
      returnId, commandKey: header.command_key, sourceFingerprint: header.source_fingerprint, actorId: header.recorded_by,
      occurredAt: occurredAt(header.recorded_at), lines: receiptLines, replayed: false,
    }, lines: valueLines }));
  }
  return output;
}

export async function readSupplierReturnInventoryEvidenceBatch(tx: CostEvidenceTransaction, ids: readonly number[]) {
  try { return await readInventoryEvidenceBatch(tx, ids); }
  catch (error) {
    if (error instanceof CostEvidenceError) throw new Error("Retained supplier return evidence failed integrity validation.", { cause: error });
    throw error;
  }
}

export async function readSupplierReturnInventoryEvidence(tx: CostEvidenceTransaction, returnId: number) {
  const result = (await readSupplierReturnInventoryEvidenceBatch(tx, [returnId])).get(returnId);
  if (!result) throw new Error("Recorded supplier return does not exist.");
  return result;
}

/** Revalue the same immutable returned intervals, separately from sales COGS.
 * No credit entitlement, loss, reimbursement or cash movement is created. */
async function revalueReturnedIntervals(tx: CostEvidenceTransaction, input: {
  previousLot: LotCostRecord & { id: unknown }; nextLot: LotCostRecord & { id: unknown };
  actorId: string; at: Date; reason: string; sourceRevisionId?: number;
}): Promise<SupplierReturnCostAdjustment[]> {
  const lotId = positive(input.previousLot.id, "lotId");
  if (lotId !== positive(input.nextLot.id, "nextLotId") || !input.actorId.trim() || !input.reason.trim()
    || !(input.at instanceof Date) || !Number.isFinite(input.at.getTime())) throw new Error("Supplier return revaluation requires exact lot and audit identity.");
  await lockInventoryCostGraph(tx);
  const rows = (await tx.execute(sql`SELECT owned.*,line.supplier_return_id,
    EXISTS(SELECT 1 FROM inventory.lot_cost_quantity_allocations reversal WHERE reversal.reverses_allocation_id=owned.allocation_id) AS has_reversal
    FROM inventory.supplier_return_allocations owned
    JOIN procurement.supplier_return_lines line ON line.id=owned.supplier_return_line_id
    WHERE owned.inventory_lot_id=${lotId} ORDER BY owned.id LIMIT 10001`)).rows;
  if (rows.length > 10_000) throw new Error("Supplier return revaluation exceeds its bounded allocation read.");
  if (rows.length === 0) return [];
  const ids = rows.map(row => positive(row.id, "returnAllocationId"));
  const entries = (await tx.execute(sql`SELECT * FROM inventory.supplier_return_cost_entries
    WHERE return_allocation_id=ANY(${sql.param(ids)}::bigint[]) ORDER BY return_allocation_id,id LIMIT 1000001`)).rows.map(costEntry);
  if (entries.length > 1_000_000) throw new Error("Supplier return revaluation exceeds its bounded cost history read.");
  const adjustments: SupplierReturnCostAdjustment[] = [];
  const amounts = (lot: LotCostRecord, intervals: Parameters<typeof lotCostsForIntervals>[1]): SupplierReturnCostTotals => {
    const values = lotCostsForIntervals(lot, intervals);
    return { productMills: moneyToSafeNumber(values.poMills, "productMills"), packagingMills: moneyToSafeNumber(values.packagingMills, "packagingMills"),
      landedMills: moneyToSafeNumber(values.landedMills, "landedMills"), totalMills: moneyToSafeNumber(values.totalMills, "totalMills") };
  };
  for (const row of rows) {
    const returnAllocationId = positive(row.id, "returnAllocationId");
    const evidence = supplierReturnAllocationEvidenceSchema.parse(row.source_evidence);
    const allocation = await readLotCostAllocation(tx, positive(row.allocation_id, "allocationId"));
    if (row.has_reversal !== false || allocation.inventory_lot_id !== lotId || allocation.direction !== 1 || allocation.quantity !== Number(row.quantity)
      || canonicalJson(allocation.intervals) !== canonicalJson(evidence.previewLine.intervals)) throw new Error("Returned value allocation no longer identifies its recorded intervals.");
    const history = verifySupplierReturnCostHistory(returnAllocationId, evidence.previewLine.costs,
      entries.filter(entry => entry.returnAllocationId === returnAllocationId));
    assertSupplierReturnCostsEqual(history.currentCosts, amounts(input.previousLot, allocation.intervals));
    const next = amounts(input.nextLot, allocation.intervals);
    for (const component of supplierReturnCostComponents) {
      const prior = history.latest.get(component)!;
      const afterMills = next[supplierReturnCostField[component]];
      if (prior.nextMills === afterMills) continue;
      const postingKey = costFingerprint({ returnAllocationId, priorEntryId: prior.id, component, afterMills, reason: input.reason,
        sourceRevisionId: input.sourceRevisionId ?? null });
      const inserted = (await tx.execute(sql`INSERT INTO inventory.supplier_return_cost_entries
        (return_allocation_id,component,previous_mills,next_mills,delta_mills,posting_key,reason,source_revision_id,recorded_by,recorded_at)
        VALUES (${returnAllocationId},${component},${prior.nextMills},${afterMills},${afterMills - prior.nextMills},${postingKey},
          ${input.reason},${input.sourceRevisionId ?? null},${input.actorId},${input.at}) RETURNING id`)).rows[0];
      adjustments.push(supplierReturnCostAdjustmentSchema.parse({
        entryId: positive(inserted?.id, "entryId"), returnId: positive(row.supplier_return_id, "returnId"),
        returnLineId: positive(row.supplier_return_line_id, "returnLineId"), returnAllocationId, inventoryLotId: lotId,
        costQuantityAllocationId: allocation.id, quantity: allocation.quantity, component,
        beforeMills: prior.nextMills, afterMills, deltaMills: afterMills - prior.nextMills, postingKey,
      }));
    }
  }
  return adjustments;
}

export async function revalueSupplierReturnAllocations(
  tx: CostEvidenceTransaction,
  input: Parameters<typeof revalueReturnedIntervals>[1],
): Promise<SupplierReturnCostAdjustment[]> {
  try { return await revalueReturnedIntervals(tx, input); }
  catch (error) {
    // Corrupt retained evidence is an infrastructure/integrity incident. It must
    // roll back cost changes and remain retryable, never permanently reject a
    // supplier command as though the operator supplied invalid input.
    if (error instanceof CostEvidenceError) throw new Error("Retained supplier return value failed integrity validation.", { cause: error });
    throw error;
  }
}
