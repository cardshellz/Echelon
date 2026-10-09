import type { PendingQuantityPublicationRecovery, QuantityPublicationProviderAnswer,
  QuantityPublicationRequestTermination } from "./types/inventory-publication-recovery";

type UnresolvedAttempt = PendingQuantityPublicationRecovery["unresolvedAttempts"][number];

export const PROVIDER_DISPLAY_NAMES: Readonly<Record<UnresolvedAttempt["providerKey"], string>> =
  Object.freeze({ ebay: "eBay", shopify: "Shopify", walmart: "Walmart" });

/**
 * The attestation an operator records from evidence the system already holds.
 * The single-attempt form and the one-click confirmation build the same words,
 * so the audit trail reads the same whichever path recorded it.
 */
export interface ProviderAnswerEvidence {
  evidenceKind: "provider_terminal_request_record";
  terminalOutcome: "completed";
  evidenceReference: string;
  evidenceHash: string;
  reason: string;
}
export interface RequestTerminationEvidence {
  evidenceKind: "owner_process_and_request_termination_record";
  terminalOutcome: "completed" | "not_sent";
  evidenceReference: string;
  evidenceHash: string;
  reason: string;
}
export type RecoveryEvidence = ProviderAnswerEvidence | RequestTerminationEvidence;

export function formatProviderErrorCodes(codes: readonly string[]): string {
  return codes.length > 0 ? codes.join(", ") : "none supplied";
}

/** Preserve the actual error response without claiming historical quantity effects. */
export function providerAnswerEvidence(
  attempt: Pick<UnresolvedAttempt, "attemptId" | "providerKey">,
  answer: QuantityPublicationProviderAnswer,
): ProviderAnswerEvidence {
  const provider = PROVIDER_DISPLAY_NAMES[attempt.providerKey];
  const codes = formatProviderErrorCodes(answer.errorCodes);
  return {
    evidenceKind: "provider_terminal_request_record",
    terminalOutcome: "completed",
    evidenceReference:
      `Stored provider request ${answer.requestId}: ${answer.method} ${answer.path} answered HTTP ${answer.httpStatus} (codes ${codes}) at ${answer.recordedAt}`,
    evidenceHash: answer.responseHash,
    reason:
      `${provider} answered every request of attempt ${attempt.attemptId}; the last answer was HTTP ${answer.httpStatus} with codes ${codes}. Historical quantity effects have not been verified.`,
  };
}

/**
 * Nothing of the attempt can still reach the provider: its last stored activity
 * lies further back than the request deadline plus the margin. A request that
 * timed out may have been applied, but it cannot still be in flight, so no
 * later write can be overtaken by it; catch-up republishes the current quantity.
 */
export function requestTerminationEvidence(
  attempt: Pick<UnresolvedAttempt, "attemptId" | "providerKey">,
  termination: QuantityPublicationRequestTermination,
): RequestTerminationEvidence {
  const provider = PROVIDER_DISPLAY_NAMES[attempt.providerKey];
  const requests = termination.requestCount === 1 ? "1 request" : `${termination.requestCount} requests`;
  return {
    evidenceKind: "owner_process_and_request_termination_record",
    terminalOutcome: termination.requestCount === 0 ? "not_sent" : "completed",
    evidenceReference:
      `Stored request record of attempt ${attempt.attemptId}: ${requests}; last activity at ${termination.lastActivityAt}; ` +
      `the ${termination.providerRequestTimeoutSeconds}-second provider request deadline and a ${termination.quiescenceMarginMinutes}-minute margin passed at ${termination.quiescentSince}.`,
    evidenceHash: termination.evidenceHash,
    reason:
      `${provider} was last contacted for attempt ${attempt.attemptId} at ${termination.lastActivityAt}; every request of it has been terminated since ${termination.quiescentSince}, ` +
      "so none can still change provider quantities. Catch-up republishes the current quantity.",
  };
}

/**
 * Deterministic keys: confirming the same stored evidence twice replays the
 * same attestation instead of recording a second one. Bounded well under the
 * 200-character key limit (prefix, a 19-digit id and a 64-hex hash).
 */
export function providerAnswerIdempotencyKey(attemptId: string, responseHash: string): string {
  return `provider-answer:${attemptId}:${responseHash}`;
}
export function requestTerminationIdempotencyKey(attemptId: string, evidenceHash: string): string {
  return `request-termination:${attemptId}:${evidenceHash}`;
}

export interface RecoveryEvidenceSelection {
  source: "provider_answer" | "request_termination";
  evidenceHash: string;
  idempotencyKey: string;
  evidence: RecoveryEvidence;
}

/** The evidence on file for an attempt, the provider's refusal first because it names the cause; null when there is none. */
export function selectRecoveryEvidence(
  attempt: Pick<UnresolvedAttempt, "attemptId" | "providerKey" | "providerAnswer" | "requestTermination">,
): RecoveryEvidenceSelection | null {
  if (attempt.providerAnswer) {
    return { source: "provider_answer", evidenceHash: attempt.providerAnswer.responseHash,
      idempotencyKey: providerAnswerIdempotencyKey(attempt.attemptId, attempt.providerAnswer.responseHash),
      evidence: providerAnswerEvidence(attempt, attempt.providerAnswer) };
  }
  if (attempt.requestTermination) {
    return { source: "request_termination", evidenceHash: attempt.requestTermination.evidenceHash,
      idempotencyKey: requestTerminationIdempotencyKey(attempt.attemptId, attempt.requestTermination.evidenceHash),
      evidence: requestTerminationEvidence(attempt, attempt.requestTermination) };
  }
  return null;
}
