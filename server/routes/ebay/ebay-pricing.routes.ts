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
  channelPricingRules,
} from "@shared/schema";
import { getAuthService, getChannelConnection, escapeXml, getCached, setCache, ebayApiRequest, ebayApiRequestWithRateNotify, EBAY_CHANNEL_ID, atpService } from "./ebay-utils";
import { createInventoryAtpService } from "../../modules/inventory/atp.service";
import { upsertChannelListing, upsertPushError, clearPushError, resolveChannelPrice, applyPricingRule, determineVariationAspectName, syncActiveListings, triggerPricingRuleSync, delay } from "./ebay-sync-helpers";

export const router = express.Router();

  router.get("/api/ebay/pricing-rules", requireAuth, async (_req: Request, res: Response) => {
    try {
      const result = await db.select({
        id: channelPricingRules.id,
        channelId: channelPricingRules.channelId,
        scope: channelPricingRules.scope,
        scopeId: channelPricingRules.scopeId,
        ruleType: channelPricingRules.ruleType,
        value: channelPricingRules.value,
        createdAt: channelPricingRules.createdAt,
        updatedAt: channelPricingRules.updatedAt,
        scopeLabel: sql<string>`
          CASE ${channelPricingRules.scope}
            WHEN 'product' THEN (SELECT name FROM catalog.products WHERE id = ${channelPricingRules.scopeId}::int LIMIT 1)
            WHEN 'variant' THEN (SELECT pv.name || ' (' || pv.sku || ')' FROM catalog.product_variants pv WHERE pv.id = ${channelPricingRules.scopeId}::int LIMIT 1)
            WHEN 'category' THEN (SELECT pt.name FROM catalog.product_types pt WHERE pt.slug = ${channelPricingRules.scopeId} LIMIT 1)
            ELSE NULL
          END
        `
      })
      .from(channelPricingRules)
      .where(eq(channelPricingRules.channelId, EBAY_CHANNEL_ID))
      .orderBy(
        sql`CASE ${channelPricingRules.scope} WHEN 'channel' THEN 4 WHEN 'category' THEN 3 WHEN 'product' THEN 2 WHEN 'variant' THEN 1 END`,
        asc(channelPricingRules.createdAt)
      );
      
      const mapped = result.map(r => ({
        id: r.id,
        channel_id: r.channelId,
        scope: r.scope,
        scope_id: r.scopeId,
        rule_type: r.ruleType,
        value: r.value,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
        scope_label: r.scopeLabel
      }));
      res.json({ rules: mapped });
    } catch (err: any) {
      console.error("[eBay Pricing Rules] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });


  router.put("/api/ebay/pricing-rules", requireAuth, async (req: Request, res: Response) => {
    try {
      const { scope, scopeId, ruleType, value } = req.body as {
        scope: string;
        scopeId: string | null;
        ruleType: string;
        value: number;
      };

      if (!["channel", "category", "product", "variant"].includes(scope)) {
        res.status(400).json({ error: "Invalid scope" });
        return;
      }
      if (!["percentage", "fixed", "override"].includes(ruleType)) {
        res.status(400).json({ error: "Invalid ruleType" });
        return;
      }
      if (typeof value !== "number" || isNaN(value)) {
        res.status(400).json({ error: "value must be a number" });
        return;
      }

      const effectiveScopeId = scope === "channel" ? null : scopeId;

      const ruleResult = await db.transaction(async (tx) => {
        if (effectiveScopeId === null) {
          const updated = await tx.update(channelPricingRules)
            .set({ ruleType, value: String(value), updatedAt: new Date() })
            .where(and(eq(channelPricingRules.channelId, EBAY_CHANNEL_ID), eq(channelPricingRules.scope, scope), isNull(channelPricingRules.scopeId)))
            .returning();
          if (updated.length > 0) return updated[0];
          
          const inserted = await tx.insert(channelPricingRules)
            .values({ channelId: EBAY_CHANNEL_ID, scope, scopeId: null, ruleType, value: String(value), createdAt: new Date(), updatedAt: new Date() })
            .returning();
          return inserted[0];
        } else {
          const inserted = await tx.insert(channelPricingRules)
            .values({ channelId: EBAY_CHANNEL_ID, scope, scopeId: effectiveScopeId, ruleType, value: String(value), createdAt: new Date(), updatedAt: new Date() })
            .onConflictDoUpdate({
              target: [channelPricingRules.channelId, channelPricingRules.scope, channelPricingRules.scopeId],
              set: { ruleType, value: String(value), updatedAt: new Date() }
            })
            .returning();
          return inserted[0];
        }
      });

      // Fire-and-forget: sync affected listings after pricing rule change
      triggerPricingRuleSync(scope, effectiveScopeId).catch((e) =>
        console.error("[eBay Pricing Rule Sync] Background sync error:", e.message),
      );
      
      res.json({ rule: {
        id: ruleResult.id,
        channel_id: ruleResult.channelId,
        scope: ruleResult.scope,
        scope_id: ruleResult.scopeId,
        rule_type: ruleResult.ruleType,
        value: ruleResult.value
      } });
    } catch (err: any) {
      console.error("[eBay Pricing Rules Upsert] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });


  router.delete("/api/ebay/pricing-rules/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

      await db.delete(channelPricingRules)
        .where(and(eq(channelPricingRules.id, id), eq(channelPricingRules.channelId, EBAY_CHANNEL_ID)));
        
      res.json({ success: true });
    } catch (err: any) {
      console.error("[eBay Pricing Rules Delete] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });


  router.get("/api/ebay/effective-price/:variantId", requireAuth, async (req: Request, res: Response) => {
    try {
      const variantId = parseInt(req.params.variantId);
      if (isNaN(variantId)) { res.status(400).json({ error: "Invalid variantId" }); return; }

      const varResult = await db.select({
        id: productVariants.id,
        productId: productVariants.productId,
        priceCents: productVariants.priceCents,
        sku: productVariants.sku,
        name: productVariants.name
      })
      .from(productVariants)
      .where(eq(productVariants.id, variantId));
      
      if (varResult.length === 0) { res.status(404).json({ error: "Variant not found" }); return; }

      const variant = varResult[0];
      const basePrice = variant.priceCents ?? 0;
      const effectivePrice = await resolveChannelPrice(db, EBAY_CHANNEL_ID, variant.productId, variant.id, basePrice);

      res.json({
        variantId,
        basePriceCents: basePrice,
        effectivePriceCents: effectivePrice,
        basePrice: (basePrice / 100).toFixed(2),
        effectivePrice: (effectivePrice / 100).toFixed(2),
      });
    } catch (err: any) {
      console.error("[eBay Effective Price] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });


  router.get("/api/ebay/effective-prices", requireAuth, async (_req: Request, res: Response) => {
    try {
      const varResult = await db.select({
        id: productVariants.id,
        productId: productVariants.productId,
        priceCents: productVariants.priceCents
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(and(eq(products.isActive, true), isNotNull(productVariants.sku)));

      const prices: Record<number, { basePriceCents: number; effectivePriceCents: number }> = {};
      for (const v of varResult) {
        const basePrice = v.priceCents ?? 0;
        const effective = await resolveChannelPrice(db, EBAY_CHANNEL_ID, v.productId, v.id, basePrice);
        prices[v.id] = { basePriceCents: basePrice, effectivePriceCents: effective };
      }

      res.json({ prices });
    } catch (err: any) {
      console.error("[eBay Effective Prices] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/ebay/listings/reconcile — Verify eBay listings still exist
