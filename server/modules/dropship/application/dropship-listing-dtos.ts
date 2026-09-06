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
      ...(row.presentation ? { presentation: dropshipListingPresentationSchema.parse(row.presentation) } : {}),
      ...(row.economics ? { economics: dropshipListingEconomicsSchema.parse(row.economics) } : {}),
    })),
  };
}
