import { ebayListingPushRequestSchema, ebayListingPushService } from "../../modules/channels/ebay-listing-push";
import { syncActiveListings } from "../../modules/channels/ebay-listing-sync";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { db, pool } from "../../db";
import { requireAuth, requireAuthOrInternalApiKey, requirePermission } from "../middleware";
import { getAuthService, getChannelConnection, EBAY_CHANNEL_ID, atpService } from "./ebay-utils";
import { resolveChannelPrice } from "../../modules/channels/infrastructure/ebay-listing-helpers";
import {
  isProductEffectivelyListed,
  isVariantEffectivelyListed,
} from "../../modules/channels/ebay-listing-eligibility";
import {
  EbayMarketplaceListingConnector,
} from "../../modules/channels/listing-connectors/ebay-listing.connector";
import { ebayListingSyncService } from '../../modules/channels/ebay-listing-sync';
import { EbayListingRecoveryService } from '../../modules/channels/ebay-listing-sync';
import { EbayPublicationRecoveryService, PostgresEbayPublicationRecoveryRepository } from '../../modules/inventory-planning/quantity-publication';
import { resolveEbayListingIssue } from '@shared/ebay-listing-issue';
import { listingFailure, listingFailureStatus } from './ebay-listing-errors';
import { registerEbayListingRecoveryRoutes } from './ebay-listing-recovery.routes';
import { readEbayPushRecoveryIdentity } from '../../modules/channels/ebay-listing-push';
import { ebayListingSyncJobSchema } from '@shared/types/ebay-listing-sync';
import { queueVariantAvailabilityRepair } from "../../modules/channels/variant-availability-sync.service";
import { selectEbayFeedListingState, type EbayFeedVariantListingState } from "../../modules/channels/ebay-listing-feed-status";
import {
  isValidEbayFixedPriceCents,
  normalizeCents,
} from "./ebay-listing-draft-builder";
import {
  createEbayRouteListingClient,
} from "./ebay-listing-connector-client";

