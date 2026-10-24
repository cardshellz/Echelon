import { expect, test, type Page } from "@playwright/test";
import { rfqCreateIntentSchema, type RfqCreateReceipt } from "../../shared/procurement/rfq-create-command";
import { rfqCreateIntent, rfqCreateReceipt } from "../fixtures/rfq-create-command";
import { setupPlanning } from "./procurement-planning-fixtures";

const storageKey = "echelon:rfq-workflow:v1";
async function saved(page: Page) { return page.evaluate(key => sessionStorage.getItem(key), storageKey); }
async function setup(page: Page) {
  const fixture = await setupPlanning(page, true);
  const item = fixture.analysis.items[0];
  const originalPieces = item.suggestedOrderPieces;
  const controls = { actorId: "test-user", canEdit: true, loseNext: false, malformedNext: false, holdNext: false,
    releaseResponse: null as (() => void) | null, status: 0, durable: false, demandUnavailable: false };
  const commands: Array<{ key: string; body: unknown; persisted: string | null }> = [];
  const receipts = new Map<string, RfqCreateReceipt>();
  await page.route("**/api/auth/me", route => route.fulfill({ json: { user: { id: controls.actorId, username: "test", role: "admin" }, permissions: controls.canEdit ? ["purchasing:view", "purchasing:edit"] : ["purchasing:view"], roles: ["admin"] } }));
  await page.route("**/api/purchasing/reorder-analysis", route => controls.demandUnavailable
    ? route.fulfill({ status: 503, json: { error: "Fictional demand unavailable" } }) : route.fulfill({ json: fixture.analysis }));
  await page.route("**/api/vendors", route => route.fulfill({ json: [{ id: 2, code: "TEST", name: "Test supplier", active: 1 }] }));
  await page.route("**/api/purchasing/recommendation-*-queue?*", route => route.fulfill({ json: { items: [], summary: { total: 0 } } }));
  await page.route("**/api/purchasing/recommendation-decisions?*", route => route.fulfill({ json: { items: [], summary: { total: 0 } } }));
  await page.route("**/api/purchasing/rfqs?*", route => route.fulfill({ json: { rfqs: [], count: 0, statusCounts: {}, limit: 25, page: { total: 0, limit: 25, offset: 0, nextOffset: null } } }));
  await page.route("**/api/purchasing/rfq-queue", async route => {
    const request = route.request();
    if (request.method() === "GET") {
      const allocated = receipts.size > 0;
      return route.fulfill({ json: { generatedAt: "2026-10-24T12:00:00Z", lookbackDays: 30,
        run: { id: 1, source: "manual", calculationVersion: "fixture", asOf: "2026-10-24T12:00:00Z" },
        summary: { total: 1, open: allocated ? 0 : 1, partiallyAllocated: 0, fullyAllocated: allocated ? 1 : 0, supplierAssignmentRequired: 0, activeRfqs: receipts.size, aboveRecommendation: 0, excessPieces: 0 },
        items: [{ recommendationId: item.recommendationId, recommendationLineId: 901, runId: 1, productId: 10, productVariantId: 100, warehouseId: 1, requiredByDate: null,
          sku: "PLAN-TEST", productName: "Fictional planning item", recommendedPieces: originalPieces, remainingPieces: allocated ? 0 : originalPieces,
          allocatedPieces: allocated ? originalPieces : 0, excessPieces: 0, sourcingStatus: allocated ? "fully_allocated" : "open", availablePieces: 20,
          onOrderPieces: 0, reorderPointPieces: 100, forecastMethod: "weighted_blend_v1", forecastDailyPieces: 2, leadTimeDays: 120, safetyStockDays: 10,
          forwardDemandPieces: 0, preferredVendorId: 2, preferredVendorName: "Test supplier", vendorId: 2, vendorProductId: 20, supplierAssignmentRequired: false, allocations: [] }],
      } });
    }
    const key = request.headers()["idempotency-key"];
    expect(request.headers()["x-rfq-receipt-version"]).toBe("1");
    const intent = rfqCreateIntentSchema.parse({ operation: "create_batch", rfqId: null, payload: request.postDataJSON() });
    commands.push({ key, body: request.postDataJSON(), persisted: await saved(page) });
    if (controls.status) return route.fulfill({ status: controls.status, json: { code: "RFQ_SELECTION_CHANGED", error: "Fictional RFQ selection conflict", ...(controls.durable ? { details: { rfqCommandOutcome: "rejected", actorId: controls.actorId, idempotencyKey: key, intent } } : {}) } });
    if (!receipts.has(key)) receipts.set(key, rfqCreateReceipt(intent, key, controls.actorId));
    if (controls.holdNext) { controls.holdNext = false; await new Promise<void>(resolve => { controls.releaseResponse = resolve; }); }
    if (controls.loseNext) { controls.loseNext = false; return route.abort("connectionreset"); }
    if (controls.malformedNext) { controls.malformedNext = false; return route.fulfill({ json: {} }); }
    return route.fulfill({ json: receipts.get(key) });
  });
  return { ...fixture, controls, commands, receipts };
}
async function compose(page: Page) {
  await page.goto("/reorder-analysis?chips=all");
  await page.getByRole("checkbox", { name: "Add PLAN-TEST to order", exact: true }).click();
  await page.getByRole("button", { name: "Open order builder", exact: true }).click();
  await page.getByRole("radio", { name: "Request quote", exact: true }).check();
  await page.getByRole("button", { name: /Continue → confirm 1 RFQ/ }).click();
  return page.getByRole("button", { name: /^Create 1 RFQ/ });
}
async function assertConfirmed(page: Page) {
  await expect(page.getByText("RFQ drafts confirmed:", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "RFQ-TEST-902", exact: true }).first()).toHaveAttribute("href", "/procurement/rfqs?rfqId=902");
  expect(await saved(page)).toBeNull();
}

