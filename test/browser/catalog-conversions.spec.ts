import { test, expect, type Page } from "playwright/test";
import { resolve } from "node:path";
import type { ProductInventoryStrategy } from "../../shared/catalog/inventory-strategy";
import type { SupplyTransformationsAdminView, TransformationAdminModel } from "../../shared/types/inventory-availability-admin";

function viewFixture(strategy: ProductInventoryStrategy): SupplyTransformationsAdminView {
  const draft: TransformationAdminModel = {
    id: 61, productId: 17, version: 2, lifecycleStatus: "draft", buildToPromiseEnabled: false,
    definitionHash: "a".repeat(64), origin: "operator", originInputHash: null, originResultHash: null,
    validationState: "valid", validationErrors: [], changeReason: "Fixture", createdBy: "operator",
    createdAt: "2026-09-18T12:00:00.000Z", updatedAt: "2026-09-18T12:00:00.000Z", bindings: [],
    paths: strategy === "physical_only" ? [] : [{
      sourceVariantId: 3, destinationVariantId: 1, sourceUnitsPerVariant: 800, destinationUnitsPerVariant: 1,
      inputQty: 1, outputQty: 800, operationType: "break_pack", authorityState: "allowed", transformationRecipeBindingKey: null,
    }],
  };
  return {
    product: { id: 17, sku: "SLEEVE", name: "Sleeves", isActive: true, legacyInventoryStrategy: strategy },
    variants: [{ id: 1, sku: "EA", unitsPerVariant: 1 }, { id: 2, sku: "P20", unitsPerVariant: 20 }, { id: 3, sku: "C800", unitsPerVariant: 800 }]
      .map(v => ({ ...v, productId: 17, name: v.sku, uomType: "pack", isActive: true })),
    recipes: [], head: { revision: "4", activeModelId: null, draftModelId: 61 }, activeModel: null, draftModel: draft,
    runtimeSelection: { authority: "legacy", revision: "1", activationRunId: null },
    runtimeAuthority: { kind: "legacy_inventory_strategy", value: strategy, draftAffectsRuntime: false },
  };
}

async function setup(page: Page, options: { strategy?: ProductInventoryStrategy; permission?: "none" | "view" | "edit" | "activate"; empty?: boolean } = {}) {
  const strategy = options.strategy ?? "physical_fungible";
  const state = { view: viewFixture(strategy), reads: 0, writes: [] as Array<{ method: string; body: Record<string, unknown> }>,
    errors: [] as string[], failure: 0 };
  if (options.empty) { state.view.draftModel = null; state.view.head = null; }
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: {
      user: { id: "operator", username: "operator", role: "admin" },
      permissions: options.permission === "none" ? [] : options.permission === "view"
        ? ["inventory_planning:view"] : ["inventory_planning:view", "inventory_planning:edit", ...(options.permission === "activate" ? ["inventory_planning:activate"] : [])], roles: [],
    } });
    if (path === "/api/inventory/build-relationships/products/17") return route.fulfill({ json: [] });
    if (path === "/api/inventory-planning/admin/product-definitions/17/progress") return route.fulfill({ json: null });
    if (path === "/api/inventory-planning/admin/supply-transformations/17" && request.method() === "GET") {
      state.reads++; return route.fulfill({ json: state.view });
    }
    if (path.startsWith("/api/inventory-planning/admin/supply-transformations/17/drafts") && ["PUT", "POST"].includes(request.method())) {
      const body = request.postDataJSON(); state.writes.push({ method: request.method(), body });
      if (state.failure) return route.fulfill({ status: state.failure, json: { message: "Test save failure" } });
      const existing = state.view.draftModel ?? viewFixture(strategy).draftModel!;
      state.view.draftModel = { ...existing, id: existing.id + 1, version: existing.version + 1,
        paths: body.paths.map((path: { sourceVariantId: number; destinationVariantId: number }) => ({ ...path,
          sourceUnitsPerVariant: state.view.variants.find(v => v.id === path.sourceVariantId)!.unitsPerVariant,
          destinationUnitsPerVariant: state.view.variants.find(v => v.id === path.destinationVariantId)!.unitsPerVariant,
        })), definitionHash: "b".repeat(64) };
      state.view.head = { revision: "5", activeModelId: null, draftModelId: state.view.draftModel.id };
      return route.fulfill({ json: { modelId: state.view.draftModel.id, version: state.view.draftModel.version,
        definitionHash: state.view.draftModel.definitionHash, alreadyApplied: false } });
    }
    state.errors.push(`Unexpected request ${request.method()} ${path}`);
    return route.fulfill({ status: 404, json: { message: "Unexpected test request" } });
  });
  await page.route("**/__catalog-conversion-test*", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><main id="root" style="max-width:1000px;margin:20px auto;padding:12px"></main><script type="module" src="/@fs/${resolve("test/browser/fixtures/catalog-conversion-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  const authentication = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/me");
  await page.goto(`/__catalog-conversion-test?strategy=${strategy}`);
  await authentication;
  return state;
}

