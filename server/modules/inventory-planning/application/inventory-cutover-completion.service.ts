import { z } from "zod";
import { finishInventoryCutoverRequestSchema, finishInventoryCutoverResultSchema,
  inventoryCutoverVerificationRequestSchema, inventoryCutoverVerificationSchema,
  type FinishInventoryCutoverRequest, type FinishInventoryCutoverResult,
  type InventoryCutoverVerification } from "@shared/types/inventory-cutover-completion";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";
import { InventoryCutoverCommitError } from "./inventory-cutover-commit.service";

export interface FinishInventoryCutoverCommand extends FinishInventoryCutoverRequest {
  actor: string;
  requestHash: string;
  occurredAt: Date;
}
export interface InventoryCutoverCompletionStore {
  verify(activationRunId: string, occurredAt: Date): Promise<InventoryCutoverVerification>;
  finish(command: FinishInventoryCutoverCommand): Promise<FinishInventoryCutoverResult>;
}

/** Completion verifies recorded provider outcomes; it never sends provider writes. */
export class InventoryCutoverCompletionService {
  constructor(private readonly store: InventoryCutoverCompletionStore,
    private readonly clock: { now(): Date } = { now: () => new Date() }) {}

  async verify(input: unknown, actorInput: unknown): Promise<InventoryCutoverVerification> {
    this.actor(actorInput);
    const request = inventoryCutoverVerificationRequestSchema.safeParse(input);
    if (!request.success) throw new InventoryCutoverCommitError("CUTOVER_VERIFICATION_REQUEST_INVALID", "A valid activation run is required.", 400);
    const result = inventoryCutoverVerificationSchema.parse(await this.store.verify(request.data.activationRunId, this.now()));
    if (result.activationRunId !== request.data.activationRunId) throw new InventoryCutoverCommitError(
      "CUTOVER_VERIFICATION_RESULT_INVALID", "Verification returned evidence for a different activation run.", 500);
    return result;
  }

  async finish(input: unknown, actorInput: unknown): Promise<FinishInventoryCutoverResult> {
    const actor = this.actor(actorInput);
    const request = finishInventoryCutoverRequestSchema.safeParse(input);
    if (!request.success) throw new InventoryCutoverCommitError("CUTOVER_FINISH_REQUEST_INVALID", "Fresh verification, a reason and a retry key are required.", 400);
    const requestHash = inventoryCutoverEvidenceHash({ contractVersion: "inventory_cutover_finish_v1", actor, ...request.data });
    const result = finishInventoryCutoverResultSchema.parse(await this.store.finish({ ...request.data, actor, requestHash, occurredAt: this.now() }));
    if (result.activationRunId !== request.data.activationRunId || result.verificationHash !== request.data.expectedVerificationHash) {
      throw new InventoryCutoverCommitError("CUTOVER_FINISH_RESULT_INVALID", "Completion returned a receipt for different reviewed evidence.", 500);
    }
    return result;
  }

  private actor(input: unknown): string {
    const actor = z.string().trim().min(1).max(100).safeParse(input);
    if (!actor.success) throw new InventoryCutoverCommitError("CUTOVER_ACTOR_REQUIRED", "An authenticated activation operator is required.", 401);
    return actor.data;
  }
  private now(): Date {
    const time = this.clock.now();
    if (!(time instanceof Date) || Number.isNaN(time.getTime())) throw new InventoryCutoverCommitError("CUTOVER_CLOCK_INVALID", "The cutover clock returned an invalid timestamp.", 500);
    return new Date(time.getTime());
  }
}
