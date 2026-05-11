import { describe, expect, it } from "vitest";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import {
  buildDropshipDogfoodLaunchGate,
  buildDropshipSystemReadinessChecks,
  buildDropshipSettingsSections,
  DropshipOpsSurfaceService,
  type DropshipAdminOpsOverview,
  type DropshipAuditEventSearchResult,
  type DropshipDogfoodSmokeResult,
  type DropshipDogfoodReadinessItem,
  type DropshipDogfoodReadinessResult,
  type DropshipOpsSurfaceRepository,
  type DropshipVendorSettingsOverview,
} from "../../application/dropship-ops-surface-service";
import type {
  DropshipProvisionVendorRepositoryResult,
  DropshipProvisionedVendorProfile,
  DropshipVendorProvisioningService,
} from "../../application/dropship-vendor-provisioning-service";

const now = new Date("2026-05-02T20:00:00.000Z");
const launchReadyEnv: NodeJS.ProcessEnv = {
  DROPSHIP_ORDER_PROCESSING_WORKER_ENABLED: "true",
  DROPSHIP_TOKEN_ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000000",
  DROPSHIP_STORE_OAUTH_STATE_SECRET: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  EBAY_CLIENT_ID: "ebay-client-id",
  EBAY_CLIENT_SECRET: "ebay-client-secret",
  EBAY_VENDOR_RUNAME: "ebay-vendor-runame",
  SHOPIFY_API_KEY: "shopify-api-key",
  SHOPIFY_API_SECRET: "shopify-api-secret",
  DROPSHIP_SHOPIFY_OAUTH_REDIRECT_URI: "https://cardshellz.test/dropship/oauth/shopify/callback",
  DROPSHIP_PUBLIC_BASE_URL: "https://cardshellz.test",
  SMTP_HOST: "smtp.cardshellz.test",
  SMTP_USER: "dropship@cardshellz.test",
  SMTP_PASS: "smtp-secret",
  SMTP_FROM: "dropship@cardshellz.test",
  SHIPSTATION_API_KEY: "shipstation-key",
  SHIPSTATION_API_SECRET: "shipstation-secret",
  SHIPSTATION_WEBHOOK_SECRET: "shipstation-webhook-secret",
  WMS_SHIPMENT_AT_SYNC: "true",
  PUSH_FROM_WMS: "true",
  SHIP_NOTIFY_V2: "true",
  STRIPE_SECRET_KEY: "stripe-secret-key",
  DROPSHIP_STRIPE_WEBHOOK_SECRET: "stripe-webhook-secret",
};

