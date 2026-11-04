import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";

// Keep the real requireAuth middleware. Its Identity import would otherwise load
// the unrelated application database barrel. Current identity is synthetic here;
// command authority is independently tested in the owner suites.
// Resolve a current assigned identity through the real requireAuth middleware;
// capability outcomes remain controlled by this suite's separate permission mock.
vi.mock("../../../identity", () => ({ hasPermission: vi.fn(), readCurrentStaffAccess: vi.fn(async (userId: string) => ({
    user: { id: userId, username: "fixture", role: "picker", active: 1, displayName: null,
      createdAt: new Date(0), lastLoginAt: null },
    roles: [{ id: 101, name: "Fixture operator", isSystem: false }], permissions: [],
  })) }));
vi.mock("../../../../db", () => { throw new Error("Route-chain tests must not initialize the application database"); });

import { registerShopifyOAuthRoutes } from "../../../../routes/shopify-oauth.routes";
import type { ShopifyStaffOAuthService } from "../../application/shopify-staff-oauth.service";
import { ShopifyStaffOAuthError, type ShopifyStaffOAuthResult } from "../../shopify-staff-oauth.types";

const INSTALL = "/api/shopify/oauth/install";
const CALLBACK = "/api/shopify/oauth/callback";
const actorId = "synthetic-staff-user";
const sessionId = "synthetic-existing-session";
const operationId = "bb4df00c-cd47-49a2-9399-9708214079a4";
const authorizationUrl = "https://synthetic-shop.myshopify.com/admin/oauth/authorize?state=synthetic-state";

function captureResponse() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    ended: false,
    status(status: number) { this.statusCode = status; return this; },
    set(field: string | Record<string, string>, value?: string) {
      const entries = typeof field === "string" ? [[field, value ?? ""]] : Object.entries(field);
      for (const [key, entry] of entries) this.headers[key.toLowerCase()] = entry;
      return this;
    },
    type(value: string) { this.headers["content-type"] = value; return this; },
    json(value: unknown) { this.body = value; this.ended = true; return this; },
    send(value: unknown) { this.body = value; this.ended = true; return this; },
    end() { this.ended = true; return this; },
    redirect(location: string) {
      this.statusCode = 302;
      this.headers.location = location;
      this.ended = true;
      return this;
    },
  };
}

/** Execute every handler captured from the actual route registration, in order.
 * This is a mounted middleware-chain test, not an HTTP/browser test: no server,
 * socket, session store, provider or application database is created. HEAD is
 * dispatched through GET's registered chain to exercise Express's HEAD rule. */
function mount() {
  const registrations = new Map<string, RequestHandler[]>();
  const app = {
    get(path: string, ...handlers: RequestHandler[]) {
      if (registrations.has(path)) throw new Error("Duplicate OAuth route registration");
      registrations.set(path, handlers);
      return this;
    },
  };
  const begin = vi.fn<ShopifyStaffOAuthService["begin"]>().mockResolvedValue({
    authorizationUrl, operationId, channelId: 41, connectionId: 83,
    expiresAt: new Date("2026-11-03T20:10:00Z"),
  });
  const callback = vi.fn<ShopifyStaffOAuthService["callback"]>().mockResolvedValue({
    operationId, channelId: 41, connectionId: 83, status: "connected", replayed: false,
  });
  const resolve = vi.fn<() => Promise<ShopifyStaffOAuthService>>().mockResolvedValue({ begin, callback });
  registerShopifyOAuthRoutes(app as unknown as Express, resolve);

  async function dispatch(url: string, options: { authenticated?: boolean; method?: string; parsedQuery?: unknown } = {}) {
    const handlers = registrations.get(url.split("?")[0]);
    if (!handlers) throw new Error("Requested OAuth route was not registered");
    const req = {
      method: options.method ?? "GET", originalUrl: url, url,
      session: options.authenticated === false ? {} : { user: { id: actorId } },
      sessionID: sessionId,
      query: options.parsedQuery ?? {},
    } as unknown as Request;
    const captured = captureResponse();
    const res = captured as unknown as Response;
    async function invoke(index: number): Promise<void> {
      if (captured.ended) throw new Error("Middleware continued after a response ended");
      const handler = handlers![index];
      if (!handler) throw new Error("OAuth middleware chain ended without a response");
      let advanced = false;
      let nextWork: Promise<void> | undefined;
      let nextError: unknown;
      const next: NextFunction = (error?: unknown) => {
        if (advanced) throw new Error("Middleware called next twice");
        advanced = true;
        if (error !== undefined) nextError = error;
        else nextWork = invoke(index + 1);
      };
      await handler(req, res, next);
      if (nextError !== undefined) throw nextError;
      await nextWork;
    }
    await invoke(0);
    expect(captured.ended).toBe(true);
    return captured;
  }
  return { registrations, begin, callback, resolve, dispatch };
}

