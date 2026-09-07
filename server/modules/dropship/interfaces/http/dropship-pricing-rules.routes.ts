import type { Express, Response } from "express";
import rateLimit from "express-rate-limit";
import { z, ZodError } from "zod";
import { pricingProfileStateSchema, pricingReviewResponseSchema, pricingTargetsResponseSchema } from "../../../../../shared/dropship/pricing-rules";
import type { DropshipPricingRulesService } from "../../application/dropship-pricing-rules-service";
import { createDropshipPricingRulesService } from "../../infrastructure/dropship-pricing-rules.factory";
import { DropshipError } from "../../domain/errors";
import { requireDropshipAuth } from "./dropship-auth.routes";

export function registerDropshipPricingRulesRoutes(app: Express,
  service: Pick<DropshipPricingRulesService, "getForMember" | "reviewForMember" | "reviewPageForMember" | "applyForMember" | "targetsForMember"> = createDropshipPricingRulesService()): void {
  const path = "/api/dropship/listings/stores/:storeConnectionId/pricing-rules";
  const limiter = rateLimit({ windowMs: 60_000, max: 30, keyGenerator: (req) => req.session.dropship!.memberId,
    standardHeaders: true, legacyHeaders: false,
    message: { error: { code: "DROPSHIP_PRICING_RATE_LIMITED", message: "Too many pricing requests. Retry in a minute." } } });
  app.get(path, requireDropshipAuth, async (req, res) => respond(res, async () =>
    validateOutput(pricingProfileStateSchema, await service.getForMember(req.session.dropship!.memberId, parseId(req.params.storeConnectionId)))));
  app.get(`${path}/targets`, requireDropshipAuth, limiter, async (req, res) => respond(res, async () =>
    validateOutput(pricingTargetsResponseSchema, await service.targetsForMember(req.session.dropship!.memberId, parseId(req.params.storeConnectionId), {
      type: req.query.type, search: req.query.search ?? "", page: parsePage(req.query.page),
    }))));
  app.post(`${path}/reviews`, requireDropshipAuth, limiter, async (req, res) => respond(res, async () =>
    validateOutput(pricingReviewResponseSchema, await service.reviewForMember(req.session.dropship!.memberId, parseId(req.params.storeConnectionId), req.body))));
  app.get(`${path}/reviews/:reviewId`, requireDropshipAuth, async (req, res) => respond(res, async () =>
    validateOutput(pricingReviewResponseSchema, await service.reviewPageForMember(req.session.dropship!.memberId, parseId(req.params.storeConnectionId),
      req.params.reviewId, parsePage(req.query.page)))));
  app.post(`${path}/apply`, requireDropshipAuth, limiter, async (req, res) => respond(res, async () =>
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
async function respond(res: Response, operation: () => Promise<unknown>): Promise<Response> {
  res.setHeader("Cache-Control", "no-store");
  try { return res.json(await operation()); }
  catch (error) {
    if (error instanceof ZodError) return res.status(400).json({ error: { code: "DROPSHIP_PRICING_INVALID_INPUT", message: "Check the pricing rule values and reload if this page is out of date." } });
    if (error instanceof DropshipError) {
      const status = error.code === "DROPSHIP_AUTH_REQUIRED" ? 401 : error.code === "DROPSHIP_PRICING_NOT_ALLOWED" ? 403
        : ["DROPSHIP_STORE_CONNECTION_REQUIRED", "DROPSHIP_PRICING_REVIEW_NOT_FOUND"].includes(error.code) ? 404
          : ["DROPSHIP_PRICING_REVIEW_STALE", "DROPSHIP_IDEMPOTENCY_CONFLICT"].includes(error.code) ? 409
            : ["DROPSHIP_PRICING_REVIEW_BLOCKED", "DROPSHIP_PRICING_REVIEW_TOO_LARGE"].includes(error.code) ? 422 : 500;
      console.warn(JSON.stringify({ code: error.code, message: "Pricing-rule request rejected.", context: error.context }));
      return res.status(status).json({ error: { code: error.code, message: error.message } });
    }
    console.error(JSON.stringify({ code: "DROPSHIP_PRICING_INTERNAL_ERROR", message: "Pricing-rule operation failed.",
      error: error instanceof Error ? error.message : "Unknown error" }));
    return res.status(500).json({ error: { code: "DROPSHIP_PRICING_INTERNAL_ERROR", message: "Pricing rules could not be loaded or applied. Retry the same action to confirm its outcome." } });
  }
}
