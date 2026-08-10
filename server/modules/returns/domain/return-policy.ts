import type { ReturnBusinessContext, ReturnPolicyScopeKind } from "@shared/schema";

export const RETURN_POLICY_SCOPE_RANK: Readonly<Record<ReturnPolicyScopeKind, number>> = {
  global: 100,
  business_context: 200,
  channel_context: 300,
  vendor_context: 400,
  vendor_channel_context: 500,
  store: 600,
};

export interface ReturnPolicyScopeInput {
  scopeKind: ReturnPolicyScopeKind;
  businessContext: ReturnBusinessContext | null;
  channelId: number | null;
  vendorId: number | null;
  storeConnectionId: number | null;
}

export interface ReturnPolicyResolutionInput {
  businessContext: ReturnBusinessContext;
  channelId: number;
  vendorId: number | null;
  storeConnectionId: number | null;
}

export interface ReturnPolicyCandidate extends ReturnPolicyScopeInput {
  id: number;
  name: string;
  version: number;
  status: string;
}

export interface ReturnPolicyResolution<T extends ReturnPolicyCandidate> {
  winner: T;
  matched: Array<{ policy: T; rank: number; reason: string }>;
}

export class ReturnPolicyDomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ReturnPolicyDomainError";
  }
}

function requirePositive(value: number | null, field: string): number {
  if (value === null || !Number.isInteger(value) || value <= 0) {
    throw new ReturnPolicyDomainError("RETURN_POLICY_SCOPE_INVALID", `${field} must be a positive integer for this scope.`, { field, value });
  }
  return value;
}

function requireNull(value: unknown, field: string): void {
  if (value !== null) {
    throw new ReturnPolicyDomainError("RETURN_POLICY_SCOPE_INVALID", `${field} must be empty for this scope.`, { field, value });
  }
}

export function normalizeReturnPolicyScope(input: ReturnPolicyScopeInput): ReturnPolicyScopeInput & { scopeKey: string } {
  const scope = { ...input };
  switch (scope.scopeKind) {
    case "global":
      requireNull(scope.businessContext, "businessContext");
      requireNull(scope.channelId, "channelId");
      requireNull(scope.vendorId, "vendorId");
      requireNull(scope.storeConnectionId, "storeConnectionId");
      return { ...scope, scopeKey: "global" };
    case "business_context":
      if (scope.businessContext === null) throw new ReturnPolicyDomainError("RETURN_POLICY_SCOPE_INVALID", "businessContext is required for this scope.");
      requireNull(scope.channelId, "channelId");
      requireNull(scope.vendorId, "vendorId");
      requireNull(scope.storeConnectionId, "storeConnectionId");
      return { ...scope, scopeKey: `context:${scope.businessContext}` };
    case "channel_context": {
      if (scope.businessContext === null) throw new ReturnPolicyDomainError("RETURN_POLICY_SCOPE_INVALID", "businessContext is required for this scope.");
      const channelId = requirePositive(scope.channelId, "channelId");
      requireNull(scope.vendorId, "vendorId");
      requireNull(scope.storeConnectionId, "storeConnectionId");
      return { ...scope, channelId, scopeKey: `context:${scope.businessContext}:channel:${channelId}` };
    }
    case "vendor_context": {
      if (scope.businessContext !== "dropship") throw new ReturnPolicyDomainError("RETURN_POLICY_SCOPE_INVALID", "Vendor scopes are only valid for dropship returns.");
      const vendorId = requirePositive(scope.vendorId, "vendorId");
      requireNull(scope.channelId, "channelId");
      requireNull(scope.storeConnectionId, "storeConnectionId");
      return { ...scope, vendorId, scopeKey: `context:dropship:vendor:${vendorId}` };
    }
    case "vendor_channel_context": {
      if (scope.businessContext !== "dropship") throw new ReturnPolicyDomainError("RETURN_POLICY_SCOPE_INVALID", "Vendor/channel scopes are only valid for dropship returns.");
      const vendorId = requirePositive(scope.vendorId, "vendorId");
      const channelId = requirePositive(scope.channelId, "channelId");
      requireNull(scope.storeConnectionId, "storeConnectionId");
      return { ...scope, vendorId, channelId, scopeKey: `context:dropship:vendor:${vendorId}:channel:${channelId}` };
    }
    case "store": {
      if (scope.businessContext !== "dropship") throw new ReturnPolicyDomainError("RETURN_POLICY_SCOPE_INVALID", "Store scopes are only valid for dropship returns.");
      const vendorId = requirePositive(scope.vendorId, "vendorId");
      const channelId = requirePositive(scope.channelId, "channelId");
      const storeConnectionId = requirePositive(scope.storeConnectionId, "storeConnectionId");
      return { ...scope, vendorId, channelId, storeConnectionId, scopeKey: `context:dropship:vendor:${vendorId}:channel:${channelId}:store:${storeConnectionId}` };
    }
  }
}

export function returnPolicyMatches(candidate: ReturnPolicyCandidate, input: ReturnPolicyResolutionInput): boolean {
  if (candidate.status !== "active") return false;
  switch (candidate.scopeKind) {
    case "global":
      return true;
    case "business_context":
      return candidate.businessContext === input.businessContext;
    case "channel_context":
      return candidate.businessContext === input.businessContext && candidate.channelId === input.channelId;
    case "vendor_context":
      return input.businessContext === "dropship" && input.vendorId !== null && candidate.vendorId === input.vendorId;
    case "vendor_channel_context":
      return input.businessContext === "dropship" && input.vendorId !== null && candidate.vendorId === input.vendorId && candidate.channelId === input.channelId;
    case "store":
      return input.businessContext === "dropship" && input.vendorId !== null && input.storeConnectionId !== null && candidate.vendorId === input.vendorId && candidate.channelId === input.channelId && candidate.storeConnectionId === input.storeConnectionId;
  }
}

function matchReason(candidate: ReturnPolicyCandidate): string {
  switch (candidate.scopeKind) {
    case "global": return "Global fallback";
    case "business_context": return `Matches ${candidate.businessContext} returns`;
    case "channel_context": return `Matches ${candidate.businessContext} channel ${candidate.channelId}`;
    case "vendor_context": return `Matches dropship vendor ${candidate.vendorId}`;
    case "vendor_channel_context": return `Matches dropship vendor ${candidate.vendorId} on channel ${candidate.channelId}`;
    case "store": return `Matches store connection ${candidate.storeConnectionId}`;
  }
}

export function resolveReturnPolicy<T extends ReturnPolicyCandidate>(candidates: readonly T[], input: ReturnPolicyResolutionInput): ReturnPolicyResolution<T> | null {
  const matched = candidates
    .filter((candidate) => returnPolicyMatches(candidate, input))
    .map((policy) => ({ policy, rank: RETURN_POLICY_SCOPE_RANK[policy.scopeKind], reason: matchReason(policy) }))
    .sort((left, right) => right.rank - left.rank);
  if (matched.length === 0) return null;

  const winnerRank = matched[0].rank;
  const winners = matched.filter((match) => match.rank === winnerRank);
  if (winners.length !== 1) {
    throw new ReturnPolicyDomainError(
      "RETURN_POLICY_AMBIGUOUS",
      "Multiple active return policies have equal specificity for this return.",
      { policyIds: winners.map(({ policy }) => policy.id), rank: winnerRank },
    );
  }
  return { winner: winners[0].policy, matched };
}
