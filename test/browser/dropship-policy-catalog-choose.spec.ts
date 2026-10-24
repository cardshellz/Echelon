import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  CATALOG_PATH,
  MARZ,
  OUTLET,
  READ_FAILURES_UNTIL_GIVE_UP,
  ROW,
  ROW_FACT,
  SLOW_SELECTION_SAVE_MS,
  TOPLOADERS_CATEGORY_ID,
  catalogReadFailuresFor,
  chooseRowsFixture,
  openCatalog,
  pageNewerThanServerAnswer,
  saveFromAnotherTab,
  step,
  serveAppQueryClient,
  type ChooseRowFact,
  type StubState,
} from "./dropship-policy-catalog-stubs";

// Playwright's serviceWorkers:block init script reads navigator.serviceWorker in
// every frame, which throws in an opaque sandbox. This local-only harness
// registers no workers.
test.use({ serviceWorkers: "allow" });

/**
 * Catalog step 1, "The checkbox is the choice", on one-time picks (stage 1's journeys, moved to PR B's save; PLAN-B
 * v4.1 §12, §15.4, V28): checking marks a change, one "Save changes" previews every add and remove, asks with the
 * server's counts, then sends them in one `POST …/selection/changes`, and nothing is sent before. The stub evaluates
 * every row from the vendor's picks with the server's own evaluator and answers the preview and the save as the
 * routes do, parsing every body with the server's schemas (dropship-policy-catalog-stubs.ts). Stage 1's journeys
 * whose subject PR B deleted (J3, J10, J25, J26) are gone; BUILD-NOTES "## B2c" names each one's replacement. J17's
 * and J22's subject (an unsure save, then Undo, shows the truth) is back as J28-J31 (review round 1 TST-2).
 */

const CHOOSE_PATH = `${CATALOG_PATH}/choose`;
const CHANGES_PATH = "/api/dropship/catalog/selection/changes";

/** A second size of ROW's product, not chosen. */
const SECOND: ChooseRowFact = { ...ROW_FACT, productVariantId: 102, variantName: "Pack of 100", variantSku: "ENV-SGL-P100", stock: 40 };
/** Another product, in another category, not chosen. */
const TOPLOADER: ChooseRowFact = { ...ROW_FACT, productId: 12, productVariantId: 103, productName: "Toploader 35pt", productSku: "TL-35",
  variantName: "Pack of 25", variantSku: "TL-35-25", category: "Toploaders", categoryId: TOPLOADERS_CATEGORY_ID, stock: 9 };

const CONFIRM_NONE = "Nothing changes on your eBay listings now.";
const CONFIRM_NOT_ENDED = "Removed items are set to quantity 0 on eBay. Their listings aren't ended.";
const CONFIRM_SCOPE = "Your choice applies to all your stores.";
const STALE = "Your saved choices changed after this page loaded. Review them and save again.";
const SAVING_STILL = "Still saving… eBay updates are in progress. Your changes are kept.";
const UNCONFIRMED = "We couldn't confirm your save. Press Save changes again to check whether it went through.";
const LIST_BEHIND = "The list couldn't be refreshed after the last save, so it may not show what is saved. Press Try again.";
const UNDONE_SAVE_MOVED = "Your saved choices changed: your last save may have gone through, or another tab saved.";
const SITE_UPDATING = "Card Shellz is updating the site. This page will try again in a moment; nothing you did is lost.";
/** Two older-dyno answers, each retried 3 s later (retryPublishRead), then the read lands: room to see the line and its end. */
const OLDER_SERVER_TIMEOUT_MS = 20_000;
const TURNED_OFF_PICK_HINT = "You picked it, but it can't be sold now. Uncheck it to remove your pick.";
/** A read that gives up after step 1's retries of a 500 (three, 3 s apart: retryPublishRead), with room to draw. */
const GIVE_UP_TIMEOUT_MS = 25_000;

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

/** Save changes, then the question's own Save changes. */
async function saveAndConfirm(page: Page) {
  await saveButton(page).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Save your changes?");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toHaveCount(0);
}

/** The body the page sends for a change: ids ascending, the revision it counted from, this page's version (§12.4, §12.6). */
function changeBody(expectedRevisionId: number | null, add: number[], remove: number[]) {
  return { clientVersion: 2, expectedRevisionId, add: { productVariantIds: add }, remove: { productVariantIds: remove } };
}

function expectClean(state: StubState) {
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
  // PR B's page never reads or writes the frozen rules (V25).
  expect(state.reads.filter((read) => read.path === "/api/dropship/catalog/selection-rules")).toEqual([]);
}

/** Picks a Show option. */
async function showOption(page: Page, name: "All" | "Saved as selected") {
  await page.getByTestId("catalog-choose-show").click();
  await page.getByRole("option", { name, exact: true }).click();
}

/** The step's list reads (not step 3's selected list, not an id read), as their query strings. */
function listReads(state: StubState): string[] {
  return state.reads.filter((read) => read.path === "/api/dropship/catalog" && !read.search.includes("selectedOnly")
    && !read.search.includes("idsOnly")).map((read) => read.search);
}

