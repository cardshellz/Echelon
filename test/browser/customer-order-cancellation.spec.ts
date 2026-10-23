import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import type { CustomerAccountRequest } from "../../shared/customer-account/customer-account.contract";
import {
  customerOrderCancellationInputSchema,
  type CustomerOrderCancellation,
  type CustomerOrderCancellationReview,
} from "../../shared/customer-account/order-cancellation";

const operationId = "11111111-1111-4111-8111-111111111111";
const storageKey = "csz-order-cancellation:v1:100:4:1";
const base = "/account/orders/1/cancellation";
const review: CustomerOrderCancellationReview = {
  connectionId: 4,
  omsOrderId: 1,
  orderNumber: "#fixture",
  currency: "USD",
  revision: "approved-revision",
  orderRevision: "native-revision",
  refundCents: 829,
  rewards: {
    fingerprint: "a".repeat(64),
    returnedPoints: "0.00",
    deductedEarnedPoints: "6.00",
    settled: false,
  },
  eligibility: { allowed: true, reasons: [] },
};

async function fixture(
  page: Page,
  options: {
    lostReply?: boolean;
    failStatusOnce?: boolean;
    notReceived?: boolean;
    reviewChanged?: boolean;
    mismatch?: boolean;
    heldStatus?: Promise<void>;
  } = {},
) {
  const requests: CustomerAccountRequest[] = [];
  const errors: string[] = [];
  let status: CustomerOrderCancellation["status"] = "refunding";
  let accepted = false,
    submissions = 0,
    providerAcceptances = 0,
    statusReads = 0;
  let requestKey: string | null = null;
  let returnedOperationId = operationId;
  await page.clock.install({ time: new Date("2026-10-23T11:22:00Z") });
  page.on("pageerror", (error) => errors.push(error.message));
  const view = (key: string): CustomerOrderCancellation => ({
    operationId: returnedOperationId,
    requestKey: options.mismatch ? "22222222-2222-4222-8222-222222222222" : key,
    omsOrderId: 1,
    orderNumber: "#fixture",
    currency: "USD",
    status,
    refundCents: 829,
    refundStatus: status === "completed" ? "completed" : "pending",
    rewards: { ...review.rewards, settled: status === "completed" },
    error: null,
  });
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
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
    if (input.path === `${base}/review`) return route.fulfill({ json: review });
    if (input.path === `${base}/status`) {
      expect(input.method).toBe("GET");
      expect(input.commandKey).toBeUndefined();
      expect(input.query?.requestKey).toBe(requestKey);
      statusReads++;
      if (options.heldStatus) await options.heldStatus;
      if (options.failStatusOnce && statusReads === 1)
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: "STATUS_UNAVAILABLE",
              message: "Synthetic read failure",
            },
          },
        });
      if (!accepted)
        return route.fulfill({
          status: 404,
          json: {
            error: {
              code: "ORDER_CANCELLATION_UNAVAILABLE",
              message: "The cancellation is unavailable.",
            },
          },
        });
      return route.fulfill({ json: view(requestKey!) });
    }
    if (input.path === base && input.method === "POST") {
      const approval = customerOrderCancellationInputSchema.parse({
        ...(input.body as object),
        connectionId: 4,
        omsOrderId: 1,
      });
      expect(input.commandKey).toBe(approval.requestKey);
      expect(approval.expectedRevision).toBe(review.revision);
      if (requestKey && !(options.reviewChanged && submissions === 1))
        expect(approval.requestKey).toBe(requestKey);
      requestKey = approval.requestKey;
      submissions++;
      if (options.reviewChanged && submissions === 1)
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "ORDER_CANCELLATION_REVIEW_CHANGED",
              message: "Review changed.",
            },
          },
        });
      if (options.notReceived && submissions === 1)
        return route.abort("failed");
      if (!accepted) {
        accepted = true;
        providerAcceptances++;
      }
      if (options.lostReply && submissions === 1) return route.abort("failed");
      return route.fulfill({ json: view(requestKey) });
    }
    return route.fulfill({
      status: 500,
      json: { error: { code: "UNEXPECTED_COMMAND", message: input.path } },
    });
  });
  await page.route("**/__cancellation-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/>
    <script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head>
    <body><div id="root"></div><script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/customer-order-cancellation-harness.tsx").replaceAll("\\", "/")}"></script></body></html>`,
    }),
  );
  await page.goto("/__cancellation-test");
  await expect(
    page.getByRole("button", { name: "Confirm cancellation", exact: true }),
  ).toBeVisible();
  return {
    requests,
    errors,
    submit: () =>
      page
        .getByRole("button", { name: "Confirm cancellation", exact: true })
        .click(),
    setStatus: (next: typeof status) => {
      status = next;
    },
    setReturnedOperationId: (id: string) => {
      returnedOperationId = id;
    },
    counts: () => ({ submissions, statusReads, providerAcceptances }),
    assertSafe: () => {
      expect(
        requests.filter((input) => input.commandKey && input.path !== base),
      ).toEqual([]);
      expect(errors).toEqual([]);
    },
  };
}

test("a lost accepted response is recovered automatically by its saved key without a second submission", async ({
  page,
}) => {
  const f = await fixture(page, { lostReply: true });
  await f.submit();
  await page.clock.runFor(1);
  await expect(
    page.getByRole("heading", { name: "Order cancelled", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Your order is cancelled. Your refund is being processed. This page will update automatically.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText("Refund pending", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toHaveCount(0);
  expect(f.counts()).toEqual({
    submissions: 1,
    statusReads: 1,
    providerAcceptances: 1,
  });
  f.setStatus("completed");
  await page.clock.fastForward(5000);
  await expect(
    page.getByText("Refund processed", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), storageKey),
  ).toBeNull();
  const reads = f.counts().statusReads;
  await page.clock.fastForward(60_000);
  expect(f.counts().statusReads).toBe(reads);
  expect(f.counts().submissions).toBe(1);
  f.assertSafe();
});

test("a failed recovery read stops polling and Try again only reads the same request", async ({
  page,
}) => {
  const f = await fixture(page, { lostReply: true, failStatusOnce: true });
  await f.submit();
  await page.clock.runFor(1);
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeVisible();
  await page.clock.fastForward(60_000);
  expect(f.counts().statusReads).toBe(1);
  expect(f.counts().submissions).toBe(1);
  await retry.click();
  await page.clock.runFor(1);
  await expect(page.getByText("Refund pending", { exact: true })).toBeVisible();
  expect(f.counts()).toEqual({
    submissions: 1,
    statusReads: 2,
    providerAcceptances: 1,
  });
  f.assertSafe();
});

test("reloading an accepted pending request reads it without another review or cancellation", async ({
  page,
}) => {
  const f = await fixture(page, { lostReply: true });
  await f.submit();
  await page.clock.runFor(1);
  await expect(page.getByText("Refund pending", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Refund pending", { exact: true })).toBeVisible();
  expect(f.counts().submissions).toBe(1);
  expect(
    f.requests.filter((input) => input.path.endsWith("/review")),
  ).toHaveLength(1);
  f.assertSafe();
});

test("a request never received by the server requires explicit continuation with the identical approval key", async ({
  page,
}) => {
  const f = await fixture(page, { notReceived: true });
  await f.submit();
  await page.clock.runFor(1);
  await expect(
    page.getByRole("button", { name: "Continue cancellation", exact: true }),
  ).toBeVisible();
  await page.clock.fastForward(60_000);
  expect(f.counts().submissions).toBe(1);
  await page
    .getByRole("button", { name: "Continue cancellation", exact: true })
    .click();
  await expect(page.getByText("Refund pending", { exact: true })).toBeVisible();
  const posts = f.requests.filter((input) => input.path === base);
  expect(posts).toHaveLength(2);
  expect(posts[0].body).toEqual(posts[1].body);
  expect(f.counts().providerAcceptances).toBe(1);
  f.assertSafe();
});

test("a changed review clears the old approval and needs a fresh explicit confirmation", async ({
  page,
}) => {
  const f = await fixture(page, { reviewChanged: true });
  await f.submit();
  await expect(
    page.getByText(
      "The order or rewards changed. Review the cancellation again before confirming.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), storageKey),
  ).toBeNull();
  expect(f.counts().statusReads).toBe(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await f.submit();
  await expect(page.getByText("Refund pending", { exact: true })).toBeVisible();
  const posts = f.requests.filter((input) => input.path === base);
  expect(posts[0].commandKey).not.toBe(posts[1].commandKey);
  expect(f.counts().providerAcceptances).toBe(1);
  f.assertSafe();
});

test("a substituted recovery response cannot confirm cancellation or clear the saved request", async ({
  page,
}) => {
  const f = await fixture(page, { lostReply: true, mismatch: true });
  await f.submit();
  await page.clock.runFor(1);
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Order cancelled", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), storageKey),
  ).not.toBeNull();
  expect(f.counts().submissions).toBe(1);
  f.assertSafe();
});

test("slow recovery reads never overlap and late results cannot reopen a closed panel", async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(page, { lostReply: true, heldStatus: pending });
  await f.submit();
  await expect(
    page.getByRole("heading", {
      name: "Checking your cancellation",
      exact: true,
    }),
  ).toBeVisible();
  await page.clock.runFor(1);
  await expect.poll(() => f.counts().statusReads).toBe(1);
  await page.clock.fastForward(20_000);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(f.counts().statusReads).toBe(1);
  await page
    .getByRole("button", { name: "Close cancellation", exact: true })
    .click();
  release();
  await expect(
    page.getByRole("heading", { name: "Order options closed", exact: true }),
  ).toBeVisible();
  await page.clock.fastForward(60_000);
  await expect(page.getByText("Refund pending", { exact: true })).toHaveCount(
    0,
  );
  expect(f.counts().statusReads).toBe(1);
  expect(f.counts().submissions).toBe(1);
  f.assertSafe();
});

test("a known cancellation cannot be replaced by a different operation in a later status response", async ({
  page,
}) => {
  const f = await fixture(page);
  await f.submit();
  await expect(page.getByText("Refund pending", { exact: true })).toBeVisible();
  f.setReturnedOperationId("22222222-2222-4222-8222-222222222222");
  f.setStatus("completed");
  await page.clock.fastForward(5000);
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Refund processed", { exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate((key) => sessionStorage.getItem(key), storageKey),
  ).not.toBeNull();
  expect(f.counts().submissions).toBe(1);
  f.assertSafe();
});
