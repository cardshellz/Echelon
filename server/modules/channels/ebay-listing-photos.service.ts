import type { Pool } from "pg";
import type { ChannelImagePayload } from "./channel-adapter.interface";
import {
  PgCatalogVariantPublicationPhotoReader,
  readCatalogPublicationPhotoScope,
} from "../catalog/catalog-publication-images.reader";
import { readChannelPhotoOverrides, readChannelPhotoSkuAliases } from "./ebay-listing-photos.repository";
import type { CatalogPublicImageUrl } from "../catalog/catalog-public-image";
import {
  EBAY_LISTING_MAX_PHOTOS, EbayListingPhotoError, assertEbayPhotoUrl, assertEbayPhotoVariants,
  buildEbayListingPhotoPlan, resolveEbayListingPhotoUrls, type EbayListingPhotoPlan, type EbayPhotoVariant,
} from "./ebay-listing-photos.domain";

export interface EbayListingPhotoRequest {
  productId: number;
  channelId: number;
  variants: readonly EbayPhotoVariant[];
  /** Source locks determine whether Echelon may replace provider photos. Explicit pushes default to Catalog. */
  mode?: "catalog" | "preserve";
  /** Read only: preserves existing pictures when required, or when Catalog genuinely has no images. */
  readExistingPhotos?: () => Promise<EbayListingPhotoPlan>;
}
export interface EbayListingPhotoResolver {
  resolve(input: EbayListingPhotoRequest): Promise<EbayListingPhotoPlan>;
}

/** One Catalog selection contract for direct eBay writers and Dropship previews. No inventory writes. */
export class ChannelEbayListingPhotoResolver implements EbayListingPhotoResolver {
  constructor(private readonly database: Pick<Pool, "connect">, private readonly publicUrl: CatalogPublicImageUrl) {}

  async resolve(input: EbayListingPhotoRequest): Promise<EbayListingPhotoPlan> {
    validateRequest(input);
    try { return await this.resolveValidated(input); }
    catch (error) {
      console.error(JSON.stringify({ event: "ebay_listing_photo_resolution_failed", productId: input.productId, channelId: input.channelId,
        code: error instanceof EbayListingPhotoError ? error.code : "EBAY_PHOTO_READ_FAILED",
        context: error instanceof EbayListingPhotoError ? error.context : {} }));
      throw error;
    }
  }

