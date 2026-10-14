import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LISTING_SETTING_REQUEST_OPERATIONS,
  type ListingSettingRequestOperation,
} from "../../../../../shared/dropship/listing-setting-values";

const MIGRATION_FILE = "0750_dropship_price_change_apply_ledger.sql";
const migrationSql = readFileSync(resolve(process.cwd(), "migrations", MIGRATION_FILE), "utf8");
const LEDGER_TABLE = "dropship.dropship_product_listing_setting_requests";
const REVIEWS_TABLE = "dropship.dropship_pricing_reviews";

// The operation CHECK lists these values, 0738's three and W7's apply; the
// shared contract must not drift from them. The tuple is checked both ways at
// compile time (`npm run check:tests`), and against the SQL and the
// contract's runtime value below.
const REQUEST_OPERATIONS = ["product_settings_bulk", "category_settings_clear", "category_moves_acknowledge", "price_change_apply"] as const;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const operationsMatchTheContract: Exact<typeof REQUEST_OPERATIONS[number], ListingSettingRequestOperation> = true;

const OPERATION_CHECK = "dropship_product_listing_setting_requests_operation_chk";
const REVIEW_CHECK = "dropship_product_listing_setting_requests_review_chk";
const REVIEW_FK = "dropship_product_listing_setting_requests_review_fk";
const REVIEW_INDEX = "dropship_product_listing_setting_requests_review_idx";

