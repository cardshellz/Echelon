import type { Express, Response } from "express";
import rateLimit from "express-rate-limit";
import { ZodError, z } from "zod";
import { catalogTargetsResponseSchema } from "../../../../../shared/dropship/catalog-scope";
import { contentProfileStateSchema, listingContentResponseSchema, saveContentProfileResponseSchema, saveListingContentResponseSchema } from "../../../../../shared/dropship/listing-content";
import type { DropshipListingContentService } from "../../application/dropship-listing-content-service";
import { createDropshipListingContentService } from "../../infrastructure/dropship-listing-content.factory";
import { DropshipError } from "../../domain/errors";
import { requireDropshipAuth } from "./dropship-auth.routes";

export function registerDropshipListingContentRoutes(app: Express,
  service: Pick<DropshipListingContentService, "getProfile" | "saveProfile" | "getForMember" | "previewForMember" | "saveForMember" | "targetsForMember"> = createDropshipListingContentService()): void {
  const base = "/api/dropship/listings/stores/:storeConnectionId";
  const limiter = rateLimit({ windowMs: 60_000, max: 60, keyGenerator: (req) => req.session.dropship!.memberId,
    standardHeaders: true, legacyHeaders: false, message: { error: { code: "DROPSHIP_CONTENT_RATE_LIMITED", message: "Too many description requests. Try again in a minute." } } });
  app.get(`${base}/content-profile`, requireDropshipAuth, limiter, async (req, res) => respond(res, contentProfileStateSchema,
    () => service.getProfile(req.session.dropship!.memberId, parseId(req.params.storeConnectionId))));
  app.get(`${base}/content-profile/targets`, requireDropshipAuth, limiter, async (req, res) => respond(res, catalogTargetsResponseSchema,
    () => service.targetsForMember(req.session.dropship!.memberId, parseId(req.params.storeConnectionId),
      { type: req.query.type, search: req.query.search ?? "", page: req.query.page === undefined ? 0 : parseId(String(req.query.page)) })));
  app.put(`${base}/content-profile`, requireDropshipAuth, limiter, async (req, res) => respond(res, saveContentProfileResponseSchema,
    () => service.saveProfile(req.session.dropship!.memberId, parseId(req.params.storeConnectionId), req.body)));
  const path = `${base}/variants/:productVariantId/content`;
  app.get(path, requireDropshipAuth, limiter, async (req, res) => respond(res, listingContentResponseSchema,
    async () => ({ content: await service.getForMember(req.session.dropship!.memberId, target(req.params)) })));
  app.post(`${path}/preview`, requireDropshipAuth, limiter, async (req, res) => respond(res, listingContentResponseSchema,
    async () => ({ content: await service.previewForMember(req.session.dropship!.memberId, target(req.params), req.body) })));
  app.put(path, requireDropshipAuth, limiter, async (req, res) => respond(res, saveListingContentResponseSchema,
    () => service.saveForMember(req.session.dropship!.memberId, target(req.params), req.body)));
}
function parseId(value: string): number { return /^\d+$/.test(value) ? Number(value) : NaN; }
function target(params: Record<string, string>) { return { storeConnectionId: parseId(params.storeConnectionId), productVariantId: parseId(params.productVariantId) }; }
async function respond<T>(res: Response, schema: z.ZodType<T>, operation: () => Promise<unknown>): Promise<Response> {
  res.setHeader("Cache-Control", "no-store");
  try {
    const result = await operation();
    const output = schema.safeParse(result);
    if (!output.success) throw new Error("Content response failed its contract.");
    return res.json(output.data);
  } catch (error) {
    const status = error instanceof ZodError ? 400 : error instanceof DropshipError ?
      error.code === "DROPSHIP_AUTH_REQUIRED" ? 401 : error.code === "DROPSHIP_CONTENT_NOT_ALLOWED" ? 403
      : error.code === "DROPSHIP_CATALOG_TARGETS_TOO_LARGE" ? 422
      : ["DROPSHIP_STORE_CONNECTION_REQUIRED", "DROPSHIP_CONTENT_NOT_AVAILABLE"].includes(error.code) ? 404
      : ["DROPSHIP_IDEMPOTENCY_CONFLICT", "DROPSHIP_CONTENT_VERSION_CONFLICT"].includes(error.code) ? 409 : 500 : 500;
    const code = error instanceof DropshipError ? error.code : status === 400 ? "DROPSHIP_CONTENT_INVALID_INPUT" : "DROPSHIP_CONTENT_INTERNAL_ERROR";
    console[status >= 500 ? "error" : "warn"](JSON.stringify({ code, message: "Content request failed.", error: status >= 500 && error instanceof Error ? error.message : undefined }));
    return res.status(status).json({ error: { code, message: error instanceof DropshipError ? error.message
      : status === 400 ? "Check the description fields and reload if the draft is out of date." : "Descriptions could not be loaded or saved. Please retry." } });
  }
}
