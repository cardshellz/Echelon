/**
 * One-off cleanup for operations.control_tower_observations.
 *
 * Usage:
 *   npx tsx scripts/cleanup-control-tower-observations.ts --dry-run
 *   npx tsx scripts/cleanup-control-tower-observations.ts --execute
 *   npx tsx scripts/cleanup-control-tower-observations.ts --execute --keep-legacy
 *
 * WHY
 * ---
 * Until the fingerprint fix in control-tower-v2.sources.ts, `occurrenceCount` -
 * a counter the audit increments on EVERY scan - was hashed into the source
 * fingerprint. Every open finding therefore looked "changed" on every hourly
 * run and logged an observation whose evidence was byte-identical to the one
 * before it. Measured in production: ~690k rows/day (28,787 findings x 24
 * runs), growing the table to 37 GB - 72% of the entire database, 99.6% noise.
 *
 * HOW
 * ---
 * The table carries an immutability guard (BEFORE DELETE OR UPDATE -> RAISE),
 * and deleting 28M rows would write tens of GB of WAL and then still need a
 * VACUUM FULL under an exclusive lock. So this rebuilds instead:
 *
 *   1. create an empty clone
 *   2. copy the keeper rows into it (no lock, writers continue)
 *   3. re-attach foreign keys + the immutability trigger
 *   4. one short transaction: copy the delta, swap names, fix the identity
 *   5. drop the old table - which returns the disk immediately
 *
 * Only step 4 takes a lock, and it is sub-second.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { connectionStringFromEnv } from "./audit-wms-inventory-integrity";

const TABLE = "operations.control_tower_observations";
const CLONE = "operations.control_tower_observations_clean";
const LEGACY = "operations.control_tower_observations_legacy";

/** Keys a fingerprint-only churn row is allowed to carry. */
const CHURN_KEYS = [
  "priorFingerprint",
  "currentFingerprint",
  "priorSeverity",
  "currentSeverity",
  "priorProjectionVersion",
  "currentProjectionVersion",
];

const CHURN_KEY_ARRAY = CHURN_KEYS.map((key) => "'" + key + "'").join(", ");

/**
 * A row is NOISE when it claims "changed" but nothing except the fingerprint
 * actually moved: same severity, same projection version, same statuses, and no
 * key outside the churn set. `jsonb - text[]` strips the churn keys; an empty
 * object proves nothing else was reported.
 */
const NOISE = [
  "observation_kind = 'changed'",
  "AND changed_fields ? 'priorFingerprint'",
  "AND changed_fields->>'priorSeverity'          IS NOT DISTINCT FROM changed_fields->>'currentSeverity'",
  "AND changed_fields->>'priorProjectionVersion' IS NOT DISTINCT FROM changed_fields->>'currentProjectionVersion'",
  "AND prior_source_status IS NOT DISTINCT FROM current_source_status",
  "AND prior_triage_status IS NOT DISTINCT FROM current_triage_status",
  "AND (changed_fields - ARRAY[" + CHURN_KEY_ARRAY + "]::text[]) = '{}'::jsonb",
].join("\n  ");

const KEEP = "NOT (" + NOISE + ")";

/** Index definitions are stable; names are not, because LIKE auto-generates them. */
const CANONICAL_INDEXES: Array<{ name: string; match: (def: string) => boolean }> = [
  { name: "control_tower_observations_pkey", match: (def) => /USING btree \(id\)/.test(def) },
  { name: "idx_control_tower_observations_run", match: (def) => /\(source_run_id, id\)/.test(def) },
  {
    name: "idx_control_tower_observations_item_created",
    match: (def) => /\(work_item_id, created_at DESC\)/.test(def),
  },
];

type Flags = { execute: boolean; keepLegacy: boolean; force: boolean };

