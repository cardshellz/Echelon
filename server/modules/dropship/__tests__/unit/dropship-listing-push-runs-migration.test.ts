import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  dropshipCatalogCodeVersions,
  dropshipListingPushJobs,
  dropshipListingPushRunTargets,
  dropshipListingPushRuns,
  dropshipProcessHeartbeats,
} from "../../../../../shared/schema/dropship.schema";
import {
  DROPSHIP_VENDOR_SELECTION_LOCK_KEY,
  DROPSHIP_VENDOR_SELECTION_LOCK_SQL,
} from "../../infrastructure/dropship-vendor-selection-lock";
import {
  LISTING_PUSH_RUNS_MIGRATION_FILE,
  LISTING_PUSH_RUNS_MIGRATION_SUFFIX,
  listingPushRunsMigrationSql,
} from "../fixtures/listing-push-runs.fixture";

/**
 * The publish runs migration's text (step 1 plan S2-5, §4.1). The PostgreSQL
 * suite (dropship-listing-push-runs.integration.test.ts) applies it through
 * the release executor; this pins what a release must never carry: an index
 * built CONCURRENTLY (impossible inside the executor's transaction), a new
 * index on job items (its build would block job item writes, D40), a row in
 * the publication selection manifest, a statement that raises by design, or a
 * write to live data.
 */
describe("dropship_listing_push_runs migration", () => {
  const sql = listingPushRunsMigrationSql();
  const statements = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");

  it("is one allocated file found by its name, with its sidecar", () => {
    expect(LISTING_PUSH_RUNS_MIGRATION_FILE.endsWith(LISTING_PUSH_RUNS_MIGRATION_SUFFIX)).toBe(true);
    expect(LISTING_PUSH_RUNS_MIGRATION_FILE).toMatch(/^9\d{20}_dropship_listing_push_runs\.sql$/);
    const sidecar = JSON.parse(readFileSync(resolve(process.cwd(), "migrations/metadata", `${LISTING_PUSH_RUNS_MIGRATION_FILE}.json`), "utf8"));
    expect(sidecar).toMatchObject({ version: 1, migration: LISTING_PUSH_RUNS_MIGRATION_FILE, ordinal: 1 });
  });

  it("takes the push jobs' strongest lock first, so no weaker lock on them is upgraded inside the file", () => {
    expect(statements.trim().split(";")[0].trim()).toBe("LOCK TABLE dropship.dropship_listing_push_jobs IN ACCESS EXCLUSIVE MODE");
  });

  it("adds the job CHECKs NOT VALID, so the jobs table is not scanned under its lock (review MC7)", () => {
    const alter = statements.slice(statements.indexOf("ALTER TABLE dropship.dropship_listing_push_jobs"));
    const jobAlter = alter.slice(0, alter.indexOf(";"));
    for (const name of ["dropship_listing_job_run_chunk_chk", "dropship_listing_job_pause_count_chk", "dropship_listing_job_run_pair_chk"]) {
      expect(jobAlter).toMatch(new RegExp(`ADD CONSTRAINT ${name} CHECK \\(.*\\) NOT VALID`));
    }
    // No other CHECK on the jobs table, inline or not, would scan it.
    expect(jobAlter.match(/CHECK \(/g)).toHaveLength(3);
  });

  it("creates the four tables and the job columns, and nothing a release could trip on", () => {
    for (const table of ["dropship_listing_push_runs", "dropship_listing_push_run_targets", "dropship_process_heartbeats",
      "dropship_catalog_code_versions"]) {
      expect(statements).toContain(`CREATE TABLE dropship.${table} (`);
    }
    for (const column of ["run_id bigint", "run_chunk_index integer", "next_attempt_at timestamptz",
      "consecutive_pause_count integer NOT NULL DEFAULT 0"]) {
      expect(statements).toContain(`ADD COLUMN ${column}`);
    }
    expect(statements).not.toMatch(/CONCURRENTLY/i);
    expect(statements).not.toMatch(/ON\s+dropship\.dropship_listing_push_job_items/i);
    expect(statements).not.toMatch(/publication_selection/i);
    expect(statements).not.toMatch(/\bRAISE\b/i);
    // No statement writes or drops anything (a foreign key's ON DELETE is not a statement).
    expect(statements).not.toMatch(/^\s*(UPDATE|DELETE|INSERT|DROP|TRUNCATE)\b/im);
    expect(statements).not.toMatch(/;\s*(UPDATE|DELETE|INSERT|DROP|TRUNCATE)\b/i);
    expect(statements).not.toMatch(/IF NOT EXISTS/i);
  });

  it("is declared in the Drizzle schema with the same names", () => {
    expect(getTableConfig(dropshipListingPushRuns).name).toBe("dropship_listing_push_runs");
    expect(getTableConfig(dropshipListingPushRunTargets).name).toBe("dropship_listing_push_run_targets");
    expect(getTableConfig(dropshipProcessHeartbeats).name).toBe("dropship_process_heartbeats");
    expect(getTableConfig(dropshipCatalogCodeVersions).name).toBe("dropship_catalog_code_versions");
    // The finish's notice step (verify V9).
    expect(getTableConfig(dropshipListingPushRuns).columns.map((column) => column.name)).toContain("notified_at");
    expect(statements).toContain("notified_at timestamptz,");
    expect(getTableConfig(dropshipListingPushRuns).indexes.map((index) => index.config.name)).toContain("dropship_push_run_notice_pending_idx");
    expect(statements).toContain("CREATE INDEX dropship_push_run_notice_pending_idx");
    const jobColumns = getTableConfig(dropshipListingPushJobs).columns.map((column) => column.name);
    expect(jobColumns).toEqual(expect.arrayContaining(["run_id", "run_chunk_index", "next_attempt_at", "consecutive_pause_count"]));
    const runChecks = getTableConfig(dropshipListingPushRuns).checks.map((check) => check.name);
    for (const name of ["dropship_push_run_chunk_math_chk", "dropship_push_run_finished_chk", "dropship_push_run_cancel_chk",
      "dropship_push_run_notified_chk"]) {
      expect(runChecks).toContain(name);
      expect(statements).toContain(`CONSTRAINT ${name}`);
    }
  });
});

describe("the vendor selection lock (TESTS16)", () => {
  it("keeps the key text the rules save has always hashed, so a run and a save take the same lock", () => {
    expect(DROPSHIP_VENDOR_SELECTION_LOCK_KEY).toBe("dropship_vendor_selection_rules");
    expect(DROPSHIP_VENDOR_SELECTION_LOCK_SQL).toBe("SELECT pg_advisory_xact_lock(hashtext('dropship_vendor_selection_rules'), $1::integer)");
    // PR B's picks save took over the selection writes (PLAN-B v4.1 V16): it must take the same lock as a run create.
    const save = readFileSync(resolve(process.cwd(), "server/modules/dropship/infrastructure/dropship-selection-change.repository.ts"), "utf8");
    const run = readFileSync(resolve(process.cwd(), "server/modules/dropship/infrastructure/dropship-listing-push-run.repository.ts"), "utf8");
    expect(save).toContain("await lockVendorSelection(client, input.vendorId);");
    expect(run).toContain("await lockVendorSelection(client, input.vendorId);");
    // A session lock on the pool would serialize nothing (CLAUDE.md §9).
    expect(`${save}\n${run}`).not.toMatch(/pg_advisory_lock\(/);
  });
});
