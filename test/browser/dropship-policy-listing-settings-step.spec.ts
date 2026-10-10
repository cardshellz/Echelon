import { expect, test, type Locator, type Page, type TestInfo } from "playwright/test";
import type { EbayCategoryRulesState } from "../../shared/dropship/ebay-category-rules";
import type { ContentProfileState } from "../../shared/dropship/listing-content";
import type { ListingSettingsSummary } from "../../shared/dropship/listing-settings";
import type { PricingProfileState } from "../../shared/dropship/pricing-rules";
import {
  CATALOG_PATH,
  ENVELOPE,
  MARZ,
  OUTLET,
  SAVED_PRICING_RULES,
  SETUP_REVISION,
  STAMP,
  TOPLOADERS,
  defaultStubState,
  liveListingSettingsSummary,
  listingSetupWithAnotherShippingPolicy,
  listingSetupWithNothingSaved,
  openCatalog,
  openOlderSettings,
  shot,
  sizeKey,
  step,
  type ProductFixture,
  type StubState,
} from "./dropship-policy-catalog-stubs";

// Playwright's serviceWorkers:block init script reads navigator.serviceWorker in
// every frame, which throws in an opaque sandbox. This local-only harness
// registers no workers.
test.use({ serviceWorkers: "allow" });

/**
 * The Listing settings step's own journeys (Listing settings PR 7, plan 4A): the shell, every
 * Store defaults writer (W1 with "Check new prices", W2, W3, W4, W10), the drawer's exact price
 * (W9, `inherit` included), the banners and the leave guard, on desktop and on a phone.
 *
 * The stub server (dropship-policy-catalog-stubs.ts) works the summary, the lists and the
 * product out of what it holds, so a save shows in them as it does on the real page. Every
 * journey ends with nothing unexpected asked and no page error.
 */

const SETUP_PATH = `${CATALOG_PATH}/setup`;
const STORE = MARZ.storeConnectionId;
const LISTINGS = `/api/dropship/listings/stores/${STORE}`;
const SETUP_WRITE_PATH = `/api/dropship/ebay/listing-setup/${STORE}`;
const KEY = (prefix: string) => expect.stringMatching(new RegExp(`^${prefix}:[A-Za-z0-9-]+$`));

/** Product 11 with a second size, so one size's change can hold the other back (D4). */
const TWO_SIZE_ENVELOPE: ProductFixture = { ...ENVELOPE, sizes: [...ENVELOPE.sizes,
  { productVariantId: 102, sizeName: "Pack of 100", sku: "ENV-SGL-P100", retailCents: 1_249, costCents: 790, stockUnits: 12 }] };
/** A product whose one size has no retail price: with no store price nothing can price it. */
const GRADED_CASE: ProductFixture = { productId: 12, productName: "Graded Card Case", productSku: "GCC", category: "Cases",
  sizes: [{ productVariantId: 201, sizeName: "Single", sku: "GCC-1", retailCents: null, costCents: 300, stockUnits: 8 }] };

/** An older group rule the store saved; the step sends it back unchanged with a new store price. */
const TOPLOADER_GROUP = { id: "toploaders", name: "Toploaders", priority: 1, scope: { type: "category" as const, category: "Toploaders" },
  recipe: { basis: "catalog_retail" as const, markupBps: 3_000, flatCents: 0, rounding: "up_99" as const } };
const RULES_WITH_GROUP: PricingProfileState = { revisionId: 3, updatedAt: STAMP, profile: {
  defaultRecipe: { basis: "catalog_retail", markupBps: 1_500, flatCents: 0, rounding: "cent" }, groups: [TOPLOADER_GROUP] } };

/** Opens step 2 with the summary worked out from what the stub holds, so a save shows in it. */
function openStep(page: Page, initial: Partial<StubState> = {}, path = SETUP_PATH) {
  return openCatalog(page, path, { liveSummary: true, ...initial });
}

function phone(testInfo: TestInfo) {
  return testInfo.project.name === "mobile";
}

/** A row's value: the record's words from 640 px, the shorter phone words below (R:433-442, C24). */
function rowValue(testInfo: TestInfo, wide: string, narrow: string) {
  return phone(testInfo) ? narrow : wide;
}

function row(page: Page, field: string) {
  return page.getByTestId(`store-default-row-${field}`);
}

/** The open Store defaults editor: an inline panel from 640 px, a bottom sheet below. */
function editor(page: Page) {
  return page.getByTestId("editor-surface");
}

function bar(page: Page) {
  return page.getByTestId("catalog-action-summary");
}

function banner(page: Page) {
  return page.getByTestId("listing-settings-banner");
}

function drawer(page: Page) {
  return page.getByTestId("product-drawer");
}

/** The drawer's main button: "Save product", or "Save" on a phone. */
function drawerSave(page: Page) {
  return page.getByTestId("product-drawer-footer").getByRole("button", { name: /^Save( product)?$/ });
}

function exactBox(page: Page, title: string) {
  return drawer(page).getByLabel(`Exact price for ${title}`, { exact: true });
}

/** A policy in the open editor, by its exact eBay name (the label also carries its Card Shellz fit line). */
function policyChoice(page: Page, name: string) {
  return editor(page).locator("label").filter({ has: page.getByText(name, { exact: true }) }).getByRole("radio");
}

function readsOf(state: StubState, method: string, path: string) {
  return state.reads.filter((read) => read.method === method && read.path === path);
}

async function expectNoHorizontalScroll(page: Page) {
  const width = page.viewportSize()?.width ?? 1280;
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

/** Waits for a sheet's enter animation, then returns its box. */
async function settledBox(locator: Locator) {
  await locator.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)));
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

/** Full screen on a phone (R:412); a sheet on the right edge from 640 px. */
async function expectSheetLayout(page: Page, testInfo: TestInfo, sheet: Locator) {
  const viewport = page.viewportSize()!;
  const box = await settledBox(sheet);
  if (phone(testInfo)) {
    expect(box.x).toBe(0);
    expect(Math.round(box.width)).toBe(viewport.width);
  } else {
    expect(box.x).toBeGreaterThan(0);
    expect(Math.round(box.x + box.width)).toBe(viewport.width);
  }
}

/** The element sits inside the viewport, so it can be pressed without scrolling. */
async function expectInView(page: Page, locator: Locator) {
  const viewport = page.viewportSize()!;
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
}

/**
 * C3: the step reads no description templates unless their editor is open, and adds no
 * pricing-rules or category-rules read of its own. The one of each comes from the hidden
 * older panels, which read on mount under the same query keys.
 */
function expectGatedReads(state: StubState) {
  expect(readsOf(state, "GET", `${LISTINGS}/content-profile`)).toEqual([]);
  expect(readsOf(state, "GET", `${LISTINGS}/pricing-rules`)).toHaveLength(1);
  expect(readsOf(state, "GET", `${LISTINGS}/ebay-category-rules`)).toHaveLength(1);
}

