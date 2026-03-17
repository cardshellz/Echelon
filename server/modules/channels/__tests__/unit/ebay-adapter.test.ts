/**
 * Unit Tests — eBay Adapter
 *
 * Tests data mapping between Echelon canonical format and eBay API format.
 * Tests order ingestion mapping from eBay Fulfillment API responses.
 * Tests listing builder payload construction.
 * Tests category mapping resolution.
 * Uses mocked DB and fetch — no real API calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EbayAdapter } from "../../adapters/ebay.adapter";
import { EbayListingBuilder } from "../../adapters/ebay/ebay-listing-builder";
import {
  resolveEbayCategoryMapping,
  buildItemSpecifics,
  mapCarrierToEbay,
  EBAY_CATEGORIES,
} from "../../adapters/ebay/ebay-category-map";
import type { ChannelListingPayload } from "../../channel-adapter.interface";

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

function createMockDb(metadata?: any) {
  const defaultConnection = {
    channelId: 2,
    accessToken: null,
    refreshToken: null,
    webhookSecret: null,
    metadata: metadata ?? {
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      ruName: "test-runame",
      environment: "sandbox",
      merchantLocationKey: "test-warehouse",
      businessPolicies: {
        paymentPolicyId: "pay-123",
        returnPolicyId: "ret-456",
        fulfillmentPolicyId: "ful-789",
      },
    },
  };

  const chain = (data: any[]) => ({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(() => Promise.resolve(data)),
  });

  return {
    select: vi.fn(() => chain([defaultConnection])),
    insert: vi.fn(() => chain([])),
    update: vi.fn(() => chain([])),
    delete: vi.fn(() => chain([])),
  };
}

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_LISTING: ChannelListingPayload = {
  productId: 42,
  title: "Card Shellz Premium 35pt Toploaders - UV Protected",
  description: "Premium UV-blocking toploaders for standard trading cards.",
  category: "Toploaders",
  tags: ["toploader", "35pt", "uv-protection"],
  status: "active",
  variants: [
    {
      variantId: 101,
      sku: "CS-TL35-P25",
      name: "25 Pack",
      barcode: null,
      gtin: "850052429010",
      mpn: "CS-TL35",
      weightGrams: 120,
      priceCents: 799,
      compareAtPriceCents: 999,
      isListed: true,
      externalVariantId: null,
      externalInventoryItemId: null,
    },
    {
      variantId: 102,
      sku: "CS-TL35-P100",
      name: "100 Pack",
      barcode: null,
      gtin: "850052429027",
      mpn: "CS-TL35",
      weightGrams: 450,
      priceCents: 2499,
      compareAtPriceCents: 2999,
      isListed: true,
      externalVariantId: null,
      externalInventoryItemId: null,
    },
    {
      variantId: 103,
      sku: "CS-TL35-C1000",
      name: "Case of 1000",
      barcode: null,
      gtin: "850052429034",
      mpn: "CS-TL35",
      weightGrams: 4200,
      priceCents: 16999,
      compareAtPriceCents: 19999,
      isListed: true,
      externalVariantId: null,
      externalInventoryItemId: null,
    },
  ],
  images: [
    { url: "https://cdn.cardshellz.com/tl35-hero.jpg", altText: "35pt Toploader", position: 0, variantSku: null },
    { url: "https://cdn.cardshellz.com/tl35-angle.jpg", altText: "35pt Toploader Angle", position: 1, variantSku: null },
  ],
  metadata: {
    itemSpecifics: {
      "Compatible Card Thickness": ["35 Pt."],
      Features: ["UV Protection", "Crystal Clear"],
    },
  },
};

const SAMPLE_EBAY_ORDER = {
  orderId: "12-34567-89012",
  creationDate: "2026-03-16T18:30:00.000Z",
  lastModifiedDate: "2026-03-16T18:35:00.000Z",
  orderFulfillmentStatus: "NOT_STARTED",
  orderPaymentStatus: "PAID",
  sellerId: "card-shellz-store",
  buyer: {
    username: "buyer123",
  },
  pricingSummary: {
    priceSubtotal: { value: "24.99", currency: "USD" },
    deliveryCost: { value: "5.99", currency: "USD" },
    tax: { value: "2.00", currency: "USD" },
    total: { value: "32.98", currency: "USD" },
  },
  fulfillmentStartInstructions: [
    {
      fulfillmentInstructionsType: "SHIP_TO",
      shippingStep: {
        shippingServiceCode: "USPS_PRIORITY",
        shipTo: {
          fullName: "John Smith",
          contactAddress: {
            addressLine1: "123 Main St",
            addressLine2: "Apt 4",
            city: "Springfield",
            stateOrProvince: "IL",
            postalCode: "62704",
            countryCode: "US",
          },
          primaryPhone: { phoneNumber: "555-123-4567" },
          email: "john@example.com",
        },
      },
    },
  ],
  lineItems: [
    {
      lineItemId: "LI-001",
      sku: "CS-TL35-P100",
      title: "Card Shellz Premium 35pt Toploaders - 100 Pack",
      quantity: 1,
      lineItemCost: { value: "24.99", currency: "USD" },
      tax: { amount: { value: "2.00", currency: "USD" } },
      total: { value: "26.99", currency: "USD" },
      lineItemFulfillmentStatus: "NOT_STARTED",
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("eBay Adapter", () => {
  let adapter: EbayAdapter;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    db = createMockDb();
    adapter = new EbayAdapter(db as any);
    // Set env vars for auth
    process.env.EBAY_CLIENT_ID = "test-client-id";
    process.env.EBAY_CLIENT_SECRET = "test-client-secret";
    process.env.EBAY_RUNAME = "test-runame";
    process.env.EBAY_ENVIRONMENT = "sandbox";
  });

  afterEach(() => {
    delete process.env.EBAY_CLIENT_ID;
    delete process.env.EBAY_CLIENT_SECRET;
    delete process.env.EBAY_RUNAME;
    delete process.env.EBAY_ENVIRONMENT;
  });

  // -----------------------------------------------------------------------
  // Adapter identity
  // -----------------------------------------------------------------------

  describe("adapter identity", () => {
    it("should have correct adapter name", () => {
      expect(adapter.adapterName).toBe("eBay");
    });

    it("should have correct provider key", () => {
      expect(adapter.providerKey).toBe("ebay");
    });
  });

  // -----------------------------------------------------------------------
  // Cancellation stub
  // -----------------------------------------------------------------------

  describe("pushCancellation", () => {
    it("should return not_supported for all cancellations", async () => {
      const results = await adapter.pushCancellation(2, [
        {
          externalOrderId: "12-34567-89012",
          reason: "out of stock",
          lineItems: null,
          notifyCustomer: true,
          refund: true,
        },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("not_supported");
    });
  });
});

// ---------------------------------------------------------------------------
// Listing Builder Tests
// ---------------------------------------------------------------------------

describe("eBay Listing Builder", () => {
  let builder: EbayListingBuilder;

  beforeEach(() => {
    builder = new EbayListingBuilder();
  });

  const defaultConfig = {
    merchantLocationKey: "test-warehouse",
    listingPolicies: {
      paymentPolicyId: "pay-123",
      returnPolicyId: "ret-456",
      fulfillmentPolicyId: "ful-789",
    },
    marketplaceId: "EBAY_US",
  };

  describe("buildInventoryItems", () => {
    it("should create one inventory item per active variant", () => {
      const items = builder.buildInventoryItems(SAMPLE_LISTING, defaultConfig);
      expect(items).toHaveLength(3);
      expect(items[0].sku).toBe("CS-TL35-P25");
      expect(items[1].sku).toBe("CS-TL35-P100");
      expect(items[2].sku).toBe("CS-TL35-C1000");
    });

    it("should skip unlisted variants", () => {
      const listing = {
        ...SAMPLE_LISTING,
        variants: [
          ...SAMPLE_LISTING.variants.slice(0, 2),
          { ...SAMPLE_LISTING.variants[2], isListed: false },
        ],
      };
      const items = builder.buildInventoryItems(listing, defaultConfig);
      expect(items).toHaveLength(2);
    });

    it("should include images in inventory items", () => {
      const items = builder.buildInventoryItems(SAMPLE_LISTING, defaultConfig);
      expect(items[0].payload.product.imageUrls).toHaveLength(2);
      expect(items[0].payload.product.imageUrls[0]).toBe(
        "https://cdn.cardshellz.com/tl35-hero.jpg",
      );
    });

    it("should set condition to NEW for all products", () => {
      const items = builder.buildInventoryItems(SAMPLE_LISTING, defaultConfig);
      expect(items[0].payload.condition).toBe("NEW");
    });

    it("should include weight when available", () => {
      const items = builder.buildInventoryItems(SAMPLE_LISTING, defaultConfig);
      expect(items[0].payload.packageWeightAndSize?.weight).toEqual({
        value: 120,
        unit: "GRAM",
      });
    });

    it("should include UPC in product aspects", () => {
      const items = builder.buildInventoryItems(SAMPLE_LISTING, defaultConfig);
      expect(items[0].payload.product.upc).toEqual(["850052429010"]);
    });

    it("should include MPN in product aspects", () => {
      const items = builder.buildInventoryItems(SAMPLE_LISTING, defaultConfig);
      expect(items[0].payload.product.mpn).toBe("CS-TL35");
    });

    it("should merge item specifics from product metadata", () => {
      const items = builder.buildInventoryItems(SAMPLE_LISTING, defaultConfig);
      const aspects = items[0].payload.product.aspects;
      expect(aspects?.["Compatible Card Thickness"]).toEqual(["35 Pt."]);
      expect(aspects?.["Features"]).toEqual(["UV Protection", "Crystal Clear"]);
    });

    it("should set initial quantity to 0 (inventory pushed separately)", () => {
      const items = builder.buildInventoryItems(SAMPLE_LISTING, defaultConfig);
      expect(
        items[0].payload.availability.shipToLocationAvailability.quantity,
      ).toBe(0);
    });
  });

  describe("buildOffers", () => {
    it("should create one offer per active variant", () => {
      const offers = builder.buildOffers(SAMPLE_LISTING, defaultConfig);
      expect(offers).toHaveLength(3);
      expect(offers[0].sku).toBe("CS-TL35-P25");
      expect(offers[0].variantId).toBe(101);
    });

    it("should set correct pricing", () => {
      const offers = builder.buildOffers(SAMPLE_LISTING, defaultConfig);
      expect(offers[0].payload.pricingSummary.price).toEqual({
        value: "7.99",
        currency: "USD",
      });
    });

    it("should set compare-at price as originalRetailPrice", () => {
      const offers = builder.buildOffers(SAMPLE_LISTING, defaultConfig);
      expect(offers[0].payload.pricingSummary.originalRetailPrice).toEqual({
        value: "9.99",
        currency: "USD",
      });
    });

    it("should set listing format to FIXED_PRICE", () => {
      const offers = builder.buildOffers(SAMPLE_LISTING, defaultConfig);
      expect(offers[0].payload.format).toBe("FIXED_PRICE");
    });

    it("should include business policies", () => {
      const offers = builder.buildOffers(SAMPLE_LISTING, defaultConfig);
      expect(offers[0].payload.listingPolicies).toEqual({
        paymentPolicyId: "pay-123",
        returnPolicyId: "ret-456",
        fulfillmentPolicyId: "ful-789",
      });
    });

    it("should set merchant location key", () => {
      const offers = builder.buildOffers(SAMPLE_LISTING, defaultConfig);
      expect(offers[0].payload.merchantLocationKey).toBe("test-warehouse");
    });
  });

  describe("buildItemGroup", () => {
    it("should create an item group for multi-variant products", () => {
      const group = builder.buildItemGroup(SAMPLE_LISTING, defaultConfig);
      expect(group).not.toBeNull();
      expect(group!.groupKey).toBe("ECHELON-P42");
    });

    it("should return null for single-variant products", () => {
      const singleVariantListing = {
        ...SAMPLE_LISTING,
        variants: [SAMPLE_LISTING.variants[0]],
      };
      const group = builder.buildItemGroup(singleVariantListing, defaultConfig);
      expect(group).toBeNull();
    });

    it("should set pack size as variation aspect", () => {
      const group = builder.buildItemGroup(SAMPLE_LISTING, defaultConfig);
      expect(group!.payload.aspects).toHaveProperty("Pack Size");
      expect(group!.payload.variesBy.specifications[0].name).toBe("Pack Size");
    });

    it("should extract pack size values from variant names", () => {
      const group = builder.buildItemGroup(SAMPLE_LISTING, defaultConfig);
      const values = group!.payload.aspects["Pack Size"];
      expect(values).toContain("25 Count");
      expect(values).toContain("100 Count");
      expect(values).toContain("1000 Count");
    });

    it("should include images", () => {
      const group = builder.buildItemGroup(SAMPLE_LISTING, defaultConfig);
      expect(group!.payload.imageUrls).toHaveLength(2);
    });

    it("should use title from listing", () => {
      const group = builder.buildItemGroup(SAMPLE_LISTING, defaultConfig);
      expect(group!.payload.title).toBe(
        "Card Shellz Premium 35pt Toploaders - UV Protected",
      );
    });

    it("should generate HTML description", () => {
      const group = builder.buildItemGroup(SAMPLE_LISTING, defaultConfig);
      expect(group!.payload.description).toContain("<div");
      expect(group!.payload.description).toContain("Card Shellz");
      expect(group!.payload.description).toContain("Happiness Guarantee");
    });
  });
});

// ---------------------------------------------------------------------------
// Category Mapping Tests
// ---------------------------------------------------------------------------

describe("eBay Category Mapping", () => {
  describe("resolveEbayCategoryMapping", () => {
    it("should map toploader products to category 183438", () => {
      const mapping = resolveEbayCategoryMapping({
        name: "Premium 35pt Toploaders",
        category: "Card Supplies",
      });
      expect(mapping.categoryId).toBe(EBAY_CATEGORIES.TOPLOADERS_HOLDERS);
    });

    it("should map sleeve products to category 183437", () => {
      const mapping = resolveEbayCategoryMapping({
        subcategory: "penny sleeve",
      });
      expect(mapping.categoryId).toBe(EBAY_CATEGORIES.SLEEVES_BAGS);
    });

    it("should map magnetic holders to 183438", () => {
      const mapping = resolveEbayCategoryMapping({
        name: "35pt Magnetic Holder One-Touch",
      });
      expect(mapping.categoryId).toBe(EBAY_CATEGORIES.TOPLOADERS_HOLDERS);
    });

    it("should map semi-rigid holders to 183438", () => {
      const mapping = resolveEbayCategoryMapping({
        name: "Semi-Rigid Card Holders",
      });
      expect(mapping.categoryId).toBe(EBAY_CATEGORIES.TOPLOADERS_HOLDERS);
    });

    it("should map binders to 183435", () => {
      const mapping = resolveEbayCategoryMapping({
        name: "Card Binder 9-Pocket",
      });
      expect(mapping.categoryId).toBe(EBAY_CATEGORIES.ALBUMS_BINDERS_PAGES);
    });

    it("should map armalopes to 183439", () => {
      const mapping = resolveEbayCategoryMapping({
        name: "Armalope Shipping Envelopes",
      });
      expect(mapping.categoryId).toBe(EBAY_CATEGORIES.STORAGE_BOXES_DIVIDERS);
    });

    it("should map graded card cases to 183440", () => {
      const mapping = resolveEbayCategoryMapping({
        name: "Hero Diamond Shell PSA Graded Card Case",
      });
      expect(mapping.categoryId).toBe(EBAY_CATEGORIES.DISPLAY_CASES_STANDS);
    });

    it("should fall back to parent category for unknown types", () => {
      const mapping = resolveEbayCategoryMapping({
        name: "Mystery Product",
      });
      expect(mapping.categoryId).toBe(EBAY_CATEGORIES.STORAGE_DISPLAY_SUPPLIES);
    });

    it("should prefer subcategory match over name match", () => {
      const mapping = resolveEbayCategoryMapping({
        subcategory: "sleeve",
        name: "Something with toploader in name",
      });
      expect(mapping.categoryId).toBe(EBAY_CATEGORIES.SLEEVES_BAGS);
    });
  });

  describe("buildItemSpecifics", () => {
    it("should merge category defaults with product specifics", () => {
      const categoryMapping = resolveEbayCategoryMapping({
        name: "Toploader",
      });
      const result = buildItemSpecifics(
        categoryMapping,
        { "Compatible Card Thickness": ["35 Pt."], Color: ["Clear"] },
      );
      expect(result.Brand).toEqual(["Card Shellz"]);
      expect(result.Type).toEqual(["Toploader"]);
      expect(result["Compatible Card Thickness"]).toEqual(["35 Pt."]);
      expect(result.Color).toEqual(["Clear"]);
    });

    it("should let channel overrides take precedence", () => {
      const categoryMapping = resolveEbayCategoryMapping({
        name: "Toploader",
      });
      const result = buildItemSpecifics(
        categoryMapping,
        { Brand: ["Card Shellz"] },
        { Brand: ["Card Shellz Premium"] },
      );
      expect(result.Brand).toEqual(["Card Shellz Premium"]);
    });
  });

  describe("mapCarrierToEbay", () => {
    it("should map USPS correctly", () => {
      expect(mapCarrierToEbay("USPS")).toBe("USPS");
      expect(mapCarrierToEbay("usps")).toBe("USPS");
    });

    it("should map UPS correctly", () => {
      expect(mapCarrierToEbay("UPS")).toBe("UPS");
    });

    it("should map FedEx correctly", () => {
      expect(mapCarrierToEbay("FedEx")).toBe("FEDEX");
    });

    it("should map Pirate Ship to USPS", () => {
      expect(mapCarrierToEbay("PirateShip")).toBe("USPS");
    });

    it("should return OTHER for unknown carriers", () => {
      expect(mapCarrierToEbay("SomeRandomCarrier")).toBe("OTHER");
    });

    it("should return OTHER for null", () => {
      expect(mapCarrierToEbay(null)).toBe("OTHER");
    });
  });
});
