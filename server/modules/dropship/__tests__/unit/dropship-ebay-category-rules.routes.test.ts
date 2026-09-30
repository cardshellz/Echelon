import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { DropshipEbayCategoryRulesService } from "../../application/dropship-ebay-category-rules-service";
import { DropshipError } from "../../domain/errors";
import { registerDropshipEbayCategoryRulesRoutes } from "../../interfaces/http/dropship-ebay-category-rules.routes";
import { DROPSHIP_BULK_JSON_LIMIT_BYTES } from "../../interfaces/http/dropship-bulk-json.middleware";
import { installGlobalJsonBodyParser } from "../../../shipping-engine/interfaces/http/rate-table-admin-body.middleware";
import { logger } from "../../../../platform/observability/logger";
import { SLEEVES, categoryOption, rulesProfile, rulesState } from "../fixtures/ebay-category-rules.fixture";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../infrastructure/dropship-ebay-category-rules.factory", () => ({
  createDropshipEbayCategoryRulesServiceFromEnv: vi.fn(),
}));
vi.mock("../../../../platform/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const review = {
  expectedRevisionId: null, selectedCount: 1, changedCount: 1, unchangedCount: 0, withoutCategoryBefore: 1, withoutCategoryAfter: 0,
  bySource: { rule: 0, store_default: 1, catalog: 0, none: 0 }, byRule: [],
  byCategory: [{ categoryId: SLEEVES.categoryId, categoryName: "Sleeves", count: 1 }], otherCategoriesCount: 0, changes: [],
};

class FakeService {
  calls: Array<{ method: string; memberId: string; storeId: unknown; input?: unknown }> = [];
  failure: unknown = null;
  stateResult: unknown = rulesState(rulesProfile({ defaultCategory: SLEEVES }));

  private record(method: string, memberId: string, storeId: unknown, input?: unknown) {
    this.calls.push({ method, memberId, storeId, input });
    if (this.failure) throw this.failure;
  }
  async getForMember(memberId: string, storeId: unknown) { this.record("get", memberId, storeId); return this.stateResult; }
  async targetsForMember(memberId: string, storeId: unknown, input: unknown) { this.record("targets", memberId, storeId, input); return { total: 0, rows: [] }; }
  async searchForMember(memberId: string, storeId: unknown, query: unknown) { this.record("search", memberId, storeId, query); return { categories: [categoryOption(SLEEVES)] }; }
  async browseForMember(memberId: string, storeId: unknown, parentId: unknown) { this.record("browse", memberId, storeId, parentId); return { parent: null, children: [] }; }
  async describeForMember(memberId: string, storeId: unknown, categoryId: unknown) { this.record("describe", memberId, storeId, categoryId); return { category: categoryOption(SLEEVES) }; }
  async reviewForMember(memberId: string, storeId: unknown, input: unknown) { this.record("review", memberId, storeId, input); return review; }
  async saveForMember(memberId: string, storeId: unknown, input: unknown) { this.record("save", memberId, storeId, input); return { state: this.stateResult, idempotentReplay: false }; }
}

