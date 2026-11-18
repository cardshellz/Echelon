import { staffAuthorityFixture } from "./fixtures/staff-authority.fixture";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { view, policyHead, policyValue, target, HASH_A, HASH_B } from "../../client/src/features/channel-inventory/__tests__/fixtures";
import type { ChannelExposurePolicyValue, InventoryChannelExposureAdminView } from "../../shared/types/inventory-channel-exposure";

const BASE = "/api/inventory-planning/admin/channel-exposure";
const RULES = "/api/inventory-planning/admin/channel-rule-definitions";
const defaults = (overrides: Partial<ChannelExposurePolicyValue> = {}) => policyValue({ allocationSemantics: "exposure", eligible: true,
  shareBps: 10_000, holdbackSellableUnits: "0", maxPublish: { mode: "unlimited" }, minPublishSellableUnits: "0", ...overrides });
const channelDefault = (channelId: number, overrides: Partial<ChannelExposurePolicyValue> = {}) => policyHead({
  scopeKey: `channel:${channelId}`, channelId, scope: { scopeType: "channel", channelId }, active: defaults(overrides) });
const skuScope = (channelId: number) => ({ scopeType: "variant" as const, channelId, productId: 10, productVariantId: 101 });
const SENT_AT = "2026-10-28T14:00:00.000Z";
/** Delivery evidence: Shopify US (destination 5) accepted 100 for CARD-P5; eBay (destination 6) has no listing for it. */
const publicationStatus = (publicationTargetId: number) => ({
  publicationTargetId, productId: 10, capturedAt: "2026-11-11T12:00:00.000Z", runtimeAuthority: "canonical", targetRevision: "3",
  rows: publicationTargetId === 5
    ? [{ productVariantId: 101, activeInventoryItemId: "item-101",
      desired: { outboxId: "7", revision: "7", quantity: "100", targetRevision: "3", state: "verified", createdAt: SENT_AT },
      acknowledged: { outboxId: "7", quantity: "100", acknowledgedAt: SENT_AT }, observed: null }]
    : [{ productVariantId: 101, activeInventoryItemId: null, desired: null, acknowledged: null, observed: null }],
});

