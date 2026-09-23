import { describe, expect, it } from "vitest";
import { parseCustomerReturnShopDomains } from "../../infrastructure/customer-return-live.composition";

describe("explicit private returns shop configuration", () => {
  it("does not infer a main store from absent configuration", () => {
    expect(parseCustomerReturnShopDomains(undefined)).toEqual([]);
    expect(parseCustomerReturnShopDomains("  ")).toEqual([]);
  });
  it("accepts canonical domains with delimiter whitespace", () => {
    expect(parseCustomerReturnShopDomains("fixture.myshopify.com, second.myshopify.com ")).toEqual(["fixture.myshopify.com", "second.myshopify.com"]);
  });
  it.each(["https://fixture.myshopify.com", "fixture.myshopify.com/", "fixture.myshopify.com.evil.test", "FIXTURE.myshopify.com", ",",
    "fixture.myshopify.com,fixture.myshopify.com", "fixture.myshopify.com,", "admin@fixture.myshopify.com"])("rejects unsafe/ambiguous configuration %s", raw => {
    expect(() => parseCustomerReturnShopDomains(raw)).toThrow("configuration needs attention");
  });
});
