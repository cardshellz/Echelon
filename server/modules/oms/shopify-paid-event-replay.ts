import { sql, type SQL } from "drizzle-orm";
import {
  automaticPaidReplayEvidenceSchema, decideAutomaticPaidReplay,
  type AutomaticPaidReplayEvidence, type PaidReplayStoredLine, type PaidReplayStoredOrder,
} from "./domain/shopify-paid-replay-policy";

interface ReplayTransaction {
  execute(statement: SQL): Promise<{ rows: unknown[] }>;
}
export interface PaidReplayDatabase extends ReplayTransaction {
  transaction<T>(work: (tx: ReplayTransaction) => Promise<T>): Promise<T>;
}
export interface PaidEventReplayResult {
  code: "OMS_PAID_WITHOUT_WMS";
  action: string;
  changed: boolean;
  omsOrderId: number;
  wmsOrderId: null;
  shipmentId: null;
  retryQueueId?: number | null;
  sourceInboxId?: number | null;
  provider?: string;
  topic?: string;
  reason?: string;
}
function firstRow<T>(result: { rows: unknown[] }): T | undefined {
  return result.rows[0] as T | undefined;
}
function positiveInt(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(field + " must be a positive integer");
  return parsed;
}
function reviewRequired(omsOrderId: number, reason: string): PaidEventReplayResult {
  return {
    code: "OMS_PAID_WITHOUT_WMS", action: "paid_replay_requires_review", changed: false,
    omsOrderId, wmsOrderId: null, shipmentId: null, reason
  };
}

/** One replay writer for both Control Tower and the bounded Shopify recovery sweep.
 * The original inbox and payload stay immutable. Automatic recovery additionally
 * checks fresh provider evidence against locked OMS rows before queuing anything. */
