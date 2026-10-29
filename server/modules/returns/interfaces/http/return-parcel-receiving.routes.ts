import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requirePermission } from "../../../../routes/middleware";
import { returnParcelReceiptInputSchema } from "@shared/returns/return-parcel-receiving.contract";
import { ReturnCaseOperationError } from "../../application/return-case-operations.service";
import { ReturnParcelReceivingService } from "../../application/return-parcel-receiving.service";
import { PostgresReturnParcelReceivingStore } from "../../infrastructure/return-parcel-receiving.repository";

export function registerReturnParcelReceivingRoutes(
  app: Express,
  service: Pick<
    ReturnParcelReceivingService,
    "lookup" | "receive"
  > = new ReturnParcelReceivingService(
    new PostgresReturnParcelReceivingStore(),
    () => new Date(),
  ),
): void {
  app.get(
    "/api/returns/admin/receiving/label",
    requirePermission("inventory", "view"),
    async (req, res) => {
      try {
        res.setHeader("Cache-Control", "private, no-store");
        return res.json(await service.lookup(req.query.trackingNumber));
      } catch (error) {
        return sendError(res, error);
      }
    },
  );
  app.post(
    "/api/returns/admin/receiving/parcels/:id/receipt",
    requirePermission("inventory", "adjust"),
    async (req: Request, res: Response) => {
      try {
        const actorId = req.session?.user?.id;
        if (actorId == null)
          return res.status(401).json({
            error: {
              code: "RETURN_CASE_ACTOR_REQUIRED",
              message: "Sign in before recording a receipt.",
            },
          });
        if (
          req.get("Origin") !== `${req.protocol}://${req.get("host")}` ||
          req.get("X-Return-Command") !== "1" ||
          !req.is("application/json")
        ) {
          return res.status(403).json({
            error: {
              code: "RETURN_PARCEL_COMMAND_FORBIDDEN",
              message: "Refresh receiving before continuing.",
            },
          });
        }
        const parcelId = z
          .string()
          .regex(/^[1-9]\d*$/)
          .transform(Number)
          .pipe(z.number().int().positive().safe())
          .parse(req.params.id);
        const input = returnParcelReceiptInputSchema.parse(req.body);
        const result = await service.receive(
          parcelId,
          input,
          `user:${actorId}`,
        );
        return res.status(result.replayed ? 200 : 201).json(result);
      } catch (error) {
        return sendError(res, error);
      }
    },
  );
}
function sendError(res: Response, error: unknown): Response {
  if (error instanceof ReturnCaseOperationError) {
    console.warn(
      JSON.stringify({
        event: "return_parcel_receipt_rejected",
        code: error.code,
        status: error.status,
      }),
    );
    return res
      .status(error.status)
      .json({ error: { code: error.code, message: error.message } });
  }
  if (error instanceof z.ZodError) {
    console.warn(
      JSON.stringify({
        event: "return_parcel_receipt_rejected",
        code: "RETURN_PARCEL_INPUT_INVALID",
        status: 400,
      }),
    );
    return res.status(400).json({
      error: {
        code: "RETURN_PARCEL_INPUT_INVALID",
        message: "Check the tracking number and received quantities.",
      },
    });
  }
  console.error(
    JSON.stringify({
      event: "return_parcel_receipt_failed",
      code: "RETURN_PARCEL_RECEIPT_UNAVAILABLE",
    }),
  );
  return res.status(503).json({
    error: {
      code: "RETURN_PARCEL_RECEIPT_UNAVAILABLE",
      message:
        "The receipt outcome could not be confirmed. Retry the same saved receipt.",
    },
  });
}
