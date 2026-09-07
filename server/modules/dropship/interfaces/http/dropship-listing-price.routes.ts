import type { Express, Response } from "express";
import rateLimit from "express-rate-limit";
import { ZodError } from "zod";
import { listingPriceResponseSchema, saveListingPriceResponseSchema } from "../../../../../shared/dropship/listing-price";
import type { DropshipListingPriceService } from "../../application/dropship-listing-price-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipListingPriceService } from "../../infrastructure/dropship-listing-price.factory";
import { requireDropshipAuth } from "./dropship-auth.routes";

export function registerDropshipListingPriceRoutes(app: Express,
  service: Pick<DropshipListingPriceService, "getForMember" | "saveForMember"> = createDropshipListingPriceService()): void {
  const path = "/api/dropship/listings/stores/:storeConnectionId/variants/:productVariantId/price";
  const limiter = rateLimit({ windowMs: 60_000, max: 60, keyGenerator: (req) => req.session.dropship!.memberId,
    standardHeaders: true, legacyHeaders: false,
    message: { error: { code: "DROPSHIP_LISTING_PRICE_RATE_LIMITED", message: "Too many price saves. Please try again in a minute." } } });
  app.get(path, requireDropshipAuth, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const price = await service.getForMember(req.session.dropship!.memberId, targetFromParams(req.params));
      const output = listingPriceResponseSchema.safeParse({ price });
      if (!output.success) throw new Error("Listing-price response failed its contract.");
      return res.json(output.data);
    } catch (error) { return respondError(res, error); }
  });
  app.put(path, requireDropshipAuth, limiter, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const result = await service.saveForMember(req.session.dropship!.memberId, targetFromParams(req.params), req.body);
      const output = saveListingPriceResponseSchema.safeParse(result);
      if (!output.success) throw new Error("Listing-price save response failed its contract.");
      return res.json(output.data);
    } catch (error) { return respondError(res, error); }
  });
}
function targetFromParams(params: Record<string, string>): { storeConnectionId: number; productVariantId: number } {
  // Reject shorthand numbers, scientific notation, and partially parsed ids.
  return { storeConnectionId: /^\d+$/.test(params.storeConnectionId) ? Number(params.storeConnectionId) : NaN,
    productVariantId: /^\d+$/.test(params.productVariantId) ? Number(params.productVariantId) : NaN };
}
function respondError(res: Response, error: unknown): Response {
  if (error instanceof ZodError) return res.status(400).json({ error: { code: "DROPSHIP_LISTING_PRICE_INVALID_INPUT", message: "Enter a valid listing price and reload if this page is out of date." } });
  if (error instanceof DropshipError) {
    const status = error.code === "DROPSHIP_AUTH_REQUIRED" ? 401
      : error.code === "DROPSHIP_PRICING_RULES_NOT_CONFIGURED" ? 422
      : ["DROPSHIP_STORE_CONNECTION_REQUIRED", "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE"].includes(error.code) ? 404
        : ["DROPSHIP_IDEMPOTENCY_CONFLICT", "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT"].includes(error.code) ? 409
          : ["DROPSHIP_LISTING_VENDOR_BLOCKED", "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", "DROPSHIP_LISTING_STORE_BLOCKED"].includes(error.code) ? 403 : 500;
    console[status >= 500 ? "error" : "warn"](JSON.stringify({ code: error.code, message: "Listing-price request rejected.", context: error.context }));
    return res.status(status).json({ error: { code: error.code, message: error.message } });
  }
  console.error(JSON.stringify({ code: "DROPSHIP_LISTING_PRICE_INTERNAL_ERROR", message: "Listing-price request failed.", error: error instanceof Error ? error.message : String(error) }));
  return res.status(500).json({ error: { code: "DROPSHIP_LISTING_PRICE_INTERNAL_ERROR", message: "The price could not be saved or loaded. Please retry." } });
}
