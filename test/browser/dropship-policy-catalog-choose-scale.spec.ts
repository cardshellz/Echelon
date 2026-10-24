import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  CATALOG_PATH,
  MAILERS_CATEGORY_ID,
  MARZ,
  ROW_FACT,
  SLEEVES_CATEGORY_ID,
  TOPLOADERS_CATEGORY_ID,
  chooseRowsFixture,
  openCatalog,
  picksOf,
  saveFromAnotherTab,
  type ChooseRowFact,
  type StubCatalogArrival,
  type StubState,
} from "./dropship-policy-catalog-stubs";

// Playwright's serviceWorkers:block init script reads navigator.serviceWorker in
// every frame, which throws in an opaque sandbox. This local-only harness
// registers no workers.
test.use({ serviceWorkers: "allow" });

/**
 * Catalog step 1 at scale on one-time picks (PLAN-B v4.1 §12.3, §12.4, §15.4 C1-C13): "Check all N that match", the
 * categories card's boxes, "Select everything", the 10,000 cap, and the save's preview, question and retries, against
 * the stub server, which plans every preview and save from its picks with the server's own planner and parses every
 * body with the server's schemas (dropship-policy-catalog-stubs.ts). Every press sends ids only: nothing is ever added
 * by itself later. N1-N3 (B3, §11.4, §15.4): the new-items notice, whose Review only filters the table; N3 its Got it while
 * "New from Card Shellz" lists every category (B3 review UIT-1).
 */

const CHOOSE_PATH = `${CATALOG_PATH}/choose`;
/** A Card Shellz category only these journeys use. */
const ENVELOPES_CATEGORY_ID = 61;

const CONFIRM_NONE = "Nothing changes on your eBay listings now.";
const CONFIRM_NOT_ENDED = "Removed items are set to quantity 0 on eBay. Their listings aren't ended.";
const CONFIRM_SCOPE = "Your choice applies to all your stores.";
const STALE = "Your saved choices changed after this page loaded. Review them and save again.";
const SAVING_STILL = "Still saving… eBay updates are in progress. Your changes are kept.";
const PAUSED = "Saving is paused for a few minutes while Card Shellz updates the site. Your changes are kept, and saving will try again by itself.";
const EFFECTS_CHANGED = "Something on eBay changed while you were deciding. Check the new numbers and save again.";
const RETIRED = "This page was updated, so your last changes weren't saved. Reload it and make them again.";
/** A save sent again on the busy or paused schedule waits 2 s, 4 s, 8 s between sends (§12.4): room for three. */
const RETRY_TIMEOUT_MS = 25_000;

interface CategoryRows { name: string | null; categoryId: number | null; count: number }

/**
 * Sizes in the given categories, in order, ids ascending from `firstId`, four sizes a product:
 * "Envelopes 0001, Pack of 25".
 */
function scaleRows(groups: readonly CategoryRows[], firstId = 20_001): ChooseRowFact[] {
  const rows: ChooseRowFact[] = [];
  for (const group of groups) {
    for (let index = 0; index < group.count; index += 1) {
      const n = rows.length;
      const label = group.name ?? "Loose";
      rows.push({ ...ROW_FACT, productId: 5_000 + Math.floor(n / 4), productVariantId: firstId + n,
        productName: `${label} ${String(Math.floor(index / 4) + 1).padStart(4, "0")}`, productSku: `${label.slice(0, 3).toUpperCase()}-${Math.floor(index / 4) + 1}`,
        variantName: `Pack of ${25 * ((index % 4) + 1)}`, variantSku: `${label.slice(0, 3).toUpperCase()}-${n + 1}`,
        category: group.name, categoryId: group.categoryId, productLineIds: [], productLineNames: [], stock: 10 + (n % 7) });
    }
  }
  return rows;
}

function ids(rows: readonly ChooseRowFact[]): number[] {
  return rows.map((fact) => fact.productVariantId);
}

function inCategory(rows: readonly ChooseRowFact[], categoryId: number): ChooseRowFact[] {
  return rows.filter((fact) => fact.categoryId === categoryId);
}

function box(page: Page, name: string) {
  return page.getByRole("checkbox", { name, exact: true });
}

/**
 * Presses a category's box. It is clicked, not checked: the box reads its ids first and changes once they come
 * (§12.3), so its state is read from the line's `data-tick` afterwards.
 */
async function pressCategory(page: Page, name: string) {
  await box(page, `Select all in ${name}`).click();
}

function status(page: Page) {
  return page.getByTestId("catalog-choose-status");
}

function saveButton(page: Page) {
  return page.getByTestId("catalog-choose-bar").getByRole("button", { name: "Save changes" });
}

/**
 * The saved count beside step 1's heading (`selectedBadge`, read from the summary). The step rail prints the same count
 * without a thousands separator (dropship-catalog-steps.ts, unchanged since cea5cb027), so the journeys read this one.
 */
function selectedBadge(page: Page) {
  return page.getByTestId("catalog-choose-card").getByText(/^[\d,]+ selected$/);
}

function categoryLine(page: Page, categoryId: number) {
  return page.getByTestId(`catalog-choose-category-${categoryId}`);
}

/** The save question's lines, in order (describeChooseConfirm). */
function confirmLines(page: Page) {
  return page.getByTestId("catalog-choose-confirm").locator("p");
}

async function confirmSave(page: Page) {
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toHaveCount(0);
}

async function saveAndConfirm(page: Page) {
  await saveButton(page).click();
  await expect(page.getByRole("alertdialog")).toContainText("Save your changes?");
  await confirmSave(page);
}

