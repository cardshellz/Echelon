/**
 * Backfill: set `wms.orders.oms_fulfillment_order_id` for legacy NULL rows
 *           by matching on `external_order_number` (and `channel_id`) to
 *           find the canonical `oms.oms_orders.id`.
 *
 * Why:
 *   53,537 historical `wms.orders` rows have `oms_fulfillment_order_id IS NULL`.
 *   These are pre-OMS-migration data. Of these:
 *     - ~19,724 are recoverable by matching to `oms.oms_orders` via
 *       `external_order_number` (conservative: also matched by `channel_id`)
 *     - ~33,813 are truly orphaned (no OMS row exists at all) — skipped
 *
 *   Per Overlord D11 era decisions: backfill where possible, leave orphans
 *   alone. The orphans are pre-OMS-migration data that has no OMS counterpart.
 *
 * Safety:
 *   - DEFAULTS TO DRY-RUN. No writes without explicit `--execute`.
 *   - Idempotent: candidate predicate is `oms_fulfillment_order_id IS NULL`,
 *     so a row updated to a numeric id is immediately out of the scan set.
 *   - Conservative channel match: both `channel_id` AND `external_order_number`
 *     must match. Rows where channels don't match are skipped (logged).
 *   - Chunked (500 rows/chunk) with a 500ms sleep between chunks.
 *   - Per-chunk transaction — if the chunk UPDATE fails, the whole chunk
 *     rolls back and the script exits (let the operator inspect).
 *   - Keyset pagination on `w.id ASC` — robust against concurrent writes.
 *
 * Plan reference: §6 Commit 31
 * Audit: shipstation-flow-refactor-plan.md
 *
 * Required env vars:
 *   EXTERNAL_DATABASE_URL  (preferred) or DATABASE_URL
 *
 * Run commands (do NOT run without reviewing dry-run output first):
 *
 *   npx tsx scripts/backfill-wms-oms-fulfillment-order-id-from-external-order-number.ts --dry-run
 *
 *   # Review output, then:
 *
 *   npx tsx scripts/backfill-wms-oms-fulfillment-order-id-from-external-order-number.ts --execute
 *
 * Flags:
 *   --dry-run            (default) read-only; no writes.
 *   --execute            opt-in write mode. Required for writes.
 *   --limit=N            cap total rows scanned across all chunks (default: unlimited).
 *   --batch-size=N       rows per chunk (default: 500).
 *   --sleep-ms=N         sleep between chunks (default: 500).
 */

import { db } from "../server/db";
import { sql } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Flag parsing — mirrors the GID backfill script pattern.
// ─────────────────────────────────────────────────────────────────────────────

