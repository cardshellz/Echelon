import { z } from "zod";
import { canonicalClaimDispatchPlanSchema } from "../../../../shared/types/inventory-availability-dispatch";
import type {
  CanonicalClaimInventoryDispatchCost,
  CanonicalClaimInventoryDispatchPort,
  CanonicalClaimInventoryDispatchResult,
  CanonicalClaimTransactionClient,
} from "../../inventory-planning/application/canonical-claim-inventory.port";

const MAX_COST_ROWS = 10_000;
const POSTGRES_INTEGER_MAX = BigInt(2_147_483_647);
const POSTGRES_BIGINT_MAX = BigInt("9223372036854775807");
// Same source-item/legacy order-item fence used by recordShipment. This is not
// dispatch authority: the caller must already hold its WMS source/claim locks.
const LEGACY_SHIPMENT_LOCK_NAMESPACE = 918407;
const databaseId = z.coerce.number().int().positive().max(Number(POSTGRES_INTEGER_MAX));
const databaseQuantity = z.union([z.string(), z.number().int().safe()]).transform(String)
  .pipe(z.string().regex(/^(0|[1-9][0-9]*)$/).refine((value) => BigInt(value) <= POSTGRES_BIGINT_MAX));
const costSchema = z.object({
  id: databaseId, orderId: databaseId, orderItemId: databaseId,
  productVariantId: databaseId, inventoryLotId: databaseId,
  quantity: databaseQuantity.refine((value) => BigInt(value) > BigInt(0) && BigInt(value) <= POSTGRES_INTEGER_MAX),
  unitCostMills: databaseQuantity, totalCostMills: databaseQuantity,
}).strict().refine((cost) => BigInt(cost.quantity) * BigInt(cost.unitCostMills) === BigInt(cost.totalCostMills),
  "Original pick cost must reconcile exactly in mills");

export class CanonicalClaimInventoryDispatchError extends Error {
  constructor(readonly code: string, message: string, readonly context: Record<string, unknown> = {}) {
    super(message);
    this.name = "CanonicalClaimInventoryDispatchError";
  }
}

function fail(code: string, message: string, context: Record<string, unknown> = {}): never {
  throw new CanonicalClaimInventoryDispatchError(code, message, context);
}

function inventoryQuantity(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > Number(POSTGRES_INTEGER_MAX)) {
    fail("CLAIM_DISPATCH_INVALID_INVENTORY", "Inventory custody must contain nonnegative PostgreSQL integers.", { field });
  }
  return value;
}

export async function loadCanonicalDispatchCosts(
  input: Parameters<CanonicalClaimInventoryDispatchPort["loadDispatchCosts"]>[0],
): Promise<readonly CanonicalClaimInventoryDispatchCost[]> {
  return readDispatchCosts(input.client, input.costIds, false);
}

async function readDispatchCosts(
  client: CanonicalClaimTransactionClient,
  costIds: readonly number[],
  lock: boolean,
): Promise<readonly CanonicalClaimInventoryDispatchCost[]> {
  const parsed = z.array(z.number().int().positive().max(Number(POSTGRES_INTEGER_MAX))).max(MAX_COST_ROWS).safeParse(costIds);
  if (!parsed.success) fail("CLAIM_DISPATCH_INVALID_COST_IDS", "Dispatch cost IDs must be a bounded array of exact PostgreSQL identities.");
  const ids = [...new Set(parsed.data)].sort((left, right) => left - right);
  if (ids.length === 0) return [];
  const result = await client.query(
    `SELECT id, order_id AS "orderId", order_item_id AS "orderItemId",
            product_variant_id AS "productVariantId", inventory_lot_id AS "inventoryLotId",
            qty AS quantity, unit_cost_mills AS "unitCostMills", total_cost_mills AS "totalCostMills"
     FROM oms.order_item_costs WHERE id = ANY($1::integer[]) ORDER BY id
     ${lock ? "FOR SHARE" : ""}`, [ids]);
  const costs = z.array(costSchema).safeParse(result.rows);
  if (!costs.success || costs.data.length !== ids.length
    || costs.data.some((cost, index) => cost.id !== ids[index])) {
    fail("CLAIM_DISPATCH_COST_EVIDENCE_MISSING", "Every original pick requires exact, valid authoritative COGS evidence.", { costIds: ids });
  }
  return costs.data;
}

/**
 * Physical inventory owner only: exact picked custody -> dispatched. Claim
 * counters and original-pick lineage belong to the caller's immutable receipt.
 * There is no on-hand fallback, reservation release, new COGS or transaction.
 * A failed journal insert must roll back this entire caller-owned transaction.
 */
