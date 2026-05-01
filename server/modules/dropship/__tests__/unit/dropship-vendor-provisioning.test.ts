import { beforeEach, describe, expect, it } from "vitest";
import type {
  DropshipEntitlementPort,
  DropshipEntitlementSnapshot,
  DropshipLogEvent,
} from "../../application/dropship-ports";
import {
  DropshipVendorProvisioningService,
  type DropshipCatalogSetupSummary,
  type DropshipProvisionVendorRepositoryInput,
  type DropshipProvisionVendorRepositoryResult,
  type DropshipProvisionedVendorProfile,
  type DropshipStoreConnectionSummary,
  type DropshipVendorProvisioningRepository,
} from "../../application/dropship-vendor-provisioning-service";
import { resolveDropshipVendorProvisioningStatus } from "../../domain/vendor-provisioning";

const now = new Date("2026-05-01T12:00:00.000Z");

describe("dropship vendor provisioning status policy", () => {
  it("keeps active and onboarding vendors active/onboarding while entitlement is valid", () => {
    expect(resolveDropshipVendorProvisioningStatus({
      currentStatus: null,
      entitlementStatus: "active",
    })).toBe("onboarding");
    expect(resolveDropshipVendorProvisioningStatus({
      currentStatus: "active",
      entitlementStatus: "grace",
    })).toBe("active");
  });

  it("moves entitlement failures into explicit lapsed or suspended states", () => {
    expect(resolveDropshipVendorProvisioningStatus({
      currentStatus: "active",
      entitlementStatus: "lapsed",
    })).toBe("lapsed");
    expect(resolveDropshipVendorProvisioningStatus({
      currentStatus: "active",
      entitlementStatus: "not_entitled",
    })).toBe("lapsed");
    expect(resolveDropshipVendorProvisioningStatus({
      currentStatus: "active",
      entitlementStatus: "suspended",
    })).toBe("suspended");
  });

  it("preserves manual closed and paused states", () => {
    expect(resolveDropshipVendorProvisioningStatus({
      currentStatus: "closed",
      entitlementStatus: "active",
    })).toBe("closed");
    expect(resolveDropshipVendorProvisioningStatus({
      currentStatus: "paused",
      entitlementStatus: "active",
    })).toBe("paused");
  });
});

describe("DropshipVendorProvisioningService", () => {
  let repository: FakeVendorProvisioningRepository;
  let entitlement: FakeEntitlementPort;
  let logs: Record<"info" | "warn" | "error", DropshipLogEvent[]>;
  let service: DropshipVendorProvisioningService;

  beforeEach(() => {
    repository = new FakeVendorProvisioningRepository();
    entitlement = new FakeEntitlementPort();
    logs = { info: [], warn: [], error: [] };
    service = new DropshipVendorProvisioningService({
      entitlement,
      repository,
      clock: { now: () => now },
      logger: {
        info: (event) => logs.info.push(event),
        warn: (event) => logs.warn.push(event),
        error: (event) => logs.error.push(event),
      },
    });
  });

  it("provisions a new entitled member into onboarding state", async () => {
    const result = await service.provisionForMember("member-1");

    expect(result.created).toBe(true);
    expect(result.vendor).toMatchObject({
      memberId: "member-1",
      currentSubscriptionId: "sub-1",
      currentPlanId: "ops-plan",
      email: "vendor@cardshellz.test",
      status: "onboarding",
      entitlementStatus: "active",
    });
    expect(repository.lastProvisionInput?.checkedAt).toEqual(now);
    expect(logs.info[0]).toMatchObject({
      code: "DROPSHIP_VENDOR_PROVISIONED",
    });
  });

  it("syncs an existing profile without downgrading an active operational status", async () => {
    repository.vendor = makeVendorProfile({
      status: "active",
      currentPlanId: "old-plan",
      email: "old@cardshellz.test",
    });

    const result = await service.provisionForMember("member-1");

    expect(result.created).toBe(false);
    expect(result.vendor.status).toBe("active");
    expect(result.vendor.currentPlanId).toBe("ops-plan");
    expect(result.vendor.email).toBe("vendor@cardshellz.test");
    expect(result.changedFields).toEqual(["currentPlanId", "email"]);
    expect(logs.info[0]).toMatchObject({
      code: "DROPSHIP_VENDOR_PROFILE_SYNCED",
    });
  });

  it("returns onboarding state with store and catalog setup gates", async () => {
    repository.vendor = makeVendorProfile({
      status: "active",
      includedStoreConnections: 1,
    });
    repository.storeConnectionSummary = {
      activeCount: 0,
      connectedCount: 0,
      needsAttentionCount: 0,
      totalCount: 0,
    };
    repository.catalogSetupSummary = {
      adminExposureRuleCount: 2,
      vendorSelectionRuleCount: 0,
    };

    const state = await service.getOnboardingState("member-1");

    expect(state.storeConnections.canConnectStore).toBe(true);
    expect(state.catalog.adminCatalogAvailable).toBe(true);
    expect(state.catalog.hasVendorSelection).toBe(false);
    expect(state.steps).toMatchObject([
      { key: "vendor_profile", status: "complete" },
      { key: "store_connection", status: "incomplete" },
      { key: "catalog_available", status: "complete" },
      { key: "catalog_selection", status: "incomplete" },
    ]);
  });
});

