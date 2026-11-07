import type { Express, Response } from "express";

import { requirePermission } from "../../../../routes/middleware";
import { SalesStatusService } from "../../application/inventory-sales-status.service";
import { SalesStatusError } from "../../domain/inventory-sales-status";
import { PostgresSalesStatusStore } from "../../infrastructure/inventory-sales-status.repository";

/**
 * All-channels sales status (shared/types/inventory-sales-status.ts). Reads need
 * inventory planning view; a change publishes stock, so it needs activate,
 * like applying a channel rule. Routes only orchestrate: the service validates
 * and the store decides.
 */
export const SALES_STATUS_API_BASE = "/api/inventory-planning/admin/sales-status";

export function registerSalesStatusRoutes(
  app: Express,
  service: Pick<SalesStatusService, "change" | "readProduct" | "list"> = new SalesStatusService(new PostgresSalesStatusStore()),
): void {
  app.get(`${SALES_STATUS_API_BASE}/products/:productId`, requirePermission("inventory_planning", "view"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(await service.readProduct(req.params.productId));
    } catch (error) {
      sendSalesStatusError(res, error);
    }
  });
  app.get(`${SALES_STATUS_API_BASE}/entries`, requirePermission("inventory_planning", "view"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(await service.list(req.query));
    } catch (error) {
      sendSalesStatusError(res, error);
    }
  });
  app.post(`${SALES_STATUS_API_BASE}/changes`, requirePermission("inventory_planning", "activate"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(await service.change(req.body, req.session?.user?.id));
    } catch (error) {
      sendSalesStatusError(res, error);
    }
  });
}

/**
 * Structured errors: `retryable` is true only for a transient refusal, where
 * the same change (same idempotency key) may simply be sent again. Anything
 * unrecognized is reported as unconfirmed rather than as a rejection, because
 * it may have happened after the commit.
 */
export function sendSalesStatusError(res: Response, error: unknown): void {
  if (error instanceof SalesStatusError) {
    if (error.status >= 500) {
      console.error(JSON.stringify({ level: "error", event: "sales_status_request_failed", action: "sales_status",
        outcome: "failed", error_code: error.code, classification: error.classification }));
    }
    res.status(error.status).json({ error: {
      code: error.code,
      message: error.message,
      retryable: error.classification === "transient",
      details: errorDetails(error.context),
    } });
    return;
  }
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "UNKNOWN";
  console.error(JSON.stringify({ level: "error", event: "sales_status_request_failed", action: "sales_status",
    outcome: "unconfirmed", error_code: /^[A-Z0-9_]{1,100}$/.test(code) ? code : "UNKNOWN" }));
  res.status(500).json({ error: {
    code: "SALES_STATUS_UNCONFIRMED",
    message: "The result is not confirmed. Retry the same change to read it.",
    retryable: true,
    details: [],
  } });
}

/** Operator-safe detail lines: validation issues, or the scopes that changed first. */
function errorDetails(context: Readonly<Record<string, unknown>>): string[] {
  if (Array.isArray(context.issues)) return context.issues.map(String);
  if (Array.isArray(context.conflicts)) {
    return context.conflicts.map((conflict) => String((conflict as { scopeKey?: unknown }).scopeKey));
  }
  return [];
}
