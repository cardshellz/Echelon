import { z } from "zod";
import { orderEditShippingRepricingSchema } from "./order-edit-shipping";
import {
  orderEditFinancialsSchema,
  orderEditSettlementSchema,
} from "./order-edit-financials";

export const ORDER_EDIT_API = "/api/order-edits/admin";
export const ORDER_EDIT_PAGE = "/order-edits";
// Operational input bound; the merchant must explicitly choose the payment window.
export const MAX_ORDER_EDIT_PAYMENT_WINDOW_MINUTES = 7 * 24 * 60;
const id = z.number().int().positive().safe();
const money = z.number().int().nonnegative().safe();
export const orderEditStatusSchema = z.enum([
  "preparing",
  "ready",
  "committing",
  "awaiting_payment",
  "refunding",
  "synchronizing",
  "recovering",
  "completed",
  "recovered",
  "review_required",
  "failed",
  "expired",
]);
export const orderEditConnectionSchema = z
  .object({
    connectionId: id,
    channelId: id,
    name: z.string(),
    shopDomain: z.string(),
    paymentWindowMinutes: z
      .number()
      .int()
      .min(1)
      .max(MAX_ORDER_EDIT_PAYMENT_WINDOW_MINUTES)
      .nullable(),
    enabled: z.boolean(),
  })
  .strict();
export const orderEditStateSchema = z
  .object({
    connections: z.array(orderEditConnectionSchema),
    customerAccess: z.literal(false),
  })
  .strict();
export const orderEditSettingsInputSchema = z
  .object({
    paymentWindowMinutes: z
      .number()
      .int()
      .min(1)
      .max(MAX_ORDER_EDIT_PAYMENT_WINDOW_MINUTES),
    enabled: z.boolean(),
  })
  .strict();
export const orderEditOrderSummarySchema = z
  .object({
    omsOrderId: id,
    orderNumber: z.string(),
    customerName: z.string(),
    customerEmail: z.string().nullable(),
    activeOperationId: z.string().uuid().nullable(),
  })
  .strict();
export const orderEditOrdersSchema = z
  .object({ orders: z.array(orderEditOrderSummarySchema).max(50) })
  .strict();
export const orderEditLineSchema = z
  .object({
    lineItemId: z.string().regex(/^gid:\/\/shopify\/LineItem\/\d+$/),
    variantId: z.string().nullable(),
    title: z.string(),
    variantTitle: z.string().nullable(),
    sku: z.string().nullable(),
    quantity: z.number().int().nonnegative().safe(),
    unitPriceCents: money,
    totalCents: money,
  })
  .strict();
export const orderEditOrderSchema = orderEditOrderSummarySchema
  .extend({
    connectionId: id,
    currency: z.literal("USD"),
    revision: z.string().min(1),
    eligibility: z
      .object({ editable: z.boolean(), reasons: z.array(z.string()) })
      .strict(),
    lines: z.array(orderEditLineSchema).max(100),
    totalCents: money,
    financialStatus: z.string(),
    warehouseStatus: z.string(),
    financials: orderEditFinancialsSchema.optional(),
    settlement: orderEditSettlementSchema.optional(),
  })
  .strict();
export const orderEditVariantSchema = z
  .object({
    variantId: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/),
    title: z.string(),
    variantTitle: z.string().nullable(),
    sku: z.string().nullable(),
    priceCents: money,
    available: z.boolean(),
  })
  .strict();
export const orderEditVariantsSchema = z
  .object({ variants: z.array(orderEditVariantSchema).max(50) })
  .strict();
export const orderEditQuoteInputSchema = z
  .object({
    connectionId: id,
    omsOrderId: id,
    expectedRevision: z.string().min(1).max(200),
    requestKey: z.string().uuid(),
    changes: z
      .array(
        z
          .object({
            lineItemId: z.string().regex(/^gid:\/\/shopify\/LineItem\/\d+$/),
            quantity: z.number().int().min(0).max(10000),
          })
          .strict(),
      )
      .max(100),
    additions: z
      .array(
        z
          .object({
            variantId: z
              .string()
              .regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/),
            quantity: z.number().int().min(1).max(10000),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine(validateOrderEditPlan);

// Read-only previews and financial quotes validate the same commercial plan.
export const orderEditPlanInputSchema = orderEditQuoteInputSchema
  .innerType()
  .pick({ changes: true, additions: true })
  .superRefine(validateOrderEditPlan);

function validateOrderEditPlan(
  input: {
    changes: Array<{ lineItemId: string }>;
    additions: Array<{ variantId: string }>;
  },
  context: z.RefinementCtx,
): void {
  if (input.changes.length + input.additions.length === 0)
    context.addIssue({
      code: "custom",
      message: "Choose at least one change.",
    });
  for (const [values, field] of [
    [input.changes.map((line) => line.lineItemId), "changes"],
    [input.additions.map((line) => line.variantId), "additions"],
  ] as const) {
    if (new Set(values).size !== values.length)
      context.addIssue({
        code: "custom",
        path: [field],
        message: "Duplicate line identifiers are not allowed.",
      });
  }
}
export const orderEditOperationSchema = z
  .object({
    shippingRepricing: orderEditShippingRepricingSchema.nullable().optional(),
    operationId: z.string().uuid(),
    orderNumber: z.string(),
    currency: z.literal("USD"),
    canAbandon: z.boolean(),
    previousTotalCents: money,
    updatedTotalCents: money,
    quoteAvailable: z.boolean().optional(),
    balanceDueCents: money,
    refundDueCents: money,
    financials: z
      .object({
        before: orderEditFinancialsSchema.nullable(),
        quoted: orderEditFinancialsSchema.nullable(),
        current: orderEditFinancialsSchema.nullable(),
      })
      .strict()
      .optional(),
    settlement: orderEditSettlementSchema.optional(),
    lines: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          variantTitle: z.string().nullable(),
          quantity: z.number().int().nonnegative(),
          totalCents: money,
        })
        .strict(),
    ),
    warnings: z.array(z.string()),
    expiresAt: z.string().datetime().nullable(),
    paymentDeadline: z.string().datetime().nullable(),
    status: orderEditStatusSchema,
    paymentUrl: z.string().url().nullable(),
    error: z
      .object({ code: z.string(), message: z.string() })
      .strict()
      .nullable(),
  })
  .strict();
export type OrderEditStatus = z.infer<typeof orderEditStatusSchema>;
export type OrderEditConnection = z.infer<typeof orderEditConnectionSchema>;
export type OrderEditState = z.infer<typeof orderEditStateSchema>;
export type OrderEditSettingsInput = z.infer<
  typeof orderEditSettingsInputSchema
>;
export type OrderEditOrder = z.infer<typeof orderEditOrderSchema>;
export type OrderEditVariant = z.infer<typeof orderEditVariantSchema>;
export type OrderEditQuoteInput = z.infer<typeof orderEditQuoteInputSchema>;
export type OrderEditOperation = z.infer<typeof orderEditOperationSchema>;
