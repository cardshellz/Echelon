import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  inspectPublicationMembershipSchema,
  reviewPublicationMembershipSchema,
  applyPublicationMembershipSchema,
  publicationMembershipInspectionSchema,
  publicationMembershipReviewSchema,
  publicationMembershipReceiptSchema,
  type InspectPublicationMembership,
  type ReviewPublicationMembership,
  type ApplyPublicationMembership,
  type PublicationMembershipInspection,
  type PublicationMembershipReview,
  type PublicationMembershipReceipt,
} from "@shared/types/inventory-publication-membership";

export class InventoryPublicationMembershipError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "InventoryPublicationMembershipError";
  }
}
export interface InventoryPublicationMembershipStore {
  inspect(
    input: InspectPublicationMembership,
  ): Promise<PublicationMembershipInspection>;
  review(
    input: ReviewPublicationMembership,
  ): Promise<PublicationMembershipReview>;
  apply(
    input: ApplyPublicationMembership,
    actor: string,
    requestHash: string,
    now: Date,
  ): Promise<PublicationMembershipReceipt>;
}

/** Inventory-owned opt-in boundary. It never creates mappings, changes runtime
 * authority, or sends provider requests. Mapping/source setup stays with the
 * existing inventory definition owners; receipts describe queued work only. */
export class InventoryPublicationMembershipService {
  constructor(
    private readonly store: InventoryPublicationMembershipStore,
    private readonly clock: { now(): Date } = { now: () => new Date() },
  ) {}

  async inspect(input: unknown): Promise<PublicationMembershipInspection> {
    return publicationMembershipInspectionSchema.parse(
      await this.store.inspect(inspectPublicationMembershipSchema.parse(input)),
    );
  }
  async review(input: unknown): Promise<PublicationMembershipReview> {
    return publicationMembershipReviewSchema.parse(
      await this.store.review(
        normalizeReview(reviewPublicationMembershipSchema.parse(input)),
      ),
    );
  }
  async apply(
    input: unknown,
    actorInput: unknown,
  ): Promise<PublicationMembershipReceipt> {
    const parsed = applyPublicationMembershipSchema.parse(input);
    const command = { ...parsed, ...normalizeReview(parsed) };
    const actor = z.string().trim().min(1).max(100).parse(actorInput);
    const now = z.date().parse(this.clock.now());
    const requestHash = createHash("sha256")
      .update(canonicalJson({ command, actor }))
      .digest("hex");
    return publicationMembershipReceiptSchema.parse(
      await this.store.apply(command, actor, requestHash, now),
    );
  }
}

function normalizeReview(
  input: ReviewPublicationMembership,
): ReviewPublicationMembership {
  return {
    ...input,
    changes: [...input.changes].sort(
      (left, right) => left.productVariantId - right.productVariantId,
    ),
  };
}
