import type { ReturnPolicy } from "../schema";

// Deterministic fictional sample scenarios only. Live returns resolve their window.
export const DEFAULT_CUSTOMER_RETURN_WINDOW_DAYS = 365;
export const MAX_CUSTOMER_RETURN_WINDOW_DAYS = 3650;

/** Supported capabilities of the already-resolved canonical policy.
 * Refund execution remains separately fenced to manual Shopify processing. */
export const CUSTOMER_RETURN_PORTAL_POLICY_REQUIREMENTS = Object.freeze({
  returnDestination: "card_shellz",
  approvalAuthority: "card_shellz",
  labelProvider: "shipstation",
  returnShippingPayer: "card_shellz",
  customerRefundAuthority: "card_shellz",
  inspectionOwner: "card_shellz",
  vendorSettlementTrigger: "none",
} as const);

type PortalPolicyCandidate = Pick<
  ReturnPolicy,
  | "status"
  | "businessContext"
  | "channelId"
  | "vendorId"
  | "storeConnectionId"
  | "returnWindowDays"
  | keyof typeof CUSTOMER_RETURN_PORTAL_POLICY_REQUIREMENTS
>;

export function matchesCustomerReturnPortalPolicy(
  policy: PortalPolicyCandidate,
  channelId: number,
): boolean {
  return customerReturnPortalPolicyIssues(policy, channelId).length === 0;
}

/** Stable, customer-readable capability diagnostics, derived from the same
 * requirements that authorize the resolved policy. Never substitutes a policy. */
export function customerReturnPortalPolicyIssues(
  policy: PortalPolicyCandidate,
  channelId: number,
): string[] {
  const required = CUSTOMER_RETURN_PORTAL_POLICY_REQUIREMENTS;
  const issues: string[] = [];
  if (policy.status !== "active") issues.push("This policy is inactive.");
  if (
    (policy.businessContext !== null && policy.businessContext !== "retail") ||
    (policy.channelId !== null && policy.channelId !== channelId) ||
    policy.vendorId !== null ||
    policy.storeConnectionId !== null
  )
    issues.push("This policy does not apply to this retail Shopify shop.");
  if (
    !Number.isInteger(policy.returnWindowDays) ||
    policy.returnWindowDays < 1 ||
    policy.returnWindowDays > MAX_CUSTOMER_RETURN_WINDOW_DAYS
  )
    issues.push(
      `This policy's return window must be between 1 and ${MAX_CUSTOMER_RETURN_WINDOW_DAYS} days for portal returns.`,
    );
  const labels: Record<keyof typeof required, string> = {
    returnDestination: "return destination",
    approvalAuthority: "return approval",
    labelProvider: "return labels",
    returnShippingPayer: "return shipping",
    customerRefundAuthority: "refund ownership",
    inspectionOwner: "inspection ownership",
    vendorSettlementTrigger: "vendor settlement",
  };
  const values: Record<string, string> = {
    card_shellz: "Card Shellz",
    vendor: "vendor",
    marketplace: "marketplace",
    customer: "customer",
    carrier: "carrier",
    shipstation: "ShipStation",
    none: "none",
    inspection_approved: "inspection-approved",
    customer_refunded: "customer-refunded",
    carrier_claim_paid: "carrier-claim-paid",
  };
  for (const field of Object.keys(required) as Array<keyof typeof required>) {
    if (policy[field] === required[field]) continue;
    const actual = values[policy[field]] ?? "unrecognized";
    const expected = values[required[field]];
    issues.push(
      field === "returnShippingPayer"
        ? `This policy uses ${actual}-paid return shipping; the portal requires ${expected}-paid shipping.`
        : `This policy uses ${actual} for ${labels[field]}; the portal requires ${expected}.`,
    );
  }
  return issues;
}
