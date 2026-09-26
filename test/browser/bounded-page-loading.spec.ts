import { test, expect, type Page } from "playwright/test";
import { resolve } from "node:path";

async function setup(page: Page, mode = "wms", fail = false) {
  const state = { fail, handledFail: fail, total: 201, requests: [] as string[], writes: [] as string[], errors: [] as string[],
    historyGates: new Map<string, Promise<void>>() };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    state.requests.push(url.pathname + url.search);
    if (route.request().method() !== "GET") state.writes.push(url.pathname);
    if (url.pathname === "/api/test/handled-data") {
      await route.fulfill(state.handledFail
        ? { status: 503, json: { error: "Temporarily unavailable" } }
        : { json: { ok: true } });
      return;
    }
    const lists = ["/api/wms/orders", "/api/oms/orders", "/api/orders/history", "/api/inventory/transactions", "/api/test/page-data", "/api/picking/queue", "/api/picking/history"];
    if (state.fail && lists.includes(url.pathname)) {
      await route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
      return;
    }
    let body: unknown = [];
    if (url.pathname === "/api/auth/me") body = { user: { id: "tester", username: "tester", role: "admin" }, permissions: ["orders:view"], roles: ["admin"] };
    if (url.pathname === "/api/wms/orders") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const searching = !!url.searchParams.get("search");
      const id = searching ? 900 : offset + 1;
      body = { orders: offset >= (searching ? 1 : state.total) ? [] : [{ id, orderNumber: searching ? "TARGET-62770" : `ORDER-${id}`, customerName: "Test Customer", warehouseStatus: "ready", createdAt: "2026-01-01T00:00:00Z", priority: 100, itemCount: 1, pickedCount: 0, source: "manual", onHold: 0 }],
        total: searching ? 1 : state.total, offset, limit: 100, buckets: { needsPick: searching ? 1 : state.total, picked: 0, issues: 0, shipped: 0, cancelled: 0, all: searching ? 1 : state.total } };
    }
    if (url.pathname === "/api/oms/orders" || url.pathname === "/api/orders/history") body = { orders: [], total: 0 };
    if (url.pathname === "/api/oms/orders/stats") body = {};
    if (url.pathname === "/api/test/page-data") body = { ok: true };
    if (url.pathname === "/api/picking/history") {
      const search = url.searchParams.get("search") ?? "";
      const gate = state.historyGates.get(search);
      if (gate) await gate;
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const searching = !!search;
      const total = search === "NOT-FOUND" ? 0 : searching ? 1 : state.total;
      const id = searching ? 900 : offset + 1;
      body = { orders: offset >= total ? [] : [{
        id, orderNumber: searching ? "#62770" : `OLD-ORDER-${id}`, customerName: "Historical Customer",
        warehouseStatus: "shipped", channelName: "Test store", warehouseId: 1,
        createdAt: "2020-01-01T00:00:00Z", completedAt: "2020-01-02T00:00:00Z",
        lastPickAt: "2020-01-02T00:00:00Z", lastPickerName: "Recorded picker",
        items: [{ id: 1, sku: "GLV-TOP-35PT-P50", name: "Glove-fit sleeves", quantity: 5, pickedQuantity: 5, status: "completed", pickedAt: "2020-01-02T00:00:00Z" }],
      }], total, limit: 50, offset };
    }
    await route.fulfill({ json: body });
  });
  await page.route("**/__bounded-page-loading**", route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
      <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script>
      </head><body><main id="root"></main><script type="module" src="/@fs/${resolve("test/browser/fixtures/bounded-page-loading-harness.tsx").replaceAll("\\", "/")}"></script></body></html>`,
  }));
  await page.goto(`/__bounded-page-loading?mode=${mode}`);
  return state;
}

test("WMS failure is not an empty warehouse and retry restores orders", async ({ page }) => {
  const state = await setup(page, "wms", true);
  await expect(page.getByRole("alert")).toContainText("Could not load orders");
  await expect(page.getByText("No orders need picking", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("tab-needs-pick")).not.toContainText("(0)");
  state.fail = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByTestId("card-order-1")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test("WMS pagination and debounced search use bounded server requests", async ({ page }) => {
  const state = await setup(page);
  await expect(page.getByTestId("card-order-1")).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByTestId("card-order-101")).toBeVisible();
  await page.getByTestId("input-search-orders").pressSequentially("62770", { delay: 35 });
  await expect(page.getByTestId("card-order-900")).toBeVisible();
  const searches = state.requests.filter(path => path.startsWith("/api/wms/orders?") && path.includes("search="));
  expect(searches).toHaveLength(1);
  const query = new URL(searches[0], "http://test").searchParams;
  expect(query.get("offset")).toBe("0");
  expect(query.get("limit")).toBe("100");
  expect(query.get("search")).toBe("62770");
  expect(state.errors).toEqual([]);
});

test("WMS refresh failures identify stale data without hiding the last successful list", async ({ page }) => {
  const state = await setup(page);
  await expect(page.getByTestId("card-order-1")).toBeVisible();
  state.fail = true;
  await page.getByTestId("button-refresh-orders").click();
  await expect(page.getByRole("alert")).toContainText("last successful load");
  await expect(page.getByTestId("card-order-1")).toBeVisible();
  expect(state.errors).toEqual([]);
});

test("WMS returns to a valid page when operations shrink the result set", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByTestId("card-order-101")).toBeVisible();
  state.total = 50;
  await page.getByTestId("button-refresh-orders").click();
  await expect(page.getByTestId("card-order-1")).toBeVisible();
  await expect(page.getByTestId("tab-needs-pick")).toContainText("(50)");
  await expect(page.getByRole("navigation", { name: "Order pages" })).toHaveCount(0);
  expect(new URL(state.requests.filter(path => path.startsWith("/api/wms/orders?")).at(-1)!, "http://test").searchParams.get("offset")).toBe("0");
  expect(state.errors).toEqual([]);
});

for (const mode of ["oms", "history", "inventory"]) {
  test(`${mode} read failure is visible instead of an empty list`, async ({ page }) => {
    const state = await setup(page, mode, true);
    await expect(page.getByRole("alert")).toContainText("Could not load");
    await expect(page.getByText(/^(No orders found|No transactions found)$/)).toHaveCount(0);
    state.fail = false;
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(state.errors).toEqual([]);
  });
}

test("app-wide fallback retries active failures and forgets an unmounted page", async ({ page }) => {
  const state = await setup(page, "health", true);
  await expect(page.getByRole("alert")).toContainText("Some data on this page could not be loaded");
  await page.getByRole("button", { name: "Leave page" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test("app-wide fallback clears when its failed read succeeds", async ({ page }) => {
  const state = await setup(page, "health", true);
  await expect(page.getByRole("alert")).toBeVisible();
  state.fail = false;
  await page.getByRole("button", { name: "Retry failed loads" }).click();
  await expect(page.getByText("Page data loaded", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test("an inline error owns its warning and retry without an app-wide duplicate", async ({ page }) => {
  const state = await setup(page, "health-handled", true);
  await expect(page.getByRole("alert")).toHaveCount(1);
  await expect(page.getByRole("alert")).toContainText("Could not load handled data");
  await expect(page.getByRole("button", { name: "Retry failed loads" })).toHaveCount(0);
  state.handledFail = false;
  await page.getByRole("button", { name: "Retry handled data" }).click();
  await expect(page.getByText("Handled data loaded", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.requests.filter(path => path === "/api/test/handled-data")).toHaveLength(2);
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("an inline error does not hide another failed read or join its app-wide retry", async ({ page }) => {
  const state = await setup(page, "health-mixed", true);
  await expect(page.getByRole("alert")).toHaveCount(2);
  await expect(page.getByText("Some data on this page could not be loaded.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry handled data" })).toBeVisible();
  state.fail = false;
  await page.getByRole("button", { name: "Retry failed loads" }).click();
  await expect(page.getByText("Page data loaded", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(1);
  await expect(page.getByRole("alert")).toContainText("Could not load handled data");
  expect(state.requests.filter(path => path === "/api/test/page-data")).toHaveLength(2);
  expect(state.requests.filter(path => path === "/api/test/handled-data")).toHaveLength(1);
  state.handledFail = false;
  await page.getByRole("button", { name: "Retry handled data" }).click();
  await expect(page.getByText("Handled data loaded", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});

for (const mode of ["single", "batch"]) {
  test(`picking ${mode} history searches all dates without enabling picking actions`, async ({ page }) => {
    await page.addInitScript(pickingMode => localStorage.setItem("pickingMode", pickingMode), mode);
    const state = await setup(page, "picking");
    await expect(page.getByTestId("filter-done")).toHaveText("History");
    expect(state.requests.some(path => path.startsWith("/api/picking/history"))).toBe(false);
    await page.getByTestId("filter-done").click();
    await expect(page.getByTestId("history-order-1")).toContainText("2020");
    await expect(page.getByTestId("button-grab-next")).toHaveCount(0);
    await page.getByRole("navigation", { name: "Picking history pages" }).getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.getByTestId("history-order-51")).toBeVisible();
    await page.getByTestId("input-search-queue").pressSequentially("62770", { delay: 30 });
    await expect(page.getByTestId("history-order-900")).toContainText("#62770");
    const searches = state.requests.filter(path => path.startsWith("/api/picking/history?") && path.includes("search="));
    expect(searches).toHaveLength(1);
    const query = new URL(searches[0], "http://test").searchParams;
    expect(query.get("offset")).toBe("0");
    expect(query.get("limit")).toBe("50");
    expect(query.has("startDate")).toBe(false);
    expect(query.has("endDate")).toBe(false);
    await page.getByTestId("history-order-900").click();
    await expect(page.getByRole("dialog")).toContainText("Picked now: 5 / 5 ordered");
    await expect(page.getByRole("dialog")).toContainText("Recorded picker");
    await expect(page.getByRole("dialog").getByRole("button", { name: /claim|release|unpick|ship/i })).toHaveCount(0);
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    expect(state.writes).toEqual([]);
    expect(state.errors).toEqual([]);
  });
}

test("picking history failure is visible, retries, and marks a failed refresh stale", async ({ page }) => {
  const state = await setup(page, "picking", true);
  await page.getByTestId("filter-done").click();
  await expect(page.getByRole("alert")).toContainText("Could not load picking history");
  await expect(page.getByText("No picking history matches your search.")).toHaveCount(0);
  state.fail = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByTestId("history-order-1")).toBeVisible();
  state.fail = true;
  await page.getByRole("button", { name: "Refresh history" }).click();
  await expect(page.getByRole("alert")).toContainText("last successful load");
  await expect(page.getByTestId("history-order-1")).toBeVisible();
  expect(state.errors).toEqual([]);
});

test("history search immediately replaces an old empty result with visible progress, including during debounce", async ({ page }) => {
  await page.clock.install();
  const state = await setup(page, "picking");
  await page.getByTestId("filter-done").click();
  await expect(page.getByTestId("history-order-1")).toBeVisible();
  await page.getByTestId("input-search-queue").fill("NOT-FOUND");
  await page.clock.fastForward(300);
  await expect(page.getByText("No picking history matches your search.")).toBeVisible();
  let release!: () => void;
  state.historyGates.set("62770", new Promise<void>(resolve => { release = resolve; }));
  try {
    await page.getByTestId("input-search-queue").fill("62770");
    await expect(page.getByRole("status")).toContainText("Searching all picking history for “62770”…");
    await expect(page.getByText("No picking history matches your search.")).toHaveCount(0);
    expect(state.requests.some(path => path.includes("search=62770"))).toBe(false);
    await page.clock.fastForward(300);
    await expect.poll(() => state.requests.some(path => path.includes("search=62770"))).toBe(true);
    await expect(page.getByRole("region", { name: "Picking history" })).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("button", { name: "Refresh history" })).toBeDisabled();
    await expect(page.getByText("No picking history matches your search.")).toHaveCount(0);
    release();
    await expect(page.getByTestId("history-order-900")).toContainText("#62770");
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Picking history" })).toHaveAttribute("aria-busy", "false");
  } finally { release(); }
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("a late response for an older search cannot replace the current order", async ({ page }) => {
  await page.clock.install();
  const state = await setup(page, "picking");
  let release!: () => void;
  state.historyGates.set("NOT-FOUND", new Promise<void>(resolve => { release = resolve; }));
  try {
    await page.getByTestId("filter-done").click();
    await expect(page.getByTestId("history-order-1")).toBeVisible();
    await page.getByTestId("input-search-queue").fill("NOT-FOUND");
    await page.clock.fastForward(300);
    await expect.poll(() => state.requests.some(path => path.includes("search=NOT-FOUND"))).toBe(true);
    await page.getByTestId("input-search-queue").fill("62770");
    await page.clock.fastForward(300);
    await expect(page.getByTestId("history-order-900")).toBeVisible();
    release();
    await expect(page.getByTestId("history-order-900")).toContainText("#62770");
    await expect(page.getByText("No picking history matches your search.")).toHaveCount(0);
  } finally { release(); }
  expect(state.errors).toEqual([]);
});

test("a stalled history search times out visibly and can be retried", async ({ page }) => {
  await page.clock.install();
  const state = await setup(page, "picking");
  let release!: () => void;
  state.historyGates.set("62770", new Promise<void>(resolve => { release = resolve; }));
  try {
    await page.getByTestId("filter-done").click();
    await expect(page.getByTestId("history-order-1")).toBeVisible();
    await page.getByTestId("input-search-queue").fill("62770");
    await page.clock.fastForward(300);
    await expect.poll(() => state.requests.some(path => path.includes("search=62770"))).toBe(true);
    await page.clock.fastForward(10_000);
    await expect(page.getByRole("alert")).toContainText("Could not load picking history");
    await expect(page.getByText("The picking history search took too long. Please try again.")).toBeVisible();
    await expect(page.getByText("No picking history matches your search.")).toHaveCount(0);
    state.historyGates.delete("62770");
    release();
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByTestId("history-order-900")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally { release(); }
  expect(state.writes).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("picking history resets pages on store filters and corrects a shrinking last page", async ({ page }) => {
  const state = await setup(page, "picking");
  await page.getByTestId("filter-done").click();
  const next = () => page.getByRole("navigation", { name: "Picking history pages" }).getByRole("button", { name: "Next", exact: true }).click();
  await next();
  await expect(page.getByTestId("history-order-51")).toBeVisible();
  await page.getByLabel("Picking channel").selectOption("shopify");
  await expect(page.getByTestId("history-order-1")).toBeVisible();
  const scoped = new URL(state.requests.filter(path => path.startsWith("/api/picking/history?")).at(-1)!, "http://test").searchParams;
  expect(scoped.get("provider")).toBe("shopify");
  expect(scoped.get("offset")).toBe("0");
  await next();
  await expect(page.getByTestId("history-order-51")).toBeVisible();
  state.total = 1;
  await page.getByRole("button", { name: "Refresh history" }).click();
  await expect(page.getByTestId("history-order-1")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Picking history pages" })).toHaveCount(0);
  expect(state.errors).toEqual([]);
});

test("browsing picking history pauses the active queue poll and resumes it on return", async ({ page }) => {
  await page.clock.install();
  const state = await setup(page, "picking");
  await expect.poll(() => state.requests.filter(path => path === "/api/picking/queue").length).toBe(1);
  await page.getByTestId("filter-done").click();
  await expect(page.getByTestId("history-order-1")).toBeVisible();
  const queueReads = state.requests.filter(path => path === "/api/picking/queue").length;
  await page.clock.fastForward(30_000);
  expect(state.requests.filter(path => path === "/api/picking/queue")).toHaveLength(queueReads);
  expect(state.requests.filter(path => path.startsWith("/api/picking/history?"))).toHaveLength(1);
  await page.getByTestId("filter-done").click();
  await expect.poll(() => state.requests.filter(path => path === "/api/picking/queue").length).toBeGreaterThan(queueReads);
  expect(state.errors).toEqual([]);
});
