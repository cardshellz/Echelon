import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { z, ZodError } from "zod";
import { pricingProfileStateSchema, pricingReviewResponseSchema } from "../../../../../shared/dropship/pricing-rules";
import type { DropshipPricingRulesService } from "../../application/dropship-pricing-rules-service";
import { createDropshipPricingRulesService } from "../../infrastructure/dropship-pricing-rules.factory";
import { DropshipError } from "../../domain/errors";
import { DROPSHIP_LISTING_GROUP_RULES_CLOSED } from "../../domain/older-group-rules-edit";
import { requireDropshipAuth } from "./dropship-auth.routes";
import { PRICING_RULES_TOO_LARGE_MESSAGE, parseDropshipBulkJsonFor } from "./dropship-bulk-json.middleware";
import { logDropshipRouteFailure } from "./dropship-route-failure-log";

export function registerDropshipPricingRulesRoutes(app: Express,
  service: Pick<DropshipPricingRulesService, "getForMember" | "reviewForMember" | "reviewPageForMember" | "applyForMember"> = createDropshipPricingRulesService()): void {
  const path = "/api/dropship/listings/stores/:storeConnectionId/pricing-rules";
  const limiter = rateLimit({ windowMs: 60_000, max: 30, keyGenerator: (req) => req.session.dropship!.memberId,
    standardHeaders: true, legacyHeaders: false,
    message: { error: { code: "DROPSHIP_PRICING_RATE_LIMITED", message: "Too many pricing requests. Retry in a minute." } } });
  app.get(path, requireDropshipAuth, async (req, res) => respond(req, res, async () =>
    validateOutput(pricingProfileStateSchema, await service.getForMember(req.session.dropship!.memberId, parseId(req.params.storeConnectionId)))));
  // A rule set with long lists of single sizes can pass the 100 KB global limit; this route parses up to 1 MiB after auth.
  app.post(`${path}/reviews`, requireDropshipAuth, limiter, parseDropshipBulkJsonFor(PRICING_RULES_TOO_LARGE_MESSAGE), async (req, res) => respond(req, res, async () =>
    validateOutput(pricingReviewResponseSchema, await service.reviewForMember(req.session.dropship!.memberId, parseId(req.params.storeConnectionId), req.body))));
  app.get(`${path}/reviews/:reviewId`, requireDropshipAuth, async (req, res) => respond(req, res, async () =>
    validateOutput(pricingReviewResponseSchema, await service.reviewPageForMember(req.session.dropship!.memberId, parseId(req.params.storeConnectionId),
      req.params.reviewId, parsePage(req.query.page)))));
  app.post(`${path}/apply`, requireDropshipAuth, limiter, async (req, res) => respond(req, res, async () =>
    validateOutput(z.object({ revisionId: z.number().int().positive(), idempotentReplay: z.boolean() }).strict(),
      await service.applyForMember(req.session.dropship!.memberId, parseId(req.params.storeConnectionId), req.body))));
}
function validateOutput(schema: z.ZodTypeAny, value: unknown): unknown {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Pricing response failed its output contract.");
  return parsed.data;
}
function parseId(value: string): number { return /^[1-9]\d*$/.test(value) ? Number(value) : NaN; }
function parsePage(value: unknown): number { return value === undefined ? 0 : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN; }
async function respond(req: Request, res: Response, operation: () => Promise<unknown>): Promise<Response> {
  res.setHeader("Cache-Control", "no-store");
  try { return res.json(await operation()); }
  catch (error) {
    const failed = (status: number, code: string, message: string) => {
      logDropshipRouteFailure("dropship.pricing_rules", req, { status, code, error, storeConnectionId: parseId(req.params.storeConnectionId ?? "") });
      return res.status(status).json({ error: { code, message } });
    };
    if (error instanceof ZodError) return failed(400, "DROPSHIP_PRICING_INVALID_INPUT", "Check the pricing rule values and reload if this page is out of date.");
    if (error instanceof DropshipError) {
      const status = error.code === "DROPSHIP_AUTH_REQUIRED" ? 401 : error.code === "DROPSHIP_PRICING_NOT_ALLOWED" ? 403
        : ["DROPSHIP_STORE_CONNECTION_REQUIRED", "DROPSHIP_PRICING_REVIEW_NOT_FOUND"].includes(error.code) ? 404
          : ["DROPSHIP_PRICING_REVIEW_STALE", "DROPSHIP_IDEMPOTENCY_CONFLICT"].includes(error.code) ? 409
            : ["DROPSHIP_PRICING_REVIEW_BLOCKED", "DROPSHIP_PRICING_REVIEW_TOO_LARGE", DROPSHIP_LISTING_GROUP_RULES_CLOSED].includes(error.code) ? 422 : 500;
      return failed(status, error.code, error.message);
    }
    return failed(500, "DROPSHIP_PRICING_INTERNAL_ERROR", "Pricing rules could not be loaded or applied. Retry the same action to confirm its outcome.");
  }
}
