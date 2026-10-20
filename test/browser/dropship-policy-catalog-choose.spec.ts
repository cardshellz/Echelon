import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  CATALOG_PATH,
  MARZ,
  OUTLET,
  ROW,
  ROW_FACT,
  SLOW_SELECTION_PUT_MS,
  chooseRowsFixture,
  openCatalog,
  saveFromAnotherTab,
  selectionRule,
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
 * Catalog step 1, stage 1 ("The checkbox is the choice"): checking marks a change, one "Save changes" sends every add
 * and remove in one PUT after the eBay question, and nothing is sent before. The stub evaluates every row with the
 * server's own selection rules and answers the save as the route does (dropship-policy-catalog-stubs.ts).
 */

const CHOOSE_PATH = `${CATALOG_PATH}/choose`;

/** A second size of ROW's product, not chosen. */
const SECOND: ChooseRowFact = { ...ROW_FACT, productVariantId: 102, variantName: "Pack of 100", variantSku: "ENV-SGL-P100", stock: 40 };
/** Another product, in another category, not chosen. */
const TOPLOADER: ChooseRowFact = { ...ROW_FACT, productId: 12, productVariantId: 103, productName: "Toploader 35pt", productSku: "TL-35",
  variantName: "Pack of 25", variantSku: "TL-35-25", category: "Toploaders", stock: 9 };

const ADD_WORDS = "Items you add that still have an eBay listing can start selling again soon after you save. Items that were never listed stay off eBay until you publish them in step 3.";
const REMOVE_WORDS = "Sizes you remove that are listed on eBay are set to quantity 0 there the next time Card Shellz updates that listing's stock, so buyers can't buy them. Card Shellz changes only their quantity. Sizes you keep checked don't change.";
const UNKNOWN_WORDS = "This page can't tell yet which of these items are on eBay. Your choice applies to all your stores.";
const UNCONFIRMED = "We couldn't confirm your save. Press Save changes again to check whether it went through.";
const UNDONE_BUT_SAVED = "Your last save went through after all. The list now shows what is saved.";
const PENDING_MOVED = "Your saved choices changed: your last save may have gone through, or another tab saved. The list now shows what is saved.";
const STALE_NOTHING_LEFT = "Your choices were saved in another tab, and they already match your changes. Nothing is left to save.";
const LIST_BEHIND = "The list couldn't be refreshed after the last save, so it may not show what is saved. Press Try again.";
const TURNED_OFF_PICK_HINT = "You picked it, but it can't be sold now. Uncheck it to remove your pick.";
/** The page-level words of a failed rules read (the server's), which step 1 shows only in its own card (verify V4). */
const SERVER_READ_FAILED = "Dropship vendor catalog request failed.";

/** The rules exactly as the page sends them (compact: no null targets, no ids). */
function sentPick(productVariantId: number) {
  return { scopeType: "variant", action: "include", productVariantId, autoConnectNewSkus: true, autoListNewSkus: false, priority: 100, metadata: { source: "portal_catalog" } };
}
function sentKeepOut(productVariantId: number) {
  return { scopeType: "variant", action: "exclude", productVariantId, autoConnectNewSkus: false, autoListNewSkus: false, priority: 200, metadata: { source: "portal_catalog" } };
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

/** Save changes, then the question's own Save changes. */
async function saveAndConfirm(page: Page) {
  await saveButton(page).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Save your changes?");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toHaveCount(0);
}

function expectClean(state: StubState) {
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
}

/** Picks a Show option. */
async function showOption(page: Page, name: "All" | "Saved as selected") {
  await page.getByTestId("catalog-choose-show").click();
  await page.getByRole("option", { name, exact: true }).click();
}

/** The requests to the rules route, in order, as "GET" / "PUT". */
function rulesCalls(state: StubState): string[] {
  return state.reads.filter((read) => read.path === "/api/dropship/catalog/selection-rules").map((read) => read.method);
}

test("J1 checking a size marks it, sends nothing, and one save after the eBay question picks it", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND] });
  await expect(row(page, 102)).toContainText("Not selected");
  await expect(row(page, 101)).toContainText("Picked by you");

  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await expect(row(page, 102)).toHaveAttribute("data-changed", "add");
  await expect(row(page, 102)).toContainText("Will be added");
  await expect(status(page)).toHaveText("Not saved: 1 to add · 0 to remove");
  expect(state.selectionPuts).toEqual([]);

  await saveButton(page).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(ADD_WORDS);
  await expect(dialog).toContainText(UNKNOWN_WORDS);
  await expect(dialog).not.toContainText(REMOVE_WORDS);
  const before = rulesCalls(state).length;
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(status(page)).toHaveText("Saved. 1 added.");
  // Save went with the marks: keyboard focus is on the line that says what happened, not lost to the page (review DUX8).
  await expect(status(page)).toBeFocused();

  // One fresh read of the rules, then one PUT of today's rules plus the new pick.
  expect(rulesCalls(state).slice(before, before + 2)).toEqual(["GET", "PUT"]);
  expect(state.selectionPuts).toHaveLength(1);
  expect(state.selectionPuts[0].status).toBe(201);
  expect(state.selectionPuts[0].body.rules).toEqual([sentPick(101), sentPick(102)]);
  expect(state.selectionPuts[0].key).toMatch(/^catalog-selection:/);
  await expect(row(page, 102)).toContainText("Picked by you");
  await expect(row(page, 102)).not.toHaveAttribute("data-changed", /.+/);
  await expect(step(page, "choose")).toContainText("2 selected");
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("2 selected");
  expectClean(state);
});

