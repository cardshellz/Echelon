import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: {},
  procurement: {
    createAutoDraftRun: vi.fn(),
    getAutoDraftSettings: vi.fn(),
    getReorderAnalysisData: vi.fn(),
    updateAutoDraftRun: vi.fn(),
  },
  inventory: {
    getVelocityLookbackDays: vi.fn(),
  },
  context: {
    load: vi.fn(),
  },
  handoff: {
    createAutomaticHandoff: vi.fn(),
  },
  lifecycle: {
    startRun: vi.fn(),
    heartbeatRun: vi.fn(),
    completeRun: vi.fn(),
    failRun: vi.fn(),
  },
  stalePoEscalation: {
    run: vi.fn(),
  },
}));

vi.mock("../../../db", () => ({ db: mocks.db }));
vi.mock("../../../modules/procurement/procurement.storage", () => ({
  procurementMethods: mocks.procurement,
}));
vi.mock("../../../modules/inventory", () => ({
  inventoryStorage: mocks.inventory,
}));
vi.mock("../../../modules/procurement/purchasing-recommendation-context.service", () => ({
  loadPurchasingRecommendationContext: mocks.context.load,
}));
vi.mock("../../../modules/procurement/recommendation-po-handoff.repository", () => ({
  createDrizzleRecommendationPoHandoffRepository: () => ({}),
}));
vi.mock("../../../modules/procurement/auto-draft-run-lifecycle.repository", () => ({
  createDrizzleAutoDraftRunLifecycleRepository: () => ({}),
}));
vi.mock("../../../modules/procurement/auto-draft-run-lifecycle.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../modules/procurement/auto-draft-run-lifecycle.service")>();
  return {
    ...actual,
    createAutoDraftRunLifecycleService: () => mocks.lifecycle,
  };
});
vi.mock("../../../modules/procurement/recommendation-po-handoff.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../modules/procurement/recommendation-po-handoff.service")>();
  return {
    ...actual,
    createRecommendationPoHandoffService: () => mocks.handoff,
  };
});
vi.mock("../../../modules/procurement/auto-draft-po-escalation.service", () => ({
  runStaleAutoDraftPoEscalationCheck: mocks.stalePoEscalation.run,
}));

import {
  previewAutomaticPurchasingPilot,
  runAutoDraftJob,
} from "../../auto-draft.job";

function recommendationRows() {
  return [{
    product_id: 1,
    variant_id: 11,
    base_sku: "HIGH-1",
    product_name: "High Confidence Product",
    total_pieces: 0,
    total_reserved_pieces: 0,
    total_outbound_pieces: 60,
    previous_outbound_pieces: 55,
    demand_order_count: 12,
    demand_active_days: 10,
    on_order_pieces: 0,
    open_po_count: 0,
    lead_time_days: 4,
    vendor_lead_time_days: 4,
    safety_stock_days: 1,
    order_uom_units: 10,
    order_uom_level: 2,
    vendor_product_id: 701,
    preferred_vendor_id: 7,
    estimated_cost_mills: 50,
    vendor_pricing_basis: "per_piece",
    vendor_purchase_uom: null,
    vendor_quoted_unit_cost_mills: 50,
    vendor_pieces_per_purchase_uom: null,
    vendor_quote_reference: "QUOTE-701",
    vendor_quoted_at: new Date().toISOString(),
    vendor_quote_valid_until: "2099-12-31",
    vendor_product_updated_at: new Date().toISOString(),
  }];
}

