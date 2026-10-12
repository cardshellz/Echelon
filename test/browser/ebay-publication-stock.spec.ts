import { expect, test, type Page } from "@playwright/test";
import { setupEbayChannelPage } from "./fixtures/ebay-channel-page.fixture";
import { resolveEbayListingIssue } from "../../shared/ebay-listing-issue";

const oldJob = { id: "543b9237-920d-4786-a950-31c6fe941c8f", productId: 1, operation: "publish", kind: "sync", state: "needs_attention",
  code: "EBAY_PUBLICATION_STOCK_REVIEW_REQUIRED", message: "The previous publication stopped before stock preparation.",
  nextAttemptAt: "2026-10-12T12:00:00.000Z", updatedAt: "2026-10-12T12:00:00.000Z" };
const queuedJob = { ...oldJob, id: "1a1300a8-0586-4905-9220-5e72e9d48a4a", state: "queued", code: null, message: null };
const queuedResponse = { results: [{ productName: "55PT Toploader Combo Pack", productId: 1, variantCount: 2, success: false, status: "queued", job: queuedJob }],
  summary: { succeeded: 0, failed: 0, skipped: 0, queued: 1, total: 1 }, cancelled: false };
async function setup(page: Page, code = oldJob.code, message = oldJob.message) {
  const feed = await setupEbayChannelPage(page);
  feed.jobs = [{ ...oldJob, code, message }]; feed.feedStatus = "error"; feed.externalListingId = null;
  const requests: { productIds: number[]; commands: { productId: number; commandKey: string }[] }[] = [];
  await page.route("**/api/ebay/listings/push", route => {
    requests.push(route.request().postDataJSON()); feed.jobs = [queuedJob];
    return route.fulfill({ json: queuedResponse });
  });
  await page.reload();
  return { feed, requests };
}

test("channel selection publishes through the saved workflow without a second inventory approval", async ({ page }, info) => {
  const { feed, requests } = await setup(page);
  await page.getByRole("button", { name: "Retry publishing", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Publication is not yet confirmed.");
  await expect(page.getByRole("button", { name: "Connect stock and publish", exact: true })).toHaveCount(0);
  expect(requests).toEqual([{ productIds: [1], commands: [{ productId: 1, commandKey: expect.stringMatching(/^[a-f0-9-]{36}$/) }] }]);
  await dialog.screenshot({ path: info.outputPath("normal-publication-stock-preparation.png") });
  feed.jobs = [{ ...queuedJob, state: "completed" }];
  await dialog.getByRole("button", { name: "Refresh publishing status", exact: true }).click();
  await expect(dialog).toContainText("Published. Listing and pictures verified.");
  expect(requests).toHaveLength(1);
  expect(feed.errors).toEqual([]); expect(feed.unexpected).toEqual([]);
});

test("an older stock-enrollment action enters normal publishing and preserves its historical command", async ({ page }) => {
  const { feed, requests } = await setup(page);
  feed.jobs = [{ ...oldJob, issue: { ...resolveEbayListingIssue({ code: oldJob.code, productId: 1 }),
    action: { kind: "review_publication_stock", label: "Review stock setup" } } }];
  const prior = { commandKey: "a1b57454-8de4-46c8-a797-eced57bfd5ba", expectedReviewHash: "a".repeat(64) };
  await page.evaluate(value => sessionStorage.setItem("ebay:publication-stock:1", JSON.stringify(value)), prior);
  await page.reload();
  await page.getByRole("button", { name: "Review stock setup", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Publication is not yet confirmed.");
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("ebay:publication-stock:1")!))).toEqual(prior);
  expect(requests).toHaveLength(1); expect(feed.unexpected).toEqual([]); expect(feed.errors).toEqual([]);
});

test("a lost normal publication response retries the exact command after automatic stock preparation", async ({ page }) => {
  const { feed, requests } = await setup(page); let accept = false;
  await page.route("**/api/ebay/listings/push", route => {
    requests.push(route.request().postDataJSON());
    if (!accept) return route.abort("failed");
    feed.jobs = [queuedJob]; return route.fulfill({ json: queuedResponse });
  });
  await page.getByRole("button", { name: "Retry publishing", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Retry saved publishing requests", exact: true })).toBeEnabled();
  accept = true; await dialog.getByRole("button", { name: "Retry saved publishing requests", exact: true }).click();
  await expect(dialog).toContainText("Publication is not yet confirmed.");
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
  expect(feed.errors).toEqual([]); expect(feed.unexpected).toEqual([]);
});

for (const [code, message] of [
  ["STOCK_LISTING_HELD", "This stock destination is on hold."],
  ["STOCK_LISTING_ATP_NOT_READY", "The canonical stock calculation is not ready."],
  ["STOCK_LISTING_MAPPING_CONFLICT", "This eBay SKU belongs to another catalog variant."],
] as const) {
  test(`${code} links the existing inventory settings without another publication`, async ({ page }) => {
    const { feed, requests } = await setup(page, code, message);
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open inventory settings", exact: true })).toHaveAttribute("href", "/channels/inventory?product=1");
    await expect(page.getByRole("button", { name: "Retry publishing", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Connect stock and publish", exact: true })).toHaveCount(0);
    expect(requests).toEqual([]); expect(feed.unexpected).toEqual([]); expect(feed.errors).toEqual([]);
  });
}

test("account and catalog failures link to the existing correction controls", async ({ page }) => {
  const { feed, requests } = await setup(page, "STOCK_LISTING_ACCOUNT_CHANGED", "Reconnect the intended eBay account.");
  await expect(page.getByRole("link", { name: "Open connection settings", exact: true })).toHaveAttribute("href", "/channels/ebay#connection");
  feed.jobs = [{ ...oldJob, code: "STOCK_LISTING_SOURCE_CHANGED", message: "The selected catalog variant is no longer sellable." }];
  await page.reload();
  await expect(page.getByRole("link", { name: "Open product variants", exact: true })).toHaveAttribute("href", "/products/1?tab=variants");
  expect(requests).toEqual([]); expect(feed.unexpected).toEqual([]); expect(feed.errors).toEqual([]);
});
