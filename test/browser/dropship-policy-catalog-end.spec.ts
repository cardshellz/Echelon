import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  CATALOG_PATH,
  LIVE_PROOF,
  MARZ,
  OUTLET,
  ROW_FACT,
  SHOP,
  openCatalog,
  pageNewerThanServerAnswer,
  step,
  stubListingId,
  type ChooseRowFact,
  type StoreFixture,
  type StubListingEnd,
  type StubState,
} from "./dropship-policy-catalog-stubs";

// Playwright's serviceWorkers:block init script reads navigator.serviceWorker in
// every frame, which throws in an opaque sandbox. This local-only harness
// registers no workers.
test.use({ serviceWorkers: "allow" });

/**
 * Catalog step 1 ends eBay listings (step 1 plan S2-5, PR C; PLAN-C v4.1 §4, §11, §13.4 E1-E5, E7-E9): unchecking a
 * size that is listed on a vendor's eBay store ends that listing; unchecking the last size of a product the vendor can
 * see ends the product's other listings too and takes its hidden picks with it. The question counts the listings per
 * store, its button says how many it ends, the saved line says they are being ended, and a save never ends more than
 * the vendor confirmed. The stub plans every preview and save with the server's own end decision, hashes and drift
 * rule (dropship-policy-catalog-stubs.ts), and records the end requests a save writes; no end worker runs in it, so an
 * end stays `pending` unless a journey seeds another state. E6 (the staff section) is not a browser journey: no
 * harness mounts the admin page (TST-1); its two client tests cover it.
 */

const CHOOSE_PATH = `${CATALOG_PATH}/choose`;

/** A second size of ROW's product (101), listed in step 1. */
const SECOND: ChooseRowFact = { ...ROW_FACT, productVariantId: 102, variantName: "Pack of 100", variantSku: "ENV-SGL-P100", stock: 40 };
/** A third size of the product that Card Shellz isn't offering now: step 1 does not list it (a hidden pick, §4.3). */
const HIDDEN: ChooseRowFact = { ...ROW_FACT, productVariantId: 105, variantName: "Pack of 200", variantSku: "ENV-SGL-P200", stock: 0 };

// PLAN-C v4.1 §11's words, as the page prints them (client/src/lib/dropship-catalog-choose-words.ts).
const CONFIRM_SCOPE = "Your choice applies to all your stores.";
const EFFECTS_CHANGED = "Something on eBay changed while you were deciding. Check the new numbers and save again.";
const PAUSED = "Saving is paused for a few minutes while Card Shellz updates the site. Your changes are kept, and saving will try again by itself.";
const TOO_MANY_REMOVED = "That's too many items to change at once. Remove fewer products in one save.";
/** A save sent again on the paused schedule waits 2 s first (§12.4): room for it and the answer. */
const RETRY_TIMEOUT_MS = 20_000;
/** A run poll is every 3 s for the first 2 minutes (runPollDelayMs); a few polls fit in this. */
const POLL_TIMEOUT_MS = 15_000;

function confirmEnd(store: string, n: number): string {
  return `On ${store}: ${n === 1 ? "1 eBay listing" : `${n} eBay listings`} will be ended. To sell one again later, choose it here and publish it in step 3.`;
}

function row(page: Page, productVariantId: number) {
  return page.getByTestId(`catalog-choose-row-${productVariantId}`);
}

function box(page: Page, name: string) {
  return page.getByRole("checkbox", { name, exact: true });
}

function status(page: Page) {
  return page.getByTestId("catalog-choose-status");
}

function saveButton(page: Page) {
  return page.getByTestId("catalog-choose-bar").getByRole("button", { name: "Save changes" });
}

/** The save question's lines, in order (describeChooseConfirm). */
function confirmLines(page: Page) {
  return page.getByTestId("catalog-choose-confirm").locator("p");
}

function dialog(page: Page) {
  return page.getByRole("alertdialog");
}

