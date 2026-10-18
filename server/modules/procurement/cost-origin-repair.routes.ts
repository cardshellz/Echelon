import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  originRepairId,
  originRepairPreviewRequestSchema,
  originRepairRequestSchema,
} from "@shared/procurement/cost-origin-repair";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { logger } from "../../platform/observability/logger";
import { CostEvidenceError } from "../inventory/infrastructure/cost-evidence.repository";
import { ApLedgerError } from "./ap-ledger.service";
import { OriginRepairError } from "./domain/cost-origin-repair";
import {
  createCostOriginRepairService,
  originRepairScope,
} from "./cost-origin-repair.service";

const pathId = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(originRepairId);
export function registerCostOriginRepairRoutes(
  app: Express,
  service = createCostOriginRepairService(db, () => new Date()),
) {
  const root = "/api/inventory-lots/:id/cost-origin-repair";
  const identity = (req: Request) => {
    if (!req.session.user?.id)
      throw new FinancialCommandError(
        "Sign in to review receipt costs.",
        401,
        "COST_ORIGIN_AUTH",
      );
    return { id: pathId.parse(req.params.id), actorId: req.session.user.id };
  };
  const failure = (error: unknown, req: Request, res: Response) => {
    const known =
      error instanceof OriginRepairError ||
      error instanceof FinancialCommandError ||
      error instanceof CostEvidenceError ||
      error instanceof ApLedgerError;
    const code =
      error instanceof z.ZodError
        ? "COST_ORIGIN_INPUT"
        : known && !(error instanceof ApLedgerError)
          ? error.code
          : "COST_ORIGIN_FAILED";
    logger.warn("procurement.cost_origin_repair", {
      lot_id: req.params.id,
      actor_id: req.session.user?.id,
      code,
      outcome: known ? "rejected" : "failed",
    });
    if (error instanceof FinancialCommandError)
      res.set(error.responseHeaders ?? {});
    return res
      .status(
        error instanceof z.ZodError
          ? 400
          : error instanceof CostEvidenceError
            ? 409
            : known
              ? error.statusCode
              : 500,
      )
      .json({
        code,
        error:
          error instanceof z.ZodError
            ? "Enter valid receipt units, supplier amounts and supporting reason."
            : known
              ? error.message
              : "The repair was not confirmed. Reload the saved result or retry the same approval.",
      });
  };
  app.get(root, requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const { id, actorId } = identity(req);
      res.json(await service.context(id, actorId));
    } catch (error) {
      failure(error, req, res);
    }
  });
  app.post(
    `${root}/preview`,
    requirePermission("purchasing", "approve"),
    async (req, res) => {
      try {
        const { id, actorId } = identity(req);
        res.json(
          await service.preview(
            id,
            originRepairPreviewRequestSchema.parse(req.body),
            actorId,
          ),
        );
      } catch (error) {
        failure(error, req, res);
      }
    },
  );
  app.post(
    root,
    requirePermission("purchasing", "approve"),
    async (req, res) => {
      try {
        const { id, actorId } = identity(req),
          input = originRepairRequestSchema.parse(req.body);
        const descriptor = financialCommandFromRequest(req, {
          actorId,
          ...originRepairScope(id),
        });
        const result = await service.approve(id, input, actorId, descriptor);
        logger.info("procurement.cost_origin_repair", {
          lot_id: id,
          actor_id: actorId,
          command_key: descriptor.idempotencyKey,
          http_status: result.httpStatus,
          replayed: result.replayed,
        });
        res.setHeader("Idempotency-Replayed", String(result.replayed));
        res.status(result.httpStatus).json(result.body);
      } catch (error) {
        failure(error, req, res);
      }
    },
  );
}
