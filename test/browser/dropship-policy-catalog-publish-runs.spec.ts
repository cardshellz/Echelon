import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  CATALOG_PATH,
  LIVE_PROOF,
  MARZ,
  OUTLET,
  ROW_FACT,
  STEP_UP_CODE,
  chooseRowsFixture,
  openCatalog,
  pageNewerThanServerAnswer,
  picksOf,
  saveFromAnotherTab,
  type ChooseRowFact,
  type StubRun,
  type StubRunFrame,
  type StubState,
} from "./dropship-policy-catalog-stubs";

// Playwright's serviceWorkers:block init script reads navigator.serviceWorker in
// every frame, which throws in an opaque sandbox. This local-only harness
// registers no workers.
test.use({ serviceWorkers: "allow" });

/**
 * Catalog step 3 on publish runs (step 1 plan S2-5, PR A, §4.10, §4.13 P1-P12): the optional chunked Check, "Publish
 * {n} new" and "Publish all {n}" as one run the server snapshots, its card with Stop, the results, and the answers of
 * an older dyno during a deploy. The stub answers the run routes and the catalog reads as the server does, parsing
 * every request and answer with the shared contracts (dropship-policy-catalog-stubs.ts).
 */

const PUBLISH_PATH = `${CATALOG_PATH}/publish`;
const SITE_UPDATING = "Card Shellz is updating the site. This page will try again in a moment; nothing you did is lost.";
/** A run poll is every 3 s for the first 2 minutes (runPollDelayMs); a few polls fit in this. */
const POLL_TIMEOUT_MS = 15_000;

/** `count` selected sizes: the stub's catalog fixture, every size picked (PR B's one-time picks, V28). */
function selected(count: number): Partial<StubState> {
  const chooseRows = chooseRowsFixture(count);
  return { chooseRows, picks: picksOf(chooseRows) };
}

function card(page: Page): Locator {
  return page.getByTestId("publish-step");
}

function runCard(page: Page): Locator {
  return page.getByTestId("publish-run-card");
}

function expectClean(state: StubState) {
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
}

/** Frames a run walks through on each detail read: `processing` stays until the last one. */
function processingFrames(reads: number, targets: number): StubRunFrame[] {
  return Array.from({ length: reads }, (_, index) => ({ counts: { pending: Math.max(0, targets - 500 * (index + 1)), queued: Math.min(500, targets),
    completed: Math.min(targets, 500 * index) } }));
}

test("P1 1,234 selected: Check runs 7 sequential previews of at most 200 with progress and the summary; the list pages server-side", async ({ page }) => {
  const state = await openCatalog(page, PUBLISH_PATH, selected(1_234));
  await expect(card(page).getByTestId("publish-counts")).toContainText("1,234");
  // "Selected items": 200 a page from the server, Load more.
  await expect(card(page).getByTestId("publish-selected-shown")).toHaveText("Showing 200 of 1,234");
  await card(page).getByTestId("publish-selected").getByRole("button", { name: "Load more" }).click();
  await expect(card(page).getByTestId("publish-selected-shown")).toHaveText("Showing 400 of 1,234");
  const listReads = state.reads.filter((read) => read.path === "/api/dropship/catalog" && read.search.includes("selection=selected&selectedOnly=true"));
  expect(listReads.map((read) => read.search)).toEqual([
    "?selection=selected&selectedOnly=true&includeFacets=false&clientVersion=2&page=1&limit=200",
    "?selection=selected&selectedOnly=true&includeFacets=false&clientVersion=2&page=2&limit=200",
  ]);

  await card(page).getByRole("button", { name: "Check listings" }).click();
  await expect(card(page).getByTestId("publish-check-summary")).toHaveText("Checked 1,234: 1,234 ready · 0 with warnings · 0 not ready");
  expect(state.previewBodies.map((body) => body.productVariantIds.length)).toEqual([200, 200, 200, 200, 200, 200, 34]);
  expect(state.previewBodies.flatMap((body) => body.productVariantIds)).toEqual(chooseRowsFixture(1_234).map((fact) => fact.productVariantId));
  expect(new Set(state.previewBodies.map((body) => body.storeConnectionId))).toEqual(new Set([MARZ.storeConnectionId]));
  // One id read for the check, this page's version on it.
  expect(state.reads.filter((read) => read.search.includes("idsOnly=true")).map((read) => read.search))
    .toEqual(["?selection=selected&idsOnly=true&purpose=remove&clientVersion=2"]);
  // The check's table replaces the list; nothing was published.
  await expect(card(page).getByTestId("publish-selected")).toHaveCount(0);
  expect(state.runCreates).toEqual([]);
  expectClean(state);
});

