import type { Express, Request, Response } from "express";
import { requirePermission } from "../../../../routes/middleware";
import type { DropshipWalletPolicyService } from "../../application/dropship-wallet-policy-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipWalletPolicyServiceFromEnv } from "../../infrastructure/dropship-wallet-policy.factory";

/**
 * Admin surface for the staff-managed wallet policy (migration 0681).
 *
 * The limits are versioned and immutable: POST publishes a NEW VERSION and
 * retires the current one; there is no PATCH. Routes orchestrate only — every
 * rule, default and count lives in DropshipWalletPolicyService.
 *
 * The card funding fee is served read-only on the GET. It is NOT editable here:
 * a vendor's agreement to a rate is recorded only in an audit payload, not on
 * their settings row, and unattended auto-reload charges quote the live rate,
 * so an editable fee would charge vendors a rate they never agreed to. Storing
 * the acknowledgement on the settings row is the prerequisite and is separate
 * work. The service carries the same note in its response payload.
 */
export function registerDropshipAdminWalletPolicyRoutes(
  app: Express,
  service: DropshipWalletPolicyService = createDropshipWalletPolicyServiceFromEnv(),
): void {
  app.get(
    "/api/dropship/admin/wallet/policy",
    requirePermission("dropship", "view"),
    async (req, res) => {
      try {
        // Optional proposal: staff see the impact of a candidate floor BEFORE
        // they publish it. Omitted values fall back to the limits in force.
        const overview = await service.getOverview({
          ...optionalCents(req.query.proposedAutoReloadMinTriggerCents, "autoReloadMinTriggerCents"),
          ...optionalCents(req.query.proposedAutoReloadMinAmountCents, "autoReloadMinAmountCents"),
        });
        return res.json(overview);
      } catch (error) {
        return sendDropshipWalletPolicyError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/admin/wallet/policy",
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
        return sendDropshipWalletPolicyError(res, error);
      }
    },
  );
}

function sendDropshipWalletPolicyError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipWalletPolicyError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  console.error("[DropshipAdminWalletPolicyRoutes] Unexpected wallet policy error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_WALLET_POLICY_INTERNAL_ERROR",
      message: "Dropship wallet policy request failed.",
    },
  });
}

function statusForDropshipWalletPolicyError(code: string): number {
  switch (code) {
    case "DROPSHIP_WALLET_POLICY_INVALID_INPUT":
    case "DROPSHIP_IDEMPOTENCY_KEY_REQUIRED":
      return 400;
    case "DROPSHIP_WALLET_POLICY_NOT_FOUND":
      return 404;
    case "DROPSHIP_WALLET_POLICY_IDEMPOTENCY_CONFLICT":
    case "DROPSHIP_WALLET_POLICY_COMMAND_INCOMPLETE":
    case "DROPSHIP_WALLET_POLICY_CONFLICT":
      return 409;
    // The table is not there yet: the caller retries after the migration lands.
    case "DROPSHIP_WALLET_POLICY_TABLE_MISSING":
      return 503;
    default:
      return 500;
  }
}

function optionalCents(value: unknown, key: string): Record<string, number> {
  if (Array.isArray(value)) {
    return optionalCents(value[0], key);
  }
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DropshipError(
      "DROPSHIP_WALLET_POLICY_INVALID_INPUT",
      "Proposed wallet policy amounts must be positive integer cents.",
      { classification: "permanent", field: key, value },
    );
  }
  return { [key]: parsed };
}

function resolveIdempotencyKey(req: Request): string {
  const header = req.header("Idempotency-Key") ?? req.header("X-Idempotency-Key");
  const bodyKey = typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : null;
  const key = bodyKey ?? header;
  if (!key) {
    throw new DropshipError(
      "DROPSHIP_IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key header or idempotencyKey body field is required.",
      { classification: "permanent" },
    );
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
