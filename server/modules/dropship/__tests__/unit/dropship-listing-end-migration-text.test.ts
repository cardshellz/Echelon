import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { dropshipListingEndRequests } from "../../../../../shared/schema/dropship.schema";
import {
  LISTING_END_MIGRATION_FILE,
  LISTING_END_MIGRATION_SUFFIX,
  listingEndMigrationSql,
} from "../fixtures/listing-end.fixture";

/**
 * The listing end requests migration's text (PR C, PLAN-C v4.1 §3, §13.1). The PostgreSQL suite
 * (dropship-listing-end.integration.test.ts) applies it through the release executor; this pins what keeps it safe
 * and what later steps rely on: one new table and nothing else (no write to live data, nothing built CONCURRENTLY,
 * nothing that raises at release), no catalog foreign key (FID-6), the state CHECKs that keep failed ends away from
 * the worker, one open end per listing, the consistency trigger once per INSERT statement with plain reads, the
 * invalidation once per UPDATE statement and only for state changes with no INSERT invalidation (FID-7), the
 * immutable identity, and the Drizzle declaration under the same names.
 */
const TABLE = "dropship.dropship_listing_end_requests";
const sql = listingEndMigrationSql();
/** The file without its comment lines, so prose never satisfies or breaks a statement check. */
const statements = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n")
  .replace(/ -- [^\n]*/g, "");
/** Function bodies, and the statements with every body blanked out. */
const functionBodies = Object.fromEntries([...statements.matchAll(/CREATE FUNCTION (\S+?)\(\)[^$]*\$\$([\s\S]*?)\$\$/g)]
  .map((match) => [match[1]!, match[2]!]));
const topLevel = statements.replace(/\$\$[\s\S]*?\$\$/g, "$$ $$");
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
/** Each top-level statement, whitespace collapsed. */
const topLevelStatements = topLevel.split(";").map(oneLine).filter((statement) => statement.length > 0);
const createTable = (() => {
  const start = statements.indexOf(`CREATE TABLE ${TABLE} (`);
  expect(start).toBeGreaterThanOrEqual(0);
  return statements.slice(start, statements.indexOf("\n);", start) + 3);
})();
const triggerOf = (name: string) => {
  const found = topLevelStatements.filter((statement) => statement.startsWith(`CREATE TRIGGER ${name} `));
  expect(found, name).toHaveLength(1);
  return found[0]!;
};

/** The nine columns that say what was asked, for which listing and why (§3). */
const IDENTITY_COLUMNS = ["vendor_id", "store_connection_id", "listing_id", "product_id", "product_variant_id",
  "selection_revision_id", "reason", "requested_identity", "created_at"];