test("J2 unchecking a lone pick deletes it: no keep-out is written, and the size reads Not selected", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND] });
  await box(page, "Select Envelope Single Pocket, Pack of 50").uncheck();
  await expect(row(page, 101)).toHaveAttribute("data-changed", "remove");
  await expect(row(page, 101)).toContainText("Will be removed");
  await expect(status(page)).toHaveText("Not saved: 0 to add · 1 to remove");

  await saveButton(page).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText(REMOVE_WORDS);
  await expect(dialog).toContainText(UNKNOWN_WORDS);
  await expect(dialog).not.toContainText(ADD_WORDS);
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(status(page)).toHaveText("Saved. 1 removed.");

  expect(state.selectionPuts.map((put) => put.body.rules)).toEqual([[]]);
  await expect(row(page, 101)).toContainText("Not selected");
  await expect(row(page, 101)).toContainText("No quantity: not selected");
  await expect(row(page, 101)).toContainText("—");
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("0 selected");
  expectClean(state);
});

test("J3 under an older category setting, a remove keeps the size out and checking it again takes the keep-out away", async ({ page }) => {
  const mailers = selectionRule(1, "category", "include", { category: "Mailers" }, { priority: 50, metadata: { source: "portal_catalog_scope" } });
  const state = await openCatalog(page, CHOOSE_PATH, { selectionRules: [mailers] });
  const sentMailers = { scopeType: "category", action: "include", category: "Mailers", autoConnectNewSkus: true, autoListNewSkus: false,
    priority: 50, metadata: { source: "portal_catalog_scope" } };
  await expect(row(page, 101)).toContainText("Selected by an older setting");

  await box(page, "Select Envelope Single Pocket, Pack of 50").uncheck();
  await saveAndConfirm(page);
  await expect(status(page)).toHaveText("Saved. 1 removed.");
  expect(state.selectionPuts[0].body.rules).toEqual([sentMailers, sentKeepOut(101)]);
  await expect(row(page, 101)).toContainText("Removed by you");
  await expect(row(page, 101)).toContainText("Check it to sell it again.");

  await box(page, "Select Envelope Single Pocket, Pack of 50").check();
  await expect(status(page)).toHaveText("Not saved: 1 to add · 0 to remove");
  await saveAndConfirm(page);
  await expect(status(page)).toHaveText("Saved. 1 added.");
  expect(state.selectionPuts[1].body.rules).toEqual([sentMailers]);
  expect(state.selectionPuts[1].key).not.toBe(state.selectionPuts[0].key);
  await expect(row(page, 101)).toContainText("Selected by an older setting");
  expectClean(state);
});