/** The question's own button, by its words (describeChooseConfirmButton), pressed; the question closes. */
async function confirmWith(page: Page, button: string) {
  await dialog(page).getByRole("button", { name: button, exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
}

/** A store's listing id in the stub, as the answers and the echo name it. */
function listingId(store: StoreFixture, productVariantId: number): number {
  return stubListingId(store.storeConnectionId, productVariantId);
}

/** An end request the stub holds, as a journey seeds or reads it. */
function end(store: StoreFixture, productVariantId: number, state: StubListingEnd["state"], id: number, reason: StubListingEnd["reason"] = "size_removed"): StubListingEnd {
  return { id, storeConnectionId: store.storeConnectionId, productVariantId, productId: ROW_FACT.productId, reason, state };
}

function expectClean(state: StubState) {
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
}

/** On a phone, the question's buttons stay on the page: nothing scrolls sideways. */
async function expectNoSideScroll(page: Page, testInfo: TestInfo) {
  const width = page.viewportSize()?.width ?? (testInfo.project.name === "mobile" ? 390 : 1280);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

test("E1 unchecking one of two live sizes ends that size's own eBay listing: the question, its button and the saved line say so; the kept size stays picked", async ({ page }, testInfo) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], picks: new Set([101, 102]),
    liveVariantIds: { [MARZ.storeConnectionId]: [101, 102] } });
  await box(page, "Select Envelope Single Pocket, Pack of 100").uncheck();
  await expect(status(page)).toHaveText("Not saved: 0 to add · 1 to remove");

  await saveButton(page).click();
  await expect(confirmLines(page)).toHaveText(["0 added · 1 removed", confirmEnd("Marz Cards", 1), CONFIRM_SCOPE]);
  await expect(confirmLines(page).nth(1)).toHaveText(/^On Marz Cards: 1 eBay listing will be ended\./);
  // The button names what it ends, in place of B's "Save changes" (PLAN-C v4.1 §11 saveEndButton).
  await expect(dialog(page).getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);
  await expectNoSideScroll(page, testInfo);
  await confirmWith(page, "End 1 listing and save");
  await expect(status(page)).toHaveText("Saved. 0 added, 1 removed. 1 eBay listing is being ended.");

  // The save echoed exactly the listing the question counted, bound to its hash (§4.6), and the stub wrote its end.
  expect(state.changeCalls).toHaveLength(1);
  expect(state.changeCalls[0].body).toMatchObject({ remove: { productVariantIds: [102] },
    expectedEnds: { listingIds: [listingId(MARZ, 102)], hiddenRemovedIds: [] }, expectedOtherEntriesHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(state.listingEnds).toEqual([end(MARZ, 102, "pending", 701)]);
  // Each size is its own listing (P1): the kept size is not ended and stays picked.
  expect([...state.picks]).toEqual([101]);
  await expect(row(page, 101)).toContainText("Picked by you");
  await expect(row(page, 102)).toContainText("Not selected");
  expectClean(state);
});

test("E2 unchecking the last size you can see of a product ends every listing of it, the earlier-removed and hidden sizes' too, and takes the hidden pick", async ({ page }, testInfo) => {
  // 101 is the only visible pick; 102 was removed earlier (its listing at quantity 0); 105 is a hidden pick.
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], hiddenRows: [HIDDEN], picks: new Set([101, 105]),
    liveVariantIds: { [MARZ.storeConnectionId]: [101, 102, 105] } });
  await box(page, "Select Envelope Single Pocket, Pack of 50").uncheck();

  await saveButton(page).click();
  await expect(confirmLines(page)).toHaveText([
    "0 added · 1 removed",
    confirmEnd("Marz Cards", 3),
    "2 of these are listings of other sizes of products you removed completely: sizes you removed earlier, or that Card Shellz isn't offering now.",
    "Removing every size you can see of a product also removes 1 of its sizes that Card Shellz isn't offering right now.",
    CONFIRM_SCOPE,
  ]);
  await expectNoSideScroll(page, testInfo);
  await confirmWith(page, "End 3 listings and save");
  await expect(status(page)).toHaveText("Saved. 0 added, 1 removed. 3 eBay listings are being ended.");

  expect(state.changeCalls[0].body).toMatchObject({ remove: { productVariantIds: [101] },
    expectedEnds: { listingIds: [listingId(MARZ, 101), listingId(MARZ, 102), listingId(MARZ, 105)], hiddenRemovedIds: [105] } });
  expect(state.listingEnds).toEqual([end(MARZ, 101, "pending", 701), end(MARZ, 102, "pending", 702, "product_removed"),
    end(MARZ, 105, "pending", 703, "product_removed")]);
  // The hidden pick went with its product (removed in the same picks delete, §4.7 step 8).
  expect(state.picks.size).toBe(0);
  await expect(row(page, 101)).toContainText("Not selected");
  await expect(row(page, 105)).toHaveCount(0);
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("0 selected");
  expectClean(state);
});

