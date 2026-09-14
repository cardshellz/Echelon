import { z } from "zod";
import type { Pool } from "pg";
const optionsSchema = z.object({
  from: z.string().date(),
  to: z.string().date(),
  apply: z.boolean(),
});
/** Bounded historical replay. Default preview reads counts only; application queues
 * current snapshots and never writes source orders, inventory or payments. */
export async function queueHistoricalArchonOrders(pool: Pool, input: unknown) {
  const options = optionsSchema.parse(input);
  if (options.to <= options.from) throw new Error("INVALID_REPLAY_RANGE");
  const db = await pool.connect();
  try {
    await db.query(
      options.apply
        ? "BEGIN ISOLATION LEVEL REPEATABLE READ"
        : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    await db.query("SET LOCAL statement_timeout='15s'");
    await db.query("SET LOCAL TIME ZONE 'UTC'");
    const rows = await db.query(
      `SELECT channel_id,count(*)::text AS orders FROM oms.oms_orders WHERE ordered_at >= $1::date AND ordered_at < $2::date GROUP BY channel_id ORDER BY channel_id`,
      [options.from, options.to],
    );
    const count = rows.rows.reduce((n, r) => n + BigInt(r.orders), BigInt(0));
    if (count > BigInt(10000))
      throw new Error("REPLAY_LIMIT_EXCEEDED_USE_SHORTER_RANGE");
    if (options.apply)
      await db.query(
        `INSERT INTO oms.archon_order_outbox(order_id)
   SELECT id FROM oms.oms_orders WHERE ordered_at >= $1::date AND ordered_at < $2::date
   ON CONFLICT(order_id) DO UPDATE SET revision=nextval('oms.archon_order_revision_seq'),next_attempt_at=now(),attempts=0,last_error=NULL`,
        [options.from, options.to],
      );
    await db.query("COMMIT");
    return {
      from: options.from,
      to: options.to,
      apply: options.apply,
      orders: String(count),
      channels: rows.rows,
    };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
