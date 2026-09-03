import { describe, expect, it } from "vitest";
import { buildDropshipPortalOAuthRedirect } from "../../interfaces/http/dropship-oauth-redirect";

describe("dropship OAuth portal redirect", () => {
  it("returns callback failures to the signed portal path", () => {
    expect(buildDropshipPortalOAuthRedirect({
      portalUrl: "https://cardshellz.example",
      status: "error",
      returnTo: "/dropship/onboarding",
      errorCode: "DROPSHIP_STORE_OAUTH_ACCOUNT_MISMATCH",
    })).toBe(
      "https://cardshellz.example/dropship/onboarding?storeConnection=error&error=DROPSHIP_STORE_OAUTH_ACCOUNT_MISMATCH",
    );
  });

  it("rejects an external return target", () => {
    expect(() => buildDropshipPortalOAuthRedirect({
      portalUrl: "https://cardshellz.example",
      status: "error",
      returnTo: "https://attacker.example/callback",
    })).toThrow();
  });
});
