import type { Express, Request, Response } from "express";
import { requirePermission } from "../../../../routes/middleware";
import { DropshipCatalogExposureService, makeDropshipCatalogExposureLogger, systemDropshipCatalogExposureClock } from "../../application/dropship-catalog-exposure-service";
import { PgDropshipCatalogExposureRepository } from "../../infrastructure/dropship-catalog-exposure.repository";
import { DropshipError } from "../../domain/errors";

type SessionUser = {
  id: string;
};

export function registerDropshipAdminCatalogRoutes(
  app: Express,
  service: DropshipCatalogExposureService = createDropshipCatalogExposureServiceFromEnv(),
): void {
  app.get(
    "/api/dropship/admin/catalog/rules",
    requirePermission("dropship", "manage_catalog"),
    async (req, res) => {
      try {
        const result = await service.listRules({
          includeInactive: parseBooleanQuery(req.query.includeInactive, false),
        });
        return res.json(result);
      } catch (error) {
        return sendDropshipCatalogError(res, error);
      }
    },
  );

  app.put(
    "/api/dropship/admin/catalog/rules",
    requirePermission("dropship", "manage_catalog"),
    async (req, res) => {
      try {
        const idempotencyKey = resolveIdempotencyKey(req);
        const result = await service.replaceRules({
          idempotencyKey,
          actor: {
            actorType: "admin",
            actorId: sessionUser(req)?.id,
          },
          rules: req.body?.rules,
        });
        return res.status(result.idempotentReplay ? 200 : 201).json(result);
      } catch (error) {
        return sendDropshipCatalogError(res, error);
      }
    },
  );

  app.get(
    "/api/dropship/admin/catalog/preview",
    requirePermission("dropship", "manage_catalog"),
    async (req, res) => {
      try {
        const result = await service.preview({
          search: parseOptionalStringQuery(req.query.search),
          category: parseOptionalStringQuery(req.query.category),
          productLineId: parseOptionalNumberQuery(req.query.productLineId),
          includeInactiveCatalog: parseBooleanQuery(req.query.includeInactiveCatalog, false),
          exposedOnly: parseBooleanQuery(req.query.exposedOnly, false),
          page: parseNumberQuery(req.query.page, 1),
          limit: parseNumberQuery(req.query.limit, 50),
        });
        return res.json(result);
      } catch (error) {
        return sendDropshipCatalogError(res, error);
      }
    },
  );
}

function createDropshipCatalogExposureServiceFromEnv(): DropshipCatalogExposureService {
  return new DropshipCatalogExposureService({
    clock: systemDropshipCatalogExposureClock,
    logger: makeDropshipCatalogExposureLogger(),
    repository: new PgDropshipCatalogExposureRepository(),
  });
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

function parseOptionalNumberQuery(value: unknown): number | undefined {
  const parsed = parseOptionalStringQuery(value);
  if (!parsed) {
    return undefined;
  }
  const asNumber = Number(parsed);
  return Number.isInteger(asNumber) && asNumber > 0 ? asNumber : undefined;
}

function parseNumberQuery(value: unknown, fallback: number): number {
  return parseOptionalNumberQuery(value) ?? fallback;
}

function parseBooleanQuery(value: unknown, fallback: boolean): boolean {
  const parsed = parseOptionalStringQuery(value);
  if (!parsed) {
    return fallback;
  }
  if (parsed === "true") {
    return true;
  }
  if (parsed === "false") {
    return false;
  }
  return fallback;
}

function sendDropshipCatalogError(res: Response, error: unknown) {
  if (error instanceof DropshipError) {
    const status = error.code === "DROPSHIP_IDEMPOTENCY_CONFLICT" ? 409 : 400;
    return res.status(status).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  if (error && typeof error === "object" && "issues" in error) {
    return res.status(400).json({
      error: {
        code: "DROPSHIP_CATALOG_EXPOSURE_INVALID_INPUT",
        message: "Dropship catalog exposure input failed validation.",
        context: { issues: (error as { issues: unknown }).issues },
      },
    });
  }

  console.error("[DropshipAdminCatalogRoutes] Unexpected catalog exposure error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_CATALOG_EXPOSURE_INTERNAL_ERROR",
      message: "Dropship catalog exposure request failed.",
    },
  });
}
