import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const purchaseOrdersTable = {
    __table: "purchaseOrders",
    vendorId: "vendor_id",
    status: "status",
    source: "source",
    autoDraftDate: "auto_draft_date",
  };
  const reorderExclusionRulesTable = { __table: "reorderExclusionRules" };
  const productsTable = { __table: "products" };

  return {
    purchaseOrdersTable,
    reorderExclusionRulesTable,
    productsTable,
    db: {
      execute: vi.fn(),
      select: vi.fn(),
    },
    storage: {
      createAutoDraftRun: vi.fn(),
      getAutoDraftSettings: vi.fn(),
      getReorderAnalysisData: vi.fn(),
      updatePurchaseOrder: vi.fn(),
      bulkCreatePurchaseOrderLines: vi.fn(),
      getPurchaseOrderLines: vi.fn(),
      updateAutoDraftRun: vi.fn(),
    },
    purchasing: {
      createPO: vi.fn(),
      recalculateTotals: vi.fn(),
    },
  };
});

vi.mock("../../../db", () => ({
  db: mocks.db,
}));

vi.mock("../../../modules/procurement/procurement.storage", () => ({
  procurementMethods: mocks.storage,
}));

vi.mock("../../../modules/procurement/purchasing.service", () => ({
  createPurchasingService: () => mocks.purchasing,
}));

vi.mock("../../../storage/base", () => {
  const sqlTag = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { raw: (value: string) => value },
  );

  return {
    purchaseOrders: mocks.purchaseOrdersTable,
    reorderExclusionRules: mocks.reorderExclusionRulesTable,
    products: mocks.productsTable,
    sql: sqlTag,
    eq: vi.fn((left, right) => ({ op: "eq", left, right })),
    and: vi.fn((...conditions) => ({ op: "and", conditions })),
  };
});

import { runAutoDraftJob } from "../../auto-draft.job";

function mockDbSelect({ existingDraftPos = [] }: { existingDraftPos?: any[] } = {}) {
  mocks.db.select.mockImplementation(() => ({
    from: (table: any) => {
      if (table === mocks.purchaseOrdersTable) {
        return {
          where: () => ({
            limit: vi.fn().mockResolvedValue(existingDraftPos),
          }),
        };
      }
      return Promise.resolve([]);
    },
  }));
}

describe("auto-draft job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbSelect();
    mocks.db.execute.mockResolvedValue({
      rows: [
        { id: 1, sku: "HIGH-1", category: null, brand: null, product_type: null, tags: [], reorder_excluded: false },
        { id: 2, sku: "REVIEW-1", category: null, brand: null, product_type: null, tags: [], reorder_excluded: false },
      ],
    });
    mocks.storage.createAutoDraftRun.mockResolvedValue({ id: 500 });
    mocks.storage.getAutoDraftSettings.mockResolvedValue({
      autoDraftMode: "draft_po",
      approvalPolicy: "high_confidence_only",
      includeOrderSoon: false,
      skipOnOpenPo: true,
      skipNoVendor: true,
    });
    mocks.storage.getReorderAnalysisData.mockResolvedValue([
      {
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
        preferred_vendor_id: 7,
        estimated_cost_mills: 12500,
        vendor_product_updated_at: new Date().toISOString(),
      },
      {
        product_id: 2,
        variant_id: 22,
        base_sku: "REVIEW-1",
        product_name: "Review Product",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 60,
        previous_outbound_pieces: 55,
        demand_order_count: 12,
        demand_active_days: 10,
        on_order_pieces: 0,
        open_po_count: 0,
        lead_time_days: 4,
        safety_stock_days: 1,
        order_uom_units: 10,
        order_uom_level: 2,
        preferred_vendor_id: 7,
      },
    ]);
    mocks.purchasing.createPO.mockResolvedValue({ id: 700 });
    mocks.storage.bulkCreatePurchaseOrderLines.mockResolvedValue([]);
    mocks.storage.getPurchaseOrderLines.mockResolvedValue([]);
  });

  it("creates PO lines only for recommendations that pass the quality gate", async () => {
    await runAutoDraftJob({ triggeredBy: "scheduler" });

    expect(mocks.purchasing.createPO).toHaveBeenCalledTimes(1);
    expect(mocks.storage.bulkCreatePurchaseOrderLines).toHaveBeenCalledWith([
      expect.objectContaining({
        purchaseOrderId: 700,
        productId: 1,
        productVariantId: 11,
        sku: "HIGH-1",
        orderQty: 1,
        unitCostCents: 125,
      }),
    ]);
    expect(mocks.storage.bulkCreatePurchaseOrderLines.mock.calls[0][0]).toHaveLength(1);
    expect(mocks.storage.updateAutoDraftRun).toHaveBeenCalledWith(
      500,
      expect.objectContaining({
        status: "success",
        itemsAnalyzed: 2,
        posCreated: 1,
        posUpdated: 0,
        linesAdded: 1,
        summaryJson: expect.objectContaining({
          settings: expect.objectContaining({
            autoDraftMode: "draft_po",
            approvalPolicy: "high_confidence_only",
          }),
          recommendationSummary: expect.objectContaining({
            actionableCount: 2,
            autoDraftEligibleCount: 1,
            autoDraftReviewRequiredCount: 1,
          }),
          actionableRecommendations: expect.arrayContaining([
            expect.objectContaining({
              sku: "HIGH-1",
              qualityGate: expect.objectContaining({
                autoDraftEligible: true,
                reason: "high_confidence",
              }),
            }),
            expect.objectContaining({
              sku: "REVIEW-1",
              qualityGate: expect.objectContaining({
                autoDraftEligible: false,
                reason: "medium_confidence_review",
              }),
            }),
          ]),
        }),
      }),
    );
  });

  it("honors the stricter candidate-score approval policy before mutating draft POs", async () => {
    mocks.storage.getAutoDraftSettings.mockResolvedValue({
      autoDraftMode: "draft_po",
      approvalPolicy: "high_confidence_and_strong_candidate",
      includeOrderSoon: false,
      skipOnOpenPo: true,
      skipNoVendor: true,
      candidateScoreStrongThreshold: 95,
      candidateScoreReviewThreshold: 80,
    });

    await runAutoDraftJob({ triggeredBy: "scheduler" });

    expect(mocks.purchasing.createPO).not.toHaveBeenCalled();
    expect(mocks.storage.bulkCreatePurchaseOrderLines).not.toHaveBeenCalled();
    expect(mocks.storage.updateAutoDraftRun).toHaveBeenCalledWith(
      500,
      expect.objectContaining({
        status: "success",
        itemsAnalyzed: 2,
        posCreated: 0,
        posUpdated: 0,
        linesAdded: 0,
        summaryJson: expect.objectContaining({
          settings: expect.objectContaining({
            approvalPolicy: "high_confidence_and_strong_candidate",
            candidateScoreStrongThreshold: 95,
            candidateScoreReviewThreshold: 80,
          }),
          actionableRecommendations: expect.arrayContaining([
            expect.objectContaining({
              sku: "HIGH-1",
              qualityGate: expect.objectContaining({
                autoDraftEligible: true,
              }),
              recommendationCandidateScore: expect.objectContaining({
                band: "review_candidate",
              }),
            }),
          ]),
        }),
      }),
    );
  });
});
