import type { Express, Request, Response } from "express";
import {
  DROPSHIP_ALL_INTAKE_STATUSES,
  type DropshipOrderOpsService,
} from "../../application/dropship-order-ops-service";
import type { DropshipOrderAcceptanceWorkflowService } from "../../application/dropship-order-acceptance-workflow-service";
import type { DropshipVendorProvisioningService } from "../../application/dropship-vendor-provisioning-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipOrderAcceptanceWorkflowServiceFromEnv } from "../../infrastructure/dropship-order-acceptance-workflow.factory";
import { createDropshipOrderOpsServiceFromEnv } from "../../infrastructure/dropship-order-ops.factory";
import { createDropshipVendorProvisioningServiceFromEnv } from "../../infrastructure/dropship-vendor-provisioning.factory";
import {
  requireDropshipAuth,
  requireDropshipSensitiveActionProof,
} from "./dropship-auth.routes";

export function registerDropshipOrderRoutes(
  app: Express,
  deps: {
    orderOpsService?: DropshipOrderOpsService;
    orderAcceptanceWorkflowService?: DropshipOrderAcceptanceWorkflowService;
    vendorProvisioningService?: DropshipVendorProvisioningService;
  } = {},
): void {
  const orderOpsService = deps.orderOpsService ?? createDropshipOrderOpsServiceFromEnv();
  const orderAcceptanceWorkflowService = deps.orderAcceptanceWorkflowService
    ?? createDropshipOrderAcceptanceWorkflowServiceFromEnv();
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

  app.get("/api/dropship/orders/:intakeId", requireDropshipAuth, async (req, res) => {
    try {
      const provisioned = await vendorProvisioningService.provisionForMember(req.session.dropship!.memberId);
      const result = await orderOpsService.getIntakeDetail({
        intakeId: parsePositiveIntegerPath(req.params.intakeId, "intakeId"),
        vendorId: provisioned.vendor.vendorId,
      });
      return res.json({ order: result });
    } catch (error) {
      return sendDropshipOrderError(res, error);
    }
  });

  app.post(
    "/api/dropship/orders/:intakeId/accept",
    requireDropshipAuth,
    requireDropshipSensitiveActionProof("high_risk_order_acceptance"),
    async (req, res) => {
      try {
        const result = await orderAcceptanceWorkflowService.acceptOrderForMember(
          req.session.dropship!.memberId,
          {
            intakeId: parsePositiveIntegerPath(req.params.intakeId, "intakeId"),
            idempotencyKey: resolveIdempotencyKey(req),
          },
        );
        return res.status(result.acceptance.idempotentReplay || result.quote.idempotentReplay ? 200 : 201).json({
          result: serializeOrderAcceptanceWorkflowResult(result),
        });
      } catch (error) {
        return sendDropshipOrderError(res, error);
      }
    },
  );
}

