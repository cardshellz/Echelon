import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.resolve(process.cwd(), "migrations/209_recipe_mixed_supply_reservations.sql"),
  "utf8",
);

describe("recipe mixed-supply reservation migration", () => {
  it("deduplicates reserve commands per supply segment", () => {
    expect(migration).toContain("DROP INDEX IF EXISTS inventory.uq_inventory_transactions_reserve_dedup");
    expect(migration).toContain("COALESCE(reference_type, 'order')");
    expect(migration).toContain("COALESCE(reference_id, order_id::text)");
    expect(migration).toContain("transaction_type = 'reserve'");
    expect(migration).toContain("voided_at IS NULL");
  });
});
