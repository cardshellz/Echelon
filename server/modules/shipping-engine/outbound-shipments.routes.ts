import type { Express, Response } from "express";
import { limitPageRead } from "../../platform/http/page-read-limit";
import { requirePermission } from "../../routes/middleware";
import { queryShipmentOrderContext, ShipmentAccessError } from "../shipping/outbound-shipment-access.query";
import { queryOutboundShipments } from "../shipping/outbound-shipment-list.query";
import { logger } from "../../platform/observability/logger";

export function registerOutboundShipmentRoutes(app: Express): void {
  app.get("/api/outbound-shipments/:id/order-context", requirePermission("shipments", "view_order_context"), limitPageRead(async (req,res) => {
    const id = Number(req.params.id);
    if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(id)) return res.status(400).json({ error: { code: "SHIPMENT_ID_INVALID" } });
    try { return res.json(await queryShipmentOrderContext(req.session.user!.id,id)); }
    catch (error) { return sendError(res,error); }
  }));
  app.get("/api/outbound-shipments", requirePermission("shipments", "view"), limitPageRead(async (req,res) => {
    try { return res.json(await queryOutboundShipments(req.session.user!.id,req.query)); }
    catch (error) { return sendError(res,error); }
  }));
}
function sendError(res: Response,error: unknown): Response {
  if (error instanceof ShipmentAccessError) return res.status(error.status).json({ error: { code: error.code,message: error.message } });
  logger.error("shipping.shipments.query", { module: "shipping",outcome: "failed",error_code: "OUTBOUND_SHIPMENTS_INTERNAL_ERROR" });
  return res.status(500).json({ error: { code: "OUTBOUND_SHIPMENTS_INTERNAL_ERROR",message: "Shipment data could not be loaded." } });
}
