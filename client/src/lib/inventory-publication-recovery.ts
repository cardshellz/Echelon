import type { PendingQuantityPublicationRecovery, QuantityPublicationProviderAnswerRecovery,
  QuantityPublicationProviderAnswerRecoveryResult, QuantityPublicationProviderAnswerSkipReason } from "@shared/types/inventory-publication-recovery";
import { PROVIDER_DISPLAY_NAMES, formatProviderErrorCodes, providerAnswerEvidence,
  type ProviderAnswerEvidence } from "@shared/inventory-publication-recovery-evidence";

type UnresolvedAttempt = PendingQuantityPublicationRecovery["unresolvedAttempts"][number];

export interface AttestationPrefill extends ProviderAnswerEvidence {
  /** One paragraph for the operator: what the provider answered and what it means. */
  summary: string;
}

/**
 * Fills the attestation form from the provider's stored answer, when the
 * server found one: the provider refused the last request with a 4xx, so the
 * request completed and can no longer change quantities. The operator still
 * reads it, ticks the confirmation and records it; nothing is submitted here.
 */
export function attestationPrefillFromProviderAnswer(attempt: UnresolvedAttempt): AttestationPrefill | null {
  const answer = attempt.providerAnswer;
  if (!answer) return null;
  const provider = PROVIDER_DISPLAY_NAMES[attempt.providerKey];
  const codes = formatProviderErrorCodes(answer.errorCodes);
  return {
    ...providerAnswerEvidence(attempt, answer),
    summary:
      `${provider} answered HTTP ${answer.httpStatus} (codes ${codes}) to ${answer.method} ${answer.path} at ${answer.recordedAt}. ` +
      "That is a refusal: nothing was written, so this request can no longer change quantities. The fields below are filled from that stored answer.",
  };
}

/** The option label's tail: whether the provider's answer is on file. */
export function providerAnswerLabel(attempt: UnresolvedAttempt): string {
  return attempt.providerAnswer ? ` · answered HTTP ${attempt.providerAnswer.httpStatus}` : "";
}

/** The one-click confirmation: every listed attempt with an answer on file, pinned to the hash the operator saw. */
export function providerAnswerConfirmations(
  attempts: readonly UnresolvedAttempt[],
): QuantityPublicationProviderAnswerRecovery["confirmations"] {
  return attempts.flatMap(attempt => attempt.providerAnswer
    ? [{ attemptId: attempt.attemptId, responseHash: attempt.providerAnswer.responseHash }]
    : []);
}

/** What the one-click confirmation covers, or null when no listed attempt has an answer on file. */
export function describeProviderAnswerBatch(attempts: readonly UnresolvedAttempt[]): string | null {
  const answered = attempts.filter(attempt => attempt.providerAnswer);
  if (answered.length === 0) return null;
  const providers = [...new Set(answered.map(attempt => PROVIDER_DISPLAY_NAMES[attempt.providerKey]))].sort();
  const who = providers.length === 1 ? providers[0] : "The marketplaces";
  const covered = `${who} refused ${answered.length} of the ${attempts.length} listed ${attempts.length === 1 ? "request" : "requests"}, and each refusal is on file. ` +
    `${answered.length === 1 ? "That request" : "Those requests"} wrote nothing, so ${answered.length === 1 ? "it" : "they"} can be confirmed together.`;
  const rest = attempts.length - answered.length;
  if (rest === 0) return covered;
  return `${covered} The other ${rest === 1 ? "entry stays" : `${rest} entries stay`} listed because no answer is on file for ${rest === 1 ? "it" : "them"}.`;
}

const SKIP_REASON_WORDS: Readonly<Record<QuantityPublicationProviderAnswerSkipReason, string>> = Object.freeze({
  not_pending: "no longer listed",
  no_provider_answer: "no answer on file",
  answer_changed: "answer changed since it was shown",
  owner_conflict: "resolved by someone else meanwhile",
});

/** One line after the one-click confirmation: what was recorded, what was skipped and why. */
export function describeProviderAnswerResult(result: QuantityPublicationProviderAnswerRecoveryResult): string {
  const fresh = result.confirmed.filter(row => !row.replay).length;
  const replayed = result.confirmed.length - fresh;
  const parts = [`Confirmed ${fresh} ${fresh === 1 ? "entry" : "entries"}`];
  if (replayed > 0) parts.push(`${replayed} already recorded`);
  if (result.skipped.length > 0) {
    const reasons = [...new Set(result.skipped.map(row => SKIP_REASON_WORDS[row.reason]))].join("; ");
    parts.push(`${result.skipped.length} skipped (${reasons})`);
  }
  return `${parts.join(" · ")}. No provider write or provider verification was performed. Failed listing pushes for the confirmed SKUs can be queued again.`;
}
