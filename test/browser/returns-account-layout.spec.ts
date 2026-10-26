import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CustomerReturnPreviewService } from "../../server/modules/returns/application/customer-return-preview.service";
import type { CustomerAccountRequest } from "../../shared/customer-account/customer-account.contract";
import { customerReturnFlowReviewInputSchema } from "../../shared/returns/customer-return-flow.contract";

// Exercise the actual shipped IIFE and scoped stylesheet, not a component with
// the staff app's global CSS. All transport is fictional and intercepted.
async function fixture(page: Page, options: { failReview?: boolean; lostSubmit?: boolean; holdReview?: Promise<void> } = {}) {
  const service = new CustomerReturnPreviewService();
  const { mode: _mode, scenarioId: _scenario, ...fields } = service.lookup({ scenarioId: "split_delivered", orderReference: "TEST-1001" });
  const order = { ...fields, sourceRevision: "a".repeat(64), lines: [
    { ...fields.lines[0], title: '3"x4" Toploader 35PT Clear Essentials + Easy Glide Combo Pack' },
    ...fields.lines.slice(1),
    { ...fields.lines[1], id: "membership", title: "Shellz Wholesale Club - Annual Membership", sku: "CLUB-ANNUAL", purchasedQuantity: 1, deliveredQuantity: 0, eligibleQuantity: 0, message: "This item does not require a return shipment." },
  ] };
  const detail = { omsOrderId: 10, order, settingsVersion: 2 };
  const status = { authorizationId: 20, authorizationNumber: "RMA-20", canProgress: false,
    parcels: [{ parcelId: 30, number: 1, status: "ready", trackingNumber: "FIXTURE-TRACK", downloadPath: "/api/returns/customer/returns/20/parcels/30/download" }] };
  const calls: CustomerAccountRequest[] = [];
  const errors: string[] = [];
  let reviewFailed = false, submitCount = 0;
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
    if (input.path === "/order-edits/orders/10") return route.fulfill({ json: {
      connectionId: 4, omsOrderId: 10, orderNumber: "#TEST-1001", customerName: "Synthetic customer", customerEmail: null, activeOperationId: null, revision: "fixture", currency: "USD",
      eligibility: { editable: false, reasons: ["Picking or fulfillment has already started."] }, lines: [], totalCents: 741, financialStatus: "Paid", warehouseStatus: "shipped", fulfillment: { code: "shipped", label: "Shipped" },
    } });
    if (input.path === "/returns/orders/10") return route.fulfill({ json: detail });
    if (input.path === "/returns/returns") return route.fulfill({ json: { returns: [], nextBeforeAuthorizationId: null } });
    if (input.path === "/returns/orders/10/review") {
      if (options.holdReview) await options.holdReview;
      if (options.failReview && !reviewFailed) { reviewFailed = true; return route.fulfill({ status: 503, json: { error: { code: "FIXTURE_REVIEW_FAILED" } } }); }
      const body = customerReturnFlowReviewInputSchema.omit({ orderReference: true }).parse(input.body);
      const { mode: _reviewMode, ...review } = service.review({ scenarioId: "split_delivered", orderReference: "TEST-1001", selections: body.selections, parcels: body.parcels });
      return route.fulfill({ json: { ...review, sourceRevision: order.sourceRevision,
        parcels: review.parcels.map(parcel => ({ ...parcel, items: parcel.items.map(item => ({ ...item, title: order.lines.find(line => line.id === item.lineId)!.title })) })) } });
    }
    if (input.path === "/returns/orders/10/returns") {
      submitCount++;
      if (options.lostSubmit && submitCount === 1) return route.abort("failed");
      return route.fulfill({ json: status });
    }
    if (input.path.startsWith("/returns/commands/")) return route.fulfill({ json: status });
    return route.fulfill({ status: 500, json: { error: { code: "UNEXPECTED_FIXTURE_ROUTE", message: input.path } } });
  });
  await page.route("**/__return-account-layout", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{margin:0;background:#f7f8fa;font-size:10px}h1,h2,h3{font:700 32px Impact,fantasy;text-transform:uppercase;margin:24px 0}button{font-family:Impact,fantasy}ol,ul{padding-left:32px}main{padding:24px}*{box-sizing:border-box}</style>
    <link rel="stylesheet" href="/return-layout-assets/csz-customer-account.css"></head><body><main data-csz-customer-account>
    <h1>Your account</h1><div data-csz-account-tools-status></div><table><tbody><tr data-csz-account-order data-external-order-id="1001" data-order-reference="#TEST-1001" data-fulfillment="fulfilled" data-cancelled="false"><td>#TEST-1001</td><td data-csz-order-fulfillment-native>Shipped</td><td data-csz-order-financial-native>Paid</td><td data-csz-order-total></td><td data-csz-order-panel-trigger></td></tr></tbody></table>
    </main><div id="csz-customer-account-tools"></div><script type="application/json" id="csz-customer-account-config">${JSON.stringify({ themeId: "174740308127", customerId: "100", proxyPath: "/apps/echelon-returns", loginPath: "/account/login" })}</script><script src="/return-layout-assets/csz-customer-account.js"></script></body></html>` }));
  await page.goto("/__return-account-layout");
  await page.getByRole("button", { name: "Manage order #TEST-1001" }).click();
  await page.getByRole("button", { name: "Return items", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What would you like to return?" })).toBeVisible();
  return { calls, errors, submitCount: () => submitCount };
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
  await expect(page.getByRole("heading", { name: "Checking your return", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Return RMA-20", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download label for box 1" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.locator(".csz-return-brand")).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("return-labels.png"), fullPage: true });
  expect(f.submitCount()).toBe(1);
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