describe("DropshipOpsSurfaceService", () => {
  it("builds launch settings sections with Phase 2 surfaces marked coming soon", () => {
    const sections = buildDropshipSettingsSections({
      vendorStatus: "active",
      entitlementStatus: "active",
      storeConnections: [],
      wallet: {
        availableBalanceCents: 0,
        pendingBalanceCents: 0,
        autoReloadEnabled: false,
        fundingMethodCount: 0,
        activeStripeFundingMethodCount: 0,
        activeUsdcBaseFundingMethodCount: 0,
        autoReloadFundingMethodReady: false,
      },
      notificationPreferenceCount: 0,
      hasContactEmail: false,
    });

    expect(sections.find((section) => section.key === "api_keys")).toMatchObject({
      status: "coming_soon",
      comingSoon: true,
    });
    expect(sections.find((section) => section.key === "webhooks")).toMatchObject({
      status: "coming_soon",
      comingSoon: true,
    });
    expect(sections.find((section) => section.key === "notifications")).toMatchObject({
      status: "ready",
      summary: expect.stringContaining("launch default notification preference(s) available; 0 vendor override(s) configured."),
    });
    expect(sections.find((section) => section.key === "store_connection")?.blockers).toContain("store_connection_required");
    expect(sections.find((section) => section.key === "wallet_payment")?.blockers).toEqual([
      "auto_reload_required",
      "stripe_funding_method_required",
      "usdc_base_funding_method_required",
    ]);
  });

  it("requires launch-ready store credentials for the settings store section", () => {
    const sections = buildDropshipSettingsSections({
      vendorStatus: "active",
      entitlementStatus: "active",
      storeConnections: [{
        storeConnectionId: 20,
        platform: "ebay",
        status: "connected",
        setupStatus: "ready",
        externalDisplayName: "Vendor eBay",
        shopDomain: null,
        hasAccessToken: true,
        hasRefreshToken: false,
        launchReady: false,
        updatedAt: now,
      }],
      wallet: {
        availableBalanceCents: 0,
        pendingBalanceCents: 0,
        autoReloadEnabled: true,
        fundingMethodCount: 1,
        activeStripeFundingMethodCount: 1,
        activeUsdcBaseFundingMethodCount: 1,
        autoReloadFundingMethodReady: true,
      },
      notificationPreferenceCount: 0,
      hasContactEmail: true,
    });

    expect(sections.find((section) => section.key === "store_connection")).toMatchObject({
      status: "attention_required",
      summary: "Store connection needs launch-ready credentials.",
      blockers: ["store_refresh_token_required"],
    });
  });

  it("marks Shopify settings store section ready with access-token credentials", () => {
    const sections = buildDropshipSettingsSections({
      vendorStatus: "active",
      entitlementStatus: "active",
      storeConnections: [{
        storeConnectionId: 21,
        platform: "shopify",
        status: "connected",
        setupStatus: "ready",
        externalDisplayName: "Vendor Shopify",
        shopDomain: "vendor.myshopify.com",
        hasAccessToken: true,
        hasRefreshToken: false,
        launchReady: true,
        updatedAt: now,
      }],
      wallet: {
        availableBalanceCents: 0,
        pendingBalanceCents: 0,
        autoReloadEnabled: true,
        fundingMethodCount: 1,
        activeStripeFundingMethodCount: 1,
        activeUsdcBaseFundingMethodCount: 1,
        autoReloadFundingMethodReady: true,
      },
      notificationPreferenceCount: 0,
      hasContactEmail: true,
    });

    expect(sections.find((section) => section.key === "store_connection")).toMatchObject({
      status: "ready",
      summary: "1 launch-ready store connection configured.",
      blockers: [],
    });
  });

  it("requires Stripe-ready funding for the launch wallet settings section", () => {
    const sections = buildDropshipSettingsSections({
      vendorStatus: "active",
      entitlementStatus: "active",
      storeConnections: [],
      wallet: {
        availableBalanceCents: 0,
        pendingBalanceCents: 0,
        autoReloadEnabled: true,
        fundingMethodCount: 1,
        activeStripeFundingMethodCount: 0,
        activeUsdcBaseFundingMethodCount: 1,
        autoReloadFundingMethodReady: false,
      },
      notificationPreferenceCount: 0,
      hasContactEmail: true,
    });

    expect(sections.find((section) => section.key === "wallet_payment")).toMatchObject({
      status: "attention_required",
      summary: "Auto-reload needs usable Stripe funding.",
      blockers: [
        "auto_reload_funding_method_required",
        "stripe_funding_method_required",
      ],
    });
  });

  it("requires USDC Base funding for the launch wallet settings section", () => {
    const sections = buildDropshipSettingsSections({
      vendorStatus: "active",
      entitlementStatus: "active",
      storeConnections: [],
      wallet: {
        availableBalanceCents: 0,
        pendingBalanceCents: 0,
        autoReloadEnabled: true,
        fundingMethodCount: 1,
        activeStripeFundingMethodCount: 1,
        activeUsdcBaseFundingMethodCount: 0,
        autoReloadFundingMethodReady: true,
      },
      notificationPreferenceCount: 0,
      hasContactEmail: true,
    });

    expect(sections.find((section) => section.key === "wallet_payment")).toMatchObject({
      status: "attention_required",
      summary: "USDC Base funding needs setup.",
      blockers: ["usdc_base_funding_method_required"],
    });
  });

  it("marks launch wallet settings ready with Stripe-ready auto-reload and USDC Base funding even when balance is zero", () => {
    const sections = buildDropshipSettingsSections({
      vendorStatus: "active",
      entitlementStatus: "active",
      storeConnections: [],
      wallet: {
        availableBalanceCents: 0,
        pendingBalanceCents: 0,
        autoReloadEnabled: true,
        fundingMethodCount: 1,
        activeStripeFundingMethodCount: 1,
        activeUsdcBaseFundingMethodCount: 1,
        autoReloadFundingMethodReady: true,
      },
      notificationPreferenceCount: 0,
      hasContactEmail: true,
    });

    expect(sections.find((section) => section.key === "wallet_payment")).toMatchObject({
      status: "ready",
      summary: "Wallet funding, USDC Base, and auto-reload ready.",
      blockers: [],
    });
  });

  it("surfaces launch-critical system configuration without exposing secret values", () => {
    const checks = buildDropshipSystemReadinessChecks({
      DROPSHIP_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      DROPSHIP_TOKEN_KEY_ID: "key-v1",
      DROPSHIP_STORE_OAUTH_STATE_SECRET: "a".repeat(32),
      EBAY_CLIENT_ID: "ebay-client",
      EBAY_CLIENT_SECRET: "ebay-secret",
      EBAY_VENDOR_RUNAME: "Cardshellz_Cardshellz-vendor-oauth",
      SHOPIFY_API_KEY: "shopify-key",
      SHOPIFY_API_SECRET: "shopify-secret",
      DROPSHIP_SHOPIFY_OAUTH_REDIRECT_URI: "https://cardshellz.io/api/dropship/store-connections/oauth/callback",
      DROPSHIP_SHOPIFY_WEBHOOK_BASE_URL: "https://echelon.cardshellz.io",
      SHIPSTATION_API_KEY: "shipstation-key",
      SHIPSTATION_API_SECRET: "shipstation-secret",
      SHIPSTATION_WEBHOOK_SECRET: "shipstation-webhook",
      WMS_SHIPMENT_AT_SYNC: "true",
      PUSH_FROM_WMS: "true",
      SHIP_NOTIFY_V2: "true",
      STRIPE_SECRET_KEY: "stripe-secret",
      DROPSHIP_STRIPE_WEBHOOK_SECRET: "stripe-webhook",
      DROPSHIP_ORDER_PROCESSING_WORKER_ENABLED: "true",
      SMTP_HOST: "smtp.example.test",
      SMTP_USER: "dropship@example.test",
      SMTP_PASS: "smtp-secret",
      SMTP_FROM: "Dropship Ops <dropship@example.test>",
    });

    expect(checks.every((check) => check.status === "ready")).toBe(true);
    expect(JSON.stringify(checks)).not.toContain("ebay-secret");
    expect(JSON.stringify(checks)).not.toContain("shopify-secret");
    expect(JSON.stringify(checks)).not.toContain("shipstation-secret");
    expect(JSON.stringify(checks)).not.toContain("stripe-secret");
    expect(JSON.stringify(checks)).not.toContain("smtp-secret");
  });

  it("blocks dogfood system readiness when OAuth prerequisites are missing", () => {
    const checks = buildDropshipSystemReadinessChecks({
      DROPSHIP_TOKEN_ENCRYPTION_KEY: "not-valid",
      SESSION_SECRET: "short",
    });

    expect(checks.find((check) => check.key === "token_vault")).toMatchObject({ status: "blocked" });
    expect(checks.find((check) => check.key === "scheduler_runtime")).toMatchObject({ status: "ready" });
    expect(checks.find((check) => check.key === "listing_push_worker")).toMatchObject({ status: "ready" });
    expect(checks.find((check) => check.key === "order_processing_worker")).toMatchObject({
      status: "blocked",
      requiredEnv: ["DROPSHIP_ORDER_PROCESSING_WORKER_ENABLED=true"],
    });
    expect(checks.find((check) => check.key === "ebay_order_intake_worker")).toMatchObject({ status: "ready" });
    expect(checks.find((check) => check.key === "oauth_state_signing")).toMatchObject({ status: "blocked" });
    expect(checks.find((check) => check.key === "ebay_oauth")).toMatchObject({
      status: "blocked",
      requiredEnv: [
        "DROPSHIP_EBAY_CLIENT_ID or EBAY_CLIENT_ID",
        "DROPSHIP_EBAY_CLIENT_SECRET or EBAY_CLIENT_SECRET",
        "EBAY_VENDOR_RUNAME or EBAY_RUNAME",
      ],
    });
    expect(checks.find((check) => check.key === "shopify_oauth")).toMatchObject({ status: "blocked" });
    expect(checks.find((check) => check.key === "shopify_webhook_subscriptions")).toMatchObject({ status: "blocked" });
    expect(checks.find((check) => check.key === "email_notifications")).toMatchObject({
      status: "blocked",
      requiredEnv: ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"],
    });
    expect(checks.find((check) => check.key === "shipstation_credentials")).toMatchObject({
      status: "blocked",
      requiredEnv: ["SHIPSTATION_API_KEY", "SHIPSTATION_API_SECRET"],
    });
    expect(checks.find((check) => check.key === "shipstation_webhook_security")).toMatchObject({
      status: "blocked",
      requiredEnv: ["SHIPSTATION_WEBHOOK_SECRET"],
    });
    expect(checks.find((check) => check.key === "split_shipment_handoff")).toMatchObject({
      status: "blocked",
      requiredEnv: ["WMS_SHIPMENT_AT_SYNC=true", "PUSH_FROM_WMS=true", "SHIP_NOTIFY_V2=true"],
    });
    expect(checks.find((check) => check.key === "stripe_funding")).toMatchObject({ status: "blocked" });
    expect(checks.find((check) => check.key === "usdc_base_funding")).toMatchObject({
      status: "ready",
      requiredEnv: [],
    });
  });

  it("warns when dropship email notifications would fall back to SMTP_USER", () => {
    const checks = buildDropshipSystemReadinessChecks({
      SMTP_HOST: "smtp.example.test",
      SMTP_USER: "dropship@example.test",
      SMTP_PASS: "smtp-secret",
    });

    expect(checks.find((check) => check.key === "email_notifications")).toMatchObject({
      status: "warning",
      requiredEnv: ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM recommended"],
    });
    expect(JSON.stringify(checks)).not.toContain("smtp-secret");
  });

  it("accepts dropship-specific marketplace OAuth environment aliases for launch readiness", () => {
    const checks = buildDropshipSystemReadinessChecks({
      ...launchReadyEnv,
      DROPSHIP_EBAY_CLIENT_ID: "dropship-ebay-client-id",
      DROPSHIP_EBAY_CLIENT_SECRET: "dropship-ebay-client-secret",
      DROPSHIP_SHOPIFY_API_KEY: "dropship-shopify-api-key",
      DROPSHIP_SHOPIFY_API_SECRET: "dropship-shopify-api-secret",
      EBAY_CLIENT_ID: undefined,
      EBAY_CLIENT_SECRET: undefined,
      SHOPIFY_API_KEY: undefined,
      SHOPIFY_API_SECRET: undefined,
    });

    expect(checks.find((check) => check.key === "ebay_oauth")).toMatchObject({
      status: "ready",
      requiredEnv: [
        "DROPSHIP_EBAY_CLIENT_ID or EBAY_CLIENT_ID",
        "DROPSHIP_EBAY_CLIENT_SECRET or EBAY_CLIENT_SECRET",
        "EBAY_VENDOR_RUNAME or EBAY_RUNAME",
      ],
    });
    expect(checks.find((check) => check.key === "shopify_oauth")).toMatchObject({
      status: "ready",
      requiredEnv: [
        "DROPSHIP_SHOPIFY_API_KEY or SHOPIFY_API_KEY",
        "DROPSHIP_SHOPIFY_API_SECRET or SHOPIFY_API_SECRET",
        "DROPSHIP_SHOPIFY_OAUTH_REDIRECT_URI or SHOPIFY_OAUTH_REDIRECT_URI",
      ],
    });
    expect(checks.find((check) => check.key === "shopify_webhook_subscriptions")).toMatchObject({
      status: "ready",
      requiredEnv: [
        "DROPSHIP_SHOPIFY_WEBHOOK_BASE_URL or DROPSHIP_PUBLIC_BASE_URL or DROPSHIP_API_BASE_URL or APP_BASE_URL or PUBLIC_APP_URL",
        "DROPSHIP_SHOPIFY_WEBHOOK_SECRET or SHOPIFY_WEBHOOK_SECRET or DROPSHIP_SHOPIFY_API_SECRET or SHOPIFY_API_SECRET",
      ],
    });
    expect(JSON.stringify(checks)).not.toContain("dropship-ebay-client-secret");
    expect(JSON.stringify(checks)).not.toContain("dropship-shopify-api-secret");
  });

  it("blocks Shopify webhook readiness when a public URL exists without an HMAC secret", () => {
    const checks = buildDropshipSystemReadinessChecks({
      DROPSHIP_PUBLIC_BASE_URL: "https://cardshellz.test",
    });

    expect(checks.find((check) => check.key === "shopify_webhook_subscriptions")).toMatchObject({
      status: "blocked",
      message: "Shopify order intake webhooks require an HMAC verification secret.",
      requiredEnv: [
        "DROPSHIP_SHOPIFY_WEBHOOK_BASE_URL or DROPSHIP_PUBLIC_BASE_URL or DROPSHIP_API_BASE_URL or APP_BASE_URL or PUBLIC_APP_URL",
        "DROPSHIP_SHOPIFY_WEBHOOK_SECRET or SHOPIFY_WEBHOOK_SECRET or DROPSHIP_SHOPIFY_API_SECRET or SHOPIFY_API_SECRET",
      ],
    });
  });

  it("builds an explicit launch gate from system and vendor readiness", () => {
    const gate = buildDropshipDogfoodLaunchGate({
      summary: [
        { status: "ready", count: 0 },
        { status: "warning", count: 0 },
        { status: "blocked", count: 0 },
      ],
      systemChecks: [
        {
          key: "token_vault",
          label: "Token vault",
          status: "ready",
          message: "Token vault configured.",
          requiredEnv: ["DROPSHIP_TOKEN_ENCRYPTION_KEY"],
        },
        {
          key: "email_notifications",
          label: "Email notifications",
          status: "warning",
          message: "SMTP_FROM is recommended.",
          requiredEnv: ["SMTP_FROM recommended"],
        },
      ],
      items: [
        makeDogfoodReadinessItem({
          readinessStatus: "ready",
          blockerCount: 0,
          warningCount: 0,
          checks: [],
        }),
        makeDogfoodReadinessItem({
          readinessStatus: "warning",
          blockerCount: 0,
          warningCount: 1,
          checks: [{
            key: "notifications",
            label: "Notifications",
            status: "warning",
            message: "SMTP_FROM is recommended.",
          }],
        }),
        makeDogfoodReadinessItem({
          readinessStatus: "blocked",
          blockerCount: 2,
          checks: [{
            key: "wallet",
            label: "Wallet",
            status: "blocked",
            message: "Wallet has no available balance or active funding method.",
          }, {
            key: "shipping_rates",
            label: "Shipping rates",
            status: "blocked",
            message: "Shipping rates are missing.",
          }],
        }),
      ],
    });

    expect(gate).toMatchObject({
      status: "warning",
      readyVendorStoreCount: 1,
      warningVendorStoreCount: 1,
      blockedVendorStoreCount: 1,
      systemBlockedCount: 0,
      systemWarningCount: 1,
      blockerCount: 2,
      warningCount: 2,
      message: "1 vendor/store row(s) ready; 1 blocked row(s) and 2 warning(s) remain.",
    });
    expect(gate.firstBlockers[0]).toMatchObject({
      scope: "vendor_store",
      key: "wallet",
      vendorId: 10,
      storeConnectionId: 20,
    });
    expect(gate.runbookSteps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "review_remaining_readiness_issues",
        status: "warning",
        scope: "ops",
      }),
      expect.objectContaining({
        key: "run_live_smoke",
        status: "ready",
        scope: "ops",
        evidence: ["1 ready vendor/store row(s) found."],
      }),
    ]));
  });

  it("blocks the launch gate when system prerequisites block or no vendor store is ready", () => {
    const systemBlockedGate = buildDropshipDogfoodLaunchGate({
      summary: [
        { status: "ready", count: 1 },
        { status: "warning", count: 0 },
        { status: "blocked", count: 0 },
      ],
      systemChecks: [{
        key: "shipstation_webhook_security",
        label: "ShipStation webhook security",
        status: "blocked",
        message: "SHIPSTATION_WEBHOOK_SECRET is missing.",
        requiredEnv: ["SHIPSTATION_WEBHOOK_SECRET"],
      }],
      items: [],
    });

    expect(systemBlockedGate).toMatchObject({
      status: "blocked",
      systemBlockedCount: 1,
      message: "1 system prerequisite(s) block dogfood.",
    });
    expect(systemBlockedGate.runbookSteps[0]).toMatchObject({
      key: "resolve_system_blockers",
      status: "blocked",
      scope: "system",
      action: "Set or repair: SHIPSTATION_WEBHOOK_SECRET.",
      evidence: ["ShipStation webhook security: SHIPSTATION_WEBHOOK_SECRET is missing."],
    });

    const noReadyGate = buildDropshipDogfoodLaunchGate({
      summary: [
        { status: "ready", count: 0 },
        { status: "warning", count: 0 },
        { status: "blocked", count: 1 },
      ],
      systemChecks: [],
      items: [],
    });

    expect(noReadyGate).toMatchObject({
      status: "blocked",
      readyVendorStoreCount: 0,
      message: "No vendor/store row is ready for dogfood.",
    });
    expect(noReadyGate.runbookSteps[0]).toMatchObject({
      key: "prepare_vendor_store",
      status: "blocked",
      evidence: ["No ready vendor/store row was returned by the readiness query."],
    });
  });

  it("scopes vendor settings through Shellz Club member provisioning", async () => {
    const repository = new FakeOpsSurfaceRepository();
    const service = makeService(repository, []);

    const settings = await service.getVendorSettingsForMember("member-1");

    expect(settings.vendor.vendorId).toBe(10);
    expect(repository.lastSettingsVendorId).toBe(10);
  });

  it("validates audit search filters before repository access", async () => {
    const repository = new FakeOpsSurfaceRepository();
    const service = makeService(repository, []);

    await expect(service.searchAuditEvents({
      severity: "critical",
      page: 1,
      limit: 50,
    })).rejects.toMatchObject({ code: "DROPSHIP_AUDIT_SEARCH_INVALID_INPUT" });
    expect(repository.lastAuditSearch).toBeNull();
  });

  it("returns admin overview and logs scoped risk context", async () => {
    const repository = new FakeOpsSurfaceRepository();
    const logs: DropshipLogEvent[] = [];
    const service = makeService(repository, logs);

    const overview = await service.getAdminOpsOverview({ vendorId: 10 });

    expect(overview.riskBuckets[0]).toMatchObject({ key: "tracking_push_failures", count: 2 });
    expect(repository.lastOverviewInput).toMatchObject({ vendorId: 10, generatedAt: now });
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_OPS_OVERVIEW_VIEWED",
      context: { vendorId: 10 },
    });
  });

  it("lists dogfood readiness with validated filters and generated timestamp", async () => {
    const repository = new FakeOpsSurfaceRepository();
    const logs: DropshipLogEvent[] = [];
    const service = makeService(repository, logs, launchReadyEnv);

    const result = await service.listDogfoodReadiness({
      status: "blocked",
      platform: "ebay",
      search: " vendor ",
      page: 2,
      limit: 10,
    });

    expect(result.summary).toEqual([{ status: "blocked", count: 1 }]);
    expect("launchGateItems" in result).toBe(false);
    expect(result.launchGate).toMatchObject({
      status: "blocked",
      blockedVendorStoreCount: 1,
    });
    expect(result.launchGate?.firstBlockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "wallet",
        vendorId: 10,
        storeConnectionId: 20,
      }),
    ]));
    expect(result.launchGate?.runbookSteps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "prepare_vendor_store",
        status: "blocked",
      }),
    ]));
    expect(result.systemChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "token_vault" }),
      expect.objectContaining({ key: "order_processing_worker" }),
      expect.objectContaining({ key: "ebay_oauth" }),
      expect.objectContaining({ key: "shopify_oauth" }),
      expect.objectContaining({ key: "shopify_webhook_subscriptions" }),
      expect.objectContaining({ key: "email_notifications" }),
      expect.objectContaining({ key: "shipstation_credentials" }),
      expect.objectContaining({ key: "shipstation_webhook_security" }),
      expect.objectContaining({ key: "split_shipment_handoff" }),
      expect.objectContaining({ key: "usdc_base_funding" }),
    ]));
    expect(repository.lastDogfoodInput).toMatchObject({
      status: "blocked",
      platform: "ebay",
      search: "vendor",
      page: 2,
      limit: 10,
      generatedAt: now,
    });
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_DOGFOOD_READINESS_VIEWED",
      context: { status: "blocked", platform: "ebay" },
    });
  });

  it("validates dogfood readiness status before repository access", async () => {
    const repository = new FakeOpsSurfaceRepository();
    const service = makeService(repository, []);

    await expect(service.listDogfoodReadiness({ status: "not_ready" })).rejects.toMatchObject({
      code: "DROPSHIP_DOGFOOD_READINESS_INVALID_INPUT",
    });
    expect(repository.lastDogfoodInput).toBeNull();
  });

  it("lists dogfood smoke candidates with scoped filters and generated timestamp", async () => {
    const repository = new FakeOpsSurfaceRepository();
    const logs: DropshipLogEvent[] = [];
    const service = makeService(repository, logs);

    const result = await service.listDogfoodSmokeCandidates({
      vendorId: 10,
      storeConnectionId: 20,
      platform: "ebay",
      search: " smoke ",
      limit: 5,
    });

    expect(result.candidates[0]).toMatchObject({
      status: "warning",
      references: { latestListingId: 30 },
    });
    expect(repository.lastDogfoodSmokeInput).toMatchObject({
      vendorId: 10,
      storeConnectionId: 20,
      platform: "ebay",
      search: "smoke",
      limit: 5,
      staleAfterHours: 72,
      generatedAt: now,
    });
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_DOGFOOD_SMOKE_VIEWED",
      context: {
        vendorId: 10,
        storeConnectionId: 20,
        platform: "ebay",
        total: 1,
      },
    });
  });

  it("uses configured dogfood smoke freshness windows without exposing invalid config as ready", async () => {
    const repository = new FakeOpsSurfaceRepository();
    const service = makeService(repository, [], {
      DROPSHIP_DOGFOOD_SMOKE_STALE_AFTER_HOURS: "24",
    });

    await service.listDogfoodSmokeCandidates({ limit: 5 });

    expect(repository.lastDogfoodSmokeInput).toMatchObject({
      staleAfterHours: 24,
      limit: 5,
      generatedAt: now,
    });
    expect(buildDropshipSystemReadinessChecks({
      DROPSHIP_DOGFOOD_SMOKE_STALE_AFTER_HOURS: "invalid",
    }).find((check) => check.key === "dogfood_smoke_freshness")).toMatchObject({
      status: "blocked",
      requiredEnv: ["DROPSHIP_DOGFOOD_SMOKE_STALE_AFTER_HOURS optional 1-720"],
    });
  });

  it("lets dogfood smoke requests override the default freshness window", async () => {
    const repository = new FakeOpsSurfaceRepository();
    const service = makeService(repository, [], {
      DROPSHIP_DOGFOOD_SMOKE_STALE_AFTER_HOURS: "24",
    });

    await service.listDogfoodSmokeCandidates({ limit: 5, staleAfterHours: 12 });

    expect(repository.lastDogfoodSmokeInput).toMatchObject({
      staleAfterHours: 12,
      limit: 5,
      generatedAt: now,
    });
  });

  it("builds dogfood launch status from readiness and fresh smoke evidence", async () => {
    const repository = new FakeOpsSurfaceRepository();
    repository.dogfoodReadinessResult = makeDogfoodReadinessResult({
      launchGateItems: [makeDogfoodReadinessItem()],
      summary: [{ status: "ready", count: 1 }],
      total: 1,
    });
    repository.dogfoodSmokeResult = makeDogfoodSmokeResult({
      readyCandidateCount: 1,
      warningCandidateCount: 0,
      blockedCandidateCount: 0,
      message: "Loaded 1 store with full smoke evidence; 0 blocked and 0 incomplete.",
      candidates: [makeDogfoodSmokeCandidate({ status: "ready" })],
    });
    const logs: DropshipLogEvent[] = [];
    const service = makeService(repository, logs, launchReadyEnv);

    const result = await service.getDogfoodLaunchStatus({
      platform: "ebay",
      search: " vendor ",
      staleAfterHours: 24,
    });

    expect(result).toMatchObject({
      status: "ready",
      message: "1 vendor/store row(s) are dogfood-ready with fresh complete smoke evidence.",
      launchCandidates: [{
        vendor: { vendorId: 10 },
        storeConnection: { storeConnectionId: 20, platform: "ebay" },
        readinessStatus: "ready",
        smokeStatus: "ready",
        smokeReferences: { latestListingId: 30 },
      }],
      launchGate: {
        status: "ready",
        readyVendorStoreCount: 1,
      },
      smoke: {
        staleAfterHours: 24,
        readyCandidateCount: 1,
      },
    });
    expect(result.runbookSteps).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "run_live_smoke", status: "ready" }),
      expect.objectContaining({
        key: "confirm_fresh_smoke",
        status: "ready",
        evidence: ["vendor 10, ebay store 20: readiness ready; smoke ready."],
      }),
    ]));
    expect(repository.lastDogfoodInput).toMatchObject({
      platform: "ebay",
      search: "vendor",
      page: 1,
      limit: 100,
      generatedAt: now,
    });
    expect(repository.lastDogfoodSmokeInput).toMatchObject({
      platform: "ebay",
      search: "vendor",
      limit: 100,
      staleAfterHours: 24,
      generatedAt: now,
    });
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_DOGFOOD_LAUNCH_STATUS_VIEWED",
      context: {
        status: "ready",
        platform: "ebay",
        staleAfterHours: 24,
        readinessTotal: 1,
        smokeTotal: 1,
      },
    });
  });

  it("scopes dogfood launch gate readiness to launch status filters", async () => {
    const repository = new FakeOpsSurfaceRepository();
    repository.dogfoodReadinessResult = makeDogfoodReadinessResult({
      items: [makeDogfoodReadinessItem({
        readinessStatus: "blocked",
        blockerCount: 1,
        checks: [{
          key: "store_connection",
          label: "Store connection",
          status: "blocked",
          message: "eBay store is not launch-ready.",
        }],
      })],
      launchGateItems: [makeDogfoodReadinessItem({
        vendor: {
          vendorId: 11,
          memberId: "member-2",
          businessName: "Shopify Vendor",
          email: "shopify-vendor@cardshellz.test",
          status: "active",
          entitlementStatus: "active",
        },
        storeConnection: {
          storeConnectionId: 21,
          platform: "shopify",
          status: "connected",
          setupStatus: "ready",
          externalDisplayName: "Shopify Store",
          shopDomain: "vendor.myshopify.com",
          updatedAt: now,
        },
      })],
      total: 1,
      summary: [
        { status: "ready", count: 0 },
        { status: "warning", count: 0 },
        { status: "blocked", count: 1 },
      ],
    });
    repository.dogfoodSmokeResult = makeDogfoodSmokeResult({
      readyCandidateCount: 1,
      warningCandidateCount: 0,
      blockedCandidateCount: 0,
      candidates: [makeDogfoodSmokeCandidate({ status: "ready" })],
    });
    const service = makeService(repository, [], launchReadyEnv);

    const result = await service.getDogfoodLaunchStatus({ platform: "ebay" });

    expect(result).toMatchObject({
      status: "blocked",
      launchGate: {
        status: "blocked",
        readyVendorStoreCount: 0,
        blockedVendorStoreCount: 1,
        firstBlockers: [{
          scope: "vendor_store",
          key: "store_connection",
          vendorId: 10,
          storeConnectionId: 20,
        }],
      },
      launchCandidates: [],
    });
  });

  it("keeps dogfood launch status warning until fresh complete smoke evidence exists", async () => {
    const repository = new FakeOpsSurfaceRepository();
    repository.dogfoodReadinessResult = makeDogfoodReadinessResult({
      launchGateItems: [makeDogfoodReadinessItem()],
      summary: [{ status: "ready", count: 1 }],
      total: 1,
    });
    repository.dogfoodSmokeResult = makeDogfoodSmokeResult({
      readyCandidateCount: 0,
      warningCandidateCount: 1,
      blockedCandidateCount: 0,
      candidates: [makeDogfoodSmokeCandidate({
        status: "warning",
        stages: [{
          key: "tracking",
          label: "Marketplace tracking",
          status: "warning",
          message: "No marketplace tracking evidence exists yet.",
          evidence: ["No marketplace tracking push has been recorded for the latest intake."],
          latestAt: null,
          freshness: {
            status: "missing",
            staleAfterHours: 72,
          },
        }],
      })],
    });
    const service = makeService(repository, [], launchReadyEnv);

    const result = await service.getDogfoodLaunchStatus();

    expect(result).toMatchObject({
      status: "warning",
      message: "No vendor/store row is both readiness-ready and fresh smoke-ready yet.",
      launchCandidates: [],
    });
    expect(result.runbookSteps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "complete_fresh_smoke",
        status: "warning",
        evidence: ["vendor 10, ebay store 20: Marketplace tracking - No marketplace tracking evidence exists yet."],
      }),
    ]));
  });

  it("does not mark launch ready when readiness and smoke belong to different stores", async () => {
    const repository = new FakeOpsSurfaceRepository();
    repository.dogfoodReadinessResult = makeDogfoodReadinessResult({
      launchGateItems: [makeDogfoodReadinessItem()],
      summary: [{ status: "ready", count: 1 }],
      total: 1,
    });
    repository.dogfoodSmokeResult = makeDogfoodSmokeResult({
      readyCandidateCount: 1,
      warningCandidateCount: 0,
      blockedCandidateCount: 0,
      message: "Loaded 1 store with full smoke evidence; 0 blocked and 0 incomplete.",
      candidates: [makeDogfoodSmokeCandidate({
        status: "ready",
        storeConnection: {
          storeConnectionId: 21,
          platform: "ebay",
          status: "connected",
          setupStatus: "ready",
          externalDisplayName: "Other eBay",
          shopDomain: null,
          updatedAt: now,
        },
      })],
    });
    const service = makeService(repository, [], launchReadyEnv);

    const result = await service.getDogfoodLaunchStatus();

    expect(result).toMatchObject({
      status: "warning",
      message: "No vendor/store row is both readiness-ready and fresh smoke-ready yet.",
      launchCandidates: [],
    });
    expect(result.runbookSteps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "complete_fresh_smoke",
        status: "warning",
        message: "Fresh smoke evidence exists, but not for a readiness-ready vendor/store row.",
      }),
    ]));
  });
});

