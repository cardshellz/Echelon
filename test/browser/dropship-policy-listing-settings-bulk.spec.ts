import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { ProductListingSettingValues } from "../../shared/dropship/listing-setting-values";
import { calculateRulePrice, type PricingRecipe } from "../../shared/dropship/pricing-rules";
import {
  SAVED_PRICING_RULES,
  bulkCatalog,
  listingSetupWithAnotherShippingPolicy,
  productKey,
  shot,
  sizeKey,
  type StubState,
  type WriteAnswer,
} from "./dropship-policy-catalog-stubs";
import {
  KEY,
  LISTINGS,
  SETUP_PATH,
  STORE,
  banner,
  drawer,
  exactBox,
  expectInView,
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
 * "Set for selected" (Listing settings PR 10, part 10c; plan 6.3-6.6): the vendor ticks products on
 * the Products tab (or "Select all N" that match the search and filter), presses Set for selected,
 * and sets one change for all of them in one Save (W6). The sheet sits in the page address
 * (`?sheet=bulk`), reads the products' ids and revisions when it opens (D6), and closes after a save
 * with the ticks kept (D22). Every save is checked against the shared contract by the stub (ids and
 * text only, never a price; compare-and-set on every product's revision; keyed), and every journey
 * ends with nothing unexpected asked and no page error. Desktop and phone.
 *
 * From 10d (plan 7.7) the sheet's Price row: the ticked products' price through the W7 check, whose
 * rows replace the sheet's (every price the server's) and whose Save applies it; Clear exact prices
 * too; a check refused as too large; a check already applied under another key; a price change
 * discarded then a setting row saved (D2); a dropped apply checked again; a saved apply whose
 * re-read failed, then Reload.
 */

const IDS_PATH = `${LISTINGS}/listing-settings/products/ids`;
const BULK_PATH = `${LISTINGS}/listing-settings/products/bulk`;
const PRODUCTS_PATH = `${LISTINGS}/listing-settings/products`;
const BUSY = "DROPSHIP_LISTING_SETTINGS_BUSY";

/** The 312-product catalog's names: odd ids "Penny Sleeves 0001", even ones "Team Bags 0002" (bulkCatalog). */
function nameOf(n: number): string {
  return `${n % 2 === 0 ? "Team Bags" : "Penny Sleeves"} ${String(n).padStart(4, "0")}`;
}

const NO_VALUES: ProductListingSettingValues = {
  price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null,
  textAbove: null, textBelow: null, mainText: null,
};

/** Product 1002 with its own return policy at revision 7, the rest with none. A new object for each journey. */
function ownRows(): StubState["productSettings"] {
  return { [productKey(STORE, 1_002)]: { revisionId: 7, values: { ...NO_VALUES, returnPolicy: { id: "returns", name: "30-day returns" } } } };
}

/** Step 2 on a catalog of `count` products, with a second shipping policy to pick. */
function openBulkStep(page: Page, count = 312, initial: Partial<StubState> = {}, path = SETUP_PATH) {
  return openStep(page, { catalog: bulkCatalog(count), productSettings: ownRows(),
    listingSetups: { [STORE]: listingSetupWithAnotherShippingPolicy(STORE) }, ...initial }, path);
}

function tickBox(page: Page, n: number) {
  return page.getByRole("checkbox", { name: `Select ${nameOf(n)}`, exact: true });
}

function selectionBar(page: Page) {
  return page.getByTestId("listing-settings-selection-bar");
}

function setForSelected(page: Page) {
  return selectionBar(page).getByRole("button", { name: "Set for selected", exact: true });
}

/** The bar's line after a confirmed save ("Saved for 2 products. Still selected."); the tab's status region reads it out. */
function savedLine(page: Page) {
  return selectionBar(page).getByTestId("listing-settings-selection-saved");
}

function sheet(page: Page) {
  return page.getByTestId("bulk-settings-sheet");
}

function sheetFooter(page: Page) {
  return page.getByTestId("bulk-settings-footer");
}

/** The sheet's main button: "Save for 312 products", or "Save" on a phone. */
function sheetSave(page: Page) {
  return sheetFooter(page).getByRole("button", { name: /^Save( for [\d,]+ products?)?$/ });
}

function actionBar(page: Page) {
  return page.getByTestId("catalog-action-summary");
}

type RowKey = "shippingPolicy" | "returnPolicy" | "paymentPolicy" | "ebayCategory" | "storeShelf" | "descriptionTemplate";
const ROW_SETTING: Record<RowKey, string> = {
  shippingPolicy: "shipping policy", returnPolicy: "return policy", paymentPolicy: "payment policy",
  ebayCategory: "eBay category", storeShelf: "store shelf", descriptionTemplate: "description",
};

function sheetRow(page: Page, key: RowKey) {
  return sheet(page).getByTestId(`drawer-setting-${key}`);
}

function changeButton(page: Page, key: RowKey) {
  return sheetRow(page, key).getByRole("button", { name: `Change ${ROW_SETTING[key]} for the selected products`, exact: true });
}

function fieldEditor(page: Page, key: "shippingPolicy" | "returnPolicy" | "paymentPolicy" | "storeShelf" | "description") {
  return sheet(page).getByTestId(`drawer-field-editor-${key}`);
}

/** Ticks two products of the first page: 1001 (no own settings) and 1002 (its own row at revision 7). */
async function tickTwo(page: Page) {
  await tickBox(page, 1).check();
  await tickBox(page, 2).check();
  await expect(selectionBar(page)).toContainText("2 selected");
}

/** Opens the sheet from the bar; its ids read answers and the rows can be changed. */
async function openSheet(page: Page, title: string) {
  await setForSelected(page).click();
  await expect(sheet(page)).toBeVisible();
  await expect(page).toHaveURL(/[?&]sheet=bulk(&|$)/);
  await expect(sheet(page).getByRole("heading", { name: title })).toBeVisible();
  await expect(changeButton(page, "shippingPolicy")).toBeEnabled();
}

/** Picks a shipping policy in its row's editor and puts it in the draft with Done. */
async function pickShipping(page: Page, name: string) {
  await changeButton(page, "shippingPolicy").click();
  await expect(fieldEditor(page, "shippingPolicy").getByRole("radio", { name: "Leave as is" })).toBeChecked();
  await fieldEditor(page, "shippingPolicy").getByRole("radio", { name: new RegExp(`^${name}`) }).check();
  await fieldEditor(page, "shippingPolicy").getByRole("button", { name: "Done" }).click();
  await expect(fieldEditor(page, "shippingPolicy")).toHaveCount(0);
  await expect(sheetRow(page, "shippingPolicy")).toContainText(`→ ${name} · Not saved`);
}

function notSaved(testInfo: TestInfo, changes: number) {
  return phone(testInfo) ? `● Not saved · ${changes}` : `● Not saved · ${changes} ${changes === 1 ? "change" : "changes"}`;
}

test("two ticked products get one shipping policy in one Save, with the revisions the ids read gave; ticking never opens the drawer", async ({ page }, testInfo) => {
  const state = await openBulkStep(page);
  await expect(page.getByTestId("listing-settings-product-1001")).toBeVisible();
  await expect(selectionBar(page)).toHaveCount(0);
  await tickTwo(page);
  // Ticking never opens the drawer (plan 6.3).
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(tickBox(page, 1)).toBeChecked();
  await expect(tickBox(page, 3)).not.toBeChecked();
  expect(readsOf(state, "GET", IDS_PATH)).toEqual([]);

  await openSheet(page, "Set for 2 products");
  await expect(sheet(page)).toContainText("These become each product's own values.");
  // Ticks, not Select all: the ids read is every chosen product, which the ticks are picked from (D6).
  expect(readsOf(state, "GET", IDS_PATH).map((read) => read.search)).toEqual(["?search=&show=all"]);
  for (const key of Object.keys(ROW_SETTING) as RowKey[]) {
    await expect(sheetRow(page, key)).toContainText("Leave as is");
    await expect(changeButton(page, key)).toBeEnabled();
  }
  // The Price row (10d) sits first, reading Leave as is; W6 itself never carries a price (asserted on the POST below).
  await expect(priceRow(page)).toContainText("Leave as is");
  await expect(sheetSave(page)).toBeDisabled();

  await pickShipping(page, "USPS Priority Mail");
  await expect(changeButton(page, "shippingPolicy")).toBeFocused();
  await expect(sheetFooter(page)).toContainText(notSaved(testInfo, 1));
  await expect(actionBar(page)).toHaveText("Not saved · 1 change in Set for selected");
  await expect(sheetSave(page)).toHaveText(phone(testInfo) ? "Save" : "Save for 2 products");
  await shot(page, testInfo, "listing-settings-bulk-sheet");

  await sheetSave(page).click();
  await expect(sheet(page)).toHaveCount(0);
  expect(state.productsBulkWrites).toEqual([{ method: "POST", path: BULK_PATH, body: {
    idempotencyKey: KEY("ls-bulk"),
    products: [{ productId: 1_001, expectedRevisionId: null }, { productId: 1_002, expectedRevisionId: 7 }],
    patch: { shippingPolicy: { id: "priority" } },
  } }]);
  // Never a price key (D1).
  expect(JSON.stringify(state.productsBulkWrites[0].body)).not.toContain("price\"");
  // The sheet closes, the ticks stay and the bar says so (D22); the address loses the sheet in place.
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(savedLine(page)).toHaveText("Saved for 2 products. Still selected.");
  await expect(page.getByTestId("listing-settings-selection-live")).toHaveText("2 selected. Saved for 2 products. Still selected.");
  await expect(selectionBar(page)).toContainText("2 selected");
  await expect(tickBox(page, 1)).toBeChecked();
  await expect(tickBox(page, 2)).toBeChecked();
  await expect(setForSelected(page)).toBeFocused();
  // D9: the Products list and the ids read are read again after the POST; its answer is not shown.
  const postAt = state.reads.findIndex((read) => read.method === "POST" && read.path === BULK_PATH);
  await expect.poll(() => state.reads.slice(postAt + 1).filter((read) => read.method === "GET" && read.path === PRODUCTS_PATH).length).toBeGreaterThanOrEqual(1);
  expect(state.reads.slice(postAt + 1).filter((read) => read.method === "GET" && read.path === IDS_PATH)).toHaveLength(1);
  expect(state.productSettings[productKey(STORE, 1_001)].values.shippingPolicy).toEqual({ id: "priority", name: "USPS Priority Mail" });
  expect(state.productSettings[productKey(STORE, 1_002)].values.returnPolicy).toEqual({ id: "returns", name: "30-day returns" });
  await expect(actionBar(page)).toHaveText("All saved");
  expectNothingUnexpected(state);
});

test("Select all 312 sends every matching product; the shelf goes back to the default for all of them", async ({ page }, testInfo) => {
  const state = await openBulkStep(page);
  await expect(page.getByTestId("listing-settings-product-1050")).toBeVisible();
  // The header's box ticks the page; a phone has one box above the cards for every card shown.
  if (phone(testInfo)) await page.getByTestId("listing-settings-select-shown").getByRole("checkbox").check();
  else await page.getByRole("checkbox", { name: "Select every product on this page", exact: true }).check();
  await expect(selectionBar(page)).toContainText("50 selected");
  await expect(selectionBar(page)).toContainText(phone(testInfo) ? "All 50 shown are selected." : "All 50 on this page are selected.");
  await selectionBar(page).getByRole("button", { name: "Select all 312" }).click();
  await expect(selectionBar(page)).toContainText("312 selected");
  await expect(selectionBar(page).getByRole("button", { name: "Select all 312" })).toHaveCount(0);

  // Two more products match by the time the sheet opens: its count is the ids read's (CC-C26).
  state.catalog = bulkCatalog(314);
  await openSheet(page, "Set for 314 products");
  await expect(sheet(page)).toContainText("314 now match (was 312).");
  expect(readsOf(state, "GET", IDS_PATH).map((read) => read.search)).toEqual(["?search=&show=all"]);

  await changeButton(page, "storeShelf").click();
  await expect(fieldEditor(page, "storeShelf").getByRole("radio", { name: "Leave as is" })).toBeChecked();
  await fieldEditor(page, "storeShelf").getByRole("radio", { name: "Use default" }).check();
  await fieldEditor(page, "storeShelf").getByRole("button", { name: "Done" }).click();
  await expect(sheetRow(page, "storeShelf")).toContainText("→ Use default · Not saved");
  await expect(sheetSave(page)).toHaveText(phone(testInfo) ? "Save" : "Save for 314 products");
  await sheetSave(page).click();
  await expect(sheet(page)).toHaveCount(0);
  expect(state.productsBulkWrites).toHaveLength(1);
  const body = state.productsBulkWrites[0].body as { products: Array<{ productId: number; expectedRevisionId: number | null }>; patch: unknown };
  expect(body.patch).toEqual({ storeShelf: null });
  expect(body.products).toHaveLength(314);
  expect(body.products[0]).toEqual({ productId: 1_001, expectedRevisionId: null });
  expect(body.products[1]).toEqual({ productId: 1_002, expectedRevisionId: 7 });
  expect(body.products.at(-1)).toEqual({ productId: 1_314, expectedRevisionId: null });
  await expect(savedLine(page)).toHaveText("Saved for 314 products. Still selected.");
  // The bar counts what the save matched, as the sheet did.
  await expect(selectionBar(page)).toContainText("314 selected");
  expectNothingUnexpected(state);
});

test("too much text for this many products turns Save off with words before anything is sent", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  // 1,251 products x 24,000 bytes (two parts of 4,000 three-byte characters) is past the server's 30,000,000.
  const state = await openBulkStep(page, 1_251);
  if (phone(testInfo)) await page.getByTestId("listing-settings-select-shown").getByRole("checkbox").check();
  else await page.getByRole("checkbox", { name: "Select every product on this page", exact: true }).check();
  await selectionBar(page).getByRole("button", { name: "Select all 1,251" }).click();
  await openSheet(page, "Set for 1,251 products");

  const text = "€".repeat(4_000);
  await changeButton(page, "descriptionTemplate").click();
  const editor = fieldEditor(page, "description");
  for (const part of ["textAbove", "textBelow"] as const) {
    await editor.getByTestId(`drawer-description-${part}`).getByRole("radio", { name: "Own text" }).check();
    await editor.getByTestId(`drawer-description-${part}-text`).fill(text);
  }
  await expect(editor.getByTestId("drawer-description-mainText")).not.toContainText("Own text");
  await editor.getByRole("button", { name: "Done" }).click();
  await expect(editor).toHaveCount(0);
  await expect(sheetSave(page)).toBeDisabled();
  await expect(sheetFooter(page)).toContainText("Too much text for this many products. Choose fewer products, or set the text once on a category or as your store default.");

  // Half the text fits: Save is on again.
  await changeButton(page, "descriptionTemplate").click();
  await editor.getByTestId("drawer-description-textBelow").getByRole("radio", { name: "Leave as is" }).check();
  await editor.getByRole("button", { name: "Done" }).click();
  await expect(sheetSave(page)).toBeEnabled();
  await expect(sheetFooter(page)).not.toContainText("Too much text");
  await sheetFooter(page).getByRole("button", { name: "Discard" }).click();
  await expect(sheetSave(page)).toBeDisabled();
  expect(state.productsBulkWrites).toEqual([]);
  expectNothingUnexpected(state);
});

