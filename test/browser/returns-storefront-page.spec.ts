import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CustomerReturnPreviewService } from "../../server/modules/returns/application/customer-return-preview.service";
import { validateCustomerReturnBoxPlan } from "../../server/modules/returns/application/customer-return-box-plan";
import { customerReturnFlowReviewInputSchema } from "../../shared/returns/customer-return-flow.contract";
import type { CustomerAccountRequest } from "../../shared/customer-account/customer-account.contract";

// Actual compiled theme assets; every service call is synthetic and intercepted.
async function fixture(page: Page, options: { guest?: boolean; invalid?: boolean; bootstrapFailure?: "session" | "service"; loseSubmit?: boolean } = {}) {
  const calls: CustomerAccountRequest[] = [], errors: string[] = [], external: string[] = [];
  const { mode: _mode, scenarioId: _scenario, ...fields } = new CustomerReturnPreviewService().lookup({ scenarioId: "split_delivered", orderReference: "TEST-1001" });
  const order = { ...fields, sourceRevision: "a".repeat(64), boxOptions: [{ id: `box-${"b".repeat(64)}`,
    dimensions: { lengthMm: 254, widthMm: 203.2, heightMm: 101.6 }, items: [{ lineId: fields.lines[0].id, quantity: 1 }] }] };
  const labels = { authorizationId: 20, authorizationNumber: "RMA-20", canProgress: false,
    parcels: [{ parcelId: 30, number: 1, status: "ready", trackingNumber: "SYNTHETIC-TRACK", downloadPath: "/api/returns/customer/returns/20/parcels/30/download" }] };
  let saved: { idempotencyKey: string } | null = null, ready = false, submissions = 0, bootstrapReads = 0;
  const workflow = () => ({ requestKey: saved!.idempotencyKey, omsOrderId: 10, phase: ready ? "ready" : "queued",
    reason: null, labels: ready ? labels : null, updatedAt: "2026-11-01T12:00:00.000Z" });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  await page.route("**/__portal-assets/*", async route => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (!["csz-return-portal.js", "csz-return-portal.css"].includes(name)) return route.abort();
    return route.fulfill({ contentType: name.endsWith(".css") ? "text/css" : "text/javascript", body: await readFile(resolve("dist/customer-return-portal", name)) });
  });
  await page.route("**/apps/echelon-returns/account", async route => {
    const input = route.request().postDataJSON() as CustomerAccountRequest;
    calls.push(input);
    expect(input.expectedCustomerId).toBe("100");
    if (input.path === "/account/bootstrap") {
      bootstrapReads++;
      if (options.bootstrapFailure && bootstrapReads === 1) return route.fulfill({ status: options.bootstrapFailure === "session" ? 401 : 503,
        json: { error: { code: options.bootstrapFailure === "session" ? "CUSTOMER_ACCOUNT_SIGN_IN_REQUIRED" : "CUSTOMER_ACCOUNT_REQUEST_FAILED", message: "Synthetic failure" } } });
      return route.fulfill({ json: { session: { authenticated: true, privateTesting: false, sessionKey: "a".repeat(43) },
        connection: { connectionId: 4, channelId: 2, name: "Shopify", shopDomain: "fixture.myshopify.com", enabled: true, paymentWindowMinutes: 30 } } });
    }
    expect(input.sessionKey).toBe("a".repeat(43));
    if (input.path === "/returns/order-options") return route.fulfill({ json: { orders: [{ omsOrderId: 10, orderReference: "TEST-1001", purchasedAt: null, eligibleItemCount: 1 }], nextBeforeOmsOrderId: null } });
    if (input.path === "/returns/returns") return route.fulfill({ json: { returns: [{ authorizationId: 20, authorizationNumber: "RMA-20", omsOrderId: 10, orderReference: "TEST-1001", createdAt: "2026-11-01T12:00:00Z" }], nextBeforeAuthorizationId: null } });
    if (input.path === "/returns/orders/10/label-requests" && input.method === "GET") return saved
      ? route.fulfill({ json: { workflow: workflow(), input: saved } })
      : route.fulfill({ status: 404, json: { error: { code: "RETURN_WORKFLOW_NOT_FOUND" } } });
    if (input.path === "/returns/orders/10") return route.fulfill({ json: { omsOrderId: 10, settingsVersion: 2, order } });
    if (input.path === "/returns/orders/10/review") {
      const body = customerReturnFlowReviewInputSchema.omit({ orderReference: true }).parse(input.body);
      const review = validateCustomerReturnBoxPlan(order.lines, { selections: body.selections, parcels: body.parcels }, order.boxOptions);
      return route.fulfill({ json: { effects: "none", orderReference: "TEST-1001", refundMethod: "manual_shopify", ...review, sourceRevision: order.sourceRevision,
        parcels: review.parcels.map(parcel => ({ ...parcel, items: parcel.items.map(item => ({ ...item, title: order.lines.find(line => line.id === item.lineId)!.title })) })) } });
    }
    if (input.path === "/returns/orders/10/label-requests") {
      saved = input.body as { idempotencyKey: string }; submissions++;
      if (options.loseSubmit && submissions === 1) return route.abort("failed");
      return route.fulfill({ json: workflow() });
    }
    if (input.path.startsWith("/returns/label-requests/")) return route.fulfill({ json: workflow() });
    if (input.path === "/returns/returns/20") return route.fulfill({ json: labels });
    if (input.path === "/returns/returns/20/label-requests") return route.fulfill({ status: 404, json: { error: { code: "RETURN_WORKFLOW_NOT_FOUND" } } });
    if (input.path === "/returns/returns/20/parcels/30/download") return route.fulfill({ contentType: "application/pdf", body: "%PDF-1.4 Synthetic label" });
    return route.fulfill({ status: 500, json: { error: { code: "UNEXPECTED_FIXTURE_ROUTE", message: input.path } } });
  });
  await page.route("**/pages/start-a-return*", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{margin:0;font:10px Impact,fantasy}h1{font:40px Impact,fantasy!important}button{font-family:Impact,fantasy}#store-header{height:60px;background:#132135;color:white}#store-footer{padding:20px}</style>
    <link rel="stylesheet" href="/__portal-assets/csz-return-portal.css"></head><body>
    <header id="store-header"><a href="/">Store navigation</a></header><main><div id="csz-return-portal" class="csz-account-ui csz-return-page"></div></main>
    <footer id="store-footer">Store footer</footer><script type="application/json" id="csz-return-portal-config">${JSON.stringify({ themeId: "174740308127", customerId: options.guest ? null : "100", proxyPath: options.invalid ? "https://evil.test/apps/returns" : "/apps/echelon-returns", loginPath: "/account/login", logoutPath: "/account/logout" })}</script>
    <script src="/__portal-assets/csz-return-portal.js"></script></body></html>` }));
  await page.goto("/pages/start-a-return?preview_theme_id=174740308127&view=return-portal");
  return { calls, errors, external, complete: () => { ready = true; }, submissions: () => submissions };
}

async function assertStoreFrame(page: Page) {
  await expect(page.locator("#store-header")).toBeVisible();
  await expect(page.locator("#store-footer")).toBeVisible();
  expect(await page.locator("iframe, dialog").count()).toBe(0);
  expect(await page.locator("body").evaluate(body => ({ overflow: body.scrollWidth > window.innerWidth, font: getComputedStyle(body).fontFamily })))
    .toEqual({ overflow: false, font: "Impact, fantasy" });
  expect(await page.locator(".csz-return-ui h1").evaluate(h => getComputedStyle(h).fontFamily)).not.toMatch(/Impact|fantasy/);
  await expect(page.getByRole("link", { name: "Back to shopping", exact: true })).toHaveAttribute("href", "https://www.cardshellz.com/");
  expect(new URL(page.url()).pathname).toBe("/pages/start-a-return");
}

test("guests sign in through Shopify and return to the same storefront page", async ({ page }) => {
  const f = await fixture(page, { guest: true });
  await expect(page.getByRole("heading", { name: "Return an order" })).toBeVisible();
  const href = await page.getByRole("link", { name: "Sign in to your account" }).getAttribute("href");
  expect(new URL(href!, page.url()).searchParams.get("return_url")).toBe("/pages/start-a-return?preview_theme_id=174740308127&view=return-portal");
  expect(f.calls).toEqual([]); expect(f.external).toEqual([]); expect(f.errors).toEqual([]);
  await assertStoreFrame(page);
});

test("signed-in chooser and protected label downloads stay on Shopify", async ({ page }) => {
  const f = await fixture(page);
  await expect(page.getByRole("heading", { name: "Choose an order to return" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign out", exact: true })).toHaveAttribute("href", "/account/logout");
  await assertStoreFrame(page);
  await page.getByRole("button", { name: "RMA-20 · Order TEST-1001", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Return RMA-20" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download label for box 1", exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
  expect(f.calls.some(call => call.path.endsWith("/download"))).toBe(true);
  expect(f.calls.every(call => call.method === "GET")).toBe(true);
  expect(f.external).toEqual([]); expect(f.errors).toEqual([]);
});

test("selection, packing, review and lost-response recovery reuse one durable request on the storefront", async ({ page }) => {
  const f = await fixture(page, { loseSubmit: true });
  await page.getByRole("button", { name: "Return items", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What would you like to return?" })).toBeVisible();
  await page.getByRole("spinbutton", { name: /^Return quantity for item 1:/ }).fill("1");
  await page.getByRole("button", { name: "Continue to packing", exact: true }).click();
  await expect(page.getByText("Using your original shipping box", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review return", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review your return", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Get return labels", exact: true }).click();
  await expect.poll(f.submissions).toBe(1);
  // Moving from the old app origin gives the storefront no old sessionStorage.
  // Restore the customer's durable server intent rather than resubmitting it.
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Return items", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Getting your return label", exact: true })).toBeVisible();
  f.complete();
  await expect(page.getByRole("button", { name: "Download label for box 1", exact: true })).toBeVisible();
  expect(f.submissions()).toBe(1);
  await assertStoreFrame(page);
  expect(f.external).toEqual([]); expect(f.errors).toEqual([]);
});

test("inactive Shopify sign-in offers sign-in; service errors offer retry", async ({ page }) => {
  const f = await fixture(page, { bootstrapFailure: "service" });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Choose an order to return" })).toBeVisible();
  expect(f.calls.filter(call => call.path === "/account/bootstrap")).toHaveLength(2);
  await fixture(page, { bootstrapFailure: "session" });
  await expect(page.getByRole("link", { name: "Sign in to your account" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
});

test("invalid page configuration shows a useful error without sending a request", async ({ page }) => {
  const f = await fixture(page, { invalid: true });
  await expect(page.getByRole("alert")).toHaveText("Returns could not be loaded. Refresh this page or contact us for help.");
  expect(f.calls).toEqual([]); expect(f.external).toEqual([]);
});
