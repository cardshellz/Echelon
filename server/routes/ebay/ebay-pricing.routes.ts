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

  // GET /api/ebay/pricing-rules
  router.get("/api/ebay/pricing-rules", requireAuth, async (_req: Request, res: Response) => {
    try {
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT r.*,
                  CASE r.scope
                    WHEN 'product' THEN (SELECT name FROM catalog.products WHERE id = r.scope_id::int LIMIT 1)
                    WHEN 'variant' THEN (SELECT pv.name || ' (' || pv.sku || ')' FROM catalog.product_variants pv WHERE pv.id = r.scope_id::int LIMIT 1)
                    WHEN 'category' THEN (SELECT pt.name FROM catalog.product_types pt WHERE pt.slug = r.scope_id LIMIT 1)
                    ELSE NULL
                  END AS scope_label
           FROM channel_pricing_rules r
           WHERE r.channel_id = $1
           ORDER BY
             CASE r.scope WHEN 'channel' THEN 4 WHEN 'category' THEN 3 WHEN 'product' THEN 2 WHEN 'variant' THEN 1 END,
             r.created_at ASC`,
          [EBAY_CHANNEL_ID],
        );
        res.json({ rules: result.rows });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Pricing Rules] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });


  // PUT /api/ebay/pricing-rules
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

      const client = await pool.connect();
      try {
        // Handle NULL scope_id for channel-level rules with proper ON CONFLICT
        const result = await client.query(
          `INSERT INTO channel_pricing_rules (channel_id, scope, scope_id, rule_type, value, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
           ON CONFLICT (channel_id, scope, scope_id) WHERE scope_id IS NOT NULL
           DO UPDATE SET rule_type = EXCLUDED.rule_type, value = EXCLUDED.value, updated_at = NOW()
           RETURNING *`,
          [EBAY_CHANNEL_ID, scope, effectiveScopeId, ruleType, value],
        );

        // If no rows returned (channel-level insert conflict), try update
        if (result.rows.length === 0) {
          const updateResult = await client.query(
            `UPDATE channel_pricing_rules SET rule_type = $1, value = $2, updated_at = NOW()
             WHERE channel_id = $3 AND scope = $4 AND scope_id IS NULL
             RETURNING *`,
            [ruleType, value, EBAY_CHANNEL_ID, scope],
          );
          if (updateResult.rows.length > 0) {
            // Fire-and-forget: sync affected listings after pricing rule change
            triggerPricingRuleSync(scope, effectiveScopeId).catch((e) =>
              console.error("[eBay Pricing Rule Sync] Background sync error:", e.message),
            );
            res.json({ rule: updateResult.rows[0] });
            return;
          }
        }

        // Fire-and-forget: sync affected listings after pricing rule change
        triggerPricingRuleSync(scope, effectiveScopeId).catch((e) =>
          console.error("[eBay Pricing Rule Sync] Background sync error:", e.message),
        );
        res.json({ rule: result.rows[0] });
      } finally {
        client.release();
      }
    } catch (err: any) {
      // Handle unique violation for channel-level (scope_id IS NULL)
      if (err.code === "23505" && err.message?.includes("channel_pricing_rules")) {
        try {
          const { scope, ruleType, value } = req.body;
          const client2 = await pool.connect();
          try {
            const updateResult = await client2.query(
              `UPDATE channel_pricing_rules SET rule_type = $1, value = $2, updated_at = NOW()
               WHERE channel_id = $3 AND scope = $4 AND scope_id IS NULL
               RETURNING *`,
              [ruleType, value, EBAY_CHANNEL_ID, scope],
            );
            // Fire-and-forget: sync affected listings after pricing rule change
            triggerPricingRuleSync(scope, null).catch((e) =>
              console.error("[eBay Pricing Rule Sync] Background sync error:", e.message),
            );
            res.json({ rule: updateResult.rows[0] });
            return;
          } finally {
            client2.release();
          }
        } catch (err2: any) {
          res.status(500).json({ error: err2.message });
          return;
        }
      }
      console.error("[eBay Pricing Rules Upsert] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });


  // DELETE /api/ebay/pricing-rules/:id
  router.delete("/api/ebay/pricing-rules/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

      const client = await pool.connect();
      try {
        await client.query(
          `DELETE FROM channel_pricing_rules WHERE id = $1 AND channel_id = $2`,
          [id, EBAY_CHANNEL_ID],
        );
        res.json({ success: true });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Pricing Rules Delete] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });


  // GET /api/ebay/effective-price/:variantId
  router.get("/api/ebay/effective-price/:variantId", requireAuth, async (req: Request, res: Response) => {
    try {
      const variantId = parseInt(req.params.variantId);
      if (isNaN(variantId)) { res.status(400).json({ error: "Invalid variantId" }); return; }

      const client = await pool.connect();
      try {
        const varResult = await client.query(
          `SELECT pv.id, pv.product_id, pv.price_cents, pv.sku, pv.name FROM catalog.product_variants pv WHERE pv.id = $1`,
          [variantId],
        );
        if (varResult.rows.length === 0) { res.status(404).json({ error: "Variant not found" }); return; }

        const variant = varResult.rows[0];
        const effectivePrice = await resolveChannelPrice(client, EBAY_CHANNEL_ID, variant.product_id, variant.id, variant.price_cents);

        res.json({
          variantId,
          basePriceCents: variant.price_cents,
          effectivePriceCents: effectivePrice,
          basePrice: (variant.price_cents / 100).toFixed(2),
          effectivePrice: (effectivePrice / 100).toFixed(2),
        });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Effective Price] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });


  // GET /api/ebay/effective-prices — bulk effective prices for listing feed
  router.get("/api/ebay/effective-prices", requireAuth, async (_req: Request, res: Response) => {
    try {
      const client = await pool.connect();
      try {
        const varResult = await client.query(
          `SELECT pv.id, pv.product_id, pv.price_cents
           FROM product_variants pv
           JOIN catalog.products p ON p.id = pv.product_id
           WHERE p.is_active = true AND pv.sku IS NOT NULL`,
        );

        const prices: Record<number, { basePriceCents: number; effectivePriceCents: number }> = {};
        for (const v of varResult.rows) {
          const effective = await resolveChannelPrice(client, EBAY_CHANNEL_ID, v.product_id, v.id, v.price_cents);
          prices[v.id] = { basePriceCents: v.price_cents, effectivePriceCents: effective };
        }

        res.json({ prices });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Effective Prices] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/ebay/listings/reconcile — Verify eBay listings still exist
