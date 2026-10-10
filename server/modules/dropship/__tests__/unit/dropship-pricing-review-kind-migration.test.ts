import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PRICING_REVIEW_KINDS as SHARED_PRICING_REVIEW_KINDS, type PricingReviewKind } from "../../../../../shared/dropship/pricing-rules";

const MIGRATION_FILE = "0738_dropship_pricing_review_kind.sql";
const migrationSql = readFileSync(resolve(process.cwd(), "migrations", MIGRATION_FILE), "utf8");
const REVIEWS_TABLE = "dropship.dropship_pricing_reviews";

// The kind CHECK lists these values; the shared pricing contract must not
// drift from them. The tuple is checked both ways at compile time (`npm run
// check:tests`), and against the SQL and the contract's runtime value below.
const PRICING_REVIEW_KINDS = ["store_default", "category_price", "product_prices"] as const;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const kindsMatchTheContract: Exact<typeof PRICING_REVIEW_KINDS[number], PricingReviewKind> = true;

describe("0738 dropship pricing review kind migration", () => {
  it("is the only migration with its number", () => {
    expect(readdirSync(resolve(process.cwd(), "migrations")).filter((file) => file.startsWith("0738_"))).toEqual([MIGRATION_FILE]);
  });

  it("is exactly: add the kind column with its default, then drop and add its CHECK", () => {
    expect(statements()).toEqual([
      `ALTER TABLE ${REVIEWS_TABLE} ADD COLUMN IF NOT EXISTS kind varchar(30) NOT NULL DEFAULT 'store_default'`,
      `ALTER TABLE ${REVIEWS_TABLE} DROP CONSTRAINT IF EXISTS dropship_pricing_review_kind_chk`,
      `ALTER TABLE ${REVIEWS_TABLE} ADD CONSTRAINT dropship_pricing_review_kind_chk `
        + `CHECK (kind IN (${PRICING_REVIEW_KINDS.map((kind) => `'${kind}'`).join(", ")}))`,
    ]);
  });

  it("lists the review kinds, store_default first as the default every existing row takes", () => {
    const values = /CHECK \(kind IN \(([^)]*)\)\)/.exec(statements().join("\n"))?.[1]?.split(",").map((value) => value.trim().replace(/^'|'$/g, ""));
    expect(values).toEqual([...PRICING_REVIEW_KINDS]);
    expect([...SHARED_PRICING_REVIEW_KINDS]).toEqual([...PRICING_REVIEW_KINDS]);
    expect(statements()[0]).toContain(`DEFAULT '${PRICING_REVIEW_KINDS[0]}'`);
  });

  it("touches only the reviews table and changes no column but the one it adds", () => {
    const tables = withoutComments(migrationSql).match(/\b(dropship|catalog|public)\.\w+/g) ?? [];
    expect(new Set(tables)).toEqual(new Set([REVIEWS_TABLE]));
    for (const statement of statements()) {
      expect(statement).not.toMatch(/^(UPDATE|DELETE|INSERT|TRUNCATE|CREATE|DROP)\b/i);
      expect(statement).not.toMatch(/\b(ALTER COLUMN|DROP COLUMN|RENAME|TYPE)\b/i);
    }
    // The only column change is ADD COLUMN IF NOT EXISTS ... NOT NULL DEFAULT: old rows read as store_default, nothing is rewritten.
    expect(statements().filter((statement) => /\bCOLUMN\b/i.test(statement))).toEqual([statements()[0]]);
  });

  it("is re-runnable: the column is added if missing, and the CHECK is dropped if present before it is added", () => {
    const [add, drop, check] = statements();
    expect(add).toMatch(/ADD COLUMN IF NOT EXISTS kind\b/);
    expect(drop).toMatch(/DROP CONSTRAINT IF EXISTS dropship_pricing_review_kind_chk$/);
    expect(check).toMatch(/^ALTER TABLE [\w.]+ ADD CONSTRAINT dropship_pricing_review_kind_chk\b/);
  });

  it("leaves the transaction to the release executor and says what changes for live data", () => {
    expect(migrationSql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    const header = normalize(migrationSql.slice(0, migrationSql.indexOf("\nALTER TABLE")).replace(/^--\s?/gm, ""));
    expect(header).toContain("Nothing changes for live data. Every existing review reads as store_default");
    expect(header).toContain("Row triggers do not fire for ALTER TABLE, so the review immutability trigger (0659) needs no change.");
    expect(header).toContain("Lock: ALTER TABLE takes ACCESS EXCLUSIVE on the reviews table until commit");
    expect(header).toContain("The release executor owns the transaction, including its migration record.");
    // Suites that map object names into an isolated schema rewrite comments too.
    for (const comment of migrationSql.match(/--[^\n]*/g) ?? []) {
      expect(comment).not.toMatch(/\b(dropship|catalog|membership|channels|public|ebay)\.[a-z_]/);
    }
  });

  it("ships with the store default loader that reads only store_default reviews", () => {
    const repository = readFileSync(
      resolve(process.cwd(), "server/modules/dropship/infrastructure/dropship-pricing-rules.repository.ts"),
      "utf8",
    );
    expect(normalize(repository)).toContain(
      "FROM dropship.dropship_pricing_reviews WHERE id = $1 AND vendor_id = $2 AND store_connection_id = $3 AND kind = 'store_default'",
    );
    // The review INSERT names no kind, exactly as code deployed before this file does: the default fills it.
    const insert = /INSERT INTO dropship\.dropship_pricing_reviews\s*\(([^)]*)\)/.exec(repository)?.[1];
    expect(insert && normalize(insert)).toBe("id, vendor_id, store_connection_id, input, rows, review_hash, actor_id, created_at");
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
