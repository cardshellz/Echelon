import type { Express, Request, Response } from "express";
import { requirePermission } from "../../../../routes/middleware";
import type { DropshipCostChangePolicyService } from "../../application/dropship-cost-change-policy-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipCostChangePolicyServiceFromEnv } from "../../infrastructure/dropship-cost-change-policy.factory";

/**
 * Admin surface for the staff-set .ops cost change policy (migration 0710,
 * docs/DROPSHIP-COST-CHANGE-CONTROLS.md).
 *
 * The policy is versioned and immutable: POST publishes a NEW VERSION and
 * retires the current one; there is no PATCH. Routes orchestrate only; every
 * rule, range and default lives in the service and the shared settings module.
 */
export function registerDropshipAdminCostChangePolicyRoutes(
  app: Express,
  service: DropshipCostChangePolicyService = createDropshipCostChangePolicyServiceFromEnv(),
): void {
  app.get(
    "/api/dropship/admin/cost-changes/policy",
    requirePermission("dropship", "view"),
    async (_req, res) => {
      try {
        return res.json(await service.getOverview());
      } catch (error) {
        return sendCostChangePolicyError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/admin/cost-changes/policy",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        // The whole body goes to the strict schema, so an unknown field is
        // refused rather than ignored. The key and the actor are set here
        // last: a body can never choose who the change is attributed to.
        const result = await service.createPolicyVersion({
          ...req.body,
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.status(result.idempotentReplay ? 200 : 201).json(result);
      } catch (error) {
        return sendCostChangePolicyError(res, error);
      }
    },
  );
}

function sendCostChangePolicyError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForCostChangePolicyError(error.code)).json({
      error: { code: error.code, message: error.message, context: error.context },
    });
  }
  console.error(JSON.stringify({
    level: "error",
    code: "DROPSHIP_COST_CHANGE_POLICY_INTERNAL_ERROR",
    message: "Unexpected cost change policy request error.",
    context: { error: error instanceof Error ? error.message : String(error) },
  }));
  return res.status(500).json({
    error: { code: "DROPSHIP_COST_CHANGE_POLICY_INTERNAL_ERROR", message: "Dropship cost change policy request failed." },
  });
}

export function statusForCostChangePolicyError(code: string): number {
  switch (code) {
    case "DROPSHIP_COST_CHANGE_POLICY_INVALID_INPUT":
    case "DROPSHIP_IDEMPOTENCY_KEY_REQUIRED":
      return 400;
    case "DROPSHIP_COST_CHANGE_POLICY_NOT_FOUND":
      return 404;
    case "DROPSHIP_COST_CHANGE_POLICY_IDEMPOTENCY_CONFLICT":
    case "DROPSHIP_COST_CHANGE_POLICY_COMMAND_INCOMPLETE":
    case "DROPSHIP_COST_CHANGE_POLICY_CONFLICT":
      return 409;
    // The table is not there yet: the caller retries after the migration lands.
    case "DROPSHIP_COST_CHANGE_POLICY_TABLE_MISSING":
      return 503;
    default:
      return 500;
  }
}

function resolveIdempotencyKey(req: Request): string {
  const header = req.header("Idempotency-Key") ?? req.header("X-Idempotency-Key");
  const bodyKey = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : null;
  const key = bodyKey ?? header;
  if (!key) {
    throw new DropshipError("DROPSHIP_IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header or idempotencyKey body field is required.",
      { classification: "permanent" });
  }
  return key;
}

function adminActor(req: Request): { actorType: "admin"; actorId?: string } {
  const user = req.session.user as { id?: unknown } | undefined;
  return {
    actorType: "admin",
    ...(typeof user?.id === "string" && user.id.trim() ? { actorId: user.id.trim() } : {}),
  };
}
