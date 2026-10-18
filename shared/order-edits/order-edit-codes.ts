import { z } from "zod";
import { orderEditDiscountValueSchema } from "./order-edit-discounts";

export const MAX_ORDER_EDIT_CODES = 5;
export const orderEditCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "Enter a valid discount code.",
  );
export const orderEditRequestedCodesSchema = z
  .array(orderEditCodeSchema)
  .max(MAX_ORDER_EDIT_CODES)
  .superRefine((codes, context) => {
    if (new Set(codes.map((code) => code.toUpperCase())).size !== codes.length)
      context.addIssue({
        code: "custom",
        message: "This code has already been added.",
      });
  });

export const orderEditDiscountClassSchema = z.enum([
  "PRODUCT",
  "ORDER",
  "SHIPPING",
]);
export const orderEditCombinesWithSchema = z
  .object({
    productDiscounts: z.boolean(),
    orderDiscounts: z.boolean(),
    shippingDiscounts: z.boolean(),
  })
  .strict();
export const orderEditCodeValueSchema = z.discriminatedUnion("type", [
  orderEditDiscountValueSchema.options[0],
  orderEditDiscountValueSchema.options[1],
]);

/** Shopify terms are read on the server; a browser never supplies amounts or permissions. */
export const orderEditCodeRuleSchema = z
  .object({
    discountId: z
      .string()
      .regex(/^gid:\/\/shopify\/DiscountCodeNode\/[1-9][0-9]*$/),
    code: orderEditCodeSchema,
    classes: z.array(orderEditDiscountClassSchema).min(1).max(3),
    combinesWith: orderEditCombinesWithSchema,
    value: orderEditCodeValueSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    // Legacy values remain readable. New rewards require explicit Club issuance
    // verification; customer eligibility or usage limits never identify a reward.
    redemption: z.enum([
      "unlimited",
      "single_use_reward",
      "shopify_coupon",
      "club_reward",
    ]),
    usageLimit: z.number().int().positive().safe().nullable().optional(),
    appliesOncePerCustomer: z.boolean().optional(),
  })
  .strict()
  .superRefine((rule, context) => {
    if (
      rule.redemption === "club_reward" &&
      (rule.value.type !== "fixed" ||
        rule.usageLimit !== 1 ||
        rule.appliesOncePerCustomer !== true)
    )
      context.addIssue({
        code: "custom",
        message: "Club rewards require their original single-use terms.",
      });
    if (
      rule.redemption === "shopify_coupon" &&
      (rule.usageLimit === undefined ||
        rule.appliesOncePerCustomer === undefined)
    )
      context.addIssue({
        code: "custom",
        message: "A Shopify coupon must retain its native usage restrictions.",
      });
  });

export const orderEditCodeApplicationSchema = z
  .object({
    code: orderEditCodeSchema,
    amountCents: z.number().int().nonnegative().safe(),
  })
  .strict();

export const orderEditCodePricingLineSchema = z
  .object({
    id: z.string().min(1),
    sourceId: z.string().min(1).max(500),
    variantId: z
      .string()
      .regex(/^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/),
    quantity: z.number().int().positive().max(10000),
    retailCents: z.number().int().nonnegative().safe(),
    productNetCents: z.number().int().nonnegative().safe(),
    netCents: z.number().int().nonnegative().safe(),
    /** The original automatic discount remains native; no manual adjustment may target this line. */
    preserveAutomaticDiscount: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (line) =>
      [
        line.netCents,
        line.productNetCents,
        line.retailCents,
        line.quantity,
      ].every(Number.isSafeInteger) &&
      line.netCents <= line.productNetCents &&
      (!line.preserveAutomaticDiscount ||
        line.netCents === line.productNetCents) &&
      BigInt(line.productNetCents) <=
        BigInt(line.retailCents) * BigInt(line.quantity),
  );

/** Persisted alongside the quote, never accepted as a browser command. */
export const orderEditCodePricingSchema = z
  .object({
    rules: z.array(orderEditCodeRuleSchema).min(1).max(MAX_ORDER_EDIT_CODES),
    newCodes: orderEditRequestedCodesSchema,
    applications: z
      .array(orderEditCodeApplicationSchema)
      .min(1)
      .max(MAX_ORDER_EDIT_CODES),
    description: z.string().regex(/^Order discounts \([a-f0-9]{24}\)$/),
    lines: z.array(orderEditCodePricingLineSchema).min(1).max(250),
  })
  .strict()
  .superRefine((pricing, context) => {
    if (
      pricing.lines.some(
        (line) =>
          ![
            line.netCents,
            line.productNetCents,
            line.quantity,
            line.retailCents,
          ].every(Number.isSafeInteger),
      ) ||
      pricing.applications.some(
        (application) => !Number.isSafeInteger(application.amountCents),
      )
    )
      return;
    const keys = pricing.rules.map((rule) => rule.code.toUpperCase());
    const applications = pricing.applications.map((application) =>
      application.code.toUpperCase(),
    );
    const expected = pricing.lines.reduce(
      (sum, line) => sum + BigInt(line.productNetCents) - BigInt(line.netCents),
      BigInt(0),
    );
    if (
      new Set(keys).size !== keys.length ||
      new Set(pricing.rules.map((rule) => rule.discountId)).size !==
        pricing.rules.length ||
      new Set(applications).size !== applications.length ||
      applications.length !== keys.length ||
      applications.some((code) => !keys.includes(code)) ||
      pricing.newCodes.some((code) => !keys.includes(code.toUpperCase())) ||
      new Set(pricing.lines.map((line) => line.id)).size !==
        pricing.lines.length ||
      pricing.applications.some(
        (application) => application.amountCents === 0,
      ) ||
      pricing.applications.reduce(
        (sum, application) => sum + BigInt(application.amountCents),
        BigInt(0),
      ) !== expected
    )
      context.addIssue({
        code: "custom",
        message:
          "The code identities and savings must reconcile to the verified item prices.",
      });
  });

export type OrderEditCodeRule = z.infer<typeof orderEditCodeRuleSchema>;
export type OrderEditCodeApplication = z.infer<
  typeof orderEditCodeApplicationSchema
>;
export type OrderEditCodePricing = z.infer<typeof orderEditCodePricingSchema>;
export type OrderEditDiscountClass = z.infer<
  typeof orderEditDiscountClassSchema
>;
export type OrderEditCombinesWith = z.infer<typeof orderEditCombinesWithSchema>;
