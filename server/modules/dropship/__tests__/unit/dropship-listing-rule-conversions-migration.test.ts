import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { dropshipListingRuleConversions } from "../../../../../shared/schema/dropship.schema";
import { MAX_NAMED_CATALOG_GROUP_ITEMS } from "../../../../../shared/dropship/catalog-scope";
import { MAX_EBAY_CATEGORY_RULES } from "../../../../../shared/dropship/ebay-category-rules";
import { contentProfileSchema } from "../../../../../shared/dropship/listing-content";
import {
  LISTING_RULE_CONVERSION_ACTOR_TYPES,
  MAX_CONVERSION_ACTOR_ID_LENGTH,
  MAX_CONVERSION_REMOVED_RULES,
  type ListingRuleConversionActorType,
} from "../../../../../shared/dropship/listing-rules-conversion";
import { LISTING_SETTING_KEY_PATTERN } from "../../../../../shared/dropship/listing-setting-values";
import { pricingProfileSchema } from "../../../../../shared/dropship/pricing-rules";
import { MAX_LISTING_SETTING_ACTOR_ID_LENGTH } from "../../infrastructure/dropship-listing-setting-shared.repository";
import { LISTING_RULE_CONVERSION_KEY_CONSTRAINT } from "../../infrastructure/dropship-listing-rule-conversions.writer";
import {
  LISTING_RULE_CONVERSIONS_MIGRATION_FILE,
  LISTING_RULE_CONVERSIONS_MIGRATION_SUFFIX,
} from "../fixtures/listing-rule-conversions-migration";

/**
 * The conversion record's migration (PR 11, plan section 12 and 7.A.3, the
 * 0750 pattern). The file is named through the fixture's one constant, never
 * by its number, which changes when the file is adopted under the real PR.
 */
const MIGRATION_FILE = LISTING_RULE_CONVERSIONS_MIGRATION_FILE;
const migrationSql = readFileSync(resolve(process.cwd(), "migrations", MIGRATION_FILE), "utf8");
const sidecar = JSON.parse(readFileSync(resolve(process.cwd(), "migrations", "metadata", `${MIGRATION_FILE}.json`), "utf8")) as Record<string, unknown>;

const TABLE = "dropship.dropship_listing_rule_conversions";
const STORES = "dropship.dropship_store_connections";
const GUARD_FUNCTION = "dropship.guard_listing_rule_conversion";
const GUARD_TRIGGER = "listing_rule_conversion_guard";
const STORE_INDEX = "dropship_listing_rule_conversion_store_idx";
const C = (purpose: string) => `dropship_listing_rule_conversion_${purpose}`;

// The actor CHECK lists these values; the shared contract must not drift from them. The
// tuple is checked both ways at compile time, and against the SQL and the contract below.
const ACTOR_TYPES = ["vendor", "system"] as const;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const actorTypesMatchTheContract: Exact<typeof ACTOR_TYPES[number], ListingRuleConversionActorType> = true;
const HASH = "'^[a-f0-9]{64}$'";

/** Plan 12's columns, in order: integer counts, no money column, no DEFAULT (the injected clock stamps the row). */
const COLUMNS = [
  "id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
  "vendor_id integer NOT NULL",
  "store_connection_id integer NOT NULL",
  "idempotency_key varchar(200) NOT NULL",
  "request_hash varchar(64) NOT NULL",
  "plan_hash varchar(64) NOT NULL",
  "writes_hash varchar(64) NOT NULL",
  "clean boolean NOT NULL",
  "changed_size_count integer NOT NULL",
  "category_count integer NOT NULL",
  "product_count integer NOT NULL",
  "pricing_groups_removed integer NOT NULL",
  "content_groups_removed integer NOT NULL",
  "ebay_rules_removed integer NOT NULL",
  "actor_type varchar(20) NOT NULL",
  "actor_id varchar(255) NOT NULL",
  "created_at timestamptz NOT NULL",
  "notice_seen_at timestamptz",
  "notice_seen_by varchar(255)",
] as const;

