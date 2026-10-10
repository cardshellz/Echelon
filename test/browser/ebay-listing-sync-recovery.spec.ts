import { expect, test } from "@playwright/test";
import { setupEbayChannelPage } from "./fixtures/ebay-channel-page.fixture";
import { resolveEbayListingIssue } from "../../shared/ebay-listing-issue";

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
    "Update paused",
  );
  await expect(page.getByText(message, { exact: true })).toContainText(
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
    "Update saved. Check the listing for progress; you can close this window.",
  );
  await expect(dialog.getByText("1 failed", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

const blockedJob = {
  ...job, state: "awaiting_evidence", code: "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED",
  message: "A prior request has no provable final response (attempts 16323).",
};
const preview = {
  jobId: job.id, productId: 1, canRecover: true, canResume: true, blockReason: null,
  previewHash: "a".repeat(64),
  attempts: [{ attemptId: "16323", state: "uncertain", skus: ["SHLZ-TOP-260PT-P10"], startedAt: "2026-10-01T12:00:00.000Z",
    requests: [{ requestId: "22001", method: "PUT", path: "/sell/inventory/v1/inventory_item/SHLZ-TOP-260PT-P10", httpStatus: 400, responseRecorded: true, errorCodes: [], outcome: "uncertain" }],
  }],
};

test("blocked quantity update has a preview and explicit audited resume action", async ({ page }, info) => {
  const state = await setupEbayChannelPage(page);
  state.jobs = [blockedJob];
  const commands: unknown[] = [];
  await page.route(`**/api/ebay/listings/sync-jobs/${job.id}/recovery`, async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: preview });
    commands.push(route.request().postDataJSON());
    state.jobs = [job];
    return route.fulfill({ json: { attemptIds: ["16323"], replayed: false, providerWriteAttempted: false, job } });
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "Errors (1)", exact: true })).toBeVisible();
  await expect(page.getByText("Listed · update paused", { exact: true }).filter({ visible: true })).toBeVisible();
  await page.getByRole("button", { name: "Review blocked update", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("SHLZ-TOP-260PT-P10 · Attempt 16323");
  await dialog.getByText("Recorded response details", { exact: true }).click();
  await expect(dialog).toContainText("HTTP response: 400");
  await expect(dialog).toContainText("eBay codes: None recorded");
  await dialog.getByRole("button", { name: "Refresh request details" }).click();
  expect(commands).toEqual([]);
  const resume = dialog.getByRole("button", { name: "Resume with current inventory", exact: true });
  await expect(resume).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await expect(resume).toBeEnabled();
  await page.screenshot({ path: info.outputPath("ebay-recovery-confirmation.png"), fullPage: true });
  await resume.click();
  await expect(dialog).toContainText("Recovery saved. The listing update will continue using current inventory.");
  expect(commands).toEqual([{ previewHash: preview.previewHash, acknowledgeUnknownOutcome: true, idempotencyKey: expect.stringMatching(/^[a-f0-9-]{36}$/) }]);
  expect(state.requests).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("recovery is unavailable without inventory administrator permission", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.jobs = [blockedJob];
  await page.route(`**/api/ebay/listings/sync-jobs/${job.id}/recovery`, (route) => route.fulfill({ json: { ...preview, canRecover: false, requiredPermission: "inventory_planning.activate" } }));
  await page.reload();
  await page.getByRole("button", { name: "Review blocked update", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("An inventory administrator must authorize this recovery.");
  await expect(dialog.getByRole("button", { name: "Resume with current inventory", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a lost recovery response retains its idempotency key for the retry", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.jobs = [blockedJob];
  const commands: Array<{ idempotencyKey: string }> = [];
  await page.route(`**/api/ebay/listings/sync-jobs/${job.id}/recovery`, async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: preview });
    commands.push(route.request().postDataJSON());
    if (commands.length === 1) return route.fulfill({ status: 503, json: { error: "Recovery response was interrupted." } });
    return route.fulfill({ json: { attemptIds: ["16323"], replayed: true, providerWriteAttempted: false, job } });
  });
  await page.reload(); await page.getByRole("button", { name: "Review blocked update", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Resume with current inventory", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Recovery response was interrupted.");
  await dialog.getByRole("button", { name: "Resume with current inventory", exact: true }).click();
  await expect(dialog).toContainText("Recovery saved.");
  expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("bulk sync keeps product failures visible beside accepted work and offers the catalog fix", async ({ page }) => {
  const state = await setupEbayChannelPage(page);
  const issue = resolveEbayListingIssue({ code: "EBAY_CATALOG_PHOTO_REQUIRED", message: "Case variant has no included photo.", productId: 2 });
  await page.route("**/api/ebay/listings/sync-stream", (route) => route.fulfill({ contentType: "text/event-stream", body: [
    { type: "progress", product: "55PT Toploader Combo Pack", productId: 1, status: "pending", current: 1, total: 2 },
    { type: "progress", product: "Another product", productId: 2, status: "error", error: issue.message, issue, current: 2, total: 2 },
    { type: "complete", summary: { ...pending, errors: 1, pending: 1, total: 2 }, cancelled: false },
  ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") }));
  await page.getByRole("button", { name: "Sync All (1)", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Sync needs attention");
  await expect(dialog).toContainText("1 saved for processing");
  await expect(dialog).toContainText("Case variant has no included photo.");
  await expect(dialog.getByRole("link", { name: "Open product images" })).toHaveAttribute("href", "/products/2?tab=images");
  await expect(dialog.getByText("Show error", { exact: true })).toHaveCount(0);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("failure to read saved status is visible and blocks duplicate sync until refreshed", async ({ page }) => {
  const state = await setupEbayChannelPage(page); let fail = true;
  await page.route("**/api/ebay/listings/sync-jobs", (route) => fail ? route.fulfill({ status: 503, json: { error: "Unavailable" } }) : route.fulfill({ json: [] }));
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Saved sync status is unavailable");
  await expect(page.getByRole("button", { name: "Sync All (1)", exact: true })).toBeDisabled();
  await expect(page.getByTitle("Sync this listing", { exact: true }).filter({ visible: true })).toBeDisabled();
  fail = false;
  await page.getByRole("button", { name: "Refresh sync status" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sync All (1)", exact: true })).toBeEnabled();
  expect(state.requests).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("feed failures offer reload instead of claiming there are no listings", async ({ page }) => {
  const state = await setupEbayChannelPage(page);
  await page.route("**/api/ebay/listing-feed", (route) => route.fulfill({ status: 503, json: { error: "Unavailable" } }));
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Listings could not be loaded");
  await expect(page.getByRole("button", { name: "Reload listings" })).toBeVisible();
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("mapping review shows catalog and provider identities and verifies through the canonical sync action", async ({ page }) => {
  const state = await setupEbayChannelPage(page);
  state.jobs = [{ ...job, state: "needs_attention", code: "EBAY_SYNC_PROVIDER_IDENTITY_CHANGED", message: "The offer identity needs verification." }];
  const sourceIdentity = { groupKey: null, variants: [{ variantId: 101, sku: "SHLZ-TOP-180PT-CLR-P10", externalSku: "SHLZ-TOP-180PT-P10", offerId: "offer-101", listingId: "listing-101" }] };
  const providerIdentity = { groupKey: "SHLZ-TOP-180PT", variants: [{ ...sourceIdentity.variants[0], sku: "SHLZ-TOP-180PT-P10", catalogSku: "SHLZ-TOP-180PT-CLR-P10" }] };
  await page.route(`**/api/ebay/listings/sync-jobs/${job.id}`, (route) => route.fulfill({ json: { job: state.jobs[0], sourceIdentity, providerIdentity } }));
  await page.reload();
  await page.getByRole("button", { name: "Review listing mapping", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Saved source mapping");
  await expect(dialog).toContainText("Group: No group saved");
  await expect(dialog).toContainText("Resolved eBay mapping");
  await expect(dialog).toContainText("Catalog SKU: SHLZ-TOP-180PT-CLR-P10");
  await expect(dialog).toContainText("eBay SKU: SHLZ-TOP-180PT-P10");
  await expect(dialog).toContainText("Offer: offer-101");
  expect(state.requests).toEqual([]);
  state.response = pending;
  await dialog.getByRole("button", { name: "Verify mapping again" }).click();
  await expect.poll(() => state.requests.length).toBe(1);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a stale recovery preview needs a new acknowledgement and does not claim success", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.jobs = [blockedJob];
  let currentPreview = preview;
  await page.route(`**/api/ebay/listings/sync-jobs/${job.id}/recovery`, (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: currentPreview });
    currentPreview = { ...preview, previewHash: "b".repeat(64) };
    return route.fulfill({ status: 409, json: { code: "EBAY_RECOVERY_PREVIEW_STALE", error: "The saved request changed. Refresh its details before confirming recovery." } });
  });
  await page.reload(); await page.getByRole("button", { name: "Review blocked update", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Resume with current inventory", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("The saved request changed.");
  await expect(dialog.getByText("Recovery saved.", { exact: false })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Refresh request details" }).click();
  await expect(dialog.getByRole("checkbox")).not.toBeChecked();
  await expect(dialog.getByRole("button", { name: "Resume with current inventory", exact: true })).toBeDisabled();
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("malformed progress stops observation with directions instead of silently showing a spinner", async ({ page }) => {
  const state = await setupEbayChannelPage(page);
  await page.route("**/api/ebay/listings/sync-stream", (route) => route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"progress","productId":"wrong"}\n\n' }));
  await page.getByRole("button", { name: "Sync All (1)", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("Sync progress could not be read.");
  await expect(dialog.getByRole("button", { name: "Close", exact: true }).first()).toBeVisible();
  await expect(dialog.getByText("Starting sync...", { exact: true })).toHaveCount(0);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("eBay policy read failures have reload and prevent saving unverified selections", async ({ page }) => {
  const state = await setupEbayChannelPage(page);
  await page.route("**/api/ebay/policies", (route) => route.fulfill({ status: 401, json: { error: "Authorization expired" } }));
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("eBay business policies could not be loaded");
  await expect(page.getByRole("button", { name: "Reload business policies" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save Policies", exact: true })).toBeDisabled();
  await expect(page.getByText("All configured", { exact: true })).toHaveCount(0);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("new listing validation failures show the fix and cannot be retried blindly", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.feedStatus = "ready";
  const issue = resolveEbayListingIssue({ code: "EBAY_CATALOG_PHOTO_REQUIRED", productId: 1, message: "Include a photo before publishing." });
  await page.route("**/api/ebay/listings/push-stream?productIds=1", (route) => route.fulfill({ contentType: "text/event-stream", body: [
    { type: "progress", product: "55PT Toploader Combo Pack", productId: 1, status: "error", error: issue.message, issue, current: 1, total: 1 },
    { type: "complete", summary: { succeeded: 0, failed: 1, skipped: 0, total: 1 }, cancelled: false },
  ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") }));
  await page.reload(); await page.getByRole("button", { name: "Push to eBay (1)", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Publishing needs attention");
  await expect(dialog).toContainText("Include a photo before publishing.");
  await expect(dialog.getByRole("link", { name: "Open product images" })).toHaveAttribute("href", "/products/1?tab=images");
  await expect(dialog.getByRole("button", { name: /Retry/ })).toHaveCount(0);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("retrying an authorized publishing failure starts a fresh progress observation", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.feedStatus = "ready";
  const issue = resolveEbayListingIssue({ code: "EBAY_LISTING_SYNC_FAILED", productId: 1 });
  let requests = 0;
  await page.route("**/api/ebay/listings/push-stream?productIds=1", (route) => {
    requests++;
    return route.fulfill({ contentType: "text/event-stream", body: (requests === 1 ? [
      { type: "progress", product: "55PT Toploader Combo Pack", productId: 1, status: "error", error: issue.message, issue, current: 1, total: 1 },
      { type: "complete", summary: { succeeded: 0, failed: 1, skipped: 0, total: 1 }, cancelled: false },
    ] : [
      { type: "progress", product: "55PT Toploader Combo Pack", productId: 1, status: "success", variantsListed: 2, current: 1, total: 1 },
      { type: "complete", summary: { succeeded: 1, failed: 0, skipped: 0, total: 1 }, cancelled: false },
    ]).map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") });
  });
  await page.reload(); await page.getByRole("button", { name: "Push to eBay (1)", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Retry temporary failures (1)", exact: true }).click();
  await expect(dialog).toContainText("Push Complete");
  await expect(dialog).toContainText("2 variants listed");
  expect(requests).toBe(2);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("initial publishing can recover a quantity blocker without a saved sync job", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.feedStatus = "ready";
  const issue = resolveEbayListingIssue({ code: blockedJob.code, productId: 1, message: blockedJob.message });
  let publishes = 0, recoveries = 0;
  await page.route("**/api/ebay/listings/push-stream?productIds=1", (route) => {
    publishes++;
    return route.fulfill({ contentType: "text/event-stream", body: [
      { type: "progress", product: "55PT Toploader Combo Pack", productId: 1, status: "error", error: issue.message, issue, current: 1, total: 1 },
      { type: "complete", summary: { succeeded: 0, failed: 1, skipped: 0, total: 1 }, cancelled: false },
    ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") });
  });
  await page.route("**/api/ebay/listings/products/1/recovery", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { ...preview, jobId: null, requiredPermission: null } });
    recoveries++;
    return route.fulfill({ json: { attemptIds: ["16323"], replayed: false, providerWriteAttempted: false, job: null, productId: 1, nextAction: "retry_publish" } });
  });
  await page.reload(); await page.getByRole("button", { name: "Push to eBay (1)", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Review blocked update", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Resolve listing sync" })).toBeVisible();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Resume with current inventory", exact: true }).click();
  await expect(dialog).toContainText("The listing has not been confirmed published.");
  expect(publishes).toBe(1); expect(recoveries).toBe(1);
  await dialog.getByRole("button", { name: "Retry Publish", exact: true }).click();
  await expect.poll(() => publishes).toBe(2);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("recovery success with a new admission error presents that correction instead of claiming progress", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.jobs = [blockedJob];
  const issue = resolveEbayListingIssue({ code: "EBAY_CATALOG_PHOTO_REQUIRED", productId: 1, message: "The included case variant needs a photo." });
  await page.route(`**/api/ebay/listings/sync-jobs/${job.id}/recovery`, (route) => route.fulfill({ json: route.request().method() === "GET" ? preview : {
    attemptIds: ["16323"], replayed: false, providerWriteAttempted: false,
    job: { ...job, kind: "admission", state: "needs_attention", code: issue.code, message: issue.message, issue },
  } }));
  await page.reload(); await page.getByRole("button", { name: "Review blocked update", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Resume with current inventory", exact: true }).click();
  await expect(dialog).toContainText("Recovery saved. The listing still needs the correction below.");
  await expect(dialog.getByRole("link", { name: "Open product images" })).toHaveAttribute("href", "/products/1?tab=images");
  await expect(dialog.getByText("The listing update will continue", { exact: false })).toHaveCount(0);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a bulk admission failure remains visible when there was no saved job or progress event", async ({ page }) => {
  const state = await setupEbayChannelPage(page);
  await page.route("**/api/ebay/listings/sync-stream", (route) => route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({
    type: "complete", cancelled: false, summary: { ...pending, pending: 0, jobs: [], errors: 1, total: 0,
      details: [{ productId: 1, productName: "55PT Toploader Combo Pack", success: false, code: "EBAY_SYNC_ADMISSION_UNSAVED", error: "The sync request could not be saved." }],
    },
  })}\n\n` }));
  await page.getByRole("button", { name: "Sync All (1)", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Sync needs attention");
  await expect(dialog).toContainText("The sync request could not be saved.");
  await expect(dialog.getByRole("button", { name: "Retry this product", exact: true })).toBeVisible();
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("an unverified connection explains its fix without hiding existing listings", async ({ page }) => {
  const state = await setupEbayChannelPage(page);
  const issue = resolveEbayListingIssue({ code: "EBAY_AUTH_UNAVAILABLE", message: "eBay did not complete the account check." });
  state.connectionHealth = "needs_attention";
  state.connectionIssue = { ...issue, title: "Connection could not be verified", nextStep: "Refresh the connection check. If it still fails, give the displayed code to an administrator.", action: { kind: "retry_sync", label: "Check connection again" } };
  await page.reload();
  const connection = page.locator("#connection");
  await expect(connection).toContainText("Connection needs attention");
  await expect(connection).toContainText("eBay did not complete the account check.");
  await expect(page.getByText("55PT Toploader Combo Pack", { exact: true })).toBeVisible();
  state.connectionHealth = "verified"; state.connectionIssue = null;
  await connection.getByRole("button", { name: "Check connection again", exact: true }).click();
  await expect(connection.getByText("Connected", { exact: true })).toBeVisible();
  await expect(connection.getByText("Connection needs attention", { exact: true })).toHaveCount(0);
  expect(state.requests).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a lost sync response clears only after its exact command appears in saved status", async ({ page }) => {
  const state = await setupEbayChannelPage(page);
  await page.clock.install();
  let commandKey: string | undefined;
  await page.route("**/api/ebay/listings/sync-product/1", async (route) => {
    commandKey = route.request().postDataJSON().commandKey;
    await route.abort("failed");
  });
  await page.getByTitle("Sync this listing", { exact: true }).filter({ visible: true }).click();
  await expect(page.getByText("Listed · update paused", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry this request", exact: true })).toBeVisible();
  expect(commandKey).toMatch(/^[a-f0-9-]{36}$/);
  state.jobs = [{ ...job, id: commandKey!, state: "completed" }];
  await page.clock.fastForward(10_100);
  await expect(page.getByText("Listed", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry this request", exact: true })).toHaveCount(0);
  await expect(page.getByTitle("Sync this listing", { exact: true }).filter({ visible: true })).toBeEnabled();
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("an older completed job cannot hide a newer unsaved sync failure", async ({ page }) => {
  const state = await setupEbayChannelPage(page);
  state.jobs = [{ ...job, state: "completed" }];
  await page.reload(); await page.clock.install();
  await page.route("**/api/ebay/listings/sync-product/1", (route) => route.abort("failed"));
  await page.getByTitle("Sync this listing", { exact: true }).filter({ visible: true }).click();
  await expect(page.getByText("Listed · update paused", { exact: true }).filter({ visible: true })).toBeVisible();
  // The older job can be observed again with a later read. It still does not
  // prove acceptance of the newer command whose response was lost.
  await page.clock.fastForward(10_100);
  await expect(page.getByRole("button", { name: "Retry this request", exact: true })).toBeVisible();
  await expect(page.getByTitle("Sync this listing", { exact: true }).filter({ visible: true })).toBeDisabled();
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("an exact command receipt resolves a lost response coalesced into another job ID", async ({ page }) => {
  const state = await setupEbayChannelPage(page);
  await page.clock.install();
  let commandKey: string | undefined;
  let accepted = false;
  await page.route("**/api/ebay/listings/sync-product/1", async (route) => {
    commandKey = route.request().postDataJSON().commandKey;
    await route.abort("failed");
  });
  await page.route("**/api/ebay/listings/sync-jobs/*", (route) => {
    const requested = new URL(route.request().url()).pathname.split("/").at(-1);
    if (accepted && requested === commandKey) return route.fulfill({ json: { job: { ...job, state: "completed" }, sourceIdentity: null, providerIdentity: null } });
    return route.fulfill({ status: 404, json: { code: "EBAY_SYNC_JOB_NOT_FOUND", error: "The receipt is not available yet." } });
  });
  await page.getByTitle("Sync this listing", { exact: true }).filter({ visible: true }).click();
  await expect(page.getByText("Listed · update paused", { exact: true }).filter({ visible: true })).toBeVisible();
  expect(commandKey).not.toBe(job.id);
  accepted = true; state.jobs = [{ ...job, state: "completed" }];
  await page.clock.fastForward(10_100);
  await expect(page.getByText("Listed", { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry this request", exact: true })).toHaveCount(0);
  await expect(page.getByTitle("Sync this listing", { exact: true }).filter({ visible: true })).toBeEnabled();
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("an unreceived request can be retried with the same command without claiming completion", async ({ page }) => {
  const state = await setupEbayChannelPage(page);
  const commands: string[] = [];
  await page.route("**/api/ebay/listings/sync-product/1", async (route) => {
    commands.push(route.request().postDataJSON().commandKey);
    if (commands.length === 1) return route.abort("failed");
    state.jobs = [{ ...job, id: commands[0] }];
    return route.fulfill({ json: { ...pending, jobs: state.jobs } });
  });
  await page.getByTitle("Sync this listing", { exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole("button", { name: "Retry this request", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry this request", exact: true }).click();
  await expect(page.getByRole("status", { name: statusName })).toContainText("waiting to run");
  expect(commands).toHaveLength(2); expect(commands[1]).toBe(commands[0]);
  await expect(page.getByRole("button", { name: "Retry this request", exact: true })).toHaveCount(0);
  await expect(page.locator('li[role="status"]').filter({ hasText: "Product Synced" })).toHaveCount(0);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a known unsaved admission failure retries its original command", async ({ page }) => {
  const state = await setupEbayChannelPage(page);
  const commands: string[] = [];
  await page.route("**/api/ebay/listings/sync-product/1", async (route) => {
    commands.push(route.request().postDataJSON().commandKey);
    if (commands.length === 1) return route.fulfill({ json: { ...pending, pending: 0, jobs: [], errors: 1,
      details: [{ productId: 1, success: false, code: "EBAY_SYNC_ADMISSION_UNSAVED", error: "The sync request could not be saved." }],
    } });
    state.jobs = [{ ...job, id: commands[0] }];
    return route.fulfill({ json: { ...pending, jobs: state.jobs } });
  });
  await page.getByTitle("Sync this listing", { exact: true }).filter({ visible: true }).click();
  await page.getByRole("button", { name: "Retry this product", exact: true }).click();
  await expect(page.getByRole("status", { name: statusName })).toContainText("waiting to run");
  expect(commands).toHaveLength(2); expect(commands[1]).toBe(commands[0]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("explicit permission denial is not presented as a lost request that can be retried", async ({ page }) => {
  const state = await setupEbayChannelPage(page);
  await page.route("**/api/ebay/listings/sync-product/1", (route) => route.fulfill({ status: 403, json: { error: "Permission denied: channels:edit" } }));
  await page.getByTitle("Sync this listing", { exact: true }).filter({ visible: true }).click();
  await expect(page.getByText("Permission denied: channels:edit", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry this request", exact: true })).toHaveCount(0);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});
