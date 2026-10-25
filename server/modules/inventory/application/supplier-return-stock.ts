import { sql } from "drizzle-orm";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  supplierReturnPreviewInputSchema, supplierReturnStockReceiptSchema, type SupplierReturnPreviewInput,
  type SupplierReturnStockPreview, type SupplierReturnStockReceipt,
} from "@shared/procurement/supplier-return";
import { SupplierReturnStockError } from "../domain/supplier-return-stock";
import { costInteger, lockInventoryCostGraph, type CostEvidenceTransaction } from "../infrastructure/cost-evidence.repository";
import { allocateLotQuantityCost } from "../infrastructure/cost-quantity.repository";
import { openOperationalQuantityPosting } from "../infrastructure/operational-quantity-posting";
import { lockSupplierReturnStock, readSupplierReturnStockSnapshot } from "../infrastructure/supplier-return-stock.repository";
import {
  readSupplierReturnInventoryEvidence, recordInitialSupplierReturnCosts, supplierReturnAllocationEvidenceSchema,
} from "../infrastructure/supplier-return-cost.repository";
export { readSupplierReturnStockOptions } from "../infrastructure/supplier-return-stock.repository";
export { readSupplierReturnInventoryEvidence, readSupplierReturnInventoryEvidenceBatch } from "../infrastructure/supplier-return-cost.repository";

export interface ExecuteSupplierReturnStockInput extends SupplierReturnPreviewInput {
  expectedSourceFingerprint: string;
  actorId: string;
  at: Date;
  reason: string;
  commandKey: string;
  requestFingerprint: string;
  assertAuthority: () => Promise<void>;
  createDocument: (preview: SupplierReturnStockPreview) => Promise<{
    returnId: number; returnLines: { id: number; inventoryLotId: number; quantity: number }[];
  }>;
}

export async function previewSupplierReturnStock(tx: CostEvidenceTransaction, input: SupplierReturnPreviewInput): Promise<SupplierReturnStockPreview> {
  return (await readSupplierReturnStockSnapshot(tx, input)).preview;
}

/** The caller owns commit and durable command recovery. Required publication
 * follow-ups commit with the physical return and are delivered by their worker.
 * Document FKs are created only after inventory fences and locks,
 * so this owner never enters a reverse document/stock lock order. */
