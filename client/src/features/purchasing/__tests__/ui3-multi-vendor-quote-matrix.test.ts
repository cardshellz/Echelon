import { describe, expect, it } from "vitest";
import type { SupplierSourcingOption } from "@shared/procurement/supplier-sourcing";
import {
  SOLO_FAST_TRACK_DECISION_NOTE,
  buildNewEditablePoHref,
  buildSoloConfirmAcknowledgement,
  formatOptionCents,
  formatOptionMills,
  hasPendingSoloConfirmRequirements,
  rankAndAnnotateSupplierOptions,
} from "../multi-vendor-quote-helpers";
import {
  firstUnmetConfirmRequirement,
  type ConfirmPoLineInput,
  type ConfirmRfqLineInput,
} from "../reorderEngine";

function makeOption(overrides: Partial<SupplierSourcingOption> = {}): SupplierSourcingOption {
  return {
    vendorProductId: 10,
    vendorId: 1,
    vendorName: "Primary Card Co",
    preferred: true,
    priority: 100,
    revision: 1,
    eligible: true,
    rejectionReasons: [],
    pricingReviewReasons: [],
    currency: "USD",
    leadTimeDays: 30,
    minimumOrderPieces: 500,
    orderIncrementPieces: 100,
    proposedPieces: 1000,
    estimatedUnitCostMills: 8500, // $0.8500 / pc
    tier: {
      vendorProductId: 10,
      revision: 1,
      evaluatedPieces: 1000,
      evaluatedQuantity: 10,
      tierIndex: 1,
      minimumQuantity: 10,
      unitCostMills: 850_000, // $85.0000 / Case of 100
      normalizedUnitCostMills: 8500,
      totalProductCostCents: 85_000, // $850.00
      priceList: {
        currency: "USD",
        basis: "per_purchase_uom",
        purchaseUom: "Case",
        piecesPerPurchaseUom: 100,
        quoteReference: "Q-2026-01",
        quotedAt: "2026-09-01T00:00:00Z",
        validFrom: "2026-09-01",
        validUntil: "2026-12-31",
        tiers: [
          { minimumQuantity: 1, unitCostMills: 920_000 },
          { minimumQuantity: 10, unitCostMills: 850_000 },
          { minimumQuantity: 50, unitCostMills: 790_000 },
        ],
      },
    },
    ...overrides,
  };
}

