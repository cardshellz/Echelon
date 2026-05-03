import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PgDropshipOpsSurfaceRepository } from "../../infrastructure/dropship-ops-surface.repository";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

const now = new Date("2026-05-03T15:00:00.000Z");

describe("PgDropshipOpsSurfaceRepository", () => {
  it("surfaces shipping setup gaps in dogfood readiness", async () => {
    const query = vi.fn(async () => ({
      rows: [makeDogfoodReadinessRow({
        selected_variant_count: "3",
        selected_package_profile_count: "2",
        selected_variant_missing_package_profile_count: "1",
        active_shipping_markup_policy_count: "0",
        active_shipping_insurance_policy_count: "0",
      })],
    }));
    const repository = new PgDropshipOpsSurfaceRepository({ query } as unknown as Pool);

    const result = await repository.listDogfoodReadiness({
      generatedAt: now,
      page: 1,
      limit: 50,
    });

    expect(String(query.mock.calls[0]?.[0])).toContain("dropship.dropship_package_profiles");
    expect(String(query.mock.calls[0]?.[0])).toContain("dropship.dropship_rate_table_rows");
    expect(String(query.mock.calls[0]?.[0])).toContain("zr_rate.zone = rr.destination_zone");
    expect(result.total).toBe(1);
    expect(result.items[0]?.metrics).toMatchObject({
      activeShippingBoxCount: 2,
      activeShippingZoneRuleCount: 1,
      activeShippingRateTableCount: 1,
      activeShippingRateRowCount: 4,
      selectedVariantCount: 3,
      selectedPackageProfileCount: 2,
      selectedVariantMissingPackageProfileCount: 1,
      activeShippingMarkupPolicyCount: 0,
      activeShippingInsurancePolicyCount: 0,
    });
    expect(result.items[0]?.readinessStatus).toBe("blocked");
    expect(result.items[0]?.checks.find((check) => check.key === "package_profiles")).toMatchObject({
      status: "blocked",
      message: "1 of 3 selected variant(s) are missing active package profiles.",
    });
    expect(result.items[0]?.checks.find((check) => check.key === "shipping_rates")).toMatchObject({
      status: "ready",
    });
    expect(result.items[0]?.checks.find((check) => check.key === "shipping_markup_policy")).toMatchObject({
      status: "warning",
    });
    expect(result.items[0]?.checks.find((check) => check.key === "shipping_insurance_policy")).toMatchObject({
      status: "warning",
    });
  });
});

function makeDogfoodReadinessRow(overrides: Record<string, unknown> = {}) {
  return {
    vendor_id: 10,
    member_id: "member-1",
    business_name: "Vendor Test",
    email: "vendor@cardshellz.test",
    vendor_status: "active",
    entitlement_status: "active",
    store_connection_id: 20,
    platform: "ebay",
    store_status: "connected",
    setup_status: "ready",
    external_display_name: "Vendor eBay",
    shop_domain: null,
    access_token_ref: "secret-ref",
    updated_at: now,
    default_warehouse_id_text: "1",
    listing_config_id: 30,
    listing_config_platform: "ebay",
    listing_config_active: true,
    admin_catalog_include_rule_count: "1",
    vendor_selection_include_rule_count: "1",
    active_shipping_box_count: "2",
    active_shipping_zone_rule_count: "1",
    active_shipping_rate_table_count: "1",
    active_shipping_rate_row_count: "4",
    selected_variant_count: "3",
    selected_package_profile_count: "3",
    selected_variant_missing_package_profile_count: "0",
    active_shipping_markup_policy_count: "1",
    active_shipping_insurance_policy_count: "1",
    setup_open_blocker_count: "0",
    setup_check_open_blocker_count: "0",
    wallet_status: "active",
    available_balance_cents: "1000",
    active_funding_method_count: "1",
    auto_reload_enabled: true,
    notification_preference_count: "1",
    ...overrides,
  };
}