test("P2 Publish new asks for the code first, sends one run with a key and scope not_live, and a reload mid-run resumes the card", async ({ page }) => {
  const state = await openCatalog(page, PUBLISH_PATH, { ...selected(1_234),
    nextRunFrames: [...processingFrames(4, 1_234), { status: "completed", counts: { pending: 0, queued: 0, completed: 1_234 } }] });
  const publishNew = card(page).getByRole("button", { name: "Publish 1,234 new" });
  await expect(card(page).getByRole("button", { name: "Publish all 1,234" })).toBeVisible();
  await publishNew.click();
  // No live proof: a code is sent, and nothing is published yet.
  await expect(card(page).getByText("Verification code to publish listings")).toBeVisible();
  expect(state.codesSent).toEqual(["bulk_listing_push"]);
  expect(state.runCreates).toEqual([]);
  await card(page).locator("input").first().fill(STEP_UP_CODE);
  await publishNew.click();

  await expect(runCard(page).getByTestId("publish-run-title")).toHaveText("Publishing to Marz Cards: 0 of 1,234 done");
  expect(state.runCreates).toHaveLength(1);
  expect(state.runCreates[0].body).toEqual({ storeConnectionId: MARZ.storeConnectionId, scope: "not_live",
    idempotencyKey: expect.stringMatching(/^listing-push-run:/), expectedSelectionRevisionId: state.selectionRevision });
  // A second press would be refused while it runs, so the buttons wait.
  await expect(publishNew).toBeDisabled();

  await page.reload();
  await expect(runCard(page).getByTestId("publish-run-title")).toContainText("Publishing to Marz Cards:");
  await expect(runCard(page).getByTestId("publish-run-title")).toHaveText("Publishing finished.", { timeout: POLL_TIMEOUT_MS });
  await expect(runCard(page).getByTestId("publish-run-counts")).toHaveText("1,234 published");
  // One run, never a second create.
  expect(state.runCreates).toHaveLength(1);
  expect(state.runs).toHaveLength(1);
  expectClean(state);
});

test("P3 a lost answer: the retry carries the same key and gets the replay", async ({ page }) => {
  const state = await openCatalog(page, PUBLISH_PATH, { ...selected(3), proofs: { bulk_listing_push: LIVE_PROOF }, runCreateAnswers: ["drop"] });
  await card(page).getByRole("button", { name: "Publish 3 new" }).click();
  await expect(runCard(page).getByTestId("publish-run-title")).toHaveText("Publishing finished.", { timeout: POLL_TIMEOUT_MS });
  expect(state.runCreates.map((create) => create.status)).toEqual([0, 200]);
  expect(state.runCreates[1].body).toEqual(state.runCreates[0].body);
  expect(state.runs).toHaveLength(1);
  expectClean(state);
});

test("P4 another tab changed the selection: selectionChanged, the count read again, no run", async ({ page }) => {
  const state = await openCatalog(page, PUBLISH_PATH, { ...selected(3), proofs: { bulk_listing_push: LIVE_PROOF } });
  await expect(card(page).getByRole("button", { name: "Publish 3 new" })).toBeEnabled();
  const summaryReads = () => state.reads.filter((read) => read.path === "/api/dropship/catalog/selection").length;
  const before = summaryReads();
  // Another tab's save that leaves the same sizes picked: only the revision moves.
  saveFromAnotherTab(state, {});
  await card(page).getByRole("button", { name: "Publish 3 new" }).click();
  await expect(card(page).getByTestId("publish-error")).toHaveText("Your choices changed since this page loaded. Check the count and publish again.");
  await expect.poll(summaryReads).toBeGreaterThan(before);
  expect(state.runCreates.map((create) => create.status)).toEqual([409]);
  expect(state.runs).toEqual([]);
  expectClean(state);
});

test("P5 Stop publishing says Stopping, then the stopped words, and the page stops asking", async ({ page }) => {
  const state = await openCatalog(page, PUBLISH_PATH, { ...selected(1_234), proofs: { bulk_listing_push: LIVE_PROOF },
    nextRunFrames: processingFrames(30, 1_234) });
  await card(page).getByRole("button", { name: "Publish 1,234 new" }).click();
  await expect(runCard(page).getByTestId("publish-run-title")).toContainText("Publishing to Marz Cards:");
  await runCard(page).getByRole("button", { name: "Stop publishing" }).click();
  await expect(runCard(page).getByTestId("publish-run-title")).toHaveText("Stopping… The listing being sent right now finishes first.");
  await expect(runCard(page).getByRole("button", { name: "Stop publishing" })).toHaveCount(0);
  await expect(runCard(page).getByTestId("publish-run-title")).toHaveText(/^Publishing stopped\. \d+ of 1,234 were done before you stopped\.$/, { timeout: POLL_TIMEOUT_MS });
  expect(state.runStops).toEqual([state.runs[0].view.runId]);
  expect(state.runs[0].view.status).toBe("cancelled");
  // A finished run is not asked about again.
  const reads = state.runDetailReads.length;
  await page.waitForTimeout(4_000);
  expect(state.runDetailReads.length).toBe(reads);
  expectClean(state);
});

