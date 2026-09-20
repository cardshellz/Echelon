import { describe, expect, it, vi } from "vitest";

import {
  EbayDropshipInventoryPublicationTransportAdapter,
} from "../../infrastructure/dropship-ebay-inventory-publication.adapter";
import type { DropshipMarketplaceStoreCredentials } from "../../infrastructure/dropship-marketplace-credentials";
import { QuantityProviderEvidenceCollector, type QuantityProviderResponseEvidence } from "../../../inventory-planning/application/quantity-provider-request-evidence";

describe("EbayDropshipInventoryPublicationTransportAdapter", () => {
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
      .mockResolvedValueOnce(jsonResponse({ responses: [{ sku: "SKU-101", offerId: "offer-1", statusCode: 200 }] }));
    const { adapter, credentials } = fixture(fetchFn);

    await expect(adapter.publishAbsolute({
      ...request(),
      desiredQuantity: 7,
    })).resolves.toEqual({ publishedQuantity: 7, providerResponse: { sku: "SKU-101", marketplaceId: "EBAY_US", offerId: "offer-1", quantity: 7 } });

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
    expect(JSON.parse(String(post.body))).toEqual({
      requests: [{ sku: "SKU-101", shipToLocationAvailability: { quantity: 7 }, offers: [{ offerId: "offer-1", availableQuantity: 7 }] }],
    });
  });

  it("reads the provider quantity without applying another ATP formula", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(jsonResponse(offerPage(9))).mockResolvedValueOnce(jsonResponse(inventoryItem(12)));
    const { adapter } = fixture(fetchFn);

    await expect(adapter.readAbsolute(request())).resolves.toEqual({
      observedQuantity: 9,
      providerResponse: { sku: "SKU-101", marketplaceId: "EBAY_US", offerId: "offer-1", inventoryItemQuantity: 12, offerQuantity: 9, observedQuantity: 9 },
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
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

function fixture(
  fetchFn: ReturnType<typeof vi.fn>,
  credentialOverrides: Partial<DropshipMarketplaceStoreCredentials> = {},
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
  return {
    adapter: new EbayDropshipInventoryPublicationTransportAdapter(
      destinations,
      credentials,
      health,
      fetchFn as typeof fetch,
      { now: () => new Date("2026-09-04T12:00:00.000Z") },
    ),
    credentials,
    health,
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
