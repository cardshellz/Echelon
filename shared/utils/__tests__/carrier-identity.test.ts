import { describe, expect, it } from "vitest";

import {
  canonicalCarrierValue,
  carrierIdentity,
  knownCarrierCode,
} from "../carrier-identity";

describe("carrier identity", () => {
  it.each([
    ["stamps_com", "USPS"],
    ["USPS", "USPS"],
    ["US Postal Service", "USPS"],
    ["ups_walleted", "UPS"],
    ["ups", "UPS"],
    ["United Parcel Service", "UPS"],
    ["FedEx", "FEDEX"],
    ["Federal Express", "FEDEX"],
    ["dhl_express_worldwide", "DHL"],
  ])("maps known provider alias %s to %s", (raw, expected) => {
    expect(knownCarrierCode(raw)).toBe(expected);
    expect(canonicalCarrierValue(raw)).toBe(expected);
  });

  it("treats USPS and stamps_com as the same package identity", () => {
    expect(carrierIdentity("USPS")).toBe(carrierIdentity(" stamps_com "));
  });

  it("keeps different unknown carrier values incompatible", () => {
    expect(carrierIdentity("regional_one")).not.toBe(carrierIdentity("regional_two"));
  });

  it("preserves an unknown carrier value for durable provider use", () => {
    expect(canonicalCarrierValue(" Regional_Carrier ")).toBe("Regional_Carrier");
    expect(knownCarrierCode("Regional_Carrier")).toBeNull();
  });

  it.each([null, undefined, "", "   "])("rejects blank carrier value %s", (raw) => {
    expect(carrierIdentity(raw)).toBeNull();
    expect(canonicalCarrierValue(raw)).toBeNull();
  });
});
