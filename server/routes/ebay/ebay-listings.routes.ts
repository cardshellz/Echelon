import { ChannelReadCoordinator } from "../../modules/marketplace-listings/application/channel-read-coordinator";
import { channelListingInventorySchema } from "@shared/types/channel-listing-inventory";
import { EbayListingFeedReader } from "../../modules/channels/infrastructure/ebay-listing-feed.reader";
import { ebayListingPushRequestSchema, ebayListingPushService } from "../../modules/channels/ebay-listing-push";
import { PostgresEbayListingRecoveryContinuation } from "../../modules/channels/infrastructure/ebay-listing-recovery-continuation";
import { ebayListingSyncRepository, syncActiveListings } from "../../modules/channels/ebay-listing-sync";
import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, pool } from "../../db";
import { requireAuth, requireAuthOrInternalApiKey, requirePermission } from "../middleware";
import { getAuthService, getChannelConnection, EBAY_CHANNEL_ID, atpService } from "./ebay-utils";
import { resolveChannelPrice } from "../../modules/channels/infrastructure/ebay-listing-helpers";
import { createCatalogPublicImageUrl } from "../../modules/catalog/catalog-public-image";
import { readEbayListingPhotoReadiness } from "../../modules/channels/ebay-listing-photo-readiness";
import {
  EbayMarketplaceListingConnector,
} from "../../modules/channels/listing-connectors/ebay-listing.connector";
import { ebayListingSyncService } from '../../modules/channels/ebay-listing-sync';
import { EbayListingRecoveryService } from '../../modules/channels/ebay-listing-sync';
import { EbayPublicationRecoveryService, PostgresEbayPublicationRecoveryRepository } from '../../modules/inventory-planning/quantity-publication';
import { resolveEbayListingIssue, safeListingDiagnostic } from '@shared/ebay-listing-issue';
import { EbayListingFeedInventoryService } from '../../modules/channels/ebay-listing-feed-inventory';
import { listingFailure, listingFailureStatus } from './ebay-listing-errors';
import { registerEbayListingRecoveryRoutes } from './ebay-listing-recovery.routes';
import { registerEbayListingMappingRoutes } from './ebay-listing-mapping.routes';
import { ebayListingMappingService } from '../../modules/channels/ebay-listing-mapping';
import { registerEbayPublicationStockRoutes } from './ebay-publication-stock.routes';
import { ebayPublicationStockService } from '../../modules/channels/ebay-publication-stock';
import { readEbayPushRecoveryIdentity } from '../../modules/channels/ebay-listing-push';
import { ebayListingSyncJobSchema } from '@shared/types/ebay-listing-sync';
import { queueVariantAvailabilityRepair } from "../../modules/channels/variant-availability-sync.service";
import {
  createEbayRouteListingClient,
} from "./ebay-listing-connector-client";

export const router = express.Router();
const EBAY_LISTING_DEFAULT_MARKETPLACE_ID = "EBAY_US";
const publicationImageUrl = createCatalogPublicImageUrl(process.env);
const ebayListingConnector = new EbayMarketplaceListingConnector();
const feedInventory = new EbayListingFeedInventoryService(atpService, {
  createReference: randomUUID,
  reportFailure: ({ error, ...context }) => console.error({ event: "ebay_listing_feed_inventory_failed", ...context,
    error: error instanceof Error ? safeListingDiagnostic(error.message) : "Unknown inventory read failure" }),
});
const feedReader = new EbayListingFeedReader(pool, EBAY_CHANNEL_ID, {
  inventory: feedInventory,
  readPhotos: input => readEbayListingPhotoReadiness(pool, input, publicationImageUrl),
  resolvePrice: (productId, variantId, basePriceCents) => resolveChannelPrice(db, EBAY_CHANNEL_ID, productId, variantId, basePriceCents),
});
const feedReads = new ChannelReadCoordinator<Awaited<ReturnType<EbayListingFeedReader["read"]>>>();
const inventoryReads = new ChannelReadCoordinator<Awaited<ReturnType<EbayListingFeedReader["readInventory"]>>>();
const ebayListingRecovery = new EbayListingRecoveryService(ebayListingSyncService,
  new EbayPublicationRecoveryService(new PostgresEbayPublicationRecoveryRepository(pool), () => new Date()),
  new PostgresEbayListingRecoveryContinuation(pool, ebayListingSyncRepository), readEbayPushRecoveryIdentity);

  // GET /api/ebay/listing-feed — Canonical channel selection and read projection
  // -----------------------------------------------------------------------
  router.get("/api/ebay/listing-feed", requireAuth, async (req: Request, res: Response) => {
    try {
      res.json(await feedReads.read(EBAY_CHANNEL_ID, async () => {
        const startedAt = performance.now();
        const poolAtStart = { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
        let productCount: number | null = null;
        try {
          const result = await feedReader.read();
          productCount = result.total;
          return result;
        } finally {
          // One measurement per coalesced load, including failed loads. This
          // distinguishes slow projection work from connection acquisition.
          console.info({ event: "channel_listing_feed_read", channelId: EBAY_CHANNEL_ID,
            elapsedMs: Math.round(performance.now() - startedAt), productCount, poolAtStart,
            poolAtFinish: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } });
        }
      }));
    } catch (error) {
      const reference = randomUUID();
      const issue = resolveEbayListingIssue({ code: "EBAY_LISTING_FEED_UNAVAILABLE", jobId: reference });
      console.error({ event: "ebay_listing_feed_failed", reference,
        error: error instanceof Error ? safeListingDiagnostic(error.message) : "Unknown listing feed read failure" });
      res.status(500).json({ code: issue.code, error: issue.message, issue });
    }
  });

  router.get("/api/ebay/listing-feed/:productId/inventory", requireAuth, requirePermission("channels", "view"), async (req: Request, res: Response) => {
    const productId = z.coerce.number().int().positive().max(2_147_483_647).safeParse(req.params.productId);
    if (!productId.success) { res.status(400).json({ error: "Choose a valid product." }); return; }
    try {
      res.json(channelListingInventorySchema.parse(
        await inventoryReads.read(productId.data, () => feedReader.readInventory(productId.data))));
    } catch (error) {
      const reference = randomUUID();
      const issue = resolveEbayListingIssue({ code: "EBAY_FEED_QUANTITY_UNAVAILABLE", productId: productId.data, jobId: reference });
      console.error({ event: "ebay_listing_inventory_failed", reference, productId: productId.data,
        error: error instanceof Error ? safeListingDiagnostic(error.message) : "Unknown inventory read failure" });
      res.status(503).json({ code: issue.code, error: issue.message, issue });
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
    try { res.json(await ebayListingPushService.push(parsed.data, { actor: String(req.session.user!.id) })); }
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
        actor: String(req.session.user!.id),
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
  registerEbayListingMappingRoutes(router, ebayListingMappingService, EBAY_CHANNEL_ID);
  registerEbayPublicationStockRoutes(router, ebayPublicationStockService);

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
