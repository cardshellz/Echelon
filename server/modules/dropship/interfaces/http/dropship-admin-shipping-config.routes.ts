import type { Express, Request, Response } from "express";
import { requirePermission } from "../../../../routes/middleware";
import type { DropshipShippingConfigService } from "../../application/dropship-shipping-config-service";
import { shippingConfigValidationError } from "../../application/dropship-shipping-config-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipShippingConfigServiceFromEnv } from "../../infrastructure/dropship-shipping-config.factory";

type SessionUser = {
  id: string;
};

export function registerDropshipAdminShippingConfigRoutes(
  app: Express,
  service: DropshipShippingConfigService = createDropshipShippingConfigServiceFromEnv(),
): void {
  app.get(
    "/api/dropship/admin/shipping/config",
    requirePermission("dropship", "view"),
    async (req, res) => {
      try {
        const config = await service.getOverview({
          search: parseOptionalStringQuery(req.query.search),
          packageProfileLimit: parseNumberQuery(req.query.packageProfileLimit, 50),
          rateTableLimit: parseNumberQuery(req.query.rateTableLimit, 25),
        });
        return res.json({ config });
      } catch (error) {
        return sendDropshipShippingConfigError(res, error);
      }
    },
  );

  app.put(
    "/api/dropship/admin/shipping/boxes",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const result = await service.upsertBox({
          ...req.body,
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.status(result.idempotentReplay ? 200 : 201).json({ box: result.record, idempotentReplay: result.idempotentReplay });
      } catch (error) {
        return sendDropshipShippingConfigError(res, error);
      }
    },
  );

  app.put(
    "/api/dropship/admin/shipping/package-profiles",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const result = await service.upsertPackageProfile({
          ...req.body,
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.status(result.idempotentReplay ? 200 : 201).json({
          packageProfile: result.record,
          idempotentReplay: result.idempotentReplay,
        });
      } catch (error) {
        return sendDropshipShippingConfigError(res, error);
      }
    },
  );

  app.put(
    "/api/dropship/admin/shipping/zone-rules",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const result = await service.upsertZoneRule({
          ...req.body,
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.status(result.idempotentReplay ? 200 : 201).json({
          zoneRule: result.record,
          idempotentReplay: result.idempotentReplay,
        });
      } catch (error) {
        return sendDropshipShippingConfigError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/admin/shipping/rate-tables",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const result = await service.createRateTable({
          ...req.body,
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.status(result.idempotentReplay ? 200 : 201).json({
          rateTable: result.record,
          idempotentReplay: result.idempotentReplay,
        });
      } catch (error) {
        return sendDropshipShippingConfigError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/admin/shipping/markup-policies",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const result = await service.createMarkupPolicy({
          ...req.body,
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.status(result.idempotentReplay ? 200 : 201).json({
          markupPolicy: result.record,
          idempotentReplay: result.idempotentReplay,
        });
      } catch (error) {
        return sendDropshipShippingConfigError(res, error);
      }
    },
  );

  app.post(
    "/api/dropship/admin/shipping/insurance-policies",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const result = await service.createInsurancePolicy({
          ...req.body,
          idempotencyKey: resolveIdempotencyKey(req),
          actor: adminActor(req),
        });
        return res.status(result.idempotentReplay ? 200 : 201).json({
          insurancePolicy: result.record,
          idempotentReplay: result.idempotentReplay,
        });
      } catch (error) {
        return sendDropshipShippingConfigError(res, error);
      }
    },
  );
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

function parseNumberQuery(value: unknown, fallback: number): number {
  const parsed = parseOptionalStringQuery(value);
  if (!parsed) {
    return fallback;
  }
  const asNumber = Number(parsed);
  return Number.isInteger(asNumber) && asNumber > 0 ? asNumber : fallback;
}

function sendDropshipShippingConfigError(res: Response, error: unknown): Response {
  const validationError = shippingConfigValidationError(error);
  if (validationError) {
    return sendDropshipShippingConfigError(res, validationError);
  }

  if (error instanceof DropshipError) {
    return res.status(statusForDropshipShippingConfigError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  console.error("[DropshipAdminShippingConfigRoutes] Unexpected shipping config error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_SHIPPING_CONFIG_INTERNAL_ERROR",
      message: "Dropship shipping configuration request failed.",
    },
  });
}

function statusForDropshipShippingConfigError(code: string): number {
  switch (code) {
    case "DROPSHIP_SHIPPING_CONFIG_INVALID_INPUT":
    case "DROPSHIP_IDEMPOTENCY_KEY_REQUIRED":
      return 400;
    case "DROPSHIP_SHIPPING_CONFIG_IDEMPOTENCY_CONFLICT":
      return 409;
    case "DROPSHIP_PRODUCT_VARIANT_NOT_FOUND":
    case "DROPSHIP_SHIPPING_BOX_NOT_FOUND":
    case "DROPSHIP_WAREHOUSE_NOT_FOUND":
    case "DROPSHIP_SHIPPING_CONFIG_REFERENCE_NOT_FOUND":
      return 404;
    default:
      return 500;
  }
}
