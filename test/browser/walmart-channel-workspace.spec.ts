import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { ChannelCatalogRow } from "../../shared/types/channel-catalog";
import { listingDraftItemSchema, listingOperationSchema } from "../../shared/types/channel-listing-publication";
import { createMembershipMock, createPublicationMock, handleMembershipRequest, handlePublicationRequest, PUBLICATION_BASE } from "./walmart-publication-fixtures";

const BASE = "/api/channels/77";
const status = { channelId: 77, connectionId: 9, partnerId: "10002558022", partnerName: "Card Shellz", environment: "production",
  shipNodeId: "10002558022", warehouseId: 1, ordersEnabled: true, importSince: "2026-09-13T11:46:00.000Z",
  lastPollAt: null, lastSuccessAt: null, lastErrorCode: null, revision: 1, mappedSkus: 0 };
const listing = (sku: string, matched = true): ChannelCatalogRow => ({ sku, title: `Product ${sku}`, externalProductId: `WPID-${sku}`,
  externalVariantId: sku, externalInventoryItemId: sku, lifecycleStatus: "ACTIVE", publishedStatus: "PUBLISHED",
  mappingStatus: matched ? "matched" : "unmatched", variant: matched ? { id: 11, sku, name: "Card sleeves", eligible: true } : null, message: null });
async function setup(page: Page, options: { readOnly?: boolean; connected?: boolean; catalogError?: boolean; catalogEmpty?: boolean; remoteRows?: ChannelCatalogRow[]; blocked?: boolean; inventoryAccess?: "view" | "activate" } = {}) {
  const state = { writes: [] as { path: string; body: any }[], reads: [] as string[], errors: [] as string[], unexpected: [] as string[],
    connected: options.connected !== false, linked: false, catalogError: options.catalogError ?? false,
    remoteRows: options.remoteRows ?? (options.catalogEmpty ? [] : null), publication: createPublicationMock(), membership: createMembershipMock() };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/api/**", async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    if (req.method() === "GET") state.reads.push(url.pathname + url.search);
    if (await handlePublicationRequest(route, state.publication)) return;
    if (await handleMembershipRequest(route, state.membership)) return;
    if (req.method() === "GET") {
      if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "operator", username: "operator", role: "operator" }, roles: ["operator"],
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
  await page.route("**/__walmart-test", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
    </head><body><main id="root"></main><script type="module" src="/@fs/${resolve("test/browser/fixtures/walmart-channel-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto("/__walmart-test");
  await expect(page.getByText("Store Setup", { exact: true })).toBeVisible();
  return state;
}
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

