import { z } from "zod";
import { millsToCents } from "@shared/utils/money";
import { selectSupplierPriceTier, sourcingId, supplierSourcingPolicySchema, supplierSelectionEvidenceSchema, type SupplierSourcingOption, type SupplierTierEvidence } from "@shared/procurement/supplier-sourcing";
import type { PurchasingRecommendationItem, PurchasingRecommendationRawRow } from "./purchasing-recommendation.engine";

const nullableInteger = z.union([z.number(), z.string().regex(/^\d+$/)]).transform(Number).pipe(z.number().int().nonnegative().safe()).nullable();
export const supplierCandidateSchema = z.object({
  vendorId: sourcingId, vendorName: z.string(), vendorActive: z.number().int(), currency: z.string().nullable(),
  defaultLeadTimeDays: nullableInteger, minimumOrderCents: nullableInteger, freeFreightThresholdCents: nullableInteger,
  revision: z.number().int().nonnegative(), policy: supplierSourcingPolicySchema,
  mapping: z.object({
    id: sourcingId, product_id: sourcingId, product_variant_id: sourcingId.nullable(), is_preferred: z.number().int().nullable(), is_active: z.number().int().nullable(),
    unit_cost_mills: nullableInteger, unit_cost_cents: nullableInteger, pricing_basis: z.enum(["legacy_unknown", "per_piece", "per_purchase_uom"]),
    purchase_uom: z.string().nullable(), quoted_unit_cost_mills: nullableInteger, pieces_per_purchase_uom: nullableInteger,
    pack_size: nullableInteger, moq: nullableInteger, lead_time_days: nullableInteger, quote_reference: z.string().nullable(),
    quoted_at: z.string().nullable(), quote_valid_until: z.string().nullable(), last_cost_mills: nullableInteger, last_cost_cents: nullableInteger,
    last_purchased_at: z.string().nullable(), updated_at: z.string(),
  }),
});
export type SupplierCandidate = z.infer<typeof supplierCandidateSchema>;

function rowForCandidate(source: PurchasingRecommendationRawRow, candidate: SupplierCandidate): PurchasingRecommendationRawRow {
  const mapping = candidate.mapping;
  const row: PurchasingRecommendationRawRow = { ...source, supplier_candidates: undefined, supplier_selection: undefined,
    vendor_product_id: mapping.id, preferred_vendor_id: candidate.vendorId, preferred_vendor_name: candidate.vendorName,
    vendor_currency: candidate.currency, vendor_minimum_order_cents: candidate.minimumOrderCents, vendor_free_freight_threshold_cents: candidate.freeFreightThresholdCents,
    vendor_lead_time_days: mapping.lead_time_days ?? candidate.defaultLeadTimeDays,
    estimated_cost_mills: mapping.unit_cost_mills, estimated_cost_cents: mapping.unit_cost_cents,
    vendor_pricing_basis: mapping.pricing_basis, vendor_purchase_uom: mapping.purchase_uom, vendor_quoted_unit_cost_mills: mapping.quoted_unit_cost_mills,
    vendor_pieces_per_purchase_uom: mapping.pieces_per_purchase_uom, vendor_pack_size: mapping.pack_size, vendor_moq: mapping.moq,
    vendor_quote_reference: mapping.quote_reference, vendor_quoted_at: mapping.quoted_at, vendor_quoted_at_date: mapping.quoted_at?.slice(0,10), vendor_quote_valid_until: mapping.quote_valid_until,
    last_cost_mills: mapping.last_cost_mills, last_cost_cents: mapping.last_cost_cents, vendor_product_last_purchased_at: mapping.last_purchased_at, vendor_product_updated_at: mapping.updated_at,
  };
  const list = candidate.policy.priceList;
  if (!list) return row;
  // The first price is used only to describe the quote's purchase unit while
  // calculating quantity. It is replaced/cleared before returning any result.
  const factor = BigInt(list.piecesPerPurchaseUom ?? 1);
  const numerator = BigInt(list.tiers[0].unitCostMills);
  const unitMills = Number((numerator * BigInt(2) + factor) / (factor * BigInt(2)));
  return { ...row, vendor_pricing_basis: list.basis, vendor_purchase_uom: list.purchaseUom,
    vendor_quoted_unit_cost_mills: list.tiers[0].unitCostMills, vendor_pieces_per_purchase_uom: list.piecesPerPurchaseUom,
    vendor_quote_reference: list.quoteReference, vendor_quoted_at: list.quotedAt, vendor_quoted_at_date: list.quotedAt.slice(0,10), vendor_quote_valid_until: list.validUntil,
    estimated_cost_mills: unitMills, estimated_cost_cents: millsToCents(unitMills) };
}
function applyTier(row: PurchasingRecommendationRawRow, tier: SupplierTierEvidence): PurchasingRecommendationRawRow {
  return { ...row, vendor_quoted_unit_cost_mills: tier.unitCostMills, estimated_cost_mills: tier.normalizedUnitCostMills, estimated_cost_cents: millsToCents(tier.normalizedUnitCostMills) };
}
function withoutSupplier(row: PurchasingRecommendationRawRow): PurchasingRecommendationRawRow {
  return { ...row, supplier_candidates: undefined, preferred_vendor_id: null, preferred_vendor_name: null, vendor_product_id: null,
    vendor_currency: null, vendor_minimum_order_cents: null, vendor_free_freight_threshold_cents: null, vendor_lead_time_days: null,
    vendor_pricing_basis: "legacy_unknown", vendor_purchase_uom: null, vendor_quoted_unit_cost_mills: null, vendor_pieces_per_purchase_uom: null,
    vendor_pack_size: null, vendor_moq: null, vendor_quote_reference: null, vendor_quoted_at: null, vendor_quoted_at_date: null, vendor_quote_valid_until: null,
    estimated_cost_mills: null, estimated_cost_cents: null, unit_cost_cents: null, last_cost_mills: null, last_cost_cents: null, vendor_product_last_purchased_at: null, vendor_product_updated_at: null };
}

