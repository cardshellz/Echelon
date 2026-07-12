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

import { runAutoDraftJob } from "../../auto-draft.job";

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
    vendor_product_updated_at: new Date().toISOString(),
  }];
}

describe("auto-draft job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.procurement.createAutoDraftRun.mockResolvedValue({
      id: 500,
      runAt: new Date("2026-07-11T18:00:00.000Z"),
      status: "running",
    });
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
      handedOff: [{ poId: 700, recommendationId: "1:11:90" }],
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
    expect(mocks.handoff.createAutomaticHandoff).toHaveBeenCalledWith({
      actorId: "system:auto-draft",
      autoDraftRunId: 500,
      items: [expect.objectContaining({
        recommendationId: "1:11:90",
        productId: 1,
        productVariantId: 11,
        suggestedOrderPieces: 10,
        orderUomUnits: 10,
        vendorId: 7,
        vendorProductId: 701,
        estimatedCostMills: 50,
        candidateBand: "strong_candidate",
        recommendationSnapshot: expect.objectContaining({
          analysis: { lookbackDays: 90 },
        }),
      })],
    });
    expect(mocks.procurement.updateAutoDraftRun).toHaveBeenCalledWith(
      500,
      expect.objectContaining({
        status: "success",
        itemsAnalyzed: 1,
        posCreated: 1,
        posUpdated: 0,
        linesAdded: 1,
        summaryJson: expect.objectContaining({
          poMutations: [{ vendorId: 7, poId: 700, action: "created", linesAdded: 1 }],
          poMutationSkips: [],
        }),
      }),
    );
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
    expect(mocks.procurement.updateAutoDraftRun).toHaveBeenCalledWith(
      500,
      expect.objectContaining({
        status: "success",
        posCreated: 0,
        posUpdated: 0,
        linesAdded: 0,
      }),
    );
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
    expect(mocks.procurement.updateAutoDraftRun).toHaveBeenCalledWith(
      500,
      expect.objectContaining({
        status: "success",
        posCreated: 0,
        linesAdded: 0,
        summaryJson: expect.objectContaining({
          recommendationSummary: expect.objectContaining({
            actionableCount: 1,
            autoDraftEligibleCount: 0,
            autoDraftReviewRequiredCount: 1,
          }),
        }),
      }),
    );
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
    expect(mocks.procurement.updateAutoDraftRun).toHaveBeenCalledWith(
      500,
      expect.objectContaining({
        status: "success",
        linesAdded: 0,
        summaryJson: expect.objectContaining({
          poMutationSkips: [expect.objectContaining({ latestDecisionId: 900 })],
        }),
      }),
    );
  });
});
