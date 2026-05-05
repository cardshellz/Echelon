import { beforeEach, describe, expect, it } from "vitest";
import type {
  DropshipEntitlementPort,
  DropshipEntitlementSnapshot,
  DropshipLogEvent,
  DropshipNotificationSenderInput,
} from "../../application/dropship-ports";
import {
  DropshipVendorProvisioningService,
  type DropshipActivateVendorRepositoryInput,
  type DropshipCatalogSetupSummary,
  type DropshipProvisionVendorRepositoryInput,
  type DropshipProvisionVendorRepositoryResult,
  type DropshipProvisionedVendorProfile,
  type DropshipStoreConnectionSummary,
  type DropshipVendorProvisioningRepository,
  type DropshipWalletSetupSummary,
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
  let notificationSender: FakeNotificationSender;
  let logs: Record<"info" | "warn" | "error", DropshipLogEvent[]>;
  let service: DropshipVendorProvisioningService;

  beforeEach(() => {
    repository = new FakeVendorProvisioningRepository();
    entitlement = new FakeEntitlementPort();
    notificationSender = new FakeNotificationSender();
    logs = { info: [], warn: [], error: [] };
    service = new DropshipVendorProvisioningService({
      entitlement,
      repository,
      notificationSender,
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
    expect(notificationSender.sent).toHaveLength(0);
  });

  it("notifies an existing vendor when membership entitlement lapses", async () => {
    repository.vendor = makeVendorProfile({
      status: "active",
      entitlementStatus: "active",
    });
    entitlement.entitlement = {
      ...entitlement.entitlement,
      status: "lapsed",
      reasonCode: "SUBSCRIPTION_NOT_ACTIVE",
    };

    const result = await service.provisionForMember("member-1");

    expect(result.vendor).toMatchObject({
      status: "lapsed",
      entitlementStatus: "lapsed",
    });
    expect(notificationSender.sent[0]).toMatchObject({
      vendorId: 1,
      eventType: "dropship_entitlement_blocked",
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship entitlement lapsed",
      idempotencyKey: "entitlement-blocked:1:lapsed:sub-1",
      payload: {
        vendorId: 1,
        memberId: "member-1",
        planId: "ops-plan",
        planName: ".ops",
        subscriptionId: "sub-1",
        entitlementStatus: "lapsed",
        reasonCode: "SUBSCRIPTION_NOT_ACTIVE",
        vendorStatus: "lapsed",
        changedFields: ["status", "entitlementStatus"],
        membershipGraceEndsAt: null,
      },
    });
  });

  it("keeps entitlement sync successful when the blocked entitlement notification fails", async () => {
    repository.vendor = makeVendorProfile({
      status: "active",
      entitlementStatus: "active",
    });
    entitlement.entitlement = {
      ...entitlement.entitlement,
      status: "suspended",
      reasonCode: "SUBSCRIPTION_PAUSED",
    };
    notificationSender.error = new Error("email unavailable");

    const result = await service.provisionForMember("member-1");

    expect(result.vendor).toMatchObject({
      status: "suspended",
      entitlementStatus: "suspended",
    });
    expect(notificationSender.sent).toHaveLength(1);
    expect(logs.warn).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "DROPSHIP_ENTITLEMENT_BLOCKED_NOTIFICATION_FAILED",
        context: expect.objectContaining({
          vendorId: 1,
          memberId: "member-1",
          entitlementStatus: "suspended",
          vendorStatus: "suspended",
          error: "email unavailable",
        }),
      }),
    ]));
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
    repository.walletSetupSummary = {
      availableBalanceCents: 0,
      pendingBalanceCents: 2500,
      activeFundingMethodCount: 1,
      autoReloadEnabled: true,
      autoReloadFundingMethodId: 8,
      autoReloadFundingMethodActive: true,
    };

    const state = await service.getOnboardingState("member-1");

    expect(state.storeConnections.canConnectStore).toBe(true);
    expect(state.catalog.adminCatalogAvailable).toBe(true);
    expect(state.catalog.hasVendorSelection).toBe(false);
    expect(state.wallet).toMatchObject({
      activeFundingMethodCount: 1,
      autoReloadConfigured: true,
      hasSpendableBalance: false,
      walletReady: false,
    });
    expect(state.steps).toMatchObject([
      { key: "vendor_profile", status: "complete" },
      { key: "store_connection", status: "incomplete" },
      { key: "catalog_available", status: "complete" },
      { key: "catalog_selection", status: "incomplete" },
      { key: "wallet_payment", status: "incomplete" },
    ]);
  });

  it("marks wallet onboarding complete only when funding, auto-reload, and spendable balance are present", async () => {
    repository.vendor = makeVendorProfile({
      status: "active",
    });
    repository.walletSetupSummary = {
      availableBalanceCents: 10000,
      pendingBalanceCents: 0,
      activeFundingMethodCount: 1,
      autoReloadEnabled: true,
      autoReloadFundingMethodId: 8,
      autoReloadFundingMethodActive: true,
    };

    const state = await service.getOnboardingState("member-1");

    expect(state.wallet.walletReady).toBe(true);
    expect(state.steps.find((step) => step.key === "wallet_payment")).toMatchObject({
      status: "complete",
    });
  });

  it("keeps store onboarding incomplete when a store exists but is not connected", async () => {
    repository.vendor = makeVendorProfile({
      status: "onboarding",
    });
    repository.storeConnectionSummary = {
      activeCount: 1,
      connectedCount: 0,
      needsAttentionCount: 1,
      totalCount: 1,
    };

    const state = await service.getOnboardingState("member-1");

    expect(state.storeConnections.canConnectStore).toBe(false);
    expect(state.steps.find((step) => step.key === "store_connection")).toMatchObject({
      status: "incomplete",
    });
  });

  it("activates an onboarding vendor when every required launch gate is complete", async () => {
    repository.vendor = makeVendorProfile({
      status: "onboarding",
    });
    repository.storeConnectionSummary = {
      activeCount: 1,
      connectedCount: 1,
      needsAttentionCount: 0,
      totalCount: 1,
    };
    repository.catalogSetupSummary = {
      adminExposureRuleCount: 2,
      vendorSelectionRuleCount: 1,
    };
    repository.walletSetupSummary = {
      availableBalanceCents: 10000,
      pendingBalanceCents: 0,
      activeFundingMethodCount: 1,
      autoReloadEnabled: true,
      autoReloadFundingMethodId: 8,
      autoReloadFundingMethodActive: true,
    };

    const state = await service.activateOnboardingForMember("member-1");

    expect(state.vendor.status).toBe("active");
    expect(repository.lastActivationInput).toMatchObject({
      vendorId: 1,
      activatedAt: now,
    });
    expect(logs.info[logs.info.length - 1]).toMatchObject({
      code: "DROPSHIP_VENDOR_ONBOARDING_ACTIVATED",
      context: { vendorId: 1, memberId: "member-1" },
    });
  });

  it("rejects onboarding activation when required launch gates are incomplete", async () => {
    repository.vendor = makeVendorProfile({
      status: "onboarding",
    });

    await expect(service.activateOnboardingForMember("member-1")).rejects.toMatchObject({
      code: "DROPSHIP_ONBOARDING_INCOMPLETE",
      context: {
        incompleteRequiredSteps: [
          "store_connection",
          "catalog_available",
          "catalog_selection",
          "wallet_payment",
        ],
      },
    });
    expect(repository.lastActivationInput).toBeNull();
  });
});

