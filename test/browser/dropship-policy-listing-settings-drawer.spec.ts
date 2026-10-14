import { expect, test, type Page } from "playwright/test";
import type { CategoryListingSettingValues, ProductListingSettingValues } from "../../shared/dropship/listing-setting-values";
import {
  ENVELOPE,
  LAYERED_SAMPLE,
  categoryKey,
  listingSetup,
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
  drawerSave,
  exactBox,
  expectInView,
  expectNoHorizontalScroll,
  expectNothingUnexpected,
  expectSheetLayout,
  openStep,
  phone,
} from "./dropship-policy-listing-settings-helpers";

// Playwright's serviceWorkers:block init script reads navigator.serviceWorker in
// every frame, which throws in an opaque sandbox. This local-only harness
// registers no workers.
test.use({ serviceWorkers: "allow" });

/**
 * The product drawer's policy rows (Listing settings PR 10, part 10a; plan 4.9): a product's own
 * shipping, return and payment policy is changed, or set back to the default, in the drawer and
 * saved through W5 from the product's own settings read. Every save is checked against the
 * shared contract by the stub (ids only, compare-and-set on the product's revision, keyed), and
 * every journey ends with nothing unexpected asked and no page error. Desktop and phone.
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

function settingRow(page: Page, key: "shippingPolicy" | "returnPolicy" | "paymentPolicy") {
  return drawer(page).getByTestId(`drawer-setting-${key}`);
}

function changeButton(page: Page, key: "shippingPolicy" | "returnPolicy" | "paymentPolicy", productName = ENVELOPE.productName) {
  const setting = { shippingPolicy: "shipping policy", returnPolicy: "return policy", paymentPolicy: "payment policy" }[key];
  return settingRow(page, key).getByRole("button", { name: `Change ${setting} for ${productName}`, exact: true });
}

function fieldEditor(page: Page, key: "shippingPolicy" | "returnPolicy" | "paymentPolicy") {
  return drawer(page).getByTestId(`drawer-field-editor-${key}`);
}

function footer(page: Page) {
  return page.getByTestId("product-drawer-footer");
}

function bar(page: Page) {
  return page.getByTestId("catalog-action-summary");
}

/** A policy in the open field editor; its label also carries its Card Shellz fit line. */
function policyRadio(page: Page, key: "shippingPolicy" | "returnPolicy" | "paymentPolicy", name: string) {
  return fieldEditor(page, key).getByRole("radio", { name: new RegExp(`^${name}`) });
}

/** Opens the field editor, picks a choice and puts it in the draft with Done. */
async function pick(page: Page, key: "shippingPolicy" | "returnPolicy" | "paymentPolicy", name: string) {
  await changeButton(page, key).click();
  await expect(fieldEditor(page, key)).toBeVisible();
  await policyRadio(page, key, name).check();
  await fieldEditor(page, key).getByRole("button", { name: "Done" }).click();
  await expect(fieldEditor(page, key)).toHaveCount(0);
}

/**
 * Answers the next GET of `path` with a 500 once `armed()` says so, once; every other request goes
 * to the stub. The failed read never reaches the stub, so `state.reads` doesn't list it.
 */
async function failNextRead(page: Page, path: string, armed: () => boolean) {
  let failed = false;
  await page.route(`**${path}`, async (route) => {
    if (!failed && route.request().method() === "GET" && armed()) {
      failed = true;
      await route.fulfill({ status: 500, json: { error: { code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", message: "Read failed." } } });
      return;
    }
    await route.fallback();
  });
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
