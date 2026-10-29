import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import type { InventoryStockSendContext, InventoryStockSendRequest, InventoryStockSendReceipt, InventoryStockSendProgress } from "../../shared/types/inventory-stock-send";

const root = "/api/inventory-planning/admin/stock-send";
async function setup(page: Page, options: { surface?: "catalog" | "channel" | "preview"; canSend?: boolean } = {}) {
  const state = { requests: [] as InventoryStockSendRequest[], receipt: null as InventoryStockSendReceipt | null,
    loseResponse: false, progressUnavailable: false, verified: false, failed: false, wrongProgress: false, stale: false,
    paused: false, hash: "a".repeat(64), errors: [] as string[] };
  const context: InventoryStockSendContext = { productId: 41, productName: "Graded slab binder", blockers: [],
    variants: [{ id: 51, sku: "BINDER-P1", name: "Each", eligible: true }, { id: 52, sku: "BINDER-C5", name: "Case of 5", eligible: true },
      { id: 53, sku: "BINDER-UNTRACKED", name: "Untracked", eligible: false }],
    targets: [{ id: 9, channelId: 7, channelName: "Test Shopify", externalScopeId: "123", label: "Test Shopify · Shopify location 123", blockers: [] },
      { id: 10, channelId: 7, channelName: "Test Shopify", externalScopeId: "456", label: "Test Shopify · Shopify location 456", blockers: [] }] };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "operator", username: "operator", role: "staff" }, roles: [],
      permissions: ["channels:view", "inventory:view", "inventory:edit", "channels:edit", "inventory_planning:view", ...(options.canSend === false ? [] : ["inventory_planning:activate"])] } });
    if (path === "/api/products/41/shopify-mapping") return route.fulfill({ json: { productId: 41, productName: context.productName,
      productSku: "BINDER", catalogProductId: "900", channel: { id: 7, name: "Test Shopify" }, status: "consistent", evidenceProductIds: ["900"],
      recommendedProductId: null, repairable: false, activeVariantCount: 2, archivedVariantCount: 0, activeVariantIssueIds: [],
      variants: context.variants.slice(0, 2).map((variant, index) => ({ variantId: variant.id, sku: variant.sku, isActive: true,
        catalogVariantId: String(901 + index), feedId: 11 + index, feedIsActive: true, feedProductId: "900", feedVariantId: String(901 + index),
        listingId: 21 + index, listingProductId: "900", listingVariantId: String(901 + index) })) } });
    if (path === "/api/channels") return route.fulfill({ json: [{ id: 7, name: "Test Shopify", provider: "shopify", status: "active", isDefault: 1 }] });
    if (path === "/api/products") return route.fulfill({ json: [{ id: 41, name: context.productName, sku: "BINDER", shopifyProductId: "900", isActive: true }] });
    if (path === "/api/channels/7/listings") return route.fulfill({ json: [] });
    if (path === "/api/inventory-planning/runtime-authority") return route.fulfill({ json: { contractVersion: "inventory_runtime_authority_readout_v1",
      authority: "canonical", liveAllocator: "inventory_exposure", revision: "2", activationRunId: "1", changedBy: "operator", changeReason: "Fixture", changedAt: "2026-10-29T12:00:00.000Z" } });
    if (path === root + "/context") return route.fulfill({ json: { ...context, blockers: state.paused ? ["All-channel stock updates are paused."] : [] } });
    if (path === root + "/review") {
      const selection = request.postDataJSON();
      return route.fulfill({ json: { ...selection, reviewHash: state.hash, ready: !state.paused, blockers: state.paused ? ["All-channel stock updates are paused."] : [],
        rows: selection.productVariantIds.map((id: number) => ({ productVariantId: id, sku: context.variants.find(variant => variant.id === id)!.sku,
          quantity: id === 51 ? "17" : "0", externalInventoryItemId: String(950 + id) })) } });
    }
    if (path === root + "/send") {
      const command = request.postDataJSON() as InventoryStockSendRequest; state.requests.push(command);
      if (state.stale) { state.stale = false; state.hash = "b".repeat(64); return route.fulfill({ status: 409,
        json: { error: { code: "STOCK_SEND_REVIEW_STALE", message: "Stock changed. Check the current quantities before sending.", definitiveRejected: true } } }); }
      const replayed = state.receipt?.idempotencyKey === command.idempotencyKey;
      if (!replayed) state.receipt = { productId: command.productId, publicationTargetId: command.publicationTargetId, productVariantIds: command.productVariantIds,
        idempotencyKey: command.idempotencyKey, reviewHash: command.expectedReviewHash, requestedAt: "2026-10-29T12:00:00.000Z", requestedBy: "operator",
        channelId: 7, channelName: "Test Shopify", location: command.publicationTargetId === 9 ? "123" : "456",
        rows: command.productVariantIds.map((id, index) => ({ productVariantId: id, sku: context.variants.find(variant => variant.id === id)!.sku,
          quantity: id === 51 ? "17" : "0", externalInventoryItemId: String(950 + id), outboxId: String(index + state.requests.length * 100), revision: String(state.requests.length) })) };
      if (state.loseResponse) { state.loseResponse = false; return route.abort("failed"); }
      return route.fulfill({ status: 202, json: { receipt: state.receipt, replayed } });
    }
    if (path.startsWith(root + "/commands/")) {
      if (state.progressUnavailable) return route.fulfill({ status: 503, json: { error: { message: "Status unavailable", definitiveRejected: false } } });
      if (!state.receipt) return route.fulfill({ status: 404, json: { error: { message: "Not recorded yet", definitiveRejected: true } } });
      const progress: InventoryStockSendProgress = { receipt: state.receipt,
        rows: state.receipt.rows.map(row => ({ productVariantId: row.productVariantId, outboxId: state.wrongProgress ? "999" : row.outboxId,
          state: state.failed ? "dead_letter" : state.verified ? "verified" : "queued", errorCode: state.failed ? "PERMISSION_DENIED" : null,
          errorMessage: state.failed ? "Shopify refused the inventory update." : null,
          observedQuantity: state.verified ? row.quantity : null, observedAt: state.verified ? "2026-10-29T12:00:05.000Z" : null })) };
      return route.fulfill({ json: progress });
    }
    state.errors.push(`Unexpected ${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: { message: "Unexpected request" } } });
  });
  await page.route("**/stock-send-fixture**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script>
    <body><div id="root"></div><script type="module" src="/@fs/${resolve("test/browser/fixtures/shopify-inventory-send-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto(`/stock-send-fixture?surface=${options.surface ?? "catalog"}`);
  return state;
}
async function choose(page: Page, sku = "BINDER-P1", fixed = false) {
  await expect(page.getByRole("button", { name: "Send inventory", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Send inventory", exact: true }).click();
  if (!fixed) {
    await page.getByLabel("Shopify location", { exact: true }).click();
    await page.getByRole("option", { name: "Test Shopify · Shopify location 123", exact: true }).click();
  }
  await page.getByRole("checkbox", { name: `Send ${sku}`, exact: true }).check();
  await expect(page.getByLabel("Inventory to send", { exact: true })).toBeVisible();
}

for (const surface of ["catalog", "channel"] as const) test(`sends one variant from the actual ${surface} surface, then waits for exact Shopify verification`, async ({ page }, info) => {
  const state = await setup(page, { surface });
  await choose(page);
  await expect(page.getByRole("checkbox", { name: "Send BINDER-UNTRACKED", exact: true })).toBeDisabled();
  const dialog = await page.getByRole("dialog").boundingBox();
  expect(dialog).not.toBeNull();
  expect(dialog!.x).toBeGreaterThanOrEqual(0);
  expect(dialog!.x + dialog!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await page.screenshot({ path: info.outputPath(`${surface}-inventory-review.png`), fullPage: true });
  await page.getByRole("button", { name: "Send selected inventory", exact: true }).click();
  await expect(page.getByText("Stock update recorded", { exact: true })).toBeVisible();
  expect(state.requests).toHaveLength(1);
  expect(state.requests[0]).toMatchObject({ productId: 41, publicationTargetId: 9, productVariantIds: [51] });
  await expect(page.getByText("Inventory verified at Shopify", { exact: true })).not.toBeVisible();
  state.verified = true;
  await expect(page.getByText("Inventory verified at Shopify", { exact: true })).toBeVisible();
  expect(state.errors).toEqual([]);
});
test("keeps a lost-response command across reload and retries its exact original key and selection", async ({ page }) => {
  const state = await setup(page);
  state.loseResponse = true; state.progressUnavailable = true;
  await choose(page); await page.getByRole("button", { name: "Send selected inventory", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry same send", exact: true })).toBeEnabled();
  const original = state.requests[0];
  await page.reload();
  await page.getByRole("button", { name: "Send inventory", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry same send", exact: true })).toBeEnabled();
  state.progressUnavailable = false;
  await page.getByRole("button", { name: "Retry same send", exact: true }).click();
  await expect(page.getByText("Stock update recorded", { exact: true })).toBeVisible();
  expect(state.requests).toHaveLength(2); expect(state.requests[1]).toEqual(original); expect(state.errors).toEqual([]);
});
test("a stale review requires current quantities and a new command rather than replaying the rejected selection", async ({ page }) => {
  const state = await setup(page); state.stale = true;
  await choose(page); await page.getByRole("button", { name: "Send selected inventory", exact: true }).click();
  await expect(page.getByText("Stock changed. Check the current quantities before sending.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send selected inventory", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Send selected inventory", exact: true }).click();
  await expect(page.getByText("Stock update recorded", { exact: true })).toBeVisible();
  expect(state.requests[1].idempotencyKey).not.toBe(state.requests[0].idempotencyKey);
  expect(state.requests[1].expectedReviewHash).toBe("b".repeat(64)); expect(state.errors).toEqual([]);
});
test("sends a legitimate zero to the fixed stock-preview location and reports provider rejection", async ({ page }) => {
  const state = await setup(page, { surface: "preview" }); state.failed = true;
  await choose(page, "BINDER-C5", true);
  await expect(page.getByText("0 units of this SKU", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Shopify location", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Send selected inventory", exact: true }).click();
  await expect(page.getByText("Delivery failed", { exact: true })).toBeVisible();
  await expect(page.getByText("Shopify refused the inventory update.", { exact: true })).toBeVisible();
  expect(state.requests[0]).toMatchObject({ publicationTargetId: 9, productVariantIds: [52] }); expect(state.errors).toEqual([]);
});
test("does not show another outbox row's verification as success", async ({ page }) => {
  const state = await setup(page); state.wrongProgress = true; state.verified = true;
  await choose(page); await page.getByRole("button", { name: "Send selected inventory", exact: true }).click();
  await expect(page.getByText("Delivery status is unavailable. Sending again is not needed to reload its status.", { exact: true })).toBeVisible();
  await expect(page.getByText("Inventory verified at Shopify", { exact: true })).not.toBeVisible(); expect(state.errors).toEqual([]);
});
test("honors activation permission", async ({ page }) => {
  const readonly = await setup(page, { canSend: false });
  await expect(page.getByRole("button", { name: "Send inventory", exact: true })).toBeDisabled();
  expect(readonly.requests).toEqual([]);
});
test("blocks a manual send while all-channel stock updates are paused", async ({ page }) => {
  const state = await setup(page); state.paused = true;
  await page.getByRole("button", { name: "Send inventory", exact: true }).click();
  await page.getByLabel("Shopify location", { exact: true }).click();
  await page.getByRole("option", { name: "Test Shopify · Shopify location 123", exact: true }).click();
  await page.getByRole("checkbox", { name: "Send BINDER-P1", exact: true }).check();
  await expect(page.getByText("All-channel stock updates are paused.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send selected inventory", exact: true })).toBeDisabled();
  expect(state.requests).toEqual([]); expect(state.errors).toEqual([]);
});
test("does not restore a saved command for a different product into this widget", async ({ page }) => {
  const state = await setup(page);
  await page.evaluate(() => sessionStorage.setItem("inventory-stock-send:v1:operator:41:all:all", JSON.stringify({ productId: 42,
    publicationTargetId: 9, productVariantIds: [51], idempotencyKey: "11111111-1111-4111-8111-111111111111", expectedReviewHash: "a".repeat(64) })));
  await page.getByRole("button", { name: "Send inventory", exact: true }).click();
  await expect(page.getByText("The saved stock-send request cannot be read. Its outcome must be checked before starting another send.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send selected inventory", exact: true })).toBeDisabled();
  expect(state.requests).toEqual([]);
});
test("starts a fresh explicit update after verification while retaining its SKU and location scope", async ({ page }) => {
  const state = await setup(page); state.verified = true;
  await choose(page); await page.getByRole("button", { name: "Send selected inventory", exact: true }).click();
  await expect(page.getByText("Inventory verified at Shopify", { exact: true })).toBeVisible();
  const first = state.requests[0];
  state.verified = false;
  await page.getByRole("button", { name: "Send another update", exact: true }).click();
  await page.getByRole("checkbox", { name: "Send BINDER-P1", exact: true }).check();
  await expect(page.getByRole("button", { name: "Send selected inventory", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Send selected inventory", exact: true }).click();
  await expect(page.getByText("Stock update recorded", { exact: true })).toBeVisible();
  expect(state.requests).toHaveLength(2);
  expect(state.requests[1]).toMatchObject({ productId: first.productId, publicationTargetId: first.publicationTargetId, productVariantIds: first.productVariantIds });
  expect(state.requests[1].idempotencyKey).not.toBe(first.idempotencyKey);
  await expect(page.getByText("Inventory verified at Shopify", { exact: true })).not.toBeVisible();
  expect(state.errors).toEqual([]);
});
