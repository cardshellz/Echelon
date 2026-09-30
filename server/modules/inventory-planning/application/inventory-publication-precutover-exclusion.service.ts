import { z } from "zod";
import { publicationMembershipReceiptSchema } from "@shared/types/inventory-publication-membership";
import { applyPrecutoverExclusionSchema, reviewPrecutoverExclusionSchema,
  type ApplyPrecutoverExclusion, type ReviewPrecutoverExclusion,
  type PrecutoverExclusionReview } from "../domain/inventory-publication-precutover-exclusion";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";

export const precutoverExclusionReceiptSchema = z.object({
  targets: z.array(publicationMembershipReceiptSchema).min(1),
  runtimeAuthorityChanged: z.literal(false), providerWriteAttempted: z.literal(false), outboxEnqueued: z.literal(false),
}).strict();
export type PrecutoverExclusionReceipt = z.infer<typeof precutoverExclusionReceiptSchema>;
export class PrecutoverExclusionError extends Error {
  constructor(readonly code: string, message: string, readonly context: Record<string, unknown> = {}) {
    super(message); this.name = "PrecutoverExclusionError";
  }
}
export interface PrecutoverExclusionStore {
  review(input: ReviewPrecutoverExclusion, now: Date): Promise<PrecutoverExclusionReview>;
  apply(input: ApplyPrecutoverExclusion, actor: string, requestHash: string, now: Date): Promise<PrecutoverExclusionReceipt>;
}
export function precutoverExclusionCommandHash(input: ApplyPrecutoverExclusion, actor: string): string {
  return inventoryCutoverEvidenceHash({ contractVersion: "precutover_listing_exclusion_v1", actor,
    input: { ...input, exclusions: [...input.exclusions].sort((a, b) =>
      a.publicationTargetId - b.publicationTargetId || a.productVariantId - b.productVariantId) } });
}
/** Operator-only, configuration-only amendment. Live removal still belongs to
 * InventoryPublicationMembershipService and retains its hold/verified-zero rule. */
export class InventoryPublicationPrecutoverExclusionService {
  constructor(private readonly store: PrecutoverExclusionStore,
    private readonly clock: { now(): Date }) {}
  async review(input: unknown): Promise<PrecutoverExclusionReview> {
    return this.store.review(reviewPrecutoverExclusionSchema.parse(input), z.date().parse(this.clock.now()));
  }
  async apply(input: unknown, actorInput: unknown): Promise<PrecutoverExclusionReceipt> {
    const command = applyPrecutoverExclusionSchema.parse(input);
    const actor = z.string().trim().min(1).max(100).parse(actorInput);
    return precutoverExclusionReceiptSchema.parse(await this.store.apply(command, actor,
      precutoverExclusionCommandHash(command, actor), z.date().parse(this.clock.now())));
  }
}
