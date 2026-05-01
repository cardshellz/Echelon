import type { Express, Request, Response } from "express";
import { ZodError } from "zod";
import type { DropshipListingPreviewService } from "../../application/dropship-listing-preview-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipListingPreviewServiceFromEnv } from "../../infrastructure/dropship-listing-preview.factory";
import {
  requireDropshipAuth,
  requireDropshipSensitiveActionProof,
} from "./dropship-auth.routes";

export function registerDropshipListingRoutes(
  app: Express,
  service: DropshipListingPreviewService = createDropshipListingPreviewServiceFromEnv(),
): void {
  app.post("/api/dropship/listings/preview", requireDropshipAuth, async (req, res) => {
    try {
      const preview = await service.previewForMember(req.session.dropship!.memberId, {
        storeConnectionId: req.body?.storeConnectionId,
        productVariantIds: req.body?.productVariantIds,
        requestedRetailPriceCents: req.body?.requestedRetailPriceCents,
      });
      return res.json({ preview });
    } catch (error) {
      return sendDropshipListingError(res, error);
    }
  });

  app.post(
    "/api/dropship/listing-push-jobs",
    requireDropshipAuth,
    requireDropshipSensitiveActionProof("bulk_listing_push"),
    async (req, res) => {
      try {
        const result = await service.createListingPushJobForMember(req.session.dropship!.memberId, {
          storeConnectionId: req.body?.storeConnectionId,
          productVariantIds: req.body?.productVariantIds,
          requestedRetailPriceCents: req.body?.requestedRetailPriceCents,
          idempotencyKey: resolveIdempotencyKey(req),
        });
        return res.status(result.idempotentReplay ? 200 : 201).json({
          job: result.job,
          items: result.items,
          preview: result.preview,
          idempotentReplay: result.idempotentReplay,
        });
      } catch (error) {
        return sendDropshipListingError(res, error);
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

function sendDropshipListingError(res: Response, error: unknown): Response {
  if (error instanceof DropshipError) {
    return res.status(statusForDropshipListingError(error.code)).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }

  if (error instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: "DROPSHIP_LISTING_INVALID_INPUT",
        message: "Dropship listing request failed validation.",
        context: { issues: error.issues },
      },
    });
  }

  console.error("[DropshipListingRoutes] Unexpected listing request error:", error);
  return res.status(500).json({
    error: {
      code: "DROPSHIP_LISTING_INTERNAL_ERROR",
      message: "Dropship listing request failed.",
    },
  });
}

function statusForDropshipListingError(code: string): number {
  switch (code) {
    case "DROPSHIP_LISTING_INVALID_INPUT":
    case "DROPSHIP_IDEMPOTENCY_KEY_REQUIRED":
      return 400;
    case "DROPSHIP_AUTH_REQUIRED":
      return 401;
    case "DROPSHIP_LISTING_VENDOR_BLOCKED":
    case "DROPSHIP_LISTING_STORE_BLOCKED":
      return 403;
    case "DROPSHIP_STORE_CONNECTION_REQUIRED":
      return 404;
    case "DROPSHIP_IDEMPOTENCY_CONFLICT":
      return 409;
    default:
      return 500;
  }
}
