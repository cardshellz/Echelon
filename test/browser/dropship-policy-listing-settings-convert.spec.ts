import { expect, test, type Page } from "@playwright/test";
import type { ConversionChangeRow, ConversionSizeView, ListingRulesConversionCheck } from "../../shared/dropship/listing-rules-conversion";
import type { ListingSettingsSizePrice } from "../../shared/dropship/listing-settings";
import {
  SAVED_PRICING_RULES,
  conversionCheck,
  shot,
  type ProductFixture,
  type ScriptedError,
  type StubState,
} from "./dropship-policy-catalog-stubs";
import {
  LISTINGS,
  SETUP_PATH,
  STORE,
  banner,
  drawer,
  exactBox,
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
 * The older-rules line and the read-only "Your older group rules" sheet (Listing settings PR 11, part 11b; plan
 * 5.2-5.5, 11.1, 11.2, 11.5; D17, D18, D20, D21, K7): a store that still holds older group rules shows one line under
 * the attention strip, in the form that fits it, with [See what changes]; the Category settings card has the same
 * button under its line, and its rows read "No category settings yet". The button puts the sheet in the address
 * (`?sheet=convert`), which reads the dry run (`GET …/listing-settings/conversion?page=N`) only while it is open:
 * the server's words and rows, 50 at a time with [Load more], one plan per screen, and for each blocked size
 * [Set a price] or [Fix], which open the drawer in one push so Back returns to the sheet. Nothing can be moved yet.
 * The stub serves scripted pages, each parsed with the strict contract where it is built (this file's load) and
 * when served; it never computes a diff. Every journey ends with nothing unexpected asked and no page error.
 * Desktop and phone.
 */

const CONVERSION_PATH = `${LISTINGS}/listing-settings/conversion`;
const SUMMARY_PATH = `${LISTINGS}/listing-settings/summary`;
const CATEGORIES_PATH = `${LISTINGS}/listing-settings/categories`;
const PLAN_A = "a".repeat(64);
const PLAN_B = "b".repeat(64);
const WRITES = "c".repeat(64);
const DESCRIPTION = "d".repeat(64);
const SLEEVES = 40;
/** The line's, the card's and the editor's button. */
const SEE_WHAT_CHANGES = "See what changes";

function product(productId: number, productName: string, category: { name: string; id: number } | null): ProductFixture {
  return {
    productId, productName, productSku: `CAT-${productId}`, category: category?.name ?? null, categoryId: category?.id ?? null,
    sizes: [{ productVariantId: productId * 10, sizeName: "Pack of 100", sku: `CAT-${productId}-100`, retailCents: 399, costCents: 210, stockUnits: 12 }],
  };
}

const PENNY = product(3_001, "Penny Sleeves", { name: "Sleeves", id: SLEEVES });
const TEAM = product(3_002, "Team Bags", { name: "Sleeves", id: SLEEVES });
/** No Card Shellz category. */
const LOOSE = product(3_006, "Loose Packs", null);

/** The store's pricing rules with one category-scope group (the categories spec's fixture): the store holds older group rules. */
function pricingRulesWithGroup() {
  const profile = SAVED_PRICING_RULES.profile!;
  return { ...SAVED_PRICING_RULES, profile: { ...profile,
    groups: [{ id: "sleeves", name: "Sleeves", priority: 1, scope: { type: "category" as const, category: "Sleeves" }, recipe: profile.defaultRecipe }] } };
}

/** Two products in Sleeves and the one pricing group; the dry run answers as each journey scripts it. A new copy each time. */
function convertState(overrides: Partial<StubState> = {}): Partial<StubState> {
  return { catalog: structuredClone([PENNY, TEAM]), pricingRules: { [STORE]: pricingRulesWithGroup() }, ...overrides };
}

// ---------------------------------------------------------------------------
// Scripted dry-run pages, each parsed with the strict contract here (at load)
// ---------------------------------------------------------------------------

function sizePrice(productId: number, productVariantId: number, productName: string, sizeName: string, overrides: Partial<ListingSettingsSizePrice> = {}): ListingSettingsSizePrice {
  return {
    productVariantId, productId, productName, sizeName, sku: null, priceCents: 479, source: "rules",
    rule: { kind: "group", name: "Sleeves", recipe: { basis: "catalog_retail", markupBps: 2_000, flatCents: 0, rounding: "cent" } },
    basis: "catalog_retail", basisAmountCents: 399, issue: null, costCents: 210, belowCostByCents: null, limits: [], pausedSince: null,
    settingRevisionId: null, ...overrides,
  };
}

/** A size that follows the group today ($4.79) and the retail price after the move ($3.99). */
function changedRow(index: number, productName: string): ConversionChangeRow {
  const productId = 4_000 + index;
  const productVariantId = 40_000 + index;
  const sizeName = `Pack of ${index + 1}`;
  const side = (overrides: Partial<ConversionSizeView>): ConversionSizeView => ({
    price: sizePrice(productId, productVariantId, productName, sizeName),
    pricingRule: { kind: "group", name: "Sleeves", recipe: { basis: "catalog_retail", markupBps: 2_000, flatCents: 0, rounding: "cent" } },
    ebayCategory: { id: "183435", name: "Card Sleeves" }, shelfNames: [], policies: { shipping: "ground", return: null, payment: null },
    descriptionHash: DESCRIPTION, blockers: [], ...overrides,
  });
  return {
    productVariantId, productId, productName, sizeName, changed: ["price", "priceSource", "pricingRule"],
    before: side({}),
    after: side({ price: sizePrice(productId, productVariantId, productName, sizeName, { priceCents: 399, source: "retail_fallback", rule: null, basis: null, basisAmountCents: null }), pricingRule: null }),
  };
}

const none = () => ({ total: 0, items: [] });

/** Clean: the group becomes Sleeves' price; two exact prices are kept. */
const CLEAN = conversionCheck(STORE, {
  planHash: PLAN_A, writesHash: WRITES,
  becomes: { categories: { total: 1, items: [{ categoryId: SLEEVES, categoryName: "Sleeves", settings: ["price"] }] }, products: none() },
  kept: { exactPrices: 2, catalogPrices: 0, sizePolicies: 0, sizeShelves: 0, sizeTexts: 0 },
});

/**
 * Not clean, for plan `planHash`: Penny Sleeves' size would lose its price, Team Bags' listed size would lose its eBay
 * category, a tie, and 60 changed sizes, 50 on page 0 and 10 on page 1, named `rowName`.
 */
function notCleanPage(page: 0 | 1, planHash: string, rowName: string): ListingRulesConversionCheck {
  const first = page * 50;
  const rows = Array.from({ length: page === 0 ? 50 : 10 }, (_, index) => changedRow(first + index, rowName));
  return conversionCheck(STORE, {
    state: "not_clean", planHash, writesHash: WRITES,
    blocked: {
      wouldLosePrice: { total: 1, items: [{ productId: PENNY.productId, productVariantId: PENNY.sizes[0].productVariantId, productName: PENNY.productName,
        sizeName: PENNY.sizes[0].sizeName, priceCents: 479 }] },
      wouldBlockListing: { total: 1, items: [{ productId: TEAM.productId, productVariantId: TEAM.sizes[0].productVariantId, productName: TEAM.productName,
        sizeName: TEAM.sizes[0].sizeName, priceCents: 479, reasons: ["no_ebay_category"] }] },
      tooMuchText: false,
    },
    becomes: { categories: { total: 1, items: [{ categoryId: SLEEVES, categoryName: "Sleeves", settings: ["price"] }] }, products: none() },
    report: { unmatched: none(), shared: none(), nameMismatches: none(), neverApplies: none(),
      ties: { total: 1, items: [{ productId: TEAM.productId, productName: TEAM.productName, setting: "price" }] }, someSizesOnly: none(), mixed: none() },
    changes: { page, pageSize: 50, total: 60, rows },
  });
}

const NOT_CLEAN_A = [notCleanPage(0, PLAN_A, "Binder Pages"), notCleanPage(1, PLAN_A, "Binder Pages")] as const;
const NOT_CLEAN_B = [notCleanPage(0, PLAN_B, "Card Cases"), notCleanPage(1, PLAN_B, "Card Cases")] as const;
const CHECK_UNAVAILABLE: ScriptedError = {
  status: 503, code: "DROPSHIP_LISTING_CONVERSION_CHECK_UNAVAILABLE", message: "Costs could not be read.",
  context: { storeConnectionId: STORE, retryable: true, classification: "transient" },
};

// ---------------------------------------------------------------------------
// Locators and steps
// ---------------------------------------------------------------------------

function line(page: Page) {
  return page.getByTestId("older-rules-line");
}

function sheet(page: Page) {
  return page.getByTestId("older-rules-sheet");
}

function card(page: Page) {
  return page.getByTestId("category-settings-card");
}

function rows(page: Page) {
  return sheet(page).locator("[data-testid^='older-rules-row-']");
}

function conversionReads(state: StubState): string[] {
  return readsOf(state, "GET", CONVERSION_PATH).map((read) => read.search);
}

/** [See what changes] on the line: the sheet opens in the address and reads page 0. */
async function openSheet(page: Page) {
  await line(page).getByRole("button", { name: SEE_WHAT_CHANGES, exact: true }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(page).toHaveURL(`${SETUP_PATH}?sheet=convert`);
  await expect(sheet(page).getByRole("heading", { name: "Your older group rules" })).toBeVisible();
}

// ---------------------------------------------------------------------------
// The line and the card (plan 5.3, D17, K7)
// ---------------------------------------------------------------------------

test("a store with older group rules shows the line with See what changes and the card's opener; rows read No category settings yet; no dry run on mount", async ({ page }, testInfo) => {
  const state = await openStep(page, convertState());
  await expect(line(page)).toContainText("Your store still has older group rules. Move them over to use category settings.");
  // Under the attention strip, above the Store defaults card (10g's slot; no updated products here).
  expect(await line(page).evaluate((element) => element.previousElementSibling?.getAttribute("data-testid"))).toBe("listing-settings-attention");
  await expect(card(page)).toContainText("Category settings can't be saved while your store has older group rules.");
  await expect(card(page)).not.toContainText("later update");
  await expect(card(page).getByTestId("category-settings-row-40")).toContainText("Sleeves · 2 products · No category settings yet");
  await expect(card(page)).not.toContainText("Uses your store defaults");
  await expect(card(page).getByRole("button", { name: /^Change settings for/ })).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: SEE_WHAT_CHANGES, exact: true })).toBeVisible();
  if (phone(testInfo)) {
    expect((await line(page).getByRole("button", { name: SEE_WHAT_CHANGES }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalScroll(page);
  }
  await shot(page, testInfo, "listing-settings-older-rules-line");
  // The dry run is read only by the open sheet (D18): the mount reads are unchanged.
  expect(conversionReads(state)).toEqual([]);
  await expect(sheet(page)).toHaveCount(0);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("with no chosen product in a Card Shellz category the line is one sentence, still with See what changes", async ({ page }) => {
  const state = await openStep(page, convertState({ catalog: structuredClone([LOOSE]), conversionPages: { 0: CLEAN } }));
  await expect(line(page)).toContainText("Your store still has older group rules.");
  await expect(line(page)).not.toContainText("Move them over to use category settings.");
  await expect(card(page)).toContainText("None of your chosen products is in a Card Shellz category.");
  await expect(card(page).getByRole("button", { name: SEE_WHAT_CHANGES })).toHaveCount(0);
  await openSheet(page);
  await expect(sheet(page)).toContainText("Moving them over changes nothing in your listings.");
  expect(conversionReads(state)).toEqual(["?page=0"]);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("over 10,000 sizes the line says to choose fewer with no button, and nothing is checked (K7, D18)", async ({ page }) => {
  const state = await openStep(page, convertState({ tooLarge: true }));
  await expect(banner(page)).toBeVisible();
  await expect(line(page)).toContainText("Your store still has older group rules. Choose 10,000 or fewer sizes to move them over.");
  await expect(line(page).getByRole("button")).toHaveCount(0);
  await expect(card(page)).toHaveCount(0);
  await expect(sheet(page)).toHaveCount(0);
  expect(conversionReads(state)).toEqual([]);
  expectGatedReads(state);
  expectNothingUnexpected(state);

  // An old ?sheet=convert address can't open it either: at most the one check made before the summary answered,
  // refused as too large (as the card's and the lists' reads, D18).
  await page.goto("about:blank");
  const linked = await openStep(page, convertState({ tooLarge: true }), `${SETUP_PATH}?sheet=convert`);
  await expect(banner(page)).toBeVisible();
  await expect(line(page)).toContainText("Choose 10,000 or fewer sizes to move them over.");
  await expect(sheet(page)).toHaveCount(0);
  expect(conversionReads(linked).length).toBeLessThanOrEqual(1);
  expectNothingUnexpected(linked);
});

// ---------------------------------------------------------------------------
// The sheet (plan 5.3, 11.2)
// ---------------------------------------------------------------------------

test("See what changes pushes ?sheet=convert and reads page 0 once; a clean answer's words; Back closes it and focus is back on the button", async ({ page }, testInfo) => {
  const state = await openStep(page, convertState({ conversionPages: { 0: CLEAN } }));
  await openSheet(page);
  expect(conversionReads(state)).toEqual(["?page=0"]);
  await expect(sheet(page).getByTestId("older-rules-summary")).toHaveText("Moving them over changes nothing in your listings.");
  await expect(sheet(page).getByTestId("older-rules-later")).toHaveText("Products you choose later use their category's settings or your store defaults, not these rules.");
  await expect(sheet(page).getByTestId("older-rules-becomes")).toContainText("They become:");
  await expect(sheet(page).getByTestId("older-rules-becomes")).toContainText("Sleeves: price");
  await expect(sheet(page).getByTestId("older-rules-kept")).toHaveText("Kept as they are: 2 exact prices");
  await expect(sheet(page).getByTestId("older-rules-blocked")).toHaveCount(0);
  await expect(sheet(page).getByTestId("older-rules-changes")).toHaveCount(0);
  // Read-only (11b): the footer says so and only closes.
  const footer = sheet(page).getByTestId("older-rules-footer");
  await expect(footer).toContainText("This is a preview. Nothing is moved yet.");
  await expect(footer.getByRole("button")).toHaveText(["Close"]);
  await expect(sheet(page).getByRole("button", { name: /Move them over/ })).toHaveCount(0);
  await expectSheetLayout(page, testInfo, sheet(page));
  await expectInView(page, footer.getByRole("button", { name: "Close" }));
  if (phone(testInfo)) {
    await expect(sheet(page).getByRole("button", { name: "Back", exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
  }
  await shot(page, testInfo, "listing-settings-older-rules-clean");

  await page.goBack();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(line(page).getByRole("button", { name: SEE_WHAT_CHANGES })).toBeFocused();
  // Closing reads nothing more; reopening reads page 0 fresh, and Close replaces the address.
  expect(conversionReads(state)).toEqual(["?page=0"]);
  await openSheet(page);
  expect(conversionReads(state)).toEqual(["?page=0", "?page=0"]);
  await sheet(page).getByTestId("older-rules-footer").getByRole("button", { name: "Close" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(line(page).getByRole("button", { name: SEE_WHAT_CHANGES })).toBeFocused();
  // Close replaced the sheet's entry (D21): Back goes to the one before it, where the sheet stays shut and nothing is read.
  await page.goBack();
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(sheet(page)).toHaveCount(0);
  expect(conversionReads(state)).toEqual(["?page=0", "?page=0"]);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("a not-clean answer: the blocked sizes with Set a price and Fix, why sizes change, the rows, and Load more reads page 1", async ({ page }, testInfo) => {
  const state = await openStep(page, convertState({ conversionPages: { 0: NOT_CLEAN_A[0], 1: NOT_CLEAN_A[1] } }));
  await openSheet(page);
  await expect(sheet(page).getByTestId("older-rules-summary")).toHaveText("Moving them over would change 60 sizes. They're listed below.");
  const blocked = sheet(page).getByTestId("older-rules-blocked");
  await expect(blocked).toContainText("Before you can move them over");
  await expect(blocked.getByTestId("older-rules-lose-price")).toContainText("1 size would have no price after the move. Give it its own price, then check again.");
  await expect(blocked.getByTestId("older-rules-lose-price")).toContainText("Penny Sleeves · Pack of 100");
  await expect(blocked.getByTestId("older-rules-lose-price")).toContainText("Now: $4.79");
  await expect(blocked.getByTestId("older-rules-block-listing")).toContainText("1 size you list on eBay would stop getting stock updates after the move. Fix it, then check again.");
  await expect(blocked.getByTestId("older-rules-block-listing")).toContainText("no eBay category");
  const setPrice = blocked.getByRole("button", { name: "Set a price for Penny Sleeves · Pack of 100", exact: true });
  await expect(setPrice).toHaveText("Set a price");
  await expect(blocked.getByRole("button", { name: "Fix Team Bags · Pack of 100", exact: true })).toHaveText("Fix");
  await expect(sheet(page).getByTestId("older-rules-reasons")).toContainText("Why some sizes would change");
  await expect(sheet(page).getByTestId("older-rules-reasons")).toContainText("Two price rules tie for Team Bags, so they can't price it today.");
  await expect(sheet(page).getByTestId("older-rules-changes")).toContainText("Sizes that would change");
  await expect(rows(page)).toHaveCount(50);
  // The server's diff in the Prices tab's words; every amount the server's cents.
  const first = sheet(page).getByTestId("older-rules-row-40000");
  await expect(first).toContainText("Binder Pages · Pack of 1");
  await expect(first).toContainText("Price: $4.79 → $3.99");
  await expect(first).toContainText("Built from: From your older group rule “Sleeves”: retail $3.99 + 20% → No pricing rule covers this size, so it uses the retail price ($3.99).");
  await expect(first).toContainText("Pricing rule: “Sleeves” (Retail price + 20%, to the cent) → None");
  // No id and no code is shown.
  await expect(sheet(page)).not.toContainText("40000");
  await expect(sheet(page)).not.toContainText("_");
  if (phone(testInfo)) {
    expect((await setPrice.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalScroll(page);
  }
  await shot(page, testInfo, "listing-settings-older-rules-not-clean");

  await sheet(page).getByRole("button", { name: "Load more", exact: true }).click();
  await expect(rows(page)).toHaveCount(60);
  // The footer stays put under 60 rows (sticky, 11.2): Close needs no scroll back.
  await expectInView(page, sheet(page).getByTestId("older-rules-footer").getByRole("button", { name: "Close" }));
  await expect(sheet(page).getByTestId("older-rules-row-40059")).toContainText("Binder Pages · Pack of 60");
  await expect(sheet(page).getByRole("button", { name: "Load more" })).toHaveCount(0);
  await expect(sheet(page).getByTestId("older-rules-changed")).toHaveCount(0);
  expect(conversionReads(state)).toEqual(["?page=0", "?page=1"]);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("a page 1 for another plan drops the rows read, says something changed and reads page 0 again (one plan per screen)", async ({ page }) => {
  const state = await openStep(page, convertState({ conversionPages: { 0: NOT_CLEAN_A[0] } }));
  await openSheet(page);
  await expect(rows(page)).toHaveCount(50);
  await expect(sheet(page).getByTestId("older-rules-row-40000")).toContainText("Binder Pages · Pack of 1");
  // A cost changes meanwhile: the server's plan is another one from now on.
  state.conversionPages = { 0: NOT_CLEAN_B[0], 1: NOT_CLEAN_B[1] };
  await sheet(page).getByRole("button", { name: "Load more", exact: true }).click();
  await expect(sheet(page).getByTestId("older-rules-changed")).toHaveText("Something changed since you opened this. Check the list again.");
  // [Load more] sat under 50 rows: the body goes back to its top, so the line is seen, not only read out.
  await expect(sheet(page).getByTestId("older-rules-changed")).toBeInViewport();
  await expect(sheet(page).getByTestId("older-rules-row-40000")).toContainText("Card Cases · Pack of 1");
  await expect(rows(page)).toHaveCount(50);
  await expect(sheet(page).getByTestId("older-rules-row-40050")).toHaveCount(0);
  await expect.poll(() => conversionReads(state)).toEqual(["?page=0", "?page=1", "?page=0"]);
  // The new plan pages on as usual; the line stays until the sheet closes.
  await sheet(page).getByRole("button", { name: "Load more", exact: true }).click();
  await expect(rows(page)).toHaveCount(60);
  await expect(sheet(page).getByTestId("older-rules-row-40050")).toContainText("Card Cases · Pack of 51");
  await expect(sheet(page).getByTestId("older-rules-changed")).toBeVisible();
  expect(conversionReads(state)).toEqual(["?page=0", "?page=1", "?page=0", "?page=1"]);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

/** Whether focus is inside the open sheet (never on the page behind it, which the modal sheet hides). */
function focusInSheet(page: Page): Promise<boolean> {
  return sheet(page).evaluate((element) => element.contains(document.activeElement));
}

/** After Back from the drawer: focus is in the sheet (its × on a wide screen, ← on a phone), never behind it, and Tab stays there. */
async function expectFocusInSheet(page: Page, compact: boolean) {
  await expect(sheet(page).getByRole("button", { name: compact ? "Back" : "Close", exact: true }).first()).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await focusInSheet(page)).toBe(true);
}

test("Set a price opens the drawer on the size's Exact price in one push; Back returns to the sheet, which reads page 0 again", async ({ page }, testInfo) => {
  const state = await openStep(page, convertState({ conversionPages: { 0: NOT_CLEAN_A[0], 1: NOT_CLEAN_A[1] } }));
  await openSheet(page);
  await sheet(page).getByRole("button", { name: "Set a price for Penny Sleeves · Pack of 100", exact: true }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(drawer(page)).toBeVisible();
  // One surface at a time (D20): the sheet is off the address, the drawer on it, on the size.
  await expect(page).toHaveURL(`${SETUP_PATH}?product=${PENNY.productId}&size=${PENNY.sizes[0].productVariantId}`);
  await expect(exactBox(page, "Pack of 100 · CAT-3001-100")).toBeFocused();

  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  await expect(sheet(page)).toBeVisible();
  await expect(page).toHaveURL(`${SETUP_PATH}?sheet=convert`);
  await expect(rows(page)).toHaveCount(50);
  await expectFocusInSheet(page, phone(testInfo));
  expect(conversionReads(state)).toEqual(["?page=0", "?page=0"]);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("Fix opens the drawer on the blocker's row (no eBay category: the eBay category row); Back returns to the sheet", async ({ page }, testInfo) => {
  const state = await openStep(page, convertState({ conversionPages: { 0: NOT_CLEAN_A[0], 1: NOT_CLEAN_A[1] } }));
  await openSheet(page);
  await sheet(page).getByRole("button", { name: "Fix Team Bags · Pack of 100", exact: true }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(drawer(page)).toBeVisible();
  await expect(page).toHaveURL(`${SETUP_PATH}?product=${TEAM.productId}`);
  await expect(drawer(page).getByRole("heading", { name: "Team Bags" })).toBeVisible();
  // 10b's landing request: the eBay category row's editor opens.
  await expect(drawer(page).getByTestId("drawer-field-editor-ebayCategory")).toBeVisible();

  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  await expect(sheet(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(50);
  await expectFocusInSheet(page, phone(testInfo));
  expect(conversionReads(state)).toEqual(["?page=0", "?page=0"]);

  // Back at once, while the sheet is still closing: the drawer, closing into the sheet again, leaves focus in the
  // sheet and never sends it to [See what changes] behind it (plan 3.4).
  await sheet(page).getByRole("button", { name: "Fix Team Bags · Pack of 100", exact: true }).click();
  await expect(drawer(page)).toBeVisible();
  await page.goBack();
  await expect(sheet(page)).toBeVisible();
  await expect(drawer(page)).toHaveCount(0);
  // The closing drawer gives focus back a moment after it leaves the page (Radix): wait that moment out first.
  await page.waitForTimeout(500);
  expect(await focusInSheet(page)).toBe(true);
  await page.keyboard.press("Tab");
  expect(await focusInSheet(page)).toBe(true);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("the card's See what changes opens the sheet; from the category editor it closes the editor and opens the sheet in one push, and Back returns to the editor", async ({ page }) => {
  const state = await openStep(page, convertState({ conversionPages: { 0: CLEAN } }));
  const cardButton = card(page).getByRole("button", { name: SEE_WHAT_CHANGES, exact: true });
  await cardButton.click();
  await expect(sheet(page)).toBeVisible();
  await expect(page).toHaveURL(`${SETUP_PATH}?sheet=convert`);
  await sheet(page).getByTestId("older-rules-footer").getByRole("button", { name: "Close" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(cardButton).toBeFocused();

  // A link opens the editor (no Change under older rules): its footer has the one line and See what changes beside it.
  await page.goto(`${SETUP_PATH}?category=${SLEEVES}`);
  const editor = page.getByTestId("category-editor");
  await expect(editor.getByTestId("category-editor-rows")).toBeVisible();
  const footer = page.getByTestId("category-editor-footer");
  await expect(footer).toContainText("Category settings can't be saved while your store has older group rules.");
  await footer.getByRole("button", { name: SEE_WHAT_CHANGES, exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(sheet(page)).toBeVisible();
  // One push: the category is off the address, the sheet on it (D20).
  await expect(page).toHaveURL(`${SETUP_PATH}?sheet=convert`);
  await page.goBack();
  await expect(sheet(page)).toHaveCount(0);
  await expect(editor.getByTestId("category-editor-rows")).toBeVisible();
  await expect(page).toHaveURL(`${SETUP_PATH}?category=${SLEEVES}`);

  // Again, then Close: the editor's button went with the editor, so focus goes to the card's heading (11.2).
  await footer.getByRole("button", { name: SEE_WHAT_CHANGES, exact: true }).click();
  await expect(sheet(page)).toBeVisible();
  await sheet(page).getByTestId("older-rules-footer").getByRole("button", { name: "Close" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(editor).toHaveCount(0);
  await expect(card(page).getByRole("heading", { name: "Category settings" })).toBeFocused();
  expect(state.categorySettingsWrites).toEqual([]);
  expectNothingUnexpected(state);
});

test("the costs can't be read: the sheet says to try again in a minute, and Try again reads page 0 again", async ({ page }) => {
  const state = await openStep(page, convertState({ conversionPages: { 0: CHECK_UNAVAILABLE } }));
  await openSheet(page);
  const problem = sheet(page).getByTestId("older-rules-problem");
  await expect(problem).toContainText("We couldn't read your costs just now, so we can't check yet. Try again in a minute.");
  await expect(sheet(page)).not.toContainText("DROPSHIP_");
  state.conversionPages = { 0: CLEAN };
  await problem.getByRole("button", { name: "Try again" }).click();
  await expect(sheet(page).getByTestId("older-rules-summary")).toHaveText("Moving them over changes nothing in your listings.");
  await expect(problem).toHaveCount(0);
  expect(conversionReads(state)).toEqual(["?page=0", "?page=0"]);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("refused as too large by the check: the sheet closes and the banner explains (D18)", async ({ page }) => {
  const state = await openStep(page, convertState({ conversionPages: { 0: CLEAN } }));
  await expect(line(page)).toBeVisible();
  // More than 10,000 sizes chosen in another window: the summary on screen still says the selection fits.
  state.tooLarge = true;
  await line(page).getByRole("button", { name: SEE_WHAT_CHANGES, exact: true }).click();
  await expect(banner(page)).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  // The line now says to choose fewer, and neither it nor the card offers a button that would open nothing (K7).
  await expect(line(page)).toContainText("Your store still has older group rules. Choose 10,000 or fewer sizes to move them over.");
  await expect(line(page).getByRole("button")).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: SEE_WHAT_CHANGES })).toHaveCount(0);
  // The close replaced the sheet's entry: Back goes to the one before it.
  await page.goBack();
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(sheet(page)).toHaveCount(0);
  expect(conversionReads(state)).toEqual(["?page=0"]);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("a later page refused as too large closes the sheet too, and the banner explains (5.3, D18)", async ({ page }) => {
  const state = await openStep(page, convertState({ conversionPages: { 0: NOT_CLEAN_A[0], 1: NOT_CLEAN_A[1] } }));
  await openSheet(page);
  await expect(rows(page)).toHaveCount(50);
  // More than 10,000 sizes chosen in another window between page 0 and Load more.
  state.tooLarge = true;
  await sheet(page).getByRole("button", { name: "Load more", exact: true }).click();
  await expect(banner(page)).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(line(page)).toContainText("Choose 10,000 or fewer sizes to move them over.");
  await expect(line(page).getByRole("button")).toHaveCount(0);
  expect(conversionReads(state)).toEqual(["?page=0", "?page=1"]);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("a later page that fails says so under the rows, with Try again, which reads that page again (not page 0)", async ({ page }) => {
  const state = await openStep(page, convertState({ conversionPages: { 0: NOT_CLEAN_A[0], 1: CHECK_UNAVAILABLE } }));
  await openSheet(page);
  await expect(rows(page)).toHaveCount(50);
  await sheet(page).getByRole("button", { name: "Load more", exact: true }).click();
  const more = sheet(page).getByTestId("older-rules-more-problem");
  await expect(more).toContainText("We couldn't read your costs just now, so we can't check yet. Try again in a minute.");
  // Page 0's rows stay, with no Load more and no problem of page 0's.
  await expect(rows(page)).toHaveCount(50);
  await expect(sheet(page).getByRole("button", { name: "Load more" })).toHaveCount(0);
  await expect(sheet(page).getByTestId("older-rules-problem")).toHaveCount(0);
  state.conversionPages = { 0: NOT_CLEAN_A[0], 1: NOT_CLEAN_A[1] };
  await more.getByRole("button", { name: "Try again" }).click();
  await expect(rows(page)).toHaveCount(60);
  await expect(more).toHaveCount(0);
  expect(conversionReads(state)).toEqual(["?page=0", "?page=1", "?page=1"]);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("an old ?sheet=convert on a store with no older rules says so, and reads the summary and the categories again once, never the dry run (11.5)", async ({ page }) => {
  // No pricing group: the default dry run answers no_older_rules.
  const state = await openStep(page, { catalog: structuredClone([PENNY, TEAM]) }, `${SETUP_PATH}?sheet=convert`);
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByTestId("older-rules-none")).toHaveText("Your store has no older group rules any more.");
  await expect(line(page)).toHaveCount(0);
  // Once per opening: the summary, the categories and the open profiles' reads, each one more (D25); the dry run stays at one.
  await expect.poll(() => readsOf(state, "GET", SUMMARY_PATH).length).toBe(2);
  await expect.poll(() => readsOf(state, "GET", CATEGORIES_PATH).length).toBe(2);
  await expect.poll(() => readsOf(state, "GET", `${LISTINGS}/pricing-rules`).length).toBe(2);
  await expect.poll(() => readsOf(state, "GET", `${LISTINGS}/ebay-category-rules`).length).toBe(2);
  expect(readsOf(state, "GET", `${LISTINGS}/content-profile`)).toEqual([]);
  await page.waitForTimeout(500);
  expect(conversionReads(state)).toEqual(["?page=0"]);
  expect(readsOf(state, "GET", SUMMARY_PATH)).toHaveLength(2);
  expectNothingUnexpected(state);
});
