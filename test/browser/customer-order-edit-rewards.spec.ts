import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const lineId = "gid://shopify/LineItem/1",
  variantId = "gid://shopify/ProductVariant/1";
const initialRewards = [
  {
    id: firstId,
    code: "SHELLZ-ONE",
    value: "1.00",
    points: "100.00",
    expiresAt: "2030-01-01T00:00:00.000Z",
    status: "available",
  },
  {
    id: secondId,
    code: "SHELLZ-TWO",
    value: "3.66",
    points: "366.00",
    expiresAt: "2030-01-01T00:00:00.000Z",
    status: "available",
  },
];
async function setup(
  page: Page,
  options: {
    quantity?: number;
    failReturn?: boolean;
    loseReturnResponse?: boolean;
    failReturnRefresh?: boolean;
    failPricing?: boolean;
    pendingIssuance?: boolean;
    originalReward?: boolean;
    pausePreview?: boolean;
  } = {},
) {
  const requests: Array<{
    path: string;
    body?: {
      rewardId?: string;
      discountCodes?: string[];
      requestKey?: string;
      points?: number;
    };
    commandKey?: string;
  }> = [];
  const errors: string[] = [];
  let rewards = structuredClone(initialRewards),
    balance = "590.00",
    cancellations = 0,
    refreshFailed = false;
  let issuing = options.pendingIssuance ?? false;
  let issuanceAttempts = 0;
  let resumePreview: (() => void) | undefined;
  if (issuing) rewards = rewards.filter((reward) => reward.id !== firstId);
  const quantity = options.quantity ?? 1;
  const discount = (key: string, label: string, amountCents: number) => ({
    key,
    label,
    amountCents,
    value: { type: "fixed" as const, amountCents },
  });
  const pricing = (count: number, codes: string[] = []) => {
    const saving =
      (codes.includes("SHELLZ-ONE") ? 100 : 0) +
      (codes.includes("SHELLZ-TWO") ? 366 : 0);
    const originalDiscount = options.originalReward ? 233 : 0;
    const original = originalDiscount
      ? [discount("code:ORIGINAL", "ORIGINAL", originalDiscount)]
      : [];
    const net = 233 * count - saving - originalDiscount;
    const tax = Number(
      (BigInt(net + 549) * BigInt(6) + BigInt(50)) / BigInt(100),
    );
    return {
      itemsGrossCents: 279 * count,
      itemsDiscountCents: 46 * count + saving + originalDiscount,
      itemsNetCents: net,
      orderDiscounts: [
        ...original,
        ...codes.map((code) =>
          discount(`code:${code}`, code, code === "SHELLZ-ONE" ? 100 : 366),
        ),
      ],
      itemDiscounts: [
        ...original,
        discount("club", "Club", 46 * count),
        ...codes.map((code) =>
          discount(`code:${code}`, code, code === "SHELLZ-ONE" ? 100 : 366),
        ),
      ],
      itemDiscountLabels: [
        ...(originalDiscount ? ["ORIGINAL"] : []),
        "Club",
        ...codes,
      ],
      shippingGrossCents: 549,
      shippingDiscountCents: 0,
      shippingCents: 549,
      shippingDiscountLabels: [],
      taxCents: tax,
      taxesIncluded: false,
      totalCents: net + 549 + tax,
      lines: [
        {
          id: lineId,
          grossCents: 279 * count,
          discountCents: 46 * count + saving + originalDiscount,
          netCents: net,
          productNetCents: 233 * count,
        },
      ],
    };
  };
  // The shared Club widget has its own tests against its real script. This
  // boundary double observes the models/callbacks supplied by the real editor.
  await page.addInitScript(() => {
    (window as any).CardShellz = {
      mountRedemptionWidget(host: HTMLElement, initial: any) {
        const balance = document.createElement("p"),
          error = document.createElement("p");
        balance.dataset.testid = "club-canonical-balance";
        error.setAttribute("role", "alert");
        host.replaceChildren(balance, error);
        const update = (model: any) => {
          balance.textContent = `${model.pointsBalance} SHELLZ Rewards`;
          error.textContent = model.error ?? "";
          host.dataset.maxPoints = String(model.maxPoints);
        };
        update(initial);
        return { update, destroy: () => host.replaceChildren() };
      },
    };
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  await page.route("**/apps/echelon-returns/account", async (route) => {
    const input = route.request().postDataJSON();
    requests.push(input);
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
    expect(input.expectedCustomerId).toBe("100");
    expect(input.sessionKey).toBe("a".repeat(43));
    if (input.path === "/order-edits/orders/1")
      return route.fulfill({
        json: {
          connectionId: 4,
          omsOrderId: 1,
          orderNumber: "#64043",
          currency: "USD",
          customerName: "Test customer",
          customerEmail: null,
          activeOperationId: null,
          revision: "baseline",
          eligibility: { editable: true, reasons: [] },
          financialStatus: "Paid",
          warehouseStatus: "Not yet picking",
          totalCents: pricing(quantity).totalCents,
          financials: pricing(quantity),
          codeEntryAvailable: true,
          settlement: {
            receivedCents: pricing(quantity).totalCents,
            refundedCents: 0,
            netPaidCents: pricing(quantity).totalCents,
            outstandingCents: 0,
            activity: [],
          },
          lines: [
            {
              lineItemId: lineId,
              variantId,
              title: "Easy Glide Soft Sleeves",
              variantTitle: "Pack of 100",
              sku: "EG-SLV-STD-P100",
              quantity,
              unitPriceCents: 233,
              totalCents: 233 * quantity,
            },
          ],
        },
      });
    if (input.path.endsWith("/rewards/manage")) {
      if (options.failReturnRefresh && cancellations && !refreshFailed) {
        refreshFailed = true;
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: "UNAVAILABLE",
              message: "Rewards could not be loaded.",
            },
          },
        });
      }
      return route.fulfill({
        json: {
          version: "v2",
          balance,
          minimumPoints: 100,
          pointsPerDollar: "100.00",
          currencyName: "SHELLZ Rewards",
          rewards,
          pending: issuing ? [{ requestKey: firstId, points: 100 }] : [],
        },
      });
    }
    if (input.path.endsWith("/rewards/issue")) {
      expect(input.body).toEqual({ requestKey: firstId, points: 100 });
      issuanceAttempts++;
      if (issuanceAttempts === 1)
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: "REWARD_ISSUANCE_PENDING",
              message: "Your reward is still being confirmed.",
            },
          },
        });
      issuing = false;
      rewards.push(structuredClone(initialRewards[0]));
      return route.fulfill({
        json: {
          code: "SHELLZ-ONE",
          value: "1.00",
          expiresAt: initialRewards[0].expiresAt,
          balance,
        },
      });
    }
    if (input.path.endsWith("/rewards/cancel")) {
      expect(input.body.rewardId).toBe(secondId);
      expect(input.commandKey).toBe(input.body.requestKey);
      cancellations++;
      if (options.failReturn && cancellations === 1) {
        rewards[1].status = "cancelling";
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: "REWARD_CANCEL_UNCERTAIN",
              message: "Retry cancellation to finish returning your points.",
            },
          },
        });
      }
      rewards = rewards.filter((reward) => reward.id !== secondId);
      balance = "956.00";
      if (options.loseReturnResponse) return route.abort("failed");
      return route.fulfill({
        json: { points: "366.00", balance, ledgerEntryId: "refund-ledger-1" },
      });
    }
    if (input.path === "/order-edits/previews/warm")
      return route.fulfill({
        json: {
          scope: input.body,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      });
    if (input.path === "/order-edits/previews") {
      if (options.pausePreview)
        await new Promise<void>((resolve) => {
          resumePreview = resolve;
        });
      const codes = input.body.discountCodes ?? [],
        count = input.body.changes[0]?.quantity ?? quantity;
      if (options.failPricing && codes.length)
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "CODE_CONFLICT",
              message: "These rewards cannot be combined on this order.",
            },
          },
        });
      const financials = pricing(count, codes);
      return route.fulfill({
        json: {
          phase: "preview",
          input: input.body,
          calculatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          financials,
          lines: [
            {
              id: lineId,
              variantId,
              title: "Easy Glide Soft Sleeves",
              variantTitle: "Pack of 100",
              quantity: count,
              totalCents: financials.itemsNetCents,
            },
          ],
          appliedCodes: codes.map((code: string) => ({
            code,
            amountCents: code === "SHELLZ-ONE" ? 100 : 366,
          })),
          shippingRepricing: {
            title: "Standard",
            code: "standard",
            source: "Echelon",
            grossCents: 549,
            netCents: 549,
            discountCents: 0,
            discountLabels: [],
          },
        },
      });
    }
    return route.fulfill({
      status: 503,
      json: {
        error: { code: "UNAVAILABLE", message: "Unavailable in fixture" },
      },
    });
  });
  await page.route("**/__customer-rewards-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/customer-order-edit-harness.tsx").replaceAll("\\", "/")}"></script></body></html>`,
    }),
  );
  await page.goto("/__customer-rewards-test");
  await expect(page.getByTestId("club-canonical-balance")).toHaveText(
    "590.00 SHELLZ Rewards",
  );
  return {
    requests,
    errors,
    releasePreview: () => {
      options.pausePreview = false;
      resumePreview?.();
    },
  };
}