describe("dropship eBay category rules routes", () => {
  let service: FakeService;
  let server: { url: string; close: () => Promise<void> } | null;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new FakeService();
    server = null;
  });
  afterEach(async () => {
    await server?.close();
  });

  it("reads the member's rules with no caching", async () => {
    server = await startServer(buildApp(service, true));
    const response = await fetch(`${server.url}/api/dropship/listings/stores/44/ebay-category-rules`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ revisionId: 7, profile: { defaultCategory: { categoryId: SLEEVES.categoryId } } });
    expect(service.calls).toEqual([{ method: "get", memberId: "member-1", storeId: 44, input: undefined }]);
  });

  it("refuses every route without a dropship session", async () => {
    server = await startServer(buildApp(service, false));
    for (const path of ["ebay-category-rules", "ebay-categories/search?q=toploader", "ebay-categories", "ebay-categories/100"]) {
      const response = await fetch(`${server.url}/api/dropship/listings/stores/44/${path}`);
      expect(response.status).toBe(401);
    }
    expect(service.calls).toEqual([]);
  });

  it("parses a full rule set (100 named rules, 10,000 listings) that the global 100 KB limit would refuse", async () => {
    server = await startServer(buildApp(service, true));
    const body = {
      expectedRevisionId: null, idempotencyKey: "category-rules:1",
      draft: { defaultCategoryId: null, rules: Array.from({ length: 100 }, (_, rule) => ({
        id: `rule-${rule}-${"r".repeat(60)}`, name: `Rule ${rule} ${"n".repeat(110)}`, categoryId: SLEEVES.categoryId,
        scope: { type: "listings", productVariantIds: Array.from({ length: 100 }, (_, index) => 1_000_000 + rule * 100 + index) },
      })) },
    };
    const text = JSON.stringify(body);
    expect(text.length).toBeGreaterThan(100 * 1024);

    const response = await fetch(`${server.url}/api/dropship/listings/stores/44/ebay-category-rules`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: text,
    });

    expect(response.status).toBe(200);
    expect(service.calls[0]).toMatchObject({ method: "save", storeId: 44, input: body });
  });

  it("refuses a body over the bulk limit with a clear code", async () => {
    server = await startServer(buildApp(service, true));
    const response = await fetch(`${server.url}/api/dropship/listings/stores/44/ebay-category-rules/review`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(DROPSHIP_BULK_JSON_LIMIT_BYTES + 1) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "DROPSHIP_REQUEST_TOO_LARGE" } });
    expect(service.calls).toEqual([]);
  });

  it("routes search, browse and a numeric category lookup separately", async () => {
    server = await startServer(buildApp(service, true));
    const base = `${server.url}/api/dropship/listings/stores/44`;
    expect((await fetch(`${base}/ebay-categories/search?q=card%20sleeves`)).status).toBe(200);
    expect((await fetch(`${base}/ebay-categories?parentId=10`)).status).toBe(200);
    expect((await fetch(`${base}/ebay-categories/100`)).status).toBe(200);
    expect((await fetch(`${base}/ebay-categories/not-a-number`)).status).toBe(404);
    expect(service.calls.map((call) => [call.method, call.input])).toEqual([
      ["search", "card sleeves"], ["browse", "10"], ["describe", "100"],
    ]);
  });

  it.each([
    [new DropshipError("DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED", "Reconnect.", { storeConnectionId: 44, retryable: false }), 403],
    [new DropshipError("DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT", "Reload.", { storeConnectionId: 44 }), 409],
    [new DropshipError("DROPSHIP_EBAY_CATEGORY_RULE_INVALID", "Pick a leaf.", { categoryId: "10", ruleId: "a", reason: "not_leaf" }), 422],
    [new DropshipError("DROPSHIP_EBAY_CATEGORY_NOT_FOUND", "Unknown.", { categoryId: "999" }), 404],
    [new DropshipError("DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE", "Down.", { retryable: true, status: 503 }), 502],
    [new DropshipError("DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", "Refresh failed.", { retryable: true }), 503],
  ])("maps %s to its status", async (error, status) => {
    service.failure = error;
    server = await startServer(buildApp(service, true));
    const response = await fetch(`${server.url}/api/dropship/listings/stores/44/ebay-categories/search?q=toploader`);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code: error.code, message: error.message } });
  });

  it("keeps provider detail and secrets out of public error context", async () => {
    service.failure = new DropshipError("DROPSHIP_EBAY_CATEGORIES_ACCESS_DENIED", "Denied.", {
      storeConnectionId: 44, status: 403, providerErrorIds: ["1100"], body: "provider-secret", accessToken: "token",
    });
    server = await startServer(buildApp(service, true));
    const response = await fetch(`${server.url}/api/dropship/listings/stores/44/ebay-categories?parentId=10`);
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body).toEqual({ error: { code: "DROPSHIP_EBAY_CATEGORIES_ACCESS_DENIED", message: "Denied.",
      context: { storeConnectionId: 44, status: 403, providerErrorIds: ["1100"] } } });
  });

  it("answers invalid input with 400 and unexpected failures with a generic 500", async () => {
    server = await startServer(buildApp(service, true));
    service.failure = new ZodError([{ code: "custom", path: ["draft"], message: "Bad draft." }]);
    const invalid = await fetch(`${server.url}/api/dropship/listings/stores/44/ebay-category-rules`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "DROPSHIP_EBAY_CATEGORY_RULES_INVALID_INPUT", context: { issues: [expect.objectContaining({ message: "Bad draft." })] } } });

    service.failure = new Error("pg connection string leaked");
    const crashed = await fetch(`${server.url}/api/dropship/listings/stores/44/ebay-category-rules`);
    expect(crashed.status).toBe(500);
    const body = await crashed.json();
    expect(body).toMatchObject({ error: { code: "DROPSHIP_EBAY_CATEGORY_RULES_INTERNAL_ERROR" } });
    expect(JSON.stringify(body)).not.toContain("pg connection");
  });

  it("logs each failure at its class's level with the store and member", async () => {
    server = await startServer(buildApp(service, true));
    const url = `${server.url}/api/dropship/listings/stores/44/ebay-categories/search?q=sleeves`;
    const correlation = { store_connection_id: 44, actor_id: "member-1", method: "GET" };

    service.failure = new DropshipError("DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED", "Reconnect the store.");
    expect((await fetch(url)).status).toBe(403);
    expect(logger.info).toHaveBeenCalledWith("dropship.ebay_category_rules.request_refused", expect.objectContaining({
      ...correlation, error_code: "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED", error_class: "permanent", status: 403 }));

    service.failure = new DropshipError("DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE", "Try again shortly.");
    expect((await fetch(url)).status).toBe(502);
    expect(logger.warn).toHaveBeenCalledWith("dropship.ebay_category_rules.request_failed", expect.objectContaining({
      ...correlation, error_code: "DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE", error_class: "transient", status: 502 }));

    service.failure = new Error("unexpected");
    expect((await fetch(url)).status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith("dropship.ebay_category_rules.request_failed", expect.objectContaining({
      ...correlation, error_code: "DROPSHIP_EBAY_CATEGORY_RULES_INTERNAL_ERROR", error_class: "fatal", status: 500 }));
  });

  it("refuses to send a response that breaks its contract", async () => {
    service.stateResult = { revisionId: "seven" };
    server = await startServer(buildApp(service, true));
    const response = await fetch(`${server.url}/api/dropship/listings/stores/44/ebay-category-rules`);
    expect(response.status).toBe(500);
  });
});

function buildApp(service: FakeService, authenticated: boolean): express.Express {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.session = (authenticated
      ? { dropship: { authIdentityId: 1, memberId: "member-1", cardShellzEmail: "vendor@cardshellz.test", hasPasskey: false,
        authMethod: "password", entitlementStatus: "active", authenticatedAt: "2026-09-30T12:00:00.000Z" }, dropshipSensitiveProofs: {} }
      : {}) as unknown as Request["session"];
    next();
  });
  installGlobalJsonBodyParser(app);
  registerDropshipEbayCategoryRulesRoutes(app, service as unknown as DropshipEbayCategoryRulesService);
  return app;
}

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const listener = http.createServer(app);
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())),
  };
}