class FakeEntitlementPort implements DropshipEntitlementPort {
  entitlement: DropshipEntitlementSnapshot = {
    memberId: "member-1",
    cardShellzEmail: "vendor@cardshellz.test",
    planId: "ops-plan",
    planName: ".ops",
    subscriptionId: "sub-1",
    includesDropship: true,
    status: "active",
    reasonCode: "ENTITLED",
  };

  async getEntitlementByMemberId(memberId: string): Promise<DropshipEntitlementSnapshot | null> {
    return memberId === this.entitlement.memberId ? this.entitlement : null;
  }
}

class FakeVendorProvisioningRepository implements DropshipVendorProvisioningRepository {
  vendor: DropshipProvisionedVendorProfile | null = null;
  storeConnectionSummary: DropshipStoreConnectionSummary = {
    activeCount: 0,
    connectedCount: 0,
    needsAttentionCount: 0,
    totalCount: 0,
  };
  catalogSetupSummary: DropshipCatalogSetupSummary = {
    adminExposureRuleCount: 0,
    vendorSelectionRuleCount: 0,
  };
  lastProvisionInput: DropshipProvisionVendorRepositoryInput | null = null;

  async provisionVendor(
    input: DropshipProvisionVendorRepositoryInput,
  ): Promise<DropshipProvisionVendorRepositoryResult> {
    this.lastProvisionInput = input;
    const existing = this.vendor;
    const status = input.resolveStatus(existing?.status ?? null);
    const nextVendor = makeVendorProfile({
      vendorId: existing?.vendorId ?? 1,
      memberId: input.entitlement.memberId,
      currentSubscriptionId: input.entitlement.subscriptionId,
      currentPlanId: input.entitlement.planId,
      email: input.entitlement.cardShellzEmail,
      status,
      entitlementStatus: input.entitlement.status,
      entitlementCheckedAt: input.checkedAt,
      createdAt: existing?.createdAt ?? input.checkedAt,
      updatedAt: input.checkedAt,
    });
    const changedFields = existing
      ? changedFields(existing, nextVendor)
      : ["memberId", "currentSubscriptionId", "currentPlanId", "email", "status", "entitlementStatus"];
    this.vendor = nextVendor;
    return {
      vendor: nextVendor,
      created: !existing,
      changedFields,
    };
  }

  async getStoreConnectionSummary(): Promise<DropshipStoreConnectionSummary> {
    return this.storeConnectionSummary;
  }

  async getCatalogSetupSummary(): Promise<DropshipCatalogSetupSummary> {
    return this.catalogSetupSummary;
  }
}

function makeVendorProfile(
  overrides: Partial<DropshipProvisionedVendorProfile> = {},
): DropshipProvisionedVendorProfile {
  return {
    vendorId: 1,
    memberId: "member-1",
    currentSubscriptionId: "sub-1",
    currentPlanId: "ops-plan",
    businessName: null,
    contactName: null,
    email: "vendor@cardshellz.test",
    phone: null,
    status: "onboarding",
    entitlementStatus: "active",
    entitlementCheckedAt: now,
    membershipGraceEndsAt: null,
    includedStoreConnections: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function changedFields(
  before: DropshipProvisionedVendorProfile,
  after: DropshipProvisionedVendorProfile,
): string[] {
  return ([
    "currentSubscriptionId",
    "currentPlanId",
    "email",
    "status",
    "entitlementStatus",
  ] as const).filter((field) => before[field] !== after[field]);
}