/** The id reads the page made, as their query strings. */
function idReads(state: StubState): string[] {
  return state.reads.filter((read) => read.path === "/api/dropship/catalog" && read.search.includes("idsOnly=true")).map((read) => read.search);
}

function sentIds(state: StubState, index: number, side: "add" | "remove"): number[] {
  return (state.changeCalls[index].body[side] as { productVariantIds: number[] }).productVariantIds;
}

function expectClean(state: StubState) {
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
  expect(state.reads.filter((read) => read.path === "/api/dropship/catalog/selection-rules")).toEqual([]);
  // Every body carried this page's version (§12.6).
  for (const call of [...state.changePreviews, ...state.changeCalls]) expect(call.body.clientVersion).toBe(2);
}

test("C1 1,433 match: the header box, then Check all 1,433 that match, adds the 1,121 not selected in one save", async ({ page }) => {
  const rows = chooseRowsFixture(1_433);
  const picked = rows.slice(1_121);
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: rows, picks: picksOf(picked) });
  await expect(page.getByTestId("catalog-choose-shown")).toHaveText("Showing 200 of 1,433");
  await box(page, "Select all shown").check();
  await expect(status(page)).toHaveText("Not saved: 200 to add · 0 to remove");
  const match = page.getByTestId("catalog-choose-match");
  await expect(match).toContainText("All 200 shown are checked.");
  await match.getByRole("button", { name: "Check all 1,433 that match" }).click();
  await expect(status(page)).toHaveText("Not saved: 1,121 to add · 0 to remove");
  // One id read with the table's filters: the ids, never a rule or a category name (§12.3).
  expect(idReads(state)).toEqual(["?selection=all&idsOnly=true&purpose=add&clientVersion=2"]);
  await expect(match).toHaveCount(0);

  await saveButton(page).click();
  await expect(confirmLines(page)).toHaveText(["1,121 added · 0 removed", CONFIRM_NONE, CONFIRM_SCOPE]);
  await confirmSave(page);
  await expect(status(page)).toHaveText("Saved. 1,121 added, 0 removed.");
  expect(state.changeCalls.map((call) => call.status)).toEqual([201]);
  expect(sentIds(state, 0, "add")).toEqual(ids(rows.slice(0, 1_121)));
  expect(sentIds(state, 0, "remove")).toEqual([]);
  expect(state.picks.size).toBe(1_433);
  await expect(selectedBadge(page)).toHaveText("1,433 selected");
  expectClean(state);
});

test("C2 ticking a category adds only its sizes not selected yet, says later items aren't added, and the save sends those ids", async ({ page }) => {
  const rows = scaleRows([
    { name: "Envelopes", categoryId: ENVELOPES_CATEGORY_ID, count: 30 },
    { name: "Sleeves", categoryId: SLEEVES_CATEGORY_ID, count: 20 },
    { name: null, categoryId: null, count: 5 },
  ]);
  const envelopes = inCategory(rows, ENVELOPES_CATEGORY_ID);
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: rows, picks: picksOf(envelopes.slice(0, 10)) });
  const line = categoryLine(page, ENVELOPES_CATEGORY_ID);
  await expect(line).toHaveText("Envelopes · 10 of 30 selected");
  await expect(line).toHaveAttribute("data-tick", "some");
  await expect(page.getByTestId("catalog-choose-no-category")).toHaveText("Items with no category aren't listed here. Choose them in the table.");

  await pressCategory(page, "Envelopes");
  await expect(page.getByTestId("catalog-choose-categories-status")).toHaveText(
    "Adds the 20 items in Envelopes that aren't selected yet. Items Card Shellz adds to Envelopes later aren't added; you'll see them in a notice here instead.");
  await expect(line).toHaveAttribute("data-tick", "all");
  await expect(status(page)).toHaveText("Not saved: 20 to add · 0 to remove");
  // Only the category's id, whatever the table shows (D26).
  expect(idReads(state)).toEqual([`?categoryId=${ENVELOPES_CATEGORY_ID}&selection=all&idsOnly=true&purpose=add&clientVersion=2`]);

  await saveAndConfirm(page);
  await expect(status(page)).toHaveText("Saved. 20 added, 0 removed.");
  expect(sentIds(state, 0, "add")).toEqual(ids(envelopes.slice(10)));
  expect(sentIds(state, 0, "remove")).toEqual([]);
  await expect(line).toHaveText("Envelopes · 30 of 30 selected");
  await expect(categoryLine(page, SLEEVES_CATEGORY_ID)).toHaveText("Sleeves · 0 of 20 selected");
  expectClean(state);
});

test("C3 unticking a fully selected category removes all of it, and the question counts its live listings set to quantity 0", async ({ page }) => {
  const rows = scaleRows([
    { name: "Toploaders", categoryId: TOPLOADERS_CATEGORY_ID, count: 8 },
    { name: "Sleeves", categoryId: SLEEVES_CATEGORY_ID, count: 6 },
  ]);
  const toploaders = inCategory(rows, TOPLOADERS_CATEGORY_ID);
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: rows, picks: picksOf(rows),
    liveVariantIds: { [MARZ.storeConnectionId]: ids(toploaders.slice(0, 3)) } });
  const line = categoryLine(page, TOPLOADERS_CATEGORY_ID);
  await expect(line).toHaveText("Toploaders · 8 of 8 selected");
  await expect(line).toHaveAttribute("data-tick", "all");

  await pressCategory(page, "Toploaders");
  await expect(page.getByTestId("catalog-choose-categories-status")).toHaveText("Removes all 8 selected items in Toploaders.");
  await expect(line).toHaveAttribute("data-tick", "none");
  await expect(status(page)).toHaveText("Not saved: 0 to add · 8 to remove");

  await saveButton(page).click();
  await expect(confirmLines(page)).toHaveText(["0 added · 8 removed",
    "On Marz Cards: 3 listings are set to quantity 0, so buyers can't buy them.", CONFIRM_NOT_ENDED, CONFIRM_SCOPE]);
  await confirmSave(page);
  await expect(status(page)).toHaveText("Saved. 0 added, 8 removed.");
  expect(sentIds(state, 0, "remove")).toEqual(ids(toploaders));
  expect(sentIds(state, 0, "add")).toEqual([]);
  await expect(line).toHaveText("Toploaders · 0 of 8 selected");
  expectClean(state);
});