test("E3 re-checking a size whose end is still pending takes the end back: no end line, its quantity comes back, and the end is superseded", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], picks: new Set([101]),
    liveVariantIds: { [MARZ.storeConnectionId]: [101, 102] }, listingEnds: [end(MARZ, 102, "pending", 740)] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();

  await saveButton(page).click();
  await expect(confirmLines(page)).toHaveText(["1 added · 0 removed",
    "On Marz Cards: 1 listing gets its quantity back shortly after you save, at the price it has on eBay now. To send today's price, publish it in step 3.",
    CONFIRM_SCOPE]);
  await expect(confirmLines(page).filter({ hasText: /ended/ })).toHaveCount(0);
  await confirmWith(page, "Save changes");
  await expect(status(page)).toHaveText("Saved. 1 added, 0 removed.");

  expect(state.changeCalls[0].body).toMatchObject({ add: { productVariantIds: [102] }, expectedEnds: { listingIds: [], hiddenRemovedIds: [] } });
  // The save's step 9a (§4.7): a pending end the vendor takes back is superseded, and nothing new is ended.
  expect(state.listingEnds).toEqual([end(MARZ, 102, "superseded", 740)]);
  expect([...state.picks].sort()).toEqual([101, 102]);
  expectClean(state);
});

test("E4 re-picking a size whose listing is still being ended says so; the save never stops the end, and step 3's publish shows it wasn't published", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], picks: new Set([101]), proofs: { bulk_listing_push: LIVE_PROOF },
    liveVariantIds: { [MARZ.storeConnectionId]: [102] }, listingEnds: [end(MARZ, 102, "ending", 741)] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();

  await saveButton(page).click();
  await expect(confirmLines(page)).toHaveText(["1 added · 0 removed",
    "1 of the items you're adding is still being ended on eBay. When that's done, publish it again in step 3.", CONFIRM_SCOPE]);
  await confirmWith(page, "Save changes");
  await expect(status(page)).toHaveText("Saved. 1 added, 0 removed.");
  // An `ending` end is never touched by a save (D20): it finishes.
  expect(state.listingEnds).toEqual([end(MARZ, 102, "ending", 741)]);

  // Step 3: the push fence blocks the size before eBay (§6.2), and the run says why in the vendor's words.
  await step(page, "publish").click();
  const card = page.getByTestId("publish-step");
  await card.getByRole("button", { name: "Publish all 2" }).click();
  const run = page.getByTestId("publish-run-card");
  await expect(run.getByTestId("publish-run-title")).toHaveText("Publishing finished.", { timeout: POLL_TIMEOUT_MS });
  await expect(run.getByTestId("publish-run-counts")).toHaveText("1 published · 1 not ready");
  await expect(run.getByTestId("publish-run-problems").getByRole("heading")).toHaveText("Didn't publish (1)");
  await expect(run.getByTestId("publish-run-problem-102")).toHaveText("Envelope Single Pocket · Pack of 100 · ENV-SGL-P100: "
    + "This listing is being ended on eBay, so it wasn't published.Publish it again after it has ended.");
  await expect(run.getByTestId("publish-run-problem-step-102")).toHaveText("Publish it again after it has ended.");
  await expect(run).not.toContainText("DROPSHIP_");
  expect(state.runCreates[0].body).toMatchObject({ scope: "all" });
  expectClean(state);
});

