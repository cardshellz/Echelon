import { describe, expect, it } from "vitest";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import {
  buildDropshipSystemReadinessChecks,
  buildDropshipSettingsSections,
  DropshipOpsSurfaceService,
  type DropshipAdminOpsOverview,
  type DropshipAuditEventSearchResult,
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
    expect(sections.find((section) => section.key === "store_connection")?.blockers).toContain("store_connection_required");
    expect(sections.find((section) => section.key === "wallet_payment")?.blockers).toEqual([
      "auto_reload_required",
      "funding_method_required",
    ]);
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
      STRIPE_SECRET_KEY: "stripe-secret",
      DROPSHIP_STRIPE_WEBHOOK_SECRET: "stripe-webhook",
    });

    expect(checks.every((check) => check.status === "ready")).toBe(true);
    expect(JSON.stringify(checks)).not.toContain("ebay-secret");
    expect(JSON.stringify(checks)).not.toContain("shopify-secret");
    expect(JSON.stringify(checks)).not.toContain("stripe-secret");
  });

  it("blocks dogfood system readiness when OAuth prerequisites are missing", () => {
    const checks = buildDropshipSystemReadinessChecks({
      DROPSHIP_TOKEN_ENCRYPTION_KEY: "not-valid",
      SESSION_SECRET: "short",
    });

    expect(checks.find((check) => check.key === "token_vault")).toMatchObject({ status: "blocked" });
    expect(checks.find((check) => check.key === "oauth_state_signing")).toMatchObject({ status: "blocked" });
    expect(checks.find((check) => check.key === "ebay_oauth")).toMatchObject({
      status: "blocked",
      requiredEnv: ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_VENDOR_RUNAME or EBAY_RUNAME"],
    });
    expect(checks.find((check) => check.key === "shopify_oauth")).toMatchObject({ status: "blocked" });
    expect(checks.find((check) => check.key === "shopify_webhook_subscriptions")).toMatchObject({ status: "blocked" });
    expect(checks.find((check) => check.key === "stripe_funding")).toMatchObject({ status: "warning" });
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
    const service = makeService(repository, logs);

    const result = await service.listDogfoodReadiness({
      status: "blocked",
      platform: "ebay",
      search: " vendor ",
      page: 2,
      limit: 10,
    });

    expect(result.summary).toEqual([{ status: "blocked", count: 1 }]);
    expect(result.systemChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "token_vault" }),
      expect.objectContaining({ key: "ebay_oauth" }),
      expect.objectContaining({ key: "shopify_oauth" }),
      expect.objectContaining({ key: "shopify_webhook_subscriptions" }),
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
});

class FakeOpsSurfaceRepository implements DropshipOpsSurfaceRepository {
  lastSettingsVendorId: number | null = null;
  lastOverviewInput: Parameters<DropshipOpsSurfaceRepository["getAdminOpsOverview"]>[0] | null = null;
  lastAuditSearch: Parameters<DropshipOpsSurfaceRepository["searchAuditEvents"]>[0] | null = null;
  lastDogfoodInput: Parameters<DropshipOpsSurfaceRepository["listDogfoodReadiness"]>[0] | null = null;

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
    return {
      generatedAt: input.generatedAt,
      items: [],
      total: 0,
      page: input.page,
      limit: input.limit,
      summary: [{ status: "blocked", count: 1 }],
      systemChecks: [],
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

function makeService(repository: DropshipOpsSurfaceRepository, logs: DropshipLogEvent[]): DropshipOpsSurfaceService {
  return new DropshipOpsSurfaceService({
    vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
    repository,
    clock: { now: () => now },
    logger: {
      info: (event) => logs.push(event),
      warn: (event) => logs.push(event),
      error: (event) => logs.push(event),
    },
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
    },
    notificationPreferences: {
      configuredCount: 0,
    },
    sections: [],
    generatedAt: now,
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