test("C4 Select everything is off with the room as its reason when everything would pass 10,000, and adds every size not selected when it fits", async ({ page }) => {
  const over = await openCatalog(page, CHOOSE_PATH, { chooseRows: scaleRows([{ name: "Sleeves", categoryId: SLEEVES_CATEGORY_ID, count: 10_005 }]),
    picks: new Set<number>() });
  const everything = page.getByTestId("catalog-choose-everything");
  await expect(everything).toHaveText("Select everything (10,005)");
  await expect(everything).toBeDisabled();
  const room = "You can have up to 10,000 selected. 0 are selected, so 10,000 more can be added.";
  await expect(page.getByTestId("catalog-choose-room")).toHaveText(room);
  await expect(everything).toHaveAccessibleDescription(room);
  expect(idReads(over)).toEqual([]);
  expectClean(over);

  const fits = await page.context().newPage();
  const rows = scaleRows([
    { name: "Envelopes", categoryId: ENVELOPES_CATEGORY_ID, count: 24 },
    { name: "Sleeves", categoryId: SLEEVES_CATEGORY_ID, count: 16 },
  ]);
  const state = await openCatalog(fits, CHOOSE_PATH, { chooseRows: rows, picks: picksOf(rows.slice(0, 10)) });
  const press = fits.getByTestId("catalog-choose-everything");
  await expect(press).toHaveText("Select everything (40)");
  await expect(press).toBeEnabled();
  await press.click();
  await expect(fits.getByTestId("catalog-choose-categories-status")).toHaveText(
    "Adds every item Card Shellz offers that isn't selected yet (30). Items Card Shellz adds later aren't added. You'll see a notice for new items in categories you sell from.");
  await expect(status(fits)).toHaveText("Not saved: 30 to add · 0 to remove");
  // No filter at all (D27).
  expect(idReads(state)).toEqual(["?selection=all&idsOnly=true&purpose=add&clientVersion=2"]);
  await saveAndConfirm(fits);
  await expect(status(fits)).toHaveText("Saved. 30 added, 0 removed.");
  expect(sentIds(state, 0, "add")).toEqual(ids(rows.slice(10)));
  // Nothing is left to add.
  await expect(press).toBeDisabled();
  expectClean(state);
  await fits.close();
});

test("C5 another tab saved after a category tick: the save stops at the preview with the changes kept, and Save again goes on the new revision", async ({ page }) => {
  const rows = scaleRows([
    { name: "Envelopes", categoryId: ENVELOPES_CATEGORY_ID, count: 20 },
    { name: "Sleeves", categoryId: SLEEVES_CATEGORY_ID, count: 12 },
  ]);
  const envelopes = inCategory(rows, ENVELOPES_CATEGORY_ID);
  const sleeves = inCategory(rows, SLEEVES_CATEGORY_ID);
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: rows, picks: picksOf(sleeves) });
  await pressCategory(page, "Envelopes");
  await expect(status(page)).toHaveText("Not saved: 20 to add · 0 to remove");
  // The other tab picked one envelope and dropped two sleeves.
  saveFromAnotherTab(state, { add: [envelopes[0].productVariantId], remove: ids(sleeves.slice(0, 2)) });

  await saveButton(page).click();
  await expect(page.getByTestId("catalog-choose-error")).toHaveText(STALE);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(state.changeCalls).toEqual([]);
  await expect(status(page)).toHaveText("Not saved: 20 to add · 0 to remove");
  // The categories and the rows were read again: they show the other tab's save.
  await expect(categoryLine(page, ENVELOPES_CATEGORY_ID)).toHaveText("Envelopes · 1 of 20 selected");
  await expect(categoryLine(page, SLEEVES_CATEGORY_ID)).toHaveText("Sleeves · 10 of 12 selected");

  await saveButton(page).click();
  await expect(confirmLines(page)).toHaveText(["19 added · 0 removed · 1 was already as you chose", CONFIRM_NONE, CONFIRM_SCOPE]);
  await confirmSave(page);
  await expect(status(page)).toHaveText("Saved. 19 added, 0 removed.");
  expect(state.changeCalls.map((call) => call.status)).toEqual([201]);
  expect(state.changeCalls[0].body.expectedRevisionId).toBe(2);
  expect(sentIds(state, 0, "add")).toEqual(ids(envelopes));
  expect(state.picks.size).toBe(30);
  expectClean(state);
});

