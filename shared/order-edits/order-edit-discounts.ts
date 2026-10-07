import { z } from "zod";

const cents = z.number().int().safe().nonnegative();
const text = z.string().trim().min(1).max(500);
const percentage = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/)
  .max(100)
  .refine((input) => {
    if (!/^\d+(?:\.\d+)?$/.test(input) || input.length > 100) return false;
    const [whole, decimals = ""] = input.split(".");
    return (
      BigInt(whole + decimals) <=
      BigInt(100) * BigInt(`1${"0".repeat(decimals.length)}`)
    );
  }, "Discount percentages must be between 0 and 100");
export const orderEditDiscountValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("percentage"), percentage }).strict(),
  z.object({ type: z.literal("fixed"), amountCents: cents }).strict(),
  z.object({ type: z.literal("allocated") }).strict(),
]);

/** A displayed discount is an allocation, never a payment or a second redemption. */
export const orderEditDiscountSchema = z
  .object({
    key: text,
    label: text,
    amountCents: cents,
    value: orderEditDiscountValueSchema,
  })
  .strict()
  .refine(
    (discount) =>
      discount.value.type !== "fixed" ||
      discount.amountCents <= discount.value.amountCents,
    "A fixed allocation cannot exceed its original credit",
  );
export type OrderEditDiscount = z.infer<typeof orderEditDiscountSchema>;
