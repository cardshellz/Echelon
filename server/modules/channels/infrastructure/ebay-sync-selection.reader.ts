import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { VARIANT_SALES_ELIGIBILITIES } from "@shared/catalog/variant-sales-eligibility";
import { isProductEffectivelyListed, isVariantSellable } from "../ebay-listing-eligibility";
import type { ChannelListingSyncState } from "../../marketplace-listings/domain/channel-listing-sync";
import { EbayListingSyncError } from "../ebay-listing-sync.domain";
import type { SyncFilter } from "./ebay-active-listing-sync";

const variant = z.object({
  id: z.number().int().positive(), active: z.boolean().nullable(),
  excluded: z.boolean().nullable(), isListed: z.number().nullable(),
  salesEligibility: z.enum(VARIANT_SALES_ELIGIBILITIES).nullable(),
});
const rowSchema = z.object({
  id: z.number().int().positive(), name: z.string(), sku: z.string().nullable(),
  productType: z.string().nullable(), active: z.boolean().nullable(),
  excluded: z.boolean().nullable(), isListed: z.number().nullable(),
  typeEnabled: z.boolean().nullable(), hasPublishedIdentity: z.boolean(),
  variants: z.array(variant),
});
export class EbaySyncSelectionReader {
  constructor(private readonly database: Pick<Pool | PoolClient, "query">, private readonly channelId: number) {}
  async read(filter: SyncFilter | null = null) {
    const rows = await this.database.query(`
      SELECT p.id,COALESCE(p.name,p.sku,'Product '||p.id::text) AS name,p.sku,
        p.product_type AS "productType",p.is_active AS active,p.ebay_listing_excluded AS excluded,
        co.is_listed AS "isListed",cm.listing_enabled AS "typeEnabled",
        EXISTS(SELECT 1 FROM channels.channel_listings l JOIN catalog.product_variants v ON v.id=l.product_variant_id
          WHERE l.channel_id=$1 AND v.product_id=p.id AND l.external_product_id IS NOT NULL) AS "hasPublishedIdentity",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',v.id,'active',v.is_active,
          'excluded',v.ebay_listing_excluded,'isListed',vo.is_listed,'salesEligibility',v.sales_eligibility) ORDER BY v.id)
          FROM catalog.product_variants v LEFT JOIN channels.channel_variant_overrides vo
          ON vo.channel_id=$1 AND vo.product_variant_id=v.id WHERE v.product_id=p.id),'[]'::jsonb) AS variants
      FROM catalog.products p LEFT JOIN channels.channel_product_overrides co ON co.channel_id=$1 AND co.product_id=p.id
      LEFT JOIN ebay.ebay_category_mappings cm ON cm.channel_id=$1 AND cm.product_type_slug=p.product_type
      WHERE ($2::int[] IS NULL OR p.id=ANY($2))
        AND ($3::text[] IS NULL OR p.product_type=ANY($3))
        AND ($4::int[] IS NULL OR EXISTS(SELECT 1 FROM catalog.product_variants v WHERE v.product_id=p.id AND v.id=ANY($4)))
      ORDER BY p.id`, [this.channelId, filter?.productIds ?? null, filter?.productTypeSlugs ?? null, filter?.variantIds ?? null]);
    return rows.rows.map(raw => {
      const row = rowSchema.parse(raw);
      const intent = { productExcluded: row.excluded, productOverrideIsListed: row.isListed, typeListingEnabled: row.typeEnabled };
      const state: ChannelListingSyncState = {
        active: row.active === true, included: isProductEffectivelyListed(intent),
        includedVariantCount: row.variants.filter(v => isVariantSellable({
          ...intent, productActive: row.active, variantActive: v.active,
          variantExcluded: v.excluded, variantOverrideIsListed: v.isListed, salesEligibility: v.salesEligibility,
        })).length,
        hasPublishedIdentity: row.hasPublishedIdentity,
      };
      return { productId: row.id, name: row.name, sku: row.sku, state };
    });
  }
  async product(productId: number) {
    const product = (await this.read({ productIds: [productId] }))[0];
    if (!product) throw new EbayListingSyncError("EBAY_SYNC_PRODUCT_NOT_FOUND", "This product no longer exists. Refresh the listing feed.");
    return product;
  }
}