test("C6 busy twice, then saved, with one key; paused twice, then saved, with one key and the changes kept meanwhile", async ({ page }) => {
  test.setTimeout(90_000);
  const rows = scaleRows([{ name: "Sleeves", categoryId: SLEEVES_CATEGORY_ID, count: 4 }]);
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: rows, picks: new Set<number>(), changeAnswers: ["busy", "busy"] });
  await box(page, "Select Sleeves 0001, Pack of 25").check();
  await saveAndConfirm(page);
  await expect(page.getByTestId("catalog-choose-progress")).toHaveText(SAVING_STILL);
  await expect(status(page)).toHaveText("Saved. 1 added, 0 removed.", { timeout: RETRY_TIMEOUT_MS });
  expect(state.changeCalls.map((call) => call.status)).toEqual([409, 409, 201]);
  expect(new Set(state.changeCalls.map((call) => call.key)).size).toBe(1);
  expect(new Set(state.changeCalls.map((call) => JSON.stringify(call.body))).size).toBe(1);

  state.changeAnswers.push("paused", "paused");
  await box(page, "Select Sleeves 0001, Pack of 50").check();
  await saveAndConfirm(page);
  await expect(page.getByTestId("catalog-choose-progress")).toHaveText(PAUSED);
  // While the save waits, the change stays on screen and counted.
  await expect(status(page)).toHaveText("Not saved: 1 to add · 0 to remove");
  await expect(box(page, "Select Sleeves 0001, Pack of 50")).toBeChecked();
  await expect(status(page)).toHaveText("Saved. 1 added, 0 removed.", { timeout: RETRY_TIMEOUT_MS });
  const second = state.changeCalls.slice(3);
  expect(second.map((call) => call.status)).toEqual([503, 503, 201]);
  expect(new Set(second.map((call) => call.key)).size).toBe(1);
  expect(second[0].key).not.toBe(state.changeCalls[0].key);
  expect(new Set(second.map((call) => JSON.stringify(call.body))).size).toBe(1);
  expect([...state.picks].sort()).toEqual(ids(rows.slice(0, 2)));
  expectClean(state);
});

test("C7 the effects change between the question and a save that adds: the page asks again with the new numbers and saves with a new key", async ({ page }) => {
  const rows = scaleRows([{ name: "Sleeves", categoryId: SLEEVES_CATEGORY_ID, count: 4 }]);
  const added = rows[1].productVariantId;
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: rows, picks: picksOf(rows.slice(0, 1)),
    // While the vendor reads the question, sync-back finds the size's listing on eBay again.
    afterChangePreview: [(stub) => { stub.liveVariantIds = { [MARZ.storeConnectionId]: [added] }; }] });
  await box(page, "Select Sleeves 0001, Pack of 50").check();
  await saveButton(page).click();
  await expect(confirmLines(page)).toHaveText(["1 added · 0 removed", CONFIRM_NONE, CONFIRM_SCOPE]);
  await page.getByRole("alertdialog").getByRole("button", { name: "Save changes" }).click();

  // The save was refused (409): the second question says why first, with the new count.
  await expect(page.getByTestId("catalog-choose-confirm-changed")).toHaveText(EFFECTS_CHANGED);
  await expect(confirmLines(page)).toHaveText([EFFECTS_CHANGED, "1 added · 0 removed",
    "On Marz Cards: 1 listing gets its quantity back shortly after you save, at the price it has on eBay now. To send today's price, publish it in step 3.",
    CONFIRM_SCOPE]);
  await confirmSave(page);
  await expect(status(page)).toHaveText("Saved. 1 added, 0 removed.");
  expect(state.changeCalls.map((call) => call.status)).toEqual([409, 201]);
  expect(state.changeCalls[1].key).not.toBe(state.changeCalls[0].key);
  expect(state.changeCalls[1].body.expectedEffectsHash).not.toBe(state.changeCalls[0].body.expectedEffectsHash);
  expect(state.changePreviews).toHaveLength(2);
  expectClean(state);
});

test("C8 over the cap (10,050 selected): adding one is refused before anything is sent; removing 100 is allowed", async ({ page }) => {
  const rows = scaleRows([
    { name: "Toploaders", categoryId: TOPLOADERS_CATEGORY_ID, count: 10 },
    { name: "Envelopes", categoryId: ENVELOPES_CATEGORY_ID, count: 100 },
    { name: "Sleeves", categoryId: SLEEVES_CATEGORY_ID, count: 9_950 },
  ]);
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: rows, picks: picksOf(rows.slice(10)) });
  await expect(page.getByTestId("catalog-choose-over-cap")).toHaveText(
    "10,050 selected, over the 10,000 limit. Publishing refuses more than 10,000. Remove some, then publish.");

  await box(page, "Select Toploaders 0001, Pack of 25").check();
  await expect(status(page)).toContainText("Not saved: 1 to add · 0 to remove");
  await expect(page.getByTestId("catalog-choose-save-off")).toHaveText("This would make 10,051 selected, over the 10,000 limit. Undo some additions to save.");
  await expect(saveButton(page)).toBeDisabled();
  expect(state.changePreviews).toEqual([]);
  await box(page, "Select Toploaders 0001, Pack of 25").uncheck();

  await pressCategory(page, "Envelopes");
  await expect(page.getByTestId("catalog-choose-categories-status")).toHaveText("Removes all 100 selected items in Envelopes.");
  await expect(status(page)).toHaveText("Not saved: 0 to add · 100 to remove");
  await expect(saveButton(page)).toBeEnabled();
  await saveAndConfirm(page);
  await expect(status(page)).toHaveText("Saved. 0 added, 100 removed.");
  expect(sentIds(state, 0, "remove")).toEqual(ids(inCategory(rows, ENVELOPES_CATEGORY_ID)));
  await expect(page.getByTestId("catalog-choose-over-cap")).toHaveCount(0);
  await expect(selectedBadge(page)).toHaveText("9,950 selected");
  expectClean(state);
});

