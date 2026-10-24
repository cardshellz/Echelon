import { expect, test, type Page } from "@playwright/test";
import { installFixtures, receipt } from "./procurement-fixtures";

const STORAGE_KEY = "echelon:receiving-entry:v1:test-user";
type Action = "create" | "add-line";
type EntryRequest = { path: string; key: string; body: Record<string, unknown> };
type Options = { lost?: boolean; malformed?: boolean; delayed?: boolean; rejected?: boolean; unconfirmed?: boolean };
type EntryLine = { id: number; receivingOrderId: number; sku: string; productName: string; productId: number;
  productVariantId: number; unitsPerVariantSnapshot: number; unitVersion: string; expectedQty: number;
  receivedQty: number; damagedQty: number; status: string; putawayLocationId: number; putawayComplete: number;
  barcode: null; unitCost: null; unitCostMills: null; reversalCapability: { allowed: boolean; code: null; reason: null } };

async function setup(page: Page, options: Options = {}) {
  const failures = await installFixtures(page);
  const state = { requests: [] as EntryRequest[], commits: 0, actorId: "test-user", permitted: true,
    detailUnavailable: false, offline: false, reads: 0, draftReceipts: new Set<number>(), lines: new Map<number, EntryLine[]>([[31, []], [32, []]]) };
  const variants = [{ id: 2, sku: "CASE-5", name: "Case of 5", productId: 10, unitsPerVariant: 5, productVariantId: 2 }];
  const order = (id: number) => {
    const lines = state.lines.get(id) ?? [];
    return { ...receipt(id), sourceType: "blind", purchaseOrderId: null, inboundShipmentId: null,
      warehouseId: 1, receivingLocationId: 5, vendorId: null, poNumber: null, status: state.draftReceipts.has(id) ? "draft" : "open", createdBy: "test-user", notes: null,
      expectedLineCount: lines.length, receivedLineCount: lines.length,
      expectedTotalUnits: lines.reduce((total, line) => total + line.expectedQty, 0),
      receivedTotalUnits: lines.reduce((total, line) => total + line.receivedQty, 0), lines };
  };
  const results = new Map<string, { request: EntryRequest; result: Record<string, unknown> }>();
  let first = true;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: state.actorId, username: "test", role: "admin" }, roles: ["admin"], permissions: state.permitted ? ["inventory:adjust", "purchasing:approve"] : [] } });
      if (path === "/api/receiving") return route.fulfill({ json: [...state.lines.keys()].map(order) });
      if (/^\/api\/receiving\/\d+$/.test(path)) {
        state.reads++;
        if (state.detailUnavailable) return route.fulfill({ status: 503, json: { error: "Receipt detail unavailable" } });
        return route.fulfill({ json: order(Number(path.split("/").at(-1))) });
      }
      if (path === "/api/warehouses") return route.fulfill({ json: [{ id: 1, name: "Fixture warehouse", code: "W1" }] });
      if (path === "/api/warehouse/locations") return route.fulfill({ json: [{ id: 5, code: "RCV-01", name: "Receiving", warehouseId: 1, isActive: 1, locationType: "receiving" }] });
      if (path === "/api/product-variants" || path.includes("search") && path.includes("sku")) return route.fulfill({ json: variants });
      if (path.endsWith("/reversals")) return route.fulfill({ json: [] });
      return route.fallback();
    }
    if (request.method() !== "POST" || path !== "/api/receiving" && !/^\/api\/receiving\/\d+\/lines$/.test(path)) return route.fallback();
    const command = { path, key: request.headers()["idempotency-key"], body: request.postDataJSON() } as EntryRequest;
    state.requests.push(command);
    if (!state.permitted) return route.fulfill({ status: 403, json: { error: "Inventory adjustment permission is required" } });
    if (state.offline) return route.abort("internetdisconnected");
    const prior = results.get(command.key);
    if (prior) {
      if (JSON.stringify(prior.request) !== JSON.stringify(command)) return route.fulfill({ status: 409, json: { error: "Command identity changed" } });
      return route.fulfill({ status: 201, json: prior.result });
    }
    const actorId = state.actorId;
    if (options.delayed) await gate;
    if ((options.rejected || options.unconfirmed) && first) {
      first = false;
      return route.fulfill({ status: 409, json: { error: "The receiving destination changed. Review the receipt.", code: "RECEIVING_DESTINATION_CHANGED",
        ...(options.rejected ? { details: { receivingEntryOutcome: "rejected", idempotencyKey: command.key } } : {}) } });
    }
    const action: Action = path === "/api/receiving" ? "create" : "add-line";
    state.commits++;
    const receivingOrderId = action === "create" ? 40 + state.commits : Number(path.split("/")[3]);
    let receivingLineId: number | null = null;
    if (action === "create") { state.lines.set(receivingOrderId, []); state.draftReceipts.add(receivingOrderId); }
    else {
      receivingLineId = 100 + state.commits;
      state.lines.get(receivingOrderId)!.push({ id: receivingLineId, receivingOrderId, sku: String(command.body.sku),
        productName: String(command.body.productName), productId: 10, productVariantId: 2, unitsPerVariantSnapshot: 5,
        unitVersion: "a".repeat(64), expectedQty: Number(command.body.expectedQty), receivedQty: Number(command.body.receivedQty),
        damagedQty: 0, status: "complete", putawayLocationId: 5, putawayComplete: 0, barcode: null, unitCost: null, unitCostMills: null,
        reversalCapability: { allowed: true, code: null, reason: null } });
    }
    // Freeze the original response. Later GETs represent current mutable receipt state.
    const result = JSON.parse(JSON.stringify({ ...order(receivingOrderId), entryCommand: { action,
      targetId: action === "create" ? null : receivingOrderId, receivingOrderId, receivingLineId, actorId, idempotencyKey: command.key } })) as Record<string, unknown>;
    results.set(command.key, { request: command, result });
    if (options.lost && first) { first = false; return route.abort("connectionreset"); }
    if (options.malformed && first) { first = false; return route.fulfill({ json: { ...result, entryCommand: { ...(result.entryCommand as object), actorId: "wrong-operator" } } }); }
    return route.fulfill({ status: 201, json: result });
  });
  return { state, failures, release };
}

