import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { view, policyHead, policyValue, previewRow, target, HASH_A, HASH_B } from "../../client/src/features/channel-inventory/__tests__/fixtures";
import type { ChannelPublicationStatus } from "../../shared/types/inventory-channel-publication-status";
import type { ChannelDefinitionProgress, ChannelDefinitionReview } from "../../shared/types/inventory-channel-definition";
import type { InventoryChannelExposureAdminView, InventoryChannelExposurePreview } from "../../shared/types/inventory-channel-exposure";

const BASE = "/api/inventory-planning/admin/channel-exposure";
const AT = "2026-09-20T14:00:00.000Z";
const defaults = policyValue({ allocationSemantics: "exposure", eligible: true, shareBps: 5000,
  holdbackSellableUnits: "0", maxPublish: { mode: "unlimited" }, minPublishSellableUnits: "0" });

async function setup(page: Page, options: {
  permission?: "none" | "view" | "edit";
  query?: string;
  pending?: boolean;
  legacy?: boolean;
  viewOverrides?: Partial<InventoryChannelExposureAdminView>;
  previewOverrides?: Partial<InventoryChannelExposurePreview>;
  globalEnabled?: boolean;
} = {}) {
  const data = view({
    publicationTargets: [target(), target({ id: 6, channelId: 4, channelConnectionId: 44, providerScopeType: "account", externalScopeId: "ebay-user-9" })],
    policyHeads: [policyHead({ scopeKey: "channel:3", channelId: 3, scope: { scopeType: "channel", channelId: 3 }, active: defaults,
      draft: options.pending ? { ...defaults, shareBps: 8000 } : null, revision: options.pending ? "2" : "1" })],
    runtimeAuthority: options.legacy ? "legacy" : "canonical",
    sourceBindingHeads: [{ publicationTargetId: 5, revision: "1", draftBinding: null,
      activeBinding: { bindingId: 10, publicationTargetId: 5, version: 1, lifecycleStatus: "sealed", definitionHash: HASH_A,
        fulfillmentNodeIds: [7], changeReason: null, createdBy: "operator-1", createdAt: AT, updatedAt: AT } }],
    variantMappingHeads: [{ publicationTargetId: 5, productVariantId: 101, revision: "1", draftMapping: null,
      activeMapping: { mappingId: 20, publicationTargetId: 5, productVariantId: 101, version: 1, lifecycleStatus: "sealed",
        externalInventoryItemId: "test-item", externalSku: "CARD-P5", definitionHash: HASH_A,
        changeReason: null, createdBy: "operator-1", createdAt: AT, updatedAt: AT } }],
    ...options.viewOverrides,
  });
  const state = { data, writes: [] as Array<{ path: string; body: Record<string, unknown>; raw: string }>,
    applyLostResponse: false, applyConflict: false, reviewBlocked: false, progress: null as ChannelDefinitionProgress | null,
    reads: [] as string[], errors: [] as string[], unexpected: [] as string[], loseResponse: false, conflict: false, invalidResponse: false,
    enableFailed: false, enableLostResponse: false, globalFailed: false, globalChangeFailed: false, previewFailed: false, stopFailed: false,
    global: { globalEnabled: options.globalEnabled ?? true, sweepIntervalMinutes: 15, revision: "1",
      changedBy: "operator-1", changeReason: "Approved" as string | null, lastSweepAt: null },
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
      if (path === "/api/inventory-planning/admin/channel-definitions/3/progress") return route.fulfill({ json: state.progress });
      if ([4,104].some(id => path === `/api/inventory-planning/admin/channel-definitions/${id}/progress`)) return route.fulfill({ json: null });
      if (path === `${BASE}/preview`) return state.previewFailed
        ? route.fulfill({ status: 503, json: { error: { code: "PREVIEW_UNAVAILABLE", message: "Stock calculation could not be loaded." } } })
        : route.fulfill({ json: {
        publicationTargetId: 5, destinationKind: "channel_connection", channelId: 3, channelConnectionId: 33, dropshipStoreConnectionId: null,
        providerScopeType: "location", externalScopeId: "gid://shopify/Location/1", publicationAuthority: "echelon",
        publicationTargetState: "preview", publicationTargetRevision: "3", hold: null, productId: 10,
        shadowRunId: "1", snapshotFingerprint: HASH_A, shadowCapturedAt: AT, modelId: 1, modelVersion: 1, modelDefinitionHash: HASH_A,
        sourceBindingId: 10, sourceBindingVersion: 1, sourceBindingDefinitionHash: HASH_A, sourceBindingAuthority: "active",
        fulfillmentNodeIds: [7,8], warehouseIds: [1,2], selectedPolicies: [], rows: [previewRow()], blockers: [],
        runtimeAuthorityChanged: false, providerWriteAttempted: false, outboxEnqueued: false,
        ...options.previewOverrides,
      } });
      if (path === `${BASE}/publication-status`) return state.statusFailed
        ? route.fulfill({ status: 503, json: { error: { code: "READ_UNAVAILABLE", message: "Recorded delivery status could not be read." } } })
        : route.fulfill({ json: state.status });
      if (path === "/api/warehouses/inventory-sources") return route.fulfill({ json: { warehouses: [] } });
      if (path === "/api/sync/status") return state.globalFailed
        ? route.fulfill({ status: 503, json: { error: { code: "STATUS_UNAVAILABLE", message: "Stock-update control is unavailable." } } })
        : route.fulfill({ json: { global: state.global } });
      if (path === "/api/inventory-planning/runtime-authority") return route.fulfill({ json: {
        contractVersion: "inventory_runtime_authority_readout_v1", authority: options.legacy ? "legacy" : "canonical", liveAllocator: options.legacy ? "channel_allocation" : "inventory_exposure",
        revision: "9", activationRunId: "44", changedBy: "operator-1", changeReason: "Approved", changedAt: AT,
      } });
    }
    if (req.method() === "PUT" && path === "/api/inventory-planning/admin/publication-global-control") {
      const body = req.postDataJSON(); state.writes.push({ path, body, raw: req.postData()! });
      if (state.globalChangeFailed) return route.fulfill({ status: 503,
        json: { error: { code: "GLOBAL_CONTROL_BUSY", message: "Stock-update control is busy. Retry this change." } } });
      state.global = { ...state.global, globalEnabled: body.globalEnabled ?? state.global.globalEnabled,
        sweepIntervalMinutes: body.sweepIntervalMinutes ?? state.global.sweepIntervalMinutes,
        revision: String(Number(state.global.revision) + 1), changeReason: body.changeReason ?? null };
      const { lastSweepAt: _lastSweepAt, ...result } = state.global;
      return route.fulfill({ json: { ...result, changedAt: AT, alreadyApplied: false } });
    }
    if (req.method() === "PUT" && path === BASE + "/publication-target-enable") {
      const body = req.postDataJSON(); state.writes.push({ path, body, raw: req.postData()! });
      if (state.enableFailed) return route.fulfill({ status: 409, json: { error: {
        code: "INVENTORY_PUBLICATION_ENABLE_STOCK_RULES_REQUIRED", message: "Save a complete channel default in Stock rules before turning stock updates on.",
      } } });
      const account = state.data.publicationTargets.find(item => item.id === body.publicationTargetId)!;
      const replay = account.state === "live";
      account.state = "live"; account.revision = "4";
      if (state.enableLostResponse) { state.enableLostResponse = false; return route.abort("failed"); }
      return route.fulfill({ json: { publicationTargetId: account.id, revision: "4", state: account.state,
        publicationRows: 0, initialDefinitionsApplied: 0, alreadyApplied: replay, runtimeAuthorityChanged: false, providerWriteAttempted: false } });
    }
    if (req.method() === "PUT" && path === `${BASE}/publication-target-stop`) {
      const body = req.postDataJSON(); state.writes.push({ path, body, raw: req.postData()! });
      if (state.stopFailed) return route.fulfill({ status: 503, json: { error: { code: "STOP_UNAVAILABLE", message: "Stock updates could not be paused." } } });
      const account = state.data.publicationTargets.find(item => item.id === body.publicationTargetId)!;
      account.state = "disabled"; account.revision = "4"; account.hasPriorLiveStop = true;
      return route.fulfill({ json: { publicationTargetId: account.id, revision: "4", state: account.state,
        alreadyApplied: false, runtimeAuthorityChanged: false, providerWriteAttempted: false, outboxEnqueued: false } });
    }
    if (req.method() === "PUT" && path === `${BASE}/publication-target-preview-state`) {
      const body = req.postDataJSON(); state.writes.push({ path, body, raw: req.postData()! });
      const account = state.data.publicationTargets.find(item => item.id === body.publicationTargetId)!;
      account.state = body.state; account.revision = "4";
      return route.fulfill({ json: { publicationTargetId: account.id, revision: "4", state: account.state,
        alreadyApplied: false, runtimeAuthorityChanged: false, providerWriteAttempted: false, outboxEnqueued: false } });
    }
    if (req.method() === "POST" && path === "/api/inventory-planning/admin/channel-definitions/review") {
      const review: ChannelDefinitionReview = { channelId: 3, channelName: "Shopify US", authorityRevision: "9", activationRunId: "44",
        reviewHash: HASH_A, ready: !state.reviewBlocked, blockers: state.reviewBlocked ? ["Warehouse evidence is unavailable. Refresh inventory evidence before applying."] : [],
        affectedProductIds: [10,20], changes: [{ selection: { kind: "channel_policy", key: "channel:3", definitionId: 2, definitionHash: HASH_B },
          headRevision: "2", label: "Channel default", before: { share_bps: 5000 }, after: { share_bps: 8000 } }],
        destinations: [{ id: 5, state: "live", authority: "echelon", scope: "gid://shopify/Location/1" }],
        quantities: [{ productId: 10, variantId: 101, sku: "CARD-P5", targetId: 5, channelName: "Shopify US", current: "50", proposed: "80", warehouses: [{ warehouseId: 1, available: "100" }] },
          { productId: 20, variantId: 201, sku: "BOX-C25", targetId: 5, channelName: "Shopify US", current: "2", proposed: "4", warehouses: [{ warehouseId: 1, available: "5" }] }] };
      return route.fulfill({ json: review });
    }
    if (req.method() === "POST" && path === "/api/inventory-planning/admin/channel-definitions/apply") {
      const body = req.postDataJSON(); state.writes.push({ path, body, raw: req.postData()! });
      if (state.applyConflict) return route.fulfill({ status: 409, json: { error: { code: "CHANNEL_REVIEW_CHANGED", message: "Inventory or settings changed. Review the channel again." } } });
      const alreadyApplied = state.progress !== null;
      state.progress = { receipt: { channelId: 3, appliedAt: AT, appliedBy: "operator-1", reviewHash: HASH_A, publicationIds: [], changedDefinitions: 1, alreadyApplied: false }, publications: [] };
      state.data.policyHeads[0] = policyHead({ scopeKey: "channel:3", channelId: 3, scope: { scopeType: "channel", channelId: 3 }, active: { ...defaults, shareBps: 8000 }, revision: "3" });
      if (state.applyLostResponse) { state.applyLostResponse = false; return route.abort("failed"); }
      return route.fulfill({ json: { ...state.progress.receipt, alreadyApplied } });
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

test("a new Walmart account turns on directly without pause history or a reason", async ({ page }, info) => {
  const state = await setup(page, {
    pending: true, query: "?channel=3&destination=5&tab=publishing&product=10",
    viewOverrides: {
      channels: [{ id: 3, name: "Walmart", provider: "walmart", status: "active", connections: [{
        id: 33, externalAccountLabel: "Card Shellz", shopifyLocationId: null, providerLocationId: "10002558022", providerAccount: null,
      }] }],
      publicationTargets: [target({ state: "disabled", hasPriorLiveStop: false, externalScopeId: "10002558022" })],
    },
  });
  const toggle = page.getByRole("switch", { name: "Automatic stock updates for Card Shellz, Location 10002558022", exact: true });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ path: BASE + "/publication-target-enable", body: {
    publicationTargetId: 5, expectedRevision: "3", idempotencyKey: expect.any(String),
  } });
  expect(state.writes[0].body).not.toHaveProperty("reason");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("walmart-stock-updates-enabled.png"), fullPage: true });
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("previously paused accounts turn on in one step", async ({ page }) => {
  const state = await setup(page, { query: "?channel=3&destination=5&tab=publishing", viewOverrides: {
    publicationTargets: [target({ state: "disabled", hasPriorLiveStop: true })],
  } });
  const toggle = page.getByRole("switch", { name: /^Automatic stock updates for/ });
  await toggle.click();
  await expect(toggle).toBeChecked();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].path).toBe(BASE + "/publication-target-enable");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("failed enable stays off and shows the specific setup correction", async ({ page }) => {
  const state = await setup(page, { viewOverrides: { publicationTargets: [target({ state: "disabled", hasPriorLiveStop: false })] } });
  state.enableFailed = true;
  const toggle = page.getByRole("switch", { name: /^Automatic stock updates for/ });
  await toggle.click();
  await expect(page.getByRole("dialog")).toContainText("Save a complete channel default in Stock rules");
  await expect(page.locator("#stock-updates-5")).not.toBeChecked();
  await page.getByRole("button", { name: "Edit stock rules", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.writes).toHaveLength(1);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("lost enable response retries the exact request without a second enable", async ({ page }) => {
  const state = await setup(page, { viewOverrides: { publicationTargets: [target({ state: "disabled" })] } });
  state.enableLostResponse = true;
  await page.getByRole("switch", { name: /^Automatic stock updates for/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Stock update change not confirmed");
  await page.evaluate(() => window.dispatchEvent(new Event("channel-inventory-test-refresh")));
  await expect(page.locator("#stock-updates-5")).toBeChecked();
  await page.getByRole("button", { name: "Retry turning on", exact: true }).click();
  await expect(page.getByRole("switch", { name: /^Automatic stock updates for/ })).toBeChecked();
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1].raw).toBe(state.writes[0].raw);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("empty stock selection does not claim the catalog has no sellable SKUs", async ({ page }, info) => {
  const state = await setup(page, {
    query: "?channel=3&destination=5&tab=quantities&product=10",
    viewOverrides: { publicationTargets: [target({ state: "disabled", hasPriorLiveStop: false })] },
    previewOverrides: {
      publicationTargetState: "disabled", membership: { mode: "explicit", includedVariantIds: [] }, rows: [],
      blockers: [{ code: "PUBLICATION_TARGET_NOT_IN_PREVIEW", message: "This exact publication target is disabled and cannot enter activation readiness review.", context: {} }],
    },
  });
  state.status.rows = state.status.rows.map(row => ({ ...row, activeInventoryItemId: null, desired: null, acknowledged: null, observed: null }));
  await page.evaluate(() => window.dispatchEvent(new Event("channel-inventory-test-refresh")));
  await expect(page.getByText("No SKUs selected for stock updates", { exact: true })).toBeVisible();
  await expect(page.getByText(/no sellable, tracked SKUs/i)).toHaveCount(0);
  await expect(page.getByLabel("SKUs without stock update records")).toContainText("CARD-P5");
  await expect(page.getByText(/PUBLICATION_TARGET_NOT_IN_PREVIEW/)).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("empty-stock-selection.png"), fullPage: true });
  await page.getByRole("button", { name: "Set up stock updates", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Automatic stock updates");
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Stock preview", exact: true })).toHaveAttribute("data-state", "active");
  expect(state.writes).toEqual([]); expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("failed global status refresh does not leave an enabled account looking confirmed", async ({ page }) => {
  const state = await setup(page, { query: "?channel=3&destination=5&tab=publishing", viewOverrides: {
    publicationTargets: [target({ state: "live" })],
  } });
  await expect(page.getByText("Enabled", { exact: true })).toBeVisible();
  state.globalFailed = true;
  await page.evaluate(() => window.dispatchEvent(new Event("channel-inventory-test-refresh")));
  await expect(page.getByText("Status unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("Enabled", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Stock-update status unavailable", { exact: true })).toBeVisible();
  state.globalFailed = false;
  await page.getByRole("button", { name: /^Stock update details for/ }).click();
  await page.getByRole("button", { name: "Reload all-channel status", exact: true }).click();
  await expect(page.getByText("Enabled", { exact: true })).toBeVisible();
  expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
});

test("missing historical pause hints never block direct enable", async ({ page }) => {
  const state = await setup(page, { viewOverrides: { publicationTargets: [target({ hasPriorLiveStop: undefined })] } });
  const toggle = page.getByRole("switch", { name: /^Automatic stock updates for/ });
  await toggle.click(); await expect(toggle).toBeChecked();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].path).toBe(BASE + "/publication-target-enable");
  expect(state.errors).toEqual([]);
});

test("externally managed stock has no Echelon start or pause controls", async ({ page }) => {
  const state = await setup(page, { query: "?channel=3&destination=5&tab=publishing", viewOverrides: {
    publicationTargets: [target({ state: "live", publicationAuthority: "external_provider" })],
  } });
  await expect(page.getByText("Managed elsewhere", { exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: /^Automatic stock updates for/ })).toHaveCount(0);
  for (const name of ["Prepare account", "Check before resuming", "Resume stock updates", "Pause stock updates"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
});

test("failed preview refresh hides stale calculated stock while keeping separate update history", async ({ page }) => {
  const state = await setup(page, { query: "?channel=3&destination=5&tab=quantities&product=10" });
  await expect(page.getByText("After stock rules", { exact: true })).toBeVisible();
  state.previewFailed = true;
  await page.evaluate(() => window.dispatchEvent(new Event("channel-inventory-test-refresh")));
  await expect(page.getByText("Stock preview unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("After stock rules", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("article", { name: "CARD-P5 delivery status", exact: true })).toBeVisible();
  expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
});

test("view-only operators cannot enable an account and the all-channel pause stays distinct", async ({ page }) => {
  const state = await setup(page, { permission: "view", globalEnabled: false, query: "?channel=3&destination=5&tab=publishing",
    viewOverrides: { publicationTargets: [target({ state: "disabled" })] },
  });
  await expect(page.getByRole("switch", { name: /^Automatic stock updates for/ })).toBeDisabled();
  await page.getByRole("button", { name: /^Stock update details for/ }).click();
  await expect(page.getByRole("button", { name: "Turn on stock updates", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "All-channel controls", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("switch")).toBeDisabled();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Apply", exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
});

test("Walmart destination setup shows the seller name and fulfillment center instead of an internal connection id", async ({ page }) => {
  const state = await setup(page, {
    query: "?channel=104&tab=supply",
    viewOverrides: {
      channels: [{
        id: 104, name: "Walmart", provider: "walmart", status: "active",
        connections: [{
          id: 67, externalAccountLabel: "Card Shellz", shopifyLocationId: null,
          providerLocationId: "10002558022", providerAccount: null,
        }],
      }],
      publicationTargets: [], policyHeads: [], sourceBindingHeads: [], variantMappingHeads: [],
    },
  });
  await page.getByRole("button", { name: "Set up destinations", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Card Shellz — Walmart US", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Walmart fulfillment center: 10002558022", { exact: true })).toBeVisible();
  await expect(dialog).not.toContainText("Connection #67");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  state.data.publicationTargets = [target({ channelId: 104, channelConnectionId: 67, externalScopeId: "10002558022" })];
  await page.evaluate(() => window.dispatchEvent(new Event("channel-inventory-test-refresh")));
  await expect(page.getByRole("group", { name: "Destinations", exact: true }).getByRole("button", { name: /^Card Shellz Location/ })).toBeVisible();
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("channel default saves without a written reason or any activation call", async ({ page }) => {
  const state = await setup(page);
  await page.getByLabel("Stock percentage", { exact: true }).fill("80");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Draft v2 pending activation", { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].body).toMatchObject({ expectedHeadRevision: "1", changeReason: null, value: { shareBps: 8000 } });
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("new channels show editable suggestions and save them only after the operator chooses Save", async ({ page }, testInfo) => {
  const state = await setup(page, { viewOverrides: { policyHeads: [] } });
  await expect(page.getByRole("radio", { name: "Available to sell", exact: true })).toBeChecked();
  await expect(page.getByLabel("Stock percentage", { exact: true })).toHaveValue("100");
  await expect(page.getByRole("radio", { name: "Not set", exact: true })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Set", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Stock buffer", { exact: true })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeEnabled();
  expect(state.writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("channel-stock-rules-basic.png"), fullPage: true });

  await page.locator("summary").filter({ hasText: "Advanced stock rules" }).click();
  await expect(page.getByLabel("Stock buffer", { exact: true })).toHaveValue("0");
  await expect(page.getByRole("radio", { name: "No maximum", exact: true })).toBeChecked();
  await expect(page.getByLabel("Out-of-stock cutoff", { exact: true })).toHaveValue("0");
  await expect(page.getByRole("radio", { name: "Share available stock", exact: true })).toBeChecked();
  expect(state.writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("channel-stock-rules-advanced.png"), fullPage: true });

  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].path).toBe(`${BASE}/policy-draft`);
  expect(state.writes[0].body).toMatchObject({
    expectedHeadRevision: "0", expectedDraftPolicyId: null, expectedDraftDefinitionHash: null,
    changeReason: null,
    value: {
      eligible: true, shareBps: 10000, holdbackSellableUnits: "0", maxPublish: { mode: "unlimited" },
      minPublishSellableUnits: "0", allocationSemantics: "exposure",
    },
  });
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("saved out-of-stock, zero and partitioned settings survive an unrelated edit", async ({ page }) => {
  const existing = policyValue({
    eligible: false, shareBps: 0, holdbackSellableUnits: "0", maxPublish: { mode: "units", units: "0" },
    minPublishSellableUnits: "0", allocationSemantics: "partitioned",
  });
  const state = await setup(page, { viewOverrides: { policyHeads: [policyHead({
    scopeKey: "channel:3", channelId: 3, scope: { scopeType: "channel", channelId: 3 }, active: existing,
  })] } });
  await expect(page.getByRole("radio", { name: "Show as out of stock", exact: true })).toBeChecked();
  await expect(page.getByLabel("Stock percentage", { exact: true })).toHaveValue("0");
  await expect(page.getByLabel("Stock buffer", { exact: true })).toHaveValue("0");
  await expect(page.getByRole("radio", { name: "Limit quantity", exact: true })).toBeChecked();
  await expect(page.getByRole("textbox", { name: "Maximum displayed quantity", exact: true })).toHaveValue("0");
  await expect(page.getByLabel("Out-of-stock cutoff", { exact: true })).toHaveValue("0");
  await expect(page.getByRole("radio", { name: "Limit combined channel percentages", exact: true })).toBeChecked();
  expect(state.writes).toEqual([]);

  await page.getByLabel("Stock buffer", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].body.value).toEqual({ ...existing, holdbackSellableUnits: "2" });
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("partial saved drafts retain missing values instead of silently adopting suggested defaults", async ({ page }) => {
  const partial = policyValue({ eligible: false, shareBps: 2500 });
  const state = await setup(page, { viewOverrides: { policyHeads: [policyHead({
    scopeKey: "channel:3", channelId: 3, scope: { scopeType: "channel", channelId: 3 },
    active: defaults, draft: partial, revision: "2",
  })] } });
  await expect(page.getByRole("radio", { name: "Show as out of stock", exact: true })).toBeChecked();
  await expect(page.getByLabel("Stock percentage", { exact: true })).toHaveValue("25");
  await expect(page.getByLabel("Stock buffer", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Out-of-stock cutoff", { exact: true })).toHaveValue("");
  await expect(page.getByRole("radio", { name: "No maximum", exact: true })).not.toBeChecked();
  await expect(page.getByRole("radio", { name: "Limit quantity", exact: true })).not.toBeChecked();
  await expect(page.getByRole("radio", { name: "Share available stock", exact: true })).not.toBeChecked();
  await expect(page.getByRole("radio", { name: "Limit combined channel percentages", exact: true })).not.toBeChecked();
  expect(state.writes).toEqual([]);

  await page.getByLabel("Stock percentage", { exact: true }).fill("35");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].body).toMatchObject({ expectedHeadRevision: "2", expectedDraftPolicyId: 2 });
  expect(state.writes[0].body.value).toEqual({ ...partial, shareBps: 3500 });
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("advanced stock rules edit the buffer and cutoff independently without enable-field controls", async ({ page }) => {
  const state = await setup(page);
  await page.locator("summary").filter({ hasText: "Advanced stock rules" }).click();
  await page.getByLabel("Stock buffer", { exact: true }).fill("5");
  await page.getByLabel("Out-of-stock cutoff", { exact: true }).fill("3");
  await page.getByRole("radio", { name: "Limit quantity", exact: true }).click();
  await page.getByRole("textbox", { name: "Maximum displayed quantity", exact: true }).fill("20");
  await page.getByRole("radio", { name: "Limit combined channel percentages", exact: true }).click();
  await expect(page.getByLabel("Stock buffer", { exact: true })).toHaveValue("5");
  await expect(page.getByLabel("Out-of-stock cutoff", { exact: true })).toHaveValue("3");
  await expect(page.getByRole("radio", { name: "Set", exact: true })).toHaveCount(0);
  await expect(page.getByText("20 units shown", { exact: true })).toBeVisible();
  await page.getByLabel("Example available stock", { exact: true }).fill("30");
  await expect(page.getByText("10 units shown", { exact: true })).toBeVisible();
  await page.getByLabel("Example available stock", { exact: true }).fill("14");
  await expect(page.getByText("0 units shown", { exact: true })).toBeVisible();
  await page.getByLabel("Example available stock", { exact: true }).fill("16");
  await expect(page.getByText("3 units shown", { exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].body.value).toEqual({ ...defaults, holdbackSellableUnits: "5", minPublishSellableUnits: "3",
    maxPublish: { mode: "units", units: "20" }, allocationSemantics: "partitioned" });
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("background revision changes preserve edits and require explicit reload", async ({ page }) => {
  const state = await setup(page);
  const offer = page.getByLabel("Stock percentage", { exact: true });
  await offer.fill("80");
  state.data.policyHeads[0] = policyHead({ scopeKey: "channel:3", channelId: 3, scope: { scopeType: "channel", channelId: 3 },
    active: defaults, draft: { ...defaults, shareBps: 3000 }, revision: "2" });
  await page.evaluate(() => window.dispatchEvent(new Event("channel-inventory-test-refresh")));
  await expect(page.getByText("Saved settings changed while you were editing", { exact: true })).toBeVisible();
  await expect(offer).toHaveValue("80");
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
  expect(state.writes).toHaveLength(0);
  await page.getByRole("button", { name: "Discard edits and reload", exact: true }).click();
  await expect(offer).toHaveValue("30");
  await offer.fill("70");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].body.expectedHeadRevision).toBe("2");
  expect(state.errors).toEqual([]);
});

test("lost responses freeze edits, block leaving and retry the identical command after refresh", async ({ page }) => {
  const state = await setup(page); state.loseResponse = true;
  const offer = page.getByLabel("Stock percentage", { exact: true });
  await offer.fill("80"); await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByText("Save outcome unknown", { exact: true })).toBeVisible();
  await expect(offer).toBeDisabled();
  state.data.policyHeads[0] = policyHead({ scopeKey: "channel:3", channelId: 3, scope: { scopeType: "channel", channelId: 3 }, active: defaults,
    draft: { ...defaults, shareBps: 8000 }, revision: "2" });
  await page.evaluate(() => window.dispatchEvent(new Event("channel-inventory-test-refresh")));
  await page.getByRole("tab", { name: "Warehouses", exact: true }).click();
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
  await page.getByLabel("Stock percentage", { exact: true }).fill("80");
  await page.getByRole("tab", { name: "Warehouses", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Discard unsaved changes?");
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByLabel("Stock percentage", { exact: true })).toHaveValue("80");
  await page.getByRole("tab", { name: "Warehouses", exact: true }).click();
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Warehouses", exact: true })).toHaveAttribute("data-state", "active");
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
  await expect(page.getByLabel("Stock percentage", { exact: true })).toBeDisabled();
  await expect(page.getByRole("radio", { name: "Available to sell", exact: true })).toBeDisabled();
  await page.locator("summary").filter({ hasText: "Advanced stock rules" }).click();
  await expect(page.getByLabel("Stock buffer", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Out-of-stock cutoff", { exact: true })).toBeDisabled();
  await expect(page.getByRole("radio", { name: "No maximum", exact: true })).toBeDisabled();
  await expect(page.getByRole("radio", { name: "Share available stock", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]);
});

test("browser back restores the prior tab instead of overwriting the URL", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("tab", { name: "Warehouses", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Warehouses", exact: true })).toHaveAttribute("data-state", "active");
  await page.goBack();
  await expect(page.getByRole("tab", { name: "Stock rules", exact: true })).toHaveAttribute("data-state", "active");
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
  await expect(pack).toContainText("Accepted by Shopify US0");
  await expect(pack).toContainText("Last checked at Shopify US0");
  await expect(pack).toContainText("The accepted quantity belongs to an earlier request");
  await expect(pack).toContainText("does not confirm the latest request");
  const each = page.getByLabel("SKUs without stock update records");
  await expect(each).toContainText("CARD-EA");
  await expect(each).toContainText("No request or stock check recorded yet.");
  await page.getByRole("button", { name: "Refresh history", exact: true }).click();
  await expect(page.getByRole("button", { name: "Refresh history", exact: true })).toBeEnabled();
  expect(state.writes).toEqual([]); expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("channel-quantities.png"), fullPage: true });
});

test("failed delivery reads hide stale evidence and never turn failure into zero", async ({ page }) => {
  const state = await setup(page, { query: "?channel=3&destination=5&tab=quantities&product=10" });
  await expect(page.getByRole("article", { name: "CARD-P5 delivery status" })).toBeVisible();
  state.statusFailed = true;
  await page.getByRole("button", { name: "Refresh history", exact: true }).click();
  await expect(page.getByText("Stock update history unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("article", { name: "CARD-P5 delivery status" })).toHaveCount(0);
  await expect(page.getByText("After stock rules", { exact: true })).toBeVisible();
  expect(state.writes).toEqual([]);
});

for (const compactViewport of [false, true]) {
  test(`identity editor retains its exact retry after a lost response${compactViewport ? " in a compact viewport" : ""}`, async ({ page }) => {
    if (compactViewport) await page.setViewportSize({ width: page.viewportSize()!.width, height: 420 });
    const state = await setup(page, { query: "?channel=3&destination=5&tab=quantities&product=10" });
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Inventory item id", { exact: true }).fill("new-provider-item");
    state.loseResponse = true;
    await page.getByRole("button", { name: "Save identity", exact: true }).click();
    await expect(page.getByText("Save outcome unknown", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Inventory item id", { exact: true })).toBeDisabled();
    // Error feedback grows the popover. Its container must remain inside the
    // viewport and scroll the real action into reach, without a forced click.
    await expect.poll(async () => {
      const bounds = await page.getByRole("dialog").boundingBox();
      return bounds !== null && bounds.y >= 0 && bounds.y + bounds.height <= page.viewportSize()!.height;
    }).toBe(true);
    const retry = page.getByRole("button", { name: "Retry same save", exact: true });
    await retry.scrollIntoViewIfNeeded();
    await expect(retry).toBeInViewport();
    await retry.click();
    await expect.poll(() => state.writes.length).toBe(2);
    expect(state.writes[1].raw).toBe(state.writes[0].raw);
    expect(state.writes[0].body).toMatchObject({ productVariantId: 101, publicationTargetId: 5, changeReason: null, externalInventoryItemId: "new-provider-item" });
    expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
  });
}

test("SKU exceptions keep inherited fields and retry the same command after a lost response", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Add exception", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("combobox").click();
  await page.getByRole("option", { name: /Card Shell/ }).click();
  await sheet.getByRole("radio", { name: "CARD-P5", exact: true }).click();
  await sheet.getByLabel("Stock percentage", { exact: true }).fill("25");
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

test("a single exception field returns to its inherited value without copying the defaults into the rule", async ({ page }) => {
  const state = await setup(page, { viewOverrides: { policyHeads: [
    policyHead({ scopeKey: "channel:3", channelId: 3, scope: { scopeType: "channel", channelId: 3 }, active: defaults }),
    policyHead({ scopeKey: "channel:3:variant:101", channelId: 3,
      scope: { scopeType: "variant", channelId: 3, productId: 10, productVariantId: 101 },
      active: policyValue({ shareBps: 2500, holdbackSellableUnits: "5" }) }),
  ] } });
  await page.getByRole("button", { name: "Add exception", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("combobox").click();
  await page.getByRole("option", { name: /Card Shell/ }).click();
  await sheet.getByRole("radio", { name: "CARD-P5", exact: true }).click();
  await expect(sheet.getByLabel("Stock percentage", { exact: true })).toHaveValue("25");
  await expect(sheet.getByLabel("Stock buffer", { exact: true })).toHaveValue("5");
  await sheet.getByRole("button", { name: "Use default for Stock percentage", exact: true }).click();
  await expect(sheet.getByLabel("Stock percentage", { exact: true })).toHaveValue("50");
  await expect(sheet.getByLabel("Stock percentage", { exact: true })).toBeEnabled();
  await expect(sheet.getByRole("button", { name: "Use default for Stock percentage", exact: true })).toHaveCount(0);
  await sheet.getByRole("button", { name: "Save exception", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].body.value).toEqual(policyValue({ holdbackSellableUnits: "5" }));
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("review covers the whole channel and Apply queues the saved batch without a reason field", async ({ page }, testInfo) => {
  const state = await setup(page, { pending: true, query: "?channel=3&destination=5&tab=publishing" });
  await page.getByRole("button", { name: "Review saved changes", exact: true }).click();
  const review = page.getByLabel("Channel changes review", { exact: true });
  await expect(review).toContainText("1 saved change · 2 affected products");
  await expect(review).toContainText("CARD-P5"); await expect(review).toContainText("BOX-C25");
  await expect(review).toContainText("50 → 80");
  await expect(review.getByRole("textbox")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("channel-apply-review.png"), fullPage: true });
  await page.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(page.getByText("Channel settings applied", { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].body).toMatchObject({ channelId: 3, expectedReviewHash: HASH_A });
  expect(state.writes[0].path).toBe("/api/inventory-planning/admin/channel-definitions/apply");
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("lost Apply responses retain the exact command through background refresh and block navigation", async ({ page }) => {
  const state = await setup(page, { pending: true, query: "?channel=3&destination=5&tab=publishing" });
  await page.getByRole("button", { name: "Review saved changes", exact: true }).click();
  state.applyLostResponse = true;
  await page.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(page.getByText(/Apply outcome is unknown/)).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("channel-inventory-test-refresh")));
  await expect(page.getByText("Saved settings changed. Review again before applying.", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Stock rules", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Resolve the save first");
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await page.getByRole("button", { name: "Retry same Apply", exact: true }).click();
  await expect(page.getByText("Channel settings applied", { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1].raw).toBe(state.writes[0].raw);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("stale Apply returns to review and does not reuse its rejected command", async ({ page }) => {
  const state = await setup(page, { pending: true, query: "?channel=3&destination=5&tab=publishing" });
  await page.getByRole("button", { name: "Review saved changes", exact: true }).click();
  state.applyConflict = true;
  await page.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(page.getByText("Inventory or settings changed. Review the channel again.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry same Apply", exact: true })).toHaveCount(0);
  state.applyConflict = false;
  await page.getByRole("button", { name: "Review saved changes", exact: true }).click();
  await page.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(page.getByText("Channel settings applied", { exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1].body.idempotencyKey).not.toBe(state.writes[0].body.idempotencyKey);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("blocked reviews cannot apply and view-only users can review but not activate", async ({ page }) => {
  const state = await setup(page, { pending: true, permission: "view", query: "?channel=3&destination=5&tab=publishing" });
  state.reviewBlocked = true;
  await page.getByRole("button", { name: "Review saved changes", exact: true }).click();
  await expect(page.getByText(/Warehouse evidence is unavailable/)).toBeVisible();
  await expect(page.getByText("Your role can review but needs inventory activation permission to apply.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply changes", exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("pre-cutover workspace cannot use routine Apply to activate the migration", async ({ page }) => {
  const state = await setup(page, { pending: true, legacy: true, query: "?channel=3&destination=5&tab=publishing" });
  await expect(page.getByText(/These settings are saved for first-time inventory setup/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Review saved changes", exact: true })).toHaveCount(0);
  expect(state.reads.some(path => path.endsWith("/progress"))).toBe(false);
  expect(state.writes).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("SKU warehouse override saves independently of selling dials", async ({ page }, testInfo) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Add exception", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("combobox").click();
  await page.getByRole("option", { name: /Card Shell/ }).click();
  await sheet.getByRole("radio", { name: "CARD-P5", exact: true }).click();
  await sheet.getByRole("checkbox", { name: "Use inherited warehouses", exact: true }).uncheck();
  await sheet.getByRole("checkbox", { name: /Canada 3PL/ }).check();
  await sheet.getByRole("button", { name: "Save exception", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("sku-supply-override.png") });
  await sheet.getByRole("button", { name: "Save exception", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].body).toMatchObject({ scope: { scopeType: "variant", channelId: 3, productId: 10, productVariantId: 101 },
    value: { sourceFulfillmentNodeIds: [8], shareBps: null, eligible: null, holdbackSellableUnits: null, maxPublish: null }, changeReason: null });
  expect(state.writes[0].body.value).not.toHaveProperty("inheritAll");
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("an existing SKU exception can restore complete inheritance as an audited draft", async ({ page }) => {
  const state = await setup(page);
  state.data.policyHeads.push(policyHead({ scopeKey: "channel:3:variant:101", channelId: 3,
    scope: { scopeType: "variant", channelId: 3, productId: 10, productVariantId: 101 },
    active: policyValue({ shareBps: 2500, sourceFulfillmentNodeIds: [8] }) }));
  await page.evaluate(() => window.dispatchEvent(new Event("channel-inventory-test-refresh")));
  await page.getByRole("button", { name: "Add exception", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("combobox").click(); await page.getByRole("option", { name: /Card Shell/ }).click();
  await sheet.getByRole("radio", { name: "CARD-P5", exact: true }).click();
  await expect(sheet.getByLabel("Stock percentage", { exact: true })).toHaveValue("25");
  await sheet.getByRole("button", { name: "Restore all inheritance", exact: true }).click();
  await expect(sheet.getByRole("checkbox", { name: "Use inherited warehouses", exact: true })).toBeChecked();
  await sheet.getByRole("button", { name: "Save exception", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0].body).toMatchObject({ expectedHeadRevision: "1", value: { inheritAll: true, shareBps: null,
    allocationSemantics: null, eligible: null, holdbackSellableUnits: null, maxPublish: null, minPublishSellableUnits: null } });
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});


test("account toggle confirms a pause, preserves its state on cancellation or failure, and changes only after success", async ({ page }, info) => {
  const state = await setup(page, { query: "?channel=3&destination=5&tab=rules", viewOverrides: {
    publicationTargets: [target({ state: "live" })],
  } });
  const toggle = page.getByRole("switch", { name: /^Automatic stock updates for/ });
  await expect(toggle).toBeChecked();
  await expect(page.getByRole("tab", { name: "Stock updates", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Saved channel changes", { exact: true })).toHaveCount(0);
  await toggle.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Pausing does not set it to zero");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(toggle).toBeChecked();
  expect(state.writes).toEqual([]);
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Pause stock updates", exact: true })).toBeEnabled();
  await dialog.screenshot({ path: info.outputPath("pause-confirmation.png") });
  state.stopFailed = true;
  await dialog.getByRole("button", { name: "Pause stock updates", exact: true }).click();
  await expect(page.getByText("Stock updates could not be paused.", { exact: true }).first()).toBeVisible();
  await expect(page.locator('#stock-updates-5')).toBeChecked();
  state.stopFailed = false;
  await dialog.getByRole("button", { name: "Pause stock updates", exact: true }).click();
  await expect(toggle).not.toBeChecked();
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1].raw).toBe(state.writes[0].raw);
  expect(state.writes[1].body).toMatchObject({ publicationTargetId: 5, expectedRevision: "3", changeReason: null });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("account-stock-toggle-paused.png"), fullPage: true });
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("saved changes review is available next to rules and protects unsaved edits", async ({ page }) => {
  const state = await setup(page, { pending: true });
  await expect(page.getByRole("tab", { name: "Stock rules", exact: true })).toHaveAttribute("data-state", "active");
  await page.getByLabel("Stock percentage", { exact: true }).fill("70");
  await page.getByRole("button", { name: "Review saved changes", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Discard unsaved changes?");
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(page.getByLabel("Channel changes review", { exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
});


test("each account toggle operates on its own location without changing the selected account", async ({ page }) => {
  const state = await setup(page, { query: "?channel=3&destination=5&tab=rules", viewOverrides: {
    publicationTargets: [target({ state: "live" }), target({ id: 6, state: "live", externalScopeId: "gid://shopify/Location/2" })],
  } });
  const first = page.getByRole("switch", { name: /Automatic stock updates.*Location\/1$/ });
  const second = page.getByRole("switch", { name: /Automatic stock updates.*Location\/2$/ });
  await expect(first).toBeChecked(); await expect(second).toBeChecked();
  await second.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Pause stock updates", exact: true }).click();
  await expect(second).not.toBeChecked(); await expect(first).toBeChecked();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0].body).toMatchObject({ publicationTargetId: 6, expectedRevision: "3" });
  await expect(page).toHaveURL(/destination=5/);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});


test("pausing all channels needs no reason and retains retry identity; enabling still asks for a reason", async ({ page }, info) => {
  const state = await setup(page);
  const openControl = () => page.getByRole("button", { name: /^(All-channel control on|Stock updates off for all channels)/ }).click();
  await openControl();
  const dialog = page.getByRole("dialog", { name: "Stock updates for all channels", exact: true });
  await dialog.getByRole("switch", { name: "Send quantity updates", exact: true }).uncheck();
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  expect(state.writes).toEqual([]);
  expect(state.global.globalEnabled).toBe(true);
  await openControl();
  await dialog.getByRole("switch", { name: "Send quantity updates", exact: true }).uncheck();
  await dialog.screenshot({ path: info.outputPath("all-channel-pause.png") });
  state.globalChangeFailed = true;
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText("Stock-update control is busy. Retry this change.", { exact: true }).first()).toBeVisible();
  expect(state.global.globalEnabled).toBe(true);
  state.globalChangeFailed = false;
  await dialog.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1].raw).toBe(state.writes[0].raw);
  expect(state.writes[1].body).toMatchObject({ globalEnabled: false, expectedRevision: "1" });
  expect(state.writes[1].body).not.toHaveProperty("changeReason");
  expect(state.global.globalEnabled).toBe(false);
  await openControl();
  await dialog.getByRole("switch", { name: "Send quantity updates", exact: true }).check();
  await expect(dialog.getByRole("textbox")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await dialog.getByRole("textbox").fill("Resume after review");
  await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  expect(state.writes).toHaveLength(2);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});