describe("0750 dropship price change apply ledger migration", () => {
  it("is the only migration with its number", () => {
    expect(operationsMatchTheContract).toBe(true);
    expect(readdirSync(resolve(process.cwd(), "migrations")).filter((file) => file.startsWith("0750_"))).toEqual([MIGRATION_FILE]);
  });

  it("is exactly: the review column, the widened operation CHECK, the pairing CHECK, the review foreign key and its partial unique index", () => {
    expect(statements()).toEqual([
      `ALTER TABLE ${LEDGER_TABLE} ADD COLUMN IF NOT EXISTS review_id uuid`,
      `ALTER TABLE ${LEDGER_TABLE} DROP CONSTRAINT IF EXISTS ${OPERATION_CHECK}`,
      `ALTER TABLE ${LEDGER_TABLE} ADD CONSTRAINT ${OPERATION_CHECK} `
        + `CHECK (operation IN (${REQUEST_OPERATIONS.map((operation) => `'${operation}'`).join(", ")}))`,
      `ALTER TABLE ${LEDGER_TABLE} DROP CONSTRAINT IF EXISTS ${REVIEW_CHECK}`,
      `ALTER TABLE ${LEDGER_TABLE} ADD CONSTRAINT ${REVIEW_CHECK} CHECK ((operation = 'price_change_apply') = (review_id IS NOT NULL))`,
      `ALTER TABLE ${LEDGER_TABLE} DROP CONSTRAINT IF EXISTS ${REVIEW_FK}`,
      `ALTER TABLE ${LEDGER_TABLE} ADD CONSTRAINT ${REVIEW_FK} FOREIGN KEY (review_id, vendor_id, store_connection_id) `
        + `REFERENCES ${REVIEWS_TABLE} (id, vendor_id, store_connection_id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ${REVIEW_INDEX} ON ${LEDGER_TABLE} (review_id) WHERE review_id IS NOT NULL`,
    ]);
  });

  it("lists the ledger's operations as the shared contract does, value for value and in order", () => {
    const values = /CHECK \(operation IN \(([^)]*)\)\)/.exec(statements().join("\n"))?.[1]?.split(",")
      .map((value) => value.trim().replace(/^'|'$/g, ""));
    expect(values).toEqual([...REQUEST_OPERATIONS]);
    expect([...LISTING_SETTING_REQUEST_OPERATIONS]).toEqual([...REQUEST_OPERATIONS]);
    // The pairing CHECK names the one operation that carries a review.
    expect(statements().join("\n")).toContain(`(operation = '${REQUEST_OPERATIONS[3]}') = (review_id IS NOT NULL)`);
  });

  it("drops each constraint if present right before it adds it, so the file re-runs over existing rows", () => {
    const all = statements();
    const added = all.flatMap((statement) => /ADD CONSTRAINT (\w+)/.exec(statement)?.[1] ?? []);
    expect(added).toEqual([OPERATION_CHECK, REVIEW_CHECK, REVIEW_FK]);
    for (const name of added) {
      const add = all.findIndex((statement) => statement.includes(`ADD CONSTRAINT ${name} `));
      expect(all[add - 1], name).toBe(`ALTER TABLE ${LEDGER_TABLE} DROP CONSTRAINT IF EXISTS ${name}`);
    }
    expect(all[0]).toMatch(/ADD COLUMN IF NOT EXISTS review_id uuid$/);
    expect(all.at(-1)).toMatch(/^CREATE UNIQUE INDEX IF NOT EXISTS /);
  });

  it("alters only the ledger, names the reviews table only as the foreign key's target, and writes no row", () => {
    const tables = withoutComments(migrationSql).match(/\b(dropship|catalog|public|membership|channels|ebay)\.\w+/g) ?? [];
    expect(new Set(tables)).toEqual(new Set([LEDGER_TABLE, REVIEWS_TABLE]));
    expect(statements().filter((statement) => statement.includes(REVIEWS_TABLE))).toEqual([statements()[6]]);
    for (const statement of statements()) {
      expect(statement).not.toMatch(/^(UPDATE|DELETE|INSERT|TRUNCATE|DROP|CREATE (TABLE|TRIGGER|FUNCTION|OR))\b/i);
      expect(statement).not.toMatch(/\b(ALTER COLUMN|DROP COLUMN|RENAME|TYPE|NOT VALID|CONCURRENTLY|ON DELETE|ON UPDATE)\b/i);
      expect(statement.startsWith(`ALTER TABLE ${LEDGER_TABLE} `) || statement.startsWith("CREATE UNIQUE INDEX IF NOT EXISTS "), statement)
        .toBe(true);
    }
    // The only column change adds the nullable review id: no default, no rewrite, null on every existing row.
    expect(statements().filter((statement) => /\bCOLUMN\b/i.test(statement))).toEqual([statements()[0]]);
  });

  it("names each object within PostgreSQL's 63 bytes, without digits", () => {
    const names = [OPERATION_CHECK, REVIEW_CHECK, REVIEW_FK, REVIEW_INDEX];
    expect(names.every((name) => migrationSql.includes(name))).toBe(true);
    for (const name of names) {
      expect(Buffer.byteLength(name), name).toBeLessThanOrEqual(63);
      // The listing-settings suites' isolation maps only [a-z_] object names.
      expect(name, name).toMatch(/^[a-z_]+$/);
    }
  });

  it("leaves the transaction to the release executor and says what changes for live data and which locks it takes", () => {
    expect(migrationSql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    const header = normalize(migrationSql.slice(0, migrationSql.indexOf("\nALTER TABLE")).replace(/^--\s?/gm, ""));
    expect(header).toContain("plan D5");
    expect(header).toContain("Nothing changes for live data: the new column is null on every existing row");
    expect(header).toContain("The ledger holds only W6 and W12 (and possibly W13) rows");
    expect(header).toContain("ACCESS EXCLUSIVE holds every listing-settings write, the replay probe included");
    expect(header).toContain("Locks: ALTER TABLE takes ACCESS EXCLUSIVE on the ledger until commit.");
    expect(header).toContain("The foreign key takes SHARE ROW EXCLUSIVE on the reviews table");
    expect(header).toContain("Row triggers do not fire for ALTER TABLE, so the ledger's append-only trigger needs no change.");
    expect(header).toContain("The release executor owns the transaction, including its migration record");
    expect(header).toContain("Re-runnable");
    // Suites that map object names into an isolated schema rewrite comments too.
    for (const comment of migrationSql.match(/--[^\n]*/g) ?? []) {
      expect(comment).not.toMatch(/\b(dropship|catalog|membership|channels|public|ebay)\.[a-z_]/);
    }
  });
});

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function statements(): string[] {
  return withoutComments(migrationSql)
    .split(/;\s*$/m)
    .map((statement) => normalize(statement))
    .filter((statement) => statement.length > 0);
}
