import type { QuantityPublicationScope } from "./quantity-publication-admission";

/** Finality means an earlier request cannot arrive later. It does not mean its
 * requested quantity was applied, or authorize replay of its old quantity. */
export interface QuantityProviderFinalityEvidence {
  state: string;
  resolutionBasis: string | null;
  requestCount: number;
  unfinishedRequestCount: number;
  completedRequestCount: number;
  hasRequestJournalContract: boolean;
  hasResponseRecoveryReceipt: boolean;
}

export function hasFinalQuantityProviderOutcome(evidence: QuantityProviderFinalityEvidence): boolean {
  if (evidence.state === "not_sent") {
    return evidence.resolutionBasis === "owner_preflight_no_request" && evidence.requestCount === 0;
  }
  if (evidence.state === "rejected") {
    return evidence.resolutionBasis === "provider_rejection" && evidence.hasRequestJournalContract && evidence.requestCount > 0
      && evidence.unfinishedRequestCount === 0;
  }
  // A completion can be recovered after its caller loses the queue lease only
  // if a versioned transport contract covered every mutation and all recorded
  // requests have terminal successful responses. This proves finality, not the
  // quantity that a new owner should publish.
  if (evidence.state === "succeeded") {
    return evidence.resolutionBasis === "owner_completion" && evidence.hasRequestJournalContract
      && evidence.requestCount > 0 && evidence.unfinishedRequestCount === 0
      && evidence.completedRequestCount === evidence.requestCount;
  }
  // Inventory's response-recovery command validates and immutably records the
  // complete journal under the exact provider scope locks before this state.
  return evidence.state === "resolved" && evidence.resolutionBasis === "provider_response_terminal"
    && evidence.hasRequestJournalContract && evidence.hasResponseRecoveryReceipt;
}

/** Local product IDs are provenance, not part of the remote provider scope. */
export function sameQuantityProviderScope(left: QuantityPublicationScope, right: QuantityPublicationScope): boolean {
  return left.destinationKind === right.destinationKind && left.connectionId === right.connectionId
    && left.providerKey === right.providerKey && left.providerScopeType === right.providerScopeType
    && left.externalScopeId === right.externalScopeId && left.externalInventoryItemId === right.externalInventoryItemId;
}
