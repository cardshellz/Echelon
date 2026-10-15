import { expect, test, type Page } from "@playwright/test";
import type { CategoryListingSettingValues, ProductListingSettingValues } from "../../shared/dropship/listing-setting-values";
import type { ListingSettingsSummary } from "../../shared/dropship/listing-settings";
import { calculateRulePrice, type PricingRecipe } from "../../shared/dropship/pricing-rules";
import {
  ENVELOPE,
  LAYERED_SAMPLE,
  SAVED_PRICING_RULES,
  STUB_PRODUCT_CATALOG_HASH,
  TOPLOADERS,
  categoryKey,
  defaultStubState,
  listingSetup,
  listingSetupWithAnotherShippingPolicy,
  liveListingSettingsSummary,
  productKey,
  shot,
  sizeKey,
  type ProductFixture,
  type StoreShelfFixture,
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
  drawerSave,
  exactBox,
  expectInView,
  expectNoHorizontalScroll,
  expectNothingUnexpected,
  expectSheetLayout,
  failNextRead,
  openProductRow,
  openStep,
  phone,
} from "./dropship-policy-listing-settings-helpers";

// Playwright's serviceWorkers:block init script reads navigator.serviceWorker in
// every frame, which throws in an opaque sandbox. This local-only harness
// registers no workers.
test.use({ serviceWorkers: "allow" });

/**
 * The product drawer's setting rows (Listing settings PR 10, parts 10a and 10b; plan 4.9, 5.6): a
 * product's own shipping, return and payment policy (10a), and its eBay category, store shelf,
 * text above and below and main text (10b), are changed, or set back to the default, in the drawer
 * and saved through W5 from the product's own settings read; "Sizes differ" is fixed with one
 * button, and own text Card Shellz changed under is checked. Every save is checked against the
 * shared contract by the stub (ids and text only, compare-and-set on the product's revision,
 * keyed), and every journey ends with nothing unexpected asked and no page error. Desktop and phone.
 *
 * From 10d (plan 7.7) the product's price: [Change price] in the PRICE head, the check whose rows
 * replace the drawer's body (W7, every price the server's), and Save new prices; Use default; a
 * price another window saved before the check (D6a); Clear exact prices too and a size that would
 * lose its price; prices moved under the apply; page 2; a dropped apply; Back while unconfirmed; a check the server
 * dropped while its apply was unconfirmed; an apply refused for sizes that would lose their price.
 */

const PRODUCT_PATH = `${LISTINGS}/listing-settings/products/${ENVELOPE.productId}`;
const OWN_PATH = `${PRODUCT_PATH}/own`;

/** A product row with nothing of its own (the stored shape), for a journey to set one field on. */
const NO_VALUES: ProductListingSettingValues = {
  price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null,
  textAbove: null, textBelow: null, mainText: null,
};
const NO_CATEGORY_VALUES: CategoryListingSettingValues = {
  price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null,
  textAbove: null, textBelow: null,
};
const NO_RETURNS = { id: "no-returns", name: "No returns" };

/** The default setup with a second return policy, so a product can have its own. */
function setupWithTwoReturnPolicies() {
  const setup = listingSetup(STORE);
  return { ...setup, options: { ...setup.options, returnPolicies: [...setup.options.returnPolicies, NO_RETURNS] } };
}

/**
 * Product 11 with its own return policy, "No returns", at revision 7. A new object for each journey:
 * the stub saves into the map it is given, so a shared one would carry a save into the next journey.
 */
function ownNoReturns(): StubState["productSettings"] {
  return { [productKey(STORE, ENVELOPE.productId)]: { revisionId: 7, values: { ...NO_VALUES, returnPolicy: { ...NO_RETURNS } } } };
}

type PolicyRow = "shippingPolicy" | "returnPolicy" | "paymentPolicy";
type RowKey = PolicyRow | "ebayCategory" | "storeShelf" | "descriptionTemplate";
const ROW_SETTING: Record<RowKey, string> = {
  shippingPolicy: "shipping policy", returnPolicy: "return policy", paymentPolicy: "payment policy",
  ebayCategory: "eBay category", storeShelf: "store shelf", descriptionTemplate: "description",
};

function settingRow(page: Page, key: RowKey) {
  return drawer(page).getByTestId(`drawer-setting-${key}`);
}

function changeButton(page: Page, key: RowKey, productName = ENVELOPE.productName) {
  return settingRow(page, key).getByRole("button", { name: `Change ${ROW_SETTING[key]} for ${productName}`, exact: true });
}

/** A row's open editor: a policy's, the eBay category's, the shelf's, or the description's. */
function fieldEditor(page: Page, key: PolicyRow | "ebayCategory" | "storeShelf" | "description") {
  return drawer(page).getByTestId(`drawer-field-editor-${key}`);
}

/** One part of the open description editor: text above, the main text or text below. */
function descriptionPart(page: Page, part: "textAbove" | "mainText" | "textBelow") {
  return fieldEditor(page, "description").getByTestId(`drawer-description-${part}`);
}

function footer(page: Page) {
  return page.getByTestId("product-drawer-footer");
}

function bar(page: Page) {
  return page.getByTestId("catalog-action-summary");
}

/** A policy in the open field editor; its label also carries its Card Shellz fit line. */
function policyRadio(page: Page, key: PolicyRow, name: string) {
  return fieldEditor(page, key).getByRole("radio", { name: new RegExp(`^${name}`) });
}

/** Opens the field editor, picks a choice and puts it in the draft with Done. */
async function pick(page: Page, key: PolicyRow, name: string) {
  await changeButton(page, key).click();
  await expect(fieldEditor(page, key)).toBeVisible();
  await policyRadio(page, key, name).check();
  await fieldEditor(page, key).getByRole("button", { name: "Done" }).click();
  await expect(fieldEditor(page, key)).toHaveCount(0);
}

/** The reads after the n-th request, by method and path. */
function readsAfter(state: StubState, index: number, method: string, path: string) {
  return state.reads.slice(index + 1).filter((read) => read.method === method && read.path === path).length;
}

const BUSY = "DROPSHIP_LISTING_SETTINGS_BUSY";

test("a product's shipping policy is picked in the drawer, saved with its id alone against the read it showed, and read again", async ({ page }, testInfo) => {
  const state = await openStep(page, { listingSetups: { [STORE]: listingSetupWithAnotherShippingPolicy(STORE) } }, `${SETUP_PATH}?product=11`);
  await expect(drawer(page)).toBeVisible();
  await expect(settingRow(page, "shippingPolicy")).toContainText("USPS Ground Advantage");
  await expect(settingRow(page, "shippingPolicy")).toContainText("Store default");
  // Every policy row can be changed; each [Change] names the product.
  for (const key of ["shippingPolicy", "returnPolicy", "paymentPolicy"] as const) await expect(changeButton(page, key)).toBeEnabled();

  // Esc closes the field editor, not the drawer, and focus goes back to its Change (plan 3.4).
  await changeButton(page, "shippingPolicy").click();
  await expect(fieldEditor(page, "shippingPolicy").getByRole("radio", { name: "Use default" })).toBeFocused();
  await expect(fieldEditor(page, "shippingPolicy")).toContainText("✓ Works with Card Shellz shipping");
  await page.keyboard.press("Escape");
  await expect(fieldEditor(page, "shippingPolicy")).toHaveCount(0);
  await expect(drawer(page)).toBeVisible();
  await expect(changeButton(page, "shippingPolicy")).toBeFocused();
  await expect(bar(page)).toHaveText("All saved");

  // Done on what the product has already changes nothing: no draft opens, and focus goes back to Change.
  await changeButton(page, "shippingPolicy").click();
  await expect(changeButton(page, "shippingPolicy")).toHaveAttribute("aria-expanded", "true");
  await fieldEditor(page, "shippingPolicy").getByRole("button", { name: "Done" }).click();
  await expect(fieldEditor(page, "shippingPolicy")).toHaveCount(0);
  await expect(changeButton(page, "shippingPolicy")).toBeFocused();
  await expect(footer(page)).not.toContainText("Not saved");
  await expect(bar(page)).toHaveText("All saved");
  // Change pressed again closes its editor, as its aria-expanded says.
  await changeButton(page, "shippingPolicy").click();
  await expect(fieldEditor(page, "shippingPolicy")).toBeVisible();
  await changeButton(page, "shippingPolicy").click();
  await expect(fieldEditor(page, "shippingPolicy")).toHaveCount(0);
  await expect(changeButton(page, "shippingPolicy")).toHaveAttribute("aria-expanded", "false");

  await pick(page, "shippingPolicy", "USPS Priority Mail");
  await expect(changeButton(page, "shippingPolicy")).toBeFocused();
  await expect(settingRow(page, "shippingPolicy")).toContainText("→ USPS Priority Mail · Not saved");
  await expect(footer(page)).toContainText(phone(testInfo) ? "● Not saved · 1" : "● Not saved · 1 change");
  await expect(bar(page)).toHaveText(`Not saved · 1 change in ${ENVELOPE.productName}`);
  await shot(page, testInfo, "listing-settings-drawer-policy");

  await drawerSave(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.productSettingsWrites).toEqual([{ method: "PUT", path: PRODUCT_PATH,
    body: { idempotencyKey: KEY("ls-product"), expectedRevisionId: null, patch: { shippingPolicy: { id: "priority" } } } }]);
  // D9: the product and its own settings are read again after the PUT; its answer is not shown.
  const putAt = state.reads.findIndex((read) => read.method === "PUT" && read.path === PRODUCT_PATH);
  await expect.poll(() => readsAfter(state, putAt, "GET", PRODUCT_PATH)).toBeGreaterThanOrEqual(1);
  await expect.poll(() => readsAfter(state, putAt, "GET", OWN_PATH)).toBeGreaterThanOrEqual(1);
  await expect(settingRow(page, "shippingPolicy")).toContainText("USPS Priority Mail");
  await expect(settingRow(page, "shippingPolicy")).toContainText("Set for this product");
  await expect(settingRow(page, "shippingPolicy")).not.toContainText("Not saved");
  await expect(bar(page)).toHaveText("All saved");
  expect(state.productSettings[productKey(STORE, ENVELOPE.productId)].values.shippingPolicy).toEqual({ id: "priority", name: "USPS Priority Mail" });

  // The next change starts from the saved revision, with a new key.
  await pick(page, "paymentPolicy", "Managed payments");
  await expect(settingRow(page, "paymentPolicy")).toContainText("→ Managed payments · Not saved");
  await drawerSave(page).click();
  await expect.poll(() => state.productSettingsWrites.length).toBe(2);
  const savedRevision = state.productSettingsWrites[1].body.expectedRevisionId;
  expect(savedRevision).toEqual(expect.any(Number));
  expect(state.productSettingsWrites[1].body).toEqual({ idempotencyKey: KEY("ls-product"), expectedRevisionId: savedRevision,
    patch: { paymentPolicy: { id: "payments" } } });
  expect(state.productSettingsWrites[1].body.idempotencyKey).not.toBe(state.productSettingsWrites[0].body.idempotencyKey);
  await expect(footer(page)).toContainText("Saved");
  // No row shows an id.
  await expect(drawer(page)).not.toContainText("priority");
  expectNothingUnexpected(state);
});

