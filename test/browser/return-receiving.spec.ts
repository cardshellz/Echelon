import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// Actual Returns page and shared persisted-command requester, mocked HTTP.
// Exact SQL admission/rollback/replay is covered by lot-cost-ownership.integration.
async function setup(page: Page, failure: "lost-response" | "invalid-success" | "different-success", orderQuantity = 4) {
  const state = { writes: [] as string[],committed: false,errors: [] as string[],unexpected: [] as string[] };
  page.on("pageerror",error=>state.errors.push(error.message));
  await page.route("**/*",route=>new URL(route.request().url()).hostname==="127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/api/**",async route=> {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (request.method()==="POST" && path==="/api/returns/process") {
      state.writes.push(request.postData()!); state.committed=true;
      const result = { orderId: 61,processed: 1,sellable: 1,damaged: 0,totalBaseUnitsReturned: 5,
        items: [{ orderItemId: 71,productVariantId: 101,qty: 1,condition: "sellable",baseUnitsReturned: 5 }] };
      if (state.writes.length===1) {
        if (failure==="lost-response") return route.abort("failed");
        return route.fulfill({ json: failure==="invalid-success" ? { processed: "wrong" } : { ...result,orderId: 62 } });
      }
      return route.fulfill({ json: result });
    }
    if (request.method()==="GET" && path==="/api/auth/me") return route.fulfill({ json: {
      user: { id: "return-operator",username: "operator",role: "admin" },permissions: ["inventory:view","inventory:adjust"],roles: ["admin"],
    } });
    if (request.method()==="GET" && path==="/api/warehouse/locations") return route.fulfill({ json: [
      { id: 30,code: "RETURNS",warehouseId: 1,isActive: 1,locationType: "pick",zone: "R",name: "" },
    ] });
    if (request.method()==="GET" && path==="/api/returns/order-lookup/WMS-61") return route.fulfill({ json: {
      order: { id: 61,orderNumber: "WMS-61",customerName: "Synthetic customer",orderPlacedAt: null,warehouseStatus: "shipped",totalAmount: 100 },
      items: [{ id: 71,sku: "COST-P5",name: "Synthetic pack",quantity: orderQuantity,productVariantId: 101 }],
      returnHistory: state.committed ? [{ orderItemId: 71,sku: "COST-P5",qty: 1,condition: "sellable",returnedAt: "2026-10-05T12:00:00Z" }] : [],
    } });
    state.unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 500,json: { error: "Unexpected request" } });
  });
  await page.route("**/__return-receiving-test**",route=>route.fulfill({ contentType: "text/html",body:
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
    <body><main id="root"></main><script type="module" src="/@fs/${resolve(process.cwd(),"test/browser/fixtures/return-receiving-harness.tsx").replaceAll("\\","/")}"></script></body></html>` }));
  await page.goto("/__return-receiving-test"); return state;
}

async function enterReturn(page: Page) {
  await page.getByPlaceholder("Enter order number...").fill("WMS-61");
  await page.getByRole("button",{ name: "Search",exact: true }).click();
  await expect(page.getByText("Order WMS-61",{ exact: true })).toBeVisible();
  await page.getByRole("checkbox").check();
  await page.getByRole("spinbutton").fill("1");
  await page.getByRole("combobox").last().click();
  await page.getByRole("option",{ name: "RETURNS",exact: true }).click();
}

for (const failure of ["lost-response","invalid-success","different-success"] as const) {
  test(`recovers the exact full return after ${failure} without creating another physical intent`,async ({ page })=> {
    const state = await setup(page,failure,1); await enterReturn(page);
    await page.getByRole("button",{ name: "Process Return (1 item)",exact: true }).click();
    await expect(page.getByText("Error",{ exact: true })).toBeVisible();
    await page.reload();
    await page.getByPlaceholder("Enter order number...").fill("WMS-61");
    await page.getByRole("button",{ name: "Search",exact: true }).click();
    await expect(page.getByText("Order WMS-61",{ exact: true })).toBeVisible();
    await expect(page.getByRole("checkbox")).toBeDisabled();
    await page.getByRole("button",{ name: "Check return result",exact: true }).click();
    await expect(page.getByText("Return processed",{ exact: true })).toBeVisible();
    expect(state.writes).toHaveLength(2); expect(state.writes[1]).toBe(state.writes[0]);
    expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
  });
  test(`replays the exact committed partial return after ${failure} and a page reload`,async ({ page },testInfo)=> {
    const state = await setup(page,failure); await enterReturn(page);
    await page.getByRole("button",{ name: "Process Return (1 item)",exact: true }).click();
    await expect(page.getByText("Error",{ exact: true })).toBeVisible();
    await page.reload(); await enterReturn(page);
    await page.getByRole("button",{ name: "Process Return (1 item)",exact: true }).click();
    await expect(page.getByText("Return processed",{ exact: true })).toBeVisible();
    expect(state.writes).toHaveLength(2); expect(state.writes[1]).toBe(state.writes[0]);
    expect(JSON.parse(state.writes[0])).toMatchObject({ orderId: 61,warehouseLocationId: 30,
      commandKey: expect.stringMatching(/^inventory:/),items: [{ orderItemId: 71,productVariantId: 101,qty: 1,condition: "sellable" }] });
    expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("replayed-return.png"),fullPage: true });
  });
}
