import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  EbayDropshipInventoryPublicationTransportAdapter,
} from "../../infrastructure/dropship-ebay-inventory-publication.adapter";
import type { DropshipMarketplaceStoreCredentials } from "../../infrastructure/dropship-marketplace-credentials";
import { QuantityProviderEvidenceCollector, type QuantityProviderResponseEvidence } from "../../../inventory-planning/application/quantity-provider-request-evidence";

describe("EbayDropshipInventoryPublicationTransportAdapter", () => {
  it.each([
    { changed: { externalInventoryItemId: "" }, code: "DROPSHIP_EBAY_INVENTORY_ID_REQUIRED" },
    { changed: { externalSku: "OTHER" }, code: "DROPSHIP_EBAY_INVENTORY_IDENTITY_MISMATCH" },
    { changed: { providerScopeType: "location" as const }, code: "DROPSHIP_EBAY_INVENTORY_SCOPE_UNSUPPORTED" },
  ])("classifies local publication preparation as no-send: $code", async ({ changed, code }) => {
    const fetchFn = vi.fn();
    const { adapter } = fixture(fetchFn);
    await expect(adapter.publishAbsolute({ ...request(), ...changed, desiredQuantity: 7 }))
      .rejects.toMatchObject({ code, effect: "not_sent", retryable: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("preserves exact credential identity context and classifies invalid marketplace before sending", async () => {
    const fetchFn = vi.fn();
    const wrongAccount = fixture(fetchFn, { externalAccountId: "OTHER" });
    await expect(wrongAccount.adapter.publishAbsolute({ ...request(), desiredQuantity: 7 }))
      .rejects.toMatchObject({ code: "DROPSHIP_INVENTORY_ACCOUNT_IDENTITY_MISMATCH", effect: "not_sent", retryable: false,
        context: { storeConnectionId: 77, targetExternalScopeId: "seller-account-1" } });
    const invalidMarket = fixture(fetchFn, { config: { marketplaceId: "INVALID" } });
    await expect(invalidMarket.adapter.publishAbsolute({ ...request(), desiredQuantity: 7 }))
      .rejects.toMatchObject({ code: "EBAY_INVENTORY_MARKETPLACE_INVALID", effect: "not_sent", retryable: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("classifies a failed offer GET as not sent without creating mutation evidence", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("GET connection failed"));
    const { adapter } = fixture(fetchFn);
    const start = vi.fn(async () => "1");
    const collector = new QuantityProviderEvidenceCollector({ start, finish: vi.fn() }, () => new Date("2026-09-04T12:00:00.000Z"));
    await expect(collector.run(() => adapter.publishAbsolute({ ...request(), desiredQuantity: 7 })))
      .rejects.toMatchObject({ effect: "not_sent", code: "DROPSHIP_EBAY_INVENTORY_NETWORK_ERROR", retryable: true });
    expect(collector.provesNoRequestsStarted()).toBe(true);
    expect(start).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("retains a terminal preflight HTTP classification and context while proving no mutation started", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("Invalid offer lookup", { status: 400 }));
    const { adapter } = fixture(fetchFn);
    const start = vi.fn(async () => "1");
    const collector = new QuantityProviderEvidenceCollector({ start, finish: vi.fn() }, () => new Date("2026-09-04T12:00:00.000Z"));
    await expect(collector.run(() => adapter.publishAbsolute({ ...request(), desiredQuantity: 7 })))
      .rejects.toMatchObject({ effect: "not_sent", code: "DROPSHIP_EBAY_INVENTORY_HTTP_ERROR", retryable: false,
        context: { status: 400, body: "Invalid offer lookup" } });
    expect(collector.provesNoRequestsStarted()).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });
  it("preserves the retryable transport contract for an ambiguous write failure", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(offerPage(2))).mockRejectedValueOnce(new Error("fetch failed"));
    const { adapter } = fixture(fetchFn);
    const evidence: QuantityProviderResponseEvidence[] = [];
    const collector = new QuantityProviderEvidenceCollector({ start: async () => "1",finish: async (_id,row) => { evidence.push(row); } },
      () => new Date("2026-09-04T12:00:00.000Z"));
    await expect(collector.run(() => adapter.publishAbsolute({ ...request(),desiredQuantity: 7 })))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_INVENTORY_NETWORK_ERROR",retryable: true });
    expect(evidence[0].outcome).toBe("uncertain");
    expect(collector.provesTerminalRejection()).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it.each([400,401])("retains terminal HTTP %s evidence while preserving Dropship errors and auth health", async status => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(offerPage(2))).mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{
      errorId: 25001,message: "You have exceeded your maximum call limit of 250 for item per day. Try back after 1 day.",
    }] }),{ status }));
    const { adapter,health } = fixture(fetchFn);
    const evidence: QuantityProviderResponseEvidence[] = [];
    const collector = new QuantityProviderEvidenceCollector({ start: async () => "1",
      finish: async (_id,row) => { evidence.push(row); } },() => new Date("2026-09-04T12:00:00.000Z"));
    await expect(collector.run(() => adapter.publishAbsolute({ ...request(),desiredQuantity: 7 })))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_INVENTORY_HTTP_ERROR" });
    expect(collector.provesTerminalRejection()).toBe(true);
    expect(evidence).toEqual([expect.objectContaining({ outcome: "rejected",httpStatus: status,
      retryNotBefore: status===400 ? "2026-09-05T12:00:00.000Z" : "2026-09-04T12:01:00.000Z" })]);
    expect(health.recordAuthFailure).toHaveBeenCalledTimes(status===401 ? 1 : 0);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it("publishes the supplied absolute quantity through the exact Dropship store", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse(offerPage(2)))
      .mockResolvedValueOnce(jsonResponse({ responses: [
        { sku: "SKU-101", statusCode: 200 }, { sku: "SKU-101", offerId: "offer-1", statusCode: 200 },
      ] }));
    const { adapter, credentials } = fixture(fetchFn);

    await expect(adapter.publishAbsolute({
      ...request(),
      desiredQuantity: 7,
    })).resolves.toEqual({ publishedQuantity: 7, providerResponse: { sku: "SKU-101", marketplaceId: "EBAY_US", offerId: "offer-1", quantity: 7,
      effect: "updated", providerWriteAttempted: true } });

    expect(credentials.loadFreshForStoreConnection).toHaveBeenCalledWith({
      vendorId: 12,
      storeConnectionId: 77,
    });
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      "https://api.ebay.com/sell/inventory/v1/offer?sku=SKU-101&marketplace_id=EBAY_US&offset=0&limit=200",
      expect.objectContaining({ method: "GET" }),
    );
    const post = fetchFn.mock.calls[1]![1] as RequestInit;
    expect(fetchFn.mock.calls[1]![0]).toBe("https://api.ebay.com/sell/inventory/v1/bulk_update_price_quantity");
    expect(post.method).toBe("POST");
    expect(post.headers).toMatchObject({ Authorization: "Bearer secret-token" });
    // eBay refuses Sell API calls without the locale headers (25709).
    expect(post.headers).toMatchObject({ "Accept-Language": "en-US", "Content-Language": "en-US", "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" });
    const read = fetchFn.mock.calls[0]![1] as RequestInit;
    expect(read.headers).toMatchObject({ "Accept-Language": "en-US", "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" });
    expect(read.headers).not.toHaveProperty("Content-Language");
    expect(JSON.parse(String(post.body))).toEqual({
      requests: [{ sku: "SKU-101", shipToLocationAvailability: { quantity: 7 }, offers: [{ offerId: "offer-1", availableQuantity: 7 }] }],
    });
  });

  it.each([
    { itemQuantity: 12, offerQuantity: 9, observedQuantity: 9, quantityConsistent: false },
    { itemQuantity: 9, offerQuantity: 12, observedQuantity: 9, quantityConsistent: false },
    { itemQuantity: 0, offerQuantity: 9, observedQuantity: 0, quantityConsistent: false },
    { itemQuantity: 9, offerQuantity: 0, observedQuantity: 0, quantityConsistent: false },
    { itemQuantity: 9, offerQuantity: 9, observedQuantity: 9, quantityConsistent: true },
    { itemQuantity: 0, offerQuantity: 0, observedQuantity: 0, quantityConsistent: true },
    { itemQuantity: Number.MAX_SAFE_INTEGER, offerQuantity: Number.MAX_SAFE_INTEGER,
      observedQuantity: Number.MAX_SAFE_INTEGER, quantityConsistent: true },
  ])("forwards provider quantity and consistency without another ATP formula (item=$itemQuantity, offer=$offerQuantity)", async ({
    itemQuantity, offerQuantity, observedQuantity, quantityConsistent,
  }) => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(offerPage(offerQuantity)))
      .mockResolvedValueOnce(jsonResponse(inventoryItem(itemQuantity)));
    const { adapter } = fixture(fetchFn);

    await expect(adapter.readAbsolute(request())).resolves.toEqual({
      observedQuantity,
      quantityConsistent,
      providerResponse: {
        sku: "SKU-101", marketplaceId: "EBAY_US", offerId: "offer-1",
        inventoryItemQuantity: itemQuantity, offerQuantity, observedQuantity, quantityConsistent,
      },
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
  });
  it("returns exact read-only convergence without creating a listing or sending a quantity mutation", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(offerPage(9))).mockResolvedValueOnce(jsonResponse(inventoryItem(9)));
    const { adapter } = fixture(fetchFn);
    await expect(adapter.publishAbsolute({ ...request(), desiredQuantity: 9 })).resolves.toMatchObject({
      publishedQuantity: 9, providerResponse: { effect: "already_current", providerWriteAttempted: false,
        observation: { inventoryItemQuantity: 9, offerQuantity: 9, observedQuantity: 9 } },
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls.every(([,init]) => init.method === "GET")).toBe(true);
  });

  it("uses the registered provider inventory-item ID when the optional SKU is absent", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(offerPage(9))).mockResolvedValueOnce(jsonResponse(inventoryItem(9)));
    const { adapter } = fixture(fetchFn);

    await expect(adapter.readAbsolute({
      ...request(),
      externalSku: null,
    })).resolves.toMatchObject({ observedQuantity: 9 });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.ebay.com/sell/inventory/v1/inventory_item/SKU-101",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("fails closed when the inventory-item ID conflicts with the optional SKU", async () => {
    const fetchFn = vi.fn();
    const { adapter } = fixture(fetchFn);

    await expect(adapter.readAbsolute({
      ...request(),
      externalInventoryItemId: "DIFFERENT-SKU",
    })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_INVENTORY_IDENTITY_MISMATCH",
      retryable: false,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fails closed when the target account differs from the verified store account", async () => {
    const fetchFn = vi.fn();
    const { adapter } = fixture(fetchFn, {
      externalAccountId: "different-seller",
    });

    await expect(adapter.readAbsolute(request())).rejects.toMatchObject({
      code: "DROPSHIP_INVENTORY_ACCOUNT_IDENTITY_MISMATCH",
      retryable: false,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("invalidates a rejected access token and returns a retryable failure", async () => {
    const fetchFn = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const { adapter, health } = fixture(fetchFn);

    await expect(adapter.readAbsolute(request())).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_INVENTORY_HTTP_ERROR",
      retryable: true,
    });
    expect(health.recordAuthFailure).toHaveBeenCalledWith(expect.objectContaining({
      vendorId: 12,
      storeConnectionId: 77,
      status: "refresh_failed",
      invalidateAccessToken: true,
    }));
  });
  it("never writes when offer discovery is ambiguous", async () => {
    const offer = offerPage(7).offers[0]!;
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ total: 2, offers: [offer, { ...offer, offerId: "offer-2" }] }));
    const { adapter } = fixture(fetchFn);
    await expect(adapter.publishAbsolute({ ...request(), desiredQuantity: 7 }))
      .rejects.toMatchObject({ code: "EBAY_INVENTORY_OFFER_AMBIGUOUS", retryable: false });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]![1]).toMatchObject({ method: "GET" });
  });
  it("does not report a partial HTTP-200 bulk result as a successful publication", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(offerPage(2)))
      .mockResolvedValueOnce(jsonResponse({ responses: [{ sku: "SKU-101", offerId: "offer-1", statusCode: 400 }] }));
    const { adapter } = fixture(fetchFn);
    await expect(adapter.publishAbsolute({ ...request(), desiredQuantity: 7 }))
      .rejects.toMatchObject({ code: "EBAY_INVENTORY_ACKNOWLEDGEMENT_INVALID", retryable: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it.each([null, false, "0", -1])("does not turn invalid item quantity %s into zero", async (quantity) => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(offerPage(7)))
      .mockResolvedValueOnce(jsonResponse({ ...inventoryItem(0), availability: { shipToLocationAvailability: { quantity } } }));
    await expect(fixture(fetchFn).adapter.readAbsolute(request())).rejects.toMatchObject({ code: "EBAY_INVENTORY_QUANTITY_INVALID" });
  });
  it("keeps configured marketplace and independently owned credentials", async () => {
    const page = offerPage(7);
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse({ ...page, offers: page.offers.map(offer => ({ ...offer, marketplaceId: "EBAY_GB" })) }))
      .mockResolvedValueOnce(jsonResponse(inventoryItem(7)));
    await fixture(fetchFn, { config: { marketplaceId: "EBAY_GB" } }).adapter.readAbsolute(request());
    expect(fetchFn.mock.calls[0]![0]).toContain("marketplace_id=EBAY_GB");
    expect(fetchFn.mock.calls[0]![1].headers).toMatchObject({ Authorization: "Bearer secret-token" });
  });
});

