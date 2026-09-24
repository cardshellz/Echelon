import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(resolve(process.cwd(), "migrations/0689_dropship_wallet_funding_reversal.sql"), "utf8");
const schema = readFileSync(resolve(process.cwd(), "shared/schema/dropship.schema.ts"), "utf8");

/** Every ledger kind after 0689, in constraint order: the two new kinds are appended, nothing is dropped. */
const LEDGER_KINDS = [
  "funding", "order_debit", "refund_credit", "return_credit", "return_fee",
  "insurance_pool_credit", "manual_adjustment", "advance_fee", "funding_reversal", "funding_reinstated",
];

describe("0689 dropship wallet funding reversal migration", () => {
  it("adds the reversal and reinstatement ledger kinds without dropping any existing kind", () => {
    expect(migrationSql).toContain("DROP CONSTRAINT IF EXISTS dropship_wallet_ledger_type_chk");
    expect(migrationSql).toContain("ADD CONSTRAINT dropship_wallet_ledger_type_chk");
    for (const kind of LEDGER_KINDS) {
      expect(migrationSql).toContain(`'${kind}'`);
    }
  });

  it("keeps the Drizzle declaration in step with the constraint", () => {
    expect(schema).toContain('"funding_reversal"');
    expect(schema).toContain('"funding_reinstated"');
    // Later migrations append kinds after these (0702 adds the rewards kinds), so the
    // 0689 list is pinned as a prefix of the declaration, not the whole of it.
    expect(schema).toContain(`IN (${LEDGER_KINDS.map((kind) => `'${kind}'`).join(",")}`);
  });

  it("changes only the ledger kinds: no new tables, no balance rewrite, no lower bound on balances", () => {
    expect(migrationSql).not.toMatch(/CREATE TABLE/i);
    expect(migrationSql).not.toMatch(/UPDATE\s+dropship\./i);
    expect(migrationSql).not.toMatch(/available_balance_cents\s*>=\s*0/);
  });
});