class FakeOpsSurfaceRepository implements DropshipOpsSurfaceRepository {
  lastSettingsVendorId: number | null = null;
  lastOverviewInput: Parameters<DropshipOpsSurfaceRepository["getAdminOpsOverview"]>[0] | null = null;
  lastAuditSearch: Parameters<DropshipOpsSurfaceRepository["searchAuditEvents"]>[0] | null = null;
  lastDogfoodInput: Parameters<DropshipOpsSurfaceRepository["listDogfoodReadiness"]>[0] | null = null;
  lastDogfoodSmokeInput: Parameters<DropshipOpsSurfaceRepository["listDogfoodSmokeCandidates"]>[0] | null = null;
  dogfoodReadinessResult: DropshipDogfoodReadinessResult | null = null;
  dogfoodSmokeResult: DropshipDogfoodSmokeResult | null = null;

  async getVendorSettingsOverview(vendorId: number, generatedAt: Date): Promise<DropshipVendorSettingsOverview> {
    this.lastSettingsVendorId = vendorId;
    return makeSettingsOverview({ generatedAt });
  }

  async getAdminOpsOverview(
    input: Parameters<DropshipOpsSurfaceRepository["getAdminOpsOverview"]>[0],
  ): Promise<DropshipAdminOpsOverview> {
    this.lastOverviewInput = input;
    return {
      generatedAt: input.generatedAt,
      riskBuckets: [{ key: "tracking_push_failures", label: "Tracking push failures", severity: "error", count: 2 }],
      vendorStatusCounts: [],
      storeConnectionStatusCounts: [],
      orderIntakeStatusCounts: [],
      orderCancellationStatusCounts: [],
      listingPushJobStatusCounts: [],
      trackingPushStatusCounts: [{ key: "failed", count: 2 }],
      rmaStatusCounts: [],
      notificationStatusCounts: [],
      recentAuditEvents: [],
    };
  }

