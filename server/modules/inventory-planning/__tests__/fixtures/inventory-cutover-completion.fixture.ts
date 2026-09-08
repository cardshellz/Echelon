import type { z } from "zod";
import type { FinishInventoryCutoverResult, InventoryCutoverVerification } from "@shared/types/inventory-cutover-completion";
import type { fullInventoryPublicationEvidenceSchema } from "../../domain/inventory-cutover-full-publication-proof";
import type { InventoryCutoverPublicationIdentity } from "../../domain/inventory-cutover-publication-proof";
import type { QuantityPublicationDrainProof } from "../../domain/quantity-publication-admission";

export const CUTOVER_COMPLETION_NOW = new Date("2026-09-08T20:00:00.000Z");
export const CUTOVER_COMPLETION_HASH = "a".repeat(64);
export const CUTOVER_COMPLETION_REQUEST = {
  activationRunId: "1", expectedVerificationHash: CUTOVER_COMPLETION_HASH,
  idempotencyKey: "finish-1", reason: "Reviewed exact full publication readbacks",
};
export function completionIdentity(): InventoryCutoverPublicationIdentity {
  return { externalInventoryItemId: "item-1", publicationTargetRevision: "2", destinationKind: "channel_connection",
    channelConnectionId: 3, dropshipStoreConnectionId: null, providerScopeType: "location", externalScopeId: "location-1" };
}
export function completionManifest() {
  return [{ id: "10", publication_target_id: 1, product_variant_id: 2, desired_revision: "3", desired_quantity: "5",
    publication_target_revision_snapshot: "2" }];
}
export function completionPublication(): z.infer<typeof fullInventoryPublicationEvidenceSchema> {
  return { publicationId: "10", publicationTargetId: 1, productVariantId: 2, state: "verified", conservativeQuantity: "5",
    acknowledgedAt: "2026-09-08T19:50:00.000Z", observedQuantity: "5", observedAt: "2026-09-08T19:55:00.000Z",
    expectedIdentity: completionIdentity(), observedIdentity: completionIdentity(), outboxIdentity: completionIdentity(),
    desiredRevision: "3", phase: "full", targetState: "live", mappingLifecycle: "sealed" };
}
export function completionDrain(): QuantityPublicationDrainProof {
  return { contractVersion: 1, activationRunId: "1", gateEpoch: "2", suppressed: true, latestAttemptId: "20",
    unresolvedAttempts: [], pendingCatchupCount: 0, latestAttemptsByScope: [{
      scope: { destinationKind: "channel_connection", connectionId: 3, providerKey: "shopify", providerScopeType: "location",
        externalScopeId: "location-1", externalInventoryItemId: "item-1", productId: 1, productVariantId: 2 },
      attemptId: "20", owner: "outbox", outboxId: "10", gateEpoch: "2", completedAt: "2026-09-08T19:51:00.000Z",
      resolutionBasis: "owner_completion",
    }] };
}
export function completionVerification(): InventoryCutoverVerification {
  return { contractVersion: "inventory_cutover_verification_v1", activationRunId: "1", authorityRevision: "3",
    capturedAt: CUTOVER_COMPLETION_NOW.toISOString(), verificationHash: CUTOVER_COMPLETION_HASH,
    ready: true, configurationFreezeOpen: true, completedAt: null, expectedPublicationRows: 1, verifiedPublicationRows: 1,
    publicationRows: [{ publicationTargetId: 1, productVariantId: 2, desiredRevision: "3", desiredQuantity: "5", observedQuantity: "5", state: "verified" }],
    blockers: [], providerWriteAttempted: false, operationalWriteAttempted: false };
}
export function completionResult(): FinishInventoryCutoverResult {
  return { activationRunId: "1", runtimeAuthority: "canonical", authorityRevision: "3", verificationHash: CUTOVER_COMPLETION_HASH,
    verifiedPublicationRows: 1, completedAt: CUTOVER_COMPLETION_NOW.toISOString(), configurationFreezeReleased: true, alreadyApplied: false };
}
