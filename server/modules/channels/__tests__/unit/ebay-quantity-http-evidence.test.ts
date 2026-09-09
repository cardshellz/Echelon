import { describe, expect, it, vi } from "vitest";
import { EbayApiClient } from "../../adapters/ebay/ebay-api.client";
import { classifyEbayQuantityResponse, ebayRetryNotBefore } from "../../adapters/ebay/ebay-quantity-http";
import { QuantityProviderEvidenceCollector, observeEbayQuantityRequest,
  type QuantityProviderRequestStart, type QuantityProviderResponseEvidence } from "../../../inventory-planning/application/quantity-provider-request-evidence";

const clock = () => new Date("2026-09-08T20:00:00.000Z");
const daily = { errors: [{ errorId: 25001, category: "APPLICATION",
  message: "A system error has occurred. You have exceeded your maximum call limit of 250 for item per day. Try back after 1 day." }] };
const item = { product: { title: "Test", imageUrls: [] }, condition: "NEW",
  availability: { shipToLocationAvailability: { quantity: 4 } } };
function setup(request: typeof fetch) {
  const starts: QuantityProviderRequestStart[] = [];
  const results: QuantityProviderResponseEvidence[] = [];
  const store = { start: vi.fn(async (row: QuantityProviderRequestStart) => { starts.push(row); return String(starts.length); }),
    finish: vi.fn(async (_id: string, row: QuantityProviderResponseEvidence) => { results.push(row); }) };
  const collector = new QuantityProviderEvidenceCollector(store, clock);
  const client = new EbayApiClient({ getAccessToken: async () => "secret-token-never-recorded" }, 67, "sandbox", {
    request, now: clock, quantityAdmission: async () => ({ item: (_sku, work) => work(null),
      group: (_key, _members, work) => work(null), reducing: (_identity, work) => work() }),
  });
  return { collector, client, store, starts, results };
}

