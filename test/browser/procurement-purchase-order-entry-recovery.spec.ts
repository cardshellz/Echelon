import { expect, test, type Page } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";
import { purchaseEntryFixture, purchasingAuthFixture } from "./procurement-purchase-order-entry-fixtures";
import { canonicalJson } from "../../shared/utils/canonical-json";

type Action = "create" | "save-draft" | "prepare";
type Mode = "success" | "lost" | "malformed" | "rejected" | "legacy" | "delayed" | "readback";
const STORAGE = "echelon:purchase-order-entry:v1:test-user";
const REVIEWED = "2026-10-24T12:00:00.000Z";
const SAVED = "2026-10-24T12:01:00.000Z";
const vendor = { id: 2, code: "TEST", name: "Test vendor", country: "US", isActive: 1 };
const fee = { id: 9, purchaseOrderId: 17, lineNumber: 1, lineType: "fee", status: "open", description: "Supplier handling fee", orderQty: 1, unitCostMills: 100000, unitCostCents: 1000, totalProductCostCents: 1000, packagingCostCents: 0, parentLineId: null };
const save = (page: Page) => page.getByRole("button", { name: "Save draft", exact: true }).filter({ visible: true }).first();
const notice = (page: Page) => page.getByRole("alert", { name: "Purchase order recovery" });
const recover = (page: Page) => page.getByRole("button", { name: "Recover saved purchase request", exact: true });
const description = (page: Page) => page.getByTestId("input-line-description-0").filter({ visible: true });
async function setup(page: Page, action: Action, mode: Mode) {
  const failures = await installFixtures(page);
  const commands: Array<{ path: string; method: string; key?: string; body: Record<string, unknown> }> = [];
  const state = { actor: "test-user", allowed: true, readFailure: false, committed: false, offline: false };
  const purchase = { ...po(17), vendor, source: "manual", status: "draft", physicalStatus: "draft", updatedAt: REVIEWED, lineCount: 1, lines: [{ ...fee }] };
  let release!: () => void; const gate = new Promise<void>(done => { release = done; });
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { ...purchasingAuthFixture, user: { ...purchasingAuthFixture.user, id: state.actor }, permissions: state.allowed ? purchasingAuthFixture.permissions : ["purchasing:view"] } });
    if (request.method() === "GET") {
      if (path === "/api/settings/procurement") return route.fulfill({ json: { useNewPoEditor: action !== "prepare" } });
      if (path === "/api/vendors") return route.fulfill({ json: [vendor] });
      if (path === "/api/purchase-orders/new-preload") return route.fulfill({ json: { vendor, lines: [] } });
      if (/^\/api\/purchase-orders\/(17|71|99)$/.test(path)) {
        const id = Number(path.split("/").at(-1));
        return route.fulfill(state.readFailure ? { status: 503, json: { error: "Current purchase unavailable" } } : { json: { ...purchase, id, status: id === 99 ? "approved" : purchase.status, poNumber: `TEST-PO-${id}`, lines: purchase.lines.map(line => ({ ...line, purchaseOrderId: id })) } });
      }
      if (/^\/api\/purchase-orders\/(17|71|99)\/workspace$/.test(path)) return route.fulfill({ json: {
        purchase: { ...purchase, id: Number(path.split("/")[3]), currency: "USD", vendorName: vendor.name, invoicedTotalCents: 0, paidTotalCents: 0, outstandingCents: 0, expectedDeliveryDate: null, confirmedDeliveryDate: null, actualDeliveryDate: null }, shipments: [], receipts: [], invoices: [], edges: [], limitations: [],
      } });
    }
    const expectedPath = action === "create" ? "/api/purchase-orders" : `/api/purchase-orders/17/${action === "save-draft" ? "draft" : "send-to-vendor"}`;
    if (path !== expectedPath || request.method() === "GET") return route.fallback();
    const body = request.postDataJSON(), key = request.headers()["idempotency-key"];
    commands.push({ path, method: request.method(), key, body });
    if (state.offline) return route.abort("internetdisconnected");
    const command = { action, targetId: action === "create" ? null : 17, payload: body };
    if (mode === "legacy") return route.fulfill({ status: 409, json: { error: "The original legacy request needs review.", code: "PURCHASE_ORDER_ENTRY_LEGACY_REVIEW_REQUIRED" } });
    if (mode === "rejected" && commands.length === 1) return route.fulfill({ status: 409, json: { error: "The draft changed. Review current terms.", details: { purchaseOrderEntryOutcome: "rejected", action, targetId: command.targetId, actorId: state.actor, idempotencyKey: key, requestCanonical: canonicalJson(command) } } });
    state.committed = true;
    Object.assign(purchase, { updatedAt: SAVED, status: action === "prepare" ? "approved" : "draft" });
    if (Array.isArray(body.lines)) purchase.lines[0].description = String(body.lines[0].description);
    if (mode === "readback") state.readFailure = true;
    if (mode === "delayed") await gate;
    if (mode === "lost" && commands.length === 1) return route.abort("failed");
    const id = action === "create" ? 71 : 17;
    const current = { ...purchase, id, poNumber: `TEST-PO-${id}`, lines: purchase.lines.map(line => ({ ...line, purchaseOrderId: id })) };
    const response = purchaseEntryFixture(request, action, command.targetId, action === "prepare" ? current : { po: current }, state.actor);
    return route.fulfill({ json: mode === "malformed" && commands.length === 1 ? { ...response, entryCommand: { ...response.entryCommand, actorId: "wrong-operator" } } : response });
  });
  await page.goto(action === "create" ? "/purchase-orders/new?vendor_id=2" : action === "prepare" ? "/purchase-orders/17" : "/purchase-orders/17/edit");
  if (action === "create") {
    await page.getByRole("button", { name: "Add line of another type", exact: true }).click();
    await page.getByRole("menuitem", { name: "Fee", exact: true }).click();
    await description(page).fill("Supplier handling fee");
  } else if (action === "save-draft") await description(page).fill("Reviewed supplier handling fee");
  const submit = action === "prepare" ? page.getByRole("button", { name: "Prepare for supplier", exact: true }).first() : save(page);
  await expect(submit).toBeEnabled();
  return { failures, commands, state, submit, release };
}

