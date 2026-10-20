import express, { type Request, type Response, type Router } from "express";
import { z } from "zod";
import { eq, and, isNotNull } from "drizzle-orm";
import { db } from "../../db";
import { requireAuth, requirePermission } from "../middleware";
import { products, productVariants } from "@shared/schema";
import { EBAY_CHANNEL_ID } from "./ebay-utils";
import { createChannelPricingService } from "../../modules/channels/channel-pricing.service";
import { sendChannelPricingError } from "../../modules/channels/interfaces/http/channel-pricing.error";
import {
  resolveChannelListingPrice,
  ChannelPricingResolutionError,
} from "../../modules/channels/channel-pricing-resolver";

type EbayPricingRuleService = Pick<
  ReturnType<typeof createChannelPricingService>,
  "listRules" | "saveRule" | "deleteRule"
>;

/** The legacy eBay API translates its response shape; Channels owns pricing writes. */
export function registerEbayPricingRuleRoutes(
  target: Router,
  service: EbayPricingRuleService = createChannelPricingService(db),
  channelId = EBAY_CHANNEL_ID,
): void {
  const actor = (request: Request): string =>
    z.string().trim().min(1).max(200).parse(request.session?.user?.id);

  target.get(
    "/api/ebay/pricing-rules",
    requireAuth,
    async (_req: Request, res: Response) => {
      try {
        const rules = await service.listRules(channelId);
        res.json({
          rules: rules.map((rule) => ({
            id: rule.id,
            channel_id: rule.channelId,
            scope: rule.scope,
            scope_id: rule.scopeId,
            rule_type: rule.ruleType,
            value: rule.value,
            created_at: rule.createdAt,
            updated_at: rule.updatedAt,
            scope_label: rule.scopeLabel,
          })),
        });
      } catch (error) {
        sendChannelPricingError(res, error, "ebay_pricing_rules_read");
      }
    },
  );

  target.put(
    "/api/ebay/pricing-rules",
    requireAuth,
    requirePermission("channels", "edit"),
    async (req: Request, res: Response) => {
      try {
        const rule = await service.saveRule(channelId, req.body, actor(req), new Date());
        res.json({
          rule: {
            id: rule.id,
            channel_id: rule.channelId,
            scope: rule.scope,
            scope_id: rule.scopeId,
            rule_type: rule.ruleType,
            value: rule.value,
          },
        });
      } catch (error) {
        sendChannelPricingError(res, error, "ebay_pricing_rule_save");
      }
    },
  );

  target.delete(
    "/api/ebay/pricing-rules/:id",
    requireAuth,
    requirePermission("channels", "edit"),
    async (req: Request, res: Response) => {
      try {
        const ruleId = z.coerce.number().int().positive().max(2_147_483_647).parse(req.params.id);
        const body = z.object({ expected: z.unknown().optional() }).strict().parse(req.body ?? {});
        await service.deleteRule(channelId, ruleId, actor(req), new Date(), body.expected);
        res.json({ success: true });
      } catch (error) {
        sendChannelPricingError(res, error, "ebay_pricing_rule_delete");
      }
    },
  );
}

export const router = express.Router();
registerEbayPricingRuleRoutes(router);

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
      const resolution = await resolveChannelListingPrice(db, {
        channelId: EBAY_CHANNEL_ID,
        productId: variant.productId,
        variantId: variant.id,
        fallbackCatalogPriceCents: variant.priceCents,
      });
      const basePrice = resolution.basePriceCents ?? 0;
      const effectivePrice = resolution.priceCents ?? 0;

      res.json({
        variantId,
        basePriceCents: basePrice,
        effectivePriceCents: effectivePrice,
        priceSource: resolution.source,
        priceProvenance: resolution.provenance,
        appliedPricingRule: resolution.appliedRule,
        missingPrice: resolution.priceCents === null,
        basePrice: (basePrice / 100).toFixed(2),
        effectivePrice: (effectivePrice / 100).toFixed(2),
      });
    } catch (err: any) {
      console.error("[eBay Effective Price] Error:", err.message);
      res.status(err instanceof ChannelPricingResolutionError ? err.status : 500).json({ error: err.message, ...(err instanceof ChannelPricingResolutionError ? { code: err.code } : {}) });
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

      const prices: Record<number, {
        basePriceCents: number | null;
        effectivePriceCents: number | null;
        priceSource: string | null;
        priceProvenance: Awaited<ReturnType<typeof resolveChannelListingPrice>>["provenance"];
        missingPrice: boolean;
        resolutionIssue?: { code: string; message: string };
      }> = {};
      for (const v of varResult) {
        try {
          const resolution = await resolveChannelListingPrice(db, {
            channelId: EBAY_CHANNEL_ID, productId: v.productId, variantId: v.id,
            fallbackCatalogPriceCents: v.priceCents,
          });
          prices[v.id] = {
            basePriceCents: resolution.basePriceCents,
            effectivePriceCents: resolution.priceCents,
            priceSource: resolution.source, priceProvenance: resolution.provenance,
            missingPrice: resolution.priceCents === null,
          };
        } catch (error) {
          if (!(error instanceof ChannelPricingResolutionError)) throw error;
          // A source conflict blocks this variant, not the healthy price previews.
          // Null means unavailable; it must never be displayed as a zero price.
          prices[v.id] = { basePriceCents: null, effectivePriceCents: null, priceSource: null,
            priceProvenance: null, missingPrice: true,
            resolutionIssue: { code: error.code, message: error.message } };
        }
      }

      res.json({ prices });
    } catch (err: any) {
      console.error("[eBay Effective Prices] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
