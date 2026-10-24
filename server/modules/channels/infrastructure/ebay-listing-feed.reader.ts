import type { Pool } from "pg";
import { ChannelPricingResolutionError } from "../channel-pricing-resolver";
import type { readEbayListingPhotoReadiness } from "../ebay-listing-photo-readiness";
import { isProductEffectivelyListed, isVariantEffectivelyListed, isExistingEbayListingSyncCandidate } from "../ebay-listing-eligibility";
import { resolveEbayListingIssue } from "@shared/ebay-listing-issue";
import { isInventoryManagedVariant } from "@shared/catalog/variant-inventory-eligibility";
import type { EbayListingFeedInventoryService } from "../application/ebay-listing-feed-inventory.service";
import { resolveEbayFeedListingState, type EbayFeedVariantListingState } from "../ebay-listing-feed-status";
import { isValidEbayFixedPriceCents, normalizeCents } from "../ebay-listing-draft";
import { EbaySyncSelectionReader } from "./ebay-sync-selection.reader";

interface FeedDependencies {
  inventory: Pick<EbayListingFeedInventoryService, "readProduct">;
  readPhotos(input: Parameters<typeof readEbayListingPhotoReadiness>[1]): ReturnType<typeof readEbayListingPhotoReadiness>;
  resolvePrice(productId: number, variantId: number, basePriceCents: number): Promise<number>;
}

interface ListingFeedVariant {
  id: number;
  sku: string;
  name: string | null;
  priceCents: number | null;
  ebayListingExcluded: boolean;
  explicitlyExcluded: boolean;
  excludedByProduct: boolean;
  effectivelyListed: boolean;
  fulfillmentPolicyOverride: string | null;
  returnPolicyOverride: string | null;
  paymentPolicyOverride: string | null;
}

/** Read projection only. Each database query releases its lease before nested
 * inventory, price or photo reads. Never hold a session across these owners. */
