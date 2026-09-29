import { publicationReconciliationDestinationSchema, publicationReconciliationEvidenceSchema, publicationReconciliationReviewSchema,
  type PublicationReconciliationDestination, type PublicationReconciliationReview } from "@shared/types/inventory-publication-reconciliation";
import { inventoryCutoverEvidenceHash } from "./inventory-cutover-manifest";
import { quantityPublicationScopeSchema } from "./quantity-publication-admission";

export class PublicationReconciliationEvidenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PublicationReconciliationEvidenceError";
  }
}

export interface PublicationReconciliationAttemptEvidence {
  id: string; owner: string; state: string; gateEpoch: string; startedAt: string;
  scope: unknown; affectedScopes: unknown; evidenceHash: string;
}
export interface PublicationReconciliationEvidence {
  activationRunId: string; gateEpoch: string; destinations: PublicationReconciliationDestination[];
  attempts: PublicationReconciliationAttemptEvidence[]; publicationRows: number; publicationManifestHash: string;
}

function destinationMatches(destination: PublicationReconciliationDestination, scope: ReturnType<typeof quantityPublicationScopeSchema.parse>): boolean {
  return destination.destinationKind === scope.destinationKind && destination.connectionId === scope.connectionId
    && destination.providerKey === scope.providerKey && destination.providerScopeType === scope.providerScopeType
    && destination.externalScopeId === scope.externalScopeId;
}

/** Explicit retirement of obsolete LOCAL authority, not evidence of remote termination or success.
 * Every member of a grouped write must belong to an already reviewed destination.
 * Async item-setup feeds and outbox attempts cannot use this legacy-only recovery.
 */
export function reviewPublicationReconciliation(raw: PublicationReconciliationEvidence, capturedAt: Date): PublicationReconciliationReview {
  const parsed = publicationReconciliationEvidenceSchema.safeParse(raw);
  if (!parsed.success || !(capturedAt instanceof Date) || !Number.isFinite(capturedAt.getTime())) {
    throw new PublicationReconciliationEvidenceError("PUBLICATION_RECONCILIATION_EVIDENCE_INVALID", "The complete reconciliation evidence or observation time is invalid.");
  }
  const input = parsed.data;
  const destinations = input.destinations.map(value => publicationReconciliationDestinationSchema.parse(value));
  if (new Set(destinations.map(value => value.publicationTargetId)).size !== destinations.length) {
    throw new PublicationReconciliationEvidenceError("PUBLICATION_RECONCILIATION_DESTINATION_AMBIGUOUS", "Prepared destination ownership is ambiguous.");
  }
  const attempts: PublicationReconciliationReview["attempts"] = [];
  for (const attempt of input.attempts) {
    const scope = quantityPublicationScopeSchema.safeParse(attempt.scope);
    const members = quantityPublicationScopeSchema.array().min(1).max(1000).safeParse(attempt.affectedScopes);
    if (!scope.success || !members.success) {
      throw new PublicationReconciliationEvidenceError("PUBLICATION_RECONCILIATION_EVIDENCE_INVALID", "Historical request scope evidence is incomplete; no partial recovery is permitted.");
    }
    const allScopes = [scope.data, ...members.data];
    const matches = allScopes.map(member => destinations.filter(destination => destinationMatches(destination, member)));
    // Unrelated destinations are not authorized for retirement by this command.
    if (matches.every(values => values.length === 0)) continue;
    if (matches.some(values => values.length !== 1)) {
      throw new PublicationReconciliationEvidenceError("PUBLICATION_RECONCILIATION_SCOPE_INCOMPLETE", "A grouped historical write crosses the reviewed destination boundary.");
    }
    if (attempt.owner !== "legacy" || !["running", "uncertain"].includes(attempt.state)
      || BigInt(attempt.gateEpoch) >= BigInt(input.gateEpoch)) {
      throw new PublicationReconciliationEvidenceError("PUBLICATION_RECONCILIATION_ATTEMPT_NOT_LEGACY", "Only prior-epoch legacy attempts can be superseded; current or asynchronous owners require separate recovery.");
    }
    attempts.push({ attemptId: attempt.id, state: attempt.state as "running" | "uncertain", gateEpoch: attempt.gateEpoch,
      startedAt: attempt.startedAt, evidenceHash: attempt.evidenceHash,
      publicationTargetIds: [...new Set(matches.flat().map(value => value.publicationTargetId))].sort((a,b) => a-b) });
  }
  attempts.sort((a,b) => BigInt(a.attemptId) < BigInt(b.attemptId) ? -1 : BigInt(a.attemptId) > BigInt(b.attemptId) ? 1 : 0);
  if (new Set(attempts.map(attempt => attempt.attemptId)).size !== attempts.length) {
    throw new PublicationReconciliationEvidenceError("PUBLICATION_RECONCILIATION_ATTEMPT_DUPLICATE", "The complete historical attempt census contains duplicate identities.");
  }
  const stable = { activationRunId: input.activationRunId, gateEpoch: input.gateEpoch,
    destinations: [...destinations].sort((a,b) => a.publicationTargetId-b.publicationTargetId), attempts,
    publicationRows: input.publicationRows, publicationManifestHash: input.publicationManifestHash,
    historicalOutcome: "unknown" as const, requiredNextStep: "publish_and_verify_current_quantities" as const };
  return publicationReconciliationReviewSchema.parse({ ...stable, capturedAt: capturedAt.toISOString(),
    reviewHash: inventoryCutoverEvidenceHash(stable), ready: attempts.length > 0, providerWriteAttempted: false });
}
