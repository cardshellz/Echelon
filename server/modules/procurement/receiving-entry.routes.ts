import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../../routes/middleware";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { logger } from "../../platform/observability";
import { createReceivingEntryCommands, hashReceivingEntryCommandIdentity, receivingEntryCommandScope, RECEIVING_ENTRY_COMMAND_PRINCIPAL } from "./receiving-entry.commands";

const orderId = z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647));

function sendEntryError(res: Response, error: unknown, actorId: string | null): Response {
  if (error instanceof FinancialCommandError) {
    if (error.statusCode >= 500) logger.error("procurement.receiving_entry.request_failed", { actorId, error_code: error.code });
    for (const [name, value] of Object.entries(error.responseHeaders ?? {})) res.setHeader(name, value);
    return res.status(error.statusCode).json({ error: error.message, code: error.code, details: error.details });
  }
  logger.error("procurement.receiving_entry.request_failed", {
    actorId, error_code: "RECEIVING_ENTRY_UNAVAILABLE", error_type: error instanceof Error ? error.name : "unknown",
  });
  return res.status(503).json({ code: "RECEIVING_ENTRY_UNAVAILABLE",
    error: "The receiving entry result is not confirmed. Retry the saved request with the same command key." });
}

export function registerReceivingEntryRoutes(app: Express): void {
  for (const route of [{ action: "create", path: "/api/receiving" }, { action: "add-line", path: "/api/receiving/:orderId/lines" }] as const) {
    app.post(route.path, requireAuth, requirePermission("inventory", "adjust"), async (req: Request, res: Response) => {
      let actorId: string | null = null;
      try {
        actorId = req.session?.user?.id ?? null;
        if (!actorId || actorId !== actorId.trim() || actorId.length > 100) {
          throw new FinancialCommandError("An authenticated receiving operator is required", 401, "RECEIVING_ENTRY_ACTOR_REQUIRED");
        }
        const target = route.action === "add-line" ? orderId.safeParse(req.params.orderId) : null;
        if (target && !target.success) throw new FinancialCommandError("The receiving order ID must be a positive PostgreSQL integer", 400, "RECEIVING_ENTRY_TARGET_INVALID");
        if (Object.keys(req.query).length > 0) throw new FinancialCommandError("Receiving entry does not accept query parameters", 400, "RECEIVING_ENTRY_QUERY_INVALID");
        const command = { action: route.action, targetId: target?.success ? target.data : null, payload: req.body };
        const descriptor = financialCommandFromRequest(req, { ...receivingEntryCommandScope(), actorType: "service", actorId: RECEIVING_ENTRY_COMMAND_PRINCIPAL });
        const result = await createReceivingEntryCommands(req.app.locals.services.receiving).execute(command, actorId, {
          ...descriptor, requestHash: hashReceivingEntryCommandIdentity(command, actorId),
        });
        res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
        return res.status(result.httpStatus).json(result.body);
      } catch (error) {
        return sendEntryError(res, error, actorId);
      }
    });
  }
}
