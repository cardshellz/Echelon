import { DropshipError } from "../domain/errors";
import {
  resolveDropshipVendorProvisioningStatus,
  type DropshipProvisionedVendorStatus,
} from "../domain/vendor-provisioning";
import type {
  DropshipClock,
  DropshipEntitlementPort,
  DropshipEntitlementSnapshot,
  DropshipLogEvent,
  DropshipLogger,
  DropshipNotificationSender,
} from "./dropship-ports";
import { sendDropshipNotificationSafely } from "./dropship-notification-dispatch";

export interface DropshipProvisionedVendorProfile {
  vendorId: number;
  memberId: string;
  currentSubscriptionId: string | null;
  currentPlanId: string | null;
  businessName: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  entitlementStatus: string;
  entitlementCheckedAt: Date | null;
  membershipGraceEndsAt: Date | null;
  includedStoreConnections: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DropshipProvisionVendorRepositoryInput {
  entitlement: DropshipEntitlementSnapshot;
  checkedAt: Date;
  resolveStatus(currentStatus: string | null): DropshipProvisionedVendorStatus;
}

export interface DropshipProvisionVendorRepositoryResult {
  vendor: DropshipProvisionedVendorProfile;
  created: boolean;
  changedFields: string[];
}

export interface DropshipActivateVendorRepositoryInput {
  vendorId: number;
  activatedAt: Date;
}

export interface DropshipStoreConnectionSummary {
  activeCount: number;
  connectedCount: number;
  needsAttentionCount: number;
  totalCount: number;
}

export interface DropshipCatalogSetupSummary {
  adminExposureRuleCount: number;
  vendorSelectionRuleCount: number;
}

export interface DropshipWalletSetupSummary {
  availableBalanceCents: number;
  pendingBalanceCents: number;
  activeFundingMethodCount: number;
  autoReloadEnabled: boolean;
  autoReloadFundingMethodId: number | null;
  autoReloadFundingMethodActive: boolean;
}

export interface DropshipVendorProvisioningRepository {
  provisionVendor(input: DropshipProvisionVendorRepositoryInput): Promise<DropshipProvisionVendorRepositoryResult>;
  getStoreConnectionSummary(vendorId: number): Promise<DropshipStoreConnectionSummary>;
  getCatalogSetupSummary(vendorId: number): Promise<DropshipCatalogSetupSummary>;
  getWalletSetupSummary(vendorId: number): Promise<DropshipWalletSetupSummary>;
  activateVendor(input: DropshipActivateVendorRepositoryInput): Promise<DropshipProvisionedVendorProfile>;
}

export interface DropshipVendorProvisioningServiceDependencies {
  entitlement: DropshipEntitlementPort;
  repository: DropshipVendorProvisioningRepository;
  notificationSender?: DropshipNotificationSender;
  clock: DropshipClock;
  logger: DropshipLogger;
}

export interface DropshipOnboardingStep {
  key: "vendor_profile" | "store_connection" | "catalog_available" | "catalog_selection" | "wallet_payment";
  label: string;
  status: "complete" | "incomplete" | "blocked";
  required: boolean;
}

export interface DropshipOnboardingState {
  vendor: DropshipProvisionedVendorProfile;
  entitlement: DropshipEntitlementSnapshot;
  storeConnections: DropshipStoreConnectionSummary & {
    includedLimit: number;
    canConnectStore: boolean;
  };
  catalog: DropshipCatalogSetupSummary & {
    adminCatalogAvailable: boolean;
    hasVendorSelection: boolean;
  };
  wallet: DropshipWalletSetupSummary & {
    hasActiveFundingMethod: boolean;
    autoReloadConfigured: boolean;
    hasSpendableBalance: boolean;
    walletReady: boolean;
  };
  steps: DropshipOnboardingStep[];
}

export class DropshipVendorProvisioningService {
  constructor(private readonly deps: DropshipVendorProvisioningServiceDependencies) {}

  async provisionForMember(memberId: string): Promise<DropshipProvisionVendorRepositoryResult> {
    const entitlement = await this.requireEntitlement(memberId);
    return this.provisionForEntitlement(entitlement);
  }

  async getOnboardingState(memberId: string): Promise<DropshipOnboardingState> {
    const entitlement = await this.requireEntitlement(memberId);
    const provisioned = await this.provisionForEntitlement(entitlement);
    const [storeConnections, catalog, wallet] = await Promise.all([
      this.deps.repository.getStoreConnectionSummary(provisioned.vendor.vendorId),
      this.deps.repository.getCatalogSetupSummary(provisioned.vendor.vendorId),
      this.deps.repository.getWalletSetupSummary(provisioned.vendor.vendorId),
    ]);

    return buildOnboardingState({
      vendor: provisioned.vendor,
      entitlement,
      storeConnections,
      catalog,
      wallet,
    });
  }

