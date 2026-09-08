import { describe, expect, it, vi } from "vitest";
import { DropshipError } from "../../domain/errors";
import { retryEbaySetupRead, retryAfterMilliseconds, type EbaySetupReadRuntime } from "../../infrastructure/dropship-ebay-setup-read-retry";
import { EbayDropshipListingSetupDirectory } from "../../infrastructure/dropship-ebay-listing-setup.directory";

function runtime(): EbaySetupReadRuntime {
  return { now: () => Date.parse("2026-09-08T12:00:00Z"), sleep: vi.fn(async () => {}), reference: () => "test-read-reference",
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
}

function failure(status = 503, extra: Record<string, unknown> = {}) {
  return new DropshipError("DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE", "Read unavailable.", {
    status, retryable: true, resource: "fulfillmentPolicies", storeConnectionId: 1, ...extra,
  });
}

describe("bounded eBay setup read recovery", () => {
  it("bounds timeout retries without exposing transport errors", async () => {
    const env = runtime();
    const fetchFn = vi.fn().mockRejectedValue(new DOMException("private timeout detail", "TimeoutError"));
    const directory = new EbayDropshipListingSetupDirectory({ loadFreshForStoreConnection: vi.fn() }, fetchFn, env);
    await expect(directory.getFulfillmentPolicyWithAccessToken({ storeConnectionId: 1, accessToken: "not-real", environment: "production", fulfillmentPolicyId: "one" }))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE", context: { attempts: 3, errorName: "TimeoutError" } });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(vi.mocked(env.logger.warn).mock.calls)).not.toContain("private timeout detail");
  });

  it.each(["oversized", "malformed"])("rejects a %s response without repeating the request", async (kind) => {
    const fetchFn = vi.fn(async () => new Response(kind === "oversized" ? "x".repeat(2 * 1024 * 1024 + 1) : "not json"));
    const directory = new EbayDropshipListingSetupDirectory({ loadFreshForStoreConnection: vi.fn() }, fetchFn, runtime());
    await expect(directory.getFulfillmentPolicyWithAccessToken({ storeConnectionId: 1, accessToken: "not-real", environment: "production", fulfillmentPolicyId: "one" }))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_LISTING_SETUP_INVALID_RESPONSE" });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it.each([429, 500, 502, 503, 504])("retries HTTP %i then returns success", async (status) => {
    const env = runtime();
    const read = vi.fn().mockRejectedValueOnce(failure(status)).mockResolvedValue({ policies: [] });
    await expect(retryEbaySetupRead(read, env)).resolves.toEqual({ policies: [] });
    expect(read).toHaveBeenCalledTimes(2);
    expect(env.sleep).toHaveBeenCalledExactlyOnceWith(250);
    expect(env.logger.info).toHaveBeenCalledWith(expect.objectContaining({ code: "DROPSHIP_EBAY_SETUP_READ_RECOVERED" }));
  });

  it("exhausts three attempts, preserves provider identifiers, and never logs secret context", async () => {
    const env = runtime();
    const read = vi.fn().mockRejectedValue(failure(503, { providerErrorIds: ["1001"], accessToken: "secret-token" }));
    await expect(retryEbaySetupRead(read, env)).rejects.toMatchObject({ context: {
      attempts: 3, diagnosticReference: "test-read-reference", status: 503, providerErrorIds: ["1001"],
    } });
    expect(read).toHaveBeenCalledTimes(3);
    expect(vi.mocked(env.sleep).mock.calls).toEqual([[250], [750]]);
    expect(JSON.stringify(vi.mocked(env.logger.warn).mock.calls)).not.toContain("secret-token");
  });

  it.each([400, 401, 403, 404, 409, 501])("does not retry permanent HTTP %i", async (status) => {
    const env = runtime();
    const read = vi.fn().mockRejectedValue(failure(status));
    await expect(retryEbaySetupRead(read, env)).rejects.toBeInstanceOf(DropshipError);
    expect(read).toHaveBeenCalledOnce();
    expect(env.sleep).not.toHaveBeenCalled();
  });

  it("does not retry unclassified exceptions or malformed responses", async () => {
    for (const error of [new Error("unexpected"), new DropshipError("DROPSHIP_EBAY_LISTING_SETUP_INVALID_RESPONSE", "invalid")]) {
      const read = vi.fn().mockRejectedValue(error);
      await expect(retryEbaySetupRead(read, runtime())).rejects.toThrow(error.message);
      expect(read).toHaveBeenCalledOnce();
    }
  });

  it("honors short Retry-After and never retries earlier than a long Retry-After", async () => {
    const env = runtime();
    const read = vi.fn().mockRejectedValueOnce(failure(429, { retryAfterMs: 1_500 })).mockResolvedValue("ok");
    await expect(retryEbaySetupRead(read, env)).resolves.toBe("ok");
    expect(env.sleep).toHaveBeenCalledExactlyOnceWith(1_500);
    const delayed = vi.fn().mockRejectedValue(failure(429, { retryAfterMs: 60_000 }));
    await expect(retryEbaySetupRead(delayed, env)).rejects.toMatchObject({ context: { attempts: 1 } });
    expect(delayed).toHaveBeenCalledOnce();
  });

  it("parses seconds, HTTP dates, past dates, overflow and invalid Retry-After headers", () => {
    const now = runtime().now();
    expect(retryAfterMilliseconds("2", now)).toBe(2000);
    expect(retryAfterMilliseconds("Tue, 08 Sep 2026 12:00:01 GMT", now)).toBe(1000);
    expect(retryAfterMilliseconds("Tue, 08 Sep 2026 11:00:00 GMT", now)).toBe(0);
    expect(retryAfterMilliseconds("999999999999999999999", now)).toBe(Number.MAX_SAFE_INTEGER);
    expect(retryAfterMilliseconds("invalid", now)).toBeUndefined();
    expect(retryAfterMilliseconds(null, now)).toBeUndefined();
  });

  it("retries only the failed provider resource, not the other three requests", async () => {
    const env = runtime();
    let failed = false;
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.redirect).toBe("error");
      const path = new URL(String(url)).pathname;
      const key = path.endsWith("/location") ? "locations" : path.endsWith("/fulfillment_policy") ? "fulfillmentPolicies"
        : path.endsWith("/return_policy") ? "returnPolicies" : "paymentPolicies";
      if (key === "fulfillmentPolicies" && !failed) { failed = true; return new Response("{}", { status: 503 }); }
      return new Response(JSON.stringify({ [key]: [] }));
    });
    const credentials = { loadFreshForStoreConnection: vi.fn() };
    const directory = new EbayDropshipListingSetupDirectory(credentials, fetchFn, env);
    await expect(directory.discoverWithAccessToken({ storeConnectionId: 1, accessToken: "not-real", environment: "production", marketplaceId: "EBAY_US" }))
      .resolves.toMatchObject({ fulfillmentPolicies: [], returnPolicies: [] });
    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect(credentials.loadFreshForStoreConnection).not.toHaveBeenCalled();
  });

  it("retries a transport failure without refreshing credentials", async () => {
    const env = runtime();
    const fetchFn = vi.fn().mockRejectedValueOnce(new TypeError("network secret"))
      .mockResolvedValue(new Response(JSON.stringify({ fulfillmentPolicyId: "one" })));
    const directory = new EbayDropshipListingSetupDirectory({ loadFreshForStoreConnection: vi.fn() }, fetchFn, env);
    await expect(directory.getFulfillmentPolicyWithAccessToken({ storeConnectionId: 1, accessToken: "not-real", environment: "production", fulfillmentPolicyId: "one" }))
      .resolves.toMatchObject({ id: "one" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(env.logger.warn).mock.calls)).not.toContain("network secret");
  });
});
