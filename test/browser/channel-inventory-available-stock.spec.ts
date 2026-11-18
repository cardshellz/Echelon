import { staffAuthorityFixture } from "./fixtures/staff-authority.fixture";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { view, HASH_A } from "../../client/src/features/channel-inventory/__tests__/fixtures";
import type { PromiseSafetyOverview } from "../../shared/types/inventory-safety-definition";

const VIEW = "/api/inventory-planning/admin/channel-exposure";
const SAFETY = "/api/inventory-planning/admin/safety-definitions";
const AT = "2026-11-12T12:00:00.000Z";

const receipt = (scopeKey: string, policyId: number) => ({ scopeKey, policyId, appliedAt: AT, appliedBy: "operator-1",
  reviewHash: HASH_A, publicationIds: ["31"], alreadyApplied: false });

/** Card Shell (product 10) has CARD-P5 (101) and CARD-EA (102). The default holds back 0; CARD-EA holds back 10. */
async function setup(page: Page, options: { permissions?: string[]; legacy?: boolean; refuse?: boolean } = {}) {
  const overview: PromiseSafetyOverview = {
    runtimeAuthority: options.legacy ? "legacy" : "canonical",
    business: { scopeKey: "business", revision: "1", value: { policyMode: "fixed_units", fixedUnits: 0 }, updatedAt: AT, updatedBy: "operator-1", hasUnappliedChange: false },
    exceptions: [{ scopeKey: "network:variant:102", revision: "4", value: { policyMode: "fixed_units", fixedUnits: 10 }, updatedAt: AT, updatedBy: "operator-1",
      hasUnappliedChange: false, productId: 10, productName: "Card Shell", productVariantId: 102, sku: "CARD-EA", variantName: "Single",
      unitsPerVariant: 1, warehouseId: null, warehouseCode: null }],
  };
  const state = { overview, sets: [] as Array<Record<string, any>>, unexpected: [] as string[], errors: [] as string[], nextPolicyId: 60, loseNextResponse: false };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (path === "/api/auth/me") return route.fulfill({ json: staffAuthorityFixture({ user: { id: "operator-1", username: "operator", role: "operator" },
      permissions: options.permissions ?? ["inventory_planning:view", "inventory_planning:edit", "inventory_planning:activate"],
      systemRoles: [], assignedRoles: [{ id: 101, name: "operator", isSystem: false }] }) });
    if (path === VIEW && method === "GET") return route.fulfill({ json: view({ runtimeAuthority: options.legacy ? "legacy" : "canonical" }) });
    if (path === "/api/sync/status") return route.fulfill({ json: { global: { globalEnabled: true, sweepIntervalMinutes: 15, revision: "1",
      changedBy: "operator-1", changeReason: "Approved", lastSweepAt: null } } });
    if (path === `${SAFETY}/overview` && method === "GET") return route.fulfill({ json: state.overview });
    if (path === `${SAFETY}/set` && method === "POST") {
      const body = request.postDataJSON();
      state.sets.push(body);
      if (options.refuse) return route.fulfill({ status: 409, json: { error: { code: "DEFINITION_REVIEW_BLOCKED",
        message: "Not saved, nothing changed. CARD-P5 / MAIN: stock cannot be calculated." } } });
      // A reduced stand-in for the server: the setting takes effect and its revision moves on.
      const scopeKey = body.scope.scopeType === "business" ? "business" : `network:variant:${body.scope.productVariantId}`;
      const applied = { scopeKey, revision: String(Number(body.expectedHeadRevision ?? "0") + 2), value: body.value, updatedAt: AT,
        updatedBy: "operator-1", hasUnappliedChange: false };
      if (scopeKey === "business") state.overview = { ...state.overview, business: applied };
      else {
        const variantId = body.scope.productVariantId as number;
        state.overview = { ...state.overview, exceptions: [...state.overview.exceptions.filter(row => row.scopeKey !== scopeKey),
          { ...applied, productId: 10, productName: "Card Shell", productVariantId: variantId, sku: variantId === 101 ? "CARD-P5" : "CARD-EA",
            variantName: variantId === 101 ? "Pack of 5" : "Single", unitsPerVariant: variantId === 101 ? 5 : 1, warehouseId: null, warehouseCode: null }] };
      }
      if (state.loseNextResponse) { state.loseNextResponse = false; return route.abort("failed"); }
      return route.fulfill({ json: { receipt: receipt(scopeKey, state.nextPolicyId += 1), affectedProducts: 1, changedRows: 1,
        changes: [{ sku: "CARD-P5", warehouseName: "MAIN", current: "40", proposed: "35" }], skippedDestinations: [] } });
    }
    state.unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 500, json: { error: { code: "UNEXPECTED_TEST_REQUEST", message: "Unexpected request" } } });
  });
  await page.route("**/__channel-inventory-workspace-test*", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
    </head><body><main id="root"></main><script type="module" src="/@fs/${resolve("test/browser/fixtures/channel-inventory-workspace-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto("/__channel-inventory-workspace-test?view=available-stock");
  if (!options.legacy) await expect(page.getByRole("region", { name: "Available stock" })).toBeVisible();
  return state;
}

