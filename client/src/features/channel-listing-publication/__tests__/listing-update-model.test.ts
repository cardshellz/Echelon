import { describe, expect, it } from "vitest";
import {
  initialListingUpdateFields,
  listingUpdateChanges,
  listingUpdateContentResubmission,
} from "../listing-update-model";
import { hasListingUpdateChanges, hasListingUpdateProductContent, type ListingUpdateContext } from "@shared/types/channel-listing-update";

const context: ListingUpdateContext = {
  current: {
    sku: "SLEEVES-100",
    externalProductId: "WPID-1",
    identifier: { type: "GTIN", value: "00036000291452" },
    title: "Real Walmart title",
    priceCents: 2499,
    productType: "Trading Card Sleeves & Holders",
    lifecycleStatus: "ACTIVE",
    publishedStatus: "PUBLISHED",
  },
  sourceHash: "a".repeat(64),
  suggestedProductType: "Trading Card Sleeves & Holders",
  updates: [],
  lastSubmitted: {
    title: "Old title",
    description: "Old description",
    brand: "Shellz",
    images: ["https://example.com/one.jpg"],
    attributes: {
      Orderable: { ShippingWeight: 2 },
      Visible: {
        netContent: {
          productNetContentUnit: "Each",
          productNetContentMeasure: 1,
        },
        pieceCount: 200,
      },
    },
  },
};
describe("existing-listing edit patches", () => {
  it("distinguishes product content from a price or shipping update", () => {
    expect(hasListingUpdateProductContent({ priceCents: 2498 })).toBe(false);
    expect(hasListingUpdateProductContent({ attributes: { Orderable: { ShippingWeight: 3 }, Visible: {} } })).toBe(false);
    expect(hasListingUpdateProductContent({ title: "Card sleeves" })).toBe(true);
    expect(hasListingUpdateProductContent({ attributes: { Visible: { pieceCount: 200 } } })).toBe(true);
  });
  it("resubmits the prefilled content for an unassigned Walmart type without resending price or creation-only fields", () => {
    const original = initialListingUpdateFields({
      ...context,
      current: { ...context.current, productType: "default" },
    });
    original.attributes.Orderable = { ShippingWeight: 2, country_of_origin_substantial_transformation: "China" };
    original.attributes.Visible = { ...original.attributes.Visible as Record<string, unknown>, condition: "New" };
    const before = structuredClone(original);
    // The suggestion is already selected: the old diff returned an empty update.
    expect(listingUpdateChanges(original, original)).toEqual({});
    const changes = listingUpdateContentResubmission(original, original, {
      properties: { Visible: { properties: { pieceCount: {}, netContent: {} } } },
    });
    expect(changes).toEqual({
      title: "Real Walmart title", description: "Old description", brand: "Shellz",
      images: ["https://example.com/one.jpg"],
      attributes: { Visible: {
        pieceCount: 200,
        netContent: { productNetContentUnit: "Each", productNetContentMeasure: 1 },
      } },
    });
    expect(original).toEqual(before);
    expect(hasListingUpdateChanges(changes)).toBe(true);
  });
  it("preserves explicit price and shipping edits when content is resubmitted", () => {
    const original = initialListingUpdateFields(context);
    const current = structuredClone(original);
    current.price = "27.49";
    current.attributes.Orderable = { ShippingWeight: 3 };
    expect(listingUpdateContentResubmission(original, current, {
      properties: { Visible: { properties: { pieceCount: {} } } },
    })).toMatchObject({ priceCents: 2749, attributes: { Orderable: { ShippingWeight: 3 }, Visible: { pieceCount: 200 } } });
  });
  it("cannot resubmit content without loaded maintenance fields", () => {
    const original = initialListingUpdateFields(context);
    expect(() => listingUpdateContentResubmission(original, original, {})).toThrow("Load the selected product type");
  });
  it("treats empty attributes as no edits while preserving false, zero and explicit list replacements", () => {
    expect(hasListingUpdateChanges({ attributes: { Visible: { missing: null, blank: "" } } })).toBe(false);
    for (const value of [false, 0, []]) {
      expect(hasListingUpdateChanges({ attributes: { Visible: { value } } })).toBe(true);
    }
  });
  it("keeps current Walmart price and title without treating catalog defaults as edits", () => {
    const original = initialListingUpdateFields(context);
    expect(original.title).toBe("Real Walmart title");
    expect(original.price).toBe("24.99");
    expect(listingUpdateChanges(original, original)).toEqual({});
    expect(
      listingUpdateChanges(original, { ...original, price: "27.49" }),
    ).toEqual({ priceCents: 2749 });
  });
  it("retains exact cents and rejects invalid or zero prices", () => {
    const original = initialListingUpdateFields(context);
    expect(
      listingUpdateChanges(original, { ...original, price: "0.01" }),
    ).toEqual({ priceCents: 1 });
    for (const price of ["0", "-1", "1.234", "Infinity", "2e3"])
      expect(() =>
        listingUpdateChanges(original, { ...original, price }),
      ).toThrow();
  });
  it("blank text and price controls leave existing fields unchanged", () => {
    const original = initialListingUpdateFields(context);
    expect(
      listingUpdateChanges(original, {
        ...original,
        price: "",
        title: "",
        brand: "",
        description: "",
        images: "",
      }),
    ).toEqual({});
  });
  it("sends an entire changed compound attribute without other fields", () => {
    const original = initialListingUpdateFields(context);
    const current = structuredClone(original);
    current.attributes.Visible = {
      netContent: {
        productNetContentUnit: "Each",
        productNetContentMeasure: 2,
      },
      pieceCount: 200,
    };
    expect(listingUpdateChanges(original, current)).toEqual({
      attributes: {
        Visible: {
          netContent: {
            productNetContentUnit: "Each",
            productNetContentMeasure: 2,
          },
        },
      },
    });
    expect(context.lastSubmitted?.attributes?.Visible?.netContent).toEqual({
      productNetContentUnit: "Each",
      productNetContentMeasure: 1,
    });
  });
  it("category changes do not copy the previous category's attributes", () => {
    const original = initialListingUpdateFields(context);
    expect(
      listingUpdateChanges(original, {
        ...original,
        productType: "Other",
        attributes: { Orderable: original.attributes.Orderable, Visible: {} },
      }),
    ).toEqual({});
  });
  it("treats image order as intentional and validates each URL", () => {
    const original = initialListingUpdateFields(context);
    expect(
      listingUpdateChanges(original, {
        ...original,
        images: "https://example.com/two.jpg\nhttps://example.com/one.jpg",
      }),
    ).toEqual({
      images: ["https://example.com/two.jpg", "https://example.com/one.jpg"],
    });
    expect(() =>
      listingUpdateChanges(original, { ...original, images: "bad-url" }),
    ).toThrow("images.0");
  });
});
