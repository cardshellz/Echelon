import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const harnessPath = "/__picking-hold-controls";

function heldOrder(warehouseStatus: "ready" | "in_progress", onHold = 0) {
  return {
    id: 101, orderNumber: "#HOLD-TEST", customerName: "Test order", warehouseStatus,
    onHold, assignedPickerId: warehouseStatus === "in_progress" ? "picker" : null,
    priority: 100, itemCount: 2, unitCount: 3, pickedCount: 1,
    orderPlacedAt: "2026-10-03T08:00:00.000Z", channelName: "Shopify", channelProvider: "shopify",
    items: [
      { id: 201, orderId: 101, sku: "PICKED-P1", name: "Already picked item", quantity: 1,
        pickedQuantity: 1, fulfilledQuantity: 1, status: "completed", onHold: false,
        requiresShipping: 1, location: "A-01", barcode: "PICKED-P1" },
      { id: 202, orderId: 101, sku: "HELD-C1000", name: "Held cases", quantity: 2,
        pickedQuantity: 0, fulfilledQuantity: 0, status: "pending", onHold: true,
        requiresShipping: 1, location: "F-03", barcode: "HELD-C1000" },
    ],
  };
}

async function mount(page: Page, warehouseStatus: "ready" | "in_progress", options: {
  failRemoveHold?: boolean;
  failReleaseAssignment?: boolean;
  orderHold?: boolean;
} = {}) {
  const order = heldOrder(warehouseStatus, options.orderHold ? 1 : 0);
  if (options.orderHold) order.items[1].onHold = false;
  const writes: Array<{ path: string; body: unknown }> = [];
  const unexpected: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem("pickingMode", "single");
    localStorage.setItem("pickerViewMode", "list");
    localStorage.setItem("soundTheme", "silent");
    localStorage.setItem("hapticEnabled", "false");
  });
  await page.routeWebSocket("**/ws", socket => socket.close());
  await page.route(`**${harnessPath}**`, route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
      <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script>
      </head><body><div id="root"></div><script type="module" src="/@fs/${resolve("test/browser/fixtures/picking-hold-controls-harness.tsx").replaceAll("\\", "/")}"></script></body></html>`,
  }));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      const replies: Record<string, unknown> = {
        "/api/auth/me": { user: { id: "picker", username: "picker", displayName: "Test picker", role: "admin" },
          permissions: ["orders:hold", "picking:view", "picking:perform"], roles: ["Administrator"] },
        "/api/picking/queue": [order],
        "/api/orders/exceptions": [],
        "/api/warehouses/1/fifo": { enabled: false },
        "/api/picking/corrections": [],
        "/api/picking/replen-bins": { replenBins: {} },
        "/api/warehouse/assembly-work/orders/101": { orderId: 101, orderNumber: "#HOLD-TEST", instructions: [] },
      };
      if (Object.prototype.hasOwnProperty.call(replies, path)) return route.fulfill({ json: replies[path] });
    } else {
      writes.push({ path, body: request.postDataJSON() });
      if (path === "/api/orders/101/items/202/release-hold") {
        if (options.failRemoveHold) return route.fulfill({ status: 409, json: { error: "Hold removal rejected by server" } });
        order.items[1].onHold = false;
        return route.fulfill({ json: { ok: true, heldShipmentId: 301, action: "push" } });
      }
      if (path === "/api/orders/101/release-hold") {
        order.onHold = 0;
        return route.fulfill({ json: order });
      }
      if (path === "/api/picking/orders/101/release") {
        if (options.failReleaseAssignment) return route.fulfill({ status: 409, json: { error: "Assignment release rejected by server" } });
        order.warehouseStatus = "ready";
        order.assignedPickerId = null;
        return route.fulfill({ json: order });
      }
      if (path === "/api/picking/orders/101/claim") return route.fulfill({ json: order });
    }
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: `Unexpected test request: ${path}` } });
  });
  await page.goto(harnessPath);
  await page.getByRole("button", { name: /^1 Hold$/ }).click();
  await expect(page.getByTestId("button-release-hold-101")).toBeVisible();
  return { order, writes, unexpected };
}

test("Remove hold targets the held line, not the picker assignment or previous picks", async ({ page }) => {
  const state = await mount(page, "in_progress");
  await expect(page.getByRole("button", { name: "Remove hold", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Release picking assignment", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Release", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Release order", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Force", exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("hold-and-release-controls.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Remove hold", exact: true }).click();
  await expect(page.getByText("Hold removed", { exact: true })).toBeVisible();
  expect(state.writes).toEqual([{ path: "/api/orders/101/items/202/release-hold", body: {} }]);
  expect(state.order).toMatchObject({ warehouseStatus: "in_progress", assignedPickerId: "picker", pickedCount: 1 });
  expect(state.order.items[0]).toMatchObject({ pickedQuantity: 1, fulfilledQuantity: 1 });
  expect(state.order.items[1]).toMatchObject({ onHold: false, pickedQuantity: 0, fulfilledQuantity: 0 });
  expect(state.unexpected).toEqual([]);
});

test("Release picking assignment leaves the item hold and picks intact", async ({ page }) => {
  const state = await mount(page, "in_progress");
  await page.getByRole("button", { name: "Release picking assignment", exact: true }).click();
  await expect(page.getByText("Picking assignment released", { exact: true })).toBeVisible();
  await expect(page.getByText("Picking assignment ended. Pick progress and holds are preserved.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Release picking assignment", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove hold", exact: true })).toBeVisible();
  expect(state.writes).toEqual([{ path: "/api/picking/orders/101/release", body: {} }]);
  expect(state.order).toMatchObject({ warehouseStatus: "ready", assignedPickerId: null, pickedCount: 1 });
  expect(state.order.items[0]).toMatchObject({ pickedQuantity: 1, fulfilledQuantity: 1 });
  expect(state.order.items[1]).toMatchObject({ onHold: true, pickedQuantity: 0, fulfilledQuantity: 0 });
  expect(state.unexpected).toEqual([]);
});

test("a held order not currently being picked only offers Remove hold", async ({ page }) => {
  const state = await mount(page, "ready");
  await expect(page.getByRole("button", { name: "Remove hold", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Release picking assignment", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("button-force-release-101")).toHaveCount(0);
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("whole-order hold removal uses the hold endpoint and names the correct result", async ({ page }) => {
  const state = await mount(page, "ready", { orderHold: true });
  await page.getByRole("button", { name: "Remove hold", exact: true }).click();
  await expect(page.getByText("The order hold on #HOLD-TEST has been removed.", { exact: true })).toBeVisible();
  expect(state.writes).toEqual([{ path: "/api/orders/101/release-hold", body: null }]);
  expect(state.order.items[0].pickedQuantity).toBe(1);
  expect(state.unexpected).toEqual([]);
});

test("failed hold removal stays held and does not fall back to releasing the order", async ({ page }) => {
  const state = await mount(page, "in_progress", { failRemoveHold: true });
  await page.getByRole("button", { name: "Remove hold", exact: true }).click();
  await expect(page.getByText("Couldn't remove hold", { exact: true })).toBeVisible();
  await expect(page.getByText("Hold removal rejected by server", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove hold", exact: true })).toBeEnabled();
  expect(state.order.items[1].onHold).toBe(true);
  expect(state.order.warehouseStatus).toBe("in_progress");
  expect(state.writes).toEqual([{ path: "/api/orders/101/items/202/release-hold", body: {} }]);
  expect(state.unexpected).toEqual([]);
});

test("failed picking release names the assignment and leaves the hold and picks alone", async ({ page }) => {
  const state = await mount(page, "in_progress", { failReleaseAssignment: true });
  await page.getByRole("button", { name: "Release picking assignment", exact: true }).click();
  await expect(page.getByText("Couldn't release picking assignment", { exact: true })).toBeVisible();
  await expect(page.getByText("Couldn't remove hold", { exact: true })).toHaveCount(0);
  expect(state.order).toMatchObject({ warehouseStatus: "in_progress", assignedPickerId: "picker", pickedCount: 1 });
  expect(state.order.items[0]).toMatchObject({ pickedQuantity: 1, fulfilledQuantity: 1 });
  expect(state.order.items[1]).toMatchObject({ onHold: true, pickedQuantity: 0, fulfilledQuantity: 0 });
  expect(state.writes).toEqual([{ path: "/api/picking/orders/101/release", body: {} }]);
  expect(state.unexpected).toEqual([]);
});

test("admin recovery explicitly warns that it also removes the whole-order hold", async ({ page }) => {
  const state = await mount(page, "in_progress");
  const confirmation = new Promise<string>(resolveMessage => {
    page.once("dialog", async dialog => {
      const message = dialog.message();
      await dialog.dismiss();
      resolveMessage(message);
    });
  });
  await page.getByRole("button", { name: "Recover stuck order", exact: true }).click();
  expect(await confirmation).toBe("Recover stuck order #HOLD-TEST? This ends the picking assignment and removes the whole-order hold. Pick progress and item holds are preserved.");
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("the active pick screen distinguishes Release picking assignment from a line's Remove hold menu", async ({ page }) => {
  const state = await mount(page, "in_progress");
  await page.getByTestId("card-order-101").click();
  await expect(page.getByTestId("button-release-active-order")).toHaveText("Release picking assignment");
  await expect(page.getByTestId("button-release-active-order")).toBeVisible();
  // Keep the complete label and view controls reachable on a pick gun, too.
  for (const id of ["button-release-active-order", "button-focus-view", "button-list-view"]) {
    const bounds = await page.getByTestId(id).boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
  await page.screenshot({ path: test.info().outputPath("active-pick-controls.png"), animations: "disabled" });
  await page.getByTestId("button-more-202").click();
  await expect(page.getByRole("menuitem", { name: "Remove hold", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Remove hold", exact: true }).click();
  await expect(page.getByText("Hold removed", { exact: true })).toBeVisible();
  expect(state.writes).toEqual([
    { path: "/api/picking/orders/101/claim", body: { claimSource: "active_resume" } },
    { path: "/api/orders/101/items/202/release-hold", body: {} },
  ]);
  expect(state.order.warehouseStatus).toBe("in_progress");
  expect(state.order.items[0]).toMatchObject({ pickedQuantity: 1, fulfilledQuantity: 1 });
  expect(state.unexpected).toEqual([]);
});