test("P6 a run with failures and one price review shows Didn't publish (3) with reasons in words", async ({ page }) => {
  const problems = [
    { productVariantId: 2_001, productId: 200, productName: "Penny Sleeves 001", variantName: "Pack of 25", sku: "PS-1", outcome: "failed" as const,
      code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", message: "eBay refused the listing's price.", retryable: false },
    { productVariantId: 2_002, productId: 200, productName: "Penny Sleeves 001", variantName: "Pack of 50", sku: "PS-2", outcome: "blocked" as const,
      code: "DROPSHIP_LISTING_PREVIEW_BLOCKED", message: "catalog_package_data_required", retryable: false },
    { productVariantId: 2_003, productId: 200, productName: "Penny Sleeves 001", variantName: "Pack of 75", sku: "PS-3", outcome: "price_review" as const,
      code: "DROPSHIP_LISTING_PRICE_AWAITING_REVIEW", message: null, retryable: false },
  ];
  const state = await openCatalog(page, PUBLISH_PATH, { ...selected(10), proofs: { bulk_listing_push: LIVE_PROOF },
    nextRunFrames: [{ status: "partial", counts: { pending: 0, completed: 7, failed: 1, blocked: 1, price_review: 1 }, problems }] });
  await card(page).getByRole("button", { name: "Publish 10 new" }).click();
  const run = runCard(page);
  await expect(run.getByTestId("publish-run-title")).toHaveText("Publishing finished.");
  await expect(run.getByTestId("publish-run-counts")).toHaveText("7 published · 1 not ready · 1 price needs your review · 1 failed");
  await expect(run.getByTestId("publish-run-problems").getByRole("heading")).toHaveText("Didn't publish (3)");
  // Each row: the name and reason, then the next step under it (review round 2 DUX5).
  await expect(run.getByTestId("publish-run-problem-2001")).toHaveText("Penny Sleeves 001 · Pack of 25 · PS-1: eBay refused the listing's price."
    + "Fix what eBay named, then publish again.");
  await expect(run.getByTestId("publish-run-problem-step-2001")).toHaveText("Fix what eBay named, then publish again.");
  await expect(run.getByTestId("publish-run-problem-2002")).toHaveText("Penny Sleeves 001 · Pack of 50 · PS-2: Card Shellz hasn't added this size's package size yet. Contact support."
    + "Fix what's named, then publish again.");
  await expect(run).toHaveAttribute("data-phase", "finishedPartial");
  await expect(run.getByTestId("publish-run-problem-2003")).toContainText("Its price changed after you pressed Publish");
  await expect(run).not.toContainText("DROPSHIP_");
  expectClean(state);
});

test("P7 on a phone the step has no horizontal scroll and Publish and Stop are at least 44 px high", async ({ page }) => {
  const state = await openCatalog(page, PUBLISH_PATH, { ...selected(1_234), proofs: { bulk_listing_push: LIVE_PROOF },
    nextRunFrames: processingFrames(30, 1_234) });
  const publishNew = card(page).getByRole("button", { name: "Publish 1,234 new" });
  for (const button of [publishNew, card(page).getByRole("button", { name: "Publish all 1,234" }), card(page).getByRole("button", { name: "Check listings" })]) {
    expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await publishNew.click();
  const stop = runCard(page).getByRole("button", { name: "Stop publishing" });
  await expect(stop).toBeVisible();
  expect((await stop.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expectClean(state);
});

test("P8 10,001 selected: runTooLarge, both buttons off, nothing sent", async ({ page }) => {
  const state = await openCatalog(page, PUBLISH_PATH, { ...selected(10_001), proofs: { bulk_listing_push: LIVE_PROOF } });
  await expect(card(page).getByTestId("publish-too-large")).toHaveText("More than 10,000 sizes are selected. Remove some in step 1, then publish.");
  await expect(card(page).getByRole("button", { name: "Publish 10,001 new" })).toBeDisabled();
  await expect(card(page).getByRole("button", { name: "Publish all 10,001" })).toBeDisabled();
  await expect(card(page).getByRole("button", { name: "Check listings" })).toBeDisabled();
  expect(state.runCreates).toEqual([]);
  expectClean(state);
});

test("P9 the server's snapshot two short: the card says two were left out", async ({ page }) => {
  const state = await openCatalog(page, PUBLISH_PATH, { ...selected(12), proofs: { bulk_listing_push: LIVE_PROOF }, runSnapshotShort: 2 });
  await card(page).getByRole("button", { name: "Publish 12 new" }).click();
  // "Publish new": both reasons a size can be left out (review round 2 DUX8).
  await expect(runCard(page).getByTestId("publish-run-left-out")).toHaveText("2 of your selected items were left out: already on eBay, or no longer offered by Card Shellz.");
  expect(state.runs[0].view.targetCount).toBe(10);
  expectClean(state);
});

test("P10 a store switch stops the Check: no checkFailed, its results dropped", async ({ page }) => {
  const state = await openCatalog(page, PUBLISH_PATH, { ...selected(1_234), stores: [MARZ, OUTLET] });
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/dropship/listings/preview", async (route) => {
    await held;
    // The page aborts the request it no longer wants; an aborted request has nothing left to answer.
    await route.fallback().catch(() => undefined);
  });
  await card(page).getByRole("button", { name: "Check listings" }).click();
  await expect(card(page).getByTestId("publish-checking")).toContainText("Checking 0 of 1,234…");
  await page.getByTestId("catalog-store-select").click();
  await page.getByRole("option", { name: `${OUTLET.name} (eBay)`, exact: true }).click();
  release();
  await expect(card(page).getByTestId("publish-checking")).toHaveCount(0);
  await expect(card(page).getByTestId("publish-check-failed")).toHaveCount(0);
  await expect(card(page).getByTestId("publish-check-summary")).toHaveCount(0);
  // At most the chunk that was in flight; no chunk after the switch.
  await page.waitForTimeout(1_000);
  expect(state.previewBodies.length).toBeLessThanOrEqual(1);
  await expect(card(page).getByTestId("publish-selected")).toBeVisible();
  expectClean(state);
});

test("P11 everything live: Publish new is hidden and Publish all posts scope all; eBay stopping answering reads as provider down", async ({ page }) => {
  const rows = chooseRowsFixture(4);
  const state = await openCatalog(page, PUBLISH_PATH, { ...selected(4), proofs: { bulk_listing_push: LIVE_PROOF },
    liveVariantIds: { [MARZ.storeConnectionId]: rows.map((fact) => fact.productVariantId) },
    nextRunFrames: [{ status: "failed", stopReason: "provider_unavailable", counts: { pending: 0, completed: 1, failed: 3 } }] });
  await expect(card(page).getByRole("button", { name: "Publish all 4" })).toBeVisible();
  await expect(card(page).getByTestId("publish-new")).toHaveCount(0);
  await expect(card(page).getByTestId("publish-all-hint")).toContainText("Also re-sends the 4 already on eBay.");
  await card(page).getByRole("button", { name: "Publish all 4" }).click();
  // One size done reads "was" (verify VC13, runProviderDown); the plural form is pinned in the words test.
  await expect(runCard(page).getByTestId("publish-run-title"))
    .toHaveText("eBay wasn't answering, so publishing stopped. 1 of 4 was done. Publish again later.");
  expect(state.runCreates[0].body).toMatchObject({ scope: "all" });
  expectClean(state);
});

test("P12 an older dyno answers HTML: the create is sent again with the same key, and the count shows after the summary's retry", async ({ page }) => {
  const state = await openCatalog(page, PUBLISH_PATH, { ...selected(3), proofs: { bulk_listing_push: LIVE_PROOF },
    selectionSummaryAnswers: ["html"], runCreateAnswers: ["html"] });
  // The summary's first answer is the app's HTML: "site updating" while it is read again, then the count.
  await expect(card(page).getByTestId("publish-site-updating")).toHaveText(SITE_UPDATING);
  await expect(card(page).getByRole("button", { name: "Publish 3 new" })).toBeEnabled({ timeout: POLL_TIMEOUT_MS });
  await expect(card(page).getByTestId("publish-site-updating")).toHaveCount(0);

  await card(page).getByRole("button", { name: "Publish 3 new" }).click();
  await expect(runCard(page).getByTestId("publish-run-title")).toHaveText("Publishing finished.", { timeout: POLL_TIMEOUT_MS });
  expect(state.runCreates.map((create) => create.status)).toEqual([200, 202]);
  expect(state.runCreates[1].body).toEqual(state.runCreates[0].body);
  expect(state.runs).toHaveLength(1);
  expectClean(state);
});

test("P25 (review round 1 CLI-2) an older (A) dyno refuses the count for this newer page: site updating while it is read again, then the count", async ({ page }) => {
  // What an A dyno answers clientVersion 2 (plan §4 row 3, §12.6): 503 page_newer_than_server, never the app's HTML.
  const state = await openCatalog(page, PUBLISH_PATH, { ...selected(3), proofs: { bulk_listing_push: LIVE_PROOF },
    selectionSummaryAnswers: [pageNewerThanServerAnswer(), pageNewerThanServerAnswer()] });
  await expect(card(page).getByTestId("publish-site-updating")).toHaveText(SITE_UPDATING);
  await expect(card(page).getByTestId("publish-count-retrying")).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: "Publish 3 new" })).toBeEnabled({ timeout: POLL_TIMEOUT_MS });
  await expect(card(page).getByTestId("publish-site-updating")).toHaveCount(0);
  expect(state.selectionSummaryAnswers).toEqual([]);
  expectClean(state);
});