test("Use default sets a product's own return policy back, sent as null, and the row then reads Store default", async ({ page }) => {
  const state = await openStep(page, { listingSetups: { [STORE]: setupWithTwoReturnPolicies() }, productSettings: ownNoReturns() },
    `${SETUP_PATH}?product=11`);
  await expect(settingRow(page, "returnPolicy")).toContainText("No returns");
  await expect(settingRow(page, "returnPolicy")).toContainText("Set for this product");

  await changeButton(page, "returnPolicy").click();
  // The editor opens on the product's own policy.
  await expect(policyRadio(page, "returnPolicy", "No returns")).toBeChecked();
  await fieldEditor(page, "returnPolicy").getByRole("radio", { name: "Use default" }).check();
  await fieldEditor(page, "returnPolicy").getByRole("button", { name: "Done" }).click();
  await expect(settingRow(page, "returnPolicy")).toContainText("→ Use default · Not saved");

  await drawerSave(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.productSettingsWrites).toEqual([{ method: "PUT", path: PRODUCT_PATH,
    body: { idempotencyKey: KEY("ls-product"), expectedRevisionId: 7, patch: { returnPolicy: null } } }]);
  expect(state.productSettingsWrites[0].body.patch).toHaveProperty("returnPolicy", null);
  await expect(settingRow(page, "returnPolicy")).toContainText("30-day returns");
  await expect(settingRow(page, "returnPolicy")).toContainText("Store default");
  await expect(settingRow(page, "returnPolicy")).not.toContainText("Set for this product");
  expectNothingUnexpected(state);
});

test("a value its Card Shellz category sets reads From category: Sleeves, and no row shows an id", async ({ page }) => {
  const state = await openStep(page, {
    catalog: [ENVELOPE, LAYERED_SAMPLE],
    listingSetups: { [STORE]: setupWithTwoReturnPolicies() },
    categorySettings: { [categoryKey(STORE, LAYERED_SAMPLE.categoryId as number)]: { revisionId: 8, values: { ...NO_CATEGORY_VALUES, returnPolicy: NO_RETURNS } } },
  }, `${SETUP_PATH}?product=${LAYERED_SAMPLE.productId}`);
  await expect(settingRow(page, "returnPolicy")).toContainText("No returns");
  await expect(settingRow(page, "returnPolicy")).toContainText("From category: Sleeves");
  await expect(settingRow(page, "shippingPolicy")).toContainText("Store default");
  await expect(settingRow(page, "shippingPolicy")).not.toContainText("From category");
  await expect(changeButton(page, "returnPolicy", LAYERED_SAMPLE.productName)).toBeEnabled();
  await expect(drawer(page)).not.toContainText("no-returns");
  await expect(drawer(page)).not.toContainText("ground");
  expectNothingUnexpected(state);
});

test("a save whose answer was lost is checked again with the same key and body, and the replay reads Saved", async ({ page }) => {
  const state = await openStep(page, { listingSetups: { [STORE]: listingSetupWithAnotherShippingPolicy(STORE) },
    productSettingsWriteAnswers: ["drop"] }, `${SETUP_PATH}?product=11`);
  await pick(page, "shippingPolicy", "USPS Priority Mail");
  await drawerSave(page).click();
  await expect(footer(page)).toContainText("We couldn't confirm your save.");
  // Locked until it is checked: nothing in the row can change, and Discard is off.
  await expect(changeButton(page, "shippingPolicy")).toBeDisabled();
  await expect(footer(page).getByRole("button", { name: "Discard" })).toBeDisabled();
  // Esc keeps the drawer open while nobody could confirm the save (plan 3.4).
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toBeVisible();
  await expect(footer(page)).toContainText("We couldn't confirm your save.");
  await footer(page).getByRole("button", { name: "Check again" }).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.productSettingsWrites).toHaveLength(2);
  expect(state.productSettingsWrites[1].body).toEqual(state.productSettingsWrites[0].body);
  expect(state.productSettingsWrites[0].body).toEqual({ idempotencyKey: KEY("ls-product"), expectedRevisionId: null, patch: { shippingPolicy: { id: "priority" } } });
  await expect(settingRow(page, "shippingPolicy")).toContainText("Set for this product");
  expectNothingUnexpected(state);
});

test("a save refused because another window saved keeps the pick, and Load latest marks the field both changed", async ({ page }) => {
  const state = await openStep(page, { listingSetups: { [STORE]: listingSetupWithAnotherShippingPolicy(STORE) } }, `${SETUP_PATH}?product=11`);
  await pick(page, "shippingPolicy", "USPS Priority Mail");
  // Another window saves this product's shipping policy after the drawer read it.
  state.productSettings[productKey(STORE, ENVELOPE.productId)] = { revisionId: 60,
    values: { ...NO_VALUES, shippingPolicy: { id: "ground", name: "USPS Ground Advantage" } } };
  await drawerSave(page).click();
  await expect(footer(page)).toContainText("This changed in another window.");
  // The first Load latest can't read the product's own settings: it says so, and the conflict stays to try again.
  let loading = true;
  await failNextRead(page, OWN_PATH, () => loading);
  await footer(page).getByRole("button", { name: "Load latest and keep my changes" }).click();
  await expect(footer(page)).toContainText("Couldn't load the latest view.");
  loading = false;
  await expect(settingRow(page, "shippingPolicy")).toContainText("→ USPS Priority Mail · Not saved");
  await footer(page).getByRole("button", { name: "Load latest and keep my changes" }).click();
  await expect(footer(page)).toContainText("Here's what's saved now. Your changes are on top; fields you both changed are marked.");
  await expect(settingRow(page, "shippingPolicy")).toContainText("Set for this product");
  await expect(settingRow(page, "shippingPolicy")).toContainText("→ USPS Priority Mail · Not saved");
  await expect(settingRow(page, "shippingPolicy")).toContainText("Changed in another window too");

  await drawerSave(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.productSettingsWrites).toHaveLength(2);
  expect(state.productSettingsWrites[1].body).toEqual({ idempotencyKey: KEY("ls-product"), expectedRevisionId: 60, patch: { shippingPolicy: { id: "priority" } } });
  expect(state.productSettingsWrites[1].body.idempotencyKey).not.toBe(state.productSettingsWrites[0].body.idempotencyKey);
  expectNothingUnexpected(state);
});

test("a save whose views can't be read again still counts, and Reload reads them and clears the draft", async ({ page }) => {
  const state = await openStep(page, { listingSetups: { [STORE]: listingSetupWithAnotherShippingPolicy(STORE) } }, `${SETUP_PATH}?product=11`);
  await pick(page, "shippingPolicy", "USPS Priority Mail");
  // The product's own settings, read again right after the PUT, fail once.
  await failNextRead(page, OWN_PATH, () => state.productSettingsWrites.length > 0);
  await drawerSave(page).click();
  await expect(footer(page)).toContainText("Saved. We couldn't load the latest view.");
  expect(state.productSettingsWrites).toHaveLength(1);
  const reload = footer(page).getByRole("button", { name: "Reload" });
  await expect(reload).toBeEnabled();
  const before = state.reads.length - 1;
  await reload.click();
  await expect(footer(page)).not.toContainText("Saved. We couldn't load the latest view.");
  await expect(footer(page).getByRole("button", { name: "Reload" })).toHaveCount(0);
  await expect.poll(() => readsAfter(state, before, "GET", OWN_PATH)).toBeGreaterThanOrEqual(1);
  await expect.poll(() => readsAfter(state, before, "GET", PRODUCT_PATH)).toBeGreaterThanOrEqual(1);
  await expect(settingRow(page, "shippingPolicy")).toContainText("USPS Priority Mail");
  await expect(settingRow(page, "shippingPolicy")).toContainText("Set for this product");
  await expect(settingRow(page, "shippingPolicy")).not.toContainText("Not saved");
  await expect(bar(page)).toHaveText("All saved");
  // Reads only: nothing more was sent.
  expect(state.productSettingsWrites).toHaveLength(1);
  expectNothingUnexpected(state);
});

