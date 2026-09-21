import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { readLabelEvidence } from "./ebay-label-replacement.repository";
import { ChannelFulfillmentProviderError } from "../channels/channel-fulfillment-provider.error";
import { enqueueShopifyLabelVoids } from "./shopify-label-void-intake.repository";
import { createPackageAllocationLabelCommercialReviewRepository } from "../shipping/package-allocation-label-commercial-review.repository";

export interface LabelLifecycleDatabase {
  execute(query: SQL): Promise<unknown>;
  transaction<T>(work: (tx: LabelLifecycleDatabase) => Promise<T>): Promise<T>;
}
const positiveId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
function rows<T>(result: unknown): T[] {
  if (!result || typeof result !== "object" || !("rows" in result) || !Array.isArray(result.rows)) {
    throw new Error("Shopify label lifecycle query returned no rows");
  }
  return result.rows as T[];
}
export interface ShopifyLabelVoidWork {
  readonly id: number; readonly omsOrderId: number; readonly channelId: number;
  readonly physicalShipmentId: number; readonly labelId: number; readonly attemptCount: number;
  readonly orderGid: string; readonly trackingNumber: string;
  readonly fulfillmentIds: readonly string[];
  readonly items: readonly { lineId: string; quantity: number }[];
  readonly processing: boolean; readonly carrierPossession: boolean; readonly labelVoidProven: boolean;
}
export function createShopifyLabelLifecycleRepository(db: LabelLifecycleDatabase) {
  async function observe(labelId: number, now: Date): Promise<void> {
    await db.transaction(tx => enqueueShopifyLabelVoids(tx, labelId, now));
  }

  async function due(now: Date, limit: number): Promise<readonly { id: number; omsOrderId: number }[]> {
    z.date().parse(now); z.number().int().min(1).max(25).parse(limit);
    return rows<{ id: string; oms_order_id: string }>(await db.execute(sql`
      SELECT id, oms_order_id FROM oms.shopify_label_void_work
      WHERE state = 'pending' AND next_attempt_at <= ${now} ORDER BY next_attempt_at, id LIMIT ${limit}
    `)).map(row => ({ id: positiveId.parse(row.id), omsOrderId: positiveId.parse(row.oms_order_id) }));
  }

  async function load(id: number): Promise<ShopifyLabelVoidWork | null> {
    positiveId.parse(id);
    const values = rows<Record<string, unknown>>(await db.execute(sql`
      SELECT work.id, work.shipping_provider_label_id, work.physical_shipment_id, work.oms_order_id,
        work.attempt_count, orders.channel_id, orders.external_order_id, package.tracking_number,
        EXISTS (SELECT 1 FROM oms.channel_fulfillment_pushes command
          WHERE command.physical_shipment_id = package.id AND command.oms_order_id = orders.id
            AND command.channel_provider = 'shopify' AND command.push_status = 'processing') AS processing,
        EXISTS (SELECT 1 FROM wms.carrier_tracking_event_matches match
          JOIN wms.carrier_tracking_events event ON event.id = match.carrier_tracking_event_id
          WHERE match.shipping_provider_label_id = work.shipping_provider_label_id
            AND match.match_status IN ('matched', 'voided_label') AND event.dispatch_evidence = 'confirmed') AS carrier_possession
      FROM oms.shopify_label_void_work work
      JOIN oms.oms_orders orders ON orders.id = work.oms_order_id
      JOIN channels.channels channel ON channel.id = orders.channel_id AND channel.provider = 'shopify'
      JOIN wms.physical_shipments package ON package.id = work.physical_shipment_id
      WHERE work.id = ${id} AND work.state = 'pending'`));
    if (values.length === 0) return null;
    const row = values[0];
    const labelId = positiveId.parse(row.shipping_provider_label_id);
    const physicalShipmentId = positiveId.parse(row.physical_shipment_id);
    const omsOrderId = positiveId.parse(row.oms_order_id);
    const evidence = await readLabelEvidence(db, labelId);
    const items = rows<{ external_line_item_id: string; quantity: number; source_id: number; order_id: string }>(await db.execute(sql`
      SELECT line.external_line_item_id, item.quantity_shipped AS quantity, line.order_id,
        COALESCE(item.legacy_wms_shipment_item_id, item.label_replacement_source_item_id, source.source_wms_shipment_item_id) AS source_id
      FROM wms.physical_shipment_items item
      JOIN wms.fulfillment_plan_lines plan ON plan.id = item.fulfillment_plan_line_id
      JOIN oms.oms_order_lines line ON line.id = plan.oms_order_line_id
      LEFT JOIN wms.package_allocation_entries entry ON entry.id = item.package_allocation_entry_id
      LEFT JOIN wms.package_allocation_source_lines source ON source.id = entry.package_allocation_source_line_id
      WHERE item.physical_shipment_id = ${physicalShipmentId} AND item.shipment_item_purpose = 'customer_fulfillment'
      ORDER BY item.id`));
    const contents = items.map(item => ({ wmsShipmentItemId: positiveId.parse(item.source_id), quantity: positiveId.parse(item.quantity) }))
      .sort((a, b) => a.wmsShipmentItemId - b.wmsShipmentItemId);
    const labelVoidProven = evidence.lifecycle?.outcome === 'projected'
      && evidence.lifecycle.projection.labelStatus === 'voided'
      && evidence.lifecycle.projection.correctionStatus === 'awaiting_relabel'
      && JSON.stringify(evidence.lifecycle.projection.authoritativeContents) === JSON.stringify(contents);
    const handles = rows<{ channel_fulfillment_id: string }>(await db.execute(sql`
      SELECT DISTINCT channel_fulfillment_id FROM oms.channel_fulfillment_pushes
      WHERE physical_shipment_id = ${physicalShipmentId} AND oms_order_id = ${omsOrderId}
        AND channel_provider = 'shopify' AND NULLIF(BTRIM(channel_fulfillment_id), '') IS NOT NULL`));
    const orderId = String(row.external_order_id ?? '').replace(/^gid:\/\/shopify\/Order\//, '');
    if (!/^\d+$/.test(orderId)) throw new ChannelFulfillmentProviderError('SHOPIFY_VOID_ORDER_INVALID', 'Label correction has no exact Shopify order');
    return { id, omsOrderId, channelId: positiveId.parse(row.channel_id), physicalShipmentId, labelId,
      attemptCount: z.coerce.number().int().nonnegative().parse(row.attempt_count), orderGid: `gid://shopify/Order/${orderId}`,
      trackingNumber: z.string().trim().min(1).parse(row.tracking_number),
      fulfillmentIds: handles.map(value => z.string().regex(/^gid:\/\/shopify\/Fulfillment\/\d+$/).parse(value.channel_fulfillment_id)),
      items: items.filter(item => Number(item.order_id) === omsOrderId).map(item => ({
        lineId: `gid://shopify/LineItem/${String(item.external_line_item_id).replace(/^gid:\/\/shopify\/LineItem\//, '')}`,
        quantity: positiveId.parse(item.quantity),
      })), processing: row.processing === true, carrierPossession: row.carrier_possession === true, labelVoidProven };
  }

  async function finish(work: ShopifyLabelVoidWork, input: {
    now: Date; state: 'pending' | 'complete' | 'review'; nextAttemptAt: Date | null;
    errorCode: string | null; evidence: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    positiveId.parse(work.id);
    z.date().parse(input.now);
    z.enum(['pending', 'complete', 'review']).parse(input.state);
    z.date().nullable().parse(input.nextAttemptAt);
    z.string().min(1).max(100).nullable().parse(input.errorCode);
    await db.transaction(async tx => {
      const changed = rows<{ id: string }>(await tx.execute(sql`UPDATE oms.shopify_label_void_work
        SET state = ${input.state}, attempt_count = attempt_count + 1, updated_at = ${input.now},
          next_attempt_at = ${input.nextAttemptAt}, last_error_code = ${input.errorCode},
          completed_at = ${input.state === 'complete' ? input.now : null}
        WHERE id = ${work.id} AND state = 'pending' AND attempt_count = ${work.attemptCount} RETURNING id`));
      if (changed.length !== 1) throw new Error('Shopify label correction ownership changed');
      await tx.execute(sql`INSERT INTO oms.shopify_label_void_attempts
        (work_id, attempt_number, outcome, error_code, evidence, actor, completed_at)
        VALUES (${work.id}, ${work.attemptCount + 1}, ${input.state}, ${input.errorCode},
          ${JSON.stringify(input.evidence)}::jsonb, 'system:shopify_label_lifecycle', ${input.now})`);
      if (input.state === 'review') {
        const { label, lifecycle } = await readLabelEvidence(tx, work.labelId);
        if (!label) throw new Error('Shopify void review has no persisted label');
        await createPackageAllocationLabelCommercialReviewRepository(tx).record({
          shippingProviderLabelId: work.labelId, providerShipmentId: label.provider_label_id,
          providerOrderId: label.provider_order_id, providerOrderKey: label.provider_order_key,
          orderNumber: null, trackingNumber: work.trackingNumber, operation: 'label_void',
          reasonCode: input.errorCode ?? 'SHOPIFY_VOID_REVIEW_REQUIRED',
          sourceWmsShipmentItemIds: lifecycle?.outcome === 'projected'
            ? lifecycle.projection.authoritativeContents?.map(item => item.wmsShipmentItemId) ?? [] : [],
          details: { workId: work.id, physicalShipmentId: work.physicalShipmentId, omsOrderId: work.omsOrderId,
            channelId: work.channelId, ...input.evidence },
        });
      }
    });
  }
  return { observe, due, load, finish };
}
export type ShopifyLabelLifecycleRepository = ReturnType<typeof createShopifyLabelLifecycleRepository>;
