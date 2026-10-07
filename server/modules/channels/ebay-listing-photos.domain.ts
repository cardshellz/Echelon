import { isIP } from "node:net";
import type { ChannelImagePayload, ChannelVariantPayload } from "./channel-adapter.interface";

/** Preserve the existing eBay publication limit for direct and Dropship listing replacements. */
export const EBAY_LISTING_MAX_PHOTOS = 12;

export class EbayListingPhotoError extends Error {
  constructor(readonly code: string, message: string, readonly context: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "EbayListingPhotoError";
  }
}

export interface EbayPhotoVariant { variantId: number; sku: string }

/** A size ID and its exact SKU are inseparable when selecting a listing's photos. */
export function assertEbayPhotoVariants(variants: readonly EbayPhotoVariant[]): void {
  if (!Array.isArray(variants) || variants.length === 0
    || variants.some(variant => !variant || !Number.isInteger(variant.variantId) || variant.variantId <= 0 || variant.variantId > 2_147_483_647
      || typeof variant.sku !== "string" || !variant.sku || variant.sku.trim() !== variant.sku)
    || new Set(variants.map(variant => variant.variantId)).size !== variants.length
    || new Set(variants.map(variant => variant.sku)).size !== variants.length) {
    throw new EbayListingPhotoError("EBAY_PHOTO_SCOPE_INVALID", "Select unique catalog sizes with their exact eBay SKUs.");
  }
}

/** Provider protocol validation, shared by Catalog, approved snapshots and retained pictures. */
export function assertEbayPhotoUrl(value: string): void {
  let url: URL;
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new EbayListingPhotoError("EBAY_PHOTO_URL_INVALID", "An eBay listing photo has an invalid address.");
  }
  try { url = new URL(value); }
  catch { throw new EbayListingPhotoError("EBAY_PHOTO_URL_INVALID", "An eBay listing photo has an invalid address."); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || url.port || !hostname.includes(".") || isIP(hostname)
    || /(?:^|\.)(?:localhost|local|internal)\.?$/i.test(hostname)) {
    throw new EbayListingPhotoError("EBAY_PHOTO_URL_INVALID", "eBay listing photos require a public HTTPS address.");
  }
}

/** Pre-resolved intent or snapshot URLs. Provider projection does not re-read Catalog. */
export function ebayListingImagesFromUrls(urls: readonly string[]): ChannelImagePayload[] {
  return urls.map((url, position) => ({ url, position, variantSku: null, altText: null }));
}

/** One ordering-preserving URL deduplication and limit for eBay replacements. */
export function resolveEbayListingPhotoUrls(urls: readonly string[]): string[] {
  urls.forEach(assertEbayPhotoUrl);
  return [...new Set(urls)].slice(0, EBAY_LISTING_MAX_PHOTOS);
}

export interface EbayListingPhotoPlan {
  byVariantId: ReadonlyMap<number, readonly string[]>;
  groupImageUrls: readonly string[];
}

/** Validate a resolved plan without reselecting, reordering or shortening its approved photos. */
export function assertEbayListingPhotoPlan(plan: EbayListingPhotoPlan, variants: readonly Pick<ChannelVariantPayload, "variantId" | "sku" | "isListed">[]): void {
  if (!plan || !(plan.byVariantId instanceof Map) || !Array.isArray(plan.groupImageUrls)
    || variants.some(variant => variant.isListed && variant.sku && !Array.isArray(plan.byVariantId.get(variant.variantId)))) {
    throw new EbayListingPhotoError("EBAY_PHOTO_SCOPE_INVALID", "The resolved eBay photo plan is missing an included SKU.");
  }
  plan.groupImageUrls.forEach(assertEbayPhotoUrl);
  for (const urls of plan.byVariantId.values()) {
    if (!Array.isArray(urls)) throw new EbayListingPhotoError("EBAY_PHOTO_INVALID", "The resolved eBay photo plan contains an invalid gallery.");
    urls.forEach(assertEbayPhotoUrl);
  }
}

/** One provider projection: stable order, exact SKU scope, deduplication and photo limit. */
export function buildEbayListingPhotoPlan(
  images: readonly ChannelImagePayload[],
  variants: readonly Pick<ChannelVariantPayload, "variantId" | "sku">[],
): EbayListingPhotoPlan {
  const scoped = variants.filter((variant): variant is EbayPhotoVariant => variant.sku !== null);
  assertEbayPhotoVariants(scoped);
  if (!Array.isArray(images)) throw new EbayListingPhotoError("EBAY_PHOTO_INVALID", "eBay listing photos must be an array.");
  for (const image of images) {
    if (!image || !Number.isSafeInteger(image.position) || image.position < 0
      || (image.variantSku !== null && (typeof image.variantSku !== "string" || !image.variantSku || image.variantSku.trim() !== image.variantSku))) {
      throw new EbayListingPhotoError("EBAY_PHOTO_INVALID", "An eBay listing photo has invalid metadata.");
    }
    assertEbayPhotoUrl(image.url);
  }
  const skus = new Set(scoped.map(variant => variant.sku));
  const ordered = images.map((image, index) => ({ image, index }))
    .sort((a, b) => a.image.position - b.image.position || a.index - b.index);
  const urlsFor = (sku: string | null, group: boolean): string[] => resolveEbayListingPhotoUrls(ordered
    .filter(({ image }) => image.variantSku === null || (group ? skus.has(image.variantSku) : image.variantSku === sku))
    .map(({ image }) => image.url));
  return { byVariantId: new Map(scoped.map(variant => [variant.variantId, urlsFor(variant.sku, false)])),
    groupImageUrls: urlsFor(null, true) };
}