test("a product changed in another window refuses the whole save; Load latest reads the ids again and keeps the change", async ({ page }, testInfo) => {
  const state = await openBulkStep(page);
  await tickTwo(page);
  await openSheet(page, "Set for 2 products");
  await changeButton(page, "returnPolicy").click();
  await fieldEditor(page, "returnPolicy").getByRole("radio", { name: "Use default" }).check();
  await fieldEditor(page, "returnPolicy").getByRole("button", { name: "Done" }).click();
  await expect(sheetRow(page, "returnPolicy")).toContainText("→ Use default · Not saved");

  // Another window saves product 1001 after the sheet read its revision.
  state.productSettings[productKey(STORE, 1_001)] = { revisionId: 90, values: { ...NO_VALUES, paymentPolicy: { id: "payments", name: "Managed payments" } } };
  await sheetSave(page).click();
  await expect(sheetFooter(page)).toContainText("1 of the selected products changed in another window.");
  const latest = sheetFooter(page).getByRole("button", { name: "Load latest and keep my changes" });
  await expect(latest).toBeVisible();
  // Nothing was saved for either product.
  expect(state.productSettings[productKey(STORE, 1_002)].values.returnPolicy).toEqual({ id: "returns", name: "30-day returns" });

  const readsBefore = readsOf(state, "GET", IDS_PATH).length;
  await latest.click();
  await expect.poll(() => readsOf(state, "GET", IDS_PATH).length).toBe(readsBefore + 1);
  await expect(sheetRow(page, "returnPolicy")).toContainText("→ Use default · Not saved");
  await expect(sheetFooter(page)).toContainText(notSaved(testInfo, 1));
  await sheetSave(page).click();
  await expect(sheet(page)).toHaveCount(0);
  const [first, second] = state.productsBulkWrites.map((write) => write.body as { idempotencyKey: string; products: unknown[] });
  expect(second.products).toEqual([{ productId: 1_001, expectedRevisionId: 90 }, { productId: 1_002, expectedRevisionId: 7 }]);
  expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  expect(state.productSettings[productKey(STORE, 1_002)].values.returnPolicy).toBeNull();
  expect(state.productSettings[productKey(STORE, 1_001)].values.paymentPolicy).toEqual({ id: "payments", name: "Managed payments" });
  expectNothingUnexpected(state);
});