test("shows the default and each SKU exception, and opens from the rail", async ({ page }, testInfo) => {
  const state = await setup(page);
  const panel = page.getByRole("region", { name: "Available stock" });
  await expect(panel.getByLabel("Units to hold back")).toHaveValue("0");
  await expect(panel).toContainText("units of each SKU, in each warehouse");
  const row = page.getByTestId("hold-back-row-network:variant:102");
  await expect(row).toContainText("CARD-EA");
  await expect(row).toContainText("Card Shell");
  await expect(row).toContainText("10");
  await expect(page.getByRole("button", { name: /Available stock/ })).toHaveAttribute("aria-current", "page");
  // Nothing to save until the number changes.
  await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  expect(state.sets).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("available-stock.png"), fullPage: true });
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("saving the default takes effect in one step and says what moved", async ({ page }) => {
  const state = await setup(page);
  const panel = page.getByRole("region", { name: "Available stock" });
  await panel.getByLabel("Units to hold back").fill("5");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("hold-back-result")).toHaveText("Every SKU: Saved. Available stock changed: CARD-P5 at MAIN 40 → 35.");
  expect(state.sets).toHaveLength(1);
  expect(state.sets[0]).toMatchObject({ scope: { scopeType: "business" }, value: { policyMode: "fixed_units", fixedUnits: 5 },
    expectedHeadRevision: "1", changeReason: null });
  expect(state.sets[0].idempotencyKey).toEqual(expect.any(String));
  await expect(panel.getByLabel("Units to hold back")).toHaveValue("5");
  expect(state.unexpected).toEqual([]);
});

test("a number that is not a whole number is refused before anything is sent", async ({ page }) => {
  const state = await setup(page);
  const panel = page.getByRole("region", { name: "Available stock" });
  await panel.getByLabel("Units to hold back").fill("2.5");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByRole("alert")).toHaveText("Enter a whole number, 0 or more.");
  await panel.getByLabel("Units to hold back").fill("");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByRole("alert")).toHaveText("Enter a number, 0 or more.");
  expect(state.sets).toEqual([]);
});

test("a refused save says so and leaves the number as it was", async ({ page }) => {
  const state = await setup(page, { refuse: true });
  const panel = page.getByRole("region", { name: "Available stock" });
  await panel.getByLabel("Units to hold back").fill("5");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("hold-back-result")).toHaveText("Every SKU: Not saved. Not saved, nothing changed. CARD-P5 / MAIN: stock cannot be calculated.");
  expect(state.sets).toHaveLength(1);
  await expect(page.getByTestId("hold-back-row-network:variant:102")).toContainText("10");
});

test("a lost response is reported as unknown, and the screen reloads what is actually in effect", async ({ page }) => {
  const state = await setup(page);
  state.loseNextResponse = true;
  const panel = page.getByRole("region", { name: "Available stock" });
  await panel.getByLabel("Units to hold back").fill("5");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("hold-back-result")).toContainText("The outcome is unknown.");
  expect(state.sets).toHaveLength(1);
  // The save had landed; the reload shows it, so there is nothing left to send twice.
  await expect(panel.getByLabel("Units to hold back")).toHaveValue("5");
  await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
});

test("adds a SKU exception, edits it and removes it", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Add exception" }).click();
  const add = page.getByRole("dialog", { name: "Add a SKU exception" });
  await add.getByRole("combobox", { name: "Product" }).click();
  await page.getByRole("option", { name: /Card Shell/ }).click();
  await add.getByRole("combobox", { name: "SKU" }).click();
  await page.getByRole("option", { name: /CARD-P5/ }).click();
  await add.getByLabel("Units to hold back").fill("25");
  await add.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("hold-back-result")).toContainText("CARD-P5: Saved.");
  // A SKU with no setting yet has no revision to fence on.
  expect(state.sets[0]).toMatchObject({ scope: { scopeType: "network_variant", productVariantId: 101 },
    value: { policyMode: "fixed_units", fixedUnits: 25 }, expectedHeadRevision: null });
  const row = page.getByTestId("hold-back-row-network:variant:101");
  await expect(row).toContainText("25");

  await row.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Hold back for CARD-P5" });
  await expect(edit.getByLabel("Units to hold back")).toHaveValue("25");
  await expect(edit.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await edit.getByLabel("Units to hold back").fill("30");
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await expect(row).toContainText("30");
  expect(state.sets[1]).toMatchObject({ value: { policyMode: "fixed_units", fixedUnits: 30 }, expectedHeadRevision: "2" });

  await row.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("dialog", { name: "Hold back for CARD-P5" }).getByRole("button", { name: "Remove exception" }).click();
  await expect(page.getByTestId("hold-back-row-network:variant:101")).toHaveCount(0);
  expect(state.sets[2]).toMatchObject({ scope: { scopeType: "network_variant", productVariantId: 101 }, value: { policyMode: "inherit" }, expectedHeadRevision: "4" });
  // The other exception is untouched throughout.
  await expect(page.getByTestId("hold-back-row-network:variant:102")).toContainText("10");
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("view-only staff see the numbers but cannot change them", async ({ page }) => {
  await setup(page, { permissions: ["inventory_planning:view"] });
  const panel = page.getByRole("region", { name: "Available stock" });
  await expect(panel.getByLabel("Units to hold back")).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add exception" })).toHaveCount(0);
  await expect(page.getByTestId("hold-back-row-network:variant:102").getByRole("button")).toHaveCount(0);
  await expect(panel).toContainText("Changing held-back stock needs inventory planning edit and activate permission.");
});

test("before cutover the screen explains itself instead of offering a setting that does nothing", async ({ page }) => {
  const state = await setup(page, { legacy: true });
  await expect(page.getByText("Held-back stock applies after inventory cutover.")).toBeVisible();
  await expect(page.getByLabel("Units to hold back")).toHaveCount(0);
  expect(state.sets).toEqual([]);
});
