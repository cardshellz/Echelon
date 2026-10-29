import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  shopifyProductConnectionExecuteSchema, shopifyProductConnectionRequestSchema,
  shopifyProductConnectionContextSchema, shopifyProductConnectionCommandSchema,
  shopifyProductConnectionPreviewSchema, shopifyProductConnectionResultSchema,
} from "@shared/catalog/shopify-product-connection";
import { requirePermission } from "../../routes/middleware";
import { createDefaultShopifyProductConnectionService } from "../../services/shopify-product-connection";
import type { ShopifyProductConnectionService } from "./shopify-product-connection.service";
import { ShopifyProductConnectionError } from "./shopify-product-connection.domain";

const productIdSchema = z.coerce.number().int().positive().max(2_147_483_647);
const commandKeySchema = z.string().uuid();

function sendResult(res: Response, schema: z.ZodTypeAny, value: unknown, status = 200): void {
  res.setHeader("Cache-Control", "no-store");
  const result = schema.safeParse(value);
  if (!result.success) {
    console.error(JSON.stringify({ code: "SHOPIFY_CONNECTION_OUTPUT_INVALID", paths: result.error.issues.map(issue => issue.path) }));
    throw new ShopifyProductConnectionError("SHOPIFY_CONNECTION_OUTPUT_INVALID", "The Shopify result could not be verified. Refresh the saved command's status.", 503, true);
  }
  res.status(status).json(result.data);
}

function sendError(res: Response, error: unknown): void {
  res.setHeader("Cache-Control", "no-store");
  if (error instanceof z.ZodError) {
    res.status(400).json({ code: "SHOPIFY_CONNECTION_REQUEST_INVALID", error: error.issues.map(issue => issue.message).join("; "), retryable: false });
    return;
  }
  if (error instanceof ShopifyProductConnectionError) {
    if (error.retryable) res.setHeader("Retry-After", "2");
    res.status(error.statusCode).json({ code: error.code, error: error.message, retryable: error.retryable });
    return;
  }
  console.error(JSON.stringify({ code: "SHOPIFY_PRODUCT_CONNECTION_UNEXPECTED", errorType: error instanceof Error ? error.name : typeof error }));
  res.status(503).json({ code: "SHOPIFY_CONNECTION_UNAVAILABLE", error: "The Shopify connection could not be checked. Refresh the product and retry the saved command.", retryable: true });
}

function actor(req: Request): string {
  const id = req.session.user?.id;
  if (typeof id !== "string" || !id.trim()) throw new ShopifyProductConnectionError("SHOPIFY_ACTOR_REQUIRED", "An authenticated operator is required.", 403);
  return `user:${id}`;
}

export function registerShopifyProductConnectionRoutes(app: Express, dependencies: {
  service?: ShopifyProductConnectionService;
} = {}): void {
  const service = dependencies.service ?? createDefaultShopifyProductConnectionService();
  const base = "/api/products/:id/shopify-connection";
  app.get(base, requirePermission("inventory", "view"), requirePermission("channels", "view"), async (req, res) => {
    try {
      const productId = productIdSchema.parse(req.params.id);
      const channelId = req.query.channelId === undefined ? undefined : productIdSchema.parse(req.query.channelId);
      sendResult(res, shopifyProductConnectionContextSchema, await service.context(productId, channelId));
    } catch (error) { sendError(res, error); }
  });
  app.get(`${base}/commands/:commandKey`, requirePermission("inventory", "view"), requirePermission("channels", "view"), async (req, res) => {
    try { sendResult(res, shopifyProductConnectionCommandSchema, await service.status(productIdSchema.parse(req.params.id), commandKeySchema.parse(req.params.commandKey))); }
    catch (error) { sendError(res, error); }
  });
  app.post(`${base}/preview`, requirePermission("inventory", "edit"), requirePermission("channels", "edit"), async (req, res) => {
    try {
      actor(req);
      sendResult(res, shopifyProductConnectionPreviewSchema, await service.preview(productIdSchema.parse(req.params.id), shopifyProductConnectionRequestSchema.parse(req.body)));
    } catch (error) { sendError(res, error); }
  });
  app.post(`${base}/execute`, requirePermission("inventory", "edit"), requirePermission("channels", "edit"), async (req, res) => {
    try {
      const result = await service.submit(productIdSchema.parse(req.params.id), shopifyProductConnectionExecuteSchema.parse(req.body), actor(req));
      sendResult(res, shopifyProductConnectionResultSchema, result, result.command.state === "complete" ? 200 : 202);
    } catch (error) { sendError(res, error); }
  });
}
