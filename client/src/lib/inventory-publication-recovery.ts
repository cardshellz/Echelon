import type { PendingQuantityPublicationRecovery, QuantityPublicationProviderAnswerRecovery,
  QuantityPublicationProviderAnswerRecoveryResult, QuantityPublicationProviderAnswerSkipReason } from "@shared/types/inventory-publication-recovery";
import { PROVIDER_DISPLAY_NAMES, formatProviderErrorCodes, selectRecoveryEvidence,
  type RecoveryEvidence } from "@shared/inventory-publication-recovery-evidence";

type UnresolvedAttempt = PendingQuantityPublicationRecovery["unresolvedAttempts"][number];

export type AttestationPrefill = RecoveryEvidence & {
  /** One paragraph for the operator: what the stored evidence shows and what it means. */
  summary: string;
};

/**
 * Fills the attestation form from evidence the server found on file: the
 * provider's refusal, or a record proving nothing can still reach the
 * provider. The operator still reads it, ticks the confirmation and records
 * it; nothing is submitted here.
 */
export function attestationPrefill(attempt: UnresolvedAttempt): AttestationPrefill | null {
  const selection = selectRecoveryEvidence(attempt);
  if (!selection) return null;
  const provider = PROVIDER_DISPLAY_NAMES[attempt.providerKey];
  if (selection.source === "provider_answer" && attempt.providerAnswer) {
    const answer = attempt.providerAnswer;
    const codes = formatProviderErrorCodes(answer.errorCodes);
    return { ...selection.evidence, summary:
      `${provider} answered HTTP ${answer.httpStatus} (codes ${codes}) to ${answer.method} ${answer.path} at ${answer.recordedAt}. ` +
      "That is a refusal: nothing was written, so this request can no longer change quantities. The fields below are filled from that stored answer." };
  }
  const termination = attempt.requestTermination!;
  return { ...selection.evidence, summary:
    `${provider} was last contacted at ${termination.lastActivityAt}. Nothing has happened on this request for more than ` +
    `${termination.quiescenceMarginMinutes} minutes, and a request times out after ${termination.providerRequestTimeoutSeconds} seconds, ` +
    "so it can no longer change quantities; catch-up republishes the current stock. The fields below are filled from that stored record." };
}

/** The option label's tail: which evidence is on file. */
export function recoveryEvidenceLabel(attempt: UnresolvedAttempt): string {
  if (attempt.providerAnswer) return ` · answered HTTP ${attempt.providerAnswer.httpStatus}`;
  if (attempt.requestTermination) return ` · no activity since ${attempt.requestTermination.lastActivityAt}`;
  return "";
}

/** The one-click confirmation: every listed attempt with evidence on file, pinned to the hash the operator saw. */
export function recoveryEvidenceConfirmations(
  attempts: readonly UnresolvedAttempt[],
): QuantityPublicationProviderAnswerRecovery["confirmations"] {
  return attempts.flatMap(attempt => {
    const selection = selectRecoveryEvidence(attempt);
    return selection ? [{ attemptId: attempt.attemptId, evidenceHash: selection.evidenceHash }] : [];
  });
}

/** What the one-click confirmation covers, or null when no listed attempt has evidence on file. */
export function describeRecoveryEvidenceBatch(attempts: readonly UnresolvedAttempt[]): string | null {
  const refused = attempts.filter(attempt => attempt.providerAnswer);
  const quiet = attempts.filter(attempt => !attempt.providerAnswer && attempt.requestTermination);
  const total = refused.length + quiet.length;
  if (total === 0) return null;
  const parts: string[] = [];
  if (refused.length > 0) {
    const providers = [...new Set(refused.map(attempt => PROVIDER_DISPLAY_NAMES[attempt.providerKey]))].sort();
    parts.push(`${refused.length} refused by ${providers.length === 1 ? providers[0] : "the marketplace"} with the refusal on file`);
  }
  if (quiet.length > 0) {
    const sample = quiet[0].requestTermination!;
    parts.push(`${quiet.length} with no activity for more than ${sample.quiescenceMarginMinutes} minutes ` +
      `(a request times out after ${sample.providerRequestTimeoutSeconds} seconds, so nothing is still in flight)`);
  }
  const covered = `${total} of the ${attempts.length} listed ${attempts.length === 1 ? "entry" : "entries"} can be confirmed: ${parts.join("; ")}. ` +
    "Those writes can no longer change stock; catch-up republishes the current quantity.";
  const rest = attempts.length - total;
  if (rest === 0) return covered;
  return `${covered} The other ${rest === 1 ? "entry stays" : `${rest} entries stay`} listed: ${rest === 1 ? "it was" : "they were"} active too recently.`;
}

const SKIP_REASON_WORDS: Readonly<Record<QuantityPublicationProviderAnswerSkipReason, string>> = Object.freeze({
  not_pending: "no longer listed",
  no_evidence: "no evidence on file",
  evidence_changed: "record changed since it was shown",
  owner_conflict: "resolved by someone else meanwhile",
});

/** One line after the one-click confirmation: what was recorded, what was skipped and why. */
export function describeRecoveryEvidenceResult(result: QuantityPublicationProviderAnswerRecoveryResult): string {
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
