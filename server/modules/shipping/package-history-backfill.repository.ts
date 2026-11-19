import type { Pool } from "pg";
import { z } from "zod";
import { PackageHistoryError } from "./package-history.domain";

export const packageHistoryBackfillInputSchema = z
  .object({
    channelId: z.number().int().positive().safe(),
    runKey: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    actor: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(200),
  })
  .strict();
export type PackageHistoryBackfillInput = z.infer<
  typeof packageHistoryBackfillInputSchema
>;
const countSchema = z.number().int().nonnegative().safe();
const checkpointSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const statusSchema = z
  .object({
    cursor: z
      .object({
        after_order_id: checkpointSchema,
        through_order_id: checkpointSchema,
        state: z.enum(["scanning", "seeded"]),
        updated_at: z.date(),
      })
      .strict(),
    states: z.array(
      z
        .object({
          state: z.enum(["pending", "ready", "retry", "review"]),
          orders: countSchema,
          packages: countSchema,
          no_package_evidence: countSchema,
        })
        .strict(),
    ),
    errors: z.array(
      z
        .object({
          last_error_code: z.string().regex(/^PACKAGE_HISTORY_[A-Z_]+$/),
          orders: countSchema,
        })
        .strict(),
    ),
    coverage: z
      .object({
        source_orders: countSchema,
        unseeded_orders: countSchema,
        leased_orders: countSchema,
      })
      .strict(),
    measurements: z.array(
      z
        .object({
          state: z.enum(["verified", "missing", "invalid"]),
          packages: countSchema,
        })
        .strict(),
    ),
  })
  .strict();

/** Keyset checkpoint advancement and job creation commit together. Seeding is
 * not capture completion; status reports outstanding/review work separately. */
