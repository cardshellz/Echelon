import { expect, test } from "@playwright/test";
import { setupEbayChannelPage as setup } from "./fixtures/ebay-channel-page.fixture";
const missingPhoto = "Replace uploaded catalog image 42: its file is missing, empty or larger than 10 MB.";
const success = { synced:2,priceChanges:0,qtyChanges:0,policyChanges:0,errors:0,details:[{ success:true },{ success:true }] };

test("a failed uploaded photo is shown as failure and the same listing can be retried",async ({ page },info) => {
  const state=await setup(page);
  await page.getByTitle("Sync this listing",{ exact:true }).filter({ visible:true }).click();
  await expect(page.locator('li[role="status"]').filter({ hasText:"Sync Needs Attention" })).toContainText(missingPhoto);
  await expect(page.locator('li[role="status"]').filter({ hasText:"Product Synced" })).toHaveCount(0);
  expect(state.requests).toHaveLength(1);
  await page.screenshot({ path:info.outputPath("ebay-photo-failure.png"),fullPage:true });
  state.response=success;
  await page.getByTitle("Sync this listing",{ exact:true }).filter({ visible:true }).click();
  await expect(page.locator('li[role="status"]').filter({ hasText:"Product Synced" })).toContainText("Synced 2 variants");
  expect(state.requests).toHaveLength(2);
  expect(state.errors).toEqual([]);expect(state.unexpected).toEqual([]);
});
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
