import { describe, expect, it } from "vitest";
import { EbayDropshipListingPushProvider } from "../../infrastructure/dropship-ebay-listing-push.provider";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreAuthFailureInput,
  DropshipMarketplaceStoreAuthFailureRecord,
  DropshipMarketplaceStoreCredentials,
} from "../../infrastructure/dropship-marketplace-credentials";
import { DropshipError } from "../../domain/errors";
import { classifyMarketplaceSyncError, MARKETPLACE_SYNC_CODES } from "../../domain/marketplace-sync-errors";

/**
 * eBay sync-back's read of one live listing (plan v4 SB2): the offer by its
 * saved id and the inventory item by our SKU, with the vendor's token, GET
 * only. Nothing here may write to eBay. No live or sandbox eBay call: the
 * provider's fetch is a script.
 */
describe("EbayDropshipListingPushProvider.readLiveListing", () => {
  const offer = { offerId: "OFFER-1", sku: "SKU-1", status: "PUBLISHED" };
  const item = { sku: "SKU-1", availability: { shipToLocationAvailability: { quantity: 4 } } };
  const read = { vendorId: 10, storeConnectionId: 22, offerId: "OFFER-1", sku: "SKU-1" };

  function setup(responses: Response[], credentials = new FakeCredentialRepository(ebayCredential())) {
    const fetcher = new FakeFetch(responses);
    const provider = new EbayDropshipListingPushProvider(credentials, fetcher.fetch, { now: () => new Date("2026-10-22T12:00:00.000Z") });
    return { provider, fetcher, credentials };
  }

  it("GETs the offer by its saved id and the item by our SKU with the vendor's token, and returns both answers raw", async () => {
    const { provider, fetcher } = setup([json(offer), json(item)]);

    await expect(provider.readLiveListing({ ...read, offerId: "OFFER 1/x", sku: "SKU 1/y" }))
      .resolves.toEqual({ kind: "read", offer, inventoryItem: item });

    expect(fetcher.calls.map((call) => [call.init.method, call.url])).toEqual([
      ["GET", "https://api.ebay.com/sell/inventory/v1/offer/OFFER%201%2Fx"],
      ["GET", "https://api.ebay.com/sell/inventory/v1/inventory_item/SKU%201%2Fy"],
    ]);
    for (const call of fetcher.calls) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer ebay-token");
      expect(headers["Content-Language"]).toBeUndefined();
      expect(headers["X-EBAY-C-MARKETPLACE-ID"]).toBeUndefined();
      expect(call.init.body).toBeUndefined();
    }
  });

  it("answers offer_missing on a 404 for the offer, without reading the item", async () => {
    const { provider, fetcher } = setup([json({ errors: [{ errorId: 25713 }] }, 404)]);
    await expect(provider.readLiveListing(read)).resolves.toEqual({ kind: "offer_missing" });
    expect(fetcher.calls).toHaveLength(1);
  });

  it("returns a missing inventory item, or an answer that is not JSON, as null, which validation reads as unreadable", async () => {
    await expect(setup([json(offer), json({ errors: [] }, 404)]).provider.readLiveListing(read))
      .resolves.toEqual({ kind: "read", offer, inventoryItem: null });
    await expect(setup([new Response("<html>oops</html>", { status: 200 }), json(item)]).provider.readLiveListing(read))
      .resolves.toEqual({ kind: "read", offer: null, inventoryItem: item });
  });

  it("throws eBay's throttle as a classified error that stops the store for the tick", async () => {
    const { provider } = setup([json({ errors: [{ errorId: 2001 }] }, 429)]);
    const error = await provider.readLiveListing(read).catch((caught) => caught);
    expect(error).toMatchObject({ code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", context: expect.objectContaining({ status: 429, method: "GET" }) });
    expect(classifyMarketplaceSyncError(error).handling).toBe("stop_store");
  });

  it("records a refused token so the next load refreshes it, and skips the store", async () => {
    const { provider, credentials } = setup([json({ errors: [] }, 401)]);
    const error = await provider.readLiveListing(read).catch((caught) => caught);
    expect(classifyMarketplaceSyncError(error).handling).toBe("skip_store");
    expect(credentials.authFailures).toEqual([expect.objectContaining({ storeConnectionId: 22, invalidateAccessToken: true })]);
  });

  it("names a store whose credentials cannot be loaded as unavailable (the whole store waits), before any eBay call", async () => {
    const credentials = new FakeCredentialRepository(ebayCredential());
    credentials.loadError = new DropshipError("DROPSHIP_STORE_CONNECTION_NOT_CONNECTED", "gone", { retryable: false });
    const { provider, fetcher } = setup([], credentials);
    const error = await provider.readLiveListing(read).catch((caught) => caught);
    expect(error).toMatchObject({ code: MARKETPLACE_SYNC_CODES.storeUnavailable,
      context: expect.objectContaining({ causeCode: "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED" }) });
    expect(classifyMarketplaceSyncError(error).handling).toBe("skip_store");
    expect(fetcher.calls).toEqual([]);
  });

  it("refuses a read without a saved offer id or SKU before any call", async () => {
    const { provider, fetcher } = setup([]);
    await expect(provider.readLiveListing({ ...read, offerId: " " })).rejects.toMatchObject({ code: MARKETPLACE_SYNC_CODES.invariantFailed });
    await expect(provider.readLiveListing({ ...read, sku: "" })).rejects.toMatchObject({ code: MARKETPLACE_SYNC_CODES.invariantFailed });
    expect(fetcher.calls).toEqual([]);
  });
});

class FakeCredentialRepository implements DropshipMarketplaceCredentialRepository {
  authFailures: DropshipMarketplaceStoreAuthFailureInput[] = [];
  loadError: Error | null = null;
  constructor(private credential: DropshipMarketplaceStoreCredentials) {}
  async loadForStoreConnection(): Promise<DropshipMarketplaceStoreCredentials> {
    if (this.loadError) throw this.loadError;
    return this.credential;
  }
  async replaceTokens(): Promise<DropshipMarketplaceStoreCredentials> {
    return this.credential;
  }
  async recordAuthFailure(input: DropshipMarketplaceStoreAuthFailureInput): Promise<DropshipMarketplaceStoreAuthFailureRecord> {
    this.authFailures.push(input);
    return { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, platform: input.platform, previousStatus: "connected",
      status: input.status, transitioned: true };
  }
}

class FakeFetch {
  calls: Array<{ url: string; init: RequestInit }> = [];
  constructor(private responses: Response[]) {}
  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    this.calls.push({ url: String(url), init: init ?? {} });
    const response = this.responses.shift();
    if (!response) throw new Error(`No fake response for ${String(url)}`);
    return response;
  };
}

function ebayCredential(): DropshipMarketplaceStoreCredentials {
  return {
    vendorId: 10, storeConnectionId: 22, platform: "ebay", status: "connected", shopDomain: null, externalAccountId: "seller-1",
    providerEnvironment: "production", externalAccountIdentityScheme: "provider_user_id",
    externalAccountVerifiedAt: new Date("2026-05-01T00:00:00.000Z"), externalDisplayName: "seller-1", config: {},
    accessToken: "ebay-token", accessTokenRef: "access-ref", accessTokenExpiresAt: new Date("2099-05-01T21:00:00.000Z"),
    refreshToken: "refresh-token", refreshTokenRef: "refresh-ref", refreshTokenExpiresAt: null,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
