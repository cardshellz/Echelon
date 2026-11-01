import { expect, test } from "@playwright/test";
import { setupEbayChannelPage as setup } from "./fixtures/ebay-channel-page.fixture";
import { resolveEbayListingIssue } from "../../shared/ebay-listing-issue";
const missingPhoto = "Replace uploaded catalog image 42: its file is missing, empty or larger than 10 MB.";
const success = { synced:2,priceChanges:0,qtyChanges:0,policyChanges:0,errors:0,details:[{ success:true },{ success:true }] };

test("a real minimum-resolution refusal identifies the photo and recovers through Images and normal Sync", async ({ page }, info) => {
  const state = await setup(page);
  const issue = resolveEbayListingIssue({ productId:1,code:"EBAY_PHOTO_RESOLUTION_TOO_SMALL",
    message:"Photo 2 is 400 × 400 pixels. This channel requires at least 500 pixels on the longest side. Replace it with the original image." });
  const failed = { id:"6e4d8e03-3197-4d21-a6d7-aa1ddaecc775",productId:1,state:"needs_attention",code:issue.code,message:issue.message,issue,
    nextAttemptAt:"2026-10-09T12:00:00.000Z",updatedAt:"2026-10-09T12:00:00.000Z" };
  state.response = { ...success,synced:0,errors:1,details:[{success:false,error:issue.message,code:issue.code}],jobs:[failed] };
  await page.getByTitle("Sync this listing",{exact:true}).filter({visible:true}).click();
  const correction = page.getByRole("link",{name:"Open product images",exact:true});
  await expect(correction).toHaveAttribute("href","/products/1?tab=images");
  await expect(page.getByText(issue.message,{exact:true}).filter({visible:true}).first()).toBeVisible();
  await expect(page.locator('li[role="status"]').filter({hasText:"Product Synced"})).toHaveCount(0);
  await page.screenshot({path:info.outputPath("thumbnail-original-correction.png"),fullPage:true});
  const completed = {id:"6e4d8e03-3197-4d21-a6d7-aa1ddaecc776",productId:1,state:"completed",code:null,message:null,
    nextAttemptAt:failed.nextAttemptAt,updatedAt:failed.updatedAt};
  state.response = {...success,jobs:[completed]};
  await page.getByTitle("Sync this listing",{exact:true}).filter({visible:true}).click();
  await expect(page.locator('li[role="status"]').filter({hasText:"Product Synced"})).toContainText("Synced 2 variants");
  await expect(correction).toHaveCount(0);
  expect(state.requests).toHaveLength(2);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

for (const receipt of ["saved", "unconfirmed"] as const) {
  test(`a photo blocker stays actionable and recovers without reload with a ${receipt} receipt`, async ({ page }, info) => {
    const state = await setup(page);
    const blockedJob = {
      id: "6e4d8e03-3197-4d21-a6d7-aa1ddaecc775",
      productId: 1,
      kind: "sync",
      operation: "sync",
      state: "needs_attention",
      code: "EBAY_CATALOG_PHOTO_UNAVAILABLE",
      message: missingPhoto,
      nextAttemptAt: "2026-10-09T12:00:00.000Z",
      updatedAt: "2026-10-09T12:00:00.000Z",
    };
    state.response = {
      ...success,
      synced: 0,
      errors: 1,
      details: [{ success: false, error: missingPhoto, code: blockedJob.code }],
      jobs: receipt === "saved" ? [blockedJob] : [],
    };
    const sync = page.getByTitle("Sync this listing", { exact: true }).filter({ visible: true });
    const photoCorrection = page.getByRole("link", { name: "Open product images" });
    const successNotice = page.locator('li[role="status"]').filter({ hasText: "Product Synced" });

    await sync.click();
    await expect(page.locator('li[role="status"]').filter({ hasText: "Sync Needs Attention" })).toContainText(missingPhoto);
    await expect(successNotice).toHaveCount(0);
    expect(state.requests).toHaveLength(1);
    await expect(photoCorrection).toHaveAttribute("href", "/products/1?tab=images");
    await expect(sync).toBeEnabled();
    await page.screenshot({ path: info.outputPath("ebay-photo-failure.png"), fullPage: true });

    // Sync rechecks through the owner; clicking again cannot dismiss an unresolved blocker.
    await sync.click();
    await expect.poll(() => state.requests.length).toBe(2);
    await expect(sync).toBeEnabled();
    await expect(photoCorrection).toBeVisible();
    await expect(successNotice).toHaveCount(0);

    // Simulate the owner confirming the corrected photos, without navigating or reloading.
    state.response = { ...success, jobs: [] };
    await sync.click();
    await expect(successNotice).toContainText("Synced 2 variants");
    await expect(photoCorrection).toHaveCount(0);
    expect(state.requests).toEqual(Array(3).fill("/api/ebay/listings/sync-product/1"));
    // A confirmed receipt permits a fresh request. Without one, only exact replay is safe.
    expect(new Set(state.commands).size).toBe(receipt === "saved" ? 3 : 1);
    expect(await page.evaluate(() => sessionStorage.getItem("channel-listing-sync-command:operator:67:1"))).toBeNull();
    expect(state.errors).toEqual([]);
    expect(state.unexpected).toEqual([]);
  });
}
test("a partial provider failure is reported as incomplete",async ({ page }) => {
  const state=await setup(page);
  state.response={ ...success,synced:1,errors:1,details:[{ success:true },{ success:false,error:"eBay rejected inventory item update" }] };
  await page.getByTitle("Sync this listing",{ exact:true }).filter({ visible:true }).click();
  await expect(page.locator('li[role="status"]').filter({ hasText:"Sync Incomplete" })).toContainText("1 variant synced; 1 error");
  await expect(page.locator('li[role="status"]').filter({ hasText:"Product Synced" })).toHaveCount(0);
  expect(state.errors).toEqual([]);expect(state.unexpected).toEqual([]);
});
test("a malformed sync response cannot claim that photos synced",async ({ page }) => {
  const state=await setup(page);state.response={ synced:"unknown" };
  await page.getByTitle("Sync this listing",{ exact:true }).filter({ visible:true }).click();
  await expect(page.locator('li[role="status"]').filter({ hasText:"Sync Failed" })).toBeVisible();
  await expect(page.locator('li[role="status"]').filter({ hasText:"Product Synced" })).toHaveCount(0);
  expect(state.errors).toEqual([]);expect(state.unexpected).toEqual([]);
});
