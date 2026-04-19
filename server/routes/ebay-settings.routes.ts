import { requireAuth } from "./middleware";
/**
 * eBay Settings Routes
 *
 * Manages eBay channel configuration: connection status, merchant location,
 * business policies, listing previews, and test listings.
 *
 * GET  /api/ebay/settings          — Current eBay config & connection status
 * GET  /api/ebay/policies          — Fetch business policies from eBay API
 * POST /api/ebay/location          — Create merchant location on eBay
 * PUT  /api/ebay/settings          — Save policy selections & config
 * GET  /api/ebay/listings/preview  — Preview how products would look on eBay
 * POST /api/ebay/listings/test     — Create a single test listing on eBay
 */

import type { Express, Request, Response } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import {
  channels,
  channelConnections,
  ebayOauthTokens,
  products,
  productVariants,
  productAssets,
  channelListings,
} from "@shared/schema";
import {
  EbayAuthService,
  createEbayAuthConfig,
} from "../modules/channels/adapters/ebay/ebay-auth.service";
import {
  EbayApiClient,
  createEbayApiClient,
} from "../modules/channels/adapters/ebay/ebay-api.client";
import {
  EbayListingBuilder,
  createEbayListingBuilder,
} from "../modules/channels/adapters/ebay/ebay-listing-builder";
import { resolveEbayCategoryMapping } from "../modules/channels/adapters/ebay/ebay-category-map";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EBAY_CHANNEL_ID = 67;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAuthService(): EbayAuthService | null {
  try {
    const config = createEbayAuthConfig();
    return new EbayAuthService(db as any, config);
  } catch {
    return null;
  }
}

function getApiClient(authService: EbayAuthService): EbayApiClient {
  return createEbayApiClient(authService, EBAY_CHANNEL_ID);
}

async function getChannelConnection() {
  const [conn] = await (db as any)
    .select()
    .from(channelConnections)
    .where(eq(channelConnections.channelId, EBAY_CHANNEL_ID))
    .limit(1);
  return conn || null;
}

