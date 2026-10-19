import { expect, test, type Page } from "@playwright/test";
import { installFixtures, receipt } from "./procurement-fixtures";

const STORAGE_KEY = "echelon:receipt-reversal:v1:test-user";
type Request = { path: string; key: string; body: { qty?: number; reason: string; allowNegative: boolean } };
type Options = { lost?: boolean; malformed?: boolean; rejected?: boolean; unconfirmed?: boolean; delayed?: boolean; permitted?: boolean };
async function setup(page: Page, options: Options = {}) {
  const failures = await installFixtures(page);
  const state = { requests: [] as Request[], postings: 0, offline: false, detailUnavailable: false, actorId: "test-user", reads: 0, lineParentId: 31, historyFailure: false, historyPayload: [] as unknown };
  const lines = [7, 8].map(id => ({ id, receivingOrderId: 31, sku: `REVIEW-${id}`, productName: `Review product ${id}`,
    productId: 10, productVariantId: 2, unitsPerVariantSnapshot: 10, unitVersion: "a".repeat(64), expectedQty: 5, receivedQty: 5,
    damagedQty: 0, reversedQty: 0, status: "complete", putawayLocationId: 5, putawayComplete: 1, unitCost: 25, purchaseOrderLineId: id }));
  const results = new Map<string, Record<string, unknown>>();
  let first = true;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() === "GET") {
      if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: state.actorId, username: "test", role: "admin" }, roles: ["admin"], permissions: options.permitted === false ? [] : ["purchasing:approve"] } });
      if (path === "/api/receiving/31") {
        state.reads++;
        if (state.detailUnavailable) return route.fulfill({ status: 503, json: { error: "Detail unavailable" } });
        return route.fulfill({ json: { ...receipt(31), sourceType: "po", warehouseId: 1, lines: lines.map(line => ({ ...line, receivingOrderId: state.lineParentId })) } });
      }
      if (path.endsWith("/reversals")) return route.fulfill(state.historyFailure ? { status: 503, json: { error: "History unavailable" } } : { json: state.historyPayload });
      if (path === "/api/warehouse/locations") return route.fulfill({ json: [{ id: 5, code: "RCV-01", name: "Receiving", warehouseId: 1, isActive: 1, locationType: "receiving" }] });
      if (path === "/api/warehouses") return route.fulfill({ json: [{ id: 1, name: "Fixture warehouse", code: "W1" }] });
      return route.fallback();
    }
    if (!/^\/api\/procurement\/receiving-(lines|orders)\/\d+\/reverse$/.test(path) || req.method() !== "POST") return route.fallback();
    const command = { path, key: req.headers()["idempotency-key"], body: req.postDataJSON() } as Request;
    state.requests.push(command);
    if (state.offline) return route.abort("internetdisconnected");
    if (results.has(command.key)) return route.fulfill({ json: results.get(command.key) });
    if (options.delayed) await gate;
    if ((options.rejected || options.unconfirmed) && first) {
      first = false;
      return route.fulfill({ status: 409, json: { code: "INSUFFICIENT_ON_HAND", error: "Goods have already been consumed. Review the correction.",
        ...(options.rejected ? { details: { receiptReversalOutcome: "rejected", idempotencyKey: command.key } } : {}) } });
    }
    state.postings++;
    const action = path.includes("receiving-lines") ? "line" : "order";
    const targetId = Number(path.split("/").at(-2));
    const selected = action === "line" ? lines.filter(line => line.id === targetId) : lines;
    const reversals = selected.map(line => {
      const qty = action === "line" ? command.body.qty! : line.receivedQty - line.reversedQty;
      line.reversedQty += qty;
      return { reversalId: 100 + line.id, receivingLineId: line.id, receivingOrderId: 31, qty, baseUnitsReversed: qty * 10,
        lotUnitCostMills: 2500, apReconciliationReopened: false, idempotentReplay: false };
    });
    const result = { ...(action === "line" ? reversals[0] : { reversals, poStatusUpdate: null }),
      action, targetId, receivingOrderId: 31, actorId: state.actorId, idempotencyKey: command.key };
    results.set(command.key, result);
    if (options.lost && first) { first = false; return route.abort("connectionreset"); }
    if (options.malformed && first) { first = false; return route.fulfill({ json: { ...result, actorId: "wrong-operator" } }); }
    return route.fulfill({ json: result });
  });
  return { state, failures, release };
}
async function open(page: Page, action: "line" | "order" = "line") {
  await page.goto("/receiving?open=31");
  await expect(page.getByRole("heading", { name: /Receipt TEST-RECEIPT-31/ })).toBeVisible();
  await (action === "line" ? page.locator('[data-testid="btn-reverse-line-7"]:visible,[data-testid="btn-reverse-line-mobile-7"]:visible') : page.getByTestId("btn-reverse-order")).click();
  await page.getByTestId("input-reverse-reason").fill("Correct reviewed receipt count");
  if (action === "line") await page.getByTestId("input-reverse-qty").fill("2");
}
async function saved(page: Page) { return page.evaluate(key => { const value = sessionStorage.getItem(key); return value ? JSON.parse(value) : null; }, STORAGE_KEY); }
async function navigate(page: Page, address: string) { await page.evaluate(url => { history.pushState(null, "", url); window.dispatchEvent(new PopStateEvent("popstate")); }, address); }
const retry = (page: Page) => page.getByRole("button", { name: "Retry saved receipt reversal", exact: true });

