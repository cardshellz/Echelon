import { z } from "zod";
import { orderEditOrderSchema } from "../order-edits/order-edit.contract";
import { customerReturnCustomerOrderSchema } from "../returns/customer-return-access.contract";
import { customerAccountOrderIdentityInputSchema } from "./customer-account.contract";
import { CUSTOMER_ACCOUNT_ORDER_PAGE_SIZE } from "./customer-account-orders";

/** Legacy OMS imports omitted Shopify's display '#'. The separately verified
 * external order ID remains the identity; this only compares display references. */
export function customerOrderActionReferenceKey(reference: string): string {
  return reference.replace(/^#/, "");
}

/** Presentation evidence only. Never accepted as authorization by a command. */
export const customerOrderActionSnapshotSchema = z.object({
  order: orderEditOrderSchema.nullable(),
  returnOrder: customerReturnCustomerOrderSchema.nullable(),
  orderFailed: z.boolean(),
  returnFailed: z.boolean(),
}).strict();
export type CustomerOrderActionSnapshot = z.infer<typeof customerOrderActionSnapshotSchema>;

export const customerOrderActionsSchema = customerAccountOrderIdentityInputSchema.extend({
  omsOrderId: z.number().int().positive().safe().nullable(),
  state: z.enum(["ready", "refreshing", "failed", "not_managed"]),
  verifiedAt: z.string().datetime().nullable(),
  validUntil: z.string().datetime().nullable(),
  snapshot: customerOrderActionSnapshotSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.state === "ready") !== (value.snapshot !== null))
    ctx.addIssue({ code: "custom", message: "Only current action evidence may be displayed." });
  if (value.snapshot && (value.omsOrderId === null || !value.verifiedAt || !value.validUntil
    || (value.snapshot.order && (value.snapshot.order.omsOrderId !== value.omsOrderId
      || customerOrderActionReferenceKey(value.snapshot.order.orderNumber) !== customerOrderActionReferenceKey(value.orderReference)))
    || (value.snapshot.returnOrder && (value.snapshot.returnOrder.omsOrderId !== value.omsOrderId
      || customerOrderActionReferenceKey(value.snapshot.returnOrder.order.orderReference) !== customerOrderActionReferenceKey(value.orderReference)))
    || (value.verifiedAt && value.validUntil && Date.parse(value.validUntil) <= Date.parse(value.verifiedAt))))
    ctx.addIssue({ code: "custom", message: "Action evidence does not match the requested order." });
  const order = value.snapshot?.order;
  if (order?.financials && order.financials.totalCents !== order.totalCents)
    ctx.addIssue({ code: "custom", message: "Cached action financial evidence must balance." });
});
export type CustomerOrderActions = z.infer<typeof customerOrderActionsSchema>;
export const customerOrderActionPageSchema = z.object({
  orders: z.array(customerOrderActionsSchema).max(CUSTOMER_ACCOUNT_ORDER_PAGE_SIZE),
}).strict().superRefine(({ orders }, ctx) => {
  if (new Set(orders.map(row => row.externalOrderId)).size !== orders.length)
    ctx.addIssue({ code: "custom", message: "Duplicate action identities." });
});
export type CustomerOrderActionPage = z.infer<typeof customerOrderActionPageSchema>;
