import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../../routes/middleware";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { logger } from "../../platform/observability";
import {
  createReceiptReversalCommands, hashReceiptReversalCommandIdentity,
  receiptReversalCommandScope, RECEIPT_REVERSAL_COMMAND_PRINCIPAL,
} from "./receipt-reversal.commands";

const resourceIdSchema = z.string().regex(/^[1-9][0-9]*$/).transform(Number)
  .pipe(z.number().int().positive().max(2_147_483_647));
const actorIdSchema = z.string().min(1).refine(value => value.trim().length > 0);
type ReversalAction = "line" | "order";

function authenticatedActor(req: Request): string {
  // Use the same session identity checked by requireAuth/requirePermission.
  const actor = actorIdSchema.safeParse(req.session?.user?.id);
  if (!actor.success) throw new FinancialCommandError(
    "An authenticated operator is required to reverse a receipt.", 401, "RECEIPT_REVERSAL_ACTOR_REQUIRED",
  );
  return actor.data;
}

function sendReversalError(res: Response, error: unknown, context: {
  action: ReversalAction; targetId: string; actorId: string | null;
}): Response {
  if (error instanceof FinancialCommandError) {
    if (error.statusCode >= 500) logger.error("procurement.receipt_reversal.request_failed", {
      ...context, error_code: error.code, error_type: error.name,
    });
    for (const [name, value] of Object.entries(error.responseHeaders ?? {})) res.setHeader(name, value);
    return res.status(error.statusCode).json({ error: error.message, code: error.code, details: error.details });
  }
  logger.error("procurement.receipt_reversal.request_failed", {
    ...context, error_code: "RECEIPT_REVERSAL_UNAVAILABLE", error_type: error instanceof Error ? error.name : "unknown",
  });
  return res.status(503).json({
    error: "The reversal result is not confirmed. Retry the saved request with the same command key.",
    code: "RECEIPT_REVERSAL_UNAVAILABLE",
  });
}

/** Both endpoints share one durable key namespace; the identity includes action,
 * target, operator and the unchanged body, preventing cross-receipt key reuse. */
export function registerReceiptReversalRoutes(app: Express): void {
  const routes = [
    { action: "line", path: "/api/procurement/receiving-lines/:id/reverse" },
    { action: "order", path: "/api/procurement/receiving-orders/:id/reverse" },
  ] as const;
  for (const { action, path } of routes) {
    app.post(path, requireAuth, requirePermission("purchasing", "approve"), async (req, res) => {
      let actorId: string | null = null;
      try {
        actorId = authenticatedActor(req);
        const target = resourceIdSchema.safeParse(req.params.id);
        if (!target.success) throw new FinancialCommandError(
          "The receipt resource ID must be a positive PostgreSQL integer.", 400, "RECEIPT_REVERSAL_ID_INVALID",
        );
        if (Object.keys(req.query).length !== 0) throw new FinancialCommandError(
          "Receipt reversals do not accept query parameters.", 400, "RECEIPT_REVERSAL_QUERY_INVALID",
        );
        const scope = receiptReversalCommandScope();
        const descriptor = financialCommandFromRequest(req, {
          ...scope, actorType: "service", actorId: RECEIPT_REVERSAL_COMMAND_PRINCIPAL,
        });
        const commands = createReceiptReversalCommands(req.app.locals.services.receiptReversal);
        const result = await commands.execute(action, target.data, req.body, actorId, {
          ...descriptor,
          requestHash: hashReceiptReversalCommandIdentity({ action, targetId: target.data, body: req.body, actorId }),
        });
        res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
        return res.status(result.httpStatus).json(result.body);
      } catch (error) {
        return sendReversalError(res, error, { action, targetId: req.params.id, actorId });
      }
    });
  }
}
