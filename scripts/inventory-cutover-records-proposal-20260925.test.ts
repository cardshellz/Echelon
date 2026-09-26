import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProposal, planLine, type LocalLine, type ProviderFact } from "./inventory-cutover-records-proposal-20260925";

function line(id="1",order="1"):LocalLine {
  return {id,order_id:order,external_line_item_id:`external-${id}`,quantity:1,paid_quantity:1,cancelled_quantity:0,
    refunded_quantity:0,authority_fulfillable_quantity:1,wms_materialized_quantity:1,authorization_status:"authorized",
    fulfillment_status:"unfulfilled",requires_shipping:true,row_hash:"a".repeat(64)};
}
function fact(local:LocalLine,outcome:ProviderFact["outcome"]="fulfilled"):ProviderFact {
  return {channelId:36,orderId:`provider-${local.order_id}`,lineId:local.external_line_item_id,quantity:1,outcome,
    refunds:outcome==="refunded"?[{refundId:"refund-1",quantity:1,restockPolicy:"no_restock"}]:[]};
}
function fixture() {
  const lines=Array.from({length:42},(_,index)=>line(String(index+1)));
  const order=(id:string)=>({id,channel_id:36,external_order_id:`provider-${id}`,external_order_number:id,
    status:"confirmed",fulfillment_status:"unfulfilled",financial_status:"paid",row_hash:"b".repeat(64)});
  return {context:{checked_at:"2026-09-25T20:00:00.000Z",read_only:"on",productionWrites:false,executable:false,
    approvedClosedLineIds:lines.map(l=>l.id),preservedOpenLineId:"119866",orders:[order("1"),order("2")],
    lines:[...lines,line("119866","2")],adjustments:[] as Record<string,unknown>[]},
    facts:[...lines.map(l=>fact(l)),fact(line("119866","2"),"open")]};
}
test("fulfilled treatment only changes the OMS fulfillment marker, not commercial quantities",()=>{
  const before=line();assert.deepEqual(planLine(before,fact(before)),{fulfillment_status:"fulfilled"});
  assert.equal(before.authority_fulfillable_quantity,1);
});
test("already-fulfilled line is a no-op",()=>{
  const before={...line(),fulfillment_status:"fulfilled"};assert.deepEqual(planLine(before,fact(before)),{});
});
test("full refund keeps original fulfillment history and aligns disposition",()=>{
  const before={...line(),fulfillment_status:"fulfilled"};const after=planLine(before,fact(before,"refunded"));
  assert.deepEqual(after,{authorization_status:"refunded",refunded_quantity:1,authority_fulfillable_quantity:0});
  assert.equal(before.fulfillment_status,"fulfilled");
});
test("cancel-policy refund overlaps cancellation instead of double counting it",()=>{
  const before={...line(),cancelled_quantity:1,authority_fulfillable_quantity:0};
  const evidence={...fact(before,"refunded"),refunds:[{refundId:"r",quantity:1,restockPolicy:"cancel"}]};
  assert.deepEqual(planLine(before,evidence),{authorization_status:"refunded",refunded_quantity:1});
});
test("open, unknown, mismatched and invalid quantity evidence fails closed",()=>{
  const before=line();
  assert.throws(()=>planLine(before,fact(before,"open")));
  assert.throws(()=>planLine(before,fact(before,"unknown")));
  assert.throws(()=>planLine(before,{...fact(before),lineId:"wrong"}));
  assert.throws(()=>planLine(before,{...fact(before),quantity:2}));
  assert.throws(()=>planLine({...before,quantity:-1},fact(before)));
  assert.throws(()=>planLine(before,{...fact(before,"refunded"),refunds:[]}));
});
test("whole proposal preserves the unrelated open order and does not mutate inputs",()=>{
  const {context,facts}=fixture();const before=JSON.stringify({context,facts});const result=buildProposal(context,facts);
  assert.equal(result.lineChanges.length,42);assert.equal(result.orderChanges.length,1);
  assert.equal(result.preserve.openOmsOrderId,"2");assert.equal(result.executable,false);
  assert.equal(JSON.stringify({context,facts}),before);
  assert.deepEqual(result.orderChanges[0].after,{status:"shipped",fulfillment_status:"fulfilled"});
});
test("another open sibling prevents whole-order closure",()=>{
  const {context,facts}=fixture();const sibling=line("55");context.lines.push(sibling);facts.push(fact(sibling,"open"));
  assert.throws(()=>buildProposal(context,facts),/still open or uncertain/);
});
test("missing, duplicate and extra provider lines cannot create partial order coverage",()=>{
  const {context,facts}=fixture();assert.throws(()=>buildProposal(context,facts.slice(1)),/Provider evidence missing/);
  assert.throws(()=>buildProposal(context,[...facts,facts[0]]),/Duplicate provider line/);
  assert.throws(()=>buildProposal(context,[...facts,fact(line("55"))]),/line sets differ/);
});
test("foreign-channel evidence cannot authorize closure",()=>{
  const {context,facts}=fixture();facts[0]={...facts[0],channelId:67};assert.throws(()=>buildProposal(context,facts),/Provider evidence missing/);
});
test("duplicate local external identities cannot hide a missing provider sibling",()=>{
  const {context,facts}=fixture();
  context.lines[1].external_line_item_id=context.lines[0].external_line_item_id;
  assert.throws(()=>buildProposal(context,facts),/Duplicate local external line identity/);
});
test("duplicate refund evidence and mixed fulfilled/refund treatment are rejected",()=>{
  const before={...line(),quantity:2,paid_quantity:2};
  const refund={refundId:"r",quantity:1,restockPolicy:"no_restock"};
  assert.throws(()=>planLine(before,{...fact(before,"refunded"),quantity:2,refunds:[refund,refund]}),/Duplicate provider refund/);
  assert.throws(()=>planLine(line(),{...fact(line()),refunds:[refund]}),/conflicts with refund evidence/);
});
test("preserved open line cannot be added as a target",()=>{
  const {context,facts}=fixture();context.approvedClosedLineIds[0]="119866";
  assert.throws(()=>buildProposal(context,facts),/Open line/);
});
test("existing refund evidence is retained, missing evidence proposed once, conflicting evidence rejected",()=>{
  const {context,facts}=fixture();facts[0]=fact(context.lines[0],"refunded");
  const first=buildProposal(context,facts);assert.equal(first.proposedRefundEvidence.length,1);
  context.adjustments.push({id:"700",order_id:"1",order_line_id:"1",external_line_item_id:"external-1",source:"shopify_webhook",
    source_event_id:"refund-1",adjustment_type:"refund",restock_policy:"no_restock",quantity:1,row_hash:"c".repeat(64)});
  assert.equal(buildProposal(context,facts).proposedRefundEvidence.length,0);
  context.adjustments[0].order_id="2";
  assert.throws(()=>buildProposal(context,facts),/Refund evidence key conflicts/);
  context.adjustments[0].order_id="1";
  context.adjustments[0].quantity=2;assert.throws(()=>buildProposal(context,facts),/separate review/);
});
test("replanning an already-aligned fulfilled scope produces no repeat lifecycle edits",()=>{
  const {context,facts}=fixture();context.orders[0].status="shipped";context.orders[0].fulfillment_status="fulfilled";
  context.lines.filter(l=>l.order_id==="1").forEach(l=>{l.fulfillment_status="fulfilled";});
  const result=buildProposal(context,facts);assert.equal(result.lineChanges.length,0);assert.equal(result.orderChanges.length,0);
});