/** Every CHECK, by name, as PostgreSQL is given it (plan 12; D1 is `system_clean`). */
const CHECKS: ReadonlyArray<readonly [string, string]> = [
  [C("key_chk"), `idempotency_key ~ '${LISTING_SETTING_KEY_PATTERN.source}'`],
  [C("hash_chk"), `request_hash ~ ${HASH} AND plan_hash ~ ${HASH} AND writes_hash ~ ${HASH}`],
  [C("count_chk"), "changed_size_count BETWEEN 0 AND 10000 AND category_count BETWEEN 0 AND 10000 AND product_count BETWEEN 0 AND 10000"],
  [C("removed_chk"), "pricing_groups_removed BETWEEN 0 AND 100 AND content_groups_removed BETWEEN 0 AND 100 AND ebay_rules_removed BETWEEN 0 AND 100"],
  [C("actor_chk"), `actor_type IN (${ACTOR_TYPES.map((type) => `'${type}'`).join(", ")})`],
  [C("actor_id_chk"), "btrim(actor_id) <> ''"],
  [C("clean_chk"), "NOT clean OR changed_size_count = 0"],
  [C("system_clean_chk"), "actor_type <> 'system' OR (clean AND changed_size_count = 0)"],
  [C("notice_chk"), "(notice_seen_at IS NULL) = (notice_seen_by IS NULL) AND (notice_seen_by IS NULL OR btrim(notice_seen_by) <> '') "
    + "AND (actor_type = 'system' OR notice_seen_at IS NULL)"],
];

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS ${TABLE} (${[
  ...COLUMNS,
  `CONSTRAINT ${C("owner_fk")} FOREIGN KEY (store_connection_id, vendor_id) REFERENCES ${STORES}(id, vendor_id)`,
  `CONSTRAINT ${LISTING_RULE_CONVERSION_KEY_CONSTRAINT} UNIQUE (vendor_id, idempotency_key)`,
  ...CHECKS.map(([name, expression]) => `CONSTRAINT ${name} CHECK (${expression})`),
].join(", ")})`;

/** The guard (the 0739 marks guard is the precedent): every refusal is 23514, which the write wrapper maps to INVARIANT_FAILED. */
const GUARD_BODY = [
  "BEGIN",
  "IF TG_OP = 'DELETE' THEN",
  "RAISE EXCEPTION 'Listing rule conversions are kept; they cannot be deleted' USING ERRCODE = '23514';",
  "END IF;",
  "IF (to_jsonb(NEW) - 'notice_seen_at' - 'notice_seen_by') IS DISTINCT FROM (to_jsonb(OLD) - 'notice_seen_at' - 'notice_seen_by') THEN",
  "RAISE EXCEPTION 'A listing rule conversion cannot change; only its notice can be marked seen' USING ERRCODE = '23514';",
  "END IF;",
  "IF OLD.actor_type <> 'system' OR OLD.notice_seen_at IS NOT NULL OR OLD.notice_seen_by IS NOT NULL",
  "OR NEW.notice_seen_at IS NULL OR NEW.notice_seen_by IS NULL THEN",
  "RAISE EXCEPTION 'A system conversion''s notice is marked seen once, and nothing else changes' USING ERRCODE = '23514';",
  "END IF;",
  "RETURN NEW;",
  "END;",
].join(" ");

describe("the dropship listing rule conversions migration (PR 11, plan section 12)", () => {
  it("is the only migration with its name, allocated by the policy with a sidecar that names it", () => {
    expect(actorTypesMatchTheContract).toBe(true);
    const files = readdirSync(resolve(process.cwd(), "migrations"));
    expect(files.filter((file) => file.endsWith(LISTING_RULE_CONVERSIONS_MIGRATION_SUFFIX))).toEqual([MIGRATION_FILE]);
    // 9, eight digits of dependency generation, eight of PR number, four of ordinal (docs/migration-allocation.md).
    const prefix = /^9(\d{8})(\d{8})(\d{4})_dropship_listing_rule_conversions\.sql$/.exec(MIGRATION_FILE);
    expect(prefix).not.toBeNull();
    const [, generation, pr, ordinal] = prefix!;
    expect(files.filter((file) => file.startsWith(`9${generation}${pr}${ordinal}_`))).toEqual([MIGRATION_FILE]);
    expect(sidecar).toEqual({ version: 1, migration: MIGRATION_FILE, generation: Number(generation), pr: Number(pr),
      ordinal: Number(ordinal), after: expect.any(Array) });
    expect((sidecar.after as string[]).length).toBeGreaterThan(0);
    for (const dependency of sidecar.after as string[]) expect(existsSync(resolve(process.cwd(), "migrations", dependency)), dependency).toBe(true);
  });

  it("is exactly: the table, its store index, the guard function, and the guard trigger dropped if present and created again", () => {
    expect(statements()).toEqual([
      CREATE_TABLE,
      `CREATE INDEX IF NOT EXISTS ${STORE_INDEX} ON ${TABLE} (store_connection_id, id)`,
      `CREATE OR REPLACE FUNCTION ${GUARD_FUNCTION}() RETURNS trigger LANGUAGE plpgsql AS <<plpgsql body>>`,
      `DROP TRIGGER IF EXISTS ${GUARD_TRIGGER} ON ${TABLE}`,
      `CREATE TRIGGER ${GUARD_TRIGGER} BEFORE UPDATE OR DELETE ON ${TABLE} FOR EACH ROW EXECUTE FUNCTION ${GUARD_FUNCTION}()`,
    ]);
    expect(normalize(functionBody())).toBe(GUARD_BODY);
  });

  it("has plan 12's columns in order: integer counts only, no money or float column, no DEFAULT", () => {
    const body = createTableBody();
    const columns = body.split("\n").map((line) => line.trim().replace(/,$/, "")).filter((line) => /^[a-z_]+ [a-z]/.test(line));
    expect(columns).toEqual([...COLUMNS]);
    for (const column of columns) {
      expect(column, column).toMatch(/^[a-z_]+ (bigint|integer|boolean|varchar\(\d+\)|timestamptz)(\s|$)/);
    }
    expect(body).not.toMatch(/\b(numeric|decimal|real|double|money|float)\b|\bDEFAULT\b|\bcents\b/i);
  });

  it("holds the record's rules as CHECKs, and its one foreign key and one unique key", () => {
    expect([...checkBodies().entries()]).toEqual(CHECKS.map(([name, expression]) => [name, expression]));
    const body = normalize(createTableBody());
    expect([...body.matchAll(/FOREIGN KEY \(([^)]*)\) REFERENCES ([\w.]+)\(([^)]*)\)/g)].map((match) => match.slice(1)))
      .toEqual([["store_connection_id, vendor_id", STORES, "id, vendor_id"]]);
    expect(body).not.toMatch(/\bREFERENCES\b(?![^,]*dropship_store_connections)/);
    expect([...body.matchAll(/CONSTRAINT (\w+) UNIQUE \(([^)]*)\)/g)].map((match) => match.slice(1)))
      .toEqual([[LISTING_RULE_CONVERSION_KEY_CONSTRAINT, "vendor_id, idempotency_key"]]);
    expect(body).not.toMatch(/\bON (DELETE|UPDATE)\b/);
  });

  it("repeats the shared contracts' values: the key pattern, the actor types, the size and rule caps, the actor width", () => {
    expect([...LISTING_RULE_CONVERSION_ACTOR_TYPES]).toEqual([...ACTOR_TYPES]);
    expect(LISTING_SETTING_KEY_PATTERN.source).toBe("^[A-Za-z0-9:_-]{8,200}$");
    expect(MAX_NAMED_CATALOG_GROUP_ITEMS).toBe(10_000);
    // The removed counts are capped at what a profile can hold: 100 of each kind.
    expect(MAX_CONVERSION_REMOVED_RULES).toBe(100);
    expect(MAX_EBAY_CATEGORY_RULES).toBe(MAX_CONVERSION_REMOVED_RULES);
    const recipe = { basis: "product_cost", markupBps: 0, flatCents: 0, rounding: "cent" } as const;
    const pricingGroups = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `g${index}`, name: `Group ${index}`,
      priority: index + 1, scope: { type: "product", productId: index + 1 }, recipe }));
    expect(pricingProfileSchema.safeParse({ defaultRecipe: recipe, groups: pricingGroups(100) }).success).toBe(true);
    expect(pricingProfileSchema.safeParse({ defaultRecipe: recipe, groups: pricingGroups(101) }).success).toBe(false);
    const template = { introduction: "", footer: "" };
    const contentGroups = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `g${index}`, name: `Group ${index}`,
      priority: index + 1, scope: { type: "product", productId: index + 1 }, template }));
    expect(contentProfileSchema.safeParse({ defaultTemplate: template, groups: contentGroups(100) }).success).toBe(true);
    expect(contentProfileSchema.safeParse({ defaultTemplate: template, groups: contentGroups(101) }).success).toBe(false);
    expect(MAX_CONVERSION_ACTOR_ID_LENGTH).toBe(MAX_LISTING_SETTING_ACTOR_ID_LENGTH);
    expect(COLUMNS).toContain(`actor_id varchar(${MAX_CONVERSION_ACTOR_ID_LENGTH}) NOT NULL`);
    expect(COLUMNS).toContain(`notice_seen_by varchar(${MAX_CONVERSION_ACTOR_ID_LENGTH})`);
  });

  it("is re-runnable: every statement is guarded, and the trigger is dropped right before it is created", () => {
    const all = statements();
    expect(all[0]).toMatch(/^CREATE TABLE IF NOT EXISTS /);
    expect(all[1]).toMatch(/^CREATE INDEX IF NOT EXISTS /);
    expect(all[2]).toMatch(/^CREATE OR REPLACE FUNCTION /);
    expect(all[3]).toBe(`DROP TRIGGER IF EXISTS ${GUARD_TRIGGER} ON ${TABLE}`);
    expect(all[4]).toMatch(new RegExp(`^CREATE TRIGGER ${GUARD_TRIGGER} `));
  });

  it("creates only its own objects, names the store table only as the foreign key's target, and writes no row", () => {
    const names = withoutComments(migrationSql).match(/\b(dropship|catalog|public|membership|channels|ebay)\.\w+/g) ?? [];
    expect(new Set(names)).toEqual(new Set([TABLE, STORES, GUARD_FUNCTION]));
    expect(statements().filter((statement) => statement.includes(STORES))).toEqual([CREATE_TABLE]);
    for (const statement of statements()) {
      expect(statement).not.toMatch(/^(UPDATE|DELETE|INSERT|TRUNCATE|ALTER|COPY|GRANT|REVOKE)\b/i);
      expect(statement).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|SCHEMA|FUNCTION|CONSTRAINT)\b|\bCONCURRENTLY\b|\bNOT VALID\b/i);
    }
    // The guard only refuses: it reads nothing and writes nothing.
    expect(functionBody()).not.toMatch(/\b(INSERT INTO|DELETE FROM|SELECT|PERFORM|EXECUTE)\b|\bUPDATE\s+\w+\s+SET\b/i);
  });

  it("names each object within PostgreSQL's 63 bytes, without digits", () => {
    const names = [TABLE.split(".")[1]!, GUARD_FUNCTION.split(".")[1]!, GUARD_TRIGGER, STORE_INDEX,
      C("owner_fk"), LISTING_RULE_CONVERSION_KEY_CONSTRAINT, ...CHECKS.map(([name]) => name)];
    const declared = [...withoutComments(migrationSql).matchAll(/CONSTRAINT (\w+)/g)].map((match) => match[1]!);
    expect(declared).toEqual([C("owner_fk"), LISTING_RULE_CONVERSION_KEY_CONSTRAINT, ...CHECKS.map(([name]) => name)]);
    for (const name of names) {
      expect(migrationSql, name).toContain(name);
      expect(Buffer.byteLength(name), name).toBeLessThanOrEqual(63);
      // The listing-settings suites' isolation maps only [a-z_] object names.
      expect(name, name).toMatch(/^[a-z_]+$/);
    }
  });

  it("leaves the transaction to the release executor and says why, what changes for live data and which locks it takes", () => {
    expect(migrationSql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|SAVEPOINT)\s*;/im);
    for (const statement of statements()) expect(statement).not.toMatch(/^(BEGIN|COMMIT|ROLLBACK|START|END|SAVEPOINT)\b/i);
    const header = normalize(migrationSql.slice(0, migrationSql.indexOf("\nCREATE TABLE")).replace(/^--\s?/gm, ""));
    expect(header).toContain("The record of one move of a store's older group rules into category and product settings");
    expect(header).toContain("inserted first in the conversion's transaction, so its unique key claims the request key (plan D12)");
    expect(header).toContain("The database refuses what must never be recorded (plan D1): a system conversion that was not clean or changed a size.");
    expect(header).toContain("Every count is an integer");
    expect(header).toContain("there is no money column.");
    expect(header).toContain("a guard trigger refuses every DELETE and every UPDATE except notice_seen_at and notice_seen_by going "
      + "from null to values, once, on a system row.");
    expect(header).toContain("Nothing changes for live data: the table is new and starts empty, and no existing table is altered.");
    expect(header).toContain("Locks: the foreign key takes SHARE ROW EXCLUSIVE on the store connection table until commit.");
    expect(header).toContain("The executor's 15 s lock timeout bounds this file's wait for it, and the executor retries the file after it.");
    expect(header).toContain("No other table is referenced, so no other lock is taken.");
    expect(header).toContain("The release executor owns the transaction, including its migration record. Additive and re-runnable");
    // The 15 s the header cites is the executor's default.
    expect(readFileSync(resolve(process.cwd(), "migrations", "migration-executor.ts"), "utf8")).toContain("DEFAULT_LOCK_TIMEOUT_MS = 15_000;");
    // Suites that map object names into an isolated schema rewrite comments too.
    for (const comment of migrationSql.match(/--[^\n]*/g) ?? []) {
      expect(comment).not.toMatch(/\b(dropship|catalog|membership|channels|public|ebay)\.[a-z_]/);
    }
  });

  it("is declared in Drizzle under the same name, with the same columns, keys, CHECKs and index (a forced push keeps it)", () => {
    const config = getTableConfig(dropshipListingRuleConversions);
    expect(`${config.schema}.${config.name}`).toBe(TABLE);
    expect(config.columns.map((column) => `${column.name} ${column.getSQLType()}${column.notNull ? " NOT NULL" : ""}`)).toEqual(
      COLUMNS.map((definition) => definition.replace(" GENERATED ALWAYS AS IDENTITY PRIMARY KEY", " NOT NULL")
        .replace("timestamptz", "timestamp with time zone")));
    expect(config.columns.find((column) => column.name === "id")?.generatedIdentity?.type).toBe("always");
    expect(config.foreignKeys.map((key) => key.getName())).toEqual([C("owner_fk")]);
    expect(config.uniqueConstraints.map((unique) => [unique.name, unique.columns.map((column) => column.name)]))
      .toEqual([[LISTING_RULE_CONVERSION_KEY_CONSTRAINT, ["vendor_id", "idempotency_key"]]]);
    expect(config.checks.map((check) => check.name)).toEqual(CHECKS.map(([name]) => name));
    expect(config.indexes.map((index) => [index.config.name, index.config.columns.map((column) => (column as { name: string }).name)]))
      .toEqual([[STORE_INDEX, ["store_connection_id", "id"]]]);
  });
});

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
}

function withoutComments(sql: string): string {
  // No string literal in this file contains "--", so a line comment is everything after it.
  return sql.replace(/--[^\n]*/g, "");
}

function statements(): string[] {
  return withoutComments(migrationSql)
    .replace(/\$\$[\s\S]*?\$\$/g, () => "<<plpgsql body>>")
    .split(/;\s*$/m)
    .map((statement) => normalize(statement))
    .filter((statement) => statement.length > 0);
}

function functionBody(): string {
  const match = /CREATE OR REPLACE FUNCTION dropship\.guard_listing_rule_conversion\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$([\s\S]*?)\$\$/
    .exec(migrationSql);
  if (!match) throw new Error("guard function body not found");
  return withoutComments(match[1]!);
}

function createTableBody(): string {
  const match = /CREATE TABLE IF NOT EXISTS dropship\.dropship_listing_rule_conversions \(([\s\S]*?)\n\);/.exec(migrationSql);
  if (!match) throw new Error("CREATE TABLE not found");
  return withoutComments(match[1]!);
}

function checkBodies(): Map<string, string> {
  const body = normalize(createTableBody());
  const checks = new Map<string, string>();
  for (const match of body.matchAll(/CONSTRAINT (\w+) CHECK ?\(/g)) {
    let depth = 1;
    let index = match.index! + match[0].length;
    const start = index;
    while (depth > 0) {
      if (body[index] === "(") depth += 1;
      if (body[index] === ")") depth -= 1;
      index += 1;
    }
    checks.set(match[1]!, body.slice(start, index - 1).trim());
  }
  return checks;
}