for (const outcome of ["lost", "malformed"] as const) {
  for (const destination of ["/reorder-analysis?chips=all", "/procurement/rfqs", "/reorder-analysis/legacy"]) {
    test(`${outcome} initial response recovers unchanged after reservation consumes demand at ${destination}`, async ({ page }) => {
      const f = await setup(page); f.controls[outcome === "lost" ? "loseNext" : "malformedNext"] = true;
      await (await compose(page)).click();
      await expect.poll(() => f.commands.length).toBe(1);
      await expect(page.getByRole("button", { name: "Recover saved RFQ request", exact: true }).last()).toBeEnabled();
      const original = await saved(page); expect(original).not.toBeNull();
      expect(JSON.parse(f.commands[0].persisted!)).toMatchObject({ userId: "test-user", key: f.commands[0].key, body: { payload: f.commands[0].body } });
      // A committed RFQ consumes the queue requirement; retry must not rebuild it.
      f.analysis.items[0].suggestedOrderPieces = 0;
      f.analysis.items[0].suggestedOrderQty = 0;
      await page.goto(destination);
      await expect(page.getByText("The original supplier selections and quantities will be retried without recalculating demand.", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Recover saved RFQ request", exact: true }).click();
      await assertConfirmed(page);
      expect(f.commands).toHaveLength(2);
      expect(f.commands[1]).toEqual(f.commands[0]);
      expect(f.receipts.size).toBe(1); expect(f.failures).toEqual([]);
    });
  }
}

test("saved creation can recover while live demand is unavailable", async ({ page }) => {
  const f = await setup(page); f.controls.loseNext = true;
  await (await compose(page)).click();
  await expect.poll(() => f.commands.length).toBe(1);
  await expect(page.getByRole("button", { name: "Recover saved RFQ request" }).last()).toBeEnabled();
  f.controls.demandUnavailable = true; await page.reload();
  await page.getByRole("button", { name: "Recover saved RFQ request" }).click();
  await assertConfirmed(page); expect(f.commands[1]).toEqual(f.commands[0]); expect(f.failures).toEqual([]);
});

test("recovery in the original builder replaces the stale failure summary with the confirmed batch", async ({ page }) => {
  const f = await setup(page); f.controls.loseNext = true;
  await (await compose(page)).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Recover saved RFQ request" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Recover saved RFQ request" }).click();
  await expect(dialog.getByText("RFQ drafts confirmed:", { exact: false })).toBeVisible();
  await expect(dialog.getByText("1 RFQ draft created from 1 line.", { exact: false })).toBeVisible();
  await expect(dialog.getByText("The RFQ action may have completed", { exact: false })).toHaveCount(0);
  expect(await saved(page)).toBeNull(); expect(f.receipts.size).toBe(1); expect(f.failures).toEqual([]);
});

