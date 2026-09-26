/** Offline proposal only. No database, provider, apply mode or runtime hooks. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { deriveRefundAuthority } from "../server/modules/oms/refund-line-disposition";

const id = z.string().regex(/^[1-9][0-9]*$/);
const quantity = z.number().int().nonnegative().max(2_147_483_647);
const providerId = z.number().int().positive().safe();
const rowHash = z.string().regex(/^[a-f0-9]{64}$/);
const lineSchema = z.object({ id,order_id:id,external_line_item_id:z.string(),quantity,
  paid_quantity:quantity,cancelled_quantity:quantity,refunded_quantity:quantity,authority_fulfillable_quantity:quantity,
  wms_materialized_quantity:quantity,authorization_status:z.string(),fulfillment_status:z.string().nullable(),
  requires_shipping:z.boolean().nullable(),row_hash:rowHash,
});
const orderSchema = z.object({ id,channel_id:z.number().int().positive(),external_order_id:z.string(),
  external_order_number:z.string(),status:z.string(),fulfillment_status:z.string().nullable(),
  financial_status:z.string().nullable(),row_hash:rowHash });
export type LocalLine = z.infer<typeof lineSchema>;
export interface ProviderFact {
  readonly channelId: number; readonly orderId: string; readonly lineId: string;
  readonly quantity: number; readonly outcome: "fulfilled" | "refunded" | "open" | "unknown";
  readonly refunds: readonly { refundId: string; quantity: number; restockPolicy: string }[];
}
const factSchema: z.ZodType<ProviderFact> = z.object({ channelId:z.number().int().positive(),orderId:z.string().min(1),
  lineId:z.string().min(1),quantity,outcome:z.enum(["fulfilled","refunded","open","unknown"]),
  refunds:z.array(z.object({ refundId:z.string().min(1),quantity:quantity.positive(),restockPolicy:z.string().min(1) })),
});
const contextSchema = z.object({ checked_at:z.string(),read_only:z.literal("on"),productionWrites:z.literal(false),
  executable:z.literal(false),approvedClosedLineIds:z.array(id).length(42),preservedOpenLineId:z.literal("119866"),
  orders:z.array(orderSchema).max(100),lines:z.array(lineSchema).max(500),
  adjustments:z.array(z.object({ id,order_id:id,order_line_id:id.nullable(),external_line_item_id:z.string(),
    source:z.string(),source_event_id:z.string(),adjustment_type:z.string(),restock_policy:z.string(),quantity,row_hash:rowHash,
  })).max(1000),
});
function ensure(condition:unknown,message:string):asserts condition { if(!condition) throw new Error(message); }
const key = (channel:number,order:string,line:string):string => `${channel}:${order}:${line}`;
type FieldValue = string | number | null;
interface PlannedChange { table:string;id:string;expectedRowHash:string;before:Record<string,FieldValue>;after:Record<string,FieldValue> }

export function planLine(rawLine:unknown,rawFact:unknown):Record<string,FieldValue> {
  const line=lineSchema.parse(rawLine);const fact=factSchema.parse(rawFact);
  ensure(line.external_line_item_id===fact.lineId&&line.quantity===fact.quantity,"Provider line identity/quantity mismatch");
  ensure(new Set(fact.refunds.map(refund => refund.refundId)).size === fact.refunds.length,
    "Duplicate provider refund evidence for one line");
  if(fact.outcome==="fulfilled") {
    ensure(fact.refunds.length === 0, "Fulfilled-only treatment conflicts with refund evidence");
    return line.fulfillment_status==="fulfilled"?{}:{fulfillment_status:"fulfilled"};
  }
  ensure(fact.outcome==="refunded","Open or uncertain provider lines cannot be closed");
  const refundQuantity=fact.refunds.reduce((sum,r)=>sum+r.quantity,0);
  ensure(refundQuantity===line.quantity&&line.paid_quantity===line.quantity,"Exact fully paid/refunded line required");
  ensure(line.refunded_quantity<=refundQuantity,"Existing refund quantity exceeds provider evidence");
  const disposition=deriveRefundAuthority({ paidQuantity:line.paid_quantity,
    previousAuthorityFulfillableQuantity:line.authority_fulfillable_quantity,cancelledQuantity:line.cancelled_quantity,
    refundCancelQuantity:fact.refunds.filter(r=>r.restockPolicy==="cancel").reduce((sum,r)=>sum+r.quantity,0),
    refundOtherQuantity:fact.refunds.filter(r=>r.restockPolicy!=="cancel").reduce((sum,r)=>sum+r.quantity,0) });
  ensure(disposition.overDispositionQuantity===0&&disposition.authorizationStatus==="refunded","Refund disposition requires review");
  // A refund does not prove or erase past physical fulfillment. Keep that field,
  // cancellation/paid quantities and every WMS/shipment/inventory field unchanged.
  const values={authorization_status:disposition.authorizationStatus,refunded_quantity:disposition.refundedQuantity,
    authority_fulfillable_quantity:disposition.authorityFulfillableQuantity};
  return Object.fromEntries(Object.entries(values).filter(([field,value])=>line[field as keyof LocalLine]!==value));
}

export function buildProposal(rawContext:unknown,rawFacts:unknown) {
  const context=contextSchema.parse(rawContext);const facts=z.array(factSchema).parse(rawFacts);
  ensure(new Set(context.approvedClosedLineIds).size===42,"Duplicate approved target");
  ensure(!context.approvedClosedLineIds.includes(context.preservedOpenLineId),"Open line is not an approved closure target");
  ensure(new Set(context.lines.map(l=>l.id)).size===context.lines.length,"Duplicate local line");
  ensure(new Set(context.lines.map(line => `${line.order_id}:${line.external_line_item_id}`)).size === context.lines.length,
    "Duplicate local external line identity");
  ensure(new Set(context.orders.map(o=>o.id)).size===context.orders.length,"Duplicate local order");
  const factMap=new Map<string,ProviderFact>();
  for(const fact of facts) { const k=key(fact.channelId,fact.orderId,fact.lineId);ensure(!factMap.has(k),"Duplicate provider line");factMap.set(k,fact); }
  const lineChanges:PlannedChange[]=[];const orderChanges:PlannedChange[]=[];
  const proposedRefundEvidence:Record<string,unknown>[]=[];
  const targets=context.lines.filter(l=>context.approvedClosedLineIds.includes(l.id));
  ensure(targets.length===42,"Approved line missing");
  const targetOrderIds=[...new Set(targets.map(l=>l.order_id))];
  const outcomeCounts={fulfilled:0,refunded:0};
  for(const line of targets) {
    const order=context.orders.find(o=>o.id===line.order_id);ensure(order,"Target order missing");
    const fact=factMap.get(key(order.channel_id,order.external_order_id,line.external_line_item_id));ensure(fact,"Provider evidence missing");
    const after=planLine(line,fact);
    if(Object.keys(after).length) lineChanges.push({table:"oms.oms_order_lines",id:line.id,expectedRowHash:line.row_hash,
      before:Object.fromEntries(Object.keys(after).map(field=>[field,line[field as keyof LocalLine] as FieldValue])),after});
    ensure(fact.outcome==="fulfilled"||fact.outcome==="refunded","Target outcome not terminal");outcomeCounts[fact.outcome]++;
    if(fact.outcome==="refunded") {
      const existing=context.adjustments.filter(a=>a.order_line_id===line.id);
      for(const adjustment of existing) ensure(adjustment.adjustment_type==="refund"&&adjustment.source==="shopify_webhook"
        &&fact.refunds.some(r=>r.refundId===adjustment.source_event_id&&r.quantity===adjustment.quantity&&r.restockPolicy===adjustment.restock_policy),
        "Existing refund/cancellation evidence needs separate review");
      for(const refund of fact.refunds) {
        const sameKey=context.adjustments.filter(a=>a.source==="shopify_webhook"&&a.source_event_id===refund.refundId
          &&a.external_line_item_id===fact.lineId&&a.adjustment_type==="refund");
        ensure(sameKey.length<=1,"Duplicate refund evidence key");
        if(sameKey.length) ensure(sameKey[0].order_id===line.order_id&&sameKey[0].order_line_id===line.id&&sameKey[0].quantity===refund.quantity
          &&sameKey[0].restock_policy===refund.restockPolicy,"Refund evidence key conflicts");
        else proposedRefundEvidence.push({table:"oms.order_line_adjustments",orderId:line.order_id,orderLineId:line.id,
          externalLineItemId:fact.lineId,source:"shopify_webhook",sourceEventId:refund.refundId,adjustmentType:"refund",
          restockPolicy:refund.restockPolicy,quantity:refund.quantity,
          provenance:"Owner-approved provider readback; records an already-issued refund, does not issue or restock it"});
      }
    }
  }
  const orderChecks:Record<string,unknown>[]=[];
  for(const orderId of targetOrderIds) {
    const order=context.orders.find(o=>o.id===orderId)!;
    const allLines=context.lines.filter(l=>l.order_id===orderId);
    const orderFacts=facts.filter(f=>f.channelId===order.channel_id&&f.orderId===order.external_order_id);
    ensure(allLines.length===orderFacts.length,"Complete local/provider order line sets differ");
    const closedFacts=allLines.map(line=>{
      const fact=factMap.get(key(order.channel_id,order.external_order_id,line.external_line_item_id));
      ensure(fact&&fact.quantity===line.quantity,"Sibling provider identity/quantity mismatch");
      ensure(fact.outcome==="fulfilled"||fact.outcome==="refunded","Another line on this order is still open or uncertain");
      return fact;
    });
    const allRefunded=closedFacts.every(f=>f.outcome==="refunded");
    ensure(order.status!=="cancelled","Cancelled order is not a closure target");
    if(allRefunded) ensure(order.financial_status==="refunded","Fully refunded header requires existing financial confirmation");
    else ensure(order.financial_status==="paid"||order.financial_status==="partially_refunded","Shipped closure financial state requires review");
    // Do not invent shipped_at, tracking, carrier possession, payment/refund totals
    // or package rows. This is the internal OMS lifecycle, not a provider command.
    const desired:Record<string,FieldValue>=allRefunded?{status:"refunded"}:{status:"shipped",fulfillment_status:"fulfilled"};
    const after=Object.fromEntries(Object.entries(desired).filter(([field,value])=>order[field as keyof typeof order]!==value));
    if(Object.keys(after).length) orderChanges.push({table:"oms.oms_orders",id:orderId,expectedRowHash:order.row_hash,
      before:Object.fromEntries(Object.keys(after).map(field=>[field,order[field as keyof typeof order] as FieldValue])),after});
    orderChecks.push({omsOrderId:orderId,externalOrderNumber:order.external_order_number,allLines:allLines.length,
      reviewedTargetLines:targets.filter(l=>l.order_id===orderId).length,providerClosed:true,allRefunded});
  }
  const protectedOpenOrder=context.lines.find(l=>l.id===context.preservedOpenLineId)?.order_id;
  ensure(protectedOpenOrder&&!targetOrderIds.includes(protectedOpenOrder),"Open order included in closure scope");
  return {contractVersion:1,executable:false,productionWrites:false,providerWrites:false,
    basedOnDatabaseCapture:context.checked_at,approvedTargetLineIds:context.approvedClosedLineIds,outcomeCounts,
    lineChanges,orderChanges,proposedRefundEvidence,orderChecks,
    preserve:{openOmsOrderId:protectedOpenOrder,openLineId:context.preservedOpenLineId,
      otherLines:context.lines.filter(l=>!context.approvedClosedLineIds.includes(l.id)).map(l=>({id:l.id,rowHash:l.row_hash})),
      inventory:"All physical quantities, lots, reservations, costs and journals unchanged",
      shipping:"All WMS items, shipment/package records, labels and provider commands unchanged",
      financial:"No payment, price, financial-status or monetary-total changes; no new refund issued",
      fulfillmentAuthority:"Paid/fulfilled commercial quantities remain unchanged; only proven refunded line disposition is aligned"},
    requiredExecutionChecks:["Fresh provider and locked local evidence with exact before/after fingerprints",
      "Durable idempotency/audit records and serializable all-or-nothing transaction",
      "Append authority audit for refunded state changes; retain existing evidence",
      "Rehearse database triggers, rollback and retry in disposable PostgreSQL before production apply",
      "Deploy and verify preservation of refunded/cancelled/review disposition across non-authorizing order updates",
      "Preserve normal internal intake/Archon outbox updates; prove no inventory/shipping/provider command writes",
      "Receipt/review dispositions and #63534 identity repair are separate, not silently cleared here"]};
}

export function readInputs() {
  const directory=resolve("artifacts/inventory-cutover-20260924");
  const sources={
    context:{file:"records-context-2026-09-25T20-53-00-052Z.json",sha256:"7a96856b1bb039a279005c21cf1ae97cb2419b597023bcb5bf8e26509b4d5ef4"},
    shopify:{file:"shopify-lifecycle-review-2026-09-25T19-00-05-705Z.json",sha256:"73c77479dc2822cdc5f61524dfa9cda6f0beb2fb98d9812386803940bc33af4d"},
    marketplace:{file:"marketplace-lifecycle-review-2026-09-25T19-29-48-107Z.json",sha256:"99ae48ef8a370f670aa08aff72bb0a6e9213f3792c27ca20a11ee51bba32424d"},
  };
  const read=(source:{file:string;sha256:string}):unknown=>{const raw=readFileSync(resolve(directory,source.file),"utf8");
    ensure(createHash("sha256").update(raw).digest("hex")===source.sha256,"Source hash changed: "+source.file);return JSON.parse(raw);};
  const context=read(sources.context);
  const shopify=z.object({complete:z.literal(true),errors:z.array(z.unknown()).length(0),orders:z.array(z.object({order:z.object({id:providerId,
    line_items:z.array(z.object({id:providerId,quantity,current_quantity:quantity,fulfillable_quantity:quantity,fulfillment_status:z.string().nullable()})),
    fulfillments:z.array(z.object({status:z.string(),line_items:z.array(z.object({id:providerId,quantity}))})),
    refunds:z.array(z.object({id:providerId,refund_line_items:z.array(z.object({line_item_id:providerId,quantity,restock_type:z.string()})),
      transactions:z.array(z.object({kind:z.string(),status:z.string()}))})),
  })}))}).parse(read(sources.shopify));
  const facts:ProviderFact[]=[];
  for(const {order} of shopify.orders) for(const line of order.line_items) {
    const refunds=order.refunds.flatMap(r=>r.refund_line_items.filter(l=>l.line_item_id===line.id).map(l=>({refundId:String(r.id),
      quantity:l.quantity,restockPolicy:l.restock_type,successful:r.transactions.some(t=>t.kind==="refund"&&t.status==="success")})));
    const refundQty=refunds.reduce((sum,r)=>sum+r.quantity,0);
    const shipped=order.fulfillments.filter(f=>f.status==="success").flatMap(f=>f.line_items).filter(l=>l.id===line.id).reduce((sum,l)=>sum+l.quantity,0);
    const outcome=line.fulfillment_status==="fulfilled"&&line.fulfillable_quantity===0&&line.current_quantity===line.quantity
      &&shipped===line.quantity&&refundQty===0?"fulfilled":line.current_quantity===0&&line.fulfillable_quantity===0
      &&shipped===0&&refundQty===line.quantity&&refunds.every(r=>r.successful)?"refunded":line.fulfillable_quantity>0?"open":"unknown";
    facts.push({channelId:36,orderId:String(order.id),lineId:String(line.id),quantity:line.quantity,outcome,refunds});
  }
  const walmartLineSchema = z.object({
    lineNumber: z.string(),
    refund: z.boolean(),
    orderLineQuantity: z.object({ amount: quantity }),
    orderLineStatuses: z.object({
      orderLineStatus: z.array(z.object({
        status: z.string(),
        statusQuantity: z.object({ amount: quantity }),
      })),
    }),
  });
  const marketplace=z.object({complete:z.literal(true),errors:z.array(z.unknown()).length(0),
    ebayOrders:z.array(z.object({order:z.object({orderId:z.string(),orderPaymentStatus:z.string(),cancelStatus:z.object({cancelState:z.string()}).optional(),
      lineItems:z.array(z.object({lineItemId:z.string(),quantity,lineItemFulfillmentStatus:z.string()}))})})),
    walmartOrder: z.object({ purchaseOrderId: z.string(), orderLines: z.object({ orderLine: z.array(walmartLineSchema) }) }),
  }).parse(read(sources.marketplace));
  for(const {order} of marketplace.ebayOrders) for(const line of order.lineItems) facts.push({channelId:67,orderId:order.orderId,lineId:line.lineItemId,
    quantity:line.quantity,outcome:line.lineItemFulfillmentStatus==="FULFILLED"&&order.orderPaymentStatus==="PAID"
      &&order.cancelStatus?.cancelState==="NONE_REQUESTED"?"fulfilled":"unknown",refunds:[]});
  const walmart=marketplace.walmartOrder;
  for(const line of walmart.orderLines.orderLine) facts.push({channelId:104,orderId:walmart.purchaseOrderId,lineId:line.lineNumber,
    quantity:line.orderLineQuantity.amount,outcome:!line.refund&&line.orderLineStatuses.orderLineStatus.every(s=>["Shipped","Delivered"].includes(s.status))
      &&line.orderLineStatuses.orderLineStatus.reduce((sum,s)=>sum+s.statusQuantity.amount,0)===line.orderLineQuantity.amount?"fulfilled":"unknown",refunds:[]});
  return {sources,context,facts};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const {sources,context,facts}=readInputs();const proposal={...buildProposal(context,facts),sources};
  const content=JSON.stringify(proposal,null,2)+"\n";
  const file=resolve("artifacts/inventory-cutover-20260924","records-proposal-"+new Date().toISOString().replace(/[:.]/g,"-")+".json");
  writeFileSync(file,content,{flag:"wx"});
  console.log(JSON.stringify({file,sha256:createHash("sha256").update(content).digest("hex"),targets:proposal.approvedTargetLineIds.length,
    lineChanges:proposal.lineChanges.length,orderChanges:proposal.orderChanges.length,refundEvidenceInserts:proposal.proposedRefundEvidence.length,
    outcomes:proposal.outcomeCounts,executable:proposal.executable,productionWrites:false}));
}