test("C9 on a phone the categories card is above the table with 44 px boxes; on a desktop it is beside it; no sideways scroll", async ({ page }, testInfo: TestInfo) => {
  const rows = scaleRows([
    { name: "Envelopes", categoryId: ENVELOPES_CATEGORY_ID, count: 8 },
    { name: "Sleeves", categoryId: SLEEVES_CATEGORY_ID, count: 8 },
  ]);
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: rows, picks: picksOf(rows.slice(0, 3)) });
  await expect(categoryLine(page, ENVELOPES_CATEGORY_ID)).toBeVisible();
  const card = await page.getByTestId("catalog-choose-categories").boundingBox();
  const table = await page.getByTestId("catalog-choose-card").boundingBox();
  expect(card).not.toBeNull();
  expect(table).not.toBeNull();
  if (testInfo.project.name === "mobile") {
    expect((card?.y ?? 0) + (card?.height ?? 0)).toBeLessThanOrEqual(table?.y ?? 0);
    for (const categoryId of [ENVELOPES_CATEGORY_ID, SLEEVES_CATEGORY_ID]) {
      const target = await categoryLine(page, categoryId).locator("label").boundingBox();
      expect(target?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(target?.height ?? 0).toBeGreaterThanOrEqual(44);
      const name = await categoryLine(page, categoryId).getByRole("button").boundingBox();
      expect(name?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    expect((await page.getByTestId("catalog-choose-everything").boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  } else {
    expect((card?.x ?? 0) + (card?.width ?? 0)).toBeLessThanOrEqual(table?.x ?? 0);
    expect(card?.y ?? 0).toBeLessThan((table?.y ?? 0) + (table?.height ?? 0));
  }
  const width = page.viewportSize()?.width ?? 1280;
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expectClean(state);
});

test("C10 over the cap: Uncheck all 10,050 is too many at once; narrowed to one category's 9,000 it removes them, and a removal-only drift saves with the new count", async ({ page }) => {
  const rows = scaleRows([
    { name: "Sleeves", categoryId: SLEEVES_CATEGORY_ID, count: 9_000 },
    { name: "Envelopes", categoryId: ENVELOPES_CATEGORY_ID, count: 1_050 },
  ]);
  const sleeves = inCategory(rows, SLEEVES_CATEGORY_ID);
  const live = ids(sleeves.slice(0, 3));
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: rows, picks: picksOf(rows),
    liveVariantIds: { [MARZ.storeConnectionId]: live },
    // While the vendor reads the question, one of the three ends on eBay: the removal goes through with two (§7.5).
    afterChangePreview: [(stub) => { stub.endedVariantIds = { [MARZ.storeConnectionId]: [live[0]] }; }] });
  await box(page, "Select all shown").uncheck();
  const match = page.getByTestId("catalog-choose-match");
  await match.getByRole("button", { name: "Uncheck all 10,050 that match" }).click();
  await expect(page.getByTestId("catalog-choose-match-error")).toHaveText(
    "Too many to change at once (10,050). Search or pick a category to narrow the list.");
  await expect(status(page)).toHaveText("Not saved: 0 to add · 200 to remove");

  await page.getByRole("button", { name: "Undo changes" }).click();
  await page.getByRole("button", { name: "Show only Sleeves" }).click();
  await expect(page.getByTestId("catalog-choose-shown")).toHaveText("Showing 200 of 9,000");
  await box(page, "Select all shown").uncheck();
  await match.getByRole("button", { name: "Uncheck all 9,000 that match" }).click();
  await expect(status(page)).toHaveText("Not saved: 0 to add · 9,000 to remove");
  expect(idReads(state)).toEqual([
    "?selection=all&idsOnly=true&purpose=remove&clientVersion=2",
    `?categoryId=${SLEEVES_CATEGORY_ID}&selection=all&idsOnly=true&purpose=remove&clientVersion=2`,
  ]);

  await saveButton(page).click();
  await expect(confirmLines(page)).toHaveText(["0 added · 9,000 removed",
    "On Marz Cards: 3 listings are set to quantity 0, so buyers can't buy them.", CONFIRM_NOT_ENDED, CONFIRM_SCOPE]);
  await confirmSave(page);
  await expect(status(page)).toHaveText("Saved. A few listings changed on eBay while you were deciding; 2 listings are set to quantity 0.");
  expect(state.changeCalls.map((call) => call.status)).toEqual([201]);
  expect(sentIds(state, 0, "remove")).toEqual(ids(sleeves));
  expect(state.picks.size).toBe(1_050);
  expectClean(state);
});

test("C11 an older dyno's HTML, then its 413 with no code, then writes paused: the same save is sent again until it saves", async ({ page }) => {
  test.setTimeout(90_000);
  const rows = scaleRows([{ name: "Sleeves", categoryId: SLEEVES_CATEGORY_ID, count: 4 }]);
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: rows, picks: new Set<number>(),
    changeAnswers: ["html", "too-large-no-code", "paused"] });
  await box(page, "Select Sleeves 0001, Pack of 25").check();
  await saveAndConfirm(page);
  await expect(page.getByTestId("catalog-choose-progress")).toHaveText(PAUSED);
  await expect(status(page)).toHaveText("Not saved: 1 to add · 0 to remove");
  await expect(status(page)).toHaveText("Saved. 1 added, 0 removed.", { timeout: RETRY_TIMEOUT_MS });
  expect(state.changeCalls.map((call) => call.status)).toEqual([200, 413, 503, 201]);
  expect(new Set(state.changeCalls.map((call) => call.key)).size).toBe(1);
  expect(new Set(state.changeCalls.map((call) => JSON.stringify(call.body))).size).toBe(1);
  expect(state.changePreviews).toHaveLength(1);
  expectClean(state);
});

