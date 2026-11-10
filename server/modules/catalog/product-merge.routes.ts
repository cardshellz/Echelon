import type { Express, Request, Response } from "express";
import { productMergePreviewSchema, productMergeRunSchema } from "@shared/catalog/product-merge";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { ProductMergeError, ProductMergeService } from "./application/product-merge.service";
import { PostgresProductMergeRepository } from "./infrastructure/product-merge.repository";

/**
 * HTTP interface for the product merge. Routes parse, authorize and translate
 * errors only; every decision lives in ProductMergeService and its domain.
 *
 *   POST /api/products/:id/merge/preview   read-only plan + previewHash
 *   POST /api/products/:id/merge           start a run (Idempotency-Key required)
 *   GET  /api/product-merges/:runId        run status
 *   POST /api/product-merges/:runId/resume continue after a transient failure
 */

/** Same permission as the existing variant merge: this moves stock and orders. */
const MERGE_PERMISSION = ["inventory", "update"] as const;

const structuredLogger = {
  info: (event: Record<string, unknown>) => console.log(JSON.stringify(event)),
  warn: (event: Record<string, unknown>) => console.warn(JSON.stringify(event)),
  error: (event: Record<string, unknown>) => console.error(JSON.stringify(event)),
};

export function createProductMergeService(reservation: unknown, inventoryCore: unknown): ProductMergeService {
  const reservations = reservation as {
    releaseOrderReservation(orderId: number, reason: string, userId?: string): Promise<{ released: number }>;
    reserveOrder(orderId: number, userId?: string): Promise<{ failed: unknown[] }>;
  };
  return new ProductMergeService(
    new PostgresProductMergeRepository(db, inventoryCore as never, error => structuredLogger.error({
      level: "error", action: "product_merge.post_commit_effect_failed", outcome: "failed",
      error_code: "MERGE_EFFECT_FAILED", message: error instanceof Error ? error.message : String(error),
    })),
    {
      async release(wmsOrderId, reason, actor) {
        const result = await reservations.releaseOrderReservation(wmsOrderId, reason, actor);
        return { releasedLines: result.released };
      },
      async reclaim(wmsOrderId, _reason, actor) {
        const result = await reservations.reserveOrder(wmsOrderId, actor);
        return { failedLines: result.failed.length };
      },
    },
    () => new Date(),
    structuredLogger,
  );
}

function positiveId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function sendError(res: Response, error: unknown): Response {
  if (error instanceof ProductMergeError) {
    return res.status(error.statusCode).json({ error: error.message, code: error.code, context: error.context });
  }
  if (error instanceof FinancialCommandError) {
    return res.status(error.statusCode).json({ error: error.message, code: error.code });
  }
  console.error(JSON.stringify({ level: "error", action: "product_merge.request_failed", outcome: "failed",
    error_code: "PRODUCT_MERGE_FAILED", message: error instanceof Error ? error.message : "Unknown failure" }));
  return res.status(500).json({ error: "The merge request failed. Open the merge run to see its state, then resume.",
    code: "PRODUCT_MERGE_FAILED" });
}

function serviceFor(req: Request, override?: ProductMergeService): ProductMergeService {
  if (override) return override;
  const services = req.app.locals.services as { reservation: unknown; inventoryCore: unknown };
  return createProductMergeService(services.reservation, services.inventoryCore);
}

export function registerProductMergeRoutes(app: Express, override?: ProductMergeService): void {
  app.post("/api/products/:id/merge/preview", requirePermission(...MERGE_PERMISSION), async (req, res) => {
    try {
      const sourceProductId = positiveId(req.params.id);
      if (!sourceProductId) return res.status(400).json({ error: "Invalid product id", code: "MERGE_INVALID_REQUEST" });
      const preview = await serviceFor(req, override).preview(sourceProductId, req.body);
      res.setHeader("Cache-Control", "no-store");
      return res.json(productMergePreviewSchema.parse(preview));
    } catch (error) { return sendError(res, error); }
  });

  app.post("/api/products/:id/merge", requirePermission(...MERGE_PERMISSION), async (req, res) => {
    try {
      const sourceProductId = positiveId(req.params.id);
      if (!sourceProductId) return res.status(400).json({ error: "Invalid product id", code: "MERGE_INVALID_REQUEST" });
      const descriptor = financialCommandFromRequest(req, { routeTemplate: "/api/products/:id/merge",
        resourceKey: `product:${sourceProductId}`, commandName: "catalog.product.merge" });
      const run = await serviceFor(req, override).execute(sourceProductId, req.body, descriptor.idempotencyKey,
        `${descriptor.actorType}:${descriptor.actorId}`);
      res.setHeader("Cache-Control", "no-store");
      return res.json(productMergeRunSchema.parse(run));
    } catch (error) { return sendError(res, error); }
  });

  app.get("/api/product-merges/:runId", requirePermission(...MERGE_PERMISSION), async (req, res) => {
    try {
      const runId = positiveId(req.params.runId);
      if (!runId) return res.status(400).json({ error: "Invalid merge run id", code: "MERGE_INVALID_REQUEST" });
      res.setHeader("Cache-Control", "no-store");
      return res.json(productMergeRunSchema.parse(await serviceFor(req, override).getRun(runId)));
    } catch (error) { return sendError(res, error); }
  });

  app.post("/api/product-merges/:runId/resume", requirePermission(...MERGE_PERMISSION), async (req, res) => {
    try {
      const runId = positiveId(req.params.runId);
      if (!runId) return res.status(400).json({ error: "Invalid merge run id", code: "MERGE_INVALID_REQUEST" });
      res.setHeader("Cache-Control", "no-store");
      return res.json(productMergeRunSchema.parse(await serviceFor(req, override).resume(runId)));
    } catch (error) { return sendError(res, error); }
  });
}
