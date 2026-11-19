import type { Express, Response } from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../../routes/middleware";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { logger } from "../../platform/observability";
import { createPurchaseOrderEntryCommands, hashPurchaseOrderEntryCommandIdentity, purchaseOrderEntryCommandScope, PURCHASE_ORDER_ENTRY_COMMAND_PRINCIPAL } from "./purchase-order-entry.commands";
import { purchaseOrderEntryPermission, PurchaseOrderEntryError } from "./domain/purchase-order-entry";

const targetId = z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647));
function sendEntryError(res: Response, error: unknown, actorId: string | null): Response {
  if (error instanceof FinancialCommandError || error instanceof PurchaseOrderEntryError) {
    if (error instanceof FinancialCommandError) {
      for (const [name, value] of Object.entries(error.responseHeaders ?? {})) res.setHeader(name, value);
    }
    if (error.statusCode >= 500) logger.error("procurement.purchase_order_entry.request_failed", { actorId, error_code: error.code });
    return res.status(error.statusCode).json({ error: error.message, code: error.code,
      details: { code: error.code, ...(error instanceof FinancialCommandError ? error.details : {}) } });
  }
  logger.error("procurement.purchase_order_entry.request_failed", { actorId, error_code: "PURCHASE_ORDER_ENTRY_UNAVAILABLE",
    error_type: error instanceof Error ? error.name : "unknown" });
  return res.status(503).json({ code: "PURCHASE_ORDER_ENTRY_UNAVAILABLE",
    error: "The purchase order result is not confirmed. Retry the saved request with the same command key." });
}

export function registerPurchaseOrderEntryRoutes(app: Express): void {
  const routes = [
    { method: "post", path: "/api/purchase-orders", action: "create" },
    { method: "put", path: "/api/purchase-orders/:id/draft", action: "save-draft" },
    { method: "post", path: "/api/purchase-orders/:id/duplicate", action: "duplicate" },
    { method: "post", path: "/api/purchase-orders/:id/send-to-vendor", action: "prepare" },
    { method: "post", path: "/api/purchase-orders/:id/send-pdf", action: "prepare-document" },
  ] as const;
  for (const route of routes) {
    app[route.method](route.path, requireAuth, requirePermission("purchasing", purchaseOrderEntryPermission(route.action)), async (req, res) => {
      let actorId: string | null = null;
      try {
        actorId = req.session.user?.id ?? null;
        if (!actorId) throw new FinancialCommandError("An authenticated purchasing operator is required", 401, "PURCHASE_ORDER_ENTRY_ACTOR_REQUIRED");
        const target = route.action === "create" ? null : targetId.safeParse(req.params.id);
        if (target && !target.success) throw new FinancialCommandError("Purchase order ID must be a positive integer", 400, "PURCHASE_ORDER_ENTRY_TARGET_INVALID");
        if (Object.keys(req.query).length) throw new FinancialCommandError("Purchase order commands do not accept query parameters", 400, "PURCHASE_ORDER_ENTRY_QUERY_INVALID");
        const command = { action: route.action, targetId: target?.success ? target.data : null, payload: req.body === undefined ? {} : req.body };
        const descriptor = financialCommandFromRequest(req, { ...purchaseOrderEntryCommandScope(), actorType: "service", actorId: PURCHASE_ORDER_ENTRY_COMMAND_PRINCIPAL });
        const result = await createPurchaseOrderEntryCommands(app.locals.services.purchasing).execute(command, actorId,
          // All five transports share one intent namespace, including PUT
          // draft saves. The action in the hashed body identifies the write.
          { ...descriptor, ...purchaseOrderEntryCommandScope(), requestHash: hashPurchaseOrderEntryCommandIdentity(command, actorId) });
        res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
        return res.status(result.httpStatus).json(result.body);
      } catch (error) { return sendEntryError(res, error, actorId); }
    });
  }
}