test("C12 a 410 says the page was updated with Reload; PR C's 409 page outdated says the same; Reload reads the page again", async ({ page }) => {
  const rows = scaleRows([{ name: "Sleeves", categoryId: SLEEVES_CATEGORY_ID, count: 4 }]);
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: rows, picks: new Set<number>(), changeAnswers: [
    { status: 410, code: "DROPSHIP_SELECTION_RULES_RETIRED", message: RETIRED },
    { status: 409, code: "DROPSHIP_SELECTION_PAGE_OUTDATED", message: "This page is out of date." },
  ] });
  await box(page, "Select Sleeves 0001, Pack of 25").check();
  await saveAndConfirm(page);
  await expect(page.getByTestId("catalog-choose-error")).toHaveText(RETIRED);
  await expect(page.getByTestId("catalog-choose-reload")).toBeVisible();

  // Nothing was saved: the next press asks again, and C's answer reads the same.
  await saveAndConfirm(page);
  await expect(page.getByTestId("catalog-choose-error")).toHaveText(RETIRED);
  await expect(page.getByTestId("catalog-choose-reload")).toBeVisible();
  expect(state.changeCalls.map((call) => call.status)).toEqual([410, 409]);
  expect(state.changeCalls[1].key).not.toBe(state.changeCalls[0].key);
  expect(state.picks.size).toBe(0);

  await Promise.all([page.waitForEvent("load"), page.getByTestId("catalog-choose-reload").click()]);
  await expect(box(page, "Select Sleeves 0001, Pack of 25")).not.toBeChecked();
  await expect(page.getByTestId("catalog-choose-error")).toHaveCount(0);
  expectClean(state);
});

test("C13 adding a size whose listing ended on eBay: the question counts it nowhere; a live one beside it gets its quantity back", async ({ page }) => {
  const rows = scaleRows([{ name: "Sleeves", categoryId: SLEEVES_CATEGORY_ID, count: 4 }]);
  const [kept, ended, live] = ids(rows);
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: rows, picks: new Set([kept]),
    endedVariantIds: { [MARZ.storeConnectionId]: [ended] }, liveVariantIds: { [MARZ.storeConnectionId]: [ended, live] } });
  await box(page, "Select Sleeves 0001, Pack of 50").check();
  await saveButton(page).click();
  await expect(confirmLines(page)).toHaveText(["1 added · 0 removed", CONFIRM_NONE, CONFIRM_SCOPE]);
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();

  await box(page, "Select Sleeves 0001, Pack of 75").check();
  await saveButton(page).click();
  await expect(confirmLines(page)).toHaveText(["2 added · 0 removed",
    "On Marz Cards: 1 listing gets its quantity back shortly after you save, at the price it has on eBay now. To send today's price, publish it in step 3.",
    CONFIRM_SCOPE]);
  await confirmSave(page);
  await expect(status(page)).toHaveText("Saved. 2 added, 0 removed.");
  expect(sentIds(state, 0, "add")).toEqual([ended, live]);
  expect(state.changePreviews).toHaveLength(2);
  expectClean(state);
});

/** Arrivals of `facts` (sizes Card Shellz added after the release), ids ascending from `firstId`. */
function arrivals(facts: readonly ChooseRowFact[], firstId = 101): StubCatalogArrival[] {
  return facts.map((fact, index) => ({ arrivalId: firstId + index, productVariantId: fact.productVariantId, categoryId: fact.categoryId as number }));
}

/** A category's notice mark at `through` (both watermarks): arrivals after it are new. */
function marks(categoryIds: readonly number[], through = 100) {
  return Object.fromEntries(categoryIds.map((categoryId) => [categoryId, { seenThroughArrivalId: through, notifiedThroughArrivalId: through }]));
}

function noticeLine(page: Page, categoryId: number) {
  return page.getByTestId(`catalog-new-items-${categoryId}`);
}

/** The catalog list reads the page made (not the id reads), as their query strings. */
function listReads(state: StubState): string[] {
  return state.reads.filter((read) => read.path === "/api/dropship/catalog" && !read.search.includes("idsOnly=true")).map((read) => read.search);
}

