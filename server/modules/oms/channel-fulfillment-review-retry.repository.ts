import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  ChannelFulfillmentReviewRetryError,
  previewChannelFulfillmentReviewRetry,
  reviewRetryExecutionSchema,
  reviewRetryIdempotencyKey,
  reviewRetryScopeSchema,
  reviewRetrySnapshotSchema,
  type ChannelFulfillmentReviewRetryExecution,
  type ChannelFulfillmentReviewRetryPreview,
  type ChannelFulfillmentReviewRetryResult,
  type ChannelFulfillmentReviewRetryScope,
} from "./channel-fulfillment-review-retry.domain";

interface QueryExecutor {
  execute(query: SQL): Promise<unknown>;
}
export interface ChannelFulfillmentReviewRetryDatabase extends QueryExecutor {
  transaction<T>(work: (transaction: QueryExecutor) => Promise<T>): Promise<T>;
}
export interface ChannelFulfillmentReviewRetryRepository {
  preview(input: ChannelFulfillmentReviewRetryScope): Promise<ChannelFulfillmentReviewRetryPreview>;
  requeue(input: ChannelFulfillmentReviewRetryExecution): Promise<ChannelFulfillmentReviewRetryResult>;
}

const queryResultSchema = z.object({ rows: z.array(z.record(z.unknown())) });
function resultRows(result: unknown): Record<string, unknown>[] {
  return queryResultSchema.parse(result).rows;
}

async function loadSnapshot(
  executor: QueryExecutor,
  scope: ChannelFulfillmentReviewRetryScope,
  lock: boolean,
): Promise<ChannelFulfillmentReviewRetryPreview> {
  const result = resultRows(await executor.execute(sql`
    SELECT jsonb_build_object(
      'commandId', command.id,
      'omsOrderId', command.oms_order_id,
      'orderNumber', oms_order.external_order_number,
      'externalOrderId', oms_order.external_order_id,
      'channelId', oms_order.channel_id,
      'provider', command.channel_provider,
      'physicalShipmentId', command.physical_shipment_id,
      'providerPhysicalShipmentId', command.metadata->>'providerPhysicalShipmentId',
      'trackingNumber', command.tracking_number,
      'carrier', command.carrier,
      'trackingUrl', command.tracking_url,
      'shippedAt', command.shipped_at,
      'channelFulfillmentScopeKey', command.channel_fulfillment_scope_key,
      'metadata', command.metadata,
      'commandKey', command.command_key,
      'requestHash', command.request_hash,
      'status', command.push_status,
      'attemptCount', command.attempt_count,
      'maxAttempts', command.max_attempts,
      'lastErrorCode', command.last_error_code,
      'lastError', command.last_error,
      'leaseToken', command.lease_token,
      'items', COALESCE(item_scope.items, '[]'::jsonb)
    ) AS snapshot
    FROM oms.channel_fulfillment_pushes AS command
    JOIN oms.oms_orders AS oms_order ON oms_order.id = command.oms_order_id
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'pushItemId', item.id,
        'physicalShipmentItemId', item.physical_shipment_item_id,
        'omsOrderLineId', item.oms_order_line_id,
        'channelOrderLineId', item.channel_order_line_id,
        'quantity', item.quantity_pushed,
        'sku', order_line.sku
      ) ORDER BY item.id) AS items
      FROM oms.channel_fulfillment_push_items AS item
      LEFT JOIN oms.oms_order_lines AS order_line
        ON order_line.id = item.oms_order_line_id AND order_line.order_id = command.oms_order_id
      WHERE item.channel_fulfillment_push_id = command.id
    ) AS item_scope ON TRUE
    WHERE command.id = ${scope.commandId} AND command.oms_order_id = ${scope.omsOrderId}
    ${lock ? sql`FOR UPDATE OF command` : sql``}
  `));
  if (result.length === 0) {
    throw new ChannelFulfillmentReviewRetryError(
      "REVIEW_RETRY_COMMAND_NOT_FOUND", "The command does not belong to the requested OMS order", 404,
      { ...scope },
    );
  }
  if (result.length !== 1) throw new Error("Reviewed retry snapshot returned multiple commands");
  return previewChannelFulfillmentReviewRetry(reviewRetrySnapshotSchema.parse(result[0].snapshot));
}

function classifyError(error: unknown): ChannelFulfillmentReviewRetryError {
  if (error instanceof ChannelFulfillmentReviewRetryError) return error;
  const postgresCode = typeof (error as { code?: unknown } | null)?.code === "string"
    ? String((error as { code: string }).code) : null;
  const retryable = postgresCode === "40001" || postgresCode === "40P01" || postgresCode === "55P03";
  return new ChannelFulfillmentReviewRetryError(
    "REVIEW_RETRY_DATABASE_ERROR", "Reviewed command retry database operation failed",
    retryable ? 503 : 500, { postgresCode, retryable },
  );
}

