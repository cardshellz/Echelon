import type { PendingQuantityPublicationRecovery, QuantityPublicationProviderAnswer } from "./types/inventory-publication-recovery";

type UnresolvedAttempt = PendingQuantityPublicationRecovery["unresolvedAttempts"][number];

export const PROVIDER_DISPLAY_NAMES: Readonly<Record<UnresolvedAttempt["providerKey"], string>> =
  Object.freeze({ ebay: "eBay", shopify: "Shopify", walmart: "Walmart" });

/**
 * The attestation an operator records for an attempt whose stored provider
 * answer proves a refusal. The single-attempt form and the one-click
 * confirmation build the same words, so the audit trail reads the same
 * whichever path recorded it.
 */
export interface ProviderAnswerEvidence {
  evidenceKind: "provider_terminal_request_record";
  terminalOutcome: "completed";
  evidenceReference: string;
  evidenceHash: string;
  reason: string;
}

export function formatProviderErrorCodes(codes: readonly string[]): string {
  return codes.length > 0 ? codes.join(", ") : "none supplied";
}

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
      `${provider} answered every request of attempt ${attempt.attemptId}; the last answer was HTTP ${answer.httpStatus} with codes ${codes}, a refusal that wrote no quantity.`,
  };
}

/**
 * Deterministic key: confirming the same stored answer twice replays the same
 * attestation instead of recording a second one. Bounded well under the
 * 200-character key limit (prefix, a 19-digit id and a 64-hex hash).
 */
export function providerAnswerIdempotencyKey(attemptId: string, responseHash: string): string {
  return `provider-answer:${attemptId}:${responseHash}`;
}