test("Use default on a product whose size still sets its own policy sends null, which clears the size's leftover", async ({ page }) => {
  const product = LAYERED_SAMPLE;
  const state = await openStep(page, {
    catalog: [ENVELOPE, product],
    listingSetups: { [STORE]: listingSetupWithAnotherShippingPolicy(STORE) },
    // Today's per-size settings left "USPS Priority Mail" on the Pack of 500; the product has nothing of its own.
    sizeLeftovers: { [sizeKey(STORE, 302)]: { shippingPolicyId: "priority" } },
  }, `${SETUP_PATH}?product=${product.productId}`);
  await expect(settingRow(page, "shippingPolicy")).toContainText("USPS Priority Mail");
  await expect(settingRow(page, "shippingPolicy")).toContainText("Set on this size");
  await expect(settingRow(page, "shippingPolicy")).toContainText("Store default");

  await changeButton(page, "shippingPolicy", product.productName).click();
  // The row reads otherwise than the product's own (none): nothing is picked, so Done waits for a pick.
  await expect(fieldEditor(page, "shippingPolicy").getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(fieldEditor(page, "shippingPolicy").getByRole("button", { name: "Done" })).toBeDisabled();
  await fieldEditor(page, "shippingPolicy").getByRole("radio", { name: "Use default" }).check();
  await fieldEditor(page, "shippingPolicy").getByRole("button", { name: "Done" }).click();
  await expect(settingRow(page, "shippingPolicy")).toContainText("→ Use default · Not saved");
  await expect(bar(page)).toHaveText(`Not saved · 1 change in ${product.productName}`);

  await drawerSave(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.productSettingsWrites).toEqual([{ method: "PUT", path: `${LISTINGS}/listing-settings/products/${product.productId}`,
    body: { idempotencyKey: KEY("ls-product"), expectedRevisionId: null, patch: { shippingPolicy: null } } }]);
  expect(state.sizeLeftovers[sizeKey(STORE, 302)]).toEqual({});
  await expect(settingRow(page, "shippingPolicy")).toContainText("USPS Ground Advantage");
  await expect(settingRow(page, "shippingPolicy")).not.toContainText("Set on this size");
  await expect(settingRow(page, "shippingPolicy")).not.toContainText("USPS Priority Mail");
  expectNothingUnexpected(state);
});

test("another big change saving refuses with nothing saved, and Save again sends the same key", async ({ page }) => {
  const busy: WriteAnswer = { status: 503, code: BUSY, message: "Listing settings are busy. Try again.", context: { reason: "heavy_write_in_progress" } };
  const state = await openStep(page, { productSettings: ownNoReturns(), listingSetups: { [STORE]: setupWithTwoReturnPolicies() },
    productSettingsWriteAnswers: [busy] }, `${SETUP_PATH}?product=11`);
  await pick(page, "returnPolicy", "30-day returns");
  await drawerSave(page).click();
  await expect(footer(page)).toContainText("Another big change is saving. Nothing was saved. Try again in a few seconds.");
  // Not locked: the change can still be edited, and Save sends it again.
  await expect(changeButton(page, "returnPolicy")).toBeEnabled();
  await drawerSave(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.productSettingsWrites).toHaveLength(2);
  expect(state.productSettingsWrites[1].body).toEqual(state.productSettingsWrites[0].body);
  expect(state.productSettingsWrites[0].body).toEqual({ idempotencyKey: KEY("ls-product"), expectedRevisionId: 7, patch: { returnPolicy: { id: "returns" } } });
  expectNothingUnexpected(state);
});

test("a busy answer that names no reason may have saved: we couldn't confirm, and Check again sends the same request", async ({ page }) => {
  const busy: WriteAnswer = { status: 503, code: BUSY, message: "Listing settings are busy. Try again." };
  const state = await openStep(page, { productSettings: ownNoReturns(), listingSetups: { [STORE]: setupWithTwoReturnPolicies() },
    productSettingsWriteAnswers: [busy] }, `${SETUP_PATH}?product=11`);
  await pick(page, "returnPolicy", "30-day returns");
  await drawerSave(page).click();
  await expect(footer(page)).toContainText("We couldn't confirm your save.");
  await expect(footer(page)).not.toContainText("Nothing was saved");
  await expect(changeButton(page, "returnPolicy")).toBeDisabled();
  await footer(page).getByRole("button", { name: "Check again" }).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.productSettingsWrites).toHaveLength(2);
  expect(state.productSettingsWrites[1].body).toEqual(state.productSettingsWrites[0].body);
  expectNothingUnexpected(state);
});

