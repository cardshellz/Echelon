import { z } from "zod";
import {
  commitInventoryCutoverRequestSchema, previewInventoryCutoverRequestSchema,
  inventoryCutoverCommitResultSchema, inventoryCutoverReviewSchema,
  type CommitInventoryCutoverRequest, type InventoryCutoverCommitResult, type InventoryCutoverReview,
} from "@shared/types/inventory-cutover-commit";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";

export interface InventoryCutoverCommitCommand extends CommitInventoryCutoverRequest {
  actor: string;
  requestHash: string;
  occurredAt: Date;
}

export interface InventoryCutoverCommitStore {
  preview(activationRunId: string, occurredAt: Date): Promise<InventoryCutoverReview>;
  commit(command: InventoryCutoverCommitCommand): Promise<InventoryCutoverCommitResult>;
}

export class InventoryCutoverCommitError extends Error {
  constructor(readonly code: string, message: string, readonly status: number = 409,
    readonly context: Readonly<Record<string, unknown>> = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = "InventoryCutoverCommitError";
  }
}

export class InventoryCutoverCommitService {
  constructor(private readonly store: InventoryCutoverCommitStore,
    private readonly clock: { now(): Date } = { now: () => new Date() }) {}

  async preview(input: unknown, actorInput: unknown): Promise<InventoryCutoverReview> {
    this.actor(actorInput); // Current authentication is required even for a repeat review.
    const request = previewInventoryCutoverRequestSchema.safeParse(input);
    if (!request.success) throw new InventoryCutoverCommitError("CUTOVER_REVIEW_REQUEST_INVALID", "A valid activation run is required.", 400);
    return inventoryCutoverReviewSchema.parse(await this.store.preview(request.data.activationRunId, this.now()));
  }

  async commit(input: unknown, actorInput: unknown): Promise<InventoryCutoverCommitResult> {
    const actor = this.actor(actorInput);
    const request = commitInventoryCutoverRequestSchema.safeParse(input);
    if (!request.success) throw new InventoryCutoverCommitError("CUTOVER_COMMIT_REQUEST_INVALID", "Review the cutover run, revision, evidence hash, reason and idempotency key.", 400);
    const requestHash = inventoryCutoverEvidenceHash({ contractVersion: "inventory_cutover_commit_v1", actor, ...request.data });
    // Retry time is deliberately absent from semantic identity.
    return inventoryCutoverCommitResultSchema.parse(await this.store.commit({
      ...request.data, actor, requestHash, occurredAt: this.now(),
    }));
  }

  private actor(input: unknown): string {
    const parsed = z.string().trim().min(1).max(100).safeParse(input);
    if (!parsed.success) throw new InventoryCutoverCommitError("CUTOVER_ACTOR_REQUIRED", "An authenticated activation operator is required.", 401);
    return parsed.data;
  }

  private now(): Date {
    const value = this.clock.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new InventoryCutoverCommitError("CUTOVER_CLOCK_INVALID", "The cutover clock returned an invalid timestamp.", 500);
    }
    return value;
  }
}