for (const action of ["line", "order"] as const) {
  test(`${action} reversal lost response survives reload and replays exactly once`, async ({ page }, info) => {
    const { state, failures } = await setup(page, { lost: true });
    await open(page, action); await page.getByTestId("btn-reverse-confirm").click();
    await expect(retry(page)).toBeEnabled();
    await expect(page.getByTestId("input-reverse-reason")).toBeDisabled();
    const original = await saved(page); expect(original.body.action).toBe(action); expect(state.postings).toBe(1);
    const dialog = page.getByRole("dialog").filter({ has: page.getByTestId("btn-reverse-confirm") });
    await expect.poll(async () => { const b = await dialog.boundingBox(), v = page.viewportSize()!; return !!b && b.y >= 0 && b.y + b.height <= v.height && b.width <= v.width; }).toBe(true);
    await page.screenshot({ path: info.outputPath(`${action}-reversal-recovery.png`), fullPage: true, animations: "disabled" });
    await page.reload(); await expect(retry(page)).toBeEnabled();
    await expect(page.getByTestId("btn-reverse-order")).toBeDisabled();
    await retry(page).click();
    await expect(page.getByText("Receipt reversal confirmed", { exact: true })).toBeVisible();
    expect(state.requests).toHaveLength(2); expect(state.requests[1]).toEqual(state.requests[0]); expect(state.postings).toBe(1);
    expect(await saved(page)).toBeNull(); expect(failures).toEqual([]);
  });
}
test("malformed success retains recovery and never claims confirmation", async ({ page }) => {
  const { state, failures } = await setup(page, { malformed: true }); await open(page);
  await page.getByTestId("btn-reverse-confirm").click(); await expect(retry(page)).toBeEnabled();
  await expect(page.getByText(/result could not be verified/)).toBeVisible();
  await expect(page.getByText("Receipt reversal confirmed", { exact: true })).toHaveCount(0);
  await retry(page).click(); await expect(page.getByText("Receipt reversal confirmed", { exact: true })).toBeVisible();
  expect(state.requests[1]).toEqual(state.requests[0]); expect(state.postings).toBe(1); expect(failures).toEqual([]);
});
test("durable rejection permits an explicitly reviewed correction with a new key", async ({ page }) => {
  const { state, failures } = await setup(page, { rejected: true }); await open(page);
  await page.getByTestId("btn-reverse-confirm").click();
  await expect(page.getByText("Goods have already been consumed. Review the correction.", { exact: true })).toBeVisible();
  expect(await saved(page)).toBeNull(); expect(state.postings).toBe(0);
  await page.getByTestId("input-reverse-qty").fill("1"); await page.getByTestId("input-reverse-allow-negative").check();
  await page.getByTestId("btn-reverse-confirm").click(); await expect(page.getByText("Receipt reversal confirmed", { exact: true })).toBeVisible();
  expect(state.requests[1].key).not.toBe(state.requests[0].key); expect(state.requests[1].body).toMatchObject({ qty: 1, allowNegative: true }); expect(failures).toEqual([]);
});
test("a rejection without durable identity retains the original request", async ({ page }) => {
  const { state, failures } = await setup(page, { unconfirmed: true }); await open(page);
  await page.getByTestId("btn-reverse-confirm").click(); await expect(retry(page)).toBeEnabled();
  await expect(page.getByTestId("input-reverse-qty")).toBeDisabled(); expect(await saved(page)).not.toBeNull();
  await retry(page).click(); await expect(page.getByText("Receipt reversal confirmed", { exact: true })).toBeVisible();
  expect(state.requests[1]).toEqual(state.requests[0]); expect(failures).toEqual([]);
});
test("recovery remains reachable from the list and when receipt details cannot load", async ({ page }) => {
  const { state, failures } = await setup(page, { lost: true }); await open(page);
  await page.getByTestId("btn-reverse-confirm").click(); await expect(retry(page)).toBeEnabled();
  await page.goto("/receiving"); await expect(retry(page)).toBeEnabled();
  state.detailUnavailable = true;
  await page.getByRole("link", { name: "receipt #31", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Receipt unavailable", exact: true })).toBeVisible();
  await retry(page).click(); await expect(page.getByText("Receipt reversal confirmed", { exact: true })).toBeVisible();
  expect(state.requests[1]).toEqual(state.requests[0]); expect(state.postings).toBe(1); expect(failures).toEqual([]);
});
test("late success cannot close or overwrite another receipt visit", async ({ page }) => {
  const { state, failures, release } = await setup(page, { delayed: true }); await open(page);
  await page.getByTestId("btn-reverse-confirm").click(); await expect.poll(() => state.requests.length).toBe(1);
  await page.keyboard.press("Escape"); await navigate(page, "/receiving?open=32");
  await expect(page.getByRole("heading", { name: /Receipt TEST-RECEIPT-32/ })).toBeVisible();
  const response = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/reverse"));
  release(); await (await response).finished();
  await expect.poll(() => state.postings).toBe(1); await expect.poll(() => saved(page)).toBeNull();
  await expect(page).toHaveURL(/receiving\?open=32$/);
  await expect(page.getByRole("heading", { name: /Receipt TEST-RECEIPT-32/ })).toBeVisible();
  await expect(page.getByText("Receipt reversal confirmed", { exact: true })).toHaveCount(0); expect(failures).toEqual([]);
});
test("offline attempt persists now and reconnecting never dispatches it automatically", async ({ page }) => {
  const { state, failures } = await setup(page); await open(page);
  state.offline = true; await page.context().setOffline(true);
  await page.getByTestId("btn-reverse-confirm").click(); await expect(retry(page)).toBeEnabled();
  const original = await saved(page); expect(original).not.toBeNull(); expect(state.postings).toBe(0);
  await page.keyboard.press("Escape"); await navigate(page, "/receiving?open=32");
  state.offline = false; await page.context().setOffline(false); await page.waitForLoadState("networkidle");
  expect(state.postings).toBe(0); expect(await saved(page)).toEqual(original);
  await retry(page).click(); await expect(page.getByText("Receipt reversal confirmed", { exact: true })).toBeVisible();
  expect(state.requests.at(-1)?.key).toBe(original.key); expect(state.postings).toBe(1); expect(failures).toEqual([]);
});
test("another operator cannot recover the previous operator's saved request", async ({ page }) => {
  const { state, failures } = await setup(page, { lost: true }); await open(page);
  await page.getByTestId("btn-reverse-confirm").click(); await expect(retry(page)).toBeEnabled();
  const original = await saved(page); state.actorId = "other-operator"; await page.reload();
  await expect(page.getByTestId("btn-reverse-order")).toBeEnabled(); await expect(retry(page)).toHaveCount(0);
  expect(await saved(page)).toEqual(original); expect(state.requests).toHaveLength(1);
  state.actorId = "test-user"; await page.reload(); await expect(retry(page)).toBeEnabled();
  await retry(page).click(); await expect(page.getByText("Receipt reversal confirmed", { exact: true })).toBeVisible();
  expect(state.requests[1]).toEqual(state.requests[0]); expect(state.postings).toBe(1); expect(failures).toEqual([]);
});
test("approval permission is required before either reversal can start", async ({ page }) => {
  const { state, failures } = await setup(page, { permitted: false }); await page.goto("/receiving?open=31");
  await expect(page.getByTestId("btn-reverse-order")).toBeDisabled();
  await expect(page.locator('[data-testid="btn-reverse-line-7"]:visible,[data-testid="btn-reverse-line-mobile-7"]:visible')).toBeDisabled();
  expect(state.requests).toEqual([]); expect(failures).toEqual([]);
});
test("corrupt saved evidence blocks new reversals without discarding it", async ({ page }) => {
  const { state, failures } = await setup(page);
  await page.addInitScript(key => sessionStorage.setItem(key, "broken"), STORAGE_KEY);
  await page.goto("/receiving?open=31"); await expect(page.getByText(/Saved receipt reversal cannot be verified/)).toBeVisible();
  await expect(page.getByTestId("btn-reverse-order")).toBeDisabled();
  expect(await page.evaluate(key => sessionStorage.getItem(key), STORAGE_KEY)).toBe("broken"); expect(state.requests).toEqual([]); expect(failures).toEqual([]);
});
test("blocked recovery reads can be explicitly retried after storage is restored", async ({ page }) => {
  const { state, failures } = await setup(page);
  await page.addInitScript(key => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function(k: string) { if (k === key) throw new DOMException("Fixture blocked", "SecurityError"); return original.call(this, k); };
    Object.defineProperty(window, "restoreReversalStorage", { value: () => { Storage.prototype.getItem = original; } });
  }, STORAGE_KEY);
  await page.goto("/receiving?open=31"); await expect(page.getByText(/Receipt reversal recovery cannot be read/)).toBeVisible();
  await expect(page.getByTestId("btn-reverse-order")).toBeDisabled();
  await page.evaluate(() => (window as typeof window & { restoreReversalStorage(): void }).restoreReversalStorage());
  await page.getByRole("button", { name: "Retry reversal recovery read", exact: true }).click();
  await expect(page.getByTestId("btn-reverse-order")).toBeEnabled(); expect(state.requests).toEqual([]); expect(failures).toEqual([]);
});

test("unsavable intent never dispatches and can be retried after browser storage recovers", async ({ page }) => {
  const { state, failures } = await setup(page);
  await page.addInitScript(key => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(k: string, value: string) { if (k === key) throw new DOMException("Fixture full", "QuotaExceededError"); original.call(this, k, value); };
    Object.defineProperty(window, "restoreReversalStorageWrite", { value: () => { Storage.prototype.setItem = original; } });
  }, STORAGE_KEY);
  await open(page); await page.getByTestId("btn-reverse-confirm").click();
  await expect(page.getByText(/The reversal was not sent because its recovery request could not be saved/)).toBeVisible();
  expect(state.requests).toEqual([]); expect(await saved(page)).toBeNull();
  await page.evaluate(() => (window as typeof window & { restoreReversalStorageWrite(): void }).restoreReversalStorageWrite());
  await page.getByTestId("btn-reverse-confirm").click(); await expect(page.getByText("Receipt reversal confirmed", { exact: true })).toBeVisible();
  expect(state.postings).toBe(1); expect(state.requests).toHaveLength(1); expect(failures).toEqual([]);
});