/** A run this store finished `minutesAgo` minutes ago, already in the stub when the page opens. */
function finishedRun(input: { runId: number; minutesAgo: number; counts: Partial<StubRun["counts"]>; problems: StubRun["problems"]; targets: number }): StubRun {
  const completedAt = new Date(Date.now() - input.minutesAgo * 60_000).toISOString();
  return {
    view: { runId: input.runId, storeConnectionId: MARZ.storeConnectionId, scope: "not_live", status: "partial", stopReason: null,
      selectionRevisionId: 1, targetCount: input.targets, chunkSize: 500, chunkCount: 1, nextChunkIndex: 1, cancelRequestedAt: null,
      createdAt: completedAt, updatedAt: completedAt, completedAt },
    counts: { pending: 0, queued: 0, completed: 0, failed: 0, blocked: 0, skipped: 0, price_review: 0, stale: 0, cancelled: 0, ...input.counts },
    problems: input.problems, waitingUntil: null, drafts: 0, frames: [], key: `finished-${input.runId}`, body: "{}",
  };
}

test("P13 a finished run with sizes that didn't publish shows again after a reload, with each one's reason and step, until hidden (review round 2 DUX1, DUX5)", async ({ page }) => {
  const problems = [{ productVariantId: 2_001, productId: 200, productName: "Penny Sleeves 001", variantName: "Pack of 25", sku: "PS-1",
    outcome: "failed" as const, code: "DROPSHIP_EBAY_MANAGED_LOCATION_CONFIG_MISMATCH",
    message: "Open Listing settings, choose Update now under Shipping policy, then queue the listing again.", retryable: false }];
  const state = await openCatalog(page, PUBLISH_PATH, { ...selected(3), proofs: { bulk_listing_push: LIVE_PROOF },
    runs: [finishedRun({ runId: 77, minutesAgo: 90, targets: 3, counts: { completed: 2, failed: 1 }, problems })] });
  const run = runCard(page);
  await expect(run.getByTestId("publish-run-title")).toHaveText("Publishing finished.");
  await expect(run).toHaveAttribute("data-phase", "finishedPartial");
  await expect(run.getByTestId("publish-run-problems").getByRole("heading")).toHaveText("Didn't publish (1)");
  await expect(run.getByTestId("publish-run-problem-2001")).toContainText("Card Shellz changed the warehouse your listings ship from.");
  await expect(run.getByTestId("publish-run-problem-step-2001")).toHaveText("In Listing settings, choose Update now under Shipping policy, then publish again.");
  await expect(run).not.toContainText("queue");
  await page.reload();
  await expect(runCard(page).getByTestId("publish-run-problem-2001")).toBeVisible();
  await runCard(page).getByRole("button", { name: "Hide" }).click();
  await expect(runCard(page)).toHaveCount(0);
  await page.reload();
  await expect(card(page).getByRole("button", { name: "Publish all 3" })).toBeVisible();
  await expect(runCard(page)).toHaveCount(0);
  // Reading and hiding the card sent nothing (a finished run older than a week, or one with nothing wrong: P22).
  expect(state.runCreates).toEqual([]);
  expectClean(state);
});