async function getOrCreateChannelConnection() {
  let conn = await getChannelConnection();
  if (!conn) {
    const [newConn] = await (db as any)
      .insert(channelConnections)
      .values({
        channelId: EBAY_CHANNEL_ID,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    conn = newConn;
  }
  return conn;
}

// ---------------------------------------------------------------------------
// Route Registration
// ---------------------------------------------------------------------------

export function registerEbaySettingsRoutes(app: Express): void {
  // -----------------------------------------------------------------------
  // GET /api/ebay/settings — Current eBay config & connection status
  // -----------------------------------------------------------------------
  app.get("/api/ebay/settings", requireAuth, async (_req: Request, res: Response) => {
    try {
      const authService = getAuthService();
      if (!authService) {
        res.json({
          connected: false,
          configured: false,
          error: "eBay OAuth not configured. Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_RUNAME.",
        });
        return;
      }

      // Get token info
      const [tokenRow] = await (db as any)
        .select()
        .from(ebayOauthTokens)
        .where(eq(ebayOauthTokens.channelId, EBAY_CHANNEL_ID))
        .limit(1);

      // Get channel info
      const [channel] = await (db as any)
        .select()
        .from(channels)
        .where(eq(channels.id, EBAY_CHANNEL_ID))
        .limit(1);

      // Get connection/config
      const conn = await getChannelConnection();
      const metadata = (conn?.metadata as Record<string, any>) || {};

      // Try to get eBay user info if connected
      let ebayUsername: string | null = null;
      if (tokenRow?.accessToken) {
        try {
          const apiClient = getApiClient(authService);
          const accessToken = await authService.getAccessToken(EBAY_CHANNEL_ID);
          const environment = process.env.EBAY_ENVIRONMENT || "production";
          const baseUrl = environment === "sandbox"
            ? "https://api.sandbox.ebay.com"
            : "https://api.ebay.com";

          const userResp = await fetch(`${baseUrl}/commerce/identity/v1/user/`, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/json",
            },
          });
          if (userResp.ok) {
            const userData = await userResp.json();
            ebayUsername = userData.username || null;
          }
        } catch (err: any) {
          console.warn("[eBay Settings] Failed to fetch user identity:", err.message);
        }
      }

      res.json({
        connected: !!tokenRow?.accessToken,
        configured: true,
        channel: channel || null,
        ebayUsername,
        tokenInfo: tokenRow
          ? {
              accessTokenExpiresAt: tokenRow.accessTokenExpiresAt,
              refreshTokenExpiresAt: tokenRow.refreshTokenExpiresAt,
              lastRefreshedAt: tokenRow.lastRefreshedAt,
              environment: tokenRow.environment,
            }
          : null,
        config: {
          merchantLocationKey: metadata.merchantLocationKey || null,
          fulfillmentPolicyId: metadata.fulfillmentPolicyId || null,
          returnPolicyId: metadata.returnPolicyId || null,
          paymentPolicyId: metadata.paymentPolicyId || null,
          merchantLocation: metadata.merchantLocation || null,
        },
        lastSyncAt: conn?.lastSyncAt || null,
        syncStatus: conn?.syncStatus || "never",
      });
    } catch (err: any) {
      console.error("[eBay Settings] Error fetching settings:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/ebay/policies — Fetch business policies from eBay API
  // -----------------------------------------------------------------------
  app.get("/api/ebay/policies", requireAuth, async (_req: Request, res: Response) => {
    try {
      const authService = getAuthService();
      if (!authService) {
        res.status(500).json({ error: "eBay OAuth not configured" });
        return;
      }

      const accessToken = await authService.getAccessToken(EBAY_CHANNEL_ID);
      const environment = process.env.EBAY_ENVIRONMENT || "production";
      const baseUrl = environment === "sandbox"
        ? "https://api.sandbox.ebay.com"
        : "https://api.ebay.com";

      // Fetch all three policy types in parallel
      const [fulfillmentResp, returnResp, paymentResp] = await Promise.all([
        fetch(`${baseUrl}/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US`, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        }),
        fetch(`${baseUrl}/sell/account/v1/return_policy?marketplace_id=EBAY_US`, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        }),
        fetch(`${baseUrl}/sell/account/v1/payment_policy?marketplace_id=EBAY_US`, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        }),
      ]);

      const [fulfillmentData, returnData, paymentData] = await Promise.all([
        fulfillmentResp.ok ? fulfillmentResp.json() : { fulfillmentPolicies: [] },
        returnResp.ok ? returnResp.json() : { returnPolicies: [] },
        paymentResp.ok ? paymentResp.json() : { paymentPolicies: [] },
      ]);

      res.json({
        fulfillmentPolicies: (fulfillmentData.fulfillmentPolicies || []).map((p: any) => ({
          id: p.fulfillmentPolicyId,
          name: p.name,
          description: p.description,
          marketplaceId: p.marketplaceId,
        })),
        returnPolicies: (returnData.returnPolicies || []).map((p: any) => ({
          id: p.returnPolicyId,
          name: p.name,
          description: p.description,
          marketplaceId: p.marketplaceId,
        })),
        paymentPolicies: (paymentData.paymentPolicies || []).map((p: any) => ({
          id: p.paymentPolicyId,
          name: p.name,
          description: p.description,
          marketplaceId: p.marketplaceId,
        })),
      });
    } catch (err: any) {
      console.error("[eBay Settings] Error fetching policies:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/ebay/location — Create merchant location on eBay
  // -----------------------------------------------------------------------
  app.post("/api/ebay/location", requireAuth, async (req: Request, res: Response) => {
    try {
      const authService = getAuthService();
      if (!authService) {
        res.status(500).json({ error: "eBay OAuth not configured" });
        return;
      }

      const {
        name,
        addressLine1,
        addressLine2,
        city,
        stateOrProvince,
        postalCode,
        country,
        merchantLocationKey,
      } = req.body;

      if (!name || !addressLine1 || !city || !stateOrProvince || !postalCode) {
        res.status(400).json({ error: "Missing required address fields" });
        return;
      }

      const locationKey = merchantLocationKey || "CARDSHELLZ_HQ";
      const accessToken = await authService.getAccessToken(EBAY_CHANNEL_ID);
      const environment = process.env.EBAY_ENVIRONMENT || "production";
      const baseUrl = environment === "sandbox"
        ? "https://api.sandbox.ebay.com"
        : "https://api.ebay.com";

      const locationPayload = {
        location: {
          address: {
            addressLine1,
            addressLine2: addressLine2 || undefined,
            city,
            stateOrProvince,
            postalCode,
            country: country || "US",
          },
        },
        locationTypes: ["WAREHOUSE"],
        name,
        merchantLocationStatus: "ENABLED",
      };

      const resp = await fetch(
        `${baseUrl}/sell/inventory/v1/location/${encodeURIComponent(locationKey)}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(locationPayload),
        },
      );

      if (!resp.ok && resp.status !== 204) {
        const errorBody = await resp.text();
        res.status(resp.status).json({ error: `eBay API error: ${errorBody}` });
        return;
      }

      // Save location key to channel connection metadata
      const conn = await getOrCreateChannelConnection();
      const existingMetadata = (conn.metadata as Record<string, any>) || {};
      await (db as any)
        .update(channelConnections)
        .set({
          metadata: {
            ...existingMetadata,
            merchantLocationKey: locationKey,
            merchantLocation: {
              name,
              addressLine1,
              addressLine2,
              city,
              stateOrProvince,
              postalCode,
              country: country || "US",
            },
          },
          updatedAt: new Date(),
        })
        .where(eq(channelConnections.id, conn.id));

      res.json({
        success: true,
        merchantLocationKey: locationKey,
        message: `Merchant location "${name}" created on eBay`,
      });
    } catch (err: any) {
      console.error("[eBay Settings] Error creating location:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // PUT /api/ebay/settings — Save policy selections & config
  // -----------------------------------------------------------------------
  app.put("/api/ebay/settings", requireAuth, async (req: Request, res: Response) => {
    try {
      const { fulfillmentPolicyId, returnPolicyId, paymentPolicyId } = req.body;

      const conn = await getOrCreateChannelConnection();
      const existingMetadata = (conn.metadata as Record<string, any>) || {};

      await (db as any)
        .update(channelConnections)
        .set({
          metadata: {
            ...existingMetadata,
            fulfillmentPolicyId: fulfillmentPolicyId || existingMetadata.fulfillmentPolicyId,
            returnPolicyId: returnPolicyId || existingMetadata.returnPolicyId,
            paymentPolicyId: paymentPolicyId || existingMetadata.paymentPolicyId,
          },
          updatedAt: new Date(),
        })
        .where(eq(channelConnections.id, conn.id));

      res.json({ success: true, message: "eBay settings saved" });
    } catch (err: any) {
      console.error("[eBay Settings] Error saving settings:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/ebay/listings/preview — Preview how products would look on eBay
  // -----------------------------------------------------------------------
  app.get("/api/ebay/listings/preview", requireAuth, async (_req: Request, res: Response) => {
    try {
      // Fetch 3 active products with variants and images
      const sampleProducts = await (db as any)
        .select()
        .from(products)
        .where(eq(products.isActive, true))
        .limit(3);

      if (sampleProducts.length === 0) {
        res.json({ previews: [], message: "No active products found" });
        return;
      }

      const previews = [];
      const builder = createEbayListingBuilder();

      for (const product of sampleProducts) {
        // Get variants
        const variants = await (db as any)
          .select()
          .from(productVariants)
          .where(eq(productVariants.productId, product.id));

        // Get images
        const assets = await (db as any)
          .select()
          .from(productAssets)
          .where(eq(productAssets.productId, product.id));

        // Resolve category
        const categoryMapping = resolveEbayCategoryMapping({
          category: product.category,
          subcategory: product.subcategory,
          name: product.name,
        });

        // Build preview
        const imageUrls = assets
          .sort((a: any, b: any) => (a.position || 0) - (b.position || 0))
          .map((a: any) => a.url)
          .filter(Boolean)
          .slice(0, 12);

        const variantPreviews = variants
          .filter((v: any) => v.sku)
          .slice(0, 3)
          .map((v: any) => ({
            sku: v.sku,
            name: v.name,
            priceCents: v.priceCents || 0,
            price: ((v.priceCents || 0) / 100).toFixed(2),
          }));

        previews.push({
          productId: product.id,
          title: product.title || product.name,
          description: product.description
            ? product.description.substring(0, 300) + (product.description.length > 300 ? "..." : "")
            : null,
          category: categoryMapping.categoryName,
          categoryId: categoryMapping.categoryId,
          images: imageUrls,
          variants: variantPreviews,
          bulletPoints: product.bulletPoints || [],
          brand: product.brand || "Card Shellz",
        });
      }

      res.json({ previews });
    } catch (err: any) {
      console.error("[eBay Settings] Error generating preview:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/ebay/listings/test — Create a single test listing on eBay
  // -----------------------------------------------------------------------
  app.post("/api/ebay/listings/test", requireAuth, async (req: Request, res: Response) => {
    try {
      const authService = getAuthService();
      if (!authService) {
        res.status(500).json({ error: "eBay OAuth not configured" });
        return;
      }

      const { productId } = req.body;
      if (!productId) {
        res.status(400).json({ error: "productId is required" });
        return;
      }

      // Get config
      const conn = await getChannelConnection();
      const metadata = (conn?.metadata as Record<string, any>) || {};

      if (!metadata.merchantLocationKey) {
        res.status(400).json({ error: "Merchant location not configured. Create a location first." });
        return;
      }
      if (!metadata.fulfillmentPolicyId || !metadata.returnPolicyId || !metadata.paymentPolicyId) {
        res.status(400).json({ error: "Business policies not configured. Select policies first." });
        return;
      }

      // Get product, variants, images
      const [product] = await (db as any)
        .select()
        .from(products)
        .where(eq(products.id, productId))
        .limit(1);

      if (!product) {
        res.status(404).json({ error: "Product not found" });
        return;
      }

      const variants = await (db as any)
        .select()
        .from(productVariants)
        .where(eq(productVariants.productId, productId));

      const assets = await (db as any)
        .select()
        .from(productAssets)
        .where(eq(productAssets.productId, productId));

      if (variants.length === 0) {
        res.status(400).json({ error: "Product has no variants" });
        return;
      }

      // Use just the first variant for a test listing
      const testVariant = variants[0];
      const imageUrls = assets
        .sort((a: any, b: any) => (a.position || 0) - (b.position || 0))
        .map((a: any) => a.url)
        .filter(Boolean)
        .slice(0, 12);

      const builder = createEbayListingBuilder();
      const apiClient = getApiClient(authService);

      const listingConfig = {
        merchantLocationKey: metadata.merchantLocationKey,
        listingPolicies: {
          fulfillmentPolicyId: metadata.fulfillmentPolicyId,
          returnPolicyId: metadata.returnPolicyId,
          paymentPolicyId: metadata.paymentPolicyId,
        },
        marketplaceId: "EBAY_US",
      };

      // Build channel listing payload
      const channelPayload: import("../modules/channels/channel-adapter.interface").ChannelListingPayload = {
        productId: product.id,
        title: product.title || product.name,
        description: product.description || "",
        category: product.category || "",
        tags: (product.tags as string[]) || [],
        status: "active",
        images: imageUrls.map((url: string, i: number) => ({
          url,
          position: i,
          altText: product.name,
          variantSku: null,
        })),
        metadata: {
          bulletPoints: product.bulletPoints || [],
          itemSpecifics: product.itemSpecifics || {},
        },
        variants: [
          {
            variantId: testVariant.id,
            sku: testVariant.sku,
            name: testVariant.name,
            barcode: testVariant.barcode || null,
            priceCents: testVariant.priceCents || 999,
            compareAtPriceCents: testVariant.compareAtPriceCents || null,
            weightGrams: testVariant.weightGrams || null,
            gtin: testVariant.barcode || null,
            mpn: null,
            isListed: true,
            externalVariantId: null,
            externalInventoryItemId: null,
          },
        ],
      };

      // Build and create inventory item
      const inventoryItems = builder.buildInventoryItems(channelPayload, listingConfig);
      if (inventoryItems.length === 0) {
        res.status(400).json({ error: "No inventory items could be built from this product" });
        return;
      }

      const item = inventoryItems[0];
      await apiClient.createOrReplaceInventoryItem(item.sku, item.payload);

      // Build and create offer
      const offers = builder.buildOffers(channelPayload, listingConfig);
      if (offers.length === 0) {
        res.status(400).json({ error: "No offers could be built from this product" });
        return;
      }

      const offer = offers[0];
      // Set a test quantity
      offer.payload.availableQuantity = 1;
      const offerId = await apiClient.createOffer(offer.payload);

      // Publish the offer
      let listingId: string | null = null;
      if (offerId) {
        try {
          const publishResult = await apiClient.publishOffer(offerId);
          listingId = publishResult?.listingId || null;
        } catch (pubErr: any) {
          console.warn("[eBay Settings] Offer created but publish failed:", pubErr.message);
          res.json({
            success: true,
            warning: `Offer created (${offerId}) but publish failed: ${pubErr.message}`,
            offerId,
            sku: item.sku,
          });
          return;
        }
      }

      res.json({
        success: true,
        message: `Test listing created on eBay!`,
        sku: item.sku,
        offerId,
        listingId,
        listingUrl: listingId
          ? `https://www.ebay.com/itm/${listingId}`
          : null,
      });
    } catch (err: any) {
      console.error("[eBay Settings] Error creating test listing:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/ebay/stats — Channel stats (orders, listings, last sync)
  // -----------------------------------------------------------------------
  app.get("/api/ebay/stats", requireAuth, async (_req: Request, res: Response) => {
    try {
      const authService = getAuthService();
      let orderCount = 0;
      let activeListingsCount = 0;

      // Get active listings count from DB
      const listings = await (db as any)
        .select()
        .from(channelListings)
        .where(
          and(
            eq(channelListings.channelId, EBAY_CHANNEL_ID),
            eq(channelListings.syncStatus, "synced"),
          ),
        );
      activeListingsCount = listings.length;

      // Try to get order count from eBay API
      if (authService) {
        try {
          const apiClient = getApiClient(authService);
          const ordersResp = await apiClient.getOrders({ limit: 1 });
          orderCount = ordersResp.total || 0;
        } catch (err: any) {
          console.warn("[eBay Settings] Could not fetch order count:", err.message);
        }
      }

      // Get last sync time
      const conn = await getChannelConnection();

      res.json({
        totalOrders: orderCount,
        activeListings: activeListingsCount,
        lastSyncAt: conn?.lastSyncAt || null,
        syncStatus: conn?.syncStatus || "never",
      });
    } catch (err: any) {
      console.error("[eBay Settings] Error fetching stats:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
}
