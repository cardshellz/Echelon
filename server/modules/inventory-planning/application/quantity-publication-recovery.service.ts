import { z } from "zod";
import { pendingQuantityPublicationRecoveryRequestSchema, pendingQuantityPublicationRecoverySchema,
  quantityPublicationRecoveryResultSchema, quantityPublicationRecoverySchema,
  type PendingQuantityPublicationRecovery, type QuantityPublicationRecovery, type QuantityPublicationRecoveryResult } from "@shared/types/inventory-publication-recovery";
import { InventoryCutoverCommitError } from "./inventory-cutover-commit.service";

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
