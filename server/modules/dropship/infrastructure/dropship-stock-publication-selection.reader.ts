import { createHash } from "node:crypto";
import { z } from "zod";
import {
  stockPublicationSelectionSchema,
  type StockPublicationSelection,
  type StockSelectionQueryClient,
} from "@shared/types/stock-publication-selection";
import { readCatalogStockSelectionFacts } from "../../catalog/catalog-stock-selection.reader";
import { parseCatalogVariantUomType } from "../domain/listing-tiers";
import { DropshipError } from "../domain/errors";
import { decideDropshipStockPublicationSelection } from "../domain/stock-publication-selection";

const id = z.number().int().positive().max(2_147_483_647);
const inputSchema = z.object({
  storeConnectionId: id, productId: id, productVariantIds: z.array(id), now: z.date(),
}).strict().superRefine((input, ctx) => {
  if (new Set(input.productVariantIds).size !== input.productVariantIds.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["productVariantIds"], message: "Variant IDs must be unique." });
});
const configSchema = z.object({
  listingMode: z.enum(["draft_first", "live", "manual_only"]),
  inventoryMode: z.enum(["managed_quantity_sync", "manual_quantity", "disabled"]),
  isActive: z.boolean(),
});
const storeSchema = z.object({
  id, vendorId: id, platform: z.string(), externalAccountId: z.string().nullable(),
  providerEnvironment: z.string().nullable(), status: z.string(), config: configSchema.nullable(),
});
const targetSchema = z.object({
  id, scopeType: z.enum(["catalog", "product_line", "category", "product", "variant"]),
  action: z.enum(["include", "exclude"]), productLineId: id.nullable(), productId: id.nullable(),
  productVariantId: id.nullable(), category: z.string().nullable(),
});
const exposureRuleSchema = targetSchema.extend({ startsAt: z.date().nullable(), endsAt: z.date().nullable() });
const vendorRuleSchema = targetSchema.extend({ autoConnectNewSkus: z.boolean(), autoListNewSkus: z.boolean() });
const overrideSchema = z.object({ productVariantId: id, enabledOverride: z.boolean().nullable() });
const listingSchema = z.object({
  id, productVariantId: id,
  status: z.enum(["not_listed", "preview_ready", "queued", "pushing", "active", "paused", "ended", "failed", "blocked", "drift_detected"]),
  externalListingId: z.string().min(1).nullable(), externalOfferId: z.string().min(1).nullable(),
  livePushItemId: id.nullable(),
});

/** Read the exact destination's current listing intent through Dropship's rules.
 * No ATP, credentials, photos, provider requests, locks or writes. The caller can
 * use its existing transaction to obtain a consistent publication snapshot. */
