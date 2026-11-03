import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeShopifyStaffOAuthCode } from "../../adapters/shopify/shopify-staff-oauth.provider";
import { ShopifyStaffOAuthError, type ShopifyStaffOAuthConfig } from "../../shopify-staff-oauth.types";

const config: ShopifyStaffOAuthConfig = {
  shopDomain: "test-store.myshopify.com",
  clientId: "fixture-client-id",
  clientSecret: "fixture-client-secret",
  redirectUri: "https://local.example/api/shopify/callback",
  scopes: ["read_orders", "write_products"],
  fingerprint: "fixture-config-fingerprint",
};
const code = "fixture-private-code";
const token = { access_token: "fixture-private-token", scope: "write_orders,write_products" };

function transport(payload: unknown = token) {
  return vi.fn<typeof fetch>(async () => Response.json(payload));
}

async function failure(promise: Promise<unknown>, outcome: "failed" | "exchange_unknown" = "exchange_unknown") {
  const error: unknown = await promise.then(() => { throw new Error("Expected exchange refusal"); }, value => value);
  expect(error).toBeInstanceOf(ShopifyStaffOAuthError);
  const typed = error as ShopifyStaffOAuthError;
  expect(typed.outcome).toBe(outcome);
  expect(typed.message).toBe(typed.code);
  expect(typed.cause).toBeUndefined();
  const exposed = `${JSON.stringify(typed)} ${typed.stack}`;
  for (const secret of [config.clientId, config.clientSecret, code, token.access_token, "provider-private-diagnostic"])
    expect(exposed).not.toContain(secret);
  return typed;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("staff Shopify OAuth token exchange boundary", () => {
  it("exchanges once at the configured canonical shop and preserves non-expiring offline semantics", async () => {
    const request = transport({ ...token, unrelated_metadata: "future-compatible" });
    await expect(exchangeShopifyStaffOAuthCode(config, code, { fetch: request }))
      .resolves.toEqual({ accessToken: token.access_token, scopes: token.scope });
    expect(request).toHaveBeenCalledExactlyOnceWith("https://test-store.myshopify.com/admin/oauth/access_token", {
      method: "POST", redirect: "error", signal: expect.any(AbortSignal),
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code }),
    });
    const body = JSON.parse(String(request.mock.calls[0][1]!.body));
    expect(body).not.toHaveProperty("expiring");
    expect(body).not.toHaveProperty("grant_type");
    expect(body).not.toHaveProperty("refresh_token");
  });

  it.each([
    "https://test-store.myshopify.com", "test-store", "test-store.myshopify.com.attacker.example",
    "test-store.myshopify.com:443", "test-store.myshopify.com/path", "user@test-store.myshopify.com",
    "test-store.myshopify.com?query=1", "test-store.myshopify.com#fragment", "test-store.myshopify.com.",
    "test-store.myshopify.com\n", "test-store%2emyshopify.com", "tést-store.myshopify.com",
  ])("rejects configured destination %s without any exchange", async shopDomain => {
    const request = transport();
    await failure(exchangeShopifyStaffOAuthCode({ ...config, shopDomain }, code, { fetch: request }), "failed");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { clientId: "" }, { clientSecret: " " }, { clientSecret: "secret\r\nheader" },
    { clientSecret: "x".repeat(4_097) }, { scopes: [] }, { scopes: ["read_orders,write_products"] },
  ])("rejects invalid credentials or requested scope configuration before HTTP: %j", async change => {
    const request = transport();
    await failure(exchangeShopifyStaffOAuthCode({ ...config, ...change }, code, { fetch: request }), "failed");
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["", " ", "code\nprivate", "x".repeat(10_001)])("rejects malformed code before HTTP (%#)", async value => {
    const request = transport();
    await failure(exchangeShopifyStaffOAuthCode(config, value, { fetch: request }), "failed");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([{ timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 60_001 },
    { maxResponseBytes: 0 }, { maxResponseBytes: 65_537 }])("cannot disable transport bounds: %j", async bounds => {
    const request = transport();
    await failure(exchangeShopifyStaffOAuthCode(config, code, { fetch: request, ...bounds }), "failed");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([301, 302, 307, 308])("does not follow a %s redirect or trust a redirect body", async status => {
    const cancel = vi.fn();
    const request = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel }), {
      status, headers: { Location: "https://attacker.example/collect" },
    }));
    await failure(exchangeShopifyStaffOAuthCode(config, code, { fetch: request }));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]!.redirect).toBe("error");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("also refuses a response marked redirected by an incorrectly implemented transport", async () => {
    const response = Response.json(token);
    Object.defineProperty(response, "redirected", { value: true });
    const request = vi.fn<typeof fetch>(async () => response);
    await failure(exchangeShopifyStaffOAuthCode(config, code, { fetch: request }));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 404, 422])("classifies an explicit %s rejection without disclosing its body", async status => {
    const request = vi.fn<typeof fetch>(async () => new Response("provider-private-diagnostic", { status }));
    const error = await failure(exchangeShopifyStaffOAuthCode(config, code, { fetch: request }), "failed");
    expect(error.code).toBe("SHOPIFY_OAUTH_EXCHANGE_REJECTED");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([408, 429, 500, 502, 503])("retains an unknown outcome for %s without retry", async status => {
    const request = vi.fn<typeof fetch>(async () => new Response("provider-private-diagnostic", { status }));
    await failure(exchangeShopifyStaffOAuthCode(config, code, { fetch: request }));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("sanitizes a transport failure with credentials in its error and cause", async () => {
    const request = vi.fn<typeof fetch>(async () => {
      throw new Error(`${config.clientSecret} ${code} provider-private-diagnostic`, { cause: token });
    });
    await failure(exchangeShopifyStaffOAuthCode(config, code, { fetch: request }));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("bounds a request stalled before headers, even when the injected transport ignores abort", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    const result = failure(exchangeShopifyStaffOAuthCode(config, code, { fetch: request, timeoutMs: 20 }));
    await vi.advanceTimersByTimeAsync(20);
    await result;
    expect(request.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a response arriving after the deadline without reading or accepting its token", async () => {
    vi.useFakeTimers();
    let deliver!: (response: Response) => void;
    const request = vi.fn<typeof fetch>(() => new Promise<Response>(resolve => { deliver = resolve; }));
    const result = failure(exchangeShopifyStaffOAuthCode(config, code, { fetch: request, timeoutMs: 20 }));
    await vi.advanceTimersByTimeAsync(20);
    await result;
    const cancel = vi.fn();
    deliver(new Response(new ReadableStream({ cancel })));
    await Promise.resolve();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps the deadline active through a stalled response body and cancels that body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"access_token":')); }, cancel,
    });
    const request = vi.fn<typeof fetch>(async () => new Response(body));
    const result = failure(exchangeShopifyStaffOAuthCode(config, code, { fetch: request, timeoutMs: 20 }));
    await vi.advanceTimersByTimeAsync(20);
    await result;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a body with excessive declared length without consuming it", async () => {
    const cancel = vi.fn();
    const request = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel }), {
      headers: { "Content-Length": "65537" },
    }));
    await failure(exchangeShopifyStaffOAuthCode(config, code, { fetch: request }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("enforces actual streamed bytes despite a small declared length, and cancels on overflow", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(40)); controller.enqueue(new Uint8Array(40)); }, cancel,
    });
    const request = vi.fn<typeof fetch>(async () => new Response(body, { headers: { "Content-Length": "1" } }));
    await failure(exchangeShopifyStaffOAuthCode(config, code, { fetch: request, maxResponseBytes: 64 }));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("accepts a valid token response exactly at its byte bound", async () => {
    const encoded = JSON.stringify(token);
    const request = vi.fn<typeof fetch>(async () => new Response(encoded));
    await expect(exchangeShopifyStaffOAuthCode(config, code, {
      fetch: request, maxResponseBytes: new TextEncoder().encode(encoded).byteLength,
    })).resolves.toEqual({ accessToken: token.access_token, scopes: token.scope });
  });

  it.each(["{not-json", '"provider-private-diagnostic"', "null", "[]", "{}"])("refuses malformed token response %s", async body => {
    const request = vi.fn<typeof fetch>(async () => new Response(body));
    await failure(exchangeShopifyStaffOAuthCode(config, code, { fetch: request }));
  });

  it.each(["", " ", "token\nheader", 42, null, "x".repeat(8_193)])("refuses an unusable token (%#)", async access_token => {
    await failure(exchangeShopifyStaffOAuthCode(config, code, { fetch: transport({ ...token, access_token }) }));
  });

  it.each(["", null, ["write_orders", "write_products"], "write_orders,", "write_orders,,write_products",
    "write_orders, write_products", "write_orders,write-products", "read_orders", "write_orders,read_products"])
  ("refuses invalid or insufficient scopes (%#)", async scope => {
    await failure(exchangeShopifyStaffOAuthCode(config, code, { fetch: transport({ ...token, scope }) }));
  });

  it("accepts exact read grants and additional scopes without inventing write privileges", async () => {
    const scope = "read_orders,write_products,read_customers";
    await expect(exchangeShopifyStaffOAuthCode(config, code, { fetch: transport({ ...token, scope }) }))
      .resolves.toEqual({ accessToken: token.access_token, scopes: scope });
  });

  it("recognizes corresponding unauthenticated write access as read access", async () => {
    const scope = "unauthenticated_write_checkouts";
    await expect(exchangeShopifyStaffOAuthCode({ ...config, scopes: ["unauthenticated_read_checkouts"] }, code,
      { fetch: transport({ ...token, scope }) })).resolves.toEqual({ accessToken: token.access_token, scopes: scope });
  });

  it.each([
    { expires_in: 3600 }, { expires_in: null }, { refresh_token: "fixture-refresh-secret" },
    { refresh_token_expires_in: 7776000 }, { associated_user: { id: 1 } }, { associated_user_scope: "read_orders" },
  ])("does not silently store an unsupported expiring or online token (%#)", async metadata => {
    const error = await failure(exchangeShopifyStaffOAuthCode(config, code, { fetch: transport({ ...token, ...metadata }) }));
    expect(JSON.stringify(error)).not.toContain("fixture-refresh-secret");
  });

  it("does not log credentials, callback code, token or provider diagnostics", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await exchangeShopifyStaffOAuthCode(config, code, { fetch: transport() });
    await failure(exchangeShopifyStaffOAuthCode(config, code, {
      fetch: vi.fn<typeof fetch>(async () => new Response("provider-private-diagnostic", { status: 500 })),
    }));
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