test("P14 a paused run says when it goes on, and drafts are counted apart, in amber (review round 2 DUX3)", async ({ page }) => {
  const at = "2026-10-20T15:45:00.000Z";
  const state = await openCatalog(page, PUBLISH_PATH, { ...selected(4), proofs: { bulk_listing_push: LIVE_PROOF },
    nextRunFrames: [{ counts: { pending: 0, queued: 4 }, waitingUntil: at }, { counts: { pending: 0, queued: 4 }, waitingUntil: at },
      { status: "completed", counts: { queued: 0, completed: 4 }, waitingUntil: null, drafts: 4 }] });
  await card(page).getByRole("button", { name: "Publish 4 new" }).click();
  await expect(runCard(page).getByTestId("publish-run-waiting")).toContainText("eBay is busy. Publishing waits and goes on by itself at ");
  await expect(runCard(page).getByTestId("publish-run-title")).toHaveText("Publishing finished.", { timeout: POLL_TIMEOUT_MS });
  await expect(runCard(page)).toHaveAttribute("data-phase", "finishedPartial");
  await expect(runCard(page).getByTestId("publish-run-counts")).toHaveText("4 saved as unpublished drafts");
  await expect(runCard(page).getByTestId("publish-run-drafts")).toContainText("buyers can't see those yet");
  await expect(runCard(page).getByTestId("publish-run-waiting")).toHaveCount(0);
  expectClean(state);
});