test("J1 checking a size marks it, sends nothing, and one save after the question picks it", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND] });
  await expect(row(page, 102)).toContainText("Not selected");
  await expect(row(page, 101)).toContainText("Picked by you");

  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await expect(row(page, 102)).toHaveAttribute("data-changed", "add");
  await expect(row(page, 102)).toContainText("Will be added");
  await expect(status(page)).toHaveText("Not saved: 1 to add · 0 to remove");
  expect(state.changePreviews).toEqual([]);
  expect(state.changeCalls).toEqual([]);

  await saveButton(page).click();
  const dialog = page.getByRole("alertdialog");
  // The server's counts, and only what Echelon does: nothing of this size is on eBay (§13).
  await expect(confirmLines(page)).toHaveText(["1 added · 0 removed", CONFIRM_NONE, CONFIRM_SCOPE]);
  expect(state.changePreviews.map((preview) => preview.body)).toEqual([changeBody(1, [102], [])]);
  expect(state.changeCalls).toEqual([]);
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(status(page)).toHaveText("Saved. 1 added, 0 removed.");
  // Save went with the marks: keyboard focus is on the line that says what happened, not lost to the page (review DUX8).
  await expect(status(page)).toBeFocused();

  // One save: the preview's body, a request key and the effects the vendor confirmed.
  expect(state.changeCalls).toHaveLength(1);
  expect(state.changeCalls[0].status).toBe(201);
  expect(state.changeCalls[0].body).toEqual({ ...changeBody(1, [102], []), idempotencyKey: expect.stringMatching(/^catalog-selection:/),
    expectedEffectsHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect([...state.picks].sort()).toEqual([101, 102]);
  await expect(row(page, 102)).toContainText("Picked by you");
  await expect(row(page, 102)).not.toHaveAttribute("data-changed", /.+/);
  await expect(step(page, "choose")).toContainText("2 selected");
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("2 selected");
  expectClean(state);
});

test("J2 unchecking a pick removes it, says removed listings are only set to quantity 0, and the size reads Not selected", async ({ page }) => {
  // The pick is listed on Marz Cards, so the save sets that listing to quantity 0 (J2b: a removal with no listing).
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], liveVariantIds: { [MARZ.storeConnectionId]: [101] } });
  await box(page, "Select Envelope Single Pocket, Pack of 50").uncheck();
  await expect(row(page, 101)).toHaveAttribute("data-changed", "remove");
  await expect(row(page, 101)).toContainText("Will be removed");
  await expect(status(page)).toHaveText("Not saved: 0 to add · 1 to remove");

  await saveButton(page).click();
  await expect(confirmLines(page)).toHaveText(["0 added · 1 removed", "On Marz Cards: 1 listing is set to quantity 0, so buyers can't buy it.",
    CONFIRM_NOT_ENDED, CONFIRM_SCOPE]);
  await page.getByRole("alertdialog").getByRole("button", { name: "Save changes" }).click();
  await expect(status(page)).toHaveText("Saved. 0 added, 1 removed.");

  expect(state.changeCalls.map((call) => call.body.remove)).toEqual([{ productVariantIds: [101] }]);
  expect(state.picks.size).toBe(0);
  await expect(row(page, 101)).toContainText("Not selected");
  await expect(row(page, 101)).toContainText("No quantity: not selected");
  await expect(row(page, 101)).toContainText("—");
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("0 selected");
  expectClean(state);
});

test("J2b (review round 1 CLI-6) removing a pick no store lists: the question says nothing changes on eBay, and never that it is set to quantity 0", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND] });
  await box(page, "Select Envelope Single Pocket, Pack of 50").uncheck();
  await saveButton(page).click();
  // Only what Echelon does (FIDELITY2): no listing, so no quantity 0 and no "aren't ended" line beside "Nothing changes".
  await expect(confirmLines(page)).toHaveText(["0 added · 1 removed", CONFIRM_NONE, CONFIRM_SCOPE]);
  await page.getByRole("alertdialog").getByRole("button", { name: "Save changes" }).click();
  await expect(status(page)).toHaveText("Saved. 0 added, 1 removed.");
  expect(state.picks.size).toBe(0);
  expectClean(state);
});

test("J4 Cancel in the question sends nothing, and Undo changes clears every change", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND] });
  await box(page, "Select Envelope Single Pocket, Pack of 50").uncheck();
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await expect(status(page)).toHaveText("Not saved: 1 to add · 1 to remove");

  await saveButton(page).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(status(page)).toHaveText("Not saved: 1 to add · 1 to remove");
  // The preview writes nothing; Cancel sends no save.
  expect(state.changePreviews.map((preview) => preview.body)).toEqual([changeBody(1, [102], [101])]);
  expect(state.changeCalls).toEqual([]);

  await page.getByRole("button", { name: "Undo changes" }).click();
  await expect(status(page)).toHaveText("");
  await expect(saveButton(page)).toHaveCount(0);
  await expect(box(page, "Select Envelope Single Pocket, Pack of 50")).toBeChecked();
  await expect(box(page, "Select Envelope Single Pocket, Pack of 100")).not.toBeChecked();
  await expect(row(page, 101)).toContainText("Picked by you");
  expect(state.changeCalls).toEqual([]);
  expectClean(state);
});

test("J5 200 rows a page: the header box checks those shown, Load more keeps the marks and shows the box as mixed", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { selected: false, chooseRows: chooseRowsFixture(230) });
  await expect(page.getByTestId("catalog-choose-shown")).toHaveText("Showing 200 of 230");
  const header = box(page, "Select all shown");
  await header.check();
  await expect(status(page)).toHaveText("Not saved: 200 to add · 0 to remove");
  await expect(header).toBeChecked();

  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByTestId("catalog-choose-shown")).toHaveText("Showing all 230");
  // The button went with the last page: focus is on the first new row's box (review DUX8).
  await expect(box(page, "Select Penny Sleeves 051, Pack of 25")).toBeFocused();
  await expect(status(page)).toHaveText("Not saved: 200 to add · 0 to remove");
  await expect(row(page, 2_230)).toContainText("Not selected");
  await expect(row(page, 2_001)).toContainText("Will be added");
  expect(await header.evaluate((element) => (element as HTMLInputElement).indeterminate)).toBe(true);
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  // Every catalog page asked for 200 rows, with no facets and this page's version (§12.2).
  expect(listReads(state)).toEqual([
    "?selection=all&includeFacets=false&clientVersion=2&page=1&limit=200",
    "?selection=all&includeFacets=false&clientVersion=2&page=2&limit=200",
  ]);

  await page.getByRole("button", { name: "Undo changes" }).click();
  await expect(status(page)).toHaveText("");
  expect(await header.evaluate((element) => (element as HTMLInputElement).indeterminate)).toBe(false);
  expect(state.changeCalls).toEqual([]);
  expectClean(state);
});

