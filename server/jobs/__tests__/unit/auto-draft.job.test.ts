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
