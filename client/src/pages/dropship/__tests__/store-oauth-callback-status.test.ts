import { describe, expect, it } from "vitest";
import {
  readStoreOAuthCallbackStatus,
  storeOAuthCallbackMessage,
} from "../store-oauth-callback-status";

describe("dropship store OAuth callback status", () => {
  it("explains that an account mismatch was rejected without changing the connection", () => {
    const status = readStoreOAuthCallbackStatus(
      "?storeConnection=error&error=DROPSHIP_STORE_OAUTH_ACCOUNT_MISMATCH",
    );

    expect(status).not.toBeNull();
    expect(storeOAuthCallbackMessage(status!, "marz_cards")).toBe(
      "The authorization was not saved because a different eBay account was used. Sign in to the eBay account that owns marz_cards, or choose Change eBay store if you intended to replace it.",
    );
  });

  it("reports successful callbacks and ignores unrelated query strings", () => {
    const connected = readStoreOAuthCallbackStatus("?storeConnection=connected");

    expect(connected).toEqual({ kind: "connected", errorCode: null });
    expect(storeOAuthCallbackMessage(connected!)).toBe("Store connection completed.");
    expect(readStoreOAuthCallbackStatus("?section=notifications")).toBeNull();
  });
});
