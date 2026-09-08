import type { Express, Request, Response } from "express";
import { z } from "zod";
import { retryCostReportSchema } from "@shared/procurement/cost-report-delivery";
import { requirePermission } from "../../routes/middleware";
import { CostReportingError } from "./cost-reporting.domain";
import type { CostReportingService } from "./cost-reporting.service";

const purchaseId = z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647));
const deliveryId = z.string().uuid();
const intentKey = z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/);
export function registerCostReportingRoutes(app: Express, service: CostReportingService): void {
  function failure(error: unknown, res: Response): void {
    if (error instanceof z.ZodError) { res.status(400).json({code:"COST_REPORT_REQUEST_INVALID",error:"The reporting request is invalid."}); return; }
    if (error instanceof CostReportingError) { res.status(error.statusCode).json({code:error.code,error:error.message}); return; }
    console.error(JSON.stringify({event:"cost_reporting_request_failed",code:"COST_REPORT_DATABASE_UNAVAILABLE"}));
    res.status(503).json({code:"COST_REPORT_DATABASE_UNAVAILABLE",error:"Reporting status could not be saved or verified. Retry the same request safely."});
  }
  app.get("/api/purchase-orders/:purchaseOrderId/cost-reporting",requirePermission("inventory","view"),async (req,res) => {
    try { res.json(await service.status(purchaseId.parse(req.params.purchaseOrderId))); } catch (error) { failure(error,res); }
  });
  app.post("/api/purchase-orders/:purchaseOrderId/cost-reporting/:deliveryId/retry",requirePermission("purchasing","approve"),async (req,res) => {
    try {
      const actor = (req as Request & {user?: {id?:string}}).user?.id ?? req.session?.user?.id;
      if (!actor) { res.status(401).json({code:"COST_REPORT_ACTOR_REQUIRED",error:"Sign in before retrying report delivery."}); return; }
      const result = await service.retry({purchaseOrderId:purchaseId.parse(req.params.purchaseOrderId),deliveryId:deliveryId.parse(req.params.deliveryId),
        key:intentKey.parse(req.get("Idempotency-Key")),actor,command:retryCostReportSchema.parse(req.body)});
      res.setHeader("Idempotency-Replayed",String(result.replayed)); res.json(result);
    } catch (error) { failure(error,res); }
  });
}
