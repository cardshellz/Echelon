import { expect, test, type Page } from "@playwright/test";
import {
  orderEditPreviewInputSchema,
  orderEditPreviewScopeSchema,
} from "../../shared/order-edits/order-edit-preview";
import {
  ORDER_EDIT_API,
  orderEditQuoteInputSchema,
  orderEditSettingsInputSchema,
  type OrderEditOperation,
  type OrderEditConnection,
  type OrderEditOrder,
  type OrderEditQuoteInput,
} from "../../shared/order-edits/order-edit.contract";

const operationId = "7862fe7b-a70b-42e8-9ae7-4e2fb16448d0";
const lineId = "gid://shopify/LineItem/123";
const order: OrderEditOrder = {
  connectionId: 3,
  omsOrderId: 51,
  orderNumber: "#60000",
  customerName: "Test Customer",
  customerEmail: "fixture@example.com",
  activeOperationId: null,
  currency: "USD",
  revision: "revision-7",
  eligibility: { editable: true, reasons: [] },
  totalCents: 2000,
  financialStatus: "paid",
  warehouseStatus: "not_started",
  lines: [
    {
      lineItemId: lineId,
      variantId: "gid://shopify/ProductVariant/345",
      title: "Toploader Binder Pages",
      variantTitle: "Black · 1 Binder",
      sku: "BINDER-BLACK",
      quantity: 2,
      unitPriceCents: 1000,
      totalCents: 2000,
    },
  ],
};