for (const action of ["create", "save-draft", "prepare"] as const) for (const mode of ["lost", "malformed"] as const) {
  test(`${action}: ${mode} response survives reload and replays exact saved command`, async ({ page }) => {
    const { failures, commands, submit } = await setup(page, action, mode);
    await submit.click(); await expect(recover(page)).toBeEnabled();
    if (action !== "prepare") { await expect(description(page)).toBeDisabled(); await expect(save(page)).toBeDisabled(); }
    const original = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!), STORAGE);
    expect(original.key).toBe(commands[0].key); expect(original.body.payload).toEqual(commands[0].body);
    await page.reload(); await expect(recover(page)).toBeEnabled();
    await recover(page).click();
    await expect(page).toHaveURL(new RegExp(`/purchase-orders/${action === "create" ? 71 : 17}${action === "prepare" ? "" : "/edit"}(?:\\?|$)`));
    await expect(notice(page)).toHaveCount(0);
    expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]); expect(failures).toEqual([]);
  });
}

test("durable rejection releases the old draft intent for an intentional corrected save", async ({ page }) => {
  const { commands, failures, submit } = await setup(page, "save-draft", "rejected");
  await submit.click(); await expect(notice(page)).toContainText("draft changed");
  await expect(recover(page)).toHaveCount(0); await expect(description(page)).toBeEnabled();
  await description(page).fill("Corrected handling fee"); await submit.click();
  await expect(page.getByText("PO saved as draft", { exact: true })).toBeVisible();
  expect(commands).toHaveLength(2); expect(commands[1].key).not.toBe(commands[0].key);
  expect(commands[1].body.lines).toMatchObject([{ description: "Corrected handling fee" }]); expect(failures).toEqual([]);
});