test("J6 changes survive a search, the Show filter and a store switch; leaving step 1 asks first", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { stores: [MARZ, OUTLET], chooseRows: [ROW_FACT, SECOND, TOPLOADER] });
  const dialog = page.getByRole("alertdialog");
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await box(page, "Select Toploader 35pt, Pack of 25").check();
  await expect(status(page)).toHaveText("Not saved: 2 to add · 0 to remove");

  const search = page.getByTestId("catalog-choose-filters").getByLabel("Search");
  await search.fill("toploader");
  await expect(page.getByTestId("catalog-choose-shown")).toHaveText("Showing 1 item");
  await expect(row(page, 103)).toContainText("Will be added");
  await expect(status(page)).toHaveText("Not saved: 2 to add · 0 to remove");
  await search.fill("");
  await expect(row(page, 102)).toContainText("Will be added");

  await page.getByTestId("catalog-choose-show").click();
  await page.getByRole("option", { name: "Saved as selected", exact: true }).click();
  await expect(row(page, 101)).toBeVisible();
  await expect(row(page, 102)).toHaveCount(0);
  await expect(status(page)).toHaveText("Not saved: 2 to add · 0 to remove");
  // The list is what is saved; the checks move rows only after Save, and the page says so (review DUX1).
  await expect(page.getByTestId("catalog-choose-saved-note")).toHaveText("This list shows what is saved. Items you check or uncheck move in or out of it after you save.");
  await page.getByTestId("catalog-choose-show").click();
  await page.getByRole("option", { name: "All", exact: true }).click();
  await expect(row(page, 103)).toContainText("Will be added");

  // Step 1's choice is for every store: another store neither asks nor drops it.
  await page.getByTestId("catalog-store-select").click();
  await page.getByRole("option", { name: "Marz Cards Outlet (eBay)" }).click();
  await expect(page.getByTestId("catalog-store-select")).toHaveText("Marz Cards Outlet (eBay)");
  await expect(dialog).toHaveCount(0);
  await expect(status(page)).toHaveText("Not saved: 2 to add · 0 to remove");

  await page.getByRole("link", { name: "Next: Listing settings" }).click();
  await expect(dialog).toContainText("Leave without saving?");
  await expect(dialog).toContainText("You have 2 changes that aren't saved.");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(CHOOSE_PATH);
  await expect(status(page)).toHaveText("Not saved: 2 to add · 0 to remove");

  await page.getByRole("link", { name: "Next: Listing settings" }).click();
  await dialog.getByRole("button", { name: "Discard and leave" }).click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/setup`);
  await step(page, "choose").click();
  await expect(page).toHaveURL(CHOOSE_PATH);
  await expect(row(page, 102)).toContainText("Not selected");
  await expect(status(page)).toHaveText("");
  expect(state.changeCalls).toEqual([]);
  expect(state.changePreviews).toEqual([]);
  // No catalog read ever asked for a product line or a product.
  for (const read of state.reads.filter((entry) => entry.path === "/api/dropship/catalog")) expect(read.search).not.toMatch(/productLine|productId/);
  expectClean(state);
});

test("J7 another tab saved first: the preview finds a newer revision, nothing is saved, the rows read again with the changes kept, and the next save goes on the new revision", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND, TOPLOADER] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  saveFromAnotherTab(state, { add: [103] });
  await expect(step(page, "choose")).toContainText("1 selected");

  // The preview says the head moved before any question (§12.4 step 1): nothing is asked, nothing is saved.
  await saveButton(page).click();
  await expect(page.getByTestId("catalog-choose-error")).toHaveText(STALE);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(state.changePreviews.map((preview) => preview.body.expectedRevisionId)).toEqual([1]);
  expect(state.changeCalls).toEqual([]);
  await expect(row(page, 103)).toContainText("Picked by you");
  // The other tab's save is the saved selection now: the page's count and step 3's rows read it again (review MC7).
  await expect(step(page, "choose")).toContainText("2 selected");
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("2 selected");
  await expect(row(page, 102)).toContainText("Will be added");
  await expect(status(page)).toHaveText("Not saved: 1 to add · 0 to remove");

  await saveAndConfirm(page);
  await expect(status(page)).toHaveText("Saved. 1 added, 0 removed.");
  expect(state.changeCalls.map((call) => call.status)).toEqual([201]);
  expect(state.changeCalls[0].body).toMatchObject(changeBody(2, [102], []));
  expect([...state.picks].sort()).toEqual([101, 102, 103]);
  expectClean(state);
});

test("J8 a busy answer is sent again with the same key and the same body, saying it is still saving, and saves", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], changeAnswers: ["busy"] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await saveAndConfirm(page);
  await expect(page.getByTestId("catalog-choose-progress")).toHaveText(SAVING_STILL);
  await expect(status(page)).toHaveText("Saved. 1 added, 0 removed.");
  expect(state.changeCalls.map((call) => call.status)).toEqual([409, 201]);
  expect(state.changeCalls[1].key).toBe(state.changeCalls[0].key);
  expect(state.changeCalls[1].body).toEqual(state.changeCalls[0].body);
  // One question for the press: the resend is the same confirmed save.
  expect(state.changePreviews).toHaveLength(1);
  await expect(row(page, 102)).toContainText("Picked by you");
  expectClean(state);
});

test("J9 a save whose answer is lost is sent again with the same key, which replays it: saved once, never twice", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], changeAnswers: ["drop-after-commit"] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await saveAndConfirm(page);
  await expect(status(page)).toHaveText("Saved. 1 added, 0 removed.");
  // The first send committed with its answer cut off; the same key's resend gets the stored answer (200).
  expect(state.changeCalls.map((call) => call.status)).toEqual([0, 200]);
  expect(state.changeCalls[1].key).toBe(state.changeCalls[0].key);
  expect(state.changeCalls[1].body).toEqual(state.changeCalls[0].body);
  // One committed save: one new revision.
  expect(state.selectionRevision).toBe(2);
  await expect(row(page, 102)).toContainText("Picked by you");
  expectClean(state);
});

test("J11 no product line shows anywhere on step 1, and no Product, Product line or Apply filters control; the Category filter sends an id", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: chooseRowsFixture(3) });
  await expect(row(page, 2_001)).toBeVisible();
  await expect(page.getByText("Trading Card Supplies")).toHaveCount(0);
  for (const part of [page.getByTestId("catalog-choose-filters"), page.getByTestId("catalog-choose-card"), page.getByTestId("catalog-choose-categories")]) {
    await expect(part.getByText("Product line", { exact: false })).toHaveCount(0);
    await expect(part.getByText("All products")).toHaveCount(0);
    for (const name of ["Apply filters", "Reset", "Select visible", "Remove visible", "Select", "Remove"]) {
      await expect(part.getByRole("button", { name, exact: true })).toHaveCount(0);
    }
  }
  await page.getByTestId("catalog-choose-category").click();
  await expect(page.getByRole("option")).toHaveText(["All categories", "Sleeves (2)", "Toploaders (1)"]);
  await page.getByRole("option", { name: "Toploaders (1)" }).click();
  await expect(page.getByTestId("catalog-choose-shown")).toHaveText("Showing 1 item");
  for (const read of state.reads.filter((entry) => entry.path === "/api/dropship/catalog")) {
    expect(read.search).not.toMatch(/productLine|productId|[?&]category=/);
  }
  expect(listReads(state)).toContain(`?categoryId=${TOPLOADERS_CATEGORY_ID}&selection=all&includeFacets=false&clientVersion=2&page=1&limit=200`);
  expectClean(state);
});

test("J12 on a phone each box is a 44 px target, the item says how it is chosen, and the page never scrolls sideways", async ({ page }, testInfo: TestInfo) => {
  const turnedOffPick: ChooseRowFact = { ...TOPLOADER, enabledOverride: false };
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND, turnedOffPick], picks: new Set([101, 103]) });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  const phone = testInfo.project.name === "mobile";
  const howLine = page.getByTestId("catalog-choose-how-line-102");
  if (phone) {
    for (const id of [101, 102]) {
      const target = await row(page, id).locator("label").first().boundingBox();
      expect(target?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(target?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    for (const name of ["Save changes", "Undo changes"]) {
      const button = await page.getByTestId("catalog-choose-bar").getByRole("button", { name }).boundingBox();
      expect(button?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await expect(howLine).toBeInViewport();
    await expect(howLine).toContainText("Will be added");
    await expect(howLine).toContainText("Available");
    // A turned-off pick says what to do on a phone too (review DUX9; verify V6).
    await expect(page.getByTestId("catalog-choose-how-line-103")).toContainText("Turned off for you");
    await expect(page.getByTestId("catalog-choose-how-line-103")).toContainText(TURNED_OFF_PICK_HINT);
    await expect(page.getByTestId("catalog-choose-table").getByRole("columnheader", { name: "How", exact: true })).toBeHidden();
  } else {
    await expect(howLine).toBeHidden();
    await expect(page.getByTestId("catalog-choose-table").getByRole("columnheader", { name: "How", exact: true })).toBeVisible();
    await expect(page.getByTestId("catalog-choose-table").getByRole("columnheader", { name: "Available", exact: true })).toBeVisible();
    await expect(row(page, 103)).toContainText(TURNED_OFF_PICK_HINT);
  }
  // The box is described by its How words and the hint, on every screen (review DUX9).
  await expect(box(page, "Select Toploader 35pt, Pack of 25")).toHaveAccessibleDescription(`Turned off for you ${TURNED_OFF_PICK_HINT}`);
  const width = page.viewportSize()?.width ?? 1280;
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expect(ROW.productVariantId).toBe(101);
  expectClean(state);
});

// ---------------------------------------------------------------------------
// Review round (step 1 stage 1), on PR B's save
// ---------------------------------------------------------------------------

test("J13 (review CT2, MC1) three 500s: the bar says the save couldn't be confirmed; the next press sends the same key and body and saves", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], changeAnswers: ["server-error", "server-error", "server-error"] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await saveAndConfirm(page);
  await expect(page.getByTestId("catalog-choose-error")).toHaveText(UNCONFIRMED);
  expect(state.changeCalls.map((call) => call.status)).toEqual([500, 500, 500]);
  await expect(status(page)).toHaveText("Not saved: 1 to add · 0 to remove");

  // The kept save goes again as it was: no new preview, no second question (B2a deviation 3).
  await saveButton(page).click();
  await expect(status(page)).toHaveText("Saved. 1 added, 0 removed.");
  expect(state.changeCalls.map((call) => call.status)).toEqual([500, 500, 500, 201]);
  expect(new Set(state.changeCalls.map((call) => call.key)).size).toBe(1);
  expect(state.changeCalls[3].body).toEqual(state.changeCalls[0].body);
  expect(state.changePreviews).toHaveLength(1);
  expectClean(state);
});

test("J14 (review CT2, DUX10) a refusal is sent once, says the server's words, and keeps every change", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], changeAnswers: [
    { status: 403, code: "DROPSHIP_VENDOR_CATALOG_ACCESS_BLOCKED", message: "Dropship vendor status does not allow catalog access." }] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await saveAndConfirm(page);
  await expect(page.getByTestId("catalog-choose-error")).toHaveText("Dropship vendor status does not allow catalog access.");
  expect(state.changeCalls.map((call) => call.status)).toEqual([403]);
  await expect(status(page)).toHaveText("Not saved: 1 to add · 0 to remove");
  await expect(row(page, 102)).toContainText("Will be added");
  expectClean(state);
});

test("J15 (review CT2) the categories can't be read: the card says so with Try again, the table and Save still work, and Try again recovers", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], categoriesReadFailures: READ_FAILURES_UNTIL_GIVE_UP });
  const failed = page.getByTestId("catalog-choose-categories-failed");
  await expect(failed).toContainText("The catalog couldn't be loaded.", { timeout: GIVE_UP_TIMEOUT_MS });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await expect(saveButton(page)).toBeEnabled();
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(failed).toHaveCount(0);
  await expect(page.getByTestId("catalog-choose-category-30")).toContainText("Mailers · 1 of 2 selected");
  expect(state.reads.filter((read) => read.path === "/api/dropship/catalog/categories").length).toBe(READ_FAILURES_UNTIL_GIVE_UP + 1);
  expect(state.changeCalls).toEqual([]);
  expectClean(state);
});

test("J16 (review CT2, CT3, MC4; verify V6) a size turned off for the vendor: their own pick stays checked and can be removed; with none it can be checked, and the save says it was skipped", async ({ page }) => {
  const turnedOff: ChooseRowFact = { ...SECOND, enabledOverride: false };
  const offNoPick: ChooseRowFact = { ...TOPLOADER, enabledOverride: false };
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, turnedOff, offNoPick], picks: new Set([101, 102]) });
  const offPicked = box(page, "Select Envelope Single Pocket, Pack of 100");
  await expect(row(page, 102)).toContainText("Turned off for you");
  await expect(row(page, 102)).toContainText(TURNED_OFF_PICK_HINT);
  await expect(row(page, 102)).toContainText("No quantity: not selected");
  // The vendor's own pick is their choice: checked, and the box can take it back (verify V6).
  await expect(offPicked).toBeChecked();
  await expect(offPicked).toBeEnabled();
  // The server says "Not selected" when there is no pick, before it looks at the override, so the box can be checked.
  await expect(row(page, 103)).toContainText("Not selected");
  await box(page, "Select Toploader 35pt, Pack of 25").check();
  await saveAndConfirm(page);
  // Card Shellz does not offer it to this vendor now: the save skips it and says so (§13 skipped).
  await expect(status(page)).toHaveText("Saved. 0 added, 0 removed. 1 is no longer offered by Card Shellz and was skipped.");
  await expect(row(page, 103)).toContainText("Not selected");
  await expect(box(page, "Select Toploader 35pt, Pack of 25")).not.toBeChecked();

  await offPicked.uncheck();
  await expect(row(page, 102)).toContainText("Will be removed");
  await expect(status(page)).toHaveText("Not saved: 0 to add · 1 to remove");
  await saveAndConfirm(page);
  await expect(status(page)).toHaveText("Saved. 0 added, 1 removed.");
  expect(state.changeCalls.map((call) => call.body.remove)).toEqual([{ productVariantIds: [] }, { productVariantIds: [102] }]);
  await expect(row(page, 102)).toContainText("Not selected");
  await expect(offPicked).not.toBeChecked();
  expect([...state.picks]).toEqual([101]);
  expect(state.changeCalls.map((call) => call.status)).toEqual([201, 201]);
  expectClean(state);
});

test("J18 (review MC6) leaving while a save runs asks the vendor to wait, offers no discard, and the save finishes", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], changeAnswers: ["slow"] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await saveAndConfirm(page);
  await expect(page.getByTestId("catalog-choose-bar").getByRole("button", { name: "Saving…" })).toBeVisible();
  await step(page, "publish").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Your changes are still saving");
  await expect(dialog).toContainText("Wait for the save to finish, then leave. Leaving now can't stop it.");
  await expect(dialog.getByRole("button", { name: "Discard and leave" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "OK" }).click();
  await expect(page).toHaveURL(CHOOSE_PATH);
  await expect(status(page)).toHaveText("Saved. 1 added, 0 removed.", { timeout: SLOW_SELECTION_SAVE_MS + 10_000 });
  expect(state.changeCalls.map((call) => call.status)).toEqual([201]);
  expectClean(state);
});

test("J19 (review DUX2) the portal menu asks before it drops step 1's changes", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await page.getByTestId("portal-nav").getByRole("button", { name: "Wallet" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Leave without saving?");
  await expect(dialog).toContainText("You have 1 change that isn't saved.");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(CHOOSE_PATH);
  await expect(status(page)).toHaveText("Not saved: 1 to add · 0 to remove");
  // The Catalog item itself keeps the page, so it leaves nothing and asks nothing.
  await page.getByTestId("portal-nav").getByRole("button", { name: "Catalog" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(status(page)).toHaveText("Not saved: 1 to add · 0 to remove");
  expect(state.changeCalls).toEqual([]);
  expectClean(state);
});

// ---------------------------------------------------------------------------
// Verify round (step 1 stage 1), on PR B's save
// ---------------------------------------------------------------------------

test("J20 (verify V1, V4) a save with no sure answer, then Save again: the same key replays the save that went through, and the bar says saved, not an error", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND],
    changeAnswers: ["drop-after-commit", "server-error", "server-error"] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await saveAndConfirm(page);
  // It committed with its answer cut off, then two 500s: the page cannot know (review MC1).
  await expect(page.getByTestId("catalog-choose-error")).toHaveText(UNCONFIRMED);
  expect(state.changeCalls.map((call) => call.status)).toEqual([0, 500, 500]);
  expect(state.selectionRevision).toBe(2);

  await saveButton(page).click();
  await expect(status(page)).toHaveText("Saved. 1 added, 0 removed.");
  await expect(page.getByTestId("catalog-choose-error")).toHaveCount(0);
  await expect(saveButton(page)).toHaveCount(0);
  expect(state.changeCalls.map((call) => call.status)).toEqual([0, 500, 500, 200]);
  expect(new Set(state.changeCalls.map((call) => call.key)).size).toBe(1);
  // Saved once: one revision, one question.
  expect(state.selectionRevision).toBe(2);
  expect(state.changePreviews).toHaveLength(1);
  await expect(row(page, 102)).toContainText("Picked by you");
  await expect(step(page, "choose")).toContainText("2 selected");
  expectClean(state);
});

test("J21 (verify V1) another tab already saved the same change: the preview says the choices changed, and the next save finds it already as chosen", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  saveFromAnotherTab(state, { add: [102] });
  await saveButton(page).click();
  await expect(page.getByTestId("catalog-choose-error")).toHaveText(STALE);
  expect(state.changeCalls).toEqual([]);
  await expect(row(page, 102)).toContainText("Picked by you");
  await expect(step(page, "choose")).toContainText("2 selected");

  // The kept change is what is saved already: the question says so, and the save writes no pick twice.
  await saveButton(page).click();
  await expect(confirmLines(page)).toHaveText(["0 added · 0 removed · 1 was already as you chose", CONFIRM_NONE, CONFIRM_SCOPE]);
  await page.getByRole("alertdialog").getByRole("button", { name: "Save changes" }).click();
  await expect(status(page)).toHaveText("Saved. 0 added, 0 removed.");
  expect(state.changeCalls.map((call) => call.status)).toEqual([201]);
  expect(state.changeCalls[0].body).toMatchObject(changeBody(2, [102], []));
  expect([...state.picks].sort()).toEqual([101, 102]);
  expectClean(state);
});

test("J23 (verify V5) a save goes through but the list can't be read again: the bar says saved, the list says why it may be behind, its boxes wait, and Try again shows it", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND] });
  const added = box(page, "Select Envelope Single Pocket, Pack of 100");
  await added.check();
  state.catalogReadFailures.push(...catalogReadFailuresFor("all", 1));
  await saveAndConfirm(page);
  await expect(status(page)).toHaveText("Saved. 1 added, 0 removed.", { timeout: GIVE_UP_TIMEOUT_MS });
  const behind = page.getByTestId("catalog-choose-refetch-failed");
  await expect(behind).toContainText(LIST_BEHIND);
  // The rows on screen were read before the save: their boxes stay off until a read succeeds.
  await expect(added).toBeDisabled();
  await expect(box(page, "Select all shown")).toBeDisabled();
  await expect(step(page, "choose")).toContainText("2 selected");

  await behind.getByRole("button", { name: "Try again" }).click();
  await expect(behind).toHaveCount(0);
  await expect(row(page, 102)).toContainText("Picked by you");
  await expect(added).toBeChecked();
  await expect(added).toBeEnabled();
  expect(state.changeCalls.map((call) => call.status)).toEqual([201]);
  expectClean(state);
});

test("J24 (verify V8) Load more fails: the page says so beside the button, the marks stay, and Try again loads the rest", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { selected: false, chooseRows: chooseRowsFixture(230) });
  await box(page, "Select Penny Sleeves 001, Pack of 25").check();
  state.catalogReadFailures.push(...catalogReadFailuresFor("all", 2));
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("Couldn't load more items.")).toBeVisible({ timeout: GIVE_UP_TIMEOUT_MS });
  await expect(page.getByTestId("catalog-choose-shown")).toHaveText("Showing 200 of 230");
  await expect(status(page)).toHaveText("Not saved: 1 to add · 0 to remove");

  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("catalog-choose-shown")).toHaveText("Showing all 230");
  await expect(page.getByText("Couldn't load more items.")).toHaveCount(0);
  await expect(row(page, 2_230)).toContainText("Not selected");
  await expect(status(page)).toHaveText("Not saved: 1 to add · 0 to remove");
  expect(state.changeCalls).toEqual([]);
  expectClean(state);
});

test("J27 (verify round) with the app's own cache: after a save, a filter read before it is read again, so Saved as selected lists the size just added", async ({ page }) => {
  // The app's client never treats a read as stale on its own (staleTime Infinity), unlike the harness's.
  await serveAppQueryClient(page);
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND] });
  await showOption(page, "Saved as selected");
  await expect(row(page, 101)).toBeVisible();
  await expect(row(page, 102)).toHaveCount(0);
  await showOption(page, "All");
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await saveAndConfirm(page);
  await expect(status(page)).toHaveText("Saved. 1 added, 0 removed.");

  await showOption(page, "Saved as selected");
  await expect(row(page, 102)).toContainText("Picked by you");
  await expect(page.getByTestId("catalog-choose-shown")).toHaveText("Showing all 2");
  expect(state.reads.filter((read) => read.path === CHANGES_PATH)).toHaveLength(1);
  expectClean(state);
});

// ---------------------------------------------------------------------------
// Review round 1 (B1+B2 findings)
// ---------------------------------------------------------------------------

/** The step's catalog-card badge ("2 selected"), the bar's summary and the rail: the three places the count shows. */
async function expectSelectedCount(page: Page, count: number) {
  await expect(page.getByTestId("catalog-choose-card").getByText(`${count} selected`, { exact: true })).toBeVisible();
  await expect(page.getByTestId("catalog-action-summary")).toHaveText(`${count} selected`);
  await expect(step(page, "choose")).toContainText(`${count} selected`);
}

/** A save that went through with its answer cut off, then two 500s: the bar can only say it couldn't confirm (J20). */
async function unsureSaveThatWentThrough(page: Page, state: StubState) {
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await saveAndConfirm(page);
  await expect(page.getByTestId("catalog-choose-error")).toHaveText(UNCONFIRMED);
  expect(state.changeCalls.map((call) => call.status)).toEqual([0, 500, 500]);
  expect(state.selectionRevision).toBe(2);
  await expectSelectedCount(page, 1);
}

test("J28 (review round 1 CLI-1, TST-2; stage 1's J17) a save with no sure answer, then Undo: the page reads the saved choices again and shows the save that went through", async ({ page }) => {
  // Production's cache (staleTime Infinity): nothing is read again by itself.
  await serveAppQueryClient(page);
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND],
    changeAnswers: ["drop-after-commit", "server-error", "server-error"] });
  await unsureSaveThatWentThrough(page, state);

  await page.getByRole("button", { name: "Undo changes" }).click();
  await expect(row(page, 102)).toContainText("Picked by you");
  await expect(box(page, "Select Envelope Single Pocket, Pack of 100")).toBeChecked();
  await expectSelectedCount(page, 2);
  await expect(status(page)).toHaveText(UNDONE_SAVE_MOVED);
  await expect(page.getByTestId("catalog-choose-error")).toHaveCount(0);
  await expect(saveButton(page)).toHaveCount(0);
  // Nothing was sent again: the same three sends of one save, one revision, one question.
  expect(state.changeCalls.map((call) => call.status)).toEqual([0, 500, 500]);
  expect(state.selectionRevision).toBe(2);
  expect(state.changePreviews).toHaveLength(1);
  expectClean(state);
});

test("J29 (review round 1 CLI-1, TST-2) a save with no sure answer, then the box unticked back: the same read again and the same truth", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND],
    changeAnswers: ["drop-after-commit", "server-error", "server-error"] });
  await unsureSaveThatWentThrough(page, state);

  // A plain click, not uncheck(): the page reads the saved choices again and ticks the box back (the save went
  // through), so uncheck()'s own "did the state change" check races that re-read and fails when it is fast.
  await box(page, "Select Envelope Single Pocket, Pack of 100").click();
  await expect(row(page, 102)).toContainText("Picked by you");
  await expect(box(page, "Select Envelope Single Pocket, Pack of 100")).toBeChecked();
  await expectSelectedCount(page, 2);
  await expect(status(page)).toHaveText(UNDONE_SAVE_MOVED);
  expect(state.changeCalls.map((call) => call.status)).toEqual([0, 500, 500]);
  expectClean(state);
});

test("J30 (review round 1 TST-2; stage 1's J22) a save with no sure answer, another tab saves on top, then Undo: both saves show", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND, TOPLOADER],
    changeAnswers: ["drop-after-commit", "server-error", "server-error"] });
  await unsureSaveThatWentThrough(page, state);
  saveFromAnotherTab(state, { add: [103] });

  await page.getByRole("button", { name: "Undo changes" }).click();
  await expect(row(page, 102)).toContainText("Picked by you");
  await expect(row(page, 103)).toContainText("Picked by you");
  await expectSelectedCount(page, 3);
  await expect(status(page)).toHaveText(UNDONE_SAVE_MOVED);
  expect(state.changeCalls.map((call) => call.status)).toEqual([0, 500, 500]);
  expect(state.selectionRevision).toBe(3);
  expectClean(state);
});

test("J31 (review round 1 CLI-1) a save with no sure answer, then Discard and leave: the count reads again at once, and step 1 shows the save when the vendor comes back", async ({ page }) => {
  await serveAppQueryClient(page);
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND],
    changeAnswers: ["drop-after-commit", "server-error", "server-error"] });
  await unsureSaveThatWentThrough(page, state);

  await page.getByRole("link", { name: "Next: Listing settings" }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Discard and leave" }).click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/setup`);
  await expect(step(page, "choose")).toContainText("2 selected");
  await step(page, "choose").click();
  await expect(page).toHaveURL(CHOOSE_PATH);
  await expect(row(page, 102)).toContainText("Picked by you");
  await expectSelectedCount(page, 2);
  await expect(status(page)).toHaveText("");
  expect(state.changeCalls.map((call) => call.status)).toEqual([0, 500, 500]);
  expectClean(state);
});

