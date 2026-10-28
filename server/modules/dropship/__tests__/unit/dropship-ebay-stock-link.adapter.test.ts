import { describe, expect, it, vi } from "vitest";
import type { StockLinkDestination } from "@shared/types/stock-link";
import { STOCK_LINK_ERROR_CODES as C, StockLinkError, classifyStockLinkFailure } from "../../../inventory-planning/domain/stock-link-errors";
import { DropshipEbayStockLinkAdapter } from "../../infrastructure/dropship-ebay-stock-link.adapter";
import type { DropshipMarketplaceStoreCredentials } from "../../infrastructure/dropship-marketplace-credentials";
import { DropshipError } from "../../domain/errors";

// Channels PR3: the Dropship eBay stock-link adapter (read-only offer lookup per SKU) with eBay HTTP mocked.

const NOW = new Date("2026-10-28T12:00:00.000Z");
const destination: StockLinkDestination = { publicationTargetId: 9, destinationKind: "dropship_store_connection", providerKey: "ebay",
  channelId: 40, channelConnectionId: null, dropshipStoreConnectionId: 22, providerScopeType: "account",
  externalScopeId: "dropship-seller", targetRevision: "3" };
const signal = new AbortController().signal;

function credential(overrides: Partial<DropshipMarketplaceStoreCredentials> = {}): DropshipMarketplaceStoreCredentials {
  return { vendorId: 10, storeConnectionId: 22, platform: "ebay", status: "connected", shopDomain: null, externalAccountId: "dropship-seller",
    providerEnvironment: "production", externalAccountIdentityScheme: "provider_user_id", externalAccountVerifiedAt: NOW,
    externalDisplayName: null, config: { marketplaceId: "EBAY_US" }, accessToken: "token", accessTokenRef: "a", accessTokenExpiresAt: null,
    refreshToken: null, refreshTokenRef: null, refreshTokenExpiresAt: null, ...overrides };
}

function adapter(responses: Array<() => Response>, options: { credential?: () => Promise<DropshipMarketplaceStoreCredentials>; status?: string } = {}) {
  const fetchFn = vi.fn(async () => responses.shift()!());
  const loadFresh = vi.fn(options.credential ?? (async () => credential()));
  return { fetchFn, loadFresh, adapter: new DropshipEbayStockLinkAdapter({
    destinations: { load: async id => ({ storeConnectionId: id, vendorId: 10, providerKey: "ebay", status: options.status ?? "connected" }) },
    credentials: { loadFreshForStoreConnection: loadFresh }, fetch: fetchFn as unknown as typeof fetch, clock: () => NOW }) };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const offer = (offerId: string, status: string, listingId?: string) =>
  ({ offerId, sku: "P5", marketplaceId: "EBAY_US", status, availableQuantity: 3, ...(listingId ? { listing: { listingId } } : {}) });

async function refusalOf(promise: Promise<unknown>): Promise<StockLinkError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(StockLinkError);
  return error as StockLinkError;
}

describe("DropshipEbayStockLinkAdapter.findOffersBySku", () => {
  it("returns every offer of the SKU on the store's marketplace with its status and listing id, read with the store's login", async () => {
    const { adapter: subject, fetchFn, loadFresh } = adapter([json({ total: 2, offers: [offer("5001", "PUBLISHED", "3990"), offer("4000", "UNPUBLISHED")] })]);
    await expect(subject.findOffersBySku(destination, "P5", { signal })).resolves.toEqual({ observedAt: NOW.toISOString(), sku: "P5",
      marketplaceId: "EBAY_US", offers: [{ offerId: "5001", sku: "P5", status: "PUBLISHED", listingId: "3990" },
        { offerId: "4000", sku: "P5", status: "UNPUBLISHED", listingId: null }] });
    expect(loadFresh).toHaveBeenCalledWith({ vendorId: 10, storeConnectionId: 22, operation: "stock-link-read" });
    const [url, init] = fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.ebay.com/sell/inventory/v1/offer?sku=P5&marketplace_id=EBAY_US&offset=0&limit=200");
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token");
  });

  it("reads eBay's 404 for a SKU without offers as no offers", async () => {
    const { adapter: subject } = adapter([json({ errors: [{ errorId: 25713 }] }, 404)]);
    await expect(subject.findOffersBySku(destination, "P5", { signal })).resolves.toMatchObject({ offers: [] });
  });

  it("classifies eBay's refusals: login → pause, throttle → transient with Retry-After, 5xx → transient, other 4xx → the row's", async () => {
    const cases: Array<[() => Response, string, string]> = [
      [json({}, 401), C.storeAuthRefused, "pause"],
      [json({}, 403), C.storeAuthRefused, "pause"],
      [json({}, 429, { "retry-after": "7" }), C.providerThrottled, "transient"],
      [json({}, 503), C.providerUnavailable, "transient"],
      [json({}, 400), C.lookupRejected, "permanent"],
      [() => new Response("not json", { status: 200 }), C.providerResponseInvalid, "transient"],
    ];
    for (const [response, code, kind] of cases) {
      const error = await refusalOf(adapter([response]).adapter.findOffersBySku(destination, "P5", { signal }));
      expect([error.code, classifyStockLinkFailure(error).kind]).toEqual([code, kind]);
      if (code === C.providerThrottled) expect(error.retryAfterMs).toBe(7_000);
      if (code === C.lookupRejected) expect(classifyStockLinkFailure(error).scope).toBe("row");
    }
  });

  it("never reads with a login that is not the destination's verified account", async () => {
    const { adapter: subject, fetchFn } = adapter([], { credential: async () => credential({ externalAccountId: "someone-else" }) });
    expect((await refusalOf(subject.findOffersBySku(destination, "P5", { signal }))).code).toBe(C.storeAuthRefused);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("pauses on a login that cannot be refreshed and retries one that may refresh later", async () => {
    const lost = adapter([], { credential: async () => { throw new DropshipError("DROPSHIP_X", "refresh token revoked", { retryable: false }); } });
    expect((await refusalOf(lost.adapter.findOffersBySku(destination, "P5", { signal }))).code).toBe(C.storeAuthRefused);
    const later = adapter([], { credential: async () => { throw new DropshipError("DROPSHIP_X", "eBay down", { retryable: true }); } });
    expect((await refusalOf(later.adapter.findOffersBySku(destination, "P5", { signal }))).code).toBe(C.providerUnavailable);
  });

  it("refuses another destination kind, an untrimmed SKU and an answer for another SKU (contract)", async () => {
    const { adapter: subject } = adapter([json({ total: 1, offers: [{ ...offer("5001", "PUBLISHED"), sku: "P6" }] })]);
    const shopify = { ...destination, destinationKind: "channel_connection" as const, providerKey: "shopify", channelConnectionId: 7,
      dropshipStoreConnectionId: null };
    expect((await refusalOf(subject.findOffersBySku(shopify, "P5", { signal }))).code).toBe(C.adapterContract);
    expect((await refusalOf(subject.findOffersBySku(destination, " P5", { signal }))).code).toBe(C.adapterContract);
    expect((await refusalOf(subject.findOffersBySku(destination, "P5", { signal }))).code).toBe(C.adapterContract);
  });

  it("treats a store that is not connected as unavailable (a pause), without reading eBay", async () => {
    const { adapter: subject, fetchFn } = adapter([], { status: "paused" });
    expect((await refusalOf(subject.findOffersBySku(destination, "P5", { signal }))).code).toBe(C.storeUnavailable);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
