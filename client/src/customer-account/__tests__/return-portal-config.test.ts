import { describe, expect, it } from "vitest";
import { returnPortalPageConfigSchema } from "../return-portal-config";
import { customerAccountSignInUrl } from "../customer-account-access";

const config = { themeId: "174740308127", customerId: null, proxyPath: "/apps/echelon-returns", loginPath: "/account/login", logoutPath: "/account/logout" };
describe("native returns page configuration", () => {
  it("accepts guests and string identities without coercing Shopify IDs", () => {
    expect(returnPortalPageConfigSchema.parse(config).customerId).toBeNull();
    expect(returnPortalPageConfigSchema.parse({ ...config, customerId: "9007199254740993" }).customerId).toBe("9007199254740993");
  });
  it.each([
    { customerId: 100 }, { customerId: "0" }, { customerId: "" }, { themeId: 100 },
    { logoutPath: "https://evil.test/account/logout" }, { logoutPath: "//evil.test/account/logout" },
    { loginPath: "/account/login?return_url=https://evil.test" },
    { proxyPath: "https://backend.test/apps/echelon-returns" }, { proxyPath: "/apps/member-portal" },
    { publicOrigin: "https://backend.test" },
  ])("rejects unsafe or ambiguous config: %j", change => {
    expect(returnPortalPageConfigSchema.safeParse({ ...config, ...change }).success).toBe(false);
  });
  it("keeps guest sign-in on the original storefront page and preview template", () => {
    const path = "/pages/start-a-return?preview_theme_id=174740308127&view=return-portal";
    const url = new URL(customerAccountSignInUrl(config.loginPath, path), "https://shop.test");
    expect(url.origin).toBe("https://shop.test");
    expect(url.searchParams.get("return_url")).toBe(path);
  });
});
