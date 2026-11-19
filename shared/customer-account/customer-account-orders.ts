import { z } from "zod";
import { customerOrderProgressSchema } from "./order-progress";
import { customerAccountOrderIdentityInputSchema } from "./customer-account.contract";
import { customerOrderFulfillmentSchema } from "./order-fulfillment";
import { orderEditLineSchema } from "../order-edits/order-edit.contract";
import { orderEditFinancialsSchema } from "../order-edits/order-edit-financials";

// Matches the theme's order-history page size. One provider query per page,
// without importing historical orders into OMS just to display their totals.
export const CUSTOMER_ACCOUNT_ORDER_PAGE_SIZE = 20;
const externalId =
  customerAccountOrderIdentityInputSchema.shape.externalOrderId;
export const customerAccountOrderSummariesInputSchema = z
  .object({
    orders: z
      .array(customerAccountOrderIdentityInputSchema)
      .min(1)
      .max(CUSTOMER_ACCOUNT_ORDER_PAGE_SIZE),
  })
  .strict()
  .superRefine(({ orders }, context) => {
    if (
      new Set(orders.map((order) => order.externalOrderId)).size !==
      orders.length
    )
      context.addIssue({
        code: "custom",
        message: "Duplicate order identities are not allowed.",
      });
  });
export const customerAccountOrderSummarySchema =
  customerAccountOrderIdentityInputSchema
    .extend({
      omsOrderId: z.number().int().positive().safe().nullable(),
      currency: z.literal("USD"),
      totalCents: z.number().int().nonnegative().safe(),
      financialStatus: z.string().min(1).max(80),
      cancelled: z.boolean(),
      fulfillment: customerOrderFulfillmentSchema.optional(),
      progress: customerOrderProgressSchema.nullable().optional(),
    })
    .strict();
export const customerAccountOrderSummariesSchema = z
  .object({
    orders: z
      .array(customerAccountOrderSummarySchema)
      .max(CUSTOMER_ACCOUNT_ORDER_PAGE_SIZE),
    unavailableExternalOrderIds: z
      .array(externalId)
      .max(CUSTOMER_ACCOUNT_ORDER_PAGE_SIZE),
    statusUnavailable: z.boolean(),
  })
  .strict()
  .superRefine((result, context) => {
    const ids = [
      ...result.orders.map((order) => order.externalOrderId),
      ...result.unavailableExternalOrderIds,
    ];
    if (new Set(ids).size !== ids.length)
      context.addIssue({
        code: "custom",
        message: "An order must have exactly one lookup result.",
      });
  });
export const customerAccountOrderDetailsSchema =
  customerAccountOrderIdentityInputSchema
    .extend({
      currency: z.literal("USD"),
      totalCents: z.number().int().nonnegative().safe(),
      lines: z.array(orderEditLineSchema).max(100),
      financials: orderEditFinancialsSchema.optional(),
    })
    .strict()
    .superRefine((order, context) => {
      if (order.financials && order.financials.totalCents !== order.totalCents)
        context.addIssue({
          code: "custom",
          message:
            "The financial breakdown must match the current order total.",
        });
    });
export type CustomerAccountOrderSummary = z.infer<
  typeof customerAccountOrderSummarySchema
>;
export type CustomerAccountOrderDetails = z.infer<
  typeof customerAccountOrderDetailsSchema
>;
export type CustomerAccountOrderSummariesInput = z.infer<
  typeof customerAccountOrderSummariesInputSchema
>;
export type CustomerAccountOrderSummaries = z.infer<
  typeof customerAccountOrderSummariesSchema
>;