  async activateOnboardingForMember(memberId: string): Promise<DropshipOnboardingState> {
    const entitlement = await this.requireEntitlement(memberId);
    const provisioned = await this.provisionForEntitlement(entitlement);
    const [storeConnections, catalog, wallet] = await Promise.all([
      this.deps.repository.getStoreConnectionSummary(provisioned.vendor.vendorId),
      this.deps.repository.getCatalogSetupSummary(provisioned.vendor.vendorId),
      this.deps.repository.getWalletSetupSummary(provisioned.vendor.vendorId),
    ]);
    const state = buildOnboardingState({
      vendor: provisioned.vendor,
      entitlement,
      storeConnections,
      catalog,
      wallet,
    });
    assertOnboardingStateCanActivate(state);

    if (state.vendor.status === "active") {
      return state;
    }

    const activated = await this.deps.repository.activateVendor({
      vendorId: state.vendor.vendorId,
      activatedAt: this.deps.clock.now(),
    });
    this.deps.logger.info({
      code: "DROPSHIP_VENDOR_ONBOARDING_ACTIVATED",
      message: "Dropship vendor onboarding was activated for live order intake.",
      context: {
        vendorId: activated.vendorId,
        memberId: activated.memberId,
      },
    });
    return buildOnboardingState({
      vendor: activated,
      entitlement,
      storeConnections,
      catalog,
      wallet,
    });
  }

  private async provisionForEntitlement(
    entitlement: DropshipEntitlementSnapshot,
  ): Promise<DropshipProvisionVendorRepositoryResult> {
    const result = await this.deps.repository.provisionVendor({
      entitlement,
      checkedAt: this.deps.clock.now(),
      resolveStatus: (currentStatus) => resolveDropshipVendorProvisioningStatus({
        currentStatus,
        entitlementStatus: entitlement.status,
      }),
    });

    if (result.created || result.changedFields.length > 0) {
      this.deps.logger.info({
        code: result.created ? "DROPSHIP_VENDOR_PROVISIONED" : "DROPSHIP_VENDOR_PROFILE_SYNCED",
        message: result.created
          ? "Dropship vendor profile provisioned from Shellz Club entitlement."
          : "Dropship vendor profile synced from Shellz Club entitlement.",
        context: {
          vendorId: result.vendor.vendorId,
          memberId: entitlement.memberId,
          changedFields: result.changedFields,
        },
      });
    }

    await this.notifyEntitlementBlockedIfNeeded(result, entitlement);
    return result;
  }

  private async requireEntitlement(memberId: string): Promise<DropshipEntitlementSnapshot> {
    const normalizedMemberId = normalizeDropshipMemberId(memberId);
    const entitlement = await this.deps.entitlement.getEntitlementByMemberId(normalizedMemberId);
    if (!entitlement) {
      throw new DropshipError(
        "DROPSHIP_ENTITLEMENT_REQUIRED",
        "Dropship entitlement is required to provision a vendor profile.",
        { memberId: normalizedMemberId, reasonCode: "ENTITLEMENT_NOT_FOUND" },
      );
    }

    return entitlement;
  }

