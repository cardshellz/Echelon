import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import type {
  OrderEditOperation,
  OrderEditOrder,
} from "../../shared/order-edits/order-edit.contract";

const operationId = "a5c5a236-9b81-4e66-a1dc-bd9c1e9f27d0";
const lineId = "gid://shopify/LineItem/1";
const variantId = "gid://shopify/ProductVariant/1";
const baseline = {
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
  lines: [{ id: lineId, grossCents: 279, discountCents: 46, netCents: 233 }],
};
const updated = {
  ...baseline,
  itemsGrossCents: 558,
  itemsDiscountCents: 92,
  itemsNetCents: 466,
  taxCents: 61,
  totalCents: 1076,
  lines: [{ id: lineId, grossCents: 558, discountCents: 92, netCents: 466 }],
};
const settlement = {
  receivedCents: 829,
  refundedCents: 0,
  netPaidCents: 829,
  outstandingCents: 0,
  activity: [],
};
const order: OrderEditOrder = {
  connectionId: 4,
  omsOrderId: 1,
  orderNumber: "#64043",
  currency: "USD",
  customerName: "Test customer",
  customerEmail: null,
  activeOperationId: operationId,
  revision: "baseline",
  eligibility: { editable: true, reasons: [] },
  financialStatus: "Paid",
  warehouseStatus: "Not yet picking",
  totalCents: 829,
  financials: baseline,
  settlement,
  codeEntryAvailable: true,
  lines: [
    {
      lineItemId: lineId,
      variantId,
      title: "Easy Glide Soft Sleeves",
      variantTitle: "Pack of 100",
      sku: "EG-SLV-STD-P100",
      quantity: 1,
      unitPriceCents: 233,
      totalCents: 233,
    },
  ],
};
function operation(
  status: "preparing" | "review_required" | "ready" | "awaiting_payment",
  expired = false,
): OrderEditOperation {
  const ready = status === "ready";
  return {
    operationId,
    orderNumber: order.orderNumber,
    currency: "USD",
    status,
    canAbandon: status !== "awaiting_payment",
    quoteAvailable: ready,
    expectedRevision: "baseline",
    requestedPlan: {
      changes: [{ lineItemId: lineId, quantity: 2 }],
      additions: [],
      discountCodes: [],
    },
    previousTotalCents: 829,
    updatedTotalCents: ready ? 1076 : 829,
    balanceDueCents: ready ? 247 : 0,
    refundDueCents: 0,
    financials: {
      before: baseline,
      current: baseline,
      quoted: ready ? updated : null,
    },
    settlement,
    lines: [
      {
        id: lineId,
        variantId,
        title: "Easy Glide Soft Sleeves",
        variantTitle: "Pack of 100",
        quantity: ready ? 2 : 1,
        totalCents: ready ? 466 : 233,
      },
    ],
    warnings: [],
    expiresAt: new Date(
      Date.now() + (expired ? -60_000 : 600_000),
    ).toISOString(),
    paymentDeadline: null,
    paymentUrl: null,
    error:
      status === "review_required"
        ? { code: "ORDER_EDIT_UNAVAILABLE", message: "Old failed preparation" }
        : null,
  };
}

