import type { Express, Request, Response } from "express";
import { DropshipError } from "../../domain/errors";
import type { DropshipShippingQuoteService } from "../../application/dropship-shipping-quote-service";
import { createDropshipShippingQuoteServiceFromEnv } from "../../infrastructure/dropship-shipping-quote.factory";
import { requireDropshipAuth } from "./dropship-auth.routes";

export function registerDropshipShippingRoutes(
  app: Express,
  service: DropshipShippingQuoteService = createDropshipShippingQuoteServiceFromEnv(),
): void {
  app.post("/api/dropship/shipping/quote", requireDropshipAuth, async (req, res) => {
    try {
      const result = await service.quoteForMember(req.session.dropship!.memberId, {
        storeConnectionId: req.body?.storeConnectionId,
        warehouseId: req.body?.warehouseId,
        destination: req.body?.destination,
        items: req.body?.items,
        idempotencyKey: resolveIdempotencyKey(req),
      });

      return res.status(result.idempotentReplay ? 200 : 201).json({
        quote: {
          quoteSnapshotId: result.quoteSnapshotId,
          idempotentReplay: result.idempotentReplay,
          storeConnectionId: result.storeConnectionId,
          warehouseId: result.warehouseId,
          destination: result.destination,
          packageCount: result.packageCount,
          totalShippingCents: result.totalShippingCents,
          currency: result.currency,
          carrierServices: result.carrierServices,
        },
      });
    } catch (error) {
      return sendDropshipShippingError(res, error);
    }
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

function sendDropshipShippingError(res: Response, error: unknown) {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipShippingError(error.code)).json({
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
        code: "DROPSHIP_SHIPPING_INVALID_INPUT",
        message: "Dropship shipping quote input failed validation.",
        context: { issues: (error as { issues: unknown }).issues },
      },
    });
  }

  console.error("[DropshipShippingRoutes] Unexpected shipping quote error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_SHIPPING_INTERNAL_ERROR",
      message: "Dropship shipping quote request failed.",
    },
  });
}

function statusForDropshipShippingError(code: string): number {
  if (code === "DROPSHIP_IDEMPOTENCY_CONFLICT") {
    return 409;
  }
  if (code === "DROPSHIP_STORE_CONNECTION_REQUIRED") {
    return 404;
  }
  if (code === "DROPSHIP_SHIPPING_VENDOR_BLOCKED" || code === "DROPSHIP_SHIPPING_STORE_BLOCKED") {
    return 403;
  }
  if (
    code === "DROPSHIP_PACKAGE_PROFILE_REQUIRED"
    || code === "DROPSHIP_BOX_CATALOG_REQUIRED"
    || code === "DROPSHIP_PACKAGE_PROFILE_BOX_REQUIRED"
    || code === "DROPSHIP_CARTONIZATION_BLOCKED"
    || code === "DROPSHIP_SHIPPING_ZONE_REQUIRED"
    || code === "DROPSHIP_SHIPPING_RATE_REQUIRED"
    || code === "DROPSHIP_SHIPPING_RATE_CURRENCY_MISMATCH"
  ) {
    return 409;
  }
  return 400;
}
