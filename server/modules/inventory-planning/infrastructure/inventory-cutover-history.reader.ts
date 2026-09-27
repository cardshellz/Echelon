import type { PoolClient } from "pg";
import type { OpeningSource } from "@shared/types/inventory-cutover-opening";
import type { CutoverReconstructionBlocker } from "@shared/types/inventory-cutover-reconstruction";
import { cutoverHistoryFactsSchema, type CutoverHistoryFacts } from "../domain/inventory-cutover-history-proposal";
import { assertInventoryCutoverFenceHeldInsideTransaction } from "./inventory-cutover-admission-fence.repository";

/** Same caller-owned READ ONLY snapshot, or the existing exclusive admission
 * fence plus exact owner locks during apply. No ambient DB, writes or provider I/O. */
export async function readCutoverHistoryFacts(client: Pick<PoolClient, "query">, source: OpeningSource,
  blockers: readonly CutoverReconstructionBlocker[]): Promise<CutoverHistoryFacts> {
  const guard = (await client.query<{ readOnly: string; isolation: string; capturedAt: Date }>(
    `SELECT current_setting('transaction_read_only') AS "readOnly",
      current_setting('transaction_isolation') AS isolation, transaction_timestamp() AS "capturedAt"`)).rows[0];
  if (!guard || guard.capturedAt.toISOString() !== source.capturedAt) throw new Error("HISTORY_READER_SNAPSHOT_REQUIRED");
  if (!(guard.readOnly === "on" && ["repeatable read", "serializable"].includes(guard.isolation))) {
    if (guard.readOnly !== "off" || guard.isolation !== "read committed") throw new Error("HISTORY_READER_SNAPSHOT_REQUIRED");
    await assertInventoryCutoverFenceHeldInsideTransaction(client);
  }
  const { receipts, shipmentIds } = historyFactIdentities(source, blockers);
  const receiptRows = (await client.query<{ data: unknown }>(`SELECT jsonb_build_object(
    'id',r.id::text,'rowHash',encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex'),
    'attemptsHash',encode(sha256(convert_to(COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)
      FROM oms.channel_fulfillment_receipt_attempts a WHERE a.receipt_id=r.id),'[]'::jsonb)::text,'UTF8')),'hex'),
    'itemsHash',encode(sha256(convert_to(COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id)
      FROM oms.channel_fulfillment_receipt_items i WHERE i.receipt_id=r.id),'[]'::jsonb)::text,'UTF8')),'hex'),
    'status',r.processing_status,'sourceChannelId',r.source_channel_id,'sourceOrderId',r.source_order_id,
    'linkedOrderId',r.oms_order_id::text,'leaseExpiresAt',to_char(r.lease_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'leaseTokenPresent',r.lease_token IS NOT NULL,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'matchedOrders',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',o.id::text,'channelId',o.channel_id,
      'externalOrderId',o.external_order_id,'status',o.status,
      'rowHash',encode(sha256(convert_to(to_jsonb(o)::text,'UTF8')),'hex'),
      'linesHash',encode(sha256(convert_to(COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id)
        FROM oms.oms_order_lines l WHERE l.order_id=o.id),'[]'::jsonb)::text,'UTF8')),'hex'),
      'lines',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',l.id::text,'requiresShipping',l.requires_shipping,
        'authorizedQty',l.authority_fulfillable_quantity,'fulfillmentStatus',l.fulfillment_status) ORDER BY l.id)
        FROM oms.oms_order_lines l WHERE l.order_id=o.id),'[]'::jsonb)) ORDER BY o.id)
      FROM oms.oms_orders o WHERE o.channel_id=r.source_channel_id AND o.external_order_id=r.source_order_id),'[]'::jsonb)
    ) AS data FROM oms.channel_fulfillment_receipts r WHERE r.id=ANY($1::bigint[]) ORDER BY r.id`, [receipts])).rows;
  const shipmentRows = (await client.query<{ data: unknown }>(`SELECT jsonb_build_object(
    'id',s.id,'rowHash',encode(sha256(convert_to(to_jsonb(s)::text,'UTF8')),'hex'),
    'status',s.status,'orderId',s.order_id,'orderStatus',o.warehouse_status,
    'orderHash',CASE WHEN o.id IS NOT NULL THEN encode(sha256(convert_to(to_jsonb(o)::text,'UTF8')),'hex') END,
    'purpose',s.shipment_purpose,'externalFulfillmentId',s.external_fulfillment_id,
    'requiresReview',s.requires_review,'held',s.held,
    'physicalLinksHash',encode(sha256(convert_to(COALESCE(packages.evidence,'[]'::jsonb)::text,'UTF8')),'hex'),
    'physicalStatuses',COALESCE(packages.statuses,'[]'::jsonb),
    'labelsHash',encode(sha256(convert_to(COALESCE((SELECT jsonb_agg(jsonb_build_object('link',to_jsonb(ll),'label',to_jsonb(l)) ORDER BY ll.id)
      FROM wms.shipping_provider_label_links ll JOIN wms.shipping_provider_labels l ON l.id=ll.shipping_provider_label_id
      WHERE ll.legacy_wms_shipment_id=s.id),'[]'::jsonb)::text,'UTF8')),'hex'),
    'openPickCorrections',(SELECT count(*)::integer FROM wms.pick_corrections c JOIN wms.order_items i ON i.id=c.order_item_id
      WHERE i.order_id=s.order_id AND c.state<>'resolved'),
    'sources',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',si.id,
      'rowHash',encode(sha256(convert_to(to_jsonb(si)::text,'UTF8')),'hex'),
      'purpose',si.shipment_item_purpose,'quantity',si.qty,'orderItemId',si.order_item_id,'variantId',si.product_variant_id,
      'replacementForOrderItemId',si.replacement_for_order_item_id,'correctionForSourceItemId',si.correction_for_shipment_item_id,
      'owner',CASE WHEN i.id IS NOT NULL THEN jsonb_build_object('id',i.id,'orderId',i.order_id,'orderStatus',owner.warehouse_status,
        'quantity',i.quantity,'pickedQuantity',i.picked_quantity,'fulfilledQuantity',i.fulfilled_quantity,
        'rowHash',encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex'),
        'orderHash',encode(sha256(convert_to(to_jsonb(owner)::text,'UTF8')),'hex')) END,
      'correctedPhysicalItems',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',pi.id::text,'provider',p.provider,
        'providerShipmentId',p.provider_physical_shipment_id,'status',p.status,'sourceItemId',pi.legacy_wms_shipment_item_id,
        'orderItemId',pi.wms_order_item_id,'variantId',pi.product_variant_id,'quantity',pi.quantity_shipped,
        'adjustmentQuantity',COALESCE(a.quantity_delta,0),
        'rowHash',encode(sha256(convert_to(jsonb_build_object('physical',to_jsonb(p),'item',to_jsonb(pi),'adjustment',to_jsonb(a))::text,'UTF8')),'hex')) ORDER BY pi.id)
        FROM wms.physical_shipment_items pi JOIN wms.physical_shipments p ON p.id=pi.physical_shipment_id
        LEFT JOIN wms.physical_shipment_item_quantity_adjustments a ON a.physical_shipment_item_id=pi.id
        WHERE pi.legacy_wms_shipment_item_id=si.correction_for_shipment_item_id),'[]'::jsonb)
      ) ORDER BY si.id) FROM wms.outbound_shipment_items si
        LEFT JOIN wms.outbound_shipment_items corrected ON corrected.id=si.correction_for_shipment_item_id
        LEFT JOIN wms.order_items i ON i.id=COALESCE(si.order_item_id,si.replacement_for_order_item_id,corrected.order_item_id)
        LEFT JOIN wms.orders owner ON owner.id=i.order_id WHERE si.shipment_id=s.id),'[]'::jsonb)
    ) AS data FROM wms.outbound_shipments s LEFT JOIN wms.orders o ON o.id=s.order_id
    LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('package',to_jsonb(p),
      'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('item',to_jsonb(pi),'adjustment',to_jsonb(a)) ORDER BY pi.id)
        FROM wms.physical_shipment_items pi LEFT JOIN wms.physical_shipment_item_quantity_adjustments a
          ON a.physical_shipment_item_id=pi.id WHERE pi.physical_shipment_id=p.id),'[]'::jsonb)) ORDER BY p.id) AS evidence,
      jsonb_agg(p.status ORDER BY p.id) AS statuses
      FROM wms.physical_shipments p WHERE p.shipment_request_id IN (SELECT id FROM wms.shipment_requests WHERE legacy_wms_shipment_id=s.id)
        OR EXISTS (SELECT 1 FROM wms.physical_shipment_items pi JOIN wms.outbound_shipment_items si ON si.id=pi.legacy_wms_shipment_item_id
          WHERE pi.physical_shipment_id=p.id AND si.shipment_id=s.id)) packages ON true
    WHERE s.id=ANY($1::integer[]) ORDER BY s.id`, [shipmentIds])).rows;
  if (receiptRows.length !== receipts.length || shipmentRows.length !== shipmentIds.length) throw new Error("HISTORY_READER_MEMBERSHIP_CHANGED");
  return cutoverHistoryFactsSchema.parse({
    contractVersion: "inventory_cutover_history_facts_v1",
    sourceEvidenceHash: source.evidenceHash, capturedAt: source.capturedAt,
    receipts: receiptRows.map(row => row.data), shipments: shipmentRows.map(row => row.data)
  });
}

