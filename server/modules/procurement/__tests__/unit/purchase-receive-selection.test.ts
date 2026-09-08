import { describe, expect, it } from "vitest";
import {
  hasVerifiedUniqueReceiveSelection,
  purchaseReceiveSelectionSchema,
  type PurchaseReceiveSelection,
} from "@shared/procurement/purchase-receive-selection";
import {
  generatePurchasingRecommendations,
  type PurchasingRecommendationRawRow,
} from "../../purchasing-recommendation.engine";

const unique: PurchaseReceiveSelection = {
  version: 1, highestHierarchyLevel: 3, candidateCount: 1, selectedVariantId: 101,
};
const ambiguous: PurchaseReceiveSelection = {
  version: 1, highestHierarchyLevel: 3, candidateCount: 2, selectedVariantId: null,
};
const missing: PurchaseReceiveSelection = {
  version: 1, highestHierarchyLevel: null, candidateCount: 0, selectedVariantId: null,
};

function row(overrides: Partial<PurchasingRecommendationRawRow> = {}): PurchasingRecommendationRawRow {
  return {
    product_id: 10, variant_id: 101, receive_variant_selection: unique,
    base_sku: "SYNTHETIC-RECEIVE", product_name: "Synthetic receiving selection",
    total_pieces: 0, total_reserved_pieces: 0,
    total_outbound_pieces: 60, previous_outbound_pieces: 60,
    demand_order_count: 12, demand_active_days: 10,
    latest_demand_at: "2026-05-18T12:00:00.000Z",
    on_order_pieces: 0, open_po_count: 0,
    lead_time_days: 14, vendor_lead_time_days: 2, safety_stock_days: 1,
    order_uom_units: 5_000, order_uom_level: 3,
    preferred_vendor_id: 80, preferred_vendor_name: "Synthetic supplier", vendor_product_id: 8_010,
    vendor_currency: "USD", vendor_pricing_basis: "per_piece",
    vendor_purchase_uom: null, vendor_pieces_per_purchase_uom: null,
    vendor_quoted_unit_cost_mills: 50, estimated_cost_mills: 50,
    vendor_moq: 1, vendor_pack_size: 1,
    vendor_quote_reference: "SYNTHETIC-QUOTE", vendor_quote_valid_until: "2026-06-30",
    vendor_quoted_at: "2026-05-18T12:00:00.000Z",
    vendor_product_updated_at: "2026-05-18T12:00:00.000Z",
    ...overrides,
  };
}

function analyze(input: PurchasingRecommendationRawRow): ReturnType<typeof generatePurchasingRecommendations> {
  return generatePurchasingRecommendations({
    rows: [input], lookbackDays: 30, asOf: "2026-05-20T12:00:00.000Z", requireVendor: true,
  });
}