  async searchAuditEvents(
    input: Parameters<DropshipOpsSurfaceRepository["searchAuditEvents"]>[0],
  ): Promise<DropshipAuditEventSearchResult> {
    this.lastAuditSearch = input;
    return { items: [], total: 0, page: input.page, limit: input.limit };
  }

  async listDogfoodReadiness(
    input: Parameters<DropshipOpsSurfaceRepository["listDogfoodReadiness"]>[0],
  ): Promise<DropshipDogfoodReadinessResult> {
    this.lastDogfoodInput = input;
    if (this.dogfoodReadinessResult) {
      return {
        ...this.dogfoodReadinessResult,
        generatedAt: input.generatedAt,
        page: input.page,
        limit: input.limit,
      };
    }
    return {
      generatedAt: input.generatedAt,
      items: [],
      launchGateItems: [makeDogfoodReadinessItem({
        readinessStatus: "blocked",
        blockerCount: 1,
        checks: [{
          key: "wallet",
          label: "Wallet",
          status: "blocked",
          message: "Wallet has no available balance or active funding method.",
        }],
      })],
      total: 0,
      page: input.page,
      limit: input.limit,
      summary: [{ status: "blocked", count: 1 }],
      systemChecks: [],
    };
  }

  async listDogfoodSmokeCandidates(
    input: Parameters<DropshipOpsSurfaceRepository["listDogfoodSmokeCandidates"]>[0],
  ): Promise<DropshipDogfoodSmokeResult> {
    this.lastDogfoodSmokeInput = input;
    if (this.dogfoodSmokeResult) {
      return {
        ...this.dogfoodSmokeResult,
        generatedAt: input.generatedAt,
        staleAfterHours: input.staleAfterHours ?? 72,
      };
    }
    return {
      generatedAt: input.generatedAt,
      staleAfterHours: input.staleAfterHours ?? 72,
      total: 1,
      readyCandidateCount: 0,
      warningCandidateCount: 1,
      blockedCandidateCount: 0,
      message: "Loaded 1 store waiting on smoke evidence.",
      candidates: [{
        vendor: {
          vendorId: 10,
          memberId: "member-1",
          businessName: "Vendor Test",
          email: "vendor@cardshellz.test",
          status: "active",
          entitlementStatus: "active",
        },
        storeConnection: {
          storeConnectionId: 20,
          platform: "ebay",
          status: "connected",
          setupStatus: "ready",
          externalDisplayName: "Vendor eBay",
          shopDomain: null,
          updatedAt: now,
        },
        status: "warning",
        message: "Dogfood smoke evidence is incomplete but not blocked.",
        stages: [{
          key: "listing",
          label: "Listing push",
          status: "ready",
          message: "At least one active marketplace listing exists for this store.",
          evidence: ["1 active marketplace listing(s)."],
          latestAt: now,
          freshness: {
            status: "fresh",
            staleAfterHours: input.staleAfterHours ?? 72,
          },
        }],
        references: {
          latestListingId: 30,
          latestListingJobId: 40,
          latestIntakeId: null,
          latestOmsOrderId: null,
          latestWmsShipmentId: null,
          latestTrackingPushId: null,
        },
        lastActivityAt: now,
      }],
    };
  }
}

