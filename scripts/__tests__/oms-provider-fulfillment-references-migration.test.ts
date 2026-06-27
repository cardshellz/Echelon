import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readMigration() {
  return fs.readFileSync(
    path.resolve(process.cwd(), "migrations/110_oms_provider_fulfillment_references.sql"),
    "utf8",
  );
}

function readReverseMigration() {
  return fs.readFileSync(
    path.resolve(process.cwd(), "migrations/reverse/110_oms_provider_fulfillment_references.sql"),
    "utf8",
  );
}

describe("OMS provider fulfillment references migration", () => {
  it("adds nullable provider-neutral fulfillment reference columns", () => {
    const sql = readMigration();

    expect(sql).toContain("ADD COLUMN IF NOT EXISTS fulfillment_provider varchar(40)");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS provider_fulfillment_order_id varchar(200)");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS provider_fulfillment_order_line_item_id varchar(200)");
  });

  it("backfills neutral references from Shopify compatibility columns without clobbering other providers", () => {
    const sql = readMigration();

    expect(sql).toContain("fulfillment_provider = COALESCE(fulfillment_provider, 'shopify')");
    expect(sql).toContain("provider_fulfillment_order_id = COALESCE(");
    expect(sql).toContain("shopify_fulfillment_order_id");
    expect(sql).toContain("provider_fulfillment_order_line_item_id = COALESCE(");
    expect(sql).toContain("shopify_fulfillment_order_line_item_id");
    expect(sql).toContain("fulfillment_provider IS NULL OR fulfillment_provider = 'shopify'");
  });

  it("indexes provider-scoped fulfillment lookups for later reader migration", () => {
    const sql = readMigration();

    expect(sql).toContain("idx_oms_lines_provider_fulfillment_order");
    expect(sql).toContain("ON oms.oms_order_lines (fulfillment_provider, provider_fulfillment_order_id)");
    expect(sql).toContain("idx_oms_lines_provider_fulfillment_line");
    expect(sql).toContain("ON oms.oms_order_lines (fulfillment_provider, provider_fulfillment_order_line_item_id)");
  });

  it("keeps the reverse migration explicit about neutral-column data loss", () => {
    const reverseSql = readReverseMigration();

    expect(reverseSql).toContain("DATA-LOSS WARNING");
    expect(reverseSql).toContain("DROP INDEX IF EXISTS oms.idx_oms_lines_provider_fulfillment_line");
    expect(reverseSql).toContain("DROP COLUMN IF EXISTS provider_fulfillment_order_line_item_id");
    expect(reverseSql).toContain("DROP COLUMN IF EXISTS provider_fulfillment_order_id");
    expect(reverseSql).toContain("DROP COLUMN IF EXISTS fulfillment_provider");
  });
});
