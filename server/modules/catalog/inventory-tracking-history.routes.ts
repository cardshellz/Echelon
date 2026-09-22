import type { Express } from "express";
import { z } from "zod";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import { exportTrackingStopHistory, listTrackingStopHistory } from "../inventory/infrastructure/tracking-stop.repository";

const productIdSchema = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive().safe());
const historyIdSchema = z.string().regex(/^[1-9]\d{0,18}$/)
  .pipe(z.string().refine(id => BigInt(id) <= BigInt("9223372036854775807")));

export function registerInventoryTrackingHistoryRoutes(app: Express): void {
  app.get("/api/products/:id/inventory-tracking/history", requirePermission("inventory", "view"), async (req, res) => {
    const productId = productIdSchema.safeParse(req.params.id);
    const before = historyIdSchema.optional().safeParse(req.query.before);
    if (!productId.success || !before.success) return res.status(400).json({ code: "INVENTORY_TRACKING_HISTORY_INVALID", error: "Invalid history request" });
    try {
      res.setHeader("Cache-Control", "no-store");
      return res.json(await listTrackingStopHistory(db, productId.data, before.data));
    } catch (error) {
      console.error(JSON.stringify({ event: "inventory.tracking_history.read_failed", productId: productId.data,
        message: error instanceof Error ? error.message : "Unknown failure" }));
      return res.status(500).json({ code: "INVENTORY_TRACKING_HISTORY_FAILED", error: "Unable to load tracking history" });
    }
  });
  app.get("/api/products/:id/inventory-tracking/history/:historyId", requirePermission("inventory", "view"), async (req, res) => {
    const productId = productIdSchema.safeParse(req.params.id);
    const historyId = historyIdSchema.safeParse(req.params.historyId);
    if (!productId.success || !historyId.success) return res.status(400).json({ code: "INVENTORY_TRACKING_HISTORY_INVALID", error: "Invalid history request" });
    try {
      const document = await exportTrackingStopHistory(db, productId.data, historyId.data);
      if (document === null) return res.status(404).json({ code: "INVENTORY_TRACKING_HISTORY_MISSING", error: "Tracking history not found" });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Disposition", `attachment; filename="inventory-tracking-history-${historyId.data}.json"`);
      return res.type("application/json").send(document);
    } catch (error) {
      console.error(JSON.stringify({ event: "inventory.tracking_history.export_failed", productId: productId.data, historyId: historyId.data,
        message: error instanceof Error ? error.message : "Unknown failure" }));
      return res.status(500).json({ code: "INVENTORY_TRACKING_HISTORY_FAILED", error: "Unable to export tracking history" });
    }
  });
}