function expectPrivateResponse(response: ReturnType<typeof captureResponse>) {
  expect(response.headers).toMatchObject({
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden in route-chain tests"); }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("staff Shopify OAuth registered middleware chains (no HTTP server)", () => {
  it("retains both staff URLs and their complete registered chains", () => {
    const h = mount();
    expect([...h.registrations.keys()].sort()).toEqual([CALLBACK, INSTALL]);
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it.each([INSTALL, CALLBACK])("rejects an unauthenticated request to %s before resolving the owner", async path => {
    const h = mount();
    const response = await h.dispatch(path, { authenticated: false });
    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({ error: "Authentication required" });
    expectPrivateResponse(response);
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.callback).not.toHaveBeenCalled();
  });

  it.each([INSTALL, CALLBACK])("HEAD on %s cannot issue or consume authorization state", async path => {
    const h = mount();
    const response = await h.dispatch(`${path}?state=synthetic-private-state`, { method: "HEAD" });
    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe("GET");
    expect(response.body).toBeUndefined();
    expectPrivateResponse(response);
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.callback).not.toHaveBeenCalled();
  });

  it.each([
    { suffix: "", channel: undefined },
    { suffix: "?channelId=41", channel: 41 },
  ])("redirects an authenticated install with explicit owner identity $suffix", async ({ suffix, channel }) => {
    const h = mount();
    const response = await h.dispatch(`${INSTALL}${suffix}`);
    expect(h.resolve).toHaveBeenCalledTimes(1);
    expect(h.begin).toHaveBeenCalledExactlyOnceWith({ actorId, sessionId,
      ...(channel === undefined ? {} : { channelId: channel }) });
    expect(h.callback).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(authorizationUrl);
    expectPrivateResponse(response);
  });

  it.each([
    "channelId=", "channelId=0", "channelId=-1", "channelId=01", "channelId=1.5", "channelId=abc",
    "channelId=%2B1", "channelId=41&channelId=42", "channelId=41&channel%49d=41",
    "channelId=9007199254740993",
  ])("rejects invalid/ambiguous channel selection before owner resolution: %s", async query => {
    const h = mount();
    const response = await h.dispatch(`${INSTALL}?${query}`);
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("SHOPIFY_OAUTH_CHANNEL_INVALID");
    expectPrivateResponse(response);
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
  });

  it("passes the exact original callback query to the owner without collapsing duplicate or encoded fields", async () => {
    const h = mount();
    const raw = "shop=one.myshopify.com&shop=two.myshopify.com&state=PRIVATE_STATE&code=a%2Bb+c&extra=%26x%3D1&hmac=bad";
    h.callback.mockRejectedValue(new ShopifyStaffOAuthError("SHOPIFY_OAUTH_QUERY_INVALID"));
    const response = await h.dispatch(`${CALLBACK}?${raw}`, {
      parsedQuery: { shop: "parser-selected-shop.myshopify.com", state: { attacker: "nested" }, code: "changed" },
    });
    expect(h.callback).toHaveBeenCalledExactlyOnceWith({ actorId, sessionId, rawQuery: raw });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("SHOPIFY_OAUTH_QUERY_INVALID");
    expect(String(response.body)).not.toContain("PRIVATE_STATE");
    expect(h.begin).not.toHaveBeenCalled();
    expectPrivateResponse(response);
  });

  it("passes an absent callback query as empty input for owner validation", async () => {
    const h = mount();
    h.callback.mockRejectedValue(new ShopifyStaffOAuthError("SHOPIFY_OAUTH_QUERY_INVALID"));
    const response = await h.dispatch(CALLBACK);
    expect(h.callback).toHaveBeenCalledExactlyOnceWith({ actorId, sessionId, rawQuery: "" });
    expect(response.statusCode).toBe(400);
  });

  it("uses the same bound identity for install and successful callback without exposing owner result fields", async () => {
    const h = mount();
    await h.dispatch(`${INSTALL}?channelId=41`);
    const raw = "shop=synthetic-shop.myshopify.com&state=PRIVATE_STATE&code=PRIVATE_CODE&hmac=synthetic";
    const response = await h.dispatch(`${CALLBACK}?${raw}`);
    expect(h.begin).toHaveBeenCalledExactlyOnceWith({ actorId, sessionId, channelId: 41 });
    expect(h.callback).toHaveBeenCalledExactlyOnceWith({ actorId, sessionId, rawQuery: raw });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/plain");
    expect(response.body).toContain("authorization completed");
    expect(JSON.stringify(response)).not.toContain("PRIVATE_CODE");
    expect(JSON.stringify(response)).not.toContain("PRIVATE_STATE");
    expect(JSON.stringify(response)).not.toContain(operationId);
    expectPrivateResponse(response);
  });

  it.each([
    { status: "connected", httpStatus: 200, wording: "completed" },
    { status: "in_progress", httpStatus: 409, wording: "already in progress" },
    { status: "exchange_unknown", httpStatus: 409, wording: "outcome is uncertain" },
    { status: "failed", httpStatus: 400, wording: "authorization failed" },
    { status: "superseded", httpStatus: 409, wording: "newer authorization" },
  ] as const)("renders the durable $status outcome without echoing diagnostic fields", async ({ status, httpStatus, wording }) => {
    const h = mount();
    const result: ShopifyStaffOAuthResult = {
      operationId, channelId: 41, connectionId: 83, status, replayed: true,
      code: "PRIVATE_PROVIDER_DIAGNOSTIC",
    };
    h.callback.mockResolvedValue(result);
    const response = await h.dispatch(CALLBACK);
    expect(response.statusCode).toBe(httpStatus);
    expect(response.body).toContain(wording);
    expect(String(response.body)).not.toContain("PRIVATE_PROVIDER_DIAGNOSTIC");
    expect(response.headers["content-type"]).toBe("text/plain");
    expectPrivateResponse(response);
    expect(h.callback).toHaveBeenCalledTimes(1);
  });

  it.each([INSTALL, CALLBACK])("redacts arbitrary owner/provider errors on %s", async path => {
    const h = mount();
    const failure = new Error("PRIVATE_TOKEN PRIVATE_APP_SECRET <script>PRIVATE_PROVIDER_BODY</script>");
    h.begin.mockRejectedValue(failure);
    h.callback.mockRejectedValue(failure);
    const response = await h.dispatch(`${path}?code=PRIVATE_QUERY_CODE`);
    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("SHOPIFY_OAUTH_UNAVAILABLE");
    expect(response.body).toContain("outcome is uncertain");
    expect(JSON.stringify(response)).not.toMatch(/PRIVATE_|<script>/);
    expectPrivateResponse(response);
  });

  it("preserves safe domain status/code without exposing a forged error message or cause", async () => {
    const h = mount();
    const failure = new ShopifyStaffOAuthError("SHOPIFY_OAUTH_FORBIDDEN", 403);
    failure.message = "PRIVATE_PROVIDER_MESSAGE";
    Object.assign(failure, { cause: new Error("PRIVATE_PROVIDER_CAUSE") });
    h.callback.mockRejectedValue(failure);
    const response = await h.dispatch(CALLBACK);
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("SHOPIFY_OAUTH_FORBIDDEN");
    expect(JSON.stringify(response)).not.toContain("PRIVATE_");
  });

  it("rejects an unsafe domain error code instead of reflecting it", async () => {
    const h = mount();
    h.callback.mockRejectedValue(new ShopifyStaffOAuthError("SHOPIFY_OAUTH_<script>PRIVATE_SECRET</script>", 400));
    const response = await h.dispatch(CALLBACK);
    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("SHOPIFY_OAUTH_UNAVAILABLE");
    expect(JSON.stringify(response)).not.toMatch(/PRIVATE_|<script>/);
  });

  it("includes only a safe operation reference for an uncertain accepted attempt", async () => {
    const h = mount();
    h.callback.mockRejectedValue(new ShopifyStaffOAuthError("SHOPIFY_OAUTH_EXCHANGE_UNKNOWN", 502, "exchange_unknown", operationId));
    const response = await h.dispatch(CALLBACK);
    expect(response.statusCode).toBe(502);
    expect(response.body).toContain(`Reference: ${operationId}`);
    const unsafe = new ShopifyStaffOAuthError("SHOPIFY_OAUTH_EXCHANGE_UNKNOWN", 502, "exchange_unknown", "<script>secret</script>");
    expect(unsafe.operationId).toBeUndefined();
  });

  it("returns a safe unavailable result when owner resolution itself fails", async () => {
    const h = mount();
    h.resolve.mockRejectedValue(new Error("PRIVATE_CONFIGURATION_VALUE"));
    const response = await h.dispatch(INSTALL);
    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("SHOPIFY_OAUTH_UNAVAILABLE");
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.callback).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain("PRIVATE_CONFIGURATION_VALUE");
  });
});
