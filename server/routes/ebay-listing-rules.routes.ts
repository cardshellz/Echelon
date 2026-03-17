/**
 * eBay Listing Rules Routes
 *
 * Manages cascading listing rules (default → product_type → SKU)
 * and product type assignments.
 *
 * GET    /api/ebay/listing-rules           — Get all rules for channel 67
 * POST   /api/ebay/listing-rules           — Create rule
 * PUT    /api/ebay/listing-rules/:id       — Update rule
 * DELETE /api/ebay/listing-rules/:id       — Delete rule
 * GET    /api/ebay/listing-rules/resolve/:sku — Resolve effective config for a SKU
 * GET    /api/ebay/store-categories        — Fetch eBay store categories via Trading API
 * GET    /api/ebay/browse-categories       — Search eBay browse categories via taxonomy API
 * GET    /api/product-types                — List all product types
 * GET    /api/products/with-types          — List all products with type info (for assignment UI)
 * PUT    /api/products/:id/product-type    — Update a single product's type
 * PUT    /api/products/bulk-product-type   — Bulk-assign product type
 */

import type { Express, Request, Response } from "express";
import { eq, and, isNull, sql, ilike, or, asc, desc } from "drizzle-orm";
import { db } from "../db";
import { pool } from "../db";
import {
  products,
  productVariants,
  productTypes,
  ebayListingRules,
  ebayOauthTokens,
} from "@shared/schema";
import {
  EbayAuthService,
  createEbayAuthConfig,
} from "../modules/channels/adapters/ebay/ebay-auth.service";

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

// ---------------------------------------------------------------------------
// Route Registration
// ---------------------------------------------------------------------------

