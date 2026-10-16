import { expect, test, type Page } from "@playwright/test";
import type { CategoryListingSettingValues, ProductListingSettingValues } from "../../shared/dropship/listing-setting-values";
import { calculateRulePrice, type PricingRecipe } from "../../shared/dropship/pricing-rules";
import {
  SAVED_PRICING_RULES,
  categoryKey,
  listingSetup,
  productKey,
  shot,
  sizeKey,
  type ProductFixture,
  type StubState,
} from "./dropship-policy-catalog-stubs";
import {
  KEY,
  LISTINGS,
  SETUP_PATH,
  STORE,
  expectGatedReads,
  expectInView,
  expectNoHorizontalScroll,
  expectNothingUnexpected,
  expectSheetLayout,
  openStep,
  phone,
  readsOf,
} from "./dropship-policy-listing-settings-helpers";

// Playwright's serviceWorkers:block init script reads navigator.serviceWorker in
// every frame, which throws in an opaque sandbox. This local-only harness
// registers no workers.
test.use({ serviceWorkers: "allow" });

/**
 * The Category settings card and the category editor (Listing settings PR 10, part 10e; plan 8.1-8.8):
 * the card lists each Card Shellz category that holds a chosen product with what it sets, and [Change]
 * opens that category's editor at `?category=<id>` (W12, `PUT …/listing-settings/categories/:id`),
 * where a field is set, or set to "Use store default", and "Also clear theirs" makes the products with
 * their own value follow the category. Every save is checked against the shared contract by the stub
 * (ids and text only, never a price; compare-and-set on the category's revision and on the clear set's
 * products; the clear set must be the one the server derives; keyed), older group rules refuse every
 * save (D11), and every journey ends with nothing unexpected asked and no page error. Desktop and phone.
 *
 * From 10f (plan 9.1-9.4, 9.6) the Price row: the category's price through the W7 `category_price`
 * check, with the editor's other changes and "Also clear theirs" riding along in the one check (D2),
 * applied with the category's revision; older rules take the row's Change away and refuse a race (D11);
 * a revision that moved under the apply brings the editor back with Load latest (9.4); a dropped apply
 * is checked again with the same key. A category price never goes through W12 (9.7).
 */

const CATEGORIES_PATH = `${LISTINGS}/listing-settings/categories`;
const PRODUCTS_PATH = `${LISTINGS}/listing-settings/products`;
const PRICES_PATH = `${LISTINGS}/listing-settings/prices`;
const SUMMARY_PATH = `${LISTINGS}/listing-settings/summary`;
const REVIEW_PATH = `${LISTINGS}/listing-settings/price-changes/review`;
const APPLY_PATH = `${LISTINGS}/listing-settings/price-changes/apply`;
const RETAIL_20: PricingRecipe = { basis: "catalog_retail", markupBps: 2_000, flatCents: 0, rounding: "cent" };
/** Every Sleeves size's retail price (the fixture's). */
const RETAIL_CENTS = 399;

