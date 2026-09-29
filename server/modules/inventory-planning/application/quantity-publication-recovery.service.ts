import { z } from "zod";
import { pendingQuantityPublicationRecoveryRequestSchema, pendingQuantityPublicationRecoverySchema,
  quantityPublicationProviderAnswerRecoveryResultSchema, quantityPublicationProviderAnswerRecoverySchema,
  quantityPublicationRecoveryResultSchema, quantityPublicationRecoverySchema,
  type PendingQuantityPublicationRecovery, type QuantityPublicationProviderAnswerRecoveryResult,
  type QuantityPublicationRecovery, type QuantityPublicationRecoveryResult } from "@shared/types/inventory-publication-recovery";
import { selectRecoveryEvidence } from "@shared/inventory-publication-recovery-evidence";
import { QuantityPublicationAdmissionError } from "../domain/quantity-publication-admission";
import { InventoryCutoverCommitError } from "./inventory-cutover-commit.service";

/** The owner refused because someone else resolved or re-evidenced the attempt first; the rest of a batch is unaffected. */
const OWNER_CONFLICT_CODES: ReadonlySet<string> = new Set(["PUBLICATION_RECOVERY_REPLAY_CONFLICT", "PUBLICATION_RECOVERY_STATE_INVALID"]);

/** Attempt ids are decimal bigint strings; numeric order, not string order. */
function compareAttemptIds(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface QuantityPublicationRecoveryCommand extends QuantityPublicationRecovery { actor: string; now: Date }
export interface QuantityPublicationRecoveryStore {
  pending(activationRunId: string | undefined, now: Date): Promise<PendingQuantityPublicationRecovery>;
  attest(command: QuantityPublicationRecoveryCommand): Promise<QuantityPublicationRecoveryResult>;
}

/** Explicit operator evidence only: no timeout-based clearing, provider I/O, or automatic retry. */
export class QuantityPublicationRecoveryService {
  constructor(private readonly store: QuantityPublicationRecoveryStore,
    private readonly clock: { now(): Date } = { now: () => new Date() }) {}

  async pending(input: unknown, actorInput: unknown): Promise<PendingQuantityPublicationRecovery> {
    this.actor(actorInput);
    const request = pendingQuantityPublicationRecoveryRequestSchema.safeParse(input);
    if (!request.success) throw new InventoryCutoverCommitError("PUBLICATION_RECOVERY_PENDING_REQUEST_INVALID", "A valid activation run is required.", 400);
    const result = pendingQuantityPublicationRecoverySchema.parse(await this.store.pending(request.data.activationRunId, this.now()));
    if (request.data.activationRunId !== undefined && result.activationRunId !== request.data.activationRunId) throw new InventoryCutoverCommitError(
      "PUBLICATION_RECOVERY_RESULT_INVALID", "The owner history belongs to a different activation run.", 500);
    return result;
  }

  async attest(input: unknown, actorInput: unknown): Promise<QuantityPublicationRecoveryResult> {
    const actor = this.actor(actorInput);
    const request = quantityPublicationRecoverySchema.safeParse(input);
    if (!request.success) throw new InventoryCutoverCommitError("PUBLICATION_RECOVERY_REQUEST_INVALID",
      "An exact unresolved attempt, retained terminal evidence, a reason and a retry key are required.", 400);
    const result = quantityPublicationRecoveryResultSchema.parse(await this.store.attest({ ...request.data, actor, now: this.now() }));
    if (result.attemptId !== request.data.attemptId) throw new InventoryCutoverCommitError(
      "PUBLICATION_RECOVERY_RESULT_INVALID", "The attestation receipt belongs to a different publication attempt.", 500);
    return result;
  }

  /** Confirms, with one audited attestation each, every listed attempt whose stored evidence the operator saw: the
   * provider's refusal, or a record proving nothing can still reach the provider. Attempts without evidence on file,
   * or whose record changed since it was shown, are reported, never guessed. */
  async attestProviderAnswers(input: unknown, actorInput: unknown): Promise<QuantityPublicationProviderAnswerRecoveryResult> {
    const actor = this.actor(actorInput);
    const request = quantityPublicationProviderAnswerRecoverySchema.safeParse(input);
    if (!request.success) throw new InventoryCutoverCommitError("PUBLICATION_RECOVERY_ANSWERS_REQUEST_INVALID",
      "The attempts to confirm and the stored answer each one showed are required.", 400);
    const history = await this.pending(request.data.activationRunId === undefined ? {} : { activationRunId: request.data.activationRunId }, actorInput);
    const attempts = new Map(history.unresolvedAttempts.map(attempt => [attempt.attemptId, attempt]));
    const confirmed: QuantityPublicationProviderAnswerRecoveryResult["confirmed"] = [];
    const skipped: QuantityPublicationProviderAnswerRecoveryResult["skipped"] = [];
    // Ascending attempt order keeps the audit trail deterministic whatever order the client sent.
    const ordered = [...request.data.confirmations].sort((left, right) => compareAttemptIds(left.attemptId, right.attemptId));
    for (const confirmation of ordered) {
      const attempt = attempts.get(confirmation.attemptId);
      if (!attempt) { skipped.push({ attemptId: confirmation.attemptId, reason: "not_pending" }); continue; }
      const selection = selectRecoveryEvidence(attempt);
      if (!selection) { skipped.push({ attemptId: attempt.attemptId, reason: "no_evidence" }); continue; }
      if (selection.evidenceHash !== confirmation.evidenceHash) { skipped.push({ attemptId: attempt.attemptId, reason: "evidence_changed" }); continue; }
      const command = quantityPublicationRecoverySchema.parse({ attemptId: attempt.attemptId, idempotencyKey: selection.idempotencyKey, ...selection.evidence });
      let result: QuantityPublicationRecoveryResult;
      try {
        result = quantityPublicationRecoveryResultSchema.parse(await this.store.attest({ ...command, actor, now: this.now() }));
      } catch (error) {
        if (error instanceof QuantityPublicationAdmissionError && OWNER_CONFLICT_CODES.has(error.code)) {
          skipped.push({ attemptId: attempt.attemptId, reason: "owner_conflict" }); continue;
        }
        throw error;
      }
      if (result.attemptId !== attempt.attemptId) throw new InventoryCutoverCommitError(
        "PUBLICATION_RECOVERY_RESULT_INVALID", "The attestation receipt belongs to a different publication attempt.", 500);
      confirmed.push({ attemptId: attempt.attemptId, replay: result.replay });
    }
    return quantityPublicationProviderAnswerRecoveryResultSchema.parse({ basis: "operator_attestation", providerWriteAttempted: false, confirmed, skipped });
  }

  private actor(input: unknown): string {
    const parsed = z.string().trim().min(1).max(100).safeParse(input);
    if (!parsed.success) throw new InventoryCutoverCommitError("PUBLICATION_RECOVERY_ACTOR_REQUIRED", "An authenticated activation operator is required.", 401);
    return parsed.data;
  }
  private now(): Date {
    const value = this.clock.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new InventoryCutoverCommitError(
      "PUBLICATION_RECOVERY_CLOCK_INVALID", "The recovery clock returned an invalid timestamp.", 500);
    return new Date(value.getTime());
  }
}
