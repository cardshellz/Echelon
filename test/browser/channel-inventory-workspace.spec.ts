import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { view, policyHead, policyValue, previewRow, target, HASH_A, HASH_B } from "../../client/src/features/channel-inventory/__tests__/fixtures";
import type { ChannelPublicationStatus } from "../../shared/types/inventory-channel-publication-status";

const BASE = "/api/inventory-planning/admin/channel-exposure";
const AT = "2026-09-20T14:00:00.000Z";
const defaults = policyValue({ allocationSemantics: "exposure", eligible: true, shareBps: 5000,
  holdbackSellableUnits: "0", maxPublish: { mode: "unlimited" }, minPublishSellableUnits: "0" });

async function setup(page: Page, options: { permission?: "none" | "view" | "edit"; query?: string } = {}) {
  const data = view({
    publicationTargets: [target(), target({ id: 6, channelId: 4, channelConnectionId: 44, providerScopeType: "account", externalScopeId: "ebay-user-9" })],
    policyHeads: [policyHead({ scopeKey: "channel:3", channelId: 3, scope: { scopeType: "channel", channelId: 3 }, active: defaults })],
    sourceBindingHeads: [{ publicationTargetId: 5, revision: "1", draftBinding: null,
      activeBinding: { bindingId: 10, publicationTargetId: 5, version: 1, lifecycleStatus: "sealed", definitionHash: HASH_A,
        fulfillmentNodeIds: [7], changeReason: null, createdBy: "operator-1", createdAt: AT, updatedAt: AT } }],
    variantMappingHeads: [{ publicationTargetId: 5, productVariantId: 101, revision: "1", draftMapping: null,
      activeMapping: { mappingId: 20, publicationTargetId: 5, productVariantId: 101, version: 1, lifecycleStatus: "sealed",
        externalInventoryItemId: "test-item", externalSku: "CARD-P5", definitionHash: HASH_A,
        changeReason: null, createdBy: "operator-1", createdAt: AT, updatedAt: AT } }],
  });
  const state = { data, writes: [] as Array<{ path: string; body: Record<string, unknown>; raw: string }>,
    reads: [] as string[], errors: [] as string[], unexpected: [] as string[], loseResponse: false, conflict: false, invalidResponse: false,
    statusFailed: false, status: { publicationTargetId: 5, productId: 10, capturedAt: AT, runtimeAuthority: "canonical", targetRevision: "3",
      rows: [{ productVariantId: 101, activeInventoryItemId: "test-item",
        desired: { outboxId: "9", revision: "2", quantity: "60", state: "queued", targetRevision: "3", createdAt: AT },
        acknowledged: { outboxId: "8", quantity: "0", acknowledgedAt: AT },
        observed: { outboxId: "8", quantity: "0", observedAt: AT, matchesDesired: true, targetRevision: "2" } },
        { productVariantId: 102, activeInventoryItemId: "ea-item", desired: null, acknowledged: null, observed: null }],
    } as ChannelPublicationStatus };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/api/**", async route => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    if (req.method() === "GET") {
      state.reads.push(path);
      if (path === "/api/auth/me") return route.fulfill({ json: {
        user: { id: "operator-1", username: "operator", role: "operator" }, roles: ["operator"],
        permissions: options.permission === "none" ? [] : options.permission === "view" ? ["inventory_planning:view"]
          : ["inventory_planning:view", "inventory_planning:edit", "inventory_planning:activate"],
      } });
      if (path === BASE) return route.fulfill({ json: state.data });
      if (path === `${BASE}/preview`) return route.fulfill({ json: {
        publicationTargetId: 5, destinationKind: "channel_connection", channelId: 3, channelConnectionId: 33, dropshipStoreConnectionId: null,
        providerScopeType: "location", externalScopeId: "gid://shopify/Location/1", publicationAuthority: "echelon",
        publicationTargetState: "preview", publicationTargetRevision: "3", hold: null, productId: 10,
        shadowRunId: "1", snapshotFingerprint: HASH_A, shadowCapturedAt: AT, modelId: 1, modelVersion: 1, modelDefinitionHash: HASH_A,
        sourceBindingId: 10, sourceBindingVersion: 1, sourceBindingDefinitionHash: HASH_A, sourceBindingAuthority: "active",
        fulfillmentNodeIds: [7,8], warehouseIds: [1,2], selectedPolicies: [], rows: [previewRow()], blockers: [],
        runtimeAuthorityChanged: false, providerWriteAttempted: false, outboxEnqueued: false,
      } });
      if (path === `${BASE}/publication-status`) return state.statusFailed
        ? route.fulfill({ status: 503, json: { error: { code: "READ_UNAVAILABLE", message: "Recorded delivery status could not be read." } } })
        : route.fulfill({ json: state.status });
      if (path === "/api/warehouses/inventory-sources") return route.fulfill({ json: { warehouses: [] } });
      if (path === "/api/sync/status") return route.fulfill({ json: { global: { globalEnabled: true, sweepIntervalMinutes: 15,
        revision: "1", changedBy: "operator-1", changeReason: "Approved", lastSweepAt: null } } });
      if (path === "/api/inventory-planning/runtime-authority") return route.fulfill({ json: {
        contractVersion: "inventory_runtime_authority_readout_v1", authority: "canonical", liveAllocator: "inventory_exposure",
        revision: "9", activationRunId: "44", changedBy: "operator-1", changeReason: "Approved", changedAt: AT,
      } });
    }
    if (req.method() === "PUT" && ["policy-draft", "source-binding-draft", "variant-mapping-draft"].some(suffix => path === `${BASE}/${suffix}`)) {
      const body = req.postDataJSON();
      state.writes.push({ path, body, raw: req.postData()! });
      if (state.loseResponse) { state.loseResponse = false; return route.abort("failed"); }
      if (state.conflict) return route.fulfill({ status: 409, json: { error: { code: "DRAFT_CHANGED", message: "Another operator saved first." } } });
      if (state.invalidResponse) return route.fulfill({ json: { invalid: true } });
      if (path.endsWith("policy-draft") && body.scope.scopeType === "channel") state.data.policyHeads[0] = policyHead({ scopeKey: "channel:3", channelId: 3,
        scope: { scopeType: "channel", channelId: 3 }, active: defaults, draft: body.value, revision: "2" });
      if (path.endsWith("source-binding-draft")) {
        const head = state.data.sourceBindingHeads[0];
        head.revision = "2";
        head.draftBinding = { ...head.activeBinding!, bindingId: 11, version: 2, lifecycleStatus: "draft",
          fulfillmentNodeIds: body.fulfillmentNodeIds, definitionHash: HASH_B };
      }
      return route.fulfill({ json: { definitionId: 2, version: 2, definitionHash: HASH_B, headRevision: "2", alreadyApplied: false,
        runtimeAuthorityChanged: false, providerWriteAttempted: false } });
    }
    state.unexpected.push(`${req.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: { code: "UNEXPECTED_TEST_REQUEST", message: "Unexpected request" } } });
  });
  await page.route("**/__channel-inventory-workspace-test*", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
    </head><body><main id="root"></main><script type="module" src="/@fs/${resolve("test/browser/fixtures/channel-inventory-workspace-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto(`/__channel-inventory-workspace-test${options.query ?? "?channel=3&destination=5&tab=rules"}`);
  return state;
}

