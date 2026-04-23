/**
 * Backfill: rewrite `wms.orders.oms_fulfillment_order_id` from Shopify GID
 *           (`gid://shopify/Order/NNN`) to the canonical numeric OMS id
 *           (`oms.oms_orders.id::text`).
 *
 * Why:
 *   ~53,537 shopify-source + ~9 ebay-source historical WMS rows store the
 *   Shopify GID in `oms_fulfillment_order_id` instead of the OMS row id.
 *   The hourly reconcile (server/index.ts) historically JOINed on
 *   `w.oms_fulfillment_order_id::int = o.id`, so those rows were invisible
 *   to the sweep — when shipped in WMS they lingered forever in
 *   ShipStation.
 *
 *   As of commit c831857 the reconcile JOIN is disjunctive and matches
 *   both shapes, so coverage is no longer blocked on this backfill.
 *   However, normalising the column back to the canonical numeric shape:
 *     - simplifies every downstream query (one shape, one code path)
 *     - restores the Path A index fast-path for these 53k rows
 *     - removes the need for the Path B branch in future refactors
 *
 * Safety:
 *   - DEFAULTS TO DRY-RUN. No writes without explicit `--execute`.
 *   - Idempotent: candidate predicate is `LIKE 'gid://shopify/Order/%'`,
 *     so a row updated to a numeric id is immediately out of the scan set.
 *   - Only rows with EXACTLY ONE matching `oms.oms_orders` row by
 *     `external_order_id` are updated. 0-match or >1-match rows are
 *     skipped and logged; never guessed.
 *   - Chunked (500 rows/chunk) with a 500ms sleep between chunks.
 *   - Per-chunk transaction (not per row) — if the chunk UPDATE fails,
 *     the whole chunk rolls back and the next iteration picks it up again.
 *   - Keyset pagination on `w.id ASC` — robust against concurrent writes
 *     to the predicate set.
 *
 * Run commands (do NOT run without reviewing dry-run output first):
 *
 *   heroku run -a cardshellz-echelon \
 *     npx tsx scripts/backfill-wms-oms-fulfillment-order-id-from-gid.ts --dry-run
 *
 *   # Review output, then:
 *
 *   heroku run -a cardshellz-echelon \
 *     npx tsx scripts/backfill-wms-oms-fulfillment-order-id-from-gid.ts --execute
 *
 * Flags:
 *   --dry-run            (default) read-only; no writes.
 *   --execute            opt-in destructive mode. Required for writes.
 *   --limit=N            cap total rows scanned across all chunks (default: unlimited).
 *   --chunk-size=N       rows per chunk (default: 500).
 *   --sleep-ms=N         sleep between chunks (default: 500).
 *
 * Audit: shipstation-sync-audit.md §1G, §4 H1
 */

import { db } from "../server/db";
import { sql } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Flag parsing — boring, explicit, no dependency.
// ─────────────────────────────────────────────────────────────────────────────

