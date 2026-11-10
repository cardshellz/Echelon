import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { OrderEditError, appendOrderEditAuditSql } from "../order-edits/oms-coordination.api";

type Transaction = { execute(statement: SQL): Promise<{ rows?: unknown[] }> };
const item = z.object({ id: z.number().int().positive(), qty: z.number().int().positive(),
  shipment_id: z.number().int().positive(), on_hold: z.boolean(), held: z.boolean(),
  source: z.string().nullable(), provider_order_id: z.number().int().positive().nullable(),
  status: z.string(), picked_quantity: z.number().int().nonnegative(),
  fulfilled_quantity: z.number().int().nonnegative() });
type Item = z.infer<typeof item>;
export interface ProviderEditItems { items: readonly { lineItemKey: string; quantity: number }[] }

export async function appendOrderEditShippingAudit(tx: Transaction, input: {
  operationId: string; action: string; before: unknown; after: unknown; now: Date;
}): Promise<void> {
  const operation = z.object({ connection_id: z.number().int().positive(), actor_id: z.string() }).parse(
    (await tx.execute(sql`SELECT connection_id,document->>'actorId' AS actor_id FROM oms.order_edit_operations
      WHERE id=${input.operationId}::uuid`)).rows?.[0]);
  await appendOrderEditAuditSql(tx, {operationId:input.operationId,connectionId:operation.connection_id,
    actorId:operation.actor_id,action:input.action,before:input.before,after:input.after,occurredAt:input.now});
}

function matches(live: ProviderEditItems, expected: readonly Item[]): boolean {
  const actual = new Map(live.items.map(row => [row.lineItemKey, row.quantity]));
  return actual.size === live.items.length && actual.size === expected.length &&
    expected.every(row => actual.get(`wms-item-${row.id}`) === row.qty);
}

async function readItems(tx: Transaction, orderId: number): Promise<Item[]> {
  return z.array(item).parse((await tx.execute(sql`
    SELECT osi.id,osi.qty,osi.shipment_id,oi.on_hold,os.held,os.source,os.status,
      COALESCE(os.shipstation_order_id,CASE WHEN os.shipping_engine='shipstation'
        AND os.engine_order_ref ~ '^[0-9]+$' AND length(os.engine_order_ref)<10 THEN os.engine_order_ref::int END) AS provider_order_id,
      COALESCE(oi.picked_quantity,0) AS picked_quantity,COALESCE(oi.fulfilled_quantity,0) AS fulfilled_quantity
    FROM wms.outbound_shipments os JOIN wms.outbound_shipment_items osi ON osi.shipment_id=os.id
      JOIN wms.order_items oi ON oi.id=osi.order_item_id AND oi.order_id=os.order_id
    WHERE os.order_id=${orderId} AND os.status NOT IN ('cancelled','voided') AND osi.qty>0
      AND oi.status<>'cancelled' ORDER BY os.id,osi.id FOR UPDATE OF os,osi,oi`)).rows);
}

/** Cleanup may remove our edit hold, but must not dispatch a manually held key. */
export async function providerCarriesManualHold(tx: Transaction, orderId: number, live: ProviderEditItems): Promise<boolean> {
  const keys = new Set(live.items.map(row => row.lineItemKey));
  return (await readItems(tx, orderId)).some(row => row.on_hold && keys.has(`wms-item-${row.id}`));
}

/** Missing provider IDs on ordinary push work require shipping-owner recovery. */
function deferred(row: Item): boolean {
  return row.source === "line_item_hold" && row.status === "planned" && row.held && row.on_hold &&
    row.provider_order_id === null && row.picked_quantity === 0 && row.fulfilled_quantity === 0;
}

/** Called under the shipping push lock and the edit-owned WMS header lock,
 * after complete provider-scope/label verification. No financial writes.
 *
 * Holding the last line used to leave an empty linked job and a second local
 * plan containing precisely that job's items. Preserve the real job's stable
 * key/ID, restore its membership, and retain the original manual hold. Partial
 * splits retain separate held plans; the caller removes their keys from the
 * held provider job before it can release that job.
 */