test("old middleware key stays in explicit recovery after legacy-review conflict and reload", async ({ page }) => {
  const { commands, failures, submit } = await setup(page, "create", "legacy");
  await submit.click(); await expect(notice(page)).toContainText("legacy request needs review");
  await page.reload(); await recover(page).click();
  await expect(notice(page)).toContainText("legacy request needs review");
  expect(commands[1]).toEqual(commands[0]); await expect(save(page)).toBeDisabled(); expect(failures).toEqual([]);
});

test("confirmed draft save with failed readback blocks edits and reads current data without another command", async ({ page }) => {
  const { commands, state, submit, failures } = await setup(page, "save-draft", "readback");
  await submit.click(); await expect(page.getByRole("button", { name: "Reload confirmed purchase", exact: true })).toBeVisible();
  await expect(page.getByText("PO saved as draft", { exact: true })).toBeVisible(); await expect(description(page)).toBeDisabled();
  expect(await page.evaluate(key => sessionStorage.getItem(key), STORAGE)).toBeNull();
  await page.reload(); await expect(page.getByRole("button", { name: "Retry purchase load", exact: true })).toBeVisible();
  await expect(save(page)).toBeDisabled();
  state.readFailure = false;
  await page.getByRole("button", { name: "Retry purchase load", exact: true }).click();
  await expect(description(page)).toBeEnabled(); await expect(description(page)).toHaveValue("Reviewed supplier handling fee");
  expect(commands).toHaveLength(1); expect(failures).toEqual([]);
});

test("recovery remains visible on another purchase and targets only the original request", async ({ page }) => {
  const { commands, submit, failures } = await setup(page, "save-draft", "lost");
  await submit.click(); await expect(recover(page)).toBeEnabled();
  await page.goto("/purchase-orders/99"); await expect(notice(page)).toContainText("purchase #17");
  await recover(page).click(); await expect(page).toHaveURL(/\/purchase-orders\/17\/edit$/);
  expect(commands[1]).toEqual(commands[0]); expect(failures).toEqual([]);
});

test("late confirmed save does not navigate away from a newly selected purchase", async ({ page }) => {
  const { commands, submit, release, failures } = await setup(page, "create", "delayed");
  await submit.click(); await expect.poll(() => commands.length).toBe(1);
  await page.evaluate(() => { history.pushState(null, "", "/purchase-orders/99"); dispatchEvent(new PopStateEvent("popstate")); });
  await expect(page.getByRole("heading", { name: "TEST-PO-99", exact: true })).toBeVisible();
  const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/purchase-orders" && response.request().method() === "POST");
  release(); await (await response).finished();
  await expect(page).toHaveURL(/\/purchase-orders\/99(?:\?|$)/); await expect(page.getByText("PO saved as draft", { exact: true })).toHaveCount(0);
  expect(commands).toHaveLength(1); expect(failures).toEqual([]);
});

test("actor-scoped recovery cannot be submitted by a different operator", async ({ page }) => {
  const { commands, state, submit, failures } = await setup(page, "save-draft", "lost");
  await submit.click(); await expect(recover(page)).toBeEnabled();
  state.actor = "other-operator"; await page.reload(); await expect(recover(page)).toHaveCount(0);
  state.actor = "test-user"; await page.reload(); await recover(page).click(); await expect(notice(page)).toHaveCount(0);
  expect(commands[1]).toEqual(commands[0]); expect(failures).toEqual([]);
});

test("revoked permission keeps recovery but blocks dispatch until restored", async ({ page }) => {
  const { commands, state, submit, failures } = await setup(page, "save-draft", "lost");
  await submit.click(); await expect(recover(page)).toBeEnabled();
  state.allowed = false; await page.reload();
  await expect(page).toHaveURL(/\/picking$/);
  // Revocation removes editor access; the read-authorized detail still owns
  // recovery of the original request without granting mutation authority.
  await page.goto("/purchase-orders/17");
  await expect(recover(page)).toBeDisabled(); await expect(notice(page)).toContainText("purchasing permission");
  expect(commands).toHaveLength(1); state.allowed = true; await page.reload(); await recover(page).click();
  await expect(notice(page)).toHaveCount(0); expect(commands[1]).toEqual(commands[0]); expect(failures).toEqual([]);
});

