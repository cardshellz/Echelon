import { expect, test, type Locator, type Page } from "@playwright/test";
import type { EbayCategoryRulesState } from "../../shared/dropship/ebay-category-rules";
import type { ConversionChangeRow, ConversionSizeView, ListingRulesConversionCheck } from "../../shared/dropship/listing-rules-conversion";
import type { ContentProfileState } from "../../shared/dropship/listing-content";
import type { CategoryListingSettingValues } from "../../shared/dropship/listing-setting-values";
import type { ListingSettingsSizePrice } from "../../shared/dropship/listing-settings";
import { DROPSHIP_LISTING_GROUP_RULES_CLOSED } from "../../server/modules/dropship/domain/older-group-rules-edit";
import {
  SAVED_PRICING_RULES,
  SLEEVES as EBAY_SLEEVES,
  categoryKey,
  conversionCheck,
  shot,
  stubSystemConversion,
  type ProductFixture,
  type ScriptedError,
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
  expectGatedReads,
  expectInView,
  expectNoDeletedRouteCalls,
  expectNoHorizontalScroll,
  expectNoOlderSettings,
  expectNothingUnexpected,
  expectSheetLayout,
  openStep,
  phone,
  readsOf,
  row,
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
 * [Set a price] or [Fix], which open the drawer in one push so Back returns to the sheet. From part 11d (plan 8.2-8.5)
 * its footer has [Move them over] (W11, `POST …/listing-settings/conversion/apply`): one keyed POST with page 0's two
 * hashes, only when pressed, every outcome worded, a confirmed one kept until the sheet closes, and the views read
 * again. The stub serves scripted pages, each parsed with the strict contract where it is built (this file's load) and
 * when served; it never computes a diff, and a move is bound to the scripted page 0's hashes. From part 11e1 (plan
 * 9.2-9.4) a store the job moved shows the one-time notice in the line's place, with [Got it] (`POST
 * …/conversion/notice/acknowledge`, no key), and the sheet says the same when it finds the store moved. From Listing
 * settings PR 12 (plan 6.5, J1-J3, J6) "Older settings" and its panels are gone: a store with older rules of every kind
 * still moves over from the sheet, the text cap names no deleted section, and nothing reads a profile until its editor
 * opens; and (J4, J5, J7; D9, D27) the stubs refuse a new, changed or reordered older group as the server does, so the
 * step's store default saves show they send every group back as stored, a refusal keeps the draft, and a save opened
 * before a move gets the conflict, not the refusal. Every journey ends with nothing unexpected asked and no page error.
 * Desktop and phone.
 */

const CONVERSION_PATH = `${LISTINGS}/listing-settings/conversion`;
const SUMMARY_PATH = `${LISTINGS}/listing-settings/summary`;
const CATEGORIES_PATH = `${LISTINGS}/listing-settings/categories`;
const PLAN_A = "a".repeat(64);
const PLAN_B = "b".repeat(64);
const PLAN_C = "9".repeat(64);
const WRITES = "c".repeat(64);
const WRITES_B = "8".repeat(64);
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
  // The footer (11d): [Close] and [Move them over]; nothing is moved until it is pressed (D1).
  const footer = sheet(page).getByTestId("older-rules-footer");
  await expect(footer).not.toContainText("This is a preview");
  await expect(footer.getByRole("button")).toHaveText(["Close", "Move them over"]);
  expect(state.conversionApplies).toEqual([]);
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
  // Once per opening: the summary and the categories, each one more (D25); the dry run stays at one.
  await expect.poll(() => readsOf(state, "GET", SUMMARY_PATH).length).toBe(2);
  await expect.poll(() => readsOf(state, "GET", CATEGORIES_PATH).length).toBe(2);
  await page.waitForTimeout(500);
  expect(conversionReads(state)).toEqual(["?page=0"]);
  expect(readsOf(state, "GET", SUMMARY_PATH)).toHaveLength(2);
  // The re-read refetches only the profiles someone reads (D25); with no editor open nothing does since PR 12 (the older
  // panels read them on mount), so none is read, settled after the wait above rather than polled.
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

// ---------------------------------------------------------------------------
// [Move them over] (PR 11d, plan 8.2-8.5; D1, D12, D21, D25; CUX#4, CUX#11)
// ---------------------------------------------------------------------------

const APPLY_PATH = `${LISTINGS}/listing-settings/conversion/apply`;
const MOVED = "Moved over. Category settings can be saved now.";
const NO_CATEGORY_VALUES: CategoryListingSettingValues = {
  price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null, textAbove: null, textBelow: null,
};

function footer(page: Page) {
  return sheet(page).getByTestId("older-rules-footer");
}

function moveButton(page: Page) {
  return footer(page).getByRole("button", { name: "Move them over", exact: true });
}

/** What the clean plan writes when it commits (the stub computes no plan): Sleeves gets the group's price. */
function sleevesPriceLayer(): StubState["conversionLayers"] {
  return { categorySettings: { [categoryKey(STORE, SLEEVES)]: { revisionId: 1, values: { ...NO_CATEGORY_VALUES, price: SAVED_PRICING_RULES.profile!.defaultRecipe } } }, productSettings: {} };
}

/** Not clean, nothing blocked: 60 sizes change, 50 on page 0. */
function notCleanFreePage(page: 0 | 1): ListingRulesConversionCheck {
  const first = page * 50;
  return conversionCheck(STORE, {
    state: "not_clean", planHash: PLAN_B, writesHash: WRITES,
    changes: { page, pageSize: 50, total: 60, rows: Array.from({ length: page === 0 ? 50 : 10 }, (_, index) => changedRow(first + index, "Binder Pages")) },
  });
}

/** The posts the move sent, as the page sent them. */
function applies(state: StubState) {
  return state.conversionApplies.map((write) => write.body);
}

test("Move them over on a clean store: one POST with the hashes shown and an ls-convert key; Moved over. stays; Close: the line goes and the card has Change, focus on its heading", async ({ page }, testInfo) => {
  const state = await openStep(page, convertState({ conversionPages: { 0: CLEAN }, conversionLayers: sleevesPriceLayer() }));
  await openSheet(page);
  await expect(moveButton(page)).toBeEnabled();
  if (phone(testInfo)) {
    expect((await moveButton(page).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalScroll(page);
  }
  await expectInView(page, moveButton(page));
  await moveButton(page).click();
  await expect(footer(page)).toContainText(MOVED);
  // One POST, bound to page 0's two hashes, under a key of its own (D1, D12).
  expect(applies(state)).toEqual([{ idempotencyKey: KEY("ls-convert"), planHash: PLAN_A, writesHash: WRITES }]);
  expect(readsOf(state, "POST", APPLY_PATH)).toHaveLength(1);
  // The store as the move left it (the stub's): the group gone, its default kept; Sleeves' price set.
  expect(state.pricingRules[STORE].profile?.groups).toEqual([]);
  expect(state.pricingRules[STORE].profile?.defaultRecipe).toEqual(SAVED_PRICING_RULES.profile!.defaultRecipe);
  // The views are read again: page 0 now says there are no older rules, and the outcome stays (CUX#11).
  await expect(sheet(page).getByTestId("older-rules-none")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(footer(page)).toContainText(MOVED);
  await expect(footer(page).getByRole("button")).toHaveText(["Close"]);
  // [Move them over] is gone: focus waits on [Close], beside the words.
  await expect(footer(page).getByRole("button", { name: "Close" })).toBeFocused();
  await expect(sheet(page)).not.toContainText("_");
  await shot(page, testInfo, "listing-settings-older-rules-moved");

  await footer(page).getByRole("button", { name: "Close" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(line(page)).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: "Change settings for Sleeves", exact: true })).toBeVisible();
  await expect(card(page).getByTestId("category-settings-row-40")).toContainText("Sets: price");
  await expect(card(page)).not.toContainText("older group rules");
  // The line's button went with the line: focus goes to the card's heading (11.2).
  await expect(card(page).getByRole("heading", { name: "Category settings" })).toBeFocused();
  // Nothing sent again. The move's re-read (8.4) refetches only the profiles someone reads: with no editor open nothing
  // does since PR 12, so none is read (settled: the views' re-reads landed before the 300 ms wait above).
  expect(readsOf(state, "POST", APPLY_PATH)).toHaveLength(1);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

/** The store's older eBay category rule (J1): Sleeves listings go to eBay's Card Sleeves. */
function categoryRulesWithRule(): EbayCategoryRulesState {
  return { revisionId: 8, updatedAt: "2026-10-15T12:00:00.000Z", profile: { version: 1, defaultCategory: null, rules: [
    { id: "sleeves", name: "Sleeves", scope: { type: "category", category: "Sleeves" },
      category: { categoryId: EBAY_SLEEVES.categoryId, categoryName: EBAY_SLEEVES.categoryName, path: [...EBAY_SLEEVES.path] } }] } };
}

/** Clean, for a store holding a pricing group, a description group and an eBay category rule: all three become Sleeves' settings. */
const CLEAN_ALL_KINDS = conversionCheck(STORE, {
  planHash: PLAN_A, writesHash: WRITES, olderRules: { pricingGroups: 1, contentGroups: 1, ebayCategoryRules: 1 },
  becomes: { categories: { total: 1, items: [{ categoryId: SLEEVES, categoryName: "Sleeves", settings: ["price", "ebayCategory", "textAbove"] }] }, products: none() },
});

/** What CLEAN_ALL_KINDS writes when it commits (the stub computes no plan): Sleeves gets the group's price, the rule's category and the group's text. */
function sleevesAllKindsLayer(): StubState["conversionLayers"] {
  return { categorySettings: { [categoryKey(STORE, SLEEVES)]: { revisionId: 1, values: { ...NO_CATEGORY_VALUES,
    price: SAVED_PRICING_RULES.profile!.defaultRecipe,
    ebayCategory: { categoryId: EBAY_SLEEVES.categoryId, categoryName: EBAY_SLEEVES.categoryName, path: [...EBAY_SLEEVES.path] },
    textAbove: { mode: "own", text: "Fits any binder." } } } }, productSettings: {} };
}

test("with Older settings gone, a store holding pricing groups, description groups and eBay rules moves over from the sheet; nothing calls a deleted route (J1)", async ({ page }, testInfo) => {
  const state = await openStep(page, convertState({ conversionPages: { 0: CLEAN_ALL_KINDS }, conversionLayers: sleevesAllKindsLayer(),
    contentProfiles: { [STORE]: contentWithGroup() }, categoryRules: { [STORE]: categoryRulesWithRule() } }));
  // The line is the only way to the older rules: no "Older settings" section, toggle or panel (PR 12, D3, D13).
  await expect(line(page)).toContainText("Your store still has older group rules. Move them over to use category settings.");
  await expectNoOlderSettings(page);
  await openSheet(page);
  await expect(sheet(page).getByTestId("older-rules-summary")).toHaveText("Moving them over changes nothing in your listings.");
  await expect(moveButton(page)).toBeEnabled();
  await moveButton(page).click();
  await expect(footer(page)).toContainText(MOVED);
  expect(applies(state)).toEqual([{ idempotencyKey: KEY("ls-convert"), planHash: PLAN_A, writesHash: WRITES }]);
  // Every kind moved (the stub's commit): no group or rule left, each default kept.
  expect(state.pricingRules[STORE].profile?.groups).toEqual([]);
  expect(state.pricingRules[STORE].profile?.defaultRecipe).toEqual(SAVED_PRICING_RULES.profile!.defaultRecipe);
  expect(state.contentProfiles[STORE].profile?.groups).toEqual([]);
  expect(state.contentProfiles[STORE].profile?.defaultTemplate).toEqual(contentWithGroup().profile!.defaultTemplate);
  expect(state.categoryRules[STORE].profile?.rules).toEqual([]);
  expect(state.categoryRules[STORE].profile?.defaultCategory).toBeNull();
  await expect(sheet(page).getByTestId("older-rules-none")).toBeVisible();

  await footer(page).getByRole("button", { name: "Close" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(line(page)).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: "Change settings for Sleeves", exact: true })).toBeVisible();
  await expect(card(page).getByTestId("category-settings-row-40")).toContainText("Sets: price");
  await expect(card(page)).not.toContainText("older group rules");
  await expectNoOlderSettings(page);
  if (phone(testInfo)) await expectNoHorizontalScroll(page);
  // Settled (the move's re-reads have landed), not polled: no profile was read, and no deleted route was asked.
  await page.waitForTimeout(300);
  expect(readsOf(state, "POST", APPLY_PATH)).toHaveLength(1);
  expectGatedReads(state);
  expectNoDeletedRouteCalls(state);
  expectNothingUnexpected(state);
});

test("not clean: a size that would lose its price keeps Move them over off with its section; with nothing blocked the footer names how many sizes change, and the move goes", async ({ page }, testInfo) => {
  const state = await openStep(page, convertState({ conversionPages: { 0: NOT_CLEAN_A[0], 1: NOT_CLEAN_A[1] } }));
  await openSheet(page);
  await expect(sheet(page).getByTestId("older-rules-blocked")).toContainText("1 size would have no price after the move.");
  await expect(footer(page)).toContainText("Fix the sizes listed above first.");
  await expect(moveButton(page)).toBeDisabled();
  await footer(page).getByRole("button", { name: "Close" }).click();
  expect(applies(state)).toEqual([]);

  // Fixed meanwhile (the price given): the plan has no block now, and 60 sizes change.
  state.conversionPages = { 0: notCleanFreePage(0), 1: notCleanFreePage(1) };
  await openSheet(page);
  await expect(sheet(page).getByTestId("older-rules-blocked")).toHaveCount(0);
  await expect(footer(page)).toContainText("These 60 sizes change as listed.");
  await expect(moveButton(page)).toBeEnabled();
  if (phone(testInfo)) await expectNoHorizontalScroll(page);
  await moveButton(page).click();
  await expect(footer(page)).toContainText(MOVED);
  expect(applies(state)).toEqual([{ idempotencyKey: KEY("ls-convert"), planHash: PLAN_B, writesHash: WRITES }]);
  expectNothingUnexpected(state);
});

/** Not clean only because the move would save more text than the store can keep (D9c): nothing else changes or blocks. */
const TEXT_CAP = conversionCheck(STORE, {
  state: "not_clean", planHash: PLAN_A, writesHash: WRITES, olderRules: { pricingGroups: 1, contentGroups: 1, ebayCategoryRules: 0 },
  blocked: { wouldLosePrice: none(), wouldBlockListing: none(), tooMuchText: true },
});
/** The text cap's words since PR 12 (plan 8, B1): they say what still helps, and name no deleted section. */
const TOO_MUCH_TEXT = "Moving these rules would save more text than your store can keep. Choose fewer products in Choose what to sell, "
  + "then check again. Listed products you take out stop selling on eBay.";

test("the text cap: the section and the footer say what still helps, naming no Older settings, and Move them over stays off (J3)", async ({ page }, testInfo) => {
  const state = await openStep(page, convertState({ conversionPages: { 0: TEXT_CAP }, contentProfiles: { [STORE]: contentWithGroup() } }));
  await openSheet(page);
  const blocked = sheet(page).getByTestId("older-rules-blocked");
  await expect(blocked).toContainText("Before you can move them over");
  await expect(blocked.getByTestId("older-rules-too-much-text")).toHaveText(TOO_MUCH_TEXT);
  // Nothing else blocks: no size to give a price or to fix.
  await expect(blocked.getByTestId("older-rules-lose-price")).toHaveCount(0);
  await expect(blocked.getByTestId("older-rules-block-listing")).toHaveCount(0);
  // The cap alone: the footer says the same words, and the move can't be pressed.
  await expect(footer(page)).toContainText(TOO_MUCH_TEXT);
  await expect(moveButton(page)).toBeDisabled();
  await expect(sheet(page)).not.toContainText(/older settings/i);
  await expect(sheet(page)).not.toContainText("_");
  if (phone(testInfo)) await expectNoHorizontalScroll(page);
  await shot(page, testInfo, "listing-settings-older-rules-text-cap");
  await footer(page).getByRole("button", { name: "Close" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(line(page)).toBeVisible();
  expect(applies(state)).toEqual([]);
  expect(conversionReads(state)).toEqual(["?page=0"]);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("CHANGED: the words say why, page 0 is read again, and nothing more is sent until Move them over is pressed again, each time with a new key", async ({ page }) => {
  const state = await openStep(page, convertState({ conversionPages: { 0: CLEAN }, conversionLayers: sleevesPriceLayer() }));
  await openSheet(page);
  await expect(moveButton(page)).toBeEnabled();
  // The settings the move writes change in another window after the sheet read page 0.
  state.conversionPages = { 0: conversionCheck(STORE, { ...CLEAN, planHash: PLAN_B, writesHash: WRITES_B }) };
  await moveButton(page).click();
  await expect(footer(page)).toContainText("Something changed since you opened this. Check the list again.");
  // Page 0 is read again (the runner's re-read; the page's own refresh after any save reads it too), and the button
  // comes back on its new hashes once it answers.
  await expect.poll(() => conversionReads(state).length).toBeGreaterThanOrEqual(2);
  await expect(moveButton(page)).toBeEnabled();
  await page.waitForTimeout(300);
  expect(applies(state)).toHaveLength(1);

  // Now only the listed changes move (a cost, say): the same writes, another plan.
  state.conversionPages = { 0: conversionCheck(STORE, { ...CLEAN, planHash: PLAN_C, writesHash: WRITES_B }) };
  const readsBefore = conversionReads(state).length;
  await moveButton(page).click();
  await expect(footer(page)).toContainText("Some changes in the list are different now, for example because a cost changed. Check the list again.");
  await expect.poll(() => conversionReads(state).length).toBeGreaterThan(readsBefore);
  await expect(moveButton(page)).toBeEnabled();
  await page.waitForTimeout(300);
  expect(applies(state)).toHaveLength(2);

  await moveButton(page).click();
  await expect(footer(page)).toContainText(MOVED);
  const bodies = applies(state);
  expect(bodies).toEqual([
    { idempotencyKey: KEY("ls-convert"), planHash: PLAN_A, writesHash: WRITES },
    { idempotencyKey: KEY("ls-convert"), planHash: PLAN_B, writesHash: WRITES_B },
    { idempotencyKey: KEY("ls-convert"), planHash: PLAN_C, writesHash: WRITES_B },
  ]);
  // One key per plan shown: a refusal never sends its key again (D12).
  expect(new Set(bodies.map((body) => body.idempotencyKey)).size).toBe(3);
  expectNothingUnexpected(state);
});

test("a dropped answer: We couldn't confirm the move.; Esc keeps the sheet, Back keeps the move, and Check again sends the same key and hashes, answered from the first move", async ({ page }) => {
  const state = await openStep(page, convertState({ conversionPages: { 0: CLEAN }, conversionLayers: sleevesPriceLayer(), conversionApplyAnswers: ["drop"] }));
  await openSheet(page);
  await moveButton(page).click();
  await expect(footer(page)).toContainText("We couldn't confirm the move.");
  await expect(footer(page).getByRole("button")).toHaveText(["Check again", "Close"]);
  // Esc keeps the sheet while the move is unconfirmed (PLAN10 3.4).
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeVisible();
  // The move did land: the views read after any save (the page's refresh) find no older rules, so the line goes; the
  // unconfirmed move stays in the sheet to be checked (11.5).
  await expect(sheet(page).getByTestId("older-rules-none")).toBeVisible();
  await expect(line(page)).toHaveCount(0);
  // Back closes it and keeps the move (D21); Forward opens it again on the same move, still unconfirmed.
  await page.goBack();
  await expect(sheet(page)).toHaveCount(0);
  await page.goForward();
  await expect(sheet(page)).toBeVisible();
  await expect(page).toHaveURL(`${SETUP_PATH}?sheet=convert`);
  await expect(sheet(page).getByTestId("older-rules-none")).toBeVisible();
  await expect(footer(page)).toContainText("We couldn't confirm the move.");
  await footer(page).getByRole("button", { name: "Check again", exact: true }).click();
  await expect(footer(page)).toContainText(MOVED);
  const bodies = applies(state);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toEqual({ idempotencyKey: KEY("ls-convert"), planHash: PLAN_A, writesHash: WRITES });
  // The same key and body: the stub answers it from the first move (replayed), which committed once.
  expect(bodies[1]).toEqual(bodies[0]);
  expect(state.pricingRules[STORE].profile?.groups).toEqual([]);
  expectNothingUnexpected(state);
});

test("a move that never landed, closed by Back: Check again in the reopened sheet moves it, and says Moved over. alone while its own re-reads land", async ({ page }) => {
  // A 5xx no route sends (a gateway's): the move may or may not have happened, but here it did not.
  const gateway: ScriptedError = { status: 504, code: "STUB_GATEWAY_TIMEOUT", message: "Gateway timeout." };
  const state = await openStep(page, convertState({ conversionPages: { 0: CLEAN }, conversionLayers: sleevesPriceLayer(), conversionApplyAnswers: [gateway] }));
  await openSheet(page);
  await moveButton(page).click();
  await expect(footer(page)).toContainText("We couldn't confirm the move.");
  expect(state.pricingRules[STORE].profile?.groups).toHaveLength(1);
  // Back closes it and keeps the move (D21); Forward opens it again on the same move, page 0 still the report.
  await page.goBack();
  await expect(sheet(page)).toHaveCount(0);
  await page.goForward();
  await expect(sheet(page)).toBeVisible();
  await expect(footer(page)).toContainText("We couldn't confirm the move.");
  await expect(sheet(page).getByTestId("older-rules-none")).toHaveCount(0);
  // From here the summary answers slowly, so page 0 (one of the move's own re-reads) finds no older rules first. The
  // sheet must take that as the move's own doing: a one-time re-read (11.5) then would cancel the move's summary read,
  // and a confirmed move would say the view may be out of date.
  await page.route(`**${SUMMARY_PATH}*`, async (route) => {
    await new Promise((done) => setTimeout(done, 1_500));
    await route.fallback();
  });

  await footer(page).getByRole("button", { name: "Check again", exact: true }).click();
  await expect(sheet(page).getByTestId("older-rules-none")).toBeVisible();
  await expect(footer(page)).toContainText(MOVED);
  await page.waitForTimeout(500);
  await expect(footer(page)).toContainText(MOVED);
  await expect(sheet(page)).not.toContainText("We couldn't load the latest view.");
  await expect(sheet(page)).not.toContainText("Something changed");
  await expect(footer(page).getByRole("button")).toHaveText(["Close"]);
  const bodies = applies(state);
  // Check again resends the same key and body; the stub, which refused the first, moves it now.
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(state.pricingRules[STORE].profile?.groups).toEqual([]);
  expectNothingUnexpected(state);
});

test("the costs can't be read when moving: Nothing was moved, never couldn't confirm; pressing again sends the same key", async ({ page }) => {
  const state = await openStep(page, convertState({ conversionPages: { 0: CLEAN }, conversionLayers: sleevesPriceLayer(), conversionApplyAnswers: [CHECK_UNAVAILABLE] }));
  await openSheet(page);
  await moveButton(page).click();
  await expect(footer(page)).toContainText("We couldn't read your costs just now. Nothing was moved. Try again in a minute.");
  await expect(footer(page)).not.toContainText("confirm");
  await expect(sheet(page)).not.toContainText("DROPSHIP_");
  await expect(moveButton(page)).toBeEnabled();
  expect(state.pricingRules[STORE].profile?.groups).toHaveLength(1);
  await moveButton(page).click();
  await expect(footer(page)).toContainText(MOVED);
  const bodies = applies(state);
  expect(bodies).toHaveLength(2);
  // The key is kept: the first send moved nothing, and this is the same intent (PLAN10 D5).
  expect(bodies[1]).toEqual(bodies[0]);
  expectNothingUnexpected(state);
});

test("moved elsewhere meanwhile: Your rules have already been moved over.; Close: the line goes and the card has Change", async ({ page }) => {
  const state = await openStep(page, convertState({ conversionPages: { 0: CLEAN } }));
  await openSheet(page);
  // Another window (or the system) moved the rules after the sheet read page 0.
  state.pricingRules = { [STORE]: SAVED_PRICING_RULES };
  await moveButton(page).click();
  await expect(footer(page)).toContainText("Your rules have already been moved over.");
  await expect(footer(page).getByRole("button")).toHaveText(["Close"]);
  await page.waitForTimeout(300);
  await expect(footer(page)).toContainText("Your rules have already been moved over.");
  await footer(page).getByRole("button", { name: "Close" }).click();
  await expect(line(page)).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: "Change settings for Sleeves", exact: true })).toBeVisible();
  expect(applies(state)).toEqual([{ idempotencyKey: KEY("ls-convert"), planHash: PLAN_A, writesHash: WRITES }]);
  expectNothingUnexpected(state);
});

/** One description group (a product-line template) beside the pricing group: the move empties both profiles. */
function contentWithGroup(): ContentProfileState {
  return {
    revisionId: 6, updatedAt: "2026-10-15T12:00:00.000Z", profile: {
      defaultTemplate: { introduction: "", footer: "" },
      groups: [{ id: "binders", name: "Binder text", priority: 1, scope: { type: "category", category: "Sleeves" }, template: { introduction: "Fits any binder.", footer: "" } }],
    },
  };
}

test("after a move, the Price editor reads the moved rules once and checks with no group, and the Description editor reads its moved text once (J6)", async ({ page }) => {
  // No category layer is scripted: the stub's W1 check prices from the store default only (it refuses a category price),
  // and this journey is about what the editors read and send after the move, not about what the move wrote.
  const state = await openStep(page, convertState({ conversionPages: { 0: CLEAN }, contentProfiles: { [STORE]: contentWithGroup() } }));
  await openSheet(page);
  await moveButton(page).click();
  await expect(footer(page)).toContainText(MOVED);
  await footer(page).getByRole("button", { name: "Close" }).click();
  await expect(line(page)).toHaveCount(0);
  expect(state.pricingRules[STORE].profile?.groups).toEqual([]);
  expect(state.contentProfiles[STORE].profile?.groups).toEqual([]);
  // Nothing holds the profiles while no editor is open, so the move made no profile read (settled, not polled).
  await page.waitForTimeout(300);
  expectGatedReads(state);

  // The Price editor reads the moved rules once as it opens; the check it sends has no group to send back, and no
  // size is priced by an older group rule any more.
  await row(page, "price").getByRole("button", { name: "Change Price" }).click();
  const editor = page.getByTestId("editor-surface");
  await expect.poll(() => readsOf(state, "GET", `${LISTINGS}/pricing-rules`).length).toBe(1);
  await editor.getByRole("textbox", { name: "Add" }).fill("20");
  await editor.getByRole("button", { name: "Check new prices" }).click();
  const check = page.getByTestId("check-new-prices");
  await expect(check).toContainText("Check new prices · Not saved yet");
  expect(state.pricingReviews).toHaveLength(1);
  expect(state.pricingReviews[0].body).toMatchObject({ profile: { groups: [] } });
  await expect(check).not.toContainText(/older group rule/i);
  await expect(editor).not.toContainText(/older group rule/i);
  await check.getByRole("button", { name: /^Back( to editing)?$/ }).click();
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toHaveCount(0);

  // The Description editor reads the moved templates once as it opens: the group's text is not the store's.
  await row(page, "description").getByRole("button", { name: "Change Description" }).click();
  await expect.poll(() => readsOf(state, "GET", `${LISTINGS}/content-profile`).length).toBe(1);
  await expect(editor.getByRole("textbox", { name: "Text above (optional)" })).toHaveValue("");
  await expect(editor).not.toContainText("Fits any binder.");
  await page.waitForTimeout(300);
  expect(readsOf(state, "GET", `${LISTINGS}/pricing-rules`)).toHaveLength(1);
  expect(readsOf(state, "GET", `${LISTINGS}/content-profile`)).toHaveLength(1);
  await expectNoOlderSettings(page);
  expectNothingUnexpected(state);
});

// ---------------------------------------------------------------------------
// Older group rules are closed (Listing settings PR 12, plan D9, D10, D27; 6.5 J4, J5, J7): the stubs refuse a new,
// changed or reordered group as the server does, after their revision checks. The step sends every stored group back
// unchanged, so it never trips the rule; a refusal it is answered with keeps the draft; a stale save after a move gets
// the conflict, not the refusal.
// ---------------------------------------------------------------------------

/** The server's words for the refusal (plan 3.1, 8), which the page shows as they are. */
const GROUP_RULES_CLOSED = "Older group rules can't be added or changed any more. Nothing was saved. Use See what changes on Listing settings to move them over.";

test("before a move, the store price, description and eBay category save on a store holding every kind of older rule, each sending its rules back as stored (J4)", async ({ page }, testInfo) => {
  const content = contentWithGroup();
  const rules = categoryRulesWithRule();
  const state = await openStep(page, convertState({ contentProfiles: { [STORE]: content }, categoryRules: { [STORE]: rules } }));
  const editor = page.getByTestId("editor-surface");
  await expect(line(page)).toContainText("Your store still has older group rules.");

  // Price (W1): the check sends the pricing group back as stored, and Save applies it.
  await row(page, "price").getByRole("button", { name: "Change Price" }).click();
  await editor.getByRole("textbox", { name: "Add" }).fill("25");
  await editor.getByRole("button", { name: "Check new prices" }).click();
  const check = page.getByTestId("check-new-prices");
  await expect(check).toContainText("Check new prices · Not saved yet");
  expect(state.pricingReviews.map((review) => review.body)).toEqual([{ expectedRevisionId: pricingRulesWithGroup().revisionId,
    releaseFixedOverrides: false, profile: { defaultRecipe: { ...pricingRulesWithGroup().profile.defaultRecipe, markupBps: 2_500 },
      groups: pricingRulesWithGroup().profile.groups } }]);
  await check.getByRole("button", { name: "Save new prices" }).click();
  await expect(check).toHaveCount(0);
  await expect(row(page, "price")).toContainText("Saved");
  expect(state.pricingApplies).toHaveLength(1);
  expect(state.pricingRules[STORE].profile?.groups).toEqual(pricingRulesWithGroup().profile.groups);

  // Description (W4): the store's text, and the description group back as stored.
  await row(page, "description").getByRole("button", { name: "Change Description" }).click();
  await editor.getByRole("textbox", { name: "Text above (optional)" }).fill("Ships from Card Shellz.");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(row(page, "description")).toContainText("Saved");
  expect(state.contentWrites.map((write) => write.body)).toEqual([{ expectedRevisionId: content.revisionId, idempotencyKey: KEY("ls-text"),
    profile: { defaultTemplate: { introduction: "Ships from Card Shellz.", footer: "" }, groups: content.profile!.groups } }]);
  expect(state.contentProfiles[STORE].profile?.groups).toEqual(content.profile!.groups);

  // eBay category (W3): one category for every product, and the eBay rule back as stored, in its place.
  await row(page, "ebayCategory").getByRole("button", { name: "Change eBay category" }).click();
  await editor.getByRole("radio", { name: "One eBay category for every product" }).check();
  await editor.getByRole("textbox", { name: "Search eBay categories" }).fill("toploaders");
  await editor.getByRole("button", { name: "Use this category" }).click();
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(row(page, "ebayCategory")).toContainText("Toploaders");
  await expect(row(page, "ebayCategory")).toContainText("Saved");
  const [stored] = rules.profile!.rules;
  expect(state.categoryWrites.map((write) => write.body)).toEqual([{ expectedRevisionId: rules.revisionId, idempotencyKey: KEY("ls-category"),
    draft: { defaultCategoryId: "183436", rules: [{ id: stored.id, name: stored.name, scope: stored.scope, categoryId: stored.category.categoryId }] } }]);
  expect(state.categoryRules[STORE].profile?.rules).toEqual(rules.profile!.rules);

  // None of the three tripped the refusal, and the store still holds every older rule: the line stays, the move is still offered.
  await expect(page.getByText(GROUP_RULES_CLOSED)).toHaveCount(0);
  await expect(line(page)).toContainText("Your store still has older group rules.");
  if (phone(testInfo)) await expectNoHorizontalScroll(page);
  expectNothingUnexpected(state);
});

test("a description save the server refuses as a group change shows the refusal's words and keeps the text; nothing else is sent (J5)", async ({ page }) => {
  const content = contentWithGroup();
  const state = await openStep(page, convertState({ contentProfiles: { [STORE]: content },
    contentWriteAnswers: [{ status: 422, code: DROPSHIP_LISTING_GROUP_RULES_CLOSED, message: GROUP_RULES_CLOSED }] }));
  const editor = page.getByTestId("editor-surface");
  await row(page, "description").getByRole("button", { name: "Change Description" }).click();
  const above = editor.getByRole("textbox", { name: "Text above (optional)" });
  await above.fill("Ships from Card Shellz.");
  await editor.getByRole("button", { name: "Save", exact: true }).click();

  await expect(editor).toContainText(GROUP_RULES_CLOSED);
  await expect(editor).not.toContainText("DROPSHIP_");
  // Refused, not lost: the text stays to change, nothing was saved, and the bar still counts the change.
  await expect(above).toBeEditable();
  await expect(above).toHaveValue("Ships from Card Shellz.");
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("Not saved · 1 change in Description");
  await expect(row(page, "description")).not.toContainText("Saved");
  // Settled (not polled): one write, sent once, and nothing else.
  await page.waitForTimeout(300);
  expect(state.contentWrites).toHaveLength(1);
  expect(state.contentWrites[0].body).toMatchObject({ profile: { groups: content.profile!.groups } });
  expect(state.contentProfiles[STORE]).toEqual(content);
  expect([state.pricingReviews, state.pricingApplies, state.categoryWrites, state.setupWrites]).toEqual([[], [], [], []]);
  expectNothingUnexpected(state);
});

test("an eBay category save opened before the system moved the rules gets the conflict and Load latest, not the refusal, and then saves (J7)", async ({ page }) => {
  const rules = categoryRulesWithRule();
  const state = await openStep(page, convertState({ categoryRules: { [STORE]: rules } }));
  const editor = page.getByTestId("editor-surface");
  await row(page, "ebayCategory").getByRole("button", { name: "Change eBay category" }).click();
  await editor.getByRole("radio", { name: "One eBay category for every product" }).check();
  await editor.getByRole("textbox", { name: "Search eBay categories" }).fill("toploaders");
  await editor.getByRole("button", { name: "Use this category" }).click();

  // The job moves the store while the editor is open: the rules are emptied at a newer revision.
  stubSystemConversion(state, STORE);
  const moved = state.categoryRules[STORE];
  expect(moved.revisionId).not.toBe(rules.revisionId);
  expect(moved.profile?.rules).toEqual([]);

  // The page sends the old rule back at the old revision: the stub's revision check answers first (D10's 409).
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toContainText("This changed in another window.");
  await expect(editor).not.toContainText(GROUP_RULES_CLOSED);
  const latest = editor.getByRole("button", { name: "Load latest and keep my changes" });
  await expect(latest).toBeVisible();
  expect(state.categoryWrites).toHaveLength(1);
  expect(state.categoryWrites[0].body).toMatchObject({ expectedRevisionId: rules.revisionId,
    draft: { defaultCategoryId: "183436", rules: [{ id: "sleeves", categoryId: EBAY_SLEEVES.categoryId }] } });

  // Load latest: the moved rules (none) under the vendor's pick; the next save sends no rule and saves.
  await latest.click();
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(row(page, "ebayCategory")).toContainText("Saved");
  expect(state.categoryWrites).toHaveLength(2);
  expect(state.categoryWrites[1].body).toEqual({ expectedRevisionId: moved.revisionId, idempotencyKey: KEY("ls-category"),
    draft: { defaultCategoryId: "183436", rules: [] } });
  expect(state.categoryWrites[1].body.idempotencyKey).not.toBe(state.categoryWrites[0].body.idempotencyKey);
  await expect(page.getByText(GROUP_RULES_CLOSED)).toHaveCount(0);
  expectNothingUnexpected(state);
});

// ---------------------------------------------------------------------------
// The one-time notice (PR 11e1, plan 9.2-9.4, 11.3, 11.5; D18, D19, D21, D25; CUX#1)
// ---------------------------------------------------------------------------

const NOTICE_PATH = `${LISTINGS}/listing-settings/conversion/notice`;
const NOTICE_ACK_PATH = `${NOTICE_PATH}/acknowledge`;
/** The job moved one category's rule (the scripted Sleeves layer). */
const NOTICE_WORDS = "We moved your older group rules. 1 category now has its own settings. Nothing in your listings changed. "
  + "Products you choose later use their category's settings or your store defaults.";
const JOB_CONVERSION = 77;

function noticeLine(page: Page) {
  return page.getByTestId("conversion-notice-line");
}

function gotIt(scope: Locator) {
  return scope.getByRole("button", { name: "Got it, hide this note", exact: true });
}

/** The presses sent, as the page sent them. */
function acknowledges(state: StubState) {
  return state.conversionNoticeAcknowledges.map((write) => write.body);
}

/** A store the job moved before the page opened: no group left, Sleeves' price set, its notice unseen. */
function movedByTheJob(overrides: Partial<StubState> = {}): Partial<StubState> {
  return {
    catalog: structuredClone([PENNY, TEAM]), pricingRules: { [STORE]: SAVED_PRICING_RULES },
    categorySettings: sleevesPriceLayer().categorySettings,
    conversionNotices: { [STORE]: { notice: { conversionId: JOB_CONVERSION, convertedAt: "2026-10-16T05:00:00.000Z", categoryCount: 1, productCount: 0 },
      seen: false } },
    ...overrides,
  };
}

test("a store the job moved shows the notice in the line's place; Got it sends one POST, the line goes, focus moves on; a reload doesn't bring it back", async ({ page }, testInfo) => {
  const state = await openStep(page, movedByTheJob());
  await expect(noticeLine(page)).toContainText(NOTICE_WORDS);
  await expect(line(page)).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: "Change settings for Sleeves", exact: true })).toBeVisible();
  // In the strip's slot, above the Store defaults card; a mount read of its own (D18), and no dry run.
  const placed = await page.evaluate(() => {
    const at = (id: string) => document.querySelector(`[data-testid="${id}"]`);
    const noticeAt = at("conversion-notice-line");
    const defaultsAt = at("store-defaults-card");
    return noticeAt !== null && defaultsAt !== null && Boolean(noticeAt.compareDocumentPosition(defaultsAt) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(placed).toBe(true);
  expect(readsOf(state, "GET", NOTICE_PATH)).toHaveLength(1);
  expect(conversionReads(state)).toEqual([]);
  expectGatedReads(state);
  if (phone(testInfo)) {
    expect((await gotIt(noticeLine(page)).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalScroll(page);
  }
  await expect(noticeLine(page)).not.toContainText("_");
  await shot(page, testInfo, "listing-settings-conversion-notice");

  await gotIt(noticeLine(page)).click();
  await expect(noticeLine(page)).toHaveCount(0);
  expect(acknowledges(state)).toEqual([{ conversionId: JOB_CONVERSION }]);
  expect(state.conversionNotices[STORE].seen).toBe(true);
  // The button went with the line: focus moves to the Category settings card's heading (11.2).
  await expect(card(page).getByRole("heading", { name: "Category settings" })).toBeFocused();
  // The notice is read again after the press (its own key only).
  await expect.poll(() => readsOf(state, "GET", NOTICE_PATH).length).toBe(2);
  await page.waitForTimeout(300);
  await expect(line(page)).toHaveCount(0);

  // The server keeps that it was seen: a reload (or another device) never shows it again.
  await page.reload();
  await expect(card(page).getByRole("button", { name: "Change settings for Sleeves", exact: true })).toBeVisible();
  await expect.poll(() => readsOf(state, "GET", NOTICE_PATH).length).toBe(3);
  await page.waitForTimeout(300);
  await expect(noticeLine(page)).toHaveCount(0);
  expect(readsOf(state, "POST", NOTICE_ACK_PATH)).toHaveLength(1);
  expectNothingUnexpected(state);
});

test("a Got it whose answer never came back keeps the notice with why; pressed again it goes: the server had marked it, so it is already seen", async ({ page }) => {
  const state = await openStep(page, movedByTheJob({ conversionNoticeAcknowledgeAnswers: ["drop"] }));
  await gotIt(noticeLine(page)).click();
  await expect(noticeLine(page)).toContainText("Couldn't save that. Try again.");
  await expect(noticeLine(page).getByRole("alert")).toHaveText("Couldn't save that. Try again.");
  await expect(noticeLine(page)).toContainText(NOTICE_WORDS);
  await expect(gotIt(noticeLine(page))).toBeEnabled();
  await gotIt(noticeLine(page)).click();
  await expect(noticeLine(page)).toHaveCount(0);
  // The same body both times, and no request key: the press is idempotent by state.
  expect(acknowledges(state)).toEqual([{ conversionId: JOB_CONVERSION }, { conversionId: JOB_CONVERSION }]);
  expectNothingUnexpected(state);
});

test("too many Got its in a minute say so in the page's words, and the notice stays", async ({ page }) => {
  const state = await openStep(page, movedByTheJob({ conversionNoticeAcknowledgeAnswers: [{ status: 429, code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED",
    message: "Too many saves in a minute. Wait a moment and try again." }] }));
  await gotIt(noticeLine(page)).click();
  await expect(noticeLine(page).getByRole("alert")).toHaveText("Too many saves in a minute. Wait a moment and try again.");
  await expect(noticeLine(page)).toContainText(NOTICE_WORDS);
  expect(state.conversionNotices[STORE].seen).toBe(false);
  expectNothingUnexpected(state);
});

test("over 10,000 chosen sizes the notice still shows (its read takes no selection), beside the banner", async ({ page }) => {
  const state = await openStep(page, movedByTheJob({ tooLarge: true }));
  await expect(banner(page)).toBeVisible();
  await expect(noticeLine(page)).toContainText(NOTICE_WORDS);
  await gotIt(noticeLine(page)).click();
  await expect(noticeLine(page)).toHaveCount(0);
  expect(acknowledges(state)).toEqual([{ conversionId: JOB_CONVERSION }]);
  expectNothingUnexpected(state);
});

test("the job moves the store while the page is open: the sheet finds it moved and says what moved; Close: the older-rules line is gone, the notice and Change show", async ({ page }) => {
  const state = await openStep(page, convertState({ conversionLayers: sleevesPriceLayer() }));
  await expect(line(page)).toBeVisible();
  await expect(noticeLine(page)).toHaveCount(0);
  const notice = stubSystemConversion(state, STORE);
  // The summary on screen still says older rules (it is up to 60 seconds old): [See what changes] opens the sheet.
  await openSheet(page);
  await expect(sheet(page).getByTestId("older-rules-none")).toHaveText(NOTICE_WORDS);
  await expect(gotIt(footer(page))).toBeVisible();
  // The one-time re-read (11.5): the summary, the categories and the notice, never the dry run again.
  await expect.poll(() => readsOf(state, "GET", NOTICE_PATH).length).toBe(2);
  await expect.poll(() => readsOf(state, "GET", SUMMARY_PATH).length).toBe(2);
  expect(conversionReads(state)).toEqual(["?page=0"]);
  await expect(sheet(page)).not.toContainText("_");

  await footer(page).getByRole("button", { name: "Close" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(line(page)).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: "Change settings for Sleeves", exact: true })).toBeVisible();
  // Not seen yet: the notice takes the line's place, and goes with Got it there.
  await expect(noticeLine(page)).toContainText(NOTICE_WORDS);
  await gotIt(noticeLine(page)).click();
  await expect(noticeLine(page)).toHaveCount(0);
  expect(acknowledges(state)).toEqual([{ conversionId: notice.conversionId }]);
  expectNothingUnexpected(state);
});

test("Move them over pressed after the job moved the store: the footer says what the job moved, with Got it; pressed, it says the rules were already moved", async ({ page }) => {
  const state = await openStep(page, convertState({ conversionPages: { 0: CLEAN }, conversionLayers: sleevesPriceLayer() }));
  await openSheet(page);
  await expect(moveButton(page)).toBeEnabled();
  // The job moves the store after the sheet read page 0.
  const notice = stubSystemConversion(state, STORE);
  await moveButton(page).click();
  await expect(footer(page)).toContainText(NOTICE_WORDS);
  await expect(footer(page)).not.toContainText("Your rules have already been moved over.");
  expect(applies(state)).toEqual([{ idempotencyKey: KEY("ls-convert"), planHash: PLAN_A, writesHash: WRITES }]);
  await expect(footer(page).getByRole("button")).toHaveText(["Got it", "Close"]);

  await gotIt(footer(page)).click();
  await expect(footer(page)).toContainText("Your rules have already been moved over.");
  await expect(footer(page).getByRole("button")).toHaveText(["Close"]);
  // [Got it] went from the footer: focus waits on [Close].
  await expect(footer(page).getByRole("button", { name: "Close" })).toBeFocused();
  expect(acknowledges(state)).toEqual([{ conversionId: notice.conversionId }]);
  await footer(page).getByRole("button", { name: "Close" }).click();
  await expect(line(page)).toHaveCount(0);
  await expect(noticeLine(page)).toHaveCount(0);
  expect(readsOf(state, "POST", APPLY_PATH)).toHaveLength(1);
  expectNothingUnexpected(state);
});
