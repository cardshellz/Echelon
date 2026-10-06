import { describe, expect, it, vi } from "vitest";
import { WalmartApiError, WalmartClient, type WalmartCredentials } from "../../adapters/walmart/walmart-client";
import { QuantityProviderEvidenceCollector } from "../../../inventory-planning/application/quantity-provider-request-evidence";
import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";

const credentials: WalmartCredentials = {
  clientId: "test-client", clientSecret: "test-secret", environment: "production", market: "us",
};
const requestId = "01900000-0000-4000-8000-000000000001";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const token = (value = "test-token") => json({ access_token: value, expires_in: 900, token_type: "Bearer" });

function setup(fetchMock: ReturnType<typeof vi.fn>, overrides: Partial<WalmartCredentials> = {}) {
  let time = new Date("2026-09-21T12:00:00.000Z");
  return {
    client: new WalmartClient({ ...credentials, ...overrides }, {
      fetch: fetchMock as typeof fetch, now: () => time, correlationId: () => requestId,
    }),
    advance(milliseconds: number) { time = new Date(time.getTime() + milliseconds); },
  };
}

describe("WalmartClient", () => {
  it("uses the client credentials grant and never sends the secret to a resource endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(json({ order: {} }));
    const { client } = setup(fetchMock);
    await client.request("GET", "/v3/orders?limit=1");
    expect(fetchMock.mock.calls[0][0]).toBe("https://marketplace.walmartapis.com/v3/token");
    const auth = fetchMock.mock.calls[0][1];
    expect(auth.body).toBe("grant_type=client_credentials");
    expect(auth.headers.Authorization).toBe(`Basic ${Buffer.from("test-client:test-secret").toString("base64")}`);
    const request = fetchMock.mock.calls[1][1];
    expect(request.headers).toMatchObject({
      "WM_SEC.ACCESS_TOKEN": "test-token", "WM_MARKET": "us", "WM_GLOBAL_VERSION": "3.1",
      "WM_QOS.CORRELATION_ID": requestId,
    });
    expect(request.headers.Authorization).toBeUndefined();
    expect(request.redirect).toBe("error");
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it("coalesces concurrent token requests and reuses an unexpired token", async () => {
    let release!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    const { client } = setup(fetchMock);
    const first = client.authenticate();
    const second = client.authenticate();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(token());
    await Promise.all([first, second]);
    await client.authenticate();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renews before expiry using the injected clock", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(token("one")).mockResolvedValueOnce(token("two"));
    const { client, advance } = setup(fetchMock);
    await client.authenticate();
    advance(869_999);
    await client.authenticate();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance(1);
    await client.authenticate();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps tokens separate for distinct client instances", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(token("first")).mockResolvedValueOnce(token("second"));
    const first = setup(fetchMock).client;
    const second = setup(fetchMock, { clientId: "another-client" }).client;
    await first.authenticate();
    await second.authenticate();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).not.toBe(fetchMock.mock.calls[1][1].headers.Authorization);
  });

  it("refreshes once after an explicit 401 rejection", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(token("old"))
      .mockResolvedValueOnce(json({}, 401)).mockResolvedValueOnce(token("new"))
      .mockResolvedValueOnce(json({ success: true }));
    const { client } = setup(fetchMock);
    await expect(client.request("GET", "/v3/orders")).resolves.toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3][1].headers["WM_SEC.ACCESS_TOKEN"]).toBe("new");
  });

  it("preserves the operation correlation ID across an authentication renewal", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(token()).mockResolvedValueOnce(json({ items: [] }));
    const operationRequestId = "01900000-0000-4000-8000-000000000002";
    await setup(fetchMock).client.request("GET", "/v3/items", undefined, { correlationId: operationRequestId });
    expect(fetchMock.mock.calls[1][1].headers["WM_QOS.CORRELATION_ID"]).toBe(operationRequestId);
    expect(fetchMock.mock.calls[3][1].headers["WM_QOS.CORRELATION_ID"]).toBe(operationRequestId);
  });

  it("returns only bounded, sanitized rate metadata for scheduler-owned backoff", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(JSON.stringify({ feedId: "f@US" }), {
      status: 200, headers: { "Retry-After": "120", "x-current-token-count": "4", "x-next-replenishment-time": "2026-09-21T12:05:00Z", "set-cookie": "private" },
    }));
    const result = await setup(fetchMock).client.requestWithMetadata("GET", "/v3/feeds");
    expect(result.metadata).toEqual({ correlationId: requestId, status: 200, retryAfterMs: 120_000,
      remainingTokens: 4, nextReplenishmentAt: "2026-09-21T12:05:00.000Z" });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it.each([401, 429, 503])("captures a single physical feed HTTP %i outcome without replaying it", async status => {
    const fetchMock = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(JSON.stringify({ secret: "test-secret" }), { status, headers: { "Retry-After": "120" } }));
    const store = { start: vi.fn().mockResolvedValue("request-1"), finish: vi.fn().mockResolvedValue(undefined) };
    const collector = new QuantityProviderEvidenceCollector(store, () => new Date("2026-09-21T12:00:00Z"));
    await expect(collector.run(() => setup(fetchMock).client.request("POST", "/v3/feeds?feedType=MP_ITEM", { MPItem: [] }))).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.start).toHaveBeenCalledTimes(1);
    expect(store.finish.mock.calls[0][1]).toMatchObject({ outcome: status === 503 ? "uncertain" : "rejected", httpStatus: status,
      providerRequestId: requestId, responseHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(store.finish.mock.calls)).not.toContain("test-secret");
  });

  it.each(["MP_ITEM", "MP_ITEM_MATCH"])("uploads %s as a JSON file while auditing the same approved content", async feedType => {
    const fetchMock = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(json({ feedId: "f@US" }));
    const payload = { MPItemFeedHeader: { locale: "en" }, MPItem: [{ [feedType === "MP_ITEM" ? "Orderable" : "Item"]: { sku: "TEST", inventory: [{ quantity: 0 }] } }] };
    const expected = structuredClone(payload);
    const store = { start: vi.fn().mockResolvedValue("request-1"), finish: vi.fn().mockResolvedValue(undefined) };
    const collector = new QuantityProviderEvidenceCollector(store, () => new Date("2026-09-21T12:00:00Z"));
    await collector.run(() => setup(fetchMock).client.request("POST", `/v3/feeds?feedType=${feedType}`, payload));
    const request = fetchMock.mock.calls[1][1];
    expect(request.body).toBeInstanceOf(FormData);
    const form = request.body as FormData;
    expect([...form.keys()]).toEqual(["file"]);
    const file = form.get("file") as File;
    expect(file.name).toBe("items.json");
    expect(file.type).toBe("application/json");
    expect(await file.text()).toBe(JSON.stringify(expected));
    expect(request.headers["Content-Type"]).toBeUndefined();
    expect(store.start.mock.calls[0][0].requestHash).toBe(createHash("sha256").update(canonicalJson(expected)).digest("hex"));
    collector.assertSingleCompletedRequest("POST", [`/v3/feeds?feedType=${feedType}`]);
    expect(payload).toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records an ambiguous feed timeout and leaves reconciliation to the owner", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(token()).mockRejectedValueOnce(new Error("timeout after acceptance"));
    const store = { start: vi.fn().mockResolvedValue("request-1"), finish: vi.fn().mockResolvedValue(undefined) };
    const collector = new QuantityProviderEvidenceCollector(store, () => new Date("2026-09-21T12:00:00Z"));
    await expect(collector.run(() => setup(fetchMock).client.request("POST", "/v3/feeds?feedType=MP_ITEM", { MPItem: [] }))).rejects.toMatchObject({ code: "WALMART_NETWORK_ERROR" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.finish.mock.calls[0][1]).toMatchObject({ outcome: "uncertain", httpStatus: null, responseHash: null });
  });

  it("does not record a contradictory feed acknowledgement as completed", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(json({feedId: "f@US", errors: [{code: "FAILURE"}]}));
    const store = {start: vi.fn().mockResolvedValue("request-1"), finish: vi.fn().mockResolvedValue(undefined)};
    const collector = new QuantityProviderEvidenceCollector(store, () => new Date("2026-09-21T12:00:00Z"));
    const response = await collector.run(() => setup(fetchMock).client.requestWithMetadata("POST", "/v3/feeds?feedType=MP_ITEM", {MPItem: []}));
    expect(response.metadata.quantityOutcome).toBe("uncertain");
    expect(store.finish.mock.calls[0][1]).toMatchObject({outcome: "uncertain", httpStatus: 200});
  });

  it("does not loop indefinitely on unauthorized responses", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(token()).mockResolvedValueOnce(json({}, 401));
    await expect(setup(fetchMock).client.request("GET", "/v3/orders"))
      .rejects.toMatchObject({ code: "WALMART_HTTP_401", retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([408, 429, 500, 503])("classifies HTTP %i as retryable without repeating a write", async (status) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(json({}, status));
    await expect(setup(fetchMock).client.request("POST", "/v3/orders/123/shipping", {}))
      .rejects.toMatchObject({ status, retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry or expose details from an ambiguous network failure", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(token()).mockRejectedValueOnce(new Error("test-secret bearer test-token"));
    const error = await setup(fetchMock).client.request("POST", "/v3/orders/123/shipping", {}).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(WalmartApiError);
    expect(error).toMatchObject({ code: "WALMART_NETWORK_ERROR", retryable: true });
    expect(String(error)).not.toContain("test-secret");
    expect(String(error)).not.toContain("test-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never exposes an error response body", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ secret: "test-secret", customer: "private" }, 403));
    const error = await setup(fetchMock).client.authenticate().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "WALMART_HTTP_403", retryable: false });
    expect(String(error)).not.toMatch(/test-secret|private/);
  });

  it.each(["https://attacker.example/v3/orders", "//attacker.example/v3/orders", "/v3/../token", "/v3/%2e%2e/token", "/v3/orders#fragment", "/v3/\\attacker"]) (
    "rejects unsafe paths before making any request: %s", async (path) => {
      const fetchMock = vi.fn();
      await expect(setup(fetchMock).client.request("GET", path)).rejects.toMatchObject({ code: "WALMART_INVALID_PATH" });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("isolates sandbox credentials from the production host", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(json({}));
    await setup(fetchMock, { environment: "sandbox", market: "ca" }).client.request("GET", "/v3/orders");
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith("https://sandbox.walmartapis.com/"))).toBe(true);
    expect(fetchMock.mock.calls[1][1].headers["WM_MARKET"]).toBe("ca");
  });

  it.each([{ access_token: "", expires_in: 900 }, { access_token: "secret", expires_in: 0 }, { expires_in: 900 }])(
    "rejects invalid token responses without leaking values", async (payload) => {
      const fetchMock = vi.fn().mockResolvedValueOnce(json(payload));
      const error = await setup(fetchMock).client.authenticate().catch((value: unknown) => value);
      expect(error).toMatchObject({ code: "WALMART_INVALID_TOKEN_RESPONSE" });
      expect(String(error)).not.toContain("secret");
    },
  );

  it("allows a later authentication attempt after a token request fails", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(token());
    const { client } = setup(fetchMock);
    await expect(client.authenticate()).rejects.toMatchObject({ code: "WALMART_HTTP_503" });
    await expect(client.authenticate()).resolves.toBeUndefined();
  });

  it("rejects oversized and malformed response bodies", async () => {
    const oversized = vi.fn().mockResolvedValueOnce(new Response("x".repeat(5 * 1024 * 1024 + 1)));
    await expect(setup(oversized).client.authenticate()).rejects.toMatchObject({ code: "WALMART_RESPONSE_TOO_LARGE" });
    const malformed = vi.fn().mockResolvedValueOnce(new Response("private: not-json"));
    await expect(setup(malformed).client.authenticate()).rejects.toMatchObject({ code: "WALMART_INVALID_JSON" });
  });

  it("rejects invalid credential boundaries before network activity", () => {
    const fetchMock = vi.fn();
    expect(() => setup(fetchMock, { clientId: "invalid:client" })).toThrow();
    expect(() => setup(fetchMock, { clientSecret: "" })).toThrow();
    expect(() => setup(fetchMock, { market: "uk" as WalmartCredentials["market"] })).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
