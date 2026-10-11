import { z } from "zod";
import {
  orderEditPlanInputSchema,
  orderEditQuoteInputSchema,
} from "./order-edit.contract";
import { orderEditFinancialsSchema } from "./order-edit-financials";
import { orderEditShippingRepricingSchema } from "./order-edit-shipping";

// A preview is an expiring calculation, never a command or an authority to apply an edit.
export const ORDER_EDIT_PREVIEW_DEBOUNCE_MS = 400;
export const ORDER_EDIT_PREVIEW_TTL_MS = 60_000;
export const orderEditPreviewScopeSchema = orderEditQuoteInputSchema
  .innerType()
  .pick({ connectionId: true, omsOrderId: true, expectedRevision: true });
export const orderEditPreviewInputSchema = orderEditQuoteInputSchema
  .innerType()
  .omit({ requestKey: true })
  .superRefine((input, context) => {
    const checked = orderEditPlanInputSchema.safeParse({
      changes: input.changes,
      additions: input.additions,
    });
    if (!checked.success)
      for (const issue of checked.error.issues) context.addIssue(issue);
  });
export const orderEditPreviewWarmSchema = z
  .object({
    scope: orderEditPreviewScopeSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();
export const orderEditPreviewSchema = z
  .object({
    phase: z.literal("preview"),
    input: orderEditPreviewInputSchema,
    calculatedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    financials: orderEditFinancialsSchema,
    shippingRepricing: orderEditShippingRepricingSchema,
    lines: z
      .array(
        z
          .object({
            id: z.string().min(1),
            variantId: z
              .string()
              .regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/)
              .nullable()
              .optional(),
            added: z.boolean().optional(),
            title: z.string().min(1),
            variantTitle: z.string().nullable(),
            quantity: z.number().int().positive().safe(),
            totalCents: z.number().int().nonnegative().safe(),
          })
          .strict(),
      )
      .min(1)
      .max(250),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      Date.parse(value.expiresAt) <= Date.parse(value.calculatedAt) ||
      new Set(value.lines.map((line) => line.id)).size !== value.lines.length ||
      value.lines.length !== value.financials.lines.length ||
      value.lines.some(
        (line) =>
          value.financials.lines.find((item) => item.id === line.id)
            ?.netCents !== line.totalCents,
      ) ||
      value.financials.shippingCents !== value.shippingRepricing.netCents
    )
      context.addIssue({
        code: "custom",
        message: "The preview identity, expiry or amounts do not reconcile.",
      });
  });
export type OrderEditPreviewScope = z.infer<typeof orderEditPreviewScopeSchema>;
export type OrderEditPreviewInput = z.infer<typeof orderEditPreviewInputSchema>;
export type OrderEditPreview = z.infer<typeof orderEditPreviewSchema>;
