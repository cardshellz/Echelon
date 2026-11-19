import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShopifyAdapter } from "../../adapters/shopify.adapter";
import {
  ShopifyInventoryWriteRejectedError,
  shopifyInventoryWriteRejectionCode,
} from "../../adapters/shopify-inventory-write.error";
import { ChannelInventoryPublicationTransportAdapter } from "../../channel-inventory-publication-transport.adapter";
import { InventoryPublicationTransportError } from "../../../inventory-planning/application/inventory-publication-transport";
import { createAdmittedQuantityTestOwner } from "../fixtures/quantity-publication-admission";

// Channels PR1 (PLAN-CH-v3 section 6 "Outbox (PR1)"): Shopify's 404 and 422 on the
// stock write are permanent for that exact item and location. Before this change every
// non-2xx was an uncoded Error, so the outbox retried it 10 times (about 2 hours) before
// it dead-lettered with PROVIDER_PUBLICATION_REJECTED. Every other status is unchanged.

const CREDENTIALS = { id: 17, channelId: 1, shopDomain: "test-store.myshopify.com", accessToken: "shpat_test_token",
  apiVersion: "2024-01", webhookSecret: "test_webhook_secret" };

function mockDb() {
  const chain = () => ({ from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(),
    limit: vi.fn(() => Promise.resolve([CREDENTIALS])) });
  return { select: vi.fn(chain), insert: vi.fn(), update: vi.fn(), delete: vi.fn() };
}

function response(status: number, body = `{"errors":"status ${status}"}`): Response {
  return new Response(status === 204 ? null : body, { status, headers: { "Content-Type": "application/json" } });
}

const CANONICAL = { authority: "canonical_outbox" as const, channelConnectionId: 17, providerScopeType: "location" as const,
  externalScopeId: "98765" };
const ITEM = { variantId: 101, sku: "SKU-101", externalVariantId: null, externalInventoryItemId: "222", allocatedQty: 7 };

