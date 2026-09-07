import { expect, test, type Page } from "@playwright/test";
import { projectPurchasePipeline } from "../../server/modules/procurement/purchase-pipeline.service";
import { pipelineLine, pipelinePartialReceipt, pipelineTime } from "../fixtures/purchase-pipeline";
import { installFixtures } from "./procurement-fixtures";

async function setup(page: Page, canEdit = true, healthyDashboard = false) {
  const failures = await installFixtures(page);
  const data = pipelinePartialReceipt();
  data.lines.push(pipelineLine({ id: 22,purchaseOrderId: 2,poNumber: "TEST-PO-2",sku: "TEST-EUR",currency: "EUR",expectedDate: null }));
  await page.route("**/api/auth/me",(route) => route.fulfill({json:{user:{id:"test-user",username:"test",role:"admin"},permissions:canEdit ? ["purchasing:view","purchasing:edit"] : ["purchasing:view"],roles:["admin"]}}));
  // The pipeline can load even when unrelated old dashboard widgets fail.
  await page.route("**/api/purchasing/dashboard",(route) => route.fulfill(healthyDashboard ? {json:{stockouts:0,orderNow:0,draftPoCount:0,inTransitCount:0,openPoValueCents:0,noVendorCount:0,stockoutItems:[],draftPos:[],inFlightPos:[],noVendorItems:[],orderNowItems:[],healthBreakdown:{stockout:0,order_now:0,order_soon:0,on_order:0,ok:0,no_movement:0,total:0},spend:{totalReceivedCents:0,openPoValueCents:0,avgPoCents:0,topSupplierName:null,topSupplierCents:0,activeSupplierCount:0},lastAutoDraftRun:null}} : {status:503,json:{error:"Synthetic unrelated dashboard outage"}}));
  for(const path of ["procurement/landed-cost-health", "purchasing/supplier-setup-gaps", "purchasing/forecast-input-gaps", "purchasing/auto-draft/stale-pos", "procurement/health"]) await page.route(`**/api/${path}*`,(route) => route.fulfill({status:503,json:{error:"Synthetic optional widget unavailable"}}));
  await page.route("**/api/purchasing/pipeline?*",(route) => route.fulfill({json:projectPurchasePipeline(data,pipelineTime,new URL(route.request().url()).searchParams.get("horizonDays")==="30" ? 30 : 90)}));
  await page.route("**/api/purchasing/pipeline/lines/*/progress",async (route) => {
    if (route.request().method()!=="GET") return route.fallback();
    const line = data.lines.find((line) => line.id===Number(new URL(route.request().url()).pathname.split("/").at(-2)))!;
    return route.fulfill({json:{purchaseOrderLineId:line.id,current:line.progress,changes:line.progress.report ? [{revision:line.progress.revision,before:null,after:line.progress.report,recordedBy:line.progress.recordedBy,recordedAt:line.progress.recordedAt}] : []}});
  });
  return {failures,data};
}

