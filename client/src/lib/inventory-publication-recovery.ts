import type { PendingQuantityPublicationRecovery } from "@shared/types/inventory-publication-recovery";

type UnresolvedAttempt = PendingQuantityPublicationRecovery["unresolvedAttempts"][number];

export interface AttestationPrefill {
  evidenceKind: "provider_terminal_request_record";
  terminalOutcome: "completed";
  evidenceReference: string;
  evidenceHash: string;
  reason: string;
  /** One paragraph for the operator: what the provider answered and what it means. */
  summary: string;
}

const PROVIDER_NAMES: Record<UnresolvedAttempt["providerKey"], string> = { ebay: "eBay", shopify: "Shopify", walmart: "Walmart" };

/**
 * Fills the attestation form from the provider's stored answer, when the
 * server found one: the provider refused the last request with a 4xx, so the
 * request completed and can no longer change quantities. The operator still
 * reads it, ticks the confirmation and records it; nothing is submitted here.
 */
export function attestationPrefillFromProviderAnswer(attempt: UnresolvedAttempt): AttestationPrefill | null {
  const answer = attempt.providerAnswer;
  if (!answer) return null;
  const provider = PROVIDER_NAMES[attempt.providerKey];
  const codes = answer.errorCodes.length > 0 ? answer.errorCodes.join(", ") : "none supplied";
  return {
    evidenceKind: "provider_terminal_request_record",
    terminalOutcome: "completed",
    evidenceReference:
      `Stored provider request ${answer.requestId}: ${answer.method} ${answer.path} answered HTTP ${answer.httpStatus} (codes ${codes}) at ${answer.recordedAt}`,
    evidenceHash: answer.responseHash,
    reason:
      `${provider} answered every request of attempt ${attempt.attemptId}; the last answer was HTTP ${answer.httpStatus} with codes ${codes}, a refusal that wrote no quantity.`,
    summary:
      `${provider} answered HTTP ${answer.httpStatus} (codes ${codes}) to ${answer.method} ${answer.path} at ${answer.recordedAt}. ` +
      "That is a refusal: nothing was written, so this request can no longer change quantities. The fields below are filled from that stored answer.",
  };
}

/** The option label's tail: whether the provider's answer is on file. */
export function providerAnswerLabel(attempt: UnresolvedAttempt): string {
  return attempt.providerAnswer ? ` · answered HTTP ${attempt.providerAnswer.httpStatus}` : "";
}