function expectNothingUnexpected(state: StubState) {
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Opens the product's drawer from the Products tab: the name on a wide screen, the card on a phone. */
async function openProductRow(page: Page, productId: number, name: string) {
  await page.getByTestId(`listing-settings-product-${productId}`).getByRole("button", { name: new RegExp(`^${escapeRegExp(name)}`) }).click();
  await expect(drawer(page)).toBeVisible();
}

test("the step shows its title, timing line and seven store defaults in order, Products first, with Older settings closed", async ({ page }, testInfo) => {
  const state = await openStep(page);
  const stepRoot = page.getByTestId("listing-settings-step");

  await expect(stepRoot.getByRole("heading", { level: 2 }).first())
    .toHaveText(phone(testInfo) ? "Listing settings" : `Listing settings for ${MARZ.name}`);
  await expect(page.getByTestId("listing-settings-timing")).toContainText(phone(testInfo)
    ? "Saved settings go to eBay the next time a listing is sent."
    : "Saved settings go to eBay the next time a listing is sent: when you publish it, or when Card Shellz updates it.");
  const fields = await page.getByTestId("store-defaults-rows").locator("[data-field]").evaluateAll(
    (rows) => rows.map((element) => element.getAttribute("data-field")));
  expect(fields).toEqual(["price", "shipping", "return", "payment", "ebayCategory", "shelf", "description"]);
  await expect(row(page, "shipping")).toContainText("USPS Ground Advantage");
  await expect(page.getByTestId("listing-settings-attention")).toContainText("✓ Nothing here needs you.");
  await expect(banner(page)).toHaveCount(0);

  // "When is that?" says when saved settings reach eBay (a popover, or a sheet on a phone).
  await page.getByRole("button", { name: "When is that?" }).click();
  await expect(page.getByTestId("listing-settings-timing-details")).toContainText("A listing goes to eBay when you publish it in step 3.");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("listing-settings-timing-details")).toHaveCount(0);

  // Products is the tab that opens, on the products the vendor chose.
  await expect(page.getByRole("tab", { name: "Products · 1" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("listing-settings-product-11")).toContainText(ENVELOPE.productName);
  await expect(page.getByTestId(phone(testInfo) ? "listing-settings-product-cards" : "listing-settings-products-table")).toBeVisible();

  // Today's panels are mounted under "Older settings", closed: hidden, so none of their headings is in view (D3).
  const older = page.getByRole("button", { name: "Show older settings" });
  await expect(older).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("older-listing-settings-content")).toHaveAttribute("hidden", "");
  await expect(page.getByTestId("older-listing-settings-content")).toContainText("eBay listing setup");
  for (const heading of ["eBay listing setup", "Listing policies", "eBay categories", "Listing pricing rules"]) {
    await expect(page.getByRole("heading", { name: heading, exact: true })).toHaveCount(0);
  }
  await expect(bar(page)).toHaveText("All saved");
  await expectNoHorizontalScroll(page);
  await shot(page, testInfo, "listing-settings-step");

  await older.click();
  await expect(page.getByRole("button", { name: "Hide older settings" })).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("heading", { name: "eBay listing setup", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Listing pricing rules", exact: true })).toBeVisible();
  await expectNoHorizontalScroll(page);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("Task 1: a new store price is checked first, the check sends the older group rules back and keeps exact prices, and Save applies that check", async ({ page }, testInfo) => {
  const state = await openStep(page, { pricingRules: { [STORE]: RULES_WITH_GROUP } });
  const priceRow = row(page, "price");
  await expect(priceRow).toContainText(rowValue(testInfo, "Retail price + 15%, to the cent", "Retail + 15%, to the cent"));

  await priceRow.getByRole("button", { name: "Change Price" }).click();
  await expect(editor(page).getByRole("radio", { name: "Retail price" })).toBeChecked();
  await editor(page).getByRole("textbox", { name: "Add" }).fill("20");
  await expect(bar(page)).toHaveText("Not saved · 1 change in Price");
  await editor(page).getByRole("button", { name: "Check new prices" }).click();

  const sheet = page.getByTestId("check-new-prices");
  await expect(sheet).toContainText("Check new prices · Not saved yet");
  await expect(sheet).toContainText("Retail price + 20%, to the cent");
  await expect(sheet.getByTestId("check-new-prices-footer")).toContainText(phone(testInfo)
    ? "Nothing is saved yet." : "Nothing is saved until you press Save new prices.");
  expect(state.pricingReviews).toEqual([{ method: "POST", path: `${LISTINGS}/pricing-rules/reviews`, body: {
    expectedRevisionId: 3, releaseFixedOverrides: false,
    profile: { defaultRecipe: { basis: "catalog_retail", markupBps: 2_000, flatCents: 0, rounding: "cent" }, groups: [TOPLOADER_GROUP] } } }]);
  expect(state.pricingApplies).toEqual([]);
  await shot(page, testInfo, "listing-settings-check-new-prices");

  const summaryReadsBefore = state.summaryReads.length;
  await sheet.getByRole("button", { name: "Save new prices" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(priceRow).toContainText(rowValue(testInfo, "Retail price + 20%, to the cent", "Retail + 20%, to the cent"));
  await expect(priceRow).toContainText("Saved");
  await expect(priceRow).not.toContainText("Not saved");
  const [review] = Object.values(state.reviews);
  expect(state.pricingApplies).toEqual([{ method: "POST", path: `${LISTINGS}/pricing-rules/apply`,
    body: { reviewId: review.review.reviewId, reviewHash: review.review.reviewHash, idempotencyKey: KEY("ls-apply") } }]);
  // The step reads the summary again after the save (D9) and never trusts the save's answer.
  await expect.poll(() => state.summaryReads.length).toBeGreaterThan(summaryReadsBefore);
  expect(state.pricingRules[STORE]).toMatchObject({ profile: { defaultRecipe: { markupBps: 2_000 }, groups: [TOPLOADER_GROUP] } });
  // The closed older pricing panel shares the saved-rules read; its untouched form follows the new
  // rules, so nothing reports a change the vendor never made (pricingFormTakesSavedRules).
  await expect(bar(page)).toHaveText("All saved");
  await openOlderSettings(page);
  const olderPricing = page.getByRole("heading", { name: /^Listing pricing rules/ });
  await expect(olderPricing).not.toContainText("Not saved");
  await expect(page.getByRole("region", { name: "Listing pricing rules" }).getByLabel("Markup (%)").first()).toHaveValue("20.00");
  expectNothingUnexpected(state);
});

test("a store price saved in the step leaves a change the vendor made in the older pricing panel as it is", async ({ page }) => {
  const state = await openStep(page, { pricingRules: { [STORE]: SAVED_PRICING_RULES } });
  await openOlderSettings(page);
  const olderPricing = page.getByRole("region", { name: "Listing pricing rules" });
  const olderMarkup = olderPricing.getByLabel("Markup (%)").first();
  await expect(olderMarkup).toHaveValue("15.00");
  await olderMarkup.fill("25.00");
  await expect(page.getByRole("heading", { name: /^Listing pricing rules/ })).toContainText("Not saved");

  await row(page, "price").getByRole("button", { name: "Change Price" }).click();
  await editor(page).getByRole("textbox", { name: "Add" }).fill("20");
  await editor(page).getByRole("button", { name: "Check new prices" }).click();
  const sheet = page.getByTestId("check-new-prices");
  await sheet.getByRole("button", { name: "Save new prices" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(row(page, "price")).toContainText("Saved");
  expect(state.pricingApplies).toHaveLength(1);

  // The vendor's own change in the older panel is kept, and still counts as not saved.
  await expect(olderMarkup).toHaveValue("25.00");
  await expect(page.getByRole("heading", { name: /^Listing pricing rules/ })).toContainText("Not saved");
  await expect(bar(page)).toHaveText("Not saved · changes in Older settings");
  expectNothingUnexpected(state);
});

test("Task 1: a save refused as stale gives the new check to save again, and a save whose answer was lost is checked again with the same key", async ({ page }, testInfo) => {
  const state = await openStep(page, { pricingRules: { [STORE]: SAVED_PRICING_RULES },
    pricingApplyAnswers: [{ status: 409, code: "DROPSHIP_PRICING_REVIEW_STALE", message: "Prices changed since this review." }, "drop"] });
  const sheet = page.getByTestId("check-new-prices");
  await row(page, "price").getByRole("button", { name: "Change Price" }).click();
  await editor(page).getByRole("textbox", { name: "Add" }).fill("20");
  await editor(page).getByRole("button", { name: "Check new prices" }).click();
  await sheet.getByRole("button", { name: "Save new prices" }).click();

  // Only prices moved (the rules' revision did not), so the check runs again and says so (R:683).
  await expect(sheet).toContainText("Prices changed while you were checking. Here's the new check.");
  expect(state.pricingReviews).toHaveLength(2);
  expect(state.pricingReviews[1].body).toEqual(state.pricingReviews[0].body);
  expect(state.pricingApplies).toHaveLength(1);

  // The new check is saved with its own key; its answer is lost, so the step can't say it saved.
  await sheet.getByRole("button", { name: "Save new prices" }).click();
  await expect(sheet).toContainText("We couldn't confirm your save.");
  await expect(sheet.getByRole("button", { name: phone(testInfo) ? "Back" : "Back to editing", exact: true })).toBeDisabled();
  expect(state.pricingApplies).toHaveLength(2);
  expect(state.pricingApplies[1].body.reviewId).not.toBe(state.pricingApplies[0].body.reviewId);
  expect(state.pricingApplies[1].body.idempotencyKey).not.toBe(state.pricingApplies[0].body.idempotencyKey);

  // Check again sends the same save with the same key; the server answers it from the first one.
  await sheet.getByRole("button", { name: "Check again" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(row(page, "price")).toContainText(rowValue(testInfo, "Retail price + 20%, to the cent", "Retail + 20%, to the cent"));
  expect(state.pricingApplies).toHaveLength(3);
  expect(state.pricingApplies[2].body).toEqual(state.pricingApplies[1].body);
  expectNothingUnexpected(state);
});

test("Task 1: a check with a size that can't be priced keeps Save off and says which sizes and why", async ({ page }) => {
  // Graded Card Case has no retail price, so "Retail price + 20%" can't price it.
  const state = await openStep(page, { catalog: [ENVELOPE, GRADED_CASE], pricingRules: { [STORE]: SAVED_PRICING_RULES } });
  const sheet = page.getByTestId("check-new-prices");
  await row(page, "price").getByRole("button", { name: "Change Price" }).click();
  await editor(page).getByRole("textbox", { name: "Add" }).fill("20");
  await editor(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(sheet.getByTestId("check-new-prices-footer"))
    .toContainText("● 1 size can't be priced this way. Give it an exact price in Products, or start from Your cost.");
  await expect(sheet.getByRole("button", { name: "Save new prices" })).toBeDisabled();
  expect(state.pricingApplies).toEqual([]);
  expectNothingUnexpected(state);
});

test("Task 4: Choose in the strip opens the Shipping editor; a save sends that policy alone against the loaded revision, and a return-only save sends only the return policy", async ({ page }) => {
  const state = await openStep(page, { listingSetups: { [STORE]: listingSetupWithNothingSaved(STORE) } });
  const strip = page.getByTestId("listing-settings-attention");
  await expect(strip).toContainText("Choose your shipping, return and payment policies. Nothing can be listed until you do.");

  await strip.getByRole("button", { name: "Choose" }).click();
  await expect(editor(page).getByText("Shipping policy", { exact: true }).first()).toBeVisible();
  await policyChoice(page, "USPS Priority Mail").check();
  await expect(bar(page)).toHaveText("Not saved · 1 change in Shipping policy");
  await editor(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(row(page, "shipping")).toContainText("USPS Priority Mail");
  await expect(row(page, "shipping")).toContainText("Saved");
  expect(state.setupWrites).toEqual([{ method: "PUT", path: SETUP_WRITE_PATH,
    body: { expectedRevision: SETUP_REVISION, idempotencyKey: KEY("ls-policy"), fulfillmentPolicyId: "priority" } }]);

  await row(page, "return").getByRole("button", { name: "Change Return policy" }).click();
  await policyChoice(page, "No returns").check();
  await editor(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(row(page, "return")).toContainText("No returns");
  expect(state.setupWrites[1]).toEqual({ method: "PUT", path: SETUP_WRITE_PATH,
    body: { expectedRevision: SETUP_REVISION + 1, idempotencyKey: KEY("ls-policy"), returnPolicyId: "no-returns" } });
  expect(state.setupWrites[1].body.idempotencyKey).not.toBe(state.setupWrites[0].body.idempotencyKey);
  await expect(bar(page)).toHaveText("All saved");
  expectNothingUnexpected(state);
});

test("a policy save refused because another window saved keeps the pick, and Load latest marks the field both changed", async ({ page }) => {
  const loaded = listingSetupWithAnotherShippingPolicy(STORE);
  const setup = { ...loaded, options: { ...loaded.options, fulfillmentPolicies: [...loaded.options.fulfillmentPolicies,
    { id: "express", name: "USPS Priority Mail Express", compatible: true, compatibilityIssues: [] }] } };
  const state = await openStep(page, { listingSetups: { [STORE]: setup } });
  await row(page, "shipping").getByRole("button", { name: "Change Shipping policy" }).click();
  await expect(policyChoice(page, "USPS Ground Advantage")).toBeChecked();

  // Another window saves Express after this page loaded.
  state.listingSetups[STORE] = { ...setup, revision: SETUP_REVISION + 1, selection: { ...setup.selection, fulfillmentPolicyId: "express" } };
  await policyChoice(page, "USPS Priority Mail").check();
  await editor(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor(page)).toContainText("This changed in another window.");
  await expect(policyChoice(page, "USPS Priority Mail")).toBeChecked();
  expect(state.setupWrites).toHaveLength(1);

  await editor(page).getByRole("button", { name: "Load latest and keep my changes" }).click();
  await expect(editor(page)).toContainText("Changed in another window too");
  await expect(policyChoice(page, "USPS Priority Mail")).toBeChecked();
  await editor(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(row(page, "shipping")).toContainText("Saved");
  expect(state.setupWrites[1]).toEqual({ method: "PUT", path: SETUP_WRITE_PATH,
    body: { expectedRevision: SETUP_REVISION + 1, idempotencyKey: KEY("ls-policy"), fulfillmentPolicyId: "priority" } });
  expect(state.setupWrites[1].body.idempotencyKey).not.toBe(state.setupWrites[0].body.idempotencyKey);
  expectNothingUnexpected(state);
});

test("a policy save whose answer was lost is checked again with the same body and key, and a replayed or unchanged answer still reads Saved", async ({ page }) => {
  const setup = listingSetupWithAnotherShippingPolicy(STORE);
  const state = await openStep(page, { listingSetups: { [STORE]: { ...setup, options: { ...setup.options,
    paymentPolicies: [...setup.options.paymentPolicies, { id: "payments-other", name: "Other payments" }] } } },
  setupWriteAnswers: ["drop", { outcome: "replayed" }, { outcome: "unchanged" }] });
  const shipping = row(page, "shipping");
  await shipping.getByRole("button", { name: "Change Shipping policy" }).click();
  await policyChoice(page, "USPS Priority Mail").check();
  await editor(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor(page)).toContainText("We couldn't confirm your save.");
  await expect(editor(page).getByRole("button", { name: "Cancel" })).toBeDisabled();

  // Check again sends the same request with the same key, and its answer is a replay (C26).
  await editor(page).getByRole("button", { name: "Check again" }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(shipping).toContainText("USPS Priority Mail");
  await expect(shipping).toContainText("Saved");
  expect(state.setupWrites).toHaveLength(2);
  expect(state.setupWrites[1]).toEqual(state.setupWrites[0]);
  expect(state.setupWrites[0].body).toEqual({ expectedRevision: SETUP_REVISION, idempotencyKey: KEY("ls-policy"), fulfillmentPolicyId: "priority" });

  // An answer that says nothing needed changing is a confirmed save too (C26).
  const payment = row(page, "payment");
  await payment.getByRole("button", { name: "Change Payment policy" }).click();
  await policyChoice(page, "Other payments").check();
  await editor(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(payment).toContainText("Saved");
  expect(state.setupWrites[2].body).toEqual({ expectedRevision: SETUP_REVISION + 1, idempotencyKey: KEY("ls-policy"), paymentPolicyId: "payments-other" });
  await expect(bar(page)).toHaveText("All saved");
  expectNothingUnexpected(state);
});

test("the store shelf saves two shelves, then None, through the setup save", async ({ page }) => {
  const shelves = [{ categoryId: "11", categoryName: "Toploaders", path: "Supplies:Toploaders", level: 2 },
    { categoryId: "12", categoryName: "Sleeves", path: "Supplies:Sleeves", level: 2 }];
  const state = await openStep(page, { storeShelves: { [STORE]: shelves } });
  const shelf = row(page, "shelf");
  await expect(shelf).toContainText("None");

  await shelf.getByRole("button", { name: "Change Store shelf" }).click();
  await editor(page).getByRole("combobox", { name: "Shelf", exact: true }).click();
  await page.getByRole("option", { name: "Supplies › Toploaders" }).click();
  // One picker's list at a time: the first closes before the second opens.
  await expect(page.getByRole("option")).toHaveCount(0);
  await editor(page).getByRole("combobox", { name: "Second shelf (optional)" }).click();
  await page.getByRole("option", { name: "Supplies › Sleeves" }).click();
  await editor(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(shelf).toContainText("Supplies › Toploaders");
  expect(state.setupWrites).toEqual([{ method: "PUT", path: SETUP_WRITE_PATH,
    body: { expectedRevision: SETUP_REVISION, idempotencyKey: KEY("ls-shelf"), storeShelfDefault: { ids: ["11", "12"] } } }]);

  await shelf.getByRole("button", { name: "Change Store shelf" }).click();
  await editor(page).getByRole("combobox", { name: "Second shelf (optional)" }).click();
  await page.getByRole("option", { name: "None" }).click();
  await expect(page.getByRole("option")).toHaveCount(0);
  await editor(page).getByRole("combobox", { name: "Shelf", exact: true }).click();
  await page.getByRole("option", { name: "None" }).click();
  await editor(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(shelf).toContainText("None");
  expect(state.setupWrites[1]).toEqual({ method: "PUT", path: SETUP_WRITE_PATH,
    body: { expectedRevision: SETUP_REVISION + 1, idempotencyKey: KEY("ls-shelf"), storeShelfDefault: null } });
  expectNothingUnexpected(state);
});

test("a store with no eBay shelves shows None with the optional line and nothing to change", async ({ page }) => {
  const state = await openStep(page);
  await expect(row(page, "shelf")).toContainText("Your eBay store has no shelves. That's fine: shelves are optional.");
  await expect(row(page, "shelf").getByRole("button", { name: "Change Store shelf" })).toHaveCount(0);
  expectNothingUnexpected(state);
});

test("Update now repairs where items ship from with the loaded revision, and waits while a policy change isn't saved", async ({ page }) => {
  const setup = listingSetupWithAnotherShippingPolicy(STORE);
  const outdated = { ...setup, complete: false, missingFields: ["merchantLocationKey"], selection: { ...setup.selection, merchantLocationKey: "old-warehouse" } };
  const state = await openStep(page, { listingSetups: { [STORE]: outdated } });
  const note = page.getByTestId("ship-from-repair-note");
  // Found by its text, not its role: on a phone the open editor is a modal sheet, which hides the page behind it.
  const update = note.locator("button", { hasText: "Update now" });
  await expect(note).toContainText("Card Shellz needs to update where your items ship from.");
  await expect(update).toBeEnabled();

  // An unsaved policy change would be lost by the repair's reload, so the repair waits (C19).
  await row(page, "shipping").getByRole("button", { name: "Change Shipping policy" }).click();
  await policyChoice(page, "USPS Priority Mail").check();
  await expect(update).toBeDisabled();
  await expect(note).toContainText("Save or cancel your policy change first.");
  await editor(page).getByRole("button", { name: "Cancel" }).click();
  await expect(update).toBeEnabled();
  expect(state.setupWrites).toEqual([]);

  await update.click();
  await expect(note).toContainText("Saved");
  await expect(note.getByRole("button", { name: "Update now" })).toHaveCount(0);
  expect(state.setupWrites).toEqual([{ method: "POST", path: `${SETUP_WRITE_PATH}/ship-from/repair`,
    body: { expectedRevision: SETUP_REVISION, idempotencyKey: KEY("ls-ship-from") } }]);
  expectNothingUnexpected(state);
});

/** A store with one older eBay category rule (toploaders go to "Toploaders"). */
const CATEGORY_RULES: EbayCategoryRulesState = { revisionId: 7, updatedAt: STAMP, profile: { version: 1, defaultCategory: null, rules: [
  { id: "toploaders", name: "Toploaders", scope: { type: "category", category: "Toploaders" },
    category: { categoryId: TOPLOADERS.categoryId, categoryName: TOPLOADERS.categoryName, path: [...TOPLOADERS.path] } }] } };

test("an eBay category picked by search saves as the store default and sends the older rules back", async ({ page }, testInfo) => {
  const state = await openStep(page, { categoryRules: { [STORE]: CATEGORY_RULES } });
  const category = row(page, "ebayCategory");
  await expect(category).toContainText(rowValue(testInfo, "Card Shellz picks one for each product (recommended)", "Card Shellz picks"));
  await category.getByRole("button", { name: "Change eBay category" }).click();
  await editor(page).getByRole("radio", { name: "One eBay category for every product" }).check();
  await editor(page).getByRole("textbox", { name: "Search eBay categories" }).fill("sleeves");
  await editor(page).getByRole("button", { name: "Use this category" }).click();
  await expect(editor(page).getByTestId("ebay-category-default-path")).toContainText("Card Sleeves");
  await editor(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(category).toContainText("Card Sleeves");
  await expect(category).toContainText("Saved");
  await expect(bar(page)).toHaveText("All saved");
  expect(state.categorySearches.at(-1)).toBe("sleeves");
  expect(state.categoryWrites).toEqual([{ method: "PUT", path: `${LISTINGS}/ebay-category-rules`, body: {
    expectedRevisionId: 7, idempotencyKey: KEY("ls-category"),
    draft: { defaultCategoryId: "183435", rules: [{ id: "toploaders", name: "Toploaders", scope: { type: "category", category: "Toploaders" },
      categoryId: TOPLOADERS.categoryId }] } } }]);
  expectNothingUnexpected(state);
});

test("while eBay needs a sign-in, the eBay category row shows its value without Change and sends nothing", async ({ page }, testInfo) => {
  const state = await openStep(page, { storeStatuses: { [STORE]: "needs_reauth" }, categoryRules: { [STORE]: CATEGORY_RULES } });
  await expect(banner(page)).toHaveAttribute("data-kind", "sign_in");
  await expect(row(page, "ebayCategory"))
    .toContainText(rowValue(testInfo, "Card Shellz picks one for each product (recommended)", "Card Shellz picks"));
  await expect(row(page, "ebayCategory")).toContainText("Reconnect eBay to change this.");
  await expect(row(page, "ebayCategory").getByRole("button", { name: "Change eBay category" })).toHaveCount(0);
  expect(state.categoryWrites).toEqual([]);
  await expect(banner(page)).toHaveCount(1);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

/** Saved description templates with one older group the step must send back. */
const CONTENT_PROFILE: ContentProfileState = { revisionId: 5, updatedAt: STAMP, profile: {
  defaultTemplate: { introduction: "", footer: "" },
  groups: [{ id: "mailers", name: "Mailers", priority: 1, scope: { type: "category", category: "Mailers" },
    template: { introduction: "Mailers ship flat.", footer: "" } }] } };

test("the description saves the store's text and sends the older groups back; a rate-limited save keeps the text editable", async ({ page }) => {
  const state = await openStep(page, { contentProfiles: { [STORE]: CONTENT_PROFILE },
    contentWriteAnswers: [{ status: 429, code: "DROPSHIP_CONTENT_RATE_LIMITED", message: "Too many requests." }] });
  const description = row(page, "description");
  await description.getByRole("button", { name: "Change Description" }).click();
  const above = editor(page).getByRole("textbox", { name: "Text above (optional)" });
  await above.fill("Ships from Card Shellz.");
  await editor(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor(page)).toContainText("Too many saves in a minute. Wait a moment and try again.");
  await expect(above).toBeEditable();
  await expect(above).toHaveValue("Ships from Card Shellz.");
  await expect(bar(page)).toHaveText("Not saved · 1 change in Description");

  await editor(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor(page)).toHaveCount(0);
  await expect(description).toContainText("Saved");
  await expect(bar(page)).toHaveText("All saved");
  expect(state.contentWrites).toHaveLength(2);
  expect(state.contentWrites[1].body).toEqual({ expectedRevisionId: 5, idempotencyKey: KEY("ls-text"),
    profile: { defaultTemplate: { introduction: "Ships from Card Shellz.", footer: "" }, groups: CONTENT_PROFILE.profile!.groups } });
  // A rate limit keeps the request key: the second try is the same request (plan 4.5).
  expect(state.contentWrites[1].body).toEqual(state.contentWrites[0].body);
  expectNothingUnexpected(state);
});

test("Task 2: a size found by its SKU opens on its Exact box; one Save sends one price, the size is read again, and the next save uses the new revision", async ({ page }, testInfo) => {
  const state = await openStep(page, { catalog: [TWO_SIZE_ENVELOPE] });
  await page.getByRole("searchbox", { name: "Search product, size or SKU" }).fill("ENV-SGL-P100");
  await expect.poll(() => state.productsReads).toContain(`${STORE}?search=ENV-SGL-P100&show=all&page=0`);
  await expect(page.getByTestId("listing-settings-product-11")).toContainText("Pack of 100");
  await openProductRow(page, 11, ENVELOPE.productName);
  await expect(page).toHaveURL(/[?&]product=11&size=102$/);
  const box = exactBox(page, "Pack of 100 · ENV-SGL-P100");
  await expect(box).toBeFocused();

  await box.fill("14.99");
  await expect(drawer(page)).toContainText("→ $14.99 · Not saved · retail price would be $12.49");
  await expect(page.getByTestId("product-drawer-footer")).toContainText(phone(testInfo) ? "● Not saved · 1" : "● Not saved · 1 change");
  // One size per save (D4): the other size waits while this one holds a change.
  await expect(exactBox(page, "Pack of 50 · ENV-SGL-P50")).toHaveAttribute("aria-readonly", "true");
  await expect(drawer(page)).toContainText("Save or discard the price you changed first.");
  await shot(page, testInfo, "listing-settings-drawer");

  await drawerSave(page).click();
  await expect(page.getByTestId("product-drawer-footer")).toContainText("Saved");
  const pricePath = `${LISTINGS}/variants/102/price`;
  expect(state.priceWrites).toEqual([{ method: "PUT", path: pricePath, body: { priceCents: 1_499, expectedRevisionId: null, idempotencyKey: KEY("ls-price") } }]);
  // After the save the size's price is read again with a GET (C2); the PUT's answer is not cached.
  const putAt = state.reads.findIndex((read) => read.method === "PUT" && read.path === pricePath);
  await expect.poll(() => state.reads.slice(putAt + 1).filter((read) => read.method === "GET" && read.path === pricePath).length).toBe(1);
  await expect(drawer(page).getByTestId("drawer-size-102")).toContainText("$14.99");
  await expect(drawer(page).getByTestId("drawer-size-102")).toContainText("Exact price");

  const savedRevision = state.sizePrices[sizeKey(STORE, 102)].revisionId;
  await box.fill("15.49");
  await drawerSave(page).click();
  await expect.poll(() => state.priceWrites.length).toBe(2);
  expect(state.priceWrites[1].body).toEqual({ priceCents: 1_549, expectedRevisionId: savedRevision, idempotencyKey: KEY("ls-price") });
  expect(state.priceWrites[1].body.idempotencyKey).not.toBe(state.priceWrites[0].body.idempotencyKey);
  expectNothingUnexpected(state);
});

test("Task 2: a price outside a Card Shellz limit is refused by the field and the change stays to fix", async ({ page }) => {
  const message = "Card Shellz lists this size between $9.99 and $39.99.";
  const state = await openStep(page, { catalog: [TWO_SIZE_ENVELOPE],
    priceWriteAnswers: [{ status: 422, code: "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", message }] }, `${SETUP_PATH}?product=11&size=102`);
  const box = exactBox(page, "Pack of 100 · ENV-SGL-P100");
  await expect(box).toBeFocused();
  await box.fill("99.99");
  await drawerSave(page).click();
  await expect(drawer(page).getByTestId("drawer-size-102").getByRole("alert")).toHaveText(message);
  await expect(box).toHaveValue("99.99");
  await expect(box).toBeEditable();
  await expect(bar(page)).toHaveText(`Not saved · 1 change in ${ENVELOPE.productName}`);
  expect(state.priceWrites).toHaveLength(1);
  expectNothingUnexpected(state);
});

test("A3: clearing an exact price on a store with a store price saves inherit, and the size reads Store default", async ({ page }) => {
  const state = await openStep(page, { pricingRules: { [STORE]: SAVED_PRICING_RULES },
    sizePrices: { [sizeKey(STORE, 101)]: { revisionId: 31, pricingMode: "fixed", overridePriceCents: 1_499 } } },
  `${SETUP_PATH}?product=11&size=101`);
  const box = exactBox(page, "Pack of 50 · ENV-SGL-P50");
  await expect(box).toHaveValue("14.99");
  await drawer(page).getByRole("button", { name: "Use the price above" }).click();
  await expect(box).toHaveValue("");
  await expect(drawer(page)).toContainText("→ $8.04 · Not saved · uses the store default");
  await drawerSave(page).click();
  await expect(page.getByTestId("product-drawer-footer")).toContainText("Saved");
  expect(state.priceWrites).toEqual([{ method: "PUT", path: `${LISTINGS}/variants/101/price`,
    body: { priceCents: null, pricingMode: "inherit", expectedRevisionId: 31, idempotencyKey: KEY("ls-price") } }]);
  await expect(drawer(page).getByTestId("drawer-size-101")).toContainText("$8.04");
  await expect(drawer(page).getByTestId("drawer-size-101")).toContainText("Store default: retail $6.99 + 15%");
  expectNothingUnexpected(state);
});

test("A3: clearing an exact price with no store price saves inherit on the retail price, and the drawer and Prices tab say why", async ({ page }, testInfo) => {
  const fallback = "No pricing rule covers this size, so it uses the retail price ($6.99)";
  const state = await openStep(page, { sizePrices: { [sizeKey(STORE, 101)]: { revisionId: 31, pricingMode: "fixed", overridePriceCents: 1_499 } } },
    `${SETUP_PATH}?product=11&size=101`);
  const box = exactBox(page, "Pack of 50 · ENV-SGL-P50");
  await expect(box).toHaveValue("14.99");
  await drawer(page).getByRole("button", { name: "Use the price above" }).click();
  await expect(drawer(page)).toContainText("→ $6.99 · Not saved · uses the retail price");
  await expect(drawer(page)).toContainText(`${fallback}.`);
  await drawerSave(page).click();
  await expect(page.getByTestId("product-drawer-footer")).toContainText("Saved");
  expect(state.priceWrites).toEqual([{ method: "PUT", path: `${LISTINGS}/variants/101/price`,
    body: { priceCents: null, pricingMode: "inherit", expectedRevisionId: 31, idempotencyKey: KEY("ls-price") } }]);
  const size = drawer(page).getByTestId("drawer-size-101");
  await expect(size).toContainText(fallback);
  await expect(size).toContainText("Set a store price or type a price.");

  await drawer(page).getByRole("button", { name: phone(testInfo) ? "Back" : "Close" }).click();
  await expect(drawer(page)).toHaveCount(0);
  await page.getByRole("tab", { name: /^Prices/ }).click();
  const priceRow = page.getByTestId("listing-settings-size-101");
  await expect(priceRow).toContainText(fallback);
  await expect(priceRow).toContainText("Set a store price or type a price.");
  await page.getByTestId("listing-settings-prices-tab").getByLabel("Show").selectOption({ label: "Retail price, no store price" });
  await expect.poll(() => readsOf(state, "GET", `${LISTINGS}/listing-settings/prices`).map((read) => read.search))
    .toContain("?search=&show=retail_fallback&page=0");
  await expect(priceRow).toBeVisible();
  expectNothingUnexpected(state);
});

test("A3: a size with no retail price can't be cleared, and says it needs an exact price", async ({ page }) => {
  const state = await openStep(page, { catalog: [GRADED_CASE],
    sizePrices: { [sizeKey(STORE, 201)]: { revisionId: 32, pricingMode: "fixed", overridePriceCents: 899 } } },
  `${SETUP_PATH}?product=12&size=201`);
  await expect(exactBox(page, "Single · GCC-1")).toHaveValue("8.99");
  await expect(drawer(page).getByRole("button", { name: "Use the price above" })).toBeDisabled();
  await expect(drawer(page)).toContainText("This size has no retail price, so it needs an exact price.");
  expect(state.priceWrites).toEqual([]);
  expectNothingUnexpected(state);
});

test("eBay asking for a sign-in shows one banner with Reconnect eBay, locks the rows that read eBay, keeps prices editable and sends no setup save", async ({ page }) => {
  const state = await openStep(page, { setupReadError: { status: 403, code: "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED",
    message: "eBay needs the store to be connected again.", context: { storeConnectionId: STORE, retryable: false } } });
  await expect(banner(page)).toHaveCount(1);
  await expect(banner(page)).toHaveAttribute("data-kind", "sign_in");
  await expect(banner(page)).toContainText(`eBay needs you to sign in again for ${MARZ.name}. Your settings are safe.`);
  await expect(banner(page).getByRole("link", { name: "Reconnect eBay" })).toHaveAttribute("href", /\/onboarding$/);
  for (const field of ["shipping", "return", "payment", "shelf"]) {
    await expect(row(page, field)).toContainText("Reconnect eBay to change this.");
    await expect(row(page, field).getByRole("button", { name: /^Change/ })).toHaveCount(0);
  }
  await expect(page.getByTestId("ship-from-repair-note")).toHaveCount(0);
  // Prices don't read eBay: the store price can still be set (C1).
  await expect(row(page, "price").getByRole("button", { name: "Set price" })).toBeVisible();
  expect(state.setupWrites).toEqual([]);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("eBay not answering shows the unreachable banner, and Try again reads the setup again", async ({ page }) => {
  const state = await openStep(page, { setupReadFailures: 1 });
  await expect(banner(page)).toHaveCount(1);
  await expect(banner(page)).toHaveText(/Can't reach eBay right now\. Your saved settings still apply\./);
  expect(state.setupReads).toEqual([STORE]);
  await banner(page).getByRole("button", { name: "Try again" }).click();
  await expect(banner(page)).toHaveCount(0);
  expect(state.setupReads).toEqual([STORE, STORE]);
  await expect(row(page, "shipping").getByRole("button", { name: "Change Shipping policy" })).toBeVisible();
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("a paused account shows the selling-paused banner: policies stay editable and prices can't be changed", async ({ page }, testInfo) => {
  const state = await openStep(page, { vendor: { status: "paused", entitlementStatus: "active" }, pricingRules: { [STORE]: SAVED_PRICING_RULES } });
  await expect(banner(page)).toHaveCount(1);
  await expect(banner(page)).toHaveAttribute("data-kind", "selling_paused");
  await expect(banner(page)).toHaveText(/^Selling is paused on your account\. Prices, eBay categories and descriptions can't be changed until it resumes\./);
  await expect(banner(page).getByRole("link", { name: "Go to Wallet" })).toBeVisible();
  await expect(row(page, "shipping").getByRole("button", { name: "Change Shipping policy" })).toBeVisible();
  await expect(row(page, "price")).toContainText(rowValue(testInfo, "Retail price + 15%, to the cent", "Retail + 15%, to the cent"));
  await expect(row(page, "price").getByRole("button", { name: /^(Change Price|Set price)$/ })).toHaveCount(0);
  await expect(row(page, "ebayCategory").getByRole("button", { name: "Change eBay category" })).toHaveCount(0);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("a policy save refused because the store is paused shows the banner and keeps the change", async ({ page }) => {
  const state = await openStep(page, { listingSetups: { [STORE]: listingSetupWithAnotherShippingPolicy(STORE) },
    setupWriteAnswers: [{ status: 409, code: "DROPSHIP_LISTING_CONFIG_STORE_PAUSED", message: "This store is paused." }] });
  await row(page, "shipping").getByRole("button", { name: "Change Shipping policy" }).click();
  await policyChoice(page, "USPS Priority Mail").check();
  await editor(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(banner(page)).toHaveCount(1);
  await expect(banner(page)).toHaveText(new RegExp(`${MARZ.name} is paused, so its settings can't be changed now\\.`));
  await expect(bar(page)).toHaveText("Not saved · 1 change in Shipping policy");
  expect(state.setupWrites).toHaveLength(1);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("an exact price refused because the store is blocked reads the summary again, shows its banner and keeps the change", async ({ page }) => {
  // The price route answers this refusal with its code and message only, no context
  // (dropship-listing-price.routes.ts respondError; dropship-listing-price-service.ts authorize),
  // so the code names no single cause and the banner comes from the summary read again.
  const state = await openStep(page, { priceWriteAnswers: [{ status: 403, code: "DROPSHIP_LISTING_STORE_BLOCKED",
    message: "This store is not available for listing-price changes." }] },
  `${SETUP_PATH}?product=11&size=101`);
  const box = exactBox(page, "Pack of 50 · ENV-SGL-P50");
  await expect(box).toBeFocused();
  await box.fill("9.99");
  await expect(banner(page)).toHaveCount(0);
  const summaryReads = state.summaryReads.length;
  // Card Shellz paused the store after the page loaded: the summary now says so.
  state.storeStatuses[STORE] = "paused";
  await drawerSave(page).click();
  await expect(banner(page)).toHaveCount(1);
  await expect(banner(page)).toHaveAttribute("data-kind", "store_paused");
  await expect(banner(page)).toHaveText(new RegExp(`${MARZ.name} is paused, so its settings can't be changed now\\.`));
  expect(state.summaryReads.length).toBeGreaterThan(summaryReads);
  expect(state.priceWrites).toHaveLength(1);
  await expect(page.getByTestId("product-drawer-footer")).toContainText("Nothing was saved.");
  await expect(bar(page)).toHaveText(`Not saved · 1 change in ${ENVELOPE.productName}`);
  await expect(box).toHaveValue("9.99");
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("more than 10,000 sizes chosen shows the too-large banner, and the lists can't be used", async ({ page }) => {
  const state = await openStep(page, { tooLarge: true });
  await expect(banner(page)).toHaveCount(1);
  await expect(banner(page)).toContainText("You've chosen more than 10,000 sizes. Settings can't be checked until you choose 10,000 or fewer.");
  await expect(page.getByRole("searchbox", { name: "Search product, size or SKU" })).toBeDisabled();
  await expect(page.getByTestId("listing-settings-attention")).toHaveCount(0);
  await banner(page).getByRole("button", { name: "Go to step 1" }).click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/choose`);
  // The Products tab may ask once before the summary answers; that read is refused as too large too,
  // and nothing is asked after (the lists are off).
  expect(readsOf(state, "GET", `${LISTINGS}/listing-settings/products`).length).toBeLessThanOrEqual(1);
  expect(readsOf(state, "GET", `${LISTINGS}/listing-settings/prices`)).toEqual([]);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("leaving with a change asks first, from Next, the rail and the store picker; Esc gives focus back to Change; Back closes the drawer and keeps its change", async ({ page }, testInfo) => {
  const state = await openStep(page, { stores: [MARZ, OUTLET], listingSetups: { [STORE]: listingSetupWithAnotherShippingPolicy(STORE) } });
  const dialog = page.getByRole("alertdialog");
  const changed = `Not saved · 1 change in ${ENVELOPE.productName}`;

  // Esc closes an editor with nothing changed, and focus goes back to its Change (R:97).
  const changeReturn = row(page, "return").getByRole("button", { name: "Change Return policy" });
  await changeReturn.click();
  await expect(editor(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor(page)).toHaveCount(0);
  await expect(changeReturn).toBeFocused();

  if (!phone(testInfo)) {
    // From 640 px an editor opens in place, so the page's ways off stay in reach and ask first.
    await row(page, "shipping").getByRole("button", { name: "Change Shipping policy" }).click();
    await policyChoice(page, "USPS Priority Mail").check();
    await expect(bar(page)).toHaveText("Not saved · 1 change in Shipping policy");
    await page.getByRole("link", { name: "Next: Publish" }).click();
    await expect(dialog).toContainText("You have 1 change that isn't saved.");
    await dialog.getByRole("button", { name: "Keep editing" }).click();
    await expect(page).toHaveURL(SETUP_PATH);
    await editor(page).getByRole("button", { name: "Cancel" }).click();
    await expect(bar(page)).toHaveText("All saved");
  }

  // Browser Back closes the drawer and keeps its change; the bar names the product.
  await openProductRow(page, 11, ENVELOPE.productName);
  await exactBox(page, "Pack of 50 · ENV-SGL-P50").fill("9.99");
  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(bar(page)).toHaveText(changed);

  // Next, the rail and the store picker each ask first; Keep editing keeps the change.
  await page.getByRole("link", { name: "Next: Publish" }).click();
  await expect(dialog).toContainText("Leave without saving?");
  await expect(dialog).toContainText("You have 1 change that isn't saved.");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(SETUP_PATH);
  await step(page, "choose").click();
  await expect(dialog).toContainText("You have 1 change that isn't saved.");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await page.getByTestId("catalog-store-select").click();
  await page.getByRole("option", { name: "Marz Cards Outlet (eBay)" }).click();
  await expect(dialog).toContainText("You have 1 change that isn't saved.");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByTestId("catalog-store-select")).toHaveText("Marz Cards (eBay)");
  await expect(bar(page)).toHaveText(changed);

  // Opening the product again shows the change kept.
  await openProductRow(page, 11, ENVELOPE.productName);
  await expect(exactBox(page, "Pack of 50 · ENV-SGL-P50")).toHaveValue("9.99");
  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);

  // Discard and leave drops the change.
  await page.getByRole("link", { name: "Next: Publish" }).click();
  await dialog.getByRole("button", { name: "Discard and leave" }).click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/publish`);
  await step(page, "setup").click();
  await expect(bar(page)).toHaveText("All saved");
  expect(state.setupWrites).toEqual([]);
  expect(state.priceWrites).toEqual([]);
  expectNothingUnexpected(state);

  // Closing the tab with a change gets the browser's own question.
  await openProductRow(page, 11, ENVELOPE.productName);
  await exactBox(page, "Pack of 50 · ENV-SGL-P50").fill("8.99");
  const asked = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const unload = await asked;
  expect(unload.type()).toBe("beforeunload");
  await unload.accept();
});

test("the strip keeps the server's order, leaves out Reconnect while the banner shows it, and Fix opens the drawer on the size that can't be priced", async ({ page }) => {
  const catalog = [ENVELOPE, GRADED_CASE];
  const live = liveListingSettingsSummary({ ...defaultStubState(), catalog }, STORE);
  const summary: ListingSettingsSummary = { ...live, storeStatus: "needs_reauth", attention: { total: 5, items: [
    { code: "reconnect_store", count: 1, productId: null, productName: null },
    { code: "size_cannot_be_priced", count: 1, productId: GRADED_CASE.productId, productName: GRADED_CASE.productName },
    { code: "no_ebay_category", count: 2, productId: null, productName: null }] } };
  const state = await openStep(page, { catalog, summaries: { [STORE]: summary } });
  const strip = page.getByTestId("listing-settings-attention");
  await expect(banner(page)).toHaveAttribute("data-kind", "sign_in");
  await expect(strip.locator("li[data-code]")).toHaveCount(2);
  expect(await strip.locator("li[data-code]").evaluateAll((items) => items.map((item) => item.getAttribute("data-code"))))
    .toEqual(["size_cannot_be_priced", "no_ebay_category"]);
  await expect(strip).toContainText("Graded Card Case can't be listed: a size can't be priced.");
  await expect(strip.getByTestId("listing-settings-attention-more")).toContainText("And 2 more.");
  await expect(strip).not.toContainText("Reconnect eBay for");

  await strip.locator("li[data-code='size_cannot_be_priced']").getByRole("button", { name: "Fix" }).click();
  await expect(drawer(page)).toBeVisible();
  await expect(page).toHaveURL(/[?&]product=12&size=201$/);
  await expect(exactBox(page, "Single · GCC-1")).toBeFocused();
  await expect(banner(page)).toHaveCount(1);
  expectGatedReads(state);
  expectNothingUnexpected(state);
});

test("a store whose sign-in refresh failed keeps the Reconnect line, since no banner says it", async ({ page }) => {
  const state = await openStep(page, { storeStatuses: { [STORE]: "refresh_failed" } });
  await expect(page.getByTestId("listing-settings-attention")).toContainText(`Reconnect eBay for ${MARZ.name}.`);
  await expect(banner(page)).toHaveCount(0);
  expectNothingUnexpected(state);
});

test("on a phone the drawer and the price check fill the screen with Save in view; from 640 px they open as side sheets", async ({ page }, testInfo) => {
  const state = await openStep(page, { pricingRules: { [STORE]: SAVED_PRICING_RULES } }, `${SETUP_PATH}?product=11&size=101`);
  await expectSheetLayout(page, testInfo, drawer(page));
  await exactBox(page, "Pack of 50 · ENV-SGL-P50").fill("9.99");
  await expectInView(page, drawerSave(page));
  await expectNoHorizontalScroll(page);
  await shot(page, testInfo, "listing-settings-drawer-layout");
  await page.getByTestId("product-drawer-footer").getByRole("button", { name: "Discard" }).click();
  await drawer(page).getByRole("button", { name: phone(testInfo) ? "Back" : "Close" }).click();
  await expect(drawer(page)).toHaveCount(0);

  await row(page, "price").getByRole("button", { name: "Change Price" }).click();
  await editor(page).getByRole("textbox", { name: "Add" }).fill("20");
  await editor(page).getByRole("button", { name: "Check new prices" }).click();
  const sheet = page.getByTestId("check-new-prices");
  await expect(sheet).toBeVisible();
  await expectSheetLayout(page, testInfo, sheet);
  await expectInView(page, sheet.getByRole("button", { name: "Save new prices" }));
  await expectNoHorizontalScroll(page);
  await shot(page, testInfo, "listing-settings-check-layout");
  expectNothingUnexpected(state);
});
