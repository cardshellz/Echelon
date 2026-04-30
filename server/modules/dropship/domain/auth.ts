import { DropshipError } from "./errors";

export const DROPSHIP_ENTITLEMENT_GRACE_HOURS = 72;
export const DROPSHIP_EMAIL_MFA_TTL_MINUTES = 10;

export const dropshipSensitiveActionEnum = [
  "account_bootstrap",
  "connect_store",
  "disconnect_store",
  "change_password",
  "change_contact_email",
  "password_reset",
  "register_passkey",
  "add_funding_method",
  "remove_funding_method",
  "wallet_funding_high_value",
  "bulk_listing_push",
  "high_risk_order_acceptance",
] as const;

export type DropshipSensitiveAction = typeof dropshipSensitiveActionEnum[number];
export type DropshipStepUpMethod = "passkey" | "email_mfa";
export type DropshipAuthMethod = "passkey" | "password";
export type DropshipEntitlementStatus =
  | "active"
  | "grace"
  | "lapsed"
  | "suspended"
  | "not_entitled";

export interface DropshipAuthenticatedPrincipal {
  memberId: string;
  cardShellzEmail: string;
  hasPasskey: boolean;
  authMethod: DropshipAuthMethod;
}

export interface DropshipSessionPrincipal extends DropshipAuthenticatedPrincipal {
  authIdentityId: number;
  entitlementStatus: Extract<DropshipEntitlementStatus, "active" | "grace">;
  authenticatedAt: string;
}

export const DROPSHIP_PASSWORD_MIN_LENGTH = 12;
export const DROPSHIP_PASSWORD_MAX_LENGTH = 256;
export const DROPSHIP_EMAIL_CHALLENGE_MAX_ATTEMPTS = 5;
export const DROPSHIP_SENSITIVE_ACTION_PROOF_TTL_MINUTES = 10;

export interface DropshipMembershipEntitlementInput {
  memberId: string;
  memberEmail: string | null;
  memberStatus: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  billingStatus: string | null;
  planId: string | null;
  planName: string | null;
  planIncludesDropship: boolean | null;
  planIsActive: boolean | null;
}

export interface DropshipMembershipEntitlementResult {
  memberId: string;
  cardShellzEmail: string | null;
  planId: string | null;
  planName: string | null;
  subscriptionId: string | null;
  includesDropship: boolean;
  status: DropshipEntitlementStatus;
  reasonCode: string;
}

export function normalizeCardShellzEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new DropshipError("INVALID_CARD_SHELLZ_EMAIL", "Card Shellz account email is invalid.", {
      email,
    });
  }

  return normalized;
}

export function assertDropshipPasswordPolicy(password: string): void {
  if (
    password.length < DROPSHIP_PASSWORD_MIN_LENGTH ||
    password.length > DROPSHIP_PASSWORD_MAX_LENGTH
  ) {
    throw new DropshipError("DROPSHIP_PASSWORD_POLICY_FAILED", "Password does not meet length requirements.", {
      minLength: DROPSHIP_PASSWORD_MIN_LENGTH,
      maxLength: DROPSHIP_PASSWORD_MAX_LENGTH,
    });
  }

  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw new DropshipError(
      "DROPSHIP_PASSWORD_POLICY_FAILED",
      "Password must include uppercase, lowercase, and numeric characters.",
    );
  }
}

export function resolveSensitiveActionStepUp(
  principal: DropshipAuthenticatedPrincipal,
  action: DropshipSensitiveAction,
): DropshipStepUpMethod {
  if (!dropshipSensitiveActionEnum.includes(action)) {
    throw new DropshipError("UNKNOWN_DROPSHIP_SENSITIVE_ACTION", "Sensitive action is not recognized.", {
      action,
    });
  }

  return principal.hasPasskey ? "passkey" : "email_mfa";
}

export function evaluateDropshipMembershipEntitlement(
  input: DropshipMembershipEntitlementInput,
): DropshipMembershipEntitlementResult {
  const includesDropship = input.planIncludesDropship === true;
  const planActive = input.planIsActive !== false;
  const memberStatus = (input.memberStatus || "active").toLowerCase();
  const subscriptionStatus = (input.subscriptionStatus || "").toLowerCase();
  const billingStatus = (input.billingStatus || "").toLowerCase();

  if (memberStatus === "suspended" || memberStatus === "disabled" || memberStatus === "closed") {
    return buildEntitlementResult(input, includesDropship, "suspended", "MEMBER_SUSPENDED");
  }

  if (!includesDropship || !planActive) {
    return buildEntitlementResult(input, includesDropship, "not_entitled", "PLAN_NOT_DROPSHIP_ENABLED");
  }

  if (!input.subscriptionId) {
    return buildEntitlementResult(input, includesDropship, "lapsed", "NO_ACTIVE_SUBSCRIPTION");
  }

  if (subscriptionStatus === "active" && (billingStatus === "current" || billingStatus === "")) {
    return buildEntitlementResult(input, includesDropship, "active", "ENTITLED");
  }

  if (subscriptionStatus === "active" && billingStatus === "past_due") {
    return buildEntitlementResult(input, includesDropship, "grace", "BILLING_PAST_DUE_GRACE");
  }

  if (subscriptionStatus === "paused" || billingStatus === "paused") {
    return buildEntitlementResult(input, includesDropship, "suspended", "SUBSCRIPTION_PAUSED");
  }

  return buildEntitlementResult(input, includesDropship, "lapsed", "SUBSCRIPTION_NOT_ACTIVE");
}

function buildEntitlementResult(
  input: DropshipMembershipEntitlementInput,
  includesDropship: boolean,
  status: DropshipEntitlementStatus,
  reasonCode: string,
): DropshipMembershipEntitlementResult {
  return {
    memberId: input.memberId,
    cardShellzEmail: input.memberEmail ? normalizeCardShellzEmail(input.memberEmail) : null,
    planId: input.planId,
    planName: input.planName,
    subscriptionId: input.subscriptionId,
    includesDropship,
    status,
    reasonCode,
  };
}
