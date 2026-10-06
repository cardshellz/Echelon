import { z } from "zod";

const cents = z.number().int().safe().nonnegative();
const label = z.string().trim().min(1).max(500);

export const orderEditFinancialsSchema = z
  .object({
    itemsGrossCents: cents,
    itemsDiscountCents: cents,
    itemsNetCents: cents,
    itemDiscountLabels: z.array(label).max(250),
    shippingGrossCents: cents,
    shippingDiscountCents: cents,
    shippingCents: cents,
    shippingDiscountLabels: z.array(label).max(250),
    taxCents: cents,
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
      ...value.lines.flatMap((line) => [
        line.grossCents,
        line.discountCents,
        line.netCents,
      ]),
    ];
    if (amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0))
      return;
    const sum = (values: number[]) =>
      values.reduce((total, amount) => total + BigInt(amount), BigInt(0));
    if (
      new Set(value.lines.map((line) => line.id)).size !== value.lines.length ||
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
