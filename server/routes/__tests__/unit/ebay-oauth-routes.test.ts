import { describe, expect, it } from "vitest";
import { isLikelyDropshipOAuthState } from "../../ebay-oauth.routes";

function signlessDropshipState(payload: Record<string, unknown>): string {
  return `${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.signature`;
}

describe("eBay OAuth routes", () => {
  it("detects signed dropship eBay states before legacy channel parsing", () => {
    const state = signlessDropshipState({
      version: 1,
      vendorId: 1,
      memberId: "9f2a4919-ed4a-4130-b2fc-62ce0f91f51b",
      platform: "ebay",
    });

    expect(isLikelyDropshipOAuthState(state)).toBe(true);
  });

  it("does not treat legacy channel states as dropship callbacks", () => {
    expect(isLikelyDropshipOAuthState("echelon-ebay-setup")).toBe(false);
    expect(isLikelyDropshipOAuthState("123")).toBe(false);
  });

  it("rejects malformed signed-looking states", () => {
    expect(isLikelyDropshipOAuthState("not-json.signature")).toBe(false);
    expect(isLikelyDropshipOAuthState("too.many.parts")).toBe(false);
    expect(isLikelyDropshipOAuthState(signlessDropshipState({
      version: 1,
      vendorId: 1,
      memberId: "member-1",
      platform: "shopify",
    }))).toBe(false);
  });
});