test("N1 the new-items notice: Review shows the category's new items, two are checked and saved, the count drops, Got it hides the line; nothing is added before Save", async ({ page }) => {
  const rows = scaleRows([
    { name: "Envelopes", categoryId: ENVELOPES_CATEGORY_ID, count: 12 },
    { name: "Sleeves", categoryId: SLEEVES_CATEGORY_ID, count: 8 },
  ]);
  const envelopes = inCategory(rows, ENVELOPES_CATEGORY_ID);
  const sleeves = inCategory(rows, SLEEVES_CATEGORY_ID);
  // The vendor sells from both; Card Shellz added the last three envelopes and the last sleeve after the release.
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: rows, picks: picksOf([...envelopes.slice(0, 6), ...sleeves.slice(0, 4)]),
    catalogArrivals: arrivals([...envelopes.slice(9), sleeves[7]]), noticeMarks: marks([ENVELOPES_CATEGORY_ID, SLEEVES_CATEGORY_ID]) });
  await expect(noticeLine(page, ENVELOPES_CATEGORY_ID)).toHaveText(/^3 new items from Card Shellz in EnvelopesReviewGot it$/);
  await expect(noticeLine(page, SLEEVES_CATEGORY_ID)).toHaveText(/^1 new item from Card Shellz in SleevesReviewGot it$/);
  // Between the step's intro and the filters.
  const noticeBox = await page.getByTestId("catalog-new-items").boundingBox();
  const filtersBox = await page.getByTestId("catalog-choose-filters").boundingBox();
  expect((noticeBox?.y ?? 0) + (noticeBox?.height ?? 0)).toBeLessThanOrEqual(filtersBox?.y ?? 0);
  const intro = page.getByRole("heading", { name: "Step 1 · Choose what to sell", exact: true });
  await expect(intro).toBeVisible();
  expect((await intro.boundingBox())?.y ?? Infinity).toBeLessThan(noticeBox?.y ?? 0);

  await page.getByRole("button", { name: "Review: 3 new items from Card Shellz in Envelopes", exact: true }).click();
  await expect(page.getByTestId("catalog-choose-show")).toHaveText("New from Card Shellz");
  await expect(page.getByTestId("catalog-choose-category")).toHaveText("Envelopes (12)");
  await expect(page.getByTestId("catalog-choose-shown")).toHaveText("Showing all 3");
  expect(listReads(state)).toContain(`?categoryId=${ENVELOPES_CATEGORY_ID}&selection=new&includeFacets=false&clientVersion=2&page=1&limit=200`);
  await box(page, "Select Envelopes 0003, Pack of 50").check();
  await box(page, "Select Envelopes 0003, Pack of 75").check();
  await expect(status(page)).toHaveText("Not saved: 2 to add · 0 to remove");
  // Nothing was added or sent: Review only filtered the table.
  expect(state.changePreviews).toEqual([]);
  expect(state.changeCalls).toEqual([]);
  expect(state.noticeAcknowledges).toEqual([]);
  expect(state.picks.size).toBe(10);

  await saveButton(page).click();
  await expect(confirmLines(page)).toHaveText(["2 added · 0 removed", CONFIRM_NONE, CONFIRM_SCOPE]);
  await confirmSave(page);
  await expect(status(page)).toHaveText("Saved. 2 added, 0 removed.");
  expect(sentIds(state, 0, "add")).toEqual(ids(envelopes.slice(9, 11)));
  // A picked item is no longer new: the line counts one, and the review lists it alone.
  await expect(noticeLine(page, ENVELOPES_CATEGORY_ID)).toHaveText(/^1 new item from Card Shellz in EnvelopesReviewGot it$/);
  await expect(page.getByTestId("catalog-choose-shown")).toHaveText("Showing 1 item");
  await expect(box(page, "Select Envelopes 0003, Pack of 100")).toBeVisible();

  await page.getByRole("button", { name: "Got it: 1 new item from Card Shellz in Envelopes", exact: true }).click();
  await expect(noticeLine(page, ENVELOPES_CATEGORY_ID)).toHaveCount(0);
  expect(state.noticeAcknowledges).toEqual([{ body: { clientVersion: 2, categoryId: ENVELOPES_CATEGORY_ID, throughArrivalId: 103 }, status: 200 }]);
  // The review of that category is over: the table shows all of it again, and focus is on the next line.
  await expect(page.getByTestId("catalog-choose-show")).toHaveText("All");
  await expect(page.getByTestId("catalog-choose-shown")).toHaveText("Showing all 12");
  await expect(page.getByRole("button", { name: "Review: 1 new item from Card Shellz in Sleeves", exact: true })).toBeFocused();

  await page.getByRole("button", { name: "Got it: 1 new item from Card Shellz in Sleeves", exact: true }).click();
  await expect(page.getByTestId("catalog-new-items")).toHaveCount(0);
  await expect(page.getByRole("searchbox", { name: "Search" })).toBeFocused();
  // Read again after the save and after each Got it; the only write that added anything was the save.
  expect(state.noticeAcknowledges.map((call) => call.status)).toEqual([200, 200]);
  expect(state.changeCalls).toHaveLength(1);
  expect(state.picks.size).toBe(12);
  expect(state.reads.filter((read) => read.path === "/api/dropship/catalog/new-items").length).toBeGreaterThanOrEqual(4);
  for (const read of state.reads.filter((entry) => entry.path === "/api/dropship/catalog/new-items")) expect(read.search).toBe("?clientVersion=2");
  expectClean(state);
});