export async function dispatchCanonicalPickedResources(
  input: Parameters<CanonicalClaimInventoryDispatchPort["dispatchPickedResources"]>[0],
): Promise<CanonicalClaimInventoryDispatchResult> {
  const parsed = canonicalClaimDispatchPlanSchema.safeParse(input.plan);
  if (!parsed.success) fail("CLAIM_DISPATCH_INVALID_PLAN", "Canonical dispatch requires a complete validated exact-source plan.");
  const plan = parsed.data;
  const command = plan.command;
  if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime())) {
    fail("CLAIM_DISPATCH_INVALID_TIMESTAMP", "Dispatch requires a valid caller-supplied timestamp.");
  }
  if (BigInt(plan.quantity) > POSTGRES_INTEGER_MAX || plan.sourceRemainingQuantity !== "0"
    || plan.sourceDispositionAfter !== "fully_dispatched") {
    fail("CLAIM_DISPATCH_INVALID_SOURCE_QUANTITY", "Dispatch must consume one complete explicit source item within PostgreSQL integer bounds.");
  }
  // One source has one variant/location and one immutable ship ledger row. The
  // existing unique inventory-level variant/location key forbids split levels.
  const levelIds = [...new Set(plan.resources.map((resource) => resource.inventoryLevelId))];
  if (levelIds.length !== 1) fail("CLAIM_DISPATCH_LEVEL_IDENTITY_MISMATCH", "One explicit source must resolve to one exact inventory level.");
  const lotQuantities = new Map<number, bigint>();
  const selectedCosts = new Map<number, { inventoryLotId: number; quantity: bigint; unitCostMills: string }>();
  for (const resource of plan.resources) {
    for (const lot of resource.lots) {
      lotQuantities.set(lot.inventoryLotId, (lotQuantities.get(lot.inventoryLotId) ?? BigInt(0)) + BigInt(lot.quantity));
      for (const pick of lot.picks) {
        const previous = selectedCosts.get(pick.orderItemCostId);
        if (previous && (previous.inventoryLotId !== lot.inventoryLotId || previous.unitCostMills !== pick.unitCostMills)) {
          fail("CLAIM_DISPATCH_COST_IDENTITY_MISMATCH", "An original COGS row cannot identify different lots or costs.");
        }
        selectedCosts.set(pick.orderItemCostId, { inventoryLotId: lot.inventoryLotId,
          quantity: (previous?.quantity ?? BigInt(0)) + BigInt(pick.quantity), unitCostMills: pick.unitCostMills });
      }
    }
  }
  const sourceFenceIds = [...new Set([command.sourceShipmentItemId, command.orderItemId])].sort((left, right) => left - right);
  for (const id of sourceFenceIds) {
    await input.client.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)", [LEGACY_SHIPMENT_LOCK_NAMESPACE, id]);
  }
  // Legacy rows may lack source identity. Either exact source or the older
  // shipment/order-item key is already spent; never silently attach a new claim.
  const existing = await input.client.query(
    `SELECT id FROM inventory.inventory_transactions
     WHERE transaction_type = 'ship'
       AND (shipment_item_id = $1 OR (shipment_id = $2 AND order_item_id = $3))
     ORDER BY id LIMIT 1`, [command.sourceShipmentItemId, command.outboundShipmentId, command.orderItemId]);
  if (existing.rows.length !== 0) {
    fail("CLAIM_DISPATCH_SOURCE_ALREADY_POSTED", "Source shipment inventory was already posted; exact canonical replay must resolve before mutation.");
  }
  const levels = await input.client.query(
    `SELECT level.id, level.warehouse_location_id, level.product_variant_id,
            level.variant_qty, level.reserved_qty, level.picked_qty, location.warehouse_id
     FROM inventory.inventory_levels AS level
     JOIN warehouse.warehouse_locations AS location ON location.id = level.warehouse_location_id
     WHERE level.id = ANY($1::integer[])
     ORDER BY level.warehouse_location_id, level.product_variant_id, level.id
     FOR UPDATE OF level FOR SHARE OF location`, [levelIds]);
  const level = levels.rows[0];
  if (levels.rows.length !== 1 || level.id !== levelIds[0]
    || level.warehouse_location_id !== command.warehouseLocationId || level.product_variant_id !== command.productVariantId
    || level.warehouse_id !== command.warehouseId) {
    fail("CLAIM_DISPATCH_LEVEL_IDENTITY_MISMATCH", "Exact source inventory level is missing or belongs to another variant/location.");
  }
  const onHand = inventoryQuantity(level.variant_qty, "inventoryLevel.variantQty");
  inventoryQuantity(level.reserved_qty, "inventoryLevel.reservedQty");
  const quantity = Number(plan.quantity);
  if (inventoryQuantity(level.picked_qty, "inventoryLevel.pickedQty") < quantity) {
    fail("CLAIM_DISPATCH_PICKED_SHORTFALL", "Exact source inventory level has insufficient picked custody.");
  }
  const lotIds = [...lotQuantities.keys()].sort((left, right) => left - right);
  const lots = await input.client.query(
    `SELECT id, warehouse_location_id, product_variant_id, qty_on_hand, qty_reserved, qty_picked, status
     FROM inventory.inventory_lots WHERE id = ANY($1::integer[])
     ORDER BY warehouse_location_id, product_variant_id, received_at, id FOR UPDATE`, [lotIds]);
  if (lots.rows.length !== lotIds.length || new Set(lots.rows.map((lot) => lot.id)).size !== lotIds.length) {
    fail("CLAIM_DISPATCH_LOT_IDENTITY_MISMATCH", "One or more exact picked lots no longer exist.");
  }
  for (const lot of lots.rows) {
    const lotQuantity = lotQuantities.get(lot.id);
    if (lotQuantity === undefined || lot.warehouse_location_id !== command.warehouseLocationId
      || lot.product_variant_id !== command.productVariantId) {
      fail("CLAIM_DISPATCH_LOT_IDENTITY_MISMATCH", "Exact picked lot belongs to another variant/location.");
    }
    inventoryQuantity(lot.qty_on_hand, "inventoryLot.qtyOnHand");
    inventoryQuantity(lot.qty_reserved, "inventoryLot.qtyReserved");
    if (BigInt(inventoryQuantity(lot.qty_picked, "inventoryLot.qtyPicked")) < lotQuantity) {
      fail("CLAIM_DISPATCH_PICKED_SHORTFALL", "Exact claim-picked lot has insufficient picked custody.", { inventoryLotId: lot.id });
    }
  }
  // Read-only planning does not lock costs. Revalidate under a share lock after
  // levels/lots, preventing a concurrent cost correction from changing evidence
  // between this check and receipt insertion. Never use today's lot cost instead.
  const costs = await readDispatchCosts(input.client, [...selectedCosts.keys()], true);
  for (const cost of costs) {
    const selected = selectedCosts.get(cost.id)!;
    if (cost.orderId !== command.orderId || cost.orderItemId !== command.orderItemId
      || cost.productVariantId !== command.productVariantId || cost.inventoryLotId !== selected.inventoryLotId
      || cost.unitCostMills !== selected.unitCostMills || BigInt(cost.quantity) < selected.quantity) {
      fail("CLAIM_DISPATCH_COST_IDENTITY_MISMATCH", "Dispatch must retain the original order/item/variant/lot pick cost evidence.", { orderItemCostId: cost.id });
    }
  }
  // All exact layers are verified before the first write. No FIFO substitution.
  for (const lot of lots.rows) {
    const changed = await input.client.query(
      `UPDATE inventory.inventory_lots SET qty_picked = qty_picked - $1,
         status = CASE WHEN status = 'active' AND qty_on_hand = 0 AND qty_reserved = 0 AND qty_picked = $1
                       THEN 'depleted' ELSE status END
       WHERE id = $2 AND qty_picked >= $1`, [Number(lotQuantities.get(lot.id)), lot.id]);
    if (changed.rowCount !== 1) fail("CLAIM_DISPATCH_PICKED_CONFLICT", "Exact picked lot changed during dispatch.");
  }
  const changed = await input.client.query(
    `UPDATE inventory.inventory_levels SET picked_qty = picked_qty - $1, updated_at = $3
     WHERE id = $2 AND picked_qty >= $1`, [quantity, level.id, input.occurredAt]);
  if (changed.rowCount !== 1) fail("CLAIM_DISPATCH_PICKED_CONFLICT", "Exact picked inventory level changed during dispatch.");
  // Pick already reduced on-hand and recorded COGS. A second -quantity here
  // would falsify the on-hand replay; exact shipment quantity lives in the
  // caller's immutable receipt and its source item, not a second stock delta.
  const transaction = await input.client.query(
    `INSERT INTO inventory.inventory_transactions (
       product_variant_id, from_location_id, transaction_type, variant_qty_delta,
       variant_qty_before, variant_qty_after, reserved_qty_delta, source_state, target_state,
       order_id, order_item_id, shipment_id, shipment_item_id, reference_type, reference_id,
       notes, user_id, created_at
     ) VALUES ($1, $2, 'ship', 0, $3, $3, 0, 'picked', 'shipped',
       $4, $5, $6, $7, 'availability_claim_dispatch', $8, $9, $10, $11) RETURNING id`,
    [command.productVariantId, command.warehouseLocationId, onHand, command.orderId, command.orderItemId,
      command.outboundShipmentId, command.sourceShipmentItemId, plan.commandHash, command.reason, command.actor, input.occurredAt]);
  const transactionId = databaseId.safeParse(transaction.rows[0]?.id);
  if (transaction.rows.length !== 1 || !transactionId.success) {
    fail("CLAIM_DISPATCH_JOURNAL_MISSING", "Dispatch must return its exact immutable inventory journal identity.");
  }
  return { inventoryTransactionId: transactionId.data, quantity: plan.quantity,
    physicalOnHandDelta: "0", reservedQuantityDelta: "0", pickedQuantityDelta: `-${plan.quantity}` };
}
