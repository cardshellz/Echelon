import type { CatalogPublicImageUrl } from "./catalog-public-image";
import { ProductAssetError } from "./product-asset-errors";
import {
  MAX_PRODUCT_IMAGE_BYTES,
  validateProductImage,
} from "./product-image-download.service";

/** Metadata used to resolve a publication photo without loading its entire file. */
export interface CatalogPublicationImage {
  id: number;
  productId: number;
  productVariantId: number | null;
  position: number;
  /** Order within one product, shared by its variant and group galleries. */
  publicationPosition?: number;
  isPrimary?: boolean;
  included?: boolean;
  url: string | null;
  storageType: string;
  mimeType: string | null;
  fileBytes: number | null;
  fileHash: string | null;
  fileHeader: Buffer | null;
}

/** An explicit audience selection; Catalog does not know which channel supplied it. */
export interface CatalogPublicationImageOverride {
  assetId: number;
  included: boolean;
  urlOverride: string | null;
  positionOverride: number | null;
}

export interface CatalogPublicationPhotoSelection {
  productVariantIds: readonly number[];
  maxPhotosPerVariant: number;
  maxGroupPhotos?: number;
  productId?: number;
  overrides?: readonly CatalogPublicationImageOverride[];
}

export function resolveCatalogPublicationImage(
  image: CatalogPublicationImage,
  publicUrl: CatalogPublicImageUrl,
): string | null {
  if (image.url !== null) return image.url;
  if (image.storageType !== "file" && image.storageType !== "both") return null;
  if (
    !image.fileBytes ||
    image.fileBytes > MAX_PRODUCT_IMAGE_BYTES ||
    !image.fileHash ||
    !image.fileHeader
  ) {
    throw new ProductAssetError(
      "CATALOG_IMAGE_UNAVAILABLE",
      `Replace uploaded catalog image ${image.id}: its file is missing, empty or larger than 10 MB.`,
      422,
    );
  }
  // Check the same signature as the public read boundary without loading the full blob.
  const validated = validateProductImage({
    data: image.fileHeader,
    mimeType: image.mimeType ?? "",
  });
  return publicUrl(image.id, image.fileHash, validated.mimeType);
}