describe("eBay quantity request evidence and rejection handling", () => {
  it("does not accept a top-level error body as successful HTTP 200", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(daily),{ status: 200 }));
    const test = setup(request);
    await expect(test.collector.run(() => test.client.createOrReplaceInventoryItem("P5",item))).rejects.toThrow("uncertain");
    expect(test.results[0].outcome).toBe("uncertain");
    expect(request.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  });
  it("does not mistake a swallowed rejection for successful owner completion", async () => {
    const test = setup(async () => new Response(JSON.stringify(daily),{ status: 400 }));
    await test.collector.run(() => test.client.createOrReplaceInventoryItem("P5",item).catch(() => undefined));
    expect(() => test.collector.assertNoAmbiguousRequests()).toThrow("rejected");
    expect(test.collector.provesTerminalRejection()).toBe(true);
  });
  it("does not use partial history lacking HTTP evidence to prove terminal rejection", async () => {
    const test = setup(async () => new Response(JSON.stringify(daily),{ status: 400 }));
    await expect(test.collector.run(async () => {
      await observeEbayQuantityRequest({ method: "PUT",path: "/sell/inventory/v1/inventory_item/P5" },async () => undefined);
      await test.client.createOrReplaceInventoryItem("P5",item);
    })).rejects.toThrow("rejected");
    expect(test.collector.provesTerminalRejection()).toBe(false);
  });
  it("fails closed rather than shortening an unrepresentable Retry-After", () => {
    expect(() => ebayRetryNotBefore("999999999999999999999999",clock(),60000)).toThrow("cannot be represented safely");
  });
  it("records before HTTP, retains the exact response hash/id, and rejects a daily limit without retry", async () => {
    const request = vi.fn<typeof fetch>(async () => {
      expect(test.starts).toHaveLength(1);
      return new Response(JSON.stringify(daily), { status: 400, headers: { "x-ebay-c-request-id": "provider-request-123" } });
    });
    const test = setup(request);
    let failure: unknown;
    try { await test.collector.run(() => test.client.createOrReplaceInventoryItem("P5", item)); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "EBAY_QUANTITY_DAILY_LIMIT" });
    expect(test.collector.provesTerminalRejection()).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    expect(test.results).toEqual([expect.objectContaining({ outcome: "rejected", httpStatus: 400,
      providerRequestId: "provider-request-123", responseHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      errorCodes: ["25001"], retryNotBefore: "2026-09-09T20:00:00.000Z" })]);
    expect(JSON.stringify(test.starts)).not.toContain("secret-token");
    expect(JSON.stringify(test.results)).not.toContain("Try back");
  });

  it.each([401,403,429])("retains HTTP %s as a rejection and honors a long Retry-After without sleeping", async status => {
    const request = vi.fn<typeof fetch>(async () => new Response("{}", { status, headers: { "Retry-After": "7200" } }));
    const test = setup(request);
    await expect(test.collector.run(() => test.client.createOrReplaceInventoryItem("P5", item))).rejects.toMatchObject({ code: "EBAY_QUANTITY_REJECTED" });
    expect(test.results[0]).toMatchObject({ outcome: "rejected", retryNotBefore: "2026-09-08T22:00:00.000Z" });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([202,206,207,408,500,502,503])("does not retry ambiguous HTTP %s or turn it into terminal rejection", async status => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(daily), { status }));
    const test = setup(request);
    await expect(test.collector.run(() => test.client.createOrReplaceInventoryItem("P5", item))).rejects.toMatchObject({ code: "EBAY_QUANTITY_RESPONSE_UNCERTAIN" });
    expect(test.results[0].outcome).toBe("uncertain");
    expect(() => test.collector.assertNoAmbiguousRequests()).toThrow();
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not replay a network reset", async () => {
    const request = vi.fn<typeof fetch>(async () => { throw Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }); });
    const test = setup(request);
    await expect(test.collector.run(() => test.client.createOrReplaceInventoryItem("P5", item))).rejects.toThrow("fetch failed");
    expect(request).toHaveBeenCalledOnce();
    expect(test.results[0]).toMatchObject({ outcome: "uncertain", httpStatus: null });
  });

  it.each(["not-json", "{incomplete"])("records malformed success %s as uncertainty", async text => {
    const test = setup(async () => new Response(text, { status: 200 }));
    await expect(test.collector.run(() => test.client.createOrReplaceInventoryItem("P5", item))).rejects.toThrow("uncertain");
    expect(test.results[0]).toMatchObject({ outcome: "uncertain", httpStatus: 200 });
  });

  it("records successful 204 without inventing a provider request id", async () => {
    const test = setup(async () => new Response(null, { status: 204 }));
    await test.collector.run(() => test.client.createOrReplaceInventoryItem("P5", item));
    expect(test.results[0]).toMatchObject({ outcome: "completed", httpStatus: 204, providerRequestId: null });
    expect(() => test.collector.assertNoAmbiguousRequests()).not.toThrow();
  });

  it("does not let a swallowed ambiguous write be followed by another write or successful owner completion", async () => {
    const request = vi.fn<typeof fetch>(async () => { throw new Error("connection lost"); });
    const test = setup(request);
    await test.collector.run(async () => {
      await test.client.createOrReplaceInventoryItem("P5", item).catch(() => undefined);
      await expect(test.client.createOrReplaceInventoryItem("P5", item)).rejects.toMatchObject({ code: "PUBLICATION_REQUEST_EVIDENCE_INCOMPLETE" });
    });
    expect(request).toHaveBeenCalledOnce();
    expect(() => test.collector.assertNoAmbiguousRequests()).toThrow();
  });

  it("does not send when recording the request start fails", async () => {
    const request = vi.fn<typeof fetch>(); const test = setup(request);
    test.store.start.mockRejectedValueOnce(new Error("journal unavailable"));
    await expect(test.collector.run(() => test.client.createOrReplaceInventoryItem("P5", item))).rejects.toThrow("journal unavailable");
    expect(request).not.toHaveBeenCalled();
  });

  it("does not prove terminal rejection when response persistence fails", async () => {
    const test = setup(async () => new Response(JSON.stringify(daily), { status: 400 }));
    test.store.finish.mockRejectedValueOnce(new Error("lost response evidence"));
    let failure: unknown;
    try { await test.collector.run(() => test.client.createOrReplaceInventoryItem("P5", item)); } catch (error) { failure = error; }
    expect(test.collector.provesTerminalRejection()).toBe(false);
    expect(() => test.collector.assertNoAmbiguousRequests()).toThrow();
  });

  it("serializes concurrent observations and drains them before returning from a failed callback", async () => {
    const test = setup(vi.fn<typeof fetch>()); const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = { method: "PUT", path: "/sell/inventory/v1/inventory_item/P5" };
    const owner = test.collector.run(async () => {
      void observeEbayQuantityRequest(first, async () => { events.push("first-start"); await gate; events.push("first-end"); });
      void observeEbayQuantityRequest(first, async () => { events.push("second"); });
      throw new Error("callback failed");
    });
    const outcome = expect(owner).rejects.toThrow("callback failed");
    await vi.waitFor(() => expect(events).toEqual(["first-start"]));
    release(); await outcome;
    expect(events).toEqual(["first-start","first-end","second"]);
    expect(test.starts.map(row => row.ordinal)).toEqual([1,2]);
  });

  it.each([
    [400, { errors: [{ errorId: 25001, category: "APPLICATION", message: "A system error has occurred." }] }, false],
    [400, { errors: [{ errorId: 25709, category: "REQUEST", message: "Invalid Content-Language" }] }, true],
    [400, { errors: [{ errorId: 25001, category: "APPLICATION", message: "Unknown" }, ...daily.errors] }, false],
    [400, {}, false], [408, daily, false], [500, daily, false],
  ])("classifies only explicit rejections (%s)", (status, body, rejected) => {
    expect(classifyEbayQuantityResponse(status as number, body).rejected).toBe(rejected);
  });

  it.each([
    [null,"2026-09-08T20:01:00.000Z"], ["0","2026-09-08T20:01:00.000Z"],
    ["7200","2026-09-08T22:00:00.000Z"], ["Tue, 08 Sep 2026 23:00:00 GMT","2026-09-08T23:00:00.000Z"],
    ["-10","2026-09-08T20:01:00.000Z"], ["nonsense","2026-09-08T20:01:00.000Z"],
  ])("respects retry instructions %s", (raw, expected) => {
    expect(ebayRetryNotBefore(raw,clock(),60000)).toBe(expected);
  });
});
