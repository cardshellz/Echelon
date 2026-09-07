import type { Express, Request, Response } from "express";
import { z } from "zod";
import { rfqResourceIdSchema } from "@shared/procurement/rfq-workflow";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { createRfqWorkflowService, RfqWorkflowError, type RfqWorkflowCommand } from "./rfq-workflow.service";
import { createRfqWorkflowCommands, RFQ_WORKFLOW_COMMAND_PRINCIPAL, rfqWorkflowCommandScope } from "./rfq-workflow.commands";

const pathId = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(rfqResourceIdSchema);
function actor(req: Request): string | undefined { return (req as Request & { user?: { id?: string } }).user?.id ?? req.session?.user?.id; }

export function registerRfqWorkflowRoutes(app: Express): void {
  const service = createRfqWorkflowService(db, app.locals.services.purchasing);
  const commands = createRfqWorkflowCommands(service);

  function failure(error: unknown, req: Request, res: Response): Response {
    if (error instanceof FinancialCommandError) {
      for (const [name, value] of Object.entries(error.responseHeaders ?? {})) res.setHeader(name, value);
      return res.status(error.statusCode).json({ code: error.code, error: error.message });
    }
    if (error instanceof RfqWorkflowError && error.statusCode < 500) return res.status(error.statusCode).json({ code: error.code, error: error.message });
    if (error instanceof z.ZodError) return res.status(400).json({ code: "RFQ_REQUEST_INVALID", error: "The RFQ request is invalid." });
    console.error(JSON.stringify({ event: "procurement.rfq.workflow_failed", actorId: actor(req) ?? null, rfqId: req.params.rfqId, errorType: error instanceof Error ? error.name : typeof error, code: "RFQ_TRANSIENT_FAILURE" }));
    return res.status(500).json({ code: "RFQ_TRANSIENT_FAILURE", error: "RFQ workflow failed. Retry the same command without changing its key." });
  }

  async function execute(req: Request, res: Response, operation: RfqWorkflowCommand["operation"]): Promise<Response> {
    try {
      const rfqId = pathId.parse(req.params.rfqId);
      const actorId = actor(req);
      if (!actorId) throw new FinancialCommandError("An authenticated actor is required", 401, "RFQ_ACTOR_REQUIRED");
      const command: RfqWorkflowCommand = operation === "capture_quote"
        ? { operation, rfqId, lineId: pathId.parse(req.params.lineId), body: req.body }
        : { operation, rfqId, body: req.body };
      const descriptor = financialCommandFromRequest(req, { actorType: "service", actorId: RFQ_WORKFLOW_COMMAND_PRINCIPAL, ...rfqWorkflowCommandScope(command) });
      const result = await commands.execute(command, actorId, descriptor);
      res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
      return res.status(result.httpStatus).json(result.body);
    } catch (error) { return failure(error, req, res); }
  }

  app.get("/api/purchasing/rfqs/:rfqId", requirePermission("inventory", "view"), async (req, res) => {
    try { res.json(await service.getDetail(pathId.parse(req.params.rfqId))); } catch (error) { failure(error, req, res); }
  });
  app.get("/api/purchasing/rfqs/:rfqId/lines/:lineId/quotes", requirePermission("inventory", "view"), async (req, res) => {
    try { res.json(await service.getQuoteHistory(pathId.parse(req.params.rfqId), pathId.parse(req.params.lineId), req.query.beforeRevision === undefined ? null : pathId.parse(req.query.beforeRevision))); } catch (error) { failure(error, req, res); }
  });
  app.post("/api/purchasing/rfqs/:rfqId/lines/:lineId/quotes", requirePermission("purchasing", "edit"), (req, res) => execute(req, res, "capture_quote"));
  app.post("/api/purchasing/rfqs/:rfqId/convert", requirePermission("purchasing", "edit"), (req, res) => execute(req, res, "convert"));
}
