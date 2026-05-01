import type { DropshipEntitlementStatus } from "./auth";

export type DropshipProvisionedVendorStatus =
  | "onboarding"
  | "active"
  | "lapsed"
  | "suspended"
  | "paused"
  | "closed";

export interface ResolveDropshipVendorStatusInput {
  currentStatus?: string | null;
  entitlementStatus: DropshipEntitlementStatus;
}

export function resolveDropshipVendorProvisioningStatus(
  input: ResolveDropshipVendorStatusInput,
): DropshipProvisionedVendorStatus {
  if (input.currentStatus === "closed" || input.currentStatus === "paused") {
    return input.currentStatus;
  }

  if (input.entitlementStatus === "suspended") {
    return "suspended";
  }

  if (input.entitlementStatus === "lapsed" || input.entitlementStatus === "not_entitled") {
    return "lapsed";
  }

  if (input.currentStatus === "active") {
    return "active";
  }

  return "onboarding";
}