async function installFixtures(
  page: Page,
  options: {
    canEdit?: boolean;
    canConfigure?: boolean;
    connectionEnabled?: boolean;
    paymentWindowMinutes?: number | null;
    rejectSettings?: boolean;
    loseQuoteResponse?: boolean;
    loseCommitResponse?: boolean;
    rejectQuote?: boolean;
    existingOperation?: OrderEditOperation;
    staleSearch?: boolean;
    abandonResponse?: Promise<void>;
    loseAbandonResponse?: boolean;
    rejectAbandon?: boolean;
    quoteResponse?: Promise<void>;
    previewResponse?: Promise<void>;
    rejectPreview?: boolean;
  } = {},
) {
  const failures: string[] = [];
  const requests: Array<{
    path: string;
    method: string;
    body: unknown;
    key: string | undefined;
  }> = [];
  let current: OrderEditOperation | null = options.existingOperation ?? null;
  const activeOperationId = () =>
    current &&
    !["completed", "recovered", "failed", "expired"].includes(current.status)
      ? current.operationId
      : null;
  let loseQuote = options.loseQuoteResponse === true;
  let loseCommit = options.loseCommitResponse === true;
  let connection: OrderEditConnection = {
    connectionId: 3,
    channelId: 8,
    name: "Fixture shop",
    shopDomain: "fixture.myshopify.com",
    paymentWindowMinutes:
      options.paymentWindowMinutes === undefined
        ? 60
        : options.paymentWindowMinutes,
    enabled: options.connectionEnabled ?? true,
  };
  await page.clock.setFixedTime(new Date("2026-10-05T12:00:00.000Z"));
  page.on("pageerror", (error) => failures.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: "staff-1",
            username: "Staff fixture",
            role: "admin",
            active: 1,
          },
          roles: ["Administrator"],
          permissions:
            options.canEdit === false
              ? []
              : [
                  "orders:edit",
                  ...(options.canConfigure === false ? [] : ["settings:edit"]),
                ],
        },
      });
    if (!path.startsWith(ORDER_EDIT_API)) {
      if (method !== "GET") {
        failures.push(`Unexpected mutation: ${method} ${path}`);
        return route.abort();
      }
      return route.fulfill({ json: [] });
    }
    const body: unknown = method === "GET" ? null : request.postDataJSON();
    const key = request.headers()["idempotency-key"];
    requests.push({ path, method, body, key });
    if (method !== "GET") {
      expect(request.headers()["content-type"]).toBe("application/json");
      expect(request.headers().origin).toBe(url.origin);
      if (!path.startsWith(`${ORDER_EDIT_API}/previews`))
        expect(key).toMatch(/^[0-9a-f-]{36}$/);
    }
    if (path === `${ORDER_EDIT_API}/state`)
      return route.fulfill({
        json: { connections: [connection], customerAccess: false },
      });
    if (path === `${ORDER_EDIT_API}/settings/3` && method === "PUT") {
      if (options.rejectSettings)
        return route.fulfill({
          status: 422,
          json: {
            code: "SETTINGS_REJECTED",
            message: "Settings could not be saved.",
          },
        });
      connection = {
        ...connection,
        ...orderEditSettingsInputSchema.parse(body),
      };
      return route.fulfill({ json: connection });
    }
    if (path === `${ORDER_EDIT_API}/orders`) {
      expect(url.searchParams.get("connectionId")).toBe("3");
      return route.fulfill({
        json: {
          orders: [
            {
              omsOrderId: order.omsOrderId,
              orderNumber: order.orderNumber,
              customerName: order.customerName,
              customerEmail: order.customerEmail,
              activeOperationId: options.staleSearch
                ? null
                : activeOperationId(),
            },
          ],
        },
      });
    }
    if (path === `${ORDER_EDIT_API}/orders/51`)
      return route.fulfill({
        json: { ...order, activeOperationId: activeOperationId() },
      });
    if (path === `${ORDER_EDIT_API}/variants`)
      return route.fulfill({
        json: {
          variants: [
            {
              variantId: "gid://shopify/ProductVariant/777",
              title: "Card Storage Box",
              variantTitle: "White",
              sku: "BOX-WHITE",
              priceCents: 1500,
              available: true,
            },
          ],
        },
      });
    if (path === `${ORDER_EDIT_API}/previews/warm`) {
      const scope = orderEditPreviewScopeSchema.parse(body);
      expect(key).toBeUndefined();
      return route.fulfill({
        json: { scope, expiresAt: "2026-10-05T12:01:00.000Z" },
      });
    }
    if (path === `${ORDER_EDIT_API}/previews`) {
      const input = orderEditPreviewInputSchema.parse(body);
      expect(key).toBeUndefined();
      await options.previewResponse;
      if (options.rejectPreview)
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: "PREVIEW_UNAVAILABLE",
              message: "Background preview unavailable",
            },
          },
        });
      const quantity = input.changes[0]?.quantity ?? 2;
      const lines = [
        ...(quantity
          ? [
              {
                id: lineId,
                title: "Toploader Binder Pages",
                variantTitle: "Black · 1 Binder",
                quantity,
                totalCents: quantity * 1000,
              },
            ]
          : []),
        ...input.additions.map((item) => ({
          id: item.variantId,
          title: "Card Storage Box",
          variantTitle: "White",
          quantity: item.quantity,
          totalCents: item.quantity * 1500,
        })),
      ];
      const total = lines.reduce((sum, line) => sum + line.totalCents, 0);
      return route.fulfill({
        json: {
          phase: "preview",
          input,
          calculatedAt: "2026-10-05T12:00:00.000Z",
          expiresAt: "2026-10-05T12:01:00.000Z",
          lines,
          financials: {
            itemsGrossCents: total,
            itemsNetCents: total,
            itemsDiscountCents: 0,
            itemDiscountLabels: [],
            shippingGrossCents: 0,
            shippingDiscountCents: 0,
            shippingCents: 0,
            shippingDiscountLabels: [],
            taxCents: 0,
            taxesIncluded: false,
            totalCents: total,
            lines: lines.map((line) => ({
              id: line.id,
              grossCents: line.totalCents,
              netCents: line.totalCents,
              discountCents: 0,
            })),
          },
          shippingRepricing: {
            title: "Standard",
            code: "standard",
            source: "Echelon",
            grossCents: 0,
            discountCents: 0,
            netCents: 0,
            discountLabels: [],
          },
        },
      });
    }
    if (path === `${ORDER_EDIT_API}/quotes`) {
      await options.quoteResponse;
      const input = orderEditQuoteInputSchema.parse(body);
      expect(input.expectedRevision).toBe(order.revision);
      expect(key).toBe(input.requestKey);
      if (
        !current ||
        ["expired", "recovered", "completed", "failed"].includes(current.status)
      ) {
        const quantity = input.changes[0]?.quantity ?? 2;
        const total =
          quantity * 1000 +
          input.additions.reduce((sum, item) => sum + item.quantity * 1500, 0);
        current = {
          operationId: current
            ? "22222222-3333-4444-8555-666666666666"
            : operationId,
          orderNumber: order.orderNumber,
          currency: "USD",
          previousTotalCents: 2000,
          updatedTotalCents: total,
          balanceDueCents: Math.max(0, total - 2000),
          refundDueCents: Math.max(0, 2000 - total),
          lines: [
            {
              id: "calculated-1",
              title: "Toploader Binder Pages",
              variantTitle: "Black · 1 Binder",
              quantity,
              totalCents: quantity * 1000,
            },
            ...input.additions.map((item) => ({
              id: item.variantId,
              title: "Card Storage Box",
              variantTitle: "White",
              quantity: item.quantity,
              totalCents: item.quantity * 1500,
            })),
          ],
          status: options.rejectQuote ? "review_required" : "ready",
          canAbandon: true,
          expiresAt: "2026-10-05T13:00:00.000Z",
          paymentDeadline: null,
          paymentUrl: null,
          warnings: [],
          error: options.rejectQuote
            ? {
                code: "QUOTE_REJECTED",
                message: "The proposed price could not be verified.",
              }
            : null,
        };
      }
      if (loseQuote) {
        loseQuote = false;
        return route.abort("failed");
      }
      return route.fulfill({ json: current });
    }
    if (
      current &&
      path.startsWith(`${ORDER_EDIT_API}/operations/${current.operationId}`)
    ) {
      if (path.endsWith("/commit")) {
        current = {
          ...current,
          status: current.refundDueCents > 0 ? "refunding" : "awaiting_payment",
          canAbandon: false,
          paymentDeadline:
            current.balanceDueCents > 0 ? "2026-10-05T13:00:00.000Z" : null,
          paymentUrl:
            current.balanceDueCents > 0
              ? "https://fixture.myshopify.com/payment/fixture"
              : null,
        };
        if (loseCommit) {
          loseCommit = false;
          return route.abort("failed");
        }
      }
      if (path.endsWith("/abandon")) {
        expect(current.canAbandon).toBe(true);
        await options.abandonResponse;
        if (options.rejectAbandon)
          return route.fulfill({
            status: 409,
            json: {
              code: "ORDER_EDIT_ABANDON_CONFLICT",
              message: "The previous quote could not be closed.",
            },
          });
        current = { ...current, status: "expired", canAbandon: false };
        if (options.loseAbandonResponse) return route.abort("failed");
      }
      return route.fulfill({ json: current });
    }
    failures.push(`Unexpected editor request: ${method} ${path}`);
    return route.abort();
  });
  return {
    requests,
    failures,
    setStatus(status: OrderEditOperation["status"]) {
      if (current) current = { ...current, status };
    },
  };
}
async function chooseOrder(page: Page) {
  await page.goto("/order-edits");
  await page.getByLabel("Find an order").fill("60000");
  await page.getByRole("button", { name: /#60000 Test Customer/ }).click();
  await expect(
    page.getByRole("heading", { name: "Order #60000" }),
  ).toBeVisible();
}
async function assertFitsScreen(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
}

test("Change items returns immediately, keeps the draft and blocks new totals until the prior quote closes", async ({
  page,
}, testInfo) => {
  let releaseAbandon!: () => void;
  const abandonResponse = new Promise<void>((resolve) => {
    releaseAbandon = resolve;
  });
  const fixture = await installFixtures(page, { abandonResponse });
  await chooseOrder(page);
  const quantity = page.getByRole("spinbutton", {
    name: "Quantity for Toploader Binder Pages Black · 1 Binder",
  });
  await quantity.fill("3");
  await page.getByLabel("Add products", { exact: true }).fill("box");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(page.getByText("Ready to apply", { exact: true })).toBeVisible();
  const readsBefore = fixture.requests.filter((request) =>
    request.path.endsWith("/orders/51"),
  ).length;
  await page.getByRole("button", { name: "Change items", exact: true }).click();
  // The request is deliberately unresolved; these assertions cannot pass if
  // the transition waits for Shopify/ShipStation or remounts an empty draft.
  await expect(quantity).toBeVisible({ timeout: 500 });
  await expect(quantity).toHaveValue("3");
  await expect(quantity).toBeEnabled();
  await expect(
    page.getByText("BOX-WHITE", { exact: false }).first(),
  ).toBeVisible();
  const review = page.getByRole("button", {
    name: "Review changes",
    exact: true,
  });
  await expect(review).toBeDisabled();
  await expect(page).toHaveURL(new RegExp(`operationId=${operationId}$`));
  await quantity.fill("4");
  await page.screenshot({
    path: testInfo.outputPath("change-items-closing.png"),
    fullPage: true,
  });
  expect(
    fixture.requests.filter((request) => request.path.endsWith("/quotes")),
  ).toHaveLength(1);
  releaseAbandon();
  await expect(page).toHaveURL(/\/order-edits$/);
  await expect(review).toBeEnabled();
  await expect(quantity).toHaveValue("4");
  expect(
    fixture.requests.filter((request) => request.path.endsWith("/orders/51")),
  ).toHaveLength(readsBefore);
  await review.click();
  await expect(page.getByText("Ready to apply", { exact: true })).toBeVisible();
  const quotes = fixture.requests.filter((request) =>
    request.path.endsWith("/quotes"),
  );
  expect(quotes).toHaveLength(2);
  expect(quotes[1].key).not.toBe(quotes[0].key);
  expect(quotes[1].body).toMatchObject({
    changes: [{ lineItemId: lineId, quantity: 4 }],
    additions: [{ variantId: "gid://shopify/ProductVariant/777", quantity: 1 }],
  });
  expect(
    fixture.requests.filter((request) => request.path.endsWith("/commit")),
  ).toHaveLength(0);
  expect(fixture.failures).toEqual([]);
  await assertFitsScreen(page);
});

for (const failure of ["rejected", "lost"] as const) {
  test(`Change items keeps the operation reference and blocks new totals after ${failure} cancellation`, async ({
    page,
  }) => {
    const fixture = await installFixtures(page, {
      rejectAbandon: failure === "rejected",
      loseAbandonResponse: failure === "lost",
    });
    await chooseOrder(page);
    const quantity = page.getByRole("spinbutton", {
      name: "Quantity for Toploader Binder Pages Black · 1 Binder",
    });
    await quantity.fill("3");
    await page
      .getByRole("button", { name: "Review changes", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Change items", exact: true })
      .click();
    await expect(quantity).toBeVisible();
    await expect(quantity).toHaveValue("3");
    await expect(page.getByRole("alert").last()).toContainText(
      failure === "lost" ? "outcome is unknown" : "could not be closed",
    );
    await expect(
      page.getByRole("button", { name: "Review changes", exact: true }),
    ).toBeDisabled();
    await expect(page).toHaveURL(new RegExp(`operationId=${operationId}$`));
    expect(
      fixture.requests.filter((request) => request.path.endsWith("/quotes")),
    ).toHaveLength(1);
    expect(
      fixture.requests.filter((request) => request.path.endsWith("/commit")),
    ).toHaveLength(0);
    await page
      .getByRole("button", { name: "Back to review", exact: true })
      .click();
    if (failure === "lost") {
      await expect(
        page.getByRole("button", {
          name: "Apply changes · $10.00 payment due",
          exact: true,
        }),
      ).toBeDisabled();
      await page
        .getByRole("button", { name: "Check status", exact: true })
        .click();
      await expect(
        page.getByText("Edit closed", { exact: true }),
      ).toBeVisible();
    }
    expect(fixture.failures).toEqual([]);
  });
}

test("disabled connection guides setup and unlocks the selected order only after a successful save", async ({
  page,
}, testInfo) => {
  const fixture = await installFixtures(page, {
    connectionEnabled: false,
    paymentWindowMinutes: null,
  });
  await chooseOrder(page);
  const quantity = page.getByRole("spinbutton", {
    name: "Quantity for Toploader Binder Pages Black · 1 Binder",
  });
  const save = page.getByRole("button", { name: "Save settings", exact: true });
  await expect(quantity).toBeDisabled();
  await expect(
    page.getByText("Staff edits disabled", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Payment window (hours)")).toBeVisible();
  await expect(page.getByLabel("Payment window (hours)")).toHaveValue("");
  await expect(save).toBeDisabled();
  await expect(
    page.getByText("Enter a payment window before enabling staff edits."),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("disabled-setup.png"),
    fullPage: true,
  });
  await page.getByText("Pilot settings", { exact: true }).click();
  await expect(page.getByLabel("Payment window (hours)")).toBeHidden();
  await page
    .getByRole("button", { name: "Configure staff editing", exact: true })
    .click();
  await expect(page.getByLabel("Payment window (hours)")).toBeFocused();
  await page.getByLabel("Payment window (hours)").fill("0.5");
  await page
    .getByLabel("Enable staff order edits for this Shopify connection")
    .check();
  await expect(quantity).toBeDisabled();
  expect(fixture.requests.every((request) => request.method === "GET")).toBe(
    true,
  );
  await save.click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await expect(
    page.getByText("Staff edits enabled", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Payment window: 0.5 hours", { exact: true }),
  ).toBeVisible();
  await expect(quantity).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Configure staff editing", exact: true }),
  ).toHaveCount(0);
  await quantity.fill("3");
  await expect(
    page.getByRole("button", { name: "Review changes", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("enabled-order.png"),
    fullPage: true,
  });
  const mutations = fixture.requests.filter(
    (request) =>
      request.method !== "GET" &&
      !request.path.startsWith(`${ORDER_EDIT_API}/previews`),
  );
  expect(mutations).toHaveLength(1);
  expect(mutations[0]).toMatchObject({
    method: "PUT",
    path: `${ORDER_EDIT_API}/settings/3`,
    body: { paymentWindowMinutes: 30, enabled: true },
  });
  expect(fixture.failures).toEqual([]);
  await assertFitsScreen(page);
});

test("failed settings save leaves quantities disabled and does not submit an edit", async ({
  page,
}) => {
  const fixture = await installFixtures(page, {
    connectionEnabled: false,
    paymentWindowMinutes: null,
    rejectSettings: true,
  });
  await chooseOrder(page);
  await page.getByLabel("Payment window (hours)").fill("0.5");
  await page
    .getByLabel("Enable staff order edits for this Shopify connection")
    .check();
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Settings could not be saved.",
  );
  await expect(
    page.getByText("Staff edits disabled", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("spinbutton", {
      name: "Quantity for Toploader Binder Pages Black · 1 Binder",
    }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Review changes", exact: true }),
  ).toBeDisabled();
  expect(
    fixture.requests.filter((request) => request.method !== "GET"),
  ).toHaveLength(1);
  expect(
    fixture.requests.some((request) => request.path.endsWith("/quotes")),
  ).toBe(false);
  expect(fixture.failures).toEqual([]);
});

test("decimal hours preserve loaded settings and save exact minutes", async ({
  page,
}) => {
  const fixture = await installFixtures(page, { paymentWindowMinutes: 30 });
  await chooseOrder(page);
  await expect(
    page.getByText("Payment window: 0.5 hours", { exact: true }),
  ).toBeVisible();
  await page.getByText("Pilot settings", { exact: true }).click();
  const input = page.getByLabel("Payment window (hours)");
  const save = page.getByRole("button", { name: "Save settings", exact: true });
  await expect(input).toHaveValue("0.5");
  for (const value of ["0", "-1", "169", "0.01", "1.001"]) {
    await input.fill(value);
    await expect(save).toBeDisabled();
  }
  expect(
    fixture.requests.every(
      (request) =>
        request.method === "GET" ||
        request.path.startsWith(`${ORDER_EDIT_API}/previews`),
    ),
  ).toBe(true);
  await input.fill("1.25");
  await save.click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await expect(input).toHaveValue("1.25");
  await expect(
    page.getByText("Payment window: 1.25 hours", { exact: true }),
  ).toBeVisible();
  expect(
    fixture.requests.filter(
      (request) =>
        request.method !== "GET" &&
        !request.path.startsWith(`${ORDER_EDIT_API}/previews`),
    ),
  ).toEqual([
    expect.objectContaining({
      method: "PUT",
      path: `${ORDER_EDIT_API}/settings/3`,
      body: { paymentWindowMinutes: 75, enabled: true },
    }),
  ]);
  expect(fixture.failures).toEqual([]);
  await assertFitsScreen(page);
});

test("order editors without settings permission see the administrator instruction and cannot enable the connection", async ({
  page,
}) => {
  const fixture = await installFixtures(page, {
    connectionEnabled: false,
    paymentWindowMinutes: null,
    canConfigure: false,
  });
  await chooseOrder(page);
  await expect(
    page.getByText("Ask an administrator with settings permission", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Payment window (hours)")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Configure staff editing", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("spinbutton", {
      name: "Quantity for Toploader Binder Pages Black · 1 Binder",
    }),
  ).toBeDisabled();
  expect(fixture.requests.every((request) => request.method === "GET")).toBe(
    true,
  );
  expect(fixture.failures).toEqual([]);
});

test("staff can configure a payment window, quote quantity/addition changes and open pending payment", async ({
  page,
}, testInfo) => {
  const fixture = await installFixtures(page);
  await chooseOrder(page);
  await page.getByText("Pilot settings", { exact: true }).click();
  await page.getByLabel("Payment window (hours)").fill("0");
  await expect(
    page.getByRole("button", { name: "Save settings", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Payment window (hours)").fill("2");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await page
    .getByRole("spinbutton", {
      name: "Quantity for Toploader Binder Pages Black · 1 Binder",
    })
    .fill("-1");
  await expect(page.getByRole("alert")).toContainText(
    "Check the item quantities",
  );
  await expect(
    page.getByRole("button", { name: "Review changes", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("spinbutton", {
      name: "Quantity for Toploader Binder Pages Black · 1 Binder",
    })
    .fill("3");
  await page.getByLabel("Add products", { exact: true }).fill("box");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`operationId=${operationId}$`));
  await expect(page.getByText("Ready to apply", { exact: true })).toBeVisible();
  await assertFitsScreen(page);
  const screenshotPath = testInfo.outputPath("verified-quote.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach("verified-quote", {
    path: screenshotPath,
    contentType: "image/png",
  });
  await page
    .getByRole("button", {
      name: "Apply changes · $25.00 payment due",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Awaiting payment", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^(Cancel edit|Change items)$/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Open Shopify payment" }),
  ).toHaveAttribute("href", "https://fixture.myshopify.com/payment/fixture");
  expect(
    fixture.requests.filter((request) => request.path.endsWith("/commit")),
  ).toHaveLength(1);
  expect(fixture.failures).toEqual([]);
});

test("net reduction previews its refund and waits for confirmed completion", async ({
  page,
}) => {
  const fixture = await installFixtures(page);
  await chooseOrder(page);
  await page
    .getByRole("spinbutton", {
      name: "Quantity for Toploader Binder Pages Black · 1 Binder",
    })
    .fill("1");
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Apply changes and refund $10.00",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Refund processing", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^(Cancel edit|Change items)$/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Open Shopify payment" }),
  ).toHaveCount(0);
  fixture.setStatus("completed");
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(
    page.getByText("Changes completed", { exact: true }),
  ).toBeVisible();
  expect(fixture.failures).toEqual([]);
});

test("lost quote response survives refresh and resumes the exact same command", async ({
  page,
}) => {
  const fixture = await installFixtures(page, { loseQuoteResponse: true });
  await chooseOrder(page);
  await page
    .getByRole("spinbutton", {
      name: "Quantity for Toploader Binder Pages Black · 1 Binder",
    })
    .fill("3");
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry same quote request", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Resume saved quote request" }),
  ).toBeVisible();
  await expect(page.getByLabel("Find an order")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Resume saved request", exact: true })
    .click();
  await expect(page.getByText("Ready to apply", { exact: true })).toBeVisible();
  const quotes = fixture.requests.filter((request) =>
    request.path.endsWith("/quotes"),
  );
  expect(quotes).toHaveLength(2);
  expect(quotes[0].body).toEqual(quotes[1].body);
  expect(quotes[0].key).toBe(quotes[1].key);
  expect((quotes[0].body as OrderEditQuoteInput).changes).toEqual([
    { lineItemId: lineId, quantity: 3 },
  ]);
  expect(fixture.failures).toEqual([]);
});

test("lost commit response only checks the existing operation, then reports recovery accurately", async ({
  page,
}) => {
  const fixture = await installFixtures(page, { loseCommitResponse: true });
  await chooseOrder(page);
  await page
    .getByRole("spinbutton", {
      name: "Quantity for Toploader Binder Pages Black · 1 Binder",
    })
    .fill("3");
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Apply changes · $10.00 payment due",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("The last request may have completed.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(
    page.getByText("Awaiting payment", { exact: true }),
  ).toBeVisible();
  fixture.setStatus("recovering");
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(
    page.getByText("Recovering original order", { exact: true }),
  ).toBeVisible();
  fixture.setStatus("recovered");
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(
    page.getByText("Original order restored", { exact: true }),
  ).toBeVisible();
  expect(
    fixture.requests.filter((request) => request.path.endsWith("/commit")),
  ).toHaveLength(1);
  expect(fixture.failures).toEqual([]);
});

test("route permission denies the editor without loading any order-edit data", async ({
  page,
}) => {
  const fixture = await installFixtures(page, { canEdit: false });
  await page.goto("/order-edits");
  await expect(page).toHaveURL(/\/picking$/);
  await expect(page.getByLabel("Find an order")).toHaveCount(0);
  expect(fixture.requests).toEqual([]);
  expect(fixture.failures).toEqual([]);
});

test("rejected quote can be cancelled before financial submission without stranding the editor", async ({
  page,
}) => {
  const fixture = await installFixtures(page, { rejectQuote: true });
  await chooseOrder(page);
  await page
    .getByRole("spinbutton", {
      name: "Quantity for Toploader Binder Pages Black · 1 Binder",
    })
    .fill("3");
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(
    page.getByText("Staff review required", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "The proposed price could not be verified.",
  );
  await expect(
    page.getByRole("button", { name: /^Apply changes/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel edit", exact: true }).click();
  await expect(page).toHaveURL(/\/order-edits$/);
  await expect(page.getByLabel("Find an order")).toBeVisible();
  expect(
    fixture.requests.filter((request) => request.path.endsWith("/abandon")),
  ).toHaveLength(1);
  expect(
    fixture.requests.filter((request) => request.path.endsWith("/commit")),
  ).toHaveLength(0);
  expect(fixture.failures).toEqual([]);
});

function persistedOperation(
  status: "awaiting_payment" | "review_required",
): OrderEditOperation {
  return {
    operationId,
    orderNumber: order.orderNumber,
    currency: "USD",
    canAbandon: status === "review_required",
    previousTotalCents: 2000,
    updatedTotalCents: 3000,
    balanceDueCents: 1000,
    refundDueCents: 0,
    lines: [
      {
        id: "calculated-1",
        title: "Toploader Binder Pages",
        variantTitle: "Black · 1 Binder",
        quantity: 3,
        totalCents: 3000,
      },
    ],
    warnings: [],
    expiresAt: "2026-10-05T13:00:00.000Z",
    paymentDeadline:
      status === "awaiting_payment" ? "2026-10-05T13:00:00.000Z" : null,
    status,
    paymentUrl:
      status === "awaiting_payment"
        ? "https://fixture.myshopify.com/payment/fixture"
        : null,
    error:
      status === "review_required"
        ? {
            code: "QUOTE_REJECTED",
            message: "The proposed price could not be verified.",
          }
        : null,
  };
}

for (const status of ["awaiting_payment", "review_required"] as const) {
  test(`fresh browser resumes a persisted ${status} edit from order search without a new quote`, async ({
    page,
  }) => {
    const fixture = await installFixtures(page, {
      existingOperation: persistedOperation(status),
    });
    await page.goto("/order-edits");
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
    await page.getByLabel("Find an order").fill("60000");
    await page
      .getByRole("button", { name: /#60000 Test Customer.*Resume edit/ })
      .click();
    await expect(page).toHaveURL(new RegExp(`operationId=${operationId}$`));
    await expect(
      page.getByText(
        status === "awaiting_payment"
          ? "Awaiting payment"
          : "Staff review required",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Review changes", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^Apply changes/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Cancel edit", exact: true }),
    ).toHaveCount(status === "review_required" ? 1 : 0);
    expect(
      fixture.requests.some((request) => request.path.endsWith("/orders/51")),
    ).toBe(false);
    expect(fixture.requests.every((request) => request.method === "GET")).toBe(
      true,
    );
    expect(fixture.failures).toEqual([]);
    await assertFitsScreen(page);
  });
}

test("an active edit discovered after stale search results replaces the editing form with resume", async ({
  page,
}) => {
  const fixture = await installFixtures(page, {
    existingOperation: persistedOperation("review_required"),
    staleSearch: true,
  });
  await page.goto("/order-edits");
  await page.getByLabel("Find an order").fill("60000");
  await page.getByRole("button", { name: /#60000 Test Customer/ }).click();
  await expect(
    page.getByText("#60000 already has an active edit.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review changes", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Add products", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Resume edit", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`operationId=${operationId}$`));
  await expect(
    page.getByText("Staff review required", { exact: true }),
  ).toBeVisible();
  expect(fixture.requests.every((request) => request.method === "GET")).toBe(
    true,
  );
  expect(fixture.failures).toEqual([]);
});

test("warms pricing on open, calculates after a pause and shows preview immediately while Apply remains blocked", async ({
  page,
}, testInfo) => {
  let finishQuote!: () => void;
  const quoteResponse = new Promise<void>((resolve) => {
    finishQuote = resolve;
  });
  const fixture = await installFixtures(page, { quoteResponse });
  await chooseOrder(page);
  await expect
    .poll(
      () =>
        fixture.requests.filter((r) => r.path.endsWith("/previews/warm"))
          .length,
    )
    .toBe(1);
  expect(
    fixture.requests.some((r) => /\/(quotes|commit|abandon)$/.test(r.path)),
  ).toBe(false);
  const quantity = page.getByRole("spinbutton", {
    name: "Quantity for Toploader Binder Pages Black · 1 Binder",
  });
  await quantity.fill("3");
  await expect(
    page.getByText("Updated total preview: $30.00", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(
    page.getByText("Preview · verifying", { exact: true }),
  ).toBeVisible({ timeout: 1500 });
  await expect(
    page.getByRole("button", { name: "Verifying changes…", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: /^Apply changes/ }),
  ).toHaveCount(0);
  expect(
    fixture.requests.filter((r) => r.path.endsWith("/quotes")),
  ).toHaveLength(1);
  expect(fixture.requests.some((r) => r.path.endsWith("/commit"))).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath("preview-verifying.png"),
    fullPage: true,
  });
  await assertFitsScreen(page);
  finishQuote();
  await expect(page.getByText("Ready to apply", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Apply changes/ }),
  ).toBeEnabled();
  expect(fixture.failures).toEqual([]);
});

test("a delayed old preview is discarded after quantities change", async ({
  page,
}) => {
  let finishPreview!: () => void;
  let finishQuote!: () => void;
  const fixture = await installFixtures(page, {
    previewResponse: new Promise<void>((resolve) => {
      finishPreview = resolve;
    }),
    quoteResponse: new Promise<void>((resolve) => {
      finishQuote = resolve;
    }),
  });
  await chooseOrder(page);
  const quantity = page.getByRole("spinbutton", {
    name: "Quantity for Toploader Binder Pages Black · 1 Binder",
  });
  await quantity.fill("3");
  await expect
    .poll(
      () => fixture.requests.filter((r) => r.path.endsWith("/previews")).length,
    )
    .toBe(1);
  await quantity.fill("4");
  await page
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(
    page.getByText("Verifying changes", { exact: true }),
  ).toBeVisible({ timeout: 1500 });
  finishPreview();
  await expect(
    page.getByText("Preview · verifying", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /^Apply changes/ }),
  ).toHaveCount(0);
  expect(
    fixture.requests.find((r) => r.path.endsWith("/quotes"))?.body,
  ).toMatchObject({ changes: [{ lineItemId: lineId, quantity: 4 }] });
  finishQuote();
  await expect(
    page.getByRole("button", {
      name: "Apply changes · $20.00 payment due",
      exact: true,
    }),
  ).toBeEnabled();
  expect(fixture.failures).toEqual([]);
});

test("background calculation failure leaves Review available and never locks a financial command", async ({
  page,
}) => {
  const fixture = await installFixtures(page, { rejectPreview: true });
  await chooseOrder(page);
  await page
    .getByRole("spinbutton", {
      name: "Quantity for Toploader Binder Pages Black · 1 Binder",
    })
    .fill("3");
  await expect(
    page.getByText("Background totals are unavailable.", { exact: false }),
  ).toBeVisible();
  const review = page.getByRole("button", {
    name: "Review changes",
    exact: true,
  });
  await expect(review).toBeEnabled();
  expect(fixture.requests.some((r) => r.path.endsWith("/quotes"))).toBe(false);
  await review.click();
  await expect(page.getByText("Ready to apply", { exact: true })).toBeVisible();
  expect(
    fixture.requests.filter((r) => r.path.endsWith("/quotes")),
  ).toHaveLength(1);
  expect(fixture.failures).toEqual([]);
});