async function setupSafety(page: Page, permissions: string[]) {
  const policy = { policyId: 61, version: 2, lifecycleStatus: "draft", scope: { scopeType: "business" },
    value: { policyMode: "fixed_units", fixedUnits: 5 }, definitionHash: "a".repeat(64), changeReason: "Fixture",
    createdBy: "operator", createdAt: "2026-09-18T12:00:00.000Z", updatedAt: "2026-09-18T12:00:00.000Z" };
  const head = { scopeKey: "business", revision: "4", activePolicy: { ...policy, policyId: 60, version: 1, lifecycleStatus: "sealed", value: { policyMode: "off" } }, draftPolicy: policy as typeof policy | null };
  const state = { head, errors: [] as string[], applies: [] as unknown[], applyFailure: 500, reads: 0, receipt: null as unknown };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "operator", username: "operator", role: "admin" }, permissions, roles: [] } });
    if (path === "/api/inventory-planning/admin/promise-safety/17") {
      state.reads++;
      return route.fulfill({ json: { product: { id: 17, sku: "P20", name: "Sleeves" },
        variants: [], warehouses: [], policyHeads: [head], demandEvidence: [], demandMethod: { methodVersion: "irreversible_consumption_v1_28d",
          observationDays: 28, minimumObservedDays: 14, minimumSourceEvents: 2, minimumActiveDays: 2, minimumConsumptionUnits: 3, recencyDays: 14, maximumEvidenceAgeHours: 36 } } });
    }
    if (path === "/api/inventory-planning/admin/safety-definitions/progress") return route.fulfill({ json: state.receipt ? { receipt: state.receipt, publications: [] } : null });
    if (path === "/api/inventory-planning/admin/safety-definitions/review") return route.fulfill({ json: {
      selection: { scopeKey: "business", draftPolicyId: 61, expectedHeadRevision: "4", expectedDefinitionHash: "a".repeat(64) },
      reviewHash: "c".repeat(64), ready: true, authorityRevision: "2", activationRunId: "1", affectedProductIds: [17,18], blockers: [],
      previousPolicy: { id: 60, definitionHash: "b".repeat(64), value: { policyMode: "off" } }, proposedPolicy: policy.value,
      atp: [{ productId: 17, variantId: 2, sku: "P20", warehouseId: 1, warehouseName: "MAIN", current: "50", proposed: "45" },
        { productId: 18, variantId: 3, sku: "OTHER", warehouseId: 1, warehouseName: "MAIN", current: "20", proposed: "15" }], channels: [],
    } });
    if (path === "/api/inventory-planning/admin/safety-definitions/apply") {
      state.applies.push(route.request().postDataJSON());
      if (state.applyFailure) { const status = state.applyFailure; state.applyFailure = 0; return route.fulfill({ status, json: { error: { message: "Review changed; review again." } } }); }
      state.receipt = { scopeKey: "business", policyId: 61, appliedAt: "2026-09-18T12:00:00.000Z", appliedBy: "operator", reviewHash: "c".repeat(64), publicationIds: [], alreadyApplied: true };
      head.draftPolicy = null;
      return route.fulfill({ json: state.receipt });
    }
    state.errors.push(`Unexpected ${path}`); return route.fulfill({ status: 404, json: {} });
  });
  await page.route("**/__catalog-conversion-test*", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" /><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><main id="root" style="max-width:1000px;margin:20px auto;padding:12px"></main><script type="module" src="/@fs/${resolve("test/browser/fixtures/catalog-conversion-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto("/__catalog-conversion-test?safety=1");
  return state;
}

test.describe("Procurement safety controls", () => {
  test("reviews business-wide impact and retries the identical Apply after uncertainty", async ({ page }, testInfo) => {
    const state = await setupSafety(page, ["inventory_planning:view", "inventory_planning:edit", "inventory_planning:activate"]);
    await page.getByRole("button", { name: "Review safety draft" }).click();
    await expect(page.getByText(/Business-wide review: 2 products/)).toBeVisible();
    await expect(page.getByRole("table").filter({ hasText: "Warehouse ATP" })).toContainText("OTHER");
    await page.getByRole("region", { name: "Review and apply safety policy" }).screenshot({ path: testInfo.outputPath("safety-review.png") });
    await page.getByRole("button", { name: "Apply reviewed safety policy" }).click();
    await expect(page.getByRole("alert")).toContainText("Apply outcome is unknown");
    await expect(page.getByLabel("Policy scope", { exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Retry same safety Apply" }).click();
    await expect(page.getByText("Safety policy applied", { exact: true })).toBeVisible();
    expect(state.applies).toHaveLength(2); expect(state.applies[1]).toEqual(state.applies[0]); expect(state.errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
  test("view-only users can review but cannot apply or edit Inventory's safety summary", async ({ page }) => {
    const state = await setupSafety(page, ["inventory_planning:view"]);
    await page.getByRole("button", { name: "Review safety draft" }).click();
    await expect(page.getByText("Your role can review but cannot apply safety policy.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Apply reviewed safety policy" })).toHaveCount(0);
    await expect(page.getByText("Promise safety stock", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Edit in Procurement" })).toHaveAttribute("href", "/settings/procurement/promise-safety?productId=17");
    expect(state.applies).toEqual([]); expect(state.errors).toEqual([]);
  });
  test("no planning permission makes no safety request", async ({ page }) => {
    const state = await setupSafety(page, []);
    await expect(page.getByText("Inventory planning view permission is required to view ATP promise safety.")).toBeVisible();
    expect(state.reads).toBe(0); expect(state.errors).toEqual([]);
  });
  test("stale Apply is rejected and requires a fresh review", async ({ page }) => {
    const state = await setupSafety(page, ["inventory_planning:view", "inventory_planning:activate"]); state.applyFailure = 409;
    await page.getByRole("button", { name: "Review safety draft" }).click();
    await page.getByRole("button", { name: "Apply reviewed safety policy" }).click();
    await expect(page.getByRole("alert")).toContainText("Review changed");
    await expect(page.getByRole("button", { name: "Apply reviewed safety policy" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Review safety draft" })).toBeEnabled();
    expect(state.applies).toHaveLength(1); expect(state.errors).toEqual([]);
  });
});

test.describe("catalog conversion controls", () => {
  test("reviews warehouse and channel quantities, then retries an uncertain Apply with the identical command", async ({ page }) => {
    const state = await setup(page, { permission: "activate" });
    const commands: unknown[] = [];
    await page.route("**/api/inventory-planning/admin/product-definitions/review", route => route.fulfill({ json: {
      selection: { productId: 17, draftModelId: 61, expectedHeadRevision: "4", expectedDefinitionHash: "a".repeat(64) },
      reviewHash: "c".repeat(64), ready: true, authorityRevision: "2", activationRunId: "1",
      previousModel: null, affectedProductIds: [17], blockers: [],
      atp: [{ productId: 17, variantId: 2, sku: "P20", warehouseId: 1, warehouseName: "MAIN", current: "10", proposed: "50" }],
      channels: [{ productId: 17, targetId: 1, channelName: "Shopify", variantId: 2, sku: "P20", current: "10", proposed: "50" }],
    } }));
    await page.route("**/api/inventory-planning/admin/product-definitions/apply", async route => {
      commands.push(route.request().postDataJSON());
      if (commands.length === 1) return route.fulfill({ status: 500, json: { message: "Connection lost" } });
      const receipt = { productId: 17, modelId: 61, appliedAt: "2026-09-18T12:00:00.000Z", appliedBy: "operator", reviewHash: "c".repeat(64), publicationIds: [], alreadyApplied: true };
      state.view.activeModel = { ...state.view.draftModel!, lifecycleStatus: "sealed" };
      state.view.draftModel = null;
      state.view.head = { revision: "5", activeModelId: 61, draftModelId: null };
      await page.route("**/api/inventory-planning/admin/product-definitions/17/progress", progress => progress.fulfill({ json: { receipt, publications: [] } }));
      return route.fulfill({ json: receipt });
    });
    await page.getByRole("button", { name: "Review draft changes" }).click();
    await expect(page.getByRole("table").filter({ hasText: "Warehouse ATP" })).toContainText("MAIN");
    await page.getByText("Channel quantities (1)", { exact: true }).click();
    await expect(page.getByText("Shopify · P20: 10 → 50", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Apply reviewed changes" }).click();
    await expect(page.getByRole("alert")).toContainText("Apply outcome is unknown");
    await expect(page.getByRole("button", { name: "Continue editing draft" })).toBeDisabled();
    await page.getByRole("button", { name: "Retry same Apply" }).click();
    await expect(page.getByText("Rules applied", { exact: true })).toBeVisible();
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(state.errors).toEqual([]);
  });

  test("saves an explicit reversible pair and preserves nonadjacent paths", async ({ page }, testInfo) => {
    const state = await setup(page);
    const pair = page.getByRole("region", { name: "Conversion P20 to C800", exact: true });
    await expect(pair).toContainText("40 P20 = 1 C800");
    await page.getByRole("button", { name: "Continue editing draft" }).click();
    await pair.getByLabel("Reversible", { exact: true }).check();
    await page.getByTestId("product-conversion-card").screenshot({ path: testInfo.outputPath("package-directions.png") });
    await expect(page.getByLabel(/reason/i)).toHaveCount(0);
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Draft v3 saved");
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({ method: "PUT", body: { expectedVersion: 2, expectedHeadRevision: "4",
      expectedDefinitionHash: "a".repeat(64), buildToPromiseEnabled: false, recipeBindings: [],
      paths: [expect.objectContaining({ sourceVariantId: 3, destinationVariantId: 1 }),
        expect.objectContaining({ sourceVariantId: 2, destinationVariantId: 3, inputQty: 40, outputQty: 1, operationType: "assemble_pack" }),
        expect.objectContaining({ sourceVariantId: 3, destinationVariantId: 2, inputQty: 1, outputQty: 40, operationType: "break_pack" })] } });
    expect(state.errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test("starts a new model as a draft only", async ({ page }) => {
    const state = await setup(page, { empty: true });
    await page.getByRole("button", { name: "Edit directions" }).click();
    await page.getByRole("region", { name: "Conversion EA to P20", exact: true }).getByLabel("Break down", { exact: true }).check();
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Live conversion rules and inventory are unchanged");
    expect(state.writes[0]).toMatchObject({ method: "POST", body: { productId: 17, paths: [
      expect.objectContaining({ sourceVariantId: 2, destinationVariantId: 1, inputQty: 1, outputQty: 20 }),
    ] } });
    expect(state.errors).toEqual([]);
  });

  test("issues no planning request without view permission", async ({ page }) => {
    const state = await setup(page, { permission: "none" });
    await expect(page.getByText("Inventory planning view permission is required to see conversion rules.").first()).toBeVisible();
    expect(state.reads).toBe(0); expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
  });

  test("read-only permission shows directions but no editing", async ({ page }) => {
    const state = await setup(page, { permission: "view" });
    await expect(page.getByText("View only.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit directions" })).toHaveCount(0);
    await expect(page.getByRole("radio")).toHaveCount(0);
    expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
  });

  test("keeps edit tokens captured before a background refresh", async ({ page }) => {
    const state = await setup(page);
    await page.getByRole("button", { name: "Continue editing draft" }).click();
    state.view = { ...state.view, head: { ...state.view.head!, revision: "8" },
      draftModel: { ...state.view.draftModel!, version: 9, definitionHash: "c".repeat(64) } };
    const oldReads = state.reads;
    await page.getByRole("button", { name: "Refresh test data" }).click();
    await expect.poll(() => state.reads).toBeGreaterThan(oldReads);
    await page.getByRole("region", { name: "Conversion EA to P20", exact: true }).getByLabel("Build up", { exact: true }).check();
    state.failure = 409;
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Reload and review");
    expect(state.writes[0].body).toMatchObject({ expectedVersion: 2, expectedHeadRevision: "4", expectedDefinitionHash: "a".repeat(64) });
    await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Reload and review" }).click();
    await expect(page.getByTestId("product-conversion-card")).toContainText("Draft v9");
  });

  test("retries an uncertain save with the identical request and idempotency key", async ({ page }) => {
    const state = await setup(page);
    await page.getByRole("button", { name: "Continue editing draft" }).click();
    await page.getByRole("region", { name: "Conversion EA to P20", exact: true }).getByLabel("Build up", { exact: true }).check();
    state.failure = 503;
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("save outcome is unknown");
    await expect(page.getByRole("radio").first()).toBeDisabled();
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    state.failure = 0;
    await page.getByRole("button", { name: "Retry same save", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Draft v3 saved");
    expect(state.writes).toHaveLength(2); expect(state.writes[0]).toEqual(state.writes[1]);
    expect(state.errors).toEqual([]);
  });

  test("physical-only products have no package editor", async ({ page }) => {
    const state = await setup(page, { strategy: "physical_only" });
    await expect(page.getByRole("heading", { name: "Product variants" })).toBeVisible();
    await expect(page.getByTestId("product-conversion-card")).toHaveCount(0);
    await expect(page.getByRole("radio")).toHaveCount(0); expect(state.errors).toEqual([]);
  });

  test("shows active directions until the operator explicitly opens the draft", async ({ page }) => {
    const state = await setup(page);
    state.view.activeModel = { ...state.view.draftModel!, id: 60, version: 1, lifecycleStatus: "sealed",
      paths: [{ sourceVariantId: 2, destinationVariantId: 1, sourceUnitsPerVariant: 20, destinationUnitsPerVariant: 1,
        inputQty: 1, outputQty: 20, operationType: "break_pack", authorityState: "allowed", transformationRecipeBindingKey: null }] };
    state.view.head!.activeModelId = 60;
    state.view.runtimeSelection = { authority: "canonical", revision: "2", activationRunId: "1" };
    await page.getByRole("button", { name: "Refresh test data" }).click();
    const card = page.getByTestId("product-conversion-card");
    await expect(card).toContainText("Active rules · v1");
    await expect(card).toContainText("Draft changes available");
    const pair = page.getByRole("region", { name: "Conversion EA to P20", exact: true });
    await expect(pair.getByLabel("Break down", { exact: true })).toBeChecked();
    await page.getByRole("button", { name: "Continue editing draft" }).click();
    await expect(card).toContainText("Your changes — not live");
    await expect(card.getByText("Validated", { exact: true })).toHaveCount(0);
    await expect(pair.getByLabel("None", { exact: true })).toBeChecked();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(card).toContainText("Active rules · v1");
    await expect(pair.getByLabel("Break down", { exact: true })).toBeChecked();
    expect(state.writes).toEqual([]);
    expect(state.errors).toEqual([]);
  });

  test("recipe-managed products retain build relationships", async ({ page }) => {
    const state = await setup(page, { strategy: "recipe_managed" });
    await expect(page.getByText("Build Relationships", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open Builds" })).toHaveAttribute("href", "/inventory/builds?tab=recipes");
    await expect(page.getByRole("radio")).toHaveCount(0); expect(state.errors).toEqual([]);
  });
});
