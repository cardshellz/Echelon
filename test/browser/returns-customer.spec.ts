import { validateCustomerReturnBoxPlan } from "../../server/modules/returns/application/customer-return-box-plan";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CustomerReturnPreviewService } from "../../server/modules/returns/application/customer-return-preview.service";
import { customerReturnSavedRequestSchema } from "../../client/src/lib/customer-return-customer";

const API = "/api/returns/customer";
const identity = "a".repeat(43);
async function fixtures(
  page: Page,
  options: {
    signedIn?: boolean;
    failSubmit?: boolean;
    failOrders?: boolean;
    history?: boolean;
    changedReview?: boolean;
    unverifiedOrders?: boolean;
    missingWeight?: boolean;
    unconfirmedDelivery?: boolean;
    rejectSubmit?: boolean;
    rejectResume?: boolean;
    pendingHistory?: boolean;
    queuedWorkflow?: boolean;
    restoreWorkflow?: boolean;
    beforeSubmit?: () => Promise<void>;
  } = {},
) {
  const service = new CustomerReturnPreviewService();
  const {
    mode: _mode,
    scenarioId: _scenario,
    ...fields
  } = service.lookup({
    scenarioId: "split_delivered",
    orderReference: "TEST-1001",
  });
  const order = {
    ...fields,
    sourceRevision: "a".repeat(64),
    lines: fields.lines.map(line => ({
      ...line,
      deliveredQuantity: options.unconfirmedDelivery ? 0 : line.deliveredQuantity,
    })),
  };
  if (options.missingWeight) order.lines[0].unitWeightGrams = null;
  const detail = { omsOrderId: 10, order, settingsVersion: 2 };
  const calls: { path: string; method: string; body: any }[] = [];
  let sessionKey = identity;
  let submitted = false;
  let failed = false;
  let rejected = false;
  let signedOut = false;
  let historyStatusReads = 0;
  let workflowKey = "20000000-0000-4000-8000-000000000001";
  let workflowExists = false, workflowReads = 0;
  const workflowReply = (phase: "queued" | "labels" | "ready" | "needs_input" = "ready") => ({
    requestKey: workflowKey, omsOrderId: 10, phase, reason: phase === "needs_input" ? "RETURN_DETAILS_CHANGED" : null,
    labels: phase === "queued" || phase === "needs_input" ? null : phase === "labels"
      ? { ...status, canProgress: true, parcels: [{ ...status.parcels[0], status: "pending", trackingNumber: null, downloadPath: null }] } : status,
    updatedAt: "2026-10-30T12:00:00.000Z",
  });
  const status = {
    authorizationId: 20,
    authorizationNumber: "RMA-20",
    canProgress: false,
    parcels: [
      {
        parcelId: 30,
        number: 1,
        status: "ready",
        trackingNumber: "TRACK-30",
        downloadPath: `${API}/returns/20/parcels/30/download`,
      },
    ],
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (!path.startsWith(API))
      return route.fulfill({
        status: 401,
        json: { error: "Not signed into the staff app" },
      });
    const body = request.method() === "POST" ? request.postDataJSON() : null;
    calls.push({ path, method: request.method(), body });
    if (request.method() === "POST")
      expect(request.headers()["x-return-command"]).toBe("1");
    if (path === `${API}/session`)
      return route.fulfill({
        json: {
          authenticated: options.signedIn !== false && !signedOut,
          privateTesting: true,
          sessionKey:
            options.signedIn === false || signedOut ? null : sessionKey,
        },
      });
    if (request.headers()["x-return-session"] !== sessionKey)
      return route.fulfill({
        status: 401,
        json: { error: { code: "RETURN_CUSTOMER_SESSION_CHANGED" } },
      });
    if (path === `${API}/logout`) {
      signedOut = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === `${API}/orders`)
      return options.failOrders
        ? route.fulfill({
            status: 503,
            json: { error: { code: "CUSTOMER_RETURN_UNAVAILABLE" } },
          })
        : route.fulfill({
            json: {
              orders: options.unverifiedOrders ? [] : [detail],
              nextBeforeOmsOrderId: null,
              unavailableOrderCount: options.unverifiedOrders ? 1 : 0,
            },
          });
    if (path === `${API}/orders/10`) return route.fulfill({ json: detail });
    if (path === `${API}/orders/10/review`) {
      if (options.changedReview)
        return route.fulfill({
          status: 409,
          json: { error: { code: "RETURN_LIVE_REVIEW_CHANGED" } },
        });
      expect(body).not.toHaveProperty("orderReference");
      expect(body).not.toHaveProperty("channelId");
      if (options.missingWeight || options.unconfirmedDelivery) {
        const plan = validateCustomerReturnBoxPlan(order.lines, { selections: body.selections, parcels: body.parcels }, order.boxOptions);
        return route.fulfill({ json: { ...plan, sourceRevision: order.sourceRevision, effects: "none",
          orderReference: order.orderReference, refundMethod: "manual_shopify" } });
      }
      const { mode: _reviewMode, ...review } = service.review({
        scenarioId: "split_delivered",
        orderReference: "TEST-1001",
        selections: body.selections,
        parcels: body.parcels,
      });
      return route.fulfill({
        json: { ...review, sourceRevision: order.sourceRevision },
      });
    }
    if (path === `${API}/orders/10/label-requests` && request.method() === "GET") {
      if (options.restoreWorkflow) {
        workflowExists = true;
        return route.fulfill({ json: { workflow: workflowReply("labels"), input: {
          idempotencyKey: workflowKey, settingsVersion: 2, sourceRevision: order.sourceRevision,
          selections: [{ lineId: order.lines[0].id, quantity: 1, reasonCode: null }],
          parcels: [{ originalBoxId: null, dimensions: { lengthMm: 254, widthMm: 203.2, heightMm: 152.4 }, items: [{ lineId: order.lines[0].id, quantity: 1 }] }],
        } } });
      }
      return route.fulfill({ status: 404, json: { error: { code: "RETURN_WORKFLOW_NOT_FOUND" } } });
    }
    if (path === `${API}/orders/10/label-requests`) {
      await options.beforeSubmit?.();
      expect(body).not.toHaveProperty("channelId"); expect(body).not.toHaveProperty("orderReference");
      workflowKey = body.idempotencyKey;
      if (options.rejectSubmit && !rejected) { rejected = true; workflowExists = true; return route.fulfill({ json: workflowReply("needs_input") }); }
      if (options.failSubmit && !failed) { failed = true; return route.abort("failed"); }
      workflowExists = true; submitted = true;
      return route.fulfill({ json: workflowReply(options.queuedWorkflow ? "queued" : "ready") });
    }
    if (path.startsWith(`${API}/label-requests/`)) {
      if (path.endsWith("/retry") && options.rejectResume) {
        rejected = true; workflowExists = true; workflowKey = path.split("/").at(-2)!;
        return route.fulfill({ json: workflowReply("needs_input") });
      }
      if (!workflowExists) return route.fulfill({ status: 404, json: { error: { code: "RETURN_WORKFLOW_NOT_FOUND" } } });
      return route.fulfill({ json: workflowReply(rejected ? "needs_input" : options.queuedWorkflow && workflowReads++ === 0 ? "labels" : "ready") });
    }
    if (path === `${API}/returns/20/label-requests`) {
      if (request.method() === "GET" && !workflowExists)
        return route.fulfill({ status: 404, json: { error: { code: "RETURN_WORKFLOW_NOT_FOUND" } } });
      workflowExists = true; return route.fulfill({ json: workflowReply() });
    }
    if (path.startsWith(`${API}/commands/`) && path.endsWith("/resume") && options.rejectResume) {
      rejected = true;
      return route.fulfill({ status: 410, json: { error: {
        code: "RETURN_LABEL_SUBMISSION_REJECTED", reasonCode: "RETURN_LABEL_SETTINGS_CHANGED",
      } } });
    }
    if (path.startsWith(`${API}/commands/`) && rejected && !submitted)
      return route.fulfill({ status: 410, json: { error: {
        code: "RETURN_LABEL_SUBMISSION_REJECTED", reasonCode: "RETURN_LABEL_ALLOCATION_UNVERIFIED",
      } } });
    if (path.startsWith(`${API}/commands/`))
      return submitted
        ? route.fulfill({ json: status })
        : route.fulfill({
            status: 404,
            json: { error: { code: "CUSTOMER_RETURN_UNAVAILABLE" } },
          });
    if (path === `${API}/returns`)
      return route.fulfill({
        json: {
          returns: options.history
            ? [
                {
                  authorizationId: 20,
                  authorizationNumber: "RMA-20",
                  omsOrderId: 10,
                  orderReference: "TEST-1001",
                  createdAt: "2026-01-01T00:00:00.000Z",
                },
              ]
            : [],
          nextBeforeAuthorizationId: null,
        },
      });
    if (path === `${API}/returns/20`) {
      if (options.pendingHistory && historyStatusReads++ === 0)
        return route.fulfill({ json: { ...status, parcels: [{ ...status.parcels[0], status: "pending", trackingNumber: null, downloadPath: null }] } });
      return route.fulfill({ json: status });
    }
    if (path.endsWith("/download"))
      return route.fulfill({
        headers: { "Content-Type": "application/pdf" },
        body: "%PDF-fictional",
      });
    return route.fulfill({
      status: 500,
      json: { error: { code: "UNEXPECTED_TEST_ROUTE" } },
    });
  });
  return {
    calls,
    changeSession: () => {
      sessionKey = "b".repeat(43);
    },
  };
}