test("J32 (review round 1 CLI-1) a save with no sure answer that did not go through, then Undo: read again, nothing moved, nothing said", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND],
    changeAnswers: ["server-error", "server-error", "server-error"] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await saveAndConfirm(page);
  await expect(page.getByTestId("catalog-choose-error")).toHaveText(UNCONFIRMED);
  const summaryReads = () => state.reads.filter((read) => read.path === "/api/dropship/catalog/selection").length;
  const before = summaryReads();

  await page.getByRole("button", { name: "Undo changes" }).click();
  await expect.poll(summaryReads).toBeGreaterThan(before);
  await expect(row(page, 102)).toContainText("Not selected");
  await expectSelectedCount(page, 1);
  await expect(status(page)).toHaveText("");
  expect(state.selectionRevision).toBe(1);
  expect(state.changeCalls.map((call) => call.status)).toEqual([500, 500, 500]);
  expectClean(state);
});

test("J33 (review round 1 CLI-2) an older (A) dyno refuses the list for this newer page: the site-updating line while it is read again, then the rows", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], olderServerReads: ["list", "list"] });
  await expect(page.getByTestId("catalog-choose-updating")).toHaveText(SITE_UPDATING);
  await expect(row(page, 102)).toContainText("Not selected", { timeout: OLDER_SERVER_TIMEOUT_MS });
  await expect(page.getByTestId("catalog-choose-updating")).toHaveCount(0);
  expect(state.olderServerReads).toEqual([]);
  expectClean(state);
});

