import { describe, expect, it, vi } from "vitest";

import {
  EbayDropshipInventoryPublicationTransportAdapter,
} from "../../infrastructure/dropship-ebay-inventory-publication.adapter";
import type { DropshipMarketplaceStoreCredentials } from "../../infrastructure/dropship-marketplace-credentials";

describe("EbayDropshipInventoryPublicationTransportAdapter", () => {
  it("publishes the supplied absolute quantity through the exact Dropship store", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse(inventoryItem(2)))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const { adapter, credentials } = fixture(fetchFn);

    await expect(adapter.publishAbsolute({
      ...request(),
      desiredQuantity: 7,
    })).resolves.toEqual({ publishedQuantity: 7, providerResponse: { status: 204 } });

    expect(credentials.loadFreshForStoreConnection).toHaveBeenCalledWith({
      vendorId: 12,
      storeConnectionId: 77,
    });
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      "https://api.ebay.com/sell/inventory/v1/inventory_item/SKU-101",
      expect.objectContaining({ method: "GET" }),
    );
    const put = fetchFn.mock.calls[1]![1] as RequestInit;
    expect(JSON.parse(String(put.body))).toMatchObject({
      availability: { shipToLocationAvailability: { quantity: 7 } },
      product: { title: "Example" },
    });
  });

  it("reads the provider quantity without applying another ATP formula", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(inventoryItem(9)));
    const { adapter } = fixture(fetchFn);

    await expect(adapter.readAbsolute(request())).resolves.toEqual({
      observedQuantity: 9,
      providerResponse: { status: 200, observedQuantity: 9 },
    });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("uses the registered provider inventory-item ID when the optional SKU is absent", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(inventoryItem(9)));
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
    availability: { shipToLocationAvailability: { quantity } },
    condition: "NEW",
    product: { title: "Example" },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
