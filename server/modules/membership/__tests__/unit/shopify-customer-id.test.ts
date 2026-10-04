/**
 * Echelon must find the member the membership app would find for the same
 * Shopify customer id, so the normalizer is checked against a verbatim copy of
 * the app's own rule: normalizeShopifyCustomerIdValue in
 * cardshellz/shellz-club-app server/infrastructure/repos/memberRepo.ts
 * (commit f678a69). Change both together.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeShopifyCustomerId,
  SHOPIFY_CUSTOMER_GID_PREFIX,
  SHOPIFY_CUSTOMER_ID_MAX_LENGTH,
  shopifyCustomerIdCandidates,
} from "../../domain/shopify-customer-id";

/** Verbatim from the membership app; an empty string there means "no id". */
function membershipAppNormalize(input: unknown): string {
  let v = String(input || "").trim();
  if (!v) return v;
  v = v.replace(/^gid:\/\/shopify\/Customer\//i, "").trim();
  v = v.replace(/,/g, "");
  v = v.replace(/^'(.+)'$/, "$1");
  if (/^\d+\.0+$/.test(v)) {
    v = v.replace(/\.0+$/, "");
  }
  return v.trim();
}

const PARITY_INPUTS: readonly unknown[] = [
  "23325275357343",
  23325275357343,
  "gid://shopify/Customer/23325275357343",
  "GID://Shopify/Customer/23325275357343",
  "  gid://shopify/Customer/ 23325275357343 ",
  "3,978,054,467,743",
  "'3978054467743'",
  "' 3978054467743 '",
  "3978054467743.0",
  "3978054467743.000",
  "3978054467743.5",
  "2.33362E+13",
  "import_123",
  "admin_1700000000000",
  "''",
  "'",
  "gid://shopify/Customer/",
  "   ",
  "",
  0,
  false,
  null,
  undefined,
];

describe("normalizeShopifyCustomerId", () => {
  it.each(PARITY_INPUTS.map((input) => [input]))("matches the membership app for %j", (input) => {
    const expected = membershipAppNormalize(input);
    expect(normalizeShopifyCustomerId(input)).toBe(expected === "" ? null : expected);
  });

  it("turns every stored or exported form of one customer into the bare numeric id", () => {
    for (const form of [
      "23325275357343",
      23325275357343,
      "gid://shopify/Customer/23325275357343",
      "23,325,275,357,343",
      "'23325275357343'",
      "23325275357343.0",
    ]) {
      expect(normalizeShopifyCustomerId(form)).toBe("23325275357343");
    }
  });

  it("never expands scientific notation into a plausible but wrong id", () => {
    expect(normalizeShopifyCustomerId("2.33362E+13")).toBe("2.33362E+13");
  });

  it("returns null when nothing usable remains", () => {
    for (const empty of [null, undefined, "", "   ", "gid://shopify/Customer/", 0, false]) {
      expect(normalizeShopifyCustomerId(empty)).toBeNull();
    }
  });

  it("rejects a value longer than any real id, Echelon's one addition to the app's rule", () => {
    const longest = "9".repeat(SHOPIFY_CUSTOMER_ID_MAX_LENGTH);
    expect(normalizeShopifyCustomerId(longest)).toBe(longest);
    expect(normalizeShopifyCustomerId(`${longest}9`)).toBeNull();
  });
});

describe("shopifyCustomerIdCandidates", () => {
  it("matches a numeric id in both stored forms, numeric first", () => {
    expect(shopifyCustomerIdCandidates("23325275357343")).toEqual([
      "23325275357343",
      `${SHOPIFY_CUSTOMER_GID_PREFIX}23325275357343`,
    ]);
  });

  it("matches any other value only as itself", () => {
    expect(shopifyCustomerIdCandidates("2.33362E+13")).toEqual(["2.33362E+13"]);
    expect(shopifyCustomerIdCandidates("import_123")).toEqual(["import_123"]);
  });
});
