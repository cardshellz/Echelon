import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderRequestDeadline, boundedProviderRetryAfterSeconds, PROVIDER_REQUEST_TIMEOUT_MS } from "../../provider-request-limits";
import { EbayApiClient } from "../../adapters/ebay/ebay-api.client";
import type { EbayQuantityRequestAdmission } from "../../quantity-publication-request";

describe("bounded quantity provider request ownership", () => {
  afterEach(() => { vi.useRealTimers(); });
  it("aborts at a deterministic local deadline and labels the remote outcome uncertain", async () => {
    vi.useFakeTimers();
    const deadline = createProviderRequestDeadline();
    await vi.advanceTimersByTimeAsync(PROVIDER_REQUEST_TIMEOUT_MS - 1);
    expect(deadline.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(deadline.signal.reason).toMatchObject({ code: "QUANTITY_PROVIDER_REQUEST_TIMEOUT", outcome: "uncertain" });
    deadline.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("removes the timer after a successful request without aborting its signal", async () => {
    vi.useFakeTimers();
    const deadline = createProviderRequestDeadline(); deadline.dispose();
    await vi.advanceTimersByTimeAsync(PROVIDER_REQUEST_TIMEOUT_MS);
    expect(deadline.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([["999999999", 15], ["-1", 5], ["junk", 5], ["0", 0], ["4", 4], [null, 5]])(
    "bounds provider retry-after %s without allowing an unbounded gate hold", (raw, expected) => {
      expect(boundedProviderRetryAfterSeconds(raw as string | null, 5)).toBe(expected);
    });
  it.each([0, -1, NaN, Infinity, 30_001])("rejects invalid deadline %s", value => {
    expect(() => createProviderRequestDeadline(value)).toThrow("Invalid provider request deadline");
  });
  it("does not retry an ambiguous timeout in the actual eBay API client and cleans up its timer", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const admission: EbayQuantityRequestAdmission = { item: (_sku, work) => work(null),
      group: (_key, _members, work) => work(null), reducing: (_identity, work) => work() };
    const api = new EbayApiClient({ getAccessToken: async () => "test-token" }, 67, "sandbox", {
      request, quantityAdmission: async () => admission,
    });
    const pending = api.createOrReplaceInventoryItem("P5", { product: { title: "P5", imageUrls: [] }, condition: "NEW",
      availability: { shipToLocationAvailability: { quantity: 4 } } });
    const rejected = expect(pending).rejects.toMatchObject({ code: "QUANTITY_PROVIDER_REQUEST_TIMEOUT", outcome: "uncertain" });
    await vi.advanceTimersByTimeAsync(PROVIDER_REQUEST_TIMEOUT_MS);
    await rejected;
    expect(request).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