describe("dropship_listing_end_requests migration text", () => {
  it("is one allocated file found by its name, with its sidecar", () => {
    expect(LISTING_END_MIGRATION_FILE.endsWith(LISTING_END_MIGRATION_SUFFIX)).toBe(true);
    expect(LISTING_END_MIGRATION_FILE).toMatch(/^9\d{20}_dropship_listing_end_requests\.sql$/);
    const sidecar = JSON.parse(readFileSync(resolve(process.cwd(), "migrations/metadata", `${LISTING_END_MIGRATION_FILE}.json`), "utf8"));
    expect(sidecar).toMatchObject({ version: 1, migration: LISTING_END_MIGRATION_FILE, ordinal: 1 });
  });

  it("creates one table, three functions, three triggers and its indexes, and nothing else", () => {
    const kinds = topLevelStatements.map((statement) => /^CREATE (TABLE|UNIQUE INDEX|INDEX|FUNCTION|TRIGGER) /.exec(statement)?.[1]);
    expect(kinds.every((kind) => kind !== undefined), topLevelStatements.join("\n")).toBe(true);
    expect(kinds.filter((kind) => kind === "TABLE")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "FUNCTION")).toHaveLength(3);
    expect(kinds.filter((kind) => kind === "TRIGGER")).toHaveLength(3);
    expect(kinds.filter((kind) => kind === "UNIQUE INDEX" || kind === "INDEX")).toHaveLength(7);
    for (const statement of topLevelStatements.filter((entry) => /^CREATE (UNIQUE )?INDEX /.test(entry))) {
      expect(statement).toContain(` ON ${TABLE} (`);
    }
  });

  it("writes no live data and carries nothing a release could trip on", () => {
    expect(statements).not.toMatch(/CONCURRENTLY/i);
    expect(topLevel).not.toMatch(/IF NOT EXISTS|IF EXISTS/i);
    expect(topLevel).not.toMatch(/^\s*(UPDATE|DELETE|INSERT|TRUNCATE|ALTER|DROP|LOCK|GRANT|SELECT|DO)\b/im);
    // Only the trigger functions raise, and only on rows written later: no statement raises while the release runs.
    expect(topLevel).not.toMatch(/\bRAISE\b/i);
    expect(Object.keys(functionBodies).sort()).toEqual(["dropship.check_listing_end_request_rows",
      "dropship.invalidate_listing_end_state_changes", "dropship.refuse_listing_end_request_identity_change"]);
  });

  it("references no catalog table: the listing key pins the size and the trigger proves the ids (FID-6)", () => {
    expect(createTable).not.toMatch(/REFERENCES catalog\./);
    const references = [...createTable.matchAll(/CONSTRAINT (\w+)\s+(?:FOREIGN KEY \(([^)]*)\)\s+)?REFERENCES ([\w.]+)\(([^)]*)\)( ON DELETE CASCADE)?/g)]
      .map((match) => [match[1], match[3], match[4], match[5] !== undefined]);
    expect(references).toEqual([
      ["dropship_end_vendor_fk", "dropship.dropship_vendors", "id", true],
      ["dropship_end_listing_fk", "dropship.dropship_vendor_listings", "id", true],
      ["dropship_end_revision_fk", "dropship.dropship_vendor_selection_rule_set_revisions", "id", false],
      ["dropship_end_store_owner_fk", "dropship.dropship_store_connections", "id, vendor_id", true],
    ]);
    expect(oneLine(createTable)).toContain("CONSTRAINT dropship_end_store_owner_fk FOREIGN KEY (store_connection_id, vendor_id) "
      + "REFERENCES dropship.dropship_store_connections(id, vendor_id) ON DELETE CASCADE");
    expect(oneLine(createTable)).toContain("product_id integer NOT NULL, product_variant_id integer NOT NULL,");
  });

  it("keeps the worker's states apart from the closed ones: due only while pending or ending, decided only when closed", () => {
    const table = oneLine(createTable);
    expect(table).toContain("CHECK (state IN ('pending', 'ending', 'ended', 'failed', 'superseded', 'resolved'))");
    expect(table).toContain("CHECK (reason IN ('size_removed', 'product_removed'))");
    expect(table).toContain("CONSTRAINT dropship_end_ended_at_chk CHECK ((state = 'ended') = (ended_at IS NOT NULL))");
    // A failed end (permanent) has no due time, so the worker never picks it up again (CLAUDE.md §6).
    expect(table).toContain("CONSTRAINT dropship_end_due_chk CHECK ((state IN ('pending', 'ending')) = (next_attempt_at IS NOT NULL))");
    expect(table).toContain("CONSTRAINT dropship_end_decided_chk CHECK ((state IN ('ended', 'failed', 'superseded', 'resolved')) = "
      + "(decided_at IS NOT NULL))");
    expect(table).toContain("CONSTRAINT dropship_end_withdraw_chk CHECK (withdraw_returned_at IS NULL OR (withdraw_requested_at IS NOT NULL "
      + "AND withdraw_returned_at >= withdraw_requested_at))");
    expect(table).toContain("CONSTRAINT dropship_end_ending_identity_chk CHECK (state <> 'ending' OR resolved_identity IS NOT NULL)");
    expect(table).toContain("CONSTRAINT dropship_end_staff_key_chk CHECK ((staff_action IS NULL) = (staff_action_key IS NULL))");
    expect(table).toContain("CHECK (staff_action IS NULL OR staff_action IN ('retry', 'resolve_ended', 'resolve_left'))");
    expect(table).toContain("CHECK (withdraw_call_count BETWEEN 0 AND 3)");
    expect(table).toContain("context jsonb NOT NULL DEFAULT '{}'::jsonb CONSTRAINT dropship_end_context_chk CHECK (jsonb_typeof(context) = 'object')");
    expect(table).toContain("requested_identity jsonb NOT NULL CONSTRAINT dropship_end_requested_identity_chk "
      + "CHECK (jsonb_typeof(requested_identity) = 'object')");
    // The writers pass their injected clock: no time column has a default (CLAUDE.md §3).
    expect(table).toContain("created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,");
    expect(table).not.toMatch(/DEFAULT (now|clock_timestamp|transaction_timestamp|CURRENT_TIMESTAMP)/i);
  });

  it("indexes one open end per listing and the reads of later steps, with the plan's predicates", () => {
    const indexes = topLevelStatements.filter((statement) => /^CREATE (UNIQUE )?INDEX /.test(statement));
    expect(indexes).toEqual([
      `CREATE UNIQUE INDEX dropship_end_one_open_idx ON ${TABLE} (listing_id) WHERE state IN ('pending', 'ending', 'failed')`,
      `CREATE INDEX dropship_end_due_idx ON ${TABLE} (next_attempt_at, id) WHERE next_attempt_at IS NOT NULL`,
      `CREATE INDEX dropship_end_vendor_product_open_idx ON ${TABLE} (vendor_id, product_id) WHERE state IN ('pending', 'ending', 'failed')`,
      `CREATE INDEX dropship_end_store_decided_idx ON ${TABLE} (store_connection_id, decided_at DESC) WHERE state IN ('ended', 'failed')`,
      `CREATE INDEX dropship_end_withdraw_started_idx ON ${TABLE} (store_connection_id, withdraw_requested_at) WHERE withdraw_requested_at IS NOT NULL`,
      `CREATE INDEX dropship_end_listing_ended_idx ON ${TABLE} (listing_id, ended_at DESC) WHERE state = 'ended'`,
      `CREATE INDEX dropship_end_state_idx ON ${TABLE} (state, id)`,
    ]);
  });

  it("proves each new row against its listing and the catalog once per INSERT statement, with plain reads (FID-6)", () => {
    expect(triggerOf("listing_end_request_consistency")).toBe(`CREATE TRIGGER listing_end_request_consistency AFTER INSERT ON ${TABLE} `
      + "REFERENCING NEW TABLE AS new_ends FOR EACH STATEMENT EXECUTE FUNCTION dropship.check_listing_end_request_rows()");
    const body = oneLine(functionBodies["dropship.check_listing_end_request_rows"]!);
    expect(body).toContain("FROM new_ends n JOIN dropship.dropship_vendor_listings l ON l.id = n.listing_id "
      + "LEFT JOIN catalog.product_variants v ON v.id = n.product_variant_id");
    expect(body).toContain("WHERE l.vendor_id <> n.vendor_id OR l.store_connection_id <> n.store_connection_id "
      + "OR l.product_variant_id <> n.product_variant_id OR v.id IS NULL OR v.product_id <> n.product_id");
    expect(body).toContain("RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'DROPSHIP_LISTING_END_REQUEST_INCONSISTENT';");
    expect(body).not.toMatch(/\bFOR (UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)\b/);
  });

  it("re-plans a product once per UPDATE statement, only for rows whose state changed, and never on INSERT (FID-7)", () => {
    expect(triggerOf("publication_selection_invalidation")).toBe(`CREATE TRIGGER publication_selection_invalidation AFTER UPDATE ON ${TABLE} `
      + "REFERENCING OLD TABLE AS old_ends NEW TABLE AS new_ends FOR EACH STATEMENT "
      + "EXECUTE FUNCTION dropship.invalidate_listing_end_state_changes()");
    const body = oneLine(functionBodies["dropship.invalidate_listing_end_state_changes"]!);
    expect(body).toContain("FOR affected IN SELECT DISTINCT n.product_id FROM new_ends n JOIN old_ends o ON o.id = n.id "
      + "WHERE o.state IS DISTINCT FROM n.state ORDER BY n.product_id "
      + "LOOP PERFORM inventory.invalidate_publication_selection_product(affected); END LOOP;");
    // The save's inserts are re-planned by the picks DELETE of the same transaction; nothing here re-plans an insert.
    const invalidators = Object.entries(functionBodies)
      .filter(([, text]) => text.includes("invalidate_publication_selection_product")).map(([name]) => name);
    expect(invalidators).toEqual(["dropship.invalidate_listing_end_state_changes"]);
    expect(topLevelStatements.filter((statement) => /^CREATE TRIGGER .* AFTER INSERT /.test(statement)))
      .toEqual([triggerOf("listing_end_request_consistency")]);
    expect(statements).not.toContain("gate_publication_selection_change");
  });

  it("refuses any change of the nine identity columns, and fires only when an UPDATE names and changes one", () => {
    const trigger = triggerOf("listing_end_request_identity_immutable");
    const listed = /BEFORE UPDATE OF (.+?) ON /.exec(trigger)?.[1]?.split(", ");
    expect(listed).toEqual(IDENTITY_COLUMNS);
    expect(trigger).toContain(` ON ${TABLE} FOR EACH ROW WHEN (`);
    const when = /WHEN \((.*)\) EXECUTE FUNCTION/.exec(trigger)?.[1]?.split(" OR ");
    expect(when).toEqual(IDENTITY_COLUMNS.map((column) => `OLD.${column} IS DISTINCT FROM NEW.${column}`));
    expect(trigger.endsWith("EXECUTE FUNCTION dropship.refuse_listing_end_request_identity_change()")).toBe(true);
    expect(oneLine(functionBodies["dropship.refuse_listing_end_request_identity_change"]!))
      .toBe("BEGIN RAISE EXCEPTION 'DROPSHIP_LISTING_END_REQUEST_IDENTITY_IMMUTABLE'; END;");
    for (const mutable of ["state", "resolved_identity", "next_attempt_at", "decided_at", "ended_at", "version", "updated_at"]) {
      expect(listed, mutable).not.toContain(mutable);
    }
  });

  it("pins every function's search path and qualifies every relation it reads", () => {
    for (const [name] of Object.entries(functionBodies)) {
      expect(statements, name).toMatch(new RegExp(`CREATE FUNCTION ${name.replace(".", "\\.")}\\(\\) RETURNS trigger LANGUAGE plpgsql `
        + "SET search_path = pg_catalog AS \\$\\$"));
    }
    for (const body of Object.values(functionBodies)) {
      for (const match of body.matchAll(/(?<!DISTINCT )\b(?:FROM|JOIN)\s+([\w.]+)/g)) {
        expect(["new_ends", "old_ends"].includes(match[1]!) || /^(dropship|catalog|inventory)\./.test(match[1]!), match[1]).toBe(true);
      }
    }
  });
});

