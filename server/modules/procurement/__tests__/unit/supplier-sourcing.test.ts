import { describe, expect, it } from "vitest";
import { DEFAULT_SUPPLIER_SOURCING_POLICY, selectSupplierPriceTier, supplierPriceListSchema, supplierSourcingUpdateSchema, type SupplierPriceList } from "@shared/procurement/supplier-sourcing";
import { generatePurchasingRecommendations } from "../../purchasing-recommendation.engine";
import type { SupplierCandidate } from "../../supplier-sourcing-selection";

export const priceList: SupplierPriceList = { currency: "USD", basis: "per_purchase_uom", purchaseUom: "case", piecesPerPurchaseUom: 50, quoteReference: "SUPPLIER-Q-001", quotedAt: "2026-09-01T12:00:00Z", validFrom: "2026-09-01", validUntil: "2026-10-31", tiers: [{ minimumQuantity: 1, unitCostMills: 100001 }, { minimumQuantity: 10, unitCostMills: 90001 }] };
const select = (pieces: number, patch: Partial<Parameters<typeof selectSupplierPriceTier>[0]> = {}) => selectSupplierPriceTier({ vendorProductId: 1, revision: 1, priceList, pieces, asOfDate: "2026-09-07", currency: "USD", ...patch });
export function supplier(id = 1, patch: Partial<SupplierCandidate> = {}): SupplierCandidate {
  return { vendorId: id, vendorName: `Supplier ${id}`, vendorActive: 1, currency: "USD", defaultLeadTimeDays: 10, minimumOrderCents: 0, freeFreightThresholdCents: null,
    revision: 1, policy: { ...DEFAULT_SUPPLIER_SOURCING_POLICY, priceList },
    mapping: { id, product_id: 10, product_variant_id: null, is_preferred: id === 1 ? 1 : 0, is_active: 1, unit_cost_mills: 2000, unit_cost_cents: 20, pricing_basis: "per_piece", purchase_uom: null,
      quoted_unit_cost_mills: 2000, pieces_per_purchase_uom: null, pack_size: 1, moq: 1, lead_time_days: 10, quote_reference: "LEGACY-BASE", quoted_at: "2026-09-01T00:00:00Z", quote_valid_until: "2026-10-31", last_cost_mills: null, last_cost_cents: null, last_purchased_at: null, updated_at: "2026-09-01T00:00:00Z" }, ...patch };
}
export const rawRow = { product_id: 10, variant_id: 100, base_sku: "SYNTHETIC-SKU", product_name: "Synthetic product", total_pieces: 0, total_reserved_pieces: 0, total_outbound_pieces: 60, previous_outbound_pieces: 60, demand_order_count: 20, demand_active_days: 15, latest_demand_at: "2026-09-06T12:00:00Z", on_order_pieces: 0, open_po_count: 0, safety_stock_days: 0, recommendation_analysis_date: "2026-09-07", inbound_schedule: [], receipt_supply_evidence: { version: 1, lines: [] } };
function recommend(candidates: SupplierCandidate[], patch = {}) { return generatePurchasingRecommendations({ asOf: "2026-09-07T12:00:00Z", lookbackDays: 30, rows: [{ ...rawRow, ...patch, supplier_candidates: candidates }] }).items[0]; }

describe("quantity price contracts and exact selection", () => {
  it("selects thresholds inclusively without buying to earn a discount", () => {
    expect(select(450).evidence).toMatchObject({ evaluatedQuantity: 9, tierIndex: 0, unitCostMills: 100001, totalProductCostCents: 9000 });
    expect(select(500).evidence).toMatchObject({ evaluatedQuantity: 10, tierIndex: 1, unitCostMills: 90001, totalProductCostCents: 9000 });
    expect(select(550).evidence?.evaluatedPieces).toBe(550);
  });
  it("retains exact source and UOM with fractional per-piece pricing", () => {
    expect(select(150).evidence).toMatchObject({ totalProductCostCents: 3000, normalizedUnitCostMills: 2000, priceList });
  });
  it.each([["2026-08-31","quote_not_yet_valid"],["2026-11-01","quote_expired"]])("rejects invalid quote date %s", (asOfDate,rejection) => { expect(select(50,{ asOfDate })).toEqual({ evidence: null,rejection }); });
  it("accepts the explicit final validity date", () => { expect(select(50,{asOfDate:"2026-10-31"}).rejection).toBeNull(); });
  it("never applies an exchange rate or compares currency quotes", () => { expect(select(50,{currency:"EUR"}).rejection).toBe("currency_mismatch"); });
  it("rejects partial UOMs, quantities below the first tier and overflows", () => {
    expect(select(49).rejection).toBe("purchase_unit_mismatch");
    expect(select(50,{ priceList:{ ...priceList,tiers:[{minimumQuantity:10,unitCostMills:1000}] } }).rejection).toBe("below_first_price_tier");
    expect(select(100,{priceList:{ ...priceList,tiers:[{minimumQuantity:1,unitCostMills:Number.MAX_SAFE_INTEGER}] }}).rejection).toBe("price_overflow");
  });
  it("supports an explicit zero quote and refuses missing precision", () => {
    expect(select(50,{priceList:{...priceList,tiers:[{minimumQuantity:1,unitCostMills:0}]}}).evidence?.totalProductCostCents).toBe(0);
    expect(() => select(0)).toThrow(); expect(() => select(1.5)).toThrow();
    expect(supplierPriceListSchema.safeParse({...priceList,tiers:[{minimumQuantity:1,unitCostMills:0.5}]}).success).toBe(false);
  });
  it("requires explicit validity, source, UOM and unique ordered thresholds", () => {
    for (const patch of [{validUntil:null},{quoteReference:""},{purchaseUom:null},{piecesPerPurchaseUom:0},{tiers:[{minimumQuantity:1,unitCostMills:1},{minimumQuantity:1,unitCostMills:2}]}]) expect(supplierPriceListSchema.safeParse({...priceList,...patch}).success).toBe(false);
    expect(supplierSourcingUpdateSchema.safeParse({expectedRevision:0,idempotencyKey:"bad",reason:"no",policy:DEFAULT_SUPPLIER_SOURCING_POLICY}).success).toBe(false);
  });
  it("does not mutate source price lists", () => { const frozen = Object.freeze({...priceList,tiers:Object.freeze(priceList.tiers.map((tier) => Object.freeze({...tier})))}) as unknown as SupplierPriceList; select(50,{priceList:frozen}); expect(frozen).toEqual(priceList); });
});

