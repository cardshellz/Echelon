import express, { type Request, type Response } from "express";
import { eq, and, sql, asc, isNotNull, inArray, isNull, desc } from "drizzle-orm";
import { db, pool } from "../../db";
import { requireAuth, requireInternalApiKey, requirePermission } from "../middleware";
import {
  channels,
  channelConnections,
  ebayOauthTokens,
  ebayCategoryMappings,
  products,
  productVariants,
  productTypes,
  inventoryLevels,
  ebayCategoryAspects,
  ebayTypeAspectDefaults,
  ebayProductAspectOverrides,
} from "@shared/schema";
import { getAuthService, getChannelConnection, escapeXml, getCached, setCache, ebayApiRequest, ebayApiRequestWithRateNotify, EBAY_CHANNEL_ID, atpService } from "./ebay-utils";
import { createInventoryAtpService } from "../../modules/inventory/atp.service";
import { upsertChannelListing, upsertPushError, clearPushError, resolveChannelPrice, applyPricingRule, determineVariationAspectName, syncActiveListings, triggerPricingRuleSync, delay } from "./ebay-sync-helpers";

export const router = express.Router();

  // GET /api/ebay/category-tree — Root-level eBay categories (Taxonomy API)
  // -----------------------------------------------------------------------
  router.get("/api/ebay/category-tree", requireAuth, async (_req: Request, res: Response) => {
    try {
      const cached = getCached<any>("root");
      if (cached) {
        res.json(cached);
        return;
      }

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

      const url = `${baseUrl}/commerce/taxonomy/v1/category_tree/0`;
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
                    "Content-Language": "en-US",
                    "Accept-Language": "en-US",
          Accept: "application/json",
        },
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error("[eBay Category Tree] API error:", resp.status, errText);
        res.status(resp.status).json({ error: `eBay API error: ${resp.status}` });
        return;
      }

      const data = await resp.json();
      const rootNode = data.rootCategoryNode;
      if (!rootNode || !rootNode.childCategoryTreeNodes) {
        res.json({ categories: [] });
        return;
      }

      const categories = rootNode.childCategoryTreeNodes.map((node: any) => ({
        categoryId: node.category?.categoryId,
        categoryName: node.category?.categoryName,
        hasChildren: !!(node.childCategoryTreeNodes && node.childCategoryTreeNodes.length > 0),
      }));

      const result = { categories };
      setCache("root", result);
      res.json(result);
    } catch (err: any) {
      console.error("[eBay Category Tree] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/ebay/category-tree/:categoryId/children — Children of a category

  // -----------------------------------------------------------------------
  router.get("/api/ebay/category-tree/:categoryId/children", requireAuth, async (req: Request, res: Response) => {
    try {
      const { categoryId } = req.params;
      if (!categoryId) {
        res.status(400).json({ error: "categoryId is required" });
        return;
      }

      const cacheKey = `children:${categoryId}`;
      const cached = getCached<any>(cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }

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

      const url = `${baseUrl}/commerce/taxonomy/v1/category_tree/0/get_category_subtree?category_id=${encodeURIComponent(categoryId)}`;
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
                    "Content-Language": "en-US",
                    "Accept-Language": "en-US",
          Accept: "application/json",
        },
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error("[eBay Category Children] API error:", resp.status, errText);
        res.status(resp.status).json({ error: `eBay API error: ${resp.status}` });
        return;
      }

      const data = await resp.json();
      const rootNode = data.categorySubtreeNode;
      if (!rootNode) {
        res.json({ categories: [], breadcrumb: "" });
        return;
      }

      // Build breadcrumb from ancestors
      const ancestors = data.categoryTreeNodeAncestors || [];
      const ancestorNames = ancestors
        .sort((a: any, b: any) => (b.categoryTreeNodeLevel || 0) - (a.categoryTreeNodeLevel || 0))
        .map((a: any) => a.categoryName);
      const breadcrumb = [...ancestorNames, rootNode.category?.categoryName].join(" > ");

      // Extract DIRECT children only
      const childNodes = rootNode.childCategoryTreeNodes || [];
      const categories = childNodes.map((node: any) => ({
        categoryId: node.category?.categoryId,
        categoryName: node.category?.categoryName,
        parentId: categoryId,
        hasChildren: !!(node.childCategoryTreeNodes && node.childCategoryTreeNodes.length > 0),
        breadcrumb,
      }));

      const result = { categories, breadcrumb };
      setCache(cacheKey, result);
      res.json(result);
    } catch (err: any) {
      console.error("[eBay Category Children] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/ebay/category-search — Search eBay browse categories (Taxonomy API)

  // -----------------------------------------------------------------------
  router.get("/api/ebay/category-search", requireAuth, async (req: Request, res: Response) => {
    try {
      const q = (req.query.q as string || "").trim();
      if (!q || q.length < 2) {
        res.json({ categories: [] });
        return;
      }

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

      const url = `${baseUrl}/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(q)}`;
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
                    "Content-Language": "en-US",
                    "Accept-Language": "en-US",
          Accept: "application/json",
        },
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error("[eBay Category Search] API error:", resp.status, errText);
        res.status(resp.status).json({ error: `eBay API error: ${resp.status}` });
        return;
      }

      const data = await resp.json();
      const suggestions = data.categorySuggestions || [];

      const categories = suggestions.slice(0, 10).map((s: any) => {
        const cat = s.category || {};
        const ancestors = s.categoryTreeNodeAncestors || [];
        // Build breadcrumb from ancestors (root → leaf)
        const ancestorNames = ancestors
          .sort((a: any, b: any) => (b.categoryTreeNodeLevel || 0) - (a.categoryTreeNodeLevel || 0))
          .map((a: any) => a.categoryName);
        const breadcrumb = [...ancestorNames, cat.categoryName].join(" > ");
        return {
          categoryId: cat.categoryId,
          categoryName: cat.categoryName,
          breadcrumb,
        };
      });

      res.json({ categories });
    } catch (err: any) {
      console.error("[eBay Category Search] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/ebay/category-aspects/:categoryId — Cached eBay aspect definitions

  // -----------------------------------------------------------------------
  router.get("/api/ebay/category-aspects/:categoryId", requireAuth, async (req: Request, res: Response) => {
    try {
      const { categoryId } = req.params;
      if (!categoryId) {
        res.status(400).json({ error: "categoryId is required" });
        return;
      }

        // Check cache freshness (24 hours)
        const cacheCheck = await db.select({ fetchedAt: ebayCategoryAspects.fetchedAt })
          .from(ebayCategoryAspects)
          .where(eq(ebayCategoryAspects.categoryId, categoryId))
          .limit(1);

        const isFresh =
          cacheCheck.length > 0 &&
          Date.now() - new Date(cacheCheck[0].fetchedAt).getTime() <
            24 * 60 * 60 * 1000;

        if (!isFresh) {
          // Fetch from eBay Taxonomy API
          const authService = getAuthService();
          if (!authService) {
            res.status(500).json({ error: "eBay OAuth not configured" });
            return;
          }
          const accessToken = await authService.getAccessToken(EBAY_CHANNEL_ID);

          const apiPath = `/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`;
          const data = await ebayApiRequest("GET", apiPath, accessToken);

          // Parse and upsert aspects
          const aspects: Array<{
            name: string;
            required: boolean;
            mode: string;
            usage: string;
            values: string[] | null;
            order: number;
          }> = [];

          if (data && data.aspects) {
            for (let i = 0; i < data.aspects.length; i++) {
              const a = data.aspects[i];
              const constraint = a.aspectConstraint || {};
              const name = a.localizedAspectName || "";
              if (!name) continue;

              const required =
                constraint.aspectRequired === true ||
                constraint.aspectUsage === "REQUIRED";
              const mode = constraint.aspectMode || "FREE_TEXT";
              const usage = constraint.aspectUsage || "RECOMMENDED";

              // Extract allowed values
              let values: string[] | null = null;
              if (a.aspectValues && Array.isArray(a.aspectValues)) {
                values = a.aspectValues
                  .map((v: any) => v.localizedValue)
                  .filter(Boolean);
              }

              aspects.push({
                name,
                required,
                mode,
                usage,
                values,
                order: i,
              });
            }
          }

          // Delete old + insert fresh (transactional)
          await db.transaction(async (tx) => {
            await tx.delete(ebayCategoryAspects).where(eq(ebayCategoryAspects.categoryId, categoryId));
            if (aspects.length > 0) {
              const insertData = aspects.map(a => ({
                  categoryId,
                  aspectName: a.name,
                  aspectRequired: a.required,
                  aspectMode: a.mode,
                  aspectUsage: a.usage,
                  aspectValues: a.values,
                  aspectOrder: a.order,
                  fetchedAt: new Date()
              }));
              await tx.insert(ebayCategoryAspects).values(insertData);
            }
          });
        }

        // Return cached aspects
        const result = await db.select({
            aspectName: ebayCategoryAspects.aspectName,
            aspectRequired: ebayCategoryAspects.aspectRequired,
            aspectMode: ebayCategoryAspects.aspectMode,
            aspectUsage: ebayCategoryAspects.aspectUsage,
            aspectValues: ebayCategoryAspects.aspectValues,
            aspectOrder: ebayCategoryAspects.aspectOrder,
          })
          .from(ebayCategoryAspects)
          .where(eq(ebayCategoryAspects.categoryId, categoryId))
          .orderBy(desc(ebayCategoryAspects.aspectRequired), asc(ebayCategoryAspects.aspectOrder));

        const aspectsList = result.map((r: any) => ({
          name: r.aspectName,
          required: r.aspectRequired,
          mode: r.aspectMode,
          usage: r.aspectUsage,
          values: r.aspectValues || null,
          order: r.aspectOrder,
        }));

        res.json({ aspects: aspectsList, categoryId });
    } catch (err: any) {
      console.error("[eBay Category Aspects] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/ebay/type-aspect-defaults/:productTypeSlug

  // -----------------------------------------------------------------------
  router.get("/api/ebay/type-aspect-defaults/:productTypeSlug", requireAuth, async (req: Request, res: Response) => {
    try {
      const { productTypeSlug } = req.params;
      const result = await db.select()
        .from(ebayTypeAspectDefaults)
        .where(eq(ebayTypeAspectDefaults.productTypeSlug, productTypeSlug));
      
      const defaults: Record<string, string> = {};
      for (const r of result) {
        defaults[r.aspectName] = r.aspectValue;
      }
      res.json({ defaults });
    } catch (err: any) {
      console.error("[eBay Type Aspect Defaults] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // PUT /api/ebay/type-aspect-defaults/:productTypeSlug

  // -----------------------------------------------------------------------
  router.put("/api/ebay/type-aspect-defaults/:productTypeSlug", requireAuth, async (req: Request, res: Response) => {
    try {
      const { productTypeSlug } = req.params;
      const { defaults } = req.body as { defaults: Record<string, string> };
      if (!defaults || typeof defaults !== "object") {
        res.status(400).json({ error: "defaults object is required" });
        return;
      }

      await db.transaction(async (tx) => {
        await tx.delete(ebayTypeAspectDefaults).where(eq(ebayTypeAspectDefaults.productTypeSlug, productTypeSlug));
        
        const entries = Object.entries(defaults).filter(
          ([, v]) => v !== undefined && v !== null && v !== "",
        );
        
        if (entries.length > 0) {
          const insertData = entries.map(([name, value]) => ({
            productTypeSlug,
            aspectName: name,
            aspectValue: value,
            createdAt: new Date(),
            updatedAt: new Date()
          }));
          await tx.insert(ebayTypeAspectDefaults).values(insertData);
        }
      });

      // Return updated defaults
      const result: Record<string, string> = {};
      const entries = Object.entries(defaults).filter(
        ([, v]) => v !== undefined && v !== null && v !== "",
      );
      for (const [name, value] of entries) {
        result[name] = value;
      }
      res.json({ defaults: result });
    } catch (err: any) {
      console.error("[eBay Type Aspect Defaults Save] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/ebay/product-aspects/:productId

  // -----------------------------------------------------------------------
  router.get("/api/ebay/product-aspects/:productId", requireAuth, async (req: Request, res: Response) => {
    try {
      const productId = parseInt(req.params.productId);
      if (isNaN(productId)) {
        res.status(400).json({ error: "Invalid product ID" });
        return;
      }
      const result = await db.select()
        .from(ebayProductAspectOverrides)
        .where(eq(ebayProductAspectOverrides.productId, productId));
      
      const overrides: Record<string, string> = {};
      for (const r of result) {
        overrides[r.aspectName] = r.aspectValue;
      }
      res.json({ overrides });
    } catch (err: any) {
      console.error("[eBay Product Aspects] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // PUT /api/ebay/product-aspects/:productId

  // -----------------------------------------------------------------------
  router.put("/api/ebay/product-aspects/:productId", requireAuth, async (req: Request, res: Response) => {
    try {
      const productId = parseInt(req.params.productId);
      if (isNaN(productId)) {
        res.status(400).json({ error: "Invalid product ID" });
        return;
      }
      const { overrides } = req.body as { overrides: Record<string, string> };
      if (!overrides || typeof overrides !== "object") {
        res.status(400).json({ error: "overrides object is required" });
        return;
      }

      await db.transaction(async (tx) => {
        await tx.delete(ebayProductAspectOverrides).where(eq(ebayProductAspectOverrides.productId, productId));

        const entries = Object.entries(overrides).filter(
          ([, v]) => v !== undefined && v !== null && v !== "",
        );
        
        if (entries.length > 0) {
          const insertData = entries.map(([name, value]) => ({
            productId,
            aspectName: name,
            aspectValue: value,
            createdAt: new Date(),
            updatedAt: new Date()
          }));
          await tx.insert(ebayProductAspectOverrides).values(insertData);
        }
      });

      const result: Record<string, string> = {};
      const entries = Object.entries(overrides).filter(
        ([, v]) => v !== undefined && v !== null && v !== "",
      );
      for (const [name, value] of entries) {
        result[name] = value;
      }
      res.json({ overrides: result });
    } catch (err: any) {
      console.error("[eBay Product Aspects Save] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/ebay/listings/push — Push products to eBay (create listings)
