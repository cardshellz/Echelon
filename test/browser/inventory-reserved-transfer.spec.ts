import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
async function setup(page: Page, lostResponse = false) {
  const state = {
    writes: [] as Record<string, unknown>[], moves: 0, errors: [] as string[]
  };
  const receipts = new Map<string, unknown>();
  let lost = false;
  page.on("pageerror", e => state.errors.push(e.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/inventory/transfer") {
      const body = request.postDataJSON();
      state.writes.push(body);
      if (body.moveReserved !== true)
        return route.fulfill({
          status: 409, json: {
            code: "TRANSFER_BLOCKED_BY_RESERVATION", error: "One case is reserved for order #64431", context: {
              needed: 1, onHandAtSource: 1, availableAtSource: 0, reservedAtSource: 1, sourceCode: "F-07", destCode: "F-06"
            }
          }
        });
      const previous = receipts.get(body.commandKey);
      if (previous)
        return route.fulfill({
          json: previous
        });
      const result = {
        success: true, reservedMoved: 1, orderItemsRepointed: 1
      };
      receipts.set(body.commandKey, result);
      state.moves++;
      if (lostResponse && !lost) {
        lost = true;
        return route.abort("connectionreset");
      }
      return route.fulfill({
        json: result
      });
    }
    if (url.pathname === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: "operator", username: "operator", role: "admin"
          }, roles: ["admin"], permissions: []
        }
      });
    if (url.pathname === "/api/warehouse/locations")
      return route.fulfill({
        json: [{
          id: 1237, code: "F-07", warehouseId: 1, isActive: 1, locationType: "pick"
        }, {
          id: 1236, code: "F-06", warehouseId: 1, isActive: 1, locationType: "pick"
        }]
      });
    if (url.pathname === "/api/warehouses")
      return route.fulfill({
        json: [{
          id: 1, code: "LEON", name: "Leonberg", isActive: 1
        }]
      });
    if (url.pathname === "/api/inventory/skus/search")
      return route.fulfill({
        json: [{
          variantId: 26, sku: "ESS-TOP-55PT-SLV-CLR-C1000", name: "Case of 1000", available: 0, reserved: 1, onHand: 1
        }]
      });
    return route.fulfill({
      json: []
    });
  });
  await page.route("**/__reserved-transfer-test**", route => route.fulfill({
    contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><main id="root"></main><script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/reserved-transfer-harness.tsx").replaceAll("\\", "/")}"></script></body></html>`
  }));
  await page.goto("/__reserved-transfer-test");
  return state;
}
async function prepare(page: Page, mobile: boolean) {
  if (mobile) {
    await page.getByTestId("input-source-location").fill("F-07");
    await page.getByTestId("button-next-source").click();
    await page.getByTestId("button-select-sku-ESS-TOP-55PT-SLV-CLR-C1000").click();
    await expect(page.getByText("1 on hand · 1 reserved · 0 available", {
      exact: true
    })).toBeVisible();
    await page.getByTestId("button-next-sku").click();
    await expect(page.getByTestId("input-quantity")).toHaveValue("1");
    await page.getByTestId("button-next-quantity").click();
    await page.getByTestId("input-dest-location").fill("F-06");
    await page.getByTestId("button-next-dest").click();
  }
  else {
    await page.getByTestId("input-source-search").fill("F-07");
    await page.getByRole("button", {
      name: /F-07/
    }).click();
    await expect(page.getByText("1 on hand · 1 reserved · 0 available", {
      exact: true
    })).toBeVisible();
    await page.getByTestId("input-dest-search").fill("F-06");
    await page.getByRole("button", {
      name: /F-06/
    }).click();
  }
}
async function confirm(page: Page) {
  await page.getByRole("button", {
    name: /^(Move Inventory|Confirm Transfer)$/
  }).click();
  await expect(page.getByRole("dialog")).toContainText("0");
  await page.getByRole("button", {
    name: "Move reserved too", exact: true
  }).click();
}
test("moves a fully reserved case after explicit confirmation while showing zero free stock", async ({ page }, info) => {
  const state = await setup(page);
  await prepare(page, info.project.name === "mobile");
  await confirm(page);
  await expect(page.getByText("Inventory moved. 1 reserved unit(s) followed the stock; 1 pending order line(s) re-pointed to the new bin.", {
    exact: true
  })).toBeVisible();
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]).toMatchObject({
    fromLocationId: 1237, toLocationId: 1236, variantId: 26, quantity: 1, moveReserved: true
  });
  expect(state.writes[1].commandKey).not.toBe(state.writes[0].commandKey);
  expect(state.moves).toBe(1);
  expect(state.errors).toEqual([]);
});
test("retries a lost reserved-move response with the original confirmed command key", async ({ page }, info) => {
  const state = await setup(page, true);
  await prepare(page, info.project.name === "mobile");
  await confirm(page);
  await expect(page.getByText(/request could not be completed/).first()).toBeVisible();
  await confirm(page);
  await expect(page.getByText("Inventory moved. 1 reserved unit(s) followed the stock; 1 pending order line(s) re-pointed to the new bin.", {
    exact: true
  })).toBeVisible();
  const confirmed = state.writes.filter(w => w.moveReserved === true);
  expect(confirmed).toHaveLength(2);
  expect(confirmed[1]).toEqual(confirmed[0]);
  expect(state.moves).toBe(1);
  expect(state.errors).toEqual([]);
});
