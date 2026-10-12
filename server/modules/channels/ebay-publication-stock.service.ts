import { z } from "zod";
import { ebayPublicationStockApplySchema, ebayPublicationStockResultSchema, ebayPublicationStockReviewSchema, ebayPublicationStockRefusalSchema,
  type EbayPublicationStockApply, type EbayPublicationStockResult, type EbayPublicationStockReview } from "@shared/types/ebay-publication-stock";
import type { InventoryEbayPublicationReadiness, InventoryEbayPublicationReadinessInput } from "@shared/types/ebay-publication-readiness";
import type { EbayListingInspection } from "../marketplace-listings";
import { EbayListingSyncError, syncStageHash, type EbayListingSyncIdentity } from "./ebay-listing-sync.domain";

export interface EbayStockPublicationSource {
  sourceIdentity: EbayListingSyncIdentity;
  targetIdentity: EbayListingSyncIdentity;
  inspection: EbayListingInspection;
  inventorySource: InventoryEbayPublicationReadinessInput;
  productName: string;
}
export interface EbayPublicationStockDependencies {
  channelId: number;
  prepare(productId: number): Promise<EbayStockPublicationSource>;
  reviewInventory(source: InventoryEbayPublicationReadinessInput): Promise<InventoryEbayPublicationReadiness>;
  findApplied(input: { productId: number; commandKey: string; actor?: string; reviewHash?: string }): Promise<EbayPublicationStockResult | null>;
  commit(input: { source: EbayStockPublicationSource; inventory: InventoryEbayPublicationReadiness;
    command: EbayPublicationStockApply; actor: string; now: Date }): Promise<EbayPublicationStockResult>;
  reject(input: { productId: number; command: EbayPublicationStockApply; actor: string;
    code: z.infer<typeof ebayPublicationStockRefusalSchema>["code"]; message: string; now: Date }): Promise<EbayPublicationStockResult>;
  now(): Date;
}
const id = z.number().int().positive().max(2_147_483_647);
const sourceReviewRefusalCodes = new Set([
  "EBAY_SYNC_IDENTITY_CHANGED", "EBAY_SYNC_MEMBERSHIP_CHANGED", "EBAY_SYNC_OFFER_IDENTITY_CHANGED",
  "EBAY_SYNC_ACCOUNT_CHANGED", "EBAY_LISTING_ALREADY_PUBLISHED", "EBAY_LISTING_PREFLIGHT_FAILED",
  "EBAY_MAPPING_OWNERSHIP_CONFLICT", "EBAY_SYNC_MAPPING_INVALID", "EBAY_PUBLICATION_TARGET_UNVERIFIED",
]);

/** Combines provider identity proof with Inventory's own enrollment proposal.
 * Inventory owns all quantities/configuration; the saved listing queue owns HTTP work. */
export class EbayPublicationStockService {
  constructor(private readonly deps: EbayPublicationStockDependencies) {}

  async review(productId: number): Promise<EbayPublicationStockReview> {
    const evidence = await this.capture(id.parse(productId));
    return evidence.review;
  }

  async apply(productId: number, actorInput: string, raw: EbayPublicationStockApply): Promise<EbayPublicationStockResult> {
    productId = id.parse(productId);
    const actor = z.string().trim().min(1).max(100).parse(actorInput);
    const command = ebayPublicationStockApplySchema.parse(raw);
    // Lost-response replay works without fresh eBay connectivity or unchanged stock.
    const prior = await this.deps.findApplied({ productId, commandKey: command.commandKey, actor, reviewHash: command.expectedReviewHash });
    if (prior) return ebayPublicationStockResultSchema.parse(prior);
    try {
      const { source, review } = await this.capture(productId);
      if (review.reviewHash !== command.expectedReviewHash)
        throw new EbayListingSyncError("EBAY_PUBLICATION_STOCK_REVIEW_STALE", "The eBay identity or stock plan changed. Review the current plan again before publishing.");
      if (!review.canApply)
        throw new EbayListingSyncError("EBAY_PUBLICATION_STOCK_REVIEW_BLOCKED", review.inventory.blockers.map(row => row.message).join(" "));
      return ebayPublicationStockResultSchema.parse(await this.deps.commit({ source, inventory: review.inventory, command, actor, now: this.deps.now() }));
    } catch (error) {
      if (error instanceof Error && "code" in error && sourceReviewRefusalCodes.has(String(error.code))) {
        return this.deps.reject({ productId, command, actor, code: "EBAY_PUBLICATION_STOCK_SOURCE_CHANGED",
          message: `${error.message} Refresh this publication review before submitting a new request.`, now: this.deps.now() });
      }
      const refusal = error instanceof Error && "code" in error
        ? ebayPublicationStockRefusalSchema.safeParse({ code: error.code, error: error.message, definitiveRejected: true }) : null;
      if (!refusal?.success) throw error;
      // A refusal is final only after it competes with any concurrent successful
      // Apply under the inventory owner's command lock. A committed Apply wins.
      return this.deps.reject({ productId, command, actor, code: refusal.data.code, message: refusal.data.error, now: this.deps.now() });
    }
  }

  async getReceipt(productId: number, commandKey: string): Promise<EbayPublicationStockResult | null> {
    return this.deps.findApplied({ productId: id.parse(productId), commandKey: z.string().uuid().parse(commandKey) });
  }

  private async capture(productId: number) {
    const source = await this.deps.prepare(productId);
    if (source.sourceIdentity.productId !== productId || source.sourceIdentity.channelId !== this.deps.channelId
      || source.inspection.publication !== null)
      throw new EbayListingSyncError("EBAY_PUBLICATION_STOCK_SOURCE_CHANGED", "The listing's publication state changed. Refresh this product and review its current listing mapping.");
    const inventory = await this.deps.reviewInventory(source.inventorySource);
    const reviewHash = syncStageHash({ source: source.sourceIdentity, target: source.targetIdentity,
      inventorySource: source.inventorySource, inventoryReviewHash: inventory.reviewHash });
    return { source, review: ebayPublicationStockReviewSchema.parse({ productId, productName: source.productName,
      observedAt: this.deps.now().toISOString(), reviewHash, inventory,
      canApply: inventory.ready, allowedToApply: true, requiredPermission: null,
      effects: [...inventory.effects, "Save a publication request using the current catalog pictures, prices, and canonical stock. Track its result in this listing feed."],
    }) };
  }
}
