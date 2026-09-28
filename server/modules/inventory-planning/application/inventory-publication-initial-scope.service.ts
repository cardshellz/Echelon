import { z } from "zod";
import {
  reviewInitialPublicationScopeSchema, prepareInitialPublicationScopeSchema,
  initialPublicationScopeReviewSchema, initialPublicationScopeReceiptSchema,
  type ReviewInitialPublicationScope, type PrepareInitialPublicationScope,
  type InitialPublicationScopeReview, type InitialPublicationScopeReceipt,
} from "@shared/types/inventory-publication-initial-scope";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";

export class InitialPublicationScopeError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message); this.name = "InitialPublicationScopeError";
  }
}
export interface InitialPublicationScopeStore {
  review(input: ReviewInitialPublicationScope): Promise<InitialPublicationScopeReview>;
  prepare(input: PrepareInitialPublicationScope, actor: string, requestHash: string, now: Date): Promise<InitialPublicationScopeReceipt>;
}
export function initialScopeCommandHash(input: PrepareInitialPublicationScope, actor: string): string {
  return inventoryCutoverEvidenceHash({ contractVersion: "initial_publication_scope_v2", input: { ...input,
    excludedVariants: [...(input.excludedVariants ?? [])].sort((a, b) => a.productVariantId - b.productVariantId) }, actor });
}
/** Pre-cutover configuration only. No provider, outbox, quantity, or activation dependency. */
export class InventoryPublicationInitialScopeService {
  constructor(private readonly store: InitialPublicationScopeStore,
    private readonly clock: { now(): Date } = { now: () => new Date() }) {}
  async review(input: unknown): Promise<InitialPublicationScopeReview> {
    return initialPublicationScopeReviewSchema.parse(await this.store.review(reviewInitialPublicationScopeSchema.parse(input)));
  }
  async prepare(input: unknown, actorInput: unknown): Promise<InitialPublicationScopeReceipt> {
    const command = prepareInitialPublicationScopeSchema.parse(input);
    const actor = z.string().trim().min(1).max(100).parse(actorInput);
    const now = z.date().parse(this.clock.now());
    return initialPublicationScopeReceiptSchema.parse(await this.store.prepare(command, actor, initialScopeCommandHash(command, actor), now));
  }
}
