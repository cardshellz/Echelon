import { describe, expect, it } from "vitest";
import {
  initialListingUpdateFields,
  listingUpdateSubmission,
} from "../listing-update-model";
import {
  hasListingUpdateChanges,
  hasListingUpdateProductContent,
  type ListingUpdateContext,
} from "@shared/types/channel-listing-update";

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
const maintenanceSchema = {
  properties: {
    Orderable: { properties: { ShippingWeight: {} } },
    Visible: { properties: { netContent: {}, pieceCount: {}, keyFeatures: {} } },
  },
};
const expectedSubmission = {
  priceCents: 2499,
  title: "Real Walmart title",
  description: "Old description",
  brand: "Shellz",
  images: ["https://example.com/one.jpg"],
  attributes: {
    Orderable: { ShippingWeight: 2 },
    Visible: {
      netContent: { productNetContentUnit: "Each", productNetContentMeasure: 1 },
      pieceCount: 200,
    },
  },
};

describe("complete existing-listing submissions", () => {
  it("distinguishes product content from a price or shipping update", () => {
    expect(hasListingUpdateProductContent({ priceCents: 2498 })).toBe(false);
    expect(hasListingUpdateProductContent({
      attributes: { Orderable: { ShippingWeight: 3 }, Visible: {} },
    })).toBe(false);
    expect(hasListingUpdateProductContent({ title: "Card sleeves" })).toBe(true);
    expect(hasListingUpdateProductContent({
      attributes: { Visible: { pieceCount: 200 } },
    })).toBe(true);
  });

  it.each(["Trading Card Sleeves & Holders", "default"])(
    "sends every populated field without an edit when Walmart reports %s",
    (productType) => {
      const fields = initialListingUpdateFields({
        ...context,
        current: { ...context.current, productType },
      });
      const before = structuredClone(fields);
      const submission = listingUpdateSubmission(fields, maintenanceSchema);
      expect(submission).toEqual(expectedSubmission);
      expect(fields).toEqual(before);
      expect(hasListingUpdateChanges(submission)).toBe(true);
    },
  );

  it("includes unchanged content and shipping alongside a one-cent price edit", () => {
    const fields = initialListingUpdateFields(context);
    fields.price = "24.98";
    expect(listingUpdateSubmission(fields, maintenanceSchema)).toEqual({
      ...expectedSubmission,
      priceCents: 2498,
    });
  });

  it("uses the current Walmart title and price shown by the editor", () => {
    const fields = initialListingUpdateFields({
      ...context,
      current: { ...context.current, title: "Current title", priceCents: 3199 },
      lastSubmitted: { ...context.lastSubmitted, priceCents: 2499 },
    });
    expect(listingUpdateSubmission(fields, maintenanceSchema)).toMatchObject({
      title: "Current title",
      priceCents: 3199,
      description: "Old description",
    });
  });

  it("includes filled shipping edits and excludes retained fields outside the editor schema", () => {
    const fields = initialListingUpdateFields(context);
    fields.attributes.Orderable = {
      ShippingWeight: 3,
      country_of_origin_substantial_transformation: "China",
      inventory: { quantity: 100 },
      sku: "OTHER-SKU",
      price: 0.01,
    };
    fields.attributes.Visible = {
      ...fields.attributes.Visible as Record<string, unknown>,
      condition: "New",
      previousTypeOnly: "old attribute",
    };
    expect(listingUpdateSubmission(fields, maintenanceSchema)).toEqual({
      ...expectedSubmission,
      attributes: {
        ...expectedSubmission.attributes,
        Orderable: { ShippingWeight: 3 },
      },
    });
  });

  it.each([
    {},
    { properties: { Visible: { properties: {} } } },
    { properties: { Orderable: { properties: {} }, Visible: { properties: null } } },
    { properties: { Orderable: { properties: [] }, Visible: { properties: {} } } },
  ])("requires both loaded editable sections: %j", (schema) => {
    expect(() => listingUpdateSubmission(
      initialListingUpdateFields(context), schema,
    )).toThrow("Load the selected product type");
  });

  it("supports a loaded type with no additional editable attributes", () => {
    const fields = initialListingUpdateFields(context);
    const { attributes: _attributes, ...canonical } = expectedSubmission;
    expect(listingUpdateSubmission(fields, {
      properties: {
        Orderable: { properties: {} },
        Visible: { properties: {} },
      },
    })).toEqual(canonical);
  });

  it("retains exact cents and validates prices even when prefilled", () => {
    const fields = initialListingUpdateFields(context);
    expect(listingUpdateSubmission({
      ...fields, price: "0.01",
    }, maintenanceSchema)).toEqual({ ...expectedSubmission, priceCents: 1 });
    for (const price of ["0", "-1", "1.234", "Infinity", "2e3"]) {
      expect(() => listingUpdateSubmission({
        ...fields, price,
      }, maintenanceSchema)).toThrow();
    }
  });

  it("omits blank controls and absent values without sending clears or defaults", () => {
    const fields = initialListingUpdateFields(context);
    const submission = listingUpdateSubmission({
      ...fields,
      price: " ",
      title: "",
      brand: " ",
      description: "",
      images: "\n",
      attributes: {
        Orderable: { ShippingWeight: undefined },
        Visible: { pieceCount: null, keyFeatures: " " },
      },
    }, maintenanceSchema);
    expect(submission).toEqual({});
    expect(hasListingUpdateChanges(submission)).toBe(false);
  });

  it("preserves false, zero and explicit list values", () => {
    for (const value of [false, 0, []]) {
      const fields = initialListingUpdateFields(context);
      fields.attributes.Visible = { custom: value };
      const submission = listingUpdateSubmission(fields, {
        properties: {
          Orderable: { properties: {} },
          Visible: { properties: { custom: {} } },
        },
      });
      expect(submission.attributes?.Visible).toEqual({ custom: value });
    }
    expect(hasListingUpdateChanges({
      attributes: { Visible: { missing: null, blank: "" } },
    })).toBe(false);
  });

  it("includes complete compound values and does not alias the form state", () => {
    const fields = initialListingUpdateFields(context);
    fields.attributes.Visible = {
      netContent: { productNetContentUnit: "Each", productNetContentMeasure: 2 },
      pieceCount: 200,
    };
    const submission = listingUpdateSubmission(fields, maintenanceSchema);
    expect(submission.attributes?.Visible).toEqual(fields.attributes.Visible);
    const netContent = submission.attributes!.Visible!.netContent as Record<string, unknown>;
    netContent.productNetContentMeasure = 99;
    expect((fields.attributes.Visible as Record<string, unknown>).netContent).toEqual({
      productNetContentUnit: "Each", productNetContentMeasure: 2,
    });
    expect(context.lastSubmitted?.attributes?.Visible?.netContent).toEqual({
      productNetContentUnit: "Each", productNetContentMeasure: 1,
    });
  });

  it("does not restore the old type's fields after the editor clears them", () => {
    const fields = initialListingUpdateFields(context);
    fields.productType = "Other";
    fields.attributes.Visible = {};
    expect(listingUpdateSubmission(fields, maintenanceSchema)).toEqual({
      ...expectedSubmission,
      attributes: { Orderable: { ShippingWeight: 2 } },
    });
  });

  it("includes image order and validates every populated URL", () => {
    const fields = initialListingUpdateFields(context);
    fields.images = "https://example.com/two.jpg\nhttps://example.com/one.jpg";
    expect(listingUpdateSubmission(fields, maintenanceSchema)).toEqual({
      ...expectedSubmission,
      images: ["https://example.com/two.jpg", "https://example.com/one.jpg"],
    });
    expect(() => listingUpdateSubmission({
      ...fields, images: "bad-url",
    }, maintenanceSchema)).toThrow("images.0");
  });
});
