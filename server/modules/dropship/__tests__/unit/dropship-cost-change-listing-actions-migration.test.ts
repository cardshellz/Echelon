import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  costChangeHoldReleaseDetails,
  costChangeHoldReleaseReasons,
  costChangeListingActionValues,
  costChangeListingPriceSourceValues,
} from "../../domain/cost-change-listing-action";

const MIGRATION_FILE = "0713_dropship_cost_change_listing_actions.sql";
const migrationSql = readFileSync(resolve(process.cwd(), "migrations", MIGRATION_FILE), "utf8");
const ACTIONS = "dropship.dropship_cost_change_listing_actions";
const ENTRIES = "dropship.dropship_cost_change_entry_actions";
const HOLDS = "dropship.dropship_cost_change_listing_holds";

describe("0713 dropship cost change listing actions migration", () => {
  it("is the only migration with its number", () => {
    expect(readdirSync(resolve(process.cwd(), "migrations")).filter((file) => file.startsWith("0713_"))).toEqual([MIGRATION_FILE]);
  });

  it("ties each listing action to its increase, vendor, store, variant, listing and policy, once per increase and listing", () => {
    const body = tableBody(ACTIONS);
    expect(body).toContain("entry_id bigint NOT NULL REFERENCES dropship.dropship_cost_schedule_entries(id)");
    expect(body).toContain("vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id)");
    expect(body).toContain("store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id)");
    expect(body).toContain("product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id)");
    expect(body).toContain("listing_id integer NOT NULL REFERENCES dropship.dropship_vendor_listings(id)");
    expect(body).toContain("push_job_id integer REFERENCES dropship.dropship_listing_push_jobs(id)");
    expect(body).toContain("hold_id bigint REFERENCES dropship.dropship_cost_change_listing_holds(id)");
    expect(body).toContain("policy_id integer REFERENCES dropship.dropship_cost_change_policies(id)");
    expect(migrationSql).not.toContain("ON DELETE CASCADE");
    expect(migrationSql).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS dropship_cost_change_listing_actions_entry_listing_idx\n  ON ${ACTIONS}(entry_id, listing_id);`);
  });

  it("mirrors the domain's actions, price sources and release reasons as CHECK constraints", () => {
    const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
    expect(tableBody(ACTIONS).replace(/\s+/g, " ")).toContain(`CHECK (action IN (${list(costChangeListingActionValues)}))`);
    expect(tableBody(ACTIONS)).toContain(`CHECK (price_source IN (${list(costChangeListingPriceSourceValues)}))`);
    expect(tableBody(HOLDS)).toContain(`release_reason IN (${list(costChangeHoldReleaseReasons)})`);
    expect(tableBody(HOLDS)).toContain(`release_detail IN (${list(costChangeHoldReleaseDetails)})`);
    expect(tableBody(ACTIONS)).toContain("CHECK ((action = 'reprice_refused') = (detail IS NOT NULL))");
  });

  it("makes a reprice name its push job and a pause its hold, and nothing else name either", () => {
    const body = tableBody(ACTIONS);
    expect(body).toContain("(action = 'reprice_queued' AND push_job_id IS NOT NULL AND hold_id IS NULL)");
    expect(body).toContain("OR (action = 'below_cost_paused' AND hold_id IS NOT NULL AND push_job_id IS NULL)");
    expect(body).toContain("OR (action NOT IN ('reprice_queued', 'below_cost_paused') AND push_job_id IS NULL AND hold_id IS NULL)");
    expect(body).toContain("CHECK (unit_cost_cents > 0)");
    expect(body).toContain("CHECK (listing_price_cents IS NULL OR listing_price_cents > 0)");
  });

  it("keeps one live hold per listing, only for a price under the cost, released once with a reason and a key", () => {
    const body = tableBody(HOLDS);
    expect(body).toContain("CHECK (listing_price_cents > 0 AND unit_cost_cents > 0 AND listing_price_cents < unit_cost_cents)");
    expect(body).toContain("(released_at IS NULL AND release_reason IS NULL AND release_detail IS NULL AND release_idempotency_key IS NULL)");
    expect(body).toContain("OR (released_at IS NOT NULL AND released_at >= held_at");
    expect(migrationSql).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS dropship_cost_change_listing_holds_active_idx\n  ON ${HOLDS}(store_connection_id, product_variant_id)\n  WHERE released_at IS NULL;`);
    expect(migrationSql).toContain("a released hold cannot change");
    expect(migrationSql).toContain("only the release of a live hold may be recorded");
    expect(migrationSql).toContain("dropship_cost_change_listing_holds rows cannot be deleted");
  });

  it("marks an increase done with one entry row carrying the counts", () => {
    const body = tableBody(ENTRIES);
    expect(body).toContain("entry_id bigint PRIMARY KEY REFERENCES dropship.dropship_cost_schedule_entries(id)");
    expect(body).toContain("listing_count integer NOT NULL CHECK (listing_count >= 0)");
    expect(body).toContain("CHECK (jsonb_typeof(action_counts) = 'object')");
    expect(body).toContain("superseded_by_entry_id bigint REFERENCES dropship.dropship_cost_schedule_entries(id)");
    expect(body).toContain("CHECK (superseded_by_entry_id IS NULL OR listing_count = 0)");
  });

  it("never edits or deletes an action or an entry row, and is re-runnable", () => {
    expect(migrationSql).toContain(`BEFORE UPDATE OR DELETE ON ${ACTIONS}`);
    expect(migrationSql).toContain(`BEFORE UPDATE OR DELETE ON ${ENTRIES}`);
    expect(migrationSql).toContain(`BEFORE UPDATE OR DELETE ON ${HOLDS}`);
    expect(migrationSql).toContain("dropship_cost_change_listing_actions is append-only: rows cannot be updated or deleted");
    expect(migrationSql).toContain("dropship_cost_change_entry_actions is append-only: rows cannot be updated or deleted");
    for (const statement of statements()) {
      const guarded = /^CREATE TABLE IF NOT EXISTS/i.test(statement)
        || /^CREATE (UNIQUE )?INDEX IF NOT EXISTS/i.test(statement)
        || /^CREATE OR REPLACE FUNCTION/i.test(statement)
        || /^DROP TRIGGER IF EXISTS/i.test(statement)
        || /^CREATE TRIGGER dropship_cost_change_(listing_actions|entry_actions|listing_holds)_guard_trg/i.test(statement);
      expect(guarded, `unguarded statement: ${statement.slice(0, 80)}`).toBe(true);
    }
  });
});

function statements(): string[] {
  return migrationSql
    .replace(/\$\$[\s\S]*?\$\$/g, () => "<<plpgsql body>>")
    .split(/;\s*$/m)
    .map((statement) => statement.replace(/--[^\n]*/g, "").trim())
    .filter((statement) => statement.length > 0);
}

function tableBody(table: string): string {
  const escaped = table.replace(".", "\\.");
  const body = new RegExp(`CREATE TABLE IF NOT EXISTS ${escaped} \\(([\\s\\S]*?)\\n\\);`).exec(migrationSql)?.[1];
  if (!body) throw new Error(`CREATE TABLE body not found for ${table}`);
  return body;
}
