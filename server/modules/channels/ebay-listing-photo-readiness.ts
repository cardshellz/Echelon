import type { PoolClient } from "pg";
import type { CatalogPublicImageUrl } from "../catalog/catalog-public-image";
import {
  PgCatalogVariantPublicationPhotoReader,
  readCatalogPublicationPhotoScope,
} from "../catalog/catalog-publication-images.reader";
import { readChannelPhotoOverrides } from "./ebay-listing-photos.repository";
import { EBAY_LISTING_MAX_PHOTOS } from "./ebay-listing-photos.domain";

/** Readiness is a projection of the publication selector, never a raw asset count. */
export async function readEbayListingPhotoReadiness(
  client: Pick<PoolClient, "query">,
  input: {
    productId: number;
    channelId: number;
    variantIds: readonly number[];
  },
  publicUrl: CatalogPublicImageUrl,
) {
  const scope = await readCatalogPublicationPhotoScope(client, input.productId);
  const overrides = await readChannelPhotoOverrides(
    client,
    input.channelId,
    scope.assetIds,
  );
  const mediaPlan = await new PgCatalogVariantPublicationPhotoReader(
    client,
    publicUrl,
  ).listPublicationPlan({
    productId: input.productId,
    productVariantIds: input.variantIds,
    maxPhotosPerVariant: EBAY_LISTING_MAX_PHOTOS,
    maxGroupPhotos: EBAY_LISTING_MAX_PHOTOS,
    overrides,
  });
  return {
    mediaPlan,
    ready:
      mediaPlan.variants.length > 0 &&
      mediaPlan.variants.every(
        ({ gallery }) =>
          gallery.selected.length > 0 &&
          !gallery.omissions.some((omission) => omission.blocking),
      ),
    // Preserving an existing external gallery requires a provider observation;
    // a Catalog-only feed must not manufacture that evidence.
    requiresProviderObservation: scope.assetIds.length === 0,
  };
}
