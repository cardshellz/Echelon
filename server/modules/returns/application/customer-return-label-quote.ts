import { createHash } from "node:crypto";
import { z } from "zod";
import { customerReturnCostReferencesSchema } from "../domain/customer-return-cost-guard";
import { customerReturnLabelSettingsSchema } from "@shared/returns/customer-return-label.contract";
import {
  returnRateCandidateSchema,
  returnRateResultSchema,
  returnRateShipmentSchema,
} from "../../shipping-engine/application/return-rate-provider.port";

// Quick rates have no persistent provider rate id. Bound the interval between
// observation and durable purchase intent; this is not a provider price lock.
export const RETURN_RATE_QUOTE_MAX_AGE_MS = 60_000;
export const customerReturnQuoteDecisionSchema = z
  .object({
    settings: customerReturnLabelSettingsSchema,
    shipment: returnRateShipmentSchema,
    shipmentHash: z.string().regex(/^[a-f0-9]{64}$/),
    result: returnRateResultSchema.nullable(),
    costReferences: customerReturnCostReferencesSchema.optional(),
    selected: returnRateCandidateSchema.nullable(),
    errorCode: z
      .string()
      .regex(/^[A-Z0-9_]+$/)
      .max(100)
      .nullable(),
    quotedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.shipmentHash !== customerReturnShipmentHash(value.shipment) ||
      (value.selected !== null
        ? value.result === null || value.errorCode !== null
        : value.errorCode === null) ||
      Date.parse(value.expiresAt) - Date.parse(value.quotedAt) !==
        RETURN_RATE_QUOTE_MAX_AGE_MS
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid return quote evidence.",
      });
    }
  });
export type CustomerReturnQuoteDecision = z.infer<
  typeof customerReturnQuoteDecisionSchema
>;

/** Extend the existing immutable JSON evidence rather than changing old rows.
 * Older quote results contain no comparison manifests and remain readable.
 */
export function storedCustomerReturnQuoteResult(decision: CustomerReturnQuoteDecision) {
  return decision.result === null ? null : { ...decision.result,
    ...(decision.costReferences?.length ? { costReferences: decision.costReferences } : {}) };
}
export function readStoredCustomerReturnQuoteResult(raw: unknown) {
  if (raw === null) return { result: null, costReferences: undefined };
  const value = returnRateResultSchema.innerType().extend({ costReferences: customerReturnCostReferencesSchema.optional() }).strict().parse(raw);
  const { costReferences, ...result } = value;
  return { result: returnRateResultSchema.parse(result), costReferences };
}

export function customerReturnShipmentHash(
  shipment: z.infer<typeof returnRateShipmentSchema>,
): string {
  return createHash("sha256")
    .update(JSON.stringify(returnRateShipmentSchema.parse(shipment)))
    .digest("hex");
}