/** "$3.60" from integer cents (never floating point). */
function dollars(cents: number | null): string {
  if (cents === null) throw new Error("The resolver gave no price.");
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** The price the shared resolver gives a size from its retail price, as the check's rows show it (D1). */
function rulePrice(recipe: PricingRecipe, retailCents = RETAIL_CENTS): string {
  return dollars(calculateRulePrice(recipe, retailCents).priceCents);
}

const SLEEVES = 40;
const TOPLOADERS = 41;
const CASES = 42;
const categoryPath = (categoryId: number) => `${CATEGORIES_PATH}/${categoryId}`;

const NO_VALUES: ProductListingSettingValues = {
  price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null,
  textAbove: null, textBelow: null, mainText: null,
};
const NO_CATEGORY_VALUES: CategoryListingSettingValues = {
  price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null,
  textAbove: null, textBelow: null,
};
const PRIORITY = { id: "priority", name: "USPS Priority Mail" };
const NO_RETURNS = { id: "no-returns", name: "No returns" };

function product(productId: number, productName: string, category: { name: string; id: number } | null): ProductFixture {
  return {
    productId, productName, productSku: `CAT-${productId}`, category: category?.name ?? null, categoryId: category?.id ?? null,
    sizes: [{ productVariantId: productId * 10, sizeName: "Pack of 100", sku: `CAT-${productId}-100`, retailCents: 399, costCents: 210, stockUnits: 12 }],
  };
}

const PENNY = product(3_001, "Penny Sleeves", { name: "Sleeves", id: SLEEVES });
const TEAM = product(3_002, "Team Bags", { name: "Sleeves", id: SLEEVES });
const SOFT = product(3_003, "Soft Sleeves", { name: "Sleeves", id: SLEEVES });
const TOP = product(3_004, "Toploaders 35pt", { name: "Toploaders", id: TOPLOADERS });
const CASE = product(3_005, "Card Cases", { name: "Cases", id: CASES });
/** No Card Shellz category: counted under the card, never listed. */
const LOOSE = product(3_006, "Loose Packs", null);

/** The default setup with a second shipping policy and a second return policy the category can take. */
function setupWithChoices() {
  const setup = listingSetup(STORE);
  return { ...setup, options: { ...setup.options,
    fulfillmentPolicies: [...setup.options.fulfillmentPolicies, { ...PRIORITY, compatible: true, compatibilityIssues: [] }],
    returnPolicies: [...setup.options.returnPolicies, { ...NO_RETURNS }] } };
}

/**
 * Three categories: Sleeves (three products, no settings of its own; Penny Sleeves holds its own shipping
 * policy on its row at revision 7, Team Bags through a size's leftover, Soft Sleeves its own return
 * policy at revision 9), Toploaders (one product; sets its store shelf at revision 8) and Cases (one
 * product, nothing); plus one product with no category. A new copy for each journey: the stub saves
 * into the objects it is given.
 */
function categoriesState(): Partial<StubState> {
  return {
    catalog: structuredClone([PENNY, TEAM, SOFT, TOP, CASE, LOOSE]),
    listingSetups: { [STORE]: setupWithChoices() },
    productSettings: {
      [productKey(STORE, PENNY.productId)]: { revisionId: 7, values: { ...NO_VALUES, shippingPolicy: { ...PRIORITY } } },
      [productKey(STORE, SOFT.productId)]: { revisionId: 9, values: { ...NO_VALUES, returnPolicy: { id: "returns", name: "30-day returns" } } },
    },
    sizeLeftovers: { [sizeKey(STORE, TEAM.sizes[0].productVariantId)]: { shippingPolicyId: "ground" } },
    categorySettings: {
      [categoryKey(STORE, TOPLOADERS)]: { revisionId: 8, values: { ...NO_CATEGORY_VALUES, storeShelf: { mode: "own", shelves: [{ id: "11", name: "Supplies:Sleeves" }] } } },
    },
    storeShelves: { [STORE]: [
      { categoryId: "11", categoryName: "Sleeves", path: "Supplies:Sleeves", level: 2 },
      { categoryId: "12", categoryName: "Sale", path: "Sale", level: 1 },
    ] },
  };
}

/** The store's pricing rules with one older group rule (plan P21, D11): every category save is refused while it stands. */
function pricingRulesWithGroup() {
  const profile = SAVED_PRICING_RULES.profile!;
  return { ...SAVED_PRICING_RULES, profile: { ...profile,
    groups: [{ id: "sleeves", name: "Sleeves", priority: 1, scope: { type: "category" as const, category: "Sleeves" }, recipe: profile.defaultRecipe }] } };
}

type RowKey = "shippingPolicy" | "returnPolicy" | "paymentPolicy" | "ebayCategory" | "storeShelf" | "descriptionTemplate";
const ROW_SETTING: Record<RowKey, string> = {
  shippingPolicy: "shipping policy", returnPolicy: "return policy", paymentPolicy: "payment policy",
  ebayCategory: "eBay category", storeShelf: "store shelf", descriptionTemplate: "description",
};

function card(page: Page) {
  return page.getByTestId("category-settings-card");
}

function cardRow(page: Page, categoryId: number) {
  return card(page).getByTestId(`category-settings-row-${categoryId}`);
}

function changeCategory(page: Page, name: string) {
  return card(page).getByRole("button", { name: `Change settings for ${name}`, exact: true });
}

function editor(page: Page) {
  return page.getByTestId("category-editor");
}

function settingRow(page: Page, key: RowKey) {
  return editor(page).getByTestId(`drawer-setting-${key}`);
}

function changeButton(page: Page, key: RowKey, name: string) {
  return settingRow(page, key).getByRole("button", { name: `Change ${ROW_SETTING[key]} for ${name}`, exact: true });
}

function fieldEditor(page: Page, key: "shippingPolicy" | "returnPolicy" | "paymentPolicy" | "ebayCategory" | "storeShelf" | "description") {
  return editor(page).getByTestId(`drawer-field-editor-${key}`);
}

function clearBox(page: Page, field: string) {
  return editor(page).getByTestId(`category-clear-${field}`);
}

function footer(page: Page) {
  return page.getByTestId("category-editor-footer");
}

function saveButton(page: Page) {
  return footer(page).getByRole("button", { name: "Save", exact: true });
}

function priceRow(page: Page) {
  return editor(page).getByTestId("category-price-row");
}

function changePrice(page: Page, name: string) {
  return priceRow(page).getByRole("button", { name: `Change price for ${name}`, exact: true });
}

function priceEditor(page: Page) {
  return editor(page).getByTestId("drawer-field-editor-price");
}

function check(page: Page) {
  return editor(page).getByTestId("price-check");
}

function checkFooter(page: Page) {
  return editor(page).getByTestId("price-check-footer");
}

/** The editor's Save while the draft holds a price change (plan 9.2): the same words on every width (10d's rule). */
function checkNewPrices(page: Page) {
  return footer(page).getByRole("button", { name: "Check new prices", exact: true });
}

/** Opens the Price row's editor, picks Set price and types `percent` into Add. */
async function setPricePercent(page: Page, name: string, percent: string) {
  await changePrice(page, name).click();
  await expect(priceEditor(page)).toBeVisible();
  await priceEditor(page).getByRole("radio", { name: "Set price" }).check();
  await priceEditor(page).getByRole("textbox", { name: "Add" }).fill(percent);
}

/** The categories state with the store price saved (retail + 15%), so a check has a Now price to show. */
function pricedCategoriesState(): Partial<StubState> {
  return { ...categoriesState(), pricingRules: { [STORE]: SAVED_PRICING_RULES } };
}

function bar(page: Page) {
  return page.getByTestId("catalog-action-summary");
}

/** Opens a category's editor from the card's [Change], and waits for its detail. */
async function openEditor(page: Page, name: string, categoryId: number) {
  await changeCategory(page, name).click();
  await expect(editor(page)).toBeVisible();
  await expect(page).toHaveURL(`${SETUP_PATH}?category=${categoryId}`);
  await expect(editor(page).getByTestId("category-editor-rows")).toBeVisible();
}

/** Opens a policy row's editor, picks a policy by name and puts it in the draft with Done. */
async function pickPolicy(page: Page, key: "shippingPolicy" | "returnPolicy" | "paymentPolicy", name: string, policy: string) {
  await changeButton(page, key, name).click();
  await expect(fieldEditor(page, key)).toBeVisible();
  await fieldEditor(page, key).getByRole("radio", { name: new RegExp(`^${policy}`) }).check();
  await fieldEditor(page, key).getByRole("button", { name: "Done" }).click();
  await expect(fieldEditor(page, key)).toHaveCount(0);
}

/** The reads after the n-th request, by method and path. */
function readsAfter(state: StubState, index: number, method: string, path: string) {
  return state.reads.slice(index + 1).filter((read) => read.method === method && read.path === path).length;
}

test("the card lists each category in name order with what it sets and the uncategorized line, from one mount read; Change opens the editor at ?category=", async ({ page }, testInfo) => {
  const state = await openStep(page, categoriesState());
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toContainText("Category settings");
  await expect(card(page)).toContainText("Products in a Card Shellz category use its settings before your store defaults.");
  // Name order: Cases, Sleeves, Toploaders (the server's), whatever order the catalog lists them in.
  const rows = card(page).getByTestId("category-settings-rows").locator("li");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Cases · 1 product · Uses your store defaults");
  await expect(rows.nth(1)).toContainText("Sleeves · 3 products · Uses your store defaults");
  await expect(rows.nth(2)).toContainText("Toploaders · 1 product · Sets: store shelf");
  await expect(card(page)).toContainText("1 product has no Card Shellz category. It uses your store defaults.");
  for (const name of ["Cases", "Sleeves", "Toploaders"]) await expect(changeCategory(page, name)).toBeEnabled();
  // The card sits between the Store defaults card and the tabs (A5).
  expect(await card(page).evaluate((element) => element.parentElement?.previousElementSibling?.querySelector("[data-testid='store-defaults-card']") !== null)).toBe(true);
  expect(await card(page).evaluate((element) => element.parentElement?.nextElementSibling?.querySelector("[data-testid='listing-settings-tabs']") !== null)).toBe(true);
  expect(readsOf(state, "GET", CATEGORIES_PATH)).toHaveLength(1);
  await shot(page, testInfo, "listing-settings-categories-card");

  await openEditor(page, "Sleeves", SLEEVES);
  await expect(editor(page)).toContainText("Sleeves · 3 products");
  expect(readsOf(state, "GET", categoryPath(SLEEVES))).toHaveLength(1);
  // Every value with where it comes from; the Price row with its [Change] (PR 10f) and the sizes' prices as they are now (CC-C23).
  await expect(settingRow(page, "shippingPolicy")).toContainText("USPS Ground Advantage");
  await expect(settingRow(page, "shippingPolicy")).toContainText("Store default");
  // No store price in this store yet: the row says so, as the drawer's head does; each size sells at its retail price now.
  await expect(priceRow(page)).toContainText("No store price yet. Set one in Store defaults.");
  await expect(priceRow(page).getByTestId("category-price-examples")).toHaveText("Now: Pack of 100 $3.99 · Pack of 100 $3.99 · Pack of 100 $3.99");
  await expect(changePrice(page, "Sleeves")).toBeEnabled();
  await expect(priceRow(page)).not.toContainText("can't be changed here yet");
  for (const key of ["shippingPolicy", "returnPolicy", "paymentPolicy", "ebayCategory", "storeShelf", "descriptionTemplate"] as const) {
    await expect(changeButton(page, key, "Sleeves")).toBeEnabled();
  }
  // The box shows only where the save would set the field: nothing is set yet, although two products hold their own shipping policy.
  await expect(editor(page).locator("[data-testid^='category-clear-']")).toHaveCount(0);
  await expect(bar(page)).toHaveText("All saved");

  // × (← on a phone) takes the category off the address in place and gives focus back to the row's Change (plan 3.4).
  await editor(page).getByRole("button", { name: phone(testInfo) ? "Back" : "Close" }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(changeCategory(page, "Sleeves")).toBeFocused();
  expect(state.categorySettingsWrites).toEqual([]);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("a shipping policy is set for Sleeves, saved with its id alone against the detail read, and read again; the next change starts from the saved revision (D6, D9)", async ({ page }, testInfo) => {
  const state = await openStep(page, categoriesState());
  await openEditor(page, "Sleeves", SLEEVES);
  // The editor offers "Use store default" (D17), never the drawer's "Use default".
  await changeButton(page, "shippingPolicy", "Sleeves").click();
  await expect(fieldEditor(page, "shippingPolicy").getByRole("radio", { name: "Use store default" })).toBeVisible();
  await expect(fieldEditor(page, "shippingPolicy").getByRole("radio", { name: "Use default", exact: true })).toHaveCount(0);
  // Esc closes the field editor, not the sheet, and focus goes back to its Change.
  await page.keyboard.press("Escape");
  await expect(fieldEditor(page, "shippingPolicy")).toHaveCount(0);
  await expect(editor(page)).toBeVisible();
  await expect(changeButton(page, "shippingPolicy", "Sleeves")).toBeFocused();

  await pickPolicy(page, "shippingPolicy", "Sleeves", "USPS Priority Mail");
  await expect(changeButton(page, "shippingPolicy", "Sleeves")).toBeFocused();
  await expect(settingRow(page, "shippingPolicy")).toContainText("→ USPS Priority Mail · Not saved");
  await expect(footer(page)).toContainText(phone(testInfo) ? "● Not saved · 1" : "● Not saved · 1 change");
  await expect(bar(page)).toHaveText("Not saved · 1 change in Sleeves");
  // Now the save would set the field on the category: the box shows for the two products with their own, unticked.
  await expect(clearBox(page, "shippingPolicy")).toContainText("2 products in Sleeves have their own shipping policy.");
  await expect(clearBox(page, "shippingPolicy").getByRole("checkbox", { name: "Also clear theirs, so all 3 use this one." })).not.toBeChecked();
  await shot(page, testInfo, "listing-settings-category-editor");

  await saveButton(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.categorySettingsWrites).toEqual([{ method: "PUT", path: categoryPath(SLEEVES),
    body: { idempotencyKey: KEY("ls-cat"), expectedRevisionId: null, patch: { shippingPolicy: { id: "priority" } } } }]);
  // D9: the categories list, the category's detail, the products and the summary are read again; the answer is not shown.
  const putAt = state.reads.findIndex((read) => read.method === "PUT" && read.path === categoryPath(SLEEVES));
  await expect.poll(() => readsAfter(state, putAt, "GET", categoryPath(SLEEVES))).toBeGreaterThanOrEqual(1);
  await expect.poll(() => readsAfter(state, putAt, "GET", CATEGORIES_PATH)).toBeGreaterThanOrEqual(1);
  await expect.poll(() => readsAfter(state, putAt, "GET", PRODUCTS_PATH)).toBeGreaterThanOrEqual(1);
  await expect.poll(() => readsAfter(state, putAt, "GET", SUMMARY_PATH)).toBeGreaterThanOrEqual(1);
  await expect(settingRow(page, "shippingPolicy")).toContainText("USPS Priority Mail");
  await expect(settingRow(page, "shippingPolicy")).toContainText("Set for Sleeves");
  await expect(settingRow(page, "shippingPolicy")).not.toContainText("Not saved");
  await expect(bar(page)).toHaveText("All saved");
  await expect(cardRow(page, SLEEVES)).toContainText("Sleeves · 3 products · Sets: shipping policy");
  expect(state.categorySettings[categoryKey(STORE, SLEEVES)].values.shippingPolicy).toEqual(PRIORITY);
  // The box stays: the category now sets the field, and the two products still hold their own.
  await expect(clearBox(page, "shippingPolicy")).toContainText("2 products in Sleeves have their own shipping policy.");

  // The next change starts from the saved revision, with a new key (D6).
  await pickPolicy(page, "returnPolicy", "Sleeves", "No returns");
  await expect(settingRow(page, "returnPolicy")).toContainText("→ No returns · Not saved");
  await saveButton(page).click();
  await expect.poll(() => state.categorySettingsWrites.length).toBe(2);
  const savedRevision = state.categorySettingsWrites[1].body.expectedRevisionId;
  expect(savedRevision).toEqual(expect.any(Number));
  expect(state.categorySettingsWrites[1].body).toEqual({ idempotencyKey: KEY("ls-cat"), expectedRevisionId: savedRevision, patch: { returnPolicy: { id: "no-returns" } } });
  expect(state.categorySettingsWrites[1].body.idempotencyKey).not.toBe(state.categorySettingsWrites[0].body.idempotencyKey);
  await expect(footer(page)).toContainText("Saved");
  await expect(settingRow(page, "returnPolicy")).toContainText("Set for Sleeves");
  // No row shows an id.
  await expect(editor(page)).not.toContainText("priority");
  await expect(editor(page)).not.toContainText("no-returns");
  expectNothingUnexpected(state);
});

test("Use store default sets Toploaders' own shelf back, sent as null, and the row then reads None with no tag (nothing gives a shelf)", async ({ page }) => {
  const state = await openStep(page, categoriesState());
  await openEditor(page, "Toploaders", TOPLOADERS);
  await expect(editor(page)).toContainText("Toploaders · 1 product");
  await expect(settingRow(page, "storeShelf")).toContainText("Supplies › Sleeves");
  await expect(settingRow(page, "storeShelf")).toContainText("Set for Toploaders");

  await changeButton(page, "storeShelf", "Toploaders").click();
  // The editor opens on the category's own shelf.
  await expect(fieldEditor(page, "storeShelf").getByRole("radio", { name: "Own shelves" })).toBeChecked();
  await fieldEditor(page, "storeShelf").getByRole("radio", { name: "Use store default" }).check();
  await fieldEditor(page, "storeShelf").getByRole("button", { name: "Done" }).click();
  await expect(settingRow(page, "storeShelf")).toContainText("→ Use store default · Not saved");

  await saveButton(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.categorySettingsWrites).toEqual([{ method: "PUT", path: categoryPath(TOPLOADERS),
    body: { idempotencyKey: KEY("ls-cat"), expectedRevisionId: 8, patch: { storeShelf: null } } }]);
  expect(state.categorySettingsWrites[0].body.patch).toHaveProperty("storeShelf", null);
  // This store sets no shelf default, so nothing gives one: "None" with no tag (the value says so itself, as the drawer's).
  await expect(settingRow(page, "storeShelf")).toContainText("None");
  await expect(settingRow(page, "storeShelf")).not.toContainText("Store default");
  await expect(settingRow(page, "storeShelf")).not.toContainText("Set for Toploaders");
  await expect(cardRow(page, TOPLOADERS)).toContainText("Toploaders · 1 product · Uses your store defaults");
  expectNothingUnexpected(state);
});

test("Also clear theirs sends exactly the shown set with each product's revision, and the products then follow the category; never with Use store default (8.4)", async ({ page }, testInfo) => {
  const state = await openStep(page, categoriesState());
  await openEditor(page, "Sleeves", SLEEVES);
  await pickPolicy(page, "shippingPolicy", "Sleeves", "USPS Priority Mail");
  const box = clearBox(page, "shippingPolicy").getByRole("checkbox", { name: "Also clear theirs, so all 3 use this one." });
  await box.check();
  await expect(box).toBeChecked();
  await expect(footer(page)).toContainText(phone(testInfo) ? "● Not saved · 2" : "● Not saved · 2 changes");
  await expect(bar(page)).toHaveText("Not saved · 2 changes in Sleeves");

  await saveButton(page).click();
  await expect(footer(page)).toContainText("Saved");
  // The union of the entries holding the field, each once, ascending, with the revision the detail read gave (null for a leftover alone).
  expect(state.categorySettingsWrites).toEqual([{ method: "PUT", path: categoryPath(SLEEVES), body: {
    idempotencyKey: KEY("ls-cat"), expectedRevisionId: null, patch: { shippingPolicy: { id: "priority" } },
    clear: { fields: ["shippingPolicy"], products: [{ productId: PENNY.productId, expectedRevisionId: 7 }, { productId: TEAM.productId, expectedRevisionId: null }] },
  } }]);
  expect(state.productSettings[productKey(STORE, PENNY.productId)].values.shippingPolicy).toBeNull();
  expect(state.productSettings[productKey(STORE, PENNY.productId)].revisionId).not.toBe(7);
  expect(state.sizeLeftovers[sizeKey(STORE, TEAM.sizes[0].productVariantId)]).toEqual({});
  // Soft Sleeves' own return policy was not named: untouched.
  expect(state.productSettings[productKey(STORE, SOFT.productId)].values.returnPolicy).toEqual({ id: "returns", name: "30-day returns" });
  // After the re-read nothing is left to clear: the box goes.
  await expect(clearBox(page, "shippingPolicy")).toHaveCount(0);
  await expect(settingRow(page, "shippingPolicy")).toContainText("Set for Sleeves");

  // Use store default on the return policy shows no box for Soft Sleeves' own return policy: a clear needs a set value, so the
  // store default is never pinned on the category (SW:438-445).
  await pickPolicy(page, "returnPolicy", "Sleeves", "No returns");
  await expect(clearBox(page, "returnPolicy")).toContainText("1 product in Sleeves has its own return policy.");
  await changeButton(page, "returnPolicy", "Sleeves").click();
  await fieldEditor(page, "returnPolicy").getByRole("radio", { name: "Use store default" }).check();
  await fieldEditor(page, "returnPolicy").getByRole("button", { name: "Done" }).click();
  await expect(settingRow(page, "returnPolicy")).not.toContainText("Not saved");
  await expect(clearBox(page, "returnPolicy")).toHaveCount(0);
  await expect(bar(page)).toHaveText("All saved");
  expect(state.categorySettingsWrites).toHaveLength(1);
  expectNothingUnexpected(state);
});

test("a clear-only save on a value the category already sets resends it as ids alone, and the category stays at its revision", async ({ page }, testInfo) => {
  const initial = categoriesState();
  initial.categorySettings![categoryKey(STORE, SLEEVES)] = { revisionId: 5, values: { ...NO_CATEGORY_VALUES, returnPolicy: { ...NO_RETURNS } } };
  const state = await openStep(page, initial);
  await expect(cardRow(page, SLEEVES)).toContainText("Sleeves · 3 products · Sets: return policy");
  await openEditor(page, "Sleeves", SLEEVES);
  await expect(settingRow(page, "returnPolicy")).toContainText("No returns");
  await expect(settingRow(page, "returnPolicy")).toContainText("Set for Sleeves");
  // The category sets the field already: the box shows with no change made.
  const box = clearBox(page, "returnPolicy").getByRole("checkbox", { name: "Also clear theirs, so all 3 use this one." });
  await expect(clearBox(page, "returnPolicy")).toContainText("1 product in Sleeves has its own return policy.");
  await expect(saveButton(page)).toBeDisabled();
  await box.check();
  await expect(footer(page)).toContainText(phone(testInfo) ? "● Not saved · 1" : "● Not saved · 1 change");
  await expect(settingRow(page, "returnPolicy")).not.toContainText("Not saved");

  await saveButton(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.categorySettingsWrites).toEqual([{ method: "PUT", path: categoryPath(SLEEVES), body: {
    idempotencyKey: KEY("ls-cat"), expectedRevisionId: 5, patch: { returnPolicy: { id: "no-returns" } },
    clear: { fields: ["returnPolicy"], products: [{ productId: SOFT.productId, expectedRevisionId: 9 }] },
  } }]);
  // The category was saved as unchanged (plan P20): its revision stands; Soft Sleeves lost its own return policy.
  expect(state.categorySettings[categoryKey(STORE, SLEEVES)].revisionId).toBe(5);
  expect(state.productSettings[productKey(STORE, SOFT.productId)].values.returnPolicy).toBeNull();
  await expect(clearBox(page, "returnPolicy")).toHaveCount(0);
  await expect(bar(page)).toHaveText("All saved");
  expectNothingUnexpected(state);
});

test("while the store holds older group rules, no row has Change and the one line says why, with See what changes; nothing is sent (D11, PR 11b D17)", async ({ page }) => {
  const state = await openStep(page, { ...categoriesState(), pricingRules: { [STORE]: pricingRulesWithGroup() } });
  await expect(card(page)).toBeVisible();
  await expect(cardRow(page, TOPLOADERS)).toContainText("Toploaders · 1 product · Sets: store shelf");
  // A category that sets nothing: a group may still decide its products, so never "Uses your store defaults" (D17).
  await expect(cardRow(page, SLEEVES)).toContainText("Sleeves · 3 products · No category settings yet");
  await expect(cardRow(page, CASES)).toContainText("Cases · 1 product · No category settings yet");
  await expect(card(page)).not.toContainText("Uses your store defaults");
  await expect(card(page).getByRole("button", { name: /^Change settings for/ })).toHaveCount(0);
  // The line no longer promises a later move (D17); the card's one button opens the read-only sheet (PR 11b).
  await expect(card(page)).toContainText("Category settings can't be saved while your store has older group rules.");
  await expect(card(page)).not.toContainText("later update");
  await expect(card(page).getByRole("button")).toHaveText(["See what changes"]);
  // No read-only editor (UX-m3): the card's [Change] was the one way in.
  await expect(editor(page)).toHaveCount(0);
  expect(state.categorySettingsWrites).toEqual([]);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("a 409 for older group rules added after the editor opened is worded in the footer, the change is kept, and the card takes Change away", async ({ page }) => {
  const state = await openStep(page, categoriesState());
  await openEditor(page, "Sleeves", SLEEVES);
  await pickPolicy(page, "shippingPolicy", "Sleeves", "USPS Priority Mail");
  // Older settings gets a pricing group while the editor is open: the next save is refused for good (the backstop).
  state.pricingRules[STORE] = pricingRulesWithGroup();
  await saveButton(page).click();
  const line = "Category settings can't be saved while your store has older group rules.";
  await expect(footer(page)).toContainText(line);
  // The read-only sheet's opener beside the line (PR 11b, D17), once the card read the summary again.
  await expect(footer(page).getByRole("button", { name: "See what changes", exact: true })).toBeVisible();
  expect(state.categorySettingsWrites).toHaveLength(1);
  // The change is kept (refused, not dropped); the card read the summary again and took every Change away.
  await expect(settingRow(page, "shippingPolicy")).toContainText("→ USPS Priority Mail · Not saved");
  await expect(bar(page)).toHaveText("Not saved · 1 change in Sleeves");
  // By element, not by role: the open sheet hides the page behind it from the accessibility tree. The card's one
  // button is See what changes (PR 11b).
  await expect(card(page).locator("button")).toHaveText(["See what changes"]);
  await expect(card(page)).toContainText(line);
  // The editor learned of the rules from the summary too (D11): no second save is offered, no row can be changed, Discard still can.
  await expect(saveButton(page)).toBeDisabled();
  await expect(editor(page).getByRole("button", { name: /^Change / })).toHaveCount(0);
  await expect(footer(page).getByRole("button", { name: "Discard" })).toBeEnabled();
  expect(state.categorySettingsWrites).toHaveLength(1);
  expectNothingUnexpected(state);
});

test("while the store holds older group rules, a link opens the editor with no Change, Save off and the one line; nothing is sent (D11, D21)", async ({ page }) => {
  const state = await openStep(page, { ...categoriesState(), pricingRules: { [STORE]: pricingRulesWithGroup() } }, `${SETUP_PATH}?category=${SLEEVES}`);
  await expect(editor(page)).toBeVisible();
  await expect(editor(page).getByTestId("category-editor-rows")).toBeVisible();
  await expect(editor(page)).toContainText("Sleeves · 3 products");
  await expect(settingRow(page, "shippingPolicy")).toContainText("USPS Ground Advantage");
  await expect(editor(page).getByRole("button", { name: /^Change / })).toHaveCount(0);
  await expect(editor(page).locator("[data-testid^='category-clear-']")).toHaveCount(0);
  await expect(saveButton(page)).toBeDisabled();
  await expect(footer(page)).toContainText("Category settings can't be saved while your store has older group rules.");
  await expect(footer(page)).not.toContainText("later update");
  await expect(footer(page).getByRole("button", { name: "See what changes", exact: true })).toBeVisible();
  expect(state.categorySettingsWrites).toEqual([]);
  expectNothingUnexpected(state);
});

test("a clear set that changed since the editor opened is refused; Load latest rebuilds the set, keeps the tick, and the save then names every product", async ({ page }) => {
  const state = await openStep(page, categoriesState());
  await openEditor(page, "Sleeves", SLEEVES);
  await pickPolicy(page, "shippingPolicy", "Sleeves", "USPS Priority Mail");
  await clearBox(page, "shippingPolicy").getByRole("checkbox").check();
  await expect(clearBox(page, "shippingPolicy")).toContainText("2 products in Sleeves have their own shipping policy.");
  // Soft Sleeves gets its own shipping policy in another window after the editor read the set.
  state.productSettings[productKey(STORE, SOFT.productId)] = { revisionId: 12, values: { ...NO_VALUES, shippingPolicy: { id: "ground", name: "USPS Ground Advantage" } } };
  await saveButton(page).click();
  await expect(footer(page)).toContainText("The products in Sleeves changed. Load the latest and save again. A Card Shellz change can take a minute to show.");
  expect(state.categorySettingsWrites).toHaveLength(1);
  expect(state.categorySettingsWrites[0].body.clear).toEqual({ fields: ["shippingPolicy"],
    products: [{ productId: PENNY.productId, expectedRevisionId: 7 }, { productId: TEAM.productId, expectedRevisionId: null }] });

  await footer(page).getByRole("button", { name: "Load latest and keep my changes" }).click();
  await expect(footer(page)).toContainText("Here's what's saved now. Your changes are on top; fields you both changed are marked.");
  // The choice and the tick are kept; the set is the new one.
  await expect(settingRow(page, "shippingPolicy")).toContainText("→ USPS Priority Mail · Not saved");
  await expect(clearBox(page, "shippingPolicy")).toContainText("3 products in Sleeves have their own shipping policy.");
  await expect(clearBox(page, "shippingPolicy").getByRole("checkbox")).toBeChecked();
  // The category's own value did not move: nothing is marked as changed in another window too.
  await expect(settingRow(page, "shippingPolicy")).not.toContainText("Changed in another window too");

  await saveButton(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.categorySettingsWrites).toHaveLength(2);
  expect(state.categorySettingsWrites[1].body).toEqual({ idempotencyKey: KEY("ls-cat"), expectedRevisionId: null, patch: { shippingPolicy: { id: "priority" } },
    clear: { fields: ["shippingPolicy"], products: [
      { productId: PENNY.productId, expectedRevisionId: 7 }, { productId: TEAM.productId, expectedRevisionId: null }, { productId: SOFT.productId, expectedRevisionId: 12 },
    ] } });
  expect(state.categorySettingsWrites[1].body.idempotencyKey).not.toBe(state.categorySettingsWrites[0].body.idempotencyKey);
  expect(state.productSettings[productKey(STORE, SOFT.productId)].values.shippingPolicy).toBeNull();
  await expect(clearBox(page, "shippingPolicy")).toHaveCount(0);
  expectNothingUnexpected(state);
});

test("a save whose answer was lost is checked again with the same key and body; Esc keeps the editor, and the card row keeps its Change", async ({ page }) => {
  const state = await openStep(page, { ...categoriesState(), categorySettingsWriteAnswers: ["drop"] });
  await openEditor(page, "Sleeves", SLEEVES);
  await pickPolicy(page, "shippingPolicy", "Sleeves", "USPS Priority Mail");
  await saveButton(page).click();
  await expect(footer(page)).toContainText("We couldn't confirm your save.");
  // Locked until it is checked: nothing in the editor can change, and Discard is off.
  await expect(changeButton(page, "shippingPolicy", "Sleeves")).toBeDisabled();
  await expect(clearBox(page, "shippingPolicy").getByRole("checkbox")).toBeDisabled();
  await expect(footer(page).getByRole("button", { name: "Discard" })).toBeDisabled();
  // Esc keeps the editor open while nobody could confirm the save (plan 3.4).
  await page.keyboard.press("Escape");
  await expect(editor(page)).toBeVisible();
  await expect(footer(page)).toContainText("We couldn't confirm your save.");
  // The card row still has its Change while the save is unconfirmed, so Check again stays reachable after Back; by element,
  // since the open sheet hides the page behind it from the accessibility tree. (The D11 rule that keeps it under older
  // rules is pinned by the lib and component tests: this store holds none.)
  await expect(cardRow(page, SLEEVES).locator("button")).toHaveCount(1);

  await footer(page).getByRole("button", { name: "Check again" }).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.categorySettingsWrites).toHaveLength(2);
  expect(state.categorySettingsWrites[1].body).toEqual(state.categorySettingsWrites[0].body);
  expect(state.categorySettingsWrites[0].body).toEqual({ idempotencyKey: KEY("ls-cat"), expectedRevisionId: null, patch: { shippingPolicy: { id: "priority" } } });
  await expect(settingRow(page, "shippingPolicy")).toContainText("Set for Sleeves");
  expectNothingUnexpected(state);
});

test("Back closes the editor and keeps its change; opening the category again shows it; × asks first, and replaces the address (D21)", async ({ page }, testInfo) => {
  const state = await openStep(page, categoriesState());
  const historyLength = () => page.evaluate(() => window.history.length);
  const startLength = await historyLength();
  await openEditor(page, "Sleeves", SLEEVES);
  expect(await historyLength()).toBe(startLength + 1);
  await pickPolicy(page, "shippingPolicy", "Sleeves", "USPS Priority Mail");
  await expect(bar(page)).toHaveText("Not saved · 1 change in Sleeves");

  await page.goBack();
  await expect(editor(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  // The change is kept in the step's one draft (D16), so the bar still names it.
  await expect(bar(page)).toHaveText("Not saved · 1 change in Sleeves");
  expect(state.categorySettingsWrites).toEqual([]);

  await openEditor(page, "Sleeves", SLEEVES);
  await expect(settingRow(page, "shippingPolicy")).toContainText("→ USPS Priority Mail · Not saved");
  await expect(footer(page)).toContainText(phone(testInfo) ? "● Not saved · 1" : "● Not saved · 1 change");
  // × with a change asks first; Keep editing keeps it, Discard and leave drops it and closes in place.
  const dialog = page.getByRole("alertdialog");
  await editor(page).getByRole("button", { name: phone(testInfo) ? "Back" : "Close" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(editor(page)).toBeVisible();
  await expect(settingRow(page, "shippingPolicy")).toContainText("→ USPS Priority Mail · Not saved");
  await editor(page).getByRole("button", { name: phone(testInfo) ? "Back" : "Close" }).click();
  await dialog.getByRole("button", { name: "Discard and leave" }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(bar(page)).toHaveText("All saved");
  // Replaced, not pushed: Back goes before the editor was first opened and leaves it shut.
  await page.goBack();
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(editor(page)).toHaveCount(0);
  expect(state.categorySettingsWrites).toEqual([]);
  expectNothingUnexpected(state);
});

test("a link opens the editor from the address alone, with one detail read and nothing sent (D21)", async ({ page }, testInfo) => {
  const state = await openStep(page, categoriesState(), `${SETUP_PATH}?category=${SLEEVES}`);
  await expect(editor(page)).toBeVisible();
  await expect(editor(page).getByTestId("category-editor-rows")).toBeVisible();
  // Named by the read, since no card row opened it.
  await expect(editor(page)).toContainText("Sleeves · 3 products");
  await expect(settingRow(page, "shippingPolicy")).toContainText("USPS Ground Advantage");
  expect(readsOf(state, "GET", categoryPath(SLEEVES))).toHaveLength(1);
  for (const key of ["shippingPolicy", "returnPolicy", "paymentPolicy", "ebayCategory", "storeShelf", "descriptionTemplate"] as const) {
    await expect(changeButton(page, key, "Sleeves")).toBeEnabled();
  }
  await expect(bar(page)).toHaveText("All saved");
  await editor(page).getByRole("button", { name: phone(testInfo) ? "Back" : "Close" }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  expect(state.categorySettingsWrites).toEqual([]);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("a link to a category no chosen product is in closes the editor, replaces the address, says so under the card and reads it again (8.6)", async ({ page }) => {
  const state = await openStep(page, categoriesState(), `${SETUP_PATH}?category=999`);
  await expect(card(page)).toBeVisible();
  await expect(editor(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(card(page).getByTestId("category-settings-notice")).toHaveText("No chosen product is in this category any more.");
  await expect(card(page).getByTestId("category-settings-rows").locator("li")).toHaveCount(3);
  await expect.poll(() => readsOf(state, "GET", CATEGORIES_PATH).length).toBeGreaterThanOrEqual(2);
  expect(readsOf(state, "GET", categoryPath(999))).toHaveLength(1);
  // Replaced, not pushed: Back leaves the step.
  await expect(bar(page)).toHaveText("All saved");
  // Opening a category again takes the line away.
  await openEditor(page, "Sleeves", SLEEVES);
  await expect(page.getByTestId("category-settings-notice")).toHaveCount(0);
  expect(state.categorySettingsWrites).toEqual([]);
  expectNothingUnexpected(state);
});

test("a save for a category no chosen product is in any more is refused: the editor closes, the card says why and no longer lists it (8.6)", async ({ page }) => {
  const state = await openStep(page, categoriesState());
  await openEditor(page, "Sleeves", SLEEVES);
  await pickPolicy(page, "shippingPolicy", "Sleeves", "USPS Priority Mail");
  // Card Shellz moved every chosen Sleeves product out of the category while the editor was open.
  state.catalog = state.catalog.filter((product) => product.categoryId !== SLEEVES);
  await saveButton(page).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  expect(state.categorySettingsWrites).toHaveLength(1);
  await expect(card(page).getByTestId("category-settings-notice")).toHaveText("No chosen product is in this category any more.");
  await expect(cardRow(page, SLEEVES)).toHaveCount(0);
  await expect(card(page).getByTestId("category-settings-rows").locator("li")).toHaveCount(2);
  // The change went with the editor (the category can't take it); nothing is left unsaved.
  await expect(bar(page)).toHaveText("All saved");
  expectNothingUnexpected(state);
});

test("a save whose re-read fails keeps the rows and offers Reload; Reload then shows what was saved (saved_view_stale, D9)", async ({ page }) => {
  const state = await openStep(page, categoriesState());
  // Every read of the detail fails while `failing` (the save's own re-read, then the step's refresh of every view), as
  // `failNextRead` fails one; the failed reads never reach the stub.
  let failing = false;
  await page.route((url) => url.pathname === categoryPath(SLEEVES), async (route) => {
    if (failing && route.request().method() === "GET") {
      await route.fulfill({ status: 500, json: { error: { code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", message: "Read failed." } } });
      return;
    }
    await route.fallback();
  });
  await openEditor(page, "Sleeves", SLEEVES);
  await pickPolicy(page, "shippingPolicy", "Sleeves", "USPS Priority Mail");
  failing = true;
  await saveButton(page).click();
  await expect(footer(page)).toContainText("Saved. We couldn't load the latest view.");
  expect(state.categorySettingsWrites).toHaveLength(1);
  expect(state.categorySettings[categoryKey(STORE, SLEEVES)].values.shippingPolicy).toEqual(PRIORITY);
  // The rows stay (the answer the editor opened on), with the line that the latest read failed; Reload is in the footer.
  await expect(editor(page).getByTestId("category-editor-rows")).toBeVisible();
  await expect(editor(page).getByTestId("category-editor-latest-failed")).toContainText("Couldn't load the latest view.");
  await expect(editor(page).getByTestId("category-editor-read-problem")).toHaveCount(0);
  await expect(settingRow(page, "shippingPolicy")).toContainText("USPS Ground Advantage");
  await expect(settingRow(page, "shippingPolicy")).not.toContainText("Not saved");
  await expect(bar(page)).toHaveText("All saved");

  failing = false;
  await footer(page).getByRole("button", { name: "Reload" }).click();
  await expect(settingRow(page, "shippingPolicy")).toContainText("USPS Priority Mail");
  await expect(settingRow(page, "shippingPolicy")).toContainText("Set for Sleeves");
  await expect(editor(page).getByTestId("category-editor-latest-failed")).toHaveCount(0);
  await expect(footer(page)).not.toContainText("Saved. We couldn't load the latest view.");
  await expect(cardRow(page, SLEEVES)).toContainText("Sleeves · 3 products · Sets: shipping policy");
  expect(state.categorySettingsWrites).toHaveLength(1);
  expectNothingUnexpected(state);
});

test("the description editor offers text above and below with Use store default and no main text, and own text is saved as typed (D17)", async ({ page }) => {
  const state = await openStep(page, categoriesState());
  await openEditor(page, "Sleeves", SLEEVES);
  await expect(settingRow(page, "descriptionTemplate")).toContainText("Card Shellz text");
  await changeButton(page, "descriptionTemplate", "Sleeves").click();
  const description = fieldEditor(page, "description");
  await expect(description).toBeVisible();
  // A category has no main text: only text above and below, each with "Use store default".
  await expect(description.getByTestId("drawer-description-textAbove")).toBeVisible();
  await expect(description.getByTestId("drawer-description-textBelow")).toBeVisible();
  await expect(description.getByTestId("drawer-description-mainText")).toHaveCount(0);
  await expect(description.getByRole("radio", { name: "Use store default" })).toHaveCount(2);
  await expect(description.getByRole("radio", { name: "Use default", exact: true })).toHaveCount(0);
  await description.getByTestId("drawer-description-textAbove").getByRole("radio", { name: "Own text" }).check();
  await description.getByLabel("Text above for Sleeves").fill("Ships fast from our shop.");
  await description.getByRole("button", { name: "Done" }).click();
  await expect(settingRow(page, "descriptionTemplate")).toContainText("→ Text above: your own · Not saved");

  await saveButton(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.categorySettingsWrites).toEqual([{ method: "PUT", path: categoryPath(SLEEVES),
    body: { idempotencyKey: KEY("ls-cat"), expectedRevisionId: null, patch: { textAbove: { mode: "own", text: "Ships fast from our shop." } } } }]);
  await expect(settingRow(page, "descriptionTemplate")).toContainText("Card Shellz text, with your text above");
  await expect(settingRow(page, "descriptionTemplate")).toContainText("Set for Sleeves");
  await expect(cardRow(page, SLEEVES)).toContainText("Sets: text above");
  expectNothingUnexpected(state);
});

test("a category price is checked with a shelf, a shipping change and Also clear theirs riding along, then saved in one apply; the rows and the card read again; never W12 (9.1, 9.2, D2, D9)", async ({ page }, testInfo) => {
  const state = await openStep(page, pricedCategoriesState());
  await openEditor(page, "Sleeves", SLEEVES);
  // The store price, with the sizes' prices as they are now.
  await expect(priceRow(page)).toContainText("Retail price + 15%, to the cent");
  await expect(priceRow(page)).toContainText("Store default");
  const now = rulePrice(SAVED_PRICING_RULES.profile!.defaultRecipe);
  await expect(priceRow(page).getByTestId("category-price-examples")).toHaveText(`Now: Pack of 100 ${now} · Pack of 100 ${now} · Pack of 100 ${now}`);
  // A shipping policy with its clear box ticked rides along in the one check (D2), and so does a store shelf, which the
  // review resolves with eBay as W12 does (its id is new to the category).
  await pickPolicy(page, "shippingPolicy", "Sleeves", "USPS Priority Mail");
  await clearBox(page, "shippingPolicy").getByRole("checkbox").check();
  await changeButton(page, "storeShelf", "Sleeves").click();
  await fieldEditor(page, "storeShelf").getByRole("combobox", { name: "Shelf for Sleeves" }).click();
  await page.getByRole("option", { name: "Sale", exact: true }).click();
  await expect(page.getByRole("option")).toHaveCount(0);
  await fieldEditor(page, "storeShelf").getByRole("button", { name: "Done" }).click();
  await expect(settingRow(page, "storeShelf")).toContainText("→ Sale · Not saved");
  // The price editor offers "Use store default" (D17) and no "Clear exact prices too" (a category check releases nothing).
  await setPricePercent(page, "Sleeves", "20");
  await expect(priceEditor(page).getByRole("radio", { name: "Use store default" })).toBeVisible();
  await expect(priceEditor(page).getByRole("checkbox")).toHaveCount(0);
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();

  // The check replaces the editor's body (D20): one review for the category, with the editor's other changes and the clear set.
  await expect(check(page)).toBeVisible();
  await expect(editor(page).getByTestId("category-editor-rows")).toHaveCount(0);
  await expect(editor(page)).toContainText("Sleeves · 3 products");
  expect(state.priceChangeReviews).toEqual([{ method: "POST", path: REVIEW_PATH, body: {
    kind: "category_price", categoryId: SLEEVES, expectedRevisionId: null,
    patch: { price: RETAIL_20, shippingPolicy: { id: "priority" }, storeShelf: { mode: "own", shelfIds: ["12"] } },
    clear: { fields: ["shippingPolicy"], products: [{ productId: PENNY.productId, expectedRevisionId: 7 }, { productId: TEAM.productId, expectedRevisionId: null }] },
  } }]);
  await expect(check(page).getByTestId("price-check-head")).toHaveText("Checking: Retail price + 20%, to the cent · Not saved yet");
  // The other settings in the stored shape's order (the shelf before the shipping policy).
  await expect(check(page).getByTestId("price-check-also")).toHaveText(["Also saves: store shelf, shipping policy.", "Clears 2 products' own shipping policy."]);
  await expect(check(page).getByTestId("price-check-counts")).toHaveText("3 sizes · 3 change");
  for (const product of [PENNY, TEAM, SOFT]) {
    const row = check(page).getByTestId(`price-check-size-${product.sizes[0].productVariantId}`);
    await expect(row).toContainText(product.productName);
    await expect(row).toContainText(`Category price, from retail ${dollars(RETAIL_CENTS)}`);
    await expect(row).toContainText(now);
    await expect(row).toContainText(rulePrice(RETAIL_20));
  }
  await expect(bar(page)).toHaveText("Not saved · 4 changes in Sleeves");
  expect(state.priceChangeApplies).toEqual([]);
  await shot(page, testInfo, "listing-settings-category-price-check");

  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(footer(page)).toContainText("Saved");
  const [held] = Object.values(state.priceChangeChecks);
  expect(state.priceChangeApplies).toEqual([{ method: "POST", path: APPLY_PATH,
    body: { reviewId: held.reviewId, reviewHash: held.reviewHash, idempotencyKey: KEY("ls-price-check") } }]);
  // The editor's body shows again from the views read again (D9): the category, the categories, the products and the
  // summary now; the prices view is invalidated too and reads when its tab shows (nothing watches it under Products).
  const postAt = state.reads.findIndex((read) => read.method === "POST" && read.path === APPLY_PATH);
  for (const path of [categoryPath(SLEEVES), CATEGORIES_PATH, PRODUCTS_PATH, SUMMARY_PATH]) {
    await expect.poll(() => readsAfter(state, postAt, "GET", path), path).toBeGreaterThanOrEqual(1);
  }
  await expect(check(page)).toHaveCount(0);
  await expect(priceRow(page)).toContainText("Retail price + 20%, to the cent");
  await expect(priceRow(page)).toContainText("Set for Sleeves");
  await expect(priceRow(page)).not.toContainText("Not saved");
  await expect(settingRow(page, "shippingPolicy")).toContainText("USPS Priority Mail");
  await expect(settingRow(page, "shippingPolicy")).toContainText("Set for Sleeves");
  await expect(settingRow(page, "storeShelf")).toContainText("Sale");
  await expect(settingRow(page, "storeShelf")).toContainText("Set for Sleeves");
  await expect(clearBox(page, "shippingPolicy")).toHaveCount(0);
  await expect(bar(page)).toHaveText("All saved");
  await expect(cardRow(page, SLEEVES)).toContainText("Sleeves · 3 products · Sets: price, store shelf, shipping policy");
  expect(state.categorySettings[categoryKey(STORE, SLEEVES)].values.price).toEqual(RETAIL_20);
  expect(state.categorySettings[categoryKey(STORE, SLEEVES)].values.shippingPolicy).toEqual(PRIORITY);
  // The shelf as eBay named it, resolved by the review and written by the apply.
  expect(state.categorySettings[categoryKey(STORE, SLEEVES)].values.storeShelf).toMatchObject({ mode: "own", shelves: [{ id: "12" }] });
  expect(state.productSettings[productKey(STORE, PENNY.productId)].values.shippingPolicy).toBeNull();
  expect(state.sizeLeftovers[sizeKey(STORE, TEAM.sizes[0].productVariantId)]).toEqual({});
  // A category price never goes through W12 (9.7).
  expect(state.categorySettingsWrites).toEqual([]);
  expectNothingUnexpected(state);
});

test("Use store default over the category's own price is checked and applied as null, and the row then reads the store price", async ({ page }) => {
  const initial = pricedCategoriesState();
  initial.categorySettings![categoryKey(STORE, SLEEVES)] = { revisionId: 5, values: { ...NO_CATEGORY_VALUES, price: RETAIL_20 } };
  const state = await openStep(page, initial);
  await openEditor(page, "Sleeves", SLEEVES);
  await expect(priceRow(page)).toContainText("Retail price + 20%, to the cent");
  await expect(priceRow(page)).toContainText("Set for Sleeves");
  await changePrice(page, "Sleeves").click();
  await expect(priceEditor(page).getByRole("radio", { name: "Set price" })).toBeChecked();
  await priceEditor(page).getByRole("radio", { name: "Use store default" }).check();
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(check(page)).toBeVisible();
  expect(state.priceChangeReviews).toEqual([{ method: "POST", path: REVIEW_PATH,
    body: { kind: "category_price", categoryId: SLEEVES, expectedRevisionId: 5, patch: { price: null } } }]);
  await expect(check(page).getByTestId("price-check-head")).toHaveText("Checking: Use store default · Not saved yet");
  await expect(check(page).getByTestId("price-check-also")).toHaveCount(0);
  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.priceChangeApplies).toHaveLength(1);
  expect(state.categorySettings[categoryKey(STORE, SLEEVES)].values.price).toBeNull();
  await expect(priceRow(page)).toContainText("Retail price + 15%, to the cent");
  await expect(priceRow(page)).toContainText("Store default");
  expect(state.categorySettingsWrites).toEqual([]);
  expectNothingUnexpected(state);
});

test("while the store holds older group rules the Price row has no Change (D11); rules added after the check opened refuse the apply with the one line, and Back to editing is the way out (9.4)", async ({ page }) => {
  const ruled = await openStep(page, { ...pricedCategoriesState(), pricingRules: { [STORE]: pricingRulesWithGroup() } }, `${SETUP_PATH}?category=${SLEEVES}`);
  await expect(editor(page).getByTestId("category-editor-rows")).toBeVisible();
  await expect(changePrice(page, "Sleeves")).toHaveCount(0);
  await expect(priceRow(page).getByTestId("category-price-examples")).toBeVisible();
  await expect(footer(page)).toContainText("Category settings can't be saved while your store has older group rules.");
  expect(ruled.priceChangeReviews).toEqual([]);
  expectNothingUnexpected(ruled);
  await page.goto("about:blank");

  // The race: a pricing group arrives between the check and its apply (the server's 2.5; the 409 is the backstop).
  const state = await openStep(page, pricedCategoriesState());
  await openEditor(page, "Sleeves", SLEEVES);
  await setPricePercent(page, "Sleeves", "20");
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(check(page)).toBeVisible();
  state.pricingRules[STORE] = pricingRulesWithGroup();
  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  const line = "Category settings can't be saved while your store has older group rules.";
  await expect(checkFooter(page)).toContainText(line);
  await expect(checkFooter(page).getByRole("button", { name: "Save new prices" })).toBeDisabled();
  // [See what changes] beside the line in the check's footer too (PR 11b, plan 11.1), before Back to editing.
  await expect(checkFooter(page).getByRole("button")).toHaveText(["See what changes", /^Back( to editing)?$/, "Save new prices"]);
  expect(state.priceChangeApplies).toHaveLength(1);
  expect(state.categorySettings[categoryKey(STORE, SLEEVES)]).toBeUndefined();
  // The card read the summary again and took every Change away (D11), as after W12's refusal (by element: the open
  // sheet hides the page behind it from the accessibility tree); its one button is See what changes (PR 11b).
  await expect(card(page).locator("button")).toHaveText(["See what changes"]);
  await expect(card(page)).toContainText(line);
  // Back to editing: the editor's body with the change kept, no Change on the Price row either, Check new prices off
  // with the one line, and no second apply.
  await checkFooter(page).getByRole("button", { name: /^Back( to editing)?$/ }).click();
  await expect(check(page)).toHaveCount(0);
  await expect(editor(page).getByTestId("category-editor-rows")).toBeVisible();
  await expect(priceRow(page)).toContainText("→ Retail price + 20%, to the cent · Not saved");
  await expect(changePrice(page, "Sleeves")).toHaveCount(0);
  await expect(editor(page).getByRole("button", { name: /^Change / })).toHaveCount(0);
  await expect(checkNewPrices(page)).toBeDisabled();
  await expect(footer(page)).toContainText(line);
  await expect(bar(page)).toHaveText("Not saved · 1 change in Sleeves");
  expect(state.priceChangeApplies).toHaveLength(1);
  expect(state.priceChangeReviews).toHaveLength(1);
  expect(state.categorySettingsWrites).toEqual([]);
  expectNothingUnexpected(state);
});

test("a category whose revision moved under the apply is a conflict: the editor's body comes back with Load latest, which keeps the price; the new check carries the new revision (9.4, D6)", async ({ page }) => {
  const initial = pricedCategoriesState();
  initial.categorySettings![categoryKey(STORE, SLEEVES)] = { revisionId: 5, values: { ...NO_CATEGORY_VALUES, returnPolicy: { ...NO_RETURNS } } };
  const state = await openStep(page, initial);
  await openEditor(page, "Sleeves", SLEEVES);
  await setPricePercent(page, "Sleeves", "20");
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(check(page)).toBeVisible();
  expect(state.priceChangeReviews[0].body.expectedRevisionId).toBe(5);
  // Another window saved the category meanwhile (the same values at a new revision: the rows still hash the same).
  state.categorySettings[categoryKey(STORE, SLEEVES)] = { revisionId: 6, values: { ...NO_CATEGORY_VALUES, returnPolicy: { ...NO_RETURNS } } };
  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  // The editor's body is back, with Load latest (never a re-check over a moved category).
  await expect(check(page)).toHaveCount(0);
  await expect(editor(page).getByTestId("category-editor-rows")).toBeVisible();
  await expect(footer(page).getByRole("button", { name: "Load latest and keep my changes" })).toBeVisible();
  expect(state.priceChangeApplies).toHaveLength(1);
  expect(state.priceChangeReviews).toHaveLength(1);
  expect(state.categorySettings[categoryKey(STORE, SLEEVES)].values.price).toBeNull();

  await footer(page).getByRole("button", { name: "Load latest and keep my changes" }).click();
  await expect(footer(page)).toContainText("Here's what's saved now. Your changes are on top; fields you both changed are marked.");
  await expect(priceRow(page)).toContainText("→ Retail price + 20%, to the cent · Not saved");
  await expect(priceRow(page).getByTestId("category-price-examples")).toHaveCount(0);
  // Save is the check again, from the revision read now (D6); then the apply saves.
  await checkNewPrices(page).click();
  await expect(check(page)).toBeVisible();
  expect(state.priceChangeReviews).toHaveLength(2);
  expect(state.priceChangeReviews[1].body).toEqual({ kind: "category_price", categoryId: SLEEVES, expectedRevisionId: 6, patch: { price: RETAIL_20 } });
  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.priceChangeApplies).toHaveLength(2);
  expect(state.priceChangeApplies[1].body.idempotencyKey).not.toBe(state.priceChangeApplies[0].body.idempotencyKey);
  expect(state.categorySettings[categoryKey(STORE, SLEEVES)].values.price).toEqual(RETAIL_20);
  expect(state.categorySettings[categoryKey(STORE, SLEEVES)].revisionId).not.toBe(6);
  await expect(priceRow(page)).toContainText("Set for Sleeves");
  expectNothingUnexpected(state);
});

test("an apply whose answer was lost is checked again with the same key and body; Esc keeps the editor and the check meanwhile (D5, D7)", async ({ page }) => {
  const state = await openStep(page, { ...pricedCategoriesState(), priceChangeApplyAnswers: ["drop"] });
  await openEditor(page, "Sleeves", SLEEVES);
  await setPricePercent(page, "Sleeves", "20");
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(check(page)).toBeVisible();
  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(checkFooter(page)).toContainText("We couldn't confirm your save.");
  await expect(checkFooter(page)).not.toContainText("Nothing was saved");
  await page.keyboard.press("Escape");
  await expect(editor(page)).toBeVisible();
  await expect(check(page)).toBeVisible();
  await checkFooter(page).getByRole("button", { name: "Check again" }).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.priceChangeApplies).toHaveLength(2);
  expect(state.priceChangeApplies[1].body).toEqual(state.priceChangeApplies[0].body);
  expect(state.priceChangeApplies[0].body.idempotencyKey).toEqual(KEY("ls-price-check"));
  expect(state.categorySettings[categoryKey(STORE, SLEEVES)].values.price).toEqual(RETAIL_20);
  await expect(priceRow(page)).toContainText("Set for Sleeves");
  expectNothingUnexpected(state);
});

test("on a phone the editor fills the screen, a field editor opens inside it, and Save stays in view with no sideways scroll", async ({ page }, testInfo) => {
  test.skip(!phone(testInfo), "The phone layout (below 640 px) only.");
  const state = await openStep(page, categoriesState());
  const change = changeCategory(page, "Sleeves");
  expect((await change.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await openEditor(page, "Sleeves", SLEEVES);
  await expectSheetLayout(page, testInfo, editor(page));
  await changeButton(page, "shippingPolicy", "Sleeves").click();
  await expect(fieldEditor(page, "shippingPolicy")).toBeVisible();
  // Inline in the editor: no second sheet opens over it (D20).
  await expect(page.getByTestId("editor-surface")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await fieldEditor(page, "shippingPolicy").getByRole("radio", { name: /^USPS Priority Mail/ }).check();
  await fieldEditor(page, "shippingPolicy").getByRole("button", { name: "Done" }).click();
  await expect(footer(page)).toContainText("● Not saved · 1");
  await expect(saveButton(page)).toHaveText("Save");
  await expectInView(page, saveButton(page));
  await expectNoHorizontalScroll(page);
  await shot(page, testInfo, "listing-settings-category-editor-phone");
  await saveButton(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.categorySettingsWrites).toHaveLength(1);
  expectNothingUnexpected(state);
});
