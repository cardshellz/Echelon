import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express, type Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipEbayCategoryRulesService } from "../../application/dropship-ebay-category-rules-service";
import type { DropshipListingContentService } from "../../application/dropship-listing-content-service";
import type { DropshipPricingRulesService } from "../../application/dropship-pricing-rules-service";
import { DropshipError } from "../../domain/errors";
import { DROPSHIP_LISTING_GROUP_RULES_CLOSED, GROUP_RULES_CLOSED_MESSAGE, olderGroupRulesClosed } from "../../domain/older-group-rules-edit";
import { logger } from "../../../../platform/observability/logger";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
vi.mock("../../infrastructure/dropship-ebay-category-rules.factory", () => ({ createDropshipEbayCategoryRulesServiceFromEnv: vi.fn() }));
vi.mock("../../../../platform/observability/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { registerDropshipEbayCategoryRulesRoutes } from "../../interfaces/http/dropship-ebay-category-rules.routes";
import { registerDropshipListingContentRoutes } from "../../interfaces/http/dropship-listing-content.routes";
import { registerDropshipPricingRulesRoutes } from "../../interfaces/http/dropship-pricing-rules.routes";
import { dropshipRouteErrorClass, logDropshipRouteFailure } from "../../interfaces/http/dropship-route-failure-log";

/**
 * Listing settings PR 12 (plan D11, 6.4 T5): the group-rule refusal answers 422 on all three writer routes, with each
 * route's own body (pricing and content `{ code, message }`; eBay its public context allow-list), and the pricing and
 * content routes now log through the platform logger with the eBay route's entry, never `console.*`. The refusal's
 * line also names the ids it refused (review MC1, CLAUDE.md §10): which group a request tried to add or change, and
 * whether it reordered the eBay rules. Ids only; every other code logs no context.
 */

const MEMBER = "member-1";
const PROFILE = { defaultRecipe: { basis: "product_cost", markupBps: 3_000, flatCents: 100, rounding: "cent" }, groups: [] };
const EDIT = { allowed: false, addedIds: ["new"], changedIds: ["kept"], reordered: false };
/** The eBay route's entry fields since PR 9b (dropship-ebay-category-rules.routes.ts), in a stable order. */
const ENTRY_FIELDS = ["actor_id", "error_class", "error_code", "error_message", "method", "outcome", "path", "status", "store_connection_id"];
/** The group-rule refusal's line adds these, and only these, to the entry. */
const GROUP_RULE_FIELDS = ["added_ids", "changed_ids", "group_rules_kind", "reordered"];
const REFUSAL_FIELDS = [...ENTRY_FIELDS, ...GROUP_RULE_FIELDS].sort();

interface Running { url: string; close: () => Promise<void> }

async function start(register: (app: Express) => void): Promise<Running> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { dropship: { memberId: MEMBER } } as unknown as Request["session"];
    next();
  });
  register(app);
  const server = http.createServer(app);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dropship/listings/stores/22`,
    close: () => new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())),
  };
}

const send = (url: string, method: string, body: unknown) => fetch(url, { method, headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body) });

/** The one logger line a request wrote, with its level. */
function onlyLogLine(): { level: "info" | "warn" | "error"; action: string; entry: Record<string, unknown> } {
  const lines = (["info", "warn", "error"] as const).flatMap((level) =>
    vi.mocked(logger[level]).mock.calls.map(([action, entry]) => ({ level, action, entry: entry as Record<string, unknown> })));
  expect(lines).toHaveLength(1);
  return lines[0];
}

describe("the group-rule refusal on the three writer routes", () => {
  let running: Running | null = null;
  const consoleSpies = (["log", "info", "warn", "error"] as const).map((method) => vi.spyOn(console, method));
  const refused = () => olderGroupRulesClosed(22, "pricing", EDIT);

  beforeEach(() => {
    vi.clearAllMocks();
    running = null;
  });
  afterEach(async () => {
    await running?.close();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  function pricingService(failure: () => unknown) {
    const fail = async () => { throw failure(); };
    return { getForMember: vi.fn(fail), reviewForMember: vi.fn(fail), reviewPageForMember: vi.fn(fail), applyForMember: vi.fn(fail) } as
      unknown as Pick<DropshipPricingRulesService, "getForMember" | "reviewForMember" | "reviewPageForMember" | "applyForMember">;
  }
  function contentService(failure: () => unknown) {
    const fail = async () => { throw failure(); };
    return { getProfile: vi.fn(fail), saveProfile: vi.fn(fail), getForMember: vi.fn(fail), previewForMember: vi.fn(fail), saveForMember: vi.fn(fail) } as
      unknown as Pick<DropshipListingContentService, "getProfile" | "saveProfile" | "getForMember" | "previewForMember" | "saveForMember">;
  }
  function ebayService(failure: () => unknown) {
    const fail = async () => { throw failure(); };
    return { getForMember: vi.fn(fail), searchForMember: vi.fn(fail), browseForMember: vi.fn(fail), describeForMember: vi.fn(fail),
      reviewForMember: vi.fn(fail), saveForMember: vi.fn(fail) } as unknown as DropshipEbayCategoryRulesService;
  }

  it("pricing: a refused review or apply is a 422 with the code and words only, and one INFO line", async () => {
    running = await start((app) => registerDropshipPricingRulesRoutes(app, pricingService(refused)));
    const response = await send(`${running.url}/pricing-rules/reviews`, "POST", { expectedRevisionId: 3, profile: PROFILE, releaseFixedOverrides: false });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { code: DROPSHIP_LISTING_GROUP_RULES_CLOSED, message: GROUP_RULES_CLOSED_MESSAGE } });
    const line = onlyLogLine();
    expect(line).toEqual({ level: "info", action: "dropship.pricing_rules.request_refused", entry: { outcome: "failed",
      error_code: DROPSHIP_LISTING_GROUP_RULES_CLOSED, status: 422, method: "POST",
      path: "/api/dropship/listings/stores/:storeConnectionId/pricing-rules/reviews", store_connection_id: 22, actor_id: MEMBER,
      error_class: "permanent", error_message: undefined,
      group_rules_kind: "pricing", added_ids: ["new"], changed_ids: ["kept"], reordered: false } });
    expect(Object.keys(line.entry).sort()).toEqual(REFUSAL_FIELDS);

    vi.clearAllMocks();
    const applied = await send(`${running.url}/pricing-rules/apply`, "POST", { reviewId: "4e2f7a0c-3b8d-4f6e-9a1c-2d5b7e9f0a13",
      reviewHash: "a".repeat(64), idempotencyKey: "ls-apply:1" });
    expect(applied.status).toBe(422);
    expect(onlyLogLine()).toMatchObject({ level: "info", entry: { error_code: DROPSHIP_LISTING_GROUP_RULES_CLOSED, status: 422,
      group_rules_kind: "pricing", added_ids: ["new"], changed_ids: ["kept"], reordered: false } });
  });

  it("content: a refused templates save is a 422 with the code and words only, and one INFO line", async () => {
    running = await start((app) => registerDropshipListingContentRoutes(app, contentService(() => olderGroupRulesClosed(22, "description", EDIT))));
    const response = await send(`${running.url}/content-profile`, "PUT", { expectedRevisionId: 5, idempotencyKey: "ls-text:1",
      profile: { defaultTemplate: { introduction: "", footer: "" }, groups: [] } });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { code: DROPSHIP_LISTING_GROUP_RULES_CLOSED, message: GROUP_RULES_CLOSED_MESSAGE } });
    const line = onlyLogLine();
    expect(line).toEqual({ level: "info", action: "dropship.listing_content.request_refused", entry: { outcome: "failed",
      error_code: DROPSHIP_LISTING_GROUP_RULES_CLOSED, status: 422, method: "PUT",
      path: "/api/dropship/listings/stores/:storeConnectionId/content-profile", store_connection_id: 22, actor_id: MEMBER,
      error_class: "permanent", error_message: undefined,
      group_rules_kind: "description", added_ids: ["new"], changed_ids: ["kept"], reordered: false } });
    expect(Object.keys(line.entry).sort()).toEqual(REFUSAL_FIELDS);
  });

  it("eBay: a refused save is a 422 whose body keeps the allow-list (store and retryable, no ids), with the same entry", async () => {
    running = await start((app) => registerDropshipEbayCategoryRulesRoutes(app, ebayService(() =>
      olderGroupRulesClosed(22, "ebay_category", { ...EDIT, reordered: true }))));
    const response = await send(`${running.url}/ebay-category-rules`, "PUT", { expectedRevisionId: 7, idempotencyKey: "ls-category:1",
      draft: { defaultCategoryId: null, rules: [] } });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { code: DROPSHIP_LISTING_GROUP_RULES_CLOSED, message: GROUP_RULES_CLOSED_MESSAGE,
      context: { storeConnectionId: 22, retryable: false } } });
    const line = onlyLogLine();
    expect(line).toMatchObject({ level: "info", action: "dropship.ebay_category_rules.request_refused",
      entry: { error_code: DROPSHIP_LISTING_GROUP_RULES_CLOSED, status: 422, store_connection_id: 22, actor_id: MEMBER, error_class: "permanent",
        group_rules_kind: "ebay_category", added_ids: ["new"], changed_ids: ["kept"], reordered: true } });
    expect(Object.keys(line.entry).sort()).toEqual(REFUSAL_FIELDS);
  });

  it("logs the refusal's ids only when they are ids: an unreadable context logs nulls, never its text", () => {
    const req = { method: "PUT", path: "/x", route: { path: "/api/dropship/listings/stores/:storeConnectionId/content-profile" },
      session: { dropship: { memberId: MEMBER } } } as unknown as Request;
    for (const context of [
      { kind: "description", addedIds: ["Free text with spaces"], changedIds: [], reordered: false },
      { kind: "colours", addedIds: [], changedIds: [], reordered: false },
      { kind: "pricing", addedIds: "new", changedIds: [], reordered: false },
      { kind: "pricing", addedIds: Array.from({ length: 101 }, (_, index) => `g${index}`), changedIds: [], reordered: false },
      {},
    ]) {
      vi.clearAllMocks();
      logDropshipRouteFailure("dropship.listing_content", req, { status: 422, code: DROPSHIP_LISTING_GROUP_RULES_CLOSED, storeConnectionId: 22,
        error: new DropshipError(DROPSHIP_LISTING_GROUP_RULES_CLOSED, GROUP_RULES_CLOSED_MESSAGE, context) });
      const line = onlyLogLine();
      expect(line.entry).toMatchObject({ group_rules_kind: null, added_ids: null, changed_ids: null, reordered: null });
      expect(Object.keys(line.entry).sort()).toEqual(REFUSAL_FIELDS);
      expect(JSON.stringify(line.entry)).not.toContain("Free text");
    }
  });

  it.each([
    ["pricing", "dropship.pricing_rules", "DROPSHIP_PRICING_INTERNAL_ERROR", "/pricing-rules"],
    ["content", "dropship.listing_content", "DROPSHIP_CONTENT_INTERNAL_ERROR", "/content-profile"],
  ])("%s: a fatal failure is one ERROR line with its message, and the answer hides it", async (route, scope, code, path) => {
    const failure = () => new Error("pg connection reset by peer");
    running = await start((app) => route === "pricing"
      ? registerDropshipPricingRulesRoutes(app, pricingService(failure))
      : registerDropshipListingContentRoutes(app, contentService(failure)));
    const response = await fetch(`${running.url}${path}`);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.code).toBe(code);
    expect(JSON.stringify(body)).not.toContain("pg connection");
    expect(onlyLogLine()).toEqual({ level: "error", action: `${scope}.request_failed`, entry: expect.objectContaining({
      error_code: code, status: 500, method: "GET", store_connection_id: 22, actor_id: MEMBER, error_class: "fatal",
      error_message: "pg connection reset by peer" }) });
  });

  it.each([
    ["pricing", "dropship.pricing_rules", "/pricing-rules"],
    ["content", "dropship.listing_content", "/content-profile"],
  ])("%s: an ordinary refusal (409) is an INFO line too, with no context in the log", async (route, scope, path) => {
    const failure = () => new DropshipError(route === "pricing" ? "DROPSHIP_PRICING_REVIEW_STALE" : "DROPSHIP_CONTENT_VERSION_CONFLICT",
      "Reload.", { secretish: "provider words" });
    running = await start((app) => route === "pricing"
      ? registerDropshipPricingRulesRoutes(app, pricingService(failure))
      : registerDropshipListingContentRoutes(app, contentService(failure)));
    expect((await fetch(`${running.url}${path}`)).status).toBe(409);
    const line = onlyLogLine();
    expect(line).toMatchObject({ level: "info", action: `${scope}.request_refused`, entry: { status: 409, error_class: "permanent" } });
    expect(JSON.stringify(line.entry)).not.toContain("provider words");
    // Only the group-rule refusal adds fields; every other code keeps the eBay route's entry exactly.
    expect(Object.keys(line.entry).sort()).toEqual(ENTRY_FIELDS);
  });

  it("classifies a 502 or 503 as transient (one WARN line), a 500 as fatal and every other status as a refusal", () => {
    expect([400, 401, 403, 404, 409, 413, 422, 429].map(dropshipRouteErrorClass)).toEqual(Array(8).fill("permanent"));
    expect([502, 503].map(dropshipRouteErrorClass)).toEqual(["transient", "transient"]);
    expect([500, 504].map(dropshipRouteErrorClass)).toEqual(["fatal", "fatal"]);
    // No status either moved route maps is 502/503 today, so the transient line is shown through the shared writer.
    const req = { method: "GET", path: "/x", route: { path: "/api/dropship/listings/stores/:storeConnectionId/pricing-rules" },
      session: { dropship: { memberId: MEMBER } } } as unknown as Request;
    logDropshipRouteFailure("dropship.pricing_rules", req, { status: 503, code: "DROPSHIP_SOMETHING_UNAVAILABLE", storeConnectionId: Number.NaN,
      error: new Error("not logged for a transient failure") });
    expect(onlyLogLine()).toEqual({ level: "warn", action: "dropship.pricing_rules.request_failed", entry: { outcome: "failed",
      error_code: "DROPSHIP_SOMETHING_UNAVAILABLE", status: 503, method: "GET", path: "/api/dropship/listings/stores/:storeConnectionId/pricing-rules",
      store_connection_id: null, actor_id: MEMBER, error_class: "transient", error_message: undefined } });
  });
});
