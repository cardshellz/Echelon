import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION_SOURCE = readFileSync(
  resolve(
    __dirname,
    "../../../../../migrations/0589_outbound_shipment_item_purpose_authority.sql",
  ),
  "utf8",
);

const PURPOSE_CONSTRAINT_REPAIR_SOURCE = readFileSync(
  resolve(
    __dirname,
    "../../../../../migrations/0608_expand_outbound_shipment_item_purpose_constraint.sql",
  ),
  "utf8",
);

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
    expect(MIGRATION_SOURCE).toMatch(
      /replacement_for_order_item_id,\r?\n\s+shipment_item_purpose,\r?\n\s+product_variant_id,/,
    );
  });

  it("keeps the coarse purpose constraint aligned with omission correction authority", () => {
    expect(PURPOSE_CONSTRAINT_REPAIR_SOURCE).toContain(
      "DROP CONSTRAINT IF EXISTS outbound_shipment_items_purpose_chk",
    );
    expect(PURPOSE_CONSTRAINT_REPAIR_SOURCE).toMatch(
      /ADD CONSTRAINT outbound_shipment_items_purpose_chk[\s\S]*'customer_fulfillment'[\s\S]*'replacement'[\s\S]*'concession'[\s\S]*'omission_correction'[\s\S]*'unclassified'/,
    );
    expect(PURPOSE_CONSTRAINT_REPAIR_SOURCE).toContain(
      "VALIDATE CONSTRAINT outbound_shipment_items_purpose_chk",
    );
  });
});
