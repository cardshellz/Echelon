import { expect, test, type Page } from "@playwright/test";
import type { CategoryListingSettingValues, ProductListingSettingValues } from "../../shared/dropship/listing-setting-values";
import {
  bulkCatalog,
  categoryKey,
  listingSetupWithAnotherShippingPolicy,
  productKey,
  shot,
  type ProductFixture,
  type StubState,
} from "./dropship-policy-catalog-stubs";
import {
  KEY,
  LISTINGS,
  SETUP_PATH,
  STORE,
  banner,
  drawer,
  exactBox,
  expectNoHorizontalScroll,
  expectNothingUnexpected,
  expectSheetLayout,
  failNextRead,
  openProductRow,
  openStep,
  phone,
  readsOf,
} from "./dropship-policy-listing-settings-helpers";

// Playwright's serviceWorkers:block init script reads navigator.serviceWorker in
// every frame, which throws in an opaque sandbox. This local-only harness
// registers no workers.
test.use({ serviceWorkers: "allow" });

/**
 * "Card Shellz updated products" (Listing settings PR 10, part 10g; plan 10.1-10.5): when Card Shellz
 * moves a chosen product to another category, or changes a product the vendor wrote their own text
 * for, the vendor sees it in one sheet at `?sheet=updated` and presses [Got it] or [Got it for all N]
 * (W13, `POST …/category-moves/acknowledge`). The line under the attention strip ("Card Shellz moved 4
 * products to another category." [Review]) comes from the page-0 read made when the step mounts; the
 * strip's own-text line keeps its record words and its [Check] opens the same sheet. Every "Got it" is
 * checked against the shared contract by the stub (each product once, the category the read showed,
 * keyed), and every journey ends with nothing unexpected asked and no page error. Desktop and phone.
 */

const UPDATED_PATH = `${LISTINGS}/listing-settings/updated-products`;
const ACKNOWLEDGE_PATH = `${LISTINGS}/listing-settings/category-moves/acknowledge`;

const SLEEVES = 40;
const TOPLOADERS = 41;
const CASES = 42;
/** A category id no chosen product is in any more: Card Shellz removed it (CC-C21). */
const REMOVED = 99;

const NO_VALUES: ProductListingSettingValues = {
  price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null,
  textAbove: null, textBelow: null, mainText: null,
};
const NO_CATEGORY_VALUES: CategoryListingSettingValues = {
  price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null,
  textAbove: null, textBelow: null,
};

function product(productId: number, productName: string, category: { name: string; id: number } | null): ProductFixture {
  return {
    productId, productName, productSku: `UPD-${productId}`, category: category?.name ?? null, categoryId: category?.id ?? null,
    sizes: [{ productVariantId: productId * 10, sizeName: "Pack of 100", sku: `UPD-${productId}-100`, retailCents: 399, costCents: 210, stockUnits: 12 }],
  };
}

const PENNY = product(2_001, "Penny Sleeves", { name: "Toploaders", id: TOPLOADERS });
const TEAM = product(2_002, "Team Bags", { name: "Toploaders", id: TOPLOADERS });
const BINDER = product(2_003, "Binder Pages", { name: "Toploaders", id: TOPLOADERS });
const CASE = product(2_004, "Card Cases", { name: "Toploaders", id: TOPLOADERS });
/** Still in Sleeves, unmarked: it gives the category its current name, and is never listed. */
const SOFT = product(2_005, "Soft Sleeves", { name: "Sleeves", id: SLEEVES });
/** Own main text written against an older Card Shellz product: listed for its text only. */
const WORDY = product(2_006, "Wordy Mailers", { name: "Sleeves", id: SLEEVES });

/**
 * Four products Card Shellz moved into Toploaders since the vendor last confirmed them: from Sleeves
 * (Penny Sleeves; Team Bags, whose own row covers every setting that differs), from no category
 * (Binder Pages) and from a category Card Shellz removed (Card Cases); plus Wordy Mailers' own text.
 * Sleeves and Toploaders differ in their shipping policy and text below. A new copy of each product for each
 * journey (the stub keeps the objects it is given, and one journey moves Team Bags again in place): a journey's
 * catalog is its own, as `bulkCatalog`'s is.
 */