for (const fault of ["read", "save", "corrupt"] as const) {
  test(`${fault} recovery storage blocks initial dispatch`, async ({ page }) => {
    const f = await setup(page);
    await page.addInitScript(({ key, fault }) => {
      if (fault === "corrupt") { sessionStorage.setItem(key, "invalid saved RFQ"); return; }
      const method = fault === "read" ? "getItem" : "setItem";
      const original = Storage.prototype[method];
      Object.defineProperty(Storage.prototype, method, { configurable: true, value: function(name: string, value?: string) {
        if (name === key) throw new DOMException("Fictional blocked recovery storage", "QuotaExceededError");
        return method === "getItem" ? (original as Storage["getItem"]).call(this, name) : (original as Storage["setItem"]).call(this, name, value!);
      } });
    }, { key: storageKey, fault });
    if (fault === "save") {
      await (await compose(page)).click();
      await expect(page.getByText("The RFQ request was not sent because its recovery could not be saved.", { exact: true }).first()).toBeVisible();
    } else {
      await page.goto("/reorder-analysis?chips=all");
      await expect(page.getByRole("button", { name: "Check saved RFQ request", exact: true })).toBeVisible();
    }
    expect(f.commands).toHaveLength(0); expect(f.receipts.size).toBe(0); expect(f.failures).toEqual([]);
  });
}

for (const authority of ["revoked", "other operator"] as const) {
  test(`${authority} cannot dispatch or discard the saved initial batch`, async ({ page }) => {
    const f = await setup(page); f.controls.loseNext = true;
    await (await compose(page)).click();
    await expect(page.getByRole("button", { name: "Recover saved RFQ request" }).last()).toBeEnabled();
    const original = await saved(page);
    if (authority === "revoked") f.controls.canEdit = false; else f.controls.actorId = "another-operator";
    await page.reload();
    if (authority === "revoked") await expect(page.getByRole("button", { name: "Recover saved RFQ request" })).toBeDisabled();
    else await expect(page.getByText("The saved RFQ request belongs to another operator or cannot be verified. Recover it as the original operator before another RFQ action.", { exact: true })).toBeVisible();
    expect(f.commands).toHaveLength(1); expect(await saved(page)).toBe(original);
    f.controls.actorId = "test-user"; f.controls.canEdit = true; await page.reload();
    await page.getByRole("button", { name: "Recover saved RFQ request" }).click();
    await assertConfirmed(page); expect(f.commands[1]).toEqual(f.commands[0]); expect(f.failures).toEqual([]);
  });
}

test("unproven conflict retains original intent; matching durable rejection clears it", async ({ page }) => {
  const f = await setup(page); f.controls.status = 409;
  await (await compose(page)).click();
  await expect(page.getByRole("button", { name: "Recover saved RFQ request" }).last()).toBeEnabled();
  const original = await saved(page); expect(original).not.toBeNull();
  await page.reload(); await page.getByRole("button", { name: "Recover saved RFQ request" }).click();
  await expect.poll(() => f.commands.length).toBe(2); expect(await saved(page)).toBe(original);
  f.controls.durable = true;
  await expect(page.getByRole("button", { name: "Recover saved RFQ request" })).toBeEnabled();
  await page.getByRole("button", { name: "Recover saved RFQ request" }).click();
  await expect.poll(() => saved(page)).toBeNull();
  expect(f.commands.every(command => command.key === f.commands[0].key)).toBe(true);
  expect(f.receipts.size).toBe(0); expect(f.failures).toEqual([]);
});

test("legacy RFQ entry uses the same saved creation owner and recovers from the current cockpit", async ({ page }) => {
  const f = await setup(page); f.controls.loseNext = true;
  await page.goto("/reorder-analysis/legacy");
  const selection = page.getByText("Add to RFQ", { exact: true }).locator("..");
  await selection.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create RFQ drafts (1)", exact: true }).click();
  await page.getByRole("button", { name: "Create 1 RFQ draft", exact: true }).click();
  await expect(page.getByRole("button", { name: "Recover saved RFQ request" }).last()).toBeEnabled();
  expect(f.commands).toHaveLength(1); expect(JSON.parse(f.commands[0].persisted!).body.operation).toBe("create_batch");
  await page.goto("/reorder-analysis?chips=all");
  await page.getByRole("button", { name: "Recover saved RFQ request" }).click();
  await assertConfirmed(page); expect(f.commands[1]).toEqual(f.commands[0]); expect(f.failures).toEqual([]);
});