export function prepareSupplierSourcingRow(source: PurchasingRecommendationRawRow, asOfDate: string, evaluate: (row: PurchasingRecommendationRawRow) => PurchasingRecommendationItem): PurchasingRecommendationRawRow {
  if (source.supplier_candidates === undefined) return source; // old immutable/fixture contracts remain readable
  const candidates = z.array(supplierCandidateSchema).max(100).parse(source.supplier_candidates);
  const evaluated = candidates.map((candidate) => {
    let row = rowForCandidate(source, candidate);
    const mapping = candidate.mapping;
    const rejectionReasons: string[] = [];
    if (candidate.vendorActive !== 1) rejectionReasons.push("supplier_inactive");
    if (mapping.is_active !== 1) rejectionReasons.push("mapping_inactive");
    if (!candidate.policy.eligibleForProposals) rejectionReasons.push("supplier_paused_for_proposals");
    if (mapping.product_id !== Number(source.product_id) || (mapping.product_variant_id !== null && mapping.product_variant_id !== Number(source.variant_id))) rejectionReasons.push("receive_variant_mismatch");
    if (mapping.moq === 0 || mapping.pack_size === 0 || mapping.pieces_per_purchase_uom === 0) rejectionReasons.push("invalid_quantity_rules");
    const result = evaluate(row);
    const pricingReviewReasons: string[] = [];
    let tier: SupplierTierEvidence | null = null;
    if (candidate.policy.priceList && result.suggestedOrderPieces > 0) {
      const selection = selectSupplierPriceTier({ vendorProductId: mapping.id, revision: candidate.revision, priceList: candidate.policy.priceList,
        pieces: result.suggestedOrderPieces, asOfDate, currency: candidate.currency ?? "" });
      tier = selection.evidence;
      if (selection.rejection) pricingReviewReasons.push(selection.rejection);
      row = tier ? applyTier(row, tier) : { ...row, estimated_cost_mills: null, estimated_cost_cents: null, unit_cost_cents: null, vendor_quoted_unit_cost_mills: null, last_cost_mills: null, last_cost_cents: null };
    } else if (candidate.policy.priceList) {
      // A zero buy has no applicable quantity tier. Keep the unit identity for
      // display, but never advertise a threshold price for a nonexistent buy.
      row = { ...row, estimated_cost_mills: null, estimated_cost_cents: null, vendor_quoted_unit_cost_mills: null };
      pricingReviewReasons.push("no_purchase_quantity");
    } else if (result.supplierBasis.costQuality !== "current" || result.supplierBasis.pricingBasis === "legacy_unknown") {
      pricingReviewReasons.push(`quote_${result.supplierBasis.costQuality}`);
    }
    if (candidate.currency !== "USD") pricingReviewReasons.push("purchase_currency_review_required");
    const option: SupplierSourcingOption = {
      vendorProductId: mapping.id, vendorId: candidate.vendorId, vendorName: candidate.vendorName,
      preferred: mapping.is_preferred === 1, priority: candidate.policy.priority, revision: candidate.revision,
      eligible: rejectionReasons.length === 0, rejectionReasons, pricingReviewReasons, currency: candidate.currency,
      minimumOrderPieces: mapping.moq && mapping.moq > 0 ? mapping.moq : null,
      orderIncrementPieces: Math.max(1, candidate.policy.priceList?.piecesPerPurchaseUom ?? mapping.pieces_per_purchase_uom ?? mapping.pack_size ?? 1),
      leadTimeDays: result.leadTimeDays, proposedPieces: result.suggestedOrderPieces,
      estimatedUnitCostMills: tier?.normalizedUnitCostMills ?? (pricingReviewReasons.length ? null : result.estimatedCostMills), tier,
    };
    return { row, option, variantSpecific: mapping.product_variant_id !== null };
  }).sort((a,b) => Number(b.option.eligible) - Number(a.option.eligible)
    || Number(b.option.preferred) - Number(a.option.preferred)
    || a.option.priority - b.option.priority
    || Number(b.variantSpecific) - Number(a.variantSpecific)
    || a.option.leadTimeDays - b.option.leadTimeDays
    || a.option.vendorId - b.option.vendorId || a.option.vendorProductId - b.option.vendorProductId);
  const selected = evaluated.find((entry) => entry.option.eligible);
  const evidence = supplierSelectionEvidenceSchema.parse({ version: 1, selectedVendorProductId: selected?.option.vendorProductId ?? null,
    method: selected ? selected.option.preferred ? "preferred" : "ranked_alternate" : "none",
    rankBasis: "preferred_then_priority_then_variant_then_lead_time_then_identity", priceComparison: "not_performed", options: evaluated.map((entry) => entry.option) });
  return { ...(selected?.row ?? withoutSupplier(source)), supplier_selection: evidence };
}
