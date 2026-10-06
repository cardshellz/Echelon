import { sql } from "drizzle-orm";
import { costInteger, CostEvidenceError, lockInventoryCostGraph, type CostEvidenceTransaction } from "../infrastructure/cost-evidence.repository";
import { openOperationalQuantityPosting } from "../infrastructure/operational-quantity-posting";

/** Removes only the actual newly returned damaged layers from sellable stock.
 * The real return and this quarantine must be in the same owning transaction.
 */
export async function quarantineReturnedStock(tx: CostEvidenceTransaction, input: {
  inventoryLotIds: readonly number[]; productVariantId: number; warehouseLocationId: number;
  quantity: number; actor: string; reason: string; operationKey: string; occurredAt: Date;
}): Promise<void> {
  costInteger(input.productVariantId,"productVariantId",1); costInteger(input.warehouseLocationId,"warehouseLocationId",1);
  costInteger(input.quantity,"quantity",1);
  const ids = [...input.inventoryLotIds].sort((a,b)=>a-b);
  ids.forEach((id)=>costInteger(id,"inventoryLotId",1));
  if (ids.length === 0 || new Set(ids).size !== ids.length || !input.actor.trim() || !input.reason.trim()
    || !input.operationKey.trim() || !Number.isFinite(input.occurredAt.getTime())) {
    throw new CostEvidenceError("RETURN_QUARANTINE_INPUT_INVALID","Quarantine requires exact returned lots and audit identity.");
  }
  await lockInventoryCostGraph(tx);
  const posting = await openOperationalQuantityPosting(tx);
  const levelResult = await tx.execute(sql`SELECT id,variant_qty FROM inventory.inventory_levels
    WHERE product_variant_id=${input.productVariantId} AND warehouse_location_id=${input.warehouseLocationId} FOR UPDATE`);
  const level = levelResult.rows[0];
  const before = costInteger(level?.variant_qty,"inventoryLevel.quantity");
  if (before < input.quantity) throw new CostEvidenceError("RETURN_QUARANTINE_STOCK_CONFLICT","Returned level cannot support the exact quarantine quantity.");
  const lots = await tx.execute(sql`SELECT id,product_variant_id,warehouse_location_id,qty_on_hand,qty_reserved,
    qty_picked,qty_consumed,unit_cost_cents FROM inventory.inventory_lots
    WHERE id IN (SELECT value::integer FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)) ORDER BY id FOR UPDATE`);
  let total = BigInt(0);
  for (const lot of lots.rows) {
    if (Number(lot.product_variant_id) !== input.productVariantId || Number(lot.warehouse_location_id) !== input.warehouseLocationId
      || costInteger(lot.qty_reserved,"lot.reserved") !== 0 || costInteger(lot.qty_picked,"lot.picked") !== 0) {
      throw new CostEvidenceError("RETURN_QUARANTINE_IDENTITY_CONFLICT","Quarantine cannot take another SKU, location or reserved custody.");
    }
    total+=BigInt(costInteger(lot.qty_on_hand,"lot.onHand",1));
  }
  if (lots.rows.length !== ids.length || total !== BigInt(input.quantity)) {
    throw new CostEvidenceError("RETURN_QUARANTINE_STOCK_CONFLICT","Exact returned layers do not match the damaged quantity.");
  }
  let running = before;
  for (const lot of lots.rows) {
    const quantity = costInteger(lot.qty_on_hand,"lot.onHand",1);
    if (posting) await posting.addLot(Number(lot.id),{ onHand: -quantity,reserved: 0,picked: 0,packed: 0 });
    else await tx.execute(sql`UPDATE inventory.inventory_lots SET qty_on_hand=0,qty_consumed=qty_consumed+${quantity},status='depleted' WHERE id=${lot.id}`);
    await tx.execute(sql`INSERT INTO inventory.inventory_transactions
      (product_variant_id,from_location_id,transaction_type,variant_qty_delta,variant_qty_before,variant_qty_after,
       source_state,target_state,inventory_lot_id,unit_cost_cents,reference_type,reference_id,user_id,notes,created_at)
      VALUES (${input.productVariantId},${input.warehouseLocationId},'adjustment',${-quantity},${running},${running-quantity},
        'customer_return','damaged',${lot.id},${costInteger(lot.unit_cost_cents,"unitCostCents")},
        'return_quarantine',${input.operationKey},${input.actor},${input.reason},${input.occurredAt})`);
    running-=quantity;
  }
  if (posting) await posting.post({ idempotencyKey: input.operationKey,kind: "adjust",actor: input.actor,
    reason: input.reason,reference: { type: "return_quarantine",id: input.operationKey },occurredAt: input.occurredAt.toISOString() });
  else await tx.execute(sql`UPDATE inventory.inventory_levels SET variant_qty=${running},updated_at=${input.occurredAt} WHERE id=${level.id}`);
}