test("P15 after Check, View preview reads that size's full preview: its description, no 'not returned' (review round 2 DUX2)", async ({ page }) => {
  const state = await openCatalog(page, PUBLISH_PATH, selected(3));
  await card(page).getByRole("button", { name: "Check listings" }).click();
  await expect(card(page).getByTestId("publish-check-summary")).toHaveText("Checked 3: 3 ready · 0 with warnings · 0 not ready");
  const checks = state.previewBodies.length;
  await card(page).getByRole("button", { name: /^View preview for / }).first().click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText("Holds one card in a rigid sleeve.")).toBeVisible();
  await expect(sheet).not.toContainText("Detailed content was not returned");
  await expect(sheet).toContainText("doesn't publish anything");
  // One more preview, of that one size.
  expect(state.previewBodies.slice(checks).map((body) => body.productVariantIds.length)).toEqual([1]);
  expect(state.runCreates).toEqual([]);
  expectClean(state);
});

test("P16 a proof whose method changed (passkey added elsewhere) asks for a new one instead of repeating the refusal (review round 2 CT4)", async ({ page }) => {
  const state = await openCatalog(page, PUBLISH_PATH, { ...selected(3), proofs: { bulk_listing_push: LIVE_PROOF },
    runCreateAnswers: [{ status: 403, code: "DROPSHIP_STEP_UP_METHOD_REQUIRED", message: "A passkey is required for this action." }] });
  const authReads = () => state.reads.filter((read) => read.path === "/api/dropship/auth/me").length;
  const before = authReads();
  await card(page).getByRole("button", { name: "Publish 3 new" }).click();
  await expect(card(page).getByTestId("publish-error")).toHaveText("Your verification expired before publishing started. Press Publish again to verify.");
  await expect.poll(authReads).toBeGreaterThan(before);
  expect(state.runCreates.map((create) => create.status)).toEqual([403]);
  expectClean(state);
});