describe("Shopify stock write rejection (inventory_levels/set.json)", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let adapter: ShopifyAdapter;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    // The admitted test owner implements the write path the adapter uses (run); see its fixture.
    adapter = new ShopifyAdapter(mockDb() as never,
      createAdmittedQuantityTestOwner() as unknown as ConstructorParameters<typeof ShopifyAdapter>[1]);
    // The adapter waits between items and between its own 429/5xx retries; tests do not.
    vi.spyOn(adapter as unknown as { delay(ms: number): Promise<void> }, "delay").mockResolvedValue(undefined);
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it.each([
    [404, "SHOPIFY_INVENTORY_ITEM_NOT_FOUND"],
    [422, "SHOPIFY_INVENTORY_REJECTED"],
  ])("reports %i as a permanent %s on the first answer, without retrying", async (status, code) => {
    fetchMock.mockImplementation(async () => response(status));
    const [result] = await adapter.pushInventory(1, [ITEM], CANONICAL);
    expect(result).toEqual({ variantId: 101, pushedQty: 0, status: "error", errorCode: code, retryable: false,
      error: `Shopify API POST /inventory_levels/set.json failed (${status}): {"errors":"status ${status}"}` });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403])("keeps %i an uncoded retryable failure, as today", async (status) => {
    fetchMock.mockImplementation(async () => response(status));
    const [result] = await adapter.pushInventory(1, [ITEM], CANONICAL);
    expect(result).toEqual({ variantId: 101, pushedQty: 0, status: "error",
      error: `Shopify API POST /inventory_levels/set.json failed (${status}): {"errors":"status ${status}"}` });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the adapter's own 429 retries and their uncoded final failure", async () => {
    fetchMock.mockImplementation(async () => response(429));
    const [result] = await adapter.pushInventory(1, [ITEM], CANONICAL);
    expect(result).toEqual({ variantId: 101, pushedQty: 0, status: "error",
      error: "Shopify API POST /inventory_levels/set.json failed after 3 retries" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([500, 503])("keeps the adapter's own %i retries and their uncoded final failure", async (status) => {
    fetchMock.mockImplementation(async () => response(status));
    const [result] = await adapter.pushInventory(1, [ITEM], CANONICAL);
    expect(result).toEqual({ variantId: 101, pushedQty: 0, status: "error",
      error: `Shopify API POST /inventory_levels/set.json failed (${status}): {"errors":"status ${status}"}` });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives the legacy (non-canonical) stock path the same Error message, now with the code", async () => {
    // Restore whatever the environment had, so a developer's or CI's own value survives.
    const previousLocation = process.env.SHOPIFY_LOCATION_ID;
    process.env.SHOPIFY_LOCATION_ID = "12345";
    try {
      fetchMock.mockImplementation(async () => response(404));
      const [result] = await adapter.pushInventory(1, [ITEM]);
      expect(result).toMatchObject({ status: "error", pushedQty: 0, errorCode: "SHOPIFY_INVENTORY_ITEM_NOT_FOUND", retryable: false,
        error: 'Shopify API POST /inventory_levels/set.json failed (404): {"errors":"status 404"}' });
    } finally {
      if (previousLocation === undefined) delete process.env.SHOPIFY_LOCATION_ID;
      else process.env.SHOPIFY_LOCATION_ID = previousLocation;
    }
  });

  it("leaves other Shopify requests untouched: a 404 price write is still a plain message", async () => {
    fetchMock.mockImplementation(async () => response(404));
    const results = await adapter.pushPricing(1, [{ variantId: 101, sku: "SKU-101", externalVariantId: "333",
      priceCents: 1299, compareAtPriceCents: null, currency: "USD" }]);
    expect(results).toEqual([{ variantId: 101, status: "error",
      error: 'Shopify API PUT /variants/333.json failed (404): {"errors":"status 404"}' }]);
  });

  describe("through the canonical outbox transport bridge", () => {
    const request = { destination: { kind: "channel_connection" as const, channelConnectionId: 17, dropshipStoreConnectionId: null },
      channelId: 1, providerScopeType: "location" as const, externalScopeId: "98765", productVariantId: 101,
      externalInventoryItemId: "222", externalSku: "SKU-101", desiredQuantity: 7 };

    it.each([
      [404, "SHOPIFY_INVENTORY_ITEM_NOT_FOUND"],
      [422, "SHOPIFY_INVENTORY_REJECTED"],
    ])("turns %i into a non-retryable %s transport failure, so the outbox dead-letters it at once", async (status, code) => {
      fetchMock.mockImplementation(async () => response(status));
      const failure = await new ChannelInventoryPublicationTransportAdapter(adapter).publishAbsolute(request).catch(error => error);
      expect(failure).toBeInstanceOf(InventoryPublicationTransportError);
      expect(failure).toMatchObject({ code, retryable: false });
    });

    it.each([400, 401, 403, 429, 503])("keeps %i a retryable PROVIDER_PUBLICATION_REJECTED, as today", async (status) => {
      fetchMock.mockImplementation(async () => response(status));
      const failure = await new ChannelInventoryPublicationTransportAdapter(adapter).publishAbsolute(request).catch(error => error);
      expect(failure).toBeInstanceOf(InventoryPublicationTransportError);
      expect(failure).toMatchObject({ code: "PROVIDER_PUBLICATION_REJECTED", retryable: true });
    });
  });
});

describe("shopifyInventoryWriteRejectionCode", () => {
  it("classifies only the stock write's 404 and 422", () => {
    expect(shopifyInventoryWriteRejectionCode("POST", "/inventory_levels/set.json", 404)).toBe("SHOPIFY_INVENTORY_ITEM_NOT_FOUND");
    expect(shopifyInventoryWriteRejectionCode("POST", "/inventory_levels/set.json", 422)).toBe("SHOPIFY_INVENTORY_REJECTED");
    for (const status of [200, 400, 401, 403, 408, 409, 429, 500, 502, 503])
      expect(shopifyInventoryWriteRejectionCode("POST", "/inventory_levels/set.json", status)).toBeNull();
    // A read of the same path, or any other path, keeps its existing handling.
    expect(shopifyInventoryWriteRejectionCode("GET", "/inventory_levels/set.json", 404)).toBeNull();
    expect(shopifyInventoryWriteRejectionCode("POST", "/inventory_levels/adjust.json", 404)).toBeNull();
    expect(shopifyInventoryWriteRejectionCode("PUT", "/variants/333.json", 422)).toBeNull();
  });

  it("is a typed Error that callers reading only the message keep handling", () => {
    const error = new ShopifyInventoryWriteRejectedError("SHOPIFY_INVENTORY_ITEM_NOT_FOUND", "Shopify said 404", 404);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "ShopifyInventoryWriteRejectedError", code: "SHOPIFY_INVENTORY_ITEM_NOT_FOUND",
      message: "Shopify said 404", retryable: false, classification: "permanent",
      context: { httpStatus: 404, path: "/inventory_levels/set.json" } });
  });
});
