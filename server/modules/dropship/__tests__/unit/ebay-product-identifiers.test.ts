import { describe, expect, it } from "vitest";
import {
  EBAY_MPN_NOT_APPLICABLE,
  ebayProductIdentifierWarnings,
  resolveEbayMpn,
} from "../../domain/ebay-product-identifiers";

describe("resolveEbayMpn", () => {
  it("uses the catalog MPN when there is one", () => {
    expect(resolveEbayMpn({ mpn: " TL35 ", itemSpecifics: { MPN: ["OTHER"] } })).toEqual({ mpn: "TL35", placeholder: false });
  });

  it("falls back to an MPN item specific, whatever its case or shape", () => {
    expect(resolveEbayMpn({ mpn: null, itemSpecifics: { mpn: "ARM-50" } })).toEqual({ mpn: "ARM-50", placeholder: false });
    expect(resolveEbayMpn({ mpn: "", itemSpecifics: { MPN: ["ARM-50", "ARM-51"] } })).toEqual({ mpn: "ARM-50", placeholder: false });
  });

  it("sends eBay's placeholder when the catalog has no MPN at all", () => {
    expect(resolveEbayMpn({ mpn: null, itemSpecifics: null })).toEqual({ mpn: EBAY_MPN_NOT_APPLICABLE, placeholder: true });
    expect(resolveEbayMpn({ mpn: "   ", itemSpecifics: { MPN: [""], Size: ["35pt"] } })).toEqual({ mpn: "Does Not Apply", placeholder: true });
    expect(resolveEbayMpn({ mpn: null, itemSpecifics: { MPN: 42 } })).toEqual({ mpn: "Does Not Apply", placeholder: true });
  });
});

describe("ebayProductIdentifierWarnings", () => {
  it("warns only when the placeholder is what eBay will show", () => {
    expect(ebayProductIdentifierWarnings({ mpn: null, itemSpecifics: null })).toEqual(["ebay_mpn_placeholder"]);
    expect(ebayProductIdentifierWarnings({ mpn: "TL35", itemSpecifics: null })).toEqual([]);
  });
});
