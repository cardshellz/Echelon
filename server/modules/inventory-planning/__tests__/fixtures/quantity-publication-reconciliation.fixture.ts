import { reviewPublicationReconciliation, type PublicationReconciliationEvidence } from "../../domain/quantity-publication-reconciliation";
import type { PublicationReconciliationResult } from "@shared/types/inventory-publication-reconciliation";

export const reconciliationNow = new Date("2026-09-29T12:00:00.000Z");
export function reconciliationEvidence(): PublicationReconciliationEvidence {
  const scope = { destinationKind: "channel_connection" as const, connectionId: 7, providerKey: "shopify" as const,
    providerScopeType: "location" as const, externalScopeId: "test-location", externalInventoryItemId: "test-item", productId: 20, productVariantId: 101 };
  return { activationRunId: "8", gateEpoch: "3", destinations: [{ publicationTargetId: 1, targetRevision: "2",
    destinationKind: scope.destinationKind, connectionId: scope.connectionId, providerKey: scope.providerKey,
    providerScopeType: scope.providerScopeType, externalScopeId: scope.externalScopeId }],
    attempts: [{ id: "12", owner: "legacy", state: "uncertain", gateEpoch: "1", startedAt: "2026-09-28T00:00:00.000Z",
      scope, affectedScopes: [scope], evidenceHash: "a".repeat(64) }], publicationRows: 1, publicationManifestHash: "b".repeat(64) };
}
export const reconciliationReview = () => reviewPublicationReconciliation(reconciliationEvidence(), reconciliationNow);
export const reconciliationRequest = () => ({ activationRunId: "8", expectedReviewHash: reconciliationReview().reviewHash,
  acceptUnknownRemoteOutcomes: true as const, reason: "Replace obsolete requests with fresh current quantity writes", idempotencyKey: "reconcile-8" });
export const reconciliationResult = (): PublicationReconciliationResult => ({ reconciliationId: "1", activationRunId: "8",
  reviewHash: reconciliationReview().reviewHash, supersededAttemptIds: ["12"], historicalOutcome: "unknown",
  requiredNextStep: "publish_and_verify_current_quantities", providerWriteAttempted: false, runtimeAuthorityChanged: false, replay: false });
