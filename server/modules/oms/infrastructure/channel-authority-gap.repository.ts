import { sql, type SQL } from "drizzle-orm";
import {
  CHANNEL_AUTHORITY_GAP_EVENT_TYPE,
  OMS_PAID_QUANTITY_BELOW_CHANNEL,
  summarizeChannelAuthorityGap,
  type ChannelAuthorityGap,
} from "../domain/channel-payment-settlement";
import { logger } from "../../../platform/observability/logger";

/**
 * Serializes gap recording per OMS order so concurrent webhooks and the
 * reconciler cannot both append the same unchanged gap. Namespace chosen to
 * not collide with the other 9184xx OMS order locks.
 */
const CHANNEL_AUTHORITY_GAP_LOCK_NAMESPACE = 918431;

interface GapExecutor {
  execute(statement: SQL): Promise<{ rows?: unknown[] }>;
  transaction<T>(fn: (tx: GapExecutor) => Promise<T>): Promise<T>;
}

/**
 * Make units the channel sold but OMS will not ship visible, every time.
 *
 * Records one append-only oms_order_events row per distinct gap (an unchanged
 * gap observed again by later webhooks or reconciler runs is not re-appended)
 * and emits one structured log line per observation:
 *  - OMS_LINE_AWAITING_CHANNEL_PAYMENT (info): the channel says money is owed.
 *  - OMS_PAID_QUANTITY_BELOW_CHANNEL (error): the channel says fully paid, yet
 *    OMS still will not ship; a human must look.
 * Returns the gap, or null when every bought unit is authorized.
 */
export async function recordChannelAuthorityGap(
  db: GapExecutor,
  input: {
    omsOrderId: number;
    externalOrderNumber: string | null;
    channelPaymentSettled: boolean | null;
    sourceEventId: string;
  },
): Promise<ChannelAuthorityGap | null> {
  if (!Number.isSafeInteger(input.omsOrderId) || input.omsOrderId <= 0) {
    throw new Error(`recordChannelAuthorityGap: omsOrderId must be a positive integer (got ${input.omsOrderId})`);
  }

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${CHANNEL_AUTHORITY_GAP_LOCK_NAMESPACE}, ${input.omsOrderId})`);
    const lineRows = await tx.execute(sql`
      SELECT id, sku, quantity, channel_current_quantity, paid_quantity,
             authorization_status, requires_shipping
      FROM oms.oms_order_lines
      WHERE order_id = ${input.omsOrderId}
    `);
    const gap = summarizeChannelAuthorityGap({
      channelPaymentSettled: input.channelPaymentSettled,
      lines: ((lineRows.rows ?? []) as any[]).map((row) => ({
        id: Number(row.id),
        sku: row.sku ?? null,
        quantity: row.quantity == null ? null : Number(row.quantity),
        channelCurrentQuantity: row.channel_current_quantity == null ? null : Number(row.channel_current_quantity),
        paidQuantity: row.paid_quantity == null ? null : Number(row.paid_quantity),
        authorizationStatus: row.authorization_status ?? null,
        requiresShipping: row.requires_shipping == null ? null : Boolean(row.requires_shipping),
      })),
    });
    if (!gap) return { gap: null, recorded: false };

    const last = await tx.execute(sql`
      SELECT details->>'signature' AS signature
      FROM oms.oms_order_events
      WHERE order_id = ${input.omsOrderId}
        AND event_type = ${CHANNEL_AUTHORITY_GAP_EVENT_TYPE}
      ORDER BY id DESC
      LIMIT 1
    `);
    const lastSignature = ((last.rows ?? [])[0] as { signature?: string } | undefined)?.signature ?? null;
    if (lastSignature === gap.signature) return { gap, recorded: false };

    await tx.execute(sql`
      INSERT INTO oms.oms_order_events (order_id, event_type, details)
      VALUES (
        ${input.omsOrderId},
        ${CHANNEL_AUTHORITY_GAP_EVENT_TYPE},
        ${JSON.stringify({
          code: gap.code,
          signature: gap.signature,
          channelPaymentSettled: input.channelPaymentSettled,
          sourceEventId: input.sourceEventId,
          lines: gap.lines,
        })}::jsonb
      )
    `);
    return { gap, recorded: true };
  });

  if (outcome.gap) {
    const line = JSON.stringify({
      level: outcome.gap.code === OMS_PAID_QUANTITY_BELOW_CHANNEL ? "error" : "info",
      action: "oms_channel_authority_gap",
      outcome: outcome.recorded ? "recorded" : "unchanged",
      error_code: outcome.gap.code,
      oms_order_id: input.omsOrderId,
      external_order_number: input.externalOrderNumber,
      channel_event_id: input.sourceEventId,
      lines: outcome.gap.lines,
    });
    if (outcome.gap.code === OMS_PAID_QUANTITY_BELOW_CHANNEL) logger.error("oms.channel_authority_gap_repository", { error: line });
    else logger.info("oms.channel_authority_gap_repository", { detail: line });
  }
  return outcome.gap;
}
