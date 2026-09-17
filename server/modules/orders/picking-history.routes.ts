import type { Express } from "express";
import { db } from "../../db";
import { requireAuth } from "../../routes/middleware";
import { limitPageRead } from "../../platform/http/page-read-limit";
import { PickingHistoryRepository, pickingHistoryQuerySchema } from "./picking-history.repository";

export function registerPickingHistoryRoutes(
  app: Express,
  repository: Pick<PickingHistoryRepository, "page"> = new PickingHistoryRepository(db),
) {
  app.get("/api/picking/history", requireAuth, limitPageRead(async (req, res) => {
    const parsed = pickingHistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ code: "INVALID_PICKING_HISTORY_QUERY", error: "Invalid picking history filters or page size" });
    res.set("Cache-Control", "private, no-store");
    try {
      // The repository validates independently for non-HTTP callers, too.
      return res.json(await repository.page(parsed.data));
    } catch (error) {
      console.error("Picking history read failed", { code: "PICKING_HISTORY_READ_FAILED", error });
      return res.status(500).json({ code: "PICKING_HISTORY_READ_FAILED", error: "Failed to load picking history. Please retry." });
    }
  }));
}
