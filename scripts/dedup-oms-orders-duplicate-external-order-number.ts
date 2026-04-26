/**
 * Deduplicate oms.oms_orders rows that share the same (channel_id, external_order_number).
 *
 * Diagnostic queries on 2026-04-23 found ~10 known duplicates (e.g. #55521
 * ingested twice). This script MUST run before migration 065, which adds a
 * unique index on (channel_id, external_order_number).
 *
 * Strategy: for each duplicate group, keep the OLDEST row (lowest id, ordered
 * by created_at ASC) and reassign + delete the newer ones.
 *
 * FK references to oms_orders.id found in:
 *   - oms.oms_order_lines.order_id
 *   - oms.oms_order_events.order_id
 *
 * Usage:
 *   EXTERNAL_DATABASE_URL=... npx tsx scripts/dedup-oms-orders-duplicate-external-order-number.ts              # dry-run (default)
 *   EXTERNAL_DATABASE_URL=... npx tsx scripts/dedup-oms-orders-duplicate-external-order-number.ts --execute     # for real
 *   EXTERNAL_DATABASE_URL=... npx tsx scripts/dedup-oms-orders-duplicate-external-order-number.ts --limit=10    # cap groups
 */

import { Pool } from "pg";

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseFlags(argv: string[]) {
  const execute = argv.includes("--execute");
  const dryRun = !execute;
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : 1000;

  if (limitArg && (isNaN(limit) || limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }

  return { execute, dryRun, limit };
}

// ── Types ───────────────────────────────────────────────────────────────────

interface DuplicateGroup {
  channel_id: number;
  external_order_number: string;
  cnt: number;
  ids: number[];
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(argv = process.argv.slice(2)) {
  const { execute, dryRun, limit } = parseFlags(argv);

  const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("Set EXTERNAL_DATABASE_URL or DATABASE_URL");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  console.log(
    `[Dedup] Finding duplicate oms_orders (mode: ${dryRun ? "DRY-RUN" : "EXECUTE"}, limit: ${limit})`,
  );

  const dupResult = await pool.query<DuplicateGroup>(
    `SELECT channel_id,
            external_order_number,
            COUNT(*)          AS cnt,
            ARRAY_AGG(id ORDER BY created_at ASC) AS ids
       FROM oms.oms_orders
      WHERE external_order_number IS NOT NULL
      GROUP BY channel_id, external_order_number
      HAVING COUNT(*) > 1
      ORDER BY cnt DESC, channel_id, external_order_number
      LIMIT $1`,
    [limit],
  );

  const groups = dupResult.rows;
  console.log(`[Dedup] Found ${groups.length} duplicate group(s)`);

  if (groups.length === 0) {
    console.log("[Dedup] No duplicates. Safe to apply migration 065.");
    await pool.end();
    return;
  }

  let deleted = 0;
  let reassignedLines = 0;
  let reassignedEvents = 0;
  let errors = 0;

  for (const group of groups) {
    const ids: number[] = group.ids;
    const canonical = ids[0]; // oldest
    const doomed = ids.slice(1);

    if (dryRun) {
      console.log(
        `[Dedup][DRY] dup ${group.channel_id}/${group.external_order_number}: ` +
          `keep id=${canonical}, would delete [${doomed.join(", ")}]`,
      );
      continue;
    }

    // Execute mode — reassign FKs then delete in a transaction
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Reassign oms_order_lines
      const linesRes = await client.query(
        `UPDATE oms.oms_order_lines SET order_id = $1 WHERE order_id = ANY($2::bigint[])`,
        [canonical, doomed],
      );
      reassignedLines += linesRes.rowCount ?? 0;

      // 2. Reassign oms_order_events
      const eventsRes = await client.query(
        `UPDATE oms.oms_order_events SET order_id = $1 WHERE order_id = ANY($2::bigint[])`,
        [canonical, doomed],
      );
      reassignedEvents += eventsRes.rowCount ?? 0;

      // 3. Delete duplicate orders
      const delRes = await client.query(
        `DELETE FROM oms.oms_orders WHERE id = ANY($1::bigint[])`,
        [doomed],
      );
      deleted += delRes.rowCount ?? 0;

      await client.query("COMMIT");

      console.log(
        `[Dedup] dup ${group.channel_id}/${group.external_order_number}: ` +
          `kept id=${canonical}, deleted [${doomed.join(", ")}] ` +
          `(reassigned ${linesRes.rowCount} lines, ${eventsRes.rowCount} events)`,
      );
    } catch (err: any) {
      await client.query("ROLLBACK");
      console.error(
        `[Dedup] ERROR for ${group.channel_id}/${group.external_order_number}: ${err.message}`,
      );
      errors++;
    } finally {
      client.release();
    }
  }

  console.log(
    `[Dedup] Complete: ${deleted} orders deleted, ${reassignedLines} lines reassigned, ` +
      `${reassignedEvents} events reassigned, ${errors} error(s)`,
  );

  if (errors > 0) {
    console.error("[Dedup] Had errors — review before applying migration 065.");
    await pool.end();
    process.exit(1);
  }

  console.log("[Dedup] Safe to apply migration 065.");
  await pool.end();
}

// Exported for testing
export { parseFlags, main };

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error("[Dedup] Fatal error:", err);
    process.exit(1);
  });
}