export async function executeSupplierReturnStock(tx: CostEvidenceTransaction, input: ExecuteSupplierReturnStockInput): Promise<SupplierReturnStockReceipt> {
  const selected = supplierReturnPreviewInputSchema.parse({ vendorId: input.vendorId, lines: input.lines });
  const audit = z.object({
    expectedSourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/), requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    actorId: z.string().trim().min(1).max(100), at: z.date(), reason: z.string().trim().min(3).max(1000),
    commandKey: z.string().min(1).max(200).refine(value => value === value.trim()),
  }).parse(input);
  if (typeof input.assertAuthority !== "function" || typeof input.createDocument !== "function") throw new Error("Supplier return requires its authority and document owners.");
  await tx.execute(sql`SAVEPOINT supplier_return_transaction_context`);
  await tx.execute(sql`RELEASE SAVEPOINT supplier_return_transaction_context`);
  const posting = await openOperationalQuantityPosting(tx);
  await lockInventoryCostGraph(tx);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`supplier_return:${audit.commandKey}`},0))`);
  const existing = (await tx.execute(sql`SELECT id,vendor_id,recorded_by,request_fingerprint,source_fingerprint
    FROM procurement.supplier_returns WHERE command_key=${audit.commandKey}`)).rows;
  await input.assertAuthority();
  if (existing.length > 1) throw new Error("Supplier return command has duplicate immutable receipts.");
  if (existing.length === 1) {
    const header = existing[0];
    if (header.recorded_by !== audit.actorId || header.request_fingerprint !== audit.requestFingerprint
      || header.source_fingerprint !== audit.expectedSourceFingerprint || Number(header.vendor_id) !== selected.vendorId) {
      throw new SupplierReturnStockError("SUPPLIER_RETURN_COMMAND_CONFLICT", "This return request key belongs to another reviewed command.");
    }
    const evidence = await readSupplierReturnInventoryEvidence(tx, costInteger(header.id, "returnId", 1));
    const economic = (lines: readonly { inventoryLotId: number; quantity: number }[]) => canonicalJson([...lines]
      .map(line => ({ inventoryLotId: line.inventoryLotId, quantity: line.quantity })).sort((a, b) => a.inventoryLotId - b.inventoryLotId));
    if (economic(evidence.receipt.lines) !== economic(selected.lines)) throw new Error("Retained supplier return receipt disagrees with its command selections.");
    return { ...evidence.receipt, replayed: true };
  }
  await lockSupplierReturnStock(tx, selected.lines.map(line => line.inventoryLotId));
  // Source/quantity locks may have waited behind a mutation. Recheck the live
  // operator immediately before accepting reviewed evidence and creating rows.
  await input.assertAuthority();
  const snapshot = await readSupplierReturnStockSnapshot(tx, selected);
  if (snapshot.quantityAuthority !== (posting ? "ledger" : "pre_opening")) throw new Error("Supplier return quantity authority changed despite admission fencing.");
  if (snapshot.preview.sourceFingerprint !== audit.expectedSourceFingerprint) {
    throw new SupplierReturnStockError("SUPPLIER_RETURN_SOURCE_STALE", "Stock, reservations or costs changed after review. Review the updated return before recording it.");
  }
  const created = z.object({
    returnId: z.number().int().positive().safe(),
    returnLines: z.array(z.object({ id: z.number().int().positive().safe(), inventoryLotId: z.number().int().positive().safe(),
      quantity: z.number().int().positive().max(2_147_483_647) }).strict()).min(1).max(100),
  }).strict().parse(await input.createDocument(snapshot.preview));
  if (created.returnLines.length !== selected.lines.length || new Set(created.returnLines.map(line => line.id)).size !== selected.lines.length
    || new Set(created.returnLines.map(line => line.inventoryLotId)).size !== selected.lines.length
    || created.returnLines.some(line => !selected.lines.some(source => source.inventoryLotId === line.inventoryLotId && source.quantity === line.quantity))) {
    throw new Error("Supplier return document owner changed the reviewed physical selections.");
  }
  const levelBalances = new Map<number, number>();
  const receiptLines: SupplierReturnStockReceipt["lines"] = [];
  for (const line of snapshot.preview.lines) {
    const recorded = created.returnLines.find(item => item.inventoryLotId === line.inventoryLotId)!;
    const allocation = await allocateLotQuantityCost(tx, line.inventoryLotId, line.quantity, audit.actorId, audit.at, {
      sourceKind: "supplier_return", returnId: created.returnId, returnLineId: recorded.id, sourceFingerprint: audit.expectedSourceFingerprint,
    }, `supplier_return:${created.returnId}:${recorded.id}`);
    if (allocation.id === null || canonicalJson(allocation.intervals) !== canonicalJson(line.intervals)
      || allocation.costs.poMills !== BigInt(line.costs.productMills) || allocation.costs.packagingMills !== BigInt(line.costs.packagingMills)
      || allocation.costs.landedMills !== BigInt(line.costs.landedMills)) throw new Error("Supplier return allocation changed after the locked review.");
    const row = snapshot.rows.get(line.inventoryLotId)!;
    const before = levelBalances.get(line.inventoryLevelId) ?? costInteger(row.level_on_hand, "level.onHand");
    const after = before - line.quantity;
    levelBalances.set(line.inventoryLevelId, after);
    if (posting) await posting.addLot(line.inventoryLotId, { onHand: -line.quantity, reserved: 0, picked: 0, packed: 0 });
    else {
      const updatedLot = (await tx.execute(sql`UPDATE inventory.inventory_lots SET qty_on_hand=qty_on_hand-${line.quantity},
        status=CASE WHEN qty_on_hand=${line.quantity} AND qty_reserved=0 AND qty_picked=0 AND qty_packed=0 THEN 'depleted' ELSE status END
        WHERE id=${line.inventoryLotId} AND qty_on_hand=${costInteger(row.qty_on_hand, "lot.onHand")}
          AND qty_reserved=${costInteger(row.qty_reserved, "lot.reserved")} AND qty_on_hand-qty_reserved>=${line.quantity} RETURNING id`)).rows;
      const updatedLevel = (await tx.execute(sql`UPDATE inventory.inventory_levels SET variant_qty=variant_qty-${line.quantity},updated_at=${audit.at}
        WHERE id=${line.inventoryLevelId} AND variant_qty=${before} AND reserved_qty=${costInteger(row.level_reserved, "level.reserved")}
          AND variant_qty-reserved_qty>=${line.quantity} RETURNING id`)).rows;
      if (updatedLot.length !== 1 || updatedLevel.length !== 1) throw new SupplierReturnStockError("SUPPLIER_RETURN_STOCK_CHANGED", "The selected unreserved stock changed before the return was recorded.");
    }
    const unitMills = (BigInt(line.costs.totalMills) * BigInt(2) + BigInt(line.quantity)) / (BigInt(line.quantity) * BigInt(2));
    const movement = (await tx.execute(sql`INSERT INTO inventory.inventory_transactions
      (product_variant_id,from_location_id,to_location_id,transaction_type,variant_qty_delta,units_per_variant_snapshot,
       variant_qty_before,variant_qty_after,reserved_qty_delta,source_state,target_state,unit_cost_mills,total_cost_mills,
       inventory_lot_id,receiving_order_id,receiving_line_id,reference_type,reference_id,notes,user_id,created_at)
      VALUES (${line.productVariantId},${line.warehouseLocationId},NULL,'supplier_return',${-line.quantity},${line.unitsPerVariant},
        ${posting ? null : before},${posting ? null : after},0,'on_hand','returned_to_supplier',${unitMills.toString()}::bigint,${line.costs.totalMills},
        ${line.inventoryLotId},${line.sourceProof.origin.receivingOrderId},${line.sourceProof.origin.receivingLineId},
        'supplier_return',${String(recorded.id)},${audit.reason},${audit.actorId},${audit.at}) RETURNING id`)).rows[0];
    const inventoryTransactionId = costInteger(movement?.id, "inventoryTransactionId", 1);
    const evidence = supplierReturnAllocationEvidenceSchema.parse({
      contractVersion: 1, sourceFingerprint: audit.expectedSourceFingerprint, requestFingerprint: audit.requestFingerprint,
      quantityAuthority: snapshot.quantityAuthority, previewLine: line,
    });
    const owned = (await tx.execute(sql`INSERT INTO inventory.supplier_return_allocations
      (supplier_return_line_id,inventory_lot_id,inventory_transaction_id,allocation_id,quantity,source_evidence,recorded_by,recorded_at)
      VALUES (${recorded.id},${line.inventoryLotId},${inventoryTransactionId},${allocation.id},${line.quantity},
        ${canonicalJson(evidence)}::jsonb,${audit.actorId},${audit.at}) RETURNING id`)).rows[0];
    const returnAllocationId = costInteger(owned?.id, "returnAllocationId", 1);
    const costs = await recordInitialSupplierReturnCosts(tx, { returnId: created.returnId, returnLineId: recorded.id,
      returnAllocationId, costs: line.costs, actorId: audit.actorId, at: audit.at, reason: audit.reason });
    receiptLines.push({ returnLineId: recorded.id, returnAllocationId, inventoryTransactionId, inventoryLotId: line.inventoryLotId,
      productVariantId: line.productVariantId, warehouseLocationId: line.warehouseLocationId, quantity: line.quantity,
      costQuantityAllocationId: allocation.id, initialCostEntryIds: costs.initialCostEntryIds });
  }
  if (posting) await posting.post({ idempotencyKey: audit.commandKey, kind: "supplier_return", actor: audit.actorId,
    reason: audit.reason, reference: { type: "supplier_return", id: String(created.returnId) }, occurredAt: audit.at.toISOString() });
  for (const variantId of [...new Set(snapshot.preview.lines.map(line => line.productVariantId))].sort((a, b) => a - b)) {
    await tx.execute(sql`INSERT INTO inventory.supplier_return_followups(supplier_return_id,product_variant_id,created_at,next_attempt_at)
      VALUES(${created.returnId},${variantId},${audit.at},${audit.at})`);
  }
  const receipt = supplierReturnStockReceiptSchema.parse({ returnId: created.returnId, commandKey: audit.commandKey,
    sourceFingerprint: audit.expectedSourceFingerprint, actorId: audit.actorId, occurredAt: audit.at.toISOString(), lines: receiptLines, replayed: false });
  // The returned proof is obtained through the same integrity reader used for
  // later detail and retry, before the caller's document/audit transaction commits.
  const verified = await readSupplierReturnInventoryEvidence(tx, created.returnId);
  const ordered = (value: SupplierReturnStockReceipt) => canonicalJson({ ...value, replayed: false,
    lines: [...value.lines].sort((a, b) => a.returnLineId - b.returnLineId) });
  if (ordered(verified.receipt) !== ordered(receipt)) throw new Error("New supplier return receipt failed persisted evidence verification.");
  return receipt;
}
