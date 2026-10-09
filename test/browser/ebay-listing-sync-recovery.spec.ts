import { expect, test } from "@playwright/test";
import { setupEbayChannelPage } from "./fixtures/ebay-channel-page.fixture";

const job = {
  id: "6e4d8e03-3197-4d21-a6d7-aa1ddaecc775",
  productId: 1,
  state: "queued",
  code: null as string | null,
  message: null as string | null,
  nextAttemptAt: "2026-10-09T12:00:00.000Z",
  updatedAt: "2026-10-09T12:00:00.000Z",
};
const pending = {
  synced: 0,
  priceChanges: 0,
  qtyChanges: 0,
  policyChanges: 0,
  errors: 0,
  pending: 1,
  details: [],
  jobs: [job],
};
const statusName = "Sync status for 55PT Toploader Combo Pack";

test("saved sync survives reload, shows recovery, and clears only after verified server completion", async ({
  page,
}, info) => {
  const state = await setupEbayChannelPage(page);
  state.response = pending;
  state.feedStatus = "error";
  state.syncError =
    "A prior provider quantity outcome requires reconciliation.";
  await page
    .getByTitle("Sync this listing", { exact: true })
    .filter({ visible: true })
    .click();
  await expect(
    page.locator('li[role="status"]').filter({ hasText: "Sync Saved" }),
  ).toBeVisible();
  await expect(page.getByRole("status", { name: statusName })).toContainText(
    "waiting to run",
  );
  await expect(
    page.locator('li[role="status"]').filter({ hasText: "Product Synced" }),
  ).toHaveCount(0);
  expect(state.commands[0]).toMatch(/^[a-f0-9-]{36}$/);

  state.jobs = [
    {
      ...job,
      state: "recovering",
      code: "EBAY_QUANTITY_RESPONSE_UNCERTAIN",
      message:
        "eBay returned error 25002. The saved job will check its final response and retry.",
    },
  ];
  await page.reload();
  await expect(page.getByRole("status", { name: statusName })).toContainText(
    "recovering automatically",
  );
  await expect(page.getByText(state.syncError, { exact: true })).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("ebay-sync-recovery.png"),
    fullPage: true,
  });

  state.jobs = [{ ...job, state: "completed" }];
  state.feedStatus = "listed";
  state.syncError = null;
  await page.reload();
  await expect(
    page.getByText("55PT Toploader Combo Pack", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status", { name: statusName })).toHaveCount(0);
  await expect(
    page.getByText("Listed", { exact: true }).filter({ visible: true }),
  ).toBeVisible();
  expect(state.requests).toHaveLength(1);
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("missing terminal evidence stays actionable and cannot claim automatic success", async ({
  page,
}) => {
  const state = await setupEbayChannelPage(page);
  const message =
    "A prior request has no provable final response (attempts 17348). Reconcile that request before another write.";
  state.jobs = [
    {
      ...job,
      state: "awaiting_evidence",
      code: "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED",
      message,
    },
  ];
  state.feedStatus = "error";
  state.syncError = "obsolete blocker";
  await page.reload();
  await expect(page.getByRole("status", { name: statusName })).toContainText(
    "Sync needs evidence",
  );
  await expect(page.getByRole("status", { name: statusName })).toContainText(
    "17348",
  );
  await expect(page.getByText("obsolete blocker", { exact: true })).toHaveCount(
    0,
  );
  expect(state.requests).toEqual([]);
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test("bulk sync reports retained work rather than displaying pending products as failures", async ({
  page,
}) => {
  const state = await setupEbayChannelPage(page);
  await page.route("**/api/ebay/listings/sync-stream", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: [
        {
          type: "progress",
          product: "55PT Toploader Combo Pack",
          productId: 1,
          status: "pending",
          current: 1,
          total: 1,
        },
        {
          type: "complete",
          summary: { ...pending, total: 1 },
          cancelled: false,
        },
      ]
        .map((value) => `data: ${JSON.stringify(value)}\n\n`)
        .join(""),
    }),
  );
  await page.getByRole("button", { name: "Sync All (1)", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Sync Saved");
  await expect(dialog).toContainText(
    "Update saved. Recovery will continue automatically.",
  );
  await expect(dialog.getByText("1 failed", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