  private async resolveValidated(input: EbayListingPhotoRequest): Promise<EbayListingPhotoPlan> {
    const client = await this.database.connect();
    const images: ChannelImagePayload[] = [];
    let hasCatalogAssets = false;
    let retainedGroupPhotos: readonly string[] | undefined;
    let discarded = false;
    try {
      // Scope, channel overlays, order and file hashes must come from the same committed version.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const scope = await readCatalogPublicationPhotoScope(client, input.productId);
      const skuByVariantId = new Map(scope.variants.map(variant => [variant.variantId, variant.sku]));
      const skuAliases = await readChannelPhotoSkuAliases(client, input.channelId, input.variants.map(variant => variant.variantId));
      if (input.variants.some(variant => !skuByVariantId.has(variant.variantId)
        || (skuByVariantId.get(variant.variantId) !== variant.sku && skuAliases.get(variant.variantId) !== variant.sku))) {
        throw new EbayListingPhotoError("EBAY_PHOTO_SCOPE_INVALID", "An eBay photo request contains a size or SKU from another catalog product.", { productId: input.productId });
      }
      hasCatalogAssets = scope.assetIds.length > 0;
      if (input.mode !== "preserve" && hasCatalogAssets) {
        const overrides = await readChannelPhotoOverrides(client, input.channelId, scope.assetIds);
        const photos = await new PgCatalogVariantPublicationPhotoReader(client, this.publicUrl).listPublicationPhotos({
          productId: input.productId, productVariantIds: input.variants.map(variant => variant.variantId),
          maxPhotosPerVariant: EBAY_LISTING_MAX_PHOTOS, overrides,
        });
        for (const variant of input.variants) {
          const resolved = photos.get(variant.variantId);
          if (!resolved) throw new EbayListingPhotoError("EBAY_PHOTO_SCOPE_INVALID", "Catalog omitted a requested eBay size.");
          if (resolved.issues.length) {
            throw new EbayListingPhotoError("EBAY_CATALOG_PHOTO_UNAVAILABLE", resolved.issues[0].message,
              { productId: input.productId, variantId: variant.variantId, issues: resolved.issues });
          }
          if (resolved.photos.length === 0) {
            throw new EbayListingPhotoError("EBAY_CATALOG_PHOTO_REQUIRED", `No included catalog photo is available for eBay SKU ${variant.sku}.`,
              { productId: input.productId, variantId: variant.variantId });
          }
          for (const photo of resolved.photos) {
            assertEbayPhotoUrl(photo.url);
            images.push({ url: photo.url, position: photo.position, variantSku: variant.sku, altText: null });
          }
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) {
        discarded = true;
        client.release(true);
        throw new AggregateError([error, rollbackError], "eBay photo read and rollback failed.");
      }
      throw error;
    } finally {
      if (!discarded) client.release();
    }
    if (input.mode === "preserve" || !hasCatalogAssets) {
      if (!input.readExistingPhotos) throw photoRequired(input.productId);
      // Release the read-only transaction before a network call; a provider error must never become empty photos.
      const existing = await input.readExistingPhotos();
      const retained = validateExistingPhotos(existing, input.variants);
      if (input.mode === "preserve") {
        if (input.variants.length > 1 && retained.groupImageUrls.length === 0) {
          throw new EbayListingPhotoError("EBAY_EXISTING_GROUP_PHOTOS_REQUIRED", "Existing eBay group photos are unavailable; verify the listing group before syncing other content.");
        }
        return retained;
      }
      if (retained.groupImageUrls.length) retainedGroupPhotos = resolveEbayListingPhotoUrls(retained.groupImageUrls);
      // Catalog is empty: retain each SKU's pictures, using the group's gallery for a SKU with no pictures.
      for (const variant of input.variants) {
        const urls = retained.byVariantId.get(variant.variantId)!;
        for (const [position, url] of (urls.length ? urls : retained.groupImageUrls).entries()) {
          images.push({ url, position, variantSku: variant.sku, altText: null });
        }
      }
    }
    if (images.length === 0) throw photoRequired(input.productId);
    const plan = buildEbayListingPhotoPlan(images, input.variants);
    return retainedGroupPhotos ? { ...plan, groupImageUrls: retainedGroupPhotos } : plan;
  }
}

function validateExistingPhotos(plan: EbayListingPhotoPlan, variants: readonly EbayPhotoVariant[]): EbayListingPhotoPlan {
  if (!plan || !(plan.byVariantId instanceof Map) || !Array.isArray(plan.groupImageUrls)
    || variants.some(variant => !Array.isArray(plan.byVariantId.get(variant.variantId)))) {
    throw new EbayListingPhotoError("EBAY_PHOTO_READ_FAILED", "eBay did not return a complete listing photo snapshot.");
  }
  plan.groupImageUrls.forEach(assertEbayPhotoUrl);
  const byVariantId = new Map(variants.map(variant => {
    const urls = plan.byVariantId.get(variant.variantId)!;
    urls.forEach(assertEbayPhotoUrl);
    return [variant.variantId, [...urls]] as const;
  }));
  if (plan.groupImageUrls.length === 0 && [...byVariantId.values()].every(urls => urls.length === 0)) throw photoRequired();
  // Source-locked fields keep the provider's exact order and count, including empty SKU galleries in a group.
  return { byVariantId, groupImageUrls: [...plan.groupImageUrls] };
}

function photoRequired(productId?: number): EbayListingPhotoError {
  return new EbayListingPhotoError("EBAY_CATALOG_PHOTO_REQUIRED", "Add a catalog photo before publishing this eBay listing.", { productId });
}

function validateRequest(input: EbayListingPhotoRequest): void {
  const validId = (id: number) => Number.isInteger(id) && id > 0 && id <= 2_147_483_647;
  if (!input || !validId(input.productId) || !validId(input.channelId)
    || (input.mode !== undefined && input.mode !== "catalog" && input.mode !== "preserve")
    || (input.readExistingPhotos !== undefined && typeof input.readExistingPhotos !== "function")) {
    throw new EbayListingPhotoError("EBAY_PHOTO_SCOPE_INVALID", "Select an exact product, channel and photo sync mode.");
  }
  assertEbayPhotoVariants(input.variants);
}
