import { z } from "zod";
import { CentsSchema } from "../../../../shared/validation/currency";
import { createListingPushJobInputSchema, generateVendorListingPreviewInputSchema } from "./dropship-use-case-dtos";
import { dropshipListingEconomicsSchema, dropshipListingPresentationSchema } from "../../../../shared/dropship/listing-presentation";
import type { DropshipListingPreviewResult, DropshipListingPreviewRow } from "./dropship-listing-preview-service";

const positiveIdSchema = z.number().int().positive();
const idempotencyKeySchema = z.string().trim().min(8).max(200);

export const generateVendorListingPreviewForMemberInputSchema = generateVendorListingPreviewInputSchema.omit({
  vendorId: true,
  actor: true,
  // Only the push worker may say which category a queued listing carried.
  queuedEbayCategoriesByVariantId: true,
});

export const createListingPushJobForMemberInputSchema = createListingPushJobInputSchema.omit({
  vendorId: true,
  requestedBy: true,
}).extend({
  requestedRetailPriceCents: CentsSchema.optional(),
  requestedRetailPricesByVariantId: generateVendorListingPreviewInputSchema.shape.requestedRetailPricesByVariantId,
  idempotencyKey: idempotencyKeySchema,
  storeConnectionId: positiveIdSchema,
  productVariantIds: z.array(positiveIdSchema).min(1).max(500),
}).strict();

export type GenerateVendorListingPreviewForMemberInput = z.infer<typeof generateVendorListingPreviewForMemberInputSchema>;
export type CreateListingPushJobForMemberInput = z.infer<typeof createListingPushJobForMemberInputSchema>;

export type DropshipVendorListingPreviewRow = Omit<DropshipListingPreviewRow, "listingIntent">;
export type DropshipVendorListingPreviewResult = Omit<DropshipListingPreviewResult, "rows"> & {
  rows: DropshipVendorListingPreviewRow[];
};

/** Explicit vendor transport boundary. Worker-only intent/configuration must never leave here. */
export function toDropshipVendorListingPreview(preview: DropshipListingPreviewResult): DropshipVendorListingPreviewResult {
  return {
    vendorId: preview.vendorId,
    storeConnectionId: preview.storeConnectionId,
    platform: preview.platform,
    generatedAt: preview.generatedAt,
    summary: { ...preview.summary },
    rows: preview.rows.map((row) => ({
      productVariantId: row.productVariantId, productId: row.productId, sku: row.sku, title: row.title,
      platform: row.platform, listingMode: row.listingMode, currentListingStatus: row.currentListingStatus,
      previewStatus: row.previewStatus, blockers: [...row.blockers], warnings: [...row.warnings],
      marketplaceQuantity: row.marketplaceQuantity, priceCents: row.priceCents,
      priceSettingRevisionId: row.priceSettingRevisionId,
      marketplaceCategoryId: row.marketplaceCategoryId, marketplaceCategoryName: row.marketplaceCategoryName,
      storeCategoryNames: [...row.storeCategoryNames], businessPolicySelection: row.businessPolicySelection,
      previewHash: row.previewHash, adminExposureDecision: row.adminExposureDecision, selectionDecision: row.selectionDecision,
      listingTier: row.listingTier,
      // The vendor client echoes these back when it queues a push, and
      // createListingPushJob rejects any row whose fresh preview evidence differs
      // from what the vendor reviewed. Leaving them out rejected every vendor push
      // with DROPSHIP_CONTENT_VERSION_CONFLICT. Both evidence values are SHA-256
      // digests, so they disclose no description, cost or rule inputs.
      ...(row.contentEvidenceHash !== undefined ? { contentEvidenceHash: row.contentEvidenceHash } : {}),
      ...(row.rulePriceEvidenceHash !== undefined ? { rulePriceEvidenceHash: row.rulePriceEvidenceHash } : {}),
      ...(row.pricingRuleName !== undefined ? { pricingRuleName: row.pricingRuleName } : {}),
      // Where the category came from: the vendor's own rule, store default or the Card Shellz catalog.
      ...(row.marketplaceCategorySource !== undefined ? { marketplaceCategorySource: row.marketplaceCategorySource } : {}),
      ...(row.marketplaceCategoryRuleName !== undefined ? { marketplaceCategoryRuleName: row.marketplaceCategoryRuleName } : {}),
      ...(row.presentation ? { presentation: dropshipListingPresentationSchema.parse(row.presentation) } : {}),
      ...(row.economics ? { economics: dropshipListingEconomicsSchema.parse(row.economics) } : {}),
    })),
  };
}