describe("versioned purchase receive-selection evidence", () => {
  it.each([
    { name: "unique", evidence: unique },
    { name: "ambiguous", evidence: ambiguous },
    { name: "missing", evidence: missing },
    { name: "maximum PostgreSQL identity", evidence: { ...unique, selectedVariantId: 2_147_483_647 } },
  ])("accepts a coherent $name capture", ({ evidence }) => {
    expect(purchaseReceiveSelectionSchema.parse(evidence)).toEqual(evidence);
  });

  const invalidEvidence: Array<{ name: string; evidence: unknown }> = [
    { name: "absent capture", evidence: undefined },
    { name: "null capture", evidence: null },
    { name: "unknown version", evidence: { ...unique, version: 2 } },
    { name: "unknown field", evidence: { ...unique, guessed: true } },
    { name: "fractional hierarchy", evidence: { ...unique, highestHierarchyLevel: 1.5 } },
    { name: "string hierarchy", evidence: { ...unique, highestHierarchyLevel: "3" } },
    { name: "negative count", evidence: { ...ambiguous, candidateCount: -1 } },
    { name: "fractional count", evidence: { ...ambiguous, candidateCount: 1.5 } },
    { name: "overflow count", evidence: { ...ambiguous, candidateCount: 2_147_483_648 } },
    { name: "string count", evidence: { ...unique, candidateCount: "1" } },
    { name: "zero identity", evidence: { ...unique, selectedVariantId: 0 } },
    { name: "overflow identity", evidence: { ...unique, selectedVariantId: 2_147_483_648 } },
    { name: "string identity", evidence: { ...unique, selectedVariantId: "101" } },
    { name: "unique without identity", evidence: { ...unique, selectedVariantId: null } },
    { name: "tie with chosen identity", evidence: { ...ambiguous, selectedVariantId: 101 } },
    { name: "no candidates with a hierarchy", evidence: { ...missing, highestHierarchyLevel: 3 } },
    { name: "candidate with no hierarchy", evidence: { ...unique, highestHierarchyLevel: null } },
    { name: "no candidates with an identity", evidence: { ...missing, selectedVariantId: 101 } },
  ];

  it.each(invalidEvidence)("rejects $name", ({ evidence }) => {
    expect(purchaseReceiveSelectionSchema.safeParse(evidence).success).toBe(false);
    expect(hasVerifiedUniqueReceiveSelection(evidence, 101)).toBe(false);
  });

  it("authorizes only the matching unique identity", () => {
    expect(hasVerifiedUniqueReceiveSelection(unique, 101)).toBe(true);
    for (const identity of [undefined, null, 0, -1, 102, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(hasVerifiedUniqueReceiveSelection(unique, identity)).toBe(false);
    }
    for (const evidence of [missing, ambiguous]) {
      for (const identity of [undefined, null, 101]) {
        expect(hasVerifiedUniqueReceiveSelection(evidence, identity)).toBe(false);
      }
    }
  });
});

describe("receiving ambiguity in the actual recommendation engine", () => {
  it("retains a verified unique identity without adding a receive blocker", () => {
    const result = analyze(row());
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ productVariantId: 101, receiveVariantSelection: unique });
    expect(result.items[0].qualityControls.some((control) => control.area === "receive_configuration")).toBe(false);
  });

  it("does not guess a variant for a tie and emits a hard, explicit blocker", () => {
    const result = analyze(row({ variant_id: null, receive_variant_selection: ambiguous, order_uom_units: null }));
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item.productVariantId).toBeUndefined();
    expect(item.receiveVariantSelection).toEqual(ambiguous);
    expect(item.qualityGate.autoDraftEligible).toBe(false);
    const blocker = item.autopilotBlockers.find((control) => control.code === "ambiguous_receive_configuration");
    expect(blocker).toMatchObject({ area: "receive_configuration", severity: "block", label: "Choose a receiving unit" });
    expect(blocker?.detail).toContain("2 active receiving configurations");
    expect(blocker?.detail).toContain("Automatic drafting is held");
  });

  it("keeps a tied product and its cause visible with no demand and no supplier", () => {
    const result = analyze(row({
      variant_id: null, receive_variant_selection: ambiguous, order_uom_units: null,
      total_outbound_pieces: 0, previous_outbound_pieces: 0, demand_order_count: 0,
      demand_active_days: 0, latest_demand_at: null,
      preferred_vendor_id: null, preferred_vendor_name: null, vendor_product_id: null,
      vendor_lead_time_days: null, estimated_cost_mills: null, vendor_quoted_unit_cost_mills: null,
      vendor_pricing_basis: null, vendor_quote_reference: null, vendor_quoted_at: null,
    }));
    expect(result.summary).toMatchObject({ totalProducts: 1, autoDraftEligibleCount: 0 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ preferredVendorId: null, receiveVariantSelection: ambiguous });
    expect(result.items[0].productVariantId).toBeUndefined();
    expect(result.items[0].qualityControls).toContainEqual(expect.objectContaining({
      area: "receive_configuration", severity: "block", code: "ambiguous_receive_configuration",
    }));
  });

  it("retains missing configuration without creating a variant identity", () => {
    const result = analyze(row({ variant_id: null, receive_variant_selection: missing, order_uom_units: null }));
    expect(result.items[0].productVariantId).toBeUndefined();
    expect(result.items[0].receiveVariantSelection).toEqual(missing);
    expect(result.items[0].qualityGate.autoDraftEligible).toBe(false);
    expect(result.items[0].qualityControls).toContainEqual(expect.objectContaining({
      code: "missing_receive_configuration", severity: "block",
    }));
  });

  it.each([
    { name: "mismatched unique capture", selection: unique, variantId: 102 },
    { name: "chosen identity despite a tie", selection: ambiguous, variantId: 101 },
    { name: "chosen identity despite no candidates", selection: missing, variantId: 101 },
  ])("rejects $name instead of mixing evidence", ({ selection, variantId }) => {
    expect(() => analyze(row({ receive_variant_selection: selection, variant_id: variantId })))
      .toThrow("receive selection does not match its captured variant");
  });

  it.each([1, 500, 5_000])("uses supplier commercial units independently of receiving pack size %i", (receivingPack) => {
    const perPiece = analyze(row({ order_uom_units: receivingPack })).items[0];
    expect(perPiece).toMatchObject({ orderUomUnits: 1, orderUomLabel: "pieces",
      suggestedOrderQty: 6, suggestedOrderPieces: 6 });

    const supplierPack = analyze(row({ order_uom_units: receivingPack,
      vendor_pricing_basis: "per_purchase_uom", vendor_purchase_uom: "pack",
      vendor_pieces_per_purchase_uom: 6, vendor_quoted_unit_cost_mills: 300,
    })).items[0];
    expect(supplierPack).toMatchObject({ orderUomUnits: 6, orderUomLabel: "pack",
      suggestedOrderQty: 1, suggestedOrderPieces: 6 });

    const commercialMultiple = analyze(row({ order_uom_units: receivingPack, vendor_pack_size: 24 })).items[0];
    expect(commercialMultiple).toMatchObject({ orderUomUnits: 1, orderUomLabel: "pieces",
      suggestedOrderQty: 24, suggestedOrderPieces: 24 });
  });
});
