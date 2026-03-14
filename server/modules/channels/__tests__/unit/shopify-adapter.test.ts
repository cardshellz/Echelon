/**
 * Unit Tests — Shopify Adapter
 *
 * Tests data mapping between Echelon canonical format and Shopify API format.
 * Tests order ingestion mapping from Shopify webhook payloads.
 * Uses mocked DB and fetch — no real API calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ShopifyAdapter } from "../../adapters/shopify.adapter";

// ---------------------------------------------------------------------------
// Mock DB that returns credentials
// ---------------------------------------------------------------------------

function createMockDb(creds?: any) {
  const defaultCreds = {
    channelId: 1,
    shopDomain: "test-store.myshopify.com",
    accessToken: "shpat_test_token",
    apiVersion: "2024-01",
    webhookSecret: "test_webhook_secret",
  };

  const chain = (data: any[]) => ({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(() => Promise.resolve(data)),
  });

  return {
    select: vi.fn(() => chain([creds ?? defaultCreds])),
    insert: vi.fn(() => chain([])),
    update: vi.fn(() => chain([])),
    delete: vi.fn(() => chain([])),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Shopify Adapter", () => {
  let adapter: ShopifyAdapter;
  let db: ReturnType<typeof createMockDb>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    db = createMockDb();
    adapter = new ShopifyAdapter(db as any);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // -----------------------------------------------------------------------
  // Adapter identity
  // -----------------------------------------------------------------------

  describe("adapter identity", () => {
    it("should have correct adapter name", () => {
      expect(adapter.adapterName).toBe("Shopify");
    });

    it("should have correct provider key", () => {
      expect(adapter.providerKey).toBe("shopify");
    });
  });

  // -----------------------------------------------------------------------
  // Order mapping (Shopify → Echelon canonical)
  // -----------------------------------------------------------------------

  describe("order mapping (receiveOrder)", () => {
    it("should map a Shopify order to canonical ChannelOrder format", async () => {
      const shopifyOrder = {
        id: 5551234567890,
        email: "john@example.com",
        created_at: "2026-03-14T10:00:00-04:00",
        subtotal_price: "29.99",
        total_tax: "2.40",
        total_price: "37.38",
        total_discounts: "0.00",
        currency: "USD",
        financial_status: "paid",
        fulfillment_status: null,
        note: "Please ship quickly",
        tags: "VIP, Shellz Club",
        customer: {
          first_name: "John",
          last_name: "Doe",
        },
        shipping_address: {
          name: "John Doe",
          address1: "123 Main St",
          address2: "Apt 4",
          city: "Springfield",
          province: "IL",
          zip: "62701",
          country_code: "US",
          phone: "+1-555-0123",
        },
        shipping_lines: [
          { price: "4.99" },
        ],
        line_items: [
          {
            id: 11111,
            sku: "TL-UV-100",
            title: "Premium UV Shield Toploaders - 100ct",
            quantity: 2,
            price: "14.99",
            discount_allocations: [
              { amount: "0.00" },
            ],
            tax_lines: [
              { price: "1.20" },
            ],
          },
        ],
      };

      // Mock fetch for HMAC — we'll skip HMAC verification by not providing header
      const db2 = createMockDb({
        channelId: 1,
        shopDomain: "test.myshopify.com",
        accessToken: "token",
        apiVersion: "2024-01",
        webhookSecret: null, // No secret = skip HMAC
      });
      const adapter2 = new ShopifyAdapter(db2 as any);

      const result = await adapter2.receiveOrder(1, shopifyOrder, {});

      expect(result).not.toBeNull();
      expect(result!.externalOrderId).toBe("5551234567890");
      expect(result!.source).toBe("shopify");
      expect(result!.customerEmail).toBe("john@example.com");
      expect(result!.customerName).toBe("John Doe");

      // Address mapping
      expect(result!.shippingAddress?.name).toBe("John Doe");
      expect(result!.shippingAddress?.address1).toBe("123 Main St");
      expect(result!.shippingAddress?.city).toBe("Springfield");
      expect(result!.shippingAddress?.province).toBe("IL");
      expect(result!.shippingAddress?.zip).toBe("62701");
      expect(result!.shippingAddress?.country).toBe("US");

      // Money fields (converted to cents)
      expect(result!.subtotalCents).toBe(2999);
      expect(result!.taxCents).toBe(240);
      expect(result!.totalCents).toBe(3738);
      expect(result!.shippingCents).toBe(499);
      expect(result!.discountCents).toBe(0);
      expect(result!.currency).toBe("USD");

      // Status
      expect(result!.financialStatus).toBe("paid");
      expect(result!.fulfillmentStatus).toBeNull();

      // Notes and tags
      expect(result!.notes).toBe("Please ship quickly");
      expect(result!.tags).toEqual(["VIP", "Shellz Club"]);

      // Line items
      expect(result!.lineItems).toHaveLength(1);
      expect(result!.lineItems[0].externalLineItemId).toBe("11111");
      expect(result!.lineItems[0].sku).toBe("TL-UV-100");
      expect(result!.lineItems[0].quantity).toBe(2);
      expect(result!.lineItems[0].priceCents).toBe(1499);
      expect(result!.lineItems[0].taxCents).toBe(120);
    });

    it("should return null for invalid payload", async () => {
      const db2 = createMockDb({
        channelId: 1,
        shopDomain: "test.myshopify.com",
        accessToken: "token",
        apiVersion: "2024-01",
        webhookSecret: null,
      });
      const adapter2 = new ShopifyAdapter(db2 as any);

      const result = await adapter2.receiveOrder(1, { random: "data" }, {});
      expect(result).toBeNull();
    });

    it("should handle order with no shipping address", async () => {
      const order = {
        id: 123,
        email: "test@test.com",
        created_at: "2026-01-01T00:00:00Z",
        subtotal_price: "10.00",
        total_tax: "0.00",
        total_price: "10.00",
        total_discounts: "0.00",
        currency: "USD",
        line_items: [],
      };

      const db2 = createMockDb({
        channelId: 1,
        shopDomain: "test.myshopify.com",
        accessToken: "token",
        apiVersion: "2024-01",
        webhookSecret: null,
      });
      const adapter2 = new ShopifyAdapter(db2 as any);
      const result = await adapter2.receiveOrder(1, order, {});

      expect(result).not.toBeNull();
      expect(result!.shippingAddress?.name).toBeNull();
    });

    it("should handle order with no customer", async () => {
      const order = {
        id: 456,
        created_at: "2026-01-01T00:00:00Z",
        subtotal_price: "5.00",
        total_tax: "0.00",
        total_price: "5.00",
        total_discounts: "0.00",
        currency: "USD",
        line_items: [],
      };

      const db2 = createMockDb({
        channelId: 1,
        shopDomain: "test.myshopify.com",
        accessToken: "token",
        apiVersion: "2024-01",
        webhookSecret: null,
      });
      const adapter2 = new ShopifyAdapter(db2 as any);
      const result = await adapter2.receiveOrder(1, order, {});

      expect(result!.customerName).toBeNull();
      expect(result!.customerEmail).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Listing payload mapping (Echelon → Shopify)
  // -----------------------------------------------------------------------

  describe("listing payload construction", () => {
    it("should push listings and map variant IDs from response", async () => {
      // Mock successful Shopify API response
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          product: {
            id: 99999,
            variants: [
              { id: 111, sku: "TL-UV-100" },
              { id: 222, sku: "TL-UV-200" },
            ],
          },
        }),
      });

      const listings = [{
        productId: 1,
        title: "Premium UV Shield Toploaders",
        description: "<p>99.99% UV protection</p>",
        category: "Trading Card Supplies",
        tags: ["toploaders", "UV", "premium"],
        status: "active" as const,
        variants: [
          {
            variantId: 10,
            sku: "TL-UV-100",
            name: "100ct",
            barcode: null,
            gtin: "0123456789012",
            mpn: "TL-UV-100",
            weightGrams: 450,
            priceCents: 1499,
            compareAtPriceCents: 1999,
            isListed: true,
            externalVariantId: null,
            externalInventoryItemId: null,
          },
          {
            variantId: 20,
            sku: "TL-UV-200",
            name: "200ct",
            barcode: null,
            gtin: "0123456789013",
            mpn: "TL-UV-200",
            weightGrams: 850,
            priceCents: 2499,
            compareAtPriceCents: null,
            isListed: true,
            externalVariantId: null,
            externalInventoryItemId: null,
          },
        ],
        images: [
          { url: "https://cdn.cardshellz.com/tl-uv.jpg", altText: "UV Toploader", position: 0, variantSku: null },
        ],
      }];

      const results = await adapter.pushListings(1, listings);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("created");
      expect(results[0].externalProductId).toBe("99999");
      expect(results[0].externalVariantIds?.[10]).toBe("111");
      expect(results[0].externalVariantIds?.[20]).toBe("222");

      // Verify the payload sent to Shopify
      const fetchCall = (globalThis.fetch as any).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);

      expect(body.product.title).toBe("Premium UV Shield Toploaders");
      expect(body.product.body_html).toBe("<p>99.99% UV protection</p>");
      expect(body.product.tags).toBe("toploaders, UV, premium");
      expect(body.product.status).toBe("active");

      // Variant mapping
      expect(body.product.variants).toHaveLength(2);
      expect(body.product.variants[0].sku).toBe("TL-UV-100");
      expect(body.product.variants[0].barcode).toBe("0123456789012"); // GTIN used as barcode
      expect(body.product.variants[0].price).toBe("14.99");
      expect(body.product.variants[0].compare_at_price).toBe("19.99");
      expect(body.product.variants[0].weight).toBe(450);
      expect(body.product.variants[0].weight_unit).toBe("g");

      // Image mapping
      expect(body.product.images).toHaveLength(1);
      expect(body.product.images[0].position).toBe(1); // 0-based → 1-based
      expect(body.product.images[0].alt).toBe("UV Toploader");
    });

    it("should filter out unlisted variants", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          product: {
            id: 99999,
            variants: [{ id: 111, sku: "TL-UV-100" }],
          },
        }),
      });

      const listings = [{
        productId: 1,
        title: "Test",
        description: null,
        category: null,
        tags: null,
        status: "active" as const,
        variants: [
          {
            variantId: 10,
            sku: "TL-UV-100",
            name: "100ct",
            barcode: null,
            gtin: null,
            mpn: null,
            weightGrams: null,
            priceCents: 1499,
            compareAtPriceCents: null,
            isListed: true,
            externalVariantId: null,
            externalInventoryItemId: null,
          },
          {
            variantId: 20,
            sku: "TL-UV-200",
            name: "200ct - HIDDEN",
            barcode: null,
            gtin: null,
            mpn: null,
            weightGrams: null,
            priceCents: 2499,
            compareAtPriceCents: null,
            isListed: false, // Should be excluded
            externalVariantId: null,
            externalInventoryItemId: null,
          },
        ],
        images: [],
      }];

      await adapter.pushListings(1, listings);

      const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
      expect(body.product.variants).toHaveLength(1);
      expect(body.product.variants[0].sku).toBe("TL-UV-100");
    });
  });

  // -----------------------------------------------------------------------
  // Inventory push
  // -----------------------------------------------------------------------

  describe("inventory push", () => {
    it("should push inventory with correct payload", async () => {
      process.env.SHOPIFY_LOCATION_ID = "12345";

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ inventory_level: {} }),
      });

      const items = [{
        variantId: 1,
        sku: "TL-UV-100",
        externalVariantId: "111",
        externalInventoryItemId: "222",
        allocatedQty: 500,
      }];

      const results = await adapter.pushInventory(1, items);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("success");
      expect(results[0].pushedQty).toBe(500);

      const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
      expect(body.inventory_item_id).toBe(222);
      expect(body.location_id).toBe(12345);
      expect(body.available).toBe(500);

      delete process.env.SHOPIFY_LOCATION_ID;
    });

    it("should error when no externalInventoryItemId", async () => {
      const items = [{
        variantId: 1,
        sku: "TL-UV-100",
        externalVariantId: "111",
        externalInventoryItemId: null,
        allocatedQty: 500,
      }];

      const results = await adapter.pushInventory(1, items);
      expect(results[0].status).toBe("error");
      expect(results[0].error).toContain("externalInventoryItemId");
    });
  });

  // -----------------------------------------------------------------------
  // Pricing push
  // -----------------------------------------------------------------------

  describe("pricing push", () => {
    it("should format price from cents to dollars string", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ variant: {} }),
      });

      const items = [{
        variantId: 1,
        externalVariantId: "111",
        priceCents: 1499,
        compareAtPriceCents: 1999,
        currency: "USD",
      }];

      const results = await adapter.pushPricing(1, items);
      expect(results[0].status).toBe("success");

      const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
      expect(body.variant.price).toBe("14.99");
      expect(body.variant.compare_at_price).toBe("19.99");
    });
  });

  // -----------------------------------------------------------------------
  // Cancellation stub
  // -----------------------------------------------------------------------

  describe("cancellation (stub)", () => {
    it("should return not_supported for all cancellations", async () => {
      const results = await adapter.pushCancellation(1, [
        {
          externalOrderId: "123",
          reason: "Customer request",
          lineItems: null,
          notifyCustomer: true,
          refund: true,
        },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("not_supported");
    });
  });

  // -----------------------------------------------------------------------
  // HMAC verification
  // -----------------------------------------------------------------------

  describe("webhook HMAC verification", () => {
    it("should reject invalid HMAC", async () => {
      const order = { id: 123 };

      // Generate a valid-length but wrong base64 HMAC (SHA-256 produces 32 bytes = 44 chars base64)
      const fakeHmac = Buffer.from("a".repeat(32)).toString("base64");

      await expect(
        adapter.receiveOrder(1, JSON.stringify(order), {
          "x-shopify-hmac-sha256": fakeHmac,
        }),
      ).rejects.toThrow(/HMAC verification failed/);
    });
  });
});