// Fix PR 2a-2 (plan F2 2.9.2-2.9.3): a quantity reaches only the offer the
// listing's own completed push recorded; while a push runs it waits (retryable).
describe("EbayDropshipInventoryPublicationTransportAdapter offer identity", () => {
  const noPublishedOffer = () => jsonResponse({ total: 1, offers: [{ ...offerPage(0).offers[0]!, status: "UNPUBLISHED" }] });
  const posts = (fetchFn: ReturnType<typeof vi.fn>) => fetchFn.mock.calls.filter(([, init]) => (init as RequestInit).method === "POST");

  it("reads the recorded offer for the exact store and variant", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(offerPage(2))).mockResolvedValueOnce(jsonResponse({ responses: [
      { sku: "SKU-101", offerId: "offer-1", statusCode: 200 }] }));
    const { adapter, identities } = fixture(fetchFn);
    await adapter.publishAbsolute({ ...request(), desiredQuantity: 7 });
    expect(identities.load).toHaveBeenCalledWith(77, 101);
  });

  it.each([
    ["no offer is PUBLISHED yet", () => noPublishedOffer()],
    ["the offer lookup answers 404", () => new Response("not found", { status: 404 })],
  ])("defers as retryable while a push is in flight when %s", async (_name, response) => {
    for (const operation of ["publish", "read"] as const) {
      const fetchFn = vi.fn().mockResolvedValue(response());
      const { adapter } = fixture(fetchFn, {}, { externalOfferId: null, pushInFlight: true });
      const call = operation === "publish" ? adapter.publishAbsolute({ ...request(), desiredQuantity: 7 }) : adapter.readAbsolute(request());
      await expect(call).rejects.toMatchObject({ code: "DROPSHIP_EBAY_LISTING_PUSH_IN_FLIGHT", effect: "not_sent", retryable: true,
        context: { storeConnectionId: 77, productVariantId: 101, recordedOfferId: null, pushInFlight: true } });
      expect(posts(fetchFn)).toEqual([]);
    }
  });

  it("keeps the original dead-letter classification when no push is in flight", async () => {
    const fetchFn = vi.fn().mockResolvedValue(noPublishedOffer());
    const { adapter } = fixture(fetchFn, {}, { externalOfferId: "offer-1", pushInFlight: false });
    await expect(adapter.publishAbsolute({ ...request(), desiredQuantity: 7 }))
      .rejects.toMatchObject({ code: "EBAY_INVENTORY_OFFER_AMBIGUOUS", effect: "not_sent", retryable: false });
    const missing = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }));
    await expect(fixture(missing, {}, { externalOfferId: "offer-1", pushInFlight: false }).adapter.publishAbsolute({ ...request(), desiredQuantity: 7 }))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_INVENTORY_HTTP_ERROR", retryable: false, context: { status: 404, operation: "offer_lookup" } });
  });

  it("refuses a PUBLISHED offer that is not the recorded one, with no quantity request", async () => {
    const fetchFn = vi.fn().mockImplementation(async () => jsonResponse(offerPage(2)));
    const { adapter } = fixture(fetchFn, {}, { externalOfferId: "offer-recorded", pushInFlight: false });
    await expect(adapter.publishAbsolute({ ...request(), desiredQuantity: 7 })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_OFFER_IDENTITY_CHANGED", effect: "not_sent", retryable: false,
      context: { recordedOfferId: "offer-recorded", publishedOfferId: "offer-1" } });
    await expect(adapter.readAbsolute(request())).rejects.toMatchObject({ code: "DROPSHIP_EBAY_OFFER_IDENTITY_CHANGED", retryable: false });
    expect(posts(fetchFn)).toEqual([]);
  });

  // Review CF-7: a re-push that replaces the listing's offer records the new one only when it completes; a drain in
  // between waits (retryable, the outbox's bounded attempts) instead of losing that revision to a dead letter.
  // Review AV1-1: that wait has its own class, because a PUBLISHED offer is on sale (ops-health counts it once the
  // outbox gives up and no push runs any more); the no-offer-yet wait above keeps DROPSHIP_EBAY_LISTING_PUSH_IN_FLIGHT.
  it("waits for a running push when the PUBLISHED offer differs from the recorded one, sending nothing", async () => {
    const fetchFn = vi.fn().mockImplementation(async () => jsonResponse(offerPage(2)));
    const { adapter } = fixture(fetchFn, {}, { externalOfferId: "offer-recorded", pushInFlight: true });
    await expect(adapter.publishAbsolute({ ...request(), desiredQuantity: 7 })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_PUBLISHED_OFFER_PUSH_IN_FLIGHT", effect: "not_sent", retryable: true,
      context: { recordedOfferId: "offer-recorded", publishedOfferId: "offer-1", pushInFlight: true } });
    await expect(adapter.readAbsolute(request())).rejects.toMatchObject({ code: "DROPSHIP_EBAY_PUBLISHED_OFFER_PUSH_IN_FLIGHT", retryable: true });
    expect(posts(fetchFn)).toEqual([]);
  });

  it("waits for a running push to record its offer, and refuses an unrecorded offer when none runs", async () => {
    const inFlight = vi.fn().mockResolvedValue(jsonResponse(offerPage(2)));
    await expect(fixture(inFlight, {}, { externalOfferId: null, pushInFlight: true }).adapter.publishAbsolute({ ...request(), desiredQuantity: 7 }))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_PUBLISHED_OFFER_PUSH_IN_FLIGHT", effect: "not_sent", retryable: true, context: { publishedOfferId: "offer-1" } });
    const unproven = vi.fn().mockResolvedValue(jsonResponse(offerPage(2)));
    await expect(fixture(unproven, {}, { externalOfferId: null, pushInFlight: false }).adapter.publishAbsolute({ ...request(), desiredQuantity: 7 }))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_OFFER_IDENTITY_UNPROVEN", effect: "not_sent", retryable: false });
    expect([...posts(inFlight), ...posts(unproven)]).toEqual([]);
  });

  // Review TW-5: without the reader every Dropship eBay outbox send fails closed, so the env factory's wiring is pinned.
  it("is built with the Dropship listing identity reader by the production factory", () => {
    const source = readFileSync(resolve(__dirname, "../../infrastructure/dropship-ebay-inventory-publication.adapter.ts"), "utf8");
    const factory = source.slice(source.indexOf("export function createEbayDropshipInventoryPublicationTransportAdapterFromEnv"));
    expect(factory.slice(0, factory.indexOf("\n}\n"))).toMatch(/new EbayDropshipInventoryPublicationTransportAdapter\([\s\S]*new PgDropshipInventoryListingIdentityReader\(\),[\s\S]*\);/);
  });

  it("fails closed, before any eBay call, when built without the identity reader", async () => {
    const fetchFn = vi.fn();
    const adapter = new EbayDropshipInventoryPublicationTransportAdapter(
      { load: async () => ({ storeConnectionId: 77, vendorId: 12, providerKey: "ebay", status: "connected" }) },
      { loadFreshForStoreConnection: async () => credential({}) }, { recordAuthFailure: vi.fn() } as never, fetchFn as typeof fetch);
    await expect(adapter.publishAbsolute({ ...request(), desiredQuantity: 7 })).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_IDENTITY_READER_REQUIRED", effect: "not_sent", retryable: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// eBay sync-back owner rule 1 (plan v4 §6.4 SB31, review OR-2): a stock update never erases a vendor's lower eBay
// number before the sync job decides it. B = 10 settled before the read, 2 sold since, so E_low = 8.
describe("EbayDropshipInventoryPublicationTransportAdapter quantity pre-write guard", () => {
  const NOW = new Date("2026-09-04T12:00:00.000Z");
  const facts = (overrides: Record<string, unknown> = {}) => ({ listingId: 501,
    baseline: { quantity: 10, at: new Date("2026-09-04T10:00:00.000Z"), settled: true }, salesAll: 2,
    salesLedgerSince: new Date("2026-09-01T00:00:00.000Z"), listingLive: true, ...overrides });
  const posts = (fetchFn: ReturnType<typeof vi.fn>) => fetchFn.mock.calls.filter(([, init]) => (init as RequestInit).method === "POST");
  const acknowledged = () => jsonResponse({ responses: [{ sku: "SKU-101", offerId: "offer-1", statusCode: 200 }] });

  it("refuses a raise over eBay's unexplained lower number before any write, and marks the listing for the sync job", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(offerPage(4)));
    const { adapter, guard } = fixture(fetchFn, {}, undefined, facts());
    await expect(adapter.publishAbsolute({ ...request(), desiredQuantity: 10 })).rejects.toMatchObject({
      code: "DROPSHIP_QUANTITY_VENDOR_CHANGE_PENDING", effect: "not_sent", retryable: true,
      context: { storeConnectionId: 77, productVariantId: 101, listingId: 501, desiredQuantity: 10, observedQuantity: 4, expectedLow: 8 } });
    expect(posts(fetchFn)).toEqual([]);
    expect(guard.load).toHaveBeenCalledWith(77, 101, NOW);
    expect(guard.markDue).toHaveBeenCalledExactlyOnceWith(501);
  });

  it("publishes when eBay's number is explained by sales, when the write is not a raise, and without a judgeable listing", async () => {
    for (const [offerQuantity, desiredQuantity, loaded] of [[8, 10, facts()], [4, 3, facts()], [4, 4, facts()], [4, 10, null],
      [4, 10, facts({ baseline: null })], [4, 10, facts({ salesLedgerSince: null })]] as const) {
      const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(offerPage(offerQuantity)))
        .mockResolvedValueOnce(desiredQuantity === offerQuantity ? jsonResponse(inventoryItem(offerQuantity)) : acknowledged());
      const { adapter, guard } = fixture(fetchFn, {}, undefined, loaded);
      await expect(adapter.publishAbsolute({ ...request(), desiredQuantity })).resolves.toMatchObject({ publishedQuantity: desiredQuantity });
      expect(guard.markDue).not.toHaveBeenCalled();
    }
  });

  it("still refuses, as not sent, when marking the listing due fails", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(offerPage(4)));
    const { adapter, guard } = fixture(fetchFn, {}, undefined, facts());
    guard.markDue.mockRejectedValueOnce(new Error("connection reset"));
    await expect(adapter.publishAbsolute({ ...request(), desiredQuantity: 10 })).rejects.toMatchObject({
      code: "DROPSHIP_QUANTITY_VENDOR_CHANGE_PENDING", effect: "not_sent", retryable: true });
    expect(posts(fetchFn)).toEqual([]);
  });

  it("never guards the read-back", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(offerPage(4))).mockResolvedValueOnce(jsonResponse(inventoryItem(4)));
    const { adapter, guard } = fixture(fetchFn, {}, undefined, facts());
    await expect(adapter.readAbsolute(request())).resolves.toMatchObject({ observedQuantity: 4 });
    expect(guard.load).not.toHaveBeenCalled();
  });

  it("is built with the Dropship quantity guard reader by the production factory", () => {
    const source = readFileSync(resolve(__dirname, "../../infrastructure/dropship-ebay-inventory-publication.adapter.ts"), "utf8");
    const factory = source.slice(source.indexOf("export function createEbayDropshipInventoryPublicationTransportAdapterFromEnv"));
    expect(factory.slice(0, factory.indexOf("\n}\n"))).toMatch(/new PgDropshipQuantityPreWriteGuardReader\(\),\s*\);/);
  });
});

