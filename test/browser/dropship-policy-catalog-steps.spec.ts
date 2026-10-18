import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  CATALOG_PATH,
  ENVELOPE,
  HANDLING_TIME_ISSUE,
  MARZ,
  MEMBER_ID,
  OUTLET,
  SAVED_PRICING_RULES,
  SETUP_REVISION,
  SHOP,
  listingSettingsSummary,
  listingSetup,
  listingSetupWithAnotherShippingPolicy,
  listingSetupWithSavedShippingGone,
  openCatalog,
  shot,
  step,
  withShippingNotChecked,
  type StubState,
} from "./dropship-policy-catalog-stubs";

// Playwright's serviceWorkers:block init script reads navigator.serviceWorker in
// every frame, which throws in an opaque sandbox. This local-only harness
// registers no workers.
test.use({ serviceWorkers: "allow" });

// The stub server and fixtures live in dropship-policy-catalog-stubs.ts, shared with the
// Listing settings step's own journeys (dropship-policy-listing-settings-step.spec.ts).
// Since Listing settings PR 12 step 2 is the step alone: the journeys that drove the older
// panels drive the step's own rows, banner and editors, and the rail lines stay as they were.

/** The headings of the older step 2 panels (deleted in Listing settings PR 12): none may show. */
const OLDER_PANEL_HEADINGS = ["eBay listing setup", "Listing policies", "eBay categories", "Listing pricing rules", "Description templates"];

