import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import type {
  OrderEditOperation,
  OrderEditOrder,
} from "../../shared/order-edits/order-edit.contract";
import type { CustomerAccountRequest } from "../../shared/customer-account/customer-account.contract";
import type { CustomerAccountOrderSummaries } from "../../shared/customer-account/customer-account-orders";

const id = "00000000-0000-4000-8000-000000000001";
const paymentUrl = "https://fixture.myshopify.com/pay-difference";
const before = {
  itemsGrossCents: 279,
  itemsDiscountCents: 46,
  itemsNetCents: 233,
  itemDiscountLabels: ["Club"],
  shippingGrossCents: 549,
  shippingDiscountCents: 0,
  shippingCents: 549,
  shippingDiscountLabels: [],
  taxCents: 47,
  taxesIncluded: false,
  totalCents: 829,
  lines: [
    {
      id: "gid://shopify/LineItem/1",
      grossCents: 279,
      discountCents: 46,
      netCents: 233,
    },
  ],
};
const after = {
  ...before,
  itemsGrossCents: 558,
  itemsDiscountCents: 92,
  itemsNetCents: 466,
  taxCents: 61,
  totalCents: 1076,
  lines: [
    {
      id: "gid://shopify/LineItem/1",
      grossCents: 558,
      discountCents: 92,
      netCents: 466,
    },
  ],
};
const order: OrderEditOrder = {
  connectionId: 4,
  omsOrderId: 1,
  orderNumber: "#fixture",
  currency: "USD",
  customerName: "Synthetic",
  customerEmail: null,
  activeOperationId: id,
  revision: "baseline",
  eligibility: { editable: true, reasons: [] },
  totalCents: 829,
  financialStatus: "Paid",
  warehouseStatus: "Not yet picking",
  financials: before,
  lines: [
    {
      lineItemId: "gid://shopify/LineItem/1",
      variantId: "gid://shopify/ProductVariant/1",
      title: "Sleeves",
      variantTitle: null,
      sku: "SKU",
      quantity: 1,
      unitPriceCents: 233,
      totalCents: 233,
    },
  ],
};
function summaries(
  totalCents = order.totalCents,
): CustomerAccountOrderSummaries {
  return {
    orders: [
      {
        externalOrderId: "99",
        orderReference: order.orderNumber,
        omsOrderId: order.omsOrderId,
        currency: order.currency,
        totalCents,
        financialStatus: "Paid",
        cancelled: false,
      },
    ],
    unavailableExternalOrderIds: [],
    statusUnavailable: false,
  };
}
function operation(
  status: OrderEditOperation["status"] = "awaiting_payment",
): OrderEditOperation {
  const paid = status !== "awaiting_payment";
  return {
    operationId: id,
    orderNumber: order.orderNumber,
    currency: "USD",
    status,
    canAbandon: false,
    quoteAvailable: true,
    previousTotalCents: 829,
    updatedTotalCents: 1076,
    balanceDueCents: paid ? 0 : 247,
    refundDueCents: 0,
    requestedPlan: {
      changes: [{ lineItemId: "gid://shopify/LineItem/1", quantity: 2 }],
      additions: [],
      discountCodes: [],
    },
    financials: { before, current: after, quoted: after },
    settlement: {
      receivedCents: paid ? 1076 : 829,
      refundedCents: 0,
      netPaidCents: paid ? 1076 : 829,
      outstandingCents: paid ? 0 : 247,
      activity: [],
    },
    lines: [
      {
        id: "gid://shopify/LineItem/1",
        title: "Sleeves",
        variantTitle: null,
        quantity: 2,
        totalCents: 466,
      },
    ],
    warnings: [],
    expiresAt: null,
    paymentDeadline: "2026-10-22T12:00:00.000Z",
    paymentUrl: paid ? null : paymentUrl,
    error: null,
  };
}
async function setup(
  page: Page,
  options: {
    openEditor?: boolean;
    orderRead?: () => Promise<OrderEditOrder | null>;
    summaryRead?: () => Promise<CustomerAccountOrderSummaries | null>;
    multipleOrders?: boolean;
    customerId?: string;
  } = {},
) {
  await page.clock.install({ time: new Date("2026-10-21T12:00:00Z") });
  const requests: CustomerAccountRequest[] = [];
  const errors: string[] = [];
  const identities = [
    { externalOrderId: "99", orderReference: "#fixture" },
    ...(options.multipleOrders
      ? [{ externalOrderId: "100", orderReference: "#older" }]
      : []),
  ];
  let current = operation();
  let failReads = false;
  let activeOperation: string | null = id;
  let holdRead: Promise<void> | null = null;
  let retryResult: OrderEditOperation | null = null;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  await page.route(paymentUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<h1>Synthetic payment fixture</h1><a href="http://127.0.0.1:5192/account?preview_theme_id=174740308127">Return to your order</a>',
    }),
  );
  await page.route("**/apps/echelon-returns/account", async (route) => {
    const input = route.request().postDataJSON() as CustomerAccountRequest;
    requests.push(input);
    expect(input.expectedCustomerId).toBe("100");
    if (input.path === "/account/bootstrap")
      return route.fulfill({
        json: {
          session: {
            authenticated: true,
            privateTesting: true,
            sessionKey: "a".repeat(43),
          },
          connection: {
            connectionId: 4,
            channelId: 36,
            shopDomain: "fixture.myshopify.com",
            name: "Synthetic",
            enabled: true,
            paymentWindowMinutes: 30,
          },
        },
      });
    if (input.path === "/account/order-summaries") {
      expect(input.method).toBe("POST");
      expect(input.commandKey).toBeUndefined();
      expect(input.body).toEqual({ orders: identities });
      const result = options.summaryRead
        ? await options.summaryRead()
        : summaries();
      return result
        ? route.fulfill({ json: result })
        : route.fulfill({
            status: 503,
            json: {
              error: {
                code: "ORDER_READ_UNAVAILABLE",
                message: "Synthetic summary read failure",
              },
            },
          });
    }
    if (input.path === "/account/order-actions") {
      const currentOrder = options.orderRead ? await options.orderRead() : order;
      return route.fulfill({ json: { orders: identities.map(identity => ({ ...identity,
        omsOrderId: identity.externalOrderId === "99" ? 1 : null,
        state: identity.externalOrderId !== "99" ? "not_managed" : currentOrder ? "ready" : "failed",
        verifiedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 60_000).toISOString(),
        snapshot: identity.externalOrderId === "99" && currentOrder ? { order: { ...currentOrder, activeOperationId: activeOperation },
          returnOrder: null, orderFailed: false, returnFailed: false } : null })) } });
    }
    if (input.path === "/returns/returns")
      return route.fulfill({
        json: { returns: [], nextBeforeAuthorizationId: null },
      });
    if (input.path === "/order-edits/orders/1") {
      const currentOrder = options.orderRead
        ? await options.orderRead()
        : order;
      if (!currentOrder)
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: "ORDER_READ_UNAVAILABLE",
              message: "Synthetic order read failure",
            },
          },
        });
      return route.fulfill({
        json: { ...currentOrder, activeOperationId: activeOperation },
      });
    }
    if (
      input.path === `/order-edits/operations/${id}/reconcile` &&
      retryResult
    ) {
      current = retryResult;
      return route.fulfill({ json: current });
    }
    if (
      input.path === `/order-edits/operations/${id}` &&
      input.method === "GET"
    ) {
      const captured = structuredClone(current);
      if (holdRead) await holdRead;
      return failReads
        ? route.fulfill({
            status: 503,
            json: {
              error: {
                code: "STATUS_UNAVAILABLE",
                message: "Synthetic status failure",
              },
            },
          })
        : route.fulfill({ json: captured });
    }
    return route.fulfill({
      status: 500,
      json: {
        error: { code: "UNEXPECTED_FINANCIAL_COMMAND", message: input.path },
      },
    });
  });
  await page.route("**/account?*", async (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
    <body><main data-csz-customer-account><div data-csz-account-tools-status></div>
      <div data-csz-order-history-status><p role="status">Loading your orders…</p></div>
      <div data-csz-order-history-content hidden>
      <article data-csz-account-order data-order-reference="#fixture" data-external-order-id="99" data-fulfillment="unfulfilled" data-cancelled="false">
        <span data-csz-order-total role="status"></span>
        <a data-csz-account-action="address" href="/account/orders/fixture/address" hidden>Change address</a>
        <span data-csz-order-panel-trigger></span><p data-csz-order-tools-status></p>
      </article>
      ${options.multipleOrders ? '<article data-csz-account-order data-order-reference="#older" data-external-order-id="100" data-fulfillment="fulfilled" data-cancelled="false"><span data-csz-order-total></span><span data-csz-order-panel-trigger></span></article>' : ""}
      </div><div id="csz-customer-account-tools"></div></main>
      <script id="csz-customer-account-config" type="application/json">${JSON.stringify({ themeId: "174740308127", customerId: options.customerId ?? "100", proxyPath: "/apps/echelon-returns" })}</script>
      <script type="module" src="/@fs/${resolve(process.cwd(), "client/src/customer-account/entry.tsx").replaceAll("\\", "/")}"></script>
    </body></html>`,
    }),
  );
  await page.goto("/account?preview_theme_id=174740308127");
  if (options.openEditor !== false) {
    await page
      .getByRole("button", { name: "Manage order #fixture", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Continue order update", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "Pay the difference", exact: true }),
    ).toBeVisible();
  }
  return {
    requests,
    errors,
    setStatus: (status: OrderEditOperation["status"]) => {
      current = operation(status);
      if (status === "completed") activeOperation = null;
    },
    setError: (code: string) => {
      current = {
        ...current,
        error: { code, message: "Synthetic provider failure" },
      };
    },
    fail: (value: boolean) => {
      failReads = value;
    },
    hold: (value: Promise<void> | null) => {
      holdRead = value;
    },
    retryReturns: (value: OrderEditOperation) => {
      retryResult = value;
    },
    reads: () =>
      requests.filter(
        (request) => request.path === `/order-edits/operations/${id}`,
      ).length,
    assertNoFinancialCommands: () => {
      expect(
        requests.filter(
          (request) =>
            ![
              "/account/bootstrap",
              "/account/order-summaries",
              "/account/order-actions",
              "/returns/returns",
              "/order-edits/orders/1",
              `/order-edits/operations/${id}`,
            ].includes(request.path),
        ),
      ).toEqual([]);
      expect(
        requests
          .filter((request) => request.path.startsWith("/order-edits/"))
          .every((request) => request.method === "GET"),
      ).toBe(true);
      expect(errors).toEqual([]);
    },
  };
}

test("account totals wait for the owned current financial facts without submitting an edit", async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await setup(page, {
    openEditor: false,
    summaryRead: async () => {
      await pending;
      return summaries(after.totalCents);
    },
  });
  const total = page.locator("[data-csz-order-total]");
  await expect(
    page.getByRole("status").filter({ hasText: "Loading your orders…" }),
  ).toBeVisible();
  await expect(page.locator("[data-csz-order-history-content]")).toBeHidden();
  release();
  await expect(total).toHaveText("$10.76 USD");
  expect(
    fixture.requests.filter((request) =>
      request.path.startsWith("/order-edits/"),
    ),
  ).toEqual([]);
  fixture.assertNoFinancialCommands();
});

test("account totals recover from a failed current read through an explicit read-only retry", async ({
  page,
}) => {
  let reads = 0;
  const fixture = await setup(page, {
    openEditor: false,
    summaryRead: async () => (++reads === 1 ? null : summaries()),
  });
  const total = page.locator("[data-csz-order-total]");
  await expect(page.getByRole("alert")).toContainText(
    "We couldn’t load your orders.",
  );
  await expect(page.locator("[data-csz-order-history-content]")).toBeHidden();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(total).toHaveText("$8.29 USD");
  expect(reads).toBe(2);
  fixture.assertNoFinancialCommands();
});

test("a slow history lookup reveals every verified total together without per-row calculation states", async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await setup(page, {
    openEditor: false,
    multipleOrders: true,
    summaryRead: async () => {
      await pending;
      const response = summaries();
      return {
        ...response,
        orders: [
          ...response.orders,
          {
            externalOrderId: "100",
            orderReference: "#older",
            omsOrderId: null,
            currency: "USD",
            totalCents: 476,
            financialStatus: "Partially refunded",
            cancelled: false,
          },
        ],
      };
    },
  });
  const history = page.locator("[data-csz-order-history-content]");
  await expect(history).toBeHidden();
  await expect(
    page.getByText("Loading your orders…", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Checking total|Total unavailable/)).toHaveCount(
    0,
  );
  await page.clock.fastForward(10_000);
  await expect(history).toBeHidden();
  expect(
    fixture.requests.filter(
      (request) => request.path === "/account/order-summaries",
    ),
  ).toHaveLength(1);
  release();
  await expect(history).toBeVisible();
  await expect(history.locator("[data-csz-order-total]")).toHaveText([
    "$8.29 USD",
    "$4.76 USD",
  ]);
  await expect(
    page.getByText("Loading your orders…", { exact: true }),
  ).toHaveCount(0);
  expect(
    fixture.requests.filter((request) =>
      request.path.startsWith("/order-edits/"),
    ),
  ).toEqual([]);
  fixture.assertNoFinancialCommands();
});

test("an incomplete history response stays behind one retry instead of revealing a partially priced page", async ({
  page,
}) => {
  let attempts = 0;
  const fixture = await setup(page, {
    openEditor: false,
    multipleOrders: true,
    summaryRead: async () => {
      const response = summaries();
      if (++attempts === 1)
        return { ...response, unavailableExternalOrderIds: ["100"] };
      return {
        ...response,
        orders: [
          ...response.orders,
          {
            externalOrderId: "100",
            orderReference: "#older",
            omsOrderId: null,
            currency: "USD",
            totalCents: 0,
            financialStatus: "Refunded",
            cancelled: true,
          },
        ],
      };
    },
  });
  const history = page.locator("[data-csz-order-history-content]");
  await expect(page.getByRole("alert")).toContainText(
    "We couldn’t load your orders.",
  );
  await expect(history).toBeHidden();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(history).toBeVisible();
  await expect(history.locator("[data-csz-order-total]")).toHaveText([
    "$8.29 USD",
    "$0.00 USD",
  ]);
  expect(attempts).toBe(2);
  fixture.assertNoFinancialCommands();
});

test("a failed background refresh retains every previously verified amount", async ({
  page,
}) => {
  let reads = 0;
  const fixture = await setup(page, {
    summaryRead: async () => (++reads === 1 ? summaries() : null),
  });
  await page
    .getByRole("button", { name: "Close order tools", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "We couldn’t load your orders.",
  );
  await expect(page.locator("[data-csz-order-history-content]")).toBeVisible();
  await expect(page.locator("[data-csz-order-total]")).toHaveText("$8.29 USD");
  await expect(
    page.getByText(/Checking total|Total unavailable|Loading your orders/),
  ).toHaveCount(0);
  fixture.assertNoFinancialCommands();
});

test("account totals leave the loading state when startup configuration is invalid", async ({
  page,
}) => {
  const fixture = await setup(page, { openEditor: false, customerId: "" });
  await expect(page.locator("[data-csz-order-history-content]")).toBeHidden();
  await expect(page.getByRole("alert")).toHaveText(
    "Your orders could not be loaded. Please refresh this page.",
  );
  expect(fixture.requests).toEqual([]);
  fixture.assertNoFinancialCommands();
});

for (const mismatch of [
  { name: "native identity", value: { externalOrderId: "98" } },
  { name: "order reference", value: { orderReference: "#other" } },
  { name: "negative amount", value: { totalCents: -1 } },
  { name: "unsafe amount", value: { totalCents: Number.MAX_SAFE_INTEGER + 1 } },
]) {
  test(`account totals reject an invalid ${mismatch.name}`, async ({
    page,
  }) => {
    const fixture = await setup(page, {
      openEditor: false,
      summaryRead: async () => {
        const response = summaries();
        return {
          ...response,
          orders: [{ ...response.orders[0], ...mismatch.value }],
        };
      },
    });
    await expect(page.getByRole("alert")).toContainText(
      "We couldn’t load your orders.",
    );
    await expect(page.locator("[data-csz-order-history-content]")).toBeHidden();
    expect(
      fixture.requests.filter((request) =>
        request.path.startsWith("/order-edits/"),
      ),
    ).toEqual([]);
    fixture.assertNoFinancialCommands();
  });
}

for (const mismatch of [
  { name: "connection", value: { connectionId: 5 } },
  { name: "order identity", value: { omsOrderId: 2 } },
  { name: "order number", value: { orderNumber: "#other" } },
  { name: "financial total", value: { totalCents: 830 } },
]) {
  test(`order management rejects a mismatched ${mismatch.name} without discarding the verified native total`, async ({
    page,
  }) => {
    const fixture = await setup(page, {
      openEditor: false,
      orderRead: async () => ({ ...order, ...mismatch.value }),
    });
    await expect(page.locator("[data-csz-order-total]")).toHaveText(
      "$8.29 USD",
    );
    await page
      .getByRole("button", { name: "Manage order #fixture", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "Some order options couldn’t be loaded.",
    );
    await expect(
      page.getByRole("button", { name: "Edit order", exact: true }),
    ).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Continue order update", exact: true }),
    ).toBeHidden();
    await expect(page.locator("[data-csz-order-total]")).toHaveText(
      "$8.29 USD",
    );
    fixture.assertNoFinancialCommands();
  });
}

test("a staff review has one explanation shared by disabled address and cancellation actions", async ({
  page,
}) => {
  const fixture = await setup(page, {
    openEditor: false,
    orderRead: async () => ({
      ...order,
      activeOperationStatus: "review_required",
      addressEligibility: {
        editable: false,
        reasons: ["Repeated address warning"],
      },
      cancellation: {
        canReview: false,
        reasons: ["Repeated cancellation warning"],
        requestKey: null,
      },
    }),
  });
  await page
    .getByRole("button", { name: "Manage order #fixture", exact: true })
    .click();
  await expect(
    page.getByText(
      "Your previous order update needs our review. Address changes and cancellation are unavailable until it is resolved.",
      { exact: true },
    ),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "View order update", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review order update", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Cancel order", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Change shipping address", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Change shipping address", exact: true }))
    .toHaveAttribute("aria-describedby", "csz-order-review-notice");
  await expect(page.getByRole("button", { name: "Cancel order", exact: true }))
    .toHaveAttribute("aria-describedby", "csz-order-review-notice");
  await expect(
    page.getByText(/Repeated (address|cancellation) warning/),
  ).toHaveCount(0);
  fixture.assertNoFinancialCommands();
});

test("closing order options preserves the account session and totals without new reads", async ({
  page,
}) => {
  const fixture = await setup(page, { openEditor: false });
  await expect(page.locator("[data-csz-order-total]")).toHaveText("$8.29 USD");
  await page
    .getByRole("button", { name: "Manage order #fixture", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Continue order update", exact: true }),
  ).toBeVisible();
  const reads = fixture.requests.length;
  await page
    .getByRole("button", { name: "Close order options", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("[data-csz-order-total]")).toHaveText("$8.29 USD");
  await page.clock.fastForward(5000);
  expect(fixture.requests).toHaveLength(reads);
  expect(
    fixture.requests.filter((request) => request.path === "/account/bootstrap"),
  ).toHaveLength(1);
  expect(
    fixture.requests.filter(
      (request) => request.path === "/account/order-summaries",
    ),
  ).toHaveLength(1);
  fixture.assertNoFinancialCommands();
});

test("payment stays in the same tab and the verified completed edit reopens after returning", async ({
  page,
  context,
}) => {
  const fixture = await setup(page);
  const pages = context.pages().length;
  const link = page.getByRole("link", {
    name: "Pay the difference",
    exact: true,
  });
  await expect(link).not.toHaveAttribute("target", "_blank");
  await link.click();
  await expect(
    page.getByRole("heading", { name: "Synthetic payment fixture" }),
  ).toBeVisible();
  expect(context.pages()).toHaveLength(pages);
  fixture.setStatus("completed");
  await page.getByRole("link", { name: "Return to your order" }).click();
  await expect(
    page.getByText("Your order has been updated.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Payment deadline:", { exact: false }),
  ).toHaveCount(0);
  await page.screenshot({
    path: resolve(
      process.cwd(),
      `.codex-artifacts/payment-completed-${test.info().project.name}.png`,
    ),
    fullPage: true,
  });
  await expect(
    page.getByRole("link", { name: "Pay the difference" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem("csz:order-edit-payment-return:v1"),
    ),
  ).toBeNull();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  fixture.assertNoFinancialCommands();
});

test("automatically observes payment and synchronization, then stops at completion", async ({
  page,
}) => {
  const fixture = await setup(page);
  await expect(
    page.getByRole("button", { name: "Check status", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toHaveCount(0);
  fixture.setStatus("synchronizing");
  await page.clock.fastForward(5000);
  await expect(
    page.getByText(
      "We’re finishing your order update. This page will update automatically.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Payment difference:", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Amount still due:", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Pay the difference" }),
  ).toHaveCount(0);
  fixture.setStatus("completed");
  await page.clock.fastForward(5000);
  await expect(
    page.getByText("Your order has been updated.", { exact: true }),
  ).toBeVisible();
  const finishedReads = fixture.reads();
  await page.clock.fastForward(60_000);
  expect(fixture.reads()).toBe(finishedReads);
  fixture.assertNoFinancialCommands();
});

test("checks on returning from another page, pauses in the background and throttles focus events", async ({
  page,
}) => {
  const fixture = await setup(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hiddenReads = fixture.reads();
  fixture.setStatus("completed");
  await page.clock.fastForward(60_000);
  expect(fixture.reads()).toBe(hiddenReads);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pageshow"));
  });
  await expect(
    page.getByText("Your order has been updated.", { exact: true }),
  ).toBeVisible();
  expect(fixture.reads()).toBe(hiddenReads + 1);
  fixture.assertNoFinancialCommands();
});

test("a failed status read offers read-only retry and does not flood the service", async ({
  page,
}) => {
  const fixture = await setup(page);
  fixture.fail(true);
  await page.clock.fastForward(5000);
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeEnabled();
  const failedReads = fixture.reads();
  await page.clock.fastForward(60_000);
  expect(fixture.reads()).toBe(failedReads);
  fixture.fail(false);
  fixture.setStatus("completed");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.clock.runFor(1);
  await expect(
    page.getByText("Your order has been updated.", { exact: true }),
  ).toBeVisible();
  fixture.assertNoFinancialCommands();
});

test("never overlaps slow status reads and ignores a late response after closing the modal", async ({
  page,
}) => {
  const fixture = await setup(page);
  let release!: () => void;
  fixture.hold(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const initialReads = fixture.reads();
  await page.clock.fastForward(5000);
  await expect.poll(fixture.reads).toBe(initialReads + 1);
  await page.clock.fastForward(20_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(fixture.reads()).toBe(initialReads + 1);
  await page
    .getByRole("button", { name: "Close order tools", exact: true })
    .click();
  release();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.clock.fastForward(60_000);
  expect(fixture.reads()).toBe(initialReads + 1);
  fixture.assertNoFinancialCommands();
});

test("failure retries wait for active status reads and issue one explicit reconciliation", async ({
  page,
}) => {
  const fixture = await setup(page);
  fixture.setError("SHOPIFY_UNAVAILABLE");
  await page.clock.fastForward(5000);
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeEnabled();
  let release!: () => void;
  fixture.hold(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const before = fixture.reads();
  await page.clock.fastForward(5000);
  await expect.poll(fixture.reads).toBe(before + 1);
  // A failed command requires the customer's explicit retry; the observer must
  // not dispatch it, or allow it to overlap an older status response.
  fixture.retryReturns(operation("completed"));
  // The status read indicator disables duplicate retries while it is active.
  await expect(
    page.getByRole("button", { name: "Checking…", exact: true }),
  ).toBeDisabled();
  // Let the old read finish, then start the explicit retry; no financial command
  // may be dispatched by the timer while the customer is waiting.
  release();
  fixture.hold(null);
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByText("Your order has been updated.", { exact: true }),
  ).toBeVisible();
  await page.clock.fastForward(60_000);
  await expect(
    page.getByText("Your order has been updated.", { exact: true }),
  ).toBeVisible();
  expect(
    fixture.requests.filter((request) => request.path.endsWith("/reconcile")),
  ).toHaveLength(1);
  expect(
    fixture.requests.some((request) =>
      /\/(commit|abandon|resume|issue|cancel)$/.test(request.path),
    ),
  ).toBe(false);
  expect(fixture.errors).toEqual([]);
});
