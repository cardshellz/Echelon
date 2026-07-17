import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0590_shipping_service_level_pricing.sql"),
  "utf8",
);

describe("service-level pricing migration", () => {
  it("replaces carrier-owned rate identity with internal service levels", () => {
    expect(migration).toContain("DROP COLUMN carrier");
    expect(migration).toContain("DROP COLUMN service_code");
    expect(migration).toContain("service_level_id integer NOT NULL");
    expect(migration).toContain("shipping_rate_table_service_level_idx");
  });

  it("adds parcel and freight fulfillment abstractions", () => {
    expect(migration).toContain("fulfillment_mode IN ('parcel', 'freight')");
    expect(migration).toContain("pricing_basis IN ('shipment_weight', 'pallet_count')");
    expect(migration).toContain("'pallet_freight'");
    expect(migration).toContain("'Pallet Freight'");
  });

  it("enables only Standard Shipping for the initial rollout", () => {
    expect(migration).toContain("is_active = CASE WHEN code = 'standard' THEN TRUE ELSE FALSE END");
    expect(migration).toMatch(/'pallet_freight'[\s\S]*?FALSE[\s\S]*?'freight'/);
  });

  it("supports pallet-count bands with an optional shipment-weight ceiling", () => {
    expect(migration).toContain("RENAME COLUMN min_weight_grams TO min_measure");
    expect(migration).toContain("RENAME COLUMN max_weight_grams TO max_measure");
    expect(migration).toContain("max_shipment_weight_grams integer");
  });

  it("intentionally resets only unused shared rate data", () => {
    expect(migration).toContain(
      "TRUNCATE TABLE shipping.rate_table_rows, shipping.rate_tables RESTART IDENTITY",
    );
    expect(migration).not.toMatch(/(?:INSERT|UPDATE|DELETE|TRUNCATE)\s+(?:TABLE\s+|INTO\s+|FROM\s+)?dropship\./i);
  });
});
