import { staffAuthorityFixture } from "./fixtures/staff-authority.fixture";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { view, policyHead, policyValue, HASH_A, HASH_B } from "../../client/src/features/channel-inventory/__tests__/fixtures";
import type { ChannelExposurePolicyValue, InventoryChannelExposureAdminView } from "../../shared/types/inventory-channel-exposure";

const BASE = "/api/inventory-planning/admin/channel-exposure";
const RULES = "/api/inventory-planning/admin/channel-rule-definitions";
const defaults = (overrides: Partial<ChannelExposurePolicyValue> = {}) => policyValue({ allocationSemantics: "exposure", eligible: true,
  shareBps: 10_000, holdbackSellableUnits: "0", maxPublish: { mode: "unlimited" }, minPublishSellableUnits: "0", ...overrides });
const channelDefault = (channelId: number, overrides: Partial<ChannelExposurePolicyValue> = {}) => policyHead({
  scopeKey: `channel:${channelId}`, channelId, scope: { scopeType: "channel", channelId }, active: defaults(overrides) });
const skuScope = (channelId: number) => ({ scopeType: "variant" as const, channelId, productId: 10, productVariantId: 101 });

/** Shopify US (3) and eBay (4) are managed; Amazon (6) and Dropship OMS (7) have no channel default. */
async function setup(page: Page, options: {
  permissions?: string[]; blockOn?: number; legacy?: boolean; extraHeads?: InventoryChannelExposureAdminView["policyHeads"];
} = {}) {
  const data: InventoryChannelExposureAdminView = view({
    runtimeAuthority: options.legacy ? "legacy" : "canonical",
    policyHeads: [
      channelDefault(3), channelDefault(4, { shareBps: 9000, maxPublish: { mode: "units", units: "100" } }),
      policyHead({ scopeKey: "channel:4:variant:101", channelId: 4, scope: skuScope(4), active: policyValue({ holdbackSellableUnits: "5" }), revision: "3" }),
      ...(options.extraHeads ?? []),
    ],
  });
  const state = { data, saves: [] as Array<Record<string, any>>, reviews: [] as Array<Record<string, any>>, applies: [] as Array<Record<string, any>>,
    unexpected: [] as string[], errors: [] as string[], nextPolicyId: 50 };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    if (path === "/api/auth/me") return route.fulfill({ json: staffAuthorityFixture({ user: { id: "operator-1", username: "operator", role: "operator" },
      permissions: options.permissions ?? ["inventory_planning:view", "inventory_planning:edit", "inventory_planning:activate"],
      systemRoles: [], assignedRoles: [{ id: 101, name: "operator", isSystem: false }] }) });
    if (path === BASE && method === "GET") return route.fulfill({ json: state.data });
    if (path === `${BASE}/policy-draft` && method === "PUT") {
      const body = request.postDataJSON();
      state.saves.push(body);
      const policyId = state.nextPolicyId += 1;
      const scopeKey = `channel:${body.scope.channelId}:variant:${body.scope.productVariantId}`;
      const existing = state.data.policyHeads.find(head => head.scopeKey === scopeKey);
      const revision = String(Number(existing?.revision ?? "0") + 1);
      // The saved draft becomes visible on the next view read, as the server does it.
      const saved = policyHead({ scopeKey, channelId: body.scope.channelId, scope: body.scope, draft: body.value, revision });
      state.data = { ...state.data, policyHeads: [...state.data.policyHeads.filter(head => head.scopeKey !== scopeKey),
        { ...saved, activePolicy: existing?.activePolicy ?? null, draftPolicy: { ...saved.draftPolicy!, policyId } }] };
      return route.fulfill({ json: { definitionId: policyId, version: 2, definitionHash: HASH_B, headRevision: revision,
        alreadyApplied: false, runtimeAuthorityChanged: false, providerWriteAttempted: false } });
    }
    if (path === `${RULES}/review` && method === "POST") {
      const selection = request.postDataJSON();
      state.reviews.push(selection);
      const channelId = selection.scope.channelId;
      const scopeKey = `channel:${channelId}:variant:101`;
      const blocked = options.blockOn === channelId;
      return route.fulfill({ json: { selection, scopeKey, channelId, channelName: channelId === 3 ? "Shopify US" : "eBay", productId: 10,
        authorityRevision: "1", activationRunId: "1", reviewHash: HASH_A, ready: !blocked,
        blockers: blocked ? ["eBay listing CARD-P5 has no stock link yet."] : [], warnings: [], skippedDestinations: [],
        change: { selection: { kind: "channel_policy", key: scopeKey, definitionId: selection.draftPolicyId, definitionHash: selection.expectedDefinitionHash },
          headRevision: selection.expectedHeadRevision, label: "CARD-P5", before: null, after: {} },
        quantities: [{ targetId: channelId === 3 ? 5 : 6, channelName: channelId === 3 ? "Shopify US" : "eBay", variantId: 101, sku: "CARD-P5", current: "12", proposed: "0" }] } });
    }
    if (path === `${RULES}/apply` && method === "POST") {
      const command = request.postDataJSON();
      state.applies.push(command);
      const scopeKey = `channel:${command.scope.channelId}:variant:101`;
      state.data = { ...state.data, policyHeads: state.data.policyHeads.map(head => head.scopeKey !== scopeKey ? head
        : { ...head, activePolicy: { ...head.draftPolicy!, lifecycleStatus: "sealed" as const }, draftPolicy: null }) };
      return route.fulfill({ json: { channelId: command.scope.channelId, appliedAt: "2026-11-10T12:00:00.000Z", appliedBy: "operator-1",
        reviewHash: HASH_A, publicationIds: ["31"], changedDefinitions: 1, alreadyApplied: false, scopeKey, productId: 10, policyId: command.draftPolicyId } });
    }
    state.unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 500, json: { error: { code: "UNEXPECTED_TEST_REQUEST", message: "Unexpected request" } } });
  });
  await page.route("**/__product-stock-rules-test*", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
    </head><body><main id="root"></main><script type="module" src="/@fs/${resolve("test/browser/fixtures/product-stock-rules-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto("/__product-stock-rules-test");
  await expect(page.getByTestId("product-stock-rules")).toBeVisible();
  return state;
}

