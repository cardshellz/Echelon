import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ChannelCatalogRow } from "../../shared/types/channel-catalog";
import { listingDraftItemSchema, listingOperationSchema } from "../../shared/types/channel-listing-publication";
import { createMembershipMock, createPublicationMock, handleMembershipRequest, handlePublicationRequest, PUBLICATION_BASE } from "./walmart-publication-fixtures";
import { editorSchema } from "../../server/modules/channels/adapters/walmart/walmart-listing-schema";
import { createListingUpdateMock, handleListingUpdateRequest, listingChangeHistory, UPDATE_BASE } from "./walmart-listing-update-fixtures";

const BASE = "/api/channels/77";
const status = { channelId: 77, connectionId: 9, partnerId: "10002558022", partnerName: "Card Shellz", environment: "production",
  shipNodeId: "10002558022", warehouseId: 1, ordersEnabled: true, importSince: "2026-09-13T11:46:00.000Z",
  lastPollAt: null, lastSuccessAt: null, lastErrorCode: null, revision: 1, mappedSkus: 0 };
const completeListingSubmission = {
  priceCents: 2499,
  title: "55PT Toploader Essentials Clear+ Easy Glide Combo Pack",
  description: "A previous description",
  brand: "Shellz",
  images: ["https://example.com/front.jpg", "https://example.com/back.jpg"],
  attributes: {
    Orderable: { ShippingWeight: 2 },
    Visible: { pieceCount: 200, keyFeatures: ["Clear sleeves", "Archival material", "Pack of 100"] },
  },
};
const listing = (sku: string, matched = true): ChannelCatalogRow => ({ sku, title: `Product ${sku}`, externalProductId: `WPID-${sku}`,
  externalVariantId: sku, externalInventoryItemId: sku, lifecycleStatus: "ACTIVE", publishedStatus: "PUBLISHED",
  mappingStatus: matched ? "matched" : "unmatched", variant: matched ? { id: 11, sku, name: "Card sleeves", eligible: true } : null, message: null });
