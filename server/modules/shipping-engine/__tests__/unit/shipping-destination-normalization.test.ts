import { describe, expect, it } from "vitest";
import { normalizeShippingDestination } from "../../domain/shipping-destination-normalization";

describe("normalizeShippingDestination", () => {
  it("canonicalizes a United States country and full state name", () => {
    expect(normalizeShippingDestination({
      country: "United States",
      region: "Pennsylvania",
      postalCode: " 15044 ",
    })).toEqual({
      ok: true,
      destination: {
        country: "US",
        region: "PA",
        postalCode: "15044",
      },
    });
  });

  it("accepts canonical and military region codes", () => {
    expect(normalizeShippingDestination({
      country: "US",
      region: "ae",
      postalCode: "09012-1234",
    })).toEqual({
      ok: true,
      destination: {
        country: "US",
        region: "AE",
        postalCode: "09012-1234",
      },
    });
  });

  it("allows a country-only destination", () => {
    expect(normalizeShippingDestination({ country: "USA" })).toEqual({
      ok: true,
      destination: {
        country: "US",
        region: null,
        postalCode: null,
      },
    });
  });

  it("rejects an unrecognized United States region", () => {
    expect(normalizeShippingDestination({
      country: "US",
      region: "Atlantis",
    })).toEqual({
      ok: false,
      code: "SHIPPING_DESTINATION_REGION_INVALID",
      message: "The United States destination region is not recognized.",
    });
  });

  it("does not claim ownership of non-US destination normalization", () => {
    expect(normalizeShippingDestination({
      country: "CA",
      region: "Ontario",
    })).toEqual({
      ok: false,
      code: "SHIPPING_DESTINATION_COUNTRY_UNSUPPORTED",
      message: "Echelon does not own destination normalization for this country.",
    });
  });
});
