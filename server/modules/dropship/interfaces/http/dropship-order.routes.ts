import type { Express, Response } from "express";
import {
  DROPSHIP_ALL_INTAKE_STATUSES,
  type DropshipOrderOpsService,
} from "../../application/dropship-order-ops-service";
import type { DropshipVendorProvisioningService } from "../../application/dropship-vendor-provisioning-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipOrderOpsServiceFromEnv } from "../../infrastructure/dropship-order-ops.factory";
import { createDropshipVendorProvisioningServiceFromEnv } from "../../infrastructure/dropship-vendor-provisioning.factory";
import { requireDropshipAuth } from "./dropship-auth.routes";

export function registerDropshipOrderRoutes(
  app: Express,
  deps: {
    orderOpsService?: DropshipOrderOpsService;
    vendorProvisioningService?: DropshipVendorProvisioningService;
  } = {},
): void {
  const orderOpsService = deps.orderOpsService ?? createDropshipOrderOpsServiceFromEnv();
  const vendorProvisioningService = deps.vendorProvisioningService ?? createDropshipVendorProvisioningServiceFromEnv();

  app.get("/api/dropship/orders", requireDropshipAuth, async (req, res) => {
    try {
      const provisioned = await vendorProvisioningService.provisionForMember(req.session.dropship!.memberId);
      const result = await orderOpsService.listIntakes({
        vendorId: provisioned.vendor.vendorId,
        statuses: parseStatusesQuery(req.query.statuses ?? req.query.status) ?? DROPSHIP_ALL_INTAKE_STATUSES,
        search: parseOptionalStringQuery(req.query.search),
        page: parsePositiveIntegerQuery(req.query.page, "page", 1),
        limit: parsePositiveIntegerQuery(req.query.limit, "limit", 50),
      });
      return res.json(result);
    } catch (error) {
      return sendDropshipOrderError(res, error);
    }
  });
}

function sendDropshipOrderError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipOrderError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  console.error("[DropshipOrderRoutes] Unexpected order error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_ORDER_INTERNAL_ERROR",
      message: "Dropship order request failed.",
    },
  });
}

function statusForDropshipOrderError(code: string): number {
  switch (code) {
    case "DROPSHIP_ORDER_OPS_LIST_INVALID_INPUT":
    case "DROPSHIP_ORDER_INVALID_REQUEST":
      return 400;
    case "DROPSHIP_AUTH_REQUIRED":
      return 401;
    case "DROPSHIP_ENTITLEMENT_REQUIRED":
      return 403;
    default:
      return 500;
  }
}

function parseStatusesQuery(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const statuses = value.flatMap((entry) => parseStatusesQuery(entry) ?? []);
    return statuses.length > 0 ? statuses : undefined;
  }
  const parsed = parseOptionalStringQuery(value);
  if (!parsed) return undefined;
  return parsed.split(",").map((status) => status.trim()).filter(Boolean);
}

function parseOptionalStringQuery(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return parseOptionalStringQuery(value[0]);
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalPositiveIntegerQuery(value: unknown, parameter: string): number | undefined {
  const parsed = parseOptionalStringQuery(value);
  if (!parsed) return undefined;
  const number = Number(parsed);
  if (!Number.isInteger(number) || number <= 0) {
    throw new DropshipError(
      "DROPSHIP_ORDER_INVALID_REQUEST",
      "Query parameter must be a positive integer.",
      { parameter, value: parsed },
    );
  }
  return number;
}

function parsePositiveIntegerQuery(value: unknown, parameter: string, fallback: number): number {
  return parseOptionalPositiveIntegerQuery(value, parameter) ?? fallback;
}
