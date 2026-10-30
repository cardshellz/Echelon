import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CustomerReturnPreviewService } from "../../server/modules/returns/application/customer-return-preview.service";
import { validateCustomerReturnBoxPlan } from "../../server/modules/returns/application/customer-return-box-plan";
import type { CustomerAccountRequest } from "../../shared/customer-account/customer-account.contract";
import { customerReturnFlowReviewInputSchema } from "../../shared/returns/customer-return-flow.contract";
import { customerReturnSavedRequestSchema } from "../../client/src/lib/customer-return-customer";

// Exercise the actual shipped IIFE and scoped stylesheet, not a component with
// the staff app's global CSS. All transport is fictional and intercepted.
async function fixture(page: Page, options: { failReview?: boolean; lostSubmit?: boolean; holdReview?: Promise<void>; originalBox?: boolean; openReturn?: boolean; invalidateAfterFirstLookup?: boolean;
  actionState?: "refreshing" | "failed"; failReturnLookup?: boolean; holdReturnLookup?: Promise<void>; queuedWorkflow?: boolean; returnLookupOrderId?: number; noReturnQuantity?: boolean;
  savedRequestOutcome?: "rejected" | "unknown";
  blockRecoveryClear?: boolean;
} = {}) {
  const service = new CustomerReturnPreviewService();
  const { mode: _mode, scenarioId: _scenario, ...fields } = service.lookup({ scenarioId: "split_delivered", orderReference: "TEST-1001" });
  const order = { ...fields, sourceRevision: "a".repeat(64), lines: [
    { ...fields.lines[0], title: '3"x4" Toploader 35PT Clear Essentials + Easy Glide Combo Pack' },
    ...fields.lines.slice(1),
    { ...fields.lines[1], id: "membership", title: "Shellz Wholesale Club - Annual Membership", sku: "CLUB-ANNUAL", purchasedQuantity: 1, deliveredQuantity: 0, eligibleQuantity: 0, message: "This item does not require a return shipment." },
  ], boxOptions: options.originalBox ? [{ id: `box-${"b".repeat(64)}`, dimensions: { lengthMm: 254, widthMm: 203.2, heightMm: 101.6 },
    items: [{ lineId: fields.lines[0].id, quantity: fields.lines[0].eligibleQuantity }] }] : fields.boxOptions };
  const detail = { omsOrderId: options.returnLookupOrderId ?? 10,
    order: options.noReturnQuantity ? { ...order, lines: order.lines.map(line => ({ ...line, eligibleQuantity: 0,
      message: "The 365-day return window has ended." })) } : order, settingsVersion: 2 };
  const actionOrder = { connectionId: 4, omsOrderId: 10, orderNumber: "#TEST-1001", customerName: "Synthetic customer", customerEmail: null,
    activeOperationId: null, revision: "fixture", currency: "USD", eligibility: { editable: false, reasons: ["Picking or fulfillment has already started."] },
    lines: [], totalCents: 741, financialStatus: "Paid", warehouseStatus: "shipped", fulfillment: { code: "shipped", label: "Shipped" } };
  const status = { authorizationId: 20, authorizationNumber: "RMA-20", canProgress: false,
    parcels: [{ parcelId: 30, number: 1, status: "ready", trackingNumber: "FIXTURE-TRACK", downloadPath: "/api/returns/customer/returns/20/parcels/30/download" }] };
  if (options.savedRequestOutcome) {
    const saved = customerReturnSavedRequestSchema.parse({ version: 1, sessionKey: "a".repeat(43), omsOrderId: 10,
      authorizationId: null, input: { idempotencyKey: "20000000-0000-4000-8000-000000000001", sourceRevision: "b".repeat(64),
        settingsVersion: 2, selections: [{ lineId: fields.lines[0].id, quantity: 1, reasonCode: null }],
        parcels: [{ dimensions: { lengthMm: 254, widthMm: 203.2, heightMm: 152.4 }, originalBoxId: null,
          items: [{ lineId: fields.lines[0].id, quantity: 1 }] }] } });
    await page.addInitScript(record => sessionStorage.setItem(`customer-return-request:${record.sessionKey}`, JSON.stringify(record)), saved);
  }
  if (options.blockRecoveryClear) await page.addInitScript(() => {
    const original = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key: string) {
      if (key.startsWith("customer-return-request:")) throw new Error("Synthetic storage failure");
      return original.call(this, key);
    };
  });
  const calls: CustomerAccountRequest[] = [];
  const errors: string[] = [];
  let reviewFailed = false, returnLookupFailed = false, submitCount = 0, actionReads = 0;
  let workflowKey: string | null = null;
  let workflowInput: unknown = null, workflowReady = false;
  const workflowReply = () => ({ requestKey: workflowKey, omsOrderId: 10, phase: options.queuedWorkflow && !workflowReady ? "queued" : "ready", reason: null, labels: options.queuedWorkflow && !workflowReady ? null : status, updatedAt: "2026-10-30T12:00:00.000Z" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/return-layout-assets/*", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (!["csz-customer-account.js", "csz-customer-account.css"].includes(name)) return route.abort();
    return route.fulfill({ contentType: name.endsWith(".css") ? "text/css" : "text/javascript", body: await readFile(resolve("dist/customer-account", name)) });
  });
  await page.route("**/apps/echelon-returns/account", async (route) => {
    const input = route.request().postDataJSON() as CustomerAccountRequest;
    calls.push(input);
    if (input.path === "/account/bootstrap") return route.fulfill({ json: {
      session: { authenticated: true, privateTesting: true, sessionKey: "a".repeat(43) },
      connection: { connectionId: 4, channelId: 36, shopDomain: "fixture.myshopify.com", name: "Synthetic", enabled: true, paymentWindowMinutes: 30 },
    } });
    if (input.path === "/account/order-summaries") return route.fulfill({ json: {
      orders: [{ externalOrderId: "1001", orderReference: "#TEST-1001", omsOrderId: 10, currency: "USD", totalCents: 741, financialStatus: "Paid", cancelled: false, fulfillment: { code: "shipped", label: "Shipped" } }],
      unavailableExternalOrderIds: [], statusUnavailable: false,
    } });
    if (input.path === "/account/order-actions") {
      actionReads++;
      const ready = !options.actionState && (!options.invalidateAfterFirstLookup || actionReads===1);
      return route.fulfill({ json: { orders: [{ externalOrderId: "1001", orderReference: "#TEST-1001", omsOrderId: 10,
        state: ready ? "ready" : options.actionState ?? "refreshing", verifiedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 300_000).toISOString(),
        snapshot: ready ? { order: actionOrder, returnOrder: detail, orderFailed: false, returnFailed: false } : null }] } });
    }
    if (input.path === "/order-edits/orders/10") return route.fulfill({ json: {
      connectionId: 4, omsOrderId: 10, orderNumber: "#TEST-1001", customerName: "Synthetic customer", customerEmail: null, activeOperationId: null, revision: "fixture", currency: "USD",
      eligibility: { editable: false, reasons: ["Picking or fulfillment has already started."] }, lines: [], totalCents: 741, financialStatus: "Paid", warehouseStatus: "shipped", fulfillment: { code: "shipped", label: "Shipped" },
    } });
    if (input.path === "/returns/orders/10") {
      if (options.holdReturnLookup) await options.holdReturnLookup;
      if (options.failReturnLookup && !returnLookupFailed) {
        returnLookupFailed = true;
        return route.fulfill({ status: 503, json: { error: { code: "FIXTURE_RETURN_LOOKUP_FAILED" } } });
      }
      return route.fulfill({ json: detail });
    }
    if (input.path === "/returns/returns") return route.fulfill({ json: { returns: workflowReady ? [{ authorizationId: 20, authorizationNumber: "RMA-20", omsOrderId: 10, orderReference: "TEST-1001", createdAt: "2026-10-30T12:00:00.000Z" }] : [], nextBeforeAuthorizationId: null } });
    if (input.path === "/returns/returns/20") return route.fulfill({ json: status });
    if (input.path === "/returns/returns/20/parcels/30/download") return route.fulfill({ contentType: "application/pdf", body: "%PDF-1.4 synthetic account return label" });
    if (input.path === "/returns/orders/10/review") {
      if (options.holdReview) await options.holdReview;
      if (options.failReview && !reviewFailed) { reviewFailed = true; return route.fulfill({ status: 503, json: { error: { code: "FIXTURE_REVIEW_FAILED" } } }); }
      const body = customerReturnFlowReviewInputSchema.omit({ orderReference: true }).parse(input.body);
      const review = { effects: "none", orderReference: "TEST-1001", refundMethod: "manual_shopify",
        ...validateCustomerReturnBoxPlan(order.lines, { selections: body.selections, parcels: body.parcels }, order.boxOptions) };
      return route.fulfill({ json: { ...review, sourceRevision: order.sourceRevision,
        parcels: review.parcels.map(parcel => ({ ...parcel, items: parcel.items.map(item => ({ ...item, title: order.lines.find(line => line.id === item.lineId)!.title })) })) } });
    }
    if (input.path === "/returns/orders/10/label-requests" && input.method === "GET")
      return workflowKey !== null && options.queuedWorkflow && !workflowReady
        ? route.fulfill({ json: { workflow: workflowReply(), input: workflowInput } })
        : route.fulfill({ status: 404, json: { error: { code: "RETURN_WORKFLOW_NOT_FOUND" } } });
    if (input.path === "/returns/orders/10/label-requests") {
      submitCount++;
      workflowKey = (input.body as { idempotencyKey: string }).idempotencyKey;
      workflowInput = input.body;
      if (options.lostSubmit && submitCount === 1) return route.abort("failed");
      return route.fulfill({ json: workflowReply() });
    }
    if (input.path.startsWith("/returns/label-requests/")) {
      if (workflowKey === null) return route.fulfill({ status: 404, json: { error: { code: "RETURN_WORKFLOW_NOT_FOUND" } } });
      return route.fulfill({ json: workflowReply() });
    }
    if (input.path === "/returns/returns/20/label-requests") {
      return workflowKey ? route.fulfill({ json: workflowReply() })
        : route.fulfill({ status: 404, json: { error: { code: "RETURN_WORKFLOW_NOT_FOUND" } } });
    }
    if (input.path.startsWith("/returns/commands/")) {
      if (options.savedRequestOutcome) return route.fulfill({ status: options.savedRequestOutcome === "rejected" ? 409 : 503,
        json: { error: options.savedRequestOutcome === "rejected"
          ? { code: "RETURN_LABEL_SUBMISSION_REJECTED", reasonCode: "RETURN_LABEL_ALLOCATION_UNVERIFIED" }
          : { code: "FIXTURE_COMMAND_STATUS_UNAVAILABLE" } } });
      return route.fulfill({ json: status });
    }
    return route.fulfill({ status: 500, json: { error: { code: "UNEXPECTED_FIXTURE_ROUTE", message: input.path } } });
  });
  await page.route("**/__return-account-layout", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{margin:0;background:#f7f8fa;font-size:10px}h1,h2,h3{font:700 32px Impact,fantasy;text-transform:uppercase;margin:24px 0}h1{font-family:Impact,fantasy!important}button{font-family:Impact,fantasy}ol,ul{padding-left:32px}main{padding:24px}*{box-sizing:border-box}</style>
    <link rel="stylesheet" href="/return-layout-assets/csz-customer-account.css"></head><body><main data-csz-customer-account>
    <h1>Your account</h1><div data-csz-account-tools-status></div><table><tbody><tr data-csz-account-order data-external-order-id="1001" data-order-reference="#TEST-1001" data-fulfillment="fulfilled" data-cancelled="false"><td>#TEST-1001</td><td data-csz-order-fulfillment-native>Shipped</td><td data-csz-order-financial-native>Paid</td><td data-csz-order-total></td><td data-csz-order-panel-trigger></td></tr></tbody></table>
    </main><div id="csz-customer-account-tools"></div><script type="application/json" id="csz-customer-account-config">${JSON.stringify({ themeId: "174740308127", customerId: "100", proxyPath: "/apps/echelon-returns", loginPath: "/account/login" })}</script><script src="/return-layout-assets/csz-customer-account.js"></script></body></html>` }));
  await page.goto("/__return-account-layout");
  await page.getByRole("button", { name: "Manage order #TEST-1001" }).click();
  await expect(page.getByRole("button", { name: "Return items", exact: true })).toBeEnabled();
  if (options.openReturn !== false) {
    await page.getByRole("button", { name: "Return items", exact: true }).click();
    await expect(page.getByRole("heading", { name: "What would you like to return?" })).toBeVisible();
  }
  return { calls, errors, submitCount: () => submitCount, actionReads: () => actionReads, completeWorkflow: () => { workflowReady = true; } };
}

async function assertFrame(page: Page) {
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.locator(".csz-return-brand")).toHaveCount(1);
  await expect(page.locator(".csz-dialog-heading")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Close returns" })).toBeVisible();
  const measurements = await page.locator(".csz-return-ui").evaluate(root => {
    const heading = root.querySelector("h1")!;
    const title = root.querySelector(".csz-return-item-title");
    return { overflow: root.scrollWidth > root.clientWidth, font: getComputedStyle(heading).fontFamily, titleSize: title ? getComputedStyle(title).fontSize : null };
  });
  expect(measurements.overflow).toBe(false);
  expect(measurements.font).not.toMatch(/Impact|fantasy/i);
  if (measurements.titleSize) expect(measurements.titleSize).toBe("14px");
  const dialog = await page.getByRole("dialog").boundingBox();
  expect(dialog!.x).toBeGreaterThanOrEqual(0);
  expect(dialog!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

async function pack(page: Page, quantity = "1") {
  await page.getByRole("spinbutton", { name: /^Return quantity for item 1:/ }).fill(quantity);
  await page.getByRole("button", { name: "Continue to packing" }).click();
  await expect(page.getByRole("heading", { name: "How will you pack your return?" })).toBeVisible();
  await page.getByRole("combobox", { name: "Box size for box 1", exact: true }).selectOption({ index: 1 });
}

test("compiled account returns use one frame, aligned controls and readable storefront-independent type", async ({ page }, info) => {
  const f = await fixture(page);
  await assertFrame(page);
  const steps = await page.getByRole("list", { name: "Return steps" }).locator("li").all();
  const widths = await Promise.all(steps.map(step => step.boundingBox()));
  expect(Math.max(...widths.map(box => box!.width)) - Math.min(...widths.map(box => box!.width))).toBeLessThan(2);
  await expect(page.getByRole("spinbutton", { name: /Annual Membership/ })).toBeDisabled();
  await page.screenshot({ path: info.outputPath("return-items.png"), fullPage: true });
  await pack(page);
  await assertFrame(page);
  await page.screenshot({ path: info.outputPath("return-packing.png"), fullPage: true });
  await page.getByRole("button", { name: "Review return", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review your return", exact: true })).toBeVisible();
  await assertFrame(page);
  await page.screenshot({ path: info.outputPath("return-review.png"), fullPage: true });
  await page.getByRole("button", { name: "Back to packing" }).click();
  await page.getByRole("button", { name: "Back to items" }).click();
  await expect(page.getByRole("spinbutton", { name: /^Return quantity for item 1:/ })).toHaveValue("1");
  expect(f.calls.some(call => call.commandKey)).toBe(false);
  expect(f.errors).toEqual([]);
});

test("an already-loaded order panel opens with its return action without workflow inspection", async ({ page }) => {
  const f = await fixture(page, { openReturn: false });
  await page.getByRole("button", { name: "Close order options" }).click();
  const before = f.calls.length;
  await page.getByRole("button", { name: "Manage order #TEST-1001" }).click();
  await expect(page.getByRole("button", { name: "Return items", exact: true })).toBeEnabled({ timeout: 250 });
  expect(f.calls.slice(before)).toEqual([]);
  expect(f.calls.filter(call => call.path.startsWith("/order-edits/") || /^\/returns\/orders\//.test(call.path))).toEqual([]);
});

test("local invalidation keeps return navigation available without inspecting providers on panel open", async ({ page }) => {
  await page.clock.install({ time: new Date() });
  const f = await fixture(page, { openReturn: false, invalidateAfterFirstLookup: true });
  await page.getByRole("button", { name: "Close order options" }).click();
  await page.clock.fastForward(30_000);
  await expect.poll(f.actionReads).toBe(2);
  await page.getByRole("button", { name: "Manage order #TEST-1001" }).click();
  await expect(page.getByRole("button", { name: "Return items", exact: true })).toBeEnabled({ timeout: 250 });
  await expect(page.getByText("Order options are being refreshed. Your order has not changed.", { exact: true })).toHaveCount(0);
  expect(f.calls.filter(call => call.path.startsWith("/order-edits/") || /^\/returns\/orders\//.test(call.path))).toEqual([]);
  await page.getByRole("button", { name: "Return items", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What would you like to return?" })).toBeVisible();
  expect(f.calls.filter(call => call.path === "/returns/orders/10")).toHaveLength(1);
  expect(f.submitCount()).toBe(0);
  expect(f.errors).toEqual([]);
});

for (const actionState of ["refreshing", "failed"] as const) {
  test(`${actionState} options open the return flow immediately and a failed lookup can retry`, async ({ page }, info) => {
    let release!: () => void;
    const holdReturnLookup = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(page, { openReturn: false, actionState, failReturnLookup: true, holdReturnLookup });
    expect(f.calls.filter(call => call.path === "/returns/orders/10")).toHaveLength(0);
    await page.getByRole("button", { name: "Return items", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Return items", exact: true })).toBeVisible({ timeout: 250 });
    await expect(page.getByText("Loading return items…", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
    release();
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByRole("heading", { name: "What would you like to return?" })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`return-cache-${actionState}-recovered.png`), fullPage: true });
    await pack(page);
    await page.getByRole("button", { name: "Review return", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Review your return", exact: true })).toBeVisible();
    expect(f.calls.filter(call => call.path === "/returns/orders/10")).toHaveLength(2);
    expect(f.calls.filter(call => call.path.endsWith("/review"))).toHaveLength(1);
    expect(f.submitCount()).toBe(0);
    expect(f.calls.some(call => call.commandKey)).toBe(false);
    expect(f.errors).toEqual([]);
  });
}

test("a fresh return lookup still enforces policy exclusions during a cache refresh", async ({ page }) => {
  const f = await fixture(page, { actionState: "refreshing", noReturnQuantity: true });
  await expect(page.getByRole("spinbutton", { name: /^Return quantity for item 1:/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Continue to packing", exact: true })).toBeDisabled();
  await expect(page.getByTestId("preview-line-sample-line-1").getByText("The 365-day return window has ended.", { exact: true })).toBeVisible();
  expect(f.submitCount()).toBe(0);
  expect(f.calls.some(call => call.path.endsWith("/review"))).toBe(false);
  expect(f.errors).toEqual([]);
});

test("a mismatched fresh return response cannot expose another order's items", async ({ page }) => {
  const f = await fixture(page, { openReturn: false, actionState: "refreshing", returnLookupOrderId: 11 });
  await page.getByRole("button", { name: "Return items", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Choose it again");
  await expect(page.getByRole("heading", { name: "What would you like to return?" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeEnabled();
  expect(f.submitCount()).toBe(0);
  expect(f.errors).toEqual([]);
});

test("an old definitively rejected request can be left and restarted while cached options remain refreshing", async ({ page }) => {
  const f = await fixture(page, { openReturn: false, actionState: "refreshing", savedRequestOutcome: "rejected" });
  await page.getByRole("button", { name: "Return items", exact: true }).click();
  await expect(page.getByRole("heading", { name: "We couldn’t finish your return", exact: true })).toBeVisible();
  expect(f.calls.filter(call => call.path === "/returns/orders/10")).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Back to your orders", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  expect(await page.evaluate(() => sessionStorage.getItem(`customer-return-request:${"a".repeat(43)}`))).toBeNull();
  await expect(page.getByRole("heading", { name: "What would you like to return?" })).toBeVisible();
  await pack(page);
  await page.getByRole("button", { name: "Review return", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review your return", exact: true })).toBeVisible();
  expect(f.calls.filter(call => call.path === "/returns/orders/10")).toHaveLength(1);
  expect(f.submitCount()).toBe(0);
  expect(f.errors).toEqual([]);
});

for (const cache of ["ready", "refreshing"] as const) {
  test(`a saved rejection offers direct fresh review and a new explicit request with ${cache} options`, async ({ page }, info) => {
    const f = await fixture(page, { openReturn: false, actionState: cache === "ready" ? undefined : cache,
      savedRequestOutcome: "rejected" });
    await page.getByRole("button", { name: "Return items", exact: true }).click();
    await expect(page.getByRole("heading", { name: "We couldn’t finish your return", exact: true })).toBeVisible();
    await expect(page.getByText(/saved result of an earlier attempt/)).toHaveCount(0);
    await expect(page.getByText(/original shipment/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Check status", exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`saved-rejection-${cache}.png`), fullPage: true });
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(page.getByRole("heading", { name: "What would you like to return?" })).toBeVisible();
    expect(f.calls.filter(call => call.path === "/returns/orders/10")).toHaveLength(1);
    expect(await page.evaluate(() => sessionStorage.getItem(`customer-return-request:${"a".repeat(43)}`))).toBeNull();
    await pack(page);
    await page.getByRole("button", { name: "Review return", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Review your return", exact: true })).toBeVisible();
    expect(f.submitCount()).toBe(0);
    await page.getByRole("button", { name: "Get return labels", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Return RMA-20", exact: true })).toBeVisible();
    const submissions = f.calls.filter(call => call.path === "/returns/orders/10/label-requests" && call.method === "POST");
    expect(submissions).toHaveLength(1);
    expect(submissions[0].body).toMatchObject({ sourceRevision: "a".repeat(64), settingsVersion: 2 });
    expect((submissions[0].body as { idempotencyKey: string }).idempotencyKey).not.toBe("20000000-0000-4000-8000-000000000001");
    expect(f.calls.some(call => /\/commands\/.+\/resume$/.test(call.path))).toBe(false);
    expect(f.errors).toEqual([]);
  });
}

test("fresh review after a saved rejection can retry an unavailable order lookup", async ({ page }) => {
  const f = await fixture(page, { openReturn: false, actionState: "refreshing", savedRequestOutcome: "rejected", failReturnLookup: true });
  await page.getByRole("button", { name: "Return items", exact: true }).click();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What would you like to return?" })).toBeVisible();
  expect(f.calls.filter(call => call.path === "/returns/orders/10")).toHaveLength(2);
  expect(f.submitCount()).toBe(0);
  expect(f.errors).toEqual([]);
});

test("failed local recovery clearing cannot discard a saved request or start a fresh one", async ({ page }) => {
  const f = await fixture(page, { openReturn: false, actionState: "refreshing", savedRequestOutcome: "rejected", blockRecoveryClear: true });
  await page.getByRole("button", { name: "Return items", exact: true }).click();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("could not be cleared");
  expect(await page.evaluate(() => sessionStorage.getItem(`customer-return-request:${"a".repeat(43)}`))).not.toBeNull();
  expect(f.calls.filter(call => call.path === "/returns/orders/10")).toHaveLength(0);
  expect(f.submitCount()).toBe(0);
  expect(f.errors).toEqual([]);
});

test("an unknown prior request remains recoverable and cannot be discarded to bypass its outcome", async ({ page }) => {
  const f = await fixture(page, { openReturn: false, actionState: "refreshing", savedRequestOutcome: "unknown" });
  await page.getByRole("button", { name: "Return items", exact: true }).click();
  await expect(page.getByRole("heading", { name: "We couldn’t finish your return", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Review return items", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back to your orders", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem(`customer-return-request:${"a".repeat(43)}`))).not.toBeNull();
  expect(f.calls.filter(call => call.path === "/returns/orders/10")).toHaveLength(0);
  expect(f.submitCount()).toBe(0);
  expect(f.errors).toEqual([]);
});

test("verified original dimensions are the default and Change box reveals prefilled editable fields", async ({ page }, info) => {
  const f = await fixture(page, { originalBox: true });
  await page.getByRole("spinbutton", { name: /^Return quantity for item 1:/ }).fill("1");
  await page.getByRole("button", { name: "Continue to packing" }).click();
  await expect(page.getByText("Using your original shipping box", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Length of box 1 in inches" })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("original-box-default.png"), fullPage: true });
  await page.getByRole("button", { name: "Review return", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review your return", exact: true })).toBeVisible();
  const firstReview = f.calls.find(call => call.path.endsWith("/review"))!;
  expect((firstReview.body as { parcels: { originalBoxId: string; dimensions: unknown }[] }).parcels[0])
    .toMatchObject({ originalBoxId: `box-${"b".repeat(64)}`, dimensions: { lengthMm: 254, widthMm: 203.2, heightMm: 101.6 } });
  await page.getByRole("button", { name: "Back to packing" }).click();
  await page.getByRole("button", { name: "Change size for box 1" }).click();
  await expect(page.getByRole("textbox", { name: "Length of box 1 in inches" })).toHaveValue("10");
  await expect(page.getByRole("textbox", { name: "Width of box 1 in inches" })).toHaveValue("8");
  await expect(page.getByRole("textbox", { name: "Height of box 1 in inches" })).toHaveValue("4");
  await page.screenshot({ path: info.outputPath("original-box-change.png"), fullPage: true });
  await page.getByRole("textbox", { name: "Length of box 1 in inches" }).fill("12");
  await page.getByRole("button", { name: "Review return", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review your return", exact: true })).toBeVisible();
  const lastReview = f.calls.filter(call => call.path.endsWith("/review")).at(-1)!;
  expect((lastReview.body as { parcels: { originalBoxId: null; dimensions: unknown }[] }).parcels[0])
    .toMatchObject({ originalBoxId: null, dimensions: { lengthMm: 304.8, widthMm: 203.2, heightMm: 101.6 } });
  expect(f.calls.some(call => call.commandKey)).toBe(false);
});

test("packing edits stay in the return window and restore focus without a second modal", async ({ page }) => {
  const f = await fixture(page);
  await pack(page, "3");
  await page.getByRole("button", { name: "Split box 1", exact: true }).click();
  const editor = page.getByRole("region", { name: "Pack a new box", exact: true });
  await expect(editor).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Your boxes", exact: true })).not.toBeVisible();
  await editor.getByRole("button", { name: /^Add .* to new box$/ }).click();
  await editor.getByRole("button", { name: "Create box", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Box 2", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Split box 1", exact: true }).click();
  await expect(editor).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(f.errors).toEqual([]);
});

test("review failures preserve packing and a lost synthetic submission recovers into the same frame", async ({ page }, info) => {
  const f = await fixture(page, { failReview: true, lostSubmit: true });
  await pack(page);
  await page.getByRole("button", { name: "Review return", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("heading", { name: "How will you pack your return?" })).toBeVisible();
  await page.getByRole("button", { name: "Review return", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review your return", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Get return labels", exact: true }).click();
  await expect(page.getByRole("heading", { name: "We couldn’t finish your return", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Return RMA-20", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download label for box 1" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.locator(".csz-return-brand")).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("return-labels.png"), fullPage: true });
  expect(f.submitCount()).toBe(1);
  expect(f.errors).toEqual([]);
});

test("queued work survives closing the modal and loss of browser storage, then exposes the same downloadable label", async ({ page }) => {
  const f = await fixture(page, { queuedWorkflow: true });
  await pack(page); await page.getByRole("button", { name: "Review return", exact: true }).click();
  await page.getByRole("button", { name: "Get return labels", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Getting your return label", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close returns", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Close returns", exact: true }).click();
  await page.evaluate(() => sessionStorage.clear());
  await page.getByRole("button", { name: "Manage order #TEST-1001" }).click();
  await page.getByRole("button", { name: "Return items", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Getting your return label", exact: true })).toBeVisible();
  f.completeWorkflow();
  await expect(page.getByRole("button", { name: "Download label for box 1", exact: true })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download label for box 1", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("return-20-box-30.pdf");
  expect(f.submitCount()).toBe(1);
  expect(f.calls.some(call => call.path.endsWith("/progress") || call.path.endsWith("/resume"))).toBe(false);
  expect(f.errors).toEqual([]);
});

test("the return window cannot be dismissed during a pending review", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(page, { holdReview: held });
  await pack(page);
  await page.getByRole("button", { name: "Review return", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close returns" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  release();
  await expect(page.getByRole("heading", { name: "Review your return", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close returns" })).toBeEnabled();
  expect(f.calls.some(call => call.commandKey)).toBe(false);
  expect(f.errors).toEqual([]);
});