export const router = express.Router();
const EBAY_LISTING_DEFAULT_MARKETPLACE_ID = "EBAY_US";
const ebayListingConnector = new EbayMarketplaceListingConnector();
const ebayListingRecovery = new EbayListingRecoveryService(ebayListingSyncService,
  new EbayPublicationRecoveryService(new PostgresEbayPublicationRecoveryRepository(pool), () => new Date()),
  (productId, actor, commandKey) => syncActiveListings({ productIds: [productId] }, actor, commandKey), readEbayPushRecoveryIdentity);

  // GET /api/ebay/listing-feed — Products with types for listing feed
  // -----------------------------------------------------------------------
  router.get("/api/ebay/listing-feed", requireAuth, async (req: Request, res: Response) => {
    try {
      const client = await pool.connect();
      try {
        // Get products that have a product_type assigned
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
            (SELECT COUNT(*) FROM product_assets pa WHERE pa.product_id = p.id) AS image_count,
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
          WHERE p.is_active = true AND p.product_type IS NOT NULL
          ORDER BY pt.sort_order ASC, p.name ASC
        `, [EBAY_CHANNEL_ID]);

        // Fetch variants for all products in the feed
        const productIds = result.rows.map((r: any) => r.id);
        let variantsByProduct: Map<number, any[]> = new Map();
        const listingStatesByProduct = new Map<number, EbayFeedVariantListingState[]>();
        if (productIds.length > 0) {
          const varResult = await client.query(`
            SELECT
              pv.id,
              pv.product_id,
              pv.sku,
              pv.name,
              pv.price_cents,
              pv.ebay_listing_excluded,
              cvo.is_listed AS variant_override_is_listed,
              pv.ebay_fulfillment_policy_override AS variant_fulfillment_override,
              pv.ebay_return_policy_override AS variant_return_override,
              pv.ebay_payment_policy_override AS variant_payment_override,
              cl.id AS listing_id, cl.sync_status AS listing_status, cl.sync_error AS listing_sync_error
            FROM product_variants pv
            LEFT JOIN channels.channel_variant_overrides cvo ON cvo.product_variant_id = pv.id AND cvo.channel_id = $2
            LEFT JOIN channels.channel_listings cl ON cl.product_variant_id = pv.id AND cl.channel_id = $2
            WHERE pv.product_id = ANY($1) AND pv.sku IS NOT NULL AND pv.is_active = true
              AND pv.sales_eligibility = 'sellable'
            ORDER BY pv.product_id, pv.position ASC, pv.id ASC
          `, [productIds, EBAY_CHANNEL_ID]);

          // Fetch fungible ATP for all products in the feed
          const atpByVariantId: Map<number, number> = new Map();
          const uniqueProductIds = [...new Set(varResult.rows.map((v: any) => v.product_id))];
          for (const pid of uniqueProductIds) {
            const variantAtps = await atpService.getAtpPerVariant(pid);
            for (const va of variantAtps) {
              atpByVariantId.set(va.productVariantId, va.atpUnits);
            }
          }

          for (const v of varResult.rows) {
            const pid = v.product_id;
            if (!listingStatesByProduct.has(pid)) listingStatesByProduct.set(pid, []);
            listingStatesByProduct.get(pid)!.push({ variantId: v.id, listingId: v.listing_id,
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
              inventoryQuantity: Math.max(0, atpByVariantId.get(v.id) ?? 0),
              fulfillmentPolicyOverride: v.variant_fulfillment_override || null,
              returnPolicyOverride: v.variant_return_override || null,
              paymentPolicyOverride: v.variant_payment_override || null,
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
          const hasImages = (row.image_count || 0) > 0;

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

          const variants = (variantsByProduct.get(row.id) || []).map((v: any) => {
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
          const includedVariants = variants.filter((v: any) => v.effectivelyListed);
          const listingState = selectEbayFeedListingState(listingStatesByProduct.get(row.id) ?? [], includedVariants.map((variant: { id: number }) => variant.id));
          const isListed = listingState?.syncStatus === "synced";
          const isEnded = listingState?.syncStatus === "ended" || listingState?.syncStatus === "deleted";
          const isError = listingState?.syncStatus === "error";
          const listingSyncError = listingState?.syncError || null;
          const includedVariantCount = includedVariants.length;
          const missingPriceSkus: string[] = [];
          for (const variant of includedVariants) {
            const basePriceCents = normalizeCents(variant.priceCents);
            const effectivePriceCents = await resolveChannelPrice(
              db,
              EBAY_CHANNEL_ID,
              row.id,
              variant.id,
              basePriceCents ?? 0,
            );
            if (!isValidEbayFixedPriceCents(effectivePriceCents)) {
              missingPriceSkus.push(variant.sku);
            }
          }
          const hasValidEbayPrices = includedVariantCount > 0 && missingPriceSkus.length === 0;

          // Check for missing required aspects
          const missingAspects: string[] = [];
          if (effectiveCategoryId) {
            const requiredAspects = requiredAspectsByCategory.get(effectiveCategoryId) || [];
            const filledTypeDefaults = typeDefaultsBySlug.get(row.product_type) || new Set();
            const filledOverrides = overridesByProduct.get(row.id) || new Set();
            // Auto-mapped: Brand (if product has brand)
            const autoMapped = new Set<string>();
            // We can't check product.brand here efficiently, but Brand is usually
            // set as a type default. We'll just check type + product overrides.
            for (const reqAspect of requiredAspects) {
              if (!filledTypeDefaults.has(reqAspect) && !filledOverrides.has(reqAspect) && !autoMapped.has(reqAspect)) {
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
            missingAspects,
            isListed,
            isExcluded,
            syncError: listingSyncError,
            externalListingId: row.external_product_id_count === 1
              ? row.external_product_id
              : null,
            externalListingIdentityConflict: row.external_product_id_count > 1,
            variantCount: parseInt(row.variant_count) || 0,
            includedVariantCount,
            imageCount: parseInt(row.image_count) || 0,
            variants,
            fulfillmentPolicyOverride: row.product_fulfillment_override || null,
            returnPolicyOverride: row.product_return_override || null,
            paymentPolicyOverride: row.product_payment_override || null,
          });
        }

        res.json({ feed, total: feed.length });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Listing Feed] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------

  //   All eBay API calls use ebayApiRequest (https module).
  // -----------------------------------------------------------------------
  router.post("/api/ebay/listings/push", requireAuth, requirePermission("channels", "edit"), async (req: Request, res: Response) => {
    const parsed = ebayListingPushRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid eBay listing request", details: parsed.error.flatten() });
      return;
    }
    try { res.json(await ebayListingPushService.push(parsed.data)); }
    catch (error) { res.status(listingFailureStatus(error)).json(listingFailure(error)); }
  });

  router.get("/api/ebay/listings/push-stream", requireAuth, requirePermission("channels", "edit"), async (req: Request, res: Response) => {
    const value = req.query.productIds;
    const productIds = typeof value === "string" && /^(?:[1-9]\d*)(?:,[1-9]\d*)*$/.test(value)
      ? value.split(",").map(Number) : [];
    const parsed = ebayListingPushRequestSchema.safeParse({ productIds });
    if (!parsed.success) {
      res.status(400).json({ error: "Choose between 1 and 500 distinct product IDs.", details: parsed.error.flatten() });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    let cancelled = false;
    res.on("close", () => { cancelled = true; });
    const send = (event: unknown) => { if (!cancelled) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    try {
      const result = await ebayListingPushService.push(parsed.data, {
        cancelled: () => cancelled,
        onRateLimit: seconds => send({ type: "rate_limited", waitSeconds: seconds }),
        onProduct: (product, current, total) => send({ ...product, type: "progress", product: product.productName,
          current, total, variantsListed: product.variantCount }),
      });
      send({ type: "complete", summary: result.summary, cancelled: result.cancelled });
    } catch (error) { send({ type: "error", ...listingFailure(error) }); }
    res.end();
  });

  // -----------------------------------------------------------------------
  // POST /api/ebay/listings/sync-all — Sync all active eBay listings

  // -----------------------------------------------------------------------
  router.post("/api/ebay/listings/sync-all", requireAuth, requirePermission("channels","edit"), async (req: Request, res: Response) => {
    try {
      const result = await syncActiveListings(null,String(req.session.user!.id));
      res.json(result);
    } catch (err: any) {
      res.status(listingFailureStatus(err)).json(listingFailure(err));
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/ebay/listings/sync-product/:productId — Sync a single product

  // -----------------------------------------------------------------------
  router.post("/api/ebay/listings/sync-product/:productId", requireAuth, requirePermission("channels","edit"), async (req: Request, res: Response) => {
    try {
      const productId = Number(req.params.productId);
      const command=z.object({commandKey:z.string().uuid().optional()}).strict().safeParse(req.body??{});
      if (!Number.isSafeInteger(productId) || productId<=0 || productId>2147483647 || !command.success) {
        res.status(400).json({ error: "Invalid product ID" });
        return;
      }
      const result = await syncActiveListings({ productIds: [productId] },String(req.session.user!.id),command.data.commandKey);
      res.json(result);
    } catch (err: any) {
      res.status(listingFailureStatus(err)).json(listingFailure(err, Number(req.params.productId)));
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/ebay/listings/sync-stream — SSE sync with real-time progress

  // -----------------------------------------------------------------------
  router.get('/api/ebay/listings/sync-stream',requireAuth,requirePermission('channels','edit'),async(req:Request,res:Response)=> {
    const parsed=z.object({productIds:z.string().regex(/^[1-9][0-9]*(,[1-9][0-9]*)*$/).optional()}).safeParse(req.query);
    if(!parsed.success) {res.status(400).json({error:'Invalid product selection.'});return;}
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive','X-Accel-Buffering':'no'});
    let disconnected=false;res.on('close',()=>{disconnected=true;});
    const send=(value:unknown)=>{if(!disconnected) res.write(`data: ${JSON.stringify(value)}\n\n`);};
    try {
      // The canonical sync owner persists all work before provider I/O. Closing
      // this observer never cancels already accepted product updates.
      const result=await syncActiveListings(parsed.data.productIds?{productIds:parsed.data.productIds.split(',').map(Number)}:null,String(req.session.user!.id));
      result.jobs.forEach((job,index)=>send({type:'progress',product:result.details.find(row=>row.productId===job.productId)?.productName??`Product ${job.productId}`,productId:job.productId,
        status:job.state==='completed'?'success':(job.state==='needs_attention'||job.state==='awaiting_evidence')?'error':'pending',error:job.message,code:job.code,jobId:job.id,
        issue:job.code?resolveEbayListingIssue({code:job.code,message:job.message,productId:job.productId,jobId:job.id,state:job.state}):undefined,current:index+1,total:result.jobs.length}));
      send({type:'complete',summary:{...result,total:result.jobs.length},cancelled:false});
    } catch(error) {send({type:'error',...listingFailure(error)});}
    res.end();
  });
  router.get('/api/ebay/listings/sync-jobs',requireAuth,requirePermission('channels','view'),async(_req:Request,res:Response)=> {
    try {res.json((await ebayListingSyncService.list(EBAY_CHANNEL_ID)).map(job=>ebayListingSyncJobSchema.parse(job)));}
    catch {res.status(500).json({error:'Listing sync history could not be loaded.'});}
  });
  registerEbayListingRecoveryRoutes(router, ebayListingRecovery, EBAY_CHANNEL_ID);

  // -----------------------------------------------------------------------
  // Channel Pricing Rules endpoints
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  router.post("/api/ebay/listings/reconcile", requireAuthOrInternalApiKey,
    (req: Request, res: Response, next: NextFunction) => {
      // Scheduled internal callers already passed the key check. Interactive
      // reconciliation changes listing state and requires the editor grant.
      if (req.session.user) return requirePermission("channels", "edit")(req, res, next);
      next();
    }, async (_req: Request, res: Response) => {
    try {
      const authService = getAuthService();
      if (!authService) {
        res.status(500).json({ error: "eBay auth not configured" });
        return;
      }

      const accessToken = await authService.getAccessToken(EBAY_CHANNEL_ID);
      const conn = await getChannelConnection();
      const metadata = (conn?.metadata as Record<string, any>) || {};
      const marketplaceId = typeof metadata.marketplaceId === "string" && metadata.marketplaceId.trim()
        ? metadata.marketplaceId.trim()
        : EBAY_LISTING_DEFAULT_MARKETPLACE_ID;
      const ebayClient = createEbayRouteListingClient({ accessToken });

      const client = await pool.connect();
      try {
        // Get all synced listings for eBay channel
        const listingsResult = await client.query(`
          SELECT cl.id, cl.product_variant_id, cl.external_product_id, cl.external_variant_id,
                 cl.external_sku, cl.sync_status,
                 pv.sku AS variant_sku, pv.is_active AS variant_is_active,
                 pv.sales_eligibility AS variant_sales_eligibility,
                 p.name AS product_name
          FROM channels.channel_listings cl
          LEFT JOIN catalog.product_variants pv ON pv.id = cl.product_variant_id
          LEFT JOIN catalog.products p ON p.id = pv.product_id
          WHERE cl.channel_id = $1 AND cl.sync_status = 'synced'
        `, [EBAY_CHANNEL_ID]);

        const listings = listingsResult.rows;
        if (listings.length === 0) {
          res.json({ checked: 0, active: 0, ended: 0, deleted: 0, quantityDrift: 0, errors: 0 });
          return;
        }

        let active = 0;
        let ended = 0;
        let deleted = 0;
        let quantityDrift = 0;
        let errors = 0;
        const changes: Array<{ id: number; sku: string; product: string; oldStatus: string; newStatus: string }> = [];

        // Check each listing against eBay
        for (const listing of listings) {
          const sku = listing.external_sku || listing.variant_sku;
          if (!sku) {
            errors++;
            continue;
          }

          try {
            const inspection = await ebayListingConnector.inspectListingStatus({
              client: ebayClient,
              sku,
              marketplaceId,
            });

            if (!inspection.inventoryItemExists) {
              // Inventory item gone — mark as deleted
              await client.query(
                `UPDATE channel_listings SET sync_status = 'deleted', sync_error = 'Inventory item not found on eBay', updated_at = NOW()
                 WHERE id = $1`,
                [listing.id],
              );
              deleted++;
              changes.push({ id: listing.id, sku, product: listing.product_name || "Unknown", oldStatus: "synced", newStatus: "deleted" });
              continue;
            }

            if (inspection.hasActiveOffer) {
              if (
                (listing.variant_is_active === false || listing.variant_sales_eligibility === "internal_only")
                && (inspection.availableQuantity ?? 0) > 0
              ) {
                await queueVariantAvailabilityRepair({
                  channelId: EBAY_CHANNEL_ID,
                  productVariantId: listing.product_variant_id,
                });
                quantityDrift++;
                changes.push({
                  id: listing.id,
                  sku,
                  product: listing.product_name || "Unknown",
                  oldStatus: `inactive with eBay quantity ${inspection.availableQuantity}`,
                  newStatus: "availability repair queued",
                });
              }
              active++;
            } else {
              // Offer ended/withdrawn
              await client.query(
                `UPDATE channel_listings SET sync_status = 'ended', sync_error = 'Offer no longer active on eBay', updated_at = NOW()
                 WHERE id = $1`,
                [listing.id],
              );
              ended++;
              changes.push({ id: listing.id, sku, product: listing.product_name || "Unknown", oldStatus: "synced", newStatus: "ended" });
            }
          } catch (err: any) {
            console.error(`[eBay Reconcile] Error checking SKU ${sku}:`, err.message);
            errors++;
          }

          // Small delay between API calls to respect rate limits
          await new Promise((resolve) => setTimeout(resolve, 200));
        }

        if (changes.length > 0) {
          console.log(`[eBay Reconcile] Status changes:`, changes.map((c) => `${c.sku}: ${c.oldStatus} → ${c.newStatus}`).join(", "));
        }
        console.log(`[eBay Reconcile] Complete: checked=${listings.length} active=${active} ended=${ended} deleted=${deleted} quantityDrift=${quantityDrift} errors=${errors}`);

        res.json({ checked: listings.length, active, ended, deleted, quantityDrift, errors, changes });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Reconcile] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // PUT /api/ebay/product-exclusion/:productId — Toggle individual product exclusion