export function historyFactIdentities(source: OpeningSource, blockers: readonly CutoverReconstructionBlocker[]) {
  const receipts = [...new Set(blockers.filter(row => row.code === "SHIPMENT_RECEIPT_REQUIRES_REVIEW"
    && /^channel_fulfillment_receipt:[1-9][0-9]*$/.test(row.subject)).map(row => row.subject.split(":")[1]))].sort();
  const sourceIds = new Set(blockers.filter(row => row.code === "SHIPMENT_SOURCE_REQUIRES_REVIEW"
    && /^source:[1-9][0-9]*$/.test(row.subject)).map(row => Number(row.subject.split(":")[1])));
  const shipmentIds = [...new Set([
    ...blockers.filter(row => row.code === "SHIPMENT_RECEIPT_REQUIRES_REVIEW"
      && /^outbound_shipment_review:[1-9][0-9]*$/.test(row.subject)).map(row => Number(row.subject.split(":")[1])),
    ...source.evidence.sourceItems.filter(row => sourceIds.has(row.id)).map(row => row.shipmentId),
  ])].sort((a,b) => a-b);
  if (receipts.length > 100_000 || shipmentIds.length > 100_000) throw new Error("HISTORY_READER_CENSUS_LIMIT");
  return { receipts, shipmentIds };
}