  private async notifyEntitlementBlockedIfNeeded(
    result: DropshipProvisionVendorRepositoryResult,
    entitlement: DropshipEntitlementSnapshot,
  ): Promise<void> {
    if (result.created) {
      return;
    }
    if (!result.changedFields.some((field) => field === "status" || field === "entitlementStatus")) {
      return;
    }
    if (!isBlockedEntitlementStatus(entitlement.status) && !isBlockedVendorStatus(result.vendor.status)) {
      return;
    }

    await sendDropshipNotificationSafely(this.deps, {
      vendorId: result.vendor.vendorId,
      eventType: "dropship_entitlement_blocked",
      critical: true,
      channels: ["email", "in_app"],
      title: entitlement.status === "suspended"
        ? "Dropship entitlement suspended"
        : "Dropship entitlement lapsed",
      message: "Your .ops dropship entitlement needs attention. New order acceptance and restricted dropship actions may be blocked until the membership is restored.",
      payload: {
        vendorId: result.vendor.vendorId,
        memberId: entitlement.memberId,
        planId: entitlement.planId,
        planName: entitlement.planName,
        subscriptionId: entitlement.subscriptionId,
        entitlementStatus: entitlement.status,
        reasonCode: entitlement.reasonCode,
        vendorStatus: result.vendor.status,
        changedFields: result.changedFields,
        membershipGraceEndsAt: result.vendor.membershipGraceEndsAt?.toISOString() ?? null,
      },
      idempotencyKey: `entitlement-blocked:${result.vendor.vendorId}:${entitlement.status}:${entitlement.subscriptionId ?? entitlement.planId ?? "none"}`,
    }, {
      code: "DROPSHIP_ENTITLEMENT_BLOCKED_NOTIFICATION_FAILED",
      message: "Dropship entitlement blocked notification failed after vendor profile sync.",
      context: {
        vendorId: result.vendor.vendorId,
        memberId: entitlement.memberId,
        entitlementStatus: entitlement.status,
        vendorStatus: result.vendor.status,
      },
    });
  }
}

export function buildOnboardingState(input: {
  vendor: DropshipProvisionedVendorProfile;
  entitlement: DropshipEntitlementSnapshot;
  storeConnections: DropshipStoreConnectionSummary;
  catalog: DropshipCatalogSetupSummary;
  wallet: DropshipWalletSetupSummary;
}): DropshipOnboardingState {
  const activeStoreCount = input.storeConnections.activeCount;
  const connectedStoreCount = input.storeConnections.connectedCount;
  const adminCatalogAvailable = input.catalog.adminExposureRuleCount > 0;
  const hasVendorSelection = input.catalog.vendorSelectionRuleCount > 0;
  const entitlementBlocked = input.vendor.status === "lapsed" || input.vendor.status === "suspended";
  const hasActiveFundingMethod = input.wallet.activeFundingMethodCount > 0;
  const autoReloadConfigured = input.wallet.autoReloadEnabled
    && input.wallet.autoReloadFundingMethodId !== null
    && input.wallet.autoReloadFundingMethodActive;
  const hasSpendableBalance = input.wallet.availableBalanceCents > 0;
  const walletReady = hasActiveFundingMethod && autoReloadConfigured && hasSpendableBalance;

  return {
    vendor: input.vendor,
    entitlement: input.entitlement,
    storeConnections: {
      ...input.storeConnections,
      includedLimit: input.vendor.includedStoreConnections,
      canConnectStore: !entitlementBlocked && activeStoreCount < input.vendor.includedStoreConnections,
    },
    catalog: {
      ...input.catalog,
      adminCatalogAvailable,
      hasVendorSelection,
    },
    wallet: {
      ...input.wallet,
      hasActiveFundingMethod,
      autoReloadConfigured,
      hasSpendableBalance,
      walletReady,
    },
    steps: [
      {
        key: "vendor_profile",
        label: "Vendor profile",
        status: entitlementBlocked ? "blocked" : "complete",
        required: true,
      },
      {
        key: "store_connection",
        label: "Store connection",
        status: entitlementBlocked ? "blocked" : connectedStoreCount > 0 ? "complete" : "incomplete",
        required: true,
      },
      {
        key: "catalog_available",
        label: "Card Shellz catalog",
        status: adminCatalogAvailable ? "complete" : "incomplete",
        required: true,
      },
      {
        key: "catalog_selection",
        label: "Catalog selection",
        status: entitlementBlocked ? "blocked" : hasVendorSelection ? "complete" : "incomplete",
        required: true,
      },
      {
        key: "wallet_payment",
        label: "Wallet and auto-reload",
        status: entitlementBlocked ? "blocked" : walletReady ? "complete" : "incomplete",
        required: true,
      },
    ],
  };
}

function assertOnboardingStateCanActivate(state: DropshipOnboardingState): void {
  if (state.vendor.status === "active") {
    return;
  }

  if (state.vendor.status !== "onboarding") {
    throw new DropshipError(
      "DROPSHIP_ONBOARDING_ACTIVATION_BLOCKED",
      "Dropship vendor status does not allow onboarding activation.",
      { vendorId: state.vendor.vendorId, status: state.vendor.status },
    );
  }

  if (state.entitlement.status !== "active") {
    throw new DropshipError(
      "DROPSHIP_ONBOARDING_ACTIVATION_BLOCKED",
      "Active .ops entitlement is required before onboarding activation.",
      { vendorId: state.vendor.vendorId, entitlementStatus: state.entitlement.status },
    );
  }

  const incompleteRequiredSteps = state.steps
    .filter((step) => step.required && step.status !== "complete")
    .map((step) => step.key);
  if (incompleteRequiredSteps.length > 0) {
    throw new DropshipError(
      "DROPSHIP_ONBOARDING_INCOMPLETE",
      "Dropship onboarding cannot be activated until all required steps are complete.",
      {
        vendorId: state.vendor.vendorId,
        incompleteRequiredSteps,
      },
    );
  }
}

function normalizeDropshipMemberId(memberId: string): string {
  if (typeof memberId !== "string") {
    throw new DropshipError("INVALID_DROPSHIP_MEMBER_ID", "Dropship member id must be a string.");
  }

  const normalized = memberId.trim();
  if (!normalized) {
    throw new DropshipError("INVALID_DROPSHIP_MEMBER_ID", "Dropship member id is required.");
  }

  return normalized;
}

function isBlockedEntitlementStatus(status: string): boolean {
  return status === "lapsed" || status === "not_entitled" || status === "suspended";
}

function isBlockedVendorStatus(status: string): boolean {
  return status === "lapsed" || status === "suspended";
}

export function makeDropshipVendorProvisioningLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipVendorProvisioningEvent("info", event),
    warn: (event) => logDropshipVendorProvisioningEvent("warn", event),
    error: (event) => logDropshipVendorProvisioningEvent("error", event),
  };
}

export const systemDropshipVendorProvisioningClock: DropshipClock = {
  now: () => new Date(),
};

function logDropshipVendorProvisioningEvent(
  level: "info" | "warn" | "error",
  event: DropshipLogEvent,
): void {
  const payload = JSON.stringify({
    code: event.code,
    message: event.message,
    context: event.context ?? {},
  });
  if (level === "error") {
    console.error(payload);
    return;
  }
  if (level === "warn") {
    console.warn(payload);
    return;
  }
  console.info(payload);
}
