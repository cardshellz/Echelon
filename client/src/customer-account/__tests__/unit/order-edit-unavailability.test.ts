import { describe, expect, it } from "vitest";
import { customerOrderEditUnavailable, customerOrderShippingCutoff } from "../../order-edit-unavailability";
import { orderEditOperationSchema } from "@shared/order-edits/order-edit.contract";

const operation = orderEditOperationSchema.parse({
  operationId:"22222222-2222-4222-8222-222222222222",orderNumber:"#TEST",currency:"USD",
  previousTotalCents:1000,updatedTotalCents:1500,balanceDueCents:500,refundDueCents:0,
  lines:[],warnings:[],canAbandon:true,status:"review_required",expiresAt:null,paymentDeadline:null,paymentUrl:null,
  error:{code:"ORDER_EDIT_PROVIDER_NOT_EDITABLE",message:"Internal provider description"},
});
describe("customer order-edit cutoffs", () => {
  it.each(["ORDER_EDIT_PROVIDER_NOT_EDITABLE","ORDER_EDIT_PROVIDER_LABEL_EXISTS","ORDER_EDIT_SHIPMENT_NOT_EDITABLE","ORDER_EDIT_PICKING_CUTOFF","ORDER_EDIT_INELIGIBLE","ORDER_EDIT_SHIPMENT_CHANGED","ORDER_EDIT_PROVIDER_IDENTITY_UNVERIFIED","ORDER_EDIT_HELD_PARTITION_UNVERIFIED","ORDER_EDIT_PROVIDER_SPLIT_UNVERIFIED"])(
    "does not offer Apply again after a proven unsubmitted %s", code => {
      expect(customerOrderEditUnavailable({...operation,error:{code,message:"Internal"}})).toBe(true);
    },
  );
  it("shipping facts override stale editable warehouse state, but a manual hold is still editable", () => {
    expect(customerOrderShippingCutoff({fulfillment:{code:"shipped",label:"Shipped"}})).toBe(true);
    expect(customerOrderShippingCutoff({nativeFulfillment:"fulfilled",fulfillment:{code:"awaiting_picking",label:"Awaiting picking"}})).toBe(true);
    expect(customerOrderShippingCutoff({fulfillment:{code:"on_hold",label:"On hold"}})).toBe(false);
    expect(customerOrderShippingCutoff({})).toBe(false);
  });
  it("never converts uncertain/submitted processing into a harmless cutoff", () => {
    expect(customerOrderEditUnavailable({...operation,canAbandon:false})).toBe(false);
    expect(customerOrderEditUnavailable({...operation,commandInProgress:true})).toBe(false);
    expect(customerOrderEditUnavailable({...operation,status:"committing"})).toBe(false);
  });
  it("preserves transient failures and changed quotes for their existing retry paths", () => {
    expect(customerOrderEditUnavailable({...operation,error:{code:"ORDER_EDIT_UNAVAILABLE",message:"Retry"}})).toBe(false);
    expect(customerOrderEditUnavailable({...operation,error:{code:"ORDER_EDIT_STALE_QUOTE",message:"Review"}})).toBe(false);
    expect(customerOrderEditUnavailable(null)).toBe(false);
  });
});