test("N3 Got it while New from Card Shellz lists every category: the acknowledged rows leave the table at once, and that category's cached new list is read again (UIT-1)", async ({ page }) => {
  const rows = scaleRows([
    { name: "Envelopes", categoryId: ENVELOPES_CATEGORY_ID, count: 12 },
    { name: "Sleeves", categoryId: SLEEVES_CATEGORY_ID, count: 8 },
  ]);
  const envelopes = inCategory(rows, ENVELOPES_CATEGORY_ID);
  const sleeves = inCategory(rows, SLEEVES_CATEGORY_ID);
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: rows, picks: picksOf([...envelopes.slice(0, 6), ...sleeves.slice(0, 4)]),
    catalogArrivals: arrivals([...envelopes.slice(9), sleeves[7]]), noticeMarks: marks([ENVELOPES_CATEGORY_ID, SLEEVES_CATEGORY_ID]) });
  const envelopesNew = `?categoryId=${ENVELOPES_CATEGORY_ID}&selection=new&includeFacets=false&clientVersion=2&page=1&limit=200`;
  const everyNew = "?selection=new&includeFacets=false&clientVersion=2&page=1&limit=200";
  const readsOf = (search: string) => listReads(state).filter((read) => read === search).length;

  await page.getByRole("button", { name: "Review: 3 new items from Card Shellz in Envelopes", exact: true }).click();
  await expect(page.getByTestId("catalog-choose-shown")).toHaveText("Showing all 3");
  // Category "All categories" while Show stays New from Card Shellz: every category's new items.
  await page.getByTestId("catalog-choose-category").click();
  await page.getByRole("option", { name: "All categories", exact: true }).click();
  await expect(page.getByTestId("catalog-choose-show")).toHaveText("New from Card Shellz");
  await expect(page.getByTestId("catalog-choose-shown")).toHaveText("Showing all 4");
  expect(readsOf(envelopesNew)).toBe(1);
  expect(readsOf(everyNew)).toBe(1);

  await page.getByRole("button", { name: "Got it: 3 new items from Card Shellz in Envelopes", exact: true }).click();
  await expect(noticeLine(page, ENVELOPES_CATEGORY_ID)).toHaveCount(0);
  // The review goes on (another category's line is left), and the list on screen is read again: only the sleeve.
  await expect(page.getByTestId("catalog-choose-show")).toHaveText("New from Card Shellz");
  await expect(page.getByTestId("catalog-choose-shown")).toHaveText("Showing 1 item");
  await expect(box(page, "Select Sleeves 0002, Pack of 100")).toBeVisible();
  for (const name of ["Envelopes 0003, Pack of 50", "Envelopes 0003, Pack of 75", "Envelopes 0003, Pack of 100"]) {
    await expect(box(page, `Select ${name}`)).toHaveCount(0);
  }
  expect(readsOf(everyNew)).toBe(2);

  // Envelopes again from the Category menu, Show still new: its cached list is not shown as it was; a fresh read says none.
  await page.getByTestId("catalog-choose-category").click();
  await page.getByRole("option", { name: "Envelopes (12)", exact: true }).click();
  await expect(page.getByText("No items match your search and filters.")).toBeVisible();
  expect(readsOf(envelopesNew)).toBe(2);
  // Nothing was added: Got it only moved the notice's mark.
  expect(state.noticeAcknowledges).toEqual([{ body: { clientVersion: 2, categoryId: ENVELOPES_CATEGORY_ID, throughArrivalId: 103 }, status: 200 }]);
  expect(state.changePreviews).toEqual([]);
  expect(state.changeCalls).toEqual([]);
  expect(state.picks.size).toBe(10);
  expectClean(state);
});

test("N2 more than three categories: three lines and \"and 2 more categories\", Show all draws them all; 44 px buttons on a phone; no sideways scroll", async ({ page }, testInfo: TestInfo) => {
  const BINDERS_CATEGORY_ID = 65;
  const rows = scaleRows([
    { name: "Card Storage Binders And Boxes For Collectors", categoryId: BINDERS_CATEGORY_ID, count: 4 },
    { name: "Envelopes", categoryId: ENVELOPES_CATEGORY_ID, count: 4 },
    { name: "Mailers", categoryId: MAILERS_CATEGORY_ID, count: 4 },
    { name: "Sleeves", categoryId: SLEEVES_CATEGORY_ID, count: 4 },
    { name: "Toploaders", categoryId: TOPLOADERS_CATEGORY_ID, count: 4 },
  ]);
  const categoryIds = [BINDERS_CATEGORY_ID, ENVELOPES_CATEGORY_ID, MAILERS_CATEGORY_ID, SLEEVES_CATEGORY_ID, TOPLOADERS_CATEGORY_ID];
  // One pick and one new size in each category.
  const state = await openCatalog(page, CHOOSE_PATH, { chooseRows: rows,
    picks: picksOf(categoryIds.map((categoryId) => inCategory(rows, categoryId)[0])),
    catalogArrivals: arrivals(categoryIds.map((categoryId) => inCategory(rows, categoryId)[3])), noticeMarks: marks(categoryIds) });
  const notice = page.getByTestId("catalog-new-items");
  await expect(notice.locator("li")).toHaveCount(3);
  await expect(noticeLine(page, BINDERS_CATEGORY_ID)).toContainText("1 new item from Card Shellz in Card Storage Binders And Boxes For Collectors");
  await expect(noticeLine(page, SLEEVES_CATEGORY_ID)).toHaveCount(0);
  const more = page.getByTestId("catalog-new-items-more");
  await expect(more).toHaveText(/^and 2 more categoriesShow all$/);

  const buttons = notice.getByRole("button");
  if (testInfo.project.name === "mobile") {
    for (let index = 0; index < await buttons.count(); index += 1) {
      const target = await buttons.nth(index).boundingBox();
      expect(target?.height ?? 0, `button ${index}`).toBeGreaterThanOrEqual(44);
    }
  }
  const width = page.viewportSize()?.width ?? 1280;
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

  await more.getByRole("button", { name: "Show all", exact: true }).click();
  await expect(notice.locator("li")).toHaveCount(5);
  await expect(more).toHaveCount(0);
  await expect(noticeLine(page, TOPLOADERS_CATEGORY_ID)).toContainText("1 new item from Card Shellz in Toploaders");
  // Focus goes to the first line that was hidden.
  await expect(page.getByRole("button", { name: "Review: 1 new item from Card Shellz in Sleeves", exact: true })).toBeFocused();
  if (testInfo.project.name === "mobile") {
    for (let index = 0; index < await buttons.count(); index += 1) {
      expect((await buttons.nth(index).boundingBox())?.height ?? 0, `button ${index}`).toBeGreaterThanOrEqual(44);
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  // Nothing was sent: the notice only shows.
  expect(state.changePreviews).toEqual([]);
  expect(state.noticeAcknowledges).toEqual([]);
  expectClean(state);
});