function parseFlags(argv: string[]): {
  execute: boolean;
  limit: number | null;
  batchSize: number;
  sleepMs: number;
} {
  const execute = argv.includes("--execute");
  const dryRun = argv.includes("--dry-run");

  // Fail closed if both are passed — operator confusion is not a green light.
  if (execute && dryRun) {
    throw new Error(
      "Cannot pass both --dry-run and --execute. Pick one (default is --dry-run).",
    );
  }

  const readNumericFlag = (
    name: string,
    defaultValue: number | null,
    { allowZero = false }: { allowZero?: boolean } = {},
  ): number | null => {
    const prefix = `--${name}=`;
    const arg = argv.find((a) => a.startsWith(prefix));
    if (!arg) return defaultValue;
    const raw = arg.slice(prefix.length);
    const n = Number(raw);
    const minOk = allowZero ? n >= 0 : n > 0;
    if (!Number.isFinite(n) || !minOk || !Number.isInteger(n)) {
      const bound = allowZero ? "non-negative integer" : "positive integer";
      throw new Error(`--${name} must be a ${bound}, got: ${raw}`);
    }
    return n;
  };

  return {
    execute,
    limit: readNumericFlag("limit", null),
    batchSize: readNumericFlag("batch-size", 500) as number,
    // sleep-ms=0 is a valid power-user flag (skip inter-chunk throttle).
    sleepMs: readNumericFlag("sleep-ms", 500, { allowZero: true }) as number,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats accumulator
// ─────────────────────────────────────────────────────────────────────────────

type Stats = {
  scanned: number;
  matched: number;
  skippedOrphan: number;
  skippedChannelMismatch: number;
  errors: number;
  updatedInDb: number;
};

function newStats(): Stats {
  return {
    scanned: 0,
    matched: 0,
    skippedOrphan: 0,
    skippedChannelMismatch: 0,
    errors: 0,
    updatedInDb: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const mode = flags.execute ? "EXECUTE (WRITES ENABLED)" : "DRY-RUN (no writes)";

  console.log("[Backfill external-order-number] ============================================");
  console.log(`[Backfill external-order-number] mode:        ${mode}`);
  console.log(`[Backfill external-order-number] batch-size:  ${flags.batchSize}`);
  console.log(`[Backfill external-order-number] sleep-ms:    ${flags.sleepMs}`);
  console.log(`[Backfill external-order-number] limit:       ${flags.limit ?? "none"}`);
  console.log("[Backfill external-order-number] ============================================");

  // Total count (informational only).
  const totalResult: any = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM wms.orders
    WHERE oms_fulfillment_order_id IS NULL
      AND order_number IS NOT NULL
  `);
  const total: number = totalResult.rows?.[0]?.n ?? 0;
  console.log(`[Backfill external-order-number] total candidate rows (pre-run): ${total}`);

  if (total === 0) {
    console.log("[Backfill external-order-number] Nothing to do. Exiting.");
    process.exit(0);
  }

  const stats = newStats();
  let lastSeenId = 0;
  let batchIdx = 0;

  while (true) {
    if (flags.limit !== null && stats.scanned >= flags.limit) {
      console.log(`[Backfill external-order-number] Reached --limit=${flags.limit}, stopping.`);
      break;
    }

    const batchSize = flags.limit !== null
      ? Math.min(flags.batchSize, flags.limit - stats.scanned)
      : flags.batchSize;

    // Keyset pagination on w.id.
    const candidates: any = await db.execute(sql`
      SELECT w.id               AS wms_id,
             w.order_number     AS wms_order_number,
             w.channel_id       AS wms_channel_id
      FROM wms.orders w
      WHERE w.oms_fulfillment_order_id IS NULL
        AND w.order_number IS NOT NULL
        AND w.id > ${lastSeenId}
      ORDER BY w.id ASC
      LIMIT ${batchSize}
    `);

    const rows: Array<{ wms_id: number; wms_order_number: string; wms_channel_id: number | null }> =
      candidates.rows ?? [];

    if (rows.length === 0) {
      console.log("[Backfill external-order-number] No more candidate rows. Done.");
      break;
    }

    batchIdx++;
    const batchStats = await processBatch(rows, flags.execute);

    // Merge batch stats into global stats.
    stats.scanned += batchStats.scanned;
    stats.matched += batchStats.matched;
    stats.skippedOrphan += batchStats.skippedOrphan;
    stats.skippedChannelMismatch += batchStats.skippedChannelMismatch;
    stats.errors += batchStats.errors;
    stats.updatedInDb += batchStats.updatedInDb;

    lastSeenId = rows[rows.length - 1].wms_id;

    console.log(
      `[Backfill external-order-number] [batch ${batchIdx}] scanned=${batchStats.scanned} ` +
        `matched=${batchStats.matched} ` +
        `orphan=${batchStats.skippedOrphan} ` +
        `channel-mismatch=${batchStats.skippedChannelMismatch} ` +
        `errors=${batchStats.errors} ` +
        `updated-in-db=${batchStats.updatedInDb} ` +
        `| running: [${stats.scanned}/${total}]`,
    );

    // Throttle between batches.
    if (rows.length < batchSize) {
      // partial batch => likely last one; fall through to loop terminator
    } else if (flags.sleepMs > 0) {
      await sleep(flags.sleepMs);
    }
  }

  // ─── Final summary ──────────────────────────────────────────────────────
  console.log("[Backfill external-order-number] ============================================");
  console.log("[Backfill external-order-number] SUMMARY");
  console.log(`[Backfill external-order-number]   mode:                   ${mode}`);
  console.log(`[Backfill external-order-number]   scanned:                ${stats.scanned}`);
  console.log(`[Backfill external-order-number]   matched:                ${stats.matched}`);
  console.log(`[Backfill external-order-number]   updated in DB:          ${stats.updatedInDb}`);
  console.log(`[Backfill external-order-number]   orphan (skipped):       ${stats.skippedOrphan}`);
  console.log(`[Backfill external-order-number]   channel mismatch:       ${stats.skippedChannelMismatch}`);
  console.log(`[Backfill external-order-number]   errors:                 ${stats.errors}`);
  console.log("[Backfill external-order-number] ============================================");

  if (!flags.execute) {
    console.log("[Backfill external-order-number] DRY-RUN complete. Re-run with --execute to apply.");
  }

  process.exit(stats.errors > 0 ? 1 : 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Process a single batch in a transaction.
// ─────────────────────────────────────────────────────────────────────────────

async function processBatch(
  rows: Array<{ wms_id: number; wms_order_number: string; wms_channel_id: number | null }>,
  execute: boolean,
): Promise<Stats> {
  const batchStats = newStats();

  // Step 1 (outside tx): resolve each order_number to an OMS id. Reads only.
  type Plan = {
    wmsId: number;
    wmsOrderNumber: string;
    omsId: number;
  };
  const plans: Plan[] = [];

  for (const row of rows) {
    batchStats.scanned++;

    try {
      // Conservative match: both channel_id and external_order_number must match.
      // If wms.orders.channel_id is NULL, we can't do a safe channel match —
      // skip to avoid cross-channel mis-links.
      if (row.wms_channel_id === null) {
        batchStats.skippedChannelMismatch++;
        console.log(
          `[Backfill external-order-number]   SKIP wms.id=${row.wms_id} order=${row.wms_order_number}: ` +
            `wms.channel_id is NULL — cannot do conservative match`,
        );
        continue;
      }

      const matches: any = await db.execute(sql`
        SELECT id
        FROM oms.oms_orders
        WHERE external_order_number = ${row.wms_order_number}
          AND channel_id = ${row.wms_channel_id}
      `);
      const matchRows: Array<{ id: number }> = matches.rows ?? [];

      if (matchRows.length === 0) {
        batchStats.skippedOrphan++;
        continue;
      }

      // Take the first match. With the unique index on (channel_id, external_order_id)
      // there should be at most one, but we're matching on external_order_number
      // (not external_order_id), so multiple is possible in edge cases.
      const omsId = matchRows[0].id;

      batchStats.matched++;
      plans.push({
        wmsId: row.wms_id,
        wmsOrderNumber: row.wms_order_number,
        omsId,
      });
    } catch (err: any) {
      batchStats.errors++;
      console.warn(
        `[Backfill external-order-number]   ERROR wms.id=${row.wms_id} looking up OMS match: ${err?.message}`,
      );
    }
  }

  // Step 2 (in tx): apply the updates atomically. Only runs in --execute.
  if (execute && plans.length > 0) {
    try {
      await db.transaction(async (tx) => {
        for (const plan of plans) {
          // Defence in depth: re-check the WMS row still has NULL.
          const updateRes: any = await tx.execute(sql`
            UPDATE wms.orders
            SET oms_fulfillment_order_id = ${String(plan.omsId)}
            WHERE id = ${plan.wmsId}
              AND oms_fulfillment_order_id IS NULL
            RETURNING id
          `);
          const affected = updateRes.rows?.length ?? 0;
          if (affected === 1) {
            batchStats.updatedInDb++;
          } else {
            console.log(
              `[Backfill external-order-number]   NOOP wms.id=${plan.wmsId}: row changed underneath us ` +
                `(affected=${affected}); skipping`,
            );
          }
        }
      });
    } catch (err: any) {
      batchStats.errors++;
      batchStats.updatedInDb = 0;
      console.warn(
        `[Backfill external-order-number]   BATCH TX FAILED: ${err?.message}. ` +
          `Rolled back ${plans.length} planned updates. Exiting — operator must inspect.`,
      );
      process.exit(1);
    }
  } else if (!execute && plans.length > 0) {
    // Dry-run: log a sample.
    const sample = plans.slice(0, 3);
    for (const plan of sample) {
      console.log(
        `[Backfill external-order-number]   PLAN wms.id=${plan.wmsId} order=${plan.wmsOrderNumber}: ` +
          `SET oms_fulfillment_order_id = '${plan.omsId}'`,
      );
    }
    if (plans.length > sample.length) {
      console.log(
        `[Backfill external-order-number]   ... (+${plans.length - sample.length} more planned updates in this batch)`,
      );
    }
  }

  return batchStats;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point — only run main() when invoked directly.
// ─────────────────────────────────────────────────────────────────────────────

const invokedDirectly = (() => {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("backfill-wms-oms-fulfillment-order-id-from-external-order-number.ts") ||
    entry.endsWith("backfill-wms-oms-fulfillment-order-id-from-external-order-number.js");
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error("[Backfill external-order-number] Fatal:", err);
    process.exit(1);
  });
}

// Named exports for tests.
export { parseFlags, processBatch, newStats };
export type { Stats };
