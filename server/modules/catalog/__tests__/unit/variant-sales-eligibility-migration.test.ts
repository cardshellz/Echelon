import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0626_catalog_variant_sales_eligibility.sql"),
  "utf8",
).replace(/\s+/g, " ").toLowerCase();

describe("catalog variant sales eligibility migration", () => {
  it("adds a backward-compatible explicit customer sellability identity", () => {
    expect(migration).toContain(
      "add column if not exists sales_eligibility varchar(20) not null default 'sellable'",
    );
    expect(migration).toContain(
      "check (sales_eligibility in ('sellable', 'internal_only'))",
    );
    expect(migration).toContain("product_variants_internal_only_identity_chk");
    expect(migration).toContain("shopify_variant_id is null");
    expect(migration).toContain("coalesce(dropship_eligible, false) = false");
  });

  it("serializes and rejects customer-facing writes for internal-only variants", () => {
    expect(migration).toContain("pg_advisory_xact_lock(918424, variant_id)");
    expect(migration).toContain("customer_sellable_variant_required");
    for (const trigger of [
      "channel_feeds_require_sellable_variant",
      "channel_listings_require_sellable_variant",
      "channel_reservations_require_sellable_variant",
      "channel_variant_overrides_require_sellable_variant",
      "channel_allocation_rules_require_sellable_variant",
      "dropship_vendor_listings_require_sellable_variant",
      "dropship_variant_overrides_require_sellable_variant",
      "marketplace_publication_members_require_sellable_variant",
      "inventory_publication_outbox_require_sellable_variant",
      "channel_variant_availability_require_sellable_reactivation",
      "oms_order_lines_require_sellable_variant",
      "oms_orders_require_sellable_variants_on_reopen",
    ]) {
      expect(migration).toContain(trigger);
    }
  });

  it("blocks a transition while external exposure or publication work remains", () => {
    expect(migration).toContain("product_variants_guard_internal_only_transition");
    expect(migration).toContain("internal_only_variant_has_customer_exposure");
    expect(migration).toContain("marketplace.listing_publication_members");
    expect(migration).toContain("inventory.inventory_publication_outbox");
    expect(migration).toContain("channels.channel_variant_availability_sync");
    expect(migration).toContain("from wms.order_items oi");
    expect(migration).toContain(
      "o.warehouse_status not in ('shipped', 'completed', 'cancelled', 'voided')",
    );
    expect(migration).toContain("from oms.oms_order_lines ol");
    expect(migration).toContain(
      "o.status not in ('shipped', 'delivered', 'cancelled', 'refunded')",
    );
    expect(migration).toContain("customer_sellable_order_line_required");
  });
});
