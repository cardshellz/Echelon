import Decimal from "decimal.js";
import { z } from "zod";
import {
  returnCarrierWeightLimitGrams,
  returnCarrierRuleAllowsWeight,
  MAX_RETURN_CARRIER_RULES,
  MAX_RETURN_SERVICES_PER_CARRIER,
  type CustomerReturnCarrierPolicy,
} from "./customer-return-carrier-policy";
import {
  customerReturnDimensionsSchema,
  type CustomerReturnDimensions,
} from "./customer-return-parcel";
import { MILLIMETERS_PER_INCH } from "../shipping/dimensions";

const Exact = Decimal.clone({ precision: 40 });
const positiveDecimal = z.string().trim().max(16).regex(/^\d{1,6}(?:\.\d{1,3})?$/)
  .pipe(z.string().refine(value => new Exact(value).greaterThan(0), "Enter a positive number.")
    .transform(value => new Exact(value).toFixed()));
const limitSchema = z.object({
  maxWeightLb: positiveDecimal,
  maxLengthInches: positiveDecimal.nullable(),
  maxLengthPlusGirthInches: positiveDecimal,
  costReferenceDimensions: customerReturnDimensionsSchema,
}).strict();

/** Versioned merchant limits, bounded by the documented parcel service ceilings.
 * USPS: https://www.usps.com/ship/ground-advantage.htm
 * UPS: https://www.ups.com/us/en/support/shipping-support/shipping-dimensions-weight
 * FedEx: https://www.fedex.com/en-us/shipping/ground.html
 * The 20/50 lb ceilings are merchant policy, not the carriers' technical maxima.
 */
export const customerReturnShippingGuardrailsSchema = z.object({
  geography: z.literal("us_domestic"),
  costProtection: z.boolean(),
  usps: limitSchema,
  ups: limitSchema,
  fedex: limitSchema,
}).strict().superRefine((value, context) => {
  for (const family of RETURN_PARCEL_CARRIER_FAMILIES) {
    const limits = value[family];
    // Zod still runs object refinements after a nested refinement reports a dirty
    // value. Do not throw while validating malformed dimensions or decimal text.
    if (!limitSchema.safeParse(limits).success) continue;
    const ceiling = RETURN_PARCEL_CEILINGS[family];
    for (const [field, maximum] of [
      ["maxWeightLb", ceiling.weightLb],
      ["maxLengthPlusGirthInches", ceiling.lengthPlusGirthInches],
    ] as const) {
      if (new Exact(limits[field]).greaterThan(maximum)) context.addIssue({
        code: z.ZodIssueCode.custom, path: [family, field],
        message: `The maximum is ${maximum}.`,
      });
    }
    if (ceiling.lengthInches !== null && (limits.maxLengthInches === null
      || new Exact(limits.maxLengthInches).greaterThan(ceiling.lengthInches))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [family, "maxLengthInches"],
        message: `The longest side must be limited to ${ceiling.lengthInches} inches or less.` });
    }
    const geometry = customerReturnParcelGeometry(limits.costReferenceDimensions);
    if (value.costProtection && !customerReturnLimitAllowsDimensions(limits, geometry)) context.addIssue({
      code: z.ZodIssueCode.custom, path: [family, "costReferenceDimensions"],
      message: "The reference box must fit the size limits.",
    });
  }
});
export type CustomerReturnShippingGuardrails = z.infer<typeof customerReturnShippingGuardrailsSchema>;
export const RETURN_PARCEL_CARRIER_FAMILIES = ["usps", "ups", "fedex"] as const;
export type ReturnParcelCarrierFamily = typeof RETURN_PARCEL_CARRIER_FAMILIES[number];
export const RETURN_PARCEL_CEILINGS = {
  usps: { weightLb: "20", lengthInches: null, lengthPlusGirthInches: "130" },
  ups: { weightLb: "50", lengthInches: "108", lengthPlusGirthInches: "165" },
  fedex: { weightLb: "50", lengthInches: "108", lengthPlusGirthInches: "165" },
} as const;

/** These normal-carton references were rated on the merchant's connected accounts
 * on 2026-10-03. They are configurable comparison cartons, not volume limits or
 * fabricated price caps. Every cost ceiling is obtained from a fresh route quote.
 */
export function defaultCustomerReturnShippingGuardrails(): CustomerReturnShippingGuardrails {
  const parcel = { lengthMm: 609.6, widthMm: 457.2, heightMm: 406.4 }; // 24 x 18 x 16 in
  return customerReturnShippingGuardrailsSchema.parse({
    geography: "us_domestic", costProtection: true,
    usps: { maxWeightLb: "20", maxLengthInches: null, maxLengthPlusGirthInches: "130",
      costReferenceDimensions: { lengthMm: 508, widthMm: 330.2, heightMm: 254 } }, // 20 x 13 x 10 in
    ups: { maxWeightLb: "50", maxLengthInches: "108", maxLengthPlusGirthInches: "165", costReferenceDimensions: { ...parcel } },
    fedex: { maxWeightLb: "50", maxLengthInches: "108", maxLengthPlusGirthInches: "165", costReferenceDimensions: { ...parcel } },
  });
}

/** Match stable service codes validated against the connected provider catalog.
 * Never derive a carrier from a display name, a URL, or a customer-supplied ID.
 */
