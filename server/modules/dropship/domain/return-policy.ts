/**
 * Dropship return policy scope precedence (design spec D1/D2).
 *
 * Pure domain logic shared by the SQL resolver and tests: given candidate
 * policy rows, pick the winner by scope specificity (vendor+store > vendor >
 * store > global), then priority DESC, then id DESC. The PG repository's
 * resolver query mirrors this ordering exactly; keeping the comparison here
 * makes the precedence rule unit-testable without a database.
 */

export type ReturnPolicyScope = "global" | "store" | "vendor" | "vendor_store";

export interface ReturnPolicyScopeCandidate {
  id: number;
  vendorId: number | null;
  storeConnectionId: number | null;
  priority: number;
  isActive: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

const SCOPE_SPECIFICITY: Record<ReturnPolicyScope, number> = {
  global: 1,
  store: 2,
  vendor: 3,
  vendor_store: 4,
};

export function returnPolicyScopeFor(candidate: Pick<ReturnPolicyScopeCandidate, "vendorId" | "storeConnectionId">): ReturnPolicyScope {
  if (candidate.vendorId !== null && candidate.storeConnectionId !== null) return "vendor_store";
  if (candidate.vendorId !== null) return "vendor";
  if (candidate.storeConnectionId !== null) return "store";
  return "global";
}

export function returnPolicyScopeMatches(
  candidate: Pick<ReturnPolicyScopeCandidate, "vendorId" | "storeConnectionId">,
  scope: { vendorId: number | null; storeConnectionId: number | null },
): boolean {
  const candidateScope = returnPolicyScopeFor(candidate);
  switch (candidateScope) {
    case "global":
      return true;
    case "store":
      return scope.storeConnectionId !== null && candidate.storeConnectionId === scope.storeConnectionId;
    case "vendor":
      return scope.vendorId !== null && candidate.vendorId === scope.vendorId;
    case "vendor_store":
      return scope.vendorId !== null
        && scope.storeConnectionId !== null
        && candidate.vendorId === scope.vendorId
        && candidate.storeConnectionId === scope.storeConnectionId;
  }
}

export function isReturnPolicyEffectiveAt(
  candidate: Pick<ReturnPolicyScopeCandidate, "isActive" | "effectiveFrom" | "effectiveTo">,
  at: Date,
): boolean {
  if (!candidate.isActive) return false;
  if (candidate.effectiveFrom.getTime() > at.getTime()) return false;
  if (candidate.effectiveTo !== null && candidate.effectiveTo.getTime() <= at.getTime()) return false;
  return true;
}

/**
 * Ordering comparator: higher-precedence candidate sorts first.
 * Returns a negative number when `left` beats `right`.
 */
export function compareReturnPolicyPrecedence(
  left: ReturnPolicyScopeCandidate,
  right: ReturnPolicyScopeCandidate,
): number {
  const specificityDelta = SCOPE_SPECIFICITY[returnPolicyScopeFor(right)]
    - SCOPE_SPECIFICITY[returnPolicyScopeFor(left)];
  if (specificityDelta !== 0) return specificityDelta;
  if (left.priority !== right.priority) return right.priority - left.priority;
  return right.id - left.id;
}

/**
 * Pick the winning candidate for a scope at a point in time, or null when no
 * candidate matches. Candidates are filtered to active + effective rows whose
 * scope matches, then ordered by the precedence comparator.
 */
export function selectReturnPolicyCandidate<T extends ReturnPolicyScopeCandidate>(
  candidates: readonly T[],
  scope: { vendorId: number | null; storeConnectionId: number | null },
  at: Date,
): T | null {
  const eligible = candidates
    .filter((candidate) => returnPolicyScopeMatches(candidate, scope))
    .filter((candidate) => isReturnPolicyEffectiveAt(candidate, at));
  if (eligible.length === 0) return null;
  const sorted = [...eligible].sort(compareReturnPolicyPrecedence);
  return sorted[0] ?? null;
}