export async function prepareOrderEditHeldPartitions(tx: Transaction, input: {
  operationId: string; orderId: number; shipmentId: number; live: ProviderEditItems; now: Date;
}): Promise<{ retiredShipmentIds: number[]; excludedItemKeys: string[] }> {
  const rows = await readItems(tx, input.orderId);
  const own = rows.filter(row => row.shipment_id === input.shipmentId);
  const held = rows.filter(deferred);
  const heldKeys = new Set(held.map(row => `wms-item-${row.id}`));
  const carriedHeld = input.live.items.filter(row => heldKeys.has(row.lineItemKey));
  if (!carriedHeld.length) return { retiredShipmentIds: [], excludedItemKeys: [] };
  const carried = held.filter(row => carriedHeld.some(remote => remote.lineItemKey === `wms-item-${row.id}`));
  if (!matches(input.live, [...own, ...carried]))
    throw new OrderEditError("ORDER_EDIT_HELD_PARTITION_UNVERIFIED", "We couldn’t verify which items are ready to ship. Contact us for help.");
  if (own.length) return { retiredShipmentIds: [], excludedItemKeys: carried.map(row => `wms-item-${row.id}`) };
  const ids = [...new Set(carried.map(row => row.shipment_id))];
  // Never consolidate part of a held partition or combine independent holds.
  if (ids.length !== 1 || held.filter(row => row.shipment_id === ids[0]).length !== carried.length)
    throw new OrderEditError("ORDER_EDIT_HELD_PARTITION_UNVERIFIED", "We couldn’t verify which items are ready to ship. Contact us for help.");
  const heldShipmentId = ids[0];
  await tx.execute(sql`UPDATE wms.outbound_shipment_items SET shipment_id=${input.shipmentId}
    WHERE shipment_id=${heldShipmentId}`);
  await tx.execute(sql`UPDATE wms.outbound_shipments parent SET held=true,
    held_at=CASE WHEN parent.held THEN parent.held_at ELSE child.held_at END,
    on_hold_reason=CASE WHEN parent.held THEN parent.on_hold_reason ELSE child.on_hold_reason END,updated_at=${input.now}
    FROM wms.outbound_shipments child WHERE parent.id=${input.shipmentId} AND child.id=${heldShipmentId}`);
  await tx.execute(sql`UPDATE wms.outbound_shipments SET status='cancelled',cancelled_at=${input.now},
    voided_reason='order_edit_held_partition_consolidated',updated_at=${input.now} WHERE id=${heldShipmentId}`);
  await appendOrderEditShippingAudit(tx, { operationId: input.operationId, action: "held_partition_membership_restored",
    before: { shipmentId: input.shipmentId, heldShipmentId, items: carried },
    after: { shipmentId: input.shipmentId, retiredShipmentIds: ids, manualHoldRetained: true }, now: input.now });
  return { retiredShipmentIds: ids, excludedItemKeys: [] };
}

/** A held local plan is not another provider job. Prove that it has never
 * acquired a job/key or active provider membership before deferring it. */
export async function verifyDeferredHeldPartition(tx: Transaction, input: {
  orderId: number; shipmentId: number; providerOrders: readonly (ProviderEditItems & { orderKey?: string })[];
}): Promise<void> {
  const rows = (await readItems(tx, input.orderId)).filter(row => row.shipment_id === input.shipmentId);
  // Include retired/zero-quantity keys in the absence proof. A paid edit may
  // remove the last held unit; that does not turn an empty local plan into a
  // missing provider job, nor permit stale remote units to be dispatched.
  const identities = z.array(z.object({id:z.number().int().positive()})).parse((await tx.execute(sql`
    SELECT osi.id FROM wms.outbound_shipment_items osi JOIN wms.outbound_shipments os ON os.id=osi.shipment_id
      WHERE os.id=${input.shipmentId} AND os.order_id=${input.orderId} ORDER BY osi.id`)).rows);
  const keys = new Set(identities.map(row => `wms-item-${row.id}`));
  if (!rows.every(deferred) || input.providerOrders.some(order =>
    order.orderKey === `echelon-wms-shp-${input.shipmentId}` || order.items.some(row => keys.has(row.lineItemKey))))
    throw new OrderEditError("ORDER_EDIT_HELD_PARTITION_UNVERIFIED", "We couldn’t verify which items are ready to ship. Contact us for help.");
}
