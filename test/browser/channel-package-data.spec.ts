import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { setupEbayChannelPage } from "./fixtures/ebay-channel-page.fixture";
import { resolveEbayListingIssue } from "../../shared/ebay-listing-issue";

async function catalog(page: Page) {
  const state = { writes: [] as Record<string, unknown>[], reject: false,
    variant: { id: 101, productId: 1, sku: "PACKAGE-TEST", name: "Each", uomType: "each", isActive: true, isBaseUnit: true,
      unitsPerVariant: 1, hierarchyLevel: 1, parentVariantId: null, salesEligibility: "sellable", requiresShipping: true,
      weightGrams: 3175.25, lengthMm: 152.41, widthMm: 101.61, heightMm: 25.41, shippingPackageType: null as string | null } };
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.startsWith("/api/ebay/")) return route.fallback();
    if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "operator", username: "operator", role: "staff" },
      permissions: ["inventory:view", "inventory:edit"], roles: [] } });
    if (path === "/api/products/1") return route.fulfill({ json: { id: 1, productId: 1, sku: "PACKAGE", name: "Package test product",
      isActive: true, status: "active", baseUnit: "piece", inventoryTrackingDefault: true, inventoryStrategy: "physical_only",
      variants: [state.variant], assets: [] } });
    if (path === "/api/product-variants/101" && request.method() === "PUT") {
      const body = request.postDataJSON(); state.writes.push(body);
      if (state.reject) return route.fulfill({ status: 409, json: { error: "Package could not be saved. Refresh and retry." } });
      Object.assign(state.variant, body); return route.fulfill({ json: state.variant });
    }
    return route.fulfill({ json: [] });
  });
  await page.route("**/products/1?tab=variants**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><main id="root"></main><script type="module" src="/@fs/${resolve("test/browser/fixtures/catalog-images-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  return state;
}

test("package editor saves dimensions without a type and preserves untouched measurements", async ({ page }, info) => {
  const state = await catalog(page);
  // Even an old API response cannot reintroduce the retired Catalog writer.
  state.variant.shippingPackageType = "letter";
  await page.goto("/products/1?tab=variants&variantId=101");
  const dialog = page.getByRole("dialog", { name: "Edit Variant" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Shipping package type")).toHaveCount(0);
  await dialog.getByLabel("Length (in)", { exact: true }).fill("7");
  await dialog.getByRole("button", { name: "Save Changes", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toHaveProperty("lengthMm", 177.8);
  for (const field of ["shippingPackageType", "weightGrams", "widthMm", "heightMm"]) expect(state.writes[0]).not.toHaveProperty(field);
  expect(state.variant).toMatchObject({ weightGrams: 3175.25, lengthMm: 177.8, widthMm: 101.61, heightMm: 25.41, shippingPackageType: "letter" });
  await page.reload();
  await expect(dialog.getByLabel("Length (in)", { exact: true })).toHaveValue("7");
  await expect(dialog.getByLabel("Shipping package type")).toHaveCount(0);
  await dialog.getByLabel("Length (in)", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("package-measurements-editor.png"), fullPage: true });
});

test("a measurement save failure remains visible without sending or changing package type", async ({ page }) => {
  const state = await catalog(page); state.reject = true;
  await page.goto("/products/1?tab=variants&variantId=101");
  const dialog = page.getByRole("dialog", { name: "Edit Variant" });
  await dialog.getByLabel("Length (in)", { exact: true }).fill("7");
  await dialog.getByRole("button", { name: "Save Changes", exact: true }).click();
  await expect(page.getByText("Package could not be saved. Refresh and retry.", { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(state.writes[0]).not.toHaveProperty("shippingPackageType");
  expect(state.writes[0]).not.toHaveProperty("weightGrams");
  expect(state.variant.lengthMm).toBe(152.41);
});

test("a genuine dimensions blocker still opens the exact variant's measurement editor", async ({ page }) => {
  const feed = await setupEbayChannelPage(page);
  const id = "6e4d8e03-3197-4d21-a6d7-aa1ddaecc775";
  const issue = resolveEbayListingIssue({ code: "CHANNEL_LISTING_VALIDATION_FAILED", productId: 1, jobId: id,
    validation: { field: "package_dimensions", reason: "required", productId: 1, variantId: 101, variantSku: "PACKAGE-TEST" } });
  feed.jobs = [{ id, productId: 1, state: "needs_attention", code: issue.code, message: issue.message, issue,
    nextAttemptAt: "2026-10-24T22:00:00Z", updatedAt: "2026-10-24T22:00:00Z" }];
  await page.reload();
  const link = page.getByRole("link", { name: "Open product variants", exact: true });
  await expect(link).toHaveAttribute("href", "/products/1?tab=variants&variantId=101");
  await expect(page.getByText(issue.message, { exact: true })).toBeVisible();
  const state = await catalog(page);
  await link.click();
  const dialog = page.getByRole("dialog", { name: "Edit Variant" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Length (in)", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Shipping package type")).toHaveCount(0);
  expect(state.writes).toEqual([]); expect(feed.commands).toEqual([]);
});

test("a completed update retains its optional dimensions warning in the feed and saved status", async ({ page }) => {
  const state = await setupEbayChannelPage(page);
  const id = "6e4d8e03-3197-4d21-a6d7-aa1ddaecc775";
  state.jobs = [{ id, productId: 1, operation: "sync", state: "completed", code: null, message: null,
    nextAttemptAt: "2026-10-25T22:00:00Z", updatedAt: "2026-10-25T22:00:00Z",
    warnings: [{ code: "CHANNEL_PACKAGE_DIMENSIONS_MISSING", field: "package_dimensions", productId: 1,
      variantId: 101, variantSku: "PACKAGE-TEST" }] }];
  await page.reload();
  const warning = page.getByRole("region", { name: "Listing warnings" });
  await expect(warning).toContainText("PACKAGE-TEST: package dimensions are missing. Shipping estimates may be inaccurate.");
  await expect(warning.getByRole("link", { name: "Edit package dimensions" })).toHaveAttribute("href", "/products/1?tab=variants&variantId=101");
  await expect(page.getByRole("button", { name: "Sync", exact: true }).last()).toBeEnabled();
  await page.getByRole("button", { name: "View update status", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Listing update status" });
  await expect(dialog.getByRole("region", { name: "Listing warnings" })).toContainText("PACKAGE-TEST");
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await page.reload();
  await expect(warning).toBeVisible();
  expect(state.commands).toEqual([]);
  expect(state.errors).toEqual([]);
});

for (const operation of ["publish", "sync"] as const) {
  test(`normal Sync completes ${operation} with missing dimensions as a persistent warning`, async ({ page }, info) => {
    const state = await setupEbayChannelPage(page);
    const id = "6e4d8e03-3197-4d21-a6d7-aa1ddaecc775";
    const issue = resolveEbayListingIssue({ code: "CHANNEL_LISTING_VALIDATION_FAILED", productId: 1, jobId: id,
      validation: { field: "package_dimensions", reason: "required", productId: 1, variantId: 101, variantSku: "PACKAGE-TEST" } });
    const failed = { id, productId: 1, operation, state: "needs_attention", code: issue.code, message: issue.message, issue,
      nextAttemptAt: "2026-10-28T12:00:00Z", updatedAt: "2026-10-28T12:00:00Z" };
    state.jobs = [failed];
    if (operation === "publish") { state.feedStatus = "publication_incomplete"; state.externalListingId = null; }
    await page.reload();
    const queued = { id, productId: 1, operation, state: "queued", code: null, message: null,
      nextAttemptAt: "2026-10-28T12:01:00Z", updatedAt: "2026-10-28T12:01:00Z" };
    state.response = { synced: 0, errors: 0, pending: 1, priceChanges: 0, qtyChanges: 0, policyChanges: 0, details: [], jobs: [queued] };
    await page.getByTitle("Sync this listing", { exact: true }).filter({ visible: true }).click();
    await expect(page.getByRole("status", { name: "Sync status for 55PT Toploader Combo Pack" })).toContainText("Queued for eBay");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    state.jobs = [{ ...queued, state: "completed", warnings: [{ code: "CHANNEL_PACKAGE_DIMENSIONS_MISSING", field: "package_dimensions",
      productId: 1, variantId: 101, variantSku: "PACKAGE-TEST" }] }];
    state.feedStatus = "listed"; state.externalListingId = "verified-listing";
    await page.reload();
    await expect(page.getByRole("button", { name: "Errors (0)", exact: true })).toBeVisible();
    const warning = page.getByRole("region", { name: "Listing warnings" });
    await expect(warning).toContainText("PACKAGE-TEST: package dimensions are missing. Shipping estimates may be inaccurate.");
    await expect(warning.getByRole("link", { name: "Edit package dimensions", exact: true }))
      .toHaveAttribute("href", "/products/1?tab=variants&variantId=101");
    await expect(page.getByTitle("Sync this listing", { exact: true }).filter({ visible: true })).toBeEnabled();
    if (operation === "sync") {
      await page.getByRole("button", { name: "View update status", exact: true }).click();
      await expect(page.getByRole("dialog").getByRole("region", { name: "Listing warnings" })).toContainText("PACKAGE-TEST");
    }
    await page.screenshot({ path: info.outputPath(`optional-dimensions-${operation}.png`), fullPage: true });
    expect(state.requests).toEqual(["/api/ebay/listings/sync-product/1"]);
    expect(state.commands).toHaveLength(1);
    expect(failed).toMatchObject({ state: "needs_attention", code: "CHANNEL_LISTING_VALIDATION_FAILED" });
    expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
  });
}

test("an actual provider dimension refusal stays visible and normal Sync can retry after correction", async ({ page }) => {
  const state = await setupEbayChannelPage(page);
  const id = "6e4d8e03-3197-4d21-a6d7-aa1ddaecc775";
  const message = "eBay rejected this update (HTTP 400; codes 25002). Package dimensions are required by the selected shipping service.";
  const issue = resolveEbayListingIssue({ code: "EBAY_QUANTITY_REJECTED", message, productId: 1, jobId: id });
  const refused = { id, productId: 1, operation: "publish", state: "needs_attention", code: issue.code, message, issue,
    nextAttemptAt: "2026-10-28T12:00:00Z", updatedAt: "2026-10-28T12:00:00Z" };
  state.feedStatus = "publication_incomplete"; state.externalListingId = null; state.jobs = [refused];
  await page.reload();
  await expect(page.getByText(message, { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open listing settings", exact: true })).toHaveAttribute("href", "/products/1?tab=channels");
  expect(state.requests).toEqual([]);
  state.response = { synced: 0, errors: 0, pending: 1, priceChanges: 0, qtyChanges: 0, policyChanges: 0, details: [],
    jobs: [{ ...refused, state: "queued", code: null, message: null, issue: undefined }] };
  await page.getByTitle("Sync this listing", { exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole("status", { name: "Sync status for 55PT Toploader Combo Pack" })).toContainText("Queued for eBay");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.requests).toEqual(["/api/ebay/listings/sync-product/1"]);
  expect(refused.message).toBe(message);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a historical package-type failure offers the normal sync action instead of a removed editor", async ({ page }) => {
  const feed = await setupEbayChannelPage(page);
  const id = "6e4d8e03-3197-4d21-a6d7-aa1ddaecc775";
  const issue = resolveEbayListingIssue({ code: "CHANNEL_LISTING_VALIDATION_FAILED", productId: 1, jobId: id,
    message: "Shipping package type is required for PACKAGE-TEST.",
    validation: { field: "package_type", reason: "required", productId: 1, variantId: 101, variantSku: "PACKAGE-TEST" } });
  feed.jobs = [{ id, productId: 1, state: "needs_attention", code: issue.code, message: issue.message, issue,
    nextAttemptAt: "2026-10-24T22:00:00Z", updatedAt: "2026-10-24T22:00:00Z" }];
  feed.response = { synced: 1, errors: 0, priceChanges: 0, qtyChanges: 0, policyChanges: 0, details: [{ success: true }] };
  await page.reload();
  await expect(page.getByText(issue.message, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open product variants", exact: true })).toHaveCount(0);
  expect(feed.requests).toEqual([]);
  await page.getByRole("button", { name: "Retry Sync", exact: true }).click();
  await expect.poll(() => feed.requests).toEqual(["/api/ebay/listings/sync-product/1"]);
  expect(feed.errors).toEqual([]);
});