test("a foreign line in the detail response cannot dispatch a reversal for another receipt", async ({ page }) => {
  const { state, failures } = await setup(page); state.lineParentId = 99;
  await open(page); await page.getByTestId("btn-reverse-confirm").click();
  await expect(page.getByText(/receipt ownership could not be verified/)).toBeVisible();
  expect(state.requests).toEqual([]); expect(await saved(page)).toBeNull(); expect(failures).toEqual([]);
});
for (const failure of ["unavailable", "malformed", "wrong_receipt"] as const) {
  test(`receipt reversal history ${failure} shows explicit retry instead of an empty history`, async ({ page }) => {
    const { state, failures } = await setup(page);
    const auditRow = { id: 61, receivingOrderId: 31, receivingLineId: 7, qty: 2, reason: "Recorded correction", reversalScope: "line",
      orderReversalId: null, baseUnitsReversed: 20, lotUnitCostMills: 2500, allowNegative: false, apReconciliationReopened: true,
      idempotencyKey: "saved-audit-key", createdBy: "test-user", createdAt: "2026-10-19T12:00:00Z" };
    state.historyFailure = failure === "unavailable";
    state.historyPayload = failure === "wrong_receipt" ? [{ ...auditRow, receivingOrderId: 99 }] : { reversals: [] };
    await page.goto("/receiving?open=31");
    await expect(page.getByRole("button", { name: "Retry receipt reversal history", exact: true })).toBeEnabled();
    await expect(page.getByText("No receipt reversals recorded.", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("btn-reverse-order")).toBeDisabled();
    state.historyFailure = false; state.historyPayload = [auditRow];
    await page.getByRole("button", { name: "Retry receipt reversal history", exact: true }).click();
    await expect(page.getByTestId("reversal-history")).toContainText("Recorded correction");
    await expect(page.getByTestId("btn-reverse-order")).toBeEnabled(); expect(state.requests).toEqual([]); expect(failures).toEqual([]);
  });
}
