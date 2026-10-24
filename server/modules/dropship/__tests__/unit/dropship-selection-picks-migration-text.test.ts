import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  dropshipCatalogArrivals,
  dropshipSelectionConversionSizes,
  dropshipSelectionConversions,
  dropshipVendorCategoryNoticeMarks,
  dropshipVendorSelectedVariants,
  dropshipVendorSelectionRuleSetRevisions,
} from "../../../../../shared/schema/dropship.schema";
import { isReservedSelectionIdempotencyKey } from "../../domain/selection-release";
import {
  JS_TRIM_CHARACTER_CLASS,
  PICKS_SELECTION_TRIGGERS_SQL,
  SELECTION_RULE_CONVERSION_SQL,
  SELECTION_RULE_MATCH_SQL,
  SIZE_MATCH_INPUTS_SQL,
} from "../../infrastructure/dropship-selection-conversion.sql";
import { SELECTION_RULES_RETIRED_DB_MESSAGE } from "../../infrastructure/dropship-selection-atp.repository";
import {
  SELECTED_VARIANTS_MIGRATION_FILE,
  SELECTED_VARIANTS_MIGRATION_SUFFIX,
  selectedVariantsMigrationSql,
} from "../fixtures/selection-picks-migration.fixture";

/**
 * The picks migration's text (step 1 plan S2-5, PR B, PLAN-B v4.1 §6, §15.1). The PostgreSQL suite
 * (dropship-selection-picks-migration.integration.test.ts) applies it through the release executor; this pins
 * what keeps that release safe while the previous release still serves: the save's lock order first with no
 * upgrade (CHK1), a keyed temp table (SAFETY-2), the vendor and size foreign keys only after the copy
 * (SAFETY-4), a backfill key no vendor could send (SAFETY-10), the category text column (SAFETY-11), no
 * sellable trigger (V6), no statement that raises by design (SAFETY-8), the exported conversion text
 * verbatim (FIDELITY-1, V33), the exact `trim()` class, and the Drizzle declarations.
 */
// The repository module (for A's freeze message) reaches the database pool on import; nothing here queries.
vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../../inventory-planning/infrastructure/inventory-availability-runtime-atp.repository", () => ({
  createAuthorityAwareInventoryAtpService: () => ({}),
}));

const sql = selectedVariantsMigrationSql();
/** The file without its comment lines, so prose never satisfies or breaks a statement check. */
const statements = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
/** Function bodies, and the statements with every body blanked out. */
const functionBodies = [...statements.matchAll(/CREATE FUNCTION (\S+?)\(\)[^$]*\$\$([\s\S]*?)\$\$/g)]
  .map((match) => ({ name: match[1]!, body: match[2]! }));
const topLevel = statements.replace(/\$\$[\s\S]*?\$\$/g, "$$ $$");
const COPY_INTO_PICKS = "INSERT INTO dropship.dropship_vendor_selected_variants (";
/** The conversion's own record of each size's matcher inputs (FUP-1), written by the conversion's statement. */
const CONVERSION_SIZES_TABLE = "CREATE TABLE dropship.dropship_selection_conversion_sizes (";
const CONVERSION_SIZES_INSERT = "INSERT INTO dropship.dropship_selection_conversion_sizes (product_variant_id, product_id, category, product_line_ids)";
const BACKFILL_REVISIONS = "INSERT INTO dropship.dropship_vendor_selection_rule_set_revisions";
/** The sizes lock and the prune after it (MIG-1, MIG-3): exactly these two statements, in this order. */
const SIZES_LOCK = "LOCK TABLE catalog.product_variants IN SHARE ROW EXCLUSIVE MODE;";
const SIZES_PRUNE = `DELETE FROM selection_conversion c
WHERE NOT EXISTS (SELECT 1 FROM catalog.product_variants pv WHERE pv.id = c.product_variant_id);`;

function indexOfOnce(text: string, needle: string): number {
  const first = text.indexOf(needle);
  expect(first, needle).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(needle, first + 1), `${needle} appears more than once`).toBe(-1);
  return first;
}

/** Every `\uXXXX` unit of the class, as code points. */
function classCodePoints(characterClass: string): number[] {
  const units = characterClass.match(/\\u[0-9A-F]{4}/g) ?? [];
  expect(units.join("")).toBe(characterClass);
  return units.map((unit) => Number.parseInt(unit.slice(2), 16));
}