async function saved(page: Page) {
  return page.evaluate(key => { const raw = sessionStorage.getItem(key); return raw === null ? null : JSON.parse(raw); }, STORAGE_KEY);
}
const notice = (page: Page) => page.getByRole("alert", { name: "Receiving entry recovery" }).filter({ visible: true });
const retry = (page: Page) => page.getByRole("button", { name: "Retry saved receiving entry", exact: true }).filter({ visible: true });
async function navigate(page: Page, address: string) {
  await page.evaluate(url => { history.pushState(null, "", url); window.dispatchEvent(new PopStateEvent("popstate")); }, address);
}
async function prepare(page: Page, action: Action, navigateToReceipt = true) {
  if (action === "create") {
    await page.goto("/receiving");
    await page.getByTestId("btn-new-receipt").click();
    const dialog = page.getByRole("dialog", { name: "Create New Receipt", exact: true });
    await dialog.getByTestId("select-warehouse").click();
    await page.getByRole("option", { name: "Fixture warehouse (W1)", exact: true }).click();
    return { dialog, submit: dialog.getByTestId("btn-create-receipt") };
  }
  if (navigateToReceipt) await page.goto("/receiving?open=31");
  await page.getByTestId("btn-add-line").click();
  const dialog = page.getByRole("dialog", { name: "Add Line", exact: true });
  await dialog.getByTestId("input-add-line-sku").fill("CASE-5");
  await dialog.getByTestId("sku-option-CASE-5").click();
  await dialog.getByTestId("input-add-line-expected").fill("5");
  await dialog.getByRole("combobox", { name: "Put-away location", exact: true }).click();
  await page.getByRole("option", { name: /RCV-01/ }).click();
  return { dialog, submit: dialog.getByTestId("btn-confirm-add-line") };
}