describe("dropship_listing_end_requests Drizzle parity", () => {
  const config = getTableConfig(dropshipListingEndRequests);

  it("declares the table and its columns, in the migration's order", () => {
    expect(config.schema).toBe("dropship");
    expect(config.name).toBe("dropship_listing_end_requests");
    const columns = config.columns.map((column) => column.name);
    expect(columns).toEqual([...createTable.matchAll(/\n  ([a-z_]+) (?:bigint|integer|varchar|jsonb|text|timestamptz)/g)].map((match) => match[1]));
    expect(columns).toHaveLength(28);
    for (const column of config.columns) {
      const line = createTable.split("\n").find((entry) => entry.startsWith(`  ${column.name} `))!;
      expect(line.includes("NOT NULL") || line.includes("PRIMARY KEY"), column.name).toBe(column.notNull);
      expect(line.includes("DEFAULT") || line.includes("IDENTITY"), column.name).toBe(column.hasDefault);
    }
  });

  it("declares the keys with their delete rules, the checks and the indexes under the migration's names", () => {
    expect(config.foreignKeys.map((key) => [key.getName(), key.onDelete ?? "no action"]).sort()).toEqual([
      ["dropship_end_listing_fk", "cascade"], ["dropship_end_revision_fk", "no action"],
      ["dropship_end_store_owner_fk", "cascade"], ["dropship_end_vendor_fk", "cascade"],
    ]);
    const checks = config.checks.map((check) => check.name);
    expect(checks).toHaveLength(16);
    expect(checks.sort()).toEqual([...createTable.matchAll(/CONSTRAINT (\w+_chk)\s+CHECK \(/g)].map((match) => match[1]).sort());
    expect(config.indexes.map((index) => [index.config.name, index.config.unique])).toEqual([
      ["dropship_end_one_open_idx", true], ["dropship_end_due_idx", false], ["dropship_end_vendor_product_open_idx", false],
      ["dropship_end_store_decided_idx", false], ["dropship_end_withdraw_started_idx", false], ["dropship_end_listing_ended_idx", false],
      ["dropship_end_state_idx", false],
    ]);
  });
});