test("channel default saves without a written reason or any activation call", async ({ page }) => {
  const state = await setup(page);
  await page.getByLabel("Offer percentage", { exact: true }).fill("80");
  await page.getByRole("button", { name: "Save channel default", exact: true }).click();
  await expect(page.getByText("Draft v2 pending activation", { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].body).toMatchObject({ expectedHeadRevision: "1", changeReason: null, value: { shareBps: 8000 } });
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("background revision changes preserve edits and require explicit reload", async ({ page }) => {
  const state = await setup(page);
  const offer = page.getByLabel("Offer percentage", { exact: true });
  await offer.fill("80");
  state.data.policyHeads[0] = policyHead({ scopeKey: "channel:3", channelId: 3, scope: { scopeType: "channel", channelId: 3 },
    active: defaults, draft: { ...defaults, shareBps: 3000 }, revision: "2" });
  await page.evaluate(() => window.dispatchEvent(new Event("channel-inventory-test-refresh")));
  await expect(page.getByText("Saved settings changed while you were editing", { exact: true })).toBeVisible();
  await expect(offer).toHaveValue("80");
  await expect(page.getByRole("button", { name: "Save channel default", exact: true })).toBeDisabled();
  expect(state.writes).toHaveLength(0);
  await page.getByRole("button", { name: "Discard edits and reload", exact: true }).click();
  await expect(offer).toHaveValue("30");
  await offer.fill("70");
  await page.getByRole("button", { name: "Save channel default", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].body.expectedHeadRevision).toBe("2");
  expect(state.errors).toEqual([]);
});

test("lost responses freeze edits, block leaving and retry the identical command after refresh", async ({ page }) => {
  const state = await setup(page); state.loseResponse = true;
  const offer = page.getByLabel("Offer percentage", { exact: true });
  await offer.fill("80"); await page.getByRole("button", { name: "Save channel default", exact: true }).click();
  await expect(page.getByText("Save outcome unknown", { exact: true })).toBeVisible();
  await expect(offer).toBeDisabled();
  state.data.policyHeads[0] = policyHead({ scopeKey: "channel:3", channelId: 3, scope: { scopeType: "channel", channelId: 3 }, active: defaults,
    draft: { ...defaults, shareBps: 8000 }, revision: "2" });
  await page.evaluate(() => window.dispatchEvent(new Event("channel-inventory-test-refresh")));
  await page.getByRole("tab", { name: "Supply", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Resolve the save first");
  await expect(page.getByRole("button", { name: "Discard changes", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await page.getByRole("button", { name: "Retry same save", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1].raw).toBe(state.writes[0].raw);
  expect(state.errors).toEqual([]);
});

test("switching tabs asks before discarding unsaved rules", async ({ page }) => {
  const state = await setup(page);
  await page.getByLabel("Offer percentage", { exact: true }).fill("80");
  await page.getByRole("tab", { name: "Supply", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Discard unsaved changes?");
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByLabel("Offer percentage", { exact: true })).toHaveValue("80");
  await page.getByRole("tab", { name: "Supply", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Supply", exact: true })).toHaveAttribute("data-state", "active");
  expect(state.writes).toHaveLength(0); expect(state.errors).toEqual([]);
});

test("no view permission means no inventory query or cached settings", async ({ page }) => {
  const state = await setup(page, { permission: "none" });
  await expect(page.getByText("Inventory planning access required", { exact: true })).toBeVisible();
  expect(state.reads.filter(path => path.includes("inventory") || path === "/api/sync/status")).toEqual([]);
  expect(state.writes).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("view-only access has no draft save controls", async ({ page }) => {
  const state = await setup(page, { permission: "view" });
  await expect(page.getByLabel("Offer percentage", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save channel default", exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test("browser back restores the prior tab instead of overwriting the URL", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("tab", { name: "Supply", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Supply", exact: true })).toHaveAttribute("data-state", "active");
  await page.goBack();
  await expect(page.getByRole("tab", { name: "Selling rules", exact: true })).toHaveAttribute("data-state", "active");
  expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
});

test("supply retries an ambiguous save with its original warehouse set and head", async ({ page }) => {
  const state = await setup(page, { query: "?channel=3&destination=5" });
  state.invalidResponse = true;
  await page.getByRole("checkbox", { name: /Canada 3PL/ }).check();
  await page.getByRole("button", { name: "Save supply", exact: true }).click();
  await expect(page.getByText("Save outcome unknown", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Canada 3PL/ })).toBeDisabled();
  state.invalidResponse = false;
  await page.getByRole("button", { name: "Retry same save", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[0].body).toMatchObject({ fulfillmentNodeIds: [7,8], expectedHeadRevision: "1", changeReason: null });
  expect(state.writes[1].raw).toBe(state.writes[0].raw);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("delivery evidence separates desired, accepted, observed and unknown without sending anything", async ({ page }, testInfo) => {
  const state = await setup(page, { query: "?channel=3&destination=5&tab=quantities&product=10" });
  const pack = page.getByRole("article", { name: "CARD-P5 delivery status", exact: true });
  await expect(pack).toContainText("Queued");
  await expect(pack).toContainText("Last requested60");
  await expect(pack).toContainText("Last accepted0");
  await expect(pack).toContainText("Last readback0");
  await expect(pack).toContainText("Acceptance belongs to an earlier request");
  await expect(pack).toContainText("does not verify the latest request");
  const each = page.getByRole("article", { name: "CARD-EA delivery status", exact: true });
  await expect(each.getByText("Unknown", { exact: true })).toHaveCount(3);
  await page.getByRole("button", { name: "Reload delivery records", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reload delivery records", exact: true })).toBeEnabled();
  expect(state.writes).toEqual([]); expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("channel-quantities.png"), fullPage: true });
});

test("failed delivery reads hide stale evidence and never turn failure into zero", async ({ page }) => {
  const state = await setup(page, { query: "?channel=3&destination=5&tab=quantities&product=10" });
  await expect(page.getByRole("article", { name: "CARD-P5 delivery status" })).toBeVisible();
  state.statusFailed = true;
  await page.getByRole("button", { name: "Reload delivery records", exact: true }).click();
  await expect(page.getByText("Delivery status unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("article", { name: "CARD-P5 delivery status" })).toHaveCount(0);
  await expect(page.getByText("Proposed", { exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
});

test("identity editor retains its exact retry after a lost response", async ({ page }) => {
  const state = await setup(page, { query: "?channel=3&destination=5&tab=quantities&product=10" });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Inventory item id", { exact: true }).fill("new-provider-item");
  state.loseResponse = true;
  await page.getByRole("button", { name: "Save identity", exact: true }).click();
  await expect(page.getByText("Save outcome unknown", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Inventory item id", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry same save", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1].raw).toBe(state.writes[0].raw);
  expect(state.writes[0].body).toMatchObject({ productVariantId: 101, publicationTargetId: 5, changeReason: null, externalInventoryItemId: "new-provider-item" });
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("SKU exceptions keep inherited fields and retry the same command after a lost response", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Add exception", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("combobox").click();
  await page.getByRole("option", { name: /Card Shell/ }).click();
  await sheet.getByRole("radio", { name: "CARD-P5", exact: true }).click();
  await sheet.getByRole("group", { name: "Offer: inherit or set", exact: true }).getByRole("radio", { name: "Set", exact: true }).click();
  await sheet.getByLabel("Offer percentage", { exact: true }).fill("25");
  state.loseResponse = true;
  await sheet.getByRole("button", { name: "Save exception", exact: true }).click();
  await expect(sheet.getByText("Save outcome unknown", { exact: true })).toBeVisible();
  await sheet.getByRole("button", { name: "Retry same save", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1].raw).toBe(state.writes[0].raw);
  expect(state.writes[0].body).toMatchObject({ scope: { scopeType: "variant", channelId: 3, productId: 10, productVariantId: 101 },
    value: { shareBps: 2500, eligible: null, holdbackSellableUnits: null, maxPublish: null }, changeReason: null });
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});