function parseFlags(argv: string[]): Flags {
  const allowed = new Set(["--dry-run", "--execute", "--keep-legacy", "--force", "--help", "-h"]);
  for (const arg of argv) {
    if (!allowed.has(arg)) throw new Error("Unknown argument: " + arg);
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: cleanup-control-tower-observations.ts [--dry-run|--execute] [--keep-legacy] [--force]");
    process.exit(0);
  }
  if (argv.includes("--dry-run") && argv.includes("--execute")) {
    throw new Error("Choose either --dry-run or --execute, not both");
  }
  return {
    execute: argv.includes("--execute"),
    keepLegacy: argv.includes("--keep-legacy"),
    force: argv.includes("--force"),
  };
}

const num = (value: unknown): number => Number(value ?? 0);
const fmt = (value: number): string => value.toLocaleString("en-US");

async function survey(client: PoolClient) {
  const { rows } = await client.query(
    "SELECT count(*)::bigint AS total," +
      " count(*) FILTER (WHERE " + KEEP + ")::bigint AS keep," +
      " COALESCE(max(id), 0)::bigint AS max_id," +
      " pg_size_pretty(pg_total_relation_size('" + TABLE + "'::regclass)) AS size" +
      " FROM " + TABLE,
  );
  const row = rows[0];
  return {
    total: num(row.total),
    keep: num(row.keep),
    maxId: num(row.max_id),
    size: String(row.size),
  };
}

/**
 * `LIKE` cannot reuse index names that the original table still holds, so the
 * clone gets auto-generated ones. Call this only after the legacy copy has been
 * dropped, which is the moment the canonical names become available.
 */
