import type { PoolClient } from "pg";
import type { CatalogPublicationImageOverride } from "../catalog/catalog-publication-images.reader";
import { EbayListingPhotoError } from "./ebay-listing-photos.domain";

/** A channel may explicitly name an SKU differently; no fuzzy or cross-channel matching. */
export async function readChannelPhotoSkuAliases(client: PoolClient, channelId: number, variantIds: readonly number[]): Promise<Map<number, string>> {
  const result = await client.query<{ product_variant_id: number; sku_override: string }>(`
    SELECT product_variant_id, sku_override FROM channels.channel_variant_overrides
    WHERE channel_id=$1 AND product_variant_id=ANY($2::int[]) AND sku_override IS NOT NULL
  `, [channelId, variantIds]);
  return new Map(result.rows.map(row => [row.product_variant_id, row.sku_override]));
}

export async function readChannelPhotoOverrides(client: PoolClient, channelId: number, assetIds: readonly number[]): Promise<CatalogPublicationImageOverride[]> {
  const result = await client.query<{ product_asset_id: number; is_included: number; url_override: string | null; position_override: number | null }>(`
    SELECT product_asset_id, is_included, url_override, position_override FROM channels.channel_asset_overrides
    WHERE channel_id=$1 AND product_asset_id=ANY($2::int[]) ORDER BY product_asset_id
  `, [channelId, assetIds]);
  return result.rows.map(row => {
    if (row.is_included !== 0 && row.is_included !== 1) {
      throw new EbayListingPhotoError("EBAY_PHOTO_OVERRIDE_INVALID", "An eBay photo inclusion setting is invalid.", { assetId: row.product_asset_id });
    }
    return { assetId: row.product_asset_id, included: row.is_included === 1, urlOverride: row.url_override, positionOverride: row.position_override };
  });
}
