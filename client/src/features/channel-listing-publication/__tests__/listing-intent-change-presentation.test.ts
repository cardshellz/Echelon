import { describe, expect, it } from "vitest";
import { listingIntentChangePresentation, listingIntentChangesUrl } from "../listing-intent-change-presentation";

describe("saved listing change status", () => {
  it("does not present queue acceptance as provider completion", () => {
    const status = listingIntentChangePresentation({ state: "delivered", can_retry: false, last_error_message: null });
    expect(status.label).toBe("Update requested");
    expect(status.message).toContain("Provider completion has not been confirmed");
    expect(status.retry).toBe(false);
  });
  it("never turns review-required or pending changes into a retry approval", () => {
    for (const state of ["needs_review", "pending"] as const) {
      expect(listingIntentChangePresentation({ state, can_retry: true, last_error_message: "Review selected members." }).retry).toBe(false);
    }
  });
  it("uses the owner-projected retry permission for a blocked change", () => {
    for (const can_retry of [false, true]) {
      expect(listingIntentChangePresentation({ state: "blocked", can_retry, last_error_message: "Reconnect the original account." }))
        .toMatchObject({ retry: can_retry, attention: true, message: "Reconnect the original account." });
    }
  });
  it("keeps channel and Dropship account routes distinct", () => {
    expect(listingIntentChangesUrl({ kind: "channel", channelId: 67 })).toBe("/api/channels/67/listing-intent-changes");
    expect(listingIntentChangesUrl({ kind: "dropship", storeConnectionId: 67 })).toBe("/api/dropship/listings/stores/67/listing-intent-changes");
  });
  it("rejects invalid scope IDs instead of widening the status query", () => {
    for (const channelId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => listingIntentChangesUrl({ kind: "channel", channelId })).toThrow();
    }
  });
});
