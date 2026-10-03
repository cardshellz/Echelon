import { z } from "zod";
import {
  customerReturnShippingGuardrailsSchema, defaultCustomerReturnShippingGuardrails,
  RETURN_PARCEL_CARRIER_FAMILIES, type CustomerReturnShippingGuardrails,
} from "@shared/returns/customer-return-shipping-guardrails";
import { dimensionInputToMm, formatDimensionInches } from "@shared/shipping/dimensions";

export interface ReturnParcelLimitDraft {
  maxWeightLb: string;
  maxLengthInches: string;
  maxLengthPlusGirthInches: string;
  referenceLengthInches: string;
  referenceWidthInches: string;
  referenceHeightInches: string;
}
export interface ReturnShippingGuardrailsDraft {
  costProtection: boolean;
  usps: ReturnParcelLimitDraft;
  ups: ReturnParcelLimitDraft;
  fedex: ReturnParcelLimitDraft;
}
export function createReturnShippingGuardrailsDraft(value?: CustomerReturnShippingGuardrails | null): ReturnShippingGuardrailsDraft {
  const guardrails = value ?? defaultCustomerReturnShippingGuardrails();
  const familyDraft = (family: typeof RETURN_PARCEL_CARRIER_FAMILIES[number]): ReturnParcelLimitDraft => ({
    maxWeightLb: guardrails[family].maxWeightLb,
    maxLengthInches: guardrails[family].maxLengthInches ?? "",
    maxLengthPlusGirthInches: guardrails[family].maxLengthPlusGirthInches,
    referenceLengthInches: formatDimensionInches(guardrails[family].costReferenceDimensions.lengthMm),
    referenceWidthInches: formatDimensionInches(guardrails[family].costReferenceDimensions.widthMm),
    referenceHeightInches: formatDimensionInches(guardrails[family].costReferenceDimensions.heightMm),
  });
  return { costProtection: guardrails.costProtection, usps: familyDraft("usps"), ups: familyDraft("ups"), fedex: familyDraft("fedex") };
}
const inchesToMm = z.string().transform((value, context) => {
  try {
    const millimeters = dimensionInputToMm(value, "Reference box side");
    if (millimeters !== null) return millimeters;
  } catch (error) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : "Enter a valid box size." });
    return z.NEVER;
  }
  context.addIssue({ code: z.ZodIssueCode.custom, message: "Enter each reference box side." });
  return z.NEVER;
});
const limitDraft = z.object({
  maxWeightLb: z.string(), maxLengthInches: z.string(), maxLengthPlusGirthInches: z.string(),
  referenceLengthInches: inchesToMm, referenceWidthInches: inchesToMm, referenceHeightInches: inchesToMm,
}).strict().transform(value => ({
  maxWeightLb: value.maxWeightLb, maxLengthInches: value.maxLengthInches.trim() || null,
  maxLengthPlusGirthInches: value.maxLengthPlusGirthInches,
  costReferenceDimensions: { lengthMm: value.referenceLengthInches, widthMm: value.referenceWidthInches, heightMm: value.referenceHeightInches },
}));
export const returnShippingGuardrailsDraftSchema = z.object({
  costProtection: z.boolean(), usps: limitDraft, ups: limitDraft, fedex: limitDraft,
}).strict().transform(value => ({ ...value, geography: "us_domestic" as const })).pipe(customerReturnShippingGuardrailsSchema);