for (const action of ["create", "add-line"] as const) {
  for (const failure of ["lost", "malformed"] as const) {
    test(`${action} ${failure} success survives reload and replays the original entry once`, async ({ page }, info) => {
      const { state, failures } = await setup(page, { [failure]: true });
      const { dialog, submit } = await prepare(page, action);
      await submit.click();
      await expect(retry(page)).toBeEnabled();
      await expect(submit).toBeDisabled();
      expect(state.commits).toBe(1);
      const original = await saved(page);
      expect(original.body.action).toBe(action);
      await expect.poll(async () => { const box = await dialog.boundingBox(), viewport = page.viewportSize()!; return !!box && box.x >= 0 && box.width <= viewport.width && box.y >= 0 && box.y + box.height <= viewport.height; }).toBe(true);
      await page.screenshot({ path: info.outputPath(`${action}-${failure}-recovery.png`), fullPage: true, animations: "disabled" });
      await page.reload();
      await expect(retry(page)).toBeEnabled();
      await expect(page.getByTestId("btn-new-receipt")).toBeDisabled();
      if (action === "add-line") {
        await expect(page.getByTestId("btn-add-line")).toBeDisabled();
        await expect(page.getByTestId("btn-close-receipt")).toBeDisabled();
      }
      await retry(page).click();
      await expect.poll(() => saved(page)).toBeNull();
      await expect(retry(page)).toHaveCount(0);
      expect(state.requests).toHaveLength(2);
      expect(state.requests[1]).toEqual(state.requests[0]);
      expect(state.commits).toBe(1);
      if (action === "add-line") expect(state.lines.get(31)).toHaveLength(1);
      else await expect(page).toHaveURL(/receiving\?open=41$/);
      expect(failures).toEqual([]);
    });
  }

  test(`${action} late success preserves another receipt visit`, async ({ page }) => {
    const { state, failures, release } = await setup(page, { delayed: true });
    const { submit } = await prepare(page, action);
    await submit.click();
    await expect.poll(() => state.requests.length).toBe(1);
    await page.keyboard.press("Escape");
    await navigate(page, "/receiving?open=32");
    await expect(page.getByRole("heading", { name: /Receipt TEST-RECEIPT-32/ })).toBeVisible();
    const response = page.waitForResponse(response => response.request().method() === "POST" && response.url().includes("/api/receiving"));
    release(); await (await response).finished();
    await expect.poll(() => saved(page)).toBeNull();
    await expect(page).toHaveURL(/receiving\?open=32$/);
    await expect(page.getByRole("heading", { name: /Receipt TEST-RECEIPT-32/ })).toBeVisible();
    expect(state.lines.get(32)).toHaveLength(0);
    expect(state.commits).toBe(1); expect(failures).toEqual([]);
  });
}

test("separate identical physical batches receive distinct command keys", async ({ page }) => {
  const { state, failures } = await setup(page);
  const first = await prepare(page, "add-line"); await first.submit.click(); await expect(first.dialog).toBeHidden();
  await expect.poll(() => saved(page)).toBeNull();
  const second = await prepare(page, "add-line", false); await second.submit.click(); await expect(second.dialog).toBeHidden();
  expect(state.requests).toHaveLength(2);
  expect(state.requests[1].body).toEqual(state.requests[0].body);
  expect(state.requests[1].key).not.toBe(state.requests[0].key);
  expect(state.lines.get(31)).toHaveLength(2); expect(state.commits).toBe(2); expect(failures).toEqual([]);
});

test("only a matching durable rejection allows a corrected entry with a new key", async ({ page }) => {
  const { state, failures } = await setup(page, { rejected: true });
  const { dialog, submit } = await prepare(page, "add-line"); await submit.click();
  await expect(dialog.getByRole("alert").first()).toContainText("destination changed");
  await expect.poll(() => saved(page)).toBeNull();
  await dialog.getByTestId("input-add-line-expected").fill("4");
  await submit.click(); await expect(dialog).toBeHidden();
  expect(state.requests[1].key).not.toBe(state.requests[0].key);
  expect(state.requests[1].body).toMatchObject({ expectedQty: 4, receivedQty: 4 });
  expect(state.commits).toBe(1); expect(failures).toEqual([]);
});

