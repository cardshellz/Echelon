import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { MAX_LABEL_REPLACEMENT_ITEMS } from "./label-replacement-scope.domain";

/** Reuse the existing replacement worker after a Shopify cancellation. The
 * source IDs are discovery hints only: that owner rereads immutable contents
 * and proves quantity conservation before moving any package allocation.
 * No age/order-fulfilled gate applies to this outstanding correction work. */
export async function enqueueShopifyLabelReplacementRecovery(
  tx: { execute(query: SQL): Promise<unknown> },
  now: Date,
  options: { readonly limit: number; readonly voidWorkId?: number },
): Promise<void> {
  z.date().parse(now);
  z.number().int().min(1).max(100).parse(options.limit);
  if (options.voidWorkId !== undefined) z.number().int().positive().safe().parse(options.voidWorkId);
  const scope = options.voidWorkId === undefined ? sql`` : sql`AND correction.id = ${options.voidWorkId}`;
  await tx.execute(sql`
    INSERT INTO wms.ebay_label_replacement_work
      (shipping_provider_label_id, state, reason, source_item_ids, created_at, updated_at)
    SELECT candidate.label_id, 'waiting', 'shopify_void_completed', candidate.source_item_ids, ${now}, ${now}
    FROM (
      SELECT label.id AS label_id,
        (ARRAY_AGG(DISTINCT source_item.id ORDER BY source_item.id))[1:${MAX_LABEL_REPLACEMENT_ITEMS}] AS source_item_ids,
        MIN(correction.completed_at) AS correction_completed_at
      FROM oms.shopify_label_void_work correction
      JOIN oms.oms_orders source_order ON source_order.id = correction.oms_order_id
      JOIN wms.physical_shipment_items previous_item
        ON previous_item.physical_shipment_id = correction.physical_shipment_id
      LEFT JOIN wms.package_allocation_entries previous_entry
        ON previous_entry.id = previous_item.package_allocation_entry_id
      LEFT JOIN wms.package_allocation_source_lines previous_source
        ON previous_source.id = previous_entry.package_allocation_source_line_id
      JOIN wms.outbound_shipment_items source_item
        ON source_item.id = COALESCE(previous_item.legacy_wms_shipment_item_id,
          previous_item.label_replacement_source_item_id, previous_source.source_wms_shipment_item_id)
      JOIN wms.shipping_provider_label_links link ON link.legacy_wms_shipment_id = source_item.shipment_id
      JOIN wms.shipping_provider_labels label ON label.id = link.shipping_provider_label_id
      WHERE correction.state = 'complete' ${scope}
        AND source_order.status NOT IN ('cancelled', 'refunded')
        AND COALESCE(source_order.financial_status, '') NOT IN ('refunded', 'voided')
        AND label.provider = 'shipstation' AND label.label_status = 'active' AND label.label_direction = 'outbound'
        AND previous_item.shipment_item_purpose = 'customer_fulfillment'
        AND EXISTS (
          SELECT 1 FROM wms.shipping_provider_label_events candidate_evidence
          WHERE candidate_evidence.shipping_provider_label_id = label.id
            AND (candidate_evidence.sanitized_payload->'declaredContentsEvidence'->'lines'
              @> jsonb_build_array(jsonb_build_object('lineItemKey', 'wms-item-' || source_item.id::text))
              OR candidate_evidence.sanitized_payload->'shipmentItems'
              @> jsonb_build_array(jsonb_build_object('lineItemKey', 'wms-item-' || source_item.id::text)))
        )
        AND NOT EXISTS (SELECT 1 FROM wms.physical_shipments current_package
          WHERE current_package.provider = label.provider AND current_package.provider_physical_shipment_id = label.provider_label_id)
        AND NOT EXISTS (SELECT 1 FROM wms.ebay_label_replacement_work existing
          WHERE existing.shipping_provider_label_id = label.id)
      GROUP BY label.id
      ORDER BY MIN(correction.completed_at), label.id LIMIT ${options.limit}
    ) candidate
    ON CONFLICT (shipping_provider_label_id) DO NOTHING
  `);
}

/** Transaction-bound intake, replayed safely after every engine observation. */
export async function enqueueShopifyLabelVoids(tx: { execute(query: SQL): Promise<unknown> }, labelId: number, now: Date): Promise<void> {
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(labelId); z.date().parse(now);
  await tx.execute(sql`INSERT INTO oms.shopify_label_void_work
    (shipping_provider_label_id, physical_shipment_id, oms_order_id, created_at, updated_at, next_attempt_at)
    SELECT DISTINCT label.id, package.id, command.oms_order_id, ${now}::timestamptz, ${now}::timestamptz, ${now}::timestamptz
    FROM wms.shipping_provider_labels label
    JOIN wms.physical_shipments package ON package.provider = label.provider
      AND package.provider_physical_shipment_id = label.provider_label_id
    JOIN oms.channel_fulfillment_pushes command ON command.physical_shipment_id = package.id
    WHERE label.id = ${labelId} AND label.provider = 'shipstation' AND label.label_status = 'voided'
      AND label.label_direction = 'outbound' AND command.channel_provider = 'shopify'
    ON CONFLICT (physical_shipment_id, oms_order_id) DO NOTHING`);
  await tx.execute(sql`UPDATE oms.channel_fulfillment_pushes command
    SET push_status = 'review', last_error_code = 'PACKAGE_LABEL_VOIDED',
      last_error = 'The shipping engine voided this package label', updated_at = ${now}
    FROM oms.shopify_label_void_work work
    WHERE work.shipping_provider_label_id = ${labelId} AND command.physical_shipment_id = work.physical_shipment_id
      AND command.oms_order_id = work.oms_order_id AND command.channel_provider = 'shopify'
      AND command.push_status IN ('pending', 'retry')`);
}