test("J4 Cancel in the question sends nothing, and Undo changes clears every change", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND] });
  await box(page, "Select Envelope Single Pocket, Pack of 50").uncheck();
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await expect(status(page)).toHaveText("Not saved: 1 to add · 1 to remove");
  const reads = rulesCalls(state).length;

  await saveButton(page).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(status(page)).toHaveText("Not saved: 1 to add · 1 to remove");
  expect(rulesCalls(state).length).toBe(reads);
  expect(state.selectionPuts).toEqual([]);

  await page.getByRole("button", { name: "Undo changes" }).click();
  await expect(status(page)).toHaveText("");
  await expect(saveButton(page)).toHaveCount(0);
  await expect(box(page, "Select Envelope Single Pocket, Pack of 50")).toBeChecked();
  await expect(box(page, "Select Envelope Single Pocket, Pack of 100")).not.toBeChecked();
  await expect(row(page, 101)).toContainText("Picked by you");
  expect(state.selectionPuts).toEqual([]);
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
  // Every catalog page asked for 200 rows.
  const listReads = state.reads.filter((read) => read.path === "/api/dropship/catalog" && !read.search.includes("selectedOnly"));
  expect(listReads.map((read) => read.search)).toEqual(["?page=1&limit=200", "?page=2&limit=200"]);

  await page.getByRole("button", { name: "Undo changes" }).click();
  await expect(status(page)).toHaveText("");
  expect(await header.evaluate((element) => (element as HTMLInputElement).indeterminate)).toBe(false);
  expect(state.selectionPuts).toEqual([]);
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
  expect(state.selectionPuts).toEqual([]);
  // No catalog read ever asked for a product line or a product.
  for (const read of state.reads.filter((entry) => entry.path === "/api/dropship/catalog")) expect(read.search).not.toMatch(/productLine|productId/);
  expectClean(state);
});

test("J7 another tab saved first: nothing is sent, the rows read again with the changes kept, and the next save builds on the new rules", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND, TOPLOADER] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  saveFromAnotherTab(state, [selectionRule(0, "variant", "include", { productVariantId: 101 }), selectionRule(0, "variant", "include", { productVariantId: 103 })]);
  const catalogReads = state.reads.filter((read) => read.path === "/api/dropship/catalog").length;

  await expect(step(page, "choose")).toContainText("1 selected");
  await saveAndConfirm(page);
  await expect(page.getByTestId("catalog-choose-error")).toHaveText("Your choices were changed in another tab. Review them and save again.");
  expect(state.selectionPuts).toEqual([]);
  await expect(row(page, 103)).toContainText("Picked by you");
  // The other tab's save is the saved selection now: the page's count and step 3's rows read it again (review MC7).
  await expect(step(page, "choose")).toContainText("2 selected");
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("2 selected");
  expect(state.reads.filter((read) => read.path === "/api/dropship/catalog").length).toBeGreaterThan(catalogReads);
  await expect(row(page, 102)).toContainText("Will be added");
  await expect(status(page)).toHaveText("Not saved: 1 to add · 0 to remove");

  await saveAndConfirm(page);
  await expect(status(page)).toHaveText("Saved. 1 added.");
  expect(state.selectionPuts).toHaveLength(1);
  expect(state.selectionPuts[0].body.rules).toEqual([sentPick(101), sentPick(103), sentPick(102)]);
  expectClean(state);
});

test("J8 a busy answer is sent again with the same key and the same body, and saves", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], selectionPutAnswers: ["busy"] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await saveAndConfirm(page);
  await expect(status(page)).toHaveText("Saved. 1 added.");
  expect(state.selectionPuts.map((put) => put.status)).toEqual([409, 201]);
  expect(state.selectionPuts[1].key).toBe(state.selectionPuts[0].key);
  expect(state.selectionPuts[1].body).toEqual(state.selectionPuts[0].body);
  await expect(row(page, 102)).toContainText("Picked by you");
  expectClean(state);
});

test("J9 a save whose answer is lost is found saved by the next look at the rules: never sent again, never saved twice", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], selectionPutAnswers: ["drop-after-commit"] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await saveAndConfirm(page);
  await expect(status(page)).toHaveText("Saved. 1 added.");
  // Review MC2: before a resend the rules are read again; they hold what was sent, so nothing is sent again (the same
  // key would only have replayed; unit S3 and S6 cover the resend).
  expect(state.selectionPuts.map((put) => put.status)).toEqual([0]);
  // One committed save: one new revision.
  expect(state.selectionRevision).toBe(2);
  await expect(row(page, 102)).toContainText("Picked by you");
  expectClean(state);
});

