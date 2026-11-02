import { describe, expect, it } from "vitest";
import { needsCancellationSettlementRefresh } from "../../account-settlement-refresh";
import type { CustomerAccountOrderSummary } from "@shared/customer-account/customer-account-orders";
const summary: CustomerAccountOrderSummary={externalOrderId:"1",orderReference:"#TEST",omsOrderId:1,currency:"USD",totalCents:0,
  cancelled:true,financialStatus:"Paid",progress:{unavailable:[],delivery:null,packages:[],returns:[],refunds:[
    {key:"cancellation:fixture",reference:"Order cancellation",status:{code:"processing",label:"Refund processing"}}]}};
describe("automatic cancellation settlement observation",()=>{
  it("continues after cancellation while the refund is pending, independently of return delivery",()=>{
    expect(needsCancellationSettlementRefresh(summary)).toBe(true);
    expect(needsCancellationSettlementRefresh({...summary,progress:{...summary.progress!,refunds:[]}})).toBe(false);
    expect(needsCancellationSettlementRefresh({...summary,financialStatus:"Refunded"})).toBe(false);
  });
  it.each(["completed","not_required","failed"] as const)("stops on %s and does not observe unrelated returns",code=>{
    expect(needsCancellationSettlementRefresh({...summary,progress:{...summary.progress!,refunds:[{...summary.progress!.refunds[0],status:{code,label:code}}]}})).toBe(false);
    expect(needsCancellationSettlementRefresh({...summary,progress:{...summary.progress!,refunds:[{...summary.progress!.refunds[0],key:"return:fixture"}]}})).toBe(false);
  });
});
