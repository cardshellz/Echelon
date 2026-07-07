/**
 * ShipStation-v2 calibration admin — interface layer.
 *
 * POST /api/shipping/admin/calibration/run  sample + quote + (optionally)
 * write calibrated rate tables. Body defaults to a DRY RUN — nothing is
 * written unless { dryRun: false }. When SHIPSTATION_V2_API_KEY is unset the
 * run no-ops with { configured: false }. Logic lives in
 * application/rate-calibration.service.ts; this file stays thin (same
 * pattern as rate-table-admin.routes.ts).
 */

import type { Express, Response } from "express";
import { z } from "zod";
import { requirePermission } from "../../../../routes/middleware";
import { runCalibration } from "../../application/rate-calibration.service";

const runSchema = z.object({
  dryRun: z.boolean().optional(),
  originWarehouseId: z.number().int().positive().optional(),
  overwriteManual: z.boolean().optional(),
});

export function registerCalibrationAdminRoutes(app: Express): void {
  app.post(
    "/api/shipping/admin/calibration/run",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const parsed = runSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return res.status(400).json({ error: { code: "SHIPPING_ADMIN_INVALID_INPUT", issues: parsed.error.issues } });
        }
        const report = await runCalibration(parsed.data);
        return res.json(report);
      } catch (error) {
        return sendCalibrationAdminError(res, error, "run rate calibration");
      }
    },
  );
}

function sendCalibrationAdminError(res: Response, error: unknown, action: string): Response {
  console.error(`[CalibrationAdminRoutes] Failed to ${action}:`, error);
  return res.status(500).json({
    error: { code: "SHIPPING_ADMIN_INTERNAL_ERROR", message: `Failed to ${action}.` },
  });
}