test("an unconfirmed rejection retains and locks the original entry", async ({ page }) => {
  const { state, failures } = await setup(page, { unconfirmed: true });
  const { dialog, submit } = await prepare(page, "add-line"); await submit.click();
  await expect(retry(page)).toBeEnabled();
  await expect(dialog.getByTestId("input-add-line-expected")).toBeDisabled();
  expect(await saved(page)).not.toBeNull();
  await retry(page).click(); await expect.poll(() => saved(page)).toBeNull();
  expect(state.requests[1]).toEqual(state.requests[0]); expect(state.commits).toBe(1); expect(failures).toEqual([]);
});

test("another operator cannot consume the previous operator's unresolved entry", async ({ page }) => {
  const { state, failures } = await setup(page, { lost: true });
  const { submit } = await prepare(page, "add-line"); await submit.click(); await expect(retry(page)).toBeEnabled();
  const original = await saved(page);
  state.actorId = "another-operator"; await page.reload();
  await expect(page.getByTestId("btn-add-line")).toBeEnabled();
  await expect(retry(page)).toHaveCount(0); expect(await saved(page)).toEqual(original);
  state.actorId = "test-user"; await page.reload(); await expect(retry(page)).toBeEnabled();
  await retry(page).click(); await expect.poll(() => saved(page)).toBeNull();
  expect(state.requests[1]).toEqual(state.requests[0]); expect(state.commits).toBe(1); expect(failures).toEqual([]);
});

test("revoked permission preserves saved recovery without dispatching", async ({ page }) => {
  const { state, failures } = await setup(page, { lost: true });
  const { submit } = await prepare(page, "add-line"); await submit.click(); await expect(retry(page)).toBeEnabled();
  const original = await saved(page);
  state.permitted = false; await page.reload();
  await expect(retry(page)).toBeDisabled(); await expect(page.getByTestId("btn-add-line")).toBeDisabled();
  expect(await saved(page)).toEqual(original); expect(state.requests).toHaveLength(1);
  state.permitted = true; await page.reload(); await retry(page).click();
  await expect.poll(() => saved(page)).toBeNull(); expect(state.requests[1]).toEqual(state.requests[0]); expect(failures).toEqual([]);
});

test("unsavable recovery prevents dispatch and preserves the editable form", async ({ page }) => {
  const { state, failures } = await setup(page);
  await page.addInitScript(key => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(k, value) { if (k === key) throw new DOMException("Fixture storage full", "QuotaExceededError"); return original.call(this, k, value); };
    Object.defineProperty(window, "restoreEntryStorage", { value: () => { Storage.prototype.setItem = original; } });
  }, STORAGE_KEY);
  const { dialog, submit } = await prepare(page, "add-line"); await submit.click();
  await expect(dialog.getByRole("alert").first()).toContainText(/not sent.*could not be saved/);
  expect(state.requests).toEqual([]); expect(await saved(page)).toBeNull();
  await expect(dialog.getByTestId("input-add-line-expected")).toHaveValue("5");
  await page.evaluate(() => (window as typeof window & { restoreEntryStorage(): void }).restoreEntryStorage());
  await submit.click(); await expect(dialog).toBeHidden(); expect(state.commits).toBe(1); expect(failures).toEqual([]);
});

test("corrupt recovery blocks new receiving entries without erasing evidence", async ({ page }) => {
  const { state, failures } = await setup(page);
  await page.addInitScript(key => sessionStorage.setItem(key, "broken-entry-evidence"), STORAGE_KEY);
  await page.goto("/receiving?open=31");
  await expect(notice(page)).toContainText(/cannot be verified/);
  await expect(page.getByTestId("btn-add-line")).toBeDisabled();
  await expect(page.getByTestId("btn-close-receipt")).toBeDisabled();
  expect(await page.evaluate(key => sessionStorage.getItem(key), STORAGE_KEY)).toBe("broken-entry-evidence");
  expect(state.requests).toEqual([]); expect(failures).toEqual([]);
});