async function selectAndPack(page: Page, packedWeightOunces?: string, beforeReview?: () => Promise<void>) {
  await page.getByRole("button", { name: "Return items", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "What would you like to return?" }),
  ).toBeVisible();
  await expect(page.getByLabel("Order number", { exact: true })).toHaveCount(0);
  await page
    .getByRole("spinbutton", { name: /^Return quantity for item 1:/ })
    .fill("1");
  await page
    .getByRole("button", { name: "Continue to packing", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Box size for box 1", exact: true })
    .selectOption({ label: "Use a different box" });
  const length = page.getByLabel("Length of box 1 in inches", { exact: true });
  if (await length.isVisible()) {
    await length.fill("10");
    await page
      .getByLabel("Width of box 1 in inches", { exact: true })
      .fill("8");
    await page
      .getByLabel("Height of box 1 in inches", { exact: true })
      .fill("6");
  }
  if (packedWeightOunces !== undefined) {
    await expect(page.getByRole("button", { name: "Review return", exact: true })).toBeDisabled();
    await page.getByLabel("Packed box weight (ounces)", { exact: true }).fill(packedWeightOunces);
  }
  await beforeReview?.();
  await page
    .getByRole("button", { name: "Review return", exact: true })
    .click();
}

test("signed-out customer sees fixed sign-in and no staff shell or order reads", async ({
  page,
}) => {
  const f = await fixtures(page, { signedIn: false });
  await page.goto("/customer-returns");
  await expect(
    page.getByRole("link", { name: "Sign in to Card Shellz" }),
  ).toHaveAttribute("href", "/customer-returns/start");
  await expect(page.getByText(/Private testing/)).toBeVisible();
  await expect(page.locator('[data-sidebar="sidebar"]')).toHaveCount(0);
  await expect(page.getByText("Echelon", { exact: true })).toHaveCount(0);
  expect(f.calls.map((call) => call.path)).toEqual([`${API}/session`]);
});

test("owned selection skips Find order, reviews exact quantities and creates only on explicit click", async ({
  page,
}) => {
  const f = await fixtures(page);
  await page.goto("/customer-returns");
  await selectAndPack(page);
  await expect(
    page.getByRole("heading", { name: "Review your return", exact: true }),
  ).toBeVisible();
  expect(
    f.calls.filter(
      (call) => call.path.endsWith("/label-requests") && call.method === "POST",
    ),
  ).toHaveLength(0);
  await page
    .getByRole("button", { name: "Get return labels", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Return RMA-20" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Download label for box 1" }),
  ).toBeVisible();
  expect(
    f.calls.filter(
      (call) => call.path.endsWith("/label-requests") && call.method === "POST",
    ),
  ).toHaveLength(1);
  expect(f.calls.some((call) => call.path.endsWith("/progress"))).toBe(false);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("label creation names the customer task and hides retry instructions while working", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const f = await fixtures(page, { beforeSubmit: () => pending });
  await page.goto("/customer-returns");
  await selectAndPack(page);
  try {
    await page.getByRole("button", { name: "Get return labels", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Getting your return label", exact: true })).toBeVisible();
    await expect(page.getByText("Getting your return label…", { exact: true })).toBeVisible();
    await expect(page.getByText("Your selections are saved. Try again to continue with your return.", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Check status", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
  } finally {
    release();
  }
  await expect(page.getByRole("button", { name: "Download label for box 1" })).toBeVisible();
  expect(f.calls.filter(call => call.path.endsWith("/label-requests") && call.method === "POST")).toHaveLength(1);
});

test("queued label work finishes through observation with no browser purchase or manual status action", async ({ page }) => {
  const f = await fixtures(page, { queuedWorkflow: true });
  await page.goto("/customer-returns"); await selectAndPack(page);
  await page.getByRole("button", { name: "Get return labels", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Getting your return label", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download label for box 1" })).toBeVisible();
  expect(f.calls.filter(call => call.method === "POST").map(call => call.path)).toEqual([`${API}/orders/10/review`, `${API}/orders/10/label-requests`]);
  expect(f.calls.some(call => call.path.endsWith("/progress") || call.path.endsWith("/resume"))).toBe(false);
});

test("an unfinished server request is recovered after browser storage loss using reads alone", async ({ page }) => {
  const f = await fixtures(page, { restoreWorkflow: true });
  await page.goto("/customer-returns");
  await page.getByRole("button", { name: "Return items", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download label for box 1" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What would you like to return?", exact: true })).toHaveCount(0);
  expect(f.calls.every(call => call.method === "GET")).toBe(true);
  const record = await page.evaluate(key => sessionStorage.getItem(key), `customer-return-request:${identity}`);
  expect(customerReturnSavedRequestSchema.parse(JSON.parse(record!)).input.idempotencyKey).toBe("20000000-0000-4000-8000-000000000001");
});

test("a rejected standalone request can reload current items and return to the order chooser", async ({ page }) => {
  const f = await fixtures(page, { rejectSubmit: true });
  await page.goto("/customer-returns");
  await selectAndPack(page);
  await page.getByRole("button", { name: "Get return labels", exact: true }).click();
  await expect(page.getByRole("heading", { name: "We couldn’t finish your return", exact: true })).toBeVisible();
  const lookupsBeforeRecovery = f.calls.filter(call => call.path === `${API}/orders/10`).length;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What would you like to return?" })).toBeVisible();
  expect(f.calls.filter(call => call.path === `${API}/orders/10`)).toHaveLength(lookupsBeforeRecovery + 1);
  expect(f.calls.filter(call => call.path === `${API}/orders/10/label-requests` && call.method === "POST")).toHaveLength(1);
  await page.getByRole("button", { name: "Back to order", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Choose an order to return", exact: true })).toBeVisible();
  expect(f.calls.some(call => call.path.endsWith("/retry"))).toBe(false);
});

test("one Try again action refreshes an obsolete saved request directly into item review", async ({ page }, info) => {
  const f = await fixtures(page, { failSubmit: true, rejectResume: true });
  await page.goto("/customer-returns");
  await selectAndPack(page);
  await page.getByRole("button", { name: "Get return labels", exact: true }).click();
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Check status", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review return items", exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("single-return-retry.png"), fullPage: true });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("heading", { name: "What would you like to return?", exact: true })).toBeVisible();
  expect(f.calls.filter(call => call.path.endsWith("/retry"))).toHaveLength(1);
  expect(f.calls.filter(call => call.path === `${API}/orders/10/label-requests` && call.method === "POST")).toHaveLength(1);
  expect(await page.evaluate(() => sessionStorage.getItem(`customer-return-request:${"a".repeat(43)}`))).toBeNull();
  await expect(page.getByRole("spinbutton", { name: /^Return quantity for item 1:/ })).toHaveValue("0");
});

test("verified purchases remain selectable and reviewable without delivery confirmation", async ({ page }) => {
  const f = await fixtures(page, { unconfirmedDelivery: true });
  await page.goto("/customer-returns");
  await selectAndPack(page);
  await expect(page.getByRole("heading", { name: "Review your return", exact: true })).toBeVisible();
  const reviews = f.calls.filter(call => call.path.endsWith("/review"));
  expect(reviews).toHaveLength(1);
  expect(reviews[0].body.selections).toEqual([{ lineId: "sample-line-1", quantity: 1, reasonCode: null }]);
  expect(f.calls.some(call => call.path.endsWith("/label-requests") && call.method === "POST")).toBe(false);
});

test("missing item weights use a measured package weight and preserve it through a lost-response retry", async ({ page }, testInfo) => {
  const f = await fixtures(page, { missingWeight: true, failSubmit: true });
  await page.goto("/customer-returns");
  await selectAndPack(page, "16", async () => {
    await page.screenshot({ path: testInfo.outputPath("measured-box-packing.png"), fullPage: true });
  });
  await expect(page.getByRole("heading", { name: "Review your return", exact: true })).toBeVisible();
  const review = f.calls.find(call => call.path.endsWith("/review"))!;
  expect(review.body.parcels[0].packedWeightGrams).toBe(454);
  await page.screenshot({ path: testInfo.outputPath("measured-return-weight.png"), fullPage: true });
  await page.getByRole("button", { name: "Get return labels", exact: true }).click();
  await expect(page.getByRole("button", { name: "Try again" })).toBeEnabled();
  await page.reload();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Return RMA-20" })).toBeVisible();
  const writes = f.calls.filter(call => call.path.endsWith("/label-requests") && call.method === "POST");
  expect(writes).toHaveLength(2);
  expect(writes[1].body).toEqual(writes[0].body);
  expect(writes[1].body.parcels[0].packedWeightGrams).toBe(454);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("uncertain creation survives reload and retries exact durable intent without a new key", async ({
  page,
}) => {
  const f = await fixtures(page, { failSubmit: true });
  await page.goto("/customer-returns");
  await selectAndPack(page);
  await page
    .getByRole("button", { name: "Get return labels", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Try again" }),
  ).toBeEnabled();
  const original = f.calls.find(
    (call) => call.path === `${API}/orders/10/label-requests` && call.method === "POST",
  )!.body;
  const saved = await page.evaluate(
    (key) => sessionStorage.getItem(key),
    `customer-return-request:${identity}`,
  );
  expect(
    customerReturnSavedRequestSchema.parse(JSON.parse(saved!)).input,
  ).toEqual(original);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Try again" }),
  ).toBeEnabled();
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(2); // review + the first explicit submission
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: "Return RMA-20" }),
  ).toBeVisible();
  expect(
    f.calls
      .filter((call) => call.path === `${API}/orders/10/label-requests` && call.method === "POST")
      .map((call) => call.body),
  ).toEqual([original, original]);
});

test("a different verified session cannot restore another customer's pending request", async ({
  page,
}) => {
  const f = await fixtures(page, { failSubmit: true });
  await page.goto("/customer-returns");
  await selectAndPack(page);
  await page
    .getByRole("button", { name: "Get return labels", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Try again" }),
  ).toBeEnabled();
  f.changeSession();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Choose an order to return" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Try again" }),
  ).toHaveCount(0);
  expect(f.calls.some((call) => call.path.includes("/commands/"))).toBe(false);
});