export async function queueOmsPaidEventReplay(
  db: PaidReplayDatabase,
  input: { omsOrderId: number; operator: string },
  automaticEvidence?: AutomaticPaidReplayEvidence,
): Promise<PaidEventReplayResult> {
  const evidence = automaticEvidence === undefined ? undefined
    : automaticPaidReplayEvidenceSchema.parse(automaticEvidence);
  const code = "OMS_PAID_WITHOUT_WMS" as const;
  const omsOrderId = positiveInt(input.omsOrderId, "omsOrderId");
  return db.transaction(async (tx: ReplayTransaction) => {
    // Serialize operator clicks for one OMS order. The retry worker preserves
    // the original inbox identity, so the paid handler replays the succeeded
    // source event instead of creating a second receipt.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext('oms_paid_without_wms_replay'), ${omsOrderId})
    `);

    const targetResult = await tx.execute(sql`
      SELECT oo.id, oo.channel_id, oo.external_order_id, oo.status, oo.financial_status,
             oo.fulfillment_status,
             oo.created_at < NOW() - INTERVAL '15 minutes' AS settled,
             paid_inbox.id AS paid_inbox_id, paid_inbox.source_domain, paid_inbox.paid_payload
      FROM oms.oms_orders oo
      LEFT JOIN LATERAL (
        SELECT wi.id, wi.source_domain, wi.payload AS paid_payload
        FROM oms.webhook_inbox wi
        WHERE wi.provider = 'shopify'
          AND wi.topic = 'orders/paid'
          AND wi.status = 'succeeded'
          AND COALESCE(wi.payload->>'id', wi.payload->>'order_id') = split_part(oo.external_order_id, '/', -1)
          ${evidence ? sql`AND wi.source_domain = ${evidence.shopDomain}` : sql``}
        ORDER BY COALESCE(wi.processed_at, wi.updated_at, wi.first_received_at) DESC NULLS LAST,
                 wi.id DESC
        LIMIT 1
      ) paid_inbox ON TRUE
      WHERE oo.id = ${omsOrderId}
        AND oo.status NOT IN ('cancelled', 'shipped')
        AND oo.financial_status IN ('paid', 'partially_paid')
        AND NOT EXISTS (
          SELECT 1
          FROM wms.orders wo
          WHERE (wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
             OR (wo.source_table_id = oo.id::text)
        )
        ${evidence ? sql`AND oo.channel_id = ${evidence.channelId}
          AND EXISTS (SELECT 1 FROM channels.channels channel
            WHERE channel.id = oo.channel_id AND channel.provider = 'shopify')` : sql``}
      LIMIT 1
      FOR UPDATE OF oo
    `);

    const target = firstRow<PaidReplayStoredOrder & { id: number; paid_inbox_id: number | null }>(targetResult);
    if (!target) {
      return {
        code,
        action: "paid_replay_not_queued",
        changed: false,
        omsOrderId,
        wmsOrderId: null,
        shipmentId: null,
        retryQueueId: null,
        sourceInboxId: null,
        provider: "shopify",
        topic: "orders/paid",
      };
    }

    const sourceInboxId = Number(target.paid_inbox_id);
    if (!Number.isInteger(sourceInboxId) || sourceInboxId <= 0) {
      if (evidence) return reviewRequired(omsOrderId, "succeeded_paid_receipt_missing");
      throw new Error(
        `No succeeded Shopify orders/paid inbox event found for OMS order ${omsOrderId}`,
      );
    }

    if (evidence) {
      const lineResult = await tx.execute(sql`
        SELECT external_line_item_id, sku, quantity, requires_shipping,
               paid_quantity, authority_fulfillable_quantity, cancelled_quantity, refunded_quantity,
               wms_materialized_quantity, authorization_status, channel_current_quantity,
               channel_quantity_updated_at
        FROM oms.oms_order_lines WHERE order_id = ${omsOrderId} ORDER BY id FOR UPDATE
      `);
      const decision = decideAutomaticPaidReplay(target, lineResult.rows as PaidReplayStoredLine[], evidence);
      if (!decision.eligible) return reviewRequired(omsOrderId, decision.reason);
    }

    const pendingResult = await tx.execute(sql`
      SELECT id
      FROM oms.webhook_retry_queue
      WHERE provider = 'shopify'
        AND topic = 'orders/paid'
        AND source_inbox_id = ${sourceInboxId}
        AND status = 'pending'
      ORDER BY id DESC
      LIMIT 1
    `);
    const pending = firstRow<{ id: number }>(pendingResult);
    if (pending) {
      return {
        code,
        action: "orders_paid_replay_already_pending",
        changed: false,
        omsOrderId,
        wmsOrderId: null,
        shipmentId: null,
        retryQueueId: Number(pending.id),
        sourceInboxId,
        provider: "shopify",
        topic: "orders/paid",
      };
    }

    const queuedResult = await tx.execute(sql`
      INSERT INTO oms.webhook_retry_queue (
        provider,
        topic,
        payload,
        source_inbox_id,
        attempts,
        last_error,
        next_retry_at,
        status,
        created_at,
        updated_at
      )
      SELECT wi.provider,
             wi.topic,
             wi.payload,
             wi.id,
             0,
             ${`OMS paid-event replay for OMS order ${omsOrderId} by ${input.operator || "unknown"}`},
             NOW(),
             'pending',
             NOW(),
             NOW()
      FROM oms.webhook_inbox wi
      WHERE wi.id = ${sourceInboxId}
        AND wi.provider = 'shopify'
        AND wi.topic = 'orders/paid'
        AND wi.status = 'succeeded'
      ON CONFLICT (source_inbox_id) WHERE status = 'pending' AND source_inbox_id IS NOT NULL
        DO NOTHING
      RETURNING id
    `);
    const queued = firstRow<{ id: number }>(queuedResult);
    if (!queued) {
      throw new Error(
        `Succeeded Shopify orders/paid inbox event ${sourceInboxId} is no longer replayable`,
      );
    }
    const retryQueueId = Number(queued.id);

    await tx.execute(sql`
      INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
      VALUES (
        ${omsOrderId},
        'flow_reconciliation_remediated',
        ${JSON.stringify({
      code,
      operator: input.operator,
      action: "replay_orders_paid",
      sourceInboxId,
      retryQueueId,
      ...(evidence ? {
        automatic: true, shopDomain: evidence.shopDomain,
        providerUpdatedAt: evidence.order.updated_at,
        lines: evidence.order.line_items.map(line => ({
          externalLineItemId: line.id, quantity: line.quantity,
        }))
      } : {}),
    })}::jsonb,
        NOW()
      )
    `);

    return {
      code,
      action: "queued_orders_paid_replay",
      changed: true,
      omsOrderId,
      wmsOrderId: null,
      shipmentId: null,
      retryQueueId,
      sourceInboxId,
      provider: "shopify",
      topic: "orders/paid",
    };
  });
}
