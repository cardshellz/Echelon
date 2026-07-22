import type { Express } from "express";
import { z } from "zod";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import {
  createPurchaseForecastBacktestingService,
  type PurchaseForecastBacktestingService,
} from "./purchase-forecast-backtesting.service";

const evaluateBodySchema = z.object({
  horizons: z.array(z.union([z.literal(7), z.literal(30), z.literal(90)])).min(1).max(3).optional(),
  limit: z.number().int().min(1).max(5_000).optional(),
}).strict();

const reportQuerySchema = z.object({
  horizonDays: z.union([z.literal("7"), z.literal("30"), z.literal("90")]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

function requestActor(req: any): string | null {
  const userId = req.user?.id ?? req.session?.user?.id ?? null;
  return userId == null ? null : String(userId);
}

function sendBoundaryError(res: any, error: unknown): boolean {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Invalid forecast backtesting request", details: error.flatten() });
    return true;
  }
  if (error instanceof RangeError || error instanceof TypeError) {
    res.status(400).json({ error: error.message });
    return true;
  }
  return false;
}

export function registerPurchaseForecastBacktestingRoutes(
  app: Express,
  dependencies: { service?: PurchaseForecastBacktestingService } = {},
) {
  const service = dependencies.service ?? createPurchaseForecastBacktestingService({ database: db });

  app.get(
    "/api/purchasing/forecast-backtests",
    requirePermission("purchasing", "view"),
    async (req, res) => {
      try {
        const query = reportQuerySchema.parse(req.query);
        res.json(await service.getReport(query));
      } catch (error) {
        if (sendBoundaryError(res, error)) return;
        console.error("[PurchaseForecastBacktesting] Report failed", { error });
        res.status(500).json({ error: "Failed to load purchase forecast backtests" });
      }
    },
  );

  app.post(
    "/api/purchasing/forecast-backtests/evaluate",
    requirePermission("purchasing", "edit"),
    async (req, res) => {
      try {
        const body = evaluateBodySchema.parse(req.body ?? {});
        const result = await service.evaluateMatured({ ...body, actor: requestActor(req) });
        res.status(201).json(result);
      } catch (error) {
        if (sendBoundaryError(res, error)) return;
        console.error("[PurchaseForecastBacktesting] Evaluation failed", {
          actor: requestActor(req),
          error,
        });
        res.status(500).json({ error: "Failed to evaluate mature purchase forecasts" });
      }
    },
  );
}
