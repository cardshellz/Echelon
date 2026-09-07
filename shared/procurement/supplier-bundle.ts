import { z } from "zod";

const cents = z.number().int().nonnegative().safe();
export const supplierBundleTermsSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  minimumOrderCents: cents,
  freeFreightThresholdCents: cents.nullable(),
}).strict();
export type SupplierBundleTerms = z.infer<typeof supplierBundleTermsSchema>;

export interface SupplierBundleReadiness {
  terms: SupplierBundleTerms | null;
  status: "ready" | "below_minimum" | "unpriced" | "invalid_terms";
  subtotalCents: number | null;
  minimumShortfallCents: number | null;
  freeFreightShortfallCents: number | null;
  detail: string;
}

/** A commercial basket check, never authority to increase a product quantity. */
export function evaluateSupplierBundle(terms: unknown, lineTotalsCents: readonly (number | null)[]): SupplierBundleReadiness {
  const parsed = supplierBundleTermsSchema.safeParse(terms);
  if (!parsed.success || parsed.data.currency === null) return {
    terms: null, status: "invalid_terms", subtotalCents: null, minimumShortfallCents: null, freeFreightShortfallCents: null,
    detail: "Supplier currency or basket terms need review before comparing totals.",
  };
  if (lineTotalsCents.length === 0 || lineTotalsCents.some((value) => value === null || !cents.safeParse(value).success)) return {
    terms: parsed.data, status: "unpriced", subtotalCents: null, minimumShortfallCents: null, freeFreightShortfallCents: null,
    detail: "An exact price is required for every selected line to assess the supplier basket.",
  };
  const total = lineTotalsCents.reduce<bigint>((sum, value) => sum + BigInt(value!), BigInt(0));
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Supplier basket exceeds the supported cents range");
  const subtotalCents = Number(total);
  const minimumShortfallCents = Math.max(0, parsed.data.minimumOrderCents - subtotalCents);
  const freeFreightShortfallCents = parsed.data.freeFreightThresholdCents === null ? null
    : Math.max(0, parsed.data.freeFreightThresholdCents - subtotalCents);
  return {
    terms: parsed.data, status: minimumShortfallCents > 0 ? "below_minimum" : "ready", subtotalCents,
    minimumShortfallCents, freeFreightShortfallCents,
    detail: minimumShortfallCents > 0
      ? "The selected products are below the supplier order minimum. Review consolidation or request a quote."
      : "The selected products meet the supplier order minimum. Freight eligibility remains subject to the supplier's quote.",
  };
}
