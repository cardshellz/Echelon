import { describe, expect, it } from "vitest";
import { customerAccountAccessNotice, customerAccountSignInUrl } from "../customer-account-access";
import { CustomerAccountRequestError, customerAccountPageConfigSchema } from "../customer-account.transport";

const config = { themeId: "174740308127", customerId: "100", proxyPath: "/apps/echelon-returns" };

describe("order page access presentation", () => {
  it("offers sign-in only when the backend verified a signed guest request", () => {
    expect(customerAccountAccessNotice(new CustomerAccountRequestError("CUSTOMER_ACCOUNT_SIGN_IN_REQUIRED", "backend detail")))
      .toEqual({ message: "Your sign-in is no longer active. Sign in again to make changes.", action: "sign_in" });
  });
  it.each(["RETURN_CUSTOMER_LOGIN_REQUIRED", "RETURN_HANDOFF_PROOF_INVALID", "RETURN_HANDOFF_PROOF_EXPIRED",
    "CUSTOMER_ACCOUNT_IDENTITY_CHANGED", "CUSTOMER_ACCOUNT_TESTING_UNAVAILABLE", undefined])
    ("does not claim the shopper signed out for %s", code => {
      expect(customerAccountAccessNotice(new CustomerAccountRequestError(code, "Sign in to view your returns. private detail")))
        .toEqual({ message: "We couldn't load the options for your order. Please try again.", action: "retry" });
    });
  it("does not expose raw network errors", () => {
    expect(customerAccountAccessNotice(new TypeError("Failed to fetch"))).toMatchObject({ action: "retry" });
    expect(customerAccountAccessNotice(null).message).not.toMatch(/tools|returns|sign.in/i);
  });
  it("preserves the exact order and staging preview after sign-in using Shopify's localized route", () => {
    const link = customerAccountSignInUrl("/en-us/account/login", "/en-us/account/orders/fixture?preview_theme_id=174740308127");
    const parsed = new URL(link, "https://store.test");
    expect(parsed.pathname).toBe("/en-us/account/login");
    expect(parsed.searchParams.get("return_url")).toBe("/en-us/account/orders/fixture?preview_theme_id=174740308127");
  });
  it.each(["https://other.test/account", "//other.test/account", "https://account.invalid@other.test/account"])
    ("rejects an external return destination %s", destination => {
      expect(() => customerAccountSignInUrl("/account/login", destination)).toThrow("must stay on the storefront");
    });
  it("defaults the login route for earlier themes and rejects external or malformed routes", () => {
    expect(customerAccountPageConfigSchema.parse(config).loginPath).toBe("/account/login");
    for (const loginPath of ["//other.test/account/login", "https://other.test/account/login", "/account/login?return_url=other", "/account\\login"])
      expect(customerAccountPageConfigSchema.safeParse({ ...config, loginPath }).success).toBe(false);
    expect(() => customerAccountSignInUrl("https://other.test/account/login", "/account")).toThrow();
  });
});