export function registerEbayListingRulesRoutes(app: Express): void {
  // -----------------------------------------------------------------------
  // GET /api/product-types — List all product types
  // -----------------------------------------------------------------------
  app.get("/api/product-types", async (_req: Request, res: Response) => {
    try {
      const types = await (db as any)
        .select()
        .from(productTypes)
        .orderBy(asc(productTypes.sortOrder));
      res.json(types);
    } catch (err: any) {
      console.error("[Product Types] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/products/with-types — Products list for type assignment UI
  // -----------------------------------------------------------------------
  app.get("/api/products/with-types", async (req: Request, res: Response) => {
    try {
      const { filter, search } = req.query;
      
      let conditions: any[] = [eq(products.isActive, true)];
      
      if (filter === "assigned") {
        conditions.push(sql`${products.productType} IS NOT NULL`);
      } else if (filter === "unassigned") {
        conditions.push(isNull(products.productType));
      }
      
      if (search && typeof search === "string" && search.trim()) {
        const term = `%${search.trim()}%`;
        conditions.push(
          or(
            ilike(products.name, term),
            ilike(products.sku, term),
            ilike(products.title, term),
          )
        );
      }

      const result = await (db as any)
        .select({
          id: products.id,
          sku: products.sku,
          name: products.name,
          title: products.title,
          category: products.category,
          productType: products.productType,
          isActive: products.isActive,
        })
        .from(products)
        .where(and(...conditions))
        .orderBy(asc(products.name));

      res.json(result);
    } catch (err: any) {
      console.error("[Products With Types] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // PUT /api/products/:id/product-type — Assign product type to single product
  // -----------------------------------------------------------------------
  app.put("/api/products/:id/product-type", async (req: Request, res: Response) => {
    try {
      const productId = parseInt(req.params.id, 10);
      const { productType } = req.body;

      if (isNaN(productId)) {
        res.status(400).json({ error: "Invalid product ID" });
        return;
      }

      // Allow null/empty to unassign
      const typeValue = productType || null;

      // Validate the type slug exists if provided
      if (typeValue) {
        const [typeRow] = await (db as any)
          .select()
          .from(productTypes)
          .where(eq(productTypes.slug, typeValue))
          .limit(1);
        if (!typeRow) {
          res.status(400).json({ error: `Unknown product type: ${typeValue}` });
          return;
        }
      }

      await (db as any)
        .update(products)
        .set({ productType: typeValue, updatedAt: new Date() })
        .where(eq(products.id, productId));

      res.json({ success: true, productId, productType: typeValue });
    } catch (err: any) {
      console.error("[Product Type Update] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // PUT /api/products/bulk-product-type — Bulk assign product type
  // -----------------------------------------------------------------------
  app.put("/api/products/bulk-product-type", async (req: Request, res: Response) => {
    try {
      const { productIds, productType } = req.body;

      if (!Array.isArray(productIds) || productIds.length === 0) {
        res.status(400).json({ error: "productIds must be a non-empty array" });
        return;
      }

      const typeValue = productType || null;

      // Validate the type slug if provided
      if (typeValue) {
        const [typeRow] = await (db as any)
          .select()
          .from(productTypes)
          .where(eq(productTypes.slug, typeValue))
          .limit(1);
        if (!typeRow) {
          res.status(400).json({ error: `Unknown product type: ${typeValue}` });
          return;
        }
      }

      // Bulk update via raw SQL for efficiency
      const client = await pool.connect();
      try {
        const idList = productIds.map((id: number) => parseInt(String(id), 10)).filter((id: number) => !isNaN(id));
        await client.query(
          `UPDATE products SET product_type = $1, updated_at = NOW() WHERE id = ANY($2::int[])`,
          [typeValue, idList]
        );
        res.json({ success: true, updated: idList.length, productType: typeValue });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[Bulk Product Type] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/ebay/listing-rules — Get all rules for channel 67
  // -----------------------------------------------------------------------
  app.get("/api/ebay/listing-rules", async (_req: Request, res: Response) => {
    try {
      const rules = await (db as any)
        .select()
        .from(ebayListingRules)
        .where(eq(ebayListingRules.channelId, EBAY_CHANNEL_ID))
        .orderBy(asc(ebayListingRules.sortOrder));
      res.json(rules);
    } catch (err: any) {
      console.error("[eBay Listing Rules] Error fetching:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/ebay/listing-rules — Create rule
  // -----------------------------------------------------------------------
  app.post("/api/ebay/listing-rules", async (req: Request, res: Response) => {
    try {
      const {
        scopeType,
        scopeValue,
        ebayCategoryId,
        ebayStoreCategoryId,
        fulfillmentPolicyId,
        returnPolicyId,
        paymentPolicyId,
      } = req.body;

      if (!scopeType || !["default", "product_type", "sku"].includes(scopeType)) {
        res.status(400).json({ error: "scopeType must be 'default', 'product_type', or 'sku'" });
        return;
      }

      if (scopeType !== "default" && !scopeValue) {
        res.status(400).json({ error: "scopeValue is required for non-default rules" });
        return;
      }

      const [rule] = await (db as any)
        .insert(ebayListingRules)
        .values({
          channelId: EBAY_CHANNEL_ID,
          scopeType,
          scopeValue: scopeType === "default" ? null : scopeValue,
          ebayCategoryId: ebayCategoryId || null,
          ebayStoreCategoryId: ebayStoreCategoryId || null,
          fulfillmentPolicyId: fulfillmentPolicyId || null,
          returnPolicyId: returnPolicyId || null,
          paymentPolicyId: paymentPolicyId || null,
        })
        .returning();

      res.json(rule);
    } catch (err: any) {
      if (err.message?.includes("unique") || err.code === "23505") {
        res.status(409).json({ error: "A rule with this scope already exists" });
        return;
      }
      console.error("[eBay Listing Rules] Error creating:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // PUT /api/ebay/listing-rules/:id — Update rule
  // -----------------------------------------------------------------------
  app.put("/api/ebay/listing-rules/:id", async (req: Request, res: Response) => {
    try {
      const ruleId = parseInt(req.params.id, 10);
      if (isNaN(ruleId)) {
        res.status(400).json({ error: "Invalid rule ID" });
        return;
      }

      const {
        ebayCategoryId,
        ebayStoreCategoryId,
        fulfillmentPolicyId,
        returnPolicyId,
        paymentPolicyId,
        enabled,
      } = req.body;

      const updateData: any = { updatedAt: new Date() };
      if (ebayCategoryId !== undefined) updateData.ebayCategoryId = ebayCategoryId || null;
      if (ebayStoreCategoryId !== undefined) updateData.ebayStoreCategoryId = ebayStoreCategoryId || null;
      if (fulfillmentPolicyId !== undefined) updateData.fulfillmentPolicyId = fulfillmentPolicyId || null;
      if (returnPolicyId !== undefined) updateData.returnPolicyId = returnPolicyId || null;
      if (paymentPolicyId !== undefined) updateData.paymentPolicyId = paymentPolicyId || null;
      if (enabled !== undefined) updateData.enabled = enabled;

      const [updated] = await (db as any)
        .update(ebayListingRules)
        .set(updateData)
        .where(
          and(
            eq(ebayListingRules.id, ruleId),
            eq(ebayListingRules.channelId, EBAY_CHANNEL_ID),
          )
        )
        .returning();

      if (!updated) {
        res.status(404).json({ error: "Rule not found" });
        return;
      }

      res.json(updated);
    } catch (err: any) {
      console.error("[eBay Listing Rules] Error updating:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // DELETE /api/ebay/listing-rules/:id — Delete rule
  // -----------------------------------------------------------------------
  app.delete("/api/ebay/listing-rules/:id", async (req: Request, res: Response) => {
    try {
      const ruleId = parseInt(req.params.id, 10);
      if (isNaN(ruleId)) {
        res.status(400).json({ error: "Invalid rule ID" });
        return;
      }

      // Don't allow deleting the default rule
      const [existing] = await (db as any)
        .select()
        .from(ebayListingRules)
        .where(
          and(
            eq(ebayListingRules.id, ruleId),
            eq(ebayListingRules.channelId, EBAY_CHANNEL_ID),
          )
        )
        .limit(1);

      if (!existing) {
        res.status(404).json({ error: "Rule not found" });
        return;
      }

      if (existing.scopeType === "default") {
        res.status(400).json({ error: "Cannot delete the default rule. Edit it instead." });
        return;
      }

      await (db as any)
        .delete(ebayListingRules)
        .where(eq(ebayListingRules.id, ruleId));

      res.json({ success: true });
    } catch (err: any) {
      console.error("[eBay Listing Rules] Error deleting:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/ebay/listing-rules/resolve/:sku — Resolve effective config
  // -----------------------------------------------------------------------
  app.get("/api/ebay/listing-rules/resolve/:sku", async (req: Request, res: Response) => {
    try {
      const sku = req.params.sku;

      // Find the product and its type
      const [variant] = await (db as any)
        .select({
          variantId: productVariants.id,
          variantSku: productVariants.sku,
          productId: products.id,
          productName: products.name,
          productType: products.productType,
        })
        .from(productVariants)
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(eq(productVariants.sku, sku))
        .limit(1);

      if (!variant) {
        res.status(404).json({ error: `No product found for SKU: ${sku}` });
        return;
      }

      // Get all applicable rules
      const allRules = await (db as any)
        .select()
        .from(ebayListingRules)
        .where(
          and(
            eq(ebayListingRules.channelId, EBAY_CHANNEL_ID),
            eq(ebayListingRules.enabled, true),
          )
        );

      // Resolution order: SKU → product_type → default
      const skuRule = allRules.find((r: any) => r.scopeType === "sku" && r.scopeValue === sku);
      const typeRule = variant.productType
        ? allRules.find((r: any) => r.scopeType === "product_type" && r.scopeValue === variant.productType)
        : null;
      const defaultRule = allRules.find((r: any) => r.scopeType === "default");

      // Merge fields: SKU overrides type overrides default
      const fields = [
        "ebayCategoryId",
        "ebayStoreCategoryId",
        "fulfillmentPolicyId",
        "returnPolicyId",
        "paymentPolicyId",
      ] as const;

      const resolved: Record<string, any> = {};
      const sources: Record<string, string> = {};

      for (const field of fields) {
        if (skuRule && skuRule[field]) {
          resolved[field] = skuRule[field];
          sources[field] = `sku (${sku})`;
        } else if (typeRule && typeRule[field]) {
          resolved[field] = typeRule[field];
          sources[field] = `product_type (${variant.productType})`;
        } else if (defaultRule && defaultRule[field]) {
          resolved[field] = defaultRule[field];
          sources[field] = "default";
        } else {
          resolved[field] = null;
          sources[field] = "none";
        }
      }

      res.json({
        sku,
        productId: variant.productId,
        productName: variant.productName,
        productType: variant.productType,
        resolved,
        sources,
      });
    } catch (err: any) {
      console.error("[eBay Listing Rules] Error resolving:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/ebay/store-categories — Fetch eBay store categories via Trading API
  // -----------------------------------------------------------------------
  app.get("/api/ebay/store-categories", async (_req: Request, res: Response) => {
    try {
      const authService = getAuthService();
      if (!authService) {
        res.status(500).json({ error: "eBay OAuth not configured" });
        return;
      }

      const accessToken = await authService.getAccessToken(EBAY_CHANNEL_ID);

      // Use Trading API GetStore
      const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<GetStoreRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${accessToken}</eBayAuthToken></RequesterCredentials>
  <CategoryStructureOnly>true</CategoryStructureOnly>
</GetStoreRequest>`;

      const resp = await fetch("https://api.ebay.com/ws/api.dll", {
        method: "POST",
        headers: {
          "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
          "X-EBAY-API-CALL-NAME": "GetStore",
          "X-EBAY-API-SITEID": "0",
          "Content-Type": "text/xml",
        },
        body: xmlBody,
      });

      const xmlText = await resp.text();

      // Parse categories from XML
      const categories: Array<{ id: string; name: string; parentId?: string }> = [];
      const categoryRegex = /<CustomCategory>([\s\S]*?)<\/CustomCategory>/g;
      let match;
      while ((match = categoryRegex.exec(xmlText)) !== null) {
        const block = match[1];
        const idMatch = block.match(/<CategoryID>(\d+)<\/CategoryID>/);
        const nameMatch = block.match(/<Name>([^<]+)<\/Name>/);
        if (idMatch && nameMatch) {
          categories.push({
            id: idMatch[1],
            name: nameMatch[1],
          });
        }
      }

      res.json({ categories });
    } catch (err: any) {
      console.error("[eBay Store Categories] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/ebay/browse-categories?q= — Search eBay browse categories
  // -----------------------------------------------------------------------
  app.get("/api/ebay/browse-categories", async (req: Request, res: Response) => {
    try {
      const q = req.query.q as string;
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

      // Use Taxonomy API to get category suggestions
      const resp = await fetch(
        `${baseUrl}/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(q)}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
          },
        },
      );

      if (!resp.ok) {
        const errorBody = await resp.text();
        console.error("[eBay Browse Categories] API error:", resp.status, errorBody);
        res.status(resp.status).json({ error: `eBay API error: ${resp.status}` });
        return;
      }

      const data = await resp.json();
      const suggestions = (data.categorySuggestions || []).map((s: any) => ({
        id: s.category?.categoryId,
        name: s.category?.categoryName,
        path: (s.categoryTreeNodeAncestors || [])
          .map((a: any) => a.categoryName)
          .concat(s.category?.categoryName)
          .join(" > "),
      }));

      res.json({ categories: suggestions });
    } catch (err: any) {
      console.error("[eBay Browse Categories] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
}
