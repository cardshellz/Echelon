import type { Express, Request, Response } from "express";
import { db } from "../../../../db";
import { createInventoryAtpService } from "../../../inventory/atp.service";
import {
  DropshipSelectionAtpService,
  makeDropshipSelectionAtpLogger,
  systemDropshipSelectionAtpClock,
} from "../../application/dropship-selection-atp-service";
import { InventoryServiceDropshipAtpProvider } from "../../infrastructure/dropship-atp.provider";
import { PgDropshipSelectionAtpRepository } from "../../infrastructure/dropship-selection-atp.repository";
import { DropshipError } from "../../domain/errors";
import { requireDropshipAuth } from "./dropship-auth.routes";

export function registerDropshipVendorCatalogRoutes(
  app: Express,
  service: DropshipSelectionAtpService = createDropshipSelectionAtpServiceFromEnv(),
): void {
  app.get("/api/dropship/catalog/selection-rules", requireDropshipAuth, async (req, res) => {
    try {
      const vendor = await service.requireVendorForMember(req.session.dropship!.memberId);
      const result = await service.listSelectionRules({
        vendorId: vendor.vendorId,
        includeInactive: parseBooleanQuery(req.query.includeInactive, false),
      });
      return res.json(result);
    } catch (error) {
      return sendDropshipVendorCatalogError(res, error);
    }
  });

  app.put("/api/dropship/catalog/selection-rules", requireDropshipAuth, async (req, res) => {
    try {
      const vendor = await service.requireVendorForMember(req.session.dropship!.memberId);
      const result = await service.replaceSelectionRules({
        vendorId: vendor.vendorId,
        idempotencyKey: resolveIdempotencyKey(req),
        actor: {
          actorType: "vendor",
          actorId: req.session.dropship!.memberId,
        },
        rules: req.body?.rules,
      });
      return res.status(result.idempotentReplay ? 200 : 201).json(result);
    } catch (error) {
      return sendDropshipVendorCatalogError(res, error);
    }
  });

  app.get("/api/dropship/catalog", requireDropshipAuth, async (req, res) => {
    try {
      const vendor = await service.requireVendorForMember(req.session.dropship!.memberId);
      const result = await service.previewCatalog({
        vendorId: vendor.vendorId,
        search: parseOptionalStringQuery(req.query.search),
        category: parseOptionalStringQuery(req.query.category),
        productLineId: parseOptionalNumberQuery(req.query.productLineId),
        selectedOnly: parseBooleanQuery(req.query.selectedOnly, false),
        page: parseNumberQuery(req.query.page, 1),
        limit: parseNumberQuery(req.query.limit, 50),
      });
      return res.json(result);
    } catch (error) {
      return sendDropshipVendorCatalogError(res, error);
    }
  });
}

function createDropshipSelectionAtpServiceFromEnv(): DropshipSelectionAtpService {
  return new DropshipSelectionAtpService({
    clock: systemDropshipSelectionAtpClock,
    logger: makeDropshipSelectionAtpLogger(),
    repository: new PgDropshipSelectionAtpRepository(),
    atp: new InventoryServiceDropshipAtpProvider(createInventoryAtpService(db)),
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

function sendDropshipVendorCatalogError(res: Response, error: unknown) {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipVendorCatalogError(error.code)).json({
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
        code: "DROPSHIP_VENDOR_CATALOG_INVALID_INPUT",
        message: "Dropship vendor catalog input failed validation.",
        context: { issues: (error as { issues: unknown }).issues },
      },
    });
  }

  console.error("[DropshipVendorCatalogRoutes] Unexpected vendor catalog error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_VENDOR_CATALOG_INTERNAL_ERROR",
      message: "Dropship vendor catalog request failed.",
    },
  });
}

function statusForDropshipVendorCatalogError(code: string): number {
  if (code === "DROPSHIP_IDEMPOTENCY_CONFLICT") {
    return 409;
  }
  if (code === "DROPSHIP_VENDOR_PROFILE_REQUIRED") {
    return 409;
  }
  if (code === "DROPSHIP_VENDOR_CATALOG_ACCESS_BLOCKED") {
    return 403;
  }
  return 400;
}
