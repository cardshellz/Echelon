import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/161_shipping_preload_cent_adjustment.sql"),
  "utf8",
);

describe("shipping preload cent adjustment migration", () => {
  it("targets only the named regional preload", () => {
    expect(migration).toContain("shopify-standard-regional-draft-2026-07-22-v1");
    expect(migration).toContain("rr.charge_model = 'fixed_band'");
  });

  it("subtracts one cent from executable fixed-band rows", () => {
    expect(migration).toContain("SET rate_cents = rr.rate_cents - 1");
  });

  it("subtracts one cent from saved editor prices", () => {
    expect(migration).toContain("(band_data.value ->> 'rateUsd')::numeric - 0.01");
    expect(migration).toContain("'{draftLayout,groups}'");
  });

  it("records an idempotency marker", () => {
    expect(migration).toContain("metadata ->> 'preloadPriceAdjustmentCents' IS NULL");
    expect(migration).toContain("'{preloadPriceAdjustmentCents}'");
    expect(migration).toContain("to_jsonb(-1)");
  });
});
