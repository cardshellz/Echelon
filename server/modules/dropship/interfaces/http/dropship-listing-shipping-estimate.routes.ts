import type { Express } from "express";
import rateLimit from "express-rate-limit";
import { ZodError } from "zod";
import type { DropshipListingShippingEstimateService } from "../../application/dropship-listing-shipping-estimate-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipListingShippingEstimateServiceFromEnv } from "../../infrastructure/dropship-listing-shipping-estimate.factory";
import { requireDropshipAuth } from "./dropship-auth.routes";

// Cartonization can be CPU-intensive. Bound requests per authenticated member,
// independently of order placement and wallet rate limits.
export const LISTING_SHIPPING_ESTIMATE_REQUESTS_PER_MINUTE = 30;

export function registerDropshipListingShippingEstimateRoutes(
  app: Express,
  service: Pick<DropshipListingShippingEstimateService, "estimateForMember"> = createDropshipListingShippingEstimateServiceFromEnv(),
): void {
  const limiter = rateLimit({
    windowMs: 60_000,
    max: LISTING_SHIPPING_ESTIMATE_REQUESTS_PER_MINUTE,
    keyGenerator: (req) => req.session.dropship!.memberId,
    message: { error: { code: "DROPSHIP_LISTING_SHIPPING_RATE_LIMITED", message: "Too many shipping estimates. Please try again in a minute." } },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.post("/api/dropship/listings/shipping-estimate", requireDropshipAuth, limiter, async (req, res) => {
    try {
      const estimate = await service.estimateForMember(req.session.dropship!.memberId, req.body);
      res.setHeader("Cache-Control", "no-store");
      return res.json({ estimate });
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({ error: { code: "DROPSHIP_LISTING_SHIPPING_INVALID_INPUT", message: "Shipping estimate input failed validation.", context: { issues: error.issues } } });
      }
      if (error instanceof DropshipError) {
        const status = statusForError(error.code);
        if (status >= 500) console.error(JSON.stringify({ code: error.code, message: "Listing shipping estimate failed.", context: error.context }));
        return res.status(status).json({ error: { code: error.code, message: error.message } });
      }
      console.error(JSON.stringify({ code: "DROPSHIP_LISTING_SHIPPING_INTERNAL_ERROR", message: "Listing shipping estimate failed.", error: error instanceof Error ? error.message : String(error) }));
      return res.status(500).json({ error: { code: "DROPSHIP_LISTING_SHIPPING_INTERNAL_ERROR", message: "Shipping could not be estimated. Please try again." } });
    }
  });
}

function statusForError(code: string): number {
  switch (code) {
    case "DROPSHIP_SHIPPING_INVALID_DESTINATION": return 400;
    case "DROPSHIP_AUTH_REQUIRED": return 401;
    case "DROPSHIP_STORE_CONNECTION_REQUIRED": return 404;
    case "DROPSHIP_LISTING_VENDOR_BLOCKED":
    case "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED":
    case "DROPSHIP_LISTING_STORE_BLOCKED":
    case "DROPSHIP_LISTING_SHIPPING_VARIANT_NOT_SELECTED": return 403;
    case "DROPSHIP_SHARED_SHIPPING_QUOTE_FAILED":
    case "DROPSHIP_SHARED_SHIPPING_QUOTE_INVALID": return 503;
    default: return 500;
  }
}
