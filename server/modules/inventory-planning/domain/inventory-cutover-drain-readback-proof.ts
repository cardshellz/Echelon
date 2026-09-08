import { canonicalJson } from "@shared/utils/canonical-json";
import type { InventoryCutoverReview } from "@shared/types/inventory-cutover-commit";
import { quantityPublicationDrainProofSchema, type QuantityPublicationDrainProof } from "./quantity-publication-admission";
import { inventoryCutoverConservativePublicationEvidenceSchema } from "./inventory-cutover-publication-proof";

/** A readback must follow the last admitted write for its exact external item.
 * Operator terminal attestations remain distinguishable in the hashed proof;
 * they are not relabeled as machine-verified provider outcomes.
 */
export function validateCutoverDrainReadbacks(rawProof: unknown, runId: string, rawReadbacks: unknown): InventoryCutoverReview["blockers"] {
  const parsed = quantityPublicationDrainProofSchema.safeParse(rawProof);
  if (!parsed.success || parsed.data.activationRunId !== runId || !parsed.data.suppressed) return [{
    code: "CUTOVER_PUBLICATION_SUPPRESSION_MISSING", subject: "publications", message: "The prepared run must own durable quantity-publication suppression.",
  }];
  const proof: QuantityPublicationDrainProof = parsed.data;
  if (!Array.isArray(rawReadbacks) || rawReadbacks.length > 100_000) return [{
    code: "CUTOVER_PUBLICATION_DRAIN_READBACK_INVALID", subject: "publications",
    message: "Publication drain requires a bounded complete readback array.",
  }];
  const blockers: InventoryCutoverReview["blockers"] = proof.unresolvedAttempts.map(attempt => ({
    code: "CUTOVER_PUBLICATION_OUTCOME_UNRESOLVED", subject: `attempt:${attempt.attemptId}`,
    message: "An admitted provider request has no definitive terminal record. Inspect its owner or explicit recovery evidence before cutover.",
  }));
  // Index once so a complete catalog review is linear in attempts + readbacks,
  // rather than rescanning every historical external scope for every SKU.
  const latestByScope = new Map<string, QuantityPublicationDrainProof["latestAttemptsByScope"]>();
  for (const attempt of proof.latestAttemptsByScope) {
    const key = canonicalJson({ destinationKind: attempt.scope.destinationKind, connectionId: attempt.scope.connectionId,
      providerScopeType: attempt.scope.providerScopeType, externalScopeId: attempt.scope.externalScopeId,
      externalInventoryItemId: attempt.scope.externalInventoryItemId });
    const existing = latestByScope.get(key);
    if (existing) existing.push(attempt);
    else latestByScope.set(key, [attempt]);
  }
  for (const raw of rawReadbacks) {
    const readback = inventoryCutoverConservativePublicationEvidenceSchema.strip().safeParse(raw);
    if (!readback.success) {
      blockers.push({ code: "CUTOVER_PUBLICATION_DRAIN_READBACK_INVALID", subject: "publications",
        message: "Malformed readback evidence cannot establish publication drain." });
      continue;
    }
    const row = readback.data;
    const identity = row.expectedIdentity;
    const scopeKey = canonicalJson({ destinationKind: identity.destinationKind,
      connectionId: identity.channelConnectionId ?? identity.dropshipStoreConnectionId,
      providerScopeType: identity.providerScopeType, externalScopeId: identity.externalScopeId,
      externalInventoryItemId: identity.externalInventoryItemId });
    const latest = latestByScope.get(scopeKey) ?? [];
    if (latest.length !== 1 || latest.some(attempt => attempt.owner !== "outbox"
      || attempt.outboxId !== row.publicationId
      || attempt.resolutionBasis === null
      || BigInt(attempt.gateEpoch) !== BigInt(proof.gateEpoch)
      || BigInt(attempt.attemptId) > BigInt(proof.latestAttemptId)
      || attempt.completedAt === null || row.observedAt === null
      || Date.parse(attempt.completedAt) > new Date(row.observedAt).getTime())) {
      blockers.push({ code: "CUTOVER_READBACK_PREDATES_PUBLICATION_DRAIN", subject: `${row.publicationTargetId}:${row.productVariantId}`,
        message: "Obtain an exact-item readback tied to this admitted outbox request after its terminal completion or explicit reconciliation." });
    }
  }
  return blockers;
}