test("a bare Catalog address opens Choose, and moving between steps keeps the vendor's work", async ({ page }, testInfo) => {
  const state = await openCatalog(page, CATALOG_PATH);

  await expect(page).toHaveURL(`${CATALOG_PATH}/choose`);
  await expect(step(page, "choose")).toHaveAttribute("aria-current", "step");
  await expect(step(page, "choose")).toContainText("1 selected");
  await expect(page.getByRole("heading", { name: "Available catalog" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Listing preview and push" })).toHaveCount(0);
  await expect(page.getByTestId("portal-nav").getByRole("button", { name: "Catalog" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("1 selected");
  // The rail's line comes from saved settings: eBay is not asked off Listing settings.
  await expect(step(page, "setup")).toContainText("All set");
  expect(state.setupReads).toEqual([]);
  await shot(page, testInfo, "catalog-step-choose");

  await page.getByRole("link", { name: "Next: Listing settings" }).click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/setup`);
  await expect(step(page, "setup")).toHaveAttribute("aria-current", "step");
  await expect(step(page, "setup")).toContainText("All set");
  await expect(page.getByTestId("listing-settings-step")).toBeVisible();
  await expect(page.getByTestId("store-default-row-shipping")).toContainText("USPS Ground Advantage");
  // Step 2 is the step alone (PR 12, D3, D4): no older panel, and no "Older settings" section to open.
  for (const heading of OLDER_PANEL_HEADINGS) await expect(page.getByRole("heading", { name: heading, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /older settings/i })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Available catalog" })).toHaveCount(0);
  // Listing settings has its own bar (R:597); the other steps keep theirs.
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("All saved");
  await shot(page, testInfo, "catalog-step-setup");
  // eBay is asked once: the step and the rail share one read.
  expect(state.setupReads).toEqual([5]);
  // The step's only new read on mount is the Products tab's first page.
  await expect.poll(() => state.productsReads).toEqual([`${MARZ.storeConnectionId}?search=&show=all&page=0`]);

  await page.getByRole("link", { name: "Next: Publish" }).click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/publish`);
  const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "Listing preview and push" }) });
  await card.getByRole("button", { name: "Preview selected" }).click();
  await expect(card.getByText("Envelope Single Pocket, Pack of 50").first()).toBeVisible();
  await shot(page, testInfo, "catalog-step-publish");

  // Leaving the step and coming back keeps the preview: nothing is asked again.
  await step(page, "choose").click();
  await expect(page.getByRole("heading", { name: "Available catalog" })).toBeVisible();
  await step(page, "publish").click();
  await expect(card.getByText("Envelope Single Pocket, Pack of 50").first()).toBeVisible();
  expect(state.previewCalls).toBe(1);

  // The browser's Back button walks the steps.
  await page.goBack();
  await expect(page).toHaveURL(`${CATALOG_PATH}/choose`);
  await expect(page.getByRole("heading", { name: "Available catalog" })).toBeVisible();
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("Next stays off until something is selected", async ({ page }) => {
  const state = await openCatalog(page, `${CATALOG_PATH}/choose`, { selected: false });

  await expect(step(page, "choose")).toContainText("0 selected");
  await expect(step(page, "choose")).toContainText("not done yet");
  await expect(page.getByRole("button", { name: "Next: Listing settings" })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Next: Listing settings" })).toHaveCount(0);
  // The rail still opens any step.
  await step(page, "publish").click();
  await expect(page.getByText("Choose items in step 1, Choose what to sell.", { exact: false })).toBeVisible();
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

/** The new Listing settings step's bar, open Store defaults editor and product drawer (as its own journeys name them). */
function bar(page: Page) {
  return page.getByTestId("catalog-action-summary");
}

function policyEditor(page: Page) {
  return page.getByTestId("editor-surface");
}

function productDrawer(page: Page) {
  return page.getByTestId("product-drawer");
}

test("a change kept after the browser's Back is still there when Next or the rail goes back to Listing settings, with nothing asked", async ({ page }) => {
  const state = await openCatalog(page, `${CATALOG_PATH}/choose`, { liveSummary: true });
  const dialog = page.getByRole("alertdialog");
  const changed = `Not saved · 1 change in ${ENVELOPE.productName}`;
  const exactPrice = productDrawer(page).getByLabel("Exact price for Pack of 50 · ENV-SGL-P50", { exact: true });
  const openEnvelope = async () => {
    await page.getByTestId("listing-settings-product-11").getByRole("button", { name: new RegExp(`^${ENVELOPE.productName}`) }).click();
    await expect(productDrawer(page)).toBeVisible();
  };

  await page.getByRole("link", { name: "Next: Listing settings" }).click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/setup`);
  await openEnvelope();
  await exactPrice.fill("9.99");
  // Back closes the drawer and keeps its change; Back again goes to step 1, which the guard does not catch.
  await page.goBack();
  await expect(productDrawer(page)).toHaveCount(0);
  await expect(bar(page)).toHaveText(changed);
  await page.goBack();
  await expect(page).toHaveURL(`${CATALOG_PATH}/choose`);
  await expect(page.getByRole("heading", { name: "Available catalog" })).toBeVisible();

  // Going back to finish the change drops nothing, so Next asks nothing and the change is there.
  await page.getByRole("link", { name: "Next: Listing settings" }).click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/setup`);
  await expect(dialog).toHaveCount(0);
  await expect(bar(page)).toHaveText(changed);
  await openEnvelope();
  await expect(exactPrice).toHaveValue("9.99");
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(`${CATALOG_PATH}/choose`);

  // So does the rail's Listing settings link.
  await step(page, "setup").click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/setup`);
  await expect(dialog).toHaveCount(0);
  await expect(bar(page)).toHaveText(changed);

  // Leaving the step with the change still asks, and Keep editing keeps it.
  await step(page, "choose").click();
  await expect(dialog).toContainText("You have 1 change that isn't saved.");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/setup`);
  await expect(bar(page)).toHaveText(changed);
  expect(state.priceWrites).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("a save in flight is not asked about when leaving, the store stays put meanwhile, and its outcome shows when the vendor comes back from Publish", async ({ page }, testInfo) => {
  // From 640 px a Store defaults editor opens in place, so the bar and the rail stay in reach during a save.
  test.skip(testInfo.project.name === "mobile", "Below 640 px the editor is a sheet that covers the page's ways off.");
  const store = MARZ.storeConnectionId;
  const state = await openCatalog(page, `${CATALOG_PATH}/choose`, { liveSummary: true,
    listingSetups: { [store]: listingSetupWithAnotherShippingPolicy(store) } });
  const dialog = page.getByRole("alertdialog");
  const storeSelect = page.getByTestId("catalog-store-select");
  const shippingPick = policyEditor(page).locator("label")
    .filter({ has: page.getByText("USPS Priority Mail", { exact: true }) }).getByRole("radio");

  // Choose -> Listing settings -> Publish, then Back, so the browser's Forward returns to Publish.
  await page.getByRole("link", { name: "Next: Listing settings" }).click();
  await page.getByRole("link", { name: "Next: Publish" }).click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/publish`);
  await page.goBack();
  await expect(page).toHaveURL(`${CATALOG_PATH}/setup`);
  await page.getByTestId("store-default-row-shipping").getByRole("button", { name: "Change Shipping policy" }).click();
  await shippingPick.check();
  await expect(bar(page)).toHaveText("Not saved · 1 change in Shipping policy");

  // Forward to Publish is not caught; the rail's way back asks nothing and the change is there.
  await page.goForward();
  await expect(page).toHaveURL(`${CATALOG_PATH}/publish`);
  await step(page, "setup").click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/setup`);
  await expect(dialog).toHaveCount(0);
  await expect(bar(page)).toHaveText("Not saved · 1 change in Shipping policy");
  await expect(shippingPick).toBeChecked();

  // The save's answer is held, then lost (nobody can confirm it).
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/dropship/ebay/listing-setup/${store}`, async (route) => {
    if (route.request().method() === "PUT") await held;
    await route.fallback();
  });
  state.setupWriteAnswers = ["drop"];
  await policyEditor(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(bar(page)).toHaveText("Saving…");
  // Another store would drop the draft and the save's answer with it, so the picker waits.
  await expect(storeSelect).toBeDisabled();

  // A change being saved is not "unsaved": Next goes on at once and the save keeps going.
  await page.getByRole("link", { name: "Next: Publish" }).click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/publish`);
  await expect(dialog).toHaveCount(0);
  release();
  await expect(storeSelect).toBeEnabled();

  // Back on Listing settings the editor says what happened, with the change kept for Check again.
  await step(page, "setup").click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/setup`);
  await expect(dialog).toHaveCount(0);
  await expect(policyEditor(page)).toContainText("We couldn't confirm your save.");
  await expect(policyEditor(page).getByRole("button", { name: "Check again" })).toBeVisible();
  await expect(bar(page)).toHaveText("Not saved · 1 change in Shipping policy");
  expect(state.setupWrites).toEqual([{ method: "PUT", path: `/api/dropship/ebay/listing-setup/${store}`,
    body: { expectedRevision: SETUP_REVISION, idempotencyKey: expect.stringMatching(/^ls-policy:/), fulfillmentPolicyId: "priority" } }]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("closing the tab while a save is in flight still gets the browser's own question", async ({ page }) => {
  const store = MARZ.storeConnectionId;
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`,
    { listingSetups: { [store]: listingSetupWithAnotherShippingPolicy(store) } });
  const shippingPick = policyEditor(page).locator("label")
    .filter({ has: page.getByText("USPS Priority Mail", { exact: true }) }).getByRole("radio");
  await page.getByTestId("store-default-row-shipping").getByRole("button", { name: "Change Shipping policy" }).click();
  await shippingPick.check();
  await expect(bar(page)).toHaveText("Not saved · 1 change in Shipping policy");

  // The save is never answered, so it is still in flight when the tab closes.
  await page.route(`**/api/dropship/ebay/listing-setup/${store}`, async (route) => {
    if (route.request().method() === "PUT") return;
    await route.fallback();
  });
  await policyEditor(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(bar(page)).toHaveText("Saving…");
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);

  // Leaving the step keeps the save going, but closing the tab would lose its answer, so the browser asks.
  const asked = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const unload = await asked;
  expect(unload.type()).toBe("beforeunload");
  await unload.accept();
});

/** A policy in the open Shipping, Return or Payment editor, by its exact eBay name (the label also carries its fit line). */
function policyChoice(page: Page, name: string) {
  return policyEditor(page).locator("label").filter({ has: page.getByText(name, { exact: true }) }).getByRole("radio");
}

/** A Store defaults row of the step (`store-default-row-<field>`). */
function storeDefaultRow(page: Page, field: string) {
  return page.getByTestId(`store-default-row-${field}`);
}

/** The step's one connection banner (R:88). */
function stepBanner(page: Page) {
  return page.getByTestId("listing-settings-banner");
}

/** The step's title: "Listing settings for <store>" from 640 px, "Listing settings" on a phone (R:420). */
function stepTitle(testInfo: TestInfo, storeName: string) {
  return testInfo.project.name === "mobile" ? "Listing settings" : `Listing settings for ${storeName}`;
}

/**
 * The step's way to read the live setup again while nothing failed: [Check eBay again] in a policy editor (R:196), as
 * the older setup panel's Refresh options did. Opens the Return policy editor, presses it, waits for the read, cancels.
 */
async function checkEbayAgain(page: Page, state: StubState) {
  const reads = state.setupReads.length;
  await storeDefaultRow(page, "return").getByRole("button", { name: "Change Return policy" }).click();
  await policyEditor(page).getByRole("button", { name: "Check eBay again" }).click();
  await expect.poll(() => state.setupReads.length).toBe(reads + 1);
  await policyEditor(page).getByRole("button", { name: "Cancel" }).click();
  await expect(policyEditor(page)).toHaveCount(0);
}

/** "When is that?" names the store the settings are for when the vendor has more than one eBay store; read on every screen. */
async function expectSettingsFor(page: Page, storeName: string) {
  await page.getByRole("button", { name: "When is that?" }).click();
  await expect(page.getByTestId("listing-settings-timing-details")).toContainText(`These settings are for ${storeName} only. Each store has its own.`);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("listing-settings-timing-details")).toHaveCount(0);
}

test("discarding a change through the store picker opens the other store's own saved settings, and the change is gone back on the first store", async ({ page }) => {
  // Ported from the older pricing panel's journey (Listing settings PR 12, plan 6.5): the outlet saved a store price, Marz Cards has none.
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, { stores: [MARZ, OUTLET], liveSummary: true,
    pricingRules: { [OUTLET.storeConnectionId]: SAVED_PRICING_RULES } });
  const dialog = page.getByRole("alertdialog");
  const storeSelect = page.getByTestId("catalog-store-select");
  const price = storeDefaultRow(page, "price");
  const exactPrice = productDrawer(page).getByLabel("Exact price for Pack of 50 · ENV-SGL-P50", { exact: true });
  const openEnvelope = async () => {
    await page.getByTestId("listing-settings-product-11").getByRole("button", { name: new RegExp(`^${ENVELOPE.productName}`) }).click();
    await expect(productDrawer(page)).toBeVisible();
  };
  await expect(price.getByRole("button", { name: "Set price" })).toBeVisible();

  // A change on Marz Cards, kept by the browser's Back.
  await openEnvelope();
  await exactPrice.fill("9.99");
  await page.goBack();
  await expect(productDrawer(page)).toHaveCount(0);
  await expect(bar(page)).toHaveText(`Not saved · 1 change in ${ENVELOPE.productName}`);

  // The store picker asks first; Discard and leave opens the outlet's own saved settings, not this store's draft.
  await storeSelect.click();
  await page.getByRole("option", { name: "Marz Cards Outlet (eBay)" }).click();
  await expect(dialog).toContainText("You have 1 change that isn't saved.");
  await dialog.getByRole("button", { name: "Discard and leave" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(storeSelect).toHaveText("Marz Cards Outlet (eBay)");
  await expect(price).toContainText(/Retail( price)? \+ 15%, to the cent/);
  await expect(price.getByRole("button", { name: "Change Price" })).toBeVisible();
  await expect(bar(page)).toHaveText("All saved");
  await expect(page.getByText("Not saved", { exact: false })).toHaveCount(0);

  // Back on Marz Cards nothing asks, and the discarded change is gone.
  await storeSelect.click();
  await page.getByRole("option", { name: "Marz Cards (eBay)", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(storeSelect).toHaveText("Marz Cards (eBay)");
  await expect(price.getByRole("button", { name: "Set price" })).toBeVisible();
  await expect(bar(page)).toHaveText("All saved");
  await openEnvelope();
  await expect(exactPrice).toHaveValue("");
  expect(state.priceWrites).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("a shipping policy save refused because the policy doesn't fit Card Shellz shipping says so in plain words and keeps the pick; Check eBay again shows it can't be used", async ({ page }) => {
  // Ported from the older setup panel's journey (Listing settings PR 12, plan 6.5): the step's own words for this refusal.
  const loaded = listingSetupWithAnotherShippingPolicy(MARZ.storeConnectionId);
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, {
    listingSetups: { [MARZ.storeConnectionId]: loaded },
    // The policy fitted when the page loaded; the save's fresh check finds it no longer does.
    setupWriteAnswers: [{ status: 422, code: "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE",
      message: "The selected eBay fulfillment policy exceeds Card Shellz fulfillment capabilities.",
      context: { storeConnectionId: MARZ.storeConnectionId, fulfillmentPolicyId: "priority", issues: [HANDLING_TIME_ISSUE], retryable: false } }],
  });
  const shipping = storeDefaultRow(page, "shipping");
  await shipping.getByRole("button", { name: "Change Shipping policy" }).click();
  await policyChoice(page, "USPS Priority Mail").check();
  await policyEditor(page).getByRole("button", { name: "Save", exact: true }).click();

  // The vendor's words, never the staff-facing message or a code; the pick stays, not saved.
  await expect(policyEditor(page)).toContainText("This shipping policy doesn't work with Card Shellz shipping. Check eBay again, then pick another one.");
  await expect(policyEditor(page)).not.toContainText("exceeds Card Shellz fulfillment capabilities");
  await expect(policyEditor(page)).not.toContainText("DROPSHIP_");
  await expect(policyChoice(page, "USPS Priority Mail")).toBeChecked();
  await expect(bar(page)).toHaveText("Not saved · 1 change in Shipping policy");
  expect(state.setupWrites).toHaveLength(1);
  expect(state.listingSetups[MARZ.storeConnectionId]).toMatchObject({ revision: SETUP_REVISION });

  // The words' [Check eBay again] (R:196) reads the setup again: eBay's policy no longer fits, so the step shows why it
  // can't be used, won't let it be picked, and keeps Save off with the refused pick still in the draft.
  state.listingSetups[MARZ.storeConnectionId] = { ...loaded, options: { ...loaded.options, fulfillmentPolicies: [
    loaded.options.fulfillmentPolicies[0],
    { id: "priority", name: "USPS Priority Mail", compatible: false, compatibilityIssues: [HANDLING_TIME_ISSUE] }] } };
  const readsBefore = state.setupReads.length;
  await policyEditor(page).getByRole("button", { name: "Check eBay again" }).click();
  await expect.poll(() => state.setupReads.length).toBe(readsBefore + 1);
  await expect(policyEditor(page)).toContainText("✗ Can't use: handling time must be 1 business day or more");
  await expect(policyChoice(page, "USPS Priority Mail")).toBeDisabled();
  await expect(policyChoice(page, "USPS Priority Mail")).toBeChecked();
  await expect(bar(page)).toHaveText("Not saved · 1 change in Shipping policy");
  await expect(policyEditor(page).getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await policyEditor(page).getByRole("button", { name: "Cancel" }).click();
  await expect(policyEditor(page)).toHaveCount(0);
  await expect(bar(page)).toHaveText("All saved");
  await expect(shipping).toContainText("USPS Ground Advantage");
  expect(state.setupWrites).toHaveLength(1);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("a paused store's settings are read-only on Listing settings, and the rail says View only with nothing to retry; nothing is sent", async ({ page }) => {
  const setup = listingSetup(MARZ.storeConnectionId);
  const paused = { ...setup, access: { canEdit: false, reason: "store_paused" },
    checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } }, fulfillmentCapability: null,
    options: { merchantLocations: [], fulfillmentPolicies: [], returnPolicies: [], paymentPolicies: [] } };
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, { listingSetups: { [MARZ.storeConnectionId]: paused } });

  // The step's one banner says why (R:504); only support lifts a store pause.
  await expect(stepBanner(page)).toHaveCount(1);
  await expect(stepBanner(page)).toHaveAttribute("data-kind", "store_paused");
  await expect(stepBanner(page)).toContainText("Marz Cards is paused, so its settings can't be changed now.");
  // The rail says so too, with nothing to retry (review round 3, describeListingSettingsRail): the
  // unchecked answer is not an outage, and there is nothing the vendor can do here.
  await expect(step(page, "setup")).toContainText("View only");
  await expect(step(page, "setup")).toContainText("not known yet");
  await expect(step(page, "setup")).not.toContainText("All set");
  await expect(page.getByTestId("catalog-step-setup-action")).toHaveCount(0);
  // Nothing on the step can be changed (a store pause takes every right), and there is no ship-from repair.
  for (const field of ["price", "shipping", "return", "payment", "ebayCategory", "shelf", "description"]) {
    await expect(storeDefaultRow(page, field).getByRole("button", { name: /^(Change|Set) / })).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "Update now" })).toHaveCount(0);
  await expect(page.getByText("Card Shellz fulfillment capabilities", { exact: true })).toHaveCount(0);
  expect(state.setupWrites).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("remembers the chosen eBay store for this member, and never offers a store on another platform", async ({ page }, testInfo) => {
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, { stores: [SHOP, MARZ, OUTLET] });
  const storeSelect = page.getByTestId("catalog-store-select");
  const title = page.getByTestId("listing-settings-header").getByRole("heading", { level: 2 });

  // The first eBay store is used until the vendor chooses; the Shopify store listed first is skipped.
  await expect(storeSelect).toHaveText("Marz Cards (eBay)");
  await expect(title).toHaveText(stepTitle(testInfo, MARZ.name));
  await storeSelect.click();
  await expect(page.getByRole("option", { name: "Test Shop (Shopify) · Not supported yet" })).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("option", { name: "Marz Cards Outlet (eBay)" }).click();
  await expect(storeSelect).toHaveText("Marz Cards Outlet (eBay)");
  // The step is the outlet's: its title (from 640 px) and "When is that?" (every screen) name it.
  await expect(title).toHaveText(stepTitle(testInfo, OUTLET.name));
  await expectSettingsFor(page, OUTLET.name);
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("All saved");
  await expect.poll(() => state.setupReads.includes(9)).toBe(true);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), `dropship.catalog.store:${MEMBER_ID}`)).toBe("9");

  await page.reload();
  await expect(page).toHaveURL(`${CATALOG_PATH}/setup`);
  await expect(page.getByTestId("catalog-store-select")).toHaveText("Marz Cards Outlet (eBay)");
  // A reload opens the remembered store's step.
  await expect(title).toHaveText(stepTitle(testInfo, OUTLET.name));
  await expectSettingsFor(page, OUTLET.name);
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("All saved");
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("switching eBay stores on Listing settings and back shows one step, the chosen store's, and leaving afterwards asks nothing", async ({ page }) => {
  // React reports a key shared by two siblings as a console error. The older setup and policy panels
  // once shared the store id as their key, which left the previous store's panel mounted after a
  // switch; the step is keyed listing-settings-<id> (DropshipPortalCatalog), and this keeps it to one.
  const keyErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("same key")) keyErrors.push(message.text());
  });
  // The outlet saved another shipping policy, so each store's step shows which store it belongs to.
  const outlet = listingSetupWithAnotherShippingPolicy(OUTLET.storeConnectionId);
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, { stores: [MARZ, OUTLET], liveSummary: true, listingSetups: {
    [OUTLET.storeConnectionId]: { ...outlet, selection: { ...outlet.selection, fulfillmentPolicyId: "priority" } } } });
  const storeSelect = page.getByTestId("catalog-store-select");
  const steps = page.getByTestId("listing-settings-step");
  const shipping = storeDefaultRow(page, "shipping");
  const dialog = page.getByRole("alertdialog");

  await expect(steps).toHaveCount(1);
  await expect(shipping).toContainText("USPS Ground Advantage");

  // Marz Cards -> Marz Cards Outlet -> Marz Cards.
  for (const [store, shippingPolicy] of [[OUTLET, "USPS Priority Mail"], [MARZ, "USPS Ground Advantage"]] as const) {
    await storeSelect.click();
    await page.getByRole("option", { name: `${store.name} (eBay)`, exact: true }).click();
    // Nothing is unsaved, so the picker switches at once.
    await expect(storeSelect).toHaveText(`${store.name} (eBay)`);
    await expect(shipping).toContainText(shippingPolicy);
    await expect(page.getByTestId("catalog-action-summary")).toHaveText("All saved");
    await expect(dialog).toHaveCount(0);
    // The switch has rendered (the store's policy above), so these counts are settled: one step and one
    // Shipping row, the chosen store's. The previous store's are gone.
    await expect(steps).toHaveCount(1);
    await expect(shipping).toHaveCount(1);
    await expect(shipping).not.toContainText("Not saved");
  }

  // Nothing is unsaved in either store, so leaving the step asks nothing: not the Next button,
  // and not a step link.
  await page.getByRole("link", { name: "Next: Publish" }).click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/publish`);
  await expect(dialog).toHaveCount(0);
  await step(page, "setup").click();
  await expect(steps).toHaveCount(1);
  await expect(shipping).toContainText("USPS Ground Advantage");
  await step(page, "choose").click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/choose`);
  await expect(page.getByRole("heading", { name: "Available catalog" })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  expect(keyErrors).toEqual([]);
  expect(state.setupWrites).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("a vendor whose only store is on another platform is told so, and nothing asks eBay", async ({ page }) => {
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, { stores: [SHOP] });

  await expect(page.getByTestId("catalog-store-none")).toHaveText("No eBay store ready. Test Shop (Shopify): not supported yet.");
  await expect(step(page, "setup")).toContainText("No eBay store");
  await expect(page.getByTestId("listing-access-notice"))
    .toContainText("Connect your eBay store and finish its setup to set how your listings look.");
  await expect(page.getByRole("heading", { name: "eBay listing setup" })).toHaveCount(0);
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("No eBay store ready");
  expect(state.setupReads).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("the rail names what saved settings need, says Couldn't check when it can't read them, and Try again reads them again", async ({ page }, testInfo) => {
  const state = await openCatalog(page, `${CATALOG_PATH}/choose`, { summaryFailures: 1, summaries: {
    [MARZ.storeConnectionId]: listingSettingsSummary(MARZ.storeConnectionId, { state: "products_need_fix", productsNeedingFix: 2, missingPolicy: null }) } });
  const retry = page.getByTestId("catalog-step-setup-action");

  await expect(step(page, "setup")).toContainText("Couldn't check");
  await expect(step(page, "setup")).toContainText("not known yet");
  await expect(retry).toHaveText("Try again");
  await shot(page, testInfo, "catalog-rail-couldnt-check");
  await retry.click();
  await expect(step(page, "setup")).toContainText("2 products need a fix");
  await expect(step(page, "setup")).toContainText("not done yet");
  await expect(retry).toHaveCount(0);
  expect(state.summaryReads).toEqual([MARZ.storeConnectionId, MARZ.storeConnectionId]);
  expect(state.setupReads).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("the live eBay check on Listing settings keeps the rail from saying All set over a policy that no longer fits", async ({ page }) => {
  const setup = listingSetup(MARZ.storeConnectionId);
  const noLongerFits = { ...setup, complete: false, missingFields: ["fulfillmentPolicyCompatibility"],
    options: { ...setup.options, fulfillmentPolicies: [{ id: "ground", name: "USPS Ground Advantage", compatible: false,
      compatibilityIssues: [{ code: "handling_time_too_short", message: "Handling time must be 1 business day or more." }] }] } };
  const state = await openCatalog(page, `${CATALOG_PATH}/choose`, { listingSetups: { [MARZ.storeConnectionId]: noLongerFits } });

  // Saved settings alone look complete, and eBay has not been asked yet.
  await expect(step(page, "setup")).toContainText("All set");
  await step(page, "setup").click();
  // The step reads the live setup as it mounts.
  await expect(storeDefaultRow(page, "shipping")).toBeVisible();
  await expect(step(page, "setup")).toContainText("Choose a shipping policy");
  // Back on Choose, the rail keeps eBay's newest answer without asking again.
  await step(page, "choose").click();
  await expect(page.getByRole("heading", { name: "Available catalog" })).toBeVisible();
  await expect(step(page, "setup")).toContainText("Choose a shipping policy");
  expect(state.setupReads).toEqual([MARZ.storeConnectionId]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("the rail won't say All set over a live setup that couldn't check Card Shellz shipping, and Try again reads it again", async ({ page }) => {
  const setup = listingSetup(MARZ.storeConnectionId);
  const shippingUnavailable = withShippingNotChecked(setup, { status: "unavailable", kind: "temporary", reference: "browser-test-ship-check" });
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, { listingSetups: { [MARZ.storeConnectionId]: shippingUnavailable } });
  const retry = page.getByTestId("catalog-step-setup-action");
  const shipping = storeDefaultRow(page, "shipping");
  // The step's Shipping row says why it can't be changed now (the older panel's words, without its button's name).
  const notice = shipping.getByText("Can't check Card Shellz shipping right now. Try again in a few minutes.", { exact: true });

  // The saved settings look complete, but the live check found no problem only because it could
  // not check shipping, so the rail does not vouch for them.
  await expect(notice).toBeVisible();
  await expect(shipping.getByRole("button", { name: "Change Shipping policy" })).toHaveCount(0);
  await expect(step(page, "setup")).toContainText("Couldn't check");
  await expect(step(page, "setup")).not.toContainText("All set");
  await expect(retry).toHaveText("Try again");

  // Card Shellz shipping is back: Try again reads the summary and the live setup again.
  state.listingSetups[MARZ.storeConnectionId] = setup;
  await retry.click();
  await expect(step(page, "setup")).toContainText("All set");
  await expect(retry).toHaveCount(0);
  await expect(notice).toHaveCount(0);
  await expect(shipping.getByRole("button", { name: "Change Shipping policy" })).toBeVisible();
  expect(state.summaryReads).toEqual([MARZ.storeConnectionId, MARZ.storeConnectionId]);
  expect(state.setupReads).toEqual([MARZ.storeConnectionId, MARZ.storeConnectionId]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("while Card Shellz finishes shipping setup, the rail asks for a missing return policy first, then waits with nothing to retry, never asking for the shipping policy or ship-from location", async ({ page }) => {
  // eBay no longer lists the saved shipping or return policy, and where items ship from is out of
  // date; Card Shellz has not finished the store's shipping setup, so shipping can't be checked.
  const setup = listingSetupWithSavedShippingGone(MARZ.storeConnectionId);
  const finishing = withShippingNotChecked({ ...setup, missingFields: ["fulfillmentPolicyId", "returnPolicyId", "merchantLocationKey"],
    selection: { ...setup.selection, returnPolicyId: "returns-retired", merchantLocationKey: "old-warehouse" } },
  { status: "unavailable", kind: "setup_incomplete", reference: "browser-test-ship-setup" });
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, { listingSetups: { [MARZ.storeConnectionId]: finishing } });
  const retry = page.getByTestId("catalog-step-setup-action");
  const shipping = storeDefaultRow(page, "shipping");
  // The step's Shipping row says what the older setup panel said (R:503).
  const notice = shipping.getByText("Card Shellz is finishing shipping setup for your store. You can pick a shipping policy when it's done.", { exact: true });
  const repairNote = page.getByTestId("ship-from-repair-note");
  const update = repairNote.locator("button", { hasText: "Update now" });

  // The return policy is the vendor's to choose now, so the rail names it first (review round 4,
  // describeListingSettingsRail). The shipping policy and the ship-from repair wait on Card Shellz.
  await expect(notice).toBeVisible();
  await expect(shipping.getByRole("button", { name: "Change Shipping policy" })).toHaveCount(0);
  await expect(step(page, "setup")).toContainText("Choose a return policy");
  await expect(retry).toHaveCount(0);
  await expect(update).toHaveCount(0);
  expect(state.setupReads).toEqual([MARZ.storeConnectionId]);

  // The return policy is chosen in another window; Check eBay again reads it. What is left waits on Card Shellz, and a
  // retry would change nothing.
  state.listingSetups[MARZ.storeConnectionId] = { ...finishing, missingFields: ["fulfillmentPolicyId", "merchantLocationKey"],
    selection: { ...finishing.selection, returnPolicyId: "returns" } };
  await checkEbayAgain(page, state);
  await expect(step(page, "setup")).toContainText("Card Shellz is finishing setup");
  for (const line of ["Choose a shipping policy", "Ship-from location needs updating", "Couldn't check", "All set"]) {
    await expect(step(page, "setup")).not.toContainText(line);
  }
  await expect(notice).toBeVisible();
  await expect(retry).toHaveCount(0);
  await expect(update).toHaveCount(0);
  expect(state.setupReads).toEqual([MARZ.storeConnectionId, MARZ.storeConnectionId]);

  // Card Shellz has finished and the vendor picked a shipping policy elsewhere: shipping is checked,
  // so the ship-from line and the step's Update now show again, and the repair leaves nothing to do.
  state.listingSetups[MARZ.storeConnectionId] = { ...setup, missingFields: ["merchantLocationKey"],
    selection: { ...setup.selection, fulfillmentPolicyId: "priority", merchantLocationKey: "old-warehouse" } };
  await checkEbayAgain(page, state);
  await expect(step(page, "setup")).toContainText("Ship-from location needs updating");
  await expect(notice).toHaveCount(0);
  await expect(repairNote).toContainText("Card Shellz needs to update where your items ship from.");
  await update.click();
  await expect(repairNote).toContainText("Saved");
  await expect(step(page, "setup")).toContainText("All set");
  await expect(retry).toHaveCount(0);
  expect(state.setupWrites).toEqual([{ method: "POST",
    path: `/api/dropship/ebay/listing-setup/${MARZ.storeConnectionId}/ship-from/repair`,
    body: { expectedRevision: SETUP_REVISION, idempotencyKey: expect.stringMatching(/^ls-ship-from:[A-Za-z0-9-]+$/) } }]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("a store on an eBay site Card Shellz doesn't list on says Contact support in the rail, over a missing return policy and products that need a fix", async ({ page }) => {
  const setup = listingSetup(MARZ.storeConnectionId);
  const otherSite = withShippingNotChecked({ ...setup, missingFields: ["returnPolicyId"],
    selection: { ...setup.selection, returnPolicyId: "returns-retired" },
    options: { ...setup.options, returnPolicies: [...setup.options.returnPolicies, { id: "no-returns", name: "No returns" }] } },
  { status: "unavailable", kind: "marketplace_unsupported", reference: "browser-test-ship-site" });
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, {
    listingSetups: { [MARZ.storeConnectionId]: otherSite },
    summaries: { [MARZ.storeConnectionId]: listingSettingsSummary(MARZ.storeConnectionId,
      { state: "products_need_fix", productsNeedingFix: 2, missingPolicy: null }) } });

  // The step's one banner names the store (the older panel said "This store"), with Contact support.
  await expect(stepBanner(page)).toHaveCount(1);
  await expect(stepBanner(page)).toHaveAttribute("data-kind", "other_site");
  await expect(stepBanner(page)).toContainText("Card Shellz lists on eBay US only. Marz Cards is set up for another eBay site. Contact support.");
  // Card Shellz can't list on this eBay site at all, so the rail names the one thing that helps
  // (review round 4, describeListingSettingsRail), with nothing to retry.
  await expect(step(page, "setup")).toContainText("Contact support");
  for (const line of ["Choose a return policy", "2 products need a fix", "Couldn't check", "All set"]) {
    await expect(step(page, "setup")).not.toContainText(line);
  }
  await expect(page.getByTestId("catalog-step-setup-action")).toHaveCount(0);
  // Nothing on the step can be changed for this store.
  for (const field of ["shipping", "return", "payment"]) {
    await expect(storeDefaultRow(page, field).getByRole("button", { name: /^Change / })).toHaveCount(0);
  }
  expect(state.setupWrites).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("a live eBay check that fails on Listing settings keeps the rail from saying All set, Try again reads it again, and a later failed read does the same", async ({ page }) => {
  // eBay does not answer the first read. A second return policy lets the vendor save one later.
  const setup = listingSetup(MARZ.storeConnectionId);
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, { setupReadFailures: 1, listingSetups: { [MARZ.storeConnectionId]:
    { ...setup, options: { ...setup.options, returnPolicies: [...setup.options.returnPolicies, { id: "no-returns", name: "No returns" }] } } } });
  const retry = page.getByTestId("catalog-step-setup-action");
  const shipping = storeDefaultRow(page, "shipping");
  const reads = (count: number) => Array.from({ length: count }, () => MARZ.storeConnectionId);

  // The saved settings look complete, but nothing has checked them with eBay, so the rail does not
  // vouch for them (review round 3: a failed live read is an unchecked answer, DropshipPortalCatalog
  // liveSetup). The step shows its unreachable banner, and the rows that read eBay wait.
  await expect(stepBanner(page)).toHaveAttribute("data-kind", "unreachable");
  await expect(stepBanner(page)).toContainText("Can't reach eBay right now. Your saved settings still apply.");
  await expect(shipping).toContainText("Can't check eBay right now.");
  await expect(shipping.getByRole("button", { name: "Change Shipping policy" })).toHaveCount(0);
  await expect(step(page, "setup")).toContainText("Couldn't check");
  await expect(step(page, "setup")).not.toContainText("All set");
  await expect(retry).toHaveText("Try again");
  expect(state.setupReads).toEqual(reads(1));

  // The rail's Try again reads the live setup too, and the summary.
  const summaryReadsBefore = state.summaryReads.length;
  await retry.click();
  await expect(shipping.getByRole("button", { name: "Change Shipping policy" })).toBeVisible();
  await expect(stepBanner(page)).toHaveCount(0);
  await expect(step(page, "setup")).toContainText("All set");
  await expect(retry).toHaveCount(0);
  expect(state.setupReads).toEqual(reads(2));
  await expect.poll(() => state.summaryReads.length).toBeGreaterThan(summaryReadsBefore);

  // eBay stops answering later: a return-only save is confirmed, but its answer didn't check shipping, so the step
  // reads the setup again, and that read fails. The rail can't vouch for the settings either.
  state.setupReadFailures = 1;
  await storeDefaultRow(page, "return").getByRole("button", { name: "Change Return policy" }).click();
  await policyChoice(page, "No returns").check();
  await policyEditor(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.setupReads.length).toBe(3);
  await expect(stepBanner(page)).toHaveAttribute("data-kind", "unreachable");
  await expect(step(page, "setup")).toContainText("Couldn't check");
  await expect(step(page, "setup")).not.toContainText("All set");
  await expect(retry).toHaveText("Try again");
  expect(state.setupWrites).toEqual([{ method: "PUT", path: `/api/dropship/ebay/listing-setup/${MARZ.storeConnectionId}`,
    body: { expectedRevision: SETUP_REVISION, idempotencyKey: expect.stringMatching(/^ls-policy:[A-Za-z0-9-]+$/), returnPolicyId: "no-returns" } }]);

  // eBay is back: the banner's Try again reads the setup again (the rail's would too).
  await stepBanner(page).getByRole("button", { name: "Try again" }).click();
  await expect(stepBanner(page)).toHaveCount(0);
  await expect(step(page, "setup")).toContainText("All set");
  await expect(retry).toHaveCount(0);
  await expect(storeDefaultRow(page, "return")).toContainText("No returns");
  expect(state.setupReads).toEqual(reads(4));
  expect(state.setupWrites).toHaveLength(1);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});