test("blocked recovery reads can be retried after storage is restored", async ({ page }) => {
  const { state, failures } = await setup(page);
  await page.addInitScript(key => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function(k) { if (k === key) throw new DOMException("Fixture blocked", "SecurityError"); return original.call(this, k); };
    Object.defineProperty(window, "restoreEntryReads", { value: () => { Storage.prototype.getItem = original; } });
  }, STORAGE_KEY);
  await page.goto("/receiving?open=31"); await expect(notice(page)).toContainText("Receiving recovery cannot be read");
  await expect(page.getByTestId("btn-add-line")).toBeDisabled();
  await page.evaluate(() => (window as typeof window & { restoreEntryReads(): void }).restoreEntryReads());
  await page.getByRole("button", { name: "Retry receiving recovery read", exact: true }).click();
  await expect(page.getByTestId("btn-add-line")).toBeEnabled(); expect(state.requests).toEqual([]); expect(failures).toEqual([]);
});

test("failed recovery removal confirms the same committed entry again without duplicating it", async ({ page }) => {
  const { state, failures } = await setup(page);
  await page.addInitScript(key => {
    const original = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function(k) { if (k === key) throw new DOMException("Fixture blocked", "SecurityError"); return original.call(this, k); };
    Object.defineProperty(window, "restoreEntryRemoval", { value: () => { Storage.prototype.removeItem = original; } });
  }, STORAGE_KEY);
  const { submit } = await prepare(page, "add-line"); await submit.click();
  await expect(retry(page)).toBeEnabled(); await expect(notice(page)).toContainText("recovery could not be cleared");
  expect(state.commits).toBe(1); expect(await saved(page)).not.toBeNull();
  await page.evaluate(() => (window as typeof window & { restoreEntryRemoval(): void }).restoreEntryRemoval());
  await retry(page).click(); await expect.poll(() => saved(page)).toBeNull();
  expect(state.requests[1]).toEqual(state.requests[0]); expect(state.commits).toBe(1); expect(failures).toEqual([]);
});

test("offline intent survives navigation and reconnecting never silently dispatches it", async ({ page }) => {
  const { state, failures } = await setup(page);
  const { submit } = await prepare(page, "add-line");
  state.offline = true; await page.context().setOffline(true); await submit.click();
  await expect(retry(page)).toBeEnabled(); const original = await saved(page);
  expect(original).not.toBeNull(); expect(state.commits).toBe(0);
  await page.keyboard.press("Escape"); await navigate(page, "/receiving?open=32");
  state.offline = false; await page.context().setOffline(false); await page.waitForLoadState("networkidle");
  expect(state.commits).toBe(0); expect(await saved(page)).toEqual(original);
  await retry(page).click(); await expect.poll(() => saved(page)).toBeNull();
  expect(state.requests.at(-1)?.key).toBe(original.key); expect(state.commits).toBe(1);
  expect(state.lines.get(31)).toHaveLength(1); expect(state.lines.get(32)).toHaveLength(0); expect(failures).toEqual([]);
});

test("saved recovery stays reachable on the list when receipt detail is unavailable", async ({ page }) => {
  const { state, failures } = await setup(page, { lost: true });
  const { submit } = await prepare(page, "add-line"); await submit.click(); await expect(retry(page)).toBeEnabled();
  state.detailUnavailable = true; await page.goto("/receiving");
  await expect(retry(page)).toBeEnabled(); await retry(page).click();
  await expect.poll(() => saved(page)).toBeNull();
  expect(state.requests[1]).toEqual(state.requests[0]); expect(state.commits).toBe(1); expect(failures).toEqual([]);
});

test("confirmed entry with failed receipt refresh never asks the operator to add it again", async ({ page }) => {
  const { state, failures } = await setup(page);
  const { submit } = await prepare(page, "add-line"); state.detailUnavailable = true; await submit.click();
  await expect.poll(() => state.commits).toBe(1); await expect.poll(() => saved(page)).toBeNull();
  await expect(retry(page)).toHaveCount(0);
  await expect(page.getByText("Line added successfully", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Receipt unavailable", exact: true })).toBeVisible();
  expect(state.requests).toHaveLength(1);
  state.detailUnavailable = false; await page.reload();
  await expect(page.getByRole("heading", { name: /Receipt TEST-RECEIPT-31/ })).toBeVisible();
  expect(state.lines.get(31)).toHaveLength(1); expect(state.requests).toHaveLength(1); expect(failures).toEqual([]);
});
