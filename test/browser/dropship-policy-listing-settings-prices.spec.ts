import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { liveListingSettingsSummary, defaultStubState, shot, sizeKey, type ProductFixture, type StubState } from "./dropship-policy-catalog-stubs";
import {
  KEY,
  LISTINGS,
  SETUP_PATH,
  STORE,
  drawer,
  exactBox,
  expectGatedReads,
  expectInView,
  expectNoHorizontalScroll,
  expectNothingUnexpected,
  expectSheetLayout,
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
 * "Give these sizes a price" (Listing settings PR 10, part 10f; plan 9.1-9.3, 9.5-9.7): every chosen size that
 * can't be priced in one sheet at `?sheet=give-prices`, each with an Exact price box, saved in one W8 request
 * (`PUT …/listing-settings/size-prices`) of at most 200 rows, all or none (D12), each with the price revision
 * its row was read with (D6). The stub checks every request against the shared contract, compares-and-sets
 * each size, refuses a price outside a Card Shellz limit, and keys the writes; every journey ends with nothing
 * unexpected asked and no page error. Desktop and phone.
 */

const PRICES_PATH = `${LISTINGS}/listing-settings/prices`;
const SIZE_PRICES_PATH = `${LISTINGS}/listing-settings/size-prices`;

/** A size Card Shellz has no retail price for: with no store price it can't be priced until it has an exact price. */
function unpriced(productVariantId: number, sizeName: string, sku: string | null, costCents: number | null) {
  return { productVariantId, sizeName, sku, retailCents: null, costCents, stockUnits: 12 };
}

const PENNY: ProductFixture = { productId: 4_001, productName: "Penny Sleeves", productSku: "PSL", category: "Sleeves",
  sizes: [unpriced(2_001, "Pack of 100", "PSL-100", 210), unpriced(2_002, "Pack of 500", "PSL-500", 610)] };
const TEAM: ProductFixture = { productId: 4_002, productName: "Team Bags", productSku: "TB", category: "Sleeves",
  sizes: [unpriced(2_003, "Case of 1,000", null, null)] };
const TOP: ProductFixture = { productId: 4_003, productName: "Toploaders 35pt", productSku: "TL", category: "Toploaders",
  sizes: [unpriced(2_004, "Pack of 25", "TL-25", 300)] };
/** Priced from its retail price: never in the sheet. */
const PRICED: ProductFixture = { productId: 4_004, productName: "Card Cases", productSku: "CC", category: "Cases",
  sizes: [{ productVariantId: 2_005, sizeName: "Single", sku: "CC-1", retailCents: 1_299, costCents: 700, stockUnits: 4 }] };

/** Four sizes that can't be priced (one with a Card Shellz floor of $5.00) and one that can. A new copy for each journey. */
function pricesState(): Partial<StubState> {
  return {
    catalog: structuredClone([PENNY, TEAM, TOP, PRICED]),
    sizePriceLimits: { [sizeKey(STORE, 2_004)]: { floorCents: 500 } },
  };
}

/** `count` products of one size each, none priceable, ids 5001 on (sizes 3001 on). */
function manyUnpriced(count: number): ProductFixture[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return { productId: 5_000 + n, productName: `Binder Page ${String(n).padStart(3, "0")}`, productSku: `BP-${n}`, category: "Pages",
      sizes: [unpriced(3_000 + n, "Pack of 10", `BP-${n}-10`, 150)] };
  });
}

function sheet(page: Page) {
  return page.getByTestId("give-sizes-price-sheet");
}

function sheetFooter(page: Page) {
  return page.getByTestId("size-prices-footer");
}

function savePrices(page: Page) {
  return sheetFooter(page).getByRole("button", { name: "Save prices", exact: true });
}

function sizeRow(page: Page, productVariantId: number) {
  return sheet(page).getByTestId(`size-price-${productVariantId}`);
}

function box(page: Page, product: string, size: string) {
  return sheet(page).getByLabel(`Exact price for ${product}, ${size}`, { exact: true });
}

function bar(page: Page) {
  return page.getByTestId("catalog-action-summary");
}

