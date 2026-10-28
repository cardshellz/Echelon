import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import type { ShopifyConnectionContext, ShopifyConnectionPreview, ShopifyProductConnectionCommand, ShopifyProductConnectionExecute, ShopifyProductConnectionRequest } from "../../shared/catalog/shopify-product-connection";

const HASH = "a".repeat(64);
const base = "/api/products/41/shopify-connection";
async function setup(page: Page, options: { productOnly?: boolean; canEdit?: boolean; saved?: boolean } = {}) {
  const context: ShopifyConnectionContext = {
    productId: 41, productName: "Graded slab binder", productSku: "BINDER", channelId: 7,
    channels: [{ id: 7, name: "Shopify", isDefault: true }], shopDomain: "test-store.myshopify.com", currency: "USD",
    mappingStatus: "unmapped", mappedProductId: null, productOnly: options.productOnly === true, blockedReason: null,
    variants: options.productOnly ? [] : [{ id: 51, sku: "BINDER-P1", name: "Each", priceCents: 1999, compareAtPriceCents: null, requiresShipping: true, trackInventory: true },
      { id: 52, sku: "BINDER-C5", name: "Case of 5", priceCents: 8995, compareAtPriceCents: null, requiresShipping: true, trackInventory: false }],
    publications: [{ id: "777", name: "Online Store" }], publicationIssue: null,
    matchingProducts: [{ id: "900", title: "Existing draft binder", status: "DRAFT" }], lookupIssue: null, pendingCommand: null,
  };
  const state = { requests: [] as ShopifyProductConnectionExecute[], reviews: [] as ShopifyProductConnectionRequest[],
    errors: [] as string[], pending: null as ShopifyProductConnectionCommand | null, loseResponse: false, finish: false, ambiguous: false, stale: false };
  const command = (intent: ShopifyProductConnectionExecute): ShopifyProductConnectionCommand => ({
    commandKey: intent.commandKey, previewHash: intent.previewHash, request: intent.request, productId: 41, channelId: 7,
    mode: intent.request.mode, state: "pending", remoteProductId: "900", lastErrorCode: null, lastErrorMessage: null, retryable: true, completedAt: null,
  });
  if (options.saved) state.pending = command({ commandKey: "00000000-0000-4000-8000-000000000041", previewHash: HASH,
    request: { channelId: 7, currency: "USD", mode: "link", targetProductRef: "900", prices: [], bindings: [], publicationId: null, productOnlyRequiresShipping: true } });
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "operator", username: "operator", role: "staff" }, roles: [],
      permissions: ["inventory:view", "channels:view", ...(options.canEdit === false ? [] : ["inventory:edit", "channels:edit"])] } });
    if (path === base) return route.fulfill({ json: { ...context, pendingCommand: state.pending } });
    if (path === `${base}/preview`) {
      const input = request.postDataJSON() as ShopifyProductConnectionRequest; state.reviews.push(input);
      const preview: ShopifyConnectionPreview = {
        previewHash: HASH, mode: input.mode, productId: 41, productName: context.productName, channelId: 7, channelName: "Shopify",
        shopDomain: context.shopDomain, currency: "USD", ready: !state.ambiguous || input.bindings.length === 2,
        issues: state.ambiguous && input.bindings.length !== 2 ? ["Select one distinct Shopify variant for each SKU."] : [],
        targetProductId: input.mode === "link" ? "900" : null, targetTitle: input.mode === "link" ? "Existing draft binder" : context.productName,
        variants: options.productOnly ? [{ variantId: null, sku: "BINDER", name: "Product", remoteVariantId: null, priceCents: input.prices[0]?.priceCents ?? null }]
          : context.variants.map((variant, index) => ({ variantId: variant.id, sku: variant.sku, name: variant.name,
            remoteVariantId: input.mode === "link" ? input.bindings.find(binding => binding.variantId === variant.id)?.remoteVariantId ?? (state.ambiguous ? null : String(901 + index)) : null,
            priceCents: input.mode === "create" ? input.prices[index]?.priceCents ?? null : variant.priceCents })),
        remoteVariants: [{ id: "901", sku: "BINDER-P1", title: "Each" }, { id: "902", sku: "BINDER-C5", title: "Case of 5" }],
        publicationName: input.publicationId ? "Online Store" : null, warnings: ["Inventory quantities continue through Channel Inventory."],
      };
      return route.fulfill({ json: preview });
    }
    if (path === `${base}/execute`) {
      const intent = request.postDataJSON() as ShopifyProductConnectionExecute; state.requests.push(intent);
      if (state.stale) return route.fulfill({ status: 409, json: { code: "SHOPIFY_PREVIEW_STALE", error: "The product changed. Refresh the review.", retryable: false } });
      state.pending ??= command(intent);
      if (state.loseResponse) { state.loseResponse = false; return route.abort("failed"); }
      return route.fulfill({ status: 202, json: { command: state.pending, replayed: false } });
    }
    if (path.startsWith(`${base}/commands/`)) {
      if (!state.pending) return route.fulfill({ status: 404, json: { code: "SHOPIFY_COMMAND_NOT_FOUND", error: "No saved command.", retryable: false } });
      if (state.finish) state.pending = { ...state.pending, state: "complete", completedAt: "2026-10-28T12:00:00.000Z" };
      return route.fulfill({ json: state.pending });
    }
    state.errors.push(`Unexpected ${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: "Unexpected browser request" } });
  });
  await page.route("**/shopify-product-connection-test", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/@fs/${resolve("test/browser/fixtures/shopify-product-connection-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto("/shopify-product-connection-test");
  return state;
}

test("links the existing native draft from a product with variants, without a store-wide sync", async ({ page }, info) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Link existing Shopify product", exact: true }).click();
  await page.getByRole("button", { name: "Link this product", exact: true }).click();
  await page.getByRole("button", { name: "Review Shopify connection", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm Shopify link", exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath("shopify-link-review.png"), fullPage: true });
  await page.getByRole("button", { name: "Confirm Shopify link", exact: true }).click();
  await expect(page.getByText("This product has a saved Shopify command to finish.")).toBeVisible();
  expect(state.requests[0].request).toMatchObject({ mode: "link", targetProductRef: "900", prices: [], publicationId: null });
  state.finish = true;
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(state.errors).toEqual([]);
});

test("creates a draft with reviewed integer prices and an explicit publication choice", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Create on Shopify", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Shopify visibility" })).toContainText("Create as unpublished draft");
  await page.locator("#shopify-price-51").fill("0.00");
  await page.locator("#shopify-price-52").fill("12.345");
  await page.getByRole("button", { name: "Review Shopify connection", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("at most two decimal places"); expect(state.reviews).toHaveLength(0);
  await page.locator("#shopify-price-52").fill("89.95");
  await page.getByRole("combobox", { name: "Shopify visibility" }).click();
  await page.getByRole("option", { name: "Create and publish to Online Store", exact: true }).click();
  await page.getByRole("button", { name: "Review Shopify connection", exact: true }).click();
  await page.getByRole("button", { name: "Create, connect and publish", exact: true }).click();
  await expect.poll(() => state.requests.length).toBe(1);
  expect(state.requests[0].request).toMatchObject({ publicationId: "777", prices: [{ variantId: 51, priceCents: 0, compareAtPriceCents: null }, { variantId: 52, priceCents: 8995, compareAtPriceCents: null }] });
  expect(state.errors).toEqual([]);
});

test("retains the command key after a lost response and resumes after reloading", async ({ page }) => {
  const state = await setup(page); state.loseResponse = true;
  await page.getByRole("button", { name: "Link existing Shopify product", exact: true }).click();
  await page.getByRole("button", { name: "Review Shopify connection", exact: true }).click();
  await page.getByRole("button", { name: "Confirm Shopify link", exact: true }).click();
  await expect(page.getByText("This product has a saved Shopify command to finish.")).toBeVisible();
  const original = state.requests[0]; await page.reload();
  await page.getByRole("button", { name: "Link existing Shopify product", exact: true }).click();
  await page.getByRole("button", { name: "Resume saved Shopify command", exact: true }).click();
  await expect.poll(() => state.requests.length).toBe(2); expect(state.requests[1]).toEqual(original);
  state.finish = true; await expect(page.getByRole("dialog")).not.toBeVisible(); expect(state.errors).toEqual([]);
});

test("supports a product without warehouse variants and fits the mobile viewport", async ({ page }) => {
  const state = await setup(page, { productOnly: true });
  await page.getByRole("button", { name: "Create on Shopify", exact: true }).click();
  await page.getByLabel("This product requires shipping").uncheck();
  await page.locator("#shopify-price-product").fill("12.50");
  await page.getByRole("button", { name: "Review Shopify connection", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create draft and connect", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Create draft and connect", exact: true }).click();
  await expect.poll(() => state.requests.length).toBe(1);
  expect(state.requests[0].request).toMatchObject({ productOnlyRequiresShipping: false, publicationId: null, prices: [{ variantId: null, priceCents: 1250 }] });
  expect(state.errors).toEqual([]);
});

test("refuses writes without both inventory and channel edit permissions", async ({ page }) => {
  const state = await setup(page, { canEdit: false });
  await expect(page.getByRole("button", { name: "Create on Shopify", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Link existing Shopify product", exact: true })).toBeDisabled();
  expect(state.requests).toEqual([]); expect(state.errors).toEqual([]);
});

test("a stale preview returns to review without leaving a phantom pending command", async ({ page }) => {
  const state = await setup(page); state.stale = true;
  await page.getByRole("button", { name: "Link existing Shopify product", exact: true }).click();
  await page.getByRole("button", { name: "Review Shopify connection", exact: true }).click();
  await page.getByRole("button", { name: "Confirm Shopify link", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("The product changed");
  await expect(page.getByRole("button", { name: "Refresh review", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Confirm Shopify link", exact: true })).toBeDisabled();
  expect(state.errors).toEqual([]);
});
