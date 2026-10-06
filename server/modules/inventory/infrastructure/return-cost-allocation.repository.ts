import { sql } from "drizzle-orm";
import type { CostSourceRevision } from "@shared/procurement/cost-source-contracts";
import { resolveCost } from "../cost-resolver";
import { normalizeLotCosts, recordedUnitCostMills, lotCostNeedsReview, type LotCosts } from "../domain/lot-cost";
import { costInteger, CostEvidenceError, type CostEvidenceTransaction } from "./cost-evidence.repository";
import { returnableCostQuantities, ReturnCostQuantityError } from "../domain/return-cost-quantity";

export interface ReturnCostAllocationInput {
  wmsOrderId: number;
  wmsOrderItemId: number | null;
  productVariantId: number;
  quantity: number;
}
export interface ReturnCostLayer {
  quantity: number;
  sourceOrderItemCostId: number | null;
  sourceLotId: number | null;
  costs: LotCosts | null;
  evidenceState: CostSourceRevision["evidence"];
  sourceEvidence: Record<string, unknown>;
}
type ReturnCostExecutor = CostEvidenceTransaction & { select: (...args: any[]) => any };

/** Cost allocation only. The caller owns the graph lock, return authorization,
 * location/stock transaction and stable physical command. OMS identifiers never
 * enter the WMS COGS lookup; repeated SKU lines remain distinct.
 */
export async function allocateReturnCosts(tx: ReturnCostExecutor, input: ReturnCostAllocationInput): Promise<ReturnCostLayer[]> {
  for (const [field,value] of Object.entries(input)) if (value !== null) costInteger(value,field,1);
  const result = input.wmsOrderItemId === null ? { rows: [] } : await tx.execute(sql`
    SELECT cost.* FROM oms.order_item_costs cost
    WHERE cost.order_id=${input.wmsOrderId} AND cost.order_item_id=${input.wmsOrderItemId}
      AND cost.product_variant_id=${input.productVariantId} ORDER BY cost.id FOR UPDATE
  `);
  const costQuantities = result.rows.map(cost => ({ id: costInteger(cost.id,"sourceOrderItemCostId",1),
    inventoryLotId: costInteger(cost.inventory_lot_id,"sourceLotId",1), quantity: signedQuantity(cost.qty),
    unitMills: recordedUnitCostMills(cost) }));
  const negativeIds = costQuantities.filter(cost => cost.quantity < 0).map(cost => cost.id);
  const reversalResult = negativeIds.length === 0 ? { rows: [] } : await tx.execute(sql`
    SELECT reversal.order_item_cost_id AS negative_cost_id, original.order_item_cost_id AS original_cost_id, reversal.quantity
    FROM inventory.availability_claim_pick_movements reversal
    JOIN inventory.availability_claim_pick_movements original ON original.id=reversal.reverses_pick_movement_id
    WHERE reversal.order_item_cost_id IN (${sql.join(negativeIds.map(id=>sql`${id}`),sql`, `)})
      AND reversal.movement_type='unpick' AND original.movement_type='pick'
  `);
  let available: Map<number, number>;
  try {
    available = returnableCostQuantities(costQuantities,reversalResult.rows.map(row=>({
      negativeCostId: costInteger(row.negative_cost_id,"negativeCostId",1),
      originalCostId: costInteger(row.original_cost_id,"originalCostId",1), quantity: costInteger(row.quantity,"unpickQuantity",1),
    })));
  } catch (error) {
    if (error instanceof ReturnCostQuantityError) throw new CostEvidenceError(error.code,error.message);
    throw error;
  }
  const layers: ReturnCostLayer[] = [];
  let remaining = input.quantity;
  for (const cost of result.rows) {
    if (remaining === 0) break;
    const costId = costInteger(cost.id,"sourceOrderItemCostId",1);
    const soldQty = available.get(costId);
    if (soldQty === undefined) continue;
    const prior = await tx.execute(sql`SELECT COALESCE(SUM(quantity),0) AS quantity
      FROM inventory.return_cost_allocations WHERE source_order_item_cost_id=${costId}`);
    const returnedQty = costInteger(prior.rows[0]?.quantity,"returnedQuantity");
    if (returnedQty > soldQty) throw new CostEvidenceError("RETURN_COST_ALLOCATION_CONFLICT", "Recorded return allocations exceed this exact sold lot.");
    const take = Math.min(remaining,soldQty-returnedQty);
    if (take === 0) continue;
    const sourceLotId = costInteger(cost.inventory_lot_id,"sourceLotId",1);
    const lotResult = await tx.execute(sql`SELECT * FROM inventory.inventory_lots WHERE id=${sourceLotId} FOR UPDATE`);
    const sourceLot = lotResult.rows[0];
    const unitMills = recordedUnitCostMills(cost);
    let costs: LotCosts = { totalMills: unitMills, poMills: unitMills, packagingMills: BigInt(0), landedMills: BigInt(0) };
    let evidenceState: CostSourceRevision["evidence"] = "review_required";
    if (sourceLot) {
      const sourceCosts = normalizeLotCosts(sourceLot);
      if (sourceCosts.totalMills === unitMills) {
        costs = sourceCosts;
        evidenceState = lotCostNeedsReview(sourceLot) ? "estimated" : "confirmed";
      }
    }
    // If the sold total is known but its component history conflicts, retain
    // that exact total as a provisional compatibility layer. Its source evidence
    // explicitly requires component review; do not certify an invented breakdown.
    layers.push({ quantity: take, sourceOrderItemCostId: costId, sourceLotId,
      costs, evidenceState, sourceEvidence: { cost, sourceLot: sourceLot ?? null, netSoldQuantity: soldQty,
        unpicks: reversalResult.rows.filter(reversal=>Number(reversal.original_cost_id)===costId),
        componentHistoryKnown: evidenceState !== "review_required" } });
    remaining-=take;
  }
  if (remaining > 0 && result.rows.length > 0) {
    throw new CostEvidenceError("RETURN_COST_QUANTITY_EXCEEDED", "The requested return exceeds the remaining exact sold allocations.", input as unknown as Record<string,unknown>);
  }
  if (remaining > 0) {
    // Preserve a documented estimate when one exists. Missing price remains
    // null in financial evidence; the physical return is independently authorized.
    const estimate = await resolveCost(tx,input.productVariantId);
    const amount = estimate.source === "unresolved" ? null : BigInt(costInteger(estimate.costCents,"estimatedCostCents"))*BigInt(100);
    layers.push({ quantity: remaining, sourceOrderItemCostId: null, sourceLotId: null,
      costs: amount === null ? null : { totalMills: amount, poMills: amount, packagingMills: BigInt(0), landedMills: BigInt(0) },
      evidenceState: amount === null ? "unknown" : "estimated", sourceEvidence: { ...input, originalCostMissing: true,
        estimateSource: estimate.source, unitMills: amount?.toString() ?? null } });
  }
  return layers;
}

function signedQuantity(value: unknown): number {
  if ((typeof value !== "number" && typeof value !== "string") || !/^-?[1-9]\d*$/.test(String(value))) {
    throw new CostEvidenceError("RETURN_COST_ALLOCATION_CONFLICT", "Sold cost quantity must be a nonzero signed integer.");
  }
  const quantity = Number(value);
  if (!Number.isSafeInteger(quantity) || Math.abs(quantity)>2_147_483_647) {
    throw new CostEvidenceError("RETURN_COST_ALLOCATION_CONFLICT", "Sold cost quantity exceeds supported precision.");
  }
  return quantity;
}