describe("supplier-specific procurement planning", () => {
  it("prices the needed case without increasing it to the discounted threshold", () => {
    const result = recommend([supplier()]);
    expect(result).toMatchObject({ suggestedOrderPieces:50, preferredVendorId:1, estimatedCostMills:2000 });
    expect(result.supplierBasis.sourcingSelection?.options[0].tier).toMatchObject({tierIndex:0,evaluatedPieces:50});
  });
  it("keeps the preferred supplier ahead of a lower price and priority", () => {
    const alternate = supplier(2,{ policy:{...DEFAULT_SUPPLIER_SOURCING_POLICY,priority:0,priceList:{...priceList,tiers:[{minimumQuantity:1,unitCostMills:0}]}} });
    expect(recommend([alternate,supplier()]).preferredVendorId).toBe(1);
  });
  it("chooses a deterministic eligible alternate when preferred is paused", () => {
    const paused = supplier(1,{policy:{...DEFAULT_SUPPLIER_SOURCING_POLICY,eligibleForProposals:false,priceList}});
    const result = recommend([supplier(3),paused,supplier(2)]);
    expect(result.preferredVendorId).toBe(2);
    expect(result.supplierBasis.sourcingSelection).toMatchObject({method:"ranked_alternate",priceComparison:"not_performed"});
    expect(result.qualityControls.map((entry)=>entry.code)).toContain("ranked_alternate_review");
    expect(result.supplierBasis.sourcingSelection?.options.find((entry)=>entry.vendorId===1)?.rejectionReasons).toContain("supplier_paused_for_proposals");
    expect(result.qualityGate.autoDraftEligible).toBe(false);
  });
  it("uses each supplier's lead time, MOQ and order multiple before ranking", () => {
    const alternative = supplier(2); alternative.mapping.lead_time_days=80; alternative.mapping.moq=200;
    const result=recommend([supplier(),alternative]);
    expect(result.supplierBasis.sourcingSelection?.options.map((entry)=>entry.proposedPieces)).toEqual([50,200]);
  });
  it("rejects inactive or incompatible identities and retains their reasons", () => {
    const mismatch=supplier(1); mismatch.mapping.product_variant_id=999;
    const inactive=supplier(2,{vendorActive:0});
    const result=recommend([mismatch,inactive]);
    expect(result.preferredVendorId).toBeNull();
    expect(result.supplierBasis.sourcingSelection?.method).toBe("none");
    expect(result.supplierBasis.sourcingSelection?.options.flatMap((entry)=>entry.rejectionReasons)).toEqual(expect.arrayContaining(["receive_variant_mismatch","supplier_inactive"]));
  });
  it("retains invalid quantity rules as a rejected supplier instead of failing the recommendation", () => {
    const invalid = supplier(); invalid.mapping.moq = 0; invalid.mapping.pack_size = 0;
    const result = recommend([invalid, supplier(2)]);
    expect(result.preferredVendorId).toBe(2);
    expect(result.supplierBasis.sourcingSelection?.options.find((option) => option.vendorId === 1)?.rejectionReasons).toContain("invalid_quantity_rules");
  });
  it("shows expired tiers as unpriced RFQ proposals instead of using old catalog economics", () => {
    const candidate=supplier(1,{policy:{...DEFAULT_SUPPLIER_SOURCING_POLICY,priceList:{...priceList,validUntil:"2026-09-02"}}});
    const result=recommend([candidate]);
    expect(result.estimatedCostMills).toBeNull();
    expect(result.supplierBasis.sourcingSelection?.options[0].pricingReviewReasons).toContain("quote_expired");
    expect(result.qualityGate.autoDraftEligible).toBe(false);
  });
  it("does not invent a tier price for zero purchases", () => { const result=recommend([supplier()],{total_pieces:1000}); expect(result.suggestedOrderPieces).toBe(0); expect(result.estimatedCostMills).toBeNull(); });
});