export async function readDropshipListingStockSelection(client: StockSelectionQueryClient, raw: {
  storeConnectionId: number; productId: number; productVariantIds: readonly number[]; now: Date;
}): Promise<StockPublicationSelection> {
  const input = inputSchema.parse(raw);
  const productVariantIds = [...input.productVariantIds].sort((a, b) => a - b);
  const stores = (await client.query(`SELECT sc.id, sc.vendor_id AS "vendorId", sc.platform,
    sc.external_account_id AS "externalAccountId", sc.provider_environment AS "providerEnvironment", sc.status,
    CASE WHEN lc.id IS NULL THEN NULL ELSE jsonb_build_object('listingMode',lc.listing_mode,
      'inventoryMode',lc.inventory_mode,'isActive',lc.is_active) END AS config
    FROM dropship.dropship_store_connections sc
    LEFT JOIN dropship.dropship_store_listing_configs lc ON lc.store_connection_id=sc.id AND lc.platform=sc.platform
    WHERE sc.id=$1`, [input.storeConnectionId])).rows;
  if (stores.length > 1) throw new DropshipError("DROPSHIP_STOCK_SELECTION_AMBIGUOUS",
    "Multiple listing configurations describe this store connection.");
  const rawStore = stores[0];
  if (!rawStore) throw new DropshipError("DROPSHIP_STOCK_STORE_NOT_FOUND",
    "The selected Dropship store connection no longer exists.", { storeConnectionId: input.storeConnectionId });
  const store = storeSchema.parse(rawStore);
  const catalog = await readCatalogStockSelectionFacts(client, { productId: input.productId, productVariantIds });
  const rules = z.array(exposureRuleSchema).parse((await client.query(`SELECT id,scope_type AS "scopeType",action,
    product_line_id AS "productLineId",product_id AS "productId",product_variant_id AS "productVariantId",category,
    starts_at AS "startsAt",ends_at AS "endsAt" FROM dropship.dropship_catalog_rules
    WHERE is_active=true ORDER BY priority ASC,id ASC`)).rows);
  const vendorRules = z.array(vendorRuleSchema).parse((await client.query(`SELECT id,scope_type AS "scopeType",action,
    product_line_id AS "productLineId",product_id AS "productId",product_variant_id AS "productVariantId",category,
    auto_connect_new_skus AS "autoConnectNewSkus",auto_list_new_skus AS "autoListNewSkus"
    FROM dropship.dropship_vendor_selection_rules WHERE vendor_id=$1 AND is_active=true ORDER BY priority DESC,id ASC`,
  [store.vendorId])).rows);
  const overrides = z.array(overrideSchema).parse(productVariantIds.length ? (await client.query(`SELECT
    product_variant_id AS "productVariantId",enabled_override AS "enabledOverride"
    FROM dropship.dropship_vendor_variant_overrides WHERE vendor_id=$1 AND product_variant_id=ANY($2::integer[])
    ORDER BY product_variant_id`, [store.vendorId, productVariantIds])).rows : []);
  const listings = z.array(listingSchema).parse(productVariantIds.length ? (await client.query(`SELECT vl.id,
    vl.product_variant_id AS "productVariantId",vl.status,vl.external_listing_id AS "externalListingId",
    vl.external_offer_id AS "externalOfferId", intent.id AS "livePushItemId"
    FROM dropship.dropship_vendor_listings vl
    LEFT JOIN LATERAL (SELECT ji.id FROM dropship.dropship_listing_push_job_items ji
      INNER JOIN dropship.dropship_listing_push_jobs j ON j.id=ji.job_id
      WHERE j.vendor_id=vl.vendor_id AND j.store_connection_id=vl.store_connection_id
        AND ji.product_variant_id=vl.product_variant_id AND ji.listing_id=vl.id
        AND j.job_type='push' AND ji.action='push' AND j.status<>'cancelled' AND ji.status<>'cancelled'
        AND ji.result->'listingIntent'->>'listingMode'='live'
        AND ji.result->'listingIntent'->>'inventoryMode'='managed_quantity_sync'
        AND ji.result->'listingIntent'->>'productVariantId'=vl.product_variant_id::text
        AND ji.result->'listingIntent'->>'platform'=vl.platform
        AND (vl.status<>'ended' OR ji.created_at>vl.updated_at)
      ORDER BY ji.id DESC LIMIT 1) intent ON true
    WHERE vl.vendor_id=$1 AND vl.store_connection_id=$2 AND vl.product_variant_id=ANY($3::integer[])
      AND vl.platform=$4 ORDER BY vl.product_variant_id`,
  [store.vendorId, store.id, productVariantIds, store.platform])).rows : []);
  if ([listings, overrides].some(rows => new Set(rows.map(row => row.productVariantId)).size !== rows.length))
    throw new DropshipError("DROPSHIP_STOCK_SELECTION_AMBIGUOUS", "Multiple saved selections or listings describe this store variant.");
  const variants = productVariantIds.map(productVariantId => {
    const variant = catalog.variants.find(row => row.id === productVariantId);
    const product = catalog.product;
    return decideDropshipStockPublicationSelection({
      productVariantId,
      candidate: product && variant ? {
        productId: product.id, productVariantId, productLineIds: product.productLineIds,
        category: product.category, productIsActive: product.isActive, productStatus: product.status, variantIsActive: variant.isActive,
        variantUomType: parseCatalogVariantUomType(variant.uomType, { productVariantId }),
        requiresShipping: variant.requiresShipping, trackInventory: variant.trackInventory,
        salesEligibility: variant.salesEligibility,
      } : null,
      rules, vendorRules, override: overrides.find(row => row.productVariantId === productVariantId) ?? null,
      listing: listings.find(row => row.productVariantId === productVariantId) ?? null,
      config: store.config, storePaused: store.status === "paused", now: input.now,
    });
  });
  // Fingerprints describe effective intent and exact identity, not the time a
  // preview happened or a changing stock balance. Scheduled rules affect it when
  // their effective decision changes.
  const fingerprint = createHash("sha256").update(JSON.stringify({
    productId: input.productId, store, catalog, listings,
    // Additive listing status metadata must not invalidate existing stock proofs.
    variants: variants.map(({ listingSelected: _listingSelected, ...stockDecision }) => stockDecision),
  })).digest("hex");
  return stockPublicationSelectionSchema.parse({ productId: input.productId, fingerprint, variants });
}