const NOT_CONFIRMED = "We couldn't confirm that publishing started. Press Publish again; it won't publish anything twice.";
const OLDER_PROBLEMS: StubRun["problems"] = [{ productVariantId: 2_001, productId: 200, productName: "Penny Sleeves 001", variantName: "Pack of 25",
  sku: "PS-1", outcome: "failed", code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", message: "eBay refused the listing's price.", retryable: false }];

test("P17 every create try unanswered: notConfirmed, nothing shown, and the next press sends the same key (verify VC7)", async ({ page }) => {
  const state = await openCatalog(page, PUBLISH_PATH, { ...selected(3), proofs: { bulk_listing_push: LIVE_PROOF },
    runCreateAnswers: ["html", "html", "html"] });
  await card(page).getByRole("button", { name: "Publish 3 new" }).click();
  await expect(card(page).getByTestId("publish-error")).toHaveText(NOT_CONFIRMED);
  expect(state.runs).toEqual([]);
  await expect(runCard(page)).toHaveCount(0);
  await card(page).getByRole("button", { name: "Publish 3 new" }).click();
  await expect(runCard(page)).toHaveAttribute("data-run-id", "41");
  const keys = state.runCreates.map((create) => create.body.idempotencyKey);
  expect(keys).toHaveLength(4);
  expect(new Set(keys).size).toBe(1);
  expect(state.runs).toHaveLength(1);
  expectClean(state);
});

test("P18 a lost create while an older run's card is shown: the run the press made replaces it, and nothing else is sent (verify VC1)", async ({ page }) => {
  const state = await openCatalog(page, PUBLISH_PATH, { ...selected(3), proofs: { bulk_listing_push: LIVE_PROOF },
    runs: [finishedRun({ runId: 7, minutesAgo: 90, targets: 3, counts: { completed: 2, failed: 1 }, problems: OLDER_PROBLEMS })],
    // Try 1 makes the run and its answer is lost; tries 2 and 3 reach an older dyno (HTML).
    runCreateAnswers: ["drop", "html", "html"],
    nextRunFrames: Array.from({ length: 40 }, () => ({ counts: { pending: 0, queued: 3 } })) });
  await expect(runCard(page)).toHaveAttribute("data-run-id", "7");
  await card(page).getByRole("button", { name: "Publish 3 new" }).click();
  await expect(card(page).getByTestId("publish-error")).toHaveText(NOT_CONFIRMED);
  // The store's newest run is the one the lost answer made: its card replaces the older one and is followed.
  await expect(runCard(page)).toHaveAttribute("data-run-id", "41");
  await expect(runCard(page).getByTestId("publish-run-title")).toHaveText("Publishing to Marz Cards: 0 of 3 done");
  await expect.poll(() => state.runDetailReads.filter((id) => id === 41).length).toBeGreaterThan(0);
  await expect(card(page).getByRole("button", { name: "Publish 3 new" })).toBeDisabled();
  expect(state.runCreates.map((create) => create.status)).toEqual([0, 200, 200]);
  expect(state.runs.map((run) => run.view.runId)).toEqual([7, 41]);
  expectClean(state);
});

test("P19 hiding the run this page started never brings back an older run's problems (verify VC2)", async ({ page }) => {
  const state = await openCatalog(page, PUBLISH_PATH, { ...selected(3), proofs: { bulk_listing_push: LIVE_PROOF },
    runs: [finishedRun({ runId: 7, minutesAgo: 90, targets: 3, counts: { completed: 2, failed: 1 }, problems: OLDER_PROBLEMS })],
    nextRunFrames: [{ status: "completed", counts: { pending: 0, queued: 0, completed: 3 } }] });
  await expect(runCard(page)).toHaveAttribute("data-run-id", "7");
  await card(page).getByRole("button", { name: "Publish 3 new" }).click();
  await expect(runCard(page)).toHaveAttribute("data-run-id", "41");
  await expect(runCard(page).getByTestId("publish-run-title")).toHaveText("Publishing finished.");
  await expect(runCard(page)).toHaveAttribute("data-phase", "finished");
  await runCard(page).getByRole("button", { name: "Hide" }).click();
  await expect(runCard(page)).toHaveCount(0);
  // Not after a moment, and not after a reload: the newest run finished clean.
  await page.waitForTimeout(1_500);
  await expect(runCard(page)).toHaveCount(0);
  await page.reload();
  await expect(card(page).getByRole("button", { name: "Publish all 3" })).toBeVisible();
  await expect(runCard(page)).toHaveCount(0);
  expectClean(state);
});

test("P20 too many presses in a minute: the server's words, one send only, and the next press keeps the key (verify VC6)", async ({ page }) => {
  const state = await openCatalog(page, PUBLISH_PATH, { ...selected(3), proofs: { bulk_listing_push: LIVE_PROOF },
    runCreateAnswers: [{ status: 429, code: "DROPSHIP_LISTING_PUSH_RUN_RATE_LIMITED", message: "Too many publish requests in a minute. Wait a moment and try again." }] });
  await card(page).getByRole("button", { name: "Publish 3 new" }).click();
  await expect(card(page).getByTestId("publish-error")).toHaveText("Too many publish requests in a minute. Wait a moment and try again.");
  expect(state.runCreates.map((create) => create.status)).toEqual([429]);
  await card(page).getByRole("button", { name: "Publish 3 new" }).click();
  await expect(runCard(page)).toHaveAttribute("data-run-id", "41");
  expect(state.runCreates.map((create) => create.body.idempotencyKey)).toEqual(Array(2).fill(state.runCreates[0].body.idempotencyKey));
  expectClean(state);
});

function failedProblem(id: number): StubRun["problems"][number] {
  return { productVariantId: id, productId: 200, productName: `Sleeve ${id}`, variantName: "Pack", sku: `S-${id}`, outcome: "failed",
    code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", message: "eBay refused it.", retryable: false };
}

test("P21 Show more while the run goes on: a lower-id problem arriving later moves the first page, and no row falls between (verify VC3)", async ({ page }) => {
  const first = Array.from({ length: 60 }, (_, index) => failedProblem(1_001 + index));
  const later = [failedProblem(1_000), ...first];
  const frameA: StubRunFrame = { counts: { pending: 0, queued: 100, failed: 60 }, problems: first };
  const frameB: StubRunFrame = { counts: { pending: 0, queued: 99, failed: 61 }, problems: later };
  const state = await openCatalog(page, PUBLISH_PATH, { ...selected(200), proofs: { bulk_listing_push: LIVE_PROOF },
    nextRunFrames: [frameA, frameA, frameB, frameB] });
  await card(page).getByRole("button", { name: "Publish 200 new" }).click();
  await expect(runCard(page).getByTestId("publish-run-problems")).toContainText("Didn't publish (60)");
  await runCard(page).getByRole("button", { name: "Show more" }).click();
  await expect(runCard(page).getByTestId("publish-run-problem-1060")).toBeVisible();
  // The next poll: problem 1000 joins the first page, which now ends at 1049; the rows read after 1050 are dropped.
  await expect(runCard(page).getByTestId("publish-run-problems")).toContainText("Didn't publish (61)", { timeout: POLL_TIMEOUT_MS });
  await expect(runCard(page).getByTestId("publish-run-problem-1000")).toBeVisible();
  await expect(runCard(page).getByTestId("publish-run-problem-1060")).toHaveCount(0);
  await runCard(page).getByRole("button", { name: "Show more" }).click();
  await expect(runCard(page).getByTestId("publish-run-problem-1050")).toBeVisible();
  await expect(runCard(page).getByTestId("publish-run-problem-1060")).toBeVisible();
  await expect(runCard(page).locator("li")).toHaveCount(61);
  await expect(runCard(page).getByRole("button", { name: "Show more" })).toHaveCount(0);
  expectClean(state);
});

test("P22 a finished run older than a week, or one with nothing wrong, is not shown again by itself (verify VC14)", async ({ page }) => {
  const old = await openCatalog(page, PUBLISH_PATH, { ...selected(3),
    runs: [finishedRun({ runId: 7, minutesAgo: 8 * 24 * 60, targets: 3, counts: { completed: 2, failed: 1 }, problems: OLDER_PROBLEMS })] });
  await expect(card(page).getByRole("button", { name: "Publish 3 new" })).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(runCard(page)).toHaveCount(0);
  expect(old.runDetailReads).toEqual([]);
  expectClean(old);
});

test("P23 a run that left nothing wrong is not shown again by itself (verify VC14)", async ({ page }) => {
  const clean = await openCatalog(page, PUBLISH_PATH, { ...selected(3),
    runs: [finishedRun({ runId: 7, minutesAgo: 30, targets: 3, counts: { completed: 2, skipped: 1 }, problems: [] })] });
  await expect(card(page).getByRole("button", { name: "Publish 3 new" })).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(runCard(page)).toHaveCount(0);
  expect(clean.runDetailReads).toEqual([]);
  expectClean(clean);
});

const RETIRED = "This page was updated, so your last changes weren't saved. Reload it and make them again.";
const SECOND_SIZE: ChooseRowFact = { ...ROW_FACT, productVariantId: 102, variantName: "Pack of 100", variantSku: "ENV-SGL-P100", stock: 40 };

test("P24 step 1's 410 'page was updated': Reload reloads at once, without the browser asking again (verify VC10)", async ({ page }) => {
  // PR B's page saves through `/selection/changes`; the 410 is what a page older than the server is told (§4.9 item 2).
  const state = await openCatalog(page, `${CATALOG_PATH}/choose`, { chooseRows: [ROW_FACT, SECOND_SIZE],
    changeAnswers: [{ status: 410, code: "DROPSHIP_SELECTION_RULES_RETIRED", message: RETIRED }] });
  await page.getByRole("checkbox", { name: "Select Envelope Single Pocket, Pack of 100", exact: true }).check();
  await page.getByTestId("catalog-choose-bar").getByRole("button", { name: "Save changes" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByTestId("catalog-choose-error")).toHaveText(RETIRED);
  expect(state.changeCalls.map((call) => call.status)).toEqual([410]);
  // A stage 1 tab still open saves through the frozen rules route: the same 410 and words, before any write (V10, §8.4).
  const olderTab = await page.evaluate(async () => {
    const response = await fetch("/api/dropship/catalog/selection-rules", { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "catalog-selection:older-tab", rules: [] }) });
    return { status: response.status, body: await response.json() as { error?: { code?: string; message?: string } } };
  });
  expect(olderTab).toEqual({ status: 410, body: { error: { code: "DROPSHIP_SELECTION_RULES_RETIRED", message: RETIRED,
    context: { retryable: false, classification: "permanent" } } } });
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.type()); void dialog.dismiss(); });
  await Promise.all([page.waitForEvent("load"), page.getByTestId("catalog-choose-reload").click()]);
  // The page was read again from scratch: the mark that could not be saved is gone, and nothing asked first.
  await expect(page.getByRole("checkbox", { name: "Select Envelope Single Pocket, Pack of 100", exact: true })).not.toBeChecked();
  await expect(page.getByTestId("catalog-choose-error")).toHaveCount(0);
  expect(dialogs).toEqual([]);
  expect(state.errors).toEqual([]);
});
