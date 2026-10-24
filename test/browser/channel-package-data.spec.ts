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

test("saving shipping type preserves exact existing package measurements and persists on reload", async ({ page }, info) => {
  const state = await catalog(page);
  await page.goto("/products/1?tab=variants&variantId=101");
  const dialog = page.getByRole("dialog", { name: "Edit Variant" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Shipping package type")).toContainText("Unspecified");
  await dialog.getByLabel("Shipping package type").click();
  await page.getByRole("option", { name: "Parcel / thick envelope", exact: true }).click();
  await dialog.getByRole("button", { name: "Save Changes", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].shippingPackageType).toBe("parcel");
  for (const field of ["weightGrams", "lengthMm", "widthMm", "heightMm"]) expect(state.writes[0]).not.toHaveProperty(field);
  expect(state.variant).toMatchObject({ weightGrams: 3175.25, lengthMm: 152.41, widthMm: 101.61, heightMm: 25.41 });
  await page.reload();
  await expect(dialog.getByLabel("Shipping package type")).toContainText("Parcel / thick envelope");
  await page.screenshot({ path: info.outputPath("package-type-editor.png"), fullPage: true });
});

test("clearing catalog type is explicit, failure stays visible, and untouched measurements are omitted", async ({ page }) => {
  const state = await catalog(page); state.variant.shippingPackageType = "letter"; state.reject = true;
  await page.goto("/products/1?tab=variants&variantId=101");
  const dialog = page.getByRole("dialog", { name: "Edit Variant" });
  await dialog.getByLabel("Shipping package type").click();
  await page.getByRole("option", { name: "Unspecified — preserve channel value", exact: true }).click();
  await dialog.getByRole("button", { name: "Save Changes", exact: true }).click();
  await expect(page.getByText("Package could not be saved. Refresh and retry.", { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(state.writes[0]).toHaveProperty("shippingPackageType", null);
  expect(state.writes[0]).not.toHaveProperty("weightGrams");
  expect(state.variant.shippingPackageType).toBe("letter");
});

for (const field of ["package_dimensions", "package_type"] as const) {
  test(`${field} blocker names the variant and opens its actual catalog editor`, async ({ page }) => {
    const feed = await setupEbayChannelPage(page);
    const id = "6e4d8e03-3197-4d21-a6d7-aa1ddaecc775";
    const issue = resolveEbayListingIssue({ code: "CHANNEL_LISTING_VALIDATION_FAILED", productId: 1, jobId: id,
      validation: { field, reason: "required", productId: 1, variantId: 101, variantSku: "PACKAGE-TEST" } });
    feed.jobs = [{ id, productId: 1, state: "needs_attention", code: issue.code, message: issue.message, issue,
      nextAttemptAt: "2026-10-24T22:00:00Z", updatedAt: "2026-10-24T22:00:00Z" }];
    await page.reload();
    const link = page.getByRole("link", { name: "Open product variants", exact: true });
    await expect(link).toHaveAttribute("href", "/products/1?tab=variants&variantId=101");
    await expect(page.getByText(issue.message, { exact: true })).toBeVisible();
    const state = await catalog(page);
    await link.click();
    await expect(page.getByRole("dialog", { name: "Edit Variant" })).toBeVisible();
    await expect(page.getByLabel("Shipping package type")).toContainText("Unspecified");
    expect(state.writes).toEqual([]); expect(feed.commands).toEqual([]);
  });
}
