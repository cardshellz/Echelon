import { expect, test, type Page, type Route } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";
import { invoiceSourceFixture } from "../fixtures/invoice-source";
import { invoiceListItem, paymentListItem, workListPage } from "./procurement-ap-work-list-fixtures";
import { appliedPaymentReply, balance, paymentFixture, recordedPaymentReply } from "./procurement-payment-fixtures";

test.use({ timezoneId: "America/Los_Angeles" });
type Mode = "ok" | "lost" | "auth" | "mismatch" | "reject";
async function setup(page: Page) {
  const failures = await installFixtures(page);
  const state = { actor: "ap-reader", canApprove: true, mode: "ok" as Mode, detailFailed: false, invoicesFailed: false, payment: paymentFixture() as any, requests: [] as Array<{ operation: string; key: string; body: any }>, records: new Map<string,any>(), queries: [] as URLSearchParams[] };
  await page.route("**/api/auth/me", route => route.fulfill({ json: { user: { id: state.actor, username: state.actor, role: "admin" }, permissions: ["purchasing:view",...(state.canApprove ? ["purchasing:approve"] : [])],roles:["admin"] } }));
  await page.route("**/api/vendors",route=>route.fulfill({json:[{id:2,name:"Test supplier"}]}));
  await page.route("**/api/ap/command-events?*",route=>route.fulfill({json:{events:[]}}));
  await page.route("**/api/ap-payments/work-list?*",route=>route.fulfill({json:workListPage([paymentListItem(state.payment)],route.request().url())}));
  await page.route("**/api/ap-payments/90",route=>state.detailFailed?route.fulfill({status:503,json:{error:"Payment read unavailable"}}):route.fulfill({json:state.payment}));
  await page.route("**/api/vendor-invoices/work-list?*",route=>{
    const params=new URL(route.request().url()).searchParams;state.queries.push(params);
    if(state.invoicesFailed)return route.fulfill({status:503,json:{error:"Invoice list unavailable"}});
    const invoices=Array.from({length:25},(_,index)=>invoiceListItem({id:index+201,invoiceNumber:`INV-${index+201}`,status:"approved",balanceCents:10000}));
    const search=params.get("search");return route.fulfill({json:workListPage(params.get("vendorId")==="2"?invoices.filter(invoice=>!search||invoice.invoiceNumber===search):[],route.request().url())});
  });
  await page.route("**/api/vendor-invoices/71",route=>route.fulfill({json:{id:71,invoiceNumber:"INV-71",vendorId:2,vendorName:"Test supplier",status:"approved",currency:"USD",invoicedAmountCents:10000,paidAmountCents:0,balanceCents:10000,paymentReviewRequired:false,sourceCapabilities:invoiceSourceFixture(),capabilities:{edit:{allowed:false,requiredPermission:"purchasing:edit",code:"AP_INVOICE_FINANCIAL_HISTORY",reason:"Approved invoice"}},lines:[],poLinks:[],attachments:[],payments:state.payment.allocations.map((row:any)=>({...row,id:row.id,apPaymentId:90,paymentNumber:"PAY-90",paymentStatus:state.payment.status,paymentMethod:"ach",paymentDate:state.payment.paymentDate,paymentCalendarDate:state.payment.paymentCalendarDate,paymentDateSource:state.payment.paymentDateSource}))}}));
  async function command(route: Route,operation:string) {
    const request=route.request();const body=request.postDataJSON();const key=request.headers()["idempotency-key"];state.requests.push({operation,key,body});
    if(state.mode==="auth")return route.fulfill({status:401,json:{error:"Session expired"}});
    if(state.mode==="reject")return route.fulfill({status:409,json:{error:"Refresh the reviewed payment balance",details:{paymentCommandOutcome:"rejected",actorId:state.actor,idempotencyKey:key,command:operation}}});
    let result=state.records.get(key);
    if(!result){
      if(operation==="apply_payment"){
        const added=body.allocations.reduce((sum:number,row:any)=>sum+row.appliedAmountCents,0);const applied=state.payment.paymentBalance.appliedAmountCents+added;
        result=appliedPaymentReply(body,key,applied,state.actor);state.payment.paymentBalance=result.paymentBalance;
        state.payment.allocations.push(...result.applications.map((row:any)=>({id:row.allocationId,vendorInvoiceId:row.vendorInvoiceId,appliedAmountCents:row.appliedAmountCents,invoiceNumber:`INV-${row.vendorInvoiceId}`,notes:body.reason})));
      }else if(operation==="record_payment"){
        result=recordedPaymentReply(body,key,state.actor);state.payment={...result,paymentNumber:"PAY-90",vendorName:"Test supplier",allocations:result.applications.map((row:any)=>({id:row.allocationId,vendorInvoiceId:row.vendorInvoiceId,appliedAmountCents:row.appliedAmountCents,invoiceNumber:`INV-${row.vendorInvoiceId}`,notes:null}))};
      }else{result={command:operation,paymentId:90,actorId:state.actor,idempotencyKey:key,ok:true,status:"voided"};state.payment.status="voided";state.payment.paymentBalance={state:"voided",appliedAmountCents:0,unappliedAmountCents:0,version:"c".repeat(64),issue:null};}
      state.records.set(key,result);
    }
    if(state.mode==="lost")return route.abort("failed");
    return route.fulfill({json:state.mode==="mismatch"?{...result,paymentId:999}:result});
  }
  await page.route("**/api/ap-payments/90/applications",route=>command(route,"apply_payment"));
  await page.route("**/api/ap-payments/90/void",route=>command(route,"void_payment"));
  await page.route("**/api/ap-payments",route=>command(route,"record_payment"));
  return {state,failures};
}
async function openPayment(page:Page){await page.goto("/ap-payments?paymentId=90");await expect(page.getByRole("dialog").getByRole("heading",{name:"Payment PAY-90",exact:true})).toBeVisible();}
async function applyAmount(page:Page,amount="25.00"){
  const dialog=page.getByRole("dialog");await dialog.getByRole("textbox",{name:"Apply existing payment to INV-201",exact:true}).fill(amount);await dialog.getByLabel("Application reason",{exact:true}).fill("Apply deposit to supplier bill");await dialog.getByRole("button",{name:"Apply existing payment",exact:true}).click();
}
async function recordCash(page:Page){await page.goto("/ap-payments");await page.getByRole("button",{name:"Record Payment",exact:true}).click();const dialog=page.getByRole("dialog");await dialog.getByRole("combobox",{name:"Payment vendor"}).selectOption("2");await dialog.getByLabel("Payment date").fill("2026-10-19");await dialog.getByPlaceholder("0.00",{exact:true}).first().fill("50.00");await dialog.getByRole("button",{name:"Record Payment",exact:true}).click();}