test("explains zero remaining merchandise and enables saved rewards after more items are priced", async ({
  page,
}) => {
  const h = await setup(page, { originalReward: true, pausePreview: true });
  const hint = page.getByText(
    "Your items are fully discounted. Rewards can’t be used for shipping or tax.",
  );
  const saved = page
    .getByRole("group", { name: "$1.00 saved reward" })
    .getByRole("button", { name: "Use reward", exact: true });
  await expect(hint).toBeVisible();
  await expect(saved).toBeDisabled();
  await page.getByRole("spinbutton").fill("2");
  await expect
    .poll(() =>
      h.requests.some((request) => request.path === "/order-edits/previews"),
    )
    .toBe(true);
  await expect(hint).toHaveCount(0);
  await expect(saved).toBeDisabled();
  h.releasePreview();
  await expect(saved).toBeEnabled();
  await saved.click();
  await expect(
    page
      .getByRole("group", { name: "$1.00 saved reward" })
      .getByText("Applied", { exact: true }),
  ).toBeVisible();
  expect(h.errors).toEqual([]);
});
test("selects the $1 reward independently and returns the unused $3.66 through Club", async ({
  page,
}) => {
  const h = await setup(page);
  const one = page.getByRole("group", { name: "$1.00 saved reward" }),
    other = page.getByRole("group", { name: "$3.66 saved reward" });
  await expect(
    other.getByRole("button", { name: "Use reward" }),
  ).toBeDisabled();
  await one.getByRole("button", { name: "Use reward" }).click();
  await expect(one.getByText("Applied", { exact: true })).toBeVisible();
  await expect(other.getByText("Unused", { exact: true })).toBeVisible();
  await expect(page.getByTestId("club-canonical-balance")).toHaveText(
    "590.00 SHELLZ Rewards",
  );
  await other.getByRole("button", { name: "Return to points" }).click();
  await expect(page.getByTestId("club-canonical-balance")).toHaveText(
    "956.00 SHELLZ Rewards",
  );
  await expect(other).toHaveCount(0);
  await expect(one.getByText("Applied", { exact: true })).toBeVisible();
  await one.getByRole("button", { name: "Remove" }).click();
  await expect(one.getByText("Unused", { exact: true })).toBeVisible();
  expect(
    h.requests.filter((input) => input.path.endsWith("/cancel")),
  ).toHaveLength(1);
  expect(h.requests.some((input) => /\/issue|\/commit/.test(input.path))).toBe(
    false,
  );
  expect(h.errors).toEqual([]);
  expect(
    await page
      .locator(".oe-rewards")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
});

test("recovers an unfinished issuance once without automatically applying it to another order", async ({
  page,
}) => {
  const h = await setup(page, { pendingIssuance: true });
  const finish = page.getByRole("button", {
    name: "Finish creating 100 point reward",
  });
  await expect(page.getByText("Retry saved", { exact: false })).toHaveCount(0);
  await finish.click();
  await expect(
    page.getByText("Your reward is still being confirmed."),
  ).toBeVisible();
  await page.reload();
  await finish.click();
  await expect(finish).toHaveCount(0);
  const reward = page.getByRole("group", { name: "$1.00 saved reward" });
  await expect(reward.getByText("Unused", { exact: true })).toBeVisible();
  await expect(
    reward.getByRole("button", { name: "Return to points" }),
  ).toBeEnabled();
  await expect(page.getByTestId("club-canonical-balance")).toHaveText(
    "590.00 SHELLZ Rewards",
  );
  expect(
    h.requests
      .filter((input) => input.path.endsWith("/rewards/issue"))
      .map((input) => input.body),
  ).toEqual([
    { requestKey: firstId, points: 100 },
    { requestKey: firstId, points: 100 },
  ]);
  expect(
    h.requests.some((input) =>
      input.body?.discountCodes?.includes("SHELLZ-ONE"),
    ),
  ).toBe(false);
  await reward.getByRole("button", { name: "Use reward" }).click();
  await expect(reward.getByText("Applied", { exact: true })).toBeVisible();
  expect(h.errors).toEqual([]);
});
test("keeps both selected when the merchandise covers their full value", async ({
  page,
}) => {
  const h = await setup(page, { quantity: 2 });
  const one = page.getByRole("group", { name: "$1.00 saved reward" }),
    other = page.getByRole("group", { name: "$3.66 saved reward" });
  await one.getByRole("button", { name: "Use reward" }).click();
  await expect(one.getByText("Applied", { exact: true })).toBeVisible();
  await other.getByRole("button", { name: "Use reward" }).click();
  await expect(other.getByText("Applied", { exact: true })).toBeVisible();
  expect(
    h.requests.some((input) => input.body?.discountCodes?.length === 2),
  ).toBe(true);
  await expect(page.getByTestId("club-canonical-balance")).toHaveText(
    "590.00 SHELLZ Rewards",
  );
});
test("retains an uncertain return after reload and retries the same reward", async ({
  page,
}) => {
  const h = await setup(page, { failReturn: true });
  const other = page.getByRole("group", { name: "$3.66 saved reward" });
  await other.getByRole("button", { name: "Return to points" }).click();
  await expect(other.getByText("Return pending")).toBeVisible();
  await expect(page.getByTestId("club-canonical-balance")).toHaveText(
    "590.00 SHELLZ Rewards",
  );
  await page.reload();
  await other.getByRole("button", { name: "Retry return to points" }).click();
  await expect(page.getByTestId("club-canonical-balance")).toHaveText(
    "956.00 SHELLZ Rewards",
  );
  expect(
    h.requests
      .filter((input) => input.path.endsWith("/cancel"))
      .map((input) => input.body?.rewardId),
  ).toEqual([secondId, secondId]);
});
test("rereads the actual balance when a completed return loses its response", async ({
  page,
}) => {
  await setup(page, { loseReturnResponse: true });
  await page
    .getByRole("group", { name: "$3.66 saved reward" })
    .getByRole("button", { name: "Return to points" })
    .click();
  await expect(page.getByTestId("club-canonical-balance")).toHaveText(
    "956.00 SHELLZ Rewards",
  );
  await expect(
    page.getByRole("group", { name: "$3.66 saved reward" }),
  ).toHaveCount(0);
});
test("leaves rewards unused and returnable when pricing rejects the selection", async ({
  page,
}) => {
  await setup(page, { failPricing: true });
  const one = page.getByRole("group", { name: "$1.00 saved reward" });
  await one.getByRole("button", { name: "Use reward" }).click();
  await expect(
    page.getByText("These rewards cannot be combined on this order."),
  ).toBeVisible();
  await expect(one.getByText("Unused", { exact: true })).toBeVisible();
  await expect(
    one.getByRole("button", { name: "Return to points" }),
  ).toBeEnabled();
});

test("hides stale rewards after a completed return until Club can reload", async ({
  page,
}) => {
  const h = await setup(page, { failReturnRefresh: true });
  await page
    .getByRole("group", { name: "$3.66 saved reward" })
    .getByRole("button", { name: "Return to points" })
    .click();
  await expect(page.getByTestId("club-canonical-balance")).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "$3.66 saved reward" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Retry loading rewards" }).click();
  await expect(page.getByTestId("club-canonical-balance")).toHaveText(
    "956.00 SHELLZ Rewards",
  );
  await expect(
    page.getByRole("group", { name: "$3.66 saved reward" }),
  ).toHaveCount(0);
  expect(
    h.requests.filter((input) => input.path.endsWith("/cancel")),
  ).toHaveLength(1);
});