test("E5a one more end between the question and the save: the save is refused, the question asks again with the new count, and saves with a new key", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { stores: [MARZ, OUTLET], chooseRows: [ROW_FACT, SECOND], picks: new Set([101, 102]),
    liveVariantIds: { [MARZ.storeConnectionId]: [102] },
    // While the vendor reads the question, the size is listed on the second store too.
    afterChangePreview: [(stub) => { stub.liveVariantIds = { [MARZ.storeConnectionId]: [102], [OUTLET.storeConnectionId]: [102] }; }] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").uncheck();
  await saveButton(page).click();
  await expect(confirmLines(page)).toHaveText(["0 added · 1 removed", confirmEnd("Marz Cards", 1), CONFIRM_SCOPE]);
  await dialog(page).getByRole("button", { name: "End 1 listing and save", exact: true }).click();

  // Never more than confirmed (D41): the save is refused and the question comes back with both listings.
  await expect(confirmLines(page)).toHaveText([EFFECTS_CHANGED, "0 added · 1 removed", confirmEnd("Marz Cards", 1),
    confirmEnd("Marz Cards Outlet", 1), CONFIRM_SCOPE]);
  await confirmWith(page, "End 2 listings and save");
  await expect(status(page)).toHaveText("Saved. 0 added, 1 removed. 2 eBay listings are being ended.");

  expect(state.changeCalls.map((call) => call.status)).toEqual([409, 201]);
  expect(state.changeCalls[1].key).not.toBe(state.changeCalls[0].key);
  expect(state.changeCalls[0].body).toMatchObject({ expectedEnds: { listingIds: [listingId(MARZ, 102)], hiddenRemovedIds: [] } });
  expect(state.changeCalls[1].body).toMatchObject({ expectedEnds: { listingIds: [listingId(MARZ, 102), listingId(OUTLET, 102)], hiddenRemovedIds: [] } });
  expect(state.listingEnds).toEqual([end(MARZ, 102, "pending", 701), end(OUTLET, 102, "pending", 702)]);
  expectClean(state);
});

test("E5b one fewer end between the question and the save: it saves at once and says what changed and what is being ended", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { stores: [MARZ, OUTLET], chooseRows: [ROW_FACT, SECOND], picks: new Set([101, 102]),
    liveVariantIds: { [MARZ.storeConnectionId]: [102], [OUTLET.storeConnectionId]: [102] },
    // While the vendor reads the question, the vendor's own end on the second store comes in from eBay (sync-back).
    afterChangePreview: [(stub) => { stub.endedVariantIds = { [OUTLET.storeConnectionId]: [102] }; }] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").uncheck();
  await saveButton(page).click();
  await expect(confirmLines(page)).toHaveText(["0 added · 1 removed", confirmEnd("Marz Cards", 1), confirmEnd("Marz Cards Outlet", 1),
    CONFIRM_SCOPE]);
  await confirmWith(page, "End 2 listings and save");

  // Fewer than confirmed goes through (D41), and the drift line counts the end (FID-14).
  await expect(status(page)).toHaveText(
    "Saved. A few listings changed on eBay while you were deciding; 1 listing is set to quantity 0. 1 eBay listing is being ended.");
  expect(state.changePreviews).toHaveLength(1);
  expect(state.changeCalls.map((call) => call.status)).toEqual([201]);
  expect(state.listingEnds).toEqual([end(MARZ, 102, "pending", 701)]);
  expectClean(state);
});

test("E7 an eBay store and a Shopify store: the eBay listing is ended, the Shopify one is set to quantity 0", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { stores: [MARZ, SHOP], chooseRows: [ROW_FACT, SECOND], picks: new Set([101, 102]),
    liveVariantIds: { [MARZ.storeConnectionId]: [102], [SHOP.storeConnectionId]: [102] } });
  await box(page, "Select Envelope Single Pocket, Pack of 100").uncheck();
  await saveButton(page).click();
  // Stores in the server's order (ascending): Test Shop (3), then Marz Cards (5).
  await expect(confirmLines(page)).toHaveText(["0 added · 1 removed", "On Test Shop: 1 listing is set to quantity 0, so buyers can't buy it.",
    confirmEnd("Marz Cards", 1), CONFIRM_SCOPE]);
  await confirmWith(page, "End 1 listing and save");
  await expect(status(page)).toHaveText("Saved. 0 added, 1 removed. 1 eBay listing is being ended.");
  // Shopify stores keep quantity 0 (D18): no end request on them.
  expect(state.listingEnds).toEqual([end(MARZ, 102, "pending", 701)]);
  expectClean(state);
});

