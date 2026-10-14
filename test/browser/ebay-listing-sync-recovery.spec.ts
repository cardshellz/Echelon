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

test("inventory contention explains the photo interruption, retries the existing listing, and exposes read-only automatic progress", async ({ page }, info) => {
  const state = await setupEbayChannelPage(page);
  const busyJob = { ...job, operation: "sync", state: "needs_attention", code: "INVENTORY_PUBLICATION_TARGET_BUSY",
    message: "The listing update could not finish. Inspect the saved sync job before retrying." };
  state.jobs = [busyJob];
  state.feedStatus = "error";
  await page.reload();
  await expect(page.getByText("An inventory update interrupted this sync", { exact: true })).toBeVisible();
  await expect(page.getByText(busyJob.message, { exact: true })).toHaveCount(0);
  await expect(page.getByText("Another inventory update was using this listing. Its pictures and listing details have not all been verified.", { exact: true })).toBeVisible();
  const recovering = { ...busyJob, id: "39120da0-0208-4eb6-80ba-a4d5dfc879cd", state: "recovering",
    message: "An inventory update is using this listing. The saved listing update will retry automatically." };
  state.response = { ...pending, jobs: [recovering] };
  await page.getByRole("button", { name: "Retry this product", exact: true }).click();
  await expect(page.getByRole("status", { name: statusName })).toContainText("recovering automatically");
  await expect(page.getByRole("status", { name: statusName })).toContainText(recovering.message);
  expect(state.requests).toEqual(["/api/ebay/listings/sync-product/1"]);
  expect(state.commands[0]).toMatch(/^[a-f0-9-]{36}$/);
  await page.getByRole("button", { name: "View update status", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Listing update status", exact: true })).toBeVisible();
  await expect(dialog).toContainText("Next automatic check");
  await expect(dialog).toContainText("Your saved update will retry automatically, then check the listing and pictures on eBay");
  await expect(dialog.getByRole("button", { name: "Retry this product", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Refresh update status", exact: true }).click();
  expect(state.requests).toHaveLength(1);
  await page.screenshot({ path: info.outputPath("ebay-photos-inventory-contention.png"), fullPage: true });
  state.jobs = [{ ...recovering, state: "completed", code: null, message: null }];
  state.feedStatus = "listed";
  await dialog.getByRole("button", { name: "Refresh update status", exact: true }).click();
  await expect(dialog).toContainText("Listing update and pictures verified");
  expect(state.requests).toHaveLength(1);
  expect(state.errors).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("saved sync survives reload, shows recovery, and clears only after verified server completion", async ({
  page,
}, info) => {
  const state = await setupEbayChannelPage(page);
  state.response = pending;
  state.jobs = [job];
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

const interruptedPublication = { ...blockedJob, operation: "publish", code: "EBAY_PUBLICATION_RESPONSE_UNCERTAIN", message: "The publication worker stopped before its final response was recorded." };
const publicationRecovery = { ...preview, attempts: [], publicationRetry: { reviewHash: "c".repeat(64), revision: "1", message: "The publish step started but has no saved final response. Check existing offers before resuming the saved publication." } };

test("interrupted publication without quantity attempts requires explicit confirmation and keeps its retry key", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.jobs = [interruptedPublication];
  const commands: Array<{ previewHash: string; publicationRetryHash: string; idempotencyKey: string; acknowledgeUnknownOutcome: boolean }> = [];
  await page.route(`**/api/ebay/listings/sync-jobs/${job.id}/recovery`, route => {
    if (route.request().method() === "GET") return route.fulfill({ json: publicationRecovery });
    commands.push(route.request().postDataJSON());
    if (commands.length === 1) return route.abort("failed");
    return route.fulfill({ json: { attemptIds: [], publicationRetryAuthorized: true, replayed: true, providerWriteAttempted: false, job: { ...job, operation: "publish" } } });
  });
  await page.reload(); await page.getByRole("button", { name: "Review interrupted publication", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Resume interrupted publication" })).toBeVisible();
  await expect(dialog).toContainText("Publication was interrupted before its result was recorded.");
  await expect(dialog.getByRole("button", { name: "Continue saved sync" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Retry Publish" })).toHaveCount(0);
  const resume = dialog.getByRole("button", { name: "Resume saved publication", exact: true });
  await expect(resume).toBeDisabled();
  await dialog.getByRole("button", { name: "Refresh request details" }).click();
  expect(commands).toEqual([]);
  await dialog.getByRole("checkbox").check(); await resume.click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await resume.click();
  await expect(dialog).toContainText("The saved publication will continue. Listing and pictures are not yet verified.");
  expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]);
  expect(commands[0]).toEqual({ previewHash: preview.previewHash, publicationRetryHash: publicationRecovery.publicationRetry.reviewHash, acknowledgeUnknownOutcome: true, idempotencyKey: expect.stringMatching(/^[a-f0-9-]{36}$/) });
  expect(state.commands).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a changed publication recovery review resets acknowledgement and binds a new command to both hashes", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.jobs = [interruptedPublication];
  let current = publicationRecovery;
  const commands: Array<{ previewHash: string; publicationRetryHash: string; idempotencyKey: string }> = [];
  await page.route(`**/api/ebay/listings/sync-jobs/${job.id}/recovery`, route => {
    if (route.request().method() === "GET") return route.fulfill({ json: current });
    commands.push(route.request().postDataJSON());
    if (commands.length === 1) {
      current = { ...publicationRecovery, publicationRetry: { ...publicationRecovery.publicationRetry, reviewHash: "d".repeat(64), revision: "2" } };
      return route.fulfill({ status: 409, json: { code: "EBAY_RECOVERY_PREVIEW_CHANGED", error: "The saved publication changed. Refresh the current review." } });
    }
    return route.fulfill({ json: { attemptIds: [], publicationRetryAuthorized: true, replayed: false, providerWriteAttempted: false, job: { ...job, operation: "publish" } } });
  });
  await page.reload(); await page.getByRole("button", { name: "Review interrupted publication", exact: true }).click();
  const dialog = page.getByRole("dialog"); const resume = dialog.getByRole("button", { name: "Resume saved publication", exact: true });
  await dialog.getByRole("checkbox").check(); await resume.click();
  await expect(dialog.getByRole("alert")).toContainText("The saved publication changed.");
  await dialog.getByRole("button", { name: "Refresh request details" }).click();
  await expect(dialog.getByRole("checkbox")).not.toBeChecked(); await expect(resume).toBeDisabled();
  await dialog.getByRole("checkbox").check(); await resume.click();
  await expect(dialog).toContainText("Recovery saved.");
  expect(commands).toHaveLength(2);
  expect(commands[1].previewHash).toBe(commands[0].previewHash);
  expect(commands[1].publicationRetryHash).toBe("d".repeat(64));
  expect(commands[1].idempotencyKey).not.toBe(commands[0].idempotencyKey);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("interrupted publication recovery cannot bypass administrator permission through an empty attempt list", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.jobs = [interruptedPublication];
  await page.route(`**/api/ebay/listings/sync-jobs/${job.id}/recovery`, route => route.fulfill({ json: { ...publicationRecovery, canRecover: false, requiredPermission: "inventory_planning.activate" } }));
  await page.reload(); await page.getByRole("button", { name: "Review interrupted publication", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(`Share saved publishing request ${job.id}`);
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Resume saved publication|Continue saved sync|Retry Publish/ })).toHaveCount(0);
  expect(state.commands).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
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
  await page.route("**/api/ebay/listing-feed", (route) => route.fulfill({ status: 503, json: { error: "SELECT private_column FROM secret_table", issue: { message: "<html>internal proxy error</html>" } } }));
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Listings could not be loaded");
  await expect(page.getByRole("button", { name: "Reload listings" })).toBeVisible();
  await expect(page.getByText("SELECT private_column FROM secret_table")).toHaveCount(0);
  await expect(page.getByText("internal proxy error", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("alert")).not.toContainText("No products");
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("feed failure preserves safe diagnostics and blocks every bulk action on cached rows until read-only reload succeeds", async ({ page }) => {
  const state = await setupEbayChannelPage(page);
  const issue = {
    code: "EBAY_LISTING_FEED_UNAVAILABLE", title: "Listing details are unavailable",
    message: "Echelon could not read the saved listing details.",
    nextStep: "Reload the listings. If this continues, copy the reference for support.",
    reference: "feed-read-42", retryable: false,
    action: { kind: "contact_support", label: "Copy diagnostic details" },
  };
  let failing = true;
  let reads = 0;
  await page.route("**/api/ebay/listing-feed", (route) => {
    reads += 1;
    return failing ? route.fulfill({ status: 503, json: { code: issue.code, error: "raw internal failure", issue } }) : route.fallback();
  });
  // The existing saved-job poll invalidates the loaded feed; this is a failed
  // background read with cached rows, not a fresh empty-page fixture.
  await expect(page.getByRole("alert")).toContainText(issue.message, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Sync All (1)", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Verify (1)", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^Push to eBay/ })).toBeDisabled();
  await expect(page.getByText("raw internal failure", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText(issue.nextStep);
  await page.getByText("Technical details", { exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(issue.code);
  await expect(page.getByRole("alert")).toContainText(issue.reference);
  failing = false;
  const beforeReload = reads;
  await page.getByRole("button", { name: "Reload listings", exact: true }).click();
  await expect(page.getByText("55PT Toploader Combo Pack", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Verify (1)", exact: true })).toBeEnabled();
  expect(reads).toBeGreaterThan(beforeReload);
  expect(state.requests).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

for (const stockFailure of ["blocked", "legacy_retry", "same_sync"] as const) {
test(`one unavailable product inventory keeps healthy listings and true zero visible and reloads without publishing (${stockFailure})`, async ({ page }) => {
  const state = await setupEbayChannelPage(page);
  const inventoryIssue = stockFailure !== "legacy_retry" ? resolveEbayListingIssue({ code: "CANONICAL_CHANNEL_QUANTITY_BLOCKED", productId: 1 }) : {
    code: "EBAY_FEED_QUANTITY_UNAVAILABLE", title: "Current inventory is unavailable",
    message: "Inventory could not be read for this product.",
    nextStep: "Reload inventory to check its current availability.", retryable: true,
    // Even a retry-shaped older response must not issue a listing write from
    // the read-error section. Its explicit Reload inventory action is a GET.
    action: { kind: "retry_sync", label: "Retry this product" },
  };
  const savedIssue = stockFailure === "same_sync" ? inventoryIssue
    : resolveEbayListingIssue({ code: "EBAY_CATALOG_PHOTO_REQUIRED", productId: 1, message: "The saved listing update still needs a case photo." });
  state.jobs = stockFailure === "blocked" ? [] : [{ ...job, state: "needs_attention", code: savedIssue.code, message: savedIssue.message, issue: savedIssue }];
  const product = (id: number, name: string, quantities: (number | null)[]) => ({
    id, name, sku: `PRODUCT-${id}`, productType: "toploaders", productTypeName: "Toploaders",
    ebayBrowseCategoryId: null, ebayBrowseCategoryName: null, ebayBrowseCategoryOverrideId: null,
    ebayBrowseCategoryOverrideName: null, ebayStoreCategoryName: null,
    status: "listed", missingItems: [], missingAspects: [], isListed: true, isExcluded: false,
    syncError: null, externalListingId: `listing-${id}`, externalListingIdentityConflict: false,
    variantCount: quantities.length, includedVariantCount: quantities.length, imageCount: 2,
    variants: quantities.map((quantity, index) => ({ id: id * 10 + index, sku: `SKU-${id}-${index}`, name: `Variant ${id}-${index}`,
      priceCents: 500, ebayListingExcluded: false, explicitlyExcluded: false, excludedByProduct: false,
      effectivelyListed: true, inventoryQuantity: quantity, fulfillmentPolicyOverride: null,
      returnPolicyOverride: null, paymentPolicyOverride: null })),
    fulfillmentPolicyOverride: null, returnPolicyOverride: null, paymentPolicyOverride: null,
  });
  const failed = { ...product(1, "55PT Toploader Combo Pack", [null]), inventoryIssue };
  state.feedProducts = [failed, product(2, "Healthy product", [7, 0])];
  await page.reload();
  await expect(page.getByText("Healthy product", { exact: true })).toBeVisible();
  const inventory = page.getByRole("region", { name: "Inventory availability for 55PT Toploader Combo Pack" });
  await expect(inventory).toContainText(stockFailure === "same_sync" ? "The current inventory read encountered the same issue described above." : inventoryIssue.message);
  await expect(page.getByText(savedIssue.message, { exact: true })).toHaveCount(stockFailure === "blocked" ? 0 : 1);
  await page.getByRole("button", { name: "Errors (1)", exact: true }).click();
  await expect(inventory).toBeVisible();
  await expect(page.getByText("Healthy product", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "All (2)", exact: true }).click();
  if (stockFailure === "blocked") {
    await expect(inventory.getByRole("link", { name: "Open inventory settings", exact: true })).toHaveAttribute("href", "/channels/inventory?product=1");
  }
  await expect(inventory.getByRole("button", { name: "Retry this product", exact: true })).toHaveCount(0);
  await page.getByText("55PT Toploader Combo Pack", { exact: true }).click();
  await page.getByText("Healthy product", { exact: true }).click();
  await expect(page.getByText("Unavailable", { exact: true }).filter({ visible: true })).toHaveCount(1);
  await expect(page.getByText("7 qty", { exact: true }).filter({ visible: true })).toHaveCount(1);
  await expect(page.getByText("0 qty", { exact: true }).filter({ visible: true })).toHaveCount(1);
  state.feedProducts = [product(1, "55PT Toploader Combo Pack", [12]), product(2, "Healthy product", [7, 0])];
  await inventory.getByRole("button", { name: "Reload inventory", exact: true }).click();
  await expect(inventory).toHaveCount(0);
  await expect(page.getByText("12 qty", { exact: true }).filter({ visible: true })).toHaveCount(1);
  await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(0);
  await expect(page.getByText(savedIssue.message, { exact: true })).toHaveCount(stockFailure === "blocked" ? 0 : 1);
  await expect(page.getByRole("button", { name: stockFailure === "blocked" ? "Errors (0)" : "Errors (1)", exact: true })).toBeVisible();
  expect(state.requests).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
}

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
  await page.route("**/api/ebay/listings/push", (route) => route.fulfill({ json: {
    results: [{ productName: "55PT Toploader Combo Pack", productId: 1, variantCount: 2, success: false, status: "error", error: issue.message, issue }],
    summary: { succeeded: 0, failed: 1, skipped: 0, queued: 0, total: 1 }, cancelled: false,
  } }));
  await page.reload(); await page.getByRole("button", { name: "Push to eBay (1)", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Publishing needs attention");
  await expect(dialog).toContainText("Include a photo before publishing.");
  await expect(dialog.getByRole("link", { name: "Open product images" })).toHaveAttribute("href", "/products/1?tab=images");
  await expect(dialog.getByRole("button", { name: /Retry/ })).toHaveCount(0);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("retrying an unsaved publishing failure reuses its command and follows saved job completion", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.feedStatus = "ready";
  const issue = resolveEbayListingIssue({ code: "EBAY_LISTING_SYNC_FAILED", productId: 1 });
  const requests: unknown[] = [];
  await page.route("**/api/ebay/listings/push", (route) => {
    requests.push(route.request().postDataJSON());
    const accepted = requests.length > 1;
    if (accepted) state.jobs = [{ ...job, operation: "publish", state: "completed" }];
    return route.fulfill({ json: {
      results: [{ productName: "55PT Toploader Combo Pack", productId: 1, variantCount: 2, success: false, status: accepted ? "queued" : "error",
        ...(accepted ? { job: { ...job, operation: "publish" } } : { error: issue.message, issue }) }],
      summary: { succeeded: 0, failed: accepted ? 0 : 1, skipped: 0, queued: accepted ? 1 : 0, total: 1 }, cancelled: false,
    } });
  });
  await page.reload(); await page.getByRole("button", { name: "Push to eBay (1)", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Retry saved publishing requests", exact: true }).click();
  await dialog.getByRole("button", { name: "Refresh publishing status", exact: true }).click();
  await expect(dialog).toContainText("Published. Listing and pictures verified.");
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("initial publishing can recover a quantity blocker without a saved sync job", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.feedStatus = "ready";
  const issue = resolveEbayListingIssue({ code: blockedJob.code, productId: 1, message: blockedJob.message });
  let publishes = 0, recoveries = 0;
  await page.route("**/api/ebay/listings/push", (route) => {
    publishes++;
    return route.fulfill({ json: {
      results: [{ productName: "55PT Toploader Combo Pack", productId: 1, variantCount: 2, success: false, status: "error", error: issue.message, issue }],
      summary: { succeeded: 0, failed: 1, skipped: 0, queued: 0, total: 1 }, cancelled: false,
    } });
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

test("initial publication survives a lost POST and reload using the original saved command", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.feedStatus = "ready"; state.externalListingId = null;
  const requests: Array<{ productIds: number[]; commands: Array<{ productId: number; commandKey: string }> }> = [];
  let accept = false;
  await page.route("**/api/ebay/listings/push", (route) => {
    requests.push(route.request().postDataJSON());
    if (!accept) return route.abort("failed");
    state.jobs = [{ ...job, operation: "publish" }];
    return route.fulfill({ json: {
      results: [{ productName: "55PT Toploader Combo Pack", productId: 1, variantCount: 2, success: false, status: "queued", job: state.jobs[0] }],
      summary: { succeeded: 0, failed: 0, skipped: 0, queued: 1, total: 1 }, cancelled: false,
    } });
  });
  await page.reload(); await page.getByRole("button", { name: "Push to eBay (1)", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Retry saved publishing requests" })).toBeEnabled();
  expect(requests[0].commands[0].commandKey).toMatch(/^[a-f0-9-]{36}$/);
  await page.reload(); accept = true;
  await page.getByRole("button", { name: "Push to eBay (1)", exact: true }).click();
  await expect(dialog).toContainText("Publishing — queued or running. Publication is not yet confirmed.");
  await expect(dialog).not.toContainText("Published. Listing and pictures verified.");
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect(await page.evaluate(() => sessionStorage.getItem("ebay:publication-command:1"))).toBeNull();
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Push to eBay (1)", exact: true })).toHaveCount(0);
  await expect(page.getByText("Publishing", { exact: true }).filter({ visible: true })).toBeVisible();
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a lost publishing response recovers by exact command receipt without another POST", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.feedStatus = "ready"; state.externalListingId = null;
  let commandKey = ""; let posts = 0;
  await page.route("**/api/ebay/listings/push", route => {
    posts++; commandKey = route.request().postDataJSON().commands[0].commandKey;
    return route.abort("failed");
  });
  await page.route("**/api/ebay/listings/sync-jobs/*", route => {
    expect(new URL(route.request().url()).pathname.split("/").at(-1)).toBe(commandKey);
    return route.fulfill({ json: { job: { ...job, operation: "publish", state: "completed" } } });
  });
  await page.reload(); await page.getByRole("button", { name: "Push to eBay (1)", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Published. Listing and pictures verified.");
  await expect(dialog).not.toContainText("The sync response was lost");
  expect(posts).toBe(1); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("publication permission denial is explicit and does not offer blind retry", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.feedStatus = "ready";
  await page.route("**/api/ebay/listings/push", route => route.fulfill({ status: 403, json: { code: "FORBIDDEN", error: "Publishing requires channels:edit permission." } }));
  await page.reload(); await page.getByRole("button", { name: "Push to eBay (1)", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Publishing requires channels:edit permission.");
  await expect(dialog.getByRole("button", { name: "Retry saved publishing requests" })).toHaveCount(0);
  await expect(dialog).not.toContainText("The sync response was lost");
  expect(await page.evaluate(() => sessionStorage.getItem("ebay:publication-command:1"))).not.toBeNull();
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a journaled publishing admission error releases the accepted key and shows its correction", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.feedStatus = "ready";
  const issue = resolveEbayListingIssue({ code: "EBAY_CATALOG_PHOTO_REQUIRED", productId: 1 });
  await page.route("**/api/ebay/listings/push", route => {
    const saved = { ...job, id: route.request().postDataJSON().commands[0].commandKey, kind: "admission", operation: "publish", state: "needs_attention", code: issue.code, message: issue.message, issue };
    state.jobs = [saved];
    return route.fulfill({ json: { results: [{ productName: "55PT Toploader Combo Pack", productId: 1, variantCount: 2, success: false, status: "error", job: saved, issue, error: issue.message }],
      summary: { succeeded: 0, failed: 1, skipped: 0, queued: 0, total: 1 }, cancelled: false } });
  });
  await page.reload(); await page.getByRole("button", { name: "Push to eBay (1)", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Publishing paused — follow the next step below.");
  await expect(dialog.getByRole("link", { name: "Open product images" })).toHaveAttribute("href", "/products/1?tab=images");
  await expect(dialog.getByRole("button", { name: "Retry saved publishing requests" })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("ebay:publication-command:1"))).toBeNull();
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("accepted publication waits in a read-only status view until its pictures are verified", async ({ page }) => {
  const state = await setupEbayChannelPage(page);
  state.feedStatus = "publication_incomplete"; state.externalListingId = null;
  state.jobs = [{ ...job, operation: "publish", state: "recovering", code: "EBAY_PUBLICATION_READBACK_PENDING", message: "eBay accepted the request; picture verification is still pending." }];
  const writes: string[] = [];
  await page.route("**/api/ebay/listings/**", route => {
    if (route.request().method() !== "GET") { writes.push(route.request().url()); return route.fulfill({ status: 500, json: { error: "Unexpected write" } }); }
    return route.fallback();
  });
  await page.reload();
  await expect(page.getByRole("status", { name: statusName })).toContainText("Checking published listing and pictures");
  await page.getByRole("button", { name: "View publishing status", exact: true }).filter({ visible: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Publishing status", exact: true })).toBeVisible();
  await expect(dialog).toContainText("without publishing a second time");
  await expect(dialog.getByRole("button", { name: /Continue|Retry|Resume/ })).toHaveCount(0);
  await expect(dialog).not.toContainText("Published. Listing and pictures verified.");
  await dialog.getByRole("button", { name: "Refresh publishing status" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Checking published listing and pictures");
  state.jobs = [{ ...job, operation: "publish", state: "completed" }];
  state.feedStatus = "listed"; state.externalListingId = "listing-verified";
  await dialog.getByRole("button", { name: "Refresh publishing status" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Published. Listing and pictures verified.");
  expect(writes).toEqual([]); expect(state.commands).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("refreshing an older publishing request cannot hide a newer listing failure", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.feedStatus = "ready"; state.externalListingId = null;
  const oldJob = { ...job, operation: "publish", state: "completed" };
  let reads = 0;
  await page.route("**/api/ebay/listings/push", route => route.fulfill({ json: {
    results: [{ productName: "55PT Toploader Combo Pack", productId: 1, variantCount: 2, success: false, status: "queued", job: { ...oldJob, state: "queued" } }],
    summary: { succeeded: 0, failed: 0, skipped: 0, queued: 1, total: 1 }, cancelled: false,
  } }));
  await page.route(`**/api/ebay/listings/sync-jobs/${job.id}`, route => { reads++; return route.fulfill({ json: { job: oldJob } }); });
  await page.reload(); await page.getByRole("button", { name: "Push to eBay (1)", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Published. Listing and pictures verified.");
  state.jobs = [{ ...job, id: "b1c9651f-807e-4730-ab4d-d62d03615e4a", operation: "sync", state: "needs_attention", code: "EBAY_CATALOG_PHOTO_REQUIRED", message: "The newer update requires a photo." }];
  state.feedStatus = "listed"; state.externalListingId = "verified-listing";
  const previousReads = reads;
  await dialog.getByRole("button", { name: "Refresh publishing status" }).click();
  await expect.poll(() => reads).toBeGreaterThan(previousReads);
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(page.getByText("The newer update requires a photo.", { exact: true })).toBeVisible();
  await expect(page.getByText("Listed · update paused", { exact: true }).filter({ visible: true })).toBeVisible();
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("unavailable saved status blocks new publication until its read-only refresh succeeds", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.feedStatus = "ready"; state.externalListingId = null;
  let fail = true;
  await page.route("**/api/ebay/listings/sync-jobs", route => fail ? route.fulfill({ status: 503, json: { error: "Status unavailable" } }) : route.fulfill({ json: [] }));
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("Refresh its status before starting another sync or publication.");
  await expect(page.getByRole("button", { name: "Push to eBay (1)", exact: true })).toBeDisabled();
  const productPush = page.getByTitle("Push to eBay", { exact: true }).or(page.getByRole("button", { name: "Push", exact: true })).filter({ visible: true });
  await expect(productPush).toBeDisabled();
  fail = false; await page.getByRole("button", { name: "Refresh sync status" }).click();
  await expect(page.getByRole("button", { name: "Push to eBay (1)", exact: true })).toBeEnabled();
  await expect(productPush).toBeEnabled();
  expect(state.commands).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("accepted publication status read failures stay read-only and can be refreshed", async ({ page }) => {
  const state = await setupEbayChannelPage(page);
  state.jobs = [{ ...job, operation: "publish", state: "needs_attention", code: "EBAY_PUBLICATION_READBACK_PENDING", message: "Publication needs a status check." }];
  let fail = true;
  await page.route(`**/api/ebay/listings/sync-jobs/${job.id}`, route => fail
    ? route.fulfill({ status: 503, json: { error: "Status temporarily unavailable" } })
    : route.fulfill({ json: { job: state.jobs[0] } }));
  await page.reload(); await page.getByRole("button", { name: "View publishing status", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("No new publication was sent");
  await expect(dialog.getByRole("button", { name: /Continue|Retry|Resume/ })).toHaveCount(0);
  fail = false; await dialog.getByRole("button", { name: "Refresh publishing status" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Checking published listing and pictures");
  expect(state.commands).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a publication refusal opens the referenced earlier request instead of its newer admission record", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.feedStatus = "ready"; state.externalListingId = null;
  const earlier = { ...job, operation: "publish", state: "awaiting_evidence", code: "EBAY_PUBLICATION_RESPONSE_UNCERTAIN", message: "Earlier publication needs review." };
  const issue = resolveEbayListingIssue({ code: "EBAY_PUBLICATION_PRIOR_WORK_REQUIRED", productId: 1, jobId: earlier.id });
  const refusal = { ...job, id: "b1c9651f-807e-4730-ab4d-d62d03615e4a", operation: "publish", kind: "admission", state: "needs_attention", code: issue.code, message: issue.message, issue };
  await page.route("**/api/ebay/listings/push", route => { state.jobs = [refusal]; return route.fulfill({ json: {
    results: [{ productName: "55PT Toploader Combo Pack", productId: 1, variantCount: 2, success: false, status: "error", job: refusal, issue }],
    summary: { succeeded: 0, failed: 1, skipped: 0, queued: 0, total: 1 }, cancelled: false,
  } }); });
  await page.route(`**/api/ebay/listings/sync-jobs/${earlier.id}`, route => route.fulfill({ json: { job: earlier } }));
  await page.route(`**/api/ebay/listings/sync-jobs/${earlier.id}/recovery`, route => route.fulfill({ json: publicationRecovery }));
  await page.reload(); await page.getByRole("button", { name: "Push to eBay (1)", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "View earlier publication", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Publishing status", exact: true })).toBeVisible();
  await expect(dialog).toContainText(`Request reference: ${earlier.id}`);
  await expect(dialog).toContainText("Earlier publication needs review.");
  await dialog.getByRole("button", { name: "Review interrupted publication", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Resume interrupted publication" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Resume saved publication", exact: true })).toBeDisabled();
  expect(state.commands).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("unreadable publication retry storage blocks new writes and offers recovery", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.feedStatus = "ready";
  const command = { productId: 1, commandKey: "16925e0a-ab5a-4d08-8137-633047407a99" };
  let posts = 0;
  await page.route("**/api/ebay/listings/push", route => { posts++; return route.abort("failed"); });
  await page.reload();
  await page.evaluate(request => {
    sessionStorage.setItem("ebay:publication-command:1", JSON.stringify(request));
    const original = Storage.prototype.getItem;
    (window as Window & { restorePublicationStorage?: () => void }).restorePublicationStorage = () => { Storage.prototype.getItem = original; };
    Storage.prototype.getItem = function (key: string) { if (key === "ebay:publication-command:1") throw new Error("Storage denied"); return original.call(this, key); };
  }, command);
  await page.getByRole("button", { name: "Push to eBay (1)", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("An earlier request may have been sent");
  expect(posts).toBe(0);
  await page.evaluate(() => (window as Window & { restorePublicationStorage?: () => void }).restorePublicationStorage?.());
  await dialog.getByRole("button", { name: "Retry loading saved requests" }).click();
  await expect(dialog.getByRole("button", { name: "Retry saved publishing requests" })).toBeEnabled();
  expect(posts).toBe(1);
  expect(JSON.parse((await page.evaluate(() => sessionStorage.getItem("ebay:publication-command:1")))!)).toEqual(command);
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

test("a recovered exact sync receipt cannot replace a newer server failure", async ({ page }) => {
  const state = await setupEbayChannelPage(page); await page.clock.install();
  let accepted = false;
  await page.route("**/api/ebay/listings/sync-product/1", route => route.abort("failed"));
  await page.route("**/api/ebay/listings/sync-jobs/*", route => accepted
    ? route.fulfill({ json: { job: { ...job, state: "completed" } } })
    : route.fulfill({ status: 404, json: { code: "EBAY_SYNC_JOB_NOT_FOUND", error: "Receipt not available." } }));
  await page.getByTitle("Sync this listing", { exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole("button", { name: "Retry this request", exact: true })).toBeVisible();
  state.jobs = [{ ...job, id: "f20337e1-3f66-4c30-bba2-8e1846314988", state: "needs_attention", code: "EBAY_CATALOG_PHOTO_REQUIRED", message: "The current server request requires another photo." }];
  accepted = true; await page.clock.fastForward(10_100);
  await expect(page.getByRole("button", { name: "Retry this request", exact: true })).toHaveCount(0);
  await expect(page.getByText("The current server request requires another photo.", { exact: true })).toBeVisible();
  await expect(page.getByText("Listed · update paused", { exact: true }).filter({ visible: true })).toBeVisible();
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("a late saved sync response reloads the latest job instead of overwriting it", async ({ page }) => {
  const state = await setupEbayChannelPage(page);
  await page.route("**/api/ebay/listings/sync-product/1", route => {
    state.jobs = [{ ...job, id: "f20337e1-3f66-4c30-bba2-8e1846314988", state: "needs_attention", code: "EBAY_CATALOG_PHOTO_REQUIRED", message: "A newer saved update is missing a photo." }];
    return route.fulfill({ json: { ...pending, jobs: [{ ...job, state: "completed" }] } });
  });
  await page.getByTitle("Sync this listing", { exact: true }).filter({ visible: true }).click();
  await expect(page.getByText("A newer saved update is missing a photo.", { exact: true })).toBeVisible();
  await expect(page.getByText("Listed · update paused", { exact: true }).filter({ visible: true })).toBeVisible();
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
