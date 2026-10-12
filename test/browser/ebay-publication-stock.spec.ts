import { expect, test, type Page } from "@playwright/test";
import { setupEbayChannelPage } from "./fixtures/ebay-channel-page.fixture";
import type { EbayPublicationStockReview, EbayPublicationStockApply } from "../../shared/types/ebay-publication-stock";
import { resolveEbayListingIssue } from "../../shared/ebay-listing-issue";

const oldJob = { id: "543b9237-920d-4786-a950-31c6fe941c8f", productId: 1, operation: "publish", kind: "sync", state: "needs_attention", code: "STOCK_LISTING_ATP_NOT_READY", message: "An included variant has no active inventory mapping.", nextAttemptAt: "2026-10-12T12:00:00.000Z", updatedAt: "2026-10-12T12:00:00.000Z" };
const queuedJob = { ...oldJob, id: "1a1300a8-0586-4905-9220-5e72e9d48a4a", state: "queued", code: null, message: null };
const path = "/api/ebay/listings/products/1/publication-readiness";
const review = (): EbayPublicationStockReview => ({ productId: 1, productName: "55PT Toploader Combo Pack", observedAt: "2026-10-12T12:00:00.000Z", reviewHash: "a".repeat(64),
  canApply: true, allowedToApply: true, requiredPermission: null, effects: ["Activate the existing stock connection for both SKUs.", "Save a publication request using current pictures and stock."],
  inventory: { channelId: 67, connectionId: 7, productId: 1, publicationTargetId: 90, targetRevision: "rev-1", reviewHash: "b".repeat(64), ready: true, currentlyReady: false,
    variants: [{ productVariantId: 10, sku: "BLUE-P10", mappingAction: "promote_draft", membershipAction: "include", desiredQuantity: "1102" },
      { productVariantId: 11, sku: "BLUE-C500", mappingAction: "create", membershipAction: "include", desiredQuantity: "23" }], blockers: [], effects: ["Activate stock connections."] } });
const receipt = (command: EbayPublicationStockApply, replayed = false) => ({ job: queuedJob, receipt: { productId: 1, commandKey: command.commandKey, reviewHash: command.expectedReviewHash, appliedAt: "2026-10-12T12:01:00.000Z" }, replayed });
async function setup(page: Page) {
  const feed = await setupEbayChannelPage(page); feed.jobs = [oldJob]; feed.feedStatus = "error"; feed.externalListingId = null;
  const state = { review: review(), commands: [] as EbayPublicationStockApply[] };
  await page.route(`**${path}`, route => route.fulfill({ json: state.review }));
  await page.route(`**${path}/commands/*`, route => route.fulfill({ status: 404, json: { error: "No receipt yet" } }));
  await page.route(`**${path}/apply`, route => { const command = route.request().postDataJSON(); state.commands.push(command); feed.jobs = [queuedJob]; return route.fulfill({ json: receipt(command) }); });
  await page.reload();
  const open = async () => page.getByRole("button", { name: "Review stock setup", exact: true }).click();
  await open();
  return { feed, state, open, dialog: page.getByRole("dialog"), apply: page.getByRole("dialog").getByRole("button", { name: "Connect stock and publish", exact: true }) };
}

