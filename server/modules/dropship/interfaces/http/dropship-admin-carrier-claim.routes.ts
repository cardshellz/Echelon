import type { Express, Request, Response } from "express";
import { requirePermission } from "../../../../routes/middleware";
import {
  carrierClaimValidationError,
  type DropshipCarrierClaimService,
} from "../../application/dropship-carrier-claim-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipCarrierClaimServiceFromEnv } from "../../infrastructure/dropship-carrier-claim.factory";

export function registerDropshipAdminCarrierClaimRoutes(
  app: Express,
  service: DropshipCarrierClaimService = createDropshipCarrierClaimServiceFromEnv(),
): void {
  app.get(
    "/api/dropship/admin/carrier-protection/claims",
    requirePermission("dropship", "view"),
    async (req, res) => {
      try {
        return res.json({ claims: await service.listClaims({ limit: req.query.limit }) });
      } catch (error) {
        return sendError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/admin/carrier-protection/claims",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const result = await service.createClaim({
          ...req.body,
          idempotencyKey: readIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.status(result.idempotentReplay ? 200 : 201).json({
          claim: result.record,
          idempotentReplay: result.idempotentReplay,
        });
      } catch (error) {
        return sendError(res, error);
      }
    },
  );
}

function readIdempotencyKey(req: Request): string {
  const bodyKey = typeof req.body?.idempotencyKey === "string"
    ? req.body.idempotencyKey.trim()
    : null;
  const headerKey = (req.header("Idempotency-Key") ?? req.header("X-Idempotency-Key"))?.trim() ?? null;
  if (bodyKey && headerKey && bodyKey !== headerKey) {
    throw new DropshipError(
      "DROPSHIP_CARRIER_CLAIM_IDEMPOTENCY_CONFLICT",
      "Body and header idempotency keys must match when both are provided.",
    );
  }
  const key = bodyKey || headerKey;
  if (typeof key !== "string" || !key.trim()) {
    throw new DropshipError("DROPSHIP_IDEMPOTENCY_KEY_REQUIRED", "Idempotency key is required.");
  }
  return key.trim();
}

function adminActor(req: Request): { actorType: "admin"; actorId?: string } {
  const user = req.session.user as { id?: string } | undefined;
  return { actorType: "admin", actorId: user?.id };
}

function sendError(res: Response, error: unknown): Response {
  const validation = carrierClaimValidationError(error);
  if (validation) return sendError(res, validation);
  if (error instanceof DropshipError) {
    return res.status(statusForErrorCode(error.code)).json({
      error: { code: error.code, message: error.message, context: error.context },
    });
  }
  console.error("[DropshipCarrierClaimRoutes] Unexpected error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_CARRIER_CLAIM_INTERNAL_ERROR",
      message: "Carrier claim request failed.",
    },
  });
}

function statusForErrorCode(code: string): number {
  if (code.includes("WRITE_INCOMPLETE") || code.includes("COMMAND_INCOMPLETE")) return 500;
  if (code.includes("NOT_FOUND")) return 404;
  if ([
    "CONFLICT",
    "NOT_FINAL",
    "REQUIRED",
    "STALE",
    "MISMATCH",
    "SOURCE_INCOMPLETE",
    "PRICING_SNAPSHOT_INVALID",
    "SHIPMENT_ITEMS_INVALID",
    "CONCURRENT_RETRY",
  ].some((fragment) => code.includes(fragment))) return 409;
  return 400;
}