test("too many saves in a minute keeps the change and its key", async ({ page }) => {
  const state = await openStep(page, { productSettings: ownNoReturns(), listingSetups: { [STORE]: setupWithTwoReturnPolicies() },
    productSettingsWriteAnswers: [{ status: 429, code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED", message: "Too many listing settings saves." }] },
  `${SETUP_PATH}?product=11`);
  await pick(page, "returnPolicy", "30-day returns");
  await drawerSave(page).click();
  await expect(footer(page)).toContainText("Too many saves in a minute. Wait a moment and try again.");
  await expect(settingRow(page, "returnPolicy")).toContainText("→ 30-day returns · Not saved");
  await expect(bar(page)).toHaveText(`Not saved · 1 change in ${ENVELOPE.productName}`);
  await drawerSave(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.productSettingsWrites).toHaveLength(2);
  expect(state.productSettingsWrites[1].body.idempotencyKey).toBe(state.productSettingsWrites[0].body.idempotencyKey);
  expectNothingUnexpected(state);
});

test("while eBay needs a sign-in, a policy row offers only Use default, and that still saves (D4)", async ({ page }) => {
  const state = await openStep(page, { productSettings: ownNoReturns(),
    setupReadError: { status: 403, code: "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED", message: "eBay needs the store to be connected again.",
      context: { storeConnectionId: STORE, retryable: false } } }, `${SETUP_PATH}?product=11`);
  await expect(banner(page)).toHaveAttribute("data-kind", "sign_in");
  // eBay can't be read: the product's own policy reads by the name it stored (G2).
  await expect(settingRow(page, "returnPolicy")).toContainText("No returns");
  await expect(settingRow(page, "returnPolicy")).toContainText("Sign in to eBay again to pick a new one. You can still use the default.");
  await changeButton(page, "returnPolicy").click();
  await expect(fieldEditor(page, "returnPolicy").getByRole("radio")).toHaveCount(1);
  await fieldEditor(page, "returnPolicy").getByRole("radio", { name: "Use default" }).check();
  await fieldEditor(page, "returnPolicy").getByRole("button", { name: "Done" }).click();
  await expect(settingRow(page, "returnPolicy")).toContainText("→ Use default · Not saved");
  await drawerSave(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.productSettingsWrites).toEqual([{ method: "PUT", path: PRODUCT_PATH,
    body: { idempotencyKey: KEY("ls-product"), expectedRevisionId: 7, patch: { returnPolicy: null } } }]);
  expect(state.setupWrites).toEqual([]);
  expectNothingUnexpected(state);
});

test("a size's price and a setting can't be saved together: each waits for the other (D2)", async ({ page }) => {
  const state = await openStep(page, {}, `${SETUP_PATH}?product=11&size=101`);
  const box = exactBox(page, "Pack of 50 · ENV-SGL-P50");
  await expect(box).toBeFocused();
  await box.fill("9.99");
  for (const key of ["shippingPolicy", "returnPolicy", "paymentPolicy"] as const) await expect(changeButton(page, key)).toBeDisabled();
  await expect(settingRow(page, "returnPolicy")).toContainText("Save or discard your other change first.");

  await footer(page).getByRole("button", { name: "Discard" }).click();

  // A size's price typed while a field editor is open: Save waits for Done or Cancel, and says so.
  await changeButton(page, "shippingPolicy").click();
  await expect(fieldEditor(page, "shippingPolicy")).toBeVisible();
  await box.fill("8.99");
  await expect(footer(page)).toContainText("Press Done or Cancel first.");
  await expect(drawerSave(page)).toBeDisabled();
  // Cancel: its Change is off now (the price waits), so focus goes to the row, never to the page (plan 3.4).
  await fieldEditor(page, "shippingPolicy").getByRole("button", { name: "Cancel" }).click();
  await expect(fieldEditor(page, "shippingPolicy")).toHaveCount(0);
  await expect(settingRow(page, "shippingPolicy")).toBeFocused();
  await expect(footer(page)).not.toContainText("Press Done or Cancel first.");
  await expect(drawerSave(page)).toBeEnabled();
  await footer(page).getByRole("button", { name: "Discard" }).click();

  await expect(changeButton(page, "returnPolicy")).toBeEnabled();
  await pick(page, "returnPolicy", "30-day returns");
  await expect(settingRow(page, "returnPolicy")).toContainText("→ 30-day returns · Not saved");
  await expect(box).toHaveAttribute("aria-readonly", "true");
  await expect(drawer(page).getByTestId("drawer-price-section")).toContainText("Save or discard your other change first.");

  await drawerSave(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.productSettingsWrites).toEqual([{ method: "PUT", path: PRODUCT_PATH,
    body: { idempotencyKey: KEY("ls-product"), expectedRevisionId: null, patch: { returnPolicy: { id: "returns" } } } }]);
  expect(state.priceWrites).toEqual([]);
  // Saved: the size's price can be typed again.
  await expect(box).not.toHaveAttribute("aria-readonly", "true");
  expectNothingUnexpected(state);
});

test("on a phone the drawer fills the screen, a field editor opens inside it, and Save stays in view with no sideways scroll", async ({ page }, testInfo) => {
  test.skip(!phone(testInfo), "The phone layout (below 640 px) only.");
  const state = await openStep(page, { listingSetups: { [STORE]: listingSetupWithAnotherShippingPolicy(STORE) } }, `${SETUP_PATH}?product=11`);
  await expectSheetLayout(page, testInfo, drawer(page));
  await changeButton(page, "shippingPolicy").click();
  await expect(fieldEditor(page, "shippingPolicy")).toBeVisible();
  // Inline in the drawer: no second sheet opens over it (D20).
  await expect(page.getByTestId("editor-surface")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await policyRadio(page, "shippingPolicy", "USPS Priority Mail").check();
  await fieldEditor(page, "shippingPolicy").getByRole("button", { name: "Done" }).click();
  await expect(footer(page)).toContainText("● Not saved · 1");
  await expect(drawerSave(page)).toHaveText("Save");
  await expectInView(page, drawerSave(page));
  await expectNoHorizontalScroll(page);
  await shot(page, testInfo, "listing-settings-drawer-policy-phone");
  await drawerSave(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.productSettingsWrites).toHaveLength(1);
  expectNothingUnexpected(state);
});

// ---------------------------------------------------------------------------
// 10b: the eBay category, store shelf, "Sizes differ" and the description (plan 5.6)
// ---------------------------------------------------------------------------

/** Product 11 with these values of its own at revision 7 (a new object for each journey, as ownNoReturns). */
function ownValues(values: Partial<ProductListingSettingValues>): StubState["productSettings"] {
  return { [productKey(STORE, ENVELOPE.productId)]: { revisionId: 7, values: { ...NO_VALUES, ...values } } };
}

/** Two of the store's eBay shelves (`GET /api/dropship/ebay/store-categories/:id`), named by eBay's path. */
function twoShelves(): Record<number, StoreShelfFixture[]> {
  return { [STORE]: [
    { categoryId: "11", categoryName: "Sleeves", path: "Supplies:Sleeves", level: 2 },
    { categoryId: "12", categoryName: "Sale", path: "Sale", level: 1 },
  ] };
}

test("the eBay category is picked from eBay's own list in the drawer and saved by its number alone, which never shows", async ({ page }) => {
  const state = await openStep(page, {}, `${SETUP_PATH}?product=11`);
  await expect(settingRow(page, "ebayCategory")).toContainText("Card Sleeves");
  await expect(settingRow(page, "ebayCategory")).toContainText("Card Shellz picks");

  await changeButton(page, "ebayCategory").click();
  const editor = fieldEditor(page, "ebayCategory");
  // The product has none of its own: the editor opens on Use default, focused (plan 3.4).
  await expect(editor.getByRole("radio", { name: "Use default" })).toBeFocused();
  await editor.getByRole("button", { name: "Pick an eBay category" }).click();
  const search = editor.getByRole("textbox", { name: "Search eBay categories" });
  await expect(search).toBeFocused();
  await search.fill("Toploaders");
  await editor.getByRole("button", { name: "Use this category" }).click();
  // The pick is the product's own category now, focused, by name only.
  await expect(editor.getByRole("radio", { name: TOPLOADERS.categoryName })).toBeChecked();
  await expect(editor.getByRole("radio", { name: TOPLOADERS.categoryName })).toBeFocused();
  await expect(editor).not.toContainText(TOPLOADERS.categoryId);
  await editor.getByRole("button", { name: "Done" }).click();
  await expect(changeButton(page, "ebayCategory")).toBeFocused();
  await expect(settingRow(page, "ebayCategory")).toContainText("→ Toploaders · Not saved");
  await expect(bar(page)).toHaveText(`Not saved · 1 change in ${ENVELOPE.productName}`);

  await drawerSave(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.productSettingsWrites).toEqual([{ method: "PUT", path: PRODUCT_PATH,
    body: { idempotencyKey: KEY("ls-product"), expectedRevisionId: null, patch: { ebayCategory: { categoryId: TOPLOADERS.categoryId } } } }]);
  expect(state.categorySearches).toContain("Toploaders");
  await expect(settingRow(page, "ebayCategory")).toContainText("Toploaders");
  await expect(settingRow(page, "ebayCategory")).toContainText("Set for this product");
  await expect(drawer(page)).not.toContainText(TOPLOADERS.categoryId);
  expectNothingUnexpected(state);
});

test("two store shelves are picked for a product, first and second, saved by id, and the row then names both", async ({ page }, testInfo) => {
  const state = await openStep(page, { storeShelves: twoShelves() }, `${SETUP_PATH}?product=11`);
  await expect(settingRow(page, "storeShelf")).toContainText("None");
  await changeButton(page, "storeShelf").click();
  const editor = fieldEditor(page, "storeShelf");
  await expect(editor.getByRole("radio", { name: "Use default" })).toBeChecked();
  await editor.getByRole("combobox", { name: `Shelf for ${ENVELOPE.productName}` }).click();
  await page.getByRole("option", { name: "Supplies › Sleeves", exact: true }).click();
  // The first box's list has closed before the second opens.
  await expect(page.getByRole("option")).toHaveCount(0);
  // Picking a shelf chooses "Own shelves"; the second box opens once a first is picked.
  await expect(editor.getByRole("radio", { name: "Own shelves" })).toBeChecked();
  await editor.getByRole("combobox", { name: `Second shelf (optional) for ${ENVELOPE.productName}` }).click();
  await page.getByRole("option", { name: "Sale", exact: true }).click();
  await expect(page.getByRole("option")).toHaveCount(0);
  await expect(editor).not.toContainText("Store category");
  if (phone(testInfo)) await expectNoHorizontalScroll(page);
  await editor.getByRole("button", { name: "Done" }).click();
  await expect(settingRow(page, "storeShelf")).toContainText("→ Supplies › Sleeves · second: Sale · Not saved");

  await drawerSave(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.productSettingsWrites).toEqual([{ method: "PUT", path: PRODUCT_PATH,
    body: { idempotencyKey: KEY("ls-product"), expectedRevisionId: null, patch: { storeShelf: { mode: "own", shelfIds: ["11", "12"] } } } }]);
  await expect(settingRow(page, "storeShelf")).toContainText("Supplies › Sleeves · second: Sale");
  await expect(settingRow(page, "storeShelf")).toContainText("Set for this product");
  await expect(settingRow(page, "storeShelf")).not.toContainText("Not saved");
  expectNothingUnexpected(state);
});

test("sizes that differ get Use default for all sizes, which sends one null and gives every size the default", async ({ page }) => {
  const product = LAYERED_SAMPLE;
  const state = await openStep(page, {
    catalog: [ENVELOPE, product],
    listingSetups: { [STORE]: listingSetupWithAnotherShippingPolicy(STORE) },
    // Today's per-size settings left "USPS Priority Mail" on the Pack of 500; the product has nothing of its own.
    sizeLeftovers: { [sizeKey(STORE, 302)]: { shippingPolicyId: "priority" } },
  }, `${SETUP_PATH}?product=${product.productId}`);
  const row = settingRow(page, "shippingPolicy");
  await expect(row).toContainText("Sizes differ. Pick one for all sizes.");
  // One button beside each value, read out with the value and the product (plan 3.4, 5.3).
  await expect(row.getByRole("button", { name: `Use USPS Priority Mail for all sizes of ${product.productName}` })).toHaveText("Use for all sizes");
  await row.getByRole("button", { name: `Use default for all sizes of ${product.productName}` }).click();
  await expect(row).toContainText("→ Use default · Not saved");
  await expect(bar(page)).toHaveText(`Not saved · 1 change in ${product.productName}`);

  await drawerSave(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.productSettingsWrites).toEqual([{ method: "PUT", path: `${LISTINGS}/listing-settings/products/${product.productId}`,
    body: { idempotencyKey: KEY("ls-product"), expectedRevisionId: null, patch: { shippingPolicy: null } } }]);
  expect(state.sizeLeftovers[sizeKey(STORE, 302)]).toEqual({});
  await expect(row).not.toContainText("Sizes differ");
  await expect(row).toContainText("USPS Ground Advantage");
  await expect(row).not.toContainText("USPS Priority Mail");
  await expect(row.getByRole("button", { name: /for all sizes/ })).toHaveCount(0);
  expectNothingUnexpected(state);
});

test("own text above is written in the description editor, counted as typed, and saved as text", async ({ page }, testInfo) => {
  const state = await openStep(page, {}, `${SETUP_PATH}?product=11`);
  await expect(settingRow(page, "descriptionTemplate")).toContainText("Main text: Card Shellz text");
  await changeButton(page, "descriptionTemplate").click();
  const above = descriptionPart(page, "textAbove");
  await expect(above.getByRole("radio", { name: "Use default" })).toBeFocused();
  await above.getByRole("radio", { name: "Own text" }).check();
  const box = above.getByRole("textbox", { name: `Text above for ${ENVELOPE.productName}` });
  await box.fill("Ships in a rigid mailer.");
  await expect(above).toContainText("24 / 4,000");
  if (phone(testInfo)) await expectNoHorizontalScroll(page);
  await fieldEditor(page, "description").getByRole("button", { name: "Done" }).click();
  await expect(changeButton(page, "descriptionTemplate")).toBeFocused();
  await expect(settingRow(page, "descriptionTemplate")).toContainText("→ Text above: your own · Not saved");

  await drawerSave(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.productSettingsWrites).toEqual([{ method: "PUT", path: PRODUCT_PATH,
    body: { idempotencyKey: KEY("ls-product"), expectedRevisionId: null, patch: { textAbove: { mode: "own", text: "Ships in a rigid mailer." } } } }]);
  await expect(settingRow(page, "descriptionTemplate")).toContainText("Card Shellz text, with your text above");
  await expect(settingRow(page, "descriptionTemplate")).toContainText("Set for this product");
  expectNothingUnexpected(state);
});

test("None takes the product's own text below away, sent as none", async ({ page }) => {
  const state = await openStep(page, { productSettings: ownValues({ textBelow: { mode: "own", text: "Thanks for buying!" } }) }, `${SETUP_PATH}?product=11`);
  await expect(settingRow(page, "descriptionTemplate")).toContainText("Card Shellz text, with your text below");
  await changeButton(page, "descriptionTemplate").click();
  const below = descriptionPart(page, "textBelow");
  // The product's own text below, prefilled.
  await expect(below.getByRole("radio", { name: "Own text" })).toBeChecked();
  await expect(below.getByRole("textbox")).toHaveValue("Thanks for buying!");
  await below.getByRole("radio", { name: "None" }).check();
  await expect(below.getByRole("textbox")).toHaveCount(0);
  await fieldEditor(page, "description").getByRole("button", { name: "Done" }).click();
  await expect(settingRow(page, "descriptionTemplate")).toContainText("→ Text below: None · Not saved");

  await drawerSave(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.productSettingsWrites).toEqual([{ method: "PUT", path: PRODUCT_PATH,
    body: { idempotencyKey: KEY("ls-product"), expectedRevisionId: 7, patch: { textBelow: { mode: "none" } } } }]);
  await expect(settingRow(page, "descriptionTemplate")).not.toContainText("your text below");
  expect(state.productSettings[productKey(STORE, ENVELOPE.productId)].values.textBelow).toEqual({ mode: "none" });
  expectNothingUnexpected(state);
});

test("the product's own main text opens prefilled with its counter, and the edit is saved as typed", async ({ page }) => {
  const state = await openStep(page, { productSettings: ownValues({ mainText: { text: "Our own words.", catalogHash: STUB_PRODUCT_CATALOG_HASH } }) },
    `${SETUP_PATH}?product=11`);
  await expect(settingRow(page, "descriptionTemplate")).toContainText("Main text: your own");
  // Up to date with Card Shellz's product: nothing to check.
  await expect(settingRow(page, "descriptionTemplate")).not.toContainText("Check your text still fits");
  await changeButton(page, "descriptionTemplate").click();
  const main = descriptionPart(page, "mainText");
  await expect(main.getByRole("radio", { name: "Own text" })).toBeChecked();
  const box = main.getByRole("textbox", { name: `Main text for ${ENVELOPE.productName}` });
  await expect(box).toHaveValue("Our own words.");
  await expect(main).toContainText("14 / 20,000");
  await box.fill("Our own words, now longer.");
  await expect(main).toContainText("26 / 20,000");
  await fieldEditor(page, "description").getByRole("button", { name: "Done" }).click();
  await expect(settingRow(page, "descriptionTemplate")).toContainText("→ Main text: your own · Not saved");

  await drawerSave(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.productSettingsWrites).toEqual([{ method: "PUT", path: PRODUCT_PATH,
    body: { idempotencyKey: KEY("ls-product"), expectedRevisionId: 7, patch: { mainText: { text: "Our own words, now longer." } } } }]);
  expect(state.productSettings[productKey(STORE, ENVELOPE.productId)].values.mainText)
    .toEqual({ text: "Our own words, now longer.", catalogHash: STUB_PRODUCT_CATALOG_HASH });
  expectNothingUnexpected(state);
});

test("Keep my text saves the same main text again, checked against Card Shellz's product now, and the notice goes", async ({ page }) => {
  const state = await openStep(page, { productSettings: ownValues({ mainText: { text: "Our own words.", catalogHash: "b".repeat(64) } }) },
    `${SETUP_PATH}?product=11`);
  const row = settingRow(page, "descriptionTemplate");
  await expect(row).toContainText("Card Shellz changed this product. Check your text still fits.");
  await expect(page.getByTestId("listing-settings-attention")).toContainText("Card Shellz updated 1 product that has your own text.");
  await row.getByRole("button", { name: `Keep my text for ${ENVELOPE.productName}` }).click();
  // The answer is in the draft: the row says so instead of asking, and focus goes to its Change, never the page (plan 3.4).
  await expect(row).not.toContainText("Check your text still fits");
  await expect(row).toContainText("→ Main text: your own · Not saved");
  await expect(changeButton(page, "descriptionTemplate")).toBeFocused();

  await drawerSave(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.productSettingsWrites).toEqual([{ method: "PUT", path: PRODUCT_PATH,
    body: { idempotencyKey: KEY("ls-product"), expectedRevisionId: 7, patch: { mainText: { text: "Our own words." } } } }]);
  // Read again: the text is stamped with the product as it is now, so nothing is left to check.
  await expect(row).toContainText("Main text: your own");
  await expect(row).not.toContainText("Check your text still fits");
  await expect(row).not.toContainText("Not saved");
  await expect(page.getByTestId("listing-settings-attention")).not.toContainText("has your own text");
  expectNothingUnexpected(state);
});

test("Keep my text in the open Description editor goes in with the text typed above, and steps back while the main text is edited", async ({ page }) => {
  const state = await openStep(page, { productSettings: ownValues({ mainText: { text: "Our own words.", catalogHash: "b".repeat(64) } }) },
    `${SETUP_PATH}?product=11`);
  await changeButton(page, "descriptionTemplate").click();
  const above = descriptionPart(page, "textAbove");
  await above.getByRole("radio", { name: "Own text" }).check();
  await above.getByRole("textbox", { name: `Text above for ${ENVELOPE.productName}` }).fill("Ships in a rigid mailer.");
  const main = descriptionPart(page, "mainText");
  await expect(main).toContainText("Card Shellz changed this product. Check your text still fits.");
  // An edit of the main text is the answer itself: the notice steps back, so Keep can't drop it; as it opened, it asks again.
  const box = main.getByRole("textbox", { name: `Main text for ${ENVELOPE.productName}` });
  await box.fill("Our own words, shorter.");
  await expect(main).not.toContainText("Check your text still fits");
  await box.fill("Our own words.");
  await main.getByRole("button", { name: `Keep my text for ${ENVELOPE.productName}` }).click();
  // The answer goes in with the other parts, as Done would put them, and the editor closes to its Change.
  await expect(fieldEditor(page, "description")).toHaveCount(0);
  await expect(changeButton(page, "descriptionTemplate")).toBeFocused();
  await expect(settingRow(page, "descriptionTemplate")).toContainText("→ Text above: your own, main text: your own · Not saved");

  await drawerSave(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.productSettingsWrites).toEqual([{ method: "PUT", path: PRODUCT_PATH, body: { idempotencyKey: KEY("ls-product"), expectedRevisionId: 7,
    patch: { textAbove: { mode: "own", text: "Ships in a rigid mailer." }, mainText: { text: "Our own words." } } } }]);
  await expect(settingRow(page, "descriptionTemplate")).not.toContainText("Check your text still fits");
  expectNothingUnexpected(state);
});

test("while eBay needs a sign-in, the shelf row offers None and Use default, and Use default still saves as null (D4)", async ({ page }) => {
  const state = await openStep(page, {
    productSettings: ownValues({ storeShelf: { mode: "own", shelves: [{ id: "11", name: "Supplies:Sleeves" }] } }),
    storeShelves: twoShelves(),
    setupReadError: { status: 403, code: "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED", message: "eBay needs the store to be connected again.",
      context: { storeConnectionId: STORE, retryable: false } },
  }, `${SETUP_PATH}?product=11`);
  await expect(banner(page)).toHaveAttribute("data-kind", "sign_in");
  const row = settingRow(page, "storeShelf");
  await expect(row).toContainText("Supplies › Sleeves");
  await expect(row).toContainText("Sign in to eBay again to pick a new one. You can still use the default.");
  await changeButton(page, "storeShelf").click();
  const editor = fieldEditor(page, "storeShelf");
  // No new shelf can be picked: no boxes, only None and Use default.
  await expect(editor.getByRole("radio")).toHaveCount(2);
  await expect(editor.getByRole("combobox")).toHaveCount(0);
  await editor.getByRole("radio", { name: "Use default" }).check();
  await editor.getByRole("button", { name: "Done" }).click();
  await expect(row).toContainText("→ Use default · Not saved");

  await drawerSave(page).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.productSettingsWrites).toEqual([{ method: "PUT", path: PRODUCT_PATH,
    body: { idempotencyKey: KEY("ls-product"), expectedRevisionId: 7, patch: { storeShelf: null } } }]);
  expect(state.productSettings[productKey(STORE, ENVELOPE.productId)].values.storeShelf).toBeNull();
  expectNothingUnexpected(state);
});

test("Fix on a product's tied description rules opens the drawer on its Description editor, once", async ({ page }) => {
  const live = liveListingSettingsSummary(defaultStubState(), STORE);
  const summary: ListingSettingsSummary = { ...live, attention: { total: 1, items: [
    { code: "description_group_conflict", count: 1, productId: ENVELOPE.productId, productName: ENVELOPE.productName }] } };
  const state = await openStep(page, { summaries: { [STORE]: summary } });
  const strip = page.getByTestId("listing-settings-attention");
  await expect(strip).toContainText(`${ENVELOPE.productName}: two of your older description rules apply, so neither is used. Set its description.`);
  await strip.locator("li[data-code='description_group_conflict']").getByRole("button", { name: "Fix" }).click();
  await expect(drawer(page)).toBeVisible();
  await expect(page).toHaveURL(/[?&]product=11$/);
  // The Description row's editor is open, with focus in it.
  await expect(fieldEditor(page, "description")).toBeVisible();
  await expect(changeButton(page, "descriptionTemplate")).toHaveAttribute("aria-expanded", "true");
  await expect(descriptionPart(page, "textAbove").getByRole("radio", { name: "Use default" })).toBeFocused();
  // Esc closes the editor, not the drawer (plan 3.4).
  await page.keyboard.press("Escape");
  await expect(fieldEditor(page, "description")).toHaveCount(0);
  await expect(changeButton(page, "descriptionTemplate")).toBeFocused();

  // Closed and opened again from the list, the drawer opens as usual: the Fix is not remembered.
  await drawer(page).getByRole("button", { name: /^(Close|Back)$/ }).click();
  await expect(drawer(page)).toHaveCount(0);
  await openProductRow(page, ENVELOPE.productId, ENVELOPE.productName);
  await expect(settingRow(page, "descriptionTemplate")).toBeVisible();
  await expect(fieldEditor(page, "description")).toHaveCount(0);
  expectNothingUnexpected(state);
});

test("text over its limit is caught before anything is sent, and the store's text cap is said in the drawer, not as a banner", async ({ page }) => {
  const cap: WriteAnswer = { status: 422, code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE",
    message: "This store's saved listing text is at its limit. Shorten or remove text on other products, or set it once on a category or as the store default.",
    context: { storeConnectionId: STORE, reason: "store_text_limit", textBytes: 2_000_001, maxTextBytes: 2_000_000, retryable: false, classification: "permanent" } };
  const state = await openStep(page, { productSettingsWriteAnswers: [cap] }, `${SETUP_PATH}?product=11`);
  await changeButton(page, "descriptionTemplate").click();
  const above = descriptionPart(page, "textAbove");
  await above.getByRole("radio", { name: "Own text" }).check();
  const box = above.getByRole("textbox", { name: `Text above for ${ENVELOPE.productName}` });
  // Nothing stops the typing at the limit, so a paste is never cut: the counter says it is over.
  await box.fill("a".repeat(4_001));
  await expect(above).toContainText("4,001 / 4,000");
  await expect(box).toHaveAttribute("aria-invalid", "true");
  await fieldEditor(page, "description").getByRole("button", { name: "Done" }).click();
  await expect(above.getByRole("alert")).toHaveText("Shorten it to 4,000 characters or fewer.");
  // Nothing went in the draft: the editor stays, and nothing is waiting to be saved.
  await expect(fieldEditor(page, "description")).toBeVisible();
  await expect(bar(page)).toHaveText("All saved");
  await box.fill("Ships in a rigid mailer.");
  await expect(above.getByRole("alert")).toHaveCount(0);
  await fieldEditor(page, "description").getByRole("button", { name: "Done" }).click();
  await expect(settingRow(page, "descriptionTemplate")).toContainText("→ Text above: your own · Not saved");

  await drawerSave(page).click();
  await expect(footer(page)).toContainText("Your store has too much saved text. Shorten text on other products, or set it once on a category or as your store default.");
  await expect(banner(page)).toHaveCount(0);
  // The change is kept for the vendor to shorten; only the text that fits was ever sent.
  await expect(settingRow(page, "descriptionTemplate")).toContainText("→ Text above: your own · Not saved");
  expect(state.productSettingsWrites).toEqual([{ method: "PUT", path: PRODUCT_PATH,
    body: { idempotencyKey: KEY("ls-product"), expectedRevisionId: null, patch: { textAbove: { mode: "own", text: "Ships in a rigid mailer." } } } }]);
  expectNothingUnexpected(state);
});

// ---------------------------------------------------------------------------
// 10d: the product's price through the price check (W7; plan 7.2-7.7, D1, D2, D6a, D20, D21)
// ---------------------------------------------------------------------------

const REVIEW_PATH = `${LISTINGS}/listing-settings/price-changes/review`;
const APPLY_PATH = `${LISTINGS}/listing-settings/price-changes/apply`;
const RETAIL_20: PricingRecipe = { basis: "catalog_retail", markupBps: 2_000, flatCents: 0, rounding: "cent" };
const COST_35: PricingRecipe = { basis: "product_cost", markupBps: 3_500, flatCents: 0, rounding: "cent" };

/** "$8.39" from integer cents (never floating point). */
function dollars(cents: number | null): string {
  if (cents === null) throw new Error("The resolver gave no price.");
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** The price the shared resolver gives a size for `recipe` (the stub prices with the same call, D1). */
function rulePrice(recipe: PricingRecipe, retailCents: number): string {
  return dollars(calculateRulePrice(recipe, retailCents).priceCents);
}

function pagePath(reviewId: string): string {
  return `${LISTINGS}/listing-settings/price-changes/reviews/${reviewId}`;
}

function changePrice(page: Page, productName = ENVELOPE.productName) {
  return drawer(page).getByRole("button", { name: `Change price for ${productName}`, exact: true });
}

function priceEditor(page: Page) {
  return drawer(page).getByTestId("drawer-field-editor-price");
}

function check(page: Page) {
  return page.getByTestId("price-check");
}

function checkFooter(page: Page) {
  return page.getByTestId("price-check-footer");
}

function checkSize(page: Page, productVariantId: number) {
  return check(page).getByTestId(`price-check-size-${productVariantId}`);
}

function priceHead(page: Page) {
  return drawer(page).getByTestId("drawer-price-head");
}

/** Opens the price editor, picks Set price and types `percent` into Add (the fields are W1's). */
async function setPricePercent(page: Page, percent: string, productName = ENVELOPE.productName) {
  await changePrice(page, productName).click();
  await expect(priceEditor(page)).toBeVisible();
  await priceEditor(page).getByRole("radio", { name: "Set price" }).check();
  await priceEditor(page).getByRole("textbox", { name: "Add" }).fill(percent);
}

/** Product 11 with its own price at revision 7 (a new object for each journey). */
function ownPrice(recipe: PricingRecipe): StubState["productSettings"] {
  return { [productKey(STORE, ENVELOPE.productId)]: { revisionId: 7, values: { ...NO_VALUES, price: recipe } } };
}

/** A product of `count` sizes, ids 501 on, each with a retail price, for a check of more than one page. */
function manySizes(count: number): ProductFixture {
  return { productId: 41, productName: "Team Bags", productSku: "TB", category: "Bags",
    sizes: Array.from({ length: count }, (_, index) => ({ productVariantId: 501 + index, sizeName: `Pack of ${index + 1}`, sku: `TB-${index + 1}`,
      retailCents: 1_000 + index, costCents: 500, stockUnits: 3 })) };
}

/** A product whose second size has no retail price and an exact one: a retail-based price can't price it without the exact price. */
const GRADED_CASE: ProductFixture = { productId: 31, productName: "Graded Card Case", productSku: "GCC", category: "Cases",
  sizes: [
    { productVariantId: 401, sizeName: "Single", sku: "GCC-1", retailCents: 399, costCents: 210, stockUnits: 8 },
    { productVariantId: 402, sizeName: "Bundle", sku: "GCC-B", retailCents: null, costCents: 300, stockUnits: 2 },
  ] };

test("the product's price is set in the drawer, checked against the server's rows, and saved only after the check (D1, D6a)", async ({ page }, testInfo) => {
  const state = await openStep(page, { pricingRules: { [STORE]: SAVED_PRICING_RULES } }, `${SETUP_PATH}?product=11`);
  await expect(priceHead(page)).toHaveText("Store default: Retail price + 15%, to the cent");
  const now = rulePrice(SAVED_PRICING_RULES.profile!.defaultRecipe, 699);
  await expect(drawer(page).getByTestId("drawer-size-101")).toContainText(now);
  await expect(changePrice(page)).toBeEnabled();

  // The editor opens on Use default (the product has no price of its own), with Clear exact prices too unticked.
  await changePrice(page).click();
  await expect(changePrice(page)).toHaveAttribute("aria-expanded", "true");
  await expect(priceEditor(page).getByRole("radio", { name: "Use default" })).toBeChecked();
  await expect(priceEditor(page).getByRole("checkbox", { name: /^Clear exact prices too/ })).not.toBeChecked();
  // Esc closes the editor, not the drawer, and focus goes back to Change price (plan 3.4).
  await page.keyboard.press("Escape");
  await expect(priceEditor(page)).toHaveCount(0);
  await expect(drawer(page)).toBeVisible();
  await expect(changePrice(page)).toBeFocused();
  await expect(bar(page)).toHaveText("All saved");

  await setPricePercent(page, "20");
  // Set price shows the store price's fields to start from: the rounding is the store's.
  await expect(priceEditor(page).getByRole("combobox", { name: "Round" })).toHaveValue("cent");
  const pressedAt = state.reads.length;
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();

  // The check replaces the drawer's body (D20) and takes focus (plan 3.4): one review, sent only after the own read
  // was read again, between the press and the POST (D6a).
  await expect(check(page)).toBeVisible();
  await expect(check(page)).toBeFocused();
  await expect(priceEditor(page)).toHaveCount(0);
  await expect(drawer(page).getByTestId("drawer-settings")).toHaveCount(0);
  expect(state.priceChangeReviews).toEqual([{ method: "POST", path: REVIEW_PATH,
    body: { kind: "product_prices", productIds: [ENVELOPE.productId], price: RETAIL_20 } }]);
  const reviewAt = state.reads.findIndex((read) => read.method === "POST" && read.path === REVIEW_PATH);
  expect(reviewAt).toBeGreaterThanOrEqual(pressedAt);
  expect(state.reads.slice(pressedAt, reviewAt).some((read) => read.method === "GET" && read.path === OWN_PATH)).toBe(true);
  await expect(check(page).getByTestId("price-check-head")).toHaveText("Checking: Retail price + 20%, to the cent · Not saved yet");
  await expect(check(page).getByTestId("price-check-counts")).toHaveText("1 size · 1 change");
  const next = rulePrice(RETAIL_20, 699);
  await expect(checkSize(page, 101)).toContainText("This product's price, from retail $6.99");
  await expect(checkSize(page, 101)).toContainText(now);
  await expect(checkSize(page, 101)).toContainText(next);
  await expect(checkFooter(page)).toContainText(phone(testInfo) ? "Nothing is saved yet." : "Nothing is saved until you press Save new prices.");
  await expect(bar(page)).toHaveText(`Not saved · 1 change in ${ENVELOPE.productName}`);
  expect(state.priceChangeApplies).toEqual([]);
  await shot(page, testInfo, "listing-settings-drawer-price-check");

  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(check(page)).toHaveCount(0);
  await expect(footer(page)).toContainText("Saved");
  const [held] = Object.values(state.priceChangeChecks);
  expect(state.priceChangeApplies).toEqual([{ method: "POST", path: APPLY_PATH,
    body: { reviewId: held.reviewId, reviewHash: held.reviewHash, idempotencyKey: KEY("ls-price-check") } }]);
  // D9: the product, its own read, the lists and the summary are read again after the POST; its answer is not shown.
  const postAt = state.reads.findIndex((read) => read.method === "POST" && read.path === APPLY_PATH);
  await expect.poll(() => readsAfter(state, postAt, "GET", PRODUCT_PATH)).toBeGreaterThanOrEqual(1);
  await expect.poll(() => readsAfter(state, postAt, "GET", OWN_PATH)).toBeGreaterThanOrEqual(1);
  await expect.poll(() => readsAfter(state, postAt, "GET", `${LISTINGS}/listing-settings/products`)).toBeGreaterThanOrEqual(1);
  await expect(priceHead(page)).toHaveText("This product: Retail price + 20%, to the cent");
  await expect(drawer(page).getByTestId("drawer-size-101")).toContainText(next);
  await expect(bar(page)).toHaveText("All saved");
  expect(state.productSettings[productKey(STORE, ENVELOPE.productId)].values.price).toEqual(RETAIL_20);
  // Nothing the client worked out was sent: no price of a size, no revision, in either request (the recipe's own fields only).
  for (const write of [...state.priceChangeReviews, ...state.priceChangeApplies]) expect(JSON.stringify(write.body)).not.toMatch(/priceCents|expectedPrice|revision/i);
  expectNothingUnexpected(state);
});

test("Use default sets a product's own price back, sent as null, and the head then reads Store default; the product's own recipe again is nothing to check", async ({ page }) => {
  const state = await openStep(page, { pricingRules: { [STORE]: SAVED_PRICING_RULES }, productSettings: ownPrice(RETAIL_20) }, `${SETUP_PATH}?product=11`);
  await expect(priceHead(page)).toHaveText("This product: Retail price + 20%, to the cent");
  await changePrice(page).click();
  // The editor opens on the product's own price; checking that again is nothing to check: the editor closes, nothing is sent.
  await expect(priceEditor(page).getByRole("radio", { name: "Set price" })).toBeChecked();
  await expect(priceEditor(page).getByRole("textbox", { name: "Add" })).toHaveValue("20");
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(priceEditor(page)).toHaveCount(0);
  await expect(changePrice(page)).toBeFocused();
  await expect(bar(page)).toHaveText("All saved");
  expect(state.priceChangeReviews).toEqual([]);

  await changePrice(page).click();
  await priceEditor(page).getByRole("radio", { name: "Use default" }).check();
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(check(page)).toBeVisible();
  expect(state.priceChangeReviews).toEqual([{ method: "POST", path: REVIEW_PATH, body: { kind: "product_prices", productIds: [ENVELOPE.productId], price: null } }]);
  await expect(check(page).getByTestId("price-check-head")).toHaveText("Checking: Use default · Not saved yet");
  await expect(checkSize(page, 101)).toContainText("Store default, from retail $6.99");
  await expect(checkSize(page, 101)).toContainText(rulePrice(SAVED_PRICING_RULES.profile!.defaultRecipe, 699));

  // Back to editing, then the product's own recipe typed back: the change is undone (All saved), the editor closes, no second check.
  await checkFooter(page).getByRole("button", { name: /^Back( to editing)?$/ }).click();
  await expect(priceEditor(page)).toBeVisible();
  await priceEditor(page).getByRole("radio", { name: "Set price" }).check();
  await priceEditor(page).getByRole("textbox", { name: "Add" }).fill("20");
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(priceEditor(page)).toHaveCount(0);
  await expect(check(page)).toHaveCount(0);
  await expect(bar(page)).toHaveText("All saved");
  await expect(footer(page)).not.toContainText("couldn't be built");
  expect(state.priceChangeReviews).toHaveLength(1);

  // Use default once more, checked and saved.
  await changePrice(page).click();
  await priceEditor(page).getByRole("radio", { name: "Use default" }).check();
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(check(page)).toBeVisible();
  expect(state.priceChangeReviews).toHaveLength(2);
  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.priceChangeApplies).toHaveLength(1);
  expect(state.productSettings[productKey(STORE, ENVELOPE.productId)].values.price).toBeNull();
  await expect(priceHead(page)).toHaveText("Store default: Retail price + 15%, to the cent");
  expectNothingUnexpected(state);
});

test("a price another window saved before the check is a conflict, nothing sent; Load latest keeps the change and checks it (D6a)", async ({ page }) => {
  const state = await openStep(page, { pricingRules: { [STORE]: SAVED_PRICING_RULES } }, `${SETUP_PATH}?product=11`);
  await setPricePercent(page, "20");
  // Another window saves this product's price after the drawer read it.
  state.productSettings[productKey(STORE, ENVELOPE.productId)] = { revisionId: 60, values: { ...NO_VALUES, price: COST_35 } };
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(footer(page)).toContainText("This changed in another window.");
  await expect(check(page)).toHaveCount(0);
  expect(state.priceChangeReviews).toEqual([]);
  expect(state.priceChangeApplies).toEqual([]);

  await footer(page).getByRole("button", { name: "Load latest and keep my changes" }).click();
  await expect(footer(page)).toContainText("Here's what's saved now. Your changes are on top; fields you both changed are marked.");
  await expect(priceHead(page)).toHaveText("This product: Your cost + 35%, to the cent");
  await expect(bar(page)).toHaveText(`Not saved · 1 change in ${ENVELOPE.productName}`);
  // The change is kept with no check: the footer's button checks it against what is saved now.
  await footer(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(check(page)).toBeVisible();
  expect(state.priceChangeReviews).toHaveLength(1);
  await expect(checkSize(page, 101)).toContainText("This product's price, from retail $6.99");
  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.priceChangeApplies).toHaveLength(1);
  expect(state.productSettings[productKey(STORE, ENVELOPE.productId)].values.price).toEqual(RETAIL_20);
  expectNothingUnexpected(state);
});

test("a size that would lose its price keeps Save off and says why; without clearing its exact price the check saves", async ({ page }) => {
  const state = await openStep(page, { catalog: [ENVELOPE, GRADED_CASE], pricingRules: { [STORE]: SAVED_PRICING_RULES },
    sizePrices: { [sizeKey(STORE, 402)]: { revisionId: 32, pricingMode: "fixed", overridePriceCents: 899 } } }, `${SETUP_PATH}?product=31`);
  await setPricePercent(page, "20", GRADED_CASE.productName);
  await priceEditor(page).getByRole("checkbox", { name: /^Clear exact prices too/ }).check();
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(check(page)).toBeVisible();
  expect(state.priceChangeReviews).toEqual([{ method: "POST", path: REVIEW_PATH,
    body: { kind: "product_prices", productIds: [GRADED_CASE.productId], price: RETAIL_20, releaseExactPrices: true } }]);
  await expect(check(page).getByTestId("price-check-counts")).toHaveText("2 sizes · 2 change · 1 loses its exact price · 1 would lose its price");
  await expect(checkSize(page, 401)).toContainText(rulePrice(RETAIL_20, 399));
  await expect(checkSize(page, 402)).toContainText("$8.99");
  await expect(checkSize(page, 402)).toContainText("● Loses its price");
  await expect(checkFooter(page)).toContainText("● 1 size can't be priced this way. Give it an exact price in Products, or start from Your cost.");
  await expect(checkFooter(page)).toContainText("To give them an exact price, discard this change first.");
  await expect(checkFooter(page).getByRole("button", { name: "Save new prices" })).toBeDisabled();
  expect(state.priceChangeApplies).toEqual([]);

  // Back to editing: the editor opens on the change; the exact price is kept this time.
  await checkFooter(page).getByRole("button", { name: /^Back( to editing)?$/ }).click();
  await expect(check(page)).toHaveCount(0);
  await expect(priceEditor(page)).toBeVisible();
  await expect(priceEditor(page).getByRole("textbox", { name: "Add" })).toHaveValue("20");
  await expect(priceEditor(page).getByRole("checkbox", { name: /^Clear exact prices too/ })).toBeChecked();
  await priceEditor(page).getByRole("checkbox", { name: /^Clear exact prices too/ }).uncheck();
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(check(page)).toBeVisible();
  expect(state.priceChangeReviews).toHaveLength(2);
  expect(state.priceChangeReviews[1].body).toEqual({ kind: "product_prices", productIds: [GRADED_CASE.productId], price: RETAIL_20 });
  await expect(check(page).getByTestId("price-check-counts")).toHaveText("2 sizes · 1 change");
  await expect(checkSize(page, 402)).toContainText("Exact price kept");
  await expect(checkSize(page, 402)).not.toContainText("Loses its price");
  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.priceChangeApplies).toHaveLength(1);
  expect(state.productSettings[productKey(STORE, GRADED_CASE.productId)].values.price).toEqual(RETAIL_20);
  expect(state.sizePrices[sizeKey(STORE, 402)]).toMatchObject({ pricingMode: "fixed", overridePriceCents: 899 });
  expectNothingUnexpected(state);
});

test("prices that moved under the apply give a new check with the stale line, never a re-apply; the new check saves with its own key", async ({ page }) => {
  const state = await openStep(page, { pricingRules: { [STORE]: SAVED_PRICING_RULES } }, `${SETUP_PATH}?product=11`);
  await setPricePercent(page, "20");
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(check(page)).toBeVisible();
  // Another window gives the size an exact price while the check is on screen: the apply's recompute differs.
  state.sizePrices[sizeKey(STORE, 101)] = { revisionId: 50, pricingMode: "fixed", overridePriceCents: 777 };
  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(check(page)).toContainText("Prices changed while you were checking. Here's the new check.");
  expect(state.priceChangeApplies).toHaveLength(1);
  expect(state.priceChangeReviews).toHaveLength(2);
  expect(state.priceChangeReviews[1].body).toEqual(state.priceChangeReviews[0].body);
  // D6a again: the own read is read between the refused apply and the new review, before the re-check is sent.
  const applyAt = state.reads.findIndex((read) => read.method === "POST" && read.path === APPLY_PATH);
  const recheckAt = state.reads.findIndex((read, index) => index > applyAt && read.method === "POST" && read.path === REVIEW_PATH);
  expect(recheckAt).toBeGreaterThan(applyAt);
  expect(state.reads.slice(applyAt + 1, recheckAt).some((read) => read.method === "GET" && read.path === OWN_PATH)).toBe(true);
  await expect(checkSize(page, 101)).toContainText("Exact price kept");
  await expect(checkSize(page, 101)).toContainText("$7.77");
  await expect(check(page).getByTestId("price-check-counts")).toHaveText("1 size · no price changes");
  await expect(checkFooter(page)).toContainText("No prices change now. Saving still sets the price.");
  await expect(checkFooter(page).getByRole("button", { name: "Save new prices" })).toBeEnabled();

  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.priceChangeApplies).toHaveLength(2);
  expect(state.priceChangeApplies[1].body.reviewId).not.toBe(state.priceChangeApplies[0].body.reviewId);
  expect(state.priceChangeApplies[1].body.idempotencyKey).not.toBe(state.priceChangeApplies[0].body.idempotencyKey);
  expect(state.productSettings[productKey(STORE, ENVELOPE.productId)].values.price).toEqual(RETAIL_20);
  expect(state.sizePrices[sizeKey(STORE, 101)]).toMatchObject({ pricingMode: "fixed", overridePriceCents: 777 });
  expectNothingUnexpected(state);
});

test("a check of more than 50 sizes pages through the same review, and saves", async ({ page }) => {
  const product = manySizes(60);
  const state = await openStep(page, { catalog: [ENVELOPE, product], pricingRules: { [STORE]: SAVED_PRICING_RULES } }, `${SETUP_PATH}?product=${product.productId}`);
  await setPricePercent(page, "20", product.productName);
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(check(page)).toBeVisible();
  await expect(check(page).getByTestId("price-check-counts")).toHaveText("60 sizes · 60 change");
  await expect(check(page).getByTestId("price-check-pages")).toHaveText("1–50 of 60");
  await expect(checkSize(page, 501)).toBeVisible();
  await expect(checkSize(page, 560)).toHaveCount(0);
  const [held] = Object.values(state.priceChangeChecks);
  await check(page).getByRole("button", { name: "Next" }).click();
  await expect(check(page).getByTestId("price-check-pages")).toHaveText("51–60 of 60");
  await expect(checkSize(page, 560)).toContainText(rulePrice(RETAIL_20, 1_059));
  await expect(checkSize(page, 501)).toHaveCount(0);
  expect(state.reads.filter((read) => read.method === "GET" && read.path === pagePath(held.reviewId)).map((read) => read.search)).toEqual(["?page=1"]);
  await check(page).getByRole("button", { name: "Previous" }).click();
  await expect(check(page).getByTestId("price-check-pages")).toHaveText("1–50 of 60");
  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.priceChangeApplies).toEqual([{ method: "POST", path: APPLY_PATH,
    body: { reviewId: held.reviewId, reviewHash: held.reviewHash, idempotencyKey: KEY("ls-price-check") } }]);
  expectNothingUnexpected(state);
});