async function setup(
  page: Page,
  options: {
    initial?: "preparing" | "review_required" | "ready" | "awaiting_payment";
    expired?: boolean;
    retryFails?: boolean;
    loseResume?: boolean;
  } = {},
) {
  const requests: Array<{ path: string; method: string; commandKey?: string }> =
    [];
  const errors: string[] = [];
  let resumes = 0;
  let current = operation(
    options.initial ?? "review_required",
    options.expired,
  );
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  await page.route("**/apps/echelon-returns/account", async (route) => {
    const input = route.request().postDataJSON();
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
            name: "Shopify",
            enabled: true,
            paymentWindowMinutes: 30,
          },
        },
      });
    expect(input.sessionKey).toBe("a".repeat(43));
    if (input.path === "/order-edits/orders/1")
      return route.fulfill({ json: order });
    if (input.path === `/order-edits/operations/${operationId}`)
      return route.fulfill({ json: current });
    if (input.path === `/order-edits/operations/${operationId}/resume`) {
      expect(input.commandKey).toBe(operationId);
      resumes += 1;
      current =
        options.retryFails && resumes === 1
          ? operation("review_required")
          : operation("ready");
      if (options.loseResume && resumes === 1) return route.abort("failed");
      return route.fulfill({ json: current });
    }
    if (input.path === `/order-edits/operations/${operationId}/reconcile`)
      return route.fulfill({ json: current });
    if (input.path.startsWith("/order-edits/catalog/"))
      return route.fulfill({
        status: 503,
        json: {
          error: {
            code: "CATALOG_UNAVAILABLE",
            message: "Catalog unavailable in this fixture",
          },
        },
      });
    return route.fulfill({
      status: 500,
      json: {
        error: {
          code: "UNEXPECTED_REQUEST",
          message: `Unexpected ${input.path}`,
        },
      },
    });
  });
  await page.route("**/__customer-edit-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
    <body><div id="root"></div><script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/customer-order-edit-harness.tsx").replaceAll("\\", "/")}"></script></body></html>`,
    }),
  );
  await page.goto("/__customer-edit-test");
  return { requests, errors };
}

for (const initial of ["preparing", "review_required", "ready"] as const) {
  test(`reopening ${initial === "ready" ? "an expired" : initial === "preparing" ? "an interrupted" : "a failed"} customer edit restores the same plan and enables Apply`, async ({
    page,
  }) => {
    const f = await setup(page, { initial, expired: true });
    await expect(
      page.getByRole("button", {
        name: "Apply changes · $2.47 due",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(page.getByRole("spinbutton")).toHaveValue("2");
    await expect(
      page.getByText("Another order edit holds this order."),
    ).toHaveCount(0);
    await expect(page.getByText("Old failed preparation")).toHaveCount(0);
    await expect(page.getByText(`Edit reference ${operationId}`)).toBeVisible();
    expect(
      f.requests.filter((request) => request.path.endsWith("/resume")),
    ).toHaveLength(1);
    expect(
      f.requests.some((request) =>
        /\/(quotes|commit|abandon)$/.test(request.path),
      ),
    ).toBe(false);
    expect(f.errors).toEqual([]);
  });
}

test("a second preparation failure retains selections and offers a direct retry", async ({
  page,
}) => {
  const f = await setup(page, { retryFails: true });
  await expect(page.getByRole("spinbutton")).toHaveValue("2");
  await page
    .getByRole("button", { name: "Retry changes", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Apply changes · $2.47 due",
      exact: true,
    }),
  ).toBeEnabled();
  expect(
    f.requests.filter((request) => request.path.endsWith("/resume")),
  ).toHaveLength(2);
  expect(
    f.requests.some((request) =>
      /\/(quotes|commit|abandon)$/.test(request.path),
    ),
  ).toBe(false);
});

test("an uncertain resume is reconciled without repeating or applying the edit", async ({
  page,
}) => {
  const f = await setup(page, { loseResume: true });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Apply changes · $2.47 due",
      exact: true,
    }),
  ).toBeEnabled();
  expect(
    f.requests.filter((request) => request.path.endsWith("/resume")),
  ).toHaveLength(1);
  expect(
    f.requests.some((request) =>
      /\/(quotes|commit|abandon)$/.test(request.path),
    ),
  ).toBe(false);
});

test("an already submitted operation is never prepared again on reopen", async ({
  page,
}) => {
  const f = await setup(page, { initial: "awaiting_payment" });
  await expect(
    page.getByText(`Edit reference ${operationId}`).filter({ visible: true }),
  ).toBeVisible();
  expect(
    f.requests.some((request) =>
      /\/(quotes|resume|commit|abandon)$/.test(request.path),
    ),
  ).toBe(false);
});