test("J10 a save that would pass 500 saved choices is stopped before sending, with the count", async ({ page }) => {
  const older = Array.from({ length: 499 }, (_, index) => selectionRule(1_000 + index, "variant", "include", { productVariantId: 50_000 + index }));
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], selectionRules: older });
  await box(page, "Select Envelope Single Pocket, Pack of 50").check();
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await expect(status(page)).toContainText("Not saved: 2 to add · 0 to remove");
  const reason = page.getByTestId("catalog-choose-save-off");
  await expect(reason).toContainText("You can keep up to 500 saved choices");
  await expect(reason).toContainText("This save would make 501, which is 1 over. Change some marked items back, then save.");
  await expect(saveButton(page)).toBeDisabled();
  await expect(saveButton(page)).toHaveAttribute("aria-describedby", (await reason.getAttribute("id")) ?? "missing");
  // A disabled Save leaves the Tab order, so the status region says why too (review DUX3).
  await expect(status(page)).toContainText("Not saved: 2 to add · 0 to remove. You can keep up to 500 saved choices");
  // On a phone the bar with the stop stays under 30% of the screen (review DUX12; measured 27.5% at 390×844 before the words changed).
  const bar = await page.getByTestId("catalog-action-bar").boundingBox();
  const viewport = page.viewportSize();
  expect((bar?.height ?? Number.POSITIVE_INFINITY) / (viewport?.height ?? 1)).toBeLessThanOrEqual(0.3);

  await box(page, "Select Envelope Single Pocket, Pack of 100").uncheck();
  await expect(reason).toHaveCount(0);
  await expect(saveButton(page)).toBeEnabled();
  expect(state.selectionPuts).toEqual([]);
  expectClean(state);
});

test("J11 no product line shows anywhere on step 1, and no Product, Product line or Apply filters control", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: chooseRowsFixture(3) });
  await expect(row(page, 2_001)).toBeVisible();
  await expect(page.getByText("Trading Card Supplies")).toHaveCount(0);
  for (const part of [page.getByTestId("catalog-choose-filters"), page.getByTestId("catalog-choose-card")]) {
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
  for (const read of state.reads.filter((entry) => entry.path === "/api/dropship/catalog")) expect(read.search).not.toMatch(/productLine|productId/);
  expect(state.reads.some((read) => read.path === "/api/dropship/catalog" && read.search.includes("category=Toploaders"))).toBe(true);
  expectClean(state);
});

test("J12 on a phone each box is a 44 px target, the item says how it is chosen, and the page never scrolls sideways", async ({ page }, testInfo: TestInfo) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND, TOPLOADER],
    selectionRules: [selectionRule(1, "variant", "include", { productVariantId: 101 }), selectionRule(2, "variant", "exclude", { productVariantId: 103 })] });
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
    // "Removed by you" says what to do on a phone too (review DUX9).
    await expect(page.getByTestId("catalog-choose-how-line-103")).toContainText("Removed by you");
    await expect(page.getByTestId("catalog-choose-how-line-103")).toContainText("Check it to sell it again.");
    await expect(page.getByTestId("catalog-choose-table").getByRole("columnheader", { name: "How", exact: true })).toBeHidden();
  } else {
    await expect(howLine).toBeHidden();
    await expect(page.getByTestId("catalog-choose-table").getByRole("columnheader", { name: "How", exact: true })).toBeVisible();
    await expect(page.getByTestId("catalog-choose-table").getByRole("columnheader", { name: "Available", exact: true })).toBeVisible();
    await expect(row(page, 103)).toContainText("Check it to sell it again.");
  }
  // The box is described by its How words and the hint, on every screen (review DUX9).
  await expect(box(page, "Select Toploader 35pt, Pack of 25")).toHaveAccessibleDescription("Removed by you Check it to sell it again.");
  const width = page.viewportSize()?.width ?? 1280;
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expect(ROW.productVariantId).toBe(101);
  expectClean(state);
});

// ---------------------------------------------------------------------------
// Review round (step 1 stage 1)
// ---------------------------------------------------------------------------

test("J13 (review CT2, MC1) three 500s: the bar says the save couldn't be confirmed; the next press sends the same key and body and saves", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], selectionPutAnswers: ["server-error", "server-error", "server-error"] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await saveAndConfirm(page);
  await expect(page.getByTestId("catalog-choose-error")).toHaveText("We couldn't confirm your save. Press Save changes again to check whether it went through.");
  expect(state.selectionPuts.map((put) => put.status)).toEqual([500, 500, 500]);
  await expect(status(page)).toHaveText("Not saved: 1 to add · 0 to remove");

  await saveAndConfirm(page);
  await expect(status(page)).toHaveText("Saved. 1 added.");
  expect(state.selectionPuts.map((put) => put.status)).toEqual([500, 500, 500, 201]);
  expect(new Set(state.selectionPuts.map((put) => put.key)).size).toBe(1);
  expect(state.selectionPuts[3].body).toEqual(state.selectionPuts[0].body);
  expectClean(state);
});