export function returnParcelCarrierFamily(serviceCode: string): ReturnParcelCarrierFamily | null {
  return RETURN_PARCEL_CARRIER_FAMILIES.find(family => serviceCode.startsWith(`${family}_`)) ?? null;
}
export type CustomerReturnShippingPolicy = CustomerReturnCarrierPolicy & {
  parcelGuardrails?: CustomerReturnShippingGuardrails | null;
};
export const customerReturnPackingLimitSchema = z.object({
  serviceCode: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/).max(100),
  maxWeightGrams: z.number().int().positive().safe(),
  maxLengthMm: z.number().finite().positive().nullable(),
  maxLengthPlusGirthMm: z.number().finite().positive(),
}).strict();
export const customerReturnPackingLimitsSchema = z.array(customerReturnPackingLimitSchema)
  .max(MAX_RETURN_CARRIER_RULES * MAX_RETURN_SERVICES_PER_CARRIER);
export type CustomerReturnPackingLimit = z.infer<typeof customerReturnPackingLimitSchema>;

export function customerReturnPackingLimits(policy: CustomerReturnShippingPolicy): CustomerReturnPackingLimit[] | null {
  if (policy.parcelGuardrails == null) return null; // Historical policies retain their original contract.
  const guardrails = customerReturnShippingGuardrailsSchema.parse(policy.parcelGuardrails);
  const services = policy.selectionMode === "fixed_service"
    ? [{ serviceCode: policy.serviceCode!, maxWeightLb: null }]
    : policy.carrierRules.flatMap(rule => rule.serviceCodes.map(serviceCode => ({ serviceCode, maxWeightLb: rule.maxWeightLb })));
  return customerReturnPackingLimitsSchema.parse(services.flatMap(service => {
    const family = returnParcelCarrierFamily(service.serviceCode);
    if (!family) return [];
    const limits = guardrails[family];
    const familyWeight = returnCarrierWeightLimitGrams(limits.maxWeightLb)!;
    const accountWeight = returnCarrierWeightLimitGrams(service.maxWeightLb);
    return [{ serviceCode: service.serviceCode,
      maxWeightGrams: Math.min(familyWeight, accountWeight ?? familyWeight),
      maxLengthMm: limits.maxLengthInches === null ? null : new Exact(limits.maxLengthInches).times(MILLIMETERS_PER_INCH).toNumber(),
      maxLengthPlusGirthMm: new Exact(limits.maxLengthPlusGirthInches).times(MILLIMETERS_PER_INCH).toNumber() }];
  }));
}

export function customerReturnParcelGeometry(dimensions: CustomerReturnDimensions): {
  longestMm: number; lengthPlusGirthMm: number;
} {
  const parsed = customerReturnDimensionsSchema.parse(dimensions);
  const sides = Object.values(parsed).map(value => new Exact(value)).sort((left, right) => right.comparedTo(left));
  return { longestMm: sides[0].toNumber(), lengthPlusGirthMm: sides[0].plus(sides[1].times(2)).plus(sides[2].times(2)).toNumber() };
}
function customerReturnLimitAllowsDimensions(
  limits: z.infer<typeof limitSchema>, geometry: ReturnType<typeof customerReturnParcelGeometry>,
): boolean {
  return (limits.maxLengthInches === null || new Exact(geometry.longestMm).lte(new Exact(limits.maxLengthInches).times(MILLIMETERS_PER_INCH)))
    && new Exact(geometry.lengthPlusGirthMm).lte(new Exact(limits.maxLengthPlusGirthInches).times(MILLIMETERS_PER_INCH));
}
export function customerReturnPackingIssue(
  limits: readonly CustomerReturnPackingLimit[] | null | undefined,
  weightGrams: number, dimensions: CustomerReturnDimensions,
): "weight" | "size" | "unsupported" | null {
  if (limits == null) return null;
  if (!limits.length) return "unsupported";
  const weighted = limits.filter(limit => weightGrams > 0 && weightGrams <= limit.maxWeightGrams);
  if (!weighted.length) return "weight";
  const geometry = customerReturnParcelGeometry(dimensions);
  return weighted.some(limit => (limit.maxLengthMm === null || geometry.longestMm <= limit.maxLengthMm)
    && geometry.lengthPlusGirthMm <= limit.maxLengthPlusGirthMm) ? null : "size";
}
export function customerReturnServiceAllowsParcel(
  policy: CustomerReturnShippingPolicy, serviceCode: string,
  weightGrams: number, dimensions: CustomerReturnDimensions,
): boolean {
  if (policy.parcelGuardrails == null) return true;
  const family = returnParcelCarrierFamily(serviceCode);
  if (!family || !Number.isSafeInteger(weightGrams) || weightGrams <= 0) return false;
  const limits = customerReturnShippingGuardrailsSchema.parse(policy.parcelGuardrails)[family];
  if (weightGrams > returnCarrierWeightLimitGrams(limits.maxWeightLb)!
    || !customerReturnLimitAllowsDimensions(limits, customerReturnParcelGeometry(dimensions))) return false;
  // Avoid constructing/validating the entire public service projection for every
  // rate candidate when a policy contains many accounts and services.
  return policy.selectionMode === "fixed_service" ? policy.serviceCode === serviceCode
    : policy.carrierRules.some(rule => rule.serviceCodes.includes(serviceCode) && returnCarrierRuleAllowsWeight(rule, weightGrams));
}