test("existing returns open through read-only history without current eligibility or policy assumptions", async ({
  page,
}) => {
  const f = await fixtures(page, { history: true });
  await page.goto("/customer-returns");
  await page.getByRole("button", { name: "RMA-20 \u00b7 Order TEST-1001" }).click();
  await expect(
    page.getByRole("button", { name: "Download label for box 1" }),
  ).toBeVisible();
  expect(f.calls.every((call) => call.method === "GET")).toBe(true);
});

test("a waiting historical label explicitly joins the backend workflow without browser purchase commands", async ({ page }) => {
  const f = await fixtures(page, { history: true, pendingHistory: true });
  await page.goto("/customer-returns");
  await page.getByRole("button", { name: "RMA-20 \u00b7 Order TEST-1001" }).click();
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Check status", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download label for box 1", exact: true })).toBeVisible();
  expect(f.calls.filter(call => call.method === "POST").map(call => call.path)).toEqual([`${API}/returns/20/label-requests`]);
  expect(f.calls.some(call => call.path.endsWith("/progress"))).toBe(false);
});

test("order load failure remains an error and never claims no eligible orders", async ({
  page,
}) => {
  const f = await fixtures(page, { failOrders: true, history: true });
  await page.goto("/customer-returns");
  await expect(page.getByRole("alert")).toContainText("could not confirm");
  await expect(page.getByText(/No eligible orders were found/)).toHaveCount(0);
  await page.getByRole("button", { name: "RMA-20 \u00b7 Order TEST-1001" }).click();
  await expect(
    page.getByRole("button", { name: "Download label for box 1" }),
  ).toBeVisible();
  expect(f.calls.every((call) => call.method === "GET")).toBe(true);
});

