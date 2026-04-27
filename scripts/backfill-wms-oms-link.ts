/**
 * Backfill (v2 — consolidated): rewrite `wms.orders.oms_fulfillment_order_id`
 * to the canonical numeric OMS id (`oms.oms_orders.id::text`) using two paths:
 *
 *   Path A — GID rows:
 *     Rows where `oms_fulfillment_order_id` contains a Shopify GID
 *     (`gid://shopify/Order/NNN`).  Matches via `oms.oms_orders.external_order_id`.
 *
 *   Path B — NULL rows:
 *     Rows where `oms_fulfillment_order_id IS NULL`.  Matches via
 *     `oms.oms_orders.external_order_number = wms.orders.order_number`
 *     AND `oms.channel_id = wms.channel_id` (conservative match).
 *
 * This script replaces BOTH of the prior single-purpose backfill scripts:
 *   - `backfill-wms-oms-fulfillment-order-id-from-gid.ts`       (GID path)
 *   - `backfill-wms-oms-fulfillment-order-id-from-external-order-number.ts` (NULL path)
 *
 * Those scripts are left as historical artifacts; new ops should use this one.
 *
 * Plan reference: §6 Commit 34
 *
 * Safety:
 *   - DEFAULTS TO DRY-RUN.  No writes without explicit `--execute`.
 *   - Idempotent: each path's candidate predicate excludes rows already
 *     normalised (GID rows become numeric; NULL rows become non-NULL),
 *     so re-running finds zero work.
 *   - Only rows with EXACTLY ONE matching `oms.oms_orders` row are updated.
 *     0-match or >1-match rows are skipped and logged; never guessed.
 *   - Chunked (500 rows/chunk) with a 500 ms sleep between chunks.
 *   - Per-chunk transaction — if the chunk UPDATE fails, the whole chunk
 *     rolls back and the next iteration picks it up again.
 *   - Keyset pagination on `w.id ASC` — robust against concurrent writes.
 *
 * Run commands (do NOT run without reviewing dry-run output first):
 *
 *   npx tsx scripts/backfill-wms-oms-link.ts --dry-run
 *
 *   # Review output, then:
 *
 *   npx tsx scripts/backfill-wms-oms-link.ts --execute
 *
 *   # Run only Path A (GID):
 *
 *   npx tsx scripts/backfill-wms-oms-link.ts --dry-run --path=A
 *
 *   # Run only Path B (NULL):
 *
 *   npx tsx scripts/backfill-wms-oms-link.ts --dry-run --path=B
 *
 * Flags:
 *   --dry-run            (default) read-only; no writes.
 *   --execute            opt-in write mode.  Required for writes.
 *   --limit=N            cap total rows scanned across all chunks (default: unlimited).
 *   --batch-size=N       rows per chunk (default: 500).
 *   --sleep-ms=N         sleep between chunks (default: 500).
 *   --path=A|B|both      restrict to one path (default: both).  Path A runs first.
 */

import { db } from "../server/db";
import { sql } from "drizzle-orm";

// ─────────────────────────────────────────────────────────────────────────────
// Flag parsing
// ─────────────────────────────────────────────────────────────────────────────

type PathFlag = "A" | "B" | "both";

