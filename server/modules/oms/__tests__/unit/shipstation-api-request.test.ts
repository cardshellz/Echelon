import { describe, expect, it, vi } from "vitest";

import {
  createShipStationApiRequester,
  DEFAULT_SHIPSTATION_REQUEST_TIMEOUT_MS,
  isReplaySafeByDefault,
  MAX_RATE_LIMIT_WAIT_SECONDS,
  parseRateLimitResetSeconds,
  resolveShipStationRequestTimeoutMs,
  ShipStationRateLimitError,
  ShipStationRequestTimeoutError,
  ShipStationTransientError,
  SS_RATE_LIMITED,
  SS_REQUEST_TIMEOUT,
} from "../../shipstation-api-request";
import { SS_PUSH_INVALID_SHIPMENT } from "../../shipstation.service";

type ScriptedResponse =
  | { status: 429; reset?: string; retryAfter?: string }
  | { status: number; json?: unknown; text?: string }
  | { throws: Error };

function makeFetch(script: ScriptedResponse[]) {
  const remaining = [...script];
  return vi.fn(async (_url: string, _init: RequestInit) => {
    const next = remaining.shift();
    if (!next) throw new Error("Unexpected fetch call");
    if ("throws" in next) throw next.throws;
    const headers = new Map<string, string>();
    if (next.status === 429) {
      if ("reset" in next && next.reset !== undefined) headers.set("x-rate-limit-reset", next.reset);
      if ("retryAfter" in next && next.retryAfter !== undefined) headers.set("retry-after", next.retryAfter);
    }
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      json: async () => ("json" in next ? next.json : undefined),
      text: async () => ("text" in next ? String(next.text) : ""),
    } as unknown as Response;
  });
}

function makeRequester(fetchImpl: ReturnType<typeof makeFetch>, overrides: Partial<Parameters<typeof createShipStationApiRequester>[0]> = {}) {
  const sleep = vi.fn(async (_ms: number) => {});
  const logger = { warn: vi.fn() };
  const request = createShipStationApiRequester({
    buildUrl: (path) => `https://ssapi.example${path}`,
    getAuthHeader: () => "Basic test",
    fetch: fetchImpl as unknown as typeof fetch,
    sleep,
    logger,
    requestTimeoutMs: 5_000,
    ...overrides,
  });
  return { request, sleep, logger };
}