function updatedState(): Partial<StubState> {
  return {
    catalog: structuredClone([PENNY, TEAM, BINDER, CASE, SOFT, WORDY]),
    listingSetups: { [STORE]: listingSetupWithAnotherShippingPolicy(STORE) },
    categoryMarks: {
      [productKey(STORE, PENNY.productId)]: SLEEVES, [productKey(STORE, TEAM.productId)]: SLEEVES,
      [productKey(STORE, BINDER.productId)]: null, [productKey(STORE, CASE.productId)]: REMOVED,
    },
    categorySettings: {
      [categoryKey(STORE, SLEEVES)]: { revisionId: 8, values: { ...NO_CATEGORY_VALUES, shippingPolicy: { id: "ground", name: "USPS Ground Advantage" } } },
      [categoryKey(STORE, TOPLOADERS)]: { revisionId: 9, values: { ...NO_CATEGORY_VALUES, shippingPolicy: { id: "priority", name: "USPS Priority Mail" }, textBelow: { mode: "none" } } },
    },
    productSettings: {
      [productKey(STORE, TEAM.productId)]: { revisionId: 7, values: { ...NO_VALUES, shippingPolicy: { id: "ground", name: "USPS Ground Advantage" }, textBelow: { mode: "none" } } },
      [productKey(STORE, WORDY.productId)]: { revisionId: 12, values: { ...NO_VALUES, mainText: { text: "Our own words.", catalogHash: "b".repeat(64) } } },
    },
  };
}

/** Sixty products moved from Sleeves into Toploaders (ids 1001-1060), and one still in Sleeves to name it. */
function sixtyMovedState(): Partial<StubState> {
  const moved = bulkCatalog(60).map((entry) => ({ ...entry, category: "Toploaders", categoryId: TOPLOADERS }));
  return {
    catalog: [...moved, structuredClone(SOFT)],
    categoryMarks: Object.fromEntries(moved.map((entry) => [productKey(STORE, entry.productId), SLEEVES])),
  };
}

function line(page: Page) {
  return page.getByTestId("updated-products-line");
}

function review(page: Page) {
  return line(page).getByRole("button", { name: "Review", exact: true });
}

function sheet(page: Page) {
  return page.getByTestId("updated-products-sheet");
}

function sheetRow(page: Page, productId: number) {
  return sheet(page).getByTestId(`updated-product-${productId}`);
}

function gotItAll(page: Page) {
  return sheet(page).getByTestId("updated-products-got-it-all");
}

function gotIt(page: Page, productName: string) {
  return sheet(page).getByRole("button", { name: `Got it for ${productName}`, exact: true });
}

function strip(page: Page) {
  return page.getByTestId("listing-settings-attention");
}

function stripCheck(page: Page) {
  return strip(page).locator("li[data-code='own_text_needs_check']").getByRole("button", { name: "Check", exact: true });
}

/** The vendor's eye on step 2 with the updated products: the line is there and the page-0 read was made once on mount. */
async function openUpdatedStep(page: Page, initial: Partial<StubState> = updatedState(), path = SETUP_PATH) {
  const state = await openStep(page, initial, path);
  await expect(page.getByTestId("listing-settings-product-2001")).toBeVisible();
  return state;
}

/** Opens the sheet from the line; its own fresh page-0 read answers and the rows can be used. */
async function openSheet(page: Page) {
  await review(page).click();
  await expect(sheet(page)).toBeVisible();
  await expect(page).toHaveURL(/[?&]sheet=updated(&|$)/);
  await expect(sheet(page).getByRole("heading", { name: "Card Shellz updated products" })).toBeVisible();
  await expect(gotItAll(page)).toBeEnabled();
  // Focus starts on × (← on a phone), never on the button that acknowledges every move (plan 3.4).
  await expect(gotItAll(page)).not.toBeFocused();
  await expect(sheet(page).getByRole("button", { name: /^(Close|Back)$/ })).toBeFocused();
}

