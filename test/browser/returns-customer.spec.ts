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
  const order = { ...fields, sourceRevision: "a".repeat(64) };
  const detail = { omsOrderId: 10, order, settingsVersion: 2 };
  const calls: { path: string; method: string; body: any }[] = [];
  let sessionKey = identity;
  let submitted = false;
  let failed = false;
  let signedOut = false;
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
    if (path === `${API}/orders/10/returns`) {
      expect(body).not.toHaveProperty("channelId");
      expect(body).not.toHaveProperty("orderReference");
      if (options.failSubmit && !failed) {
        failed = true;
        return route.abort("failed");
      }
      submitted = true;
      return route.fulfill({ json: status });
    }
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
    if (path === `${API}/returns/20`) return route.fulfill({ json: status });
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

async function selectAndPack(page: Page) {
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
      (call) => call.path.endsWith("/returns") && call.method === "POST",
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
      (call) => call.path.endsWith("/returns") && call.method === "POST",
    ),
  ).toHaveLength(1);
  expect(f.calls.some((call) => call.path.endsWith("/progress"))).toBe(false);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
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
    page.getByRole("button", { name: "Retry saved request" }),
  ).toBeEnabled();
  const original = f.calls.find(
    (call) => call.path === `${API}/orders/10/returns`,
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
    page.getByRole("button", { name: "Retry saved request" }),
  ).toBeEnabled();
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(2); // review + the first explicit submission
  await page.getByRole("button", { name: "Retry saved request" }).click();
  await expect(
    page.getByRole("heading", { name: "Return RMA-20" }),
  ).toBeVisible();
  expect(
    f.calls
      .filter((call) => call.path === `${API}/orders/10/returns`)
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
    page.getByRole("button", { name: "Retry saved request" }),
  ).toBeEnabled();
  f.changeSession();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Choose an order to return" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry saved request" }),
  ).toHaveCount(0);
  expect(f.calls.some((call) => call.path.includes("/commands/"))).toBe(false);
});

test("existing returns open through read-only history without current eligibility or policy assumptions", async ({
  page,
}) => {
  const f = await fixtures(page, { history: true });
  await page.goto("/customer-returns");
  await page.getByRole("button", { name: "RMA-20 · Order TEST-1001" }).click();
  await expect(
    page.getByRole("button", { name: "Download label for box 1" }),
  ).toBeVisible();
  expect(f.calls.every((call) => call.method === "GET")).toBe(true);
});

test("order load failure remains an error and never claims no eligible orders", async ({
  page,
}) => {
  const f = await fixtures(page, { failOrders: true, history: true });
  await page.goto("/customer-returns");
  await expect(page.getByRole("alert")).toContainText("could not confirm");
  await expect(page.getByText(/No eligible orders were found/)).toHaveCount(0);
  await page.getByRole("button", { name: "RMA-20 · Order TEST-1001" }).click();
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
      (call) => call.method === "POST" && call.path.endsWith("/returns"),
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
    page.getByRole("button", { name: "Retry saved request" }),
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