test("shows one SKU's rule on every channel and where each number comes from", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("radio", { name: "CARD-P5" }).click();
  const ebay = page.getByTestId("stock-rule-row-4");
  await expect(ebay).toContainText("90%");
  await expect(ebay).toContainText("5SKU rule");
  await expect(ebay).toContainText("100default");
  await expect(ebay.getByRole("button", { name: "Edit" })).toBeVisible();
  await expect(page.getByTestId("stock-rule-row-3").getByRole("button", { name: "Add exception" })).toBeVisible();
  await expect(page.getByTestId("stock-rule-row-6")).toContainText("No channel default yet");
  await expect(page.getByTestId("stock-rule-row-6").getByRole("button")).toHaveCount(0);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("Max 0 on one channel saves and takes effect in one step", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("radio", { name: "CARD-P5" }).click();
  await page.getByTestId("stock-rule-row-3").getByRole("button", { name: "Add exception" }).click();
  const dialog = page.getByRole("dialog", { name: "Stock rule on Shopify US" });
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await dialog.getByLabel("Max", { exact: true }).click();
  await page.getByRole("option", { name: "Set a number" }).click();
  await dialog.getByLabel("Max units").fill("0");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("stock-rule-results")).toContainText("Shopify US: Applied. Shopify US 12 → 0.");
  await expect(page.getByTestId("stock-rule-row-3")).toContainText("Out of stock");
  expect(state.saves).toHaveLength(1);
  expect(state.saves[0]).toMatchObject({ scope: skuScope(3), expectedHeadRevision: "0",
    value: { maxPublish: { mode: "units", units: "0" }, shareBps: null, holdbackSellableUnits: null, minPublishSellableUnits: null } });
  expect(state.reviews).toHaveLength(1);
  expect(state.applies).toHaveLength(1);
  expect(state.applies[0]).toMatchObject({ scope: skuScope(3), draftPolicyId: state.reviews[0].draftPolicyId, expectedReviewHash: HASH_A });
  expect(state.unexpected).toEqual([]);
});

test("Set on all channels writes only the typed field and keeps each channel's other values", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("radio", { name: "CARD-P5" }).click();
  await page.getByRole("button", { name: "Set on all channels" }).click();
  const dialog = page.getByRole("dialog", { name: "Set on all channels" });
  await expect(dialog).toContainText("Shopify US, eBay");
  await dialog.getByLabel("Max", { exact: true }).click();
  await page.getByRole("option", { name: "Set a number" }).click();
  await dialog.getByLabel("Max units").fill("0");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("stock-rule-results")).toContainText("eBay: Applied.");
  expect(state.saves.map(save => save.scope.channelId)).toEqual([3, 4]);
  // eBay already had Buffer 5 on this SKU; it is kept.
  expect(state.saves[1].value).toMatchObject({ maxPublish: { mode: "units", units: "0" }, holdbackSellableUnits: "5" });
  expect(state.saves[0].value).toMatchObject({ maxPublish: { mode: "units", units: "0" }, holdbackSellableUnits: null });
  expect(state.applies).toHaveLength(2);
  await expect(page.getByTestId("stock-rule-row-3")).toContainText("Out of stock");
  await expect(page.getByTestId("stock-rule-row-4")).toContainText("Out of stock");
});