test("another big change saving means nothing was saved; Save again sends the same request with the same key", async ({ page }) => {
  const state = await openBulkStep(page, 312, { productsBulkWriteAnswers: [{ status: 503, code: BUSY, message: "Busy.",
    context: { reason: "heavy_write_in_progress", retryable: true } }] });
  await tickTwo(page);
  await openSheet(page, "Set for 2 products");
  await pickShipping(page, "USPS Priority Mail");
  await sheetSave(page).click();
  await expect(sheetFooter(page)).toContainText("Another big change is saving. Nothing was saved. Try again in a few seconds.");
  // Not locked: the change can still be edited, and Save is on.
  await expect(changeButton(page, "shippingPolicy")).toBeEnabled();
  await sheetSave(page).click();
  await expect(sheet(page)).toHaveCount(0);
  expect(state.productsBulkWrites).toHaveLength(2);
  expect(state.productsBulkWrites[1].body).toEqual(state.productsBulkWrites[0].body);
  await expect(savedLine(page)).toHaveText("Saved for 2 products. Still selected.");
  expectNothingUnexpected(state);
});

test("a save whose answer was lost is checked again with the same key and body, and Esc keeps the sheet open meanwhile", async ({ page }) => {
  const state = await openBulkStep(page, 312, { productsBulkWriteAnswers: ["drop"] });
  await tickTwo(page);
  await openSheet(page, "Set for 2 products");
  await pickShipping(page, "USPS Priority Mail");
  await sheetSave(page).click();
  await expect(sheetFooter(page)).toContainText("We couldn't confirm your save.");
  const checkAgain = sheetFooter(page).getByRole("button", { name: "Check again" });
  await expect(checkAgain).toBeVisible();
  // Locked until it is checked: no row can be changed, Discard is off, and Esc keeps the sheet (plan 3.4).
  await expect(changeButton(page, "shippingPolicy")).toBeDisabled();
  await expect(sheetFooter(page).getByRole("button", { name: "Discard" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeVisible();
  await checkAgain.click();
  await expect(sheet(page)).toHaveCount(0);
  expect(state.productsBulkWrites).toHaveLength(2);
  expect(state.productsBulkWrites[1].body).toEqual(state.productsBulkWrites[0].body);
  // Saved once: the retry was answered from the first save.
  expect(state.productSettings[productKey(STORE, 1_001)].values.shippingPolicy).toEqual({ id: "priority", name: "USPS Priority Mail" });
  await expect(savedLine(page)).toHaveText("Saved for 2 products. Still selected.");
  expectNothingUnexpected(state);
});

test("ticks stay across a search and Clear clears them; the sheet reads every chosen product for ticks made under another search", async ({ page }) => {
  const state = await openBulkStep(page);
  await tickBox(page, 1).check();
  await tickBox(page, 3).check();
  // A search keeps the ticks (D22).
  await page.getByRole("searchbox", { name: "Search product, size or SKU" }).fill("team");
  await expect(page.getByTestId("listing-settings-product-1002")).toBeVisible();
  await expect(page.getByTestId("listing-settings-product-1001")).toHaveCount(0);
  await expect(selectionBar(page)).toContainText("2 selected");
  await openSheet(page, "Set for 2 products");
  // The ticks' read is unfiltered: they were made under another search.
  expect(readsOf(state, "GET", IDS_PATH).map((read) => read.search)).toEqual(["?search=&show=all"]);
  await sheet(page).getByRole("button", { name: /^(Close|Back)$/ }).click();
  await expect(sheet(page)).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search product, size or SKU" }).fill("");
  await expect(tickBox(page, 1)).toBeChecked();
  await expect(tickBox(page, 3)).toBeChecked();

  await selectionBar(page).getByRole("button", { name: "Clear", exact: true }).click();
  await expect(selectionBar(page)).toHaveCount(0);
  await expect(tickBox(page, 1)).not.toBeChecked();
  await expect(tickBox(page, 3)).not.toBeChecked();
  expect(state.productsBulkWrites).toEqual([]);
  expectNothingUnexpected(state);
});

test("Select all made under a search falls back to the explicit ticks when the search changes", async ({ page }, testInfo) => {
  const state = await openBulkStep(page);
  await page.getByRole("searchbox", { name: "Search product, size or SKU" }).fill("team");
  // The searched list is shown (not the last one, kept on screen while it loads).
  await expect(page.getByTestId("listing-settings-product-1001")).toHaveCount(0);
  await expect(page.getByTestId("listing-settings-product-1002")).toBeVisible();
  if (phone(testInfo)) await page.getByTestId("listing-settings-select-shown").getByRole("checkbox").check();
  else await page.getByRole("checkbox", { name: "Select every product on this page", exact: true }).check();
  await selectionBar(page).getByRole("button", { name: "Select all 156" }).click();
  await expect(selectionBar(page)).toContainText("156 selected");
  await openSheet(page, "Set for 156 products");
  // "Select all N": the ids read is the list's own search and filter.
  expect(readsOf(state, "GET", IDS_PATH).map((read) => read.search)).toEqual(["?search=team&show=all"]);
  await sheet(page).getByRole("button", { name: /^(Close|Back)$/ }).click();
  await page.getByRole("searchbox", { name: "Search product, size or SKU" }).fill("");
  await expect(page.getByTestId("listing-settings-product-1001")).toBeVisible();
  // The page's 50 ticks stay; Select all is gone.
  await expect(selectionBar(page)).toContainText("50 selected");
  expectNothingUnexpected(state);
});

test("Back closes the sheet and keeps its change; opening it again shows the change, and × with a change asks first", async ({ page }, testInfo) => {
  const state = await openBulkStep(page);
  const dialog = page.getByRole("alertdialog");
  const historyLength = () => page.evaluate(() => window.history.length);
  const startLength = await historyLength();
  await tickTwo(page);
  await openSheet(page, "Set for 2 products");
  await pickShipping(page, "USPS Priority Mail");
  await page.goBack();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(actionBar(page)).toHaveText("Not saved · 1 change in Set for selected");

  // The same products and revisions: the change is shown again (D21).
  await openSheet(page, "Set for 2 products");
  await expect(sheetRow(page, "shippingPolicy")).toContainText("→ USPS Priority Mail · Not saved");
  await expect(sheetFooter(page)).toContainText(notSaved(testInfo, 1));

  // × (← on a phone) with a change asks first; Keep editing keeps it, Discard and leave drops it.
  const close = sheet(page).getByRole("button", { name: phone(testInfo) ? "Back" : "Close", exact: true });
  await close.click();
  await expect(dialog).toContainText("You have 1 change that isn't saved.");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(sheet(page)).toBeVisible();
  await close.click();
  await dialog.getByRole("button", { name: "Discard and leave" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(actionBar(page)).toHaveText("All saved");
  // The ticks are the tab's, not the draft's: they stay.
  await expect(selectionBar(page)).toContainText("2 selected");
  // Opening pushed one entry and closing replaced it (D21), so Back now leaves the sheet shut.
  expect(await historyLength()).toBe(startLength + 1);
  await page.goBack();
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(sheet(page)).toHaveCount(0);
  expect(state.productsBulkWrites).toEqual([]);
  expectNothingUnexpected(state);
});

test("opening Set for selected while another editor keeps a change asks first; Keep editing stays, Discard and leave opens it (D16)", async ({ page }, testInfo) => {
  const state = await openBulkStep(page);
  const dialog = page.getByRole("alertdialog");
  // Back closes the drawer and keeps its size price (D21).
  await openProductRow(page, 1_001, nameOf(1));
  await exactBox(page, "Pack of 100 · BLK-1-100").fill("9.99");
  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  await expect(actionBar(page)).toHaveText(`Not saved · 1 change in ${nameOf(1)}`);

  await tickBox(page, 1).check();
  await setForSelected(page).click();
  await expect(dialog).toContainText("You have 1 change that isn't saved.");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(actionBar(page)).toHaveText(`Not saved · 1 change in ${nameOf(1)}`);
  expect(readsOf(state, "GET", IDS_PATH)).toEqual([]);

  await setForSelected(page).click();
  await dialog.getByRole("button", { name: "Discard and leave" }).click();
  await expect(sheet(page).getByRole("heading", { name: "Set for 1 product" })).toBeVisible();
  await expect(changeButton(page, "shippingPolicy")).toBeEnabled();
  await expect(actionBar(page)).toHaveText("All saved");
  // Closing gives focus back to Set for selected, not to the question's button that opened it (3.4).
  await sheet(page).getByRole("button", { name: phone(testInfo) ? "Back" : "Close", exact: true }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(setForSelected(page)).toBeFocused();
  expect(state.priceWrites).toEqual([]);
  expectNothingUnexpected(state);
});

test("on a phone each checkbox sits beside its card, the bar stays in reach, and the sheet fills the screen with Save in view", async ({ page }, testInfo) => {
  test.skip(!phone(testInfo), "phone layout only");
  const state = await openBulkStep(page);
  const card = page.getByTestId("listing-settings-product-1001");
  await expect(card).toBeVisible();
  // The 44 px checkbox is beside the card's button, never inside it; the button's name still starts with the product.
  const box = card.locator("label").first();
  const boxSize = await box.boundingBox();
  expect(boxSize).not.toBeNull();
  expect(Math.round(boxSize!.width)).toBeGreaterThanOrEqual(44);
  expect(Math.round(boxSize!.height)).toBeGreaterThanOrEqual(44);
  const button = card.getByRole("button", { name: new RegExp(`^${nameOf(1)}`) });
  await expect(button).toBeVisible();
  await expect(button.getByRole("checkbox")).toHaveCount(0);
  await tickBox(page, 1).check();
  await expect(drawer(page)).toHaveCount(0);

  // Sticky: scrolled down the cards, the bar is still in view, below the step rail (which sticks too), and its
  // buttons take a tap: a trial click fails when anything covers them.
  await page.getByTestId("listing-settings-product-1040").scrollIntoViewIfNeeded();
  await expectInView(page, selectionBar(page));
  const rail = await page.getByTestId("catalog-step-rail").boundingBox();
  const stuck = await selectionBar(page).boundingBox();
  expect(rail).not.toBeNull();
  expect(stuck).not.toBeNull();
  expect(stuck!.y).toBeGreaterThanOrEqual(rail!.y + rail!.height - 1);
  await setForSelected(page).click({ trial: true, timeout: 5_000 });
  await selectionBar(page).getByRole("button", { name: "Clear", exact: true }).click({ trial: true, timeout: 5_000 });
  await expectNoHorizontalScroll(page);

  await openSheet(page, "Set for 1 product");
  await expectSheetLayout(page, testInfo, sheet(page));
  await pickShipping(page, "USPS Priority Mail");
  await expect(sheetSave(page)).toHaveText("Save");
  await expectInView(page, sheetSave(page));
  await expectNoHorizontalScroll(page);
  await shot(page, testInfo, "listing-settings-bulk-phone");
  await sheetSave(page).click();
  await expect(sheet(page)).toHaveCount(0);
  expect(state.productsBulkWrites).toHaveLength(1);
  expectNothingUnexpected(state);
});

test("a second Set for selected after a save reads the ids again and sends the revisions read then, with no conflict (D6)", async ({ page }) => {
  const state = await openBulkStep(page);
  await tickTwo(page);
  await openSheet(page, "Set for 2 products");
  await pickShipping(page, "USPS Priority Mail");
  await sheetSave(page).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(savedLine(page)).toHaveText("Saved for 2 products. Still selected.");
  // Another window saves product 1001 after the save's own re-read.
  state.productSettings[productKey(STORE, 1_001)] = { revisionId: 90, values: { ...NO_VALUES, paymentPolicy: { id: "payments", name: "Managed payments" } } };
  const readsBefore = readsOf(state, "GET", IDS_PATH).length;

  await openSheet(page, "Set for 2 products");
  // The opening reads for itself; an answer kept from the save's re-read is never what it opens on.
  expect(readsOf(state, "GET", IDS_PATH)).toHaveLength(readsBefore + 1);
  await changeButton(page, "returnPolicy").click();
  await fieldEditor(page, "returnPolicy").getByRole("radio", { name: "Use default" }).check();
  await fieldEditor(page, "returnPolicy").getByRole("button", { name: "Done" }).click();
  await sheetSave(page).click();
  await expect(sheet(page)).toHaveCount(0);
  expect(state.productsBulkWrites).toHaveLength(2);
  const second = state.productsBulkWrites[1].body as { products: Array<{ productId: number; expectedRevisionId: number | null }>; patch: unknown };
  expect(second.products[0]).toEqual({ productId: 1_001, expectedRevisionId: 90 });
  expect(second.patch).toEqual({ returnPolicy: null });
  expect(state.productSettings[productKey(STORE, 1_001)].values.paymentPolicy).toEqual({ id: "payments", name: "Managed payments" });
  await expect(savedLine(page)).toHaveText("Saved for 2 products. Still selected.");
  expectNothingUnexpected(state);
});

test("a product Card Shellz removed refuses the save; Load latest leaves it out and keeps the change (6.5)", async ({ page }) => {
  const state = await openBulkStep(page);
  await tickTwo(page);
  await openSheet(page, "Set for 2 products");
  await pickShipping(page, "USPS Priority Mail");
  // Card Shellz takes product 1001 out of the catalog while the sheet is open.
  state.catalog = state.catalog.filter((product) => product.productId !== 1_001);
  await sheetSave(page).click();
  await expect(sheetFooter(page)).toContainText("A selected product is no longer in the Card Shellz catalog. Load the list again.");
  const latest = sheetFooter(page).getByRole("button", { name: "Load latest and keep my changes" });
  await expect(latest).toBeVisible();
  const readsBefore = readsOf(state, "GET", IDS_PATH).length;
  await latest.click();
  await expect.poll(() => readsOf(state, "GET", IDS_PATH).length).toBe(readsBefore + 1);
  await expect(sheet(page).getByRole("heading", { name: "Set for 1 product" })).toBeVisible();
  await expect(sheet(page)).toContainText("1 product is no longer chosen and is left out.");
  await expect(sheetRow(page, "shippingPolicy")).toContainText("→ USPS Priority Mail · Not saved");
  await sheetSave(page).click();
  await expect(sheet(page)).toHaveCount(0);
  expect(state.productsBulkWrites).toHaveLength(2);
  const [first, second] = state.productsBulkWrites.map((write) => write.body as { idempotencyKey: string; products: unknown[]; patch: unknown });
  expect(second.products).toEqual([{ productId: 1_002, expectedRevisionId: 7 }]);
  expect(second.patch).toEqual({ shippingPolicy: { id: "priority" } });
  expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  await expect(savedLine(page)).toHaveText("Saved for 1 product. Still selected.");
  expectNothingUnexpected(state);
});

test("an unconfirmed save stays in reach after Clear: Set for selected opens on it, names its products, and Check again resends it (D21)", async ({ page }) => {
  const state = await openBulkStep(page, 312, { productsBulkWriteAnswers: ["drop"] });
  await tickTwo(page);
  await openSheet(page, "Set for 2 products");
  await pickShipping(page, "USPS Priority Mail");
  await sheetSave(page).click();
  await expect(sheetFooter(page)).toContainText("We couldn't confirm your save.");
  await page.goBack();
  await expect(sheet(page)).toHaveCount(0);
  await selectionBar(page).getByRole("button", { name: "Clear", exact: true }).click();
  await expect(tickBox(page, 1)).not.toBeChecked();
  // Nothing is ticked, yet the bar keeps Set for selected for the save still to check.
  await expect(selectionBar(page)).toContainText("0 selected");
  await expect(setForSelected(page)).toBeEnabled();
  const readsBefore = readsOf(state, "GET", IDS_PATH).length;
  await setForSelected(page).click();
  await expect(sheet(page).getByRole("heading", { name: "Set for 2 products" })).toBeVisible();
  await expect(sheet(page)).toContainText("This save is for the 2 products it was sent for.");
  await expect(sheetRow(page, "shippingPolicy")).toContainText("→ USPS Priority Mail · Not saved");
  const checkAgain = sheetFooter(page).getByRole("button", { name: "Check again" });
  await expect(checkAgain).toBeEnabled();
  // The save's own products: no ids read.
  expect(readsOf(state, "GET", IDS_PATH)).toHaveLength(readsBefore);
  await checkAgain.click();
  await expect(sheet(page)).toHaveCount(0);
  expect(state.productsBulkWrites).toHaveLength(2);
  expect(state.productsBulkWrites[1].body).toEqual(state.productsBulkWrites[0].body);
  // Saved, and no longer said to be selected: nothing is ticked now.
  await expect(savedLine(page)).toHaveText("Saved for 2 products.");
  await expect(selectionBar(page)).toContainText("0 selected");
  await expect(setForSelected(page)).toBeDisabled();
  expectNothingUnexpected(state);
});

test("a change kept by Back goes to the products ticked since, with the sheet saying so", async ({ page }) => {
  const state = await openBulkStep(page);
  await tickTwo(page);
  await openSheet(page, "Set for 2 products");
  await pickShipping(page, "USPS Priority Mail");
  await page.goBack();
  await expect(sheet(page)).toHaveCount(0);
  await tickBox(page, 3).check();
  await openSheet(page, "Set for 3 products");
  await expect(sheet(page)).toContainText("Your unsaved change from before is kept for these products.");
  await expect(sheetRow(page, "shippingPolicy")).toContainText("→ USPS Priority Mail · Not saved");
  await sheetSave(page).click();
  await expect(sheet(page)).toHaveCount(0);
  expect(state.productsBulkWrites).toEqual([{ method: "POST", path: BULK_PATH, body: {
    idempotencyKey: KEY("ls-bulk"),
    products: [{ productId: 1_001, expectedRevisionId: null }, { productId: 1_002, expectedRevisionId: 7 }, { productId: 1_003, expectedRevisionId: null }],
    patch: { shippingPolicy: { id: "priority" } },
  } }]);
  await expect(savedLine(page)).toHaveText("Saved for 3 products. Still selected.");
  expectNothingUnexpected(state);
});

test("an address that opens the sheet with nothing ticked is put back, and a tick then opens nothing (D21)", async ({ page }) => {
  const state = await openBulkStep(page, 312, {}, `${SETUP_PATH}?sheet=bulk`);
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(page.getByTestId("listing-settings-product-1001")).toBeVisible();
  await tickBox(page, 1).check();
  await expect(selectionBar(page)).toContainText("1 selected");
  await expect(sheet(page)).toHaveCount(0);
  expect(readsOf(state, "GET", IDS_PATH)).toEqual([]);
  expectNothingUnexpected(state);
});

test("more than 10,000 sizes chosen by the time the sheet opens: its ids read is refused, the banner says why (D8, D18)", async ({ page }) => {
  const state = await openBulkStep(page);
  await tickBox(page, 1).check();
  state.tooLarge = true;
  await setForSelected(page).click();
  await expect(sheet(page)).toBeVisible();
  await expect(banner(page)).toContainText("You've chosen more than 10,000 sizes.");
  await expect(sheet(page).getByTestId("bulk-settings-read-problem")).toContainText("Couldn't check the selected products. Try again.");
  expect(readsOf(state, "GET", IDS_PATH)).toHaveLength(1);
  await expect(sheetSave(page)).toBeDisabled();
  expect(state.productsBulkWrites).toEqual([]);
  expectNothingUnexpected(state);
});

// ---------------------------------------------------------------------------
// 10d: the ticked products' price through the price check (W7; plan 7.2-7.7, D1, D2, D6, D20)
// ---------------------------------------------------------------------------

const REVIEW_PATH = `${LISTINGS}/listing-settings/price-changes/review`;
const APPLY_PATH = `${LISTINGS}/listing-settings/price-changes/apply`;
const RETAIL_20: PricingRecipe = { basis: "catalog_retail", markupBps: 2_000, flatCents: 0, rounding: "cent" };

/** "$3.60" from integer cents (never floating point). */
function dollars(cents: number | null): string {
  if (cents === null) throw new Error("The resolver gave no price.");
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** The price the shared resolver gives a size for `recipe` (the stub prices with the same call, D1). */
function rulePrice(recipe: PricingRecipe, retailCents: number): string {
  return dollars(calculateRulePrice(recipe, retailCents).priceCents);
}

/** bulkCatalog's retail price for product n: 299 + n % 50 cents. */
function retailOf(n: number): number {
  return 299 + (n % 50);
}

function priceRow(page: Page) {
  return sheet(page).getByTestId("drawer-setting-price");
}

function changePrice(page: Page) {
  return priceRow(page).getByRole("button", { name: "Change price for the selected products", exact: true });
}

function priceEditor(page: Page) {
  return sheet(page).getByTestId("drawer-field-editor-price");
}

function check(page: Page) {
  return sheet(page).getByTestId("price-check");
}

function checkFooter(page: Page) {
  return sheet(page).getByTestId("price-check-footer");
}

function checkSize(page: Page, productVariantId: number) {
  return check(page).getByTestId(`price-check-size-${productVariantId}`);
}

/** Opens the Price row's editor, picks Set price and types `percent` into Add. */
async function setPricePercent(page: Page, percent: string) {
  await changePrice(page).click();
  await expect(priceEditor(page)).toBeVisible();
  await priceEditor(page).getByRole("radio", { name: "Set price" }).check();
  await priceEditor(page).getByRole("textbox", { name: "Add" }).fill(percent);
}

/** The bulk step with the store price saved, so a check has a Now price to show. */
function openPricedBulkStep(page: Page, initial: Partial<StubState> = {}) {
  return openBulkStep(page, 312, { pricingRules: { [STORE]: SAVED_PRICING_RULES }, ...initial });
}

test("three ticked products get one price through the check, saved for all of them; the other rows wait while the price holds a change (D2)", async ({ page }, testInfo) => {
  const state = await openPricedBulkStep(page);
  await tickBox(page, 1).check();
  await tickBox(page, 2).check();
  await tickBox(page, 3).check();
  await openSheet(page, "Set for 3 products");
  await expect(priceRow(page)).toContainText("Leave as is");
  await expect(changePrice(page)).toBeEnabled();

  // D2: a setting change holds the Price row; discarding it frees the row again.
  await pickShipping(page, "USPS Priority Mail");
  await expect(changePrice(page)).toBeDisabled();
  await expect(priceRow(page)).toContainText("Save or discard your other change first.");
  await sheetFooter(page).getByRole("button", { name: "Discard" }).click();
  await expect(changePrice(page)).toBeEnabled();

  await changePrice(page).click();
  await expect(priceEditor(page).getByRole("radio", { name: "Use default" })).toBeChecked();
  await priceEditor(page).getByRole("radio", { name: "Set price" }).check();
  await priceEditor(page).getByRole("textbox", { name: "Add" }).fill("20");
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();

  // The check replaces the sheet's rows (D20): one review for the products the ids read gave (D6), no revision.
  await expect(check(page)).toBeVisible();
  await expect(sheet(page).getByTestId("bulk-settings-rows")).toHaveCount(0);
  expect(state.priceChangeReviews).toEqual([{ method: "POST", path: REVIEW_PATH,
    body: { kind: "product_prices", productIds: [1_001, 1_002, 1_003], price: RETAIL_20 } }]);
  await expect(check(page).getByTestId("price-check-head")).toHaveText("Checking: Retail price + 20%, to the cent · Not saved yet");
  await expect(check(page).getByTestId("price-check-counts")).toHaveText("3 sizes · 3 change");
  for (const n of [1, 2, 3]) {
    await expect(checkSize(page, 100_000 + n)).toContainText(nameOf(n));
    await expect(checkSize(page, 100_000 + n)).toContainText(`This product's price, from retail ${dollars(retailOf(n))}`);
    await expect(checkSize(page, 100_000 + n)).toContainText(rulePrice(SAVED_PRICING_RULES.profile!.defaultRecipe, retailOf(n)));
    await expect(checkSize(page, 100_000 + n)).toContainText(rulePrice(RETAIL_20, retailOf(n)));
  }
  await expect(actionBar(page)).toHaveText("Not saved · 1 change in Set for selected");
  expect(state.priceChangeApplies).toEqual([]);
  await shot(page, testInfo, "listing-settings-bulk-price-check");

  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(sheet(page)).toHaveCount(0);
  const [held] = Object.values(state.priceChangeChecks);
  expect(state.priceChangeApplies).toEqual([{ method: "POST", path: APPLY_PATH,
    body: { reviewId: held.reviewId, reviewHash: held.reviewHash, idempotencyKey: KEY("ls-price-check") } }]);
  // The sheet closes, the ticks stay and the bar says so (D22); the list is read again (D9).
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(savedLine(page)).toHaveText("Saved for 3 products. Still selected.");
  await expect(tickBox(page, 1)).toBeChecked();
  await expect(tickBox(page, 3)).toBeChecked();
  const postAt = state.reads.findIndex((read) => read.method === "POST" && read.path === APPLY_PATH);
  await expect.poll(() => state.reads.slice(postAt + 1).filter((read) => read.method === "GET" && read.path === PRODUCTS_PATH).length).toBeGreaterThanOrEqual(1);
  for (const n of [1, 2, 3]) expect(state.productSettings[productKey(STORE, 1_000 + n)].values.price).toEqual(RETAIL_20);
  await expect(actionBar(page)).toHaveText("All saved");
  expectNothingUnexpected(state);
});

test("Clear exact prices too releases the ticked sizes' exact prices through the check, and the row says which", async ({ page }) => {
  const state = await openPricedBulkStep(page, { sizePrices: { [sizeKey(STORE, 100_002)]: { revisionId: 32, pricingMode: "fixed", overridePriceCents: 1_234 } } });
  await tickTwo(page);
  await openSheet(page, "Set for 2 products");
  await changePrice(page).click();
  await priceEditor(page).getByRole("checkbox", { name: /^Clear exact prices too/ }).check();
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(check(page)).toBeVisible();
  expect(state.priceChangeReviews).toEqual([{ method: "POST", path: REVIEW_PATH,
    body: { kind: "product_prices", productIds: [1_001, 1_002], price: null, releaseExactPrices: true } }]);
  await expect(check(page).getByTestId("price-check-head")).toHaveText("Checking: Use default · Clear exact prices too · Not saved yet");
  await expect(check(page).getByTestId("price-check-counts")).toHaveText("2 sizes · 1 change · 1 loses its exact price");
  await expect(checkSize(page, 100_002)).toContainText("$12.34");
  await expect(checkSize(page, 100_002)).toContainText(rulePrice(SAVED_PRICING_RULES.profile!.defaultRecipe, retailOf(2)));
  await expect(checkSize(page, 100_002)).toContainText("Exact price cleared");
  await expect(checkSize(page, 100_001)).not.toContainText("Exact price cleared");

  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(savedLine(page)).toHaveText("Saved for 2 products. Still selected.");
  expect(state.priceChangeApplies).toHaveLength(1);
  expect(state.sizePrices[sizeKey(STORE, 100_002)]).toMatchObject({ pricingMode: "inherit", overridePriceCents: null });
  expectNothingUnexpected(state);
});

test("a check refused as too large says so in the Price editor, with nothing saved and the change kept", async ({ page }) => {
  const tooLarge: WriteAnswer = { status: 422, code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE",
    message: "This price check covers more than 10,000 sizes. Choose fewer products.", context: { storeConnectionId: STORE } };
  const state = await openPricedBulkStep(page, { priceChangeReviewAnswers: [tooLarge] });
  await tickTwo(page);
  await openSheet(page, "Set for 2 products");
  await setPricePercent(page, "20");
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(priceEditor(page).getByRole("alert")).toHaveText("This check covers more than 10,000 sizes. Choose fewer products.");
  await expect(check(page)).toHaveCount(0);
  await expect(banner(page)).toHaveCount(0);
  await expect(actionBar(page)).toHaveText("Not saved · 1 change in Set for selected");
  expect(state.priceChangeReviews).toHaveLength(1);
  expect(state.priceChangeApplies).toEqual([]);
  // The same check sent again is answered: the words were this send's only.
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(check(page)).toBeVisible();
  expect(state.priceChangeReviews).toHaveLength(2);
  expectNothingUnexpected(state);
});

test("a check already applied under another key gets a new check that says so, once, and the new check saves (CC-C8)", async ({ page }) => {
  const applied: WriteAnswer = { status: 409, code: "DROPSHIP_IDEMPOTENCY_CONFLICT", message: "This price check was already applied.",
    context: { storeConnectionId: STORE, reviewId: "0000000d-0000-4000-8000-000000000001" } };
  const state = await openPricedBulkStep(page, { priceChangeApplyAnswers: [applied] });
  await tickTwo(page);
  await openSheet(page, "Set for 2 products");
  await setPricePercent(page, "20");
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(check(page)).toBeVisible();
  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(check(page)).toContainText("This check was already saved. Here's a new check.");
  expect(state.priceChangeApplies).toHaveLength(1);
  expect(state.priceChangeReviews).toHaveLength(2);
  expect(state.priceChangeReviews[1].body).toEqual(state.priceChangeReviews[0].body);
  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(savedLine(page)).toHaveText("Saved for 2 products. Still selected.");
  expect(state.priceChangeApplies).toHaveLength(2);
  expect(state.priceChangeApplies[1].body.reviewId).not.toBe(state.priceChangeApplies[0].body.reviewId);
  expect(state.priceChangeApplies[1].body.idempotencyKey).not.toBe(state.priceChangeApplies[0].body.idempotencyKey);
  expect(state.productSettings[productKey(STORE, 1_001)].values.price).toEqual(RETAIL_20);
  expectNothingUnexpected(state);
});

test("a price change discarded after its check gives way to a setting row on the same products, saved through W6 (D2)", async ({ page }, testInfo) => {
  const state = await openPricedBulkStep(page);
  await tickTwo(page);
  await openSheet(page, "Set for 2 products");
  await setPricePercent(page, "20");
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(check(page)).toBeVisible();
  await checkFooter(page).getByRole("button", { name: /^Back( to editing)?$/ }).click();
  await expect(priceEditor(page)).toBeVisible();
  await expect(sheetFooter(page)).toContainText(notSaved(testInfo, 1));
  await sheetFooter(page).getByRole("button", { name: "Discard" }).click();
  await expect(priceEditor(page)).toHaveCount(0);
  await expect(actionBar(page)).toHaveText("All saved");
  await expect(priceRow(page)).not.toContainText("Not saved");
  // Every row can be changed again: a pick goes in the draft on the same products, and the Price row then waits.
  await expect(changeButton(page, "shippingPolicy")).toBeEnabled();
  await pickShipping(page, "USPS Priority Mail");
  await expect(sheetFooter(page)).toContainText(notSaved(testInfo, 1));
  await expect(actionBar(page)).toHaveText("Not saved · 1 change in Set for selected");
  await expect(changePrice(page)).toBeDisabled();
  await sheetSave(page).click();
  await expect(sheet(page)).toHaveCount(0);
  expect(state.productsBulkWrites).toEqual([{ method: "POST", path: BULK_PATH, body: {
    idempotencyKey: KEY("ls-bulk"),
    products: [{ productId: 1_001, expectedRevisionId: null }, { productId: 1_002, expectedRevisionId: 7 }],
    patch: { shippingPolicy: { id: "priority" } },
  } }]);
  expect(state.priceChangeApplies).toEqual([]);
  await expect(savedLine(page)).toHaveText("Saved for 2 products. Still selected.");
  expect(state.productSettings[productKey(STORE, 1_001)].values.shippingPolicy).toEqual({ id: "priority", name: "USPS Priority Mail" });
  expect(state.productSettings[productKey(STORE, 1_001)].values.price).toBeNull();
  expectNothingUnexpected(state);
});

test("an apply whose answer was lost is checked again with the same key and body, and the sheet then closes with the saved line", async ({ page }) => {
  const state = await openPricedBulkStep(page, { priceChangeApplyAnswers: ["drop"] });
  await tickTwo(page);
  await openSheet(page, "Set for 2 products");
  await setPricePercent(page, "20");
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(checkFooter(page)).toContainText("We couldn't confirm your save.");
  await expect(checkFooter(page)).not.toContainText("Nothing was saved");
  // Esc keeps the sheet, and the check, open while nobody could confirm the save (plan 3.4).
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeVisible();
  await expect(check(page)).toBeVisible();
  await checkFooter(page).getByRole("button", { name: "Check again" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(savedLine(page)).toHaveText("Saved for 2 products. Still selected.");
  expect(state.priceChangeApplies).toHaveLength(2);
  expect(state.priceChangeApplies[1].body).toEqual(state.priceChangeApplies[0].body);
  expect(state.priceChangeApplies[0].body.idempotencyKey).toEqual(KEY("ls-price-check"));
  for (const n of [1, 2]) expect(state.productSettings[productKey(STORE, 1_000 + n)].values.price).toEqual(RETAIL_20);
  expectNothingUnexpected(state);
});

test("a price apply saved while the list couldn't be read again says so with Reload; Reload reads again and closes the sheet with the saved line (D9)", async ({ page }) => {
  const state = await openPricedBulkStep(page);
  await tickTwo(page);
  await openSheet(page, "Set for 2 products");
  await setPricePercent(page, "20");
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(check(page)).toBeVisible();
  await failNextRead(page, PRODUCTS_PATH, () => state.priceChangeApplies.length > 0);
  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  // Saved, but the sheet stays: its rows show again, the footer says the view may be out of date, with Reload.
  await expect(sheet(page)).toBeVisible();
  await expect(check(page)).toHaveCount(0);
  await expect(sheetFooter(page)).toContainText("Saved. We couldn't load the latest view.");
  expect(state.priceChangeApplies).toHaveLength(1);
  for (const n of [1, 2]) expect(state.productSettings[productKey(STORE, 1_000 + n)].values.price).toEqual(RETAIL_20);
  await sheetFooter(page).getByRole("button", { name: "Reload" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(savedLine(page)).toHaveText("Saved for 2 products. Still selected.");
  await expect(actionBar(page)).toHaveText("All saved");
  // Reload only reads: no second apply.
  expect(state.priceChangeApplies).toHaveLength(1);
  expectNothingUnexpected(state);
});