test("E7b an eBay store that can't be used now: its listings will be ended when it can, and stay at quantity 0 until then", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], picks: new Set([101, 102]),
    storeStatuses: { [MARZ.storeConnectionId]: "needs_reauth" }, liveVariantIds: { [MARZ.storeConnectionId]: [102] } });
  await box(page, "Select Envelope Single Pocket, Pack of 100").uncheck();
  await saveButton(page).click();
  await expect(confirmLines(page)).toHaveText(["0 added · 1 removed",
    "On Marz Cards: 1 eBay listing will be ended when the store can be used again. It stays at quantity 0 until then.", CONFIRM_SCOPE]);
  await confirmWith(page, "End 1 listing and save");
  await expect(status(page)).toHaveText("Saved. 0 added, 1 removed. 1 eBay listing is being ended.");
  expect(state.listingEnds).toEqual([end(MARZ, 102, "pending", 701)]);
  expectClean(state);
});

test("E8 an older server answers the save 503 once: the page says saving is paused, sends the same save again, and it saves once", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], picks: new Set([101, 102]),
    liveVariantIds: { [MARZ.storeConnectionId]: [102] }, changeAnswers: [pageNewerThanServerAnswer()] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").uncheck();
  await saveButton(page).click();
  await confirmWith(page, "End 1 listing and save");
  // A 503 writes-paused (here: page_newer_than_server) is the paused schedule (classifyChooseSaveError), not busy.
  await expect(page.getByTestId("catalog-choose-progress")).toHaveText(PAUSED);
  await expect(status(page)).toHaveText("Saved. 0 added, 1 removed. 1 eBay listing is being ended.", { timeout: RETRY_TIMEOUT_MS });

  expect(state.changeCalls.map((call) => call.status)).toEqual([503, 201]);
  expect(state.changeCalls[1].key).toBe(state.changeCalls[0].key);
  expect(state.changeCalls[1].body).toEqual(state.changeCalls[0].body);
  expect(state.listingEnds).toEqual([end(MARZ, 102, "pending", 701)]);
  expectClean(state);
});

test("E9 a removal too large to save at once says so in its own words, never the over-cap words, and writes nothing; the preview's refusal the same", async ({ page }) => {
  const tooLarge = { status: 422, code: "DROPSHIP_SELECTION_REMOVAL_TOO_LARGE", message: TOO_MANY_REMOVED,
    context: { factSizes: 30_001, limit: 30_000, classification: "permanent", retryable: false } };
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], picks: new Set([101, 102]),
    liveVariantIds: { [MARZ.storeConnectionId]: [102] }, changeAnswers: [tooLarge] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").uncheck();
  await saveButton(page).click();
  await confirmWith(page, "End 1 listing and save");
  await expect(page.getByTestId("catalog-choose-error")).toHaveText(TOO_MANY_REMOVED);
  await expect(page.getByTestId("catalog-choose-bar")).not.toContainText("Undo some additions");
  // The change is kept and nothing was saved.
  await expect(status(page)).toHaveText("Not saved: 0 to add · 1 to remove");
  expect(state.changeCalls.map((call) => call.status)).toEqual([422]);
  expect(state.listingEnds).toEqual([]);
  expect([...state.picks].sort()).toEqual([101, 102]);
  // The change is kept: the vendor can remove fewer and save again.
  await expect(row(page, 102)).toHaveAttribute("data-changed", "remove");

  // The preview answers the same 422 for the next press: the same words, and no question.
  state.changePreviewAnswers.push(tooLarge);
  await saveButton(page).click();
  await expect.poll(() => state.changePreviews.map((call) => call.status)).toEqual([200, 422]);
  await expect(page.getByTestId("catalog-choose-error")).toHaveText(TOO_MANY_REMOVED);
  await expect(dialog(page)).toHaveCount(0);
  expect(state.changeCalls).toHaveLength(1);
  expectClean(state);
});
