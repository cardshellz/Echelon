import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  quantityCorrectionId,
  quantityCorrectionInputSchema,
  quantityCorrectionApprovalSchema,
} from "@shared/procurement/receipt-shipment-quantity-correction";
import { requirePermission } from "../../routes/middleware";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { logger } from "../../platform/observability/logger";
import { CostEvidenceError } from "../inventory/infrastructure/cost-evidence.repository";
import { ShipmentTrackingError } from "./shipment-tracking.service";
import { QuantityCorrectionError } from "./domain/receipt-shipment-quantity-correction";
import {
  quantityCorrectionScope,
  type createReceiptShipmentQuantityCorrectionService,
} from "./receipt-shipment-quantity-correction.service";

const pathId = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(quantityCorrectionId);
type Service = ReturnType<
  typeof createReceiptShipmentQuantityCorrectionService
>;
export function registerReceiptShipmentQuantityCorrectionRoutes(
  app: Express,
  service: Service,
) {
  const root = "/api/shipment-lines/:id/quantity-correction";
  const identity = (req: Request) => {
    if (!req.session.user?.id)
      throw new FinancialCommandError(
        "Sign in to review quantities.",
        401,
        "QUANTITY_CORRECTION_AUTH",
      );
    return { id: pathId.parse(req.params.id), actorId: req.session.user.id };
  };
  const failure = (error: unknown, req: Request, res: Response) => {
    const known =
      error instanceof QuantityCorrectionError ||
      error instanceof FinancialCommandError ||
      error instanceof CostEvidenceError ||
      error instanceof ShipmentTrackingError;
    const code =
      error instanceof z.ZodError
        ? "QUANTITY_CORRECTION_INPUT"
        : error instanceof ShipmentTrackingError
          ? String(error.details?.code ?? "QUANTITY_CORRECTION_COST")
          : error instanceof QuantityCorrectionError ||
              error instanceof FinancialCommandError ||
              error instanceof CostEvidenceError
            ? error.code
            : "QUANTITY_CORRECTION_FAILED";
    const log =
      known || error instanceof z.ZodError ? logger.warn : logger.error;
    log("procurement.receipt_shipment_quantity_correction", {
      resource_id: req.params.id,
      actor_id: req.session.user?.id,
      code,
      outcome: known ? "rejected" : "failed",
      error_class: error instanceof Error ? error.name : typeof error,
      // Database exceptions may contain source values or connection details.
      // Keep the diagnostic code and request context without logging that text.
      error_code:
        error && typeof error === "object" && "code" in error &&
        typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)
          ? error.code : undefined,
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
            ? "Enter whole piece quantities, confirm the source documents and provide a reason."
            : known
              ? error.message
              : "The correction was not confirmed. Reload the saved result or retry the same approval.",
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
  app.get(
    "/api/receiving-lines/:id/quantity-correction",
    requirePermission("purchasing", "view"),
    async (req, res) => {
      try {
        const { id, actorId } = identity(req);
        res.json(await service.receiptContext(id, actorId));
      } catch (error) {
        failure(error, req, res);
      }
    },
  );
  app.get(
    "/api/purchase-orders/:id/quantity-corrections",
    requirePermission("purchasing", "view"),
    async (req, res) => {
      try {
        const { id } = identity(req);
        res.json(await service.options(id));
      } catch (error) {
        failure(error, req, res);
      }
    },
  );
  app.post(
    `${root}/preview`,
    requirePermission("purchasing", "approve"),
    async (req, res) => {
      try {
        const { id, actorId } = identity(req);
        res.json(
          await service.preview(
            id,
            quantityCorrectionInputSchema.parse(req.body),
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
          input = quantityCorrectionApprovalSchema.parse(req.body);
        const descriptor = financialCommandFromRequest(req, {
          actorId,
          ...quantityCorrectionScope(id),
        });
        const result = await service.approve(id, input, actorId, descriptor);
        logger.info("procurement.receipt_shipment_quantity_correction", {
          shipment_line_id: id,
          actor_id: actorId,
          command_key: descriptor.idempotencyKey,
          replayed: result.replayed,
          http_status: result.httpStatus,
        });
        res.setHeader("Idempotency-Replayed", String(result.replayed));
        res.status(result.httpStatus).json(result.body);
      } catch (error) {
        failure(error, req, res);
      }
    },
  );
}