function fixture(
  fetchFn: ReturnType<typeof vi.fn>,
  credentialOverrides: Partial<DropshipMarketplaceStoreCredentials> = {},
  identity: { externalOfferId: string | null; pushInFlight: boolean } = { externalOfferId: "offer-1", pushInFlight: false },
  guardFacts: Record<string, unknown> | null = null,
) {
  const destinations = {
    load: vi.fn(async () => ({
      storeConnectionId: 77,
      vendorId: 12,
      providerKey: "ebay",
      status: "connected",
    })),
  };
  const credentials = {
    loadFreshForStoreConnection: vi.fn(async () => credential(credentialOverrides)),
  };
  const health = { recordAuthFailure: vi.fn(async () => ({}) as never) };
  // The listing's recorded offer (the last completed push) and whether a push runs now.
  const identities = { load: vi.fn(async () => identity) };
  // What the pre-write quantity guard judges (null: nothing to judge, the write goes as before).
  const guard = { load: vi.fn(async () => guardFacts as never), markDue: vi.fn(async () => undefined) };
  return {
    adapter: new EbayDropshipInventoryPublicationTransportAdapter(
      destinations,
      credentials,
      health,
      fetchFn as typeof fetch,
      { now: () => new Date("2026-09-04T12:00:00.000Z") },
      identities,
      guard,
    ),
    credentials,
    health,
    identities,
    guard,
  };
}