class FakeNotificationSender {
  sent: DropshipNotificationSenderInput[] = [];
  error: Error | null = null;

  async send(input: DropshipNotificationSenderInput): Promise<void> {
    this.sent.push(input);
    if (this.error) {
      throw this.error;
    }
  }
}

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
  walletSetupSummary: DropshipWalletSetupSummary = {
    availableBalanceCents: 0,
    pendingBalanceCents: 0,
    activeFundingMethodCount: 0,
    autoReloadEnabled: true,
    autoReloadFundingMethodId: null,
    autoReloadFundingMethodActive: false,
  };
  lastProvisionInput: DropshipProvisionVendorRepositoryInput | null = null;
  lastActivationInput: DropshipActivateVendorRepositoryInput | null = null;

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
      ? changedVendorFields(existing, nextVendor)
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

  async getWalletSetupSummary(): Promise<DropshipWalletSetupSummary> {
    return this.walletSetupSummary;
  }

  async activateVendor(
    input: DropshipActivateVendorRepositoryInput,
  ): Promise<DropshipProvisionedVendorProfile> {
    this.lastActivationInput = input;
    if (!this.vendor) {
      throw new Error("Missing fake vendor.");
    }
    this.vendor = makeVendorProfile({
      ...this.vendor,
      status: "active",
      updatedAt: input.activatedAt,
    });
    return this.vendor;
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

function changedVendorFields(
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