test("version-one saved initial intent remains recoverable without a new composition", async ({ page }) => {
  const f = await setup(page);
  await page.addInitScript(({ key, body }) => sessionStorage.setItem(key, JSON.stringify({ version: 1, userId: "test-user", key: "existing-rfq-key", body })), { key: storageKey, body: rfqCreateIntent });
  await page.goto("/procurement/rfqs");
  await page.getByRole("button", { name: "Recover saved RFQ request" }).click();
  await assertConfirmed(page); expect(f.commands).toHaveLength(1); expect(f.commands[0].key).toBe("existing-rfq-key"); expect(f.failures).toEqual([]);
});

for (const outcome of ["delayed success", "recovery"] as const) {
  test(`${outcome} preserves a removed and re-added selection with the same displayed values`, async ({ page }) => {
    const f = await setup(page);
    f.controls.holdNext = outcome === "delayed success"; f.controls.loseNext = outcome === "recovery";
    await (await compose(page)).click();
    if (outcome === "delayed success") await expect.poll(() => f.controls.releaseResponse !== null).toBe(true);
    else await expect(page.getByRole("button", { name: "Recover saved RFQ request" }).last()).toBeEnabled();
    await page.keyboard.press("Escape");
    const selection = page.getByRole("checkbox", { name: "Remove PLAN-TEST from order", exact: true });
    await expect(selection).toBeChecked(); await selection.uncheck();
    await page.getByRole("checkbox", { name: "Add PLAN-TEST to order", exact: true }).check();
    if (outcome === "delayed success") f.controls.releaseResponse!();
    else await page.getByRole("button", { name: "Recover saved RFQ request" }).click();
    await assertConfirmed(page); await expect(selection).toBeChecked();
    expect(f.commands).toHaveLength(outcome === "delayed success" ? 1 : 2);
    expect(f.receipts.size).toBe(1); expect(f.failures).toEqual([]);
  });
}

test("delayed success preserves quantity edits made after dispatch", async ({ page }) => {
  const f = await setup(page); f.controls.holdNext = true;
  await (await compose(page)).click();
  await expect.poll(() => f.controls.releaseResponse !== null).toBe(true);
  await page.getByRole("button", { name: "← Back", exact: true }).last().click();
  const quantity = page.getByRole("spinbutton", { name: "Pieces for PLAN-TEST", exact: true });
  const revised = String(Number(await quantity.inputValue()) + 10);
  await quantity.fill(revised); await quantity.press("Tab");
  await page.keyboard.press("Escape"); f.controls.releaseResponse!();
  await assertConfirmed(page);
  await expect(page.getByRole("checkbox", { name: "Remove PLAN-TEST from order", exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Open order builder", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "Pieces for PLAN-TEST", exact: true })).toHaveValue(revised);
  expect(f.commands).toHaveLength(1); expect(f.receipts.size).toBe(1); expect(f.failures).toEqual([]);
});

test("late creation response after client navigation retains intent for the new page to recover", async ({ page }) => {
  const f = await setup(page); f.controls.holdNext = true;
  await (await compose(page)).click();
  await expect.poll(() => f.controls.releaseResponse !== null).toBe(true);
  const original = await saved(page);
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "RFQs", exact: true }).click();
  await expect(page).toHaveURL(/\/procurement\/rfqs$/);
  f.controls.releaseResponse!();
  await expect(page.getByRole("button", { name: "Recover saved RFQ request" })).toBeEnabled();
  expect(await saved(page)).toBe(original);
  await page.getByRole("button", { name: "Recover saved RFQ request" }).click();
  await assertConfirmed(page); expect(f.commands[1]).toEqual(f.commands[0]); expect(f.receipts.size).toBe(1); expect(f.failures).toEqual([]);
});
