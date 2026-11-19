import { z } from "zod";

const idSchema = z.number().int().positive().max(2_147_483_647);
const ruleTypeSchema = z.enum(["percentage", "fixed", "override"]);

// Existing HTTP clients send either JSON numbers or decimal strings. Convert
// their representation without performing binary floating-point money math.
export const pricingRuleValueSchema = z.union([z.string(), z.number().finite()])
  .transform(value => String(value))
  .pipe(z.string().regex(/^\d{1,8}(?:\.\d{1,2})?$/, "Use a nonnegative decimal with at most two decimal places"))
  .transform(value => {
    const [whole, fraction = ""] = value.split(".");
    return `${BigInt(whole)}.${fraction.padEnd(2, "0")}`;
  });

export const expectedPricingRuleSchema = z.object({
  // Listing workspaces expose the default's value, while rule editors also
  // expose its row ID. Both can supply an optimistic value snapshot.
  id: idSchema.optional(),
  // A snapshot describes existing data, including invalid legacy data that the
  // operator must be able to correct or remove. Only the new value is strict.
  ruleType: z.string().max(20),
  value: z.string().max(100),
}).strict();
export type ExpectedPricingRule = z.infer<typeof expectedPricingRuleSchema>;

const ruleFields = {
  ruleType: ruleTypeSchema,
  value: pricingRuleValueSchema,
  // Omission preserves existing API callers; explicit null is insert-only.
  expected: expectedPricingRuleSchema.nullable().optional(),
};
const catalogIdSchema = z.string().regex(/^[1-9]\d{0,9}$/)
  .refine(value => BigInt(value) <= BigInt(2_147_483_647), "Select a valid Catalog ID");
export const saveChannelPricingRuleSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("channel"), scopeId: z.null().default(null), ...ruleFields }).strict(),
  z.object({ scope: z.literal("category"), scopeId: z.string().trim().min(1).max(100), ...ruleFields }).strict(),
  z.object({ scope: z.literal("product"), scopeId: catalogIdSchema, ...ruleFields }).strict(),
  z.object({ scope: z.literal("variant"), scopeId: catalogIdSchema, ...ruleFields }).strict(),
]);
export type SaveChannelPricingRule = z.infer<typeof saveChannelPricingRuleSchema>;
export type PricingRuleTarget = Pick<SaveChannelPricingRule, "scope" | "scopeId">;

const centsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const storedCentsSchema = z.string().regex(/^(0|[1-9][0-9]*)$/)
  .refine(value => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER), "Stored price exceeds the supported range");
export const expectedChannelPriceSchema = z.object({
  price: storedCentsSchema, compareAtPrice: storedCentsSchema.nullable(), currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();
export type ExpectedChannelPrice = z.infer<typeof expectedChannelPriceSchema>;
export const saveChannelPriceSchema = z.object({
  price: centsSchema,
  compareAtPrice: centsSchema.nullable().optional(),
  cost: centsSchema.nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
}).strict();
export type SaveChannelPrice = z.infer<typeof saveChannelPriceSchema>;

export class ChannelPricingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ChannelPricingError";
  }
}

export function parsePricingContext(channelId: unknown, actor: unknown, now: unknown) {
  return z.object({
    channelId: idSchema,
    actor: z.string().trim().min(1).max(200),
    now: z.date(),
  }).parse({ channelId, actor, now });
}

export function parsePricingId(value: unknown): number {
  return idSchema.parse(value);
}