describe("UI-3 Multi-Vendor Quote Matrix & Solo Buying Desk helpers", () => {
  describe("rankAndAnnotateSupplierOptions", () => {
    it("identifies best USD price, fastest lead time, pack quote, and volume break tiers", () => {
      const primary = makeOption();
      const fasterPremium = makeOption({
        vendorProductId: 20,
        vendorId: 2,
        vendorName: "Express Print Domestic",
        preferred: false,
        priority: 50,
        leadTimeDays: 10,
        minimumOrderPieces: null,
        orderIncrementPieces: 1,
        proposedPieces: 1000,
        estimatedUnitCostMills: 11_250, // $1.1250 / pc
        tier: null,
      });
      const rejected = makeOption({
        vendorProductId: 30,
        vendorId: 3,
        vendorName: "Inactive Overseas",
        preferred: false,
        eligible: false,
        rejectionReasons: ["quote_expired"],
        leadTimeDays: 5,
        estimatedUnitCostMills: 5000,
        tier: null,
      });

      const annotated = rankAndAnnotateSupplierOptions(
        [primary, fasterPremium, rejected],
        10,
        "2026-10-15",
      );

      expect(annotated).toHaveLength(3);

      // Primary is selected and has the best eligible USD price ($0.8500 vs $1.1250)
      expect(annotated[0].isSelected).toBe(true);
      expect(annotated[0].isBestPrice).toBe(true);
      expect(annotated[0].isFastestLeadTime).toBe(false);
      expect(annotated[0].formattedUnitCost).toBe("$0.8500/pc");
      expect(annotated[0].formattedPackQuote).toBe("$85.0000 / Case (100 pc)");
      expect(annotated[0].formattedLineTotal).toBe("$850");
      expect(annotated[0].moqLabel).toBe("MOQ 500 pc");
      expect(annotated[0].incrementLabel).toBe("Mult 100 pc");
      expect(annotated[0].quoteStatus).toEqual({
        label: "Valid thru 2026-12-31",
        tone: "green",
      });
      expect(annotated[0].tierSummaries).toEqual([
        { label: "1+ Case: $92.0000", isActive: false },
        { label: "10+ Case: $85.0000", isActive: true },
        { label: "50+ Case: $79.0000", isActive: false },
      ]);

      // Second supplier has the fastest eligible lead time (10d vs 30d; rejected 5d is ignored)
      expect(annotated[1].isSelected).toBe(false);
      expect(annotated[1].isBestPrice).toBe(false);
      expect(annotated[1].isFastestLeadTime).toBe(true);
      expect(annotated[1].moqLabel).toBe("No MOQ");
      expect(annotated[1].incrementLabel).toBe("1 pc increments");
      expect(annotated[1].quoteStatus).toEqual({
        label: "Catalog estimate",
        tone: "amber",
      });

      // Rejected supplier never wins best-price or fastest-lead badges
      expect(annotated[2].isBestPrice).toBe(false);
      expect(annotated[2].isFastestLeadTime).toBe(false);
      expect(annotated[2].quoteStatus).toEqual({
        label: "Rejected: quote expired",
        tone: "red",
      });
    });

    it("never emits a dollar sign for foreign currencies or currencyCodeOnly mode", () => {
      const eurOption = makeOption({
        currency: "EUR",
        estimatedUnitCostMills: 12_500,
        tier: null,
      });
      const usdOption = makeOption({
        vendorProductId: 11,
        currency: "USD",
        estimatedUnitCostMills: 12_500,
        tier: null,
      });

      expect(formatOptionMills(12_500, "EUR")).toBe("1.2500 EUR");
      expect(formatOptionCents(125_000, "EUR")).toBe("1,250 EUR");

      const eurAnnotated = rankAndAnnotateSupplierOptions([eurOption], 10);
      expect(eurAnnotated[0].formattedUnitCost).toBe("1.2500 EUR/pc");
      expect(eurAnnotated[0].formattedLineTotal).toBe("1,250 EUR");
      expect(JSON.stringify(eurAnnotated)).not.toContain("$");

      const codeOnly = rankAndAnnotateSupplierOptions([usdOption], 11, undefined, true);
      expect(codeOnly[0].formattedUnitCost).toBe("1.2500 USD/pc");
      expect(codeOnly[0].formattedLineTotal).toBe("1,250 USD");
      expect(JSON.stringify(codeOnly)).not.toContain("$");
    });
  });

  describe("buildNewEditablePoHref", () => {
    it("preloads vendor_id and optional variant_ids for PurchaseOrderEdit", () => {
      expect(buildNewEditablePoHref({ vendorId: 42 })).toBe(
        "/purchase-orders/new?vendor_id=42",
      );
      expect(buildNewEditablePoHref({ vendorId: 42, productVariantId: 108 })).toBe(
        "/purchase-orders/new?vendor_id=42&variant_ids=108",
      );
      expect(buildNewEditablePoHref({ vendorId: 42, productVariantId: null })).toBe(
        "/purchase-orders/new?vendor_id=42",
      );
    });
  });

  describe("Solo Fast-Track Order Builder confirmation", () => {
    const flaggedPoLines: ConfirmPoLineInput[] = [
      {
        recommendationId: "rec-1",
        sku: "CARD-SLEEVE-100",
        pieces: 2000,
        suggestedOrderPieces: 1500,
        exceedReason: "Topping up to hit volume price break",
        controls: [
          { code: "stale_supplier_cost", label: "Supplier cost is older than 90 days" },
          { code: "thin_history", label: "Thin demand history" },
        ],
      },
    ];
    const rfqLines: ConfirmRfqLineInput[] = [
      {
        recommendationId: "rec-2",
        sku: "TOPLOADER-35PT",
        pieces: 600,
        baselinePieces: 400,
        exceedReason: "Holiday promo buffer",
      },
    ];

    it("detects pending confirm ceremony and satisfies firstUnmetConfirmRequirement in one click", () => {
      expect(
        hasPendingSoloConfirmRequirements({
          poLines: flaggedPoLines,
          rfqLines,
          acknowledgedControlKeys: new Set(),
          approvedExceptionIds: new Set(),
          note: "",
        }),
      ).toBe(true);

      const applied = buildSoloConfirmAcknowledgement({
        poLines: flaggedPoLines,
        rfqLines,
        currentAckedControls: new Set(),
        currentApprovedExceptions: new Set(),
        currentNote: "",
      });

      expect(applied.decisionNote).toBe(SOLO_FAST_TRACK_DECISION_NOTE);
      expect(applied.decisionNote.length).toBeGreaterThanOrEqual(10);

      // Verify the resulting state passes the exact Order Builder confirm gate!
      expect(
        firstUnmetConfirmRequirement({
          poLines: flaggedPoLines,
          rfqLines,
          acknowledgedControlKeys: applied.ackedControls,
          approvedExceptionIds: applied.approvedExceptions,
          note: applied.decisionNote,
        }),
      ).toBeNull();

      expect(
        hasPendingSoloConfirmRequirements({
          poLines: flaggedPoLines,
          rfqLines,
          acknowledgedControlKeys: applied.ackedControls,
          approvedExceptionIds: applied.approvedExceptions,
          note: applied.decisionNote,
        }),
      ).toBe(false);
    });

    it("preserves an operator-written note when it already meets the 10-character minimum", () => {
      const customNote = "Confirmed Q4 restock pricing with rep on phone";
      const applied = buildSoloConfirmAcknowledgement({
        poLines: flaggedPoLines,
        rfqLines: [],
        currentAckedControls: new Set(),
        currentApprovedExceptions: new Set(),
        currentNote: customNote,
      });

      expect(applied.decisionNote).toBe(customNote);
    });
  });
});
