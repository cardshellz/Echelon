import type { Express, Request, Response } from "express";
import { z } from "zod";

import { requirePermission } from "../../routes/middleware";
import {
  createShopifyProductMappingReconciliationService,
  ShopifyMappingReconciliationError,
} from "./shopify-product-mapping-reconciliation.service";
import {
  ShopifyMappingVerificationError,
} from "./shopify-product-mapping-verifier";

const reconciliationParamsSchema = z.object({
  channelId: z.coerce.number().int().positive(),
});
const retireParamsSchema = reconciliationParamsSchema.extend({
  productId: z.coerce.number().int().positive(),
});
const retireBodySchema = z.object({
  expectedProductId: z.union([
    z.string().trim().min(1).max(100),
    z.number().int().positive(),
  ]),
  expectedFingerprint: z.string().trim().min(1).max(100_000),
  expectedShopDomain: z.string().trim().min(1).max(255),
}).strict();

function authenticatedActor(req: Request): string {
  const sessionUser = (
    req as Request & {
      session?: {
        user?: {
          id?: string | number | null;
          username?: string | null;
        };
      };
      user?: {
        username?: string | null;
      };
    }
  );
  const identity = sessionUser.session?.user?.id
    ?? sessionUser.session?.user?.username
    ?? sessionUser.user?.username;
  if (
    identity === null
    || identity === undefined
    || String(identity).trim() === ""
  ) {
    throw new ShopifyMappingReconciliationError(
      "AUTHENTICATED_ACTOR_REQUIRED",
      "Authenticated user identity is required",
      401,
    );
  }
  return `user:${String(identity).trim()}`;
}

function sendMappingError(
  res: Response,
  error: unknown,
  operation: string,
): Response {
  if (error instanceof z.ZodError) {
    return res.status(400).json({
      error: `Invalid ${operation} request`,
      code: "INVALID_SHOPIFY_MAPPING_RECONCILIATION_REQUEST",
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

  console.error(`Error during ${operation}:`, error);
  return res.status(500).json({
    error: `Failed to ${operation}`,
    code: "SHOPIFY_MAPPING_RECONCILIATION_FAILED",
  });
}

export function registerShopifyProductMappingReconciliationRoutes(
  app: Express,
): void {
  const service = createShopifyProductMappingReconciliationService();

  app.get(
    "/api/channels/:channelId/shopify-mapping-reconciliation",
    requirePermission("inventory", "view"),
    async (req, res) => {
      try {
        const params = reconciliationParamsSchema.parse(req.params);
        return res.json(await service.scan(params.channelId));
      } catch (error: unknown) {
        return sendMappingError(
          res,
          error,
          "reconcile Shopify product mappings",
        );
      }
    },
  );

  app.post(
    "/api/channels/:channelId/shopify-mapping-reconciliation/products/:productId/retire",
    requirePermission("inventory", "edit"),
    async (req, res) => {
      try {
        const params = retireParamsSchema.parse(req.params);
        const body = retireBodySchema.parse(req.body);
        return res.json(await service.retireStaleMapping({
          channelId: params.channelId,
          productId: params.productId,
          expectedProductId: body.expectedProductId,
          expectedFingerprint: body.expectedFingerprint,
          expectedShopDomain: body.expectedShopDomain,
          actor: authenticatedActor(req),
        }));
      } catch (error: unknown) {
        return sendMappingError(
          res,
          error,
          "retire stale Shopify product mapping",
        );
      }
    },
  );
}