function seedTwoDrafts(state: Awaited<ReturnType<typeof setup>>) {
  state.publication.draft = { ...state.publication.draft, revision: 1, items: [
    listingDraftItemSchema.parse({ variantId: 1, productType: "Trading Card Accessories", brand: "First brand", priceOverrideCents: 549,
      identifier: { type: "UPC", value: "012345678905" }, attributes: { Orderable: { shippingWeight: 0.2 }, Visible: { countryOfOrigin: "US", color: "Red" } } }),
    listingDraftItemSchema.parse({ variantId: 26, productType: "Trading Card Accessories", brand: "Second brand", priceOverrideCents: 749,
      identifier: { type: "UPC", value: "036000291452" }, attributes: { Orderable: { shippingWeight: 0.4 }, Visible: { countryOfOrigin: "CN", color: "Blue" } } }),
  ] };
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
  await expect(existing.getByRole("button", { name: /^Edit / })).toHaveCount(0);
  await expect(existing.getByText("$4.99", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Review 1 items", exact: true }).click();
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
  state.publication.draft = { ...state.publication.draft, revision: 1,
    items: [listingDraftItemSchema.parse({ variantId: 1, productType: "Trading Card Accessories" })] };
  await page.reload();
  await page.getByRole("button", { name: "View CARD-1", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("Trading Card Accessories", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Change product type", exact: true })).toBeDisabled();
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
  await page.getByRole("button", { name: "Review 1 items", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Shipping weight is required", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Publish 1 items", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Edit details for CARD-1", exact: true }).click();
  await expect(page.getByLabel("Identifier for this selling unit", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Update draft item", exact: true })).toBeVisible();
  expect(state.publication.operations).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("bulk edits apply only opted-in fields to selected drafts and preserve each identifier and attributes", async ({ page }, info) => {
  const state = await setup(page, { catalogEmpty: true });
  seedTwoDrafts(state);
  const original = structuredClone(state.publication.draft.items);
  await page.reload();
  await page.getByLabel("Select all actionable rows on this page", { exact: true }).check();
  await page.getByRole("button", { name: "Bulk edit selected (2)", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Apply to 2 draft items", exact: true })).toBeDisabled();
  await dialog.getByLabel("Brand action", { exact: true }).selectOption("override");
  await dialog.getByLabel("Shared brand", { exact: true }).fill("Shared test brand");
  await dialog.getByLabel("Fixed Walmart price (USD) action", { exact: true }).selectOption("override");
  await dialog.getByLabel("Shared fixed walmart price (usd)", { exact: true }).fill("8.99");
  await dialog.getByLabel("Change shared provider attributes", { exact: true }).check();
  await dialog.getByLabel(/^Country of origin/).selectOption("US");
  await dialog.getByRole("region", { name: "Bulk edit preview", exact: true }).scrollIntoViewIfNeeded();
  await expect(dialog.getByText("2 of 2 selected drafts will change.", { exact: false })).toBeVisible();
  await dialog.screenshot({ path: info.outputPath("bulk-edit-preview.png") });
  expect(state.publication.writes).toEqual([]);
  await dialog.getByRole("button", { name: "Apply to 2 draft items", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.publication.writes).toEqual([]);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved. No listing has been submitted.", { exact: true })).toBeVisible();
  expect(state.publication.draft.items).toEqual(original.map(item => ({ ...item, brand: "Shared test brand", priceOverrideCents: 899,
    attributes: { ...item.attributes, Visible: { ...(item.attributes.Visible as object), countryOfOrigin: "US" } } })));
  expect(state.publication.operations).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("bulk cancel and invalid price preserve the draft and one selected item can return to inherited pricing", async ({ page }) => {
  const state = await setup(page, { catalogEmpty: true });
  seedTwoDrafts(state);
  const original = structuredClone(state.publication.draft.items);
  await page.reload();
  await page.getByLabel("Select CARD-1", { exact: true }).check();
  await page.getByRole("button", { name: "Bulk edit selected (1)", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Fixed Walmart price (USD) action", { exact: true }).selectOption("override");
  await dialog.getByLabel("Shared fixed walmart price (usd)", { exact: true }).fill("0");
  await expect(dialog.getByRole("button", { name: "Apply to 1 draft item", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(state.publication.draft.items).toEqual(original);
  expect(state.publication.writes).toEqual([]);
  await page.getByRole("button", { name: "Bulk edit selected (1)", exact: true }).click();
  await dialog.getByLabel("Fixed Walmart price (USD) action", { exact: true }).selectOption("inherit");
  await dialog.getByRole("button", { name: "Apply to 1 draft item", exact: true }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved. No listing has been submitted.", { exact: true })).toBeVisible();
  expect(state.publication.draft.items).toEqual([{ ...original[0], priceOverrideCents: null }, original[1]]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("bulk product type changes preview and clear only attributes belonging to the changed type", async ({ page }) => {
  const state = await setup(page, { catalogEmpty: true });
  seedTwoDrafts(state);
  state.publication.draft.items[1].productType = "Trading Card Storage";
  const original = structuredClone(state.publication.draft.items);
  await page.reload();
  await page.getByLabel("Select all actionable rows on this page", { exact: true }).check();
  await page.getByRole("button", { name: "Bulk edit selected (2)", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Change shared provider attributes", { exact: true })).toBeDisabled();
  await dialog.getByLabel("Change product type for selected drafts", { exact: true }).check();
  await dialog.getByRole("button", { name: "Browse product types", exact: true }).click();
  await dialog.getByRole("button", { name: "Browse Collectibles", exact: true }).click();
  await dialog.getByRole("button", { name: "Browse Card Storage", exact: true }).click();
  await dialog.getByRole("button", { name: "Select Trading Card Storage", exact: true }).click();
  await expect(dialog.getByLabel("Change shared provider attributes", { exact: true })).toBeEnabled();
  await expect(dialog.getByText("Existing provider attributes will be cleared on 1 item.", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Apply to 2 draft items", exact: true }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved. No listing has been submitted.", { exact: true })).toBeVisible();
  expect(state.publication.draft.items).toEqual([{ ...original[0], productType: "Trading Card Storage", attributes: {} }, original[1]]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
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
  await page.getByRole("button", { name: "Bulk edit selected (2)", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Brand action", { exact: true }).selectOption("override");
  await dialog.getByLabel("Shared brand", { exact: true }).fill("My bulk brand");
  state.publication.draft = { ...state.publication.draft, revision: 2,
    items: state.publication.draft.items.map(item => item.variantId === 26 ? { ...item, brand: "New operator brand" } : item) };
  const expected = structuredClone(state.publication.draft.items);
  const refresh = page.waitForResponse(response => new URL(response.url()).pathname === PUBLICATION_BASE);
  await page.clock.runFor(10_100);
  await refresh;
  await dialog.getByRole("button", { name: "Apply to 2 draft items", exact: true }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "A selected draft changed while bulk editing was open" })).toBeVisible();
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

test("publication retries reuse command identity and later batches preserve submitted prices", async ({ page }) => {
  const state = await setup(page);
  await selectFirstProduct(page);
  await page.getByRole("button", { name: "Review 1 items", exact: true }).click();
  state.publication.loseSubmissionResponse = true;
  await page.getByRole("button", { name: "Publish 1 items", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Submission response interrupted" })).toBeVisible();
  await page.getByRole("button", { name: "Publish 1 items", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const submissions = state.publication.writes.filter(write => write.path === `${PUBLICATION_BASE}/operations`);
  expect(submissions).toHaveLength(2); expect(submissions[0].body).toEqual(submissions[1].body);
  await expect(page.getByText("Walmart processing", { exact: true })).toBeVisible();
  await expect(page.getByText("Live", { exact: true })).toHaveCount(0);
  // Store Setup always has this link; only Activity proves reconciliation completed.
  const activity = page.getByRole("tabpanel", { name: "Activity", exact: true });
  const inventoryLink = activity.getByRole("link", { name: "Channel Inventory", exact: true });
  await expect(inventoryLink).toHaveCount(0);
  await activity.getByRole("button", { name: "Check Walmart status", exact: true }).click();
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
  await page.getByRole("button", { name: "Review 1 items", exact: true }).click();
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
  await page.getByRole("button", { name: "Review 1 items", exact: true }).click();
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
  await page.getByRole("button", { name: "Edit failed items", exact: true }).click();
  await expect(page.getByText("$9.99", { exact: true })).toBeVisible();
  await expect(page.getByText("CARD-1", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review 2 items", exact: true })).toBeVisible();
  expect(state.publication.operations).toHaveLength(1);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft saved. No listing has been submitted.", { exact: true })).toBeVisible();
  expect(state.publication.draft.items).toMatchObject([{ variantId: 26, priceOverrideCents: 999 }, { variantId: 1 }]);
  expect(state.errors).toEqual([]);
});

async function verifyFirstPublication(page: Page) {
  await selectFirstProduct(page);
  await page.getByRole("button", { name: "Review 1 items", exact: true }).click();
  await page.getByRole("button", { name: "Publish 1 items", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Check Walmart status", exact: true }).click();
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