test("J34 (review round 1 CLI-2) an older (A) dyno refuses a category's id read: the line says why everything waits, then the press applies", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND, TOPLOADER] });
  await expect(row(page, 103)).toContainText("Not selected");
  state.olderServerReads.push("ids", "ids");
  await box(page, "Select all in Toploaders").click();
  await expect(page.getByTestId("catalog-choose-updating")).toHaveText(SITE_UPDATING);
  await expect(box(page, "Select Toploader 35pt, Pack of 25")).toBeDisabled();
  await expect(row(page, 103)).toContainText("Will be added", { timeout: OLDER_SERVER_TIMEOUT_MS });
  await expect(page.getByTestId("catalog-choose-updating")).toHaveCount(0);
  await expect(status(page)).toHaveText("Not saved: 1 to add · 0 to remove");
  expect(state.olderServerReads).toEqual([]);
  expectClean(state);
});

test("J35 (review round 1 CLI-2) an older (A) dyno refuses the count for this newer page: the site-updating line, not the retrying one, then the count", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND],
    selectionSummaryAnswers: [pageNewerThanServerAnswer(), pageNewerThanServerAnswer()] });
  await expect(page.getByTestId("catalog-count-updating")).toHaveText(SITE_UPDATING);
  await expect(page.getByTestId("catalog-count-retrying")).toHaveCount(0);
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("1 selected", { timeout: OLDER_SERVER_TIMEOUT_MS });
  await expect(page.getByTestId("catalog-count-updating")).toHaveCount(0);
  expect(state.selectionSummaryAnswers).toEqual([]);
  expectClean(state);
});

