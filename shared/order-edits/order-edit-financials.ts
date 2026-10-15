import { z } from "zod";
import { orderEditDiscountSchema } from "./order-edit-discounts";
import { orderEditTaxLineSchema } from "./order-edit-taxes";

export const ORDER_EDIT_PRICING_DISPLAY_HEADER = "X-Order-Edit-Pricing-Display";
export const ORDER_EDIT_PRICING_DISPLAY_VERSION = "v2";
export const orderEditPricingDisplayVersionSchema = z.enum(["v1", "v2"]);
export type OrderEditPricingDisplayVersion = z.infer<
  typeof orderEditPricingDisplayVersionSchema
>;

const cents = z.number().int().safe().nonnegative();
const label = z.string().trim().min(1).max(500);

export const orderEditFinancialsSchema = z
  .object({
    itemsGrossCents: cents,
    itemsDiscountCents: cents,
    itemsNetCents: cents,
    itemDiscountLabels: z.array(label).max(250),
    // Optional so saved operations retain their original financial proof shape.
    itemDiscounts: z.array(orderEditDiscountSchema).max(250).optional(),
    // Response-only presentation: order coupons are separate from product/member prices.
    // Omitted for older evidence that cannot prove this distinction.
    orderDiscounts: z.array(orderEditDiscountSchema).max(250).optional(),
    shippingGrossCents: cents,
    shippingDiscountCents: cents,
    shippingCents: cents,
    shippingDiscountLabels: z.array(label).max(250),
    taxCents: cents,
    // Optional display evidence; older saved edits do not contain tax rates.
    taxLines: z.array(orderEditTaxLineSchema).max(250).optional(),
    taxesIncluded: z.boolean(),
    totalCents: cents,
    lines: z
      .array(
        z
          .object({
            id: z.string().min(1),
            grossCents: cents,
            discountCents: cents,
            netCents: cents,
            productNetCents: cents.optional(),
          })
          .strict(),
      )
      .max(250),
  })
  .strict()
  .superRefine((value, context) => {
    // Zod still runs refinements after a number constraint fails; do not feed fractional amounts to BigInt.
    const amounts = [
      value.itemsGrossCents,
      value.itemsDiscountCents,
      value.itemsNetCents,
      value.shippingGrossCents,
      value.shippingDiscountCents,
      value.shippingCents,
      value.taxCents,
      value.totalCents,
      ...(value.taxLines?.map((line) => line.amountCents) ?? []),
      ...value.lines.flatMap((line) => [
        line.grossCents,
        line.discountCents,
        line.netCents,
        ...(line.productNetCents === undefined ? [] : [line.productNetCents]),
      ]),
    ];
    if (amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0))
      return;
    const sum = (values: number[]) =>
      values.reduce((total, amount) => total + BigInt(amount), BigInt(0));
    if (
      value.taxLines !== undefined &&
      sum(value.taxLines.map((line) => line.amountCents)) !== BigInt(value.taxCents)
    ) {
      context.addIssue({
        code: "custom",
        message: "The tax lines do not reconcile to the tax total.",
      });
    }
    if (value.orderDiscounts !== undefined) {
      if (
        value.orderDiscounts.some(
          (discount) => !Number.isSafeInteger(discount.amountCents),
        ) ||
        new Set(value.orderDiscounts.map((discount) => discount.key)).size !==
          value.orderDiscounts.length ||
        value.lines.some(
          (line) =>
            line.productNetCents === undefined ||
            line.productNetCents < line.netCents ||
            line.productNetCents > line.grossCents,
        ) ||
        value.orderDiscounts.some(
          (discount) =>
            !value.itemDiscounts?.some(
              (item) =>
                item.key === discount.key &&
                item.label === discount.label &&
                item.amountCents === discount.amountCents &&
                JSON.stringify(item.value) === JSON.stringify(discount.value),
            ),
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "The order discount presentation is incomplete or inconsistent.",
        });
      } else if (
        sum(value.lines.map((line) => line.productNetCents!)) -
          BigInt(value.itemsNetCents) !==
        sum(value.orderDiscounts.map((discount) => discount.amountCents))
      ) {
        context.addIssue({
          code: "custom",
          message: "The item subtotals and order discounts do not reconcile.",
        });
      }
    } else if (value.lines.some((line) => line.productNetCents !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Item subtotals require their order discount breakdown.",
      });
    }
    if (
      new Set(value.lines.map((line) => line.id)).size !== value.lines.length ||
      (value.itemDiscounts !== undefined &&
        (new Set(value.itemDiscounts.map((discount) => discount.key)).size !==
          value.itemDiscounts.length ||
          value.itemDiscounts.some(
            (discount) => !Number.isSafeInteger(discount.amountCents),
          ) ||
          sum(value.itemDiscounts.map((discount) => discount.amountCents)) !==
            BigInt(value.itemsDiscountCents))) ||
      value.lines.some(
        (line) =>
          BigInt(line.grossCents) - BigInt(line.discountCents) !==
          BigInt(line.netCents),
      ) ||
      sum(value.lines.map((line) => line.grossCents)) !==
        BigInt(value.itemsGrossCents) ||
      sum(value.lines.map((line) => line.netCents)) !==
        BigInt(value.itemsNetCents) ||
      BigInt(value.itemsGrossCents) - BigInt(value.itemsDiscountCents) !==
        BigInt(value.itemsNetCents) ||
      BigInt(value.shippingGrossCents) - BigInt(value.shippingDiscountCents) !==
        BigInt(value.shippingCents) ||
      BigInt(value.itemsNetCents) +
        BigInt(value.shippingCents) +
        (value.taxesIncluded ? BigInt(0) : BigInt(value.taxCents)) !==
        BigInt(value.totalCents)
    )
      context.addIssue({
        code: "custom",
        message:
          "The financial breakdown does not reconcile to the order total.",
      });
  });

export const orderEditSettlementSchema = z
  .object({
    receivedCents: cents,
    refundedCents: cents,
    netPaidCents: cents,
    outstandingCents: z.number().int().safe(),
    activity: z
      .array(
        z
          .object({
            id: z.string().min(1),
            kind: z.enum([
              "payment",
              "refund",
              "authorization",
              "void",
              "adjustment",
            ]),
            status: z.enum([
              "SUCCESS",
              "PENDING",
              "AWAITING_RESPONSE",
              "UNKNOWN",
              "FAILURE",
              "ERROR",
            ]),
            amountCents: cents,
            processedAt: z.string().datetime().nullable(),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

export type OrderEditFinancials = z.infer<typeof orderEditFinancialsSchema>;
export type OrderEditSettlement = z.infer<typeof orderEditSettlementSchema>;
