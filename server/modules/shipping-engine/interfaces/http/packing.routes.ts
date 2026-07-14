/**
 * Packing station routes — interface layer (PACKING PAGE v2).
 *
 * GET  /api/shipping/packing/queue                          — packing-eligible orders + their pack plans + box options
 * POST /api/shipping/packing/plans/:planId/parcels/:parcelId/confirm — record actual box/weight for one parcel
 * POST /api/shipping/packing/orders/:wmsOrderId/generate-plan        — explicit ensurePackPlan for plan-less orders
 *
 * Gated with requireAuth, mirroring the picking station routes
 * (server/modules/orders/picking.routes.ts) — packers are station users,
 * not settings admins. Design: docs/SHIPPING-ENGINE-DESIGN.md.
 */

import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../../../routes/middleware";
import { ensurePackPlan } from "../../../cartonization/application/wms-pack-plan.service";
import { confirmParcel, getPackingQueue } from "../../application/packing.service";

const confirmParcelSchema = z.object({
  actualBoxId: z.number().int().positive().nullable().optional(),
  actualWeightGrams: z.number().int().positive().nullable().optional(),
  packedBy: z.string().trim().min(1).max(120).optional(),
});

/** 4xx per failure code; anything unknown stays a 500 via the catch. */
const CONFIRM_FAILURE_STATUS: Record<string, number> = {
  PLAN_NOT_FOUND: 404,
  PARCEL_NOT_FOUND: 404,
  BOX_NOT_FOUND: 400,
  PLAN_NOT_CONFIRMABLE: 409,
};

export function registerPackingRoutes(app: Express): void {
  app.get("/api/shipping/packing/queue", requireAuth, async (_req, res) => {
    try {
      const queue = await getPackingQueue();
      return res.json(queue);
    } catch (error) {
      return sendPackingError(res, error, "load packing queue");
    }
  });

  app.post(
    "/api/shipping/packing/plans/:planId/parcels/:parcelId/confirm",
    requireAuth,
    async (req, res) => {
      try {
        const planId = parsePositiveInt(req.params.planId);
        const parcelId = parsePositiveInt(req.params.parcelId);
        if (planId === null || parcelId === null) {
          return res.status(400).json({ error: { code: "PACKING_INVALID_INPUT", message: "invalid plan or parcel id" } });
        }
        const parsed = confirmParcelSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return res.status(400).json({ error: { code: "PACKING_INVALID_INPUT", issues: parsed.error.issues } });
        }

        const result = await confirmParcel({
          planId,
          parcelId,
          actualBoxId: parsed.data.actualBoxId ?? null,
          actualWeightGrams: parsed.data.actualWeightGrams ?? null,
          // Session identity wins over the client-sent name — the station
          // login is the accountable packer.
          packedBy: sessionUserLabel(req) ?? parsed.data.packedBy ?? null,
        });
        if (!result.ok) {
          return res.status(CONFIRM_FAILURE_STATUS[result.code] ?? 500).json({ error: { code: `PACKING_${result.code}` } });
        }
        return res.json({
          planStatus: result.planStatus,
          allConfirmed: result.allConfirmed,
          parcel: result.parcel,
        });
      } catch (error) {
        return sendPackingError(res, error, "confirm parcel");
      }
    },
  );

  app.post(
    "/api/shipping/packing/orders/:wmsOrderId/generate-plan",
    requireAuth,
    async (req, res) => {
      try {
        const wmsOrderId = parsePositiveInt(req.params.wmsOrderId);
        if (wmsOrderId === null) {
          return res.status(400).json({ error: { code: "PACKING_INVALID_INPUT", message: "invalid order id" } });
        }
        const result = await ensurePackPlan({ wmsOrderId });
        if (!result) {
          // ensurePackPlan never throws: null = missing dims/attrs or an
          // incomplete packing. Actionable for the station, not a server error.
          return res.status(422).json({
            error: {
              code: "PACKING_PLAN_UNAVAILABLE",
              message: "No pack plan could be generated — item dims/packing attributes are incomplete.",
            },
          });
        }
        return res.json({
          plan: result.plan,
          instruction: result.instruction,
        });
      } catch (error) {
        return sendPackingError(res, error, "generate pack plan");
      }
    },
  );
}

function parsePositiveInt(raw: string): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function sessionUserLabel(req: Request): string | null {
  const user = (req as any).session?.user;
  if (!user) return null;
  return user.displayName || user.username || user.id || null;
}

function sendPackingError(res: Response, error: unknown, action: string): Response {
  console.error(`[PackingRoutes] Failed to ${action}:`, error);
  return res.status(500).json({
    error: { code: "PACKING_INTERNAL_ERROR", message: `Failed to ${action}.` },
  });
}