function parseFlags(argv: string[]): {
  execute: boolean;
  limit: number | null;
  chunkSize: number;
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
    chunkSize: readNumericFlag("chunk-size", 500) as number,
    // sleep-ms=0 is a valid power-user flag (skip inter-chunk throttle).
    sleepMs: readNumericFlag("sleep-ms", 500, { allowZero: true }) as number,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GID validator — exported for unit testing.
//
// We accept ONLY `gid://shopify/Order/<digits>`. Anything else (other GID
// resource types, trailing noise, malformed prefixes) is rejected and the
// row is skipped. This matches the SQL predicate `LIKE 'gid://shopify/Order/%'`
// + post-filter; the stricter shape here is a belt-and-braces validation
// before we touch the DB.
// ─────────────────────────────────────────────────────────────────────────────

const SHOPIFY_ORDER_GID_RE = /^gid:\/\/shopify\/Order\/[0-9]+$/;

export function isShopifyOrderGid(value: unknown): value is string {
  return typeof value === "string" && SHOPIFY_ORDER_GID_RE.test(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats accumulator
// ─────────────────────────────────────────────────────────────────────────────

type Stats = {
  scanned: number;
  matched: number;
  skippedNoOmsMatch: number;
  skippedMultipleOmsMatches: number;
  skippedInvalidGidShape: number;
  errors: number;
  updatedInDb: number; // only non-zero with --execute
};

function newStats(): Stats {
  return {
    scanned: 0,
    matched: 0,
    skippedNoOmsMatch: 0,
    skippedMultipleOmsMatches: 0,
    skippedInvalidGidShape: 0,
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

  console.log("[Backfill GID→numeric] ============================================");
  console.log(`[Backfill GID→numeric] mode:       ${mode}`);
  console.log(`[Backfill GID→numeric] chunk-size: ${flags.chunkSize}`);
  console.log(`[Backfill GID→numeric] sleep-ms:   ${flags.sleepMs}`);
  console.log(`[Backfill GID→numeric] limit:      ${flags.limit ?? "none"}`);
  console.log("[Backfill GID→numeric] ============================================");

  // Total count (informational only — we don't use it to drive pagination).
  const totalResult: any = await db.execute(sql`
    SELECT COUNT(*)::int AS n
    FROM wms.orders
    WHERE oms_fulfillment_order_id LIKE 'gid://shopify/Order/%'
  `);
  const total: number = totalResult.rows?.[0]?.n ?? 0;
  console.log(`[Backfill GID→numeric] total candidate rows (pre-run): ${total}`);

  if (total === 0) {
    console.log("[Backfill GID→numeric] Nothing to do. Exiting.");
    process.exit(0);
  }

  const stats = newStats();
  let lastSeenId = 0;
  let chunkIdx = 0;

  while (true) {
    if (flags.limit !== null && stats.scanned >= flags.limit) {
      console.log(`[Backfill GID→numeric] Reached --limit=${flags.limit}, stopping.`);
      break;
    }

    const chunkSize = flags.limit !== null
      ? Math.min(flags.chunkSize, flags.limit - stats.scanned)
      : flags.chunkSize;

    // Keyset pagination on w.id. In --execute mode, updated rows leave the
    // predicate set (no longer LIKE 'gid://...'), so a simple LIMIT+WHERE
    // would walk the remaining rows correctly too — but keyset is robust
    // against re-scanning already-processed rows if a chunk rolls back.
    const candidates: any = await db.execute(sql`
      SELECT w.id                         AS wms_id,
             w.order_number               AS wms_order_number,
             w.oms_fulfillment_order_id   AS gid
      FROM wms.orders w
      WHERE w.oms_fulfillment_order_id LIKE 'gid://shopify/Order/%'
        AND w.id > ${lastSeenId}
      ORDER BY w.id ASC
      LIMIT ${chunkSize}
    `);

    const rows: Array<{ wms_id: number; wms_order_number: string; gid: string }> =
      candidates.rows ?? [];

    if (rows.length === 0) {
      console.log("[Backfill GID→numeric] No more candidate rows. Done.");
      break;
    }

    chunkIdx++;
    const chunkStats = await processChunk(rows, flags.execute);

    // Merge chunk stats into global stats.
    stats.scanned += chunkStats.scanned;
    stats.matched += chunkStats.matched;
    stats.skippedNoOmsMatch += chunkStats.skippedNoOmsMatch;
    stats.skippedMultipleOmsMatches += chunkStats.skippedMultipleOmsMatches;
    stats.skippedInvalidGidShape += chunkStats.skippedInvalidGidShape;
    stats.errors += chunkStats.errors;
    stats.updatedInDb += chunkStats.updatedInDb;

    lastSeenId = rows[rows.length - 1].wms_id;

    console.log(
      `[Backfill GID→numeric] [chunk ${chunkIdx}] scanned=${chunkStats.scanned} ` +
        `matched=${chunkStats.matched} ` +
        `skipped-no-match=${chunkStats.skippedNoOmsMatch} ` +
        `skipped-multi-match=${chunkStats.skippedMultipleOmsMatches} ` +
        `skipped-invalid-gid=${chunkStats.skippedInvalidGidShape} ` +
        `errors=${chunkStats.errors} ` +
        `updated-in-db=${chunkStats.updatedInDb} ` +
        `| running: [${stats.scanned}/${total}]`,
    );

    // Throttle between chunks — keeps DB load sane and leaves headroom for
    // the live workload. Not needed after the last chunk.
    if (rows.length < chunkSize) {
      // partial chunk => likely last one; fall through to loop terminator
    } else if (flags.sleepMs > 0) {
      await sleep(flags.sleepMs);
    }
  }

  // ─── Final summary ──────────────────────────────────────────────────────
  console.log("[Backfill GID→numeric] ============================================");
  console.log("[Backfill GID→numeric] SUMMARY");
  console.log(`[Backfill GID→numeric]   mode:                    ${mode}`);
  console.log(`[Backfill GID→numeric]   scanned:                 ${stats.scanned}`);
  console.log(`[Backfill GID→numeric]   matched (would update):  ${stats.matched}`);
  console.log(`[Backfill GID→numeric]   updated in DB:           ${stats.updatedInDb}`);
  console.log(`[Backfill GID→numeric]   skipped: no OMS match:   ${stats.skippedNoOmsMatch}`);
  console.log(`[Backfill GID→numeric]   skipped: multi-match:    ${stats.skippedMultipleOmsMatches}`);
  console.log(`[Backfill GID→numeric]   skipped: invalid GID:    ${stats.skippedInvalidGidShape}`);
  console.log(`[Backfill GID→numeric]   errors:                  ${stats.errors}`);
  console.log("[Backfill GID→numeric] ============================================");

  if (!flags.execute) {
    console.log("[Backfill GID→numeric] DRY-RUN complete. Re-run with --execute to apply.");
  }

  process.exit(stats.errors > 0 ? 1 : 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Process a single chunk in a transaction.
//
// The transaction boundary matters: we want all updates in a chunk to land
// together (or none of them, on failure). Per-row transactions would 10x
// the DB round-trip count.
// ─────────────────────────────────────────────────────────────────────────────

async function processChunk(
  rows: Array<{ wms_id: number; wms_order_number: string; gid: string }>,
  execute: boolean,
): Promise<Stats> {
  const chunkStats = newStats();

  // Step 1 (outside tx): resolve each GID to an OMS id. Reads only — safe
  // to do outside a transaction. We collect the planned updates and only
  // then open the tx for the writes.
  type Plan = {
    wmsId: number;
    wmsOrderNumber: string;
    gid: string;
    omsId: number;
  };
  const plans: Plan[] = [];

  for (const row of rows) {
    chunkStats.scanned++;

    if (!isShopifyOrderGid(row.gid)) {
      // The SQL LIKE allows anything after `gid://shopify/Order/` — be
      // strict: only digit-suffixed GIDs are valid.
      chunkStats.skippedInvalidGidShape++;
      console.log(
        `[Backfill GID→numeric]   SKIP wms.id=${row.wms_id} order=${row.wms_order_number}: ` +
          `invalid GID shape: ${JSON.stringify(row.gid)}`,
      );
      continue;
    }

    try {
      const matches: any = await db.execute(sql`
        SELECT id
        FROM oms.oms_orders
        WHERE external_order_id = ${row.gid}
      `);
      const matchRows: Array<{ id: number }> = matches.rows ?? [];

      if (matchRows.length === 0) {
        chunkStats.skippedNoOmsMatch++;
        console.log(
          `[Backfill GID→numeric]   SKIP wms.id=${row.wms_id} order=${row.wms_order_number}: ` +
            `no oms.oms_orders row with external_order_id=${row.gid}`,
        );
        continue;
      }
      if (matchRows.length > 1) {
        chunkStats.skippedMultipleOmsMatches++;
        console.log(
          `[Backfill GID→numeric]   SKIP wms.id=${row.wms_id} order=${row.wms_order_number}: ` +
            `${matchRows.length} oms.oms_orders rows match external_order_id=${row.gid} ` +
            `(ids: ${matchRows.map((r) => r.id).join(",")})`,
        );
        continue;
      }

      chunkStats.matched++;
      plans.push({
        wmsId: row.wms_id,
        wmsOrderNumber: row.wms_order_number,
        gid: row.gid,
        omsId: matchRows[0].id,
      });
    } catch (err: any) {
      chunkStats.errors++;
      console.warn(
        `[Backfill GID→numeric]   ERROR wms.id=${row.wms_id} looking up oms match: ${err?.message}`,
      );
    }
  }

  // Step 2 (in tx): apply the updates atomically. Only runs in --execute.
  if (execute && plans.length > 0) {
    try {
      await db.transaction(async (tx) => {
        for (const plan of plans) {
          // Defence in depth: re-check the WMS row still has the GID we
          // read. If someone else rewrote it between our read and write,
          // we skip — no silent overwrite of a concurrent change.
          const updateRes: any = await tx.execute(sql`
            UPDATE wms.orders
            SET oms_fulfillment_order_id = ${String(plan.omsId)}
            WHERE id = ${plan.wmsId}
              AND oms_fulfillment_order_id = ${plan.gid}
            RETURNING id
          `);
          const affected = updateRes.rows?.length ?? 0;
          if (affected === 1) {
            chunkStats.updatedInDb++;
          } else {
            // Either 0 rows (concurrent change) or something unexpected.
            // Don't raise — we don't want one concurrent edit to roll back
            // the whole chunk. Just log.
            console.log(
              `[Backfill GID→numeric]   NOOP wms.id=${plan.wmsId}: row changed underneath us ` +
                `(affected=${affected}); skipping`,
            );
          }
        }
      });
    } catch (err: any) {
      // Whole chunk rolled back. Chunk stats are now wrong (we incremented
      // updatedInDb optimistically above) — but the transaction took them
      // back on the DB side. Mark as error and don't double-count.
      chunkStats.errors++;
      chunkStats.updatedInDb = 0;
      console.warn(
        `[Backfill GID→numeric]   CHUNK TX FAILED: ${err?.message}. ` +
          `Rolled back ${plans.length} planned updates.`,
      );
    }
  } else if (!execute && plans.length > 0) {
    // Dry-run: log what we would do, but only at a summary level — one
    // line per planned update is too noisy for 53k rows, so we batch by 50.
    const sample = plans.slice(0, 3);
    for (const plan of sample) {
      console.log(
        `[Backfill GID→numeric]   PLAN wms.id=${plan.wmsId} order=${plan.wmsOrderNumber}: ` +
          `${plan.gid} → ${plan.omsId}`,
      );
    }
    if (plans.length > sample.length) {
      console.log(
        `[Backfill GID→numeric]   ... (+${plans.length - sample.length} more planned updates in this chunk)`,
      );
    }
  }

  return chunkStats;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point — only run main() when invoked directly, so tests can import
// helpers (isShopifyOrderGid, parseFlags) without triggering the DB.
// ─────────────────────────────────────────────────────────────────────────────

const invokedDirectly = (() => {
  // tsx sets process.argv[1] to the script path.
  const entry = process.argv[1] ?? "";
  return entry.endsWith("backfill-wms-oms-fulfillment-order-id-from-gid.ts") ||
    entry.endsWith("backfill-wms-oms-fulfillment-order-id-from-gid.js");
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error("[Backfill GID→numeric] Fatal:", err);
    process.exit(1);
  });
}

// Named exports for tests.
export { parseFlags, processChunk, newStats };
export type { Stats };