test("pipeline shows source quantities, currency-separated values and long/unknown arrival horizons",async({page},testInfo) => {
  const {failures} = await setup(page,true,true);
  await page.goto("/purchasing");
  const pipeline = page.getByTestId("purchase-pipeline");
  await expect(pipeline).toBeVisible();
  const transit = page.locator('[data-pipeline-row="11:111:in_transit"]');
  await expect(transit).toContainText("40 pieces");
  await expect(transit).toContainText("40.0000 USD");
  await expect(transit).toContainText("shipment destination; warehouse arrival not confirmed");
  await expect(transit.getByRole("link",{name:"TEST-SHIP-7"})).toHaveAttribute("href","/purchase-orders/1?inspect=shipment%3A7&tab=lifecycle");
  await expect(page.locator('[data-pipeline-row="11:0:in_production"]')).toContainText("30 pieces");
  await expect(pipeline).toContainText("EUR");
  await page.getByLabel("Arrival horizon").selectOption("30");
  await page.getByRole("button",{name:"Later (2)",exact:true}).click();
  await expect(transit).toHaveCount(0);
  await expect(page.locator('[data-pipeline-row="11:0:ready_to_ship"]')).toBeVisible();
  await page.getByRole("button",{name:"Unknown ETA (1)",exact:true}).click();
  await expect(pipeline).toContainText("TEST-EUR");
  await expect(page.locator('[data-pipeline-row="11:0:ready_to_ship"]')).toHaveCount(0);
  await page.screenshot({path:testInfo.outputPath("pipeline-arrivals.png"),fullPage:true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  expect(failures).toEqual([]);
});

test("supplier report validates counts, preserves history and retries an uncertain result with the same intent",async({page},testInfo) => {
  const {data,failures} = await setup(page);
  const writes: Record<string,any>[] = [];
  await page.route("**/api/purchasing/pipeline/lines/11/progress",async(route) => {
    if(route.request().method()!=="PUT") return route.fallback();
    const command=route.request().postDataJSON(); writes.push(command);
    data.lines[0].progress={revision:2,report:command.report,recordedBy:"test-user",recordedAt:pipelineTime.toISOString()};
    if(writes.length===1) return route.abort("failed");
    return route.fulfill({json:{...data.lines[0].progress,reused:true}});
  });
  await page.goto("/purchasing");
  await page.locator('[data-pipeline-row="11:0:in_production"]').getByRole("button",{name:"Record supplier progress"}).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Started pieces",{exact:true}).fill("80");
  await dialog.getByLabel("Completed pieces",{exact:true}).fill("100");
  await dialog.getByRole("button",{name:"Save supplier progress",exact:true}).click();
  await expect(dialog.getByRole("alert")).toContainText("Completed pieces cannot exceed started pieces");
  expect(writes).toHaveLength(0);
  await dialog.getByLabel("Started pieces",{exact:true}).fill("100");
  await dialog.getByLabel("Notes / correction reason").fill("Supplier confirms production finished");
  await dialog.getByRole("button",{name:"Save supplier progress",exact:true}).click();
  await expect(dialog.getByRole("button",{name:"Retry saved progress",exact:true})).toBeVisible();
  await expect(dialog.getByLabel("Started pieces",{exact:true})).toBeDisabled();
  await dialog.getByRole("button",{name:"Retry saved progress",exact:true}).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toHaveLength(2); expect(writes[0]).toEqual(writes[1]);
  await expect(page.locator('[data-pipeline-row="11:0:ready_to_ship"]')).toContainText("40 pieces");
  await expect(page.locator('[data-pipeline-row="11:0:in_production"]')).toHaveCount(0);
  await page.locator('[data-pipeline-row="11:0:ready_to_ship"]').getByRole("button",{name:"Record supplier progress"}).click();
  await dialog.getByText("Preserved report history",{exact:true}).click();
  await expect(dialog).toContainText("Revision 2");
  await page.screenshot({path:testInfo.outputPath("supplier-progress-history.png"),fullPage:true});
  expect(failures).toEqual([]);
});

test("view-only operator can inspect report history without a mutation control",async({page}) => {
  const {failures}=await setup(page,false);
  await page.goto("/purchasing");
  await page.locator('[data-pipeline-row="11:0:in_production"]').getByRole("button",{name:"Supplier report history"}).click();
  const dialog=page.getByRole("dialog");
  await expect(dialog.getByRole("button",{name:"Save supplier progress"})).toHaveCount(0);
  await expect(dialog.getByLabel("Started pieces",{exact:true})).toBeDisabled();
  await dialog.getByText("Preserved report history",{exact:true}).click();
  await expect(dialog).toContainText("Supplier report A");
  expect(failures).toEqual([]);
});

test("refresh failure retains a visibly dated snapshot and malformed initial evidence exposes no totals",async({page}) => {
  const {failures}=await setup(page);
  await page.goto("/purchasing");
  await expect(page.getByTestId("purchase-pipeline")).toBeVisible();
  await page.route("**/api/purchasing/pipeline?*",(route) => route.fulfill({json:{rows:[]}}));
  await page.getByRole("button",{name:"Refresh pipeline",exact:true}).click();
  await expect(page.getByRole("alert").filter({hasText:"Refresh failed"})).toBeVisible();
  await expect(page.getByTestId("purchase-pipeline")).toContainText(pipelineTime.toISOString());
  await page.reload();
  await expect(page.getByRole("alert").filter({hasText:"Pipeline evidence could not be loaded"})).toBeVisible();
  await expect(page.getByTestId("purchase-pipeline")).toHaveCount(0);
  expect(failures).toEqual([]);
});