async function setup(page: Page, options: { readOnly?: boolean; connected?: boolean; catalogError?: boolean; catalogEmpty?: boolean; remoteRows?: ChannelCatalogRow[]; blocked?: boolean; inventoryAccess?: "view" | "activate" } = {}) {
  const state = { writes: [] as { path: string; body: any }[], reads: [] as string[], errors: [] as string[], unexpected: [] as string[],
    connected: options.connected !== false, linked: false, catalogError: options.catalogError ?? false,
    remoteRows: options.remoteRows ?? (options.catalogEmpty ? [] : null), publication: createPublicationMock(), membership: createMembershipMock(), updates: createListingUpdateMock() };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/api/**", async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    if (req.method() === "GET") state.reads.push(url.pathname + url.search);
    if (await handleListingUpdateRequest(route, state.updates)) return;
    if (await handlePublicationRequest(route, state.publication)) return;
    if (await handleMembershipRequest(route, state.membership)) return;
    if (req.method() === "GET") {
      if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "operator", username: "operator", role: "lead" }, roles: ["lead"],
        permissions: [...(options.readOnly ? ["channels:view"] : ["channels:view", "channels:edit"]), ...(options.inventoryAccess ? ["inventory_planning:view"] : []), ...(options.inventoryAccess === "activate" ? ["inventory_planning:activate"] : [])] } });
      if (path === "/api/warehouses") return route.fulfill({ json: [{ id: 1, code: "LEON", name: "20 LEONBERG", isActive: 1, warehouseType: "operations" }] });
      if (path === `${BASE}/walmart`) return route.fulfill({ json: state.connected ? { ...status, orderSyncBlockedReason: options.blocked ? "Automatic order sync is disabled by server configuration." : null } : null });
      if (path === `${BASE}/walmart/exceptions`) return route.fulfill({ json: [] });
      if (path === `${BASE}/catalog/variants`) return route.fulfill({ json: [{ id: 22, sku: "LOCAL-SKU", name: "Card box", eligible: true }] });
      if (path === `${BASE}/catalog`) {
        if (state.catalogError) return route.fulfill({ status: 503, json: { error: "Walmart catalog is unavailable" } });
        const firstPage: ChannelCatalogRow[] = [
          { ...listing("CARD-P5"), mappingStatus: state.linked ? "linked" : "matched" }, listing("REMOTE-BOX", false),
        ];
        const secondPage = [listing("PAGE-2", false)];
        const items = url.searchParams.has("sku")
          ? (state.remoteRows ?? [...firstPage, ...secondPage]).filter(item => item.sku === url.searchParams.get("sku"))
          : state.remoteRows ?? (url.searchParams.has("cursor") ? secondPage : firstPage);
        return route.fulfill({ json: { items, nextCursor: state.remoteRows !== null || url.search ? null : "next-page", total: state.remoteRows?.length ?? 3 } });
      }
    }
    if (req.method() === "POST") {
      state.writes.push({ path, body: req.postDataJSON() });
      if (path === `${BASE}/catalog/mappings`) { state.linked = true; return route.fulfill({ json: { linked: 1 } }); }
      if (path === `${BASE}/walmart/verify`) return route.fulfill({ json: { partnerId: status.partnerId, partnerName: status.partnerName, nodes: [{ shipNode: status.shipNodeId, shipNodeName: "Card Shellz default" }] } });
      if (path === `${BASE}/walmart/connect`) { state.connected = true; return route.fulfill({ json: status }); }
    }
    state.unexpected.push(`${req.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: "Unexpected test request" } });
  });
  await page.route(/\/(?:__walmart-test|channels\/walmart\/77(?:\/listings\/bulk)?)(?:\?.*)?$/, route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
    </head><body><main id="root"></main><script type="module" src="/@fs/${resolve("test/browser/fixtures/walmart-channel-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto("/channels/walmart/77");
  await expect(page.getByText("Store Setup", { exact: true })).toBeVisible();
  return state;
}
test("existing listing edits include unchanged product content and shipping with a price edit", async ({ page }, info) => {
  const state = await setup(page, { remoteRows: [{ ...listing("CARD-P5"), mappingStatus: "linked", publishedStatus: "SYSTEM_PROBLEM" }] });
  state.publication.operations = [listingOperationSchema.parse({
    id: "22222222-2222-4222-8222-222222222222", channelId: 77, state: "processing", submissionId: "feed-1",
    items: [{ variantId: 11, sku: "CARD-P5", priceCents: 2499, state: "accepted", externalProductId: "WPID-CARD-P5",
      error: "Waiting for Walmart to finish item activation.", stockState: "waiting_for_item" }],
    createdAt: "2026-09-21T12:00:00.000Z", updatedAt: "2026-09-21T12:00:00.000Z", error: null,
  })];
  await page.reload();
  const submittedRow = page.getByRole("row").filter({ hasText: "CARD-P5" });
  await expect(submittedRow.getByText("SYSTEM_PROBLEM", { exact: true })).toBeVisible();
  await expect(submittedRow.getByText("Accepted · verification pending", { exact: true })).toBeVisible();
  await expect(submittedRow.getByText("Linked", { exact: true })).toBeVisible();
  await expect(submittedRow.getByRole("button", { name: "View activity", exact: true })).toBeVisible();
  await expect(submittedRow.getByRole("button", { name: "Edit listing CARD-P5", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("accepted-linked-listing-edit-action.png"), fullPage: true });
  await submittedRow.getByRole("button", { name: "Edit listing CARD-P5", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Edit Walmart listing", exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Walmart title", { exact: true })).toHaveValue("55PT Toploader Essentials Clear+ Easy Glide Combo Pack");
  await dialog.getByLabel("Walmart price (USD)", { exact: true }).fill("27.49");
  await expect(dialog.getByRole("button", { name: "Review changes", exact: true })).toBeInViewport({ ratio: 0.99 });
  await dialog.screenshot({ path: info.outputPath("existing-listing-editor.png") });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(state.updates.writes).toEqual([]);
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByText("$27.49", { exact: true })).toBeVisible();
  expect(state.updates.writes[0]).toEqual({ path: `${UPDATE_BASE}/review`, body: {
    sku: "CARD-P5", sourceHash: "a".repeat(64), productType: "Trading Card Sleeves & Holders",
    changes: { ...completeListingSubmission, priceCents: 2749 },
  } });
  expect(state.updates.updates).toEqual([]);
  await dialog.getByRole("button", { name: "Send changes to Walmart", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Listing changes", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Listing changes", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "Publication activity", exact: true })).toHaveCount(0);
  await page.getByRole("region", { name: "Listing changes", exact: true }).getByRole("button", { name: "Check Walmart status", exact: true }).click();
  await expect(page.getByText("Feed accepted", { exact: true })).toBeVisible();
  expect(state.updates.verificationReads).toEqual([]);
  await page.getByRole("button", { name: /^Show change details/ }).click();
  await expect(page.getByText("Walmart reports the submitted product type. Listing status is shown separately above.")).toBeVisible();
  expect(state.updates.writes.at(-1)?.path).toMatch(/\/status$/);
  expect(state.publication.writes).toEqual([]); expect(state.membership.writes).toEqual([]);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("existing listing edits show the actual category and edit shipping while preserving untouched content", async ({ page }, info) => {
  const state = await setup(page);
  state.updates.reportedProductType = "default";
  await page.getByRole("button", { name: "Edit listing CARD-P5", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Walmart currently reports:", { exact: false })).toContainText("default");
  await expect(dialog.getByRole("button", { name: "Review content resubmission", exact: true })).toHaveCount(0);
  await dialog.getByRole("textbox", { name: "Search listing fields", exact: true }).fill("Shipping Weight");
  await dialog.getByRole("spinbutton", { name: /^Shipping Weight \(lbs\)/ }).fill("3");
  await expect(dialog.getByRole("button", { name: "Review changes", exact: true })).toBeInViewport({ ratio: 0.99 });
  await dialog.screenshot({ path: info.outputPath("existing-listing-shipping.png") });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  expect(state.updates.reviews[0].changes).toEqual({
    ...completeListingSubmission,
    attributes: { ...completeListingSubmission.attributes, Orderable: { ShippingWeight: 3 } },
  });
  await dialog.getByRole("button", { name: "Back to edit", exact: true }).click();
  await expect(dialog.getByLabel("Walmart price (USD)", { exact: true })).toHaveValue("24.99");
  expect(state.updates.updates).toEqual([]); expect(state.errors).toEqual([]);
});

test("accepted feeds show category mismatch and recheck the item without another submission", async ({ page }, info) => {
  const state = await setup(page);
  state.updates.reportedProductType = "default";
  await page.getByRole("button", { name: "Edit listing CARD-P5", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Walmart price (USD)", { exact: true }).fill("24.98");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  // Regression: a one-cent edit with the prefilled correct type previously sent
  // only price and an empty Visible object while Walmart still reported default.
  expect(state.updates.reviews[0].changes).toEqual({
    ...completeListingSubmission,
    priceCents: 2498,
  });
  await dialog.getByRole("button", { name: "Send changes to Walmart", exact: true }).click();
  const region = page.getByRole("region", { name: "Listing changes", exact: true });
  await region.getByRole("button", { name: "Check Walmart status", exact: true }).click();
  await expect(region.getByText("Feed accepted", { exact: true })).toBeVisible();
  await region.getByRole("button", { name: /^Show change details/ }).click();
  await expect(region.getByText(/The product type is not confirmed/)).toBeVisible();
  await expect(region.getByText("default", { exact: true })).toBeVisible();
  await expect(region.getByText("SYSTEM_PROBLEM", { exact: true })).toBeVisible();
  const writes = state.updates.writes.length;
  await region.screenshot({ path: info.outputPath("walmart-category-mismatch.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  state.updates.verificationError = true;
  await region.getByRole("button", { name: "Check item on Walmart", exact: true }).click();
  await expect(region.getByRole("alert")).toHaveText("Walmart item check is unavailable");
  state.updates.verificationError = false;
  state.updates.reportedProductType = "Trading Card Sleeves & Holders";
  await region.getByRole("button", { name: "Check item on Walmart", exact: true }).click();
  await expect(region.getByText("Walmart reports the submitted product type. Listing status is shown separately above.")).toBeVisible();
  await expect(region.getByText("SYSTEM_PROBLEM", { exact: true })).toBeVisible();
  expect(state.updates.verificationReads).toHaveLength(3);
  expect(state.updates.writes).toHaveLength(writes);
  expect(state.publication.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});

for (const reportedType of ["Trading Card Sleeves & Holders", "default"]) {
test(`existing listing edits send every populated field without edits when Walmart reports ${reportedType}`, async ({ page }, info) => {
  const state = await setup(page);
  state.updates.reportedProductType = reportedType;
  await page.getByRole("button", { name: "Edit listing CARD-P5", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  expect(state.updates.reviews[0].changes).toEqual(completeListingSubmission);
  await expect(dialog.getByText("Stock quantities stay unchanged.", { exact: false })).toBeVisible();
  await expect(dialog.getByText("https://example.com/front.jpg", { exact: false })).toBeVisible();
  await expect(dialog.getByText("Shipping Weight (lbs)", { exact: true })).toBeVisible();
  await expect(dialog.getByText("$24.99", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Send changes to Walmart", exact: true })).toBeInViewport({ ratio: 0.99 });
  await dialog.screenshot({ path: info.outputPath("walmart-content-resubmission-review.png") });
  expect(state.updates.updates).toEqual([]);
  await dialog.getByRole("button", { name: "Send changes to Walmart", exact: true }).click();
  expect(state.updates.updates).toHaveLength(1);
  expect(state.publication.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});
}

test("existing listing edits reuse the command after a lost submission response and block a second in-flight update", async ({ page }) => {
  const state = await setup(page); state.updates.loseSubmissionResponse = true;
  await page.getByRole("button", { name: "Edit listing CARD-P5", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Walmart price (USD)", { exact: true }).fill("28.49");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await dialog.getByRole("button", { name: "Send changes to Walmart", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Connection interrupted");
  await dialog.getByRole("button", { name: "Send changes to Walmart", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.updates.updates).toHaveLength(1); expect(state.updates.commands).toHaveLength(2);
  expect(state.updates.commands[0]).toBe(state.updates.commands[1]);
  await page.getByRole("tab", { name: "Listing Feed", exact: true }).click();
  await page.getByRole("button", { name: "Edit listing CARD-P5", exact: true }).click();
  await expect(dialog.getByText("An update is already in progress for this listing. Check its status in Activity before sending another.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Review changes", exact: true })).toBeDisabled();
  expect(state.publication.writes).toEqual([]); expect(state.errors).toEqual([]);
});

test("existing listing edits are unavailable to viewers", async ({ page }) => {
  const state = await setup(page, { readOnly: true });
  await expect(page.getByText("Product CARD-P5", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Edit listing / })).toHaveCount(0);
  expect(state.updates.writes).toEqual([]);
});

test("existing listing edits exclude retired listings", async ({ page }) => {
  const state = await setup(page, { remoteRows: [{ ...listing("RETIRED-SKU"), lifecycleStatus: "RETIRED" }] });
  await expect(page.getByText("Product RETIRED-SKU", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Edit listing / })).toHaveCount(0);
  expect(state.updates.writes).toEqual([]);
});

test("connected workspace uses normal sections, bulk matching and pagination", async ({ page }, info) => {
  const state = await setup(page);
  await expect(page.getByRole("tab", { name: "Listing Feed", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Existing listings", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tabpanel").getByText("Listing Feed", { exact: true })).toBeVisible();
  await expect(page.getByText("Product CARD-P5", { exact: true })).toBeVisible();
  await expect(page.getByText("0 draft items", { exact: true })).toBeVisible();
  await expect(page.getByText("Automatic while this channel is active")).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable order intake" })).toHaveCount(0);
  await expect(page.getByLabel("Client Secret")).toHaveCount(0);
  await page.getByLabel("Select all actionable rows on this page").check();
  await page.getByRole("button", { name: "Link selected (1)" }).click();
  await expect(page.getByRole("status")).toHaveText("1 listing linked.");
  expect(state.writes).toEqual([{ path: `${BASE}/catalog/mappings`, body: { mappings: [{ sku: "CARD-P5", productVariantId: 11, expectedExternalProductId: "WPID-CARD-P5" }] } }]);
  expect(state.publication.writes).toEqual([]);
  await page.screenshot({ path: info.outputPath("walmart-workspace.png"), fullPage: true });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Product PAGE-2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page.getByText("Product CARD-P5", { exact: true })).toBeVisible();
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
test("searches remote listings and explicitly maps a different local SKU", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("textbox", { name: "Search exact SKU" }).fill("REMOTE-BOX");
  await page.getByRole("button", { name: "Search listings" }).click();
  await expect(page.getByText("Product CARD-P5", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Choose variant" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Find Echelon variant").fill("LOCAL");
  await page.getByRole("button", { name: "Link", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.writes[0].body).toEqual({ mappings: [{ sku: "REMOTE-BOX", productVariantId: 22, expectedExternalProductId: "WPID-REMOTE-BOX" }] });
  expect(state.errors).toEqual([]);
});
test("credentials appear only on reconnect and preserve the saved account scope", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await page.getByLabel("Client ID", { exact: true }).fill("test-client");
  await page.getByLabel("Client Secret").fill("test-secret");
  await page.getByRole("button", { name: "Verify account" }).click();
  await page.getByRole("button", { name: "Reconnect Walmart", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.writes[1]).toEqual({ path: `${BASE}/walmart/connect`, body: { clientId: "test-client", clientSecret: "test-secret", environment: "production",
    expectedPartnerId: status.partnerId, shipNodeId: status.shipNodeId, warehouseId: 1, importSince: status.importSince } });
  expect(state.errors).toEqual([]);
});
test("new connection has one save action and selects the sole supported fulfillment center", async ({ page }) => {
  const state = await setup(page, { connected: false });
  await page.getByRole("button", { name: "Connect Walmart", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await page.getByLabel("Client ID", { exact: true }).fill("test-client");
  await page.getByLabel("Client Secret").fill("test-secret");
  await page.getByRole("button", { name: "Verify account" }).click();
  await expect(page.getByLabel("Walmart fulfillment center")).toHaveValue(status.shipNodeId);
  await page.getByLabel("Echelon warehouse").selectOption("1");
  await page.getByLabel("Import orders from (your local time)").fill("2026-09-21T08:00");
  await dialog.getByRole("button", { name: "Connect Walmart", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Listing Feed", exact: true })).toBeVisible();
  expect(state.writes[1].body).not.toHaveProperty("ordersEnabled");
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});
test("read-only users can browse without connection or mapping writes", async ({ page }) => {
  const state = await setup(page, { readOnly: true });
  await expect(page.getByText("Product CARD-P5", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Link selected|Choose variant/ })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});
test("provider and server failures are visible instead of a misleading empty or automatic state", async ({ page }) => {
  await setup(page, { catalogError: true, blocked: true });
  await expect(page.getByText("Walmart catalog is unavailable", { exact: false })).toBeVisible();
  await expect(page.getByText("Disabled on server", { exact: true })).toBeVisible();
  await expect(page.getByText("No listings in this feed yet.", { exact: false })).toHaveCount(0);
});

async function selectFirstProduct(page: Page) {
  await page.getByRole("button", { name: "Add products", exact: true }).click();
  await page.getByLabel("Select CARD-1", { exact: true }).check();
  await page.getByRole("button", { name: "Add 1 to draft", exact: true }).click();
}

async function reviewSelectedDrafts(page: Page, skus: readonly string[]) {
  for (const sku of skus) await page.getByLabel(`Select ${sku}`, { exact: true }).check();
  await page.getByRole("button", { name: `Review selected (${skus.length})`, exact: true }).click();
}

async function expectPinnedListingEditor(dialog: Locator) {
  await expect.poll(() => dialog.evaluate(element => element.scrollTop)).toBe(0);
  await expect(dialog.getByRole("heading", { level: 2 })).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole("navigation", { name: "Listing editor sections", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport({ ratio: 1 });
  const footerGap = await dialog.evaluate(element => {
    const button = Array.from(element.querySelectorAll("button")).find(node => node.textContent?.trim() === "Update draft item");
    return element.getBoundingClientRect().bottom - button!.getBoundingClientRect().bottom;
  });
  // Mobile includes one explanatory line below the actions; a larger gap means
  // a hidden outer scroll container shifted the fixed header/footer out of place.
  expect(footerGap).toBeLessThan(70);
}

function seedTwoDrafts(state: Awaited<ReturnType<typeof setup>>) {
  state.publication.draft = { ...state.publication.draft, revision: 1, items: [
    listingDraftItemSchema.parse({ variantId: 1, productType: "Trading Card Accessories", brand: "First brand", priceOverrideCents: 549,
      identifier: { type: "UPC", value: "012345678905" }, attributes: { Orderable: { shippingWeight: 0.2 }, Visible: { countryOfOrigin: "US", color: "Red" } } }),
    listingDraftItemSchema.parse({ variantId: 26, productType: "Trading Card Accessories", brand: "Second brand", priceOverrideCents: 749,
      identifier: { type: "UPC", value: "036000291452" }, attributes: { Orderable: { shippingWeight: 0.4 }, Visible: { countryOfOrigin: "CN", color: "Blue" } } }),
  ] };
}

const SLEEVES_TYPE = "Trading Card Sleeves & Holders";
const KEY_FEATURE_GUIDANCE = "Describe one clear product benefit per entry. Explain the material, fit, and intended use in plain language so buyers can compare the item. Keep the features accurate for this exact selling unit and avoid repeating the same claim across entries.";
function seedSleevesDetails(state: Awaited<ReturnType<typeof setup>>) {
  seedTwoDrafts(state);
  const providerSchema = JSON.parse(readFileSync(resolve("server/modules/channels/__tests__/fixtures/walmart-listing-sleeves.schema.json"), "utf8"));
  const schema = editorSchema(providerSchema, "MP_ITEM", SLEEVES_TYPE);
  const sections = schema.properties as Record<string, Record<string, unknown>>;
  const fields = sections.Visible.properties as Record<string, Record<string, unknown>>;
  // The checked-in provider fixture omits descriptions. Add identical list/item
  // guidance solely to exercise repeated-help presentation; retain its real bounds.
  fields.keyFeatures = { ...fields.keyFeatures, description: KEY_FEATURE_GUIDANCE,
    items: { ...(fields.keyFeatures.items as object), description: KEY_FEATURE_GUIDANCE } };
  state.publication.requirementsSchema = schema;
  state.publication.taxonomy = { productTypes: [SLEEVES_TYPE], entries: [{ productType: SLEEVES_TYPE, path: ["Collectibles", "Card Protection"], description: null }] };
  state.publication.draft.items[0] = { ...state.publication.draft.items[0], productType: SLEEVES_TYPE, attributes: {
    Orderable: { ShippingWeight: 0.125, country_of_origin_substantial_transformation: "United States" },
    Visible: { condition: "New", keyFeatures: ["Clear front keeps the card visible", "Precise fit for standard cards", "Archival material protects the surface"],
      countPerPack: 100, multipackQuantity: 1, isProp65WarningRequired: "No", has_written_warranty: "No",
      netContent: { productNetContentUnit: "Each", productNetContentMeasure: 100 }, pieceCount: 100 },
  } };
}

function seedAttributeTable(state: Awaited<ReturnType<typeof setup>>, count: number) {
  const template = state.publication.catalogItems[0];
  state.publication.catalogItems = Array.from({ length: count }, (_, index) => ({
    ...template, variantId: index + 1, productId: index + 1, sku: `ROW-${String(index + 1).padStart(3, "0")}`,
    name: `Card protection ${index + 1}`,
  }));
  state.publication.draft = { ...state.publication.draft, revision: 1,
    items: state.publication.catalogItems.map(item => listingDraftItemSchema.parse({ variantId: item.variantId,
      productType: "Trading Card Accessories", identifier: item.identifier,
      attributes: { Orderable: { shippingWeight: item.variantId }, Visible: {
        dimensions: { width: item.variantId, height: 10 }, shipsInOwnContainer: false, features: ["Original feature"],
      } },
    })) };
  // Synthetic provider fields exercise scalar, nested, boolean and array controls.
  state.publication.requirementsSchema = { type: "object", required: ["Orderable", "Visible"], properties: {
    Orderable: { type: "object", title: "Shipping", required: ["shippingWeight"], properties: {
      shippingWeight: { type: "number", title: "Shipping weight", minimum: 0 },
    } },
    Visible: { type: "object", title: "Product", required: ["dimensions"], properties: {
      dimensions: { type: "object", title: "Dimensions", required: ["width", "height"], properties: {
        width: { type: "number", title: "Width", minimum: 0 }, height: { type: "number", title: "Height", minimum: 0 },
      } },
      shipsInOwnContainer: { type: "boolean", title: "Ships in own container" },
      features: { type: "array", title: "Features", items: { type: "string", maxLength: 100 } },
    } },
  } };
}

test("draft checkboxes and page selection work across filtering and tabs without selecting read-only account rows", async ({ page }) => {
  const state = await setup(page, { remoteRows: [
    { ...listing("ACCOUNT-LINKED"), mappingStatus: "linked" },
    { ...listing("ACCOUNT-UNAVAILABLE"), mappingStatus: "unavailable" },
  ] });
  seedTwoDrafts(state);
  await page.reload();
  const header = page.getByRole("checkbox", { name: "Select all actionable rows on this page", exact: true });
  await page.getByRole("checkbox", { name: "Select CARD-1", exact: true }).check();
  await expect(header).toHaveAttribute("aria-checked", "mixed");
  await expect(page.getByRole("button", { name: "Bulk edit selected (1)", exact: true })).toBeEnabled();
  await header.check();
  await expect(page.getByRole("checkbox", { name: "Select CARD-26", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Select ACCOUNT-/ })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Search exact SKU", exact: true }).fill("CARD-1");
  await page.getByRole("button", { name: "Search listings", exact: true }).click();
  await expect(page.getByText("1 outside this view", { exact: false })).toBeVisible();
  await header.uncheck();
  await expect(page.getByRole("button", { name: "Bulk edit selected (1)", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await page.getByRole("tab", { name: "Pricing Rules", exact: true }).click();
  await page.getByRole("tab", { name: "Listing Feed", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Select CARD-26", exact: true })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Select CARD-1", exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "Remove CARD-26 from draft", exact: true }).click();
  await expect(page.getByRole("button", { name: "Bulk edit selected (0)", exact: true })).toBeDisabled();
  expect(state.publication.writes).toEqual([]); expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("catalog content is displayed as actual inherited values and saving untouched fields retains inheritance", async ({ page }, info) => {
  const state = await setup(page);
  await selectFirstProduct(page);
  await page.getByRole("button", { name: "Edit CARD-1", exact: true }).click();
  await expect(page.getByLabel("Walmart title", { exact: true })).toHaveValue("Trading card protection");
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue("Protect your cards");
  await expect(page.getByLabel("Brand", { exact: true })).toHaveValue("Card Shellz");
  await expect(page.getByLabel("Image URLs", { exact: true })).toHaveValue("https://example.com/product.png");
  await expect(page.getByText("Using catalog", { exact: true }).first()).toBeVisible();
  await page.getByLabel("Description", { exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole("dialog").screenshot({ path: info.outputPath("listing-inherited-content.png") });
  await page.getByRole("button", { name: "Update draft item", exact: true }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved. No listing has been submitted.", { exact: true })).toBeVisible();
  expect(state.publication.draft.items[0]).toMatchObject({ title: null, description: null, brand: null, images: null });
  expect(state.publication.operations).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("an unavailable catalog photo preserves product identity and shows an item-scoped issue", async ({ page }) => {
  const state = await setup(page);
  seedTwoDrafts(state);
  const issue = "An uploaded catalog photo is not available to the marketplace yet. The public image address needs to be configured.";
  state.publication.catalogItems[0].imageIssues = [{ code: "CATALOG_PUBLIC_URL_REQUIRED", message: issue, field: "images" }];
  await page.reload();
  const row = page.getByRole("row").filter({ has: page.getByRole("checkbox", { name: "Select CARD-1", exact: true }) });
  await expect(row.getByText("Clear card sleeves", { exact: true })).toBeVisible();
  await expect(row.getByText("$5.49", { exact: true })).toBeVisible();
  await expect(row.getByText("A catalog photo needs attention. Open details to review it.", { exact: true })).toBeVisible();
  await expect(page.getByText("SKU unavailable", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Standard toploaders", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit CARD-1", exact: true }).click();
  await expect(page.getByLabel("Walmart title", { exact: true })).toHaveValue("Trading card protection");
  await page.getByRole("button", { name: "Jump to content", exact: true }).click();
  const issues = page.getByRole("list", { name: "Catalog photo issues", exact: true });
  await expect(issues).toHaveText(issue);
  await page.getByLabel("Image URLs", { exact: true }).fill("https://example.com/custom.jpg");
  await expect(issues).toHaveCount(0);
  await page.getByRole("button", { name: "Update draft item", exact: true }).click();
  await expect(row.getByText("A catalog photo needs attention. Open details to review it.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved. No listing has been submitted.", { exact: true })).toBeVisible();
  expect(state.publication.draft.items[0].images).toEqual(["https://example.com/custom.jpg"]);
  expect(state.publication.operations).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("the current uploaded fourth photo is inherited alongside the three external photos", async ({ page }) => {
  const state = await setup(page);
  seedTwoDrafts(state);
  const urls = ["https://example.com/primary.jpg", "https://example.com/second.jpg", "https://example.com/third.jpg",
    `https://catalog.example.com/api/catalog/images/42/${"ab".repeat(32)}.jpg`];
  state.publication.catalogItems[0].images = urls;
  await page.reload();
  await page.getByRole("button", { name: "Edit CARD-1", exact: true }).click();
  await expect(page.getByLabel("Image URLs", { exact: true })).toHaveValue(urls.join("\n"));
  await expect(page.getByRole("list", { name: "Catalog photo issues", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Update draft item", exact: true }).click();
  expect(state.publication.draft.items[0].images).toBeNull();
  expect(state.publication.operations).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("returning to an open editor refreshes catalog images without replacing custom values", async ({ page }) => {
  const state = await setup(page);
  await selectFirstProduct(page);
  await page.getByRole("button", { name: "Edit CARD-1", exact: true }).click();
  const images = page.getByLabel("Image URLs", { exact: true });
  await expect(images).toHaveValue("https://example.com/product.png");
  await page.getByLabel("Walmart title", { exact: true }).fill("My edited title");
  const updated = ["https://example.com/new.jpg", "https://example.com/product.png"];
  state.publication.catalogItems[0].images = updated;
  // Same event emitted when staff return from editing the catalog in another tab.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
  await expect(images).toHaveValue(updated.join("\n"));
  await expect(page.getByLabel("Walmart title", { exact: true })).toHaveValue("My edited title");
  await images.fill("https://example.com/custom.jpg");
  state.publication.catalogItems[0].images = [updated[1]];
  const readsBefore = state.reads.filter(path => path.includes("/catalog?variantIds=")).length;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true })));
  await expect.poll(() => state.reads.filter(path => path.includes("/catalog?variantIds=")).length).toBeGreaterThan(readsBefore);
  await expect(images).toHaveValue("https://example.com/custom.jpg");
  await page.getByRole("button", { name: "Use catalog images", exact: true }).click();
  await expect(images).toHaveValue(updated[1]);
  await page.getByRole("button", { name: "Update draft item", exact: true }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved. No listing has been submitted.", { exact: true })).toBeVisible();
  expect(state.publication.draft.items[0]).toMatchObject({ title: "My edited title", images: null });
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("content overrides and reset-to-catalog are explicit without changing other item fields", async ({ page }) => {
  const state = await setup(page);
  await selectFirstProduct(page);
  await page.getByRole("button", { name: "Edit CARD-1", exact: true }).click();
  await page.getByLabel("Walmart title", { exact: true }).fill("Custom listing title");
  await expect(page.getByText("Custom", { exact: true }).first()).toBeVisible();
  await page.getByLabel("Description", { exact: true }).fill("Custom description");
  await page.getByRole("button", { name: "Use catalog description", exact: true }).click();
  await expect(page.getByLabel("Description", { exact: true })).toHaveValue("Protect your cards");
  await page.getByRole("button", { name: "Update draft item", exact: true }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved. No listing has been submitted.", { exact: true })).toBeVisible();
  expect(state.publication.draft.items[0]).toMatchObject({ title: "Custom listing title", description: null, brand: null, images: null });
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("one feed shows existing listings and selected drafts but publishes only the draft", async ({ page }) => {
  const state = await setup(page);
  await selectFirstProduct(page);
  const feed = page.getByRole("tabpanel", { name: "Listing Feed", exact: true });
  const table = feed.getByRole("table");
  await expect(table).toHaveCount(1);
  await expect(table.getByText("Product CARD-P5", { exact: true })).toBeVisible();
  await expect(table.getByText("CARD-1", { exact: true })).toBeVisible();
  await expect(feed.getByText("1 draft items", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Existing listings", exact: true })).toHaveCount(0);
  const existing = table.getByRole("row").filter({ has: page.getByText("CARD-P5", { exact: true }) });
  await expect(existing.getByRole("button", { name: "Edit listing CARD-P5", exact: true })).toBeVisible();
  await expect(existing.getByRole("button", { name: "Edit details", exact: true })).toHaveCount(0);
  await expect(existing.getByText("$4.99", { exact: true })).toHaveCount(0);
  await reviewSelectedDrafts(page, ["CARD-1"]);
  await expect(page.getByRole("dialog").getByRole("button", { name: "Publish 1 items", exact: true })).toBeVisible();
  expect(state.publication.draft.items.map(item => item.variantId)).toEqual([1]);
  expect(state.publication.reviews.at(-1)?.items.map(item => item.sku)).toEqual(["CARD-1"]);
  await page.getByRole("button", { name: "Publish 1 items", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.publication.operations[0].items.map(item => item.sku)).toEqual(["CARD-1"]);
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("remote listing, saved draft and latest operation for the same exact SKU occupy one row", async ({ page }) => {
  const state = await setup(page, { remoteRows: [listing("CARD-1", false)] });
  state.publication.draft = { ...state.publication.draft, revision: 1,
    items: [listingDraftItemSchema.parse({ variantId: 1, method: "create", productType: "Trading Card Accessories" })] };
  state.publication.operations = [listingOperationSchema.parse({
    id: "22222222-2222-4222-8222-222222222222", channelId: 77, state: "processing", submissionId: "feed-1",
    items: [{ variantId: 1, sku: "CARD-1", priceCents: 499, state: "processing", externalProductId: null,
      error: null, stockState: "waiting_for_item" }],
    createdAt: "2026-09-21T12:00:00.000Z", updatedAt: "2026-09-21T12:00:00.000Z", error: null,
  })];
  await page.reload();
  const table = page.getByRole("tabpanel", { name: "Listing Feed", exact: true }).getByRole("table");
  await expect(table.getByText("CARD-1", { exact: true })).toHaveCount(1);
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(page.getByText("1 draft items", { exact: true })).toBeVisible();
  expect(state.publication.draft.items).toHaveLength(1);
  expect(state.publication.writes).toEqual([]); expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("account search, pagination and linking preserve unsaved drafts without publishing them", async ({ page }) => {
  const state = await setup(page);
  await selectFirstProduct(page);
  await page.getByRole("button", { name: "Edit CARD-1", exact: true }).click();
  await page.getByLabel("Fixed Walmart price (USD)", { exact: true }).fill("6.79");
  await page.getByRole("button", { name: "Update draft item", exact: true }).click();
  await page.getByLabel("Select CARD-P5", { exact: true }).check();
  await page.getByRole("textbox", { name: "Search exact SKU" }).fill("CARD-1");
  await page.getByRole("button", { name: "Search listings" }).click();
  await expect(page.getByText("CARD-1", { exact: true })).toBeVisible();
  await expect(page.getByText("$6.79", { exact: true })).toBeVisible();
  await expect(page.getByText("Product CARD-P5", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
  await expect(page.getByLabel("Select CARD-P5", { exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Product PAGE-2", { exact: true })).toBeVisible();
  await expect(page.getByText("CARD-1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page.getByLabel("Select all actionable rows on this page").check();
  await page.getByRole("button", { name: "Link selected (1)", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "1 listing linked." })).toBeVisible();
  expect(state.publication.writes).toEqual([]);
  expect(state.writes.map(write => write.path)).toEqual([`${BASE}/catalog/mappings`]);
  await expect(page.getByText("$6.79", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved. No listing has been submitted.", { exact: true })).toBeVisible();
  expect(state.publication.draft.items).toMatchObject([{ variantId: 1, priceOverrideCents: 679 }]);
  expect(state.publication.operations).toEqual([]);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("remote catalog failure stays visible while local draft selection and saving remain available", async ({ page }) => {
  const state = await setup(page, { catalogError: true });
  await selectFirstProduct(page);
  await expect(page.getByText("Walmart catalog is unavailable", { exact: false })).toBeVisible();
  await expect(page.getByText("CARD-1", { exact: true })).toBeVisible();
  await expect(page.getByText("No listings in this feed yet.", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved. No listing has been submitted.", { exact: true })).toBeVisible();
  expect(state.publication.draft.items.map(item => item.variantId)).toEqual([1]);
  expect(state.publication.operations).toEqual([]); expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("an empty successful account and empty draft show the feed empty state", async ({ page }) => {
  const state = await setup(page, { catalogEmpty: true });
  await expect(page.getByText("No listings in this feed yet. Add products to prepare your first draft.", { exact: true })).toBeVisible();
  await expect(page.getByText("0 draft items", { exact: true })).toBeVisible();
  expect(state.publication.writes).toEqual([]); expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("publication selection survives pages and edits required schema fields without publishing", async ({ page }, info) => {
  const state = await setup(page);
  await expect(page.getByText("0 draft items", { exact: true })).toBeVisible();
  await expect(page.getByText("Product CARD-P5", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add products", exact: true }).click();
  const picker = page.getByRole("dialog");
  await picker.getByLabel("Select CARD-1", { exact: true }).check();
  await picker.getByRole("button", { name: "Next", exact: true }).click();
  await picker.getByLabel("Select CARD-26", { exact: true }).check();
  await picker.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(picker.getByLabel("Select CARD-1", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Add 2 to draft", exact: true }).click();
  await page.getByRole("button", { name: "Edit CARD-1", exact: true }).click();
  await page.getByRole("button", { name: "Browse product types", exact: true }).click();
  await page.getByRole("textbox", { name: "Search product types or categories", exact: true }).fill("Trading Card Accessories");
  await page.getByRole("button", { name: "Select Trading Card Accessories", exact: true }).click();
  await page.getByRole("spinbutton", { name: /^Shipping weight/ }).fill("0.2");
  await page.getByRole("combobox", { name: /^Country of origin/ }).selectOption("US");
  await page.getByLabel("Fixed Walmart price (USD)", { exact: true }).fill("5.49");
  await page.getByRole("button", { name: "Update draft item", exact: true }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved. No listing has been submitted.", { exact: true })).toBeVisible();
  expect(state.publication.draft.items.map(item => item.variantId)).toEqual([1, 26]);
  expect(state.publication.draft.items[0]).toMatchObject({ priceOverrideCents: 549, attributes: { Orderable: { shippingWeight: 0.2 }, Visible: { countryOfOrigin: "US" } } });
  expect(state.publication.operations).toEqual([]);
  await page.reload();
  await expect(page.getByText("$5.49", { exact: true })).toBeVisible();
  await expect(page.getByText("CARD-26", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("walmart-publication-draft.png"), fullPage: true });
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("product types browse through categories and only selecting a different leaf resets attributes", async ({ page }, info) => {
  const state = await setup(page);
  await selectFirstProduct(page);
  await page.getByRole("button", { name: "Edit CARD-1", exact: true }).click();
  const requirementsBefore = state.reads.filter(path => path.includes("/requirements?")).length;
  await page.getByRole("button", { name: "Browse product types", exact: true }).click();
  await page.getByRole("button", { name: "Browse Collectibles", exact: true }).click();
  await page.getByRole("button", { name: "Browse Card Protection", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select Trading Card Accessories", exact: true })).toBeVisible();
  expect(state.reads.filter(path => path.includes("/requirements?")).length).toBe(requirementsBefore);
  expect(state.publication.writes).toEqual([]);
  await page.screenshot({ path: info.outputPath("product-type-category-browser.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Select Trading Card Accessories", exact: true }).click();
  await page.getByRole("spinbutton", { name: /^Shipping weight/ }).fill("0.2");
  await page.getByRole("combobox", { name: /^Country of origin/ }).selectOption("US");
  await page.getByRole("button", { name: "Change product type", exact: true }).click();
  await page.getByRole("textbox", { name: "Search product types or categories", exact: true }).fill("Card Protection");
  await page.getByRole("button", { name: "Select Trading Card Accessories", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: /^Shipping weight/ })).toHaveValue("0.2");
  await expect(page.getByRole("combobox", { name: /^Country of origin/ })).toHaveValue("US");
  await page.getByRole("button", { name: "Change product type", exact: true }).click();
  await page.getByRole("textbox", { name: "Search product types or categories", exact: true }).fill("Card Storage");
  await page.getByRole("button", { name: "Select Trading Card Storage", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: /^Shipping weight/ })).toHaveValue("");
  await page.getByRole("button", { name: "Update draft item", exact: true }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved. No listing has been submitted.", { exact: true })).toBeVisible();
  expect(state.publication.draft.items[0]).toMatchObject({ productType: "Trading Card Storage", attributes: {} });
  expect(state.publication.operations).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("product-type search finds ancestry, supports keyboard selection and does not save search text", async ({ page }, info) => {
  const state = await setup(page);
  await selectFirstProduct(page);
  await page.getByRole("button", { name: "Edit CARD-1", exact: true }).click();
  await page.getByRole("button", { name: "Browse product types", exact: true }).click();
  const search = page.getByRole("textbox", { name: "Search product types or categories", exact: true });
  await search.fill("not-a-real-product-type");
  await expect(page.getByText("No product types match this search.", { exact: true })).toBeVisible();
  await search.fill("collectibles storage");
  const result = page.getByRole("button", { name: "Select Trading Card Storage", exact: true });
  await expect(result).toBeVisible();
  await expect(page.getByRole("button", { name: "Select Office Folders", exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("product-type-search-results.png"), fullPage: true });
  await result.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Update draft item", exact: true }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved. No listing has been submitted.", { exact: true })).toBeVisible();
  expect(state.publication.draft.items[0].productType).toBe("Trading Card Storage");
  expect(state.publication.operations).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("taxonomy failure offers retry and preserves an existing draft type and attributes", async ({ page }) => {
  const state = await setup(page);
  state.publication.taxonomyError = true;
  state.publication.draft = { ...state.publication.draft, revision: 1,
    items: [listingDraftItemSchema.parse({ variantId: 1, productType: "Trading Card Accessories", attributes: { Orderable: { shippingWeight: 0.2 } } })] };
  await page.reload();
  await page.getByRole("button", { name: "Edit CARD-1", exact: true }).click();
  await page.getByRole("button", { name: "Change product type", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry product types", exact: true })).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: /^Shipping weight/ })).toHaveValue("0.2");
  state.publication.taxonomyError = false;
  await page.getByRole("button", { name: "Retry product types", exact: true }).click();
  await expect(page.getByRole("button", { name: "Browse Collectibles", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close product type browser", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: /^Shipping weight/ })).toHaveValue("0.2");
  expect(state.publication.writes).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("legacy flat taxonomy remains selectable and large result sets can be expanded", async ({ page }) => {
  const state = await setup(page);
  state.publication.taxonomy = { productTypes: Array.from({ length: 65 }, (_, index) => `Legacy product type ${String(index + 1).padStart(2, "0")}`) };
  await selectFirstProduct(page);
  await page.getByRole("button", { name: "Edit CARD-1", exact: true }).click();
  await page.getByRole("button", { name: "Browse product types", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select Legacy product type 01", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Select Legacy product type 65", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Show more product types", exact: true }).click();
  await page.getByRole("button", { name: "Select Legacy product type 65", exact: true }).click();
  await page.getByRole("button", { name: "Update draft item", exact: true }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved. No listing has been submitted.", { exact: true })).toBeVisible();
  expect(state.publication.draft.items[0].productType).toBe("Legacy product type 65");
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("empty taxonomy retains an unknown saved selection without inventing a replacement", async ({ page }) => {
  const state = await setup(page);
  state.publication.taxonomy = { productTypes: [], entries: [] };
  state.publication.draft = { ...state.publication.draft, revision: 1,
    items: [listingDraftItemSchema.parse({ variantId: 1, productType: "Previously saved type", attributes: { Orderable: { shippingWeight: 0.2 } } })] };
  await page.reload();
  await page.getByRole("button", { name: "Edit CARD-1", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("Previously saved type", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Change product type", exact: true }).click();
  await expect(page.getByText("No product types are available.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close product type browser", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: /^Shipping weight/ })).toHaveValue("0.2");
  expect(state.publication.writes).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("product-type loading is explicit and does not select or publish an item", async ({ page }) => {
  const state = await setup(page);
  let releaseTaxonomy!: () => void;
  const responseGate = new Promise<void>(resolve => { releaseTaxonomy = resolve; });
  await page.route(`**${PUBLICATION_BASE}/taxonomy`, async route => {
    await responseGate;
    await route.fulfill({ json: state.publication.taxonomy });
  });
  try {
    await selectFirstProduct(page);
    await page.getByRole("button", { name: "Edit CARD-1", exact: true }).click();
    await page.getByRole("button", { name: "Browse product types", exact: true }).click();
    await expect(page.getByText("Loading product types…", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Select Trading Card/ })).toHaveCount(0);
    expect(state.publication.writes).toEqual([]);
  } finally {
    releaseTaxonomy();
  }
  await expect(page.getByRole("button", { name: "Browse Collectibles", exact: true })).toBeVisible();
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("read-only item details cannot change product type", async ({ page }) => {
  const state = await setup(page, { readOnly: true });
  seedSleevesDetails(state);
  const original = structuredClone(state.publication.draft.items);
  await page.reload();
  await page.getByRole("button", { name: "View CARD-1", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(SLEEVES_TYPE, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Change product type", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Jump to required details", exact: true }).click();
  await expect(dialog.getByLabel(/^Key Features 1/)).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Remove Key Features 2", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Add Key Features", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Clear all Key Features", exact: true })).toBeDisabled();
  const guidance = dialog.locator('details[aria-label="Key Features guidance"]');
  await guidance.locator("summary").click();
  await expect(guidance.getByText(KEY_FEATURE_GUIDANCE, { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Update draft item", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(state.publication.draft.items).toEqual(original);
  expect(state.publication.writes).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("server review blockers prevent submission and stale saves preserve local selection", async ({ page }) => {
  const state = await setup(page);
  await selectFirstProduct(page);
  state.publication.staleDraft = true;
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The draft changed" })).toBeVisible();
  await expect(page.getByText("CARD-1", { exact: true })).toBeVisible();
  state.publication.staleDraft = false; state.publication.blockedReview = true;
  await reviewSelectedDrafts(page, ["CARD-1"]);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Shipping weight is required", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Publish 1 items", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Edit details for CARD-1", exact: true }).click();
  await expect(page.getByLabel("Identifier for this selling unit", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Update draft item", exact: true })).toBeVisible();
  expect(state.publication.operations).toEqual([]);
  expect(state.errors).toEqual([]);
});

async function openBulkWorkspace(page: Page, count: number) {
  await page.getByRole("button", { name: "Bulk edit selected (" + count + ")", exact: true }).click();
  const bulk = page.getByRole("region", { name: "Bulk listing workspace", exact: true });
  await expect(bulk).toBeVisible();
  await expect(page).toHaveURL(/\/channels\/walmart\/77\/listings\/bulk\?variantIds=/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Store Setup", { exact: true })).toBeHidden();
  return bulk;
}
async function saveBulkWorkspace(page: Page) {
  const bulk = page.getByRole("region", { name: "Bulk listing workspace", exact: true });
  await bulk.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(bulk.getByRole("status")).toContainText("Draft saved.");
}

async function showGridColumn(column: Locator) {
  await column.evaluate(element => {
    const cell = element.closest("td, th")!;
    const table = cell.closest("table")!;
    const viewport = table.parentElement!;
    const pinnedWidth = table.querySelector("tbody tr th")!.getBoundingClientRect().width;
    viewport.scrollLeft += cell.getBoundingClientRect().left - viewport.getBoundingClientRect().left - pinnedWidth - 2;
  });
}

test("selected review and submission preserve every unselected draft", async ({ page }) => {
  const state = await setup(page, { catalogEmpty: true }); seedTwoDrafts(state);
  const untouched = structuredClone(state.publication.draft.items[1]);
  await page.reload();
  await expect(page.getByRole("button", { name: "Review selected (0)", exact: true })).toBeDisabled();
  await page.getByLabel("Select CARD-1", { exact: true }).check();
  await page.getByLabel("Search exact SKU", { exact: true }).fill("CARD-26");
  await page.getByRole("button", { name: "Search listings", exact: true }).click();
  await expect(page.getByLabel("Select CARD-1", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Review selected (1)", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("CARD-1", { exact: true })).toBeVisible();
  await expect(dialog.getByText("CARD-26", { exact: true })).toHaveCount(0);
  expect(state.publication.writes).toEqual([{ path: `${PUBLICATION_BASE}/review`, body: { expectedRevision: 1, variantIds: [1] } }]);
  const review = state.publication.reviews.at(-1)!;
  expect(state.publication.reviewedItems[review.id]).toEqual([state.publication.draft.items[0]]);
  state.publication.loseSubmissionResponse = true;
  await dialog.getByRole("button", { name: "Publish 1 items", exact: true }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "Submission response interrupted" })).toBeVisible();
  expect(state.publication.draft.items).toEqual([untouched]);
  await dialog.getByRole("button", { name: "Publish 1 items", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const submissions = state.publication.writes.filter(write => write.path.endsWith("/operations"));
  expect(submissions).toHaveLength(2); expect(submissions[0].body).toEqual(submissions[1].body);
  expect(state.publication.operations).toHaveLength(1);
  expect(state.publication.operations[0].items.map(item => item.variantId)).toEqual([1]);
  expect(state.publication.submittedItems.map(item => item.variantId)).toEqual([1]);
  expect(state.publication.draft).toMatchObject({ revision: 2, items: [untouched] });
  await page.getByRole("tab", { name: "Listing Feed", exact: true }).click();
  await expect(page.getByText("1 draft items", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review selected (0)", exact: true })).toBeDisabled();
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("bulk GTIN and product type persist through save, feed, reload and selected review", async ({ page }) => {
  const state = await setup(page, { catalogEmpty: true }); seedTwoDrafts(state);
  state.publication.draft.items[0] = { ...state.publication.draft.items[0], identifier: null, productType: "", attributes: {} };
  state.publication.catalogItems[0] = { ...state.publication.catalogItems[0], identifier: null };
  const untouched = structuredClone(state.publication.draft.items[1]);
  await page.reload(); await page.getByLabel("Select CARD-1", { exact: true }).check();
  const bulk = await openBulkWorkspace(page, 1);
  await bulk.getByLabel("Identifier type for CARD-1", { exact: true }).selectOption("GTIN");
  await bulk.getByLabel("Product identifier for CARD-1", { exact: true }).fill("00036000291452");
  await bulk.getByRole("button", { name: "Choose category", exact: true }).click();
  await bulk.getByRole("button", { name: "Browse product types", exact: true }).click();
  await bulk.getByRole("button", { name: "Browse Collectibles", exact: true }).click();
  await bulk.getByRole("button", { name: "Browse Card Storage", exact: true }).click();
  await bulk.getByRole("button", { name: "Select Trading Card Storage", exact: true }).click();
  await saveBulkWorkspace(page);
  const expected = structuredClone(state.publication.draft.items[0]);
  expect(expected).toMatchObject({ identifier: { type: "GTIN", value: "00036000291452" }, productType: "Trading Card Storage" });
  expect(state.publication.draft.items[1]).toEqual(untouched);
  expect(state.publication.writes).toHaveLength(1);
  expect(state.publication.writes[0]).toMatchObject({ path: `${PUBLICATION_BASE}/draft`, body: { expectedRevision: 1, items: [expected, untouched] } });
  await bulk.getByRole("button", { name: "Back to listing feed", exact: true }).click();
  const row = page.getByRole("row").filter({ has: page.getByText("CARD-1", { exact: true }) });
  await expect(row).toContainText("Trading Card Storage");
  await reviewSelectedDrafts(page, ["CARD-1"]);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Trading Card Storage");
  expect(state.publication.reviewedItems[state.publication.reviews.at(-1)!.id]).toEqual([expected]);
  await dialog.getByRole("button", { name: "Back to draft", exact: true }).click();
  await page.reload(); await page.getByLabel("Select CARD-1", { exact: true }).check();
  await openBulkWorkspace(page, 1);
  await expect(bulk.getByLabel("Identifier type for CARD-1", { exact: true })).toHaveValue("GTIN");
  await expect(bulk.getByLabel("Product identifier for CARD-1", { exact: true })).toHaveValue("00036000291452");
  await expect(bulk).toContainText("Trading Card Storage");
  expect(state.publication.operations).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a review response containing unselected variants cannot open publication confirmation", async ({ page }) => {
  const state = await setup(page, { catalogEmpty: true }); seedTwoDrafts(state);
  state.publication.reviewIncludesUnselected = true;
  await page.reload(); await reviewSelectedDrafts(page, ["CARD-1"]);
  await expect(page.getByRole("alert").filter({ hasText: "The review did not match your selected items" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Publish / })).toHaveCount(0);
  expect(state.publication.writes).toEqual([{ path: `${PUBLICATION_BASE}/review`, body: { expectedRevision: 1, variantIds: [1] } }]);
  expect(state.publication.operations).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a delayed pre-save workspace poll cannot replace the acknowledged bulk draft", async ({ page }) => {
  await page.clock.install();
  const state = await setup(page, { catalogEmpty: true }); seedTwoDrafts(state);
  await page.reload(); await page.getByLabel("Select CARD-1", { exact: true }).check();
  const bulk = await openBulkWorkspace(page, 1);
  await bulk.getByLabel("Product identifier for CARD-1", { exact: true }).fill("036000291452");
  await bulk.getByLabel("Brand for CARD-1", { exact: true }).fill("Saved after old poll started");
  let release = () => {};
  let captured = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const oldReadStarted = new Promise<void>(resolve => { captured = resolve; });
  let holdNext = true;
  await page.route(`**${PUBLICATION_BASE}`, async route => {
    if (route.request().method() !== "GET" || !holdNext) return route.fallback();
    holdNext = false;
    const snapshot = structuredClone({ draft: state.publication.draft, pricingRule: state.publication.pricingRule, operations: state.publication.operations });
    captured();
    await gate;
    await route.fulfill({ json: snapshot });
  });
  try {
    await page.clock.runFor(10_100); await oldReadStarted;
    await saveBulkWorkspace(page);
    const saved = structuredClone(state.publication.draft);
    const lateResponse = page.waitForResponse(response => new URL(response.url()).pathname === PUBLICATION_BASE);
    release(); await lateResponse;
    await bulk.getByRole("button", { name: "Back to listing feed", exact: true }).click();
    await reviewSelectedDrafts(page, ["CARD-1"]);
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(state.publication.writes.filter(write => write.path.endsWith("/review")).at(-1)?.body).toEqual({ expectedRevision: saved.revision, variantIds: [1] });
    expect(state.publication.reviewedItems[state.publication.reviews.at(-1)!.id]).toEqual([saved.items[0]]);
    expect(state.publication.writes.filter(write => write.path.endsWith("/draft"))).toHaveLength(1);
    expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
  } finally { release(); }
});

test("mixed typed drafts retain real Walmart required columns and bounded editable descriptions", async ({ page }, info) => {
  const state = await setup(page, { catalogEmpty: true }); seedTwoDrafts(state);
  const productType = "Trading Card Sleeves & Holders";
  const providerSchema = JSON.parse(readFileSync(resolve("server/modules/channels/__tests__/fixtures/walmart-listing-sleeves.schema.json"), "utf8"));
  state.publication.requirementsSchema = editorSchema(providerSchema, "MP_ITEM", productType);
  state.publication.taxonomy = { productTypes: [productType], entries: [{ productType, path: ["Collectibles", "Card Protection"], description: null }] };
  const originalHtml = `<p><strong>Protect every card.</strong> ${"Long description with detailed fit information. ".repeat(160)}</p>`;
  state.publication.catalogItems[0] = { ...state.publication.catalogItems[0], description: originalHtml };
  state.publication.draft.items = state.publication.draft.items.map((item, index) => ({ ...item, productType: index === 0 ? productType : "", attributes: {} }));
  const untouched = structuredClone(state.publication.draft.items[1]);
  await page.reload(); await page.getByLabel("Select all actionable rows on this page", { exact: true }).check();
  const bulk = await openBulkWorkspace(page, 2);
  const table = bulk.getByRole("table", { name: "Draft item attributes", exact: true });
  const pinnedWidth = await table.locator("tbody tr").first().getByRole("rowheader").evaluate(element => element.getBoundingClientRect().width);
  const expectedPinnedWidth = page.viewportSize()!.width < 640 ? 140 : 208;
  expect(pinnedWidth).toBeGreaterThanOrEqual(expectedPinnedWidth - 1);
  expect(pinnedWidth).toBeLessThanOrEqual(expectedPinnedWidth + 1);
  await expect(table.getByRole("columnheader", { name: "Required", exact: true })).toHaveCount(1);
  await expect(table.getByRole("columnheader", { name: "Optional", exact: true })).toHaveCount(1);
  for (const label of ["Shipping Weight", "Country of origin substantial transformation", "Condition", "Key Features", "Count Per Pack", "Multipack Quantity", "Is Prop65 Warning Required", "Has written warranty", "Product Net Content Unit", "Product Net Content Measure", "Piece Count"])
    await expect(table.getByRole("columnheader", { name: new RegExp(`(?:^|\\s)${label}\\*?$`) })).toHaveCount(1);
  const weight = bulk.getByLabel("Shipping and offer details › Shipping Weight for CARD-1", { exact: true });
  await expect(weight).toBeEnabled(); await expect(weight).toHaveValue("");
  await expect(bulk.getByLabel("Product attributes › Condition for CARD-1", { exact: true })).toHaveValue("");
  await expect(bulk.getByLabel("Product attributes › Net Content › Product Net Content Measure for CARD-1", { exact: true })).toHaveValue("");
  await expect(bulk.getByRole("button", { name: "Choose category for CARD-26", exact: true })).toBeVisible();
  await expect(bulk.getByLabel("Shipping and offer details › Shipping Weight for CARD-26", { exact: true })).toHaveCount(0);
  const preview = bulk.getByLabel("Description preview for CARD-1", { exact: true });
  await expect(preview).toHaveValue(/Protect every card\./);
  expect(await preview.inputValue()).not.toContain("<strong>");
  expect((await preview.inputValue()).length).toBeLessThan(originalHtml.length);
  const width = await preview.evaluate(element => element.getBoundingClientRect().width);
  expect(width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await showGridColumn(preview);
  await page.screenshot({ path: info.outputPath("walmart-required-columns-description.png"), fullPage: true });
  await table.evaluate(element => { element.parentElement!.scrollLeft = 0; });
  await page.screenshot({ path: info.outputPath("walmart-required-columns-start.png"), fullPage: true });
  await showGridColumn(bulk.getByLabel("Product attributes › Net Content › Product Net Content Measure for CARD-1", { exact: true }));
  await page.screenshot({ path: info.outputPath("walmart-required-columns-net-content.png"), fullPage: true });
  await showGridColumn(table.getByRole("columnheader", { name: /(?:^|\s)State Restrictions$/ }));
  await page.screenshot({ path: info.outputPath("walmart-optional-columns-start.png"), fullPage: true });
  await bulk.getByRole("button", { name: "Edit description for CARD-1", exact: true }).click();
  const editor = bulk.getByLabel("Description for CARD-1", { exact: true });
  await expect(editor).toHaveValue(originalHtml);
  await editor.fill("<p>Changed <strong>listing description</strong>.</p>");
  await saveBulkWorkspace(page);
  expect(state.publication.draft.items[0]).toMatchObject({ description: "<p>Changed <strong>listing description</strong>.</p>", productType, attributes: {} });
  expect(state.publication.draft.items[1]).toEqual(untouched);
  expect(state.publication.writes).toHaveLength(1);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("full-page bulk editing saves one draft update and preserves identifiers and untouched attributes", async ({ page }, info) => {
  const state = await setup(page, { catalogEmpty: true }); seedTwoDrafts(state);
  const original = structuredClone(state.publication.draft.items);
  await page.reload();
  await page.getByLabel("Select all actionable rows on this page", { exact: true }).check();
  const bulk = await openBulkWorkspace(page, 2);
  await expect(bulk.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  await bulk.getByLabel("Brand for all selected items", { exact: true }).fill("Shared test brand");
  await expect(bulk.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  await bulk.getByRole("button", { name: "Apply Brand to all", exact: true }).click();
  await bulk.getByLabel("Price (USD) for all selected items", { exact: true }).fill("8.99");
  await bulk.getByRole("button", { name: "Apply Price (USD) to all", exact: true }).click();
  await bulk.getByLabel(/Country of origin for all selected items/).selectOption("choice:0");
  await bulk.getByRole("button", { name: "Apply Country of origin to all", exact: true }).click();
  await bulk.getByRole("button", { name: "Changes (2)", exact: true }).click();
  await expect(bulk.getByRole("complementary", { name: "Bulk edit preview", exact: true })).toContainText("2 of 2 items changed");
  expect(state.publication.writes).toEqual([]);
  await saveBulkWorkspace(page);
  expect(state.publication.writes).toHaveLength(1);
  expect(state.publication.draft.items).toEqual(original.map(item => ({ ...item, brand: "Shared test brand", priceOverrideCents: 899,
    attributes: { ...item.attributes, Visible: { ...(item.attributes.Visible as object), countryOfOrigin: "US" } } })));
  await expect(bulk.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  await bulk.getByRole("button", { name: "Changes (0)", exact: true }).click();
  await page.screenshot({ path: info.outputPath("bulk-workspace-content.png"), fullPage: true });
  expect(state.publication.operations).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("bulk invalid price can be discarded on leaving and a selected row can inherit pricing", async ({ page }) => {
  const state = await setup(page, { catalogEmpty: true }); seedTwoDrafts(state);
  const original = structuredClone(state.publication.draft.items);
  await page.reload(); await page.getByLabel("Select CARD-1", { exact: true }).check();
  const bulk = await openBulkWorkspace(page, 1);
  const price = bulk.getByLabel("Price (USD) for CARD-1", { exact: true });
  await expect(price).toHaveValue("5.49"); await price.fill("0");
  await expect(price).toHaveAttribute("aria-invalid", "true");
  await expect(bulk.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  page.once("dialog", dialog => dialog.accept());
  await bulk.getByRole("button", { name: "Back to listing feed", exact: true }).click();
  await expect(bulk).toHaveCount(0);
  expect(state.publication.draft.items).toEqual(original); expect(state.publication.writes).toEqual([]);
  await openBulkWorkspace(page, 1); await price.fill(""); await saveBulkWorkspace(page);
  expect(state.publication.draft.items).toEqual([{ ...original[0], priceOverrideCents: null }, original[1]]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("mixed categories keep product columns editable and changing category clears only affected attributes", async ({ page }) => {
  const state = await setup(page, { catalogEmpty: true }); seedTwoDrafts(state);
  state.publication.draft.items[1].productType = "Trading Card Storage";
  const original = structuredClone(state.publication.draft.items);
  await page.reload(); await page.getByLabel("Select all actionable rows on this page", { exact: true }).check();
  const bulk = await openBulkWorkspace(page, 2);
  await expect(bulk.getByRole("table", { name: "Draft item attributes", exact: true })).toBeVisible();
  await expect(bulk.getByLabel("Brand for CARD-1", { exact: true })).toHaveValue("First brand");
  await bulk.getByRole("button", { name: "Choose category", exact: true }).click();
  await bulk.getByRole("button", { name: "Browse product types", exact: true }).click();
  await bulk.getByRole("button", { name: "Browse Collectibles", exact: true }).click();
  await bulk.getByRole("button", { name: "Browse Card Storage", exact: true }).click();
  await bulk.getByRole("button", { name: "Select Trading Card Storage", exact: true }).click();
  await expect(bulk.getByText("Category or method changes clear prior provider attributes on 1 items.", { exact: false })).toBeVisible();
  await saveBulkWorkspace(page);
  expect(state.publication.draft.items).toEqual([{ ...original[0], productType: "Trading Card Storage", attributes: {} }, original[1]]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("bulk grid supports 100 rows, column defaults, explicit replacement and individual shipping edits", async ({ page }, info) => {
  const state = await setup(page, { catalogEmpty: true }); seedAttributeTable(state, 100);
  const original = structuredClone(state.publication.draft.items);
  await page.reload(); await page.getByRole("button", { name: "Show more listings", exact: true }).click();
  await page.getByLabel("Select all actionable rows on this page", { exact: true }).check();
  const bulk = await openBulkWorkspace(page, 100);
  const table = bulk.getByRole("table", { name: "Draft item attributes", exact: true });
  await expect(table.locator("tbody tr")).toHaveCount(25);
  const weight = bulk.getByLabel("Shipping › Shipping weight for ROW-001", { exact: true });
  const secondWeight = bulk.getByLabel("Shipping › Shipping weight for ROW-002", { exact: true });
  const columnWeight = bulk.getByLabel("Shipping › Shipping weight for all selected items", { exact: true });
  const save = bulk.getByRole("button", { name: "Save draft", exact: true });
  const apply = bulk.getByRole("button", { name: "Apply Shipping weight to all", exact: true });
  const discard = bulk.getByRole("button", { name: "Discard Shipping › Shipping weight column value", exact: true });
  await columnWeight.fill("1");
  await expect(apply).toBeEnabled(); await expect(discard).toBeVisible();
  await expect(bulk.getByRole("alert")).toHaveCount(0);
  await expect(bulk.getByText(/column defaults need Apply or Discard|Apply or discard pending column defaults/)).toHaveCount(0);
  await expect(save).toBeDisabled();
  await expect(bulk.getByLabel("Bulk listing method", { exact: true })).toBeDisabled();
  await expect(weight).toHaveValue("1"); await expect(secondWeight).toHaveValue("2");
  // A valid unapplied default is still an unsaved buffer, even without row edits.
  page.once("dialog", dialog => dialog.dismiss()); await page.goBack();
  await expect(page).toHaveURL(/\/listings\/bulk\?/);
  await expect(columnWeight).toHaveValue("1");
  await showGridColumn(columnWeight);
  await page.screenshot({ path: info.outputPath("bulk-pending-column-default.png"), fullPage: true });
  await discard.click();
  await expect(apply).toHaveCount(0); await expect(discard).toHaveCount(0);
  await expect(weight).toHaveValue("1"); await expect(secondWeight).toHaveValue("2");
  expect(state.publication.draft.items).toEqual(original); expect(state.publication.writes).toEqual([]);
  await weight.fill("7");
  await expect(save).toBeEnabled();
  await columnWeight.fill("1"); await expect(save).toBeDisabled();
  await expect(bulk.getByRole("alert")).toHaveCount(0);
  await discard.click(); await expect(save).toBeEnabled();
  await expect(weight).toHaveValue("7"); await expect(secondWeight).toHaveValue("2");
  await columnWeight.fill("2.5"); await apply.click();
  await expect(weight).toHaveValue("7"); await expect(secondWeight).toHaveValue("2.5");
  await expect(save).toBeEnabled();
  await bulk.getByLabel("Shipping › Shipping weight for all selected items", { exact: true }).fill("3");
  await bulk.getByRole("button", { name: "Replace Shipping weight row edits", exact: true }).click();
  await expect(weight).toHaveValue("3");
  await bulk.getByLabel("Product › Dimensions › Width for ROW-002", { exact: true }).fill("6.5");
  await bulk.getByLabel("Product › Ships in own container for ROW-002", { exact: true }).selectOption("true");
  await bulk.getByRole("button", { name: "Next draft rows", exact: true }).click();
  await bulk.getByLabel("Shipping › Shipping weight for ROW-026", { exact: true }).fill("9.75");
  await bulk.getByLabel("Rows per page", { exact: true }).selectOption("100");
  await expect(table.locator("tbody tr")).toHaveCount(100);
  await bulk.getByLabel("Product › Ships in own container for ROW-100", { exact: true }).selectOption("true");
  await saveBulkWorkspace(page);
  expect(state.publication.writes).toHaveLength(1);
  expect(state.publication.draft.items).toEqual(original.map(item => ({ ...item, attributes: {
    Orderable: { shippingWeight: item.variantId === 26 ? 9.75 : 3 },
    Visible: { ...(item.attributes.Visible as object), dimensions: { width: item.variantId === 2 ? 6.5 : item.variantId, height: 10 },
      shipsInOwnContainer: item.variantId === 2 || item.variantId === 100 },
  } })));
  await bulk.getByLabel("Shipping › Shipping weight for ROW-001", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("bulk-workspace-100-items.png"), fullPage: true });
  expect(state.publication.operations).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("invalid cell buffers survive paging and filters without locking unrelated editing", async ({ page }) => {
  const state = await setup(page, { catalogEmpty: true }); seedAttributeTable(state, 30);
  await page.reload(); await page.getByLabel("Select all actionable rows on this page", { exact: true }).check();
  const bulk = await openBulkWorkspace(page, 30);
  const weight = bulk.getByLabel("Shipping › Shipping weight for ROW-001", { exact: true });
  await weight.fill(""); await weight.pressSequentially("0.25"); await expect(weight).toHaveValue("0.25");
  await weight.fill("not a number"); await expect(weight).toHaveAttribute("aria-invalid", "true");
  await expect(bulk.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  await bulk.getByRole("button", { name: "Next draft rows", exact: true }).click();
  await bulk.getByLabel("Brand for ROW-026", { exact: true }).fill("Row 26 brand");
  await bulk.getByRole("button", { name: "Previous draft rows", exact: true }).click();
  await expect(weight).toHaveValue("not a number");
  await bulk.getByLabel("Search attribute columns", { exact: true }).fill("Brand"); await expect(weight).toHaveCount(0);
  await bulk.getByLabel("Search attribute columns", { exact: true }).fill(""); await expect(weight).toHaveValue("not a number");
  await expect(bulk.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  await weight.fill("0.25"); await bulk.getByLabel("Price (USD) for ROW-001", { exact: true }).fill("bad price");
  await expect(weight).toHaveValue("0.25"); await expect(bulk.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  await bulk.getByLabel("Price (USD) for ROW-001", { exact: true }).fill("8.99"); await saveBulkWorkspace(page);
  expect(state.publication.draft.items[0]).toMatchObject({ priceOverrideCents: 899, attributes: { Orderable: { shippingWeight: 0.25 } } });
  expect(state.publication.draft.items[25].brand).toBe("Row 26 brand");
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("docked item details edit arrays while the grid retains individual edits", async ({ page }, info) => {
  const state = await setup(page, { catalogEmpty: true }); seedAttributeTable(state, 2);
  const original = structuredClone(state.publication.draft.items);
  await page.reload(); await page.getByLabel("Select all actionable rows on this page", { exact: true }).check();
  const bulk = await openBulkWorkspace(page, 2);
  await bulk.getByLabel("Product › Dimensions › Width for ROW-001", { exact: true }).fill("4.5");
  await bulk.getByRole("button", { name: "Edit attributes for ROW-001", exact: true }).click();
  const details = bulk.getByRole("complementary", { name: "Item details", exact: true });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await details.getByLabel(/^Features 1/).fill("Individual feature");
  await page.screenshot({ path: info.outputPath("bulk-workspace-details.png"), fullPage: true });
  await details.getByRole("button", { name: "Close details", exact: true }).click();
  await expect(bulk.getByLabel("Product › Dimensions › Width for ROW-001", { exact: true })).toHaveValue("4.5");
  await bulk.getByRole("button", { name: "Choose category", exact: true }).click();
  await bulk.getByRole("button", { name: "Change product type", exact: true }).click();
  await bulk.getByRole("button", { name: "Select Trading Card Accessories", exact: true }).click();
  await expect(bulk.getByLabel("Product › Dimensions › Width for ROW-001", { exact: true })).toHaveValue("4.5");
  await saveBulkWorkspace(page);
  expect(state.publication.draft.items).toEqual([{ ...original[0], attributes: {
    ...original[0].attributes, Visible: { ...(original[0].attributes.Visible as object),
      dimensions: { width: 4.5, height: 10 }, features: ["Individual feature"] },
  } }, original[1]]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("failed bulk saves retain row edits and retry sends the same validated draft", async ({ page }) => {
  const state = await setup(page, { catalogEmpty: true }); seedTwoDrafts(state);
  await page.reload(); await page.getByLabel("Select CARD-1", { exact: true }).check();
  const bulk = await openBulkWorkspace(page, 1);
  await bulk.getByLabel("Brand for CARD-1", { exact: true }).fill("Retained brand");
  await bulk.getByLabel("Product identifier for CARD-1", { exact: true }).fill("036000291452");
  state.publication.staleDraft = true;
  await bulk.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(bulk.getByRole("alert").filter({ hasText: "The draft changed" })).toBeVisible();
  await expect(bulk.getByLabel("Brand for CARD-1", { exact: true })).toHaveValue("Retained brand");
  expect(state.publication.draft.items[0].brand).toBe("First brand");
  state.publication.staleDraft = false; await saveBulkWorkspace(page);
  expect(state.publication.draft.items[0]).toMatchObject({ brand: "Retained brand", identifier: { type: "UPC", value: "036000291452" } });
  expect(state.publication.draft.items[1].brand).toBe("Second brand");
  expect(state.publication.operations).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("bulk page reload restores only explicitly selected saved drafts", async ({ page }) => {
  const state = await setup(page, { catalogEmpty: true }); seedTwoDrafts(state);
  await page.reload(); await page.getByLabel("Select CARD-26", { exact: true }).check();
  await openBulkWorkspace(page, 1);
  const previousEpoch = await page.evaluate(() => history.state.echelonListingNavigation.epoch);
  await page.reload();
  const bulk = page.getByRole("region", { name: "Bulk listing workspace", exact: true });
  await expect(bulk.getByLabel("Brand for CARD-26", { exact: true })).toHaveValue("Second brand");
  expect(await page.evaluate(() => history.state.echelonListingNavigation.epoch)).not.toBe(previousEpoch);
  await expect(bulk.getByLabel("Brand for CARD-1", { exact: true })).toHaveCount(0);
  expect(state.publication.writes).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("clean bulk history entries restore the selection encoded in their URLs", async ({ page }) => {
  const state = await setup(page, { catalogEmpty: true }); seedTwoDrafts(state);
  await page.reload(); await page.getByLabel("Select CARD-1", { exact: true }).check();
  const bulk = await openBulkWorkspace(page, 1);
  await bulk.getByRole("button", { name: "Back to listing feed", exact: true }).click();
  await page.getByLabel("Select CARD-1", { exact: true }).uncheck();
  await page.getByLabel("Select CARD-26", { exact: true }).check();
  await openBulkWorkspace(page, 1);
  await expect(bulk.getByLabel("Brand for CARD-26", { exact: true })).toHaveValue("Second brand");
  await page.goBack(); await page.goBack();
  await expect(page).toHaveURL(/variantIds=1$/);
  await expect(bulk.getByLabel("Brand for CARD-1", { exact: true })).toHaveValue("First brand");
  await expect(bulk.getByLabel("Brand for CARD-26", { exact: true })).toHaveCount(0);
  await page.goForward(); await page.goForward();
  await expect(page).toHaveURL(/variantIds=26$/);
  await expect(bulk.getByLabel("Brand for CARD-26", { exact: true })).toHaveValue("Second brand");
  expect(state.publication.writes).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("browser Back cancellation preserves unsaved bulk cells and history can still return to the feed", async ({ page }) => {
  const state = await setup(page, { catalogEmpty: true }); seedTwoDrafts(state);
  await page.reload(); await page.getByLabel("Select CARD-1", { exact: true }).check();
  const bulk = await openBulkWorkspace(page, 1);
  await bulk.getByLabel("Brand for CARD-1", { exact: true }).fill("Unsaved brand");
  page.once("dialog", dialog => dialog.dismiss()); await page.goBack();
  await expect(page).toHaveURL(/\/listings\/bulk\?/);
  await expect(bulk.getByLabel("Brand for CARD-1", { exact: true })).toHaveValue("Unsaved brand");
  page.once("dialog", dialog => dialog.accept()); await page.goBack();
  await expect(page).toHaveURL("/channels/walmart/77");
  await expect(page.getByText("Store Setup", { exact: true })).toBeVisible();
  expect(state.publication.draft.items[0].brand).toBe("First brand");
  expect(state.publication.writes).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});
test("unknown staff history entries retain bulk buffers and unload protection until resumed", async ({ page }) => {
  const state = await setup(page, { catalogEmpty: true }); seedTwoDrafts(state);
  // Create a staff entry before this channel's guard epoch, as when arriving
  // from another application page. Do not fake an owner that never unmounts.
  await page.evaluate(() => history.replaceState({ marker: "prior-staff-entry" }, "", "/test-other"));
  await expect(page.getByText("Another staff page", { exact: true })).toBeVisible();
  await page.evaluate(() => history.pushState(null, "", "/channels/walmart/77"));
  await page.reload(); await page.getByLabel("Select CARD-1", { exact: true }).check();
  const bulk = await openBulkWorkspace(page, 1);
  await bulk.getByLabel("Brand for CARD-1", { exact: true }).fill("Retained across staff pages");
  await expect(bulk.getByRole("button", { name: "Changes (1)", exact: true })).toBeVisible();
  await page.evaluate(() => history.go(-2));
  await expect(page).toHaveURL("/test-other");
  await expect(bulk).toBeHidden();
  expect(await page.evaluate(() => history.state.marker)).toBe("prior-staff-entry");
  expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(true);
  await page.goForward(); await page.goForward();
  await expect(bulk.getByLabel("Brand for CARD-1", { exact: true })).toHaveValue("Retained across staff pages");
  await saveBulkWorkspace(page);
  expect(state.publication.draft.items[0].brand).toBe("Retained across staff pages");
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("bulk measurement columns retain parent help and require explicit quantity edits", async ({ page }) => {
  const state = await setup(page, { catalogEmpty: true }); seedAttributeTable(state, 2);
  const original = structuredClone(state.publication.draft.items);
  state.publication.requirementsSchema = { type: "object", required: ["Visible"], properties: {
    Visible: { type: "object", title: "Product", required: ["netContent", "pieceCount"], properties: {
      netContent: { type: "object", title: "Net Content", description: "If contents use the same unit, add their quantities. For mixed units, use 1 Each.", required: ["unit", "measure"], properties: {
        unit: { type: "string", title: "Unit", enum: ["Each", "Count"], description: "The unit used to describe the package contents." },
        measure: { type: "number", title: "Measure", description: "The quantity expressed in the selected unit." },
      } },
      pieceCount: { type: "integer", title: "Number of Pieces", description: "Total individual pieces inside the package." },
    } },
  } };
  await page.reload(); await page.getByLabel("Select all actionable rows on this page", { exact: true }).check();
  const bulk = await openBulkWorkspace(page, 2);
  await bulk.getByLabel("Search attribute columns", { exact: true }).fill("Measure");
  await bulk.getByLabel("Help for Product › Net Content › Measure", { exact: true }).click();
  await expect(bulk.getByText("If contents use the same unit, add their quantities. For mixed units, use 1 Each.", { exact: false })).toBeVisible();
  await expect(bulk.getByLabel("Product › Net Content › Measure for ROW-001", { exact: true })).toHaveValue("");
  expect(state.publication.draft.items).toEqual(original); expect(state.publication.writes).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("bulk inspector clears descendant displays and retains rejected edits until discarded", async ({ page }) => {
  const state = await setup(page, { catalogEmpty: true }); seedAttributeTable(state, 2);
  const properties = state.publication.requirementsSchema!.properties as Record<string, Record<string, unknown>>;
  properties.Visible.required = [];
  await page.reload(); await page.getByLabel("Select all actionable rows on this page", { exact: true }).check();
  const bulk = await openBulkWorkspace(page, 2);
  const width = bulk.getByLabel("Product › Dimensions › Width for ROW-001", { exact: true });
  await width.fill("4.5");
  await bulk.getByRole("button", { name: "Edit attributes for ROW-001", exact: true }).click();
  const details = bulk.getByRole("complementary", { name: "Item details", exact: true });
  await details.getByLabel("Search listing fields", { exact: true }).fill("Dimensions");
  await details.getByRole("button", { name: "Clear Dimensions", exact: true }).click();
  await details.getByRole("button", { name: "Close details", exact: true }).click();
  await expect(width).toHaveValue("");
  await width.fill("6"); await expect(width).toHaveValue("6");
  await expect(width).toHaveAttribute("aria-invalid", "true");
  await expect(bulk.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  await bulk.getByRole("button", { name: "Discard all invalid cell values", exact: true }).click();
  await saveBulkWorkspace(page);
  expect(state.publication.draft.items[0].attributes.Visible).not.toHaveProperty("dimensions");
  expect(state.publication.draft.items[1].attributes.Visible).toHaveProperty("dimensions.width", 2);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("bulk inspector preserves incomplete numeric input including nested array values", async ({ page }) => {
  const state = await setup(page, { catalogEmpty: true }); seedAttributeTable(state, 2);
  const properties = state.publication.requirementsSchema!.properties as Record<string, { properties: Record<string, unknown> }>;
  properties.Visible.properties.measurements = { type: "array", title: "Measurements", items: {
    type: "object", required: ["amount", "unit"], properties: {
      amount: { type: "number", title: "Amount", minimum: 0 }, length: { type: "integer", title: "Length", minimum: 0 },
      unit: { type: "string", title: "Unit", enum: ["lb", "oz"] },
    },
  } };
  state.publication.draft.items = state.publication.draft.items.map(item => ({ ...item, attributes: { ...item.attributes,
    Visible: { ...(item.attributes.Visible as object), measurements: [{ amount: item.variantId, length: 8, unit: "lb" }] },
  } }));
  await page.reload(); await page.getByLabel("Select all actionable rows on this page", { exact: true }).check();
  const bulk = await openBulkWorkspace(page, 2);
  await bulk.getByRole("button", { name: "Edit attributes for ROW-001", exact: true }).click();
  const details = bulk.getByRole("complementary", { name: "Item details", exact: true });
  await details.getByLabel("Width for ROW-001", { exact: true }).fill("-");
  await expect(details.getByLabel("Width for ROW-001", { exact: true })).toHaveValue("-");
  await expect(bulk.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  await details.getByRole("button", { name: "Close details", exact: true }).click();
  await bulk.getByRole("button", { name: "Edit attributes for ROW-001", exact: true }).click();
  await expect(details.getByLabel("Width for ROW-001", { exact: true })).toHaveValue("-");
  await details.getByLabel("Width for ROW-001", { exact: true }).fill("0.25");
  await details.getByLabel("Amount for ROW-001", { exact: true }).fill("-");
  await details.getByLabel("Length for ROW-001", { exact: true }).fill("-");
  await expect(bulk.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  await details.getByRole("button", { name: "Close details", exact: true }).click();
  await bulk.getByRole("button", { name: "Edit attributes for ROW-001", exact: true }).click();
  await expect(details.getByLabel("Amount for ROW-001", { exact: true })).toHaveValue("-");
  await details.getByLabel("Amount for ROW-001", { exact: true }).fill("0.75");
  await expect(details.getByLabel("Amount for ROW-001", { exact: true })).toHaveValue("0.75");
  await expect(details.getByLabel("Length for ROW-001", { exact: true })).toHaveValue("-");
  await expect(bulk.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  await details.getByLabel("Length for ROW-001", { exact: true }).fill("4");
  await saveBulkWorkspace(page);
  expect(state.publication.draft.items[0].attributes.Visible).toMatchObject({ dimensions: { width: 0.25, height: 10 }, measurements: [{ amount: 0.75, length: 4, unit: "lb" }] });
  expect(state.publication.draft.items[1].attributes.Visible).toHaveProperty("measurements", [{ amount: 2, length: 8, unit: "lb" }]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("bulk Save includes products added in the feed even when no bulk fields changed", async ({ page }) => {
  const state = await setup(page, { catalogEmpty: true });
  await selectFirstProduct(page);
  await page.getByLabel("Select CARD-1", { exact: true }).check();
  await openBulkWorkspace(page, 1); await saveBulkWorkspace(page);
  expect(state.publication.draft.items.map(item => item.variantId)).toEqual([1]);
  expect(state.publication.writes).toHaveLength(1); expect(state.publication.operations).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("actual sleeves details show one guidance block and preserve other fields when removing and adding a feature", async ({ page }, info) => {
  const state = await setup(page, { catalogEmpty: true }); seedSleevesDetails(state);
  const original = structuredClone(state.publication.draft.items);
  await page.reload(); await page.getByRole("button", { name: "Edit CARD-1", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(SLEEVES_TYPE, { exact: true })).toBeVisible();
  await dialog.screenshot({ path: info.outputPath("sku-details-modal.png") });
  await dialog.getByRole("button", { name: "Jump to required details", exact: true }).click();
  await expectPinnedListingEditor(dialog);
  await dialog.getByLabel("Search listing fields", { exact: true }).fill("Key Features");
  const guidance = dialog.locator('details[aria-label="Key Features guidance"]');
  await expect(guidance).toHaveCount(1);
  await expect(guidance).not.toHaveAttribute("open", "");
  await expect(dialog.getByText(KEY_FEATURE_GUIDANCE, { exact: true })).toHaveCount(1);
  await expect(dialog.getByText(KEY_FEATURE_GUIDANCE, { exact: true })).not.toBeVisible();
  for (const [index, feature] of (original[0].attributes.Visible as { keyFeatures: string[] }).keyFeatures.entries())
    await expect(dialog.getByLabel(new RegExp(`^Key Features ${index + 1}`))).toHaveValue(feature);
  const remove = dialog.getByRole("button", { name: "Remove Key Features 2", exact: true });
  await expect(remove).toHaveText("");
  await expect(remove.locator("svg")).toHaveAttribute("aria-hidden", "true");
  const rowWidth = await remove.evaluate(element => element.parentElement!.getBoundingClientRect().width);
  const fieldWidth = await dialog.getByLabel(/^Key Features 2/).evaluate(element => element.getBoundingClientRect().width);
  expect(rowWidth - fieldWidth).toBeLessThanOrEqual(27);
  await expect(dialog.getByRole("button", { name: "Add Key Features", exact: true })).toHaveText("Add Key Features");
  await guidance.locator("summary").click();
  await expect(guidance.getByText(KEY_FEATURE_GUIDANCE, { exact: true })).toBeVisible();
  const descriptionId = await dialog.getByLabel(/^Key Features 1/).getAttribute("aria-describedby");
  expect(descriptionId).toBeTruthy();
  for (const index of [2, 3]) await expect(dialog.getByLabel(new RegExp(`^Key Features ${index}`))).toHaveAttribute("aria-describedby", descriptionId!);
  await guidance.locator("summary").click();
  await dialog.getByLabel(/^Key Features 1/).evaluate(element => element.closest("fieldset")!.scrollIntoView({ block: "start" }));
  await expectPinnedListingEditor(dialog);
  await page.screenshot({ path: info.outputPath("sku-details-key-features-viewport.png") });
  await dialog.screenshot({ path: info.outputPath("sku-details-key-features.png") });
  // Center the action group before requiring full visibility. Nearest-edge
  // scrolling can leave a fractional pixel outside the scrollport in Chromium.
  await dialog.getByRole("button", { name: "Add Key Features", exact: true }).evaluate(element => element.parentElement!.scrollIntoView({ block: "center" }));
  await expectPinnedListingEditor(dialog);
  const clearFeatures = dialog.getByRole("button", { name: "Clear all Key Features", exact: true });
  await expect(clearFeatures).toBeInViewport({ ratio: 1 });
  await clearFeatures.click({ trial: true });
  await dialog.screenshot({ path: info.outputPath("sku-details-key-features-actions.png") });
  await remove.click();
  await expect(dialog.getByLabel(/^Key Features 2/)).toHaveValue("Archival material protects the surface");
  await expect(dialog.getByLabel(/^Key Features 2/)).toBeFocused();
  await expect(dialog.getByLabel(/^Key Features 3/)).toHaveCount(0);
  await expect(dialog.getByRole("region", { name: "Required fields summary", exact: true })).toContainText("required fields need attention");
  await dialog.getByRole("button", { name: "Add Key Features", exact: true }).click();
  await expect(dialog.getByLabel(/^Key Features 3/)).toBeFocused();
  await dialog.getByLabel(/^Key Features 3/).fill("Smooth edges help with repeated handling");
  await expectPinnedListingEditor(dialog);
  await expect(dialog.getByRole("region", { name: "Required fields summary", exact: true })).toContainText("Required fields shown here are filled");
  await dialog.getByRole("button", { name: "Jump to content", exact: true }).click();
  await expectPinnedListingEditor(dialog);
  await expect(dialog.getByLabel("Walmart title", { exact: true })).toHaveValue("Trading card protection");
  await expect(dialog.getByLabel("Brand", { exact: true })).toHaveValue("First brand");
  await dialog.getByLabel("Brand", { exact: true }).scrollIntoViewIfNeeded();
  await expectPinnedListingEditor(dialog);
  await dialog.screenshot({ path: info.outputPath("sku-details-content.png") });
  await dialog.getByRole("button", { name: "Update draft item", exact: true }).click();
  expect(state.publication.writes).toEqual([]);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved. No listing has been submitted.", { exact: true })).toBeVisible();
  expect(state.publication.draft.items).toEqual([{ ...original[0], attributes: { ...original[0].attributes,
    Visible: { ...(original[0].attributes.Visible as object), keyFeatures: ["Clear front keeps the card visible", "Archival material protects the surface", "Smooth edges help with repeated handling"] } } }, original[1]]);
  expect(state.publication.writes).toHaveLength(1); expect(state.publication.operations).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("bulk sleeves inspector shares array guidance and applies only the edited item's feature list", async ({ page }, info) => {
  const state = await setup(page, { catalogEmpty: true }); seedSleevesDetails(state);
  const original = structuredClone(state.publication.draft.items);
  await page.reload(); await page.getByLabel("Select all actionable rows on this page", { exact: true }).check();
  const bulk = await openBulkWorkspace(page, 2);
  await bulk.getByRole("button", { name: "Edit attributes for CARD-1", exact: true }).click();
  const details = bulk.getByRole("complementary", { name: "Item details", exact: true });
  await details.getByLabel("Search listing fields", { exact: true }).fill("Key Features");
  const guidance = details.locator('details[aria-label="Key Features guidance"]');
  await expect(guidance).toHaveCount(1);
  await expect(details.getByText(KEY_FEATURE_GUIDANCE, { exact: true })).toHaveCount(1);
  await guidance.locator("summary").click();
  await expect(guidance.getByText(KEY_FEATURE_GUIDANCE, { exact: true })).toBeVisible();
  await guidance.locator("summary").click();
  await details.getByRole("button", { name: "Remove Key Features 2", exact: true }).click();
  await expect(details.getByLabel(/^Key Features 2/)).toHaveValue("Archival material protects the surface");
  await details.getByRole("button", { name: "Add Key Features", exact: true }).click();
  await details.getByLabel(/^Key Features 3/).fill("Replacement for this item only");
  await page.screenshot({ path: info.outputPath("bulk-sleeves-key-features.png"), fullPage: true });
  await details.getByRole("button", { name: "Close details", exact: true }).click();
  await saveBulkWorkspace(page);
  expect(state.publication.draft.items).toEqual([{ ...original[0], attributes: { ...original[0].attributes,
    Visible: { ...(original[0].attributes.Visible as object), keyFeatures: ["Clear front keeps the card visible", "Archival material protects the surface", "Replacement for this item only"] } } }, original[1]]);
  expect(state.publication.writes).toHaveLength(1); expect(state.publication.operations).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("optional list controls enforce the schema maximum and clearing preserves unrelated values", async ({ page }) => {
  const state = await setup(page, { catalogEmpty: true }); seedTwoDrafts(state);
  const original = structuredClone(state.publication.draft.items);
  // Synthetic bounds isolate the shared array-control contract, not Walmart policy.
  state.publication.requirementsSchema = { type: "object", properties: { Visible: { type: "object", properties: {
    notes: { type: "array", title: "Notes", minItems: 1, maxItems: 2, items: { type: "string" } },
  } } } };
  await page.reload(); await page.getByRole("button", { name: "Edit CARD-1", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Jump to required details", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Add Notes", exact: true })).toBeHidden();
  await dialog.getByLabel("Search listing fields", { exact: true }).fill("Notes");
  const add = dialog.getByRole("button", { name: "Add Notes", exact: true });
  await add.click(); await expect(dialog.getByLabel(/^Notes 1/)).toBeFocused();
  await dialog.getByLabel(/^Notes 1/).fill("First note");
  await add.click(); await dialog.getByLabel(/^Notes 2/).fill("Second note");
  await expect(add).toBeDisabled();
  await dialog.getByRole("button", { name: "Remove Notes 1", exact: true }).click();
  await expect(dialog.getByLabel(/^Notes 1/)).toHaveValue("Second note");
  await expect(dialog.getByLabel(/^Notes 1/)).toBeFocused(); await expect(add).toBeEnabled();
  await dialog.getByRole("button", { name: "Clear all Notes", exact: true }).click();
  await expect(dialog.getByLabel(/^Notes 1/)).toHaveCount(0); await expect(add).toBeEnabled();
  await dialog.getByRole("button", { name: "Update draft item", exact: true }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved. No listing has been submitted.", { exact: true })).toBeVisible();
  expect(state.publication.draft.items).toEqual(original);
  expect(state.publication.operations).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("required fields stay visible, conditional choices reveal requirements and optional search preserves missing context", async ({ page }, info) => {
  const state = await setup(page, { catalogEmpty: true });
  state.publication.draft = { ...state.publication.draft, revision: 1, items: [listingDraftItemSchema.parse({ variantId: 1, productType: "Trading Card Accessories" })] };
  state.publication.requirementsSchema = { type: "object", required: ["Visible"], properties: { Visible: {
    type: "object", title: "Product details", required: ["dimensions", "hasWarranty"],
    properties: {
      dimensions: { type: "object", title: "Dimensions", required: ["width"], properties: { width: { type: "number", title: "Width" } } },
      hasWarranty: { type: "string", title: "Has warranty", enum: ["Yes", "No"] },
      warrantyText: { type: "string", title: "Warranty text" },
      color: { type: "string", title: "Color" },
    },
    allOf: [{ if: { properties: { hasWarranty: { const: "Yes" } }, required: ["hasWarranty"] }, then: { required: ["warrantyText"] } }],
  } } };
  await page.reload();
  await page.getByRole("button", { name: "Edit CARD-1", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Jump to required details", exact: true }).click();
  await expect(dialog.getByLabel(/^Width/)).toBeVisible();
  await expect(dialog.getByLabel(/^Warranty text/)).toHaveCount(0);
  await dialog.getByLabel(/^Has warranty/).selectOption("Yes");
  await expect(dialog.getByLabel(/^Warranty text/)).toBeVisible();
  await dialog.getByLabel("Search listing fields", { exact: true }).fill("Color");
  await expect(dialog.getByLabel(/^Color/)).toBeVisible();
  await expect(dialog.getByRole("region", { name: "Required fields summary", exact: true })).toContainText("required fields need attention");
  await dialog.getByRole("button", { name: /Go to .*Warranty text/ }).click();
  await expect(dialog.getByLabel(/^Warranty text/)).toBeFocused();
  await dialog.screenshot({ path: info.outputPath("required-listing-details.png") });
  await dialog.getByLabel(/^Warranty text/).fill("One year limited warranty");
  await dialog.getByLabel(/^Width/).fill("0");
  await expect(dialog.getByRole("region", { name: "Required fields summary", exact: true })).toContainText("Required fields shown here are filled");
  await dialog.getByRole("button", { name: "Update draft item", exact: true }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved. No listing has been submitted.", { exact: true })).toBeVisible();
  expect(state.publication.draft.items[0].attributes).toEqual({ Visible: { hasWarranty: "Yes", warrantyText: "One year limited warranty", dimensions: { width: 0 } } });
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("requirements failures show a retry and preserve edits while loading again", async ({ page }) => {
  const state = await setup(page, { catalogEmpty: true });
  seedTwoDrafts(state);
  state.publication.requirementsError = true;
  await page.reload();
  await page.getByRole("button", { name: "Edit CARD-1", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Jump to content", exact: true }).click();
  await dialog.getByLabel("Walmart title", { exact: true }).fill("Preserved during retry");
  await dialog.getByRole("button", { name: "Jump to required details", exact: true }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "Requirements temporarily unavailable" })).toBeVisible();
  state.publication.requirementsError = false;
  await dialog.getByRole("button", { name: "Retry required details", exact: true }).click();
  await expect(dialog.getByLabel(/^Shipping weight/)).toBeVisible();
  await expect(dialog.getByLabel("Walmart title", { exact: true })).toHaveValue("Preserved during retry");
  expect(state.publication.writes).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("single-item editing rejects a changed source after polling but merges an unrelated item change", async ({ page }) => {
  await page.clock.install();
  const state = await setup(page, { catalogEmpty: true });
  seedTwoDrafts(state);
  await page.reload();
  await page.getByRole("button", { name: "Edit CARD-1", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Walmart title", { exact: true }).fill("My unsaved title");
  state.publication.draft = { ...state.publication.draft, revision: 2,
    items: state.publication.draft.items.map(item => item.variantId === 1 ? { ...item, brand: "Another operator's brand" } : item) };
  const refresh = page.waitForResponse(response => new URL(response.url()).pathname === PUBLICATION_BASE);
  await page.clock.runFor(10_100);
  await refresh;
  await dialog.getByRole("button", { name: "Update draft item", exact: true }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "This draft item changed while editing was open" })).toBeVisible();
  await expect(dialog.getByLabel("Walmart title", { exact: true })).toHaveValue("My unsaved title");
  expect(state.publication.writes).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Edit CARD-1", exact: true }).click();
  await expect(dialog.getByLabel("Brand", { exact: true })).toHaveValue("Another operator's brand");
  await dialog.getByLabel("Walmart title", { exact: true }).fill("My updated title");
  state.publication.draft = { ...state.publication.draft, revision: 3,
    items: state.publication.draft.items.map(item => item.variantId === 26 ? { ...item, brand: "Unrelated operator change" } : item) };
  const nextRefresh = page.waitForResponse(response => new URL(response.url()).pathname === PUBLICATION_BASE);
  await page.clock.runFor(10_100);
  await nextRefresh;
  await dialog.getByRole("button", { name: "Update draft item", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved. No listing has been submitted.", { exact: true })).toBeVisible();
  expect(state.publication.draft.items).toMatchObject([{ variantId: 1, title: "My updated title", brand: "Another operator's brand" }, { variantId: 26, brand: "Unrelated operator change" }]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("bulk editing rejects changed selected drafts after polling without applying a partial patch", async ({ page }) => {
  await page.clock.install();
  const state = await setup(page, { catalogEmpty: true });
  seedTwoDrafts(state);
  await page.reload();
  await page.getByLabel("Select all actionable rows on this page", { exact: true }).check();
  const bulk = await openBulkWorkspace(page, 2);
  await bulk.getByLabel("Brand for all selected items", { exact: true }).fill("My bulk brand");
  await bulk.getByRole("button", { name: "Apply Brand to all", exact: true }).click();
  state.publication.draft = { ...state.publication.draft, revision: 2,
    items: state.publication.draft.items.map(item => item.variantId === 26 ? { ...item, brand: "New operator brand" } : item) };
  const expected = structuredClone(state.publication.draft.items);
  const refresh = page.waitForResponse(response => new URL(response.url()).pathname === PUBLICATION_BASE);
  await page.clock.runFor(10_100);
  await refresh;
  await bulk.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(bulk.getByRole("alert").filter({ hasText: "A selected draft changed while bulk editing was open" })).toBeVisible();
  expect(state.publication.writes).toEqual([]);
  expect(state.publication.draft.items).toEqual(expected);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("read-only draft rows cannot select items or open bulk editing", async ({ page }) => {
  const state = await setup(page, { readOnly: true, catalogEmpty: true });
  seedTwoDrafts(state);
  await page.reload();
  await expect(page.getByRole("button", { name: "View CARD-1", exact: true })).toBeVisible();
  await expect(page.getByLabel("Select all actionable rows on this page", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Select CARD-1", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Bulk edit selected/ })).toHaveCount(0);
  expect(state.publication.writes).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

const activityIds = {
  processing: "11111111-1111-4111-8111-111111111111",
  failed: "22222222-2222-4222-8222-222222222222",
  batch: "33333333-3333-4333-8333-333333333333",
  uncertain: "44444444-4444-4444-8444-444444444444",
  queued: "55555555-5555-4555-8555-555555555555",
};
const activityError = "The title must state 500 sleeves and the images must show the same selling unit. "
  + "Walmart content review details. ".repeat(8)
  + "https://example.com/content-review/" + "x".repeat(180);
function activitySubmissions() {
  const item = { variantId: 265, sku: "EG-SLV-STD-5PCK-B500", priceCents: 1499, state: "processing",
    externalProductId: null, error: null, stockState: "waiting_for_item" };
  const operation = { channelId: 77, state: "processing", submissionId: "18DC6ACE719D542B947125C001FFA28D@AXkBBwA",
    items: [item], createdAt: "2026-10-08T11:18:20.000Z", updatedAt: "2026-10-08T11:19:20.000Z", error: null };
  return [
    listingOperationSchema.parse({ ...operation, id: activityIds.processing }),
    listingOperationSchema.parse({ ...operation, id: activityIds.failed, state: "needs_attention", createdAt: "2026-10-08T01:49:44.000Z",
      items: [{ ...item, state: "needs_attention", canRetry: true, error: activityError }] }),
    listingOperationSchema.parse({ ...operation, id: activityIds.batch, state: "partially_completed", error: "One item needs correction.",
      items: [
        { ...item, variantId: 1, sku: "CARD-1", priceCents: 499, state: "verified", stockState: "setup_required" },
        { ...item, variantId: 26, sku: "CARD-26", priceCents: 999, state: "needs_attention", canRetry: true, error: "Invalid shipping weight" },
      ] }),
    listingOperationSchema.parse({ ...operation, id: activityIds.uncertain, state: "needs_reconciliation",
      items: [{ ...item, variantId: 99, sku: "VERY-LONG-SKU-" + "X".repeat(100), state: "needs_reconciliation", error: "Walmart outcome is not confirmed." }] }),
    listingOperationSchema.parse({ ...operation, id: activityIds.queued, state: "queued", submissionId: null, items: [] }),
  ];
}

test("publication activity uses compact expandable rows for long errors and mixed submissions", async ({ page }, info) => {
  const state = await setup(page, { inventoryAccess: "view" });
  state.publication.operations = activitySubmissions();
  await page.reload();
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  const activity = page.getByRole("region", { name: "Publication activity", exact: true });
  const rows = activity.locator("[data-submission-id]");
  await expect(rows).toHaveCount(5);
  await expect(activity.getByRole("region", { name: /^Submission details/ })).toHaveCount(0);
  await expect(activity.getByText(activityError, { exact: true })).toHaveCount(0);
  const failedRow = activity.locator(`[data-submission-id="${activityIds.failed}"]`);
  await expect(failedRow.getByText("Needs attention", { exact: true })).toBeVisible();
  await expect(failedRow.getByText("$14.99", { exact: true })).toBeVisible();
  const batchRow = activity.locator(`[data-submission-id="${activityIds.batch}"]`);
  await expect(batchRow.getByText("2 items", { exact: true })).toBeVisible();
  await expect(batchRow.getByText("Per item", { exact: true })).toBeVisible();
  await expect(batchRow.getByText("1 item needs attention", { exact: true })).toBeVisible();
  await expect(activity.locator(`[data-submission-id="${activityIds.queued}"]`).getByRole("button", { name: "Check Walmart status", exact: true })).toHaveCount(0);
  const rowHeights = await rows.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
  expect(Math.max(...rowHeights)).toBeLessThan(info.project.name === "mobile" ? 125 : 80);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await activity.screenshot({ path: info.outputPath("publication-activity-collapsed.png") });

  const disclosure = failedRow.getByRole("button", { name: /^Show details/ });
  await disclosure.focus();
  await page.keyboard.press("Enter");
  await expect(failedRow.getByRole("button", { name: /^Hide details/ })).toHaveAttribute("aria-expanded", "true");
  const detailsId = await failedRow.getByRole("button", { name: /^Hide details/ }).getAttribute("aria-controls");
  const details = page.locator(`[id="${detailsId}"]`);
  await expect(details.getByText(activityError, { exact: true })).toBeVisible();
  await expect(details.getByRole("button", { name: "Edit failed items", exact: true })).toBeVisible();
  await expect(details.getByText(state.publication.operations[1].submissionId!, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await activity.screenshot({ path: info.outputPath("publication-activity-expanded.png") });

  await batchRow.getByRole("button", { name: /^Show details/ }).click();
  const batchDetails = page.locator(`#publication-details-${activityIds.batch}`);
  await expect(batchDetails.getByText("$4.99", { exact: true })).toBeVisible();
  await expect(batchDetails.getByText("$9.99", { exact: true })).toBeVisible();
  await expect(batchDetails.getByText("Item verified", { exact: true })).toBeVisible();
  await expect(batchDetails.getByText("One item needs correction.", { exact: true })).toBeVisible();
  await batchDetails.getByRole("button", { name: "Review stock publishing", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(state.membership.writes[0].body).toEqual({ channelId: 77, channelConnectionId: 9, productVariantIds: [1] });
  await page.keyboard.press("Escape");
  await activity.locator(`[data-submission-id="${activityIds.processing}"]`).getByRole("button", { name: "Check Walmart status", exact: true }).click();
  await expect(activity.locator(`[data-submission-id="${activityIds.processing}"]`).getByText("Processed", { exact: true })).toBeVisible();
  await expect(failedRow.getByRole("button", { name: /^Hide details/ })).toHaveAttribute("aria-expanded", "true");
  await expect(batchDetails).toBeVisible();
  expect(state.publication.writes).toEqual([{ path: `${PUBLICATION_BASE}/operations/${activityIds.processing}/reconcile`, body: {} }]);
  await failedRow.getByRole("button", { name: /^Hide details/ }).focus();
  await page.keyboard.press("Space");
  await expect(details).toHaveCount(0);
  await expect(batchDetails).toBeVisible();
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("publication activity adapts to the available width beside an expanded sidebar", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop sidebar width regression");
  const state = await setup(page);
  state.publication.operations = activitySubmissions();
  await page.reload();
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  // The route harness omits AppShell; reserve its expanded sidebar width.
  await page.addStyleTag({ content: "#root { margin-left: 256px; }" });
  const activity = page.getByRole("region", { name: "Publication activity", exact: true });
  for (const width of [1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const sku = activity.locator(`[data-submission-id="${activityIds.processing}"]`).getByText("EG-SLV-STD-5PCK-B500", { exact: true });
    await expect(sku).toBeVisible();
    expect(await sku.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await activity.screenshot({ path: info.outputPath(`publication-activity-sidebar-${width}.png`) });
  }
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});
test("publication activity shows status request failures and prevents duplicate checks while pending", async ({ page }) => {
  const state = await setup(page);
  state.publication.operations = activitySubmissions();
  await page.reload();
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  const activity = page.getByRole("region", { name: "Publication activity", exact: true });
  const row = activity.locator(`[data-submission-id="${activityIds.processing}"]`);
  let release!: () => void;
  const responseReady = new Promise<void>(resolve => { release = resolve; });
  const path = `${PUBLICATION_BASE}/operations/${activityIds.processing}/reconcile`;
  await page.route(`**${path}`, async route => {
    await responseReady;
    await route.fulfill({ status: 503, json: { message: "Walmart status temporarily unavailable" } });
  });
  await row.getByRole("button", { name: "Check Walmart status", exact: true }).click();
  await expect(row.getByRole("button", { name: "Checking Walmart status", exact: true })).toBeDisabled();
  for (const button of await activity.getByRole("button", { name: "Check Walmart status", exact: true }).all()) {
    await expect(button).toBeDisabled();
  }
  release();
  await expect(activity.getByRole("alert")).toHaveText("Walmart status temporarily unavailable");
  await expect(row.getByRole("button", { name: "Check Walmart status", exact: true })).toBeEnabled();
  await expect(row.getByText("Walmart processing", { exact: true })).toBeVisible();
  await expect(activity.getByRole("region", { name: /^Submission details/ })).toHaveCount(0);
  await page.unroute(`**${path}`);
  await row.getByRole("button", { name: "Check Walmart status", exact: true }).click();
  await expect(row.getByText("Processed", { exact: true })).toBeVisible();
  await expect(activity.getByRole("alert")).toHaveCount(0);
  expect(state.publication.writes).toEqual([{ path, body: {} }]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("read-only publication activity expands results without exposing channel writes", async ({ page }) => {
  const state = await setup(page, { readOnly: true });
  state.publication.operations = activitySubmissions();
  await page.reload();
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  const activity = page.getByRole("region", { name: "Publication activity", exact: true });
  await activity.locator(`[data-submission-id="${activityIds.failed}"]`).getByRole("button", { name: /^Show details/ }).click();
  await expect(activity.getByText(activityError, { exact: true })).toBeVisible();
  await expect(activity.getByRole("button", { name: "Check Walmart status", exact: true })).toHaveCount(0);
  await expect(activity.getByRole("button", { name: "Edit failed items", exact: true })).toHaveCount(0);
  expect(state.publication.writes).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});
test("publication retries reuse command identity and later batches preserve submitted prices", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await page.getByRole("tab", { name: "Listing changes", exact: true }).click();
  await page.getByRole("tab", { name: "Listing Feed", exact: true }).click();
  await selectFirstProduct(page);
  await reviewSelectedDrafts(page, ["CARD-1"]);
  state.publication.loseSubmissionResponse = true;
  await page.getByRole("button", { name: "Publish 1 items", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Submission response interrupted" })).toBeVisible();
  await page.getByRole("button", { name: "Publish 1 items", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const submissions = state.publication.writes.filter(write => write.path === `${PUBLICATION_BASE}/operations`);
  await expect(page.getByRole("tab", { name: "Publication activity", exact: true })).toHaveAttribute("aria-selected", "true");
  expect(submissions).toHaveLength(2); expect(submissions[0].body).toEqual(submissions[1].body);
  await expect(page.getByText("Walmart processing", { exact: true })).toBeVisible();
  await expect(page.getByText("Live", { exact: true })).toHaveCount(0);
  // Store Setup always has this link; only Activity proves reconciliation completed.
  const activity = page.getByRole("tabpanel", { name: "Activity", exact: true });
  const inventoryLink = activity.getByRole("link", { name: "Channel Inventory", exact: true });
  await expect(inventoryLink).toHaveCount(0);
  await activity.getByRole("button", { name: "Check Walmart status", exact: true }).click();
  await activity.getByRole("button", { name: /^Show details for CARD-1,/ }).click();
  await expect(activity.getByText("Item verified", { exact: true })).toBeVisible();
  await expect(inventoryLink).toBeVisible();
  await expect(inventoryLink).toHaveAttribute("href", "/channels/inventory");
  await page.getByRole("tab", { name: "Listing Feed", exact: true }).click();
  await expect(page.getByText("0 draft items", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add products", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Next", exact: true }).click();
  await page.getByLabel("Select CARD-26", { exact: true }).check();
  await page.getByRole("button", { name: "Add 1 to draft", exact: true }).click();
  await page.getByRole("button", { name: "Edit CARD-26", exact: true }).click();
  await page.getByLabel("Fixed Walmart price (USD)", { exact: true }).fill("9.99");
  await page.getByRole("button", { name: "Update draft item", exact: true }).click();
  await reviewSelectedDrafts(page, ["CARD-26"]);
  await page.getByRole("button", { name: "Publish 1 items", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.publication.operations).toHaveLength(2);
  expect(state.publication.operations[0].items[0].priceCents).toBe(499);
  expect(state.publication.operations[1].items[0].priceCents).toBe(999);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("read-only publication workspace offers no draft, pricing or submission writes", async ({ page }) => {
  const state = await setup(page, { readOnly: true });
  await expect(page.getByText("0 draft items", { exact: true })).toBeVisible();
  await expect(page.getByText("Product CARD-P5", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add products", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Pricing Rules", exact: true }).click();
  await expect(page.getByLabel("Channel default", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save channel pricing rule", exact: true })).toHaveCount(0);
  expect(state.publication.writes).toEqual([]); expect(state.errors).toEqual([]);
});

test("pricing requires explicit preview and rejects a zero fixed selling price", async ({ page }) => {
  const state = await setup(page);
  await selectFirstProduct(page);
  await page.getByRole("tab", { name: "Pricing Rules", exact: true }).click();
  await page.getByLabel("Markup (%)", { exact: true }).fill("12.34");
  await page.getByLabel("Channel default", { exact: true }).selectOption("fixed");
  await expect(page.getByLabel("Amount (USD)", { exact: true })).toHaveValue("12.34");
  await expect(page.getByRole("button", { name: "Save channel pricing rule", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Preview prices", exact: true }).click();
  await expect(page.getByText("$17.33", { exact: true })).toBeVisible();
  expect(state.publication.writes).toEqual([]);
  await page.getByRole("button", { name: "Save channel pricing rule", exact: true }).click();
  await expect(page.getByText("Saved channel rule: $12.34 addition.", { exact: false })).toBeVisible();
  expect(state.publication.pricingRule).toEqual({ type: "fixed", value: "12.34" });
  await page.getByLabel("Channel default", { exact: true }).selectOption("override");
  await page.getByLabel("Amount (USD)", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Preview prices", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Fixed prices must be greater than zero" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save channel pricing rule", exact: true })).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test("failed items return to the draft without overwriting unrelated unsaved edits", async ({ page }) => {
  const state = await setup(page);
  await selectFirstProduct(page);
  await reviewSelectedDrafts(page, ["CARD-1"]);
  await page.getByRole("button", { name: "Publish 1 items", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  state.publication.operations[0].state = "needs_attention";
  state.publication.operations[0].items[0] = { ...state.publication.operations[0].items[0], state: "needs_attention", canRetry: true, error: "Invalid shipping weight" };
  await page.reload();
  await page.getByRole("button", { name: "Add products", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Next", exact: true }).click();
  await page.getByLabel("Select CARD-26", { exact: true }).check();
  await page.getByRole("button", { name: "Add 1 to draft", exact: true }).click();
  await page.getByRole("button", { name: "Edit CARD-26", exact: true }).click();
  await page.getByLabel("Fixed Walmart price (USD)", { exact: true }).fill("9.99");
  await page.getByRole("button", { name: "Update draft item", exact: true }).click();
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await page.getByRole("button", { name: /^Show details for CARD-1,/ }).click();
  await page.getByRole("button", { name: "Edit failed items", exact: true }).click();
  await expect(page.getByText("$9.99", { exact: true })).toBeVisible();
  await expect(page.getByText("CARD-1", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review selected (0)", exact: true })).toBeDisabled();
  expect(state.publication.operations).toHaveLength(1);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved. No listing has been submitted.", { exact: true })).toBeVisible();
  expect(state.publication.draft.items).toMatchObject([{ variantId: 26, priceOverrideCents: 999 }, { variantId: 1 }]);
  expect(state.errors).toEqual([]);
});

async function verifyFirstPublication(page: Page) {
  await selectFirstProduct(page);
  await reviewSelectedDrafts(page, ["CARD-1"]);
  await page.getByRole("button", { name: "Publish 1 items", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Check Walmart status", exact: true }).click();
  await page.getByRole("button", { name: /^Show details for CARD-1,/ }).click();
}

test("stock selection reviews exact verified SKUs and queues canonical updates with activation permission", async ({ page }) => {
  const state = await setup(page, { inventoryAccess: "activate" });
  await verifyFirstPublication(page);
  await page.getByRole("button", { name: "Review stock publishing", exact: true }).click();
  await expect(page.getByLabel("Publish stock for CARD-1", { exact: true })).not.toBeChecked();
  await page.getByLabel("Publish stock for CARD-1", { exact: true }).check();
  await page.getByRole("button", { name: "Review stock changes", exact: true }).click();
  await expect(page.getByText("policy quantity 8", { exact: false })).toBeVisible();
  expect(state.membership.writes.filter(write => write.path.endsWith("/apply"))).toHaveLength(0);
  await page.getByRole("button", { name: "Apply stock selection", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "inventory updates queued; Walmart quantities are not yet confirmed" })).toBeVisible();
  const apply = state.membership.writes.find(write => write.path.endsWith("/apply"))!;
  expect(apply.body).toMatchObject({ publicationTargetId: 200, expectedTargetRevision: "2", changes: [{ productVariantId: 1, included: true }], expectedReviewHash: "f".repeat(64) });
  expect(apply.body.idempotencyKey).toEqual(expect.any(String));
  expect(state.membership.writes[0].body).toEqual({ channelId: 77, channelConnectionId: 9, productVariantIds: [1] });
  await page.keyboard.press("Escape");
  await expect(page.getByText("Inventory setup required", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review stock publishing", exact: true })).toBeVisible();
  expect(state.errors).toEqual([]);
});

test("stock review requires inventory activation permission and exposes missing setup", async ({ page }) => {
  const state = await setup(page, { inventoryAccess: "view" });
  await verifyFirstPublication(page);
  await page.getByRole("button", { name: "Review stock publishing", exact: true }).click();
  await page.getByLabel("Publish stock for CARD-1", { exact: true }).check();
  await page.getByRole("button", { name: "Review stock changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply stock selection", exact: true })).toBeDisabled();
  await expect(page.getByText("Inventory activation permission is required to apply this review.", { exact: true })).toBeVisible();
  state.membership.blocked = true;
  await page.getByRole("button", { name: "Refresh readiness", exact: true }).click();
  await expect(page.getByText("A Walmart inventory destination is required", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open Channel Inventory setup", exact: true })).toBeVisible();
  expect(state.membership.writes.filter(write => write.path.endsWith("/apply"))).toHaveLength(0);
  expect(state.errors).toEqual([]);
});

test("listing changes use compact expandable rows in a separate activity tab", async ({ page }, info) => {
  const state = await setup(page);
  state.updates.updates = listingChangeHistory();
  state.updates.reportedProductType = "default";
  state.publication.operations = activitySubmissions();
  await page.reload();
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await expect(page.getByRole("region", { name: "Publication activity", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Listing changes", exact: true })).toHaveCount(0);
  const tabs = page.getByRole("tablist", { name: "Activity history", exact: true });
  await tabs.getByRole("tab", { name: "Publication activity", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "Listing changes", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "Publication activity", exact: true })).toHaveCount(0);
  const activity = page.getByRole("region", { name: "Listing changes", exact: true });
  const rows = activity.locator("[data-listing-update-id]");
  await expect(rows).toHaveCount(7);
  await expect(activity.getByRole("region", { name: /^Change details/ })).toHaveCount(0);
  expect(state.updates.verificationReads).toEqual([]);
  const rowHeights = await rows.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
  expect(Math.max(...rowHeights)).toBeLessThan(info.project.name === "mobile" ? 135 : 80);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("tabpanel", { name: "Activity", exact: true }).screenshot({ path: info.outputPath("listing-changes-collapsed.png") });

  const [latest, historical, failed, processing, uncertain] = state.updates.updates;
  const rowFor = (id: string) => activity.locator(`[data-listing-update-id="${id}"]`);
  await rowFor(historical.id).getByRole("button", { name: /^Show change details/ }).click();
  const historicalDetails = page.locator(`#listing-change-details-${historical.id}`);
  await expect(historicalDetails.getByText(historical.submissionId!, { exact: true })).toBeVisible();
  await expect(historicalDetails.getByText("Item result on Walmart", { exact: true })).toHaveCount(0);
  expect(state.updates.verificationReads).toEqual([]);
  await rowFor(historical.id).getByRole("button", { name: /^Hide change details/ }).click();

  const latestDisclosure = rowFor(latest.id).getByRole("button", { name: /^Show change details/ });
  await latestDisclosure.focus();
  await page.keyboard.press("Enter");
  const detailsId = await rowFor(latest.id).getByRole("button", { name: /^Hide change details/ }).getAttribute("aria-controls");
  const latestDetails = page.locator(`[id="${detailsId}"]`);
  await expect(latestDetails.getByText(latest.title, { exact: true })).toBeVisible();
  await expect(latestDetails.getByText(/The product type is not confirmed/)).toBeVisible();
  await expect(latestDetails.getByText("SYSTEM_PROBLEM", { exact: true })).toBeVisible();
  expect(state.updates.verificationReads).toEqual([`${UPDATE_BASE}/${latest.id}/verification`]);
  await rowFor(failed.id).getByRole("button", { name: /^Show change details/ }).click();
  await expect(page.locator(`#listing-change-details-${failed.id}`).getByText(failed.message!, { exact: true })).toBeVisible();
  await rowFor(uncertain.id).getByRole("button", { name: /^Show change details/ }).click();
  await expect(page.locator(`#listing-change-details-${uncertain.id}`).getByText(uncertain.title, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("tabpanel", { name: "Activity", exact: true }).screenshot({ path: info.outputPath("listing-changes-expanded.png") });

  await rowFor(processing.id).getByRole("button", { name: "Check Walmart status", exact: true }).click();
  await expect(rowFor(processing.id).getByText("Feed accepted", { exact: true })).toBeVisible();
  await expect(rowFor(latest.id).getByRole("button", { name: /^Hide change details/ })).toHaveAttribute("aria-expanded", "true");
  await expect(latestDetails).toBeVisible();
  expect(state.updates.writes).toEqual([{ path: `${UPDATE_BASE}/${processing.id}/status`, body: {} }]);
  await rowFor(latest.id).getByRole("button", { name: /^Hide change details/ }).focus();
  await page.keyboard.press("Space");
  await expect(latestDetails).toHaveCount(0);
  await rowFor(latest.id).getByRole("button", { name: `Edit listing ${latest.sku}`, exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Edit Walmart listing", exact: true })).toBeVisible();
  expect(state.reads).toContain(`${UPDATE_BASE}/item?sku=${latest.sku}`);
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "Listing Feed", exact: true }).click();
  await page.getByRole("button", { name: "View activity", exact: true }).first().click();
  await expect(tabs.getByRole("tab", { name: "Publication activity", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(activity).toHaveCount(0);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("listing changes adapt beside an expanded sidebar", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Desktop sidebar width regression");
  const state = await setup(page);
  state.updates.updates = listingChangeHistory();
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await page.getByRole("tab", { name: "Listing changes", exact: true }).click();
  await page.addStyleTag({ content: "#root { margin-left: 256px; }" });
  const activity = page.getByRole("region", { name: "Listing changes", exact: true });
  await expect(activity.locator("[data-listing-update-id]")).toHaveCount(7);
  for (const width of [1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const firstRow = activity.locator("[data-listing-update-id]").first();
    await expect(firstRow.getByText(state.updates.updates[0].sku, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("tabpanel", { name: "Activity", exact: true }).screenshot({ path: info.outputPath(`listing-changes-sidebar-${width}.png`) });
  }
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("listing changes show status failures and block duplicate checks while pending", async ({ page }) => {
  const state = await setup(page);
  state.updates.updates = listingChangeHistory();
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await page.getByRole("tab", { name: "Listing changes", exact: true }).click();
  const activity = page.getByRole("region", { name: "Listing changes", exact: true });
  const processing = state.updates.updates[3];
  const row = activity.locator(`[data-listing-update-id="${processing.id}"]`);
  const path = `${UPDATE_BASE}/${processing.id}/status`;
  let release!: () => void;
  const responseReady = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  await page.route(`**${path}`, async route => {
    calls++;
    await responseReady;
    await route.fulfill({ status: 503, json: { message: "Walmart status temporarily unavailable" } });
  });
  try {
    await row.getByRole("button", { name: "Check Walmart status", exact: true }).click();
    await expect(row.getByRole("button", { name: "Checking Walmart status", exact: true })).toBeDisabled();
    expect(calls).toBe(1);
  } finally { release(); }
  await expect(activity.getByRole("alert")).toHaveText("Walmart status temporarily unavailable");
  await expect(row.getByRole("button", { name: "Check Walmart status", exact: true })).toBeEnabled();
  await expect(row.getByText("Walmart processing", { exact: true })).toBeVisible();
  await page.unroute(`**${path}`);
  await row.getByRole("button", { name: "Check Walmart status", exact: true }).click();
  await expect(row.getByText("Feed accepted", { exact: true })).toBeVisible();
  await expect(activity.getByRole("alert")).toHaveCount(0);
  expect(state.updates.writes).toEqual([{ path, body: {} }]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("read-only listing changes expand details without edit or submission controls", async ({ page }) => {
  const state = await setup(page, { readOnly: true });
  state.updates.updates = listingChangeHistory();
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await page.getByRole("tab", { name: "Listing changes", exact: true }).click();
  const activity = page.getByRole("region", { name: "Listing changes", exact: true });
  const failed = state.updates.updates[2];
  await activity.locator(`[data-listing-update-id="${failed.id}"]`).getByRole("button", { name: /^Show change details/ }).click();
  await expect(activity.getByText(failed.message!, { exact: true })).toBeVisible();
  await expect(activity.getByRole("button", { name: /^Edit listing/ })).toHaveCount(0);
  await expect(activity.getByRole("button", { name: "Check Walmart status", exact: true })).toHaveCount(0);
  expect(state.updates.writes).toEqual([]); expect(state.publication.writes).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("listing changes show loading and empty history without hiding the tabs", async ({ page }) => {
  const state = await setup(page);
  let release!: () => void;
  const responseReady = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**${UPDATE_BASE}`, async route => {
    await responseReady;
    await route.fulfill({ json: [] });
  });
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await page.getByRole("tab", { name: "Listing changes", exact: true }).click();
  const activity = page.getByRole("region", { name: "Listing changes", exact: true });
  try { await expect(activity.getByRole("status")).toHaveText("Loading listing changes…"); }
  finally { release(); }
  await expect(activity.getByText("No listing changes yet. Edits sent to Walmart will appear here.", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Publication activity", exact: true })).toBeVisible();
  expect(state.updates.writes).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("listing changes load failures can be retried", async ({ page }) => {
  const state = await setup(page);
  await page.route(`**${UPDATE_BASE}`, route => route.fulfill({ status: 503, json: { message: "Listing history temporarily unavailable" } }));
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await page.getByRole("tab", { name: "Listing changes", exact: true }).click();
  const activity = page.getByRole("region", { name: "Listing changes", exact: true });
  await expect(activity.getByRole("alert")).toHaveText("Listing history temporarily unavailable");
  await expect(activity.getByText("No listing changes yet.", { exact: false })).toHaveCount(0);
  state.updates.updates = listingChangeHistory();
  await page.unroute(`**${UPDATE_BASE}`);
  await activity.getByRole("button", { name: "Reload listing changes", exact: true }).click();
  await expect(activity.locator("[data-listing-update-id]")).toHaveCount(7);
  await expect(activity.getByRole("alert")).toHaveCount(0);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});