test("J14 (review CT2, DUX10) a refusal is sent once, says the server's words, and keeps every change", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], selectionPutAnswers: ["forbidden"] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await saveAndConfirm(page);
  await expect(page.getByTestId("catalog-choose-error")).toHaveText("Dropship vendor status does not allow catalog access.");
  expect(state.selectionPuts.map((put) => put.status)).toEqual([403]);
  await expect(status(page)).toHaveText("Not saved: 1 to add · 0 to remove");
  await expect(row(page, 102)).toContainText("Will be added");
  expectClean(state);
});

test("J15 (review CT2) the saved choices can't be read: the boxes and Save stay off, and Try again recovers", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], rulesReadAnswers: ["server-error"] });
  const failed = page.getByTestId("catalog-choose-rules-failed");
  await expect(failed).toContainText("Your saved choices couldn't be loaded, so changes can't be saved yet.");
  // One cause, one message: the page's own alert for the same read stays off step 1 (verify V4).
  await expect(page.getByText(SERVER_READ_FAILED)).toHaveCount(0);
  await expect(box(page, "Select Envelope Single Pocket, Pack of 100")).toBeDisabled();
  await expect(box(page, "Select all shown")).toBeDisabled();
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(failed).toHaveCount(0);
  await expect(box(page, "Select Envelope Single Pocket, Pack of 100")).toBeEnabled();
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  await expect(saveButton(page)).toBeEnabled();
  expect(state.selectionPuts).toEqual([]);
  expectClean(state);
});

test("J16 (review CT2, CT3, MC4; verify V6) a size turned off for the vendor: their own pick stays checked and can be removed; with none it can be checked, and the save says it didn't take", async ({ page }) => {
  const turnedOff: ChooseRowFact = { ...SECOND, enabledOverride: false };
  const offNoPick: ChooseRowFact = { ...TOPLOADER, enabledOverride: false };
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, turnedOff, offNoPick],
    selectionRules: [selectionRule(1, "variant", "include", { productVariantId: 101 }), selectionRule(2, "variant", "include", { productVariantId: 102 })] });
  const offPicked = box(page, "Select Envelope Single Pocket, Pack of 100");
  await expect(row(page, 102)).toContainText("Turned off for you");
  await expect(row(page, 102)).toContainText(TURNED_OFF_PICK_HINT);
  await expect(row(page, 102)).toContainText("No quantity: not selected");
  // The vendor's own pick is their choice: checked, and the box can take it back (verify V6).
  await expect(offPicked).toBeChecked();
  await expect(offPicked).toBeEnabled();
  // The server says "Not selected" when no pick matches, before it looks at the override, so the box can be checked.
  await expect(row(page, 103)).toContainText("Not selected");
  await box(page, "Select Toploader 35pt, Pack of 25").check();
  await saveAndConfirm(page);
  await expect(status(page)).toHaveText("Saved. 1 change didn't take effect: its row says why.");
  await expect(row(page, 103)).toContainText("Turned off for you");
  await expect(box(page, "Select Toploader 35pt, Pack of 25")).toBeChecked();
  await expect(box(page, "Select Toploader 35pt, Pack of 25")).toBeEnabled();

  await offPicked.uncheck();
  await expect(row(page, 102)).toContainText("Will be removed");
  await expect(status(page)).toHaveText("Not saved: 0 to add · 1 to remove");
  await saveAndConfirm(page);
  await expect(status(page)).toHaveText("Saved. 1 removed.");
  // The lone pick is deleted with no keep-out, so the size reads Not selected.
  expect(state.selectionPuts[1].body.rules).toEqual([sentPick(101), sentPick(103)]);
  await expect(row(page, 102)).toContainText("Not selected");
  await expect(offPicked).not.toBeChecked();
  expect(state.selectionPuts.map((put) => put.status)).toEqual([201, 201]);
  expectClean(state);
});