async function restoreCanonicalIndexNames(client: PoolClient): Promise<void> {
  const { rows } = await client.query(
    "SELECT indexname, indexdef FROM pg_indexes" +
      " WHERE schemaname = 'operations' AND tablename = 'control_tower_observations'",
  );
  for (const canonical of CANONICAL_INDEXES) {
    const found = rows.find((row: { indexdef: string }) => canonical.match(String(row.indexdef)));
    if (found && found.indexname !== canonical.name) {
      await client.query("ALTER INDEX operations." + found.indexname + " RENAME TO " + canonical.name);
    }
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const connectionString = connectionStringFromEnv();
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") ? undefined : { rejectUnauthorized: false },
    max: 1,
    application_name: "control-tower-observation-cleanup",
    statement_timeout: 0,
  });
  const client = await pool.connect();

  try {
    console.log("Surveying " + TABLE + " (scans the table once)...");
    const before = await survey(client);
    const discarding = before.total - before.keep;
    console.log("  size        : " + before.size);
    console.log("  total rows  : " + fmt(before.total));
    console.log("  keep        : " + fmt(before.keep) + " (" + ((100 * before.keep) / before.total).toFixed(3) + "%)");
    console.log("  discard     : " + fmt(discarding) + " (" + ((100 * discarding) / before.total).toFixed(3) + "%)");

    if (before.keep === 0) {
      throw new Error("Refusing to continue: the keep set is empty");
    }
    if (discarding === 0) {
      console.log("\nNothing to discard - the table is already clean.");
      return;
    }
    // The first run faced a table that was 99.7% churn. A much higher keep ratio
    // means either the predicate no longer matches reality or this is a smaller
    // top-up sweep; both deserve a human look before the table is rebuilt.
    if (before.keep / before.total > 0.25 && !flags.force) {
      throw new Error(
        "Refusing to continue: " +
          ((100 * before.keep) / before.total).toFixed(1) +
          "% would be kept, versus the ~0.3% this script was written for. Review the numbers above; " +
          "pass --force to proceed anyway (expected for a top-up sweep after the fingerprint fix ships).",
      );
    }

    if (!flags.execute) {
      console.log("\nDry run - nothing changed. Re-run with --execute to rebuild the table.");
      return;
    }

    console.log("\n[1/5] Creating " + CLONE);
    await client.query("DROP TABLE IF EXISTS " + CLONE);
    await client.query("CREATE TABLE " + CLONE + " (LIKE " + TABLE + " INCLUDING ALL)");

    console.log("[2/5] Copying keeper rows (no lock; writers continue)");
    const copied = await client.query(
      "INSERT INTO " + CLONE + " OVERRIDING SYSTEM VALUE SELECT * FROM " + TABLE +
        " WHERE " + KEEP + " AND id <= $1",
      [before.maxId],
    );
    console.log("      copied " + fmt(copied.rowCount ?? 0) + " rows");

    console.log("[3/5] Re-attaching foreign keys and the immutability guard");
    await client.query(
      "ALTER TABLE " + CLONE + " ADD CONSTRAINT control_tower_observations_work_item_id_fkey" +
        " FOREIGN KEY (work_item_id) REFERENCES operations.control_tower_work_items(id) ON DELETE RESTRICT",
    );
    await client.query(
      "ALTER TABLE " + CLONE + " ADD CONSTRAINT control_tower_observations_source_run_id_fkey" +
        " FOREIGN KEY (source_run_id) REFERENCES operations.control_tower_source_runs(id) ON DELETE SET NULL",
    );
    await client.query(
      "CREATE TRIGGER control_tower_observations_immutable_guard" +
        " BEFORE DELETE OR UPDATE ON " + CLONE +
        " FOR EACH ROW EXECUTE FUNCTION operations.reject_control_tower_observation_mutation()",
    );

    console.log("[4/5] Swapping tables (brief exclusive lock)");
    await client.query("BEGIN");
    try {
      await client.query("LOCK TABLE " + TABLE + " IN ACCESS EXCLUSIVE MODE");
      const delta = await client.query(
        "INSERT INTO " + CLONE + " OVERRIDING SYSTEM VALUE SELECT * FROM " + TABLE +
          " WHERE id > $1 AND " + KEEP,
        [before.maxId],
      );
      const { rows: maxRows } = await client.query(
        "SELECT COALESCE(max(id), 0)::bigint AS max_id FROM " + TABLE,
      );
      const nextId = num(maxRows[0].max_id) + 1;

      await client.query("ALTER TABLE " + TABLE + " RENAME TO control_tower_observations_legacy");
      await client.query("ALTER TABLE " + CLONE + " RENAME TO control_tower_observations");
      // The clone's identity sequence starts at 1; continue from the real max.
      await client.query("ALTER TABLE " + TABLE + " ALTER COLUMN id RESTART WITH " + nextId);
      await client.query("COMMIT");
      console.log(
        "      delta copied: " + fmt(delta.rowCount ?? 0) + " row(s); identity continues at " + fmt(nextId),
      );
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    console.log("\n[5/5] Verifying");
    const after = await survey(client);
    console.log("  rows now    : " + fmt(after.total) + " (expected at least " + fmt(before.keep) + ")");
    console.log("  size now    : " + after.size);
    if (after.total < before.keep) {
      throw new Error("Verification failed: fewer rows than expected. Legacy table kept for inspection.");
    }

    if (flags.keepLegacy) {
      console.log("\nLegacy table kept as " + LEGACY + ". Drop it to reclaim the disk:");
      console.log("  DROP TABLE " + LEGACY + ";");
      console.log("Index names stay non-canonical until that copy is gone.");
    } else {
      console.log("\nDropping " + LEGACY + " (returns the disk immediately)");
      await client.query("DROP TABLE " + LEGACY);
      const { rows } = await client.query(
        "SELECT pg_size_pretty(pg_database_size(current_database())) AS db",
      );
      console.log("  database now: " + rows[0].db);
      // Renaming a table does not rename its indexes, so the legacy copy still
      // owned the canonical names until the DROP above. Only now are they free.
      await restoreCanonicalIndexNames(client);
      console.log("  canonical index names restored");
    }
    console.log("\nDone.");
  } finally {
    client.release();
    await pool.end();
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(String(process.argv[1])) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

export { KEEP, NOISE };