describe("dropship_vendor_selected_variants migration text", () => {
  it("is one allocated file found by its name, with its sidecar", () => {
    expect(SELECTED_VARIANTS_MIGRATION_FILE.endsWith(SELECTED_VARIANTS_MIGRATION_SUFFIX)).toBe(true);
    expect(SELECTED_VARIANTS_MIGRATION_FILE).toMatch(/^9\d{20}_dropship_vendor_selected_variants\.sql$/);
    const sidecar = JSON.parse(readFileSync(resolve(process.cwd(), "migrations/metadata", `${SELECTED_VARIANTS_MIGRATION_FILE}.json`), "utf8"));
    expect(sidecar).toMatchObject({ version: 1, migration: SELECTED_VARIANTS_MIGRATION_FILE, ordinal: 1 });
  });

  it("contains the exported conversion, match and trigger texts verbatim (FIDELITY-1, V33)", () => {
    expect(sql).toContain(SELECTION_RULE_CONVERSION_SQL);
    expect(sql).toContain(SELECTION_RULE_MATCH_SQL);
    expect(sql).toContain(PICKS_SELECTION_TRIGGERS_SQL);
    // The match decides every (rule, size) pair the conversion tries: three scope branches for the include rules and
    // three for the exclude rules (MIG-4).
    expect(SELECTION_RULE_CONVERSION_SQL.split(SELECTION_RULE_MATCH_SQL)).toHaveLength(7);
    indexOfOnce(sql, SELECTION_RULE_CONVERSION_SQL);
    indexOfOnce(sql, PICKS_SELECTION_TRIGGERS_SQL);
  });

  it("locks the revisions ACCESS EXCLUSIVE, then the rules SHARE ROW EXCLUSIVE, first and never again (CHK1)", () => {
    const parts = statements.trim().split(";").map((part) => part.trim());
    expect(parts[0]).toBe("LOCK TABLE dropship.dropship_vendor_selection_rule_set_revisions IN ACCESS EXCLUSIVE MODE");
    expect(parts[1]).toBe("LOCK TABLE dropship.dropship_vendor_selection_rules IN SHARE ROW EXCLUSIVE MODE");
    // The only other LOCK TABLE is the sizes' (MIG-1), on neither of these tables.
    expect(statements.match(/\bLOCK TABLE [^;]*;/g)).toEqual([`${parts[0]};`, `${parts[1]};`, SIZES_LOCK]);
    // The ALTER TABLE on the revisions comes after both locks (it would otherwise take ACCESS EXCLUSIVE itself).
    expect(statements.indexOf("ALTER TABLE dropship.dropship_vendor_selection_rule_set_revisions"))
      .toBeGreaterThan(statements.indexOf("IN SHARE ROW EXCLUSIVE MODE"));
  });

  it("runs the statements in the plan's order: conversion first, foreign keys after the copy, triggers, freeze, notice tables", () => {
    const order = [
      "LOCK TABLE dropship.dropship_vendor_selection_rule_set_revisions",
      "LOCK TABLE dropship.dropship_vendor_selection_rules",
      "ADD COLUMN request_kind",
      CONVERSION_SIZES_TABLE,
      "CREATE TEMP TABLE selection_conversion (",
      SELECTION_RULE_CONVERSION_SQL,
      "CREATE TABLE dropship.dropship_vendor_selected_variants (",
      "CREATE TABLE dropship.dropship_selection_conversions (",
      SIZES_LOCK,
      SIZES_PRUNE,
      BACKFILL_REVISIONS,
      COPY_INTO_PICKS,
      "INSERT INTO dropship.dropship_selection_conversions",
      "INSERT INTO dropship.dropship_audit_events",
      "ADD CONSTRAINT dropship_vendor_selected_variants_vendor_fk",
      "ADD CONSTRAINT dropship_selection_conversions_vendor_fk",
      PICKS_SELECTION_TRIGGERS_SQL,
      "CREATE TRIGGER aa_selection_rules_retired",
      "CREATE TABLE dropship.dropship_catalog_arrivals (",
      "CREATE TABLE dropship.dropship_vendor_category_notice_marks (",
    ].map((needle) => indexOfOnce(statements, needle));
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  it("converts into a keyed temp table, so each (vendor, size) is one row and the copy cannot collide (SAFETY-2)", () => {
    const temp = statements.slice(statements.indexOf("CREATE TEMP TABLE selection_conversion ("));
    expect(temp.slice(0, temp.indexOf(";"))).toMatch(/PRIMARY KEY \(vendor_id, product_variant_id\)\s*\) ON COMMIT DROP$/);
    // The conversion's statement starts with its record of the sizes it read (FUP-1), then fills the temp table.
    expect(SELECTION_RULE_CONVERSION_SQL.startsWith("WITH conversion_sizes AS (\n")).toBe(true);
    expect(SELECTION_RULE_CONVERSION_SQL).toContain("\n)\nINSERT INTO selection_conversion (vendor_id, product_variant_id, source)\nSELECT m.vendor_id,");
    expect(SELECTION_RULE_CONVERSION_SQL.endsWith("ON CONFLICT (vendor_id, product_variant_id) DO NOTHING;")).toBe(true);
    // The source is decided in the same row, from an active variant include naming the size: only the variant
    // branch's rows are `named` (MIG-4's form of A's "a variant include names the size").
    expect(SELECTION_RULE_CONVERSION_SQL).toContain("CASE WHEN bool_or(m.named) THEN 'legacy_variant_rule' ELSE 'legacy_broad_rule' END");
    expect(SELECTION_RULE_CONVERSION_SQL.match(/\bAS named\b/g)).toEqual(["AS named", "AS named"]);
    expect(SELECTION_RULE_CONVERSION_SQL.match(/SELECT r\.vendor_id, pv\.id AS product_variant_id, true AS named\n  FROM dropship\.dropship_vendor_selection_rules r\n  JOIN catalog\.product_variants pv ON pv\.id = r\.product_variant_id\n/g)).toHaveLength(2);
    expect(SELECTION_RULE_CONVERSION_SQL).toMatch(/GROUP BY m\.vendor_id, m\.product_variant_id\nON CONFLICT/);
  });

  it("tries each rule only against the sizes it can match, then takes the excluded pairs out (MIG-4)", () => {
    const [included, excluded] = SELECTION_RULE_CONVERSION_SQL.split("WHERE NOT EXISTS (");
    expect(excluded).toBeDefined();
    for (const [part, action] of [[included!, "include"], [excluded!, "exclude"]] as const) {
      const branches = part.split("UNION ALL");
      expect(branches).toHaveLength(3);
      // variant rules: the size they name; product rules: their product's sizes; every other scope: every size.
      expect(branches[0]).toContain("JOIN catalog.product_variants pv ON pv.id = r.product_variant_id");
      expect(branches[0]).toContain(`WHERE r.is_active = true AND r.action = '${action}' AND r.scope_type = 'variant'`);
      expect(branches[1]).toContain("JOIN catalog.products p ON p.id = r.product_id\n  JOIN catalog.product_variants pv ON pv.product_id = p.id");
      expect(branches[1]).toContain(`WHERE r.is_active = true AND r.action = '${action}' AND r.scope_type = 'product'`);
      expect(branches[2]).toContain("CROSS JOIN catalog.product_variants pv\n  JOIN catalog.products p ON p.id = pv.product_id");
      expect(branches[2]).toContain(`WHERE r.is_active = true AND r.action = '${action}' AND r.scope_type NOT IN ('variant', 'product')`);
      for (const branch of branches) expect(branch.split(SELECTION_RULE_MATCH_SQL)).toHaveLength(2);
    }
    // One anti-join on the pair, and no rule scan per (vendor, size) pair.
    expect(excluded).toContain("WHERE x.vendor_id = m.vendor_id AND x.product_variant_id = m.product_variant_id");
    expect(SELECTION_RULE_CONVERSION_SQL).not.toMatch(/r\.vendor_id = v\.vendor_id/);
  });

  it("records every size's matcher inputs in the conversion's own statement, so in its snapshot, and nowhere else (FUP-1)", () => {
    // A data-modifying WITH runs once, on the statement's one snapshot: the rows are what the conversion decided from,
    // whatever catalog edit commits while the file runs. Every size of a product, its product, the text category and
    // the product's lines in line order: exactly what the follow-up's repair compares (SIZE_MATCH_INPUTS_SQL).
    const cte = SELECTION_RULE_CONVERSION_SQL.slice(0, SELECTION_RULE_CONVERSION_SQL.indexOf("\n)\nINSERT INTO selection_conversion") + 2);
    expect(cte).toBe(`WITH conversion_sizes AS (
  ${CONVERSION_SIZES_INSERT}
  SELECT pv.id, p.id, p.category, ${SIZE_MATCH_INPUTS_SQL.productLineIds}
  FROM catalog.product_variants pv
  JOIN catalog.products p ON p.id = pv.product_id
)`);
    expect(SIZE_MATCH_INPUTS_SQL.productLineIds).toBe(
      "ARRAY(SELECT plp.product_line_id FROM catalog.product_line_products plp WHERE plp.product_id = p.id ORDER BY plp.product_line_id)");
    // The table comes before the conversion, keyed by the size, with no foreign key and no other writer in the file.
    expect(indexOfOnce(statements, CONVERSION_SIZES_TABLE)).toBeLessThan(indexOfOnce(statements, SELECTION_RULE_CONVERSION_SQL));
    const create = statements.slice(statements.indexOf(CONVERSION_SIZES_TABLE));
    expect(create.slice(0, create.indexOf(";"))).toBe(`${CONVERSION_SIZES_TABLE}
  product_variant_id integer PRIMARY KEY,
  product_id integer NOT NULL,
  category text,
  product_line_ids integer[] NOT NULL
)`);
    indexOfOnce(statements, CONVERSION_SIZES_INSERT);
    expect(statements.match(/dropship\.dropship_selection_conversion_sizes\b/g)).toHaveLength(2);
  });

  it("locks the sizes after the conversion and drops each size deleted since, before anything counts, copies or checks a pick (MIG-1)", () => {
    const conversion = indexOfOnce(statements, SELECTION_RULE_CONVERSION_SQL);
    const lock = indexOfOnce(statements, SIZES_LOCK);
    const prune = indexOfOnce(statements, SIZES_PRUNE);
    // Its own statements, in this order, right after the conversion's read and the new tables: the prune runs with a
    // snapshot taken once the lock is held (READ COMMITTED), so it sees every delete committed since the read.
    expect(conversion).toBeLessThan(lock);
    expect(statements.slice(lock + SIZES_LOCK.length, prune).trim()).toBe("");
    expect(prune + SIZES_PRUNE.length).toBeLessThan(indexOfOnce(statements, BACKFILL_REVISIONS));
    // Every later reader of the conversion (the backfill's pick count, the copy) comes after the prune, and the
    // size foreign key after both; no statement before the lock reads the temp table but the conversion itself.
    const readers = [...statements.matchAll(/FROM selection_conversion c\b/g)].map((match) => match.index!);
    expect(readers.length).toBe(3);
    for (const reader of readers) expect(reader).toBeGreaterThanOrEqual(prune);
    expect(indexOfOnce(statements, "ADD CONSTRAINT dropship_vendor_selected_variants_variant_fk")).toBeGreaterThan(prune);
  });

  it("waits for the sizes before it holds anything of the vendors (MIG-3)", () => {
    const lock = indexOfOnce(statements, SIZES_LOCK);
    // The first statements that lock vendors: the backfill revisions (their vendor key check holds each converted
    // vendor's row FOR KEY SHARE) and the vendor foreign keys (SHARE ROW EXCLUSIVE on the table). Both after the lock.
    const vendorLocks = [indexOfOnce(statements, BACKFILL_REVISIONS),
      ...[...statements.matchAll(/REFERENCES dropship\.dropship_vendors\(/g)].map((match) => match.index!)];
    for (const at of vendorLocks) expect(at).toBeGreaterThan(lock);
    expect(statements.slice(0, lock)).not.toMatch(/dropship\.dropship_vendors\b/);
    expect(statements.slice(0, lock)).not.toMatch(/INSERT INTO dropship\.dropship_(audit_events|vendor_selection_rule_set_revisions|selection_conversions|vendor_selected_variants)\b/);
  });

  it("adds every foreign key on the sizes or the vendors only after the copy into the picks (SAFETY-4)", () => {
    const copy = indexOfOnce(statements, COPY_INTO_PICKS);
    const references = [...statements.matchAll(/REFERENCES (catalog\.product_variants|dropship\.dropship_vendors)\(/g)];
    expect(references.length).toBe(4);
    for (const reference of references) expect(reference.index).toBeGreaterThan(copy);
    // The new tables are created without a REFERENCES of their own (the marks table comes after the FK step).
    for (const table of ["dropship_vendor_selected_variants", "dropship_selection_conversions", "dropship_selection_conversion_sizes"]) {
      const create = statements.slice(statements.indexOf(`CREATE TABLE dropship.${table} (`));
      expect(create.slice(0, create.indexOf(";"))).not.toMatch(/REFERENCES/);
    }
  });

  it("lets a deleted size take its picks with it, and adds no sellable-size trigger (CHK5, V6)", () => {
    expect(statements).toMatch(/FOREIGN KEY \(product_variant_id\)\s+REFERENCES catalog\.product_variants\(id\) ON DELETE CASCADE/);
    expect(statements).toMatch(/FOREIGN KEY \(vendor_id\)\s+REFERENCES dropship\.dropship_vendors\(id\) ON DELETE CASCADE,/);
    expect(statements).not.toMatch(/assert_customer_sellable_variant/);
    expect(statements).not.toMatch(/require_sellable_variant/);
  });

  it("matches a category on the products' text column, never the category id or name (SAFETY-11)", () => {
    for (const text of [SELECTION_RULE_MATCH_SQL, SELECTION_RULE_CONVERSION_SQL]) {
      expect(text).toContain("regexp_replace(p.category, ");
      expect(text).toContain("regexp_replace(r.category, ");
      expect(text).not.toMatch(/category_id/);
      expect(text).not.toMatch(/pc\.name/);
      expect(text).not.toMatch(/product_categories/);
    }
    // Every scope of the TypeScript matcher, and nothing else matches.
    expect(SELECTION_RULE_MATCH_SQL).toMatch(/WHEN 'catalog' THEN true/);
    expect(SELECTION_RULE_MATCH_SQL).toMatch(/WHEN 'product_line' THEN EXISTS \(SELECT 1 FROM catalog\.product_line_products plp\s+WHERE plp\.product_id = p\.id AND plp\.product_line_id = r\.product_line_id\)/);
    expect(SELECTION_RULE_MATCH_SQL).toContain("WHEN 'product' THEN COALESCE(r.product_id = p.id, false)");
    expect(SELECTION_RULE_MATCH_SQL).toContain("WHEN 'variant' THEN COALESCE(r.product_variant_id = pv.id, false)");
    expect(SELECTION_RULE_MATCH_SQL).toMatch(/ELSE false\s+END$/);
  });

  it("raises only in the freeze and the arrivals guard, never at the top level (SAFETY-8, TESTS-11)", () => {
    expect(topLevel).not.toMatch(/\bRAISE\b/i);
    expect(topLevel).not.toMatch(/(^|;)\s*DO\b/im);
    const raising = functionBodies.filter((fn) => /\bRAISE\b/i.test(fn.body)).map((fn) => fn.name).sort();
    expect(raising).toEqual(["dropship.refuse_catalog_arrival_change", "dropship.refuse_selection_rules_write"]);
    const freeze = functionBodies.find((fn) => fn.name === "dropship.refuse_selection_rules_write")!;
    expect(SELECTION_RULES_RETIRED_DB_MESSAGE).toBe("DROPSHIP_SELECTION_RULES_RETIRED");
    expect(freeze.body.trim()).toBe(`BEGIN\n  RAISE EXCEPTION '${SELECTION_RULES_RETIRED_DB_MESSAGE}' USING ERRCODE = 'P0001';\nEND;`);
    const arrivals = functionBodies.find((fn) => fn.name === "dropship.refuse_catalog_arrival_change")!;
    expect(arrivals.body.trim()).toBe("BEGIN\n  RAISE EXCEPTION 'DROPSHIP_CATALOG_ARRIVALS_APPEND_ONLY';\nEND;");
    // The third function is the picks' statement invalidation (R4), which never raises.
    expect(functionBodies.map((fn) => fn.name).sort()).toEqual([
      "dropship.invalidate_picked_products", "dropship.refuse_catalog_arrival_change", "dropship.refuse_selection_rules_write"]);
  });

  it("freezes the rules before the publication gate and writes nothing but new rows", () => {
    expect(statements).toMatch(/CREATE TRIGGER aa_selection_rules_retired\s+BEFORE INSERT OR UPDATE OR DELETE ON dropship\.dropship_vendor_selection_rules\s+FOR EACH STATEMENT EXECUTE FUNCTION dropship\.refuse_selection_rules_write\(\);/);
    // PG fires same-event triggers in name order: the freeze precedes 0743's gate.
    expect(["aa_selection_rules_retired", "ac_publication_selection_gate"].sort()[0]).toBe("aa_selection_rules_retired");
    expect(topLevel).not.toMatch(/(^|;)\s*(UPDATE|DROP|TRUNCATE)\b/im);
    // The one DELETE is the prune of the file's own temporary table (MIG-1).
    expect([...topLevel.matchAll(/(^|;)\s*DELETE\b[^;]*;/gim)].map((match) => match[0].replace(/^;?\s*/, ""))).toEqual([SIZES_PRUNE]);
    expect(topLevel).not.toMatch(/CONCURRENTLY/i);
    expect(topLevel).not.toMatch(/IF NOT EXISTS/i);
    expect(topLevel).not.toMatch(/\bSET\s+(LOCAL\s+)?(lock_timeout|statement_timeout)/i);
    // The rules stay active: nothing deactivates them.
    expect(topLevel).not.toMatch(/is_active\s*=\s*false/i);
  });

  it("keys each backfill revision with the head revision id read under the lock, under A's reserved prefix (SAFETY-10)", () => {
    expect(statements).toContain("'legacy-picks-backfill:' || r.vendor_id || ':' || head.max_id,");
    expect(statements).toMatch(/CROSS JOIN \(\s+SELECT COALESCE\(max\(id\), 0\) AS max_id FROM dropship\.dropship_vendor_selection_rule_set_revisions\s+\) head/);
    expect(statements).toContain("repeat('0', 64), 'system', NULL, count(*)::integer, now(), 'picks_backfill',");
    expect(isReservedSelectionIdempotencyKey("legacy-picks-backfill:301:77")).toBe(true);
    // The copy, the records and the audit each find a vendor's backfill revision the same way.
    expect(statements.match(/rev\.request_kind = 'picks_backfill'/g)).toHaveLength(3);
  });

  it("normalizes categories with exactly the code points String.prototype.trim removes", () => {
    const listed = classCodePoints(JS_TRIM_CHARACTER_CLASS);
    expect(listed).toEqual([...new Set(listed)].sort((left, right) => left - right));
    const trimmed: number[] = [];
    for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
      const text = codePoint >= 0xd800 && codePoint <= 0xdfff ? String.fromCharCode(codePoint) : String.fromCodePoint(codePoint);
      if (text.trim() === "") trimmed.push(codePoint);
    }
    expect(listed).toEqual(trimmed);
    // A sample of neighbours trim() keeps: zero-width space, Mongolian vowel separator, NEL, letters.
    for (const kept of [0x200b, 0x180e, 0x0085, 0x0041, 0x00e9]) expect(String.fromCodePoint(kept).trim()).not.toBe("");
    // Every regexp_replace in the file trims with exactly that class, both ends, globally.
    const trims = [...statements.matchAll(/regexp_replace\((\w+\.\w+), '([^']*)', '', 'g'\)/g)];
    // Rule and product category, in each of the six branches of the include and the exclude pairs (MIG-4).
    expect(trims.map((trim) => trim[1])).toEqual(Array.from({ length: 6 }, () => ["r.category", "p.category"]).flat());
    for (const trim of trims) expect(trim[2]).toBe(`^[${JS_TRIM_CHARACTER_CLASS}]+|[${JS_TRIM_CHARACTER_CLASS}]+$`);
    expect(statements.match(/regexp_replace\(/g)).toHaveLength(trims.length);
  });

  it("gates the picks as 0743 gates the vendor overrides, and re-plans each touched product once per statement (V33, R4)", () => {
    const manifest = readFileSync(resolve(process.cwd(), "migrations/0743_publication_selection_work.sql"), "utf8");
    expect(manifest).toContain("('dropship.dropship_vendor_variant_overrides','variant','vendor_id,product_variant_id,enabled_override',true)");
    // The gate is the overrides' gate (0743's manifest loop, gated row) and the UPDATE path is the overrides'
    // row invalidation; an INSERT or DELETE hands each product it touched to inventory's own invalidation once,
    // in product order, from the statement's transition table (the final gate's measured fix, R4).
    expect(PICKS_SELECTION_TRIGGERS_SQL).toBe(`CREATE FUNCTION dropship.invalidate_picked_products() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE affected integer;
BEGIN
  FOR affected IN SELECT DISTINCT v.product_id FROM changed_picks c
      JOIN catalog.product_variants v ON v.id = c.product_variant_id ORDER BY v.product_id
  LOOP PERFORM inventory.invalidate_publication_selection_product(affected); END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER ac_publication_selection_gate
  BEFORE INSERT OR DELETE OR UPDATE OF vendor_id, product_variant_id ON dropship.dropship_vendor_selected_variants
  FOR EACH STATEMENT EXECUTE FUNCTION inventory.gate_publication_selection_change();
CREATE TRIGGER publication_selection_invalidation
  AFTER UPDATE OF vendor_id, product_variant_id ON dropship.dropship_vendor_selected_variants
  FOR EACH ROW EXECUTE FUNCTION inventory.notify_publication_selection_change('variant', 'vendor_id,product_variant_id');
CREATE TRIGGER publication_selection_invalidation_added
  AFTER INSERT ON dropship.dropship_vendor_selected_variants REFERENCING NEW TABLE AS changed_picks
  FOR EACH STATEMENT EXECUTE FUNCTION dropship.invalidate_picked_products();
CREATE TRIGGER publication_selection_invalidation_removed
  AFTER DELETE ON dropship.dropship_vendor_selected_variants REFERENCING OLD TABLE AS changed_picks
  FOR EACH STATEMENT EXECUTE FUNCTION dropship.invalidate_picked_products();`);
    // The same gate text 0743's loop builds for a gated row, and the same invalidation function and arguments.
    expect(manifest).toContain("BEFORE INSERT OR DELETE OR UPDATE OF %s ON %s FOR EACH STATEMENT EXECUTE FUNCTION inventory.gate_publication_selection_change()");
    expect(manifest).toContain("FOR EACH ROW EXECUTE FUNCTION inventory.notify_publication_selection_change(%L,%L)");
    expect(manifest).toContain("CREATE FUNCTION inventory.invalidate_publication_selection_product(affected_product integer)");
  });
});

describe("dropship_vendor_selected_variants Drizzle parity", () => {
  const foreignKeyNames = (table: PgTable) => getTableConfig(table).foreignKeys.map((key) => key.getName()).sort();
  const checkNames = (table: PgTable) => getTableConfig(table).checks.map((check) => check.name).sort();
  const columnNames = (table: PgTable) => getTableConfig(table).columns.map((column) => column.name);

  it.each([
    [dropshipVendorSelectedVariants, "dropship_vendor_selected_variants",
      ["vendor_id", "product_variant_id", "revision_id", "source", "selected_at"],
      ["dropship_vendor_selected_variants_revision_fk", "dropship_vendor_selected_variants_variant_fk", "dropship_vendor_selected_variants_vendor_fk"],
      ["dropship_vendor_selected_variants_source_chk"]],
    [dropshipSelectionConversions, "dropship_selection_conversions",
      ["vendor_id", "backfill_revision_id", "broad_rule_ids", "converted_at", "followup_state", "followup_at", "followup_failures",
        "notice_state", "notice_at", "last_error_code"],
      ["dropship_selection_conversions_revision_fk", "dropship_selection_conversions_vendor_fk"],
      ["dropship_selection_conversions_followup_done_chk", "dropship_selection_conversions_followup_failures_chk",
        "dropship_selection_conversions_followup_state_chk", "dropship_selection_conversions_notice_sent_chk",
        "dropship_selection_conversions_notice_state_chk", "dropship_selection_conversions_review_code_chk"]],
    [dropshipSelectionConversionSizes, "dropship_selection_conversion_sizes",
      ["product_variant_id", "product_id", "category", "product_line_ids"], [], []],
    [dropshipCatalogArrivals, "dropship_catalog_arrivals",
      ["id", "product_variant_id", "product_id", "category_id", "first_seen_at", "baseline"], [], []],
    [dropshipVendorCategoryNoticeMarks, "dropship_vendor_category_notice_marks",
      ["vendor_id", "category_id", "seen_through_arrival_id", "notified_through_arrival_id", "updated_at"],
      ["dropship_vendor_category_notice_marks_vendor_fk"],
      ["dropship_vendor_category_notice_marks_notified_chk", "dropship_vendor_category_notice_marks_seen_chk"]],
  ] as const)("declares %#: the table, its columns, foreign keys and checks under the migration's names", (table, name, columns, keys, checks) => {
    expect(getTableConfig(table).name).toBe(name);
    expect(getTableConfig(table).schema).toBe("dropship");
    expect(columnNames(table)).toEqual(columns);
    expect(foreignKeyNames(table)).toEqual([...keys]);
    expect(checkNames(table)).toEqual([...checks]);
    const create = statements.slice(statements.indexOf(`CREATE TABLE dropship.${name} (`));
    const body = create.slice(0, create.indexOf(";\n"));
    for (const column of columns) expect(body).toMatch(new RegExp(`\\n  ${column} `));
    for (const key of keys) expect(statements).toContain(`CONSTRAINT ${key} `);
    for (const check of checks) expect(statements).toMatch(new RegExp(`CONSTRAINT ${check}\\s+CHECK \\(`));
  });

  it("declares the indexes and the arrivals key under the migration's names", () => {
    expect(getTableConfig(dropshipVendorSelectedVariants).indexes.map((index) => index.config.name))
      .toEqual(["dropship_vendor_selected_variants_variant_idx"]);
    expect(getTableConfig(dropshipSelectionConversions).indexes.map((index) => index.config.name))
      .toEqual(["dropship_selection_conversions_open_idx"]);
    expect(getTableConfig(dropshipCatalogArrivals).indexes.map((index) => index.config.name))
      .toEqual(["dropship_catalog_arrivals_category_idx"]);
    expect(getTableConfig(dropshipCatalogArrivals).uniqueConstraints.map((key) => key.getName()))
      .toEqual(["dropship_catalog_arrivals_variant_category_key"]);
    for (const name of ["dropship_vendor_selected_variants_variant_idx", "dropship_selection_conversions_open_idx",
      "dropship_catalog_arrivals_category_idx"]) {
      expect(statements).toMatch(new RegExp(`CREATE INDEX ${name}\\s+ON `));
    }
    expect(statements).toContain("CONSTRAINT dropship_catalog_arrivals_variant_category_key UNIQUE (product_variant_id, category_id)");
    expect(statements).toContain("WHERE followup_state = 'pending' OR notice_state = 'pending';");
  });

  it("declares the three revision columns and their checks", () => {
    const revisions = getTableConfig(dropshipVendorSelectionRuleSetRevisions);
    const kind = revisions.columns.find((column) => column.name === "request_kind")!;
    expect(kind.notNull).toBe(true);
    expect(kind.default).toBe("rules_replace");
    expect(revisions.columns.find((column) => column.name === "pick_count")!.notNull).toBe(false);
    expect(revisions.columns.find((column) => column.name === "result")!.getSQLType()).toBe("jsonb");
    expect(revisions.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
      "dropship_selection_rule_rev_kind_chk", "dropship_selection_rule_rev_pick_count_chk"]));
    expect(statements).toContain("ADD COLUMN request_kind varchar(30) NOT NULL DEFAULT 'rules_replace'");
    expect(statements).toContain("CHECK (request_kind IN ('rules_replace', 'picks_change', 'picks_backfill', 'picks_conversion_followup'))");
    expect(statements).toContain("ADD COLUMN pick_count integer");
    expect(statements).toContain("CONSTRAINT dropship_selection_rule_rev_pick_count_chk CHECK (pick_count IS NULL OR pick_count >= 0)");
    expect(statements).toContain("ADD COLUMN result jsonb;");
    // rule_count stays NOT NULL (0091:8); the migration does not touch it.
    expect(revisions.columns.find((column) => column.name === "rule_count")!.notNull).toBe(true);
    expect(statements).not.toMatch(/ALTER COLUMN rule_count/);
  });
});
