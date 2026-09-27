import type { Express, Response, RequestHandler } from "express";
import { historyReviewSchema, historyRetirementResultSchema } from "@shared/types/inventory-cutover-history";
import { pool } from "../../../../db";
import { requirePermission } from "../../../../routes/middleware";
import { InventoryCutoverHistoryService } from "../../application/inventory-cutover-history.service";
import { CutoverHistoryError } from "../../domain/inventory-cutover-history-retirement";
import { PostgresInventoryCutoverHistoryRepository } from "../../infrastructure/inventory-cutover-history.repository";
import { sendInventoryCutoverError } from "./inventory-cutover-commit.routes";

const ROOT = "/api/inventory-planning/admin/cutover-history";
const noStore: RequestHandler = (_req,res,next) => { res.setHeader("Cache-Control","no-store"); next(); };
export function registerInventoryCutoverHistoryRoutes(app: Express,
  service: Pick<InventoryCutoverHistoryService,"review" | "retire"> =
    new InventoryCutoverHistoryService(new PostgresInventoryCutoverHistoryRepository(pool))): void {
  app.get(ROOT + "/review", noStore, requirePermission("inventory_planning","activate"), async (req,res) => {
    try {
      if (Object.keys(req.query).length) throw new CutoverHistoryError("HISTORY_REQUEST_INVALID", "Partial history filters are not accepted.", 400);
      return res.json(historyReviewSchema.parse(await service.review(req.session?.user?.id)));
    } catch (error) { return sendError(res,error); }
  });
  app.post(ROOT + "/retire", noStore, requirePermission("inventory_planning","activate"), async (req,res) => {
    try {
      if (Object.keys(req.query).length) throw new CutoverHistoryError("HISTORY_REQUEST_INVALID", "Query overrides are not accepted.", 400);
      const result = historyRetirementResultSchema.parse(await service.retire(req.body,req.session?.user?.id));
      return res.status(result.alreadyApplied ? 200 : 201).json(result);
    } catch (error) { return sendError(res,error); }
  });
}
function sendError(res: Response, error: unknown): Response {
  if (error instanceof CutoverHistoryError && error.status < 500) {
    return res.status(error.status).json({ error: { code: error.code, message: error.message, context: error.context } });
  }
  return sendInventoryCutoverError(res,error);
}
