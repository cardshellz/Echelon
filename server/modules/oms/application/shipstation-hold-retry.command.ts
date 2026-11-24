import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

interface RetryTransaction {
  execute(statement: SQL): Promise<unknown>;
}
const inputSchema = z
  .object({
    wmsOrderId: z.number().int().positive().safe(),
    requestedMode: z.enum(["hold", "release"]),
    reason: z.string().min(1),
    now: z.date(),
  })
  .strict();

/**
 * Queue an OMS-owned provider hold retry inside the caller's order transaction.
 * The caller already owns the WMS row lock, serializing retries from this flow.
 * An existing pending retry owns reconciliation regardless of its requested
 * mode: the worker resolves the current hold state again before provider writes.
 */
export async function enqueueShipStationHoldSyncInTransaction(
  tx: RetryTransaction,
  input: z.infer<typeof inputSchema>,
): Promise<void> {
  const value = inputSchema.parse(input);
  await tx.execute(sql`INSERT INTO oms.webhook_retry_queue(provider,topic,payload,attempts,status,last_error,next_retry_at)
    SELECT 'internal','shipstation_hold_sync',${JSON.stringify({ wmsOrderId: value.wmsOrderId, requestedMode: value.requestedMode })}::jsonb,0,'pending',${value.reason},${value.now}
    WHERE NOT EXISTS(SELECT 1 FROM oms.webhook_retry_queue WHERE provider='internal' AND topic='shipstation_hold_sync' AND status='pending' AND payload->>'wmsOrderId'=${String(value.wmsOrderId)})`);
}
