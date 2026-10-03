import type {
  ReturnPolicy,
  ReturnPolicyScopeKind,
  ReturnBusinessContext,
} from "@shared/schema";
import { customerReturnPortalPolicyIssues } from "@shared/returns/customer-return-portal-policy";
import {
  customerReturnResolvedPolicySchema,
  customerReturnPolicyIssueSchema,
  type CustomerReturnLabelSettings,
} from "@shared/returns/customer-return-label.contract";
import {
  resolveReturnPolicy,
  normalizeReturnPolicyScope,
  ReturnPolicyDomainError,
} from "../domain/return-policy";
import { snapshotReturnPolicy } from "../domain/return-case";
import { parseReturnPolicySnapshot } from "../domain/return-case-actions";

export interface CustomerReturnPortalPolicyReader {
  read(channelId: number): Promise<(ReturnPolicy & { shipping?: CustomerReturnLabelSettings | null })[]>;
}

/** Resolve first. An unsupported channel winner must never disappear and allow
 * a less-specific policy to authorize the same customer return. */
export function resolveCustomerReturnPortalPolicy(
  policies: readonly (ReturnPolicy & { shipping?: CustomerReturnLabelSettings | null })[],
  channelId: number,
) {
  try {
    const candidates = policies.map((policy) => {
      const scope = normalizeReturnPolicyScope({
        channelId: policy.channelId,
        vendorId: policy.vendorId,
        storeConnectionId: policy.storeConnectionId,
        scopeKind: policy.scopeKind as ReturnPolicyScopeKind,
        businessContext: policy.businessContext as ReturnBusinessContext | null,
      });
      if (!scope || scope.scopeKey !== policy.scopeKey)
        throw new Error("Invalid policy scope.");
      parseReturnPolicySnapshot(snapshotReturnPolicy(policy));
      return { ...policy, ...scope };
    });
    const resolved = resolveReturnPolicy(candidates, {
      businessContext: "retail",
      channelId,
      vendorId: null,
      storeConnectionId: null,
    });
    if (!resolved)
      return {
        policy: null,
        resolvedPolicy: null,
        policyIssue: issue(
          "RETURN_PORTAL_POLICY_MISSING",
          "No active return policy applies to this Shopify shop. Configure its return policy before starting a return.",
        ),
      };
    const policy = resolved.winner;
    const unsupported = customerReturnPortalPolicyIssues(policy, channelId);
    return {
      policy,
      resolvedPolicy: customerReturnResolvedPolicySchema.parse({
        id: policy.id,
        name: policy.name,
        version: policy.version,
        returnWindowDays: policy.returnWindowDays,
        scopeKind: policy.scopeKind,
      }),
      policyIssue:
        unsupported.length === 0
          ? null
          : issue(
              "RETURN_PORTAL_POLICY_UNSUPPORTED",
              unsupportedMessage(unsupported),
            ),
    };
  } catch (error) {
    const ambiguous =
      error instanceof ReturnPolicyDomainError &&
      error.code === "RETURN_POLICY_AMBIGUOUS";
    return {
      policy: null,
      resolvedPolicy: null,
      policyIssue: issue(
        ambiguous
          ? "RETURN_PORTAL_POLICY_AMBIGUOUS"
          : "RETURN_PORTAL_POLICY_INVALID",
        "The applicable return policy could not be verified. Review the active policy scopes before starting a return.",
      ),
    };
  }
}

function issue(code: string, message: string) {
  return customerReturnPolicyIssueSchema.parse({ code, message });
}

function unsupportedMessage(issues: readonly string[]): string {
  const visible: string[] = [];
  for (const message of issues) {
    if ([...visible, message].join(" ").length > 430) break;
    visible.push(message);
  }
  const remaining = issues.length - visible.length;
  return (
    visible.join(" ") +
    (remaining > 0
      ? ` ${remaining} other policy settings also need attention.`
      : "")
  );
}
