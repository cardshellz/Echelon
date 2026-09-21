import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

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
