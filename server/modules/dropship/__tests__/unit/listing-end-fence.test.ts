import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LISTING_END_FENCE_CODES,
  LISTING_END_FENCE_WORDS,
  decideListingEndFence,
  decideListingEndFenceAction,
  type ListingEndFenceOutcome,
} from "../../domain/listing-end-fence";
import { RELIST_ALLOWED_RESULT_FIELD } from "../../domain/marketplace-push-rule";

/** PR C's push fence (PLAN-C v4.1 §6.2): the pure decisions the push worker repository and service apply. */
describe("decideListingEndFence", () => {
  it("fences an open end, a failed end waiting for staff, and a Card Shellz end after the item was queued", () => {
    expect(decideListingEndFence({ openEndState: "pending", endedSinceQueued: false })).toBe("end_open");
    expect(decideListingEndFence({ openEndState: "ending", endedSinceQueued: false })).toBe("end_open");
    expect(decideListingEndFence({ openEndState: "failed", endedSinceQueued: false })).toBe("end_review");
    expect(decideListingEndFence({ openEndState: null, endedSinceQueued: true })).toBe("ended_since_queued");
  });

  it("lets an open end win over an older finished one, and starts the item when there is neither", () => {
    expect(decideListingEndFence({ openEndState: "pending", endedSinceQueued: true })).toBe("end_open");
    expect(decideListingEndFence({ openEndState: "failed", endedSinceQueued: true })).toBe("end_review");
    expect(decideListingEndFence({ openEndState: null, endedSinceQueued: false })).toBeNull();
  });
});

describe("decideListingEndFenceAction (§6.2 table, DC11, FID-13)", () => {
  const outcomes: ListingEndFenceOutcome[] = ["end_open", "end_review", "ended_since_queued"];
  const vendor = { [RELIST_ALLOWED_RESULT_FIELD]: true };

  it("blocks only a vendor's own item inside a publish run; every other item is skipped quietly", () => {
    for (const outcome of outcomes) {
      expect(decideListingEndFenceAction({ outcome, itemResult: vendor, inRun: true }).action).toBe("block");
      expect(decideListingEndFenceAction({ outcome, itemResult: vendor, inRun: false }).action).toBe("skip");
      expect(decideListingEndFenceAction({ outcome, itemResult: {}, inRun: true }).action).toBe("skip");
      expect(decideListingEndFenceAction({ outcome, itemResult: null, inRun: false }).action).toBe("skip");
      // A pushed or stale-recovered vendor item is still the vendor's own press (the raw field, not the relist rule).
      expect(decideListingEndFenceAction({ outcome, itemResult: { ...vendor, push: { status: "failed" } }, inRun: true }).action).toBe("block");
      expect(decideListingEndFenceAction({ outcome, itemResult: { [RELIST_ALLOWED_RESULT_FIELD]: "true" }, inRun: true }).action).toBe("skip");
    }
  });

  it("names each outcome's code and server words", () => {
    expect(decideListingEndFenceAction({ outcome: "end_open", itemResult: null, inRun: false }))
      .toEqual({ action: "skip", code: "DROPSHIP_LISTING_END_IN_PROGRESS", message: "This listing is being ended on eBay, so it wasn't published." });
    expect(decideListingEndFenceAction({ outcome: "end_review", itemResult: null, inRun: false }))
      .toEqual({ action: "skip", code: "DROPSHIP_LISTING_END_REVIEW", message: "Card Shellz is looking into this listing; it stays at quantity 0." });
    expect(decideListingEndFenceAction({ outcome: "ended_since_queued", itemResult: null, inRun: false })).toEqual({ action: "skip",
      code: "DROPSHIP_LISTING_ENDED_SINCE_PUBLISH",
      message: "This listing was ended after it was published. Publish it again in step 3 to sell it." });
    expect(Object.values(LISTING_END_FENCE_CODES)).toHaveLength(3);
    expect(Object.keys(LISTING_END_FENCE_WORDS)).toEqual(Object.keys(LISTING_END_FENCE_CODES));
  });

  it("marks every server word PROPOSED (Stage 4, step 1 plan S2-5) (PLAN-C v4.1 §11)", () => {
    const source = readFileSync(resolve(process.cwd(), "server/modules/dropship/domain/listing-end-fence.ts"), "utf8");
    for (const words of Object.values(LISTING_END_FENCE_WORDS)) {
      const line = source.split("\n").findIndex((text) => text.includes(JSON.stringify(words)));
      expect(line, words).toBeGreaterThan(0);
      expect(source.split("\n")[line - 1]).toContain("// PROPOSED (Stage 4, step 1 plan S2-5)");
    }
  });
});