test("J17 (review MC1) a save with no sure answer, then Undo: the rules are read first, and a save that went through is shown and said", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], selectionPutAnswers: ["drop-after-commit"] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  // The save's first read answers; every later read fails, so the runner can't see that its cut-off save committed.
  state.rulesReadAnswers.push("ok", "server-error", "server-error", "server-error");
  await saveAndConfirm(page);
  await expect(page.getByTestId("catalog-choose-error")).toHaveText("We couldn't confirm your save. Press Save changes again to check whether it went through.");
  expect(state.selectionPuts.map((put) => put.status)).toEqual([0]);
  await expect(step(page, "choose")).toContainText("1 selected");

  await page.getByRole("button", { name: "Undo changes" }).click();
  await expect(page.getByTestId("catalog-choose-error")).toHaveText("Your last save went through after all. The list now shows what is saved.");
  await expect(row(page, 102)).toContainText("Picked by you");
  await expect(box(page, "Select Envelope Single Pocket, Pack of 100")).toBeChecked();
  await expect(step(page, "choose")).toContainText("2 selected");
  expect(state.selectionPuts).toHaveLength(1);
  expectClean(state);
});

test("J18 (review MC6) leaving while a save runs asks the vendor to wait, offers no discard, and the save finishes", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], selectionPutAnswers: ["slow"] });
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
  await expect(status(page)).toHaveText("Saved. 1 added.", { timeout: SLOW_SELECTION_PUT_MS + 10_000 });
  expect(state.selectionPuts.map((put) => put.status)).toEqual([201]);
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
  expect(state.selectionPuts).toEqual([]);
  expectClean(state);
});

// ---------------------------------------------------------------------------
// Verify round (step 1 stage 1)
// ---------------------------------------------------------------------------

test("J20 (verify V1, V4) a save with no sure answer, then Save again: the rules show it went through, and the bar says saved, not an error", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], selectionPutAnswers: ["drop-after-commit"] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  // The save's first read answers; every later read fails, so the runner can't see that its cut-off save committed.
  state.rulesReadAnswers.push("ok", "server-error", "server-error", "server-error");
  await saveAndConfirm(page);
  await expect(page.getByTestId("catalog-choose-error")).toHaveText(UNCONFIRMED);
  // The failed reads leave an error on the shared rules read; step 1 says one thing about it, in its bar (verify V4).
  await expect(page.getByText(SERVER_READ_FAILED)).toHaveCount(0);

  await saveAndConfirm(page);
  await expect(status(page)).toHaveText("Saved. 1 added.");
  await expect(page.getByTestId("catalog-choose-error")).toHaveCount(0);
  await expect(saveButton(page)).toHaveCount(0);
  expect(state.selectionPuts.map((put) => put.status)).toEqual([0]);
  await expect(row(page, 102)).toContainText("Picked by you");
  await expect(step(page, "choose")).toContainText("2 selected");
  expectClean(state);
});

test("J21 (verify V1) another tab already saved the same change: nothing is sent, and the bar says nothing is left to save", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  saveFromAnotherTab(state, [selectionRule(0, "variant", "include", { productVariantId: 101 }), selectionRule(0, "variant", "include", { productVariantId: 102 })]);
  await saveAndConfirm(page);
  await expect(status(page)).toHaveText(STALE_NOTHING_LEFT);
  await expect(page.getByTestId("catalog-choose-error")).toHaveCount(0);
  await expect(saveButton(page)).toHaveCount(0);
  expect(state.selectionPuts).toEqual([]);
  await expect(row(page, 102)).toContainText("Picked by you");
  await expect(step(page, "choose")).toContainText("2 selected");
  expectClean(state);
});

test("J22 (verify V2) a save with no sure answer, another tab saves on top, then Undo: the page reads everything again and says the saved choices changed", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND, TOPLOADER], selectionPutAnswers: ["drop-after-commit"] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  state.rulesReadAnswers.push("ok", "server-error", "server-error", "server-error");
  await saveAndConfirm(page);
  await expect(page.getByTestId("catalog-choose-error")).toHaveText(UNCONFIRMED);
  // The other tab read the committed rules (101 and 102) and adds 103.
  saveFromAnotherTab(state, [selectionRule(0, "variant", "include", { productVariantId: 101 }), selectionRule(0, "variant", "include", { productVariantId: 102 }),
    selectionRule(0, "variant", "include", { productVariantId: 103 })]);

  await page.getByRole("button", { name: "Undo changes" }).click();
  await expect(page.getByTestId("catalog-choose-error")).toHaveText(PENDING_MOVED);
  await expect(row(page, 102)).toContainText("Picked by you");
  await expect(row(page, 103)).toContainText("Picked by you");
  await expect(step(page, "choose")).toContainText("3 selected");
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("3 selected");
  expect(state.selectionPuts).toHaveLength(1);
  expectClean(state);
});

