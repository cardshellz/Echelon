import type { Express, Request, Response } from "express";
import { requirePermission } from "../../../../routes/middleware";
import type { DropshipReturnPolicyService } from "../../application/dropship-return-policy-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipReturnPolicyServiceFromEnv } from "../../infrastructure/dropship-return-policy.factory";

type SessionUser = {
  id: string;
};

/**
 * Admin CRUD for hierarchical return policies + fee schedule (build spec B1).
 * Money fields are immutable once effective: POST creates a new version; there
 * is no PATCH on effective rows. Deactivation is the only mutation.
 */
export function registerDropshipAdminReturnPolicyRoutes(
  app: Express,
  service: DropshipReturnPolicyService = createDropshipReturnPolicyServiceFromEnv(),
): void {
  app.get(
    "/api/dropship/admin/return-policies",
    requirePermission("dropship", "view"),
    async (req, res) => {
      try {
        const policies = await service.listPolicies({
          vendorId: parseOptionalPositiveIntegerQuery(req.query.vendorId),
          storeConnectionId: parseOptionalPositiveIntegerQuery(req.query.storeConnectionId),
          includeInactive: req.query.includeInactive === "true",
        });
        return res.json({ items: policies });
      } catch (error) {
        return sendDropshipReturnPolicyError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/admin/return-policies",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const result = await service.createPolicyVersion({
          ...req.body,
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.status(result.idempotentReplay ? 200 : 201).json(result);
      } catch (error) {
        return sendDropshipReturnPolicyError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/admin/return-policies/:policyId/deactivate",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const result = await service.deactivatePolicy({
          policyId: parsePositiveInteger(req.params.policyId, "policyId"),
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.json(result);
      } catch (error) {
        return sendDropshipReturnPolicyError(res, error);
      }
    },
  );

  app.get(
    "/api/dropship/admin/return-policies/effective",
    requirePermission("dropship", "view"),
    async (req, res) => {
      try {
        const vendorId = parseOptionalPositiveIntegerQuery(req.query.vendorId) ?? null;
        const storeConnectionId = parseOptionalPositiveIntegerQuery(req.query.storeConnectionId) ?? null;
        const policy = await service.resolveReturnPolicy({ vendorId, storeConnectionId });
        return res.json({ policy });
      } catch (error) {
        return sendDropshipReturnPolicyError(res, error);
      }
    },
  );

  app.get(
    "/api/dropship/admin/return-policies/fee-schedule",
    requirePermission("dropship", "view"),
    async (req, res) => {
      try {
        const fees = await service.listFees({
          vendorId: parseOptionalPositiveIntegerQuery(req.query.vendorId),
          storeConnectionId: parseOptionalPositiveIntegerQuery(req.query.storeConnectionId),
          feeType: parseOptionalStringQuery(req.query.feeType),
          faultCategory: parseOptionalStringQuery(req.query.faultCategory),
          includeInactive: req.query.includeInactive === "true",
        });
        return res.json({ items: fees });
      } catch (error) {
        return sendDropshipReturnPolicyError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/admin/return-policies/fee-schedule",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const result = await service.createFeeVersion({
          ...req.body,
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.status(result.idempotentReplay ? 200 : 201).json(result);
      } catch (error) {
        return sendDropshipReturnPolicyError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/admin/return-policies/fee-schedule/:feeId/deactivate",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const result = await service.deactivateFee({
          feeId: parsePositiveInteger(req.params.feeId, "feeId"),
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.json(result);
      } catch (error) {
        return sendDropshipReturnPolicyError(res, error);
      }
    },
  );

  app.get(
    "/api/dropship/admin/return-policies/fee-schedule/effective",
    requirePermission("dropship", "view"),
    async (req, res) => {
      try {
        const vendorId = parseOptionalPositiveIntegerQuery(req.query.vendorId) ?? null;
        const storeConnectionId = parseOptionalPositiveIntegerQuery(req.query.storeConnectionId) ?? null;
        const faultCategory = parseOptionalStringQuery(req.query.faultCategory);
        if (!faultCategory) {
          throw new DropshipError(
            "DROPSHIP_RETURN_FEE_INVALID_INPUT",
            "faultCategory query parameter is required.",
          );
        }
        const fees = await service.resolveReturnFees({ vendorId, storeConnectionId, faultCategory });
        return res.json({ fees });
      } catch (error) {
        return sendDropshipReturnPolicyError(res, error);
      }
    },
  );
}

function sendDropshipReturnPolicyError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipReturnPolicyError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  console.error("[DropshipAdminReturnPolicyRoutes] Unexpected return policy error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_RETURN_POLICY_INTERNAL_ERROR",
      message: "Dropship return policy request failed.",
    },
  });
}

function statusForDropshipReturnPolicyError(code: string): number {
  switch (code) {
    case "DROPSHIP_RETURN_POLICY_INVALID_INPUT":
    case "DROPSHIP_RETURN_FEE_INVALID_INPUT":
    case "DROPSHIP_IDEMPOTENCY_KEY_REQUIRED":
      return 400;
    case "DROPSHIP_RETURN_POLICY_NOT_FOUND":
    case "DROPSHIP_RETURN_FEE_NOT_FOUND":
      return 404;
    case "DROPSHIP_RETURN_POLICY_IDEMPOTENCY_CONFLICT":
    case "DROPSHIP_RETURN_POLICY_COMMAND_INCOMPLETE":
    case "DROPSHIP_RETURN_POLICY_ALREADY_INACTIVE":
    case "DROPSHIP_RETURN_FEE_ALREADY_INACTIVE":
      return 409;
    default:
      return 500;
  }
}

function resolveIdempotencyKey(req: Request): string {
  const header = req.header("Idempotency-Key") ?? req.header("X-Idempotency-Key");
  const bodyKey = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : null;
  const key = bodyKey ?? header;
  if (!key) {
    throw new DropshipError(
      "DROPSHIP_IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key header or idempotencyKey body field is required.",
    );
  }
  return key;
}

function adminActor(req: Request): { actorType: "admin"; actorId?: string } {
  return {
    actorType: "admin",
    actorId: sessionUser(req)?.id,
  };
}

function sessionUser(req: Request): SessionUser | null {
  const candidate = req.session.user as SessionUser | undefined;
  return candidate?.id ? candidate : null;
}

function parseOptionalStringQuery(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return parseOptionalStringQuery(value[0]);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalPositiveIntegerQuery(value: unknown): number | undefined {
  if (Array.isArray(value)) {
    return parseOptionalPositiveIntegerQuery(value[0]);
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return parsePositiveInteger(value, "query");
}

function parsePositiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DropshipError(
      "DROPSHIP_RETURN_POLICY_INVALID_INPUT",
      "Expected a positive integer.",
      { field, value },
    );
  }
  return parsed;
}