function parseFlags(argv: string[]): {
  execute: boolean;
  limit: number | null;
  batchSize: number;
  sleepMs: number;
  path: PathFlag;
} {
  const execute = argv.includes("--execute");
  const dryRun = argv.includes("--dry-run");

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

  // --path flag
  const pathArg = argv.find((a) => a.startsWith("--path="));
  let path: PathFlag = "both";
  if (pathArg) {
    const raw = pathArg.slice("--path=".length);
    if (raw !== "A" && raw !== "B" && raw !== "both") {
      throw new Error(`--path must be A, B, or both; got: ${raw}`);
    }
    path = raw;
  }

  return {
    execute,
    limit: readNumericFlag("limit", null),
    batchSize: readNumericFlag("batch-size", 500) as number,
    sleepMs: readNumericFlag("sleep-ms", 500, { allowZero: true }) as number,
    path,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GID validator — exported for unit testing.
// ─────────────────────────────────────────────────────────────────────────────

const SHOPIFY_ORDER_GID_RE = /^gid:\/\/shopify\/Order\/[0-9]+$/;

export function isShopifyOrderGid(value: unknown): value is string {
  return typeof value === "string" && SHOPIFY_ORDER_GID_RE.test(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats accumulators
// ─────────────────────────────────────────────────────────────────────────────

type PathStats = {
  scanned: number;
  matched: number;
  orphans: number;
  ambiguous: number;
  errors: number;
  updatedInDb: number;
};

function newPathStats(): PathStats {
  return {
    scanned: 0,
    matched: 0,
    orphans: 0,
    ambiguous: 0,
    errors: 0,
    updatedInDb: 0,
  };
}

// Extra counters specific to each path.
type PathAStats = PathStats & { skippedInvalidGidShape: number };
type PathBStats = PathStats & { skippedChannelMismatch: number };

function newAStats(): PathAStats {
  return { ...newPathStats(), skippedInvalidGidShape: 0 };
}
function newBStats(): PathBStats {
  return { ...newPathStats(), skippedChannelMismatch: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const mode = flags.execute ? "EXECUTE (WRITES ENABLED)" : "DRY-RUN (no writes)";

  console.log("[Backfill WMS↔OMS link] ============================================");
  console.log(`[Backfill WMS↔OMS link] mode:        ${mode}`);
  console.log(`[Backfill WMS↔OMS link] batch-size:  ${flags.batchSize}`);
  console.log(`[Backfill WMS↔OMS link] sleep-ms:    ${flags.sleepMs}`);
  console.log(`[Backfill WMS↔OMS link] limit:       ${flags.limit ?? "none"}`);
  console.log(`[Backfill WMS↔OMS link] path:        ${flags.path}`);
  console.log("[Backfill WMS↔OMS link] ============================================");

  const runA = flags.path === "A" || flags.path === "both";
  const runB = flags.path === "B" || flags.path === "both";

  let totalUpdated = 0;

  // ── Path A: GID rows ────────────────────────────────────────────────────
  const aStats = newAStats();
  if (runA) {
    console.log("[Backfill WMS↔OMS link] --- Path A (GID) ---");

    const totalAResult: any = await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM wms.orders
      WHERE oms_fulfillment_order_id LIKE 'gid://shopify/Order/%'
    `);
    const totalA: number = totalAResult.rows?.[0]?.n ?? 0;
    console.log(`[Backfill WMS↔OMS link] [A] total candidate rows: ${totalA}`);

    if (totalA > 0) {
      let lastSeenId = 0;
      let batchIdx = 0;

      while (true) {
        if (flags.limit !== null && aStats.scanned >= flags.limit) {
          console.log(`[Backfill WMS↔OMS link] [A] Reached --limit, stopping.`);
          break;
        }

        const batchSize = flags.limit !== null
          ? Math.min(flags.batchSize, flags.limit - aStats.scanned)
          : flags.batchSize;

        const candidates: any = await db.execute(sql`
          SELECT w.id                         AS wms_id,
                 w.order_number               AS wms_order_number,
                 w.oms_fulfillment_order_id   AS gid
          FROM wms.orders w
          WHERE w.oms_fulfillment_order_id LIKE 'gid://shopify/Order/%'
            AND w.id > ${lastSeenId}
          ORDER BY w.id ASC
          LIMIT ${batchSize}
        `);

        const rows: Array<{ wms_id: number; wms_order_number: string; gid: string }> =
          candidates.rows ?? [];

        if (rows.length === 0) break;

        batchIdx++;
        const batchStats = await processPathABatch(rows, flags.execute);

        aStats.scanned += batchStats.scanned;
        aStats.matched += batchStats.matched;
        aStats.orphans += batchStats.orphans;
        aStats.ambiguous += batchStats.ambiguous;
        aStats.errors += batchStats.errors;
        aStats.updatedInDb += batchStats.updatedInDb;
        aStats.skippedInvalidGidShape += batchStats.skippedInvalidGidShape;

        lastSeenId = rows[rows.length - 1].wms_id;

        console.log(
          `[Backfill WMS↔OMS link] [A batch ${batchIdx}] scanned=${batchStats.scanned} ` +
            `matched=${batchStats.matched} orphan=${batchStats.orphans} ` +
            `ambiguous=${batchStats.ambiguous} invalid-gid=${batchStats.skippedInvalidGidShape} ` +
            `errors=${batchStats.errors} updated=${batchStats.updatedInDb}`,
        );

        if (rows.length < batchSize) break;
        if (flags.sleepMs > 0) await sleep(flags.sleepMs);
      }
    }

    totalUpdated += aStats.updatedInDb;
  }

  // ── Path B: NULL rows ───────────────────────────────────────────────────
  const bStats = newBStats();
  if (runB) {
    console.log("[Backfill WMS↔OMS link] --- Path B (NULL) ---");

    const totalBResult: any = await db.execute(sql`
      SELECT COUNT(*)::int AS n
      FROM wms.orders
      WHERE oms_fulfillment_order_id IS NULL
        AND order_number IS NOT NULL
        AND channel_id IS NOT NULL
    `);
    const totalB: number = totalBResult.rows?.[0]?.n ?? 0;
    console.log(`[Backfill WMS↔OMS link] [B] total candidate rows: ${totalB}`);

    if (totalB > 0) {
      let lastSeenId = 0;
      let batchIdx = 0;

      while (true) {
        if (flags.limit !== null && bStats.scanned >= flags.limit) {
          console.log(`[Backfill WMS↔OMS link] [B] Reached --limit, stopping.`);
          break;
        }

        const batchSize = flags.limit !== null
          ? Math.min(flags.batchSize, flags.limit - bStats.scanned)
          : flags.batchSize;

        const candidates: any = await db.execute(sql`
          SELECT w.id               AS wms_id,
                 w.order_number     AS wms_order_number,
                 w.channel_id       AS wms_channel_id
          FROM wms.orders w
          WHERE w.oms_fulfillment_order_id IS NULL
            AND w.order_number IS NOT NULL
            AND w.channel_id IS NOT NULL
            AND w.id > ${lastSeenId}
          ORDER BY w.id ASC
          LIMIT ${batchSize}
        `);

        const rows: Array<{ wms_id: number; wms_order_number: string; wms_channel_id: number | null }> =
          candidates.rows ?? [];

        if (rows.length === 0) break;

        batchIdx++;
        const batchStats = await processPathBBatch(rows, flags.execute);

        bStats.scanned += batchStats.scanned;
        bStats.matched += batchStats.matched;
        bStats.orphans += batchStats.orphans;
        bStats.ambiguous += batchStats.ambiguous;
        bStats.errors += batchStats.errors;
        bStats.updatedInDb += batchStats.updatedInDb;
        bStats.skippedChannelMismatch += batchStats.skippedChannelMismatch;

        lastSeenId = rows[rows.length - 1].wms_id;

        console.log(
          `[Backfill WMS↔OMS link] [B batch ${batchIdx}] scanned=${batchStats.scanned} ` +
            `matched=${batchStats.matched} orphan=${batchStats.orphans} ` +
            `ambiguous=${batchStats.ambiguous} channel-mismatch=${batchStats.skippedChannelMismatch} ` +
            `errors=${batchStats.errors} updated=${batchStats.updatedInDb}`,
        );

        if (rows.length < batchSize) break;
        if (flags.sleepMs > 0) await sleep(flags.sleepMs);
      }
    }

    totalUpdated += bStats.updatedInDb;
  }

  // ── Final summary ───────────────────────────────────────────────────────
  console.log("[Backfill WMS↔OMS link] ============================================");
  console.log("[Backfill WMS↔OMS link] SUMMARY");
  console.log(`[Backfill WMS↔OMS link]   mode:                    ${mode}`);
  if (runA) {
    console.log(
      `[Backfill WMS↔OMS link]   Path A (GID):            ` +
        `scanned=${aStats.scanned} matched=${aStats.matched} ` +
        `orphans=${aStats.orphans} ambiguous=${aStats.ambiguous} ` +
        `invalid-gid=${aStats.skippedInvalidGidShape} ` +
        `updated=${aStats.updatedInDb}`,
    );
  }
  if (runB) {
    console.log(
      `[Backfill WMS↔OMS link]   Path B (external_order_number): ` +
        `scanned=${bStats.scanned} matched=${bStats.matched} ` +
        `orphans=${bStats.orphans} ambiguous=${bStats.ambiguous} ` +
        `channel-mismatch=${bStats.skippedChannelMismatch} ` +
        `updated=${bStats.updatedInDb}`,
    );
  }
  console.log(`[Backfill WMS↔OMS link]   Total updated:           ${totalUpdated}`);
  console.log("[Backfill WMS↔OMS link] ============================================");

  if (!flags.execute) {
    console.log("[Backfill WMS↔OMS link] DRY-RUN complete. Re-run with --execute to apply.");
  }

  const totalErrors = aStats.errors + bStats.errors;
  process.exit(totalErrors > 0 ? 1 : 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Path A: GID batch processing
// ─────────────────────────────────────────────────────────────────────────────

async function processPathABatch(
  rows: Array<{ wms_id: number; wms_order_number: string; gid: string }>,
  execute: boolean,
): Promise<PathAStats> {
  const stats = newAStats();

  type PlanA = { wmsId: number; wmsOrderNumber: string; gid: string; omsId: number };
  const plans: PlanA[] = [];

  for (const row of rows) {
    stats.scanned++;

    if (!isShopifyOrderGid(row.gid)) {
      stats.skippedInvalidGidShape++;
      continue;
    }

    try {
      const matches: any = await db.execute(sql`
        SELECT id FROM oms.oms_orders
        WHERE external_order_id = ${row.gid}
      `);
      const matchRows: Array<{ id: number }> = matches.rows ?? [];

      if (matchRows.length === 0) {
        stats.orphans++;
        continue;
      }
      if (matchRows.length > 1) {
        stats.ambiguous++;
        console.log(
          `[Backfill WMS↔OMS link] [A]   SKIP wms.id=${row.wms_id} ` +
            `${matchRows.length} OMS matches for GID=${row.gid}`,
        );
        continue;
      }

      stats.matched++;
      plans.push({
        wmsId: row.wms_id,
        wmsOrderNumber: row.wms_order_number,
        gid: row.gid,
        omsId: matchRows[0].id,
      });
    } catch (err: any) {
      stats.errors++;
      console.warn(
        `[Backfill WMS↔OMS link] [A]   ERROR wms.id=${row.wms_id}: ${err?.message}`,
      );
    }
  }

  if (execute && plans.length > 0) {
    try {
      await db.transaction(async (tx) => {
        for (const plan of plans) {
          const updateRes: any = await tx.execute(sql`
            UPDATE wms.orders
            SET oms_fulfillment_order_id = ${String(plan.omsId)}
            WHERE id = ${plan.wmsId}
              AND oms_fulfillment_order_id = ${plan.gid}
            RETURNING id
          `);
          const affected = updateRes.rows?.length ?? 0;
          if (affected === 1) {
            stats.updatedInDb++;
          } else {
            console.log(
              `[Backfill WMS↔OMS link] [A]   NOOP wms.id=${plan.wmsId}: ` +
                `row changed underneath us (affected=${affected})`,
            );
          }
        }
      });
    } catch (err: any) {
      stats.errors++;
      stats.updatedInDb = 0;
      console.warn(
        `[Backfill WMS↔OMS link] [A]   BATCH TX FAILED: ${err?.message}. ` +
          `Rolled back ${plans.length} planned updates.`,
      );
    }
  } else if (!execute && plans.length > 0) {
    const sample = plans.slice(0, 3);
    for (const plan of sample) {
      console.log(
        `[Backfill WMS↔OMS link] [A]   PLAN wms.id=${plan.wmsId} order=${plan.wmsOrderNumber}: ` +
          `${plan.gid} → ${plan.omsId}`,
      );
    }
    if (plans.length > sample.length) {
      console.log(
        `[Backfill WMS↔OMS link] [A]   ... (+${plans.length - sample.length} more)`,
      );
    }
  }

  return stats;
}

// ─────────────────────────────────────────────────────────────────────────────
// Path B: NULL batch processing
// ─────────────────────────────────────────────────────────────────────────────

async function processPathBBatch(
  rows: Array<{ wms_id: number; wms_order_number: string; wms_channel_id: number | null }>,
  execute: boolean,
): Promise<PathBStats> {
  const stats = newBStats();

  type PlanB = { wmsId: number; wmsOrderNumber: string; omsId: number };
  const plans: PlanB[] = [];

  for (const row of rows) {
    stats.scanned++;

    if (row.wms_channel_id === null) {
      stats.skippedChannelMismatch++;
      continue;
    }

    try {
      const matches: any = await db.execute(sql`
        SELECT id FROM oms.oms_orders
        WHERE external_order_number = ${row.wms_order_number}
          AND channel_id = ${row.wms_channel_id}
      `);
      const matchRows: Array<{ id: number }> = matches.rows ?? [];

      if (matchRows.length === 0) {
        stats.orphans++;
        continue;
      }
      if (matchRows.length > 1) {
        stats.ambiguous++;
        console.log(
          `[Backfill WMS↔OMS link] [B]   SKIP wms.id=${row.wms_id} ` +
            `${matchRows.length} OMS matches for order_number=${row.wms_order_number}`,
        );
        continue;
      }

      stats.matched++;
      plans.push({
        wmsId: row.wms_id,
        wmsOrderNumber: row.wms_order_number,
        omsId: matchRows[0].id,
      });
    } catch (err: any) {
      stats.errors++;
      console.warn(
        `[Backfill WMS↔OMS link] [B]   ERROR wms.id=${row.wms_id}: ${err?.message}`,
      );
    }
  }

  if (execute && plans.length > 0) {
    try {
      await db.transaction(async (tx) => {
        for (const plan of plans) {
          const updateRes: any = await tx.execute(sql`
            UPDATE wms.orders
            SET oms_fulfillment_order_id = ${String(plan.omsId)}
            WHERE id = ${plan.wmsId}
              AND oms_fulfillment_order_id IS NULL
            RETURNING id
          `);
          const affected = updateRes.rows?.length ?? 0;
          if (affected === 1) {
            stats.updatedInDb++;
          } else {
            console.log(
              `[Backfill WMS↔OMS link] [B]   NOOP wms.id=${plan.wmsId}: ` +
                `row changed underneath us (affected=${affected})`,
            );
          }
        }
      });
    } catch (err: any) {
      stats.errors++;
      stats.updatedInDb = 0;
      console.warn(
        `[Backfill WMS↔OMS link] [B]   BATCH TX FAILED: ${err?.message}. ` +
          `Rolled back ${plans.length} planned updates.`,
      );
    }
  } else if (!execute && plans.length > 0) {
    const sample = plans.slice(0, 3);
    for (const plan of sample) {
      console.log(
        `[Backfill WMS↔OMS link] [B]   PLAN wms.id=${plan.wmsId} order=${plan.wmsOrderNumber}: ` +
          `SET oms_fulfillment_order_id = '${plan.omsId}'`,
      );
    }
    if (plans.length > sample.length) {
      console.log(
        `[Backfill WMS↔OMS link] [B]   ... (+${plans.length - sample.length} more)`,
      );
    }
  }

  return stats;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point — only run main() when invoked directly.
// ─────────────────────────────────────────────────────────────────────────────

const invokedDirectly = (() => {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("backfill-wms-oms-link.ts") ||
    entry.endsWith("backfill-wms-oms-link.js");
})();

if (invokedDirectly) {
  main().catch((err) => {
    console.error("[Backfill WMS↔OMS link] Fatal:", err);
    process.exit(1);
  });
}

// Named exports for tests.
export { parseFlags, processPathABatch, processPathBBatch, newPathStats, newAStats, newBStats };
export type { PathStats, PathAStats, PathBStats, PathFlag };