test("an apply whose answer was lost is checked again with the same key and body, with Esc keeping the drawer open meanwhile", async ({ page }) => {
  const state = await openStep(page, { pricingRules: { [STORE]: SAVED_PRICING_RULES }, priceChangeApplyAnswers: ["drop"] }, `${SETUP_PATH}?product=11`);
  await setPricePercent(page, "20");
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(checkFooter(page)).toContainText("We couldn't confirm your save.");
  await expect(checkFooter(page)).not.toContainText("Nothing was saved");
  // Esc keeps the drawer, and the check, open while nobody could confirm the save (plan 3.4).
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toBeVisible();
  await expect(check(page)).toBeVisible();
  await checkFooter(page).getByRole("button", { name: "Check again" }).click();
  await expect(check(page)).toHaveCount(0);
  await expect(footer(page)).toContainText("Saved");
  expect(state.priceChangeApplies).toHaveLength(2);
  expect(state.priceChangeApplies[1].body).toEqual(state.priceChangeApplies[0].body);
  expect(state.priceChangeApplies[0].body.idempotencyKey).toEqual(KEY("ls-price-check"));
  expect(state.productSettings[productKey(STORE, ENVELOPE.productId)].values.price).toEqual(RETAIL_20);
  expectNothingUnexpected(state);
});