test("an old unapplied Show as out of stock rule is shown as Max 0 and saved as Max 0, never applied as the old flag", async ({ page }) => {
  const state = await setup(page, { extraHeads: [policyHead({ scopeKey: "channel:3:variant:101", channelId: 3, scope: skuScope(3),
    draft: policyValue({ eligible: false }), revision: "2" })] });
  await page.getByRole("radio", { name: "CARD-P5" }).click();
  await expect(page.getByTestId("stock-rule-row-3")).toContainText("Out of stock");
  await page.getByRole("button", { name: "Set on all channels" }).click();
  const dialog = page.getByRole("dialog", { name: "Set on all channels" });
  await dialog.getByLabel("Max", { exact: true }).click();
  await page.getByRole("option", { name: "Set a number" }).click();
  await dialog.getByLabel("Max units").fill("0");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("stock-rule-results")).toContainText("eBay: Applied.");
  // Shopify already read as Max 0, so nothing typed differs there; it is still re-saved without the flag.
  expect(state.saves.map(save => save.scope.channelId)).toEqual([3, 4]);
  expect(state.saves[0]).toMatchObject({ expectedHeadRevision: "2", value: { eligible: null, maxPublish: { mode: "units", units: "0" } } });
  expect(state.applies).toHaveLength(2);
  expect(state.applies[0].draftPolicyId).toBe(state.reviews[0].draftPolicyId);
  expect(state.reviews[0].draftPolicyId).toBe(51);
  expect(state.unexpected).toEqual([]);
});

test("a channel whose check fails is reported and the others still apply", async ({ page }) => {
  const state = await setup(page, { blockOn: 4 });
  await page.getByRole("radio", { name: "CARD-P5" }).click();
  await page.getByRole("button", { name: "Set on all channels" }).click();
  const dialog = page.getByRole("dialog", { name: "Set on all channels" });
  await dialog.getByLabel("Hide when below").fill("3");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const results = page.getByTestId("stock-rule-results");
  await expect(results).toContainText("Shopify US: Applied.");
  await expect(results).toContainText("eBay: Saved but not applied: eBay listing CARD-P5 has no stock link yet.");
  expect(state.applies.map(command => command.scope.channelId)).toEqual([3]);
  await expect(page.getByTestId("stock-rule-row-4")).toContainText("Saved, not applied");
});

test("a bad number changes nothing on any channel", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("radio", { name: "CARD-P5" }).click();
  await page.getByRole("button", { name: "Set on all channels" }).click();
  const dialog = page.getByRole("dialog", { name: "Set on all channels" });
  await dialog.getByLabel("Stock %").fill("150");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(state.saves).toEqual([]);
});

test("clearing an exception returns the SKU to the channel default", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("radio", { name: "CARD-P5" }).click();
  await page.getByTestId("stock-rule-row-4").getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Stock rule on eBay" });
  await expect(dialog.getByLabel("Buffer")).toHaveValue("5");
  await dialog.getByRole("button", { name: "Clear exception" }).click();
  await expect(page.getByTestId("stock-rule-results")).toContainText("eBay: Applied.");
  expect(state.saves[0].value).toMatchObject({ inheritAll: true, holdbackSellableUnits: null });
  await expect(page.getByTestId("stock-rule-row-4")).toContainText("Channel default");
});

test("view-only staff see the rules but cannot change them", async ({ page }) => {
  await setup(page, { permissions: ["inventory_planning:view"] });
  await expect(page.getByTestId("stock-rule-row-3")).toBeVisible();
  await expect(page.getByRole("button", { name: "Set on all channels" })).toHaveCount(0);
  await expect(page.getByTestId("stock-rule-row-3").getByRole("button")).toHaveCount(0);
  await expect(page.getByText("Changing stock rules needs inventory planning edit and activate permission.")).toBeVisible();
});

test("before cutover the card explains itself instead of offering rules that do nothing", async ({ page }) => {
  await setup(page, { legacy: true });
  await expect(page.getByText("Stock rules apply after inventory cutover.")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
});
