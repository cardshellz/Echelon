import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

const inputSchema = z.object({
  channelId: z.number().int().positive().safe(),
  afterOmsOrderId: z.number().int().min(0).safe(),
  limit: z.number().int().min(1).max(1000),
});
const rowSchema = z.object({
  oms_order_id: z.coerce.number().int().positive().safe(),
  shopify_order_id: z.string().regex(/^[1-9]\d*$/),
  needs_paid_replay: z.boolean(),
});

/** Cursor wraps after the last OMS id so review cases cannot starve newer work.
 * The extra zero/zero branch covers first-payment grants missed by old handlers. */
export async function loadShopifyReadinessCandidates(
  db: { execute(statement: SQL): Promise<{ rows: unknown[] }> },
  rawInput: z.infer<typeof inputSchema>,
): Promise<Array<{ omsOrderId: number; shopifyOrderId: string; needsPaidReplay: boolean }>> {
  const input = inputSchema.parse(rawInput);
  const candidates = await db.execute(sql`
    SELECT
      oo.id AS oms_order_id,
      split_part(oo.external_order_id, '/', -1) AS shopify_order_id,
      BOOL_OR(ol.authorization_status = 'seen' AND ol.paid_quantity = 0
        AND ol.authority_fulfillable_quantity = 0 AND ol.wms_materialized_quantity = 0)
        AS needs_paid_replay
    FROM oms.oms_orders oo
    JOIN oms.oms_order_lines ol ON ol.order_id = oo.id
    WHERE oo.channel_id = ${input.channelId}
      AND oo.status NOT IN ('cancelled', 'refunded', 'shipped')
      AND COALESCE(oo.fulfillment_status, '') <> 'fulfilled'
      AND COALESCE(oo.financial_status, '') IN ('paid', 'partially_paid', 'partially_refunded', 'refunded')
      AND ol.requires_shipping IS DISTINCT FROM false
      AND (
        COALESCE(ol.paid_quantity, 0) > COALESCE(ol.authority_fulfillable_quantity, 0)
        OR COALESCE(ol.authority_fulfillable_quantity, 0) >
           COALESCE(ol.wms_materialized_quantity, 0)
        OR ol.channel_quantity_updated_at IS NULL
        OR (
          oo.financial_status = 'paid'
          AND oo.created_at < NOW() - INTERVAL '15 minutes'
          AND ol.authorization_status = 'seen'
          AND ol.quantity > 0
          AND ol.paid_quantity = 0
          AND ol.authority_fulfillable_quantity = 0
          AND ol.cancelled_quantity = 0 AND ol.refunded_quantity = 0
          AND ol.wms_materialized_quantity = 0
          AND NOT EXISTS (
            SELECT 1 FROM wms.orders wo
            WHERE (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
               OR wo.source_table_id = oo.id::text
          )
        )
      )
    GROUP BY oo.id, oo.external_order_id
    ORDER BY
      CASE WHEN oo.id > ${input.afterOmsOrderId} THEN 0 ELSE 1 END ASC,
      oo.id ASC
    LIMIT ${input.limit}
  `);

  return z.array(rowSchema).parse(candidates.rows).map(row => ({
    omsOrderId: row.oms_order_id, shopifyOrderId: row.shopify_order_id,
    needsPaidReplay: row.needs_paid_replay,
  }));
}
