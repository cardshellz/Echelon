import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION_SOURCE = readFileSync(
  resolve(
    __dirname,
    "../../../../../migrations/0589_outbound_shipment_item_purpose_authority.sql",
  ),
  "utf8",
).replace(/\r\n/g, "\n");

describe("outbound shipment item purpose authority migration", () => {
  it("replaces the obsolete all-lines-require-order-item constraint", () => {
    expect(MIGRATION_SOURCE).toContain(
      "DROP CONSTRAINT IF EXISTS wms_outbound_shipment_items_order_item_required_chk",
    );
    expect(MIGRATION_SOURCE).toContain(
      "ADD CONSTRAINT outbound_shipment_items_purpose_authority_chk",
    );
    expect(MIGRATION_SOURCE).toMatch(
      /shipment_item_purpose = 'customer_fulfillment'[\s\S]*order_item_id IS NOT NULL[\s\S]*replacement_for_order_item_id IS NULL/,
    );
    expect(MIGRATION_SOURCE).toMatch(
      /shipment_item_purpose = 'replacement'[\s\S]*order_item_id IS NULL[\s\S]*replacement_for_order_item_id IS NOT NULL/,
    );
    expect(MIGRATION_SOURCE).toMatch(
      /shipment_item_purpose = 'concession'[\s\S]*product_variant_id IS NOT NULL/,
    );
  });

  it("validates same-order lineage through the purpose-specific authority line", () => {
    expect(MIGRATION_SOURCE).toContain(
      "WHEN 'customer_fulfillment' THEN NEW.order_item_id",
    );
    expect(MIGRATION_SOURCE).toContain(
      "WHEN 'replacement' THEN NEW.replacement_for_order_item_id",
    );
    expect(MIGRATION_SOURCE).toContain(
      "WHERE order_item.id = authority_order_item_id",
    );
    expect(MIGRATION_SOURCE).toContain(
      "replacement_for_order_item_id,\n  shipment_item_purpose,\n  product_variant_id,",
    );
  });
});