test("Back while the apply is unconfirmed closes the drawer and keeps it; opening the product again shows the check with Check again (D21)", async ({ page }, testInfo) => {
  const state = await openStep(page, { pricingRules: { [STORE]: SAVED_PRICING_RULES }, priceChangeApplyAnswers: ["drop"] }, `${SETUP_PATH}?product=11`);
  await setPricePercent(page, "20");
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(checkFooter(page)).toContainText("We couldn't confirm your save.");
  const [held] = Object.values(state.priceChangeChecks);
  const pageReadsBefore = readsAfter(state, -1, "GET", pagePath(held.reviewId));

  await checkFooter(page).getByRole("button", { name: phone(testInfo) ? "Back" : "Back to editing", exact: true }).click();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(bar(page)).toHaveText(`Not saved · 1 change in ${ENVELOPE.productName}`);
  expect(state.priceChangeApplies).toHaveLength(1);

  // Reopened: the check is rebuilt from the draft's review id and hash, its rows read again, with Check again.
  await openProductRow(page, ENVELOPE.productId, ENVELOPE.productName);
  await expect(check(page)).toBeVisible();
  await expect(check(page)).toHaveAttribute("data-review", held.reviewId);
  await expect(checkFooter(page)).toContainText("We couldn't confirm your save.");
  await expect(checkSize(page, 101)).toContainText(rulePrice(RETAIL_20, 699));
  expect(readsAfter(state, -1, "GET", pagePath(held.reviewId))).toBe(pageReadsBefore + 1);
  await checkFooter(page).getByRole("button", { name: "Check again" }).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.priceChangeApplies).toHaveLength(2);
  expect(state.priceChangeApplies[1].body).toEqual(state.priceChangeApplies[0].body);
  await expect(bar(page)).toHaveText("All saved");
  expectNothingUnexpected(state);
});

