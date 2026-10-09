import { z } from "zod";

export const catalogPhotoIdSchema = z.number().int().positive().max(2_147_483_647);
const photoScope = catalogPhotoIdSchema.nullable();

/** null means shared by every variant belonging to this product. */
export const productAssetScopeSchema = z.object({
  productVariantId: photoScope,
  expectedProductVariantId: photoScope,
}).strict();

export const productAssetScopeResultSchema = z.object({
  productId: catalogPhotoIdSchema,
  assetId: catalogPhotoIdSchema,
  productVariantId: photoScope,
  changed: z.boolean(),
}).strict();

export type ProductAssetScopeCommand = z.infer<typeof productAssetScopeSchema>;
export type ProductAssetScopeResult = z.infer<typeof productAssetScopeResultSchema>;
export interface CatalogPhotoVariant { id: number; name: string; sku: string }
