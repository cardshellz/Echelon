import { describe, expect, it } from "vitest";
import { storeOAuthTargetConfirmationCopy } from "../StoreOAuthTargetConfirmationDialog";

const target = {
  storeConnectionId: 44,
  platform: "ebay" as const,
  displayName: "marz_cards",
  externalAccountId: "provider-account-1",
};

describe("store OAuth target confirmation", () => {
  it("names the exact store in the reconnect action", () => {
    expect(storeOAuthTargetConfirmationCopy(target, "refresh_connection")).toEqual({
      actionLabel: "Continue to eBay for marz_cards",
      platformName: "eBay",
      reconnecting: true,
      title: "Reconnect marz_cards",
    });
  });

  it("keeps replacement copy distinct from same-store reconnect", () => {
    expect(storeOAuthTargetConfirmationCopy(target, "change_store")).toEqual({
      actionLabel: "Continue to eBay to choose a different store",
      platformName: "eBay",
      reconnecting: false,
      title: "Replace marz_cards with a different eBay store?",
    });
  });
});
