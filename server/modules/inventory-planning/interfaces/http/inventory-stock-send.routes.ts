import type { Express, Response } from "express";
import { ZodError } from "zod";
import { requirePermission } from "../../../../routes/middleware";
import { InventoryStockSendError, InventoryStockSendService } from "../../application/inventory-stock-send.service";
import { PostgresInventoryStockSendStore } from "../../infrastructure/inventory-stock-send.repository";
import { InventoryAvailabilityRuntimePublicationError } from "../../application/inventory-availability-runtime-publication.service";

const root = "/api/inventory-planning/admin/stock-send";
export function registerInventoryStockSendRoutes(app: Express,
  service: Pick<InventoryStockSendService, "context" | "review" | "send" | "progress"> = new InventoryStockSendService(new PostgresInventoryStockSendStore()),
): void {
  app.get(root + "/context", requirePermission("inventory_planning", "view"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      if (Object.keys(req.query).some(key => !["productId", "channelId"].includes(key)) || typeof req.query.productId !== "string"
        || req.query.channelId !== undefined && typeof req.query.channelId !== "string")
        throw new InventoryStockSendError("STOCK_SEND_REQUEST_INVALID", "Choose a product and Shopify channel.", 400);
      res.json(await service.context({ productId: Number(req.query.productId),
        ...(req.query.channelId === undefined ? {} : { channelId: Number(req.query.channelId) }) }));
    } catch (error) { sendError(res, error); }
  });
  app.post(root + "/review", requirePermission("inventory_planning", "view"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.review(req.body)); } catch (error) { sendError(res, error); }
  });
  app.post(root + "/send", requirePermission("inventory_planning", "activate"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { const result = await service.send(req.body, req.session?.user?.id); res.status(result.replayed ? 200 : 202).json(result); }
    catch (error) { sendError(res, error); }
  });
  app.get(root + "/commands/:commandKey", requirePermission("inventory_planning", "view"), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json(await service.progress(req.params.commandKey)); } catch (error) { sendError(res, error); }
  });
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof ZodError) {
    res.status(400).json({ error: { code: "STOCK_SEND_REQUEST_INVALID", message: "Choose a valid product, location and unique variant selection.", definitiveRejected: true } }); return;
  }
  if (error instanceof InventoryStockSendError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message, definitiveRejected: error.status < 500 } }); return;
  }
  if (error instanceof InventoryAvailabilityRuntimePublicationError) {
    res.status(409).json({ error: { code: error.code, message: error.message, definitiveRejected: true } }); return;
  }
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN";
  console.error(JSON.stringify({ event: "inventory_stock_send_failed", code: /^[A-Z0-9_]{1,100}$/.test(code) ? code : "UNKNOWN" }));
  res.status(503).json({ error: { code: "STOCK_SEND_UNCONFIRMED", message: "The stock-send result is not confirmed. Retry the same send to recover its result.", definitiveRejected: false } });
}
