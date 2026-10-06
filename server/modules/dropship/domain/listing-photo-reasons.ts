/** Vendor-facing reason an uploaded catalog photo is left out of a listing. */
export type ListingPhotoLeftOutReason = "catalog_photo_public_address_missing" | "catalog_photo_unavailable";

/**
 * The catalog's code for a photo it cannot publish, as the vendor's reason.
 * Neither is the vendor's to fix: a missing public photo address is Card
 * Shellz configuration (CATALOG_PUBLIC_URL_REQUIRED); any other code is about
 * the stored file itself (missing, empty, too large or not the image type it
 * claims to be).
 */
export function listingPhotoLeftOutReason(catalogIssueCode: string): ListingPhotoLeftOutReason {
  return catalogIssueCode === "CATALOG_PUBLIC_URL_REQUIRED"
    ? "catalog_photo_public_address_missing"
    : "catalog_photo_unavailable";
}
