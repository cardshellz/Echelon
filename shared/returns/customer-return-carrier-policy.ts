import Decimal from "decimal.js";
import { z } from "zod";

const ExactWeight = Decimal.clone({ precision: 40 });
const GRAMS_PER_POUND = "453.59237";
export const MAX_RETURN_CARRIER_RULES = 100;
export const MAX_RETURN_SERVICES_PER_CARRIER = 200;
export const customerReturnCarrierIdSchema = z
  .string()
  .regex(/^se(?:-[a-z0-9]+)+$/)
  .max(80);
export const customerReturnServiceCodeSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/)
  .max(100);
export const customerReturnWeightLimitSchema = z
  .string()
  .trim()
  .max(16)
  .regex(/^\d{1,9}(?:\.\d{1,3})?$/)
  .pipe(
    z
      .string()
      .refine(
        (value) => new ExactWeight(value).greaterThan(0),
        "Enter a weight greater than zero.",
      )
      .transform((value) => new ExactWeight(value).toFixed()),
  );

export const customerReturnCarrierRuleSchema = z
  .object({
    carrierId: customerReturnCarrierIdSchema,
    serviceCodes: z
      .array(customerReturnServiceCodeSchema)
      .min(1)
      .max(MAX_RETURN_SERVICES_PER_CARRIER)
      .refine(
        (values) => new Set(values).size === values.length,
        "Choose each service only once.",
      ),
    maxWeightLb: customerReturnWeightLimitSchema.nullable(),
  })
  .strict();
export type CustomerReturnCarrierRule = z.infer<
  typeof customerReturnCarrierRuleSchema
>;

export const customerReturnCarrierRulesSchema = z
  .array(customerReturnCarrierRuleSchema)
  .max(MAX_RETURN_CARRIER_RULES)
  .refine(
    (rules) =>
      new Set(rules.map((rule) => rule.carrierId)).size === rules.length,
    "Configure each carrier account only once.",
  );

/** Defaults accept the previous fixed-service wire format and persisted rows. */
export const customerReturnCarrierPolicyFields = {
  selectionMode: z
    .enum(["fixed_service", "cheapest_eligible"])
    .default("fixed_service"),
  carrierId: customerReturnCarrierIdSchema.nullable(),
  serviceCode: customerReturnServiceCodeSchema.nullable(),
  carrierRules: customerReturnCarrierRulesSchema.default([]),
};
type CarrierPolicyFields = {
  selectionMode: "fixed_service" | "cheapest_eligible";
  carrierId: string | null;
  serviceCode: string | null;
  carrierRules: CustomerReturnCarrierRule[];
};
export function refineCustomerReturnCarrierPolicy(
  value: CarrierPolicyFields,
  context: z.RefinementCtx,
): void {
  const valid =
    value.selectionMode === "fixed_service"
      ? value.carrierId !== null &&
        value.serviceCode !== null &&
        value.carrierRules.length === 0
      : value.carrierId === null &&
        value.serviceCode === null &&
        value.carrierRules.length > 0;
  if (!valid)
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["carrierRules"],
      message:
        "Choose one fixed service or at least one allowed carrier rule for automatic selection.",
    });
}
export const customerReturnCarrierPolicySchema = z
  .object(customerReturnCarrierPolicyFields)
  .strict()
  .superRefine(refineCustomerReturnCarrierPolicy);
export type CustomerReturnCarrierPolicy = z.infer<
  typeof customerReturnCarrierPolicySchema
>;

/** Both parcel weights and policy boundaries use whole grams, rounded upward.
 * Thus a declared 20 lb box and a 20 lb cap have the same 9,072 g boundary.
 * Keep the original decimal pounds in configuration so editing never loses precision.
 */
export function returnCarrierWeightLimitGrams(
  maxWeightLb: string | null,
): number | null {
  if (maxWeightLb === null) return null;
  return new ExactWeight(customerReturnWeightLimitSchema.parse(maxWeightLb))
    .times(GRAMS_PER_POUND)
    .ceil()
    .toNumber();
}

export function returnCarrierRuleAllowsWeight(
  rule: CustomerReturnCarrierRule,
  weightGrams: number,
): boolean {
  if (!Number.isSafeInteger(weightGrams) || weightGrams <= 0) return false;
  const ceiling = returnCarrierWeightLimitGrams(rule.maxWeightLb);
  return ceiling === null || weightGrams <= ceiling;
}

export function isReturnCarrierServiceAllowed(
  policy: CustomerReturnCarrierPolicy,
  carrierId: string,
  serviceCode: string,
  weightGrams: number,
): boolean {
  if (!Number.isSafeInteger(weightGrams) || weightGrams <= 0) return false;
  if (policy.selectionMode === "fixed_service")
    return policy.carrierId === carrierId && policy.serviceCode === serviceCode;
  return policy.carrierRules.some(
    (rule) =>
      rule.carrierId === carrierId &&
      rule.serviceCodes.includes(serviceCode) &&
      returnCarrierRuleAllowsWeight(rule, weightGrams),
  );
}

/** Stable snapshots make reordering controls immaterial to policy comparison. */
export function normalizeCustomerReturnCarrierRules(
  rules: readonly CustomerReturnCarrierRule[],
): CustomerReturnCarrierRule[] {
  return (
    rules
      // JSONB does not preserve object insertion order. Construct a canonical
      // shape as well as sorting arrays so unchanged rules can always be paused.
      .map((rule) => ({
        carrierId: rule.carrierId,
        serviceCodes: [...rule.serviceCodes].sort(),
        maxWeightLb: rule.maxWeightLb,
      }))
      .sort((left, right) =>
        left.carrierId < right.carrierId
          ? -1
          : left.carrierId > right.carrierId
            ? 1
            : 0,
      )
  );
}