test("J36 (review round 1 CLI-4) a change made right after a save, while the count is still read again, goes on the save's own revision: no false stale", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND] });
  await expectSelectedCount(page, 1);
  // The count's next two reads fail (each retried 3 s later): after the save it still says revision 1 for ~6 s.
  const internal = { status: 500, code: "DROPSHIP_VENDOR_CATALOG_INTERNAL_ERROR", message: "Dropship vendor catalog request failed." };
  state.selectionSummaryAnswers.push(internal, internal);
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await saveAndConfirm(page);
  await expect(status(page)).toHaveText("Saved. 1 added, 0 removed.");
  await box(page, "Select Envelope Single Pocket, Pack of 50").uncheck();
  await saveButton(page).click();
  await expect(confirmLines(page).first()).toHaveText("0 added · 1 removed");
  await page.getByRole("alertdialog").getByRole("button", { name: "Save changes" }).click();
  await expect(status(page)).toHaveText("Saved. 0 added, 1 removed.");
  await expect(page.getByTestId("catalog-choose-error")).toHaveCount(0);
  // The second change was made on the first save's revision (2), not the count's cached 1.
  expect(state.changePreviews.map((preview) => preview.body)).toEqual([changeBody(1, [102], []), changeBody(2, [], [101])]);
  expect(state.changeCalls.map((call) => call.status)).toEqual([201, 201]);
  expect([...state.picks]).toEqual([102]);
  expectClean(state);
});

test("J37 (review round 1 CLI-4) no box changes before the count names the head the change is made on", async ({ page }) => {
  const internal = { status: 500, code: "DROPSHIP_VENDOR_CATALOG_INTERNAL_ERROR", message: "Dropship vendor catalog request failed." };
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], selectionSummaryAnswers: [internal] });
  await expect(row(page, 102)).toContainText("Not selected");
  await expect(page.getByTestId("catalog-choose-card").getByText("Loading selection", { exact: true })).toBeVisible();
  await expect(box(page, "Select Envelope Single Pocket, Pack of 100")).toBeDisabled();
  await expect(box(page, "Select all shown")).toBeDisabled();
  // Once the count lands (3 s later) the boxes work, and the change counts from its head.
  await expect(box(page, "Select Envelope Single Pocket, Pack of 100")).toBeEnabled({ timeout: OLDER_SERVER_TIMEOUT_MS });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await saveAndConfirm(page);
  await expect(status(page)).toHaveText("Saved. 1 added, 0 removed.");
  expect(state.changePreviews.map((preview) => preview.body)).toEqual([changeBody(1, [102], [])]);
  expectClean(state);
});