export class EbayListingFeedReader {
  constructor(private readonly database: Pick<Pool, "query">, private readonly channelId: number,
    private readonly dependencies: FeedDependencies) {}
  async read() {
    const client = this.database;
    // The same selection owner defines feed visibility and bulk membership.
    const selection = await new EbaySyncSelectionReader(client, this.channelId).read();
    const selected = new Map(selection.filter(row => row.selection.visible).map(row => [row.productId, row.selection]));
    if (!selected.size) return { feed: [], total: 0, syncIncludedCount: 0 };
    const result = await client.query(`
      SELECT
        p.id,
        p.name,
        p.sku,
        p.product_type,
        p.is_active,
        pt.name AS product_type_name,
        p.ebay_browse_category_id AS product_ebay_browse_category_id,
        p.ebay_browse_category_name AS product_ebay_browse_category_name,
        ecm.ebay_browse_category_id,
        ecm.ebay_browse_category_name,
        ecm.ebay_store_category_id,
        ecm.ebay_store_category_name,
        (SELECT COUNT(*) FROM product_variants pv WHERE pv.product_id = p.id AND pv.sku IS NOT NULL AND pv.is_active = true AND pv.sales_eligibility = 'sellable') AS variant_count,
        listing_identity.external_product_id,
        listing_identity.external_product_id_count,
        p.ebay_listing_excluded,
        cpo.is_listed AS product_override_is_listed,
        COALESCE(ecm.listing_enabled, true) AS type_listing_enabled,
        p.ebay_fulfillment_policy_override AS product_fulfillment_override,
        p.ebay_return_policy_override AS product_return_override,
        p.ebay_payment_policy_override AS product_payment_override
      FROM products p
      LEFT JOIN product_types pt ON pt.slug = p.product_type
      LEFT JOIN ebay_category_mappings ecm ON ecm.product_type_slug = p.product_type AND ecm.channel_id = $1
      LEFT JOIN channels.channel_product_overrides cpo ON cpo.product_id = p.id AND cpo.channel_id = $1
      LEFT JOIN LATERAL (
        SELECT
          MIN(cl3.external_product_id) AS external_product_id,
          COUNT(DISTINCT cl3.external_product_id)::integer AS external_product_id_count
        FROM channels.channel_listings cl3
        JOIN catalog.product_variants pv3 ON pv3.id = cl3.product_variant_id
        WHERE pv3.product_id = p.id
          AND pv3.is_active = true
          AND cl3.channel_id = $1
          AND cl3.external_product_id IS NOT NULL
      ) listing_identity ON true
      WHERE p.id = ANY($2::int[])
      ORDER BY pt.sort_order ASC, p.name ASC
    `, [this.channelId, [...selected.keys()]]);

    // Fetch variants for all products in the feed
    const productIds = result.rows.map((r: any) => r.id);
    const variantsByProduct = new Map<number, ListingFeedVariant[]>();
    const listingStatesByProduct = new Map<number, Array<EbayFeedVariantListingState & { externalOfferId: string | null }>>();
    const inventoryManagedVariantIds = new Set<number>();
    if (productIds.length > 0) {
      const varResult = await client.query(`
        SELECT
          pv.id,
          pv.product_id,
          pv.sku,
          pv.name,
          pv.price_cents,
          pv.requires_shipping,
          pv.track_inventory,
          pv.ebay_listing_excluded,
          cvo.is_listed AS variant_override_is_listed,
          pv.ebay_fulfillment_policy_override AS variant_fulfillment_override,
          pv.ebay_return_policy_override AS variant_return_override,
          pv.ebay_payment_policy_override AS variant_payment_override,
          cl.id AS listing_id, cl.external_product_id AS external_listing_id,
          cl.external_variant_id AS external_offer_id,
          cl.sync_status AS listing_status, cl.sync_error AS listing_sync_error
        FROM product_variants pv
        LEFT JOIN channels.channel_variant_overrides cvo ON cvo.product_variant_id = pv.id AND cvo.channel_id = $2
        LEFT JOIN channels.channel_listings cl ON cl.product_variant_id = pv.id AND cl.channel_id = $2
        WHERE pv.product_id = ANY($1) AND pv.sku IS NOT NULL AND pv.is_active = true
          AND pv.sales_eligibility = 'sellable'
        ORDER BY pv.product_id, pv.position ASC, pv.id ASC
      `, [productIds, this.channelId]);

      for (const v of varResult.rows) {
        const pid = v.product_id;
        if (isInventoryManagedVariant({ requiresShipping: v.requires_shipping, trackInventory: v.track_inventory })) {
          inventoryManagedVariantIds.add(v.id);
        }
        if (!listingStatesByProduct.has(pid)) listingStatesByProduct.set(pid, []);
        listingStatesByProduct.get(pid)!.push({ variantId: v.id, listingRecordId: v.listing_id,
          externalListingId: v.external_listing_id?.trim() || null,
          externalOfferId: v.external_offer_id?.trim() || null,
          syncStatus: v.listing_status, syncError: v.listing_sync_error });
        if (!variantsByProduct.has(pid)) variantsByProduct.set(pid, []);
        variantsByProduct.get(pid)!.push({
          id: v.id,
          sku: v.sku,
          name: v.name,
          priceCents: v.price_cents,
          ebayListingExcluded: v.ebay_listing_excluded === true || v.variant_override_is_listed === 0,
          explicitlyExcluded: v.ebay_listing_excluded === true || v.variant_override_is_listed === 0,
          excludedByProduct: false,
          effectivelyListed: true,
          fulfillmentPolicyOverride: v.variant_fulfillment_override ?? null,
          returnPolicyOverride: v.variant_return_override ?? null,
          paymentPolicyOverride: v.variant_payment_override ?? null,
        });
      }
    }

    // Fetch required aspects per category and type defaults + product overrides
    // Build lookup maps for aspect checking
    const categoryIds = new Set<string>();
    const productTypeSlugs = new Set<string>();
    const feedProductIds = result.rows.map((r: any) => r.id);

    for (const row of result.rows) {
      const catId = row.product_ebay_browse_category_id || row.ebay_browse_category_id;
      if (catId) categoryIds.add(catId);
      if (row.product_type) productTypeSlugs.add(row.product_type);
    }

    // Required aspects per category
    const requiredAspectsByCategory: Map<string, string[]> = new Map();
    if (categoryIds.size > 0) {
      const catIdsArr = Array.from(categoryIds);
      const reqResult = await client.query(
        `SELECT category_id, aspect_name FROM ebay_category_aspects
         WHERE category_id = ANY($1) AND aspect_required = true`,
        [catIdsArr],
      );
      for (const r of reqResult.rows) {
        const existing = requiredAspectsByCategory.get(r.category_id) || [];
        existing.push(r.aspect_name);
        requiredAspectsByCategory.set(r.category_id, existing);
      }
    }

    // Type defaults per slug
    const typeDefaultsBySlug: Map<string, Set<string>> = new Map();
    if (productTypeSlugs.size > 0) {
      const slugsArr = Array.from(productTypeSlugs);
      const tdResult = await client.query(
        `SELECT product_type_slug, aspect_name FROM ebay_type_aspect_defaults
         WHERE product_type_slug = ANY($1)`,
        [slugsArr],
      );
      for (const r of tdResult.rows) {
        if (!typeDefaultsBySlug.has(r.product_type_slug))
          typeDefaultsBySlug.set(r.product_type_slug, new Set());
        typeDefaultsBySlug.get(r.product_type_slug)!.add(r.aspect_name);
      }
    }

    // Product overrides per product
    const overridesByProduct: Map<number, Set<string>> = new Map();
    if (feedProductIds.length > 0) {
      const poResult = await client.query(
        `SELECT product_id, aspect_name FROM ebay_product_aspect_overrides
         WHERE product_id = ANY($1)`,
        [feedProductIds],
      );
      for (const r of poResult.rows) {
        if (!overridesByProduct.has(r.product_id))
          overridesByProduct.set(r.product_id, new Set());
        overridesByProduct.get(r.product_id)!.add(r.aspect_name);
      }
    }

    // Determine readiness for each product
    const feed: any[] = [];
    for (const row of result.rows) {
      // Effective category: product override wins, then type mapping
      const effectiveCategoryId = row.product_ebay_browse_category_id || row.ebay_browse_category_id || null;
      const effectiveCategoryName = row.product_ebay_browse_category_name || row.ebay_browse_category_name || null;

      const hasCategoryMapping = !!effectiveCategoryId;
      const hasVariants = (row.variant_count || 0) > 0;

      const productExcludedByIntent = !isProductEffectivelyListed({
        productExcluded: row.ebay_listing_excluded === true,
        productOverrideIsListed: row.product_override_is_listed,
      });
      const productEffectivelyListed = isProductEffectivelyListed({
        productExcluded: row.ebay_listing_excluded === true,
        productOverrideIsListed: row.product_override_is_listed,
        typeListingEnabled: row.type_listing_enabled,
      });
      const isExcluded = productExcludedByIntent;
      const isTypeDisabled = row.type_listing_enabled === false;

      const listingVariants = (variantsByProduct.get(row.id) || []).map((v) => {
        const effectivelyListed = isVariantEffectivelyListed({
          productExcluded: row.ebay_listing_excluded === true,
          productOverrideIsListed: row.product_override_is_listed,
          typeListingEnabled: row.type_listing_enabled,
          variantExcluded: v.explicitlyExcluded,
        });
        return {
          ...v,
          excludedByProduct: !productEffectivelyListed,
          effectivelyListed,
        };
      });
      // Reuse the listing and inventory eligibility owners for expected rows.
      // Read failures are local to this product and never trigger publication.
      const inventory = await this.dependencies.inventory.readProduct(row.id,
        listingVariants.map((variant: { id: number }) => variant.id),
        listingVariants.filter((variant: { id: number; effectivelyListed: boolean }) => variant.effectivelyListed
          && inventoryManagedVariantIds.has(variant.id)).map((variant: { id: number }) => variant.id));
      const variants = listingVariants.map((variant) => ({ ...variant,
        inventoryQuantity: inventory.quantities.get(variant.id) ?? null }));
      const includedVariants = variants.filter((v: any) => v.effectivelyListed);
      const mediaReadiness = await this.dependencies.readPhotos({
        productId: row.id, channelId: this.channelId, variantIds: includedVariants.map(variant => variant.id),
      });
      const hasImages = mediaReadiness.ready;
      const includedVariantIds = new Set(includedVariants.map(variant => variant.id));
      const canSyncExistingListing = (listingStatesByProduct.get(row.id) ?? []).some(state =>
        isExistingEbayListingSyncCandidate({
          productActive: row.is_active,
          // The variant query admits only active, sellable catalog rows.
          variantActive: true,
          salesEligibility: "sellable",
          productExcluded: row.ebay_listing_excluded,
          productOverrideIsListed: row.product_override_is_listed,
          typeListingEnabled: row.type_listing_enabled,
          variantExcluded: !includedVariantIds.has(state.variantId),
          syncStatus: state.syncStatus,
          externalListingId: state.listingRecordId === null ? null : state.externalListingId,
          externalOfferId: state.listingRecordId === null ? null : state.externalOfferId,
        }));
      const listingState = resolveEbayFeedListingState(listingStatesByProduct.get(row.id) ?? [], includedVariants.map((variant: { id: number }) => variant.id));
      const isListed = listingState.isListed;
      const isEnded = listingState.isEnded;
      const isError = listingState?.syncStatus === "error";
      const listingSyncError = listingState?.syncError || null;
      const includedVariantCount = includedVariants.length;
      const missingPriceSkus: string[] = [];
      let priceIssue: ReturnType<typeof resolveEbayListingIssue> | null = null;
      for (const variant of includedVariants) {
        const basePriceCents = normalizeCents(variant.priceCents);
        try {
          const effectivePriceCents = await this.dependencies.resolvePrice(row.id, variant.id, basePriceCents ?? 0);
          if (!isValidEbayFixedPriceCents(effectivePriceCents)) missingPriceSkus.push(variant.sku);
        } catch (error) {
          if (!(error instanceof ChannelPricingResolutionError)) throw error;
          // A known source conflict blocks this product, not the entire listing feed.
          missingPriceSkus.push(variant.sku);
          priceIssue ??= resolveEbayListingIssue({ code: error.code, message: error.message, productId: row.id });
        }
      }
      const hasValidEbayPrices = includedVariantCount > 0 && missingPriceSkus.length === 0;

      // Check for missing required aspects
      const missingAspects: string[] = [];
      if (effectiveCategoryId) {
        const requiredAspects = requiredAspectsByCategory.get(effectiveCategoryId) || [];
        const filledTypeDefaults = typeDefaultsBySlug.get(row.product_type) || new Set();
        const filledOverrides = overridesByProduct.get(row.id) || new Set();
        // This projection checks persisted type defaults and product overrides.
        for (const reqAspect of requiredAspects) {
          if (!filledTypeDefaults.has(reqAspect) && !filledOverrides.has(reqAspect)) {
            missingAspects.push(reqAspect);
          }
        }
      }

      let status: string;
      if (isExcluded) status = "excluded";
      else if (isTypeDisabled) status = "type_disabled";
      else if (!hasCategoryMapping || !hasVariants || !hasImages || !hasValidEbayPrices) status = "missing_config";
      else if (isEnded) {
        // Ended/deleted listings are re-pushable — treat as ready if they meet all requirements
        if (missingAspects.length > 0) status = "missing_specifics";
        else status = "ready"; // Can be re-listed
      }
      else if (isListed) status = "listed";
      else if (listingState.needsPublicationCheck) status = "publication_incomplete";
      else if (isError) status = "error";
      else if (missingAspects.length > 0) status = "missing_specifics";
      else status = "ready";

      const missingItems: string[] = [];
      if (!hasCategoryMapping) missingItems.push("eBay category");
      if (!hasVariants) missingItems.push("variants");
      if (!hasImages) missingItems.push("images");
      if (!hasValidEbayPrices) missingItems.push("valid eBay prices");

      feed.push({
        id: row.id,
        syncIncluded: selected.get(row.id)!.syncIncluded,
        name: row.name,
        sku: row.sku,
        productType: row.product_type,
        productTypeName: row.product_type_name,
        ebayBrowseCategoryId: effectiveCategoryId,
        ebayBrowseCategoryName: effectiveCategoryName,
        ebayBrowseCategoryOverrideId: row.product_ebay_browse_category_id || null,
        ebayBrowseCategoryOverrideName: row.product_ebay_browse_category_name || null,
        ebayStoreCategoryName: row.ebay_store_category_name,
        status,
        missingItems,
        missingPriceSkus,
        priceIssue,
        missingAspects,
        isListed,
        canSyncExistingListing,
        isExcluded,
        syncError: listingSyncError,
        inventoryIssue: inventory.issue,
        externalListingId: row.external_product_id_count === 1
          ? row.external_product_id
          : null,
        externalListingIdentityConflict: row.external_product_id_count > 1,
        variantCount: parseInt(row.variant_count) || 0,
        includedVariantCount,
        unlinkedVariants: includedVariants.filter((variant: { id: number }) => listingState.unlinkedVariantIds.includes(variant.id))
          .map((variant: { id: number; sku: string }) => ({ id: variant.id, sku: variant.sku })),
        imageCount: mediaReadiness.mediaPlan.group.selected.length,
        mediaReadiness,
        variants,
        fulfillmentPolicyOverride: row.product_fulfillment_override ?? null,
        returnPolicyOverride: row.product_return_override ?? null,
        paymentPolicyOverride: row.product_payment_override ?? null,
      });
    }


    return { feed, total: feed.length, syncIncludedCount: selection.filter(row => row.selection.syncIncluded).length };
  }
}
