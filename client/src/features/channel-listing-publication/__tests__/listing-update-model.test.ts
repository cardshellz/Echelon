import { describe, expect, it } from "vitest";
import {
  initialListingUpdateFields,
  listingUpdateChanges,
} from "../listing-update-model";
import type { ListingUpdateContext } from "@shared/types/channel-listing-update";

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