test("storage write failure blocks a new purchase before any server call", async ({ page }) => {
  const { commands, submit, failures } = await setup(page, "create", "success");
  await page.evaluate(() => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.startsWith("echelon:purchase-order-entry:")) throw new Error("storage blocked"); original.call(this, key, value); }; });
  await submit.click(); await expect(notice(page)).toContainText("was not sent because recovery could not be saved");
  expect(commands).toHaveLength(0); expect(failures).toEqual([]);
});

test("duplicate preload still uses the full editor and a new recoverable create intent", async ({ page }) => {
  const { commands, failures } = await setup(page, "create", "success");
  await page.route("**/api/purchase-orders/new-preload?duplicate_from=17", route => route.fulfill({ json: { vendor, lines: [{ productId: 10, productVariantId: 20, productName: "Duplicated catalog product", sku: "DUP-EACH", suggestedQty: 3, expectedReceiveVariantId: 20, expectedReceiveUnitsPerVariant: 1, pricingBasis: "per_piece", quotedUnitCostMills: 10000, unitCostMills: 10000, unitCostCents: 100, catalogSource: "manual", quotedAt: null, quoteValidUntil: null }], sourcePo: { note: "Duplicate source loaded" } } }));
  await page.route("**/api/products/10", route => route.fulfill({ json: { id: 10, variants: [{ id: 20, sku: "DUP-EACH", name: "Each", unitsPerVariant: 1, isActive: true }] } }));
  await page.goto("/purchase-orders/new?duplicate_from=17");
  await expect(page.getByText("Duplicate source loaded", { exact: true })).toBeVisible();
  await expect(page.getByText("Duplicated catalog product", { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await save(page).click(); await expect(page).toHaveURL(/\/purchase-orders\/71\/edit$/);
  expect(commands).toHaveLength(1); expect(commands[0].path).toBe("/api/purchase-orders"); expect(commands[0].body.lines).toMatchObject([{ product_id: 10, expected_receive_variant_id: 20, quantity_ordered: 3 }]);
  expect(failures).toEqual([]);
});

for (const action of ["create", "save-draft", "prepare"] as const) test(`${action}: offline click saves intent immediately and reconnect never auto-submits`, async ({ page }) => {
  const { commands, state, submit, failures } = await setup(page, action, "success");
  state.offline = true; await page.context().setOffline(true);
  await submit.click(); await expect(recover(page)).toBeEnabled();
  const saved = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!), STORAGE);
  expect(saved.body.action).toBe(action); expect(state.committed).toBe(false);
  state.offline = false; await page.context().setOffline(false); await page.waitForLoadState("networkidle");
  expect(state.committed).toBe(false);
  await recover(page).click(); await expect(notice(page)).toHaveCount(0);
  expect(state.committed).toBe(true); expect(commands.at(-1)?.key).toBe(saved.key); expect(commands.at(-1)?.body).toEqual(saved.body.payload); expect(failures).toEqual([]);
});

test("tiered next-action submit does not acquire an unrelated create permission requirement", async ({ page }) => {
  const { failures, commands } = await setup(page, "prepare", "success");
  await page.route("**/api/auth/me", route => route.fulfill({ json: { ...purchasingAuthFixture, permissions: ["purchasing:view", "purchasing:edit"] } }));
  await page.route("**/api/purchasing/approval-tiers", route => route.fulfill({ json: { tiers: [{ id: 1, name: "Approval", minAmountCents: 0, isActive: true }] } }));
  await page.route("**/api/purchase-orders/17", route => route.fulfill({ json: { ...po(17), status: "draft", physicalStatus: "draft", updatedAt: REVIEWED,
    autoDraftActionPlan: { primaryAction: { id: "send_to_vendor", label: "Submit for approval", detail: "Submit reviewed terms.", severity: "info" }, checklist: [], context: { lineCount: 0, openExceptionCount: 0, availableLifecycleActionIds: ["send_to_vendor"] } } } }));
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(page.getByRole("region", { name: "Auto-draft next action", exact: true }).getByRole("button", { name: "Submit for approval", exact: true })).toBeEnabled();
  expect(commands).toHaveLength(0); expect(failures).toEqual([]);
});
