import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG_READ_WORDS } from "../../../../server/modules/dropship/domain/catalog-read-words";
import { LISTING_PUSH_RUN_WORDS } from "../../../../server/modules/dropship/domain/listing-push-run-words";
import { CHOOSE_WORDS } from "../dropship-catalog-choose-words";
import { PUBLISH_WORDS } from "../dropship-catalog-publish-words";
import { DROPSHIP_SITE_UPDATING_MESSAGE } from "../dropship-ops-surface";

/**
 * Step 3's words on publish runs (step 1 plan S2-5, PR A, §4.11): the plan's
 * strings exactly, the same words where the server sends them too, and a
 * PROPOSED marker on every new one.
 */
describe("step 3's publish words (§4.11)", () => {
  it("are the plan's words", () => {
    expect(PUBLISH_WORDS.checkButton).toBe("Check listings");
    expect(PUBLISH_WORDS.checkHint).toBe("Optional. Publishing checks each listing again as it goes.");
    expect(PUBLISH_WORDS.checking(1_200, 10_000)).toBe("Checking 1,200 of 10,000…");
    expect(PUBLISH_WORDS.stopCheck).toBe("Stop checking");
    expect(PUBLISH_WORDS.checkSummary(1_234, 1_200, 30, 4)).toBe("Checked 1,234: 1,200 ready · 30 with warnings · 4 not ready");
    expect(PUBLISH_WORDS.checkFailed(400, 1_234)).toBe("Checking stopped at 400 of 1,234. Try again.");
    expect(PUBLISH_WORDS.publishNew(1)).toBe("Publish 1 new");
    expect(PUBLISH_WORDS.publishNew(1_000)).toBe("Publish 1,000 new");
    expect(PUBLISH_WORDS.publishAll(1_234)).toBe("Publish all 1,234");
    expect(PUBLISH_WORDS.publishAllHint(234)).toBe("Also re-sends the 234 already on eBay. Use it after you change prices or listing settings, or if a listing was changed or ended on eBay directly.");
    expect(PUBLISH_WORDS.publishLine).toBe("Each size is checked and sent to eBay, 500 at a time. Thousands of listings can take a few hours; you can leave this page.");
    expect(PUBLISH_WORDS.runProgress("marz_cards", 1_200, 10_000)).toBe("Publishing to marz_cards: 1,200 of 10,000 done");
    expect(PUBLISH_WORDS.runCounts({ completed: 12, notReady: 2, review: 1, failed: 3, skipped: 4 }))
      .toBe("12 published · 2 not ready · 1 price needs your review · 3 failed · 4 skipped");
    expect(PUBLISH_WORDS.runCounts({ completed: 0, notReady: 0, review: 1, failed: 0, skipped: 0 })).toBe("1 price needs your review");
    expect(PUBLISH_WORDS.runStop).toBe("Stop publishing");
    expect(PUBLISH_WORDS.runStopping).toBe("Stopping… The listing being sent right now finishes first.");
    expect(PUBLISH_WORDS.runStopped(3, 1_000)).toBe("Publishing stopped. 3 of 1,000 were done before you stopped.");
    expect(PUBLISH_WORDS.runProviderDown(1_200, 10_000)).toBe("eBay wasn't answering, so publishing stopped. 1,200 of 10,000 were done. Publish again later.");
    // One done reads "was" (verify VC13; a deviation from §4.11's plural-only text, as runSnapshotDiff's singular).
    expect(PUBLISH_WORDS.runStopped(1, 1)).toBe("Publishing stopped. 1 of 1 was done before you stopped.");
    expect(PUBLISH_WORDS.runProviderDown(1, 600)).toBe("eBay wasn't answering, so publishing stopped. 1 of 600 was done. Publish again later.");
    expect(PUBLISH_WORDS.runStopped(0, 4)).toBe("Publishing stopped. 0 of 4 were done before you stopped.");
    expect(PUBLISH_WORDS.runFinished).toBe("Publishing finished.");
    expect(PUBLISH_WORDS.runProblems(3)).toBe("Didn't publish (3)");
    expect(PUBLISH_WORDS.priceReviewRow).toBe("Its price changed after you pressed Publish, and your cost-change setting waits for your review. Check it, then publish again.");
    expect(PUBLISH_WORDS.runSnapshotDiff(2)).toBe("2 of your selected items are no longer offered by Card Shellz and were left out.");
    expect(PUBLISH_WORDS.runSnapshotDiff(1)).toBe("1 of your selected items is no longer offered by Card Shellz and was left out.");
    expect(PUBLISH_WORDS.notSent).toBe("Publishing didn't start. Check your connection and press Publish again.");
    expect(PUBLISH_WORDS.emailTitle).toBe("Some listings didn't publish");
    expect(PUBLISH_WORDS.siteUpdating).toBe("Card Shellz is updating the site. This page will try again in a moment; nothing you did is lost.");
  });

  it("match the server's words where both say it", () => {
    for (const key of ["runActive", "selectionChanged", "runTooLarge", "runEmptyNew", "runEmpty", "emailTitle"] as const) {
      expect(PUBLISH_WORDS[key], key).toBe(LISTING_PUSH_RUN_WORDS[key]);
    }
    // The create limiter's 429 (verify VC6): the page shows the same words the server sent.
    expect(PUBLISH_WORDS.runRateLimited).toBe(LISTING_PUSH_RUN_WORDS.rateLimited);
    expect(PUBLISH_WORDS.siteUpdating).toBe(DROPSHIP_SITE_UPDATING_MESSAGE);
    expect(PUBLISH_WORDS.siteUpdating).toBe(CATALOG_READ_WORDS.pageNewerThanServer);
    // Stage 1's save, once PR B froze the rules (§4.9 item 2): step 1's words, the server's too.
    expect(CHOOSE_WORDS.retired).toBe(CATALOG_READ_WORDS.retired);
    expect(CHOOSE_WORDS.retired).toBe("This page was updated, so your last changes weren't saved. Reload it and make them again.");
  });

  it("never show a code, and mark every new string PROPOSED", () => {
    const source = readFileSync(join(process.cwd(), "client/src/lib/dropship-catalog-publish-words.ts"), "utf8");
    const body = source.slice(source.indexOf("export const PUBLISH_WORDS"));
    const entries = [...body.matchAll(/\n( {2}\/\/ [^\n]*\n)?( {2}\w+: )/g)];
    expect(entries.length).toBeGreaterThan(50);
    for (const match of entries) {
      // Stage 4 is PR C's (PLAN-C v4.1 §11): the push fence's run problem rows.
      expect(match[1], `no marker above ${match[2].trim()}`).toMatch(/\/\/ (Stage [24] \(step 1 plan S2-5\): PROPOSED|Kept)/);
    }
    const shown = Object.values(PUBLISH_WORDS as Record<string, unknown>).filter((value): value is string => typeof value === "string");
    for (const words of shown) expect(words).not.toMatch(/[A-Z]{2,}_[A-Z_]+/);
  });
});
