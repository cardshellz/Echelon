import type { PoolClient } from "pg";
import type { OpeningSource } from "@shared/types/inventory-cutover-opening";
import type { CutoverReconstructionBlocker } from "@shared/types/inventory-cutover-reconstruction";
import { historyFactIdentities } from "./inventory-cutover-history.reader";
import { assertInventoryCutoverFenceHeldInsideTransaction } from "./inventory-cutover-admission-fence.repository";

/** Existing admission drains stock/order/source writers first. Exact parent
 * FOR UPDATE locks also block FK insertions into the few supporting tables
 * outside that manifest; existing child rows are locked explicitly. No new
 * persistent global guard is installed. Timeout/deadlock rolls back the batch. */
export async function lockHistoryFacts(client: PoolClient, source: OpeningSource,
  blockers: readonly CutoverReconstructionBlocker[]): Promise<void> {
  await assertInventoryCutoverFenceHeldInsideTransaction(client);
  const { receipts, shipmentIds } = historyFactIdentities(source, blockers);
  await client.query("SELECT id FROM oms.channel_fulfillment_receipts WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE", [receipts]);
  await client.query("SELECT id FROM oms.channel_fulfillment_receipt_items WHERE receipt_id=ANY($1::bigint[]) ORDER BY id FOR UPDATE", [receipts]);
  await client.query("SELECT id FROM wms.outbound_shipments WHERE id=ANY($1::integer[]) ORDER BY id FOR UPDATE", [shipmentIds]);
  const orderIds = (await client.query<{ order_id: number }>("SELECT DISTINCT order_id FROM wms.outbound_shipments WHERE id=ANY($1::integer[]) AND order_id IS NOT NULL ORDER BY order_id", [shipmentIds])).rows.map(row => row.order_id);
  await client.query("SELECT id FROM wms.order_items WHERE order_id=ANY($1::integer[]) ORDER BY id FOR UPDATE", [orderIds]);
  await client.query(`SELECT c.id FROM wms.pick_corrections c JOIN wms.order_items i ON i.id=c.order_item_id
    WHERE i.order_id=ANY($1::integer[]) ORDER BY c.id FOR UPDATE OF c`, [orderIds]);
  await client.query("SELECT id FROM wms.shipment_requests WHERE legacy_wms_shipment_id=ANY($1::integer[]) ORDER BY id FOR UPDATE", [shipmentIds]);
  await client.query("SELECT id FROM wms.shipping_provider_label_links WHERE legacy_wms_shipment_id=ANY($1::integer[]) ORDER BY id FOR UPDATE", [shipmentIds]);
  await client.query(`SELECT l.id FROM wms.shipping_provider_labels l WHERE EXISTS
    (SELECT 1 FROM wms.shipping_provider_label_links link WHERE link.shipping_provider_label_id=l.id
      AND link.legacy_wms_shipment_id=ANY($1::integer[])) ORDER BY l.id FOR UPDATE`, [shipmentIds]);
}