/** Shopify US (3) and eBay (4) are managed and each has one live destination; Amazon (6) and Dropship OMS (7) have no channel default. */
async function setup(page: Page, options: {
  permissions?: string[]; blockOn?: number; legacy?: boolean; extraHeads?: InventoryChannelExposureAdminView["policyHeads"];
} = {}) {
  const data: InventoryChannelExposureAdminView = view({
    runtimeAuthority: options.legacy ? "legacy" : "canonical",
    publicationTargets: [target({ state: "live" }),
      target({ id: 6, channelId: 4, channelConnectionId: 44, providerScopeType: "account", externalScopeId: "ebay-user-9", state: "live" })],
    policyHeads: [
      channelDefault(3), channelDefault(4, { shareBps: 9000, maxPublish: { mode: "units", units: "100" } }),
      policyHead({ scopeKey: "channel:4:variant:101", channelId: 4, scope: skuScope(4), active: policyValue({ holdbackSellableUnits: "5" }), revision: "3" }),
      ...(options.extraHeads ?? []),
    ],
  });
  // `sets`: the one command that saves and applies. `saves`: plain draft saves, which only Discard still makes.
  // The separate review and apply endpoints are not mocked: a call to either is an unexpected request.
  const state = { data, sets: [] as Array<Record<string, any>>, saves: [] as Array<Record<string, any>>,
    unexpected: [] as string[], errors: [] as string[], nextPolicyId: 50 };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    if (path === "/api/auth/me") return route.fulfill({ json: staffAuthorityFixture({ user: { id: "operator-1", username: "operator", role: "operator" },
      permissions: options.permissions ?? ["inventory_planning:view", "inventory_planning:edit", "inventory_planning:activate"],
      systemRoles: [], assignedRoles: [{ id: 101, name: "operator", isSystem: false }] }) });
    if (path === BASE && method === "GET") return route.fulfill({ json: state.data });
    if (path === `${BASE}/publication-status` && method === "GET") {
      return route.fulfill({ json: publicationStatus(Number(new URL(request.url()).searchParams.get("publicationTargetId"))) });
    }
    if (path === `${BASE}/policy-draft` && method === "PUT") {
      const body = request.postDataJSON();
      state.saves.push(body);
      const policyId = state.nextPolicyId += 1;
      const scopeKey = `channel:${body.scope.channelId}:variant:${body.scope.productVariantId}`;
      const existing = state.data.policyHeads.find(head => head.scopeKey === scopeKey);
      const revision = String(Number(existing?.revision ?? "0") + 1);
      // The saved draft becomes visible on the next view read, as the server does it.
      const saved = policyHead({ scopeKey, channelId: body.scope.channelId, scope: body.scope, draft: body.value, revision });
      // Every saved version gets its own hash here, so the card cannot lean on hashes to tell rules apart.
      state.data = { ...state.data, policyHeads: [...state.data.policyHeads.filter(head => head.scopeKey !== scopeKey),
        { ...saved, activePolicy: existing?.activePolicy ?? null, draftPolicy: { ...saved.draftPolicy!, policyId } }] };
      return route.fulfill({ json: { definitionId: policyId, version: 2, definitionHash: HASH_B, headRevision: revision,
        alreadyApplied: false, runtimeAuthorityChanged: false, providerWriteAttempted: false } });
    }
    if (path === `${RULES}/set` && method === "POST") {
      const command = request.postDataJSON();
      state.sets.push(command);
      const channelId = command.scope.channelId;
      const channelName = channelId === 3 ? "Shopify US" : "eBay";
      const scopeKey = `channel:${channelId}:variant:101`;
      // A refusal is the whole transaction rolled back: the view is exactly what it was.
      if (options.blockOn === channelId) {
        return route.fulfill({ status: 409, json: { error: { code: "CHANNEL_RULE_REVIEW_BLOCKED",
          message: "This rule would create a problem, so it was not saved. Nothing changed.",
          details: ["eBay listing CARD-P5 has no stock link yet."] } } });
      }
      const policyId = state.nextPolicyId += 1;
      const existing = state.data.policyHeads.find(head => head.scopeKey === scopeKey);
      // Saved and applied together: the value is the rule in use and nothing is left waiting.
      const applied = policyHead({ scopeKey, channelId, scope: command.scope, active: command.value,
        revision: String(Number(existing?.revision ?? "0") + 2) });
      state.data = { ...state.data, policyHeads: [...state.data.policyHeads.filter(head => head.scopeKey !== scopeKey),
        { ...applied, activePolicy: { ...applied.activePolicy!, policyId } }] };
      return route.fulfill({ json: {
        receipt: { channelId, appliedAt: "2026-11-10T12:00:00.000Z", appliedBy: "operator-1", reviewHash: HASH_A, publicationIds: ["31"],
          changedDefinitions: 1, alreadyApplied: false, scopeKey, productId: 10, policyId },
        quantities: [{ targetId: channelId === 3 ? 5 : 6, channelName, variantId: 101, sku: "CARD-P5", current: "12", proposed: "0" }],
        skippedDestinations: [], warnings: [] } });
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
  // One plain answer per row: which rule is in use. No "out of stock" or "exception" badge.
  await expect(ebay).toContainText("SKU rule");
  await expect(page.getByTestId("stock-rule-row-3")).toContainText("Channel default");
  await expect(page.getByTestId("product-stock-rules")).not.toContainText(/out of stock/i);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("shows the quantity each channel was last sent for the picked SKU", async ({ page }) => {
  const state = await setup(page);
  // A whole product has several SKUs, so there is no single number to show.
  await expect(page.getByRole("columnheader", { name: "Last sent" })).toHaveCount(0);
  await page.getByRole("radio", { name: "CARD-P5" }).click();
  await expect(page.getByRole("columnheader", { name: "Last sent" })).toBeVisible();
  await expect(page.getByTestId("last-sent-3")).toContainText("100");
  await expect(page.getByTestId("last-sent-3")).toContainText("ago");
  await expect(page.getByTestId("last-sent-4")).toHaveText("Not listed");
  await expect(page.getByTestId("last-sent-6")).toHaveText("No destination");
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
  await expect(dialog).toContainText("With Max 0 nothing is sent to this channel, so Stock %, Buffer and Hide when below have no effect.");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("stock-rule-results")).toContainText("Shopify US: Saved. Shopify US 12 → 0.");
  await expect(page.getByTestId("stock-rule-row-3")).toContainText("0not sold here · SKU rule");
  await expect(page.getByTestId("stock-rule-row-3")).not.toContainText(/out of stock/i);
  // One request does all of it; no separate save, check or apply request is made.
  expect(state.sets).toHaveLength(1);
  expect(state.sets[0]).toMatchObject({ scope: skuScope(3), expectedHeadRevision: "0", expectedDraftPolicyId: null, expectedDraftDefinitionHash: null,
    value: { maxPublish: { mode: "units", units: "0" }, shareBps: null, holdbackSellableUnits: null, minPublishSellableUnits: null } });
  expect(state.sets[0].idempotencyKey).toEqual(expect.any(String));
  expect(state.saves).toEqual([]);
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
  await expect(page.getByTestId("stock-rule-results")).toContainText("eBay: Saved.");
  expect(state.sets.map(command => command.scope.channelId)).toEqual([3, 4]);
  // eBay already had Buffer 5 on this SKU; it is kept.
  expect(state.sets[1].value).toMatchObject({ maxPublish: { mode: "units", units: "0" }, holdbackSellableUnits: "5" });
  expect(state.sets[0].value).toMatchObject({ maxPublish: { mode: "units", units: "0" }, holdbackSellableUnits: null });
  expect(state.sets[1]).toMatchObject({ expectedHeadRevision: "3", expectedDraftPolicyId: null });
  expect(state.saves).toEqual([]);
  expect(state.unexpected).toEqual([]);
  await expect(page.getByTestId("stock-rule-row-3")).toContainText("not sold here");
  await expect(page.getByTestId("stock-rule-row-4")).toContainText("not sold here");
});

test("an old unapplied Show as out of stock rule is shown as Max 0 and saved as Max 0, never applied as the old flag", async ({ page }) => {
  const state = await setup(page, { extraHeads: [policyHead({ scopeKey: "channel:3:variant:101", channelId: 3, scope: skuScope(3),
    draft: policyValue({ eligible: false }), revision: "2" })] });
  await page.getByRole("radio", { name: "CARD-P5" }).click();
  // The old draft was never applied, so the row shows what the channel uses; the leftover is named below the table.
  await expect(page.getByTestId("stock-rule-row-3")).toContainText("No maxdefault");
  await expect(page.getByTestId("stock-rule-row-3")).toContainText("Channel default");
  await expect(page.getByTestId("stock-rule-row-3")).not.toContainText("Max 0");
  await expect(page.getByRole("note").filter({ hasText: "A saved change never took effect" }))
    .toContainText("Shopify US: Max 0. The channel is still using the numbers shown above.");
  await page.getByRole("button", { name: "Set on all channels" }).click();
  const dialog = page.getByRole("dialog", { name: "Set on all channels" });
  await dialog.getByLabel("Max", { exact: true }).click();
  await page.getByRole("option", { name: "Set a number" }).click();
  await dialog.getByLabel("Max units").fill("0");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("stock-rule-results")).toContainText("eBay: Saved.");
  await expect(page.getByText("A saved change never took effect")).toHaveCount(0);
  // Shopify already read as Max 0, so nothing typed differs there; it is still re-saved without the flag.
  expect(state.sets.map(command => command.scope.channelId)).toEqual([3, 4]);
  // The command names the leftover it replaces, so the server overwrites exactly that saved change.
  expect(state.sets[0]).toMatchObject({ expectedHeadRevision: "2", expectedDraftPolicyId: expect.any(Number),
    expectedDraftDefinitionHash: expect.any(String), value: { eligible: null, maxPublish: { mode: "units", units: "0" } } });
  expect(state.saves).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("an old unapplied change can be discarded without changing what the channel uses", async ({ page }) => {
  const state = await setup(page, { extraHeads: [policyHead({ scopeKey: "channel:3:variant:101", channelId: 3, scope: skuScope(3),
    draft: policyValue({ eligible: false }), revision: "2" })] });
  await page.getByRole("radio", { name: "CARD-P5" }).click();
  await page.getByTestId("stock-rule-row-3").getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Stock rule on Shopify US" });
  await expect(dialog).toContainText("Save applies it; Discard throws it away.");
  await dialog.getByRole("button", { name: "Discard saved change" }).click();
  await expect(page.getByTestId("stock-rule-results")).toContainText("Shopify US: Saved change discarded. Nothing changed on the channel.");
  expect(state.saves).toHaveLength(1);
  expect(state.saves[0]).toMatchObject({ scope: skuScope(3), expectedHeadRevision: "2", value: { inheritAll: true } });
  expect(state.sets).toEqual([]);
  await expect(page.getByText("A saved change never took effect")).toHaveCount(0);
  await expect(page.getByTestId("stock-rule-row-3").getByRole("button", { name: "Add exception" })).toBeVisible();
  expect(state.unexpected).toEqual([]);
});

test("a channel whose rule is refused has nothing saved there, and the others still save", async ({ page }) => {
  const state = await setup(page, { blockOn: 4 });
  await page.getByRole("radio", { name: "CARD-P5" }).click();
  await page.getByRole("button", { name: "Set on all channels" }).click();
  const dialog = page.getByRole("dialog", { name: "Set on all channels" });
  await dialog.getByLabel("Hide when below").fill("3");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const results = page.getByTestId("stock-rule-results");
  await expect(results).toContainText("Shopify US: Saved.");
  await expect(results).toContainText("eBay: Not saved. eBay listing CARD-P5 has no stock link yet.");
  // One command per channel and nothing after the refusal: the server saved nothing for eBay, so there is nothing to undo.
  expect(state.sets.map(command => command.scope.channelId)).toEqual([3, 4]);
  expect(state.saves).toEqual([]);
  // One state: eBay shows exactly what it uses, with nothing waiting.
  const ebay = page.getByTestId("stock-rule-row-4");
  await expect(ebay).toContainText("5SKU rule");
  await expect(ebay).toContainText("0default");
  await expect(page.getByText("A saved change never took effect")).toHaveCount(0);
  await expect(page.getByTestId("stock-rule-row-3")).toContainText("3SKU rule");
  expect(state.unexpected).toEqual([]);
});

test("a cutoff that a non-zero Max can never reach is refused before anything is written", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("radio", { name: "CARD-P5" }).click();
  await page.getByTestId("stock-rule-row-3").getByRole("button", { name: "Add exception" }).click();
  const dialog = page.getByRole("dialog", { name: "Stock rule on Shopify US" });
  await dialog.getByLabel("Max", { exact: true }).click();
  await page.getByRole("option", { name: "Set a number" }).click();
  await dialog.getByLabel("Max units").fill("5");
  await dialog.getByLabel("Hide when below").fill("10");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Hide when below (10) is more than Max (5), so this channel would always be sent 0.");
  expect(state.sets).toEqual([]);
  expect(state.saves).toEqual([]);
});

test("a whole-product rule names every SKU it reaches before it is saved", async ({ page }) => {
  const state = await setup(page);
  await expect(page.getByTestId("product-stock-rules")).toContainText("applies to all 2 SKUs (CARD-P5, CARD-EA)");
  await page.getByRole("button", { name: "Set on all channels" }).click();
  await expect(page.getByRole("dialog", { name: "Set on all channels" })).toContainText("For the whole product, all 2 SKUs (CARD-P5, CARD-EA).");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("radio", { name: "CARD-P5" }).click();
  await page.getByRole("button", { name: "Set on all channels" }).click();
  await expect(page.getByRole("dialog", { name: "Set on all channels" })).toContainText("For CARD-P5.");
  expect(state.sets).toEqual([]);
});

test("a bad number changes nothing on any channel", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("radio", { name: "CARD-P5" }).click();
  await page.getByRole("button", { name: "Set on all channels" }).click();
  const dialog = page.getByRole("dialog", { name: "Set on all channels" });
  await dialog.getByLabel("Stock %").fill("150");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  expect(state.sets).toEqual([]);
});

test("clearing an exception returns the SKU to the channel default", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("radio", { name: "CARD-P5" }).click();
  await page.getByTestId("stock-rule-row-4").getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog", { name: "Stock rule on eBay" });
  await expect(dialog.getByLabel("Buffer")).toHaveValue("5");
  await dialog.getByRole("button", { name: "Clear exception" }).click();
  await expect(page.getByTestId("stock-rule-results")).toContainText("eBay: Saved.");
  expect(state.sets[0].value).toMatchObject({ inheritAll: true, holdbackSellableUnits: null });
  expect(state.saves).toEqual([]);
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