test("a changed review returns to the owned chooser without a label write", async ({
  page,
}) => {
  const f = await fixtures(page, { changedReview: true });
  await page.goto("/customer-returns");
  await selectAndPack(page);
  await expect(
    page.getByRole("heading", { name: "Choose an order to return" }),
  ).toBeVisible();
  expect(
    f.calls.some(
      (call) => call.method === "POST" && call.path.endsWith("/label-requests"),
    ),
  ).toBe(false);
});

test("unverified orders are explained without claiming an empty eligible history", async ({
  page,
}) => {
  await fixtures(page, { unverifiedOrders: true });
  await page.goto("/customer-returns");
  await expect(
    page.getByText(
      "Some orders could not be checked. Refresh or contact support.",
    ),
  ).toBeVisible();
  await expect(page.getByText(/No eligible orders were found/)).toHaveCount(0);
});

test("a cross-tab customer change is rejected before exposing another account's orders", async ({
  page,
}) => {
  const f = await fixtures(page);
  await page.goto("/customer-returns");
  await expect(
    page.getByRole("button", { name: "Return items", exact: true }),
  ).toBeVisible();
  f.changeSession();
  await page.getByRole("button", { name: "Refresh orders" }).click();
  await expect(
    page.getByRole("link", { name: "Sign in to Card Shellz" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Return items", exact: true }),
  ).toHaveCount(0);
});

test("sign out clears visible customer data and retains an uncertain saved request", async ({
  page,
}) => {
  const f = await fixtures(page, { failSubmit: true });
  await page.goto("/customer-returns");
  await selectAndPack(page);
  await page
    .getByRole("button", { name: "Get return labels", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Try again" }),
  ).toBeEnabled();
  const saved = await page.evaluate(
    (key) => sessionStorage.getItem(key),
    `customer-return-request:${identity}`,
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Sign in to Card Shellz" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      (key) => sessionStorage.getItem(key),
      `customer-return-request:${identity}`,
    ),
  ).toBe(saved);
  expect(
    f.calls
      .filter((call) => call.path === `${API}/logout`)
      .map((call) => call.method),
  ).toEqual(["POST"]);
});

test("mixed-box receiving restores and retries the identical saved receipt after a lost response", async ({
  page,
}) => {
  const parcel = {
    parcelId: 71,
    authorizationId: 61,
    authorizationNumber: "RMA-61",
    boxNumber: 2,
    trackingNumber: "RETURN-BOX-2",
    lines: [
      {
        authorizationLineId: 81,
        title: "Sleeves",
        sku: "SAME",
        expectedQuantity: 2,
        receivedQuantity: 0,
      },
      {
        authorizationLineId: 82,
        title: "Toploaders",
        sku: "TOP",
        expectedQuantity: 3,
        receivedQuantity: 0,
      },
      {
        authorizationLineId: 83,
        title: "Separate sleeve purchase",
        sku: "SAME",
        expectedQuantity: 1,
        receivedQuantity: 0,
      },
    ],
  };
  const writes: unknown[] = [];
  await page.route("**/api/returns/admin/receiving/**", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: parcel });
    const body = route.request().postDataJSON();
    writes.push(body);
    if (writes.length === 1)
      return route.fulfill({
        status: 503,
        json: {
          error: {
            code: "RETURN_PARCEL_RECEIPT_UNAVAILABLE",
            message:
              "The receipt outcome could not be confirmed. Retry the same saved receipt.",
          },
        },
      });
    return route.fulfill({
      json: {
        parcel: {
          ...parcel,
          lines: parcel.lines.map((line) => ({
            ...line,
            receivedQuantity: line.authorizationLineId === 81 ? 1 : 0,
          })),
        },
        caseIds: [91, 92],
        replayed: true,
      },
    });
  });
  await page.route("**/__return-parcel-test**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
  <script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head>
  <body><div id="root"></div><script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/return-parcel-receiving-harness.tsx").replaceAll("\\", "/")}"></script></body></html>`,
    }),
  );
  await page.goto("/__return-parcel-test");
  await page.getByLabel("Return tracking number").fill("RETURN-BOX-2");
  await page.getByRole("button", { name: "Find box", exact: true }).click();
  await expect(page.getByText(/RMA-61.*Box 2/)).toBeVisible();
  await expect(
    page.getByText("Separate sleeve purchase", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Units received now", { exact: true })
    .first()
    .fill("1");
  await page
    .getByRole("button", { name: "Record box receipt", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry saved receipt", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Retry saved receipt", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "No quantities were received twice",
  );
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  await expect(
    page.getByText("1 of 2 received", { exact: false }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
