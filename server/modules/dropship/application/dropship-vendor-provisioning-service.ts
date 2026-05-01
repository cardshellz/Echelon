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
} from "./dropship-ports";

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

export interface DropshipVendorProvisioningRepository {
  provisionVendor(input: DropshipProvisionVendorRepositoryInput): Promise<DropshipProvisionVendorRepositoryResult>;
  getStoreConnectionSummary(vendorId: number): Promise<DropshipStoreConnectionSummary>;
  getCatalogSetupSummary(vendorId: number): Promise<DropshipCatalogSetupSummary>;
}

export interface DropshipVendorProvisioningServiceDependencies {
  entitlement: DropshipEntitlementPort;
  repository: DropshipVendorProvisioningRepository;
  clock: DropshipClock;
  logger: DropshipLogger;
}

export interface DropshipOnboardingStep {
  key: "vendor_profile" | "store_connection" | "catalog_available" | "catalog_selection";
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
    const [storeConnections, catalog] = await Promise.all([
      this.deps.repository.getStoreConnectionSummary(provisioned.vendor.vendorId),
      this.deps.repository.getCatalogSetupSummary(provisioned.vendor.vendorId),
    ]);

    return buildOnboardingState({
      vendor: provisioned.vendor,
      entitlement,
      storeConnections,
      catalog,
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
}

export function buildOnboardingState(input: {
  vendor: DropshipProvisionedVendorProfile;
  entitlement: DropshipEntitlementSnapshot;
  storeConnections: DropshipStoreConnectionSummary;
  catalog: DropshipCatalogSetupSummary;
}): DropshipOnboardingState {
  const activeStoreCount = input.storeConnections.activeCount;
  const adminCatalogAvailable = input.catalog.adminExposureRuleCount > 0;
  const hasVendorSelection = input.catalog.vendorSelectionRuleCount > 0;
  const entitlementBlocked = input.vendor.status === "lapsed" || input.vendor.status === "suspended";

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
        status: entitlementBlocked ? "blocked" : activeStoreCount > 0 ? "complete" : "incomplete",
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
    ],
  };
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