describe("shipstation-api-request :: replay policy", () => {
  it("sends a keyed create exactly once on 429 and raises a transient rate-limit error", async () => {
    const fetchImpl = makeFetch([{ status: 429, reset: "34" }, { status: 200, json: { orderId: 2 } }]);
    const { request, sleep } = makeRequester(fetchImpl);

    const error = await request("POST", "/orders/createorder", { orderKey: "echelon-wms-shp-16610" })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ShipStationRateLimitError);
    expect(error).toBeInstanceOf(ShipStationTransientError);
    const context = (error as ShipStationRateLimitError).context;
    expect(context).toMatchObject({
      code: SS_RATE_LIMITED,
      method: "POST",
      path: "/orders/createorder",
      attempt: 0,
      replaySafe: false,
      retryAfterSeconds: 34,
    });
    expect((error as ShipStationRateLimitError).classification).toBe("transient");
    // The retry worker's only permanent code must never be attached to this error.
    expect(context.code).not.toBe(SS_PUSH_INVALID_SHIPMENT);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("replays a GET after a 429 using the reset header plus one second", async () => {
    const fetchImpl = makeFetch([{ status: 429, reset: "3" }, { status: 200, json: { orders: [] } }]);
    const { request, sleep, logger } = makeRequester(fetchImpl);

    await expect(request("GET", "/orders?orderNumber=%2362452")).resolves.toEqual({ orders: [] });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(4_000);
    expect(JSON.parse(logger.warn.mock.calls[0][0])).toMatchObject({
      action: "shipstation_rate_limited",
      outcome: "replay_scheduled",
      method: "GET",
      replay_safe: true,
    });
  });

  it("replays a mutation only when the call site opts in as replay-safe", async () => {
    const fetchImpl = makeFetch([{ status: 429, reset: "0" }, { status: 200, json: { orderId: 555 } }]);
    const { request, sleep } = makeRequester(fetchImpl);

    await expect(
      request("POST", "/orders/createorder", { orderId: 555 }, { replaySafe: true }),
    ).resolves.toEqual({ orderId: 555 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("gives up after the replay budget and reports the exhausted attempt", async () => {
    const fetchImpl = makeFetch([
      { status: 429, reset: "0" },
      { status: 429, reset: "0" },
      { status: 429, reset: "0" },
      { status: 429, reset: "0" },
      { status: 200, json: {} },
    ]);
    const { request } = makeRequester(fetchImpl);

    const error = await request("GET", "/shipments").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ShipStationRateLimitError);
    expect((error as ShipStationRateLimitError).context).toMatchObject({ attempt: 3, replaySafe: true });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("honors an explicit retries override for replay-safe requests", async () => {
    const fetchImpl = makeFetch([{ status: 429, reset: "0" }, { status: 200, json: {} }]);
    const { request } = makeRequester(fetchImpl);

    await expect(request("GET", "/shipments", undefined, { retries: 0 })).rejects.toBeInstanceOf(ShipStationRateLimitError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("wraps an aborted request in a transient timeout error without replaying it", async () => {
    const abort = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const fetchImpl = makeFetch([{ throws: abort }, { status: 200, json: {} }]);
    const { request } = makeRequester(fetchImpl);

    const error = await request("POST", "/orders/createorder", { orderKey: "k" }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ShipStationRequestTimeoutError);
    expect((error as ShipStationRequestTimeoutError).context).toMatchObject({
      code: SS_REQUEST_TIMEOUT,
      method: "POST",
      timeoutMs: 5_000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("passes an abort signal, auth header, and serialized body to fetch", async () => {
    const fetchImpl = makeFetch([{ status: 200, json: { ok: true } }]);
    const { request } = makeRequester(fetchImpl);

    await request("post", "/orders/holduntil", { orderId: 1 }, { replaySafe: true });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://ssapi.example/orders/holduntil");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ orderId: 1 }));
    expect((init.headers as Record<string, string>).Authorization).toBe("Basic test");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps the legacy error message shape for non-429 failures and does not replay them", async () => {
    const fetchImpl = makeFetch([{ status: 400, text: "Bad address" }, { status: 200, json: {} }]);
    const { request } = makeRequester(fetchImpl);

    await expect(request("POST", "/orders/createorder", {})).rejects.toThrow(
      "ShipStation API POST /orders/createorder failed (400): Bad address",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rethrows non-abort network errors untouched", async () => {
    const boom = new Error("ECONNRESET");
    const fetchImpl = makeFetch([{ throws: boom }]);
    const { request } = makeRequester(fetchImpl);

    await expect(request("GET", "/shipments")).rejects.toBe(boom);
  });

  it("rejects out-of-range per-call overrides", async () => {
    const { request } = makeRequester(makeFetch([]));

    await expect(request("GET", "/x", undefined, { timeoutMs: 1 })).rejects.toThrow(/timeoutMs/);
    await expect(request("GET", "/x", undefined, { retries: 99 })).rejects.toThrow(/retries/);
  });
});

describe("shipstation-api-request :: helpers", () => {
  it("treats only read-only methods as replay-safe by default", () => {
    expect(isReplaySafeByDefault("GET")).toBe(true);
    expect(isReplaySafeByDefault("get")).toBe(true);
    expect(isReplaySafeByDefault("HEAD")).toBe(true);
    expect(isReplaySafeByDefault("POST")).toBe(false);
    expect(isReplaySafeByDefault("PUT")).toBe(false);
    expect(isReplaySafeByDefault("DELETE")).toBe(false);
  });

  it("parses the reset header, falls back to retry-after, then to the default, and clamps", () => {
    const headers = (entries: Record<string, string>) => ({
      get: (name: string) => entries[name] ?? null,
    });
    expect(parseRateLimitResetSeconds(headers({ "x-rate-limit-reset": "34" }))).toBe(34);
    expect(parseRateLimitResetSeconds(headers({ "retry-after": "7" }))).toBe(7);
    expect(parseRateLimitResetSeconds(headers({}))).toBe(5);
    expect(parseRateLimitResetSeconds(headers({ "x-rate-limit-reset": "later" }))).toBe(5);
    expect(parseRateLimitResetSeconds(headers({ "x-rate-limit-reset": "-4" }))).toBe(5);
    expect(parseRateLimitResetSeconds(headers({ "x-rate-limit-reset": "3600" }))).toBe(MAX_RATE_LIMIT_WAIT_SECONDS);
  });

  it("resolves the request timeout from the environment with bounds", () => {
    expect(resolveShipStationRequestTimeoutMs({})).toBe(DEFAULT_SHIPSTATION_REQUEST_TIMEOUT_MS);
    expect(resolveShipStationRequestTimeoutMs({ SHIPSTATION_REQUEST_TIMEOUT_MS: "20000" })).toBe(20_000);
    expect(resolveShipStationRequestTimeoutMs({ SHIPSTATION_REQUEST_TIMEOUT_MS: "5" })).toBe(DEFAULT_SHIPSTATION_REQUEST_TIMEOUT_MS);
    expect(resolveShipStationRequestTimeoutMs({ SHIPSTATION_REQUEST_TIMEOUT_MS: "abc" })).toBe(DEFAULT_SHIPSTATION_REQUEST_TIMEOUT_MS);
  });
});
