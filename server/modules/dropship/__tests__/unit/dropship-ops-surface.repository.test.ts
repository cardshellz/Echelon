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

  it("maps vendor settings store credential readiness", async () => {
    const query = vi.fn(async (sql: string) => {
      if (String(sql).includes("dropship.dropship_store_connections")) {
        return {
          rows: [{
            id: 20,
            platform: "ebay",
            status: "connected",
            setup_status: "ready",
            external_display_name: "Vendor eBay",
            shop_domain: null,
            access_token_ref: "access-ref",
            refresh_token_ref: null,
            updated_at: now,
          }],
        };
      }
      return {
        rows: [makeVendorSettingsRow()],
      };
    });
    const repository = new PgDropshipOpsSurfaceRepository({ query } as unknown as Pool);

    const result = await repository.getVendorSettingsOverview(10, now);

    const storeQuery = query.mock.calls
      .map((call) => String(call[0]))
      .find((sql) => sql.includes("dropship.dropship_store_connections"));
    expect(storeQuery).toContain("access_token_ref");
    expect(storeQuery).toContain("refresh_token_ref");
    expect(result.storeConnections[0]).toMatchObject({
      platform: "ebay",
      hasAccessToken: true,
      hasRefreshToken: false,
      launchReady: false,
    });
    expect(result.sections.find((section) => section.key === "store_connection")).toMatchObject({
      status: "attention_required",
      blockers: ["store_refresh_token_required"],
    });
  });

  it("surfaces marketplace cancellation failures in the admin ops overview", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes("cancellation_status AS key")) {
        expect(text).toContain("cancellation_status IS NOT NULL");
        expect(params).toEqual([10]);
        return {
          rows: [
            { key: "marketplace_cancellation_failed", count: "2" },
            { key: "marketplace_cancelled", count: "1" },
          ],
        };
      }
      if (text.includes("dropship.dropship_marketplace_tracking_pushes")) {
        return { rows: [{ key: "failed", count: "1" }] };
      }
      if (text.includes("oms.webhook_retry_queue")) {
        expect(text).toContain("q.topic = 'oms_wms_sync'");
        expect(text).toContain("q.provider = 'internal'");
        expect(text).toContain("q.payload->>'omsOrderId'");
        expect(text).toContain("dropship.dropship_order_intake oi");
        expect(text).toContain("oi.oms_order_id::text = q.payload->>'omsOrderId'");
        expect(text).not.toContain("(q.payload->>'omsOrderId')::bigint");
        expect(text).toContain("oi.vendor_id = $1");
        expect(params).toEqual([10]);
        return {
          rows: [
            { key: "dead", count: "1" },
            { key: "pending", count: "2" },
          ],
        };
      }
      return { rows: [] };
    });
    const repository = new PgDropshipOpsSurfaceRepository({ query } as unknown as Pool);

    const result = await repository.getAdminOpsOverview({
      generatedAt: now,
      vendorId: 10,
    });

    expect(result.orderCancellationStatusCounts).toEqual([
      { key: "marketplace_cancellation_failed", count: 2 },
      { key: "marketplace_cancelled", count: 1 },
    ]);
    expect(result.riskBuckets.find((bucket) => bucket.key === "marketplace_cancellation_failures")).toMatchObject({
      count: 2,
      severity: "error",
    });
    expect(result.riskBuckets.find((bucket) => bucket.key === "tracking_push_failures")).toMatchObject({
      count: 1,
      severity: "error",
    });
    expect(result.wmsSyncRetryStatusCounts).toEqual([
      { key: "dead", count: 1 },
      { key: "pending", count: 2 },
    ]);
    expect(result.riskBuckets.find((bucket) => bucket.key === "wms_sync_retries_pending")).toMatchObject({
      count: 2,
      severity: "warning",
    });
    expect(result.riskBuckets.find((bucket) => bucket.key === "wms_sync_retries_dead")).toMatchObject({
      count: 1,
      severity: "error",
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
        active_return_policy_count: "0",
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
    expect(String(query.mock.calls[0]?.[0])).toContain("dropship.dropship_return_policy_config");
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
      activeReturnPolicyCount: 0,
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
    expect(result.items[0]?.checks.find((check) => check.key === "return_policy")).toMatchObject({
      status: "blocked",
      message: "No active return policy is configured; RMA windows cannot use implicit defaults.",
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

  it("keeps global dogfood readiness rows available for launch gate evaluation while filtering visible rows", async () => {
    const query = vi.fn(async (_sql: string, params?: unknown[]) => ({
      rows: params?.includes("ebay")
        ? [makeDogfoodReadinessRow({ vendor_id: 10, member_id: "member-1", platform: "ebay" })]
        : [
            makeDogfoodReadinessRow({ vendor_id: 10, member_id: "member-1", platform: "ebay" }),
            makeDogfoodReadinessRow({ vendor_id: 11, member_id: "member-2", platform: "shopify", listing_config_platform: "shopify", refresh_token_ref: null }),
          ],
    }));
    const repository = new PgDropshipOpsSurfaceRepository({ query } as unknown as Pool);

    const result = await repository.listDogfoodReadiness({
      generatedAt: now,
      platform: "ebay",
      page: 1,
      limit: 1,
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(1);
    expect(result.launchGateItems).toHaveLength(2);
    expect(result.total).toBe(1);
  });

  it("excludes disconnected historical store connections from dogfood readiness rows", async () => {
    const query = vi.fn(async () => ({
      rows: [makeDogfoodReadinessRow()],
    }));
    const repository = new PgDropshipOpsSurfaceRepository({ query } as unknown as Pool);

    await repository.listDogfoodReadiness({
      generatedAt: now,
      page: 1,
      limit: 50,
    });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("LEFT JOIN dropship.dropship_store_connections sc ON sc.vendor_id = v.id");
    expect(sql).toContain("AND sc.status IN ('connected', 'needs_reauth', 'refresh_failed', 'grace_period', 'paused')");
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

  it("marks dogfood notification readiness ready with launch defaults and no vendor overrides", async () => {
    const query = vi.fn(async () => ({
      rows: [makeDogfoodReadinessRow({
        notification_preference_count: "0",
      })],
    }));
    const repository = new PgDropshipOpsSurfaceRepository({ query } as unknown as Pool);

    const result = await repository.listDogfoodReadiness({
      generatedAt: now,
      page: 1,
      limit: 50,
    });

    expect(result.items[0]?.readinessStatus).toBe("ready");
    expect(result.items[0]?.checks.find((check) => check.key === "notifications")).toMatchObject({
      status: "ready",
      message: expect.stringContaining("launch default notification preference(s) available; 0 vendor override(s) configured."),
    });
  });

  it("blocks eBay dogfood readiness when the store refresh token reference is missing", async () => {
    const query = vi.fn(async () => ({
      rows: [makeDogfoodReadinessRow({
        platform: "ebay",
        refresh_token_ref: null,
      })],
    }));
    const repository = new PgDropshipOpsSurfaceRepository({ query } as unknown as Pool);

    const result = await repository.listDogfoodReadiness({
      generatedAt: now,
      page: 1,
      limit: 50,
    });

    expect(String(query.mock.calls[0]?.[0])).toContain("sc.refresh_token_ref");
    expect(result.items[0]?.readinessStatus).toBe("blocked");
    expect(result.items[0]?.checks.find((check) => check.key === "store_connection")).toMatchObject({
      status: "blocked",
      message: "Store is connected; access token reference present; eBay refresh token reference missing.",
    });
  });

  it("keeps Shopify dogfood readiness ready without a refresh token reference", async () => {
    const query = vi.fn(async () => ({
      rows: [makeDogfoodReadinessRow({
        platform: "shopify",
        listing_config_platform: "shopify",
        refresh_token_ref: null,
        token_expires_at: null,
      })],
    }));
    const repository = new PgDropshipOpsSurfaceRepository({ query } as unknown as Pool);

    const result = await repository.listDogfoodReadiness({
      generatedAt: now,
      page: 1,
      limit: 50,
    });

    expect(result.items[0]?.readinessStatus).toBe("ready");
    expect(result.items[0]?.checks.find((check) => check.key === "store_connection")).toMatchObject({
      status: "ready",
      message: "Store connection is launch-ready with an access token reference.",
    });
  });

  it("maps dogfood smoke evidence across listing, intake, shipment, and tracking handoffs", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(String(sql)).toContain("dropship.dropship_vendor_listings");
      expect(String(sql)).toContain("dropship.dropship_listing_push_jobs");
      expect(String(sql)).toContain("dropship.dropship_order_intake");
      expect(String(sql)).toContain("wms.outbound_shipments");
      expect(String(sql)).toContain("dropship.dropship_marketplace_tracking_pushes");
      expect(params).toEqual([10, "ebay", 5]);
      return {
        rows: [makeDogfoodSmokeRow({
          latest_tracking_push_status: "succeeded",
          latest_tracking_push_external_fulfillment_id: "fulfillment-1",
        })],
      };
    });
    const repository = new PgDropshipOpsSurfaceRepository({ query } as unknown as Pool);

    const result = await repository.listDogfoodSmokeCandidates({
      generatedAt: now,
      vendorId: 10,
      platform: "ebay",
      limit: 5,
    });

    expect(result).toMatchObject({
      total: 1,
      readyCandidateCount: 1,
      warningCandidateCount: 0,
      blockedCandidateCount: 0,
      message: "Loaded 1 store with full smoke evidence; 0 blocked and 0 incomplete.",
    });
    expect(result.candidates[0]).toMatchObject({
      status: "ready",
      references: {
        latestListingId: 30,
        latestListingJobId: 40,
        latestIntakeId: 50,
        latestOmsOrderId: 60,
        latestWmsShipmentId: 70,
        latestTrackingPushId: 80,
      },
    });
    expect(result.candidates[0]?.stages.map((stage) => [stage.key, stage.status])).toEqual([
      ["listing", "ready"],
      ["order_intake", "ready"],
      ["fulfillment", "ready"],
      ["tracking", "ready"],
    ]);
  });

  it("warns when complete dogfood smoke evidence is older than the configured freshness window", async () => {
    const staleAt = new Date("2026-04-30T15:00:00.000Z");
    const query = vi.fn(async () => ({
      rows: [makeDogfoodSmokeRow({
        latest_listing_pushed_at: staleAt,
        latest_listing_updated_at: staleAt,
        latest_listing_job_completed_at: staleAt,
        latest_listing_job_updated_at: staleAt,
        latest_intake_received_at: staleAt,
        latest_intake_accepted_at: staleAt,
        latest_intake_updated_at: staleAt,
        latest_shipment_shipped_at: staleAt,
        latest_shipment_updated_at: staleAt,
        latest_tracking_push_completed_at: staleAt,
        latest_tracking_push_updated_at: staleAt,
      })],
    }));
    const repository = new PgDropshipOpsSurfaceRepository({ query } as unknown as Pool);

    const result = await repository.listDogfoodSmokeCandidates({
      generatedAt: now,
      staleAfterHours: 24,
      limit: 10,
    });

    expect(result).toMatchObject({
      staleAfterHours: 24,
      readyCandidateCount: 0,
      warningCandidateCount: 1,
      blockedCandidateCount: 0,
      message: "Loaded 1 store waiting on smoke evidence.",
    });
    expect(result.candidates[0]?.status).toBe("warning");
    expect(result.candidates[0]?.stages.every((stage) => stage.status === "warning")).toBe(true);
    expect(result.candidates[0]?.stages[0]).toMatchObject({
      freshness: {
        status: "stale",
        staleAfterHours: 24,
      },
      message: "Listing push evidence is older than 24 hour(s); rerun this smoke step before dogfood.",
      evidence: expect.arrayContaining([
        "Freshness threshold: 24 hour(s); latest evidence 2026-04-30T15:00:00.000Z.",
      ]),
    });
  });

  it("blocks dogfood smoke when a shipped WMS shipment has no marketplace tracking push", async () => {
    const query = vi.fn(async () => ({
      rows: [makeDogfoodSmokeRow({
        latest_tracking_push_id: null,
        latest_tracking_push_status: null,
        latest_tracking_push_external_fulfillment_id: null,
      })],
    }));
    const repository = new PgDropshipOpsSurfaceRepository({ query } as unknown as Pool);

    const result = await repository.listDogfoodSmokeCandidates({
      generatedAt: now,
      limit: 10,
    });

    expect(result.blockedCandidateCount).toBe(1);
    expect(result.candidates[0]?.stages.find((stage) => stage.key === "tracking")).toMatchObject({
      status: "blocked",
      message: "Shipment has tracking, but no marketplace tracking push exists.",
    });
  });
});

function makeVendorSettingsRow(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

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
    refresh_token_ref: "refresh-ref",
    token_expires_at: now,
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
    active_return_policy_count: "1",
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

function makeDogfoodSmokeRow(overrides: Record<string, unknown> = {}) {
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
    updated_at: now,
    active_listing_count: "1",
    latest_listing_id: 30,
    latest_listing_status: "active",
    latest_listing_external_id: "listing-1",
    latest_listing_pushed_at: now,
    latest_listing_updated_at: now,
    latest_listing_job_id: 40,
    latest_listing_job_status: "completed",
    latest_listing_job_completed_at: now,
    latest_listing_job_updated_at: now,
    latest_listing_job_item_total: "1",
    latest_listing_job_item_completed: "1",
    latest_listing_job_item_failed: "0",
    latest_intake_id: 50,
    latest_intake_status: "accepted",
    latest_intake_external_order_id: "order-1",
    latest_intake_external_order_number: "1001",
    latest_intake_oms_order_id: "60",
    latest_intake_received_at: now,
    latest_intake_accepted_at: now,
    latest_intake_updated_at: now,
    latest_shipment_id: 70,
    latest_shipment_status: "shipped",
    latest_shipment_tracking_number: "94001111",
    latest_shipment_carrier: "usps",
    latest_shipment_shipstation_order_id: 7001,
    latest_shipment_shipped_at: now,
    latest_shipment_updated_at: now,
    latest_tracking_push_id: 80,
    latest_tracking_push_status: "succeeded",
    latest_tracking_push_external_fulfillment_id: "fulfillment-1",
    latest_tracking_push_last_error_code: null,
    latest_tracking_push_last_error_message: null,
    latest_tracking_push_completed_at: now,
    latest_tracking_push_updated_at: now,
    total_count: "1",
    ...overrides,
  };
}
