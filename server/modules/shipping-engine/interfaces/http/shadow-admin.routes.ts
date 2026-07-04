/**
 * Shadow-run admin trigger — interface layer.
 *
 * POST /api/shipping/admin/shadow-run { days?, limit? }
 * Replays recent real orders through the quote pipeline (see
 * shadow-quote.service.ts) and returns the data-readiness report.
 * Separate file from shipping-admin.routes.ts so the shadow PR does not
 * touch the config-CRUD surface. Design: docs/SHIPPING-ENGINE-DESIGN.md.
 */

import type { Express, Response } from "express";
import { z } from "zod";
import { requirePermission } from "../../../../routes/middleware";
import { runShadow } from "../../application/shadow-quote.service";

const shadowRunSchema = z.object({
  days: z.number().int().min(1).max(365).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export function registerShadowAdminRoutes(app: Express): void {
  app.post(
    "/api/shipping/admin/shadow-run",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const parsed = shadowRunSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return res.status(400).json({
            error: { code: "SHIPPING_ADMIN_INVALID_INPUT", issues: parsed.error.issues },
          });
        }
        const report = await runShadow(parsed.data);
        return res.json({ report });
      } catch (error) {
        return sendShadowAdminError(res, error, "run shadow quotes");
      }
    },
  );
}

function sendShadowAdminError(res: Response, error: unknown, action: string): Response {
  console.error(`[ShadowAdminRoutes] Failed to ${action}:`, error);
  return res.status(500).json({
    error: { code: "SHIPPING_ADMIN_INTERNAL_ERROR", message: `Failed to ${action}.` },
  });
}
