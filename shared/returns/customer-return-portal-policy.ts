import type { ReturnPolicy } from "../schema";

export const DEFAULT_CUSTOMER_RETURN_WINDOW_DAYS = 365;

/** Operational requirements shared by portal setup and the saved-policy filter.
 * Refund execution remains separately fenced to manual Shopify processing. */
export const CUSTOMER_RETURN_PORTAL_POLICY_REQUIREMENTS = Object.freeze({
  returnWindowDays: DEFAULT_CUSTOMER_RETURN_WINDOW_DAYS,
  returnDestination: "card_shellz",
  approvalAuthority: "card_shellz",
  labelProvider: "shipstation",
  returnShippingPayer: "card_shellz",
  customerRefundAuthority: "card_shellz",
  inspectionOwner: "card_shellz",
  vendorSettlementTrigger: "none",
} as const);

/** A reviewable creation preset, never an automatic policy or database seed.
 * Inspection/returnless defaults match the existing policy editor. They are
 * deliberately not additional restrictions on already compatible policies. */
export const CUSTOMER_RETURN_PORTAL_POLICY_DEFAULTS = Object.freeze({
  ...CUSTOMER_RETURN_PORTAL_POLICY_REQUIREMENTS,
  inspectionRequirement: "required",
  returnlessRefundAllowed: false,
} as const);

type PortalPolicyCandidate = Pick<
  ReturnPolicy,
  | "status"
  | "businessContext"
  | "channelId"
  | "vendorId"
  | "storeConnectionId"
  | keyof typeof CUSTOMER_RETURN_PORTAL_POLICY_REQUIREMENTS
>;

export function matchesCustomerReturnPortalPolicy(
  policy: PortalPolicyCandidate,
  channelId: number,
): boolean {
  const required = CUSTOMER_RETURN_PORTAL_POLICY_REQUIREMENTS;
  return (
    policy.status === "active" &&
    (policy.businessContext === null || policy.businessContext === "retail") &&
    (policy.channelId === null || policy.channelId === channelId) &&
    policy.vendorId === null &&
    policy.storeConnectionId === null &&
    policy.returnWindowDays === required.returnWindowDays &&
    policy.returnDestination === required.returnDestination &&
    policy.approvalAuthority === required.approvalAuthority &&
    policy.labelProvider === required.labelProvider &&
    policy.returnShippingPayer === required.returnShippingPayer &&
    policy.customerRefundAuthority === required.customerRefundAuthority &&
    policy.inspectionOwner === required.inspectionOwner &&
    policy.vendorSettlementTrigger === required.vendorSettlementTrigger
  );
}
