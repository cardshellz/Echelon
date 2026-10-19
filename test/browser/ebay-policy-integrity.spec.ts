import { expect, test, type Page } from "@playwright/test";
import { setupEbayChannelPage } from "./fixtures/ebay-channel-page.fixture";
import type { EbayPolicyValues, EbayPolicyScope } from "../../shared/ebay-business-policies";

const oldPolicies: EbayPolicyValues = { fulfillmentPolicyId: "missing-shipping", returnPolicyId: "returns", paymentPolicyId: "pay" };
const options = { fulfillmentPolicies: [{ id: "shipping", name: "Available shipping" }],
  returnPolicies: [{ id: "returns", name: "Returns" }, { id: "returns-new", name: "New returns" }],
  paymentPolicies: [{ id: "pay", name: "Payment" }] };
const originalScope: EbayPolicyScope = { channelId: 67, connectionId: 34, accountId: "test-account", environment: "production", marketplaceId: "EBAY_US" };
type Level = "store" | "category" | "product" | "variant";
const prefix: Record<Level, string> = { store: "Store defaults", category: "Toploaders category",
  product: "Product Policy Overrides", variant: "Variant Policy Overrides — POLICY-VARIANT" };
const fields = ["fulfillmentPolicyId", "returnPolicyId", "paymentPolicyId"] as const;
const overrides = (values: EbayPolicyValues) => ({ fulfillmentPolicyOverride: values.fulfillmentPolicyId,
  returnPolicyOverride: values.returnPolicyId, paymentPolicyOverride: values.paymentPolicyId });

async function setup(page: Page) {
  const original = await setupEbayChannelPage(page);
  const state = { saved: Object.fromEntries(["store", "category", "product", "variant"].map(level => [level, { ...oldPolicies }])) as Record<Level, EbayPolicyValues>,
    scope: { ...originalScope }, categoryConfigured: true, failSave: false, catalogFailure: false, writes: [] as Array<{ level: Level; body: Record<string, unknown> }> };
  await page.route("**/api/ebay/channel-config", route => route.fulfill({ json: {
    connected: true, connectionHealth: "verified", channel: { id: 67, name: "eBay", status: "active" },
    ebayUsername: "test-store", tokenInfo: null, lastSyncAt: null, syncStatus: "idle",
    config: { marketplaceId: "EBAY_US", merchantLocationKey: "warehouse", merchantLocation: null, ...state.saved.store },
    categoryMappings: state.categoryConfigured ? [{ productTypeSlug: "toploaders", ebayBrowseCategoryId: null, ebayBrowseCategoryName: null,
      ebayStoreCategoryId: null, ebayStoreCategoryName: null, listingEnabled: true, aspectsReady: null, missingRequiredCount: null, ...overrides(state.saved.category) }] : [],
    productTypes: [{ id: 1, slug: "toploaders", name: "Toploaders", productCount: 1, variantCount: 1 }],
  } }));
  await page.route("**/api/ebay/policies", route => state.catalogFailure
    ? route.fulfill({ status: 503, json: { error: "Synthetic policy catalog unavailable" } }) : route.fulfill({ json: { ...options, scope: state.scope } }));
  await page.route("**/api/ebay/listing-feed", route => route.fulfill({ json: { total: 1, feed: [{
    id: 1, name: "Policy test product", sku: "POLICY", productType: "toploaders", productTypeName: "Toploaders",
    ebayBrowseCategoryId: null, ebayBrowseCategoryName: null, ebayBrowseCategoryOverrideId: null,
    ebayBrowseCategoryOverrideName: null, ebayStoreCategoryName: null, status: "publication_incomplete",
    missingItems: [], missingAspects: [], isListed: false, isExcluded: false, syncError: null,
    externalListingId: null, externalListingIdentityConflict: false, variantCount: 1, includedVariantCount: 1,
    imageCount: 0, ...overrides(state.saved.product), variants: [{ id: 11, sku: "POLICY-VARIANT", name: "Variant",
      priceCents: 100, ebayListingExcluded: false, explicitlyExcluded: false, excludedByProduct: false,
      effectivelyListed: true, inventoryQuantity: 1, ...overrides(state.saved.variant) }],
  }] } }));
  for (const [level, path] of Object.entries({ store: "settings", category: "category-mapping", product: "product-policies/1", variant: "variant-policies/11" }) as Array<[Level, string]>) {
    await page.route(`**/api/ebay/${path}`, async route => {
      expect(route.request().method()).toBe("PUT");
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.writes.push({ level, body });
      if (state.failSave) return route.fulfill({ status: 503, json: { error: "Synthetic policy save failed" } });
      const patch = level === "category" ? (body.mappings as Array<Record<string, unknown>>)[0] : body;
      for (const field of fields) {
        const key = level === "category" ? field.replace("PolicyId", "PolicyOverride") : field;
        if (Object.hasOwn(patch, key)) state.saved[level][field] = patch[key] as string | null;
      }
      if (level === "category") state.categoryConfigured = true;
      return route.fulfill({ json: { success: true, message: "Saved" } });
    });
  }
  await page.reload();
  await expect(page.getByText("Policy test product", { exact: true })).toBeVisible();
  return { ...original, state };
}