class FakeVendorProvisioningService {
  async provisionForMember(memberId: string): Promise<DropshipProvisionVendorRepositoryResult> {
    return {
      vendor: makeVendor({ memberId }),
      created: false,
      changedFields: [],
    };
  }
}

function makeService(
  repository: DropshipOpsSurfaceRepository,
  logs: DropshipLogEvent[],
  env?: NodeJS.ProcessEnv,
): DropshipOpsSurfaceService {
  return new DropshipOpsSurfaceService({
    vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
    repository,
    clock: { now: () => now },
    logger: {
      info: (event) => logs.push(event),
      warn: (event) => logs.push(event),
      error: (event) => logs.push(event),
    },
    env,
  });
}

function makeSettingsOverview(overrides: Partial<DropshipVendorSettingsOverview> = {}): DropshipVendorSettingsOverview {
  return {
    vendor: {
      vendorId: 10,
      memberId: "member-1",
      businessName: null,
      email: "vendor@cardshellz.test",
      status: "active",
      entitlementStatus: "active",
      includedStoreConnections: 1,
    },
    account: {
      hasBusinessName: false,
      hasContactEmail: true,
    },
    storeConnections: [],
    wallet: {
      availableBalanceCents: 0,
      pendingBalanceCents: 0,
      autoReloadEnabled: true,
      fundingMethodCount: 1,
      activeStripeFundingMethodCount: 1,
      activeUsdcBaseFundingMethodCount: 1,
      autoReloadFundingMethodReady: true,
    },
    notificationPreferences: {
      configuredCount: 0,
    },
    sections: [],
    generatedAt: now,
    ...overrides,
  };
}

