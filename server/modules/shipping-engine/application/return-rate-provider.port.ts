import { z } from "zod";
import {
  returnLabelInputSchema,
  returnLabelProviderIdSchema,
} from "./return-label-provider.port";

export const MAX_RETURN_RATE_CARRIERS = 100;
export const MAX_RETURN_RATE_CANDIDATES = 2_000;
const serviceCode = z
  .string()
  .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/)
  .max(100);
const cents = z.number().int().nonnegative().safe();

export const returnRateShipmentSchema = returnLabelInputSchema
  .innerType()
  .omit({ carrierId: true, serviceCode: true })
  .refine((input) => input.shipFrom.countryCode === input.shipTo.countryCode, {
    message: "Return rates require a domestic shipment.",
  });
export const returnRateInputSchema = z
  .object({
    shipment: returnRateShipmentSchema,
    carrierIds: z
      .array(returnLabelProviderIdSchema)
      .min(1)
      .max(MAX_RETURN_RATE_CARRIERS)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Carrier accounts must be unique.",
      ),
  })
  .strict();
export type ReturnRateInput = z.infer<typeof returnRateInputSchema>;

export const returnRateCandidateSchema = z
  .object({
    carrierId: returnLabelProviderIdSchema,
    carrierCode: serviceCode,
    serviceCode,
    amountCents: cents,
    currency: z.literal("USD"),
    rateId: z.null(),
    rateType: z.literal("quick"),
    packageType: z.literal("package").nullable(),
    trackable: z.literal(true),
    validationStatus: z.enum(["valid", "has_warnings"]),
    warningCount: z.number().int().min(0).max(100),
    amounts: z
      .object({
        shippingCents: cents,
        insuranceCents: cents,
        confirmationCents: cents,
        otherCents: cents,
      })
      .strict(),
  })
  .strict()
  .refine((rate) => {
    const total =
      rate.amounts.shippingCents +
      rate.amounts.insuranceCents +
      rate.amounts.confirmationCents +
      rate.amounts.otherCents;
    return Number.isSafeInteger(total) && total === rate.amountCents;
  }, "The quoted total must equal the component costs.");
export type ReturnRateCandidate = z.infer<typeof returnRateCandidateSchema>;

export const returnRateExclusionSchema = z
  .object({
    carrierId: returnLabelProviderIdSchema,
    serviceCode,
    code: z.enum([
      "RETURN_RATE_SERVICE_INVALID",
      "RETURN_RATE_NOT_TRACKABLE",
      "RETURN_RATE_PACKAGE_UNSUPPORTED",
    ]),
  })
  .strict();
export type ReturnRateExclusion = z.infer<typeof returnRateExclusionSchema>;
export const returnRateResultSchema = z
  .object({
    status: z.literal("completed"),
    rates: z.array(returnRateCandidateSchema).max(MAX_RETURN_RATE_CANDIDATES),
    exclusions: z
      .array(returnRateExclusionSchema)
      .max(MAX_RETURN_RATE_CANDIDATES),
  })
  .strict()
  .superRefine((result, context) => {
    const identities = [...result.rates, ...result.exclusions].map(
      (rate) => `${rate.carrierId}:${rate.serviceCode}`,
    );
    if (
      identities.length > MAX_RETURN_RATE_CANDIDATES ||
      new Set(identities).size !== identities.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Rate identities must be unique and bounded.",
      });
    }
  });
export type ReturnRateResult = z.infer<typeof returnRateResultSchema>;

export class ReturnRateProviderError extends Error {
  constructor(
    readonly code: string,
    readonly failureClass:
      | "configuration"
      | "transient"
      | "rejected"
      | "invalid_response",
  ) {
    super(
      "Eligible return rates could not be verified. No label was purchased.",
    );
    this.name = "ReturnRateProviderError";
  }
}

export interface ReturnRateProvider {
  /** Quotes only. A successful result does not authorize a provider purchase. */
  quote(
    input: ReturnRateInput,
    signal?: AbortSignal,
  ): Promise<ReturnRateResult>;
}
