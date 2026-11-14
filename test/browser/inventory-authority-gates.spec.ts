import { staffAuthorityFixture } from "./fixtures/staff-authority.fixture";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { view, policyHead, policyValue, HASH_A } from "../../client/src/features/channel-inventory/__tests__/fixtures";

type Authority = "legacy" | "canonical" | "unavailable";

const connectedChannels = [
  { id: 36, name: "Shopify", provider: "shopify", shopDomain: "example-us.myshopify.com" },
  { id: 37, name: "Shopify-Canada", provider: "shopify", shopDomain: "example-ca.myshopify.com" },
  { id: 67, name: "Ebay", provider: "ebay", shopDomain: "ebay.com/usr/example" },
  { id: 103, name: "Dropship OMS", provider: "manual", shopDomain: null },
  { id: 104, name: "Walmart", provider: "walmart", shopDomain: null },
].map(({ shopDomain, ...channel }) => ({
  ...channel, type: "internal", status: "active", isDefault: 0, priority: 1,
  createdAt: "2026-09-14T00:00:00.000Z", partnerProfile: null,
  connection: channel.provider === "manual" ? null : {
    id: channel.id, channelId: channel.id, shopDomain, lastSyncAt: null, syncStatus: "ok", syncError: null,
  },
}));

async function setup(
  page: Page,
  mode: "allocation" | "reserves" | "warehouses" | "channels",
  authority: Authority,
  options: { channelStatus?: number; emptyChannels?: boolean; canCopyStockRules?: boolean; copyRefused?: boolean } = {},
) {
  const state = {
    created: [] as Array<Record<string, unknown>>, copies: [] as Array<Record<string, unknown>>, stockRuleReads: 0,
    unexpected: [] as string[], errors: [] as string[], channelReads: 0,
    channelStatus: options.channelStatus ?? 200,
  };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1"
    ? route.continue()
    : route.abort());
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/auth/me") {
      return route.fulfill({ json: staffAuthorityFixture({ user: { id: "operator-1", username: "operator", role: "admin" }, permissions: ["channels:view", "channels:edit", "channels:create", "inventory:view", "inventory:edit", "inventory_planning:view",
        ...(options.canCopyStockRules ? ["inventory_planning:edit", "inventory_planning:activate"] : [])], systemRoles: ["admin"] }) });
    }
    if (request.method() === "GET" && path === "/api/inventory-planning/runtime-authority") {
      if (authority === "unavailable") {
        return route.fulfill({ status: 503, json: { error: { message: "Authority unavailable" } } });
      }
      return route.fulfill({ json: {
        contractVersion: "inventory_runtime_authority_readout_v1",
        authority,
        liveAllocator: authority === "legacy" ? "channel_allocation_rules" : "inventory_exposure",
        revision: "7",
        activationRunId: authority === "legacy" ? null : "42",
        changedBy: "operator-1",
        changeReason: "Approved cutover",
        changedAt: "2026-09-13T12:00:00.000Z",
      } });
    }
    if (request.method() === "GET" && path === "/api/warehouses") {
      return route.fulfill({ json: [{
        id: 1,
        code: "MAIN",
        name: "Main Warehouse",
        warehouseType: "operations",
        hubWarehouseId: null,
        address: null,
        city: "New Castle",
        state: "DE",
        postalCode: "19720",
        country: "US",
        timezone: "America/New_York",
        orderCutoffLocal: null,
        isActive: 1,
        isDefault: 1,
        shopifyLocationId: null,
        inventorySourceType: "internal",
        inventorySourceConfig: null,
        lastInventorySyncAt: null,
        inventorySyncStatus: null,
        feedEnabled: true,
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z",
      }] });
    }
    if (request.method() === "GET" && path === "/api/channels") {
      state.channelReads += 1;
      if (state.channelStatus !== 200) {
        return route.fulfill({ status: state.channelStatus, json: { error: "Channels unavailable" } });
      }
      return route.fulfill({ json: mode === "channels" && !options.emptyChannels ? connectedChannels : [] });
    }
    if (mode === "channels" && request.method() === "GET" && path === "/api/warehouse-settings/default") {
      return route.fulfill({ json: { channelSyncEnabled: 1 } });
    }
    // Adding a channel with "Copy stock rules from": the rules read, the create, then the copy.
    if (mode === "channels" && request.method() === "GET" && path === "/api/inventory-planning/admin/channel-exposure") {
      state.stockRuleReads += 1;
      const defaults = policyValue({ allocationSemantics: "exposure", eligible: true, shareBps: 10_000,
        holdbackSellableUnits: "0", maxPublish: { mode: "unlimited" }, minPublishSellableUnits: "0" });
      // Only Shopify US (3) has rules in effect; eBay (4) has a default that was saved and never applied.
      return route.fulfill({ json: view({ policyHeads: [
        policyHead({ scopeKey: "channel:3", channelId: 3, scope: { scopeType: "channel", channelId: 3 }, active: defaults }),
        policyHead({ scopeKey: "channel:4", channelId: 4, scope: { scopeType: "channel", channelId: 4 }, draft: defaults }),
      ] }) });
    }
    if (mode === "channels" && request.method() === "POST" && path === "/api/channels") {
      state.created.push(request.postDataJSON());
      return route.fulfill({ status: 201, json: { id: 200, ...request.postDataJSON() } });
    }
    if (mode === "channels" && request.method() === "POST" && path === "/api/inventory-planning/admin/channel-rule-definitions/copy") {
      const body = request.postDataJSON();
      state.copies.push(body);
      if (options.copyRefused) return route.fulfill({ status: 409, json: { error: { code: "CHANNEL_RULE_COPY_SOURCE_EMPTY",
        message: "Shopify US has no stock rules in effect to copy." } } });
      return route.fulfill({ json: { receipt: { channelId: body.targetChannelId, appliedAt: "2026-11-12T12:00:00.000Z", appliedBy: "operator-1",
        reviewHash: HASH_A, publicationIds: [], changedDefinitions: 3, alreadyApplied: false }, sourceChannelId: body.sourceChannelId,
        sourceChannelName: "Shopify US", targetChannelName: "TikTok Shop", copiedExceptions: 2, skippedRules: [], changedQuantities: 0,
        skippedDestinations: [], warnings: [] } });
    }
    state.unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: "Unexpected request" } });
  });
  await page.route("**/__inventory-authority-gates-test**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
      <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
      <body><main id="root"></main><script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/inventory-authority-gates-harness.tsx").replaceAll("\\", "/")}"></script></body></html>`,
  }));
  await page.goto(`/__inventory-authority-gates-test?mode=${mode}`);
  return state;
}

test.describe("inventory runtime authority gates", () => {
  for (const authority of ["canonical", "unavailable"] as const) {
    test(`sales channels and saved connections load with ${authority} inventory authority`, async ({ page }) => {
      const state = await setup(page, "channels", authority);
      await expect(page.getByTestId(/^channel-card-/)).toHaveCount(5);
      for (const channel of connectedChannels) {
        await expect(page.getByTestId(`channel-card-${channel.id}`)).toContainText(channel.name);
      }
      await expect(page.getByText("No Channels Connected", { exact: true })).toHaveCount(0);
      await expect(page.getByTestId("canonical-channel-publication-controls")).toBeVisible();
      if (authority === "unavailable") {
        await expect(page.getByText("Live allocator unknown", { exact: true })).toBeVisible();
      }
      await page.getByTestId("channel-card-36").click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("tab", { name: "Connection", exact: true }).click();
      await expect(dialog.getByRole("link")).toHaveAttribute("href", "https://example-us.myshopify.com");
      await expect(dialog.getByRole("link")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Open Channel Inventory", exact: true })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Publish inventory to Shopify", exact: true })).toHaveCount(0);
      expect(state.channelReads).toBe(1);
      // Any legacy sync read or mutation would be captured as an unexpected request.
      expect(state.unexpected).toEqual([]);
      expect(state.errors).toEqual([]);
    });
  }

  test("sales channel load failure shows a retry instead of claiming connections are missing", async ({ page }) => {
    const state = await setup(page, "channels", "canonical", { channelStatus: 503 });
    await expect(page.getByRole("alert").filter({ hasText: "Unable to load sales channels" })).toBeVisible();
    await expect(page.getByText("No Channels Connected", { exact: true })).toHaveCount(0);
    state.channelStatus = 200;
    await page.getByRole("button", { name: "Retry loading channels", exact: true }).click();
    await expect(page.getByTestId(/^channel-card-/)).toHaveCount(5);
    await expect(page.getByText("Unable to load sales channels", { exact: true })).toHaveCount(0);
    expect(state.channelReads).toBe(2);
    expect(state.unexpected).toEqual([]);
    expect(state.errors).toEqual([]);
  });

  test("sales channel empty state requires a successful empty response", async ({ page }) => {
    const state = await setup(page, "channels", "canonical", { emptyChannels: true });
    await expect(page.getByText("No Channels Connected", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Your First Channel", exact: true })).toBeVisible();
    expect(state.channelReads).toBe(1);
    expect(state.unexpected).toEqual([]);
    expect(state.errors).toEqual([]);
  });

  for (const mode of ["allocation", "reserves"] as const) {
    test(`${mode} retires legacy controls after canonical activation without reading legacy data`, async ({ page }) => {
      const state = await setup(page, mode, "canonical");
      await expect(page.getByText(
        mode === "allocation" ? "Legacy Channel Allocation is retired" : "Legacy channel reserves are retired",
        { exact: true },
      )).toBeVisible();
      await expect(page.getByRole("link", { name: "Open Channel Inventory", exact: true })).toBeVisible();
      expect(state.unexpected).toEqual([]);
      expect(state.errors).toEqual([]);
    });

    test(`${mode} fails closed when authority cannot be read`, async ({ page }) => {
      const state = await setup(page, mode, "unavailable");
      await expect(page.getByText(
        mode === "allocation" ? "Channel Allocation controls are unavailable" : "Channel reserve controls are unavailable",
        { exact: true },
      )).toBeVisible();
      expect(state.unexpected).toEqual([]);
      expect(state.errors).toEqual([]);
    });
  }

  test("adding a channel can copy another channel's stock rules, after the channel is created", async ({ page }, testInfo) => {
    const state = await setup(page, "channels", "canonical", { canCopyStockRules: true });
    await page.getByTestId("button-create-channel").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("input-channel-name").fill("TikTok Shop");
    // Nothing is copied unless asked.
    await expect(dialog.getByTestId("select-copy-stock-rules")).toHaveText("Don't copy");
    await dialog.getByTestId("select-copy-stock-rules").click();
    // Only a channel whose rules are in effect can be copied from.
    await expect(page.getByRole("option")).toHaveText(["Don't copy", "Shopify US"]);
    await page.getByRole("option", { name: "Shopify US", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("add-channel-copy-stock-rules.png") });
    await dialog.getByTestId("button-submit-channel").click();
    await expect(page.getByText("Copied the default and 2 exceptions from Shopify US to TikTok Shop. No quantity sent to a channel changes right now.",
      { exact: true }).first()).toBeVisible();
    expect(state.created).toHaveLength(1);
    expect(state.created[0]).toMatchObject({ name: "TikTok Shop" });
    // The copy names the channel the server just created.
    expect(state.copies).toHaveLength(1);
    expect(state.copies[0]).toMatchObject({ sourceChannelId: 3, targetChannelId: 200 });
    expect(state.unexpected).toEqual([]);
    expect(state.errors).toEqual([]);
  });

  test("a refused copy still leaves the new channel created and says where to copy later", async ({ page }) => {
    const state = await setup(page, "channels", "canonical", { canCopyStockRules: true, copyRefused: true });
    await page.getByTestId("button-create-channel").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("input-channel-name").fill("TikTok Shop");
    await dialog.getByTestId("select-copy-stock-rules").click();
    await page.getByRole("option", { name: "Shopify US", exact: true }).click();
    await dialog.getByTestId("button-submit-channel").click();
    await expect(page.getByText("Channel created, stock rules not copied", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Not copied\. Shopify US has no stock rules in effect to copy\. You can copy them in Channel Inventory/).first()).toBeVisible();
    expect(state.created).toHaveLength(1);
    expect(state.unexpected).toEqual([]);
    expect(state.errors).toEqual([]);
  });

  test("adding a channel without stock-rule permission offers no copy and reads no rules", async ({ page }) => {
    const state = await setup(page, "channels", "canonical");
    await page.getByTestId("button-create-channel").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("input-channel-name").fill("TikTok Shop");
    await expect(dialog.getByTestId("select-copy-stock-rules")).toHaveCount(0);
    await dialog.getByTestId("button-submit-channel").click();
    await expect(page.getByText("Channel created successfully", { exact: true }).first()).toBeVisible();
    expect(state.stockRuleReads).toBe(0);
    expect(state.copies).toEqual([]);
    expect(state.unexpected).toEqual([]);
    expect(state.errors).toEqual([]);
  });

  test("warehouses exposes the legacy feed switch only under confirmed legacy authority", async ({ page }) => {
    const state = await setup(page, "warehouses", "legacy");
    await expect(page.getByRole("switch")).toBeVisible();
    expect(state.unexpected).toEqual([]);
    expect(state.errors).toEqual([]);
  });

  test("warehouses replaces the obsolete feed switch under canonical authority", async ({ page }) => {
    const state = await setup(page, "warehouses", "canonical");
    await expect(page.getByText("Channel Inventory", { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(page.getByRole("switch")).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
    expect(state.errors).toEqual([]);
  });

  test("warehouses fails closed while runtime authority is unknown", async ({ page }) => {
    const state = await setup(page, "warehouses", "unavailable");
    await expect(page.getByText("Authority unknown", { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(page.getByRole("switch")).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
    expect(state.errors).toEqual([]);
  });
});