function makeDogfoodReadinessResult(
  overrides: Partial<DropshipDogfoodReadinessResult> = {},
): DropshipDogfoodReadinessResult {
  return {
    generatedAt: now,
    items: [makeDogfoodReadinessItem()],
    launchGateItems: [makeDogfoodReadinessItem()],
    total: 1,
    page: 1,
    limit: 100,
    summary: [{ status: "ready", count: 1 }],
    systemChecks: [],
    ...overrides,
  };
}

function makeDogfoodReadinessItem(
  overrides: Partial<DropshipDogfoodReadinessItem> = {},
): DropshipDogfoodReadinessItem {
  return {
    vendor: {
      vendorId: 10,
      memberId: "member-1",
      businessName: "Vendor Test",
      email: "vendor@cardshellz.test",
      status: "active",
      entitlementStatus: "active",
    },
    storeConnection: {
      storeConnectionId: 20,
      platform: "ebay",
      status: "connected",
      setupStatus: "ready",
      externalDisplayName: "Vendor eBay",
      shopDomain: null,
      updatedAt: now,
    },
    readinessStatus: "ready",
    blockerCount: 0,
    warningCount: 0,
    checks: [],
    metrics: {
      dropshipOmsChannelId: 7,
      dropshipOmsChannelCount: 1,
      defaultWarehouseId: 1,
      adminCatalogIncludeRuleCount: 1,
      vendorSelectionIncludeRuleCount: 1,
      activeShippingBoxCount: 1,
      activeShippingZoneRuleCount: 1,
      activeShippingRateTableCount: 1,
      activeShippingRateRowCount: 1,
      selectedVariantCount: 1,
      selectedPackageProfileCount: 1,
      selectedVariantMissingPackageProfileCount: 0,
      activeShippingMarkupPolicyCount: 1,
      activeShippingInsurancePolicyCount: 1,
      activeReturnPolicyCount: 1,
      listingConfigActive: true,
      setupOpenBlockerCount: 0,
      walletAvailableBalanceCents: 1000,
      activeFundingMethodCount: 2,
      activeStripeFundingMethodCount: 1,
      activeUsdcBaseFundingMethodCount: 1,
      autoReloadEnabled: true,
      autoReloadFundingMethodReady: true,
      notificationPreferenceCount: 0,
    },
    ...overrides,
  };
}

