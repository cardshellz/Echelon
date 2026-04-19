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

      const client = await pool.connect();
      try {
        // Check cache freshness (24 hours)
        const cacheCheck = await client.query(
          `SELECT fetched_at FROM ebay_category_aspects
           WHERE category_id = $1 LIMIT 1`,
          [categoryId],
        );

        const isFresh =
          cacheCheck.rows.length > 0 &&
          Date.now() - new Date(cacheCheck.rows[0].fetched_at).getTime() <
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
          await client.query("BEGIN");
          await client.query(
            "DELETE FROM ebay_category_aspects WHERE category_id = $1",
            [categoryId],
          );
          for (const a of aspects) {
            await client.query(
              `INSERT INTO ebay_category_aspects
                 (category_id, aspect_name, aspect_required, aspect_mode, aspect_usage, aspect_values, aspect_order, fetched_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
              [
                categoryId,
                a.name,
                a.required,
                a.mode,
                a.usage,
                a.values ? JSON.stringify(a.values) : null,
                a.order,
              ],
            );
          }
          await client.query("COMMIT");
        }

        // Return cached aspects
        const result = await client.query(
          `SELECT aspect_name, aspect_required, aspect_mode, aspect_usage, aspect_values, aspect_order
           FROM ebay_category_aspects
           WHERE category_id = $1
           ORDER BY aspect_required DESC, aspect_order ASC`,
          [categoryId],
        );

        const aspects = result.rows.map((r: any) => ({
          name: r.aspect_name,
          required: r.aspect_required,
          mode: r.aspect_mode,
          usage: r.aspect_usage,
          values: r.aspect_values || null,
          order: r.aspect_order,
        }));

        res.json({ aspects, categoryId });
      } catch (err: any) {
        // Rollback if we were in a transaction
        try {
          await client.query("ROLLBACK");
        } catch {}
        throw err;
      } finally {
        client.release();
      }
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
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT aspect_name, aspect_value FROM ebay_type_aspect_defaults
           WHERE product_type_slug = $1`,
          [productTypeSlug],
        );
        const defaults: Record<string, string> = {};
        for (const r of result.rows) {
          defaults[r.aspect_name] = r.aspect_value;
        }
        res.json({ defaults });
      } finally {
        client.release();
      }
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

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Delete all existing for this slug
        await client.query(
          "DELETE FROM ebay_type_aspect_defaults WHERE product_type_slug = $1",
          [productTypeSlug],
        );

        // Insert new
        const entries = Object.entries(defaults).filter(
          ([, v]) => v !== undefined && v !== null && v !== "",
        );
        for (const [name, value] of entries) {
          await client.query(
            `INSERT INTO ebay_type_aspect_defaults (product_type_slug, aspect_name, aspect_value, created_at, updated_at)
             VALUES ($1, $2, $3, NOW(), NOW())`,
            [productTypeSlug, name, value],
          );
        }

        await client.query("COMMIT");

        // Return updated defaults
        const result: Record<string, string> = {};
        for (const [name, value] of entries) {
          result[name] = value;
        }
        res.json({ defaults: result });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
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
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT aspect_name, aspect_value FROM ebay_product_aspect_overrides
           WHERE product_id = $1`,
          [productId],
        );
        const overrides: Record<string, string> = {};
        for (const r of result.rows) {
          overrides[r.aspect_name] = r.aspect_value;
        }
        res.json({ overrides });
      } finally {
        client.release();
      }
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

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Delete all existing for this product
        await client.query(
          "DELETE FROM ebay_product_aspect_overrides WHERE product_id = $1",
          [productId],
        );

        // Insert new
        const entries = Object.entries(overrides).filter(
          ([, v]) => v !== undefined && v !== null && v !== "",
        );
        for (const [name, value] of entries) {
          await client.query(
            `INSERT INTO ebay_product_aspect_overrides (product_id, aspect_name, aspect_value, created_at, updated_at)
             VALUES ($1, $2, $3, NOW(), NOW())`,
            [productId, name, value],
          );
        }

        await client.query("COMMIT");

        const result: Record<string, string> = {};
        for (const [name, value] of entries) {
          result[name] = value;
        }
        res.json({ overrides: result });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Product Aspects Save] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/ebay/listings/push — Push products to eBay (create listings)
