import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("cycle-count mill-cost ledger migration", () => {
  it("adds exact unit and extended mill-cost columns with nonnegative guards", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "migrations/0651_inventory_transaction_mill_costs.sql"),
      "utf8",
    );

    expect(migration).toContain("ADD COLUMN IF NOT EXISTS unit_cost_mills bigint");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS total_cost_mills bigint");
    expect(migration).toContain("inventory_transactions_unit_cost_mills_nonnegative");
    expect(migration).toContain("inventory_transactions_total_cost_mills_nonnegative");
  });
});