function makeDogfoodSmokeResult(
  overrides: Partial<DropshipDogfoodSmokeResult> = {},
): DropshipDogfoodSmokeResult {
  return {
    generatedAt: now,
    staleAfterHours: 72,
    total: 1,
    readyCandidateCount: 0,
    warningCandidateCount: 1,
    blockedCandidateCount: 0,
    message: "Loaded 1 store waiting on smoke evidence.",
    candidates: [makeDogfoodSmokeCandidate()],
    ...overrides,
  };
}

function makeDogfoodSmokeCandidate(
  overrides: Partial<DropshipDogfoodSmokeResult["candidates"][number]> = {},
): DropshipDogfoodSmokeResult["candidates"][number] {
  return {
    vendor: {
      vendorId: 10,
      memberId: "member-1",
      businessName: "Vendor Test",
      email: "vendor@cardshellz.test",
      status: "active",
      entitlementStatus: "active",
    },
    storeConnection: {
      storeConnectionId: 20,
      platform: "ebay",
      status: "connected",
      setupStatus: "ready",
      externalDisplayName: "Vendor eBay",
      shopDomain: null,
      updatedAt: now,
    },
    status: "warning",
    message: "Dogfood smoke evidence is incomplete but not blocked.",
    stages: [{
      key: "listing",
      label: "Listing push",
      status: "ready",
      message: "At least one active marketplace listing exists for this store.",
      evidence: ["1 active marketplace listing(s)."],
      latestAt: now,
      freshness: {
        status: "fresh",
        staleAfterHours: 72,
      },
    }],
    references: {
      latestListingId: 30,
      latestListingJobId: 40,
      latestIntakeId: null,
      latestOmsOrderId: null,
      latestWmsShipmentId: null,
      latestTrackingPushId: null,
    },
    lastActivityAt: now,
    ...overrides,
  };
}

function makeVendor(overrides: Partial<DropshipProvisionedVendorProfile> = {}): DropshipProvisionedVendorProfile {
  return {
    vendorId: 10,
    memberId: "member-1",
    currentSubscriptionId: "sub-1",
    currentPlanId: "ops",
    businessName: null,
    contactName: null,
    email: "vendor@cardshellz.test",
    phone: null,
    status: "active",
    entitlementStatus: "active",
    entitlementCheckedAt: now,
    membershipGraceEndsAt: null,
    includedStoreConnections: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
