import type { Express, Request, Response } from "express";
import { z, ZodError } from "zod";
import { pool } from "../../../../db";
import { requireAuth } from "../../../../routes/middleware";
import { WorkConfigurationService } from "../application/work-configuration.service";
import { WorkConfigurationRepository } from "../infrastructure/work-configuration.repository";
import { WarehouseWorkError } from "../domain/work-configuration";
import { workContextPreviewSchema, workRevisionSchema, workSetupSchema } from "@shared/warehouse-work";

const idParameterSchema = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(2_147_483_647));
const defaultHistoryCursor = 2_147_483_647;

function checkedOutput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("Warehouse work output violates its response contract");
  return result.data;
}

export function registerWorkConfigurationRoutes(
  app: Express,
  service = new WorkConfigurationService(new WorkConfigurationRepository(pool), () => new Date()),
) {
  function handler(operation: (req: Request) => Promise<unknown>) {
    return async (req: Request, res: Response) => {
      try { res.json(await operation(req)); } catch (error) {
        if (error instanceof ZodError) {
          console.warn(JSON.stringify({ event: "warehouse_work_request_rejected", code: "WORK_INPUT_INVALID", actorId: req.session.user?.id, warehouseId: req.params.warehouseId }));
          res.status(400).json({ code: "WORK_INPUT_INVALID", message: "Invalid warehouse work request", context: { issues: error.issues } });
          return;
        }
        if (error instanceof WarehouseWorkError) {
          console.warn(JSON.stringify({ event: "warehouse_work_request_rejected", code: error.code, actorId: req.session.user?.id, warehouseId: req.params.warehouseId, context: error.context }));
          res.status(error.status).json({ code: error.code, message: error.message, context: error.context });
          return;
        }
        const sqlState = error && typeof error === "object" && "code" in error ? String(error.code) : null;
        console.error(JSON.stringify({ event: "warehouse_work_request_failed", actorId: req.session.user?.id,
          warehouseId: req.params.warehouseId, method: req.method, sqlState,
          message: error instanceof Error ? error.message : "Unknown failure" }));
        const transient = sqlState === "40001" || sqlState === "40P01" || sqlState === "55P03";
        res.status(transient ? 503 : 500).json({
          code: transient ? "WORK_RETRY_REQUIRED" : "WORK_REQUEST_FAILED",
          message: transient ? "The setup is busy. Retry with the same command ID" : "Warehouse work request failed",
          context: {},
        });
      }
    };
  }
  const warehouseId = (req: Request) => idParameterSchema.parse(req.params.warehouseId);
  const actorId = (req: Request) => req.session.user!.id; // requireAuth is attached to every route.
  const root = "/api/warehouses/:warehouseId/work-configuration";
  app.get(root, requireAuth, handler(async (req) => checkedOutput(workSetupSchema, await service.setup(actorId(req), warehouseId(req)))));
  app.put(root, requireAuth, handler(async (req) => checkedOutput(workRevisionSchema, await service.save(actorId(req), warehouseId(req), req.body))));
  app.get(`${root}/history`, requireAuth, handler(async (req) => checkedOutput(z.array(workRevisionSchema), await service.history(
    actorId(req), warehouseId(req), req.query.before === undefined ? defaultHistoryCursor : idParameterSchema.parse(req.query.before),
  ))));
  // Read-only POST because the typed context is a request body, not a command.
  app.post(`${root}/preview-context`, requireAuth, handler(async (req) => checkedOutput(workContextPreviewSchema, await service.preview(actorId(req), warehouseId(req), req.body))));
}
