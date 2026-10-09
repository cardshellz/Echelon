import { ProductAssetError } from "./product-asset-errors";
export interface SharedImportedPhoto {
  url: string;
  position: number;
  altText?: string | null;
}
export interface ExistingImportPhoto {
  id: number;
  url: string | null;
  position: number;
}
export interface SharedPhotoAddition {
  url: string;
  altText: string | null;
  position: number;
  isPrimary: 0 | 1;
  productVariantId: null;
}
const MAX_POSITION = 2147483647;
// Bound writes per import while allowing large legacy galleries.
const MAX_NEW_PHOTOS = 1000;
/** New imports are shared; existing scope, order and primary choices remain authoritative. */
export function planSharedPhotoAdditions(existing: readonly ExistingImportPhoto[], photos: readonly SharedImportedPhoto[]): SharedPhotoAddition[] {
  const candidates = [...photos].sort((a, b) => a.position - b.position || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const seen = new Set(existing.map(photo => photo.url).filter((url): url is string => url !== null));
  const additions = candidates.filter(photo => {
    if (seen.has(photo.url))
      return false;
    seen.add(photo.url);
    return true;
  });
  const firstPosition = existing.reduce((max, photo) => Math.max(max, photo.position), -1) + 1;
  if (additions.length > MAX_NEW_PHOTOS || firstPosition + additions.length - 1 > MAX_POSITION) {
    throw new ProductAssetError("IMPORTED_PHOTOS_LIMIT", "Too many imported photos or no gallery positions remain.", 400);
  }
  return additions.map((photo, index) => ({
    url: photo.url, altText: photo.altText ?? null, position: firstPosition + index,
    isPrimary: existing.length === 0 && index === 0 ? 1 : 0, productVariantId: null,
  }));
}
