import type { Express, Response } from "express";
import { z } from "zod";

import { requirePermission } from "../../routes/middleware";
import { shopifyProductConsolidationPreviewRequestSchema } from "./shopify-product-consolidation.domain";
import { createShopifyProductConsolidationService } from "./shopify-product-consolidation.service";
import { ShopifyMappingReconciliationError } from "./shopify-product-mapping-reconciliation.repository";
import { ShopifyMappingVerificationError } from "./shopify-product-mapping-verifier";

const paramsSchema = z.object({
  channelId: z.coerce.number().int().positive(),
}).strict();

function sendConsolidationError(res: Response, error: unknown): Response {
  if (error instanceof z.ZodError) {
    return res.status(400).json({
      error: "Invalid Shopify product consolidation request",
      code: "INVALID_SHOPIFY_PRODUCT_CONSOLIDATION_REQUEST",
      context: { issues: error.issues },
    });
  }
  if (
    error instanceof ShopifyMappingReconciliationError
    || error instanceof ShopifyMappingVerificationError
  ) {
    return res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
      context: error.context,
    });
  }
  console.error("Error previewing Shopify product consolidation:", error);
  return res.status(500).json({
    error: "Failed to preview Shopify product consolidation",
    code: "SHOPIFY_PRODUCT_CONSOLIDATION_FAILED",
  });
}

export function registerShopifyProductConsolidationRoutes(app: Express): void {
  const service = createShopifyProductConsolidationService();

  app.post(
    "/api/channels/:channelId/shopify-mapping-reconciliation/ownership-review/consolidation/preview",
    requirePermission("inventory", "view"),
    async (req, res) => {
      try {
        const params = paramsSchema.parse(req.params);
        const request = shopifyProductConsolidationPreviewRequestSchema.parse(req.body);
        return res.json(await service.preview({
          channelId: params.channelId,
          request,
        }));
      } catch (error: unknown) {
        return sendConsolidationError(res, error);
      }
    },
  );
}