async function open(page: Page, level: Level) {
  const anchor = level === "store" ? "business-policies" : level === "category" ? "ebay-category-policies-toploaders"
    : level === "product" ? "ebay-product-policies-1" : "ebay-variant-policies-11";
  await page.evaluate(value => { window.location.hash = value; }, anchor);
  return page.getByRole("combobox", { name: `${prefix[level]} shipping policy`, exact: true }).filter({ visible: true });
}
function save(page: Page, level: Level) {
  if (level === "category") return page.getByRole("button", { name: "Save Category Mappings", exact: true });
  const editor = level === "store" ? page.locator("#business-policies") : page.getByRole("region", { name: prefix[level], exact: true });
  return editor.getByRole("button", { name: "Save Policies", exact: true });
}
async function choose(page: Page, level: Level, kind: "shipping" | "return", name: string) {
  await page.getByRole("combobox", { name: `${prefix[level]} ${kind} policy`, exact: true }).filter({ visible: true }).click();
  await page.getByRole("option", { name, exact: true }).click();
}

for (const level of ["store", "category", "product", "variant"] as const) {
  test(`${level}: unavailable saved policy is visible and unrelated edits are patch-only with retry`, async ({ page }) => {
    const { state, errors, unexpected } = await setup(page);
    const shipping = await open(page, level);
    await expect(shipping).toContainText("Unavailable shipping policy missing-shipping");
    await shipping.click();
    await expect(page.getByRole("option", { name: "Unavailable shipping policy missing-shipping" })).toBeDisabled();
    await page.keyboard.press("Escape");
    expect(state.writes).toEqual([]);
    state.failSave = true;
    await choose(page, level, "return", "New returns");
    await save(page, level).click();
    await expect(page.getByText("Synthetic policy save failed", { exact: false }).first()).toBeVisible();
    await expect(save(page, level)).toBeEnabled();
    await expect(shipping).toContainText("Unavailable shipping policy missing-shipping");
    const body = level === "category" ? (state.writes[0].body.mappings as Record<string, unknown>[])[0] : state.writes[0].body;
    expect(state.writes[0].body.expectedScope).toEqual(originalScope);
    expect(body).toMatchObject({ [level === "category" ? "returnPolicyOverride" : "returnPolicyId"]: "returns-new", expectedPolicies: oldPolicies });
    expect(body).not.toHaveProperty(level === "category" ? "fulfillmentPolicyOverride" : "fulfillmentPolicyId");
    expect(body).not.toHaveProperty(level === "category" ? "paymentPolicyOverride" : "paymentPolicyId");
    state.failSave = false;
    await save(page, level).click();
    await expect.poll(() => state.saved[level].returnPolicyId).toBe("returns-new");
    expect(state.writes[1]).toEqual(state.writes[0]);
    expect(state.saved[level].fulfillmentPolicyId).toBe("missing-shipping");
    expect(errors).toEqual([]); expect(unexpected).toEqual([]);
  });

  test(`${level}: explicit correction saves only shipping and survives a reload`, async ({ page }) => {
    const { state, errors, unexpected } = await setup(page);
    await open(page, level);
    const name = level === "store" ? "Available shipping" : level === "category" ? "Use store default"
      : level === "product" ? "Use category or store default" : "Use product, category or store default";
    await choose(page, level, "shipping", name);
    expect(state.writes).toEqual([]);
    await save(page, level).click();
    await expect.poll(() => state.saved[level].fulfillmentPolicyId).toBe(level === "store" ? "shipping" : null);
    const body = level === "category" ? (state.writes[0].body.mappings as Record<string, unknown>[])[0] : state.writes[0].body;
    expect(body).not.toHaveProperty(level === "category" ? "returnPolicyOverride" : "returnPolicyId");
    expect(body).not.toHaveProperty(level === "category" ? "paymentPolicyOverride" : "paymentPolicyId");
    await page.reload();
    await expect(await open(page, level)).toContainText(name);
    expect(errors).toEqual([]); expect(unexpected).toEqual([]);
  });

  test(`${level}: catalog failure does not masquerade as an absent or inherited policy`, async ({ page }) => {
    const { state, errors, unexpected } = await setup(page);
    state.catalogFailure = true;
    await page.reload();
    const shipping = await open(page, level);
    await expect(shipping).toContainText("Saved shipping policy missing-shipping (not checked)");
    await expect(shipping).toBeDisabled();
    expect(state.writes).toEqual([]);
    expect(errors).toEqual([]); expect(unexpected).toEqual([]);
  });
}

