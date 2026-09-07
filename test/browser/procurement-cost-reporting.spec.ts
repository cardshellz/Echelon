import {expect,test,type Page} from "@playwright/test";
import type {CostReportDeliveryList} from "../../shared/procurement/cost-report-delivery";
import {installFixtures} from "./procurement-fixtures";

const destinationId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",deliveryId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",receiptId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
async function setup(page:Page,options:{canRetry?:boolean;unconfigured?:boolean}={}) {
  const failures=await installFixtures(page);
  await page.route("**/api/auth/me",(route) => route.fulfill({json:{user:{id:"report-reviewer",username:"test",role:"admin"},roles:["admin"],permissions:["inventory:view",...(options.canRetry===false ? [] : ["purchasing:approve"])]}}));
  await page.route("**/api/purchase-orders/17/workspace",(route) => route.fulfill({json:{purchase:{id:17,poNumber:"TEST-PO-17",status:"acknowledged",physicalStatus:"acknowledged",financialStatus:"paid",currency:"USD",vendorName:"Test vendor",totalCents:10000,invoicedTotalCents:10000,paidTotalCents:10000,outstandingCents:0,expectedDeliveryDate:null,confirmedDeliveryDate:null,actualDeliveryDate:null,lines:[]},rfqOrigins:[],shipments:[],receipts:[],invoices:[],edges:[],limitations:[]}}));
  const now="2026-09-07T12:00:00.000Z";
  const pending={id:deliveryId,sourceEventId:"101",applicationId:"20",destinationId,state:"dead_letter" as const,attemptCount:8,nextAttemptAt:null,lastErrorCode:"COST_REPORT_ATTEMPTS_EXHAUSTED",lastErrorMessage:"Automatic delivery attempts exhausted; review and retry explicitly.",acknowledgement:null,recordedAt:now,updatedAt:now};
  const data:CostReportDeliveryList={purchaseOrderId:17,configuration:options.unconfigured ? "not_configured" : "enabled",unqueuedEventCount:options.unconfigured ? 1 : 0,truncated:false,deliveries:options.unconfigured ? [] : [pending,{...pending,id:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",sourceEventId:"100",applicationId:"19",state:"acknowledged",attemptCount:1,lastErrorCode:null,lastErrorMessage:null,acknowledgement:{contractVersion:1,disposition:"accepted_evidence_only",sourceSystemId:"synthetic-echelon",destinationId,deliveryId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",sourceEventId:"100",payloadHash:"a".repeat(64),reportHash:"b".repeat(64),receiptId,acceptedAt:now}}]};
  const commands:Array<{key:string;body:unknown}>=[];
  await page.route("**/api/purchase-orders/17/cost-reporting**",async (route) => {
    if (route.request().method()==="GET") return route.fulfill({json:data});
    commands.push({key:route.request().headers()["idempotency-key"],body:route.request().postDataJSON()});
    if (commands.length===1) return route.abort("connectionreset");
    data.deliveries[0]={...pending,state:"queued",lastErrorCode:null,lastErrorMessage:null};
    return route.fulfill({json:{deliveryId,state:"queued",replayed:true}});
  });
  await page.goto("/purchase-orders/17?tab=lifecycle");
  const section=page.getByRole("region",{name:"Archon cost reporting"});await expect(section).toBeVisible();
  return {section,commands,failures};
}
test("shows the retained receipt and verified hash, then safely retries an ambiguous request",async ({page},testInfo) => {
  const {section,commands,failures}=await setup(page);
  await section.locator("summary").filter({hasText:"Event 100"}).click();
  await expect(section.getByText(receiptId,{exact:true})).toBeVisible();await expect(section.getByText("b".repeat(64),{exact:true})).toBeVisible();
  await section.locator("summary").filter({hasText:"Event 101"}).click();
  await section.getByLabel("Reason for retry").fill("Receiver credentials verified");await section.getByRole("button",{name:"Retry report",exact:true}).click();
  await expect.poll(() => commands.length).toBe(2);expect(commands[0].key).toBeTruthy();expect(commands[1]).toEqual(commands[0]);
  await expect(section.locator("summary").filter({hasText:"Event 101"})).toContainText("Queued");
  await page.screenshot({path:testInfo.outputPath("cost-reporting-delivery.png"),fullPage:true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);expect(failures).toEqual([]);
});
test("view-only users can inspect acknowledgements and cannot retry",async ({page}) => {
  const {section,commands,failures}=await setup(page,{canRetry:false});await section.locator("summary").filter({hasText:"Event 101"}).click();
  await expect(section.getByRole("button",{name:"Retry report",exact:true})).toHaveCount(0);await expect(section.getByLabel("Reason for retry")).toHaveCount(0);expect(commands).toEqual([]);expect(failures).toEqual([]);
});
test("unconfigured delivery leaves retained cost events visible",async ({page}) => {
  const {section,failures}=await setup(page,{unconfigured:true});await expect(section).toContainText("An Archon reporting destination has not been configured");await expect(section).toContainText("1 retained cost event awaits delivery preparation");expect(failures).toEqual([]);
});
