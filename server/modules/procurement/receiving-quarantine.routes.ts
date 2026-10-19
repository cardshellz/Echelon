import type { Express, Request, Response } from "express";
import { z } from "zod";
import { db } from "../../db";
import { requireAuth } from "../../routes/middleware";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { logger } from "../../platform/observability";
import { ReceivingQuarantineError } from "./domain/receiving-quarantine";
import { createReceivingCustodyCommands, custodyCommandScope, custodyCommandRoute, CUSTODY_COMMAND_PRINCIPAL, hashCustodyCommandIdentity } from "./receiving-quarantine.commands";
import { readReceivingQuarantineView, type ReceivingCustodyCommand } from "./receiving-quarantine.service";
import { custodyOptionsQuerySchema, readQuarantineAcceptanceOptions } from "./receiving-quarantine-options.repository";

const resourceIdSchema = z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647));
function requestId(value: unknown): number {
  const parsed = resourceIdSchema.safeParse(value);
  if (!parsed.success) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_INPUT_INVALID", "Invalid quarantine resource ID.", 400);
  return parsed.data;
}
function requestActor(req: Request): string {
  const authenticated = req as Request & { user?: { id?: string }; session?: { user?: { id?: string } } };
  const parsed = z.string().min(1).safeParse(authenticated.user?.id ?? authenticated.session?.user?.id);
  if (!parsed.success) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_ACTOR_REQUIRED", "An authenticated actor is required.", 401);
  return parsed.data;
}
function sendCustodyError(res: Response, error: unknown) {
  if (error instanceof FinancialCommandError) {
    for (const [name, value] of Object.entries(error.responseHeaders ?? {})) res.setHeader(name, value);
    return res.status(error.statusCode).json({ error: error.message, code: error.code, details: error.details });
  }
  if (error instanceof ReceivingQuarantineError) return res.status(error.statusCode).json({ error: error.message, code: error.code, details: error.details });
  if (error instanceof z.ZodError) {
    logger.error("receiving.custody.evidence_invalid", { error_code: "RECEIVING_CUSTODY_EVIDENCE_INVALID",
      issues: error.issues.map(issue => ({ code: issue.code, path: issue.path.join(".") })) });
    return res.status(409).json({ error: "Stored quarantine evidence is invalid. Review its source records.", code: "RECEIVING_CUSTODY_EVIDENCE_INVALID" });
  }
  logger.error("receiving.custody.request_failed", { error_code: "RECEIVING_CUSTODY_UNAVAILABLE", error_type: error instanceof Error ? error.name : "unknown" });
  return res.status(503).json({ error: "Quarantine is temporarily unavailable. Retry the same action without changing its command key.", code: "RECEIVING_CUSTODY_UNAVAILABLE" });
}
export function registerReceivingQuarantineRoutes(app: Express): void {
  app.get("/api/receiving/:orderId/quarantine", requireAuth, async (req, res) => {
    try {
      const id = requestId(req.params.orderId);
      const actorId = requestActor(req);
      const result = await db.transaction(tx => readReceivingQuarantineView(tx, id, actorId), { isolationLevel: "repeatable read" });
      return res.json(result);
    } catch (error) { return sendCustodyError(res, error); }
  });
  app.get("/api/receiving/:orderId/quarantine/acceptance-options", requireAuth, async (req, res) => {
    try {
      const id = requestId(req.params.orderId);
      const actorId = requestActor(req);
      const query = custodyOptionsQuerySchema.safeParse(req.query);
      if (!query.success) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_INPUT_INVALID", "Invalid quarantine source search.", 400);
      return res.json(await db.transaction(tx => readQuarantineAcceptanceOptions(tx, id, actorId, query.data), { isolationLevel: "repeatable read" }));
    } catch (error) { return sendCustodyError(res, error); }
  });
  for (const command of ["intake", "prepare-acceptance", "return", "cancel-acceptance"] as const satisfies readonly ReceivingCustodyCommand[]) {
    const route = custodyCommandRoute(command);
    app.post(route, requireAuth, async (req, res) => {
      try {
        const id = requestId(command === "intake" ? req.params.orderId : req.params.observationId);
        const actorId = requestActor(req);
        if (Object.keys(req.query).length) throw new ReceivingQuarantineError("RECEIVING_CUSTODY_INPUT_INVALID", "Quarantine commands do not accept query parameters.", 400);
        const original = financialCommandFromRequest(req, { ...custodyCommandScope(), actorType: "service", actorId: CUSTODY_COMMAND_PRINCIPAL });
        const descriptor = { ...original, requestHash: hashCustodyCommandIdentity({ command, resourceId: id, body: req.body, actorId }) };
        const commands = createReceivingCustodyCommands(req.app.locals.services.receiving);
        const result = await commands.execute(command, id, req.body, actorId, descriptor);
        res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
        return res.status(result.httpStatus).json(result.body);
      } catch (error) { return sendCustodyError(res, error); }
    });
  }
}