test("a clean store editor refreshes external changes without a permanent initial-value latch", async ({ page }) => {
  const { state } = await setup(page);
  await open(page, "store");
  state.saved.store.fulfillmentPolicyId = "shipping";
  await page.getByRole("button", { name: "Refresh connection", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Store defaults shipping policy" })).toContainText("Available shipping");
  expect(state.writes).toEqual([]);
});

for (const level of ["category", "product", "variant"] as const) {
  test(`${level}: an available explicit override saves with the original policy snapshot`, async ({ page }) => {
    const { state } = await setup(page);
    await open(page, level);
    await choose(page, level, "shipping", "Available shipping");
    await save(page, level).click();
    await expect.poll(() => state.saved[level].fulfillmentPolicyId).toBe("shipping");
    const body = level === "category" ? (state.writes[0].body.mappings as Record<string, unknown>[])[0] : state.writes[0].body;
    expect(body).toMatchObject({ [level === "category" ? "fulfillmentPolicyOverride" : "fulfillmentPolicyId"]: "shipping", expectedPolicies: oldPolicies });
    await expect(page.getByRole("combobox", { name: `${prefix[level]} shipping policy` }).filter({ visible: true })).toContainText("Available shipping");
  });
}

test("loading preserves visible stored policy IDs at every level", async ({ page }) => {
  const { state } = await setup(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/ebay/policies", async route => { await pending; await route.fulfill({ json: options }); });
  await page.reload();
  for (const level of ["store", "category", "product", "variant"] as const) {
    const shipping = await open(page, level);
    await expect(shipping).toContainText("Saved shipping policy missing-shipping (not checked)");
    await expect(shipping).toBeDisabled();
  }
  release();
  await expect(page.getByRole("combobox", { name: `${prefix.variant} shipping policy` })).toContainText("Unavailable shipping policy missing-shipping");
  expect(state.writes).toEqual([]);
});

test("external policy refresh preserves dirty edits and requires explicit reload", async ({ page }) => {
  const { state } = await setup(page);
  await open(page, "store");
  await choose(page, "store", "return", "New returns");
  state.saved.store.fulfillmentPolicyId = "shipping";
  await page.getByRole("button", { name: "Refresh connection", exact: true }).click();
  await expect(page.getByText("Saved policies changed while you were editing,", { exact: false })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Store defaults return policy" })).toContainText("New returns");
  await expect(save(page, "store")).toBeDisabled();
  await page.getByRole("button", { name: "Reload saved policies", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Store defaults return policy" })).toContainText("Returns");
  await expect(page.getByRole("combobox", { name: "Store defaults shipping policy" })).toContainText("Available shipping");
  expect(state.writes).toEqual([]);
});

test("a variant policy anchor waits for its owner to load before opening", async ({ page }) => {
  const { state, errors, unexpected } = await setup(page);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/ebay/listing-feed", async route => { await pending; await route.fallback(); });
  await page.reload();
  await page.evaluate(() => { window.location.hash = "ebay-variant-policies-11"; });
  await expect(page.locator("#ebay-variant-policies-11")).toHaveCount(0);
  release();
  await expect(page.getByRole("combobox", { name: `${prefix.variant} shipping policy`, exact: true })).toContainText("Unavailable shipping policy missing-shipping");
  expect(state.writes).toEqual([]);
  expect(errors).toEqual([]); expect(unexpected).toEqual([]);
});

for (const storedId of ["", "  ", "__inherit__", "inherit"]) {
  test(`legacy stored ID ${JSON.stringify(storedId)} stays visible and distinct from inheritance`, async ({ page }) => {
    const { state } = await setup(page);
    state.saved.product.fulfillmentPolicyId = storedId;
    await page.reload();
    const shipping = await open(page, "product");
    const displayId = storedId.trim() ? storedId : JSON.stringify(storedId);
    await expect(shipping).toContainText(`Unavailable shipping policy ${displayId}`);
    await shipping.click();
    await expect(page.getByRole("option", { name: `Unavailable shipping policy ${displayId}`, exact: true })).toBeDisabled();
    await page.getByRole("option", { name: "Use category or store default", exact: true }).click();
    expect(state.writes).toEqual([]);
    await save(page, "product").click();
    await expect.poll(() => state.saved.product.fulfillmentPolicyId).toBeNull();
    expect(state.writes[0].body).toEqual({ fulfillmentPolicyId: null, expectedPolicies: { ...oldPolicies, fulfillmentPolicyId: storedId }, expectedScope: originalScope });
  });
}

for (const level of ["store", "category", "product", "variant"] as const) {
  test(`${level}: an account switch preserves dirty edits and blocks saving until explicit reload`, async ({ page }) => {
    const { state, errors, unexpected } = await setup(page);
    await open(page, level);
    await choose(page, level, "return", "New returns");
    state.scope = { ...originalScope, connectionId: 35, accountId: "different-account" };
    await page.getByRole("button", { name: "Refresh connection", exact: true }).click();
    await expect(page.getByText("or the eBay account or marketplace changed", { exact: false })).toBeVisible();
    await expect(page.getByRole("combobox", { name: `${prefix[level]} return policy`, exact: true }).filter({ visible: true })).toContainText("New returns");
    await expect(save(page, level)).toBeDisabled();
    expect(state.writes).toEqual([]);
    await page.getByRole("button", { name: "Reload saved policies", exact: true }).click();
    await expect(page.getByRole("combobox", { name: `${prefix[level]} return policy`, exact: true }).filter({ visible: true })).toContainText("Returns");
    await choose(page, level, "return", "New returns");
    await save(page, level).click();
    await expect.poll(() => state.writes.length).toBe(1);
    expect(state.writes[0].body.expectedScope).toEqual(state.scope);
    const patch = level === "category" ? (state.writes[0].body.mappings as Record<string, unknown>[])[0] : state.writes[0].body;
    expect(patch.expectedPolicies).toEqual(oldPolicies);
    expect(errors).toEqual([]); expect(unexpected).toEqual([]);
  });
}

test("a category policy can be saved before any category mapping exists", async ({ page }) => {
  const { state, errors, unexpected } = await setup(page);
  state.categoryConfigured = false;
  state.saved.category = { fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null };
  await page.reload();
  await expect(await open(page, "category")).toContainText("Use store default");
  await choose(page, "category", "shipping", "Available shipping");
  await save(page, "category").click();
  await expect.poll(() => state.saved.category.fulfillmentPolicyId).toBe("shipping");
  expect(state.writes[0].body).toEqual({ expectedScope: originalScope, mappings: [{ productTypeSlug: "toploaders",
    fulfillmentPolicyOverride: "shipping", expectedPolicies: { fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null } }] });
  await page.reload();
  await expect(await open(page, "category")).toContainText("Available shipping");
  expect(errors).toEqual([]); expect(unexpected).toEqual([]);
});
