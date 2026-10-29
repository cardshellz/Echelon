import type { Express, Request, Response } from "express";
import { z } from "zod";
import { shipmentCostWorkflowIdSchema } from "@shared/procurement/shipment-cost-workflow";
import { ShipmentPhysicalValuesError } from "@shared/procurement/shipment-physical-values";
import { requirePermission } from "../../routes/middleware";
import { ShipmentTrackingError } from "./shipment-tracking.service";
import { ShipmentMeasurementCorrectionError } from "./shipment-measurement-correction.repository";
import type { createShipmentMeasurementCorrectionService } from "./shipment-measurement-correction.service";

export function registerShipmentMeasurementRoutes(app: Express, service: ReturnType<typeof createShipmentMeasurementCorrectionService>) {
  const id = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(shipmentCostWorkflowIdSchema);
  async function handle(req: Request, res: Response, action: "context" | "preview") {
    const parsed = id.safeParse(req.params.id);
    if (!parsed.success) return res.status(400).json({ code: "SHIPMENT_MEASUREMENTS_ID_INVALID", error: "Choose a valid shipment." });
    const actor = (req as Request & { user?: { id?: string } }).user?.id ?? req.session?.user?.id;
    if (!actor) return res.status(401).json({ code: "SHIPMENT_MEASUREMENTS_ACTOR_REQUIRED", error: "Sign in to review shipment measurements." });
    try {
      return res.json(action === "context" ? await service.context(parsed.data, actor) : await service.preview(parsed.data, req.body, actor));
    } catch (error) {
      if (error instanceof ShipmentMeasurementCorrectionError) return res.status(error.statusCode).json({ code: error.code, error: error.message });
      if (error instanceof ShipmentTrackingError || error instanceof ShipmentPhysicalValuesError)
        return res.status(error.statusCode).json({ code: error.details?.code, error: error.message });
      console.error(JSON.stringify({ event: "procurement.shipment.measurement_review_failed", shipmentId: parsed.data, actorId: actor,
        action, code: "SHIPMENT_MEASUREMENTS_UNAVAILABLE", errorType: error instanceof Error ? error.name : typeof error }));
      return res.status(503).json({ code: "SHIPMENT_MEASUREMENTS_UNAVAILABLE", error: "The complete measurement and cost review could not be loaded. Reload and try again." });
    }
  }
  app.get("/api/inbound-shipments/:id/measurements", requirePermission("purchasing", "view"), (req, res) => handle(req, res, "context"));
  app.post("/api/inbound-shipments/:id/measurements/preview", requirePermission("purchasing", "approve"), (req, res) => handle(req, res, "preview"));
}