function request() {
  return {
    destination: {
      kind: "dropship_store_connection" as const,
      channelConnectionId: null,
      dropshipStoreConnectionId: 77,
    },
    channelId: 3,
    providerScopeType: "account" as const,
    externalScopeId: "seller-account-1",
    productVariantId: 101,
    externalInventoryItemId: "SKU-101",
    externalSku: "SKU-101",
  };
}

function credential(
  overrides: Partial<DropshipMarketplaceStoreCredentials>,
): DropshipMarketplaceStoreCredentials {
  return {
    vendorId: 12,
    storeConnectionId: 77,
    platform: "ebay",
    status: "connected",
    shopDomain: null,
    externalAccountId: "seller-account-1",
    providerEnvironment: "production",
    externalAccountIdentityScheme: "provider_user_id",
    externalAccountVerifiedAt: new Date("2026-09-01T00:00:00.000Z"),
    externalDisplayName: "Seller",
    config: {},
    accessToken: "secret-token",
    accessTokenRef: "token-ref",
    accessTokenExpiresAt: new Date("2026-09-05T00:00:00.000Z"),
    refreshToken: "refresh-token",
    refreshTokenRef: "refresh-ref",
    refreshTokenExpiresAt: null,
    ...overrides,
  };
}

function inventoryItem(quantity: number) {
  return {
    sku: "SKU-101",
    availability: { shipToLocationAvailability: { quantity } },
    condition: "NEW",
    product: { title: "Example" },
  };
}

function offerPage(availableQuantity: number) {
  return { total: 1, offers: [{ sku: "SKU-101", marketplaceId: "EBAY_US", offerId: "offer-1", status: "PUBLISHED", availableQuantity }] };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