test("review displays server SKU quantities and queues publishing without claiming completion", async ({ page }, info) => {
  const { feed, state, dialog, apply } = await setup(page);
  await expect(dialog.getByRole("region", { name: "Stock plan for BLUE-P10" })).toContainText("1102 selling units");
  await expect(dialog.getByRole("region", { name: "Stock plan for BLUE-C500" })).toContainText("23 selling units");
  await expect(dialog).toContainText("Activate the existing draft inventory connection");
  await page.screenshot({ path: info.outputPath("stock-review.png"), fullPage: true });
  await apply.click();
  await expect(dialog.getByRole("status")).toContainText("publication is not yet confirmed");
  await expect(dialog).not.toContainText("Published on eBay.");
  expect(state.commands).toEqual([{ commandKey: expect.stringMatching(/^[a-f0-9-]{36}$/), expectedReviewHash: "a".repeat(64) }]);
  feed.jobs = [{ ...queuedJob, state: "completed" }];
  await dialog.getByRole("button", { name: "Refresh publishing status" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Published on eBay. Listing and pictures verified.");
  expect(feed.errors).toEqual([]); expect(feed.unexpected).toEqual([]);
});

test("blocked setup links the exact inventory product and does not offer a writable plan", async ({ page }) => {
  const { feed, state, dialog, apply } = await setup(page);
  state.review.canApply = false; state.review.inventory.ready = false; state.review.inventory.variants[1].desiredQuantity = null;
  state.review.inventory.blockers = [{ code: "STOCK_SOURCE_MISSING", message: "Choose a warehouse source for BLUE-C500.", action: "configure_inventory", productVariantId: 11 }];
  await dialog.getByRole("button", { name: "Recheck stock setup", exact: true }).click();
  await expect(apply).toBeDisabled();
  await expect(dialog).toContainText("Choose a warehouse source for BLUE-C500.");
  await expect(dialog.getByRole("link", { name: "Open this product's stock setup" })).toHaveAttribute("href", "/channels/inventory?channel=67&destination=90&product=1");
  await expect(dialog.getByRole("region", { name: "Stock plan for BLUE-C500" })).toContainText("Unavailable until the issue below is corrected");
  expect(state.commands).toEqual([]); expect(feed.unexpected).toEqual([]);
});

test("permission-filtered canApply false still explains the required permission", async ({ page }) => {
  const { state, dialog, apply } = await setup(page);
  state.review.canApply = false; state.review.allowedToApply = false; state.review.requiredPermission = "inventory_planning:activate";
  await dialog.getByRole("button", { name: "Recheck stock setup", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("inventory_planning:activate");
  await expect(apply).toBeDisabled(); expect(state.commands).toEqual([]);
});

test("a journaled stale refusal requires a fresh review and a new command", async ({ page }) => {
  const { feed, state, dialog, apply } = await setup(page);
  let rejected = false;
  await page.route(`**${path}/apply`, route => {
    const command = route.request().postDataJSON(); state.commands.push(command);
    if (!rejected) { rejected = true; return route.fulfill({ status: 409, json: { code: "EBAY_PUBLICATION_STOCK_REVIEW_STALE", error: "Stock changed since this review.", definitiveRejected: true } }); }
    feed.jobs = [queuedJob]; return route.fulfill({ json: receipt(command) });
  });
  await apply.click(); await expect(dialog.getByRole("alert")).toContainText("rejected without applying the stock plan");
  await expect(apply).toBeDisabled();
  expect(await page.evaluate(() => sessionStorage.getItem("ebay:publication-stock:1"))).toBeNull();
  state.review.reviewHash = "c".repeat(64); state.review.inventory.variants[0].desiredQuantity = "1100";
  await dialog.getByRole("button", { name: "Recheck stock setup", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "Stock plan for BLUE-P10" })).toContainText("1100 selling units");
  await apply.click(); await expect(dialog.getByRole("status")).toContainText("publication is not yet confirmed");
  expect(state.commands[1].commandKey).not.toBe(state.commands[0].commandKey);
  expect(state.commands[1].expectedReviewHash).toBe("c".repeat(64));
  expect(feed.errors).toEqual([]); expect(feed.unexpected).toEqual([]);
});

test("a lost apply response survives reload and the exact receipt avoids another write", async ({ page }) => {
  const { feed, state, dialog, apply, open } = await setup(page); let receiptAvailable = false;
  await page.route(`**${path}/apply`, route => { state.commands.push(route.request().postDataJSON()); return route.abort("failed"); });
  await page.route(`**${path}/commands/*`, route => receiptAvailable ? route.fulfill({ json: receipt(state.commands[0], true) }) : route.fulfill({ status: 404, json: { error: "Receipt not available" } }));
  await apply.click(); await expect(dialog.getByRole("button", { name: "Retry same request" })).toBeVisible();
  await page.reload(); receiptAvailable = true; await open();
  feed.jobs = [queuedJob]; await expect(dialog.getByRole("status")).toContainText("publication is not yet confirmed");
  expect(state.commands).toHaveLength(1);
  expect(await page.evaluate(() => sessionStorage.getItem("ebay:publication-stock:1"))).toBeNull();
  expect(feed.errors).toEqual([]); expect(feed.unexpected).toEqual([]);
});

test("unreceived request retries the same command and original review after receipt 404", async ({ page }) => {
  const { feed, state, dialog, apply } = await setup(page); let accept = false;
  await page.route(`**${path}/apply`, route => {
    const command = route.request().postDataJSON(); state.commands.push(command);
    if (!accept) return route.abort("failed");
    feed.jobs = [queuedJob]; return route.fulfill({ json: receipt(command) });
  });
  await apply.click(); await expect(dialog.getByRole("button", { name: "Retry same request" })).toBeEnabled();
  accept = true; await dialog.getByRole("button", { name: "Retry same request" }).click();
  await expect(dialog.getByRole("status")).toContainText("publication is not yet confirmed");
  expect(state.commands).toHaveLength(2); expect(state.commands[1]).toEqual(state.commands[0]);
  expect(feed.errors).toEqual([]); expect(feed.unexpected).toEqual([]);
});

test("a stale code without the durable refusal marker retains its command", async ({ page }) => {
  const { state, dialog, apply } = await setup(page);
  await page.route(`**${path}/apply`, route => { state.commands.push(route.request().postDataJSON()); return route.fulfill({ status: 409, json: { code: "EBAY_PUBLICATION_STOCK_REVIEW_STALE", error: "Unconfirmed refusal" } }); });
  await apply.click(); await expect(dialog.getByRole("button", { name: "Retry same request" })).toBeEnabled();
  expect(JSON.parse((await page.evaluate(() => sessionStorage.getItem("ebay:publication-stock:1")))!)).toEqual(state.commands[0]);
  await dialog.getByRole("button", { name: "Retry same request" }).click();
  expect(state.commands).toHaveLength(2); expect(state.commands[1]).toEqual(state.commands[0]);
});

test("unreadable saved request prevents sending a fresh command", async ({ page }) => {
  const { state, open } = await setup(page);
  await page.evaluate(() => sessionStorage.setItem("ebay:publication-stock:1", "invalid-json"));
  await page.reload(); await open(); const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("could not read the saved request");
  await expect(dialog.getByRole("button", { name: "Load saved request" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Recheck stock setup", exact: true })).toBeDisabled();
  expect(state.commands).toEqual([]);
});

test("account and catalog blockers link to their actual correction controls", async ({ page }) => {
  const { feed, state, dialog, apply } = await setup(page);
  state.review.canApply = false; state.review.inventory.ready = false;
  state.review.inventory.blockers = [
    { code: "STOCK_LISTING_ACCOUNT_CHANGED", message: "Reconnect the intended eBay account.", action: "reconnect", productVariantId: null },
    { code: "STOCK_LISTING_SOURCE_CHANGED", message: "The catalog variant is no longer sellable.", action: "review_variant", productVariantId: 11 },
  ];
  await dialog.getByRole("button", { name: "Recheck stock setup", exact: true }).click();
  await expect(apply).toBeDisabled();
  await expect(dialog.getByRole("link", { name: "Open connection settings" })).toHaveAttribute("href", "/channels/ebay#connection");
  await expect(dialog.getByRole("link", { name: "Open product variants" })).toHaveAttribute("href", "/products/1?tab=variants");
  expect(state.commands).toEqual([]); expect(feed.errors).toEqual([]); expect(feed.unexpected).toEqual([]);
});

const priorJob = { ...queuedJob, id: "22b44ab8-894f-41cd-8a35-7b2d1b1db2d7", state: "recovering", code: "EBAY_PUBLICATION_READBACK_PENDING", message: "Checking the earlier accepted publication." };
const priorWorkFailure = { code: "EBAY_PUBLICATION_PRIOR_WORK_REQUIRED", error: "An earlier publication must finish first.",
  issue: resolveEbayListingIssue({ code: "EBAY_PUBLICATION_PRIOR_WORK_REQUIRED", productId: 1, jobId: priorJob.id }) };

test("a blocked stock review opens the exact earlier publication without a write", async ({ page }) => {
  const { feed, state, dialog } = await setup(page);
  await page.route(`**${path}`, route => route.fulfill({ status: 409, json: priorWorkFailure }));
  await page.route(`**/api/ebay/listings/sync-jobs/${priorJob.id}`, route => route.fulfill({ json: { job: priorJob } }));
  await dialog.getByRole("button", { name: "Recheck stock setup", exact: true }).click();
  await dialog.getByRole("button", { name: "View earlier publication", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Publishing status" })).toBeVisible();
  await expect(dialog).toContainText(`Request reference: ${priorJob.id}`);
  expect(state.commands).toEqual([]); expect(feed.commands).toEqual([]); expect(feed.errors).toEqual([]); expect(feed.unexpected).toEqual([]);
});

test("a blocked stock apply can inspect the prior job while preserving its exact pending command", async ({ page }) => {
  const { feed, state, dialog, apply, open } = await setup(page); let allow = false;
  await page.route(`**${path}/apply`, route => {
    const command = route.request().postDataJSON(); state.commands.push(command);
    if (!allow) return route.fulfill({ status: 409, json: priorWorkFailure });
    feed.jobs = [queuedJob]; return route.fulfill({ json: receipt(command) });
  });
  await page.route(`**/api/ebay/listings/sync-jobs/${priorJob.id}`, route => route.fulfill({ json: { job: priorJob } }));
  await apply.click(); await dialog.getByRole("button", { name: "View earlier publication", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Publishing status" })).toBeVisible();
  await expect(dialog).toContainText(`Request reference: ${priorJob.id}`);
  expect(JSON.parse((await page.evaluate(() => sessionStorage.getItem("ebay:publication-stock:1")))!)).toEqual(state.commands[0]);
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await open(); allow = true; await dialog.getByRole("button", { name: "Retry same request", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("publication is not yet confirmed");
  expect(state.commands).toHaveLength(2); expect(state.commands[1]).toEqual(state.commands[0]);
  expect(feed.commands).toEqual([]); expect(feed.errors).toEqual([]); expect(feed.unexpected).toEqual([]);
});
