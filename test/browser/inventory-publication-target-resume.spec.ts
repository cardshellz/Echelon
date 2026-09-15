import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const NOW = "2026-09-14T12:00:00.000Z";

async function setup(page: Page) {
  const state = {
    targetState: "preview" as "preview" | "live",
    targetRevision: "3",
    writes: [] as Array<{ method: string; path: string; body: Record<string, unknown> }>,
    unexpected: [] as string[],
    errors: [] as string[],
  };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1"
    ? route.continue()
    : route.abort());
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === "GET" && path === "/api/auth/me") {
      return route.fulfill({ json: {
        user: { id: "operator-1", username: "operator", role: "admin" },
        permissions: [
          "inventory_planning:view",
          "inventory_planning:edit",
          "inventory_planning:activate",
        ],
        roles: ["admin"],
      } });
    }
    if (request.method() === "GET" && path === "/api/inventory-planning/runtime-authority") {
      return route.fulfill({ json: {
        contractVersion: "inventory_runtime_authority_readout_v1",
        authority: "canonical",
        liveAllocator: "inventory_exposure",
        revision: "9",
        activationRunId: "44",
        changedBy: "operator-1",
        changeReason: "Approved canonical cutover",
        changedAt: NOW,
      } });
    }
    if (request.method() === "GET" && path === "/api/sync/status") {
      return route.fulfill({ json: {
        global: {
          id: 1,
          globalEnabled: true,
          sweepIntervalMinutes: 15,
          revision: "2",
          changedBy: "operator-1",
          changeReason: "Enable canonical publication",
          lastSweepAt: null,
          lastSweepDurationMs: null,
          updatedAt: NOW,
        },
        channels: [],
        summary: { pushed: 0, dryRun: 0, errors: 0, skipped: 0 },
      } });
    }
    if (request.method() === "GET" && path === "/api/warehouses/inventory-sources") {
      return route.fulfill({ json: { warehouses: [] } });
    }
    if (request.method() === "GET"
      && path === "/api/inventory-planning/admin/channel-exposure") {
      return route.fulfill({ json: adminView(state.targetState, state.targetRevision) });
    }
    if (request.method() === "GET"
      && path === "/api/inventory-planning/admin/channel-exposure/preview") {
      return route.fulfill({ json: exposurePreview(state.targetState, state.targetRevision) });
    }
    if (request.method() === "POST"
      && path === "/api/inventory-planning/admin/channel-exposure/publication-target-resume-review") {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.writes.push({ method: request.method(), path, body });
      return route.fulfill({ status: 201, json: readyReview() });
    }
    if (request.method() === "POST"
      && path === "/api/inventory-planning/admin/channel-exposure/publication-target-resume") {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.writes.push({ method: request.method(), path, body });
      state.targetState = "live";
      state.targetRevision = "4";
      return route.fulfill({ json: {
        publicationTargetId: 5,
        revision: "4",
        state: "live",
        activationRunId: "44",
        authorityRevision: "9",
        resumeReviewId: "71",
        evidenceHash: HASH_B,
        publicationRows: 1,
        alreadyApplied: false,
        runtimeAuthorityChanged: false,
        providerWriteAttempted: false,
        outboxEnqueued: true,
      } });
    }
    state.unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: { message: "Unexpected request" } } });
  });
  await page.route("**/__inventory-publication-target-resume-test", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
      <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
      <body><main id="root"></main><script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/inventory-publication-target-resume-harness.tsx").replaceAll("\\", "/")}"></script></body></html>`,
  }));
  await page.goto("/__inventory-publication-target-resume-test");
  await expect(page.getByRole("heading", { name: "Channel Inventory", exact: true })).toBeVisible();
  return state;
}

const REASON = "Restore after exact provider readback and incident resolution";
const REASON_LABEL = "Reason (required for this publishing command)";

test("reviews immutable readiness evidence before resuming one exact destination", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("tab", { name: "Publishing", exact: true }).click();
  await expect(page.getByText("Calculating only", { exact: true }).first()).toBeVisible();

  // Routine tabs never ask for a reason; the sensitive publishing command does, at the moment of the action.
  await page.getByRole("button", { name: "Check readiness to resume", exact: true }).click();
  const reviewDialog = page.getByRole("alertdialog");
  await reviewDialog.getByLabel(REASON_LABEL).fill(REASON);
  await reviewDialog.getByRole("button", { name: "Run readiness check", exact: true }).click();

  await expect(page.getByText("Readiness check #71", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume publishing", exact: true })).toBeEnabled();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({
    method: "POST",
    path: "/api/inventory-planning/admin/channel-exposure/publication-target-resume-review",
    body: {
      publicationTargetId: 5,
      expectedRevision: "3",
      reason: REASON,
    },
  });

  await page.getByRole("button", { name: "Resume publishing", exact: true }).click();
  const resumeDialog = page.getByRole("alertdialog");
  await resumeDialog.getByLabel(REASON_LABEL).fill(REASON);
  await resumeDialog.getByRole("button", { name: "Resume publishing", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop publishing", exact: true })).toBeVisible();
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]).toMatchObject({
    method: "POST",
    path: "/api/inventory-planning/admin/channel-exposure/publication-target-resume",
    body: {
      publicationTargetId: 5,
      expectedRevision: "3",
      resumeReviewId: "71",
      expectedEvidenceHash: HASH_B,
      reason: REASON,
    },
  });
  expect(state.writes.every((write) => write.path.includes("channel-exposure"))).toBe(true);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

function adminView(state: "preview" | "live", revision: string) {
  return {
    products: [{ id: 10, sku: "CARD", name: "Card Shell" }],
    selectedProduct: {
      id: 10,
      sku: "CARD",
      name: "Card Shell",
      variants: [{
        id: 101,
        sku: "CARD-P5",
        name: "Pack of 5",
        unitsPerVariant: 5,
        salesEligibility: "sellable",
        isActive: true,
      }],
    },
    channels: [{
      id: 3,
      name: "Shopify US",
      provider: "shopify",
      status: "active",
      connections: [{
        id: 33,
        externalAccountLabel: "US store",
        shopifyLocationId: "gid://shopify/Location/1",
        providerAccount: null,
      }],
    }],
    dropshipStores: [],
    publicationTargets: [{
      id: 5,
      destinationKind: "channel_connection",
      channelId: 3,
      channelConnectionId: 33,
      dropshipStoreConnectionId: null,
      legacyFulfillmentNodeId: 7,
      providerScopeType: "location",
      externalScopeId: "gid://shopify/Location/1",
      publicationAuthority: "echelon",
      state,
      revision,
    }],
    fulfillmentNodes: [{
      id: 7,
      code: "MAIN",
      name: "Main Warehouse",
      nodeType: "internal_warehouse",
      warehouseId: 1,
      warehouseCode: "MAIN",
      lifecycleStatus: "active",
    }],
    policyHeads: [],
    policySubjects: [],
    sourceBindingHeads: [],
    variantMappingHeads: [],
    legacyMappingCandidates: [],
    runtimeAuthority: "canonical",
    runtimeAuthorityRevision: "9",
    providerWriteEnabled: false,
  };
}

function exposurePreview(state: "preview" | "live", revision: string) {
  return {
    publicationTargetId: 5,
    destinationKind: "channel_connection",
    channelId: 3,
    channelConnectionId: 33,
    dropshipStoreConnectionId: null,
    providerScopeType: "location",
    externalScopeId: "gid://shopify/Location/1",
    publicationAuthority: "echelon",
    publicationTargetState: state,
    publicationTargetRevision: revision,
    productId: 10,
    shadowRunId: "81",
    snapshotFingerprint: HASH_A,
    shadowCapturedAt: NOW,
    modelId: null,
    modelVersion: null,
    modelDefinitionHash: null,
    sourceBindingId: 8,
    sourceBindingVersion: 1,
    sourceBindingDefinitionHash: HASH_A,
    sourceBindingAuthority: "active",
    fulfillmentNodeIds: [7],
    warehouseIds: [1],
    selectedPolicies: [{
      scopeKey: "channel:3",
      policyId: 9,
      version: 1,
      definitionHash: HASH_A,
      authority: "active",
    }],
    rows: [{
      ...runtimeRow(),
      mapping: { ...runtimeRow().mapping, authority: "active" },
    }],
    blockers: [],
    runtimeAuthorityChanged: false,
    providerWriteAttempted: false,
    outboxEnqueued: false,
  };
}

function readyReview() {
  return {
    resumeReviewId: "71",
    publicationTargetId: 5,
    publicationTargetRevision: "3",
    authorityRevision: "9",
    activationRunId: "44",
    state: "ready",
    configurationHash: HASH_A,
    readinessHash: HASH_A,
    evidenceHash: HASH_B,
    requestedBy: "operator-1",
    reason: "Restore after exact provider readback and incident resolution",
    capturedAt: NOW,
    identityCensus: [{
      productVariantId: 101,
      productId: 10,
      externalInventoryItemId: "inventory-item-101",
      evidenceSources: ["active_mapping", "outbox", "readback"],
      coveredByCurrentMapping: true,
    }],
    products: [{
      productId: 10,
      snapshotFingerprint: HASH_A,
      target: {
        publicationTargetId: 5,
        publicationTargetRevision: "3",
        destinationKind: "channel_connection",
        channelId: 3,
        channelName: "Shopify US",
        channelProvider: "shopify",
        channelConnectionId: 33,
        dropshipStoreConnectionId: null,
        providerScopeType: "location",
        externalScopeId: "gid://shopify/Location/1",
        publicationAuthority: "echelon",
        publicationTargetState: "live",
        sourceBinding: {
          bindingId: 8,
          version: 1,
          definitionHash: HASH_A,
          fulfillmentNodeIds: [7],
          warehouseIds: [1],
        },
        selectedPolicies: [{ scopeKey: "channel:3", policyId: 9, version: 1, definitionHash: HASH_A }],
        rows: [runtimeRow()],
        blockers: [],
        publishable: true,
      },
      readbacks: [{
        productVariantId: 101,
        externalInventoryItemId: "inventory-item-101",
        observedQuantity: "4",
        observedAt: NOW,
        evidenceHash: HASH_A,
      }],
    }],
    blockers: [],
    runtimeAuthorityChanged: false,
    providerWriteAttempted: false,
    outboxEnqueued: false,
    alreadyApplied: false,
  };
}

function runtimeRow() {
  return {
    productVariantId: 101,
    sku: "CARD-P5",
    unitsPerVariant: 5,
    canonicalAtpUnits: "10",
    sharedUnits: "4",
    afterHoldbackUnits: "4",
    cappedUnits: "4",
    publishedUnits: "4",
    sourceWarehouseBreakdown: [{ warehouseId: 1, canonicalAtpUnits: "10" }],
    policy: {
      allocationSemantics: "exposure",
      eligible: true,
      shareBps: 4_000,
      holdbackSellableUnits: "0",
      maxPublishSellableUnits: null,
      minPublishSellableUnits: "0",
      sources: {
        allocationSemantics: "channel:3",
        eligible: "channel:3",
        shareBps: "channel:3",
        holdbackSellableUnits: "channel:3",
        maxPublishSellableUnits: "channel:3",
        minPublishSellableUnits: "channel:3",
      },
    },
    mapping: {
      mappingId: 11,
      version: 1,
      definitionHash: HASH_A,
      externalInventoryItemId: "inventory-item-101",
      externalSku: "CARD-P5",
    },
    blockers: [],
    warnings: [],
  };
}
