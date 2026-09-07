import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { reviewPricingRulesInputSchema, applyPricingRulesInputSchema, pricingTargetsInputSchema } from "../../../../../shared/dropship/pricing-rules";
import { DropshipError } from "../../domain/errors";
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
import { registerDropshipPricingRulesRoutes } from "../../interfaces/http/dropship-pricing-rules.routes";

const profile = { defaultRecipe: { basis: "product_cost" as const, markupBps: 3000, flatCents: 100, rounding: "cent" as const }, groups: [] };
const reviewInput = { profile, expectedRevisionId: null, releaseFixedOverrides: false };
const reviewId = "df41ecb0-2c9f-4d48-a24c-9f74d0d6b607";
const review = { reviewId, reviewHash: "a".repeat(64), createdAt: "2026-09-07T12:00:00Z", page: 0,
  rows: [], summary: { total: 0, changed: 0, preserved: 0, blocked: 0 } };
const applyInput = { reviewId, reviewHash: review.reviewHash, idempotencyKey: "apply-test" };
describe("store pricing HTTP contracts", () => {
  let server: http.Server; let url: string;
  const target = (value: unknown) => z.number().int().positive().max(2_147_483_647).parse(value);
  const service = {
    getForMember: vi.fn(async (_member: string, store: unknown) => { target(store); return { profile: null, revisionId: null, updatedAt: null }; }),
    reviewForMember: vi.fn(async (_member: string, store: unknown, body: unknown) => { target(store); reviewPricingRulesInputSchema.parse(body); return review; }),
    reviewPageForMember: vi.fn(async (_member: string, store: unknown, id: unknown, page: unknown) => { target(store); z.string().uuid().parse(id); z.number().int().nonnegative().parse(page); return review; }),
    applyForMember: vi.fn(async (_member: string, store: unknown, body: unknown) => { target(store); applyPricingRulesInputSchema.parse(body); return { revisionId: 1, idempotentReplay: false }; }),
    targetsForMember: vi.fn(async (_member: string, store: unknown, body: unknown) => { target(store); pricingTargetsInputSchema.parse(body); return { total: 0, rows: [] }; }),
  };
  beforeEach(async () => {
    vi.clearAllMocks(); const app = express(); app.use(express.json());
    app.use((req, _res, next) => { const memberId = req.header("X-Test-Member");
      req.session = { ...(memberId ? { dropship: { memberId } } : {}) } as Request["session"]; next(); });
    registerDropshipPricingRulesRoutes(app, service); server = http.createServer(app);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dropship/listings/stores/22/pricing-rules`;
  });
  afterEach(async () => new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())));
  function request(path = "", method = "GET", body?: unknown, member: string | null = "member-1") {
    return fetch(`${url}${path}`, { method, headers: { "Content-Type": "application/json", ...(member ? { "X-Test-Member": member } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  it.each([["", "GET"], ["/targets?type=category", "GET"], ["/reviews", "POST"], [`/reviews/${reviewId}`, "GET"], ["/apply", "POST"]])("requires auth for %s", async (path, method) => {
    expect((await request(path, method, method === "POST" ? {} : undefined, null)).status).toBe(401);
    expect(service.applyForMember).not.toHaveBeenCalled();
  });
  it("uses the authenticated member and disables caching", async () => {
    const result = await request("/reviews", "POST", reviewInput);
    expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual(review);
    expect(service.reviewForMember).toHaveBeenCalledWith("member-1", 22, reviewInput);
    expect((await request("/apply", "POST", applyInput)).status).toBe(200);
  });
  it.each([{ ...reviewInput, vendorId: 99 }, { ...reviewInput, profile: { ...profile, defaultRecipe: { ...profile.defaultRecipe, markupBps: -1 } } },
    { ...reviewInput, releaseFixedOverrides: undefined }])("rejects invalid rule input %j", async (body) => {
    expect((await request("/reviews", "POST", body)).status).toBe(400);
  });
  it.each([["DROPSHIP_PRICING_REVIEW_STALE", 409], ["DROPSHIP_IDEMPOTENCY_CONFLICT", 409], ["DROPSHIP_PRICING_REVIEW_BLOCKED", 422],
    ["DROPSHIP_PRICING_NOT_ALLOWED", 403], ["DROPSHIP_PRICING_REVIEW_NOT_FOUND", 404]])("classifies %s", async (code, status) => {
    service.applyForMember.mockRejectedValueOnce(new DropshipError(String(code), "Controlled failure."));
    expect((await request("/apply", "POST", applyInput)).status).toBe(status);
  });
  it("treats invalid service output as a server failure, not bad user input", async () => {
    service.getForMember.mockResolvedValueOnce({ profile: null, revisionId: -1, updatedAt: null } as never);
    expect((await request()).status).toBe(500);
  });
  it("never exposes raw source failures", async () => {
    service.getForMember.mockRejectedValueOnce(new Error("secret source details"));
    const response = await request(); expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });
});