test("J23 (verify V5) a save goes through but the list can't be read again: the bar says saved, the list says why it may be behind, its boxes wait, and Try again shows it", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND] });
  const added = box(page, "Select Envelope Single Pocket, Pack of 100");
  await added.check();
  state.catalogReadFailures.push({ selectedOnly: false, page: 1 });
  await saveAndConfirm(page);
  await expect(status(page)).toHaveText("Saved. 1 added.");
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
  expect(state.selectionPuts.map((put) => put.status)).toEqual([201]);
  expectClean(state);
});

test("J24 (verify V8) Load more fails: the page says so beside the button, the marks stay, and Try again loads the rest", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { selected: false, chooseRows: chooseRowsFixture(230) });
  await box(page, "Select Penny Sleeves 001, Pack of 25").check();
  state.catalogReadFailures.push({ selectedOnly: false, page: 2 });
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText("Couldn't load more items.")).toBeVisible();
  await expect(page.getByTestId("catalog-choose-shown")).toHaveText("Showing 200 of 230");
  await expect(status(page)).toHaveText("Not saved: 1 to add · 0 to remove");

  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("catalog-choose-shown")).toHaveText("Showing all 230");
  await expect(page.getByText("Couldn't load more items.")).toHaveCount(0);
  await expect(row(page, 2_230)).toContainText("Not selected");
  await expect(status(page)).toHaveText("Not saved: 1 to add · 0 to remove");
  expect(state.selectionPuts).toEqual([]);
  expectClean(state);
});

test("J25 (verify V8) busy, then the look at the rules before the resend fails: nothing is sent that try, and the next one saves with the same key and body", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], selectionPutAnswers: ["busy"] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  state.rulesReadAnswers.push("ok", "server-error");
  const before = rulesCalls(state).length;
  await saveAndConfirm(page);
  await expect(status(page)).toHaveText("Saved. 1 added.");
  // Read, PUT (busy), pause, read (fails: nothing sent), pause, read, PUT (saved).
  expect(rulesCalls(state).slice(before, before + 5)).toEqual(["GET", "PUT", "GET", "GET", "PUT"]);
  expect(state.selectionPuts.map((put) => put.status)).toEqual([409, 201]);
  expect(state.selectionPuts[1].key).toBe(state.selectionPuts[0].key);
  expect(state.selectionPuts[1].body).toEqual(state.selectionPuts[0].body);
  await expect(row(page, 102)).toContainText("Picked by you");
  expectClean(state);
});

test("J26 (verify V8) a save with no sure answer, then a search that shows it saved: the page reads the rules before forgetting it and says it went through", async ({ page }) => {
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: [ROW_FACT, SECOND], selectionPutAnswers: ["drop-after-commit"] });
  await box(page, "Select Envelope Single Pocket, Pack of 100").check();
  state.rulesReadAnswers.push("ok", "server-error", "server-error", "server-error");
  await saveAndConfirm(page);
  await expect(page.getByTestId("catalog-choose-error")).toHaveText(UNCONFIRMED);

  // A new read shows the size saved, so its mark goes; the page checks the rules first, and says what it found.
  await page.getByTestId("catalog-choose-filters").getByLabel("Search").fill("Pack of 100");
  await expect(page.getByTestId("catalog-choose-shown")).toHaveText("Showing 1 item");
  await expect(page.getByTestId("catalog-choose-error")).toHaveText(UNDONE_BUT_SAVED);
  await expect(status(page)).toHaveText("");
  await expect(row(page, 102)).toContainText("Picked by you");
  await expect(step(page, "choose")).toContainText("2 selected");
  expect(state.selectionPuts).toHaveLength(1);
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
  await expect(status(page)).toHaveText("Saved. 1 added.");

  await showOption(page, "Saved as selected");
  await expect(row(page, 102)).toContainText("Picked by you");
  await expect(page.getByTestId("catalog-choose-shown")).toHaveText("Showing all 2");
  expectClean(state);
});
