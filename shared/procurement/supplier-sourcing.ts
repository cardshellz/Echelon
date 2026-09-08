import { z } from "zod";
import { normalizePoLinePricing } from "../utils/po-line-pricing";

export const SOURCING_MAX_CANDIDATES = 100;
export const SOURCING_MAX_TIERS = 50;
export const sourcingId = z.number().int().positive().max(2_147_483_647);
const money = z.number().int().nonnegative().safe();
export const supplierPriceListSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  basis: z.enum(["per_piece", "per_purchase_uom"]),
  purchaseUom: z.string().trim().min(1).max(50).nullable(),
  piecesPerPurchaseUom: sourcingId.nullable(),
  quoteReference: z.string().trim().min(1).max(255),
  quotedAt: z.string().datetime({ offset: true }),
  validFrom: z.string().date(),
  validUntil: z.string().date(),
  tiers: z.array(z.object({ minimumQuantity: sourcingId, unitCostMills: money }).strict()).min(1).max(SOURCING_MAX_TIERS),
}).strict().superRefine((list, ctx) => {
  const quoteTimestamp = new Date(list.quotedAt);
  if (Number.isFinite(quoteTimestamp.getTime()) && (list.validUntil < list.validFrom || list.validFrom < quoteTimestamp.toISOString().slice(0, 10))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["validFrom"], message: "Validity must start on or after the quote date and end on or after its start" });
  if ((list.basis === "per_piece" && (list.purchaseUom !== null || list.piecesPerPurchaseUom !== null)) || (list.basis === "per_purchase_uom" && (list.purchaseUom === null || list.piecesPerPurchaseUom === null))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["purchaseUom"], message: "The price basis must contain an explicit consistent purchase unit" });
  list.tiers.forEach((tier, index) => {
    if (index > 0 && tier.minimumQuantity <= list.tiers[index - 1].minimumQuantity) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tiers", index], message: "Quantity thresholds must be unique and increasing" });
  });
});
export const supplierSourcingPolicySchema = z.object({
  version: z.literal(1),
  priority: z.number().int().min(0).max(10_000),
  eligibleForProposals: z.boolean(),
  priceList: supplierPriceListSchema.nullable(),
}).strict();
export const DEFAULT_SUPPLIER_SOURCING_POLICY = supplierSourcingPolicySchema.parse({ version: 1, priority: 100, eligibleForProposals: true, priceList: null });
export const supplierSourcingUpdateSchema = z.object({
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
  idempotencyKey: z.string().uuid(),
  reason: z.string().trim().min(3).max(2_000),
  policy: supplierSourcingPolicySchema,
}).strict();
export const supplierSourcingRecordSchema = z.object({
  vendorProductId: sourcingId, revision: z.number().int().nonnegative(), policy: supplierSourcingPolicySchema,
  recordedBy: z.string().min(1).nullable(), recordedAt: z.string().datetime({ offset: true }).nullable(), reason: z.string().nullable(),
}).strict();
export type SupplierPriceList = z.infer<typeof supplierPriceListSchema>;
export type SupplierSourcingPolicy = z.infer<typeof supplierSourcingPolicySchema>;
export type SupplierSourcingRecord = z.infer<typeof supplierSourcingRecordSchema>;
export const supplierTierEvidenceSchema = z.object({
  vendorProductId: sourcingId, revision: sourcingId, priceList: supplierPriceListSchema,
  evaluatedPieces: sourcingId, evaluatedQuantity: sourcingId, tierIndex: z.number().int().min(0).max(SOURCING_MAX_TIERS - 1),
  minimumQuantity: sourcingId, unitCostMills: money, normalizedUnitCostMills: money, totalProductCostCents: money,
}).strict();
export type SupplierTierEvidence = z.infer<typeof supplierTierEvidenceSchema>;
export type SupplierTierRejection = "quote_not_yet_valid" | "quote_expired" | "currency_mismatch" | "below_first_price_tier" | "purchase_unit_mismatch" | "price_overflow";

/** Select a quoted threshold at the already calculated buy quantity. Price
 * thresholds never feed the quantity calculation or cause discount top-offs. */
export function selectSupplierPriceTier(input: { vendorProductId: number; revision: number; priceList: SupplierPriceList; pieces: number; asOfDate: string; currency: string }): { evidence: SupplierTierEvidence | null; rejection: SupplierTierRejection | null } {
  const list = supplierPriceListSchema.parse(input.priceList);
  sourcingId.parse(input.vendorProductId); sourcingId.parse(input.revision); sourcingId.parse(input.pieces); z.string().date().parse(input.asOfDate);
  const reject = (rejection: SupplierTierRejection) => ({ evidence: null, rejection });
  if (list.currency !== input.currency) return reject("currency_mismatch");
  if (input.asOfDate < list.validFrom) return reject("quote_not_yet_valid");
  if (input.asOfDate > list.validUntil) return reject("quote_expired");
  const piecesPerUom = list.basis === "per_purchase_uom" ? list.piecesPerPurchaseUom! : 1;
  if (input.pieces % piecesPerUom !== 0) return reject("purchase_unit_mismatch");
  const quantity = input.pieces / piecesPerUom;
  const tierIndex = list.tiers.findLastIndex((tier) => tier.minimumQuantity <= quantity);
  if (tierIndex < 0) return reject("below_first_price_tier");
  const tier = list.tiers[tierIndex];
  try {
    const price = normalizePoLinePricing(list.basis === "per_piece"
      ? { basis: "per_piece", quantityPieces: input.pieces, unitCostMills: tier.unitCostMills }
      : { basis: "per_purchase_uom", purchaseUom: list.purchaseUom!, uomQuantity: quantity, piecesPerUom, quotedCostMillsPerUom: tier.unitCostMills });
    return { evidence: supplierTierEvidenceSchema.parse({ vendorProductId: input.vendorProductId, revision: input.revision, priceList: list, evaluatedPieces: input.pieces, evaluatedQuantity: quantity, tierIndex, minimumQuantity: tier.minimumQuantity, unitCostMills: tier.unitCostMills, normalizedUnitCostMills: price.unitCostMills, totalProductCostCents: price.totalProductCostCents }), rejection: null };
  } catch { return reject("price_overflow"); }
}

export const supplierSourcingOptionSchema = z.object({
  vendorProductId: sourcingId, vendorId: sourcingId, vendorName: z.string(), preferred: z.boolean(), priority: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(), eligible: z.boolean(), rejectionReasons: z.array(z.string()),
  pricingReviewReasons: z.array(z.string()), currency: z.string().nullable(), leadTimeDays: z.number().int().nonnegative(),
  minimumOrderPieces: sourcingId.nullable(), orderIncrementPieces: sourcingId,
  proposedPieces: z.number().int().nonnegative().safe(), estimatedUnitCostMills: money.nullable(), tier: supplierTierEvidenceSchema.nullable(),
}).strict();
export const supplierSelectionEvidenceSchema = z.object({
  version: z.literal(1), selectedVendorProductId: sourcingId.nullable(), method: z.enum(["preferred", "ranked_alternate", "none"]),
  rankBasis: z.literal("preferred_then_priority_then_variant_then_lead_time_then_identity"),
  priceComparison: z.literal("not_performed"), options: z.array(supplierSourcingOptionSchema).max(SOURCING_MAX_CANDIDATES),
}).strict();
export type SupplierSourcingOption = z.infer<typeof supplierSourcingOptionSchema>;
export type SupplierSelectionEvidence = z.infer<typeof supplierSelectionEvidenceSchema>;