function serializeOrderAcceptanceWorkflowResult(
  result: Awaited<ReturnType<DropshipOrderAcceptanceWorkflowService["acceptOrderForMember"]>>,
) {
  return {
    outcome: result.acceptance.outcome,
    intakeId: result.acceptance.intakeId,
    vendorId: result.acceptance.vendorId,
    storeConnectionId: result.acceptance.storeConnectionId,
    shippingQuoteSnapshotId: result.acceptance.shippingQuoteSnapshotId,
    omsOrderId: result.acceptance.omsOrderId,
    walletLedgerEntryId: result.acceptance.walletLedgerEntryId,
    economicsSnapshotId: result.acceptance.economicsSnapshotId,
    totalDebitCents: result.acceptance.totalDebitCents,
    currency: result.acceptance.currency,
    paymentHoldExpiresAt: result.acceptance.paymentHoldExpiresAt?.toISOString() ?? null,
    idempotentReplay: result.acceptance.idempotentReplay || result.quote.idempotentReplay,
    quote: {
      quoteSnapshotId: result.quote.quoteSnapshotId,
      idempotentReplay: result.quote.idempotentReplay,
      warehouseId: result.quote.warehouseId,
      packageCount: result.quote.packageCount,
      totalShippingCents: result.quote.totalShippingCents,
      currency: result.quote.currency,
      carrierServices: result.quote.carrierServices,
    },
  };
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

  if (error && typeof error === "object" && "issues" in error) {
    return res.status(400).json({
      error: {
        code: "DROPSHIP_ORDER_INVALID_REQUEST",
        message: "Dropship order request failed validation.",
        context: { issues: (error as { issues: unknown }).issues },
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
    case "DROPSHIP_ORDER_OPS_DETAIL_INVALID_INPUT":
    case "DROPSHIP_ORDER_INVALID_REQUEST":
    case "DROPSHIP_ORDER_ACCEPTANCE_WORKFLOW_INVALID_INPUT":
    case "DROPSHIP_ORDER_DEFAULT_WAREHOUSE_REQUIRED":
    case "DROPSHIP_ORDER_SHIP_TO_REQUIRED":
    case "DROPSHIP_ORDER_SHIP_TO_INVALID":
    case "DROPSHIP_ORDER_SHIP_TO_COUNTRY_INVALID":
    case "DROPSHIP_ORDER_LINE_VARIANT_REQUIRED":
    case "DROPSHIP_ORDER_LINE_QUANTITY_INVALID":
    case "DROPSHIP_ORDER_LINES_REQUIRED":
    case "DROPSHIP_ORDER_INTAKE_PAYLOAD_REQUIRED":
      return 400;
    case "DROPSHIP_AUTH_REQUIRED":
      return 401;
    case "DROPSHIP_ENTITLEMENT_REQUIRED":
    case "DROPSHIP_STEP_UP_REQUIRED":
    case "DROPSHIP_SHIPPING_VENDOR_BLOCKED":
    case "DROPSHIP_SHIPPING_STORE_BLOCKED":
    case "DROPSHIP_ORDER_VENDOR_BLOCKED":
    case "DROPSHIP_ORDER_ENTITLEMENT_BLOCKED":
    case "DROPSHIP_ORDER_STORE_BLOCKED":
      return 403;
    case "DROPSHIP_ORDER_INTAKE_NOT_FOUND":
    case "DROPSHIP_ORDER_OPS_INTAKE_NOT_FOUND":
    case "DROPSHIP_STORE_CONNECTION_REQUIRED":
      return 404;
    case "DROPSHIP_IDEMPOTENCY_CONFLICT":
    case "DROPSHIP_ORDER_ACCEPTANCE_IDEMPOTENCY_CONFLICT":
    case "DROPSHIP_ORDER_INTAKE_NOT_ACCEPTABLE":
    case "DROPSHIP_ORDER_SHIPPING_QUOTE_REQUIRED":
    case "DROPSHIP_ORDER_SHIPPING_QUOTE_MISMATCH":
    case "DROPSHIP_ORDER_SHIPPING_QUOTE_DESTINATION_MISMATCH":
    case "DROPSHIP_ORDER_SHIPPING_QUOTE_ITEMS_REQUIRED":
    case "DROPSHIP_ORDER_SHIPPING_QUOTE_ITEMS_INVALID":
    case "DROPSHIP_ORDER_SHIPPING_QUOTE_ITEMS_MISMATCH":
    case "DROPSHIP_ORDER_LINE_LISTING_REQUIRED":
    case "DROPSHIP_ORDER_LISTING_NOT_ACCEPTABLE":
    case "DROPSHIP_ORDER_CATALOG_VARIANT_NOT_ELIGIBLE":
    case "DROPSHIP_ORDER_PRICING_POLICY_BLOCKED":
    case "DROPSHIP_ORDER_INVENTORY_SHORTFALL":
    case "DROPSHIP_ORDER_PAYMENT_HOLD_EXPIRED":
    case "DROPSHIP_ORDER_PAYMENT_HOLD_EXPIRY_REQUIRED":
    case "DROPSHIP_ORDER_WALLET_CURRENCY_MISMATCH":
    case "DROPSHIP_PACKAGE_PROFILE_REQUIRED":
    case "DROPSHIP_BOX_CATALOG_REQUIRED":
    case "DROPSHIP_PACKAGE_PROFILE_BOX_REQUIRED":
    case "DROPSHIP_CARTONIZATION_BLOCKED":
    case "DROPSHIP_SHIPPING_ZONE_REQUIRED":
    case "DROPSHIP_SHIPPING_RATE_REQUIRED":
    case "DROPSHIP_SHIPPING_RATE_CURRENCY_MISMATCH":
      return 409;
    case "DROPSHIP_WALLET_INSUFFICIENT_FUNDS":
      return 402;
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
      "DROPSHIP_ORDER_INVALID_REQUEST",
      "Idempotency-Key header or idempotencyKey body field is required.",
    );
  }
  return key;
}

function parsePositiveIntegerPath(value: string | undefined, parameter: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new DropshipError(
      "DROPSHIP_ORDER_INVALID_REQUEST",
      "Route parameter must be a positive integer.",
      { parameter, value },
    );
  }
  return number;
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
