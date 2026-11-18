import { describe, expect, it, vi } from "vitest";

// The zero write never reads published content; stubbing its reader keeps this unit test off the catalog image stack.
vi.mock("../../../channels/adapters/ebay/ebay-published-content.reader", () => ({ readEbayPublishedContent: vi.fn() }));
import { EbayDropshipListingPushProvider } from "../../infrastructure/dropship-ebay-listing-push.provider";
import type { EbayQuantityRequestAdmission } from "../../../channels/quantity-publication-request";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreAuthFailureInput,
  DropshipMarketplaceStoreAuthFailureRecord,
  DropshipMarketplaceStoreCredentials,
} from "../../infrastructure/dropship-marketplace-credentials";

/**
 * The quantity-only write of 0 for a live listing with no stock (legacy ATP authority). No live or sandbox eBay call:
 * the provider's fetch is a script. It must send ONLY quantity (no price, content or policy), only to the listing's
 * recorded offer, and only through the inventory quantity admission (an all-zero write is a reducing lifecycle).
 */
describe("EbayDropshipListingPushProvider.sendZeroQuantity", () => {
  const target = { vendorId: 10, storeConnectionId: 22, listingId: 4, productVariantId: 101, sku: "P5", externalOfferId: "OFFER-4" };
  const offersPage = (offers: Array<Record<string, unknown>>) => json({ total: offers.length, offers });
  const publishedOffer = { offerId: "OFFER-4", sku: "P5", marketplaceId: "EBAY_US", status: "PUBLISHED", availableQuantity: 6 };
  const bulkOk = () => json({ responses: [{ statusCode: 200, sku: "P5" }, { statusCode: 200, sku: "P5", offerId: "OFFER-4" }] });

  function setup(responses: Response[]) {
    const fetcher = new FakeFetch(responses);
    const admitted: Array<{ kind: string; identity: string }> = [];
    const admission: EbayQuantityRequestAdmission = {
      item: async (sku, work) => { admitted.push({ kind: "item", identity: sku }); return work(null); },
      group: async (key, _skus, work) => { admitted.push({ kind: "group", identity: key }); return work(null); },
      reducing: async (identity, work) => { admitted.push({ kind: "reducing", identity }); return work(); },
    };
    const provider = new EbayDropshipListingPushProvider(new FakeCredentialRepository(ebayCredential()), fetcher.fetch,
      { now: () => new Date("2026-11-07T12:00:00.000Z") }, undefined, undefined, () => admission);
    return { provider, fetcher, admitted };
  }

  it("discovers the SKU's offers, then sends a quantity-only 0 to the recorded offer through the reducing admission", async () => {
    const { provider, fetcher, admitted } = setup([offersPage([publishedOffer]), bulkOk()]);
    await expect(provider.sendZeroQuantity(target)).resolves.toEqual({ sku: "P5", offerId: "OFFER-4" });
    expect(fetcher.calls.map((call) => [call.init.method, new URL(call.url).pathname])).toEqual([
      ["GET", "/sell/inventory/v1/offer"],
      ["POST", "/sell/inventory/v1/bulk_update_price_quantity"],
    ]);
    expect(new URL(fetcher.calls[0]!.url).searchParams.get("marketplace_id")).toBe("EBAY_US");
    // Only quantity: no price, no content, no policy fields.
    expect(JSON.parse(String(fetcher.calls[1]!.init.body))).toEqual({ requests: [{ sku: "P5",
      shipToLocationAvailability: { quantity: 0 }, offers: [{ offerId: "OFFER-4", availableQuantity: 0 }] }] });
    expect(admitted).toEqual([{ kind: "reducing", identity: "P5" }]);
  });

  it("sends the same 0 again on replay, even when eBay already shows 0 (no read-only shortcut)", async () => {
    const { provider, fetcher } = setup([offersPage([{ ...publishedOffer, availableQuantity: 0 }]), bulkOk(),
      offersPage([{ ...publishedOffer, availableQuantity: 0 }]), bulkOk()]);
    await provider.sendZeroQuantity(target);
    await provider.sendZeroQuantity(target);
    const bodies = fetcher.calls.filter((call) => call.init.method === "POST").map((call) => call.init.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it.each([
    ["another published offer", [{ ...publishedOffer, offerId: "OFFER-9" }]],
    ["no published offer", [{ ...publishedOffer, status: "UNPUBLISHED" }]],
    ["two published offers", [publishedOffer, { ...publishedOffer, offerId: "OFFER-9" }]],
  ])("sends nothing when eBay's live offer is not provably the recorded one (%s)", async (_name, offers) => {
    const { provider, fetcher, admitted } = setup([offersPage(offers)]);
    await expect(provider.sendZeroQuantity(target)).rejects.toMatchObject({ code: "DROPSHIP_EBAY_ZERO_QUANTITY_OFFER_MISMATCH",
      context: expect.objectContaining({ retryable: false }) });
    expect(fetcher.calls.map((call) => call.init.method)).toEqual(["GET"]);
    expect(admitted).toEqual([]);
  });

  it("refuses a missing SKU or offer id before any eBay call", async () => {
    const { provider, fetcher } = setup([]);
    await expect(provider.sendZeroQuantity({ ...target, externalOfferId: " " }))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_ZERO_QUANTITY_IDENTITY_REQUIRED" });
    await expect(provider.sendZeroQuantity({ ...target, sku: " P5" }))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_ZERO_QUANTITY_IDENTITY_REQUIRED" });
    expect(fetcher.calls).toEqual([]);
  });

  it("does not claim success when eBay does not confirm the exact SKU and offer", async () => {
    const { provider } = setup([offersPage([publishedOffer]),
      json({ responses: [{ statusCode: 500, sku: "P5", errors: [{ errorId: 25001 }] }, { statusCode: 200, sku: "P5", offerId: "OFFER-4" }] })]);
    await expect(provider.sendZeroQuantity(target)).rejects.toBeTruthy();
  });

  it("fails closed without a quantity admission (no unadmitted quantity write)", async () => {
    const fetcher = new FakeFetch([offersPage([publishedOffer])]);
    const provider = new EbayDropshipListingPushProvider(new FakeCredentialRepository(ebayCredential()), fetcher.fetch,
      { now: () => new Date("2026-11-07T12:00:00.000Z") });
    await expect(provider.sendZeroQuantity(target)).rejects.toMatchObject({ code: "QUANTITY_PUBLICATION_ADMISSION_REQUIRED" });
    expect(fetcher.calls.map((call) => call.init.method)).toEqual(["GET"]);
  });
});

class FakeCredentialRepository implements DropshipMarketplaceCredentialRepository {
  constructor(private credential: DropshipMarketplaceStoreCredentials) {}
  async loadForStoreConnection(): Promise<DropshipMarketplaceStoreCredentials> {
    return this.credential;
  }
  async replaceTokens(): Promise<DropshipMarketplaceStoreCredentials> {
    return this.credential;
  }
  async recordAuthFailure(input: DropshipMarketplaceStoreAuthFailureInput): Promise<DropshipMarketplaceStoreAuthFailureRecord> {
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
