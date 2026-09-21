import type { Pool } from "pg";
import { z } from "zod";
import {
  channelOrderIdentitySchema, channelOrderObservationSchema, ChannelOrderObservationError,
  reconcileChannelOrderLineDisposition, type ChannelOrderIdentity, type ChannelOrderObservation,
  type ChannelOrderObservationWriter, type ChannelOrderLineDisposition,
} from "./channel-order-observation";

/** Transactional OMS implementation of the normalized channel-observation API. */
export class PostgresChannelOrderObservationWriter implements ChannelOrderObservationWriter {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async findOrder(identity: ChannelOrderIdentity): Promise<number | null> {
    const input = channelOrderIdentitySchema.parse(identity);
    const client = await this.pool.connect();
    try {
      const result = await client.query(`SELECT o.id FROM oms.oms_orders o
        JOIN channels.channels c ON c.id=o.channel_id AND c.provider=$3
        WHERE o.channel_id=$1 AND o.external_order_id=$2`, [input.channelId, input.externalOrderId, input.provider]);
      if (result.rows.length > 1) throw new ChannelOrderObservationError("OMS_ORDER_IDENTITY_AMBIGUOUS", "Multiple OMS orders share this channel order identity");
      return result.rows[0] ? z.coerce.number().int().positive().safe().parse(result.rows[0].id) : null;
    } finally { client.release(); }
  }

  async reconcile(observation: ChannelOrderObservation): Promise<void> {
    const input = channelOrderObservationSchema.parse(observation);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // A stale/corrupt receipt must never select another channel's order by ID.
      const before = await client.query(`SELECT o.id,o.status,o.fulfillment_status,o.subtotal_cents,o.shipping_cents,o.tax_cents,o.total_cents
        FROM oms.oms_orders o JOIN channels.channels c ON c.id=o.channel_id AND c.provider=$4
        WHERE o.id=$1 AND o.channel_id=$2 AND o.external_order_id=$3 FOR UPDATE OF o`,
      [input.orderId, input.channelId, input.externalOrderId, input.provider]);
      if (before.rowCount !== 1) throw new ChannelOrderObservationError("OMS_ORDER_MISSING", "Imported channel order could not be resolved in its exact scope");
      const header = before.rows[0];
      if (header.subtotal_cents !== input.subtotalCents || header.shipping_cents !== input.shippingCents
        || header.tax_cents !== input.taxCents || header.total_cents !== input.totalCents) {
        throw new ChannelOrderObservationError("OMS_ORDER_FINANCIAL_DRIFT", "Channel order totals changed after import and require financial reconciliation");
      }
      const existing = await client.query<ChannelOrderLineDisposition & {
        id: number; external_line_item_id: string; paid_price_cents: number; total_price_cents: number;
      }>(`SELECT id,external_line_item_id,quantity,cancelled_quantity,refunded_quantity,authority_fulfillable_quantity,
        authorization_status,paid_price_cents,total_price_cents FROM oms.oms_order_lines WHERE order_id=$1 ORDER BY id FOR UPDATE`, [input.orderId]);
      if (existing.rows.length !== input.lines.length) {
        throw new ChannelOrderObservationError("OMS_ORDER_AUTHORITY_CONFLICT", "Observed lines do not match the complete imported order");
      }
      const changes: Array<{ lineNumber: string; before: ChannelOrderLineDisposition; after: ChannelOrderLineDisposition }> = [];
      for (const line of input.lines) {
        const matches = existing.rows.filter(row => row.external_line_item_id === line.externalLineItemId);
        if (matches.length !== 1) throw new ChannelOrderObservationError("OMS_ORDER_AUTHORITY_CONFLICT", "Channel line identity could not be resolved exactly");
        const prior = matches[0];
        if (prior.paid_price_cents !== line.paidPriceCents || prior.total_price_cents !== line.totalCents) {
          throw new ChannelOrderObservationError("OMS_ORDER_FINANCIAL_DRIFT", "Channel line prices changed after import and require financial reconciliation");
        }
        const after = reconcileChannelOrderLineDisposition(line, prior);
        changes.push({ lineNumber: line.externalLineItemId, before: prior, after });
        await client.query(`UPDATE oms.oms_order_lines SET cancelled_quantity=$2,authority_fulfillable_quantity=$3,
          authorization_status=$4,updated_at=$5 WHERE id=$1`, [prior.id, after.cancelled_quantity, after.authority_fulfillable_quantity, after.authorization_status, input.observedAt]);
      }
      await client.query(`UPDATE oms.oms_orders SET status=CASE WHEN $2='cancelled' THEN 'cancelled' ELSE status END,
        fulfillment_status=CASE WHEN $5='fulfilled' THEN 'fulfilled' ELSE fulfillment_status END,
        raw_payload=$3::jsonb,updated_at=$4 WHERE id=$1`,
      [input.orderId, input.status, JSON.stringify(input.rawPayload), input.observedAt, input.fulfillmentStatus]);
      await client.query(`INSERT INTO oms.oms_order_events (order_id,event_type,details,created_at) VALUES ($1,$2,$3::jsonb,$4)`,
        [input.orderId, `${input.provider}_order_observed`, JSON.stringify({ actor: input.actor, sourceEventId: input.sourceEventId,
          before: header, providerStatus: input.status, changes,
          lines: input.lines.map(line => ({ lineNumber: line.externalLineItemId, states: line.providerStates })) }), input.observedAt]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
}