/** Where the last POST to `path` sits in the stub's log. */
function lastPostAt(state: StubState, path: string): number {
  const at = state.reads.map((read) => read.method === "POST" && read.path === path).lastIndexOf(true);
  expect(at).toBeGreaterThan(-1);
  return at;
}

/** How many GETs of `path` the log holds after its entry `at`, read live (so a poll sees a later one). */
function readsAfter(state: StubState, at: number, path: string): number {
  return state.reads.slice(at + 1).filter((read) => read.method === "GET" && read.path === path).length;
}

test("the line under the strip opens the sheet; Got it sends the category the row showed, and the row goes after the re-read", async ({ page }, testInfo) => {
  const state = await openUpdatedStep(page);
  await expect(line(page)).toHaveText("●Card Shellz moved 4 products to another category.Review");
  // The step's mount-time read (D18), page 0 once, under the strip and above Store defaults (UX-M10).
  expect(readsOf(state, "GET", UPDATED_PATH).map((read) => read.search)).toEqual(["?page=0"]);
  expect(await line(page).evaluate((element) => element.previousElementSibling?.getAttribute("data-testid"))).toBe("listing-settings-attention");
  expect(await line(page).evaluate((element) => element.nextElementSibling?.querySelector("[data-testid='store-defaults-card']") !== null)).toBe(true);

  await openSheet(page);
  // The sheet reads its page fresh (D6): a second page-0 read.
  expect(readsOf(state, "GET", UPDATED_PATH).map((read) => read.search)).toEqual(["?page=0", "?page=0"]);
  await expect(gotItAll(page)).toHaveText("Got it for all 4");
  await expect(sheetRow(page, 2_001)).toContainText("Penny Sleeves · Moved from Sleeves to Toploaders.");
  await expect(sheetRow(page, 2_001)).toContainText("Category settings that differ: shipping policy, text below.");
  // Team Bags' own row covers both settings that differ (UX-M6): never "Nothing changes".
  await expect(sheetRow(page, 2_002)).toContainText("Team Bags · Moved from Sleeves to Toploaders.");
  await expect(sheetRow(page, 2_002)).toContainText("No category setting changes for it.");
  await expect(sheet(page)).not.toContainText("Nothing changes");
  await expect(sheetRow(page, 2_003)).toContainText("Binder Pages · Moved from no category to Toploaders.");
  await expect(sheetRow(page, 2_004)).toContainText("Card Cases · Moved from a category Card Shellz removed to Toploaders.");
  await expect(sheetRow(page, 2_006)).toContainText("Wordy Mailers · Card Shellz changed this product. Check your text still fits.");
  await expect(sheetRow(page, 2_006).getByRole("button", { name: "Check the text of Wordy Mailers", exact: true })).toBeVisible();
  await expect(sheetRow(page, 2_006).getByRole("button", { name: /Got it/ })).toHaveCount(0);
  await expect(sheet(page).getByTestId("updated-product-2005")).toHaveCount(0);
  await shot(page, testInfo, "listing-settings-updated-sheet");

  await gotIt(page, "Penny Sleeves").click();
  await expect(sheet(page).getByRole("status").filter({ hasText: "Done." })).toBeVisible();
  // One POST: the product with the category it was shown in (D6), under a W13 key (D5).
  expect(state.categoryMovesAcknowledges).toEqual([{ method: "POST", path: ACKNOWLEDGE_PATH, body: {
    idempotencyKey: KEY("ls-moves"), items: [{ productId: 2_001, shownCategoryId: TOPLOADERS }],
  } }]);
  expect(state.categoryMarks[productKey(STORE, PENNY.productId)]).toBe(TOPLOADERS);
  // D9: the rows, the Products list and the summary are read again; the answer itself is never shown as the list.
  await expect(sheetRow(page, 2_001)).toHaveCount(0);
  await expect(gotItAll(page)).toHaveText("Got it for all 3");
  await expect(sheetRow(page, 2_002)).toBeVisible();
  const at = lastPostAt(state, ACKNOWLEDGE_PATH);
  expect(readsAfter(state, at, UPDATED_PATH)).toBeGreaterThanOrEqual(1);
  expect(readsAfter(state, at, `${LISTINGS}/listing-settings/summary`)).toBeGreaterThanOrEqual(1);
  await expect.poll(() => readsAfter(state, at, `${LISTINGS}/listing-settings/products`)).toBeGreaterThanOrEqual(1);
  await expect(sheet(page)).not.toContainText("moved again");

  // × (← on a phone) closes in place: the address loses the sheet, the line counts three, focus is back on Review.
  await sheet(page).getByRole("button", { name: phone(testInfo) ? "Back" : "Close", exact: true }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(line(page)).toContainText("Card Shellz moved 3 products to another category.");
  await expect(review(page)).toBeFocused();
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("All saved");
  expectNothingUnexpected(state);
});

test("the strip's own-text line keeps its record words and its Check opens the sheet, with focus back on it after", async ({ page }, testInfo) => {
  const state = await openUpdatedStep(page);
  const ownText = strip(page).locator("li[data-code='own_text_needs_check']");
  await expect(ownText).toContainText("Card Shellz updated 1 product that has your own text. Check that it still fits.");
  await expect(ownText).not.toContainText("Show products");
  await stripCheck(page).click();
  await expect(sheet(page)).toBeVisible();
  await expect(page).toHaveURL(/[?&]sheet=updated(&|$)/);
  await expect(sheetRow(page, 2_006)).toContainText("Wordy Mailers");
  // One surface at a time: the sheet never opens a second sheet or the drawer by itself (D20).
  await expect(drawer(page)).toHaveCount(0);
  await sheet(page).getByRole("button", { name: phone(testInfo) ? "Back" : "Close", exact: true }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(stripCheck(page)).toBeFocused();
  expect(state.categoryMovesAcknowledges).toEqual([]);
  expectNothingUnexpected(state);
});

test("Got it for all 4 sends every moved product as the read listed them; one moved again since stays, named from the answer", async ({ page }) => {
  const state = await openUpdatedStep(page);
  await openSheet(page);
  // Card Shellz moves Team Bags again (into Cases) after the vendor was shown it in Toploaders.
  const team = state.catalog.find((entry) => entry.productId === TEAM.productId)!;
  team.category = "Cases";
  team.categoryId = CASES;

  await gotItAll(page).click();
  await expect(sheet(page).getByRole("status").filter({ hasText: "Done." })).toBeVisible();
  await expect(sheet(page)).toContainText("1 product moved again. Check it below. It can take a minute to update.");
  expect(state.categoryMovesAcknowledges).toEqual([{ method: "POST", path: ACKNOWLEDGE_PATH, body: {
    idempotencyKey: KEY("ls-moves"),
    items: [
      { productId: 2_001, shownCategoryId: TOPLOADERS }, { productId: 2_002, shownCategoryId: TOPLOADERS },
      { productId: 2_003, shownCategoryId: TOPLOADERS }, { productId: 2_004, shownCategoryId: TOPLOADERS },
    ],
  } }]);
  // Three marks moved; Team Bags' mark stays, so it is listed again with its newer move (10.6: shown from the answer first).
  expect([PENNY, BINDER, CASE].map((entry) => state.categoryMarks[productKey(STORE, entry.productId)])).toEqual([TOPLOADERS, TOPLOADERS, TOPLOADERS]);
  expect(state.categoryMarks[productKey(STORE, TEAM.productId)]).toBe(SLEEVES);
  await expect(sheetRow(page, 2_001)).toHaveCount(0);
  await expect(sheetRow(page, 2_003)).toHaveCount(0);
  await expect(sheetRow(page, 2_004)).toHaveCount(0);
  await expect(sheetRow(page, 2_002)).toContainText("Team Bags · Moved from Sleeves to Cases.");
  await expect(sheetRow(page, 2_006)).toBeVisible();
  await expect(gotItAll(page)).toHaveText("Got it for all 1");

  // Got it for the newer move sends the category shown now; the last moved product goes, and so do the header button and the line.
  await gotIt(page, "Team Bags").click();
  await expect(sheetRow(page, 2_002)).toHaveCount(0);
  expect(state.categoryMovesAcknowledges[1].body).toEqual({ idempotencyKey: KEY("ls-moves"), items: [{ productId: 2_002, shownCategoryId: CASES }] });
  expect(state.categoryMovesAcknowledges[1].body.idempotencyKey).not.toBe(state.categoryMovesAcknowledges[0].body.idempotencyKey);
  await expect(gotItAll(page)).toHaveCount(0);
  await expect(sheetRow(page, 2_006)).toBeVisible();
  await expect(sheet(page)).not.toContainText("moved again");
  await expect(line(page)).toHaveCount(0);
  expectNothingUnexpected(state);
});

test("an own-text row's Check closes the sheet and opens the drawer on Description; Back returns to the sheet, and × puts focus back on Review", async ({ page }, testInfo) => {
  const state = await openUpdatedStep(page);
  await openSheet(page);
  await sheetRow(page, 2_006).getByRole("button", { name: "Check the text of Wordy Mailers", exact: true }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(drawer(page)).toBeVisible();
  // One surface at a time (D20): the sheet is off the address, the drawer on it.
  await expect(page).toHaveURL(`${SETUP_PATH}?product=2006`);
  await expect(drawer(page).getByRole("heading", { name: "Wordy Mailers" })).toBeVisible();
  // 10b's landing request: the Description row's editor opens, with the own-text notice.
  await expect(drawer(page).getByTestId("drawer-field-editor-description")).toBeVisible();
  await expect(drawer(page).getByTestId("drawer-setting-descriptionTemplate")).toContainText("Card Shellz changed this product. Check your text still fits.");

  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  await expect(sheet(page)).toBeVisible();
  await expect(page).toHaveURL(/[?&]sheet=updated(&|$)/);

  // Closing that drawer with × (← on a phone) gives focus back to what opened the sheet, [Review]: the row's [Check]
  // went with the sheet (plan 3.4).
  await sheetRow(page, 2_006).getByRole("button", { name: "Check the text of Wordy Mailers", exact: true }).click();
  await expect(drawer(page)).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  await drawer(page).getByRole("button", { name: phone(testInfo) ? "Back" : "Close", exact: true }).click();
  await expect(drawer(page)).toHaveCount(0);
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(review(page)).toBeFocused();
  expect(state.categoryMovesAcknowledges).toEqual([]);
  expectNothingUnexpected(state);
});

test("a Got it whose answer was lost is checked again with the same key and items; Esc keeps the sheet meanwhile", async ({ page }) => {
  const state = await openUpdatedStep(page, { ...updatedState(), categoryMovesAcknowledgeAnswers: ["drop"] });
  await openSheet(page);
  await gotIt(page, "Penny Sleeves").click();
  await expect(sheet(page).getByRole("alert")).toContainText("We couldn't confirm your save.");
  const checkAgain = sheet(page).getByRole("button", { name: "Check again", exact: true });
  await expect(checkAgain).toBeVisible();
  // Locked until it is checked: every Got it is off, Esc keeps the sheet (plan 3.4).
  await expect(gotItAll(page)).toBeDisabled();
  await expect(gotIt(page, "Team Bags")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeVisible();
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("All saved");

  await checkAgain.click();
  await expect(sheet(page).getByRole("status").filter({ hasText: "Done." })).toBeVisible();
  expect(state.categoryMovesAcknowledges).toHaveLength(2);
  expect(state.categoryMovesAcknowledges[1].body).toEqual(state.categoryMovesAcknowledges[0].body);
  // Acknowledged once: the retry was answered from the first save.
  expect(state.categoryMarks[productKey(STORE, PENNY.productId)]).toBe(TOPLOADERS);
  await expect(sheetRow(page, 2_001)).toHaveCount(0);
  await expect(gotIt(page, "Team Bags")).toBeEnabled();
  expectNothingUnexpected(state);
});

test("Back closes the sheet; × replaces the address so Back then leaves it shut", async ({ page }, testInfo) => {
  const state = await openUpdatedStep(page);
  const historyLength = () => page.evaluate(() => window.history.length);
  const startLength = await historyLength();
  await openSheet(page);
  await page.goBack();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(line(page)).toBeVisible();

  await openSheet(page);
  await sheet(page).getByRole("button", { name: phone(testInfo) ? "Back" : "Close", exact: true }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  // Opening pushed one entry and closing replaced it (D21), so Back now leaves the sheet shut.
  expect(await historyLength()).toBe(startLength + 1);
  await page.goBack();
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(sheet(page)).toHaveCount(0);
  expect(state.categoryMovesAcknowledges).toEqual([]);
  expectNothingUnexpected(state);
});

test("with nothing updated the address still opens the sheet, which says so; no line, no header button", async ({ page }) => {
  const state = await openStep(page, {}, `${SETUP_PATH}?sheet=updated`);
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByTestId("updated-products-empty")).toHaveText("Nothing here. Card Shellz hasn't updated any of your products.");
  await expect(gotItAll(page)).toHaveCount(0);
  await expect(line(page)).toHaveCount(0);
  await expect(banner(page)).toHaveCount(0);
  expectNothingUnexpected(state);
});

test("a failed mount read hides the line with no banner; the sheet says so with Try again, and the line follows the read", async ({ page }) => {
  const state = await openUpdatedStep(page);
  await expect(line(page)).toBeVisible();
  // The next page-0 read (the one the step makes on reload) fails; the stub answers every later one.
  let armed = false;
  await failNextRead(page, UPDATED_PATH, () => armed);
  armed = true;
  // The failed read never reaches the stub's log (`failNextRead`): the page's own network says when the 500 landed.
  const refused = page.waitForResponse((response) => new URL(response.url()).pathname === UPDATED_PATH && response.status() === 500);
  await page.reload();
  await expect(page.getByTestId("listing-settings-product-2001")).toBeVisible();
  await expect(strip(page)).toContainText("has your own text");
  await refused;
  // Judged once the failure landed: hidden, and no banner (UX-M9).
  await expect(line(page)).toHaveCount(0);
  await expect(banner(page)).toHaveCount(0);

  // The sheet's own read fails too: its words and Try again; the read then answers, and the line comes back with it.
  let armedAgain = false;
  await failNextRead(page, UPDATED_PATH, () => armedAgain);
  armedAgain = true;
  await stripCheck(page).click();
  await expect(sheet(page)).toBeVisible();
  const problem = sheet(page).getByTestId("updated-products-read-problem");
  await expect(problem).toContainText("Couldn't check what Card Shellz updated. Try again.");
  await expect(gotItAll(page)).toHaveCount(0);
  await problem.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(gotItAll(page)).toHaveText("Got it for all 4");
  await expect(sheetRow(page, 2_001)).toBeVisible();
  await expect(line(page)).toContainText("Card Shellz moved 4 products to another category.");
  expect(state.categoryMovesAcknowledges).toEqual([]);
  expectNothingUnexpected(state);
});

test("while more than 10,000 sizes are chosen the address can't open the sheet and the line stays hidden: the banner explains", async ({ page }) => {
  const state = await openStep(page, { ...updatedState(), tooLarge: true }, `${SETUP_PATH}?sheet=updated`);
  await expect(banner(page)).toContainText("You've chosen more than 10,000 sizes.");
  // Hidden, never "Checking…" without end (plan 3.7, D18): the banner is what the vendor reads.
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByText("Checking what Card Shellz updated…")).toHaveCount(0);
  await expect(line(page)).toHaveCount(0);
  // At most the one read made before the summary answered, refused as too large.
  expect(readsOf(state, "GET", UPDATED_PATH).length).toBeLessThanOrEqual(1);
  expect(state.categoryMovesAcknowledges).toEqual([]);
  expectNothingUnexpected(state);
});

test("Got it over another editor's unsaved change asks first: Keep editing sends nothing, Discard and leave sends it at once", async ({ page }) => {
  const state = await openUpdatedStep(page);
  const dialog = page.getByRole("alertdialog");
  // Back closes the drawer and keeps its size price (D21): the step's one draft is Penny Sleeves'.
  await openProductRow(page, 2_001, "Penny Sleeves");
  await exactBox(page, "Pack of 100 · UPD-2001-100").fill("9.99");
  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("Not saved · 1 change in Penny Sleeves");

  // The sheet opens without asking (it holds no change); the Got it asks (D16).
  await openSheet(page);
  await gotIt(page, "Team Bags").click();
  await expect(dialog).toContainText("You have 1 change that isn't saved.");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.categoryMovesAcknowledges).toEqual([]);
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("Not saved · 1 change in Penny Sleeves");
  await expect(sheetRow(page, 2_002)).toBeVisible();

  // Discard and leave drops the change and sends the Got it the vendor pressed, with no second press.
  await gotIt(page, "Team Bags").click();
  await dialog.getByRole("button", { name: "Discard and leave" }).click();
  await expect(sheet(page).getByRole("status").filter({ hasText: "Done." })).toBeVisible();
  expect(state.categoryMovesAcknowledges).toEqual([{ method: "POST", path: ACKNOWLEDGE_PATH, body: {
    idempotencyKey: KEY("ls-moves"), items: [{ productId: 2_002, shownCategoryId: TOPLOADERS }],
  } }]);
  await expect(sheetRow(page, 2_002)).toHaveCount(0);
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("All saved");
  expect(state.priceWrites).toEqual([]);
  expectNothingUnexpected(state);
});

test("a Got it refused as too many in a minute goes again with the same key when pressed again; another product gets a new key", async ({ page }) => {
  const state = await openUpdatedStep(page, { ...updatedState(), categoryMovesAcknowledgeAnswers: [
    { status: 429, code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED", message: "Slow down." },
  ] });
  await openSheet(page);
  await gotIt(page, "Penny Sleeves").click();
  await expect(sheet(page).getByRole("alert").filter({ hasText: "Too many saves in a minute. Wait a moment and try again." })).toBeVisible();
  expect(state.categoryMovesAcknowledges).toHaveLength(1);
  expect(state.categoryMarks[productKey(STORE, PENNY.productId)]).toBe(SLEEVES);

  // Nothing is locked (plan 3.3): the same press goes out again under the key it had (D5), and is saved once.
  await expect(gotIt(page, "Penny Sleeves")).toBeEnabled();
  await gotIt(page, "Penny Sleeves").click();
  await expect(sheet(page).getByRole("status").filter({ hasText: "Done." })).toBeVisible();
  expect(state.categoryMovesAcknowledges).toHaveLength(2);
  expect(state.categoryMovesAcknowledges[1].body).toEqual(state.categoryMovesAcknowledges[0].body);
  expect(state.categoryMarks[productKey(STORE, PENNY.productId)]).toBe(TOPLOADERS);
  await expect(sheetRow(page, 2_001)).toHaveCount(0);

  // Another product is another request: a new key.
  await gotIt(page, "Team Bags").click();
  await expect(sheetRow(page, 2_002)).toHaveCount(0);
  expect(state.categoryMovesAcknowledges).toHaveLength(3);
  expect(state.categoryMovesAcknowledges[2].body.items).toEqual([{ productId: 2_002, shownCategoryId: TOPLOADERS }]);
  expect(state.categoryMovesAcknowledges[2].body.idempotencyKey).not.toBe(state.categoryMovesAcknowledges[0].body.idempotencyKey);
  expectNothingUnexpected(state);
});

test("sixty moved products page 50 at a time: Previous and Next read the page asked for", async ({ page }, testInfo) => {
  test.skip(phone(testInfo), "a phone loads more instead (the next journey)");
  const state = await openStep(page, sixtyMovedState());
  await expect(line(page)).toContainText("Card Shellz moved 60 products to another category.");
  await openSheet(page);
  await expect(gotItAll(page)).toHaveText("Got it for all 60");
  await expect(sheet(page).locator("[data-testid^='updated-product-']")).toHaveCount(50);
  const paging = sheet(page).getByTestId("updated-products-paging");
  await expect(paging).toContainText("1–50 of 60");
  await expect(paging.getByRole("button", { name: "Previous" })).toBeDisabled();
  await paging.getByRole("button", { name: "Next" }).click();
  await expect(paging).toContainText("51–60 of 60");
  await expect(sheet(page).locator("[data-testid^='updated-product-']")).toHaveCount(10);
  await expect(sheetRow(page, 1_051)).toContainText("Moved from Sleeves to Toploaders.");
  expect(readsOf(state, "GET", UPDATED_PATH).map((read) => read.search)).toEqual(["?page=0", "?page=0", "?page=1"]);
  await expect(paging.getByRole("button", { name: "Next" })).toBeDisabled();
  await paging.getByRole("button", { name: "Previous" }).click();
  await expect(paging).toContainText("1–50 of 60");
  await expect(sheet(page).locator("[data-testid^='updated-product-']")).toHaveCount(50);
  expectNothingUnexpected(state);
});

test("on a phone the sheet is full screen with no sideways scroll, Got it is big enough to press, and Load more reads the next page", async ({ page }, testInfo) => {
  test.skip(!phone(testInfo), "phone layout only");
  const state = await openStep(page, sixtyMovedState());
  await expect(line(page)).toContainText("Card Shellz moved 60 products to another category.");
  await openSheet(page);
  await expectSheetLayout(page, testInfo, sheet(page));
  await expectNoHorizontalScroll(page);
  await expect(sheet(page).locator("[data-testid^='updated-product-']")).toHaveCount(50);
  const firstGotIt = gotIt(page, "Penny Sleeves 0001");
  expect((await firstGotIt.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(sheet(page).getByTestId("updated-products-paging")).toHaveCount(0);
  const loadMore = sheet(page).getByRole("button", { name: "Load more", exact: true });
  await loadMore.scrollIntoViewIfNeeded();
  await loadMore.click();
  await expect(sheet(page).locator("[data-testid^='updated-product-']")).toHaveCount(60);
  await expect(loadMore).toHaveCount(0);
  expect(readsOf(state, "GET", UPDATED_PATH).map((read) => read.search)).toEqual(["?page=0", "?page=0", "?page=1"]);
  await expectNoHorizontalScroll(page);
  // Got it on the first page with both loaded: every later product moves up a page as the pages are read again one
  // by one, and each is listed once.
  await gotIt(page, "Penny Sleeves 0001").click();
  await expect(sheet(page).getByRole("status").filter({ hasText: "Done." })).toBeVisible();
  await expect(sheetRow(page, 1_001)).toHaveCount(0);
  await expect(sheet(page).locator("[data-testid^='updated-product-']")).toHaveCount(59);
  const ids = await sheet(page).locator("[data-testid^='updated-product-']").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-testid")));
  expect(new Set(ids).size).toBe(59);
  await expect(gotItAll(page)).toHaveText("Got it for all 59");
  // Got it on the second page sends that product's shown category and reads both pages again.
  await gotIt(page, "Team Bags 0060").click();
  await expect(sheetRow(page, 1_060)).toHaveCount(0);
  expect(state.categoryMovesAcknowledges.map((write) => write.body.items)).toEqual([
    [{ productId: 1_001, shownCategoryId: TOPLOADERS }], [{ productId: 1_060, shownCategoryId: TOPLOADERS }],
  ]);
  expect(state.categoryMovesAcknowledges.map((write) => write.body.idempotencyKey)).toEqual([KEY("ls-moves"), KEY("ls-moves")]);
  await expect(gotItAll(page)).toHaveText("Got it for all 58");
  expectNothingUnexpected(state);
});
