import type { Express, Request, Response } from "express";
import { requirePermission } from "../../../../routes/middleware";
import type { DropshipWalletPolicyService } from "../../application/dropship-wallet-policy-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipWalletPolicyServiceFromEnv } from "../../infrastructure/dropship-wallet-policy.factory";

/**
 * Admin surface for the staff-managed wallet policy (migrations 0682, 0683,
 * 0700) and the per-vendor credit profile.
 *
 * The limits are versioned and immutable: POST publishes a NEW VERSION and
 * retires the current one; there is no PATCH. The credit profile is mutable
 * configuration set with PUT. Routes orchestrate only — every rule, default
 * and count lives in DropshipWalletPolicyService.
 *
 * The card funding fee is one of the limits since funding design phase 7
 * (held at zero). A vendor's acknowledged rate is stored on their settings
 * row, and an unattended charge never carries more than the rate they agreed
 * to (DropshipWalletService.unattendedFeeBps), so staff raising the fee here
 * cannot charge a vendor a rate they never agreed to.
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

  app.get(
    "/api/dropship/admin/vendors/:vendorId/credit-profile",
    requirePermission("dropship", "view"),
    async (req, res) => {
      try {
        const view = await service.getVendorCreditProfile(parseVendorId(req));
        return res.json(view);
      } catch (error) {
        return sendDropshipWalletPolicyError(res, error);
      }
    },
  );

  app.put(
    "/api/dropship/admin/vendors/:vendorId/credit-profile",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const result = await service.setVendorCreditProfile({
          ...req.body,
          vendorId: parseVendorId(req),
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.json(result);
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
    case "DROPSHIP_VENDOR_CREDIT_PROFILE_INVALID_INPUT":
    case "DROPSHIP_IDEMPOTENCY_KEY_REQUIRED":
      return 400;
    case "DROPSHIP_WALLET_POLICY_NOT_FOUND":
    case "DROPSHIP_VENDOR_CREDIT_PROFILE_NOT_FOUND":
    case "DROPSHIP_VENDOR_CREDIT_PROFILE_VENDOR_NOT_FOUND":
      return 404;
    case "DROPSHIP_WALLET_POLICY_IDEMPOTENCY_CONFLICT":
    case "DROPSHIP_WALLET_POLICY_COMMAND_INCOMPLETE":
    case "DROPSHIP_WALLET_POLICY_CONFLICT":
    case "DROPSHIP_VENDOR_CREDIT_PROFILE_IDEMPOTENCY_CONFLICT":
    case "DROPSHIP_VENDOR_CREDIT_PROFILE_COMMAND_INCOMPLETE":
      return 409;
    // The table is not there yet: the caller retries after the migration lands.
    case "DROPSHIP_WALLET_POLICY_TABLE_MISSING":
    case "DROPSHIP_VENDOR_CREDIT_PROFILE_TABLE_MISSING":
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

function parseVendorId(req: Request): number {
  const raw = req.params.vendorId;
  const parsed = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new DropshipError(
      "DROPSHIP_VENDOR_CREDIT_PROFILE_INVALID_INPUT",
      "Vendor id must be a positive integer.",
      { classification: "permanent", field: "vendorId", value: raw },
    );
  }
  return parsed;
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