function givePricesButton(page: Page) {
  return page.getByTestId("listing-settings-prices-tab").getByRole("button", { name: "Give these sizes a price", exact: true });
}

/** The Prices tab under Show = "Can't be priced", with the sheet's button. */
async function showCannotPrice(page: Page) {
  await page.getByRole("tab", { name: /^Prices/ }).click();
  await page.getByTestId("listing-settings-prices-tab").getByLabel("Show").selectOption({ label: "Can't be priced" });
  await expect(givePricesButton(page)).toBeVisible();
}

/** Opens the sheet from the Prices tab's button and waits for its rows. */
async function openSheet(page: Page) {
  await showCannotPrice(page);
  await givePricesButton(page).click();
  await expect(sheet(page)).toBeVisible();
  await expect(page).toHaveURL(`${SETUP_PATH}?sheet=give-prices`);
  await expect(sheet(page).getByTestId("size-prices-rows")).toBeVisible();
}

/** "● Not saved · 3 prices" on a wide screen, "● Not saved · 3" on a phone. */
function notSaved(testInfo: TestInfo, count: number): string {
  return phone(testInfo) ? `● Not saved · ${count}` : `● Not saved · ${count} ${count === 1 ? "price" : "prices"}`;
}

test("three sizes get a price in one request from the Prices tab's button; the saved sizes leave the list and the views read again (9.3, D1, D9, D12)", async ({ page }, testInfo) => {
  const state = await openStep(page, pricesState());
  await openSheet(page);
  await expect(sheet(page)).toContainText("Give these sizes a price");
  await expect(sheet(page)).toContainText("These sizes can't be listed until they have a price.");
  // Every size that can't be priced, each once, with its product, size and cost; the priced one is not listed.
  await expect(sheet(page).locator("[data-testid^='size-price-']")).toHaveCount(4);
  await expect(sizeRow(page, 2_001)).toContainText("Penny Sleeves");
  await expect(sizeRow(page, 2_001)).toContainText("Pack of 100 · PSL-100");
  // The cost under the "Your cost" column on a wide screen, "Your cost $2.10" on a phone card.
  await expect(sizeRow(page, 2_001)).toContainText("$2.10");
  await expect(sizeRow(page, 2_003)).toContainText("Case of 1,000");
  await expect(sizeRow(page, 2_005)).toHaveCount(0);
  // The sheet reads the Prices tab's own "Can't be priced" pages (the same key: one read for the tab, D18), fresh once it
  // opens (an open editor's read, D10: the rows' revisions are what the save compares, D6): two reads of page 0, no other.
  const pageZero = () => readsOf(state, "GET", PRICES_PATH).filter((read) => read.search === "?search=&show=cannot_price&page=0").length;
  await expect.poll(pageZero).toBe(2);
  await expect(bar(page)).toHaveText("All saved");

  await box(page, "Penny Sleeves", "Pack of 100").fill("3.49");
  await expect(sizeRow(page, 2_001)).toContainText("$3.49 is $1.39 over your cost, before eBay fees and shipping.");
  await box(page, "Penny Sleeves", "Pack of 500").fill("4.5");
  await expect(sizeRow(page, 2_002)).toContainText("Below your cost: you'd lose $1.60 on each sale. You can still save it.");
  await box(page, "Team Bags", "Case of 1,000").fill("12");
  await expect(sheetFooter(page)).toContainText(notSaved(testInfo, 3));
  await expect(bar(page)).toHaveText("Not saved · 3 changes in Give these sizes a price");
  await shot(page, testInfo, "listing-settings-give-prices");

  await savePrices(page).click();
  await expect(sheetFooter(page)).toContainText("Saved");
  // One request, the typed sizes as integer cents ascending, each with the revision its row was read with (none yet).
  expect(state.sizePricesWrites).toEqual([{ method: "PUT", path: SIZE_PRICES_PATH, body: { idempotencyKey: KEY("ls-size-prices"), rows: [
    { productVariantId: 2_001, priceCents: 349, expectedRevisionId: null },
    { productVariantId: 2_002, priceCents: 450, expectedRevisionId: null },
    { productVariantId: 2_003, priceCents: 1_200, expectedRevisionId: null },
  ] } }]);
  expect(state.sizePrices[sizeKey(STORE, 2_001)]).toMatchObject({ pricingMode: "fixed", overridePriceCents: 349 });
  expect(state.sizePrices[sizeKey(STORE, 2_004)]).toBeUndefined();
  // D9: the pages are read again, so the saved sizes leave the list; the products and the summary too.
  const putAt = state.reads.findIndex((read) => read.method === "PUT" && read.path === SIZE_PRICES_PATH);
  await expect.poll(() => state.reads.slice(putAt + 1).filter((read) => read.method === "GET" && read.path === PRICES_PATH).length).toBeGreaterThanOrEqual(1);
  await expect.poll(() => state.reads.slice(putAt + 1).filter((read) => read.method === "GET" && read.path === `${LISTINGS}/listing-settings/summary`).length).toBeGreaterThanOrEqual(1);
  await expect(sizeRow(page, 2_001)).toHaveCount(0);
  await expect(sizeRow(page, 2_003)).toHaveCount(0);
  await expect(sizeRow(page, 2_004)).toBeVisible();
  await expect(sheetFooter(page)).not.toContainText("Not saved");
  await expect(bar(page)).toHaveText("All saved");
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("a price outside a Card Shellz limit is refused with the row marked and the footer's words, nothing saved; a price inside it then saves under a new key (9.5)", async ({ page }) => {
  const state = await openStep(page, pricesState());
  await openSheet(page);
  await box(page, "Toploaders 35pt", "Pack of 25").fill("2.00");
  // The drawer's note while typing: the limit the Prices row lists.
  await expect(sizeRow(page, 2_004)).toContainText("Card Shellz lists this size at $5.00 or more.");
  await savePrices(page).click();
  await expect(sheetFooter(page)).toContainText("1 size's price would be outside what Card Shellz allows. Enter prices Card Shellz allows.");
  await expect(sizeRow(page, 2_004)).toHaveAttribute("data-outside-limit", "true");
  await expect(sizeRow(page, 2_004)).toContainText("Outside a Card Shellz price limit");
  expect(state.sizePricesWrites).toHaveLength(1);
  expect(state.sizePrices[sizeKey(STORE, 2_004)]).toBeUndefined();
  await expect(box(page, "Toploaders 35pt", "Pack of 25")).toHaveValue("2.00");

  // A price typed again is no longer the one refused: its mark goes before the next save.
  await box(page, "Toploaders 35pt", "Pack of 25").fill("6.00");
  await expect(sizeRow(page, 2_004)).not.toHaveAttribute("data-outside-limit", "true");
  await expect(sizeRow(page, 2_004)).not.toContainText("Outside a Card Shellz price limit");
  await expect(box(page, "Toploaders 35pt", "Pack of 25")).not.toHaveAttribute("aria-invalid", "true");
  await savePrices(page).click();
  await expect(sheetFooter(page)).toContainText("Saved");
  expect(state.sizePricesWrites).toHaveLength(2);
  expect(state.sizePricesWrites[1].body).toEqual({ idempotencyKey: KEY("ls-size-prices"), rows: [{ productVariantId: 2_004, priceCents: 600, expectedRevisionId: null }] });
  // A refusal means the next try gets a new key (D5).
  expect(state.sizePricesWrites[1].body.idempotencyKey).not.toBe(state.sizePricesWrites[0].body.idempotencyKey);
  expect(state.sizePrices[sizeKey(STORE, 2_004)]).toMatchObject({ pricingMode: "fixed", overridePriceCents: 600 });
  await expect(sizeRow(page, 2_004)).toHaveCount(0);
  expectNothingUnexpected(state);
});

test("sizes priced in another window are a conflict: Load latest drops the one that left the list and keeps the rest with their new revisions; never a conflict's actualRevisionId (9.5, CC-C5)", async ({ page }, testInfo) => {
  const state = await openStep(page, pricesState());
  await openSheet(page);
  await box(page, "Penny Sleeves", "Pack of 100").fill("3.49");
  await box(page, "Penny Sleeves", "Pack of 500").fill("7.99");
  await box(page, "Team Bags", "Case of 1,000").fill("12.00");
  // Another window: Pack of 100 got an exact price (it leaves the list); Pack of 500 was set to follow the store's pricing
  // (a new revision, still no price, so it stays listed).
  state.sizePrices[sizeKey(STORE, 2_001)] = { revisionId: 50, pricingMode: "fixed", overridePriceCents: 500 };
  state.sizePrices[sizeKey(STORE, 2_002)] = { revisionId: 51, pricingMode: "inherit", overridePriceCents: null };
  await savePrices(page).click();
  await expect(sheetFooter(page)).toContainText("2 sizes' prices changed in another window.");
  // The step reads its views again after every settled save (the catalog page's onSaveSettled), so the size priced
  // elsewhere has already left the list; the one still listed is marked, the untouched one is not. The typed prices
  // stay in the draft (3) until Load latest settles them.
  await expect(sizeRow(page, 2_001)).toHaveCount(0);
  await expect(sizeRow(page, 2_002)).toHaveAttribute("data-conflict", "true");
  await expect(sizeRow(page, 2_003)).not.toHaveAttribute("data-conflict", "true");
  await expect(sheetFooter(page)).toContainText(notSaved(testInfo, 3));
  await expect(sheet(page).getByTestId("size-prices-reload-line")).toHaveCount(0);
  expect(state.sizePricesWrites).toHaveLength(1);
  expect(state.sizePrices[sizeKey(STORE, 2_003)]).toBeUndefined();

  await sheetFooter(page).getByRole("button", { name: "Load latest and keep my changes" }).click();
  // The pages read again: the priced size left the list and the draft; the rest keep their text.
  await expect(sheet(page).getByTestId("size-prices-reload-line")).toHaveText("1 size left this list and wasn't saved.");
  await expect(sizeRow(page, 2_001)).toHaveCount(0);
  await expect(box(page, "Penny Sleeves", "Pack of 500")).toHaveValue("7.99");
  await expect(box(page, "Team Bags", "Case of 1,000")).toHaveValue("12.00");
  await expect(sheetFooter(page)).toContainText(notSaved(testInfo, 2));
  await expect(sheetFooter(page)).not.toContainText("changed in another window");

  await savePrices(page).click();
  await expect(sheetFooter(page)).toContainText("Saved");
  expect(state.sizePricesWrites).toHaveLength(2);
  // The revision from the page read again (51), never the conflict's `actualRevisionId`; a new key.
  expect(state.sizePricesWrites[1].body).toEqual({ idempotencyKey: KEY("ls-size-prices"), rows: [
    { productVariantId: 2_002, priceCents: 799, expectedRevisionId: 51 },
    { productVariantId: 2_003, priceCents: 1_200, expectedRevisionId: null },
  ] });
  expect(state.sizePricesWrites[1].body.idempotencyKey).not.toBe(state.sizePricesWrites[0].body.idempotencyKey);
  expect(state.sizePrices[sizeKey(STORE, 2_002)]).toMatchObject({ pricingMode: "fixed", overridePriceCents: 799 });
  expect(state.sizePrices[sizeKey(STORE, 2_001)]).toMatchObject({ revisionId: 50, overridePriceCents: 500 });
  expectNothingUnexpected(state);
});

test("a size no longer chosen is a conflict naming it: Load latest drops it with the line and keeps the rest, which then save under a new key (9.5)", async ({ page }, testInfo) => {
  const state = await openStep(page, pricesState());
  await openSheet(page);
  await box(page, "Penny Sleeves", "Pack of 100").fill("3.49");
  await box(page, "Team Bags", "Case of 1,000").fill("12.00");
  // Step 1 in another window: Pack of 100 is no longer chosen for the store.
  state.catalog[0].sizes = state.catalog[0].sizes.filter((size) => size.productVariantId !== 2_001);
  await savePrices(page).click();
  await expect(sheetFooter(page)).toContainText("This size isn't chosen any more. Load the list again.");
  // Save is not offered again for the same rows (the same size would be refused under every key): Load latest is the way.
  await expect(sheetFooter(page).getByRole("button", { name: "Load latest and keep my changes" })).toBeVisible();
  await expect(savePrices(page)).toHaveCount(0);
  await expect(sheetFooter(page)).toContainText(notSaved(testInfo, 2));
  // The step's re-read after the settled save already took the size off the list; the other typed price is unmarked.
  await expect(sizeRow(page, 2_001)).toHaveCount(0);
  await expect(sizeRow(page, 2_003)).not.toHaveAttribute("data-conflict", "true");
  expect(state.sizePricesWrites).toHaveLength(1);
  expect(state.sizePrices[sizeKey(STORE, 2_003)]).toBeUndefined();

  await sheetFooter(page).getByRole("button", { name: "Load latest and keep my changes" }).click();
  await expect(sheet(page).getByTestId("size-prices-reload-line")).toHaveText("1 size left this list and wasn't saved.");
  await expect(box(page, "Team Bags", "Case of 1,000")).toHaveValue("12.00");
  await expect(sheetFooter(page)).toContainText(notSaved(testInfo, 1));
  await savePrices(page).click();
  await expect(sheetFooter(page)).toContainText("Saved");
  expect(state.sizePricesWrites).toHaveLength(2);
  expect(state.sizePricesWrites[1].body).toEqual({ idempotencyKey: KEY("ls-size-prices"), rows: [{ productVariantId: 2_003, priceCents: 1_200, expectedRevisionId: null }] });
  expect(state.sizePricesWrites[1].body.idempotencyKey).not.toBe(state.sizePricesWrites[0].body.idempotencyKey);
  expect(state.sizePrices[sizeKey(STORE, 2_003)]).toMatchObject({ pricingMode: "fixed", overridePriceCents: 1_200 });
  expect(state.sizePrices[sizeKey(STORE, 2_001)]).toBeUndefined();
  expectNothingUnexpected(state);
});

test("a save whose answer was lost is checked again with the same key and body; Esc keeps the sheet meanwhile (D5, D7)", async ({ page }) => {
  const state = await openStep(page, { ...pricesState(), sizePricesWriteAnswers: ["drop"] });
  await openSheet(page);
  await box(page, "Penny Sleeves", "Pack of 100").fill("3.49");
  await savePrices(page).click();
  await expect(sheetFooter(page)).toContainText("We couldn't confirm your save.");
  await expect(sheetFooter(page)).not.toContainText("Nothing was saved");
  // Locked until it is checked: the boxes can't change, Discard is off, Esc keeps the sheet.
  await expect(box(page, "Penny Sleeves", "Pack of 500")).toHaveAttribute("readonly", "");
  await expect(sheetFooter(page).getByRole("button", { name: "Discard" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeVisible();
  await sheetFooter(page).getByRole("button", { name: "Check again" }).click();
  await expect(sheetFooter(page)).toContainText("Saved");
  expect(state.sizePricesWrites).toHaveLength(2);
  expect(state.sizePricesWrites[1].body).toEqual(state.sizePricesWrites[0].body);
  expect(state.sizePricesWrites[0].body).toEqual({ idempotencyKey: KEY("ls-size-prices"), rows: [{ productVariantId: 2_001, priceCents: 349, expectedRevisionId: null }] });
  await expect(sizeRow(page, 2_001)).toHaveCount(0);
  expectNothingUnexpected(state);
});

test("the strip's Fix on a can't-be-priced line with no product opens the sheet at ?sheet=give-prices (UX-M2, D21)", async ({ page }) => {
  // The summary groups the sizes that can't be priced into one line with no product (the shared contract allows it);
  // a one-product line keeps the drawer (the drawer spec's Fix journey).
  const initial = pricesState();
  const live = liveListingSettingsSummary({ ...defaultStubState(), ...initial }, STORE);
  const items = live.attention.items.filter((item) => item.code !== "size_cannot_be_priced");
  const summary = { ...live, attention: { items: [{ code: "size_cannot_be_priced", count: 4, productId: null, productName: null }, ...items], total: items.length + 1 } };
  const state = await openStep(page, { ...initial, summaries: { [STORE]: summary } });
  const strip = page.getByTestId("listing-settings-attention");
  const line = strip.locator("li[data-code='size_cannot_be_priced']");
  await expect(line).toContainText("A product can't be listed: a size can't be priced.");
  await line.getByRole("button", { name: "Fix" }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(page).toHaveURL(`${SETUP_PATH}?sheet=give-prices`);
  await expect(sheet(page).locator("[data-testid^='size-price-']")).toHaveCount(4);
  await expect(drawer(page)).toHaveCount(0);
  expect(state.sizePricesWrites).toEqual([]);
  expectNothingUnexpected(state);
});

test("over 200 typed prices Save is off with the words; 200 save in one request, with Load more keeping the pages as one list (D12, 9.3)", async ({ page }, testInfo) => {
  test.skip(phone(testInfo), "Typing 201 prices is checked on a wide screen only; the phone journey covers Load more.");
  // 201 boxes typed one by one over a growing list: the bulk spec's budget for its heaviest journey.
  test.setTimeout(90_000);
  const state = await openStep(page, { catalog: manyUnpriced(201) });
  await openSheet(page);
  const fillPage = async (loaded: number) => {
    for (let n = (loaded - 1) * 50 + 1; n <= Math.min(loaded * 50, 201); n += 1) await box(page, `Binder Page ${String(n).padStart(3, "0")}`, "Pack of 10").fill("2.49");
  };
  // Four more pages on a wide screen too (9.3): one list, each size once; each page's boxes typed before the next loads.
  for (let loaded = 1; loaded < 5; loaded += 1) {
    await expect(sheet(page).locator("[data-testid^='size-price-']")).toHaveCount(loaded * 50);
    await fillPage(loaded);
    await sheet(page).getByTestId("size-prices-load-more").click();
  }
  await expect(sheet(page).locator("[data-testid^='size-price-']")).toHaveCount(201);
  await expect(sheet(page).getByTestId("size-prices-load-more")).toHaveCount(0);
  await fillPage(5);
  await expect(sheetFooter(page)).toContainText("● Not saved · 201 prices");
  await expect(sheetFooter(page)).toContainText("Save up to 200 prices at a time.");
  await expect(savePrices(page)).toBeDisabled();
  expect(state.sizePricesWrites).toEqual([]);
  // One box emptied: 200, Save on; one request of 200 rows.
  await box(page, "Binder Page 201", "Pack of 10").fill("");
  await expect(sheetFooter(page)).toContainText("● Not saved · 200 prices");
  await expect(sheetFooter(page)).not.toContainText("Save up to 200 prices at a time.");
  await savePrices(page).click();
  await expect(sheetFooter(page)).toContainText("Saved");
  expect(state.sizePricesWrites).toHaveLength(1);
  expect(state.sizePricesWrites[0].body.rows).toHaveLength(200);
  expect(Object.keys(state.sizePrices)).toHaveLength(200);
  expect(state.sizePrices[sizeKey(STORE, 3_201)]).toBeUndefined();
  expectNothingUnexpected(state);
});

test("Back closes the sheet and keeps the typed prices; opening it again shows them; × asks first and replaces the address (D21)", async ({ page }, testInfo) => {
  const state = await openStep(page, pricesState());
  const historyLength = () => page.evaluate(() => window.history.length);
  const startLength = await historyLength();
  await openSheet(page);
  expect(await historyLength()).toBe(startLength + 1);
  await box(page, "Penny Sleeves", "Pack of 100").fill("3.49");
  await expect(bar(page)).toHaveText("Not saved · 1 change in Give these sizes a price");

  await page.goBack();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  // The typed price is kept in the step's one draft (D16), so the bar still names it.
  await expect(bar(page)).toHaveText("Not saved · 1 change in Give these sizes a price");
  expect(state.sizePricesWrites).toEqual([]);

  await givePricesButton(page).click();
  await expect(sheet(page)).toBeVisible();
  await expect(box(page, "Penny Sleeves", "Pack of 100")).toHaveValue("3.49");
  await expect(sheetFooter(page)).toContainText(notSaved(testInfo, 1));
  // × with a typed price asks first; Keep editing keeps it, Discard and leave drops it and closes in place.
  const dialog = page.getByRole("alertdialog");
  await sheet(page).getByRole("button", { name: phone(testInfo) ? "Back" : "Close" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(box(page, "Penny Sleeves", "Pack of 100")).toHaveValue("3.49");
  await sheet(page).getByRole("button", { name: phone(testInfo) ? "Back" : "Close" }).click();
  await dialog.getByRole("button", { name: "Discard and leave" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(bar(page)).toHaveText("All saved");
  // Replaced, not pushed: Back goes before the sheet was first opened and leaves it shut.
  await page.goBack();
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(sheet(page)).toHaveCount(0);
  // Focus is back on the button that opened the sheet (plan 3.4).
  await expect(givePricesButton(page)).toBeFocused();
  expect(state.sizePricesWrites).toEqual([]);
  expectNothingUnexpected(state);
});

test("over another editor's unsaved change the first typed price asks first: Keep editing types nothing, Discard and leave drops that change and keeps the price (D16)", async ({ page }, testInfo) => {
  const state = await openStep(page, pricesState());
  // A change held in the product drawer, kept by browser Back (the step's leave-guard journey).
  await openProductRow(page, PRICED.productId, PRICED.productName);
  await exactBox(page, "Single · CC-1").fill("15.00");
  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  await expect(bar(page)).toHaveText(`Not saved · 1 change in ${PRICED.productName}`);

  await openSheet(page);
  const dialog = page.getByRole("alertdialog");
  await box(page, "Penny Sleeves", "Pack of 100").fill("3.49");
  await expect(dialog).toContainText("You have 1 change that isn't saved.");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog).toHaveCount(0);
  // Nothing typed: the drawer's change is still the step's one draft.
  await expect(box(page, "Penny Sleeves", "Pack of 100")).toHaveValue("");
  await expect(bar(page)).toHaveText(`Not saved · 1 change in ${PRICED.productName}`);
  await expect(sheetFooter(page)).not.toContainText("Not saved");

  await box(page, "Penny Sleeves", "Pack of 100").fill("3.49");
  await dialog.getByRole("button", { name: "Discard and leave" }).click();
  await expect(dialog).toHaveCount(0);
  // The typed price went in from the draft the provider opened; the drawer's change is gone.
  await expect(box(page, "Penny Sleeves", "Pack of 100")).toHaveValue("3.49");
  await expect(sheetFooter(page)).toContainText(notSaved(testInfo, 1));
  await expect(bar(page)).toHaveText("Not saved · 1 change in Give these sizes a price");
  expect(state.sizePricesWrites).toEqual([]);
  expect(state.priceWrites).toEqual([]);
  expectNothingUnexpected(state);
});

test("on a phone the sheet fills the screen, Load more adds the next page to the one list, and Save stays in view with no sideways scroll", async ({ page }, testInfo) => {
  test.skip(!phone(testInfo), "The phone layout (below 640 px) only.");
  const state = await openStep(page, { catalog: manyUnpriced(60) });
  await openSheet(page);
  await expectSheetLayout(page, testInfo, sheet(page));
  await expect(sheet(page).locator("[data-testid^='size-price-']")).toHaveCount(50);
  await sheet(page).getByTestId("size-prices-load-more").click();
  await expect(sheet(page).locator("[data-testid^='size-price-']")).toHaveCount(60);
  await expect(sheet(page).getByTestId("size-prices-load-more")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await box(page, "Binder Page 060", "Pack of 10").fill("2.49");
  await expect(sheetFooter(page)).toContainText("● Not saved · 1");
  await expectInView(page, savePrices(page));
  await shot(page, testInfo, "listing-settings-give-prices-phone");
  await savePrices(page).click();
  await expect(sheetFooter(page)).toContainText("Saved");
  expect(state.sizePricesWrites).toHaveLength(1);
  expect(state.sizePricesWrites[0].body.rows).toEqual([{ productVariantId: 3_060, priceCents: 249, expectedRevisionId: null }]);
  expectNothingUnexpected(state);
});