test("applies existing funds across invoice pages and preserves later partial applications to the same invoice",async({page},info)=>{
  const {state,failures}=await setup(page);await openPayment(page);const dialog=page.getByRole("dialog");
  await dialog.getByRole("textbox",{name:"Apply existing payment to INV-201",exact:true}).fill(".10");await dialog.getByRole("navigation",{name:"eligible invoices pages"}).getByRole("button",{name:"Next",exact:true}).click();
  await dialog.getByRole("textbox",{name:"Apply existing payment to INV-225",exact:true}).fill(".20");await dialog.getByLabel("Application reason").fill("First partial deposit application");await dialog.getByRole("button",{name:"Apply existing payment",exact:true}).click();
  await expect(dialog.getByRole("region",{name:"Payment application history"})).toContainText("$0.10");await expect(dialog.getByRole("region",{name:"Payment application history"})).toContainText("$0.20");
  await dialog.getByRole("navigation",{name:"eligible invoices pages"}).getByRole("button",{name:"Previous",exact:true}).click();await applyAmount(page,".30");
  await expect(dialog.getByRole("region",{name:"Payment application history"}).getByRole("link",{name:"INV-201",exact:true})).toHaveCount(2);
  expect(state.requests.map(row=>row.operation)).toEqual(["apply_payment","apply_payment"]);expect(state.payment.paymentBalance).toMatchObject({appliedAmountCents:60,unappliedAmountCents:9940});expect(state.queries.every(query=>query.get("vendorId")==="2"&&query.get("status")==="approved,partially_paid")).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await expect(page.getByText("Existing payment applied",{exact:true})).toBeHidden({timeout:10000});await dialog.getByRole("heading",{name:"Payment PAY-90",exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath("payment-application-history.png"),fullPage:true});expect(failures).toEqual([]);
});
test("lost application response survives reload and session expiry with the identical key and body",async({page})=>{
  const {state,failures}=await setup(page);state.mode="lost";await openPayment(page);await applyAmount(page);await expect(page.getByRole("dialog").getByRole("button",{name:"Recover saved payment request"})).toBeVisible();
  state.mode="auth";await page.reload();const retry=page.getByRole("dialog").getByRole("button",{name:"Recover saved payment request"});await retry.click();await expect(page.getByRole("dialog").getByText("Session expired",{exact:true})).toBeVisible();
  state.mode="ok";await retry.click();await expect(page.getByRole("dialog").getByRole("region",{name:"Saved payment request"})).toHaveCount(0);expect(state.records.size).toBe(1);expect(state.requests).toHaveLength(3);expect(state.requests.every(row=>row.key===state.requests[0].key&&JSON.stringify(row.body)===JSON.stringify(state.requests[0].body))).toBe(true);expect(failures).toEqual([]);
});
test("wrong successful application response retains recovery until matching evidence arrives",async({page})=>{
  const {state}=await setup(page);state.mode="mismatch";await openPayment(page);await applyAmount(page);await expect(page.getByRole("dialog").getByRole("region",{name:"Saved payment request"})).toBeVisible();state.mode="ok";await page.getByRole("dialog").getByRole("button",{name:"Recover saved payment request"}).click();await expect(page.getByRole("dialog").getByRole("region",{name:"Saved payment request"})).toHaveCount(0);expect(state.records.size).toBe(1);
});
test("durable application rejection permits a fresh reviewed request with a new key",async({page})=>{
  const {state}=await setup(page);state.mode="reject";await openPayment(page);await applyAmount(page);await expect(page.getByRole("dialog").getByText("Refresh the reviewed payment balance",{exact:true}).first()).toBeVisible();await expect(page.getByRole("dialog").getByRole("region",{name:"Saved payment request"})).toHaveCount(0);state.mode="ok";await page.getByRole("dialog").getByRole("button",{name:"Apply existing payment",exact:true}).click();await expect.poll(()=>state.records.size).toBe(1);expect(state.requests[1].key).not.toBe(state.requests[0].key);
});
test("recorded cash recovery survives navigation and never allows a replacement cash request",async({page})=>{
  const {state}=await setup(page);state.mode="lost";await recordCash(page);await expect(page.getByRole("dialog").getByRole("region",{name:"Saved payment request"})).toBeVisible();await page.getByRole("dialog").getByRole("button",{name:"Cancel",exact:true}).click();await expect(page.getByRole("region",{name:"Saved payment request"})).toBeVisible();await page.goto("/ap-payments");await expect(page.getByRole("button",{name:"Record Payment",exact:true})).toBeDisabled();state.mode="ok";await page.getByRole("button",{name:"Recover saved payment request"}).click();await expect(page.getByRole("region",{name:"Saved payment request"})).toHaveCount(0);expect(state.requests).toHaveLength(2);expect(state.records.size).toBe(1);expect(state.requests[1]).toEqual(state.requests[0]);
});
test("switching operator cannot replace another operator's unresolved cash request",async({page})=>{
  const {state}=await setup(page);state.mode="lost";await recordCash(page);await expect(page.getByRole("dialog").getByRole("region",{name:"Saved payment request"})).toBeVisible();state.actor="different-buyer";await page.goto("/ap-payments");await expect(page.getByRole("alert").filter({hasText:"another operator"})).toBeVisible();await expect(page.getByRole("button",{name:"Record Payment",exact:true})).toBeDisabled();await expect(page.getByRole("button",{name:"Void payment PAY-90"})).toBeDisabled();expect(state.requests).toHaveLength(1);state.actor="ap-reader";state.mode="ok";await page.reload();await page.getByRole("button",{name:"Recover saved payment request"}).click();await expect(page.getByRole("region",{name:"Saved payment request"})).toHaveCount(0);
});
test("invoice payment entry retains its exact cash request when invoice navigation later fails",async({page})=>{
  const {state}=await setup(page);state.mode="lost";await page.goto("/ap-invoices/71");await page.getByRole("button",{name:"Record Payment",exact:true}).first().click();await page.getByRole("dialog").getByLabel("Payment date").fill("2026-10-19");await page.getByRole("dialog").getByRole("button",{name:"Record Payment",exact:true}).click();await expect(page.getByRole("dialog").getByRole("region",{name:"Saved payment request"})).toBeVisible();
  await page.getByRole("dialog").getByRole("button",{name:"Cancel",exact:true}).click();await expect(page.getByRole("region",{name:"Saved payment request"})).toBeVisible();
  await page.route("**/api/vendor-invoices/71",route=>route.fulfill({status:503,json:{error:"Invoice read failed"}}));await page.reload();await expect(page.getByText("Unable to load invoice.",{exact:true})).toBeVisible();state.mode="ok";await page.getByRole("button",{name:"Recover saved payment request"}).click();await expect(page.getByRole("region",{name:"Saved payment request"})).toHaveCount(0);expect(state.records.size).toBe(1);expect(state.requests[1]).toEqual(state.requests[0]);
});
test("void recovery confirms the original outcome after the payment already shows voided",async({page})=>{
  const {state}=await setup(page);state.mode="lost";await page.goto("/ap-payments");await page.getByRole("button",{name:"Void payment PAY-90"}).click();await page.getByPlaceholder("Void reason...").fill("Duplicate bank entry");await page.getByRole("button",{name:"Void Payment",exact:true}).click();await expect(page.getByRole("dialog").getByRole("region",{name:"Saved payment request"})).toBeVisible();await page.reload();state.mode="ok";await page.getByRole("button",{name:"Recover saved payment request"}).click();await expect(page.getByRole("region",{name:"Saved payment request"})).toHaveCount(0);expect(state.records.size).toBe(1);expect(state.requests[1]).toEqual(state.requests[0]);
});
test("read-only users inspect history but cannot apply payment funds",async({page})=>{
  const {state}=await setup(page);state.canApprove=false;await openPayment(page);await expect(page.getByRole("dialog").getByRole("region",{name:"Payment application history"})).toBeVisible();await expect(page.getByRole("button",{name:"Apply existing payment",exact:true})).toHaveCount(0);expect(state.requests).toEqual([]);
});
test("unavailable history and invoice candidates remain explicit and recoverable",async({page})=>{
  const {state}=await setup(page);state.detailFailed=true;await page.goto("/ap-payments?paymentId=90");await expect(page.getByRole("button",{name:"Retry payment history"})).toBeVisible();state.detailFailed=false;state.invoicesFailed=true;await page.getByRole("button",{name:"Retry payment history"}).click();await expect(page.getByRole("button",{name:"Retry eligible invoices"})).toBeVisible();await expect(page.getByRole("button",{name:"Apply existing payment",exact:true})).toBeDisabled();state.invoicesFailed=false;await page.getByRole("button",{name:"Retry eligible invoices"}).click();await expect(page.getByRole("textbox",{name:"Apply existing payment to INV-201",exact:true})).toBeVisible();
});
test("storage failure prevents sending new cash",async({page})=>{
  const {state}=await setup(page);await page.addInitScript(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==="echelon:ap-payment:v1")throw new Error("storage unavailable");return original.call(this,key,value);};});await recordCash(page);await expect(page.getByText(/not sent because recovery could not be saved/).first()).toBeVisible();expect(state.requests).toEqual([]);
});
test("payment evidence requiring review never presents an available cash balance",async({page})=>{
  const {state}=await setup(page);state.payment.paymentBalance={state:"review_required",appliedAmountCents:null,unappliedAmountCents:null,version:"a".repeat(64),issue:{code:"AP_PAYMENT_REVIEW",message:"Existing allocation evidence does not reconcile."}};await openPayment(page);await expect(page.getByRole("dialog").getByRole("alert")).toContainText("does not reconcile");await expect(page.getByRole("button",{name:"Apply existing payment",exact:true})).toHaveCount(0);await expect(page.getByRole("dialog").getByText("Unavailable",{exact:true})).toHaveCount(2);
});
for(const screen of ["payments","invoice","dashboard","po"] as const){
 test(`${screen} displays recorded payment day in a western timezone and labels legacy date unknown`,async({page})=>{
   const {state,failures}=await setup(page);const dateFields={paymentDate:"2026-10-19T00:00:00.000Z",paymentCalendarDate:"2026-10-19",paymentDateSource:"recorded_calendar_date"};
   state.payment={...state.payment,...dateFields,allocations:[{id:1,vendorInvoiceId:71,appliedAmountCents:1000,invoiceNumber:"INV-71",notes:null}]};
   const legacy={...state.payment,id:91,paymentNumber:"LEGACY-91",paymentCalendarDate:null,paymentDateSource:"legacy_timestamp"};
   if(screen==="payments")await page.route("**/api/ap-payments/work-list?*",route=>route.fulfill({json:workListPage([paymentListItem(state.payment),paymentListItem(legacy)],route.request().url())}));
   if(screen==="dashboard")await page.route("**/api/ap/summary",route=>route.fulfill({json:{totalOutstandingCents:0,openInvoiceCount:0,agingBuckets:{},vendorAging:[],recentPayments:[state.payment,legacy],recentlyPaid:[]}}));
   if(screen==="invoice")await page.route("**/api/vendor-invoices/71",route=>route.fulfill({json:{id:71,invoiceNumber:"INV-71",vendorId:2,status:"paid",currency:"USD",invoicedAmountCents:10000,balanceCents:0,paidAmountCents:10000,lines:[],poLinks:[],attachments:[],sourceCapabilities:invoiceSourceFixture(),payments:[{id:1,apPaymentId:90,paymentNumber:"PAY-90",appliedAmountCents:1000,paymentStatus:"completed",paymentMethod:"ach",...dateFields},{id:2,apPaymentId:91,paymentNumber:"LEGACY-91",appliedAmountCents:1000,paymentStatus:"completed",paymentMethod:"ach",paymentDate:dateFields.paymentDate,paymentCalendarDate:null,paymentDateSource:"legacy_timestamp"}]}}));
   if(screen==="po"){await page.route("**/api/purchase-orders/17",route=>route.fulfill({json:po(17)}));await page.route("**/api/purchase-orders/17/payments",route=>route.fulfill({json:{payments:[{allocationId:1,appliedAmountCents:1000,paymentNumber:"PAY-90",...dateFields},{allocationId:2,appliedAmountCents:1000,paymentNumber:"LEGACY-91",paymentDate:dateFields.paymentDate,paymentCalendarDate:null,paymentDateSource:"legacy_timestamp"}]}}));}
   await page.goto(screen==="payments"?"/ap-payments":screen==="invoice"?"/ap-invoices/71":screen==="dashboard"?"/ap":"/purchase-orders/17?tab=payments");
   await expect(page.getByText("Oct 19, 2026",{exact:true}).first()).toBeVisible();await expect(page.getByText("Date not verified",{exact:true}).first()).toBeVisible();await expect(page.getByText("Oct 18, 2026",{exact:true})).toHaveCount(0);
   if(screen==="invoice"){await page.getByRole("link",{name:"PAY-90",exact:true}).click();await expect(page.getByRole("dialog").getByRole("heading",{name:"Payment PAY-90",exact:true})).toBeVisible();}
   expect(failures).toEqual([]);
 });
}
