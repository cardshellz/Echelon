import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PgDropshipOpsSurfaceRepository } from "../../infrastructure/dropship-ops-surface.repository";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

const now = new Date("2026-05-03T15:00:00.000Z");

describe("PgDropshipOpsSurfaceRepository", () => {
  it("surfaces Stripe-ready wallet settings readiness", async () => {
    const query = vi.fn(async (sql: string) => {
      if (String(sql).includes("dropship.dropship_store_connections")) {
        return { rows: [] };
      }
      return {
        rows: [{
          id: 10,
          member_id: "member-1",
          business_name: "Vendor Test",
          email: "vendor@cardshellz.test",
          status: "active",
          entitlement_status: "active",
          included_store_connections: 1,
          available_balance_cents: "0",
          pending_balance_cents: "0",
          auto_reload_enabled: true,
          funding_method_count: "2",
          active_stripe_funding_method_count: "1",
          active_usdc_base_funding_method_count: "1",
          auto_reload_funding_method_ready: true,
          notification_preference_count: "0",
        }],
      };
    });
    const repository = new PgDropshipOpsSurfaceRepository({ query } as unknown as Pool);

    const result = await repository.getVendorSettingsOverview(10, now);

    expect(String(query.mock.calls[0]?.[0])).toContain("active_stripe_funding_method_count");
    expect(String(query.mock.calls[0]?.[0])).toContain("active_usdc_base_funding_method_count");
    expect(String(query.mock.calls[0]?.[0])).toContain("auto_reload_funding_method_ready");
    expect(result.wallet).toMatchObject({
      availableBalanceCents: 0,
      fundingMethodCount: 2,
      activeStripeFundingMethodCount: 1,
      activeUsdcBaseFundingMethodCount: 1,
      autoReloadEnabled: true,
      autoReloadFundingMethodReady: true,
    });
    expect(result.sections.find((section) => section.key === "wallet_payment")).toMatchObject({
      status: "ready",
      blockers: [],
    });
  });

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
    expect(String(query.mock.calls[0]?.[0])).toContain("c.shipping_config #>> '{dropship,role}'");
    expect(String(query.mock.calls[0]?.[0])).toContain("cc.metadata #>> '{features,dropshipOms}'");
    expect(String(query.mock.calls[0]?.[0])).toContain("active_usdc_base_funding_method_count");
    expect(result.total).toBe(1);
    expect(result.items[0]?.metrics).toMatchObject({
      dropshipOmsChannelId: 7,
      dropshipOmsChannelCount: 1,
      activeShippingBoxCount: 2,
      activeShippingZoneRuleCount: 1,
      activeShippingRateTableCount: 1,
      activeShippingRateRowCount: 4,
      selectedVariantCount: 3,
      selectedPackageProfileCount: 2,
      selectedVariantMissingPackageProfileCount: 1,
      activeShippingMarkupPolicyCount: 0,
      activeShippingInsurancePolicyCount: 0,
      activeStripeFundingMethodCount: 1,
      activeUsdcBaseFundingMethodCount: 1,
      autoReloadFundingMethodReady: true,
    });
    expect(result.items[0]?.readinessStatus).toBe("blocked");
    expect(result.items[0]?.checks.find((check) => check.key === "dropship_oms_channel")).toMatchObject({
      status: "ready",
      message: "Dropship OMS channel 7 is configured.",
    });
    expect(result.items[0]?.checks.find((check) => check.key === "package_profiles")).toMatchObject({
      status: "blocked",
      message: "1 of 3 selected variant(s) are missing active package profiles.",
    });
    expect(result.items[0]?.checks.find((check) => check.key === "shipping_rates")).toMatchObject({
      status: "ready",
    });
    expect(result.items[0]?.checks.find((check) => check.key === "shipping_markup_policy")).toMatchObject({
      status: "blocked",
      message: "No active shipping markup policy is configured; quotes cannot use implicit fee defaults.",
    });
    expect(result.items[0]?.checks.find((check) => check.key === "shipping_insurance_policy")).toMatchObject({
      status: "blocked",
      message: "No active insurance policy is configured; quotes cannot use implicit insurance-pool defaults.",
    });
  });

  it("blocks dogfood readiness when the Dropship OMS channel is missing or ambiguous", async () => {
    const query = vi.fn(async () => ({
      rows: [
        makeDogfoodReadinessRow({
          dropship_oms_channel_id_text: null,
          dropship_oms_channel_count: "0",
        }),
        makeDogfoodReadinessRow({
          vendor_id: 11,
          member_id: "member-2",
          dropship_oms_channel_id_text: "7",
          dropship_oms_channel_count: "2",
        }),
      ],
    }));
    const repository = new PgDropshipOpsSurfaceRepository({ query } as unknown as Pool);

    const result = await repository.listDogfoodReadiness({
      generatedAt: now,
      page: 1,
      limit: 50,
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.checks.find((check) => check.key === "dropship_oms_channel")).toMatchObject({
      status: "blocked",
      message: "No active Dropship OMS channel is marked in channel configuration.",
    });
    expect(result.items[1]?.checks.find((check) => check.key === "dropship_oms_channel")).toMatchObject({
      status: "blocked",
      message: "2 active Dropship OMS channels are marked; exactly one is required.",
    });
    expect(result.summary).toEqual([
      { status: "ready", count: 0 },
      { status: "warning", count: 0 },
      { status: "blocked", count: 2 },
    ]);
  });

  it("blocks dogfood readiness when launch wallet and auto-reload funding are not usable", async () => {
    const query = vi.fn(async () => ({
      rows: [makeDogfoodReadinessRow({
        available_balance_cents: "0",
        active_funding_method_count: "1",
        active_stripe_funding_method_count: "0",
        auto_reload_enabled: true,
        auto_reload_funding_method_ready: false,
      })],
    }));
    const repository = new PgDropshipOpsSurfaceRepository({ query } as unknown as Pool);

    const result = await repository.listDogfoodReadiness({
      generatedAt: now,
      page: 1,
      limit: 50,
    });

    expect(String(query.mock.calls[0]?.[0])).toContain("active_stripe_funding_method_count");
    expect(String(query.mock.calls[0]?.[0])).toContain("active_usdc_base_funding_method_count");
    expect(String(query.mock.calls[0]?.[0])).toContain("auto_reload_funding_method_ready");
    expect(result.items[0]?.readinessStatus).toBe("blocked");
    expect(result.items[0]?.metrics).toMatchObject({
      activeFundingMethodCount: 1,
      activeStripeFundingMethodCount: 0,
      activeUsdcBaseFundingMethodCount: 1,
      autoReloadEnabled: true,
      autoReloadFundingMethodReady: false,
    });
    expect(result.items[0]?.checks.find((check) => check.key === "wallet")).toMatchObject({
      status: "blocked",
      message: "Wallet has active funding method(s), but none are Stripe card/ACH methods ready for wallet funding.",
    });
    expect(result.items[0]?.checks.find((check) => check.key === "auto_reload")).toMatchObject({
      status: "blocked",
      message: "Auto reload is enabled, but no active Stripe card/ACH funding method with provider identity exists.",
    });
  });

  it("blocks dogfood readiness when USDC Base funding is not registered", async () => {
    const query = vi.fn(async () => ({
      rows: [makeDogfoodReadinessRow({
        active_usdc_base_funding_method_count: "0",
      })],
    }));
    const repository = new PgDropshipOpsSurfaceRepository({ query } as unknown as Pool);

    const result = await repository.listDogfoodReadiness({
      generatedAt: now,
      page: 1,
      limit: 50,
    });

    expect(result.items[0]?.readinessStatus).toBe("blocked");
    expect(result.items[0]?.metrics).toMatchObject({
      activeUsdcBaseFundingMethodCount: 0,
    });
    expect(result.items[0]?.checks.find((check) => check.key === "usdc_base_funding")).toMatchObject({
      status: "blocked",
      message: "No active USDC Base funding method with a wallet address is registered.",
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
    dropship_oms_channel_id_text: "7",
    dropship_oms_channel_count: "1",
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
    active_stripe_funding_method_count: "1",
    active_usdc_base_funding_method_count: "1",
    auto_reload_enabled: true,
    auto_reload_funding_method_ready: true,
    notification_preference_count: "1",
    ...overrides,
  };
}