export function createChannelFulfillmentReviewRetryRepository(
  db: ChannelFulfillmentReviewRetryDatabase,
): ChannelFulfillmentReviewRetryRepository {
  return {
    async preview(rawInput) {
      const input = reviewRetryScopeSchema.safeParse(rawInput);
      if (!input.success) {
        throw new ChannelFulfillmentReviewRetryError(
          "INVALID_REVIEW_RETRY_INPUT", "A single positive commandId and omsOrderId are required", 400,
        );
      }
      try {
        return await loadSnapshot(db, input.data, false);
      } catch (error) {
        throw classifyError(error);
      }
    },
    async requeue(rawInput) {
      const parsed = reviewRetryExecutionSchema.safeParse(rawInput);
      if (!parsed.success) {
        throw new ChannelFulfillmentReviewRetryError(
          "INVALID_REVIEW_RETRY_INPUT", "Invalid reviewed retry execution input", 400,
          { issues: parsed.error.issues },
        );
      }
      const input = parsed.data;
      const idempotencyKey = reviewRetryIdempotencyKey(input);
      try {
        return await db.transaction(async (transaction) => {
          const current = await loadSnapshot(transaction, input, true);
          const prior = resultRows(await transaction.execute(sql`
            SELECT operator, reason, previous_request_hash, previous_status, previous_attempt_count
            FROM oms.channel_fulfillment_push_requeues
            WHERE channel_fulfillment_push_id = ${input.commandId}
              AND idempotency_key = ${idempotencyKey}
          `));
          // Check the exact prior action before the current status: the worker
          // may already have advanced this command since our first response.
          if (prior.length > 0) {
            if (prior.length !== 1
              || prior[0].operator !== input.actor
              || prior[0].reason !== input.reason
              || prior[0].previous_request_hash !== current.snapshot.requestHash
              || prior[0].previous_status !== "review"
              || !Number.isSafeInteger(Number(prior[0].previous_attempt_count))
              || Number(prior[0].previous_attempt_count) > current.snapshot.attemptCount) {
              throw new ChannelFulfillmentReviewRetryError(
                "REVIEW_RETRY_IDEMPOTENCY_CONFLICT", "The recorded retry action does not match this request", 409,
              );
            }
            return Object.freeze({ ...current, mode: "execute" as const, replayed: true, requeued: false });
          }
          if (current.stateFingerprint !== input.expectedStateFingerprint) {
            throw new ChannelFulfillmentReviewRetryError(
              "REVIEW_RETRY_STATE_CHANGED", "The command changed; preview it again before retrying", 409,
              { commandId: input.commandId },
            );
          }
          if (!current.eligibleForRecheck) {
            throw new ChannelFulfillmentReviewRetryError(
              "REVIEW_RETRY_NOT_ELIGIBLE", "The command is not eligible for this reviewed recheck", 409,
              { commandId: input.commandId, blockers: current.blockers },
            );
          }
          const audit = resultRows(await transaction.execute(sql`
            INSERT INTO oms.channel_fulfillment_push_requeues (
              channel_fulfillment_push_id, idempotency_key, operator, reason,
              previous_status, previous_attempt_count, previous_error_code,
              previous_error_message, previous_request_hash, created_at
            ) VALUES (
              ${input.commandId}, ${idempotencyKey}, ${input.actor}, ${input.reason},
              ${current.snapshot.status}, ${current.snapshot.attemptCount}, ${current.snapshot.lastErrorCode},
              ${current.snapshot.lastError}, ${current.snapshot.requestHash}, ${input.requeuedAt}
            ) RETURNING id
          `));
          if (audit.length !== 1) throw new Error("Reviewed retry audit was not persisted");
          const updated = resultRows(await transaction.execute(sql`
            UPDATE oms.channel_fulfillment_pushes
            SET push_status = 'pending', next_attempt_at = ${input.requeuedAt},
                lease_token = NULL, lease_expires_at = NULL,
                last_error_code = NULL, last_error = NULL,
                completed_at = NULL, updated_at = ${input.requeuedAt}
            WHERE id = ${input.commandId} AND oms_order_id = ${input.omsOrderId}
              AND push_status = 'review' AND attempt_count = ${current.snapshot.attemptCount}
              AND request_hash = ${current.snapshot.requestHash}
            RETURNING id
          `));
          if (updated.length !== 1) throw new Error("Reviewed retry state changed while locked");
          return Object.freeze({ ...current, mode: "execute" as const, replayed: false, requeued: true });
        });
      } catch (error) {
        throw classifyError(error);
      }
    },
  };
}