export class PackageHistoryBackfillRepository {
  constructor(private readonly pool: Pool) {}
  async seed(raw: PackageHistoryBackfillInput, now: Date) {
    const input = packageHistoryBackfillInputSchema.parse(raw);
    z.date().parse(now);
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      await client.query(
        "SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='15s'",
      );
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`shipping-package-history:${input.channelId}:${input.runKey}`],
      );
      const channel = await client.query(
        `SELECT c.id FROM channels.channels c WHERE c.id=$1 AND c.provider='shopify' AND c.type='internal' AND c.status='active'
        AND (SELECT count(*) FROM channels.channel_connections cc WHERE cc.channel_id=c.id AND cc.shop_domain IS NOT NULL AND NULLIF(BTRIM(cc.access_token),'') IS NOT NULL)=1`,
        [input.channelId],
      );
      if (channel.rows.length !== 1)
        throw new PackageHistoryError("PACKAGE_HISTORY_CONNECTION_AMBIGUOUS");
      await client.query(
        `INSERT INTO wms.shipping_package_history_backfills(run_key,channel_id,through_order_id,state,actor,updated_at)
        SELECT $1,$2,COALESCE(max(id),0),'scanning',$3,$4 FROM oms.oms_orders WHERE channel_id=$2
        ON CONFLICT(run_key,channel_id) DO NOTHING`,
        [input.runKey, input.channelId, input.actor, now],
      );
      const cursor = (
        await client.query(
          `SELECT after_order_id::text,through_order_id::text,state FROM wms.shipping_package_history_backfills
        WHERE run_key=$1 AND channel_id=$2 FOR UPDATE`,
          [input.runKey, input.channelId],
        )
      ).rows[0];
      const page = (
        await client.query(
          // Qualify the source column: ORDER BY the output alias "id" would
          // sort its text representation, while the cursor compares bigint IDs.
          `SELECT o.id::text AS id FROM oms.oms_orders o WHERE o.channel_id=$1 AND o.id>$2::bigint AND o.id<=$3::bigint ORDER BY o.id LIMIT $4`,
          [
            input.channelId,
            cursor.after_order_id,
            cursor.through_order_id,
            input.limit,
          ],
        )
      ).rows;
      const ids = page.map((row) => row.id as string);
      const seeded = ids.length
        ? ((
            await client.query(
              `INSERT INTO wms.shipping_package_history_jobs(oms_order_id)
        SELECT unnest($1::bigint[]) ORDER BY 1 ON CONFLICT(oms_order_id) DO NOTHING`,
              [ids],
            )
          ).rowCount ?? 0)
        : 0;
      const after = ids.at(-1) ?? cursor.through_order_id;
      const remaining = await client.query(
        `SELECT 1 FROM oms.oms_orders WHERE channel_id=$1 AND id>$2::bigint AND id<=$3::bigint LIMIT 1`,
        [input.channelId, after, cursor.through_order_id],
      );
      const state = remaining.rows.length ? "scanning" : "seeded";
      await client.query(
        `UPDATE wms.shipping_package_history_backfills SET after_order_id=$3::bigint,state=$4,actor=$5,updated_at=$6
        WHERE run_key=$1 AND channel_id=$2`,
        [input.runKey, input.channelId, after, state, input.actor, now],
      );
      await client.query("COMMIT");
      return {
        action: "shipping_package_history_seed" as const,
        actor: input.actor,
        channelId: input.channelId,
        runKey: input.runKey,
        before: cursor.after_order_id,
        after,
        through: cursor.through_order_id,
        scanned: ids.length,
        seeded,
        state,
        at: now.toISOString(),
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }
  async status(
    raw: Pick<PackageHistoryBackfillInput, "channelId" | "runKey">,
    now: Date,
  ) {
    const input = packageHistoryBackfillInputSchema
      .pick({ channelId: true, runKey: true })
      .parse(raw);
    z.date().parse(now);
    const client = await this.pool.connect();
    let broken = false;
    try {
      // Cursor and coverage must describe the same snapshot while workers run.
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      await client.query("SET LOCAL statement_timeout='15s'");
      const cursor =
        (
          await client.query(
            `SELECT after_order_id::text,through_order_id::text,state,updated_at FROM wms.shipping_package_history_backfills
      WHERE channel_id=$1 AND run_key=$2`,
            [input.channelId, input.runKey],
          )
        ).rows[0] ?? null;
      if (!cursor) {
        await client.query("COMMIT");
        return {
          cursor: null,
          states: [],
          errors: [],
          coverage: null,
          measurements: [],
        };
      }
      const values = [input.channelId, cursor.through_order_id];
      const states = (
        await client.query(
          `WITH observations AS (
      SELECT j.document,CASE WHEN (j.computed_generation IS DISTINCT FROM j.generation OR j.verified_at>$3::timestamptz) AND j.state='ready'
        OR EXISTS(SELECT 1 FROM wms.shipping_package_history_invalidations dirty WHERE dirty.oms_order_id=j.oms_order_id)
        THEN 'pending' ELSE j.state END AS effective_state
      FROM wms.shipping_package_history_jobs j JOIN oms.oms_orders o ON o.id=j.oms_order_id
      WHERE o.channel_id=$1 AND o.id<=$2::bigint)
      SELECT effective_state AS state,count(*)::int AS orders,
        COALESCE(sum(CASE WHEN effective_state='ready' THEN jsonb_array_length(COALESCE(document->'packages','[]'::jsonb)) ELSE 0 END),0)::int AS packages,
        count(*) FILTER(WHERE effective_state='ready' AND jsonb_array_length(document->'packages')=0)::int AS no_package_evidence
      FROM observations GROUP BY effective_state ORDER BY effective_state`,
          [...values, now],
        )
      ).rows;
      const errors = (
        await client.query(
          `SELECT last_error_code,count(*)::int AS orders FROM wms.shipping_package_history_jobs j
      JOIN oms.oms_orders o ON o.id=j.oms_order_id WHERE o.channel_id=$1 AND o.id<=$2::bigint AND last_error_code IS NOT NULL
      GROUP BY last_error_code ORDER BY last_error_code`,
          values,
        )
      ).rows;
      const coverage = (
        await client.query(
          `SELECT count(*)::int AS source_orders,count(*) FILTER(WHERE j.oms_order_id IS NULL)::int AS unseeded_orders,
      count(*) FILTER(WHERE j.lease_until>$3::timestamptz)::int AS leased_orders
      FROM oms.oms_orders o LEFT JOIN wms.shipping_package_history_jobs j ON j.oms_order_id=o.id WHERE o.channel_id=$1 AND o.id<=$2::bigint`,
          [...values, now],
        )
      ).rows[0];
      const measurements = (
        await client.query(
          `SELECT p->>'measurementStatus' AS state,count(*)::int AS packages
      FROM wms.shipping_package_history_jobs j JOIN oms.oms_orders o ON o.id=j.oms_order_id
      CROSS JOIN LATERAL jsonb_array_elements(j.document->'packages') p
      WHERE o.channel_id=$1 AND o.id<=$2::bigint AND j.state='ready' AND j.computed_generation=j.generation
      AND j.verified_at<=$3::timestamptz
      AND NOT EXISTS(SELECT 1 FROM wms.shipping_package_history_invalidations dirty WHERE dirty.oms_order_id=j.oms_order_id)
      GROUP BY p->>'measurementStatus' ORDER BY state`,
          [...values, now],
        )
      ).rows;
      const result = statusSchema.parse({
        cursor,
        states,
        errors,
        coverage,
        measurements,
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }

  async retryReview(raw: PackageHistoryBackfillInput, now: Date) {
    const input = packageHistoryBackfillInputSchema.parse(raw);
    z.date().parse(now);
    const result = await this.pool.query(
      `INSERT INTO wms.shipping_package_history_invalidations(oms_order_id)
      SELECT j.oms_order_id FROM wms.shipping_package_history_jobs j JOIN oms.oms_orders o ON o.id=j.oms_order_id
      JOIN wms.shipping_package_history_backfills b ON b.channel_id=o.channel_id AND b.run_key=$2 AND o.id<=b.through_order_id
      WHERE o.channel_id=$1 AND j.state='review'
      AND NOT EXISTS(SELECT 1 FROM wms.shipping_package_history_invalidations dirty WHERE dirty.oms_order_id=j.oms_order_id)
      ORDER BY j.oms_order_id LIMIT $3 RETURNING oms_order_id`,
      [input.channelId, input.runKey, input.limit],
    );
    return {
      action: "shipping_package_history_retry_review",
      channelId: input.channelId,
      runKey: input.runKey,
      actor: input.actor,
      enqueued: result.rowCount ?? 0,
      at: now.toISOString(),
    };
  }
}