describe("auto-draft job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lifecycle.startRun.mockResolvedValue({
      run: {
        id: 500,
        runAt: new Date("2026-07-11T18:00:00.000Z"),
        status: "running",
      },
      interruptedRunIds: [],
    });
    mocks.lifecycle.heartbeatRun.mockResolvedValue({ id: 500, status: "running" });
    mocks.lifecycle.completeRun.mockResolvedValue({ id: 500, status: "success" });
    mocks.lifecycle.failRun.mockResolvedValue({ run: { id: 500, status: "error" }, transitioned: true });
    mocks.procurement.getAutoDraftSettings.mockResolvedValue({
      autoDraftMode: "draft_po",
      approvalPolicy: "high_confidence_only",
      includeOrderSoon: false,
      skipOnOpenPo: true,
      skipNoVendor: true,
    });
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(90);
    mocks.procurement.getReorderAnalysisData.mockResolvedValue(recommendationRows());
    mocks.context.load.mockResolvedValue({
      defaults: { leadTimeDays: 14, safetyStockDays: 7 },
      rules: [],
      productMetaById: new Map(),
    });
    mocks.handoff.createAutomaticHandoff.mockResolvedValue({
      pos: [{ id: 700, vendorId: 7, poNumber: "PO-20260711-001" }],
      decisions: [],
      handedOff: [{
        acceptedDecisionId: 800,
        handoffDecisionId: 801,
        recommendationId: "1:11:90",
        kind: "auto_draft_eligible",
        sku: "HIGH-1",
        poId: 700,
        poLineId: 701,
        poIds: [700],
      }],
      skipped: [],
    });
    mocks.stalePoEscalation.run.mockResolvedValue({
      sent: false,
      suppressed: false,
      reason: "no_critical",
      criticalCount: 0,
      signature: null,
      notificationTypeKey: "auto_draft_po_critical_stale",
    });
  });

  it("delegates every eligible mutation to the atomic handoff service", async () => {
    const result = await runAutoDraftJob({ triggeredBy: "scheduler" });

    expect(mocks.inventory.getVelocityLookbackDays).toHaveBeenCalledTimes(1);
    expect(mocks.procurement.getReorderAnalysisData).toHaveBeenCalledWith(90);
    expect(mocks.lifecycle.startRun).toHaveBeenCalledWith({
      triggeredBy: "scheduler",
      triggeredByUser: null,
    });
    expect(mocks.lifecycle.heartbeatRun).toHaveBeenCalledWith({ runId: 500 });
    expect(mocks.handoff.createAutomaticHandoff).toHaveBeenCalledWith({
      actorId: "system:auto-draft",
      autoDraftRunId: 500,
      items: [expect.objectContaining({
        recommendationId: "1:11:90",
        productId: 1,
        productVariantId: 11,
        suggestedOrderQty: 4,
        suggestedOrderPieces: 4,
        orderUomUnits: 1,
        orderUomLabel: "pieces",
        vendorId: 7,
        vendorProductId: 701,
        estimatedCostMills: 50,
        pricingBasis: "per_piece",
        purchaseUom: null,
        quotedUnitCostMills: 50,
        piecesPerPurchaseUom: null,
        quoteReference: "QUOTE-701",
        quotedAt: expect.any(Date),
        quoteValidUntil: "2099-12-31",
        candidateBand: "strong_candidate",
        recommendationSnapshot: expect.objectContaining({
          analysis: { lookbackDays: 90 },
        }),
      })],
      completion: {
        itemsAnalyzed: 1,
        skippedNoVendor: 0,
        skippedOnOrder: 0,
        skippedExcluded: 0,
        summaryJson: expect.objectContaining({
          poMutations: [],
          poMutationSkips: [],
        }),
      },
    });
    expect(mocks.lifecycle.completeRun).not.toHaveBeenCalled();
    expect(mocks.procurement.updateAutoDraftRun).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      count: 1,
      itemsDrafted: 1,
      itemsSkippedAfterAnalysis: 0,
      reviewOnly: false,
      recommendationRun: { id: 500 },
    });
  });

  it("records review-only analysis without invoking a PO writer", async () => {
    mocks.procurement.getAutoDraftSettings.mockResolvedValue({
      autoDraftMode: "review_only",
      approvalPolicy: "high_confidence_only",
      includeOrderSoon: false,
      skipOnOpenPo: true,
      skipNoVendor: true,
    });

    const result = await runAutoDraftJob({ triggeredBy: "manual", triggeredByUser: "buyer-1" });

    expect(mocks.handoff.createAutomaticHandoff).not.toHaveBeenCalled();
    expect(mocks.lifecycle.completeRun).toHaveBeenCalledWith({
      runId: 500,
      completion: expect.objectContaining({
        itemsAnalyzed: 1,
        summaryJson: expect.objectContaining({ poMutations: [], poMutationSkips: [] }),
      }),
    });
    expect(mocks.procurement.updateAutoDraftRun).not.toHaveBeenCalled();
    expect(result).toMatchObject({ count: 0, itemsDrafted: 0, reviewOnly: true });
  });

  it("keeps incomplete receive configuration out of automatic PO mutation", async () => {
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      {
        ...recommendationRows()[0],
        variant_id: null,
      },
    ]);

    const result = await runAutoDraftJob({ triggeredBy: "scheduler" });

    expect(mocks.handoff.createAutomaticHandoff).not.toHaveBeenCalled();
    expect(mocks.lifecycle.completeRun).toHaveBeenCalledWith({
      runId: 500,
      completion: expect.objectContaining({
        summaryJson: expect.objectContaining({
          recommendationSummary: expect.objectContaining({
            actionableCount: 1,
            autoDraftEligibleCount: 0,
            autoDraftReviewRequiredCount: 1,
          }),
        }),
      }),
    });
    expect(result).toMatchObject({
      count: 0,
      itemsDrafted: 0,
      recommendationSummary: {
        actionableCount: 1,
        autoDraftEligibleCount: 0,
        autoDraftReviewRequiredCount: 1,
      },
    });
  });

  it("keeps legacy catalog prices in review until their vendor quote basis is confirmed", async () => {
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([{
      ...recommendationRows()[0],
      vendor_pricing_basis: "legacy_unknown",
      vendor_purchase_uom: null,
      vendor_quoted_unit_cost_mills: null,
      vendor_pieces_per_purchase_uom: null,
    }]);

    const result = await runAutoDraftJob({ triggeredBy: "scheduler" });

    expect(mocks.handoff.createAutomaticHandoff).not.toHaveBeenCalled();
    expect(mocks.lifecycle.completeRun).toHaveBeenCalledWith({
      runId: 500,
      completion: expect.objectContaining({
        summaryJson: expect.objectContaining({
          recommendationSummary: expect.objectContaining({
            autoDraftEligibleCount: 0,
            autoDraftReviewRequiredCount: 1,
          }),
        }),
      }),
    });
    expect(result.recommendationSummary).toMatchObject({
      autoDraftEligibleCount: 0,
      autoDraftReviewRequiredCount: 1,
    });
  });

  it("reports snapshots skipped because another handoff committed after analysis began", async () => {
    mocks.handoff.createAutomaticHandoff.mockResolvedValue({
      pos: [],
      decisions: [],
      handedOff: [],
      skipped: [{
        recommendationId: "1:11:90",
        kind: "auto_draft_eligible",
        reason: "changed_after_run_started",
        latestDecisionId: 900,
      }],
    });

    const result = await runAutoDraftJob({ triggeredBy: "scheduler" });

    expect(result).toMatchObject({ count: 0, itemsDrafted: 0, itemsSkippedAfterAnalysis: 1 });
    expect(mocks.handoff.createAutomaticHandoff).toHaveBeenCalledWith(expect.objectContaining({
      completion: expect.objectContaining({
        summaryJson: expect.objectContaining({ poMutationSkips: [] }),
      }),
    }));
    expect(mocks.lifecycle.completeRun).not.toHaveBeenCalled();
    expect(result.recommendationRun.detail).toMatchObject({
      poMutationSkips: [expect.objectContaining({ latestDecisionId: 900 })],
    });
  });

  it("preflights one exact SKU without starting a run or invoking a PO writer", async () => {
    const preview = await previewAutomaticPurchasingPilot({ sku: " high-1 " });

    expect(mocks.lifecycle.startRun).not.toHaveBeenCalled();
    expect(mocks.lifecycle.heartbeatRun).not.toHaveBeenCalled();
    expect(mocks.handoff.createAutomaticHandoff).not.toHaveBeenCalled();
    expect(preview).toMatchObject({
      mode: "preflight",
      sku: "HIGH-1",
      itemsAnalyzed: 1,
      matchCount: 1,
      autoDraftMode: "draft_po",
      approvalPolicy: "high_confidence_only",
      eligible: true,
      blockers: [],
      limits: { maximumPurchaseOrders: 1, maximumPurchaseOrderLines: 1 },
      recommendation: {
        recommendationId: "1:11:90",
        productId: 1,
        productVariantId: 11,
        preferredVendorId: 7,
        vendorProductId: 701,
        suggestedOrderPieces: 4,
        pricingBasis: "per_piece",
        quotedUnitCostMills: 50,
        estimatedCostMills: 50,
        estimatedCostCents: 1,
        quoteReference: "QUOTE-701",
        normalizedLinePricing: {
          pricingBasis: "per_piece",
          orderQty: 4,
          quotedUnitCostMills: 50,
          quotedExtendedMills: 200,
          unitCostMills: 50,
          unitCostCents: 1,
          totalProductCostCents: 2,
          pricingRemainderMills: 0,
        },
      },
    });
  });

  it("executes a pilot with exactly one SKU even when other recommendations are eligible", async () => {
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      ...recommendationRows(),
      {
        ...recommendationRows()[0],
        product_id: 2,
        variant_id: 22,
        base_sku: "OTHER-2",
        vendor_product_id: 702,
      },
    ]);

    const result = await runAutoDraftJob({
      triggeredBy: "manual",
      triggeredByUser: "buyer-user-id",
      pilot: { sku: "HIGH-1" },
    });

    const call = mocks.handoff.createAutomaticHandoff.mock.calls[0][0];
    expect(call.actorId).toBe("buyer-user-id");
    expect(call.items).toHaveLength(1);
    expect(call.items[0]).toMatchObject({ sku: "HIGH-1", productId: 1, vendorProductId: 701 });
    expect(result).toMatchObject({ count: 1, itemsDrafted: 1 });
    expect(result.pilot).toMatchObject({
      mode: "execute",
      sku: "HIGH-1",
      eligible: true,
      outcome: "created",
      mapping: {
        acceptedDecisionId: 800,
        handoffDecisionId: 801,
        poId: 700,
        poLineId: 701,
      },
      limits: { maximumPurchaseOrders: 1, maximumPurchaseOrderLines: 1 },
    });
  });

  it("preflights purchase-UOM quotes as unit economics before deriving the line total", async () => {
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([{
      ...recommendationRows()[0],
      estimated_cost_mills: 6_000,
      vendor_pricing_basis: "per_purchase_uom",
      vendor_purchase_uom: "case",
      vendor_quoted_unit_cost_mills: 12_000,
      vendor_pieces_per_purchase_uom: 2,
    }]);

    const preview = await previewAutomaticPurchasingPilot({ sku: "HIGH-1" });

    expect(preview).toMatchObject({
      eligible: true,
      recommendation: {
        suggestedOrderPieces: 4,
        pricingBasis: "per_purchase_uom",
        purchaseUom: "case",
        piecesPerPurchaseUom: 2,
        quotedUnitCostMills: 12_000,
        normalizedLinePricing: {
          orderQty: 4,
          purchaseUom: "case",
          purchaseUomQuantity: 2,
          piecesPerPurchaseUom: 2,
          quotedUnitCostMills: 12_000,
          quotedExtendedMills: 24_000,
          unitCostMills: 6_000,
          unitCostCents: 60,
          totalProductCostCents: 240,
          pricingRemainderMills: 0,
        },
      },
    });
  });

  it("fails a pilot closed when the exact SKU is absent", async () => {
    await expect(runAutoDraftJob({
      triggeredBy: "manual",
      triggeredByUser: "buyer-user-id",
      pilot: { sku: "MISSING-1" },
    })).rejects.toMatchObject({
      code: "AUTOMATIC_PURCHASING_PILOT_BLOCKED",
      preview: {
        eligible: false,
        blockers: [expect.objectContaining({ code: "sku_not_found" })],
      },
    });

    expect(mocks.handoff.createAutomaticHandoff).not.toHaveBeenCalled();
    expect(mocks.lifecycle.failRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 500,
      errorMessage: expect.stringContaining("No purchasing recommendation matched SKU MISSING-1"),
    }));
  });

  it("reports policy blockers during preflight and does not write", async () => {
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([{
      ...recommendationRows()[0],
      vendor_pricing_basis: "legacy_unknown",
      vendor_quoted_unit_cost_mills: null,
    }]);

    const preview = await previewAutomaticPurchasingPilot({ sku: "HIGH-1" });

    expect(preview).toMatchObject({
      eligible: false,
      blockers: [expect.objectContaining({ code: "approval_policy_rejected" })],
      recommendation: {
        pricingBasis: "legacy_unknown",
        quotedUnitCostMills: null,
      },
    });
    expect(mocks.lifecycle.startRun).not.toHaveBeenCalled();
    expect(mocks.handoff.createAutomaticHandoff).not.toHaveBeenCalled();
  });

  it("blocks review-only mode and ambiguous SKU matches during preflight", async () => {
    mocks.procurement.getAutoDraftSettings.mockResolvedValue({
      autoDraftMode: "review_only",
      approvalPolicy: "high_confidence_only",
      includeOrderSoon: false,
      skipOnOpenPo: true,
      skipNoVendor: true,
    });
    const reviewOnly = await previewAutomaticPurchasingPilot({ sku: "HIGH-1" });
    expect(reviewOnly).toMatchObject({
      eligible: false,
      blockers: [expect.objectContaining({ code: "review_only_mode" })],
    });

    mocks.procurement.getAutoDraftSettings.mockResolvedValue({
      autoDraftMode: "draft_po",
      approvalPolicy: "high_confidence_only",
      includeOrderSoon: false,
      skipOnOpenPo: true,
      skipNoVendor: true,
    });
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      ...recommendationRows(),
      { ...recommendationRows()[0], product_id: 2, variant_id: 22 },
    ]);
    const ambiguous = await previewAutomaticPurchasingPilot({ sku: "HIGH-1" });
    expect(ambiguous).toMatchObject({
      eligible: false,
      matchCount: 2,
      blockers: [expect.objectContaining({ code: "sku_ambiguous" })],
      recommendation: null,
    });
  });

  it("rejects scheduler or unattributed pilot execution before starting a run", async () => {
    await expect(runAutoDraftJob({
      triggeredBy: "scheduler",
      pilot: { sku: "HIGH-1" },
    })).rejects.toThrow("must be triggered manually");
    await expect(runAutoDraftJob({
      triggeredBy: "manual",
      pilot: { sku: "HIGH-1" },
    })).rejects.toThrow("requires an operator actor ID");

    expect(mocks.lifecycle.startRun).not.toHaveBeenCalled();
    expect(mocks.handoff.createAutomaticHandoff).not.toHaveBeenCalled();
  });

  it("records analysis failure through compare-and-set lifecycle state", async () => {
    mocks.procurement.getAutoDraftSettings.mockRejectedValue(new Error("settings unavailable"));

    await expect(runAutoDraftJob({ triggeredBy: "scheduler" })).rejects.toThrow("settings unavailable");

    expect(mocks.lifecycle.heartbeatRun).not.toHaveBeenCalled();
    expect(mocks.handoff.createAutomaticHandoff).not.toHaveBeenCalled();
    expect(mocks.lifecycle.failRun).toHaveBeenCalledWith({
      runId: 500,
      errorMessage: "settings unavailable",
      progress: {
        itemsAnalyzed: 0,
        skippedNoVendor: 0,
        skippedOnOrder: 0,
        skippedExcluded: 0,
        summaryJson: null,
      },
    });
    expect(mocks.procurement.updateAutoDraftRun).not.toHaveBeenCalled();
  });
});