test("a check the server dropped while its apply was unconfirmed is still checked again from the draft after reopening; the apply's 404 makes the new check (D21)", async ({ page }, testInfo) => {
  // The first apply is refused as busy with no reason: unconfirmed, same key, nothing recorded by the server.
  const state = await openStep(page, { pricingRules: { [STORE]: SAVED_PRICING_RULES },
    priceChangeApplyAnswers: [{ status: 503, code: BUSY, message: "Busy.", context: { retryable: true } }] }, `${SETUP_PATH}?product=11`);
  await setPricePercent(page, "20");
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(checkFooter(page)).toContainText("We couldn't confirm your save.");
  const [held] = Object.values(state.priceChangeChecks);
  // The server drops the check meanwhile (it expired).
  delete state.priceChangeChecks[held.reviewId];

  await checkFooter(page).getByRole("button", { name: phone(testInfo) ? "Back" : "Back to editing", exact: true }).click();
  await expect(drawer(page)).toHaveCount(0);
  await openProductRow(page, ENVELOPE.productId, ENVELOPE.productName);
  await expect(check(page)).toBeVisible();
  // The page read answers 404: the words say so, and Check again is on, rebuilt from the draft's review id and hash alone.
  await expect(check(page)).toContainText("This price check has expired. Check new prices again.");
  await expect(check(page)).toHaveAttribute("data-review", held.reviewId);
  const checkAgain = checkFooter(page).getByRole("button", { name: "Check again" });
  await expect(checkAgain).toBeEnabled();
  await checkAgain.click();
  // The apply's own 404 makes the new check, once, with its line (the own read read again first, D6a); nothing was applied.
  await expect(check(page)).toContainText("This check expired. Here's a new check.");
  expect(state.priceChangeApplies).toHaveLength(2);
  expect(state.priceChangeApplies[1].body).toEqual(state.priceChangeApplies[0].body);
  expect(state.priceChangeReviews).toHaveLength(2);
  expect(state.priceChangeReviews[1].body).toEqual(state.priceChangeReviews[0].body);
  await expect(checkSize(page, 101)).toContainText(rulePrice(RETAIL_20, 699));
  expect(state.productSettings[productKey(STORE, ENVELOPE.productId)]?.values.price ?? null).toBeNull();

  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.priceChangeApplies).toHaveLength(3);
  expect(state.priceChangeApplies[2].body.reviewId).not.toBe(held.reviewId);
  expect(state.priceChangeApplies[2].body.idempotencyKey).not.toBe(state.priceChangeApplies[0].body.idempotencyKey);
  expect(state.productSettings[productKey(STORE, ENVELOPE.productId)].values.price).toEqual(RETAIL_20);
  await expect(bar(page)).toHaveText("All saved");
  expectNothingUnexpected(state);
});

