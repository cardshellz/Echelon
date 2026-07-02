import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BACKFILL_MIGRATION = readFileSync(
  resolve(
    __dirname,
    "../../../../../migrations/112_oms_provider_fulfillment_reference_backfill.sql",
  ),
  "utf8",
);
const REVERSE_BACKFILL_MIGRATION = readFileSync(
  resolve(
    __dirname,
    "../../../../../migrations/reverse/112_oms_provider_fulfillment_reference_backfill.sql",
  ),
  "utf8",
);

describe("OMS provider fulfillment reference backfill migration", () => {
  it("copies Shopify aliases into missing provider-neutral fields", () => {
    expect(BACKFILL_MIGRATION).toContain("UPDATE oms.oms_order_lines");
    expect(BACKFILL_MIGRATION).toContain("fulfillment_provider = 'shopify'");
    expect(BACKFILL_MIGRATION).toContain("provider_fulfillment_order_id = COALESCE");
    expect(BACKFILL_MIGRATION).toContain("NULLIF(BTRIM(shopify_fulfillment_order_id), '')");
    expect(BACKFILL_MIGRATION).toContain("provider_fulfillment_order_line_item_id = COALESCE");
    expect(BACKFILL_MIGRATION).toContain("NULLIF(BTRIM(shopify_fulfillment_order_line_item_id), '')");
  });

  it("does not overwrite non-Shopify provider rows", () => {
    expect(BACKFILL_MIGRATION).toContain(
      "COALESCE(LOWER(NULLIF(BTRIM(fulfillment_provider), '')), 'shopify') = 'shopify'",
    );
    expect(BACKFILL_MIGRATION).not.toContain("fulfillment_provider <> 'shopify'");
    expect(BACKFILL_MIGRATION).not.toContain("fulfillment_provider != 'shopify'");
  });

  it("keeps rollback data-safe", () => {
    expect(REVERSE_BACKFILL_MIGRATION).toContain("intentionally no-op");
    expect(REVERSE_BACKFILL_MIGRATION).not.toMatch(/\bUPDATE\b/i);
    expect(REVERSE_BACKFILL_MIGRATION).not.toMatch(/\bDELETE\b/i);
    expect(REVERSE_BACKFILL_MIGRATION).not.toMatch(/\bDROP\b/i);
  });
});
