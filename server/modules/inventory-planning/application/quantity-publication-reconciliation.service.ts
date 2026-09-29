import { z } from "zod";
import { publicationReconciliationRequestSchema, publicationReconciliationReviewRequestSchema,
  publicationReconciliationReviewSchema, publicationReconciliationResultSchema,
  type PublicationReconciliationRequest, type PublicationReconciliationReview,
  type PublicationReconciliationResult } from "@shared/types/inventory-publication-reconciliation";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";
import { InventoryCutoverCommitError } from "./inventory-cutover-commit.service";

export interface PublicationReconciliationCommand extends PublicationReconciliationRequest {
  actor: string; occurredAt: Date; requestHash: string;
}
export interface QuantityPublicationReconciliationStore {
  review(activationRunId: string, occurredAt: Date): Promise<PublicationReconciliationReview>;
  reconcile(command: PublicationReconciliationCommand): Promise<PublicationReconciliationResult>;
}
export class QuantityPublicationReconciliationService {
  constructor(private readonly store: QuantityPublicationReconciliationStore,
    private readonly clock: { now(): Date } = { now: () => new Date() }) {}

  async review(raw: unknown, actorInput: unknown): Promise<PublicationReconciliationReview> {
    this.actor(actorInput);
    const request = publicationReconciliationReviewRequestSchema.parse(raw);
    const result = publicationReconciliationReviewSchema.parse(await this.store.review(request.activationRunId, this.now()));
    if (result.activationRunId !== request.activationRunId) throw this.invalidResult();
    return result;
  }
  async reconcile(raw: unknown, actorInput: unknown): Promise<PublicationReconciliationResult> {
    const actor = this.actor(actorInput);
    const request = publicationReconciliationRequestSchema.parse(raw);
    const result = publicationReconciliationResultSchema.parse(await this.store.reconcile({ ...request, actor, occurredAt: this.now(),
      requestHash: inventoryCutoverEvidenceHash({ contractVersion: "publication_current_state_reconciliation_v1", actor, ...request }) }));
    if (result.activationRunId !== request.activationRunId || result.reviewHash !== request.expectedReviewHash) throw this.invalidResult();
    return result;
  }
  private actor(raw: unknown): string {
    const actor = z.string().trim().min(1).max(100).safeParse(raw);
    if (!actor.success) throw new InventoryCutoverCommitError("PUBLICATION_RECONCILIATION_ACTOR_REQUIRED", "An authenticated activation operator is required.", 401);
    return actor.data;
  }
  private now(): Date {
    const value = this.clock.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new InventoryCutoverCommitError("PUBLICATION_RECONCILIATION_CLOCK_INVALID", "Invalid reconciliation clock.", 500);
    return new Date(value.getTime());
  }
  private invalidResult(): InventoryCutoverCommitError {
    return new InventoryCutoverCommitError("PUBLICATION_RECONCILIATION_RESULT_INVALID", "Reconciliation returned evidence for another command.", 500);
  }
}
