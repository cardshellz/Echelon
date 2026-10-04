import { z } from "zod";

const assetId = z.number().int().positive().max(2_147_483_647);
// Bound the complete-order payload and transaction work while allowing large legacy galleries.
const MAX_ASSETS_PER_REORDER = 1000;
const assetIds = z.array(assetId).max(MAX_ASSETS_PER_REORDER).refine(ids => new Set(ids).size === ids.length, "Image IDs must be unique");

export const reorderProductAssetsSchema = z.object({
  orderedIds: assetIds,
  // Older callers can still submit a complete order without a snapshot.
  expectedOrderedIds: assetIds.optional(),
}).strict();

export type ReorderProductAssets = z.infer<typeof reorderProductAssetsSchema>;

export interface CatalogGalleryAsset {
  id: number;
  url: string | null;
  altText: string | null;
  assetType: string;
  isPrimary: number;
  position: number;
  productVariantId: number | null;
  storageType?: string;
}

export function sortCatalogAssets<T extends Pick<CatalogGalleryAsset, "id" | "position">>(assets: readonly T[]): T[] {
  return [...assets].sort((a, b) => a.position - b.position || a.id - b.id);
}