test("an apply refused for sizes that would lose their price marks them and keeps Save off, also after Back and reopening; a new check is the way on", async ({ page }) => {
  const lost: WriteAnswer = { status: 422, code: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", message: "Some sizes would lose their price.",
    context: { storeConnectionId: STORE, sizes: [{ productVariantId: 101 }], sizeCount: 1 } };
  const state = await openStep(page, { pricingRules: { [STORE]: SAVED_PRICING_RULES }, priceChangeApplyAnswers: [lost] });
  await openProductRow(page, ENVELOPE.productId, ENVELOPE.productName);
  await setPricePercent(page, "20");
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(checkFooter(page)).toContainText("● 1 size would be left without a price. Give it an exact price in Products first.");
  await expect(checkSize(page, 101)).toContainText("● Loses its price");
  await expect(checkFooter(page).getByRole("button", { name: "Save new prices" })).toBeDisabled();
  expect(state.priceChangeApplies).toHaveLength(1);
  expect(state.priceChangeReviews).toHaveLength(1);

  // Browser Back closes the drawer and keeps the refused check; reopened, it still says why and Save stays off.
  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page).toHaveURL(SETUP_PATH);
  await expect(bar(page)).toHaveText(`Not saved · 1 change in ${ENVELOPE.productName}`);
  await openProductRow(page, ENVELOPE.productId, ENVELOPE.productName);
  await expect(check(page)).toBeVisible();
  await expect(checkFooter(page)).toContainText("● 1 size would be left without a price. Give it an exact price in Products first.");
  await expect(checkFooter(page).getByRole("button", { name: "Save new prices" })).toBeDisabled();
  expect(state.priceChangeApplies).toHaveLength(1);

  // Back to editing, then a new check: the server's rows decide again, and the new check saves under its own key.
  await checkFooter(page).getByRole("button", { name: /^Back( to editing)?$/ }).click();
  await expect(priceEditor(page)).toBeVisible();
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(check(page)).toBeVisible();
  expect(state.priceChangeReviews).toHaveLength(2);
  await expect(checkSize(page, 101)).not.toContainText("Loses its price");
  await expect(checkFooter(page).getByRole("button", { name: "Save new prices" })).toBeEnabled();
  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.priceChangeApplies).toHaveLength(2);
  expect(state.priceChangeApplies[1].body.idempotencyKey).not.toBe(state.priceChangeApplies[0].body.idempotencyKey);
  expect(state.productSettings[productKey(STORE, ENVELOPE.productId)].values.price).toEqual(RETAIL_20);
  expectNothingUnexpected(state);
});

test("on a phone the price editor opens inside the drawer and the check shows as cards, with Save new prices in view and no sideways scroll", async ({ page }, testInfo) => {
  test.skip(!phone(testInfo), "The phone layout (below 640 px) only.");
  const state = await openStep(page, { pricingRules: { [STORE]: SAVED_PRICING_RULES } }, `${SETUP_PATH}?product=11`);
  await expectSheetLayout(page, testInfo, drawer(page));
  await setPricePercent(page, "20");
  // Inline in the drawer: no second sheet opens over it (D20).
  await expect(page.getByTestId("editor-surface")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await priceEditor(page).getByRole("button", { name: "Check new prices" }).click();
  await expect(check(page)).toBeVisible();
  await expect(check(page).locator("table")).toHaveCount(0);
  await expect(check(page).locator("li[data-testid^='price-check-size-']")).toHaveCount(1);
  await expect(checkSize(page, 101)).toContainText(`${rulePrice(SAVED_PRICING_RULES.profile!.defaultRecipe, 699)} → ${rulePrice(RETAIL_20, 699)}`);
  await expect(checkFooter(page)).toContainText("Nothing is saved yet.");
  await expectInView(page, checkFooter(page).getByRole("button", { name: "Save new prices" }));
  await expectNoHorizontalScroll(page);
  await shot(page, testInfo, "listing-settings-drawer-price-check-phone");
  await checkFooter(page).getByRole("button", { name: "Save new prices" }).click();
  await expect(footer(page)).toContainText("Saved");
  expect(state.priceChangeApplies).toHaveLength(1);
  expectNothingUnexpected(state);
});
