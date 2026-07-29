import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import http from "http";
import { AddressInfo } from "net";

const mocks = vi.hoisted(() => ({
  procurement: {
    getReorderAnalysisData: vi.fn(),
    getOpenPoSummaryReport: vi.fn(),
    getDashboardData: vi.fn(),
    getReorderExclusionRules: vi.fn(),
    getTotalExcludedProducts: vi.fn(),
    getExclusionRuleMatchCount: vi.fn(),
    createReorderExclusionRule: vi.fn(),
    deleteReorderExclusionRule: vi.fn(),
    setProductReorderExcluded: vi.fn(),
    getLatestAutoDraftRun: vi.fn(),
    getRecentAutoDraftRuns: vi.fn(),
    createAutoDraftRun: vi.fn(),
    updateAutoDraftRun: vi.fn(),
    getRecentRecommendationDecisions: vi.fn(),
    getLatestRecommendationDecisions: vi.fn(),
    getLatestRecommendationDecisionsByDecision: vi.fn(),
    createRecommendationDecision: vi.fn(),
    getAutoDraftSettings: vi.fn(),
    updateAutoDraftSettings: vi.fn(),
  },
  inventory: {
    getVelocityLookbackDays: vi.fn(),
    updateVelocityLookbackDays: vi.fn(),
  },
  db: {
    execute: vi.fn(),
    select: vi.fn(),
  },
  runAutoDraftJob: vi.fn(),
  startAutoDraftJob: vi.fn(),
  purchasingService: {
    createPOFromReorder: vi.fn(),
    snapshotPurchaseRecommendations: vi.fn(),
    createRfqBatch: vi.fn(),
  },
  recommendationPoHandoffService: {
    recordDecision: vi.fn(),
    createAcceptedHandoff: vi.fn(),
  },
}));

vi.mock("../../../../routes/middleware", () => {
  const pass = (req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { id: "admin-user", role: "admin" };
    (req as any).session = { user: { id: "admin-user", role: "admin" } };
    next();
  };
  return {
    requirePermission: () => pass,
  };
});


vi.mock("../..", () => ({ procurementStorage: mocks.procurement }));
vi.mock("../../../../modules/inventory", () => ({ inventoryStorage: mocks.inventory }));
vi.mock("../../../../db", () => ({ db: mocks.db }));
vi.mock("../../../../storage/base", () => ({
  products: {},
  reorderExclusionRules: {},
}));
vi.mock("../../../../jobs/auto-draft.job", () => ({
  runAutoDraftJob: mocks.runAutoDraftJob,
  startAutoDraftJob: mocks.startAutoDraftJob,
}));

import {
  registerPurchasingRecommendationAdminRoutes,
  registerPurchasingRecommendationRoutes,
} from "../../purchasing-recommendation.routes";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.locals.services = {
    purchasing: mocks.purchasingService,
    recommendationPoHandoff: mocks.recommendationPoHandoffService,
  };
  registerPurchasingRecommendationRoutes(app);
  registerPurchasingRecommendationAdminRoutes(app);
  return app;
}

function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function requestJson(baseUrl: string, method: string, path: string, body?: any) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function selectChain(rows: any[]) {
  const chain: any = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    limit: vi.fn().mockResolvedValue(rows),
    then: (resolve: (value: any[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

describe("purchasing recommendation routes", () => {
  let server: { url: string; close: () => Promise<void> } | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.db.execute.mockResolvedValue({ rows: [] });
    mocks.db.select.mockImplementation(() => {
      const chain: any = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        innerJoin: vi.fn(() => chain),
        leftJoin: vi.fn(() => chain),
        limit: vi.fn().mockResolvedValue([]),
        then: (resolve: (value: any[]) => unknown) => Promise.resolve([]).then(resolve),
      };
      return chain;
    });
    mocks.runAutoDraftJob.mockResolvedValue({
      success: true,
      pos: [],
      count: 0,
      itemsDrafted: 0,
      itemsSkippedAfterAnalysis: 0,
      reviewOnly: false,
      recommendationSummary: {},
      recommendationRun: { id: 1001, detail: {} },
    });
    mocks.startAutoDraftJob.mockResolvedValue({
      runId: 1001,
      interruptedRunIds: [],
      completion: Promise.resolve({
        success: true,
        pos: [],
        count: 0,
        itemsDrafted: 0,
        itemsSkippedAfterAnalysis: 0,
        reviewOnly: false,
        recommendationSummary: {},
        recommendationRun: { id: 1001, detail: {} },
      }),
    });
    mocks.procurement.getAutoDraftSettings.mockResolvedValue({
      autoDraftMode: "draft_po",
      approvalPolicy: "high_confidence_only",
      includeOrderSoon: false,
      skipOnOpenPo: true,
      skipNoVendor: true,
      candidateScoreStrongThreshold: 80,
      candidateScoreReviewThreshold: 60,
    });
    mocks.procurement.createAutoDraftRun.mockResolvedValue({ id: 1001 });
    mocks.procurement.updateAutoDraftRun.mockResolvedValue(undefined);
    mocks.procurement.getRecentAutoDraftRuns.mockResolvedValue([]);
    mocks.procurement.getRecentRecommendationDecisions.mockResolvedValue([]);
    mocks.procurement.getLatestRecommendationDecisions.mockResolvedValue([]);
    mocks.procurement.getLatestRecommendationDecisionsByDecision.mockResolvedValue([]);
    mocks.procurement.createRecommendationDecision.mockImplementation(async (data) => ({
      id: 5001,
      ...data,
      decidedAt: "2026-05-22T12:00:00.000Z",
      createdAt: "2026-05-22T12:00:00.000Z",
    }));
    mocks.purchasingService.createPOFromReorder.mockResolvedValue([]);
    mocks.purchasingService.snapshotPurchaseRecommendations.mockImplementation(async (input) => ({
      run: { id: 701, calculationVersion: input.calculationVersion },
      lines: input.lines.map((line: any, index: number) => ({ id: index + 1, ...line })),
      observations: input.observations.map((observation: any, index: number) => ({ id: index + 1001, ...observation })),
    }));
    mocks.purchasingService.createRfqBatch.mockResolvedValue({
      reused: false,
      rfqs: [{ id: 801, status: "draft", vendorId: 77 }],
      lines: [{ id: 901, recommendationLineId: 11, requestedPieces: 12 }],
    });
    mocks.recommendationPoHandoffService.recordDecision.mockImplementation(async (data) => ({
      id: 5001,
      ...data,
      decidedAt: "2026-05-22T12:00:00.000Z",
      createdAt: "2026-05-22T12:00:00.000Z",
    }));
    mocks.recommendationPoHandoffService.createAcceptedHandoff.mockResolvedValue({
      pos: [],
      decisions: [],
      handedOff: [],
    });
  });

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  it("computes purchasing KPIs from reorder analysis and open PO pipeline", async () => {
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(10);
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      {
        product_id: 1,
        base_sku: "CRIT",
        product_name: "Critical Product",
        total_pieces: 3,
        total_reserved_pieces: 1,
        total_outbound_pieces: 10,
        on_order_pieces: 0,
        lead_time_days: null,
        safety_stock_days: null,
        unit_cost_cents: 250,
      },
      {
        product_id: 2,
        base_sku: "IDLE",
        product_name: "Idle Product",
        total_pieces: 300,
        total_reserved_pieces: 0,
        total_outbound_pieces: 1,
        on_order_pieces: 0,
        lead_time_days: 2,
        safety_stock_days: 1,
        estimated_cost_mills: 50,
        estimated_cost_cents: 1,
      },
    ]);
    mocks.db.execute.mockResolvedValue({
      rows: [
        { key: "default_lead_time_days", value: "4" },
        { key: "default_safety_stock_days", value: "3" },
      ],
    });
    mocks.procurement.getOpenPoSummaryReport.mockResolvedValue([
      { status: "sent", total_value_cents: "5000", total_lines: "2" },
      { status: "draft", total_value_cents: "1000", total_lines: "10" },
    ]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/purchasing/kpis");

    expect(status).toBe(200);
    expect(body).toMatchObject({
      criticalRestocks: 1,
      upcomingRestocks: 0,
      idleCapitalCents: 150,
      inboundPipelineValueCents: 5000,
      totalOpenLines: 2,
    });
    expect(body.lastComputedAt).toEqual(expect.any(String));
  });

  it("returns reorder analysis items and summary with configured lookback", async () => {
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(30);
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      {
        product_id: 5,
        variant_id: 51,
        base_sku: "SKU-P1",
        product_name: "Product",
        variant_count: 1,
        total_pieces: 5,
        total_reserved_pieces: 1,
        total_outbound_pieces: 60,
        on_order_pieces: 0,
        open_po_count: 0,
        earliest_expected: null,
        lead_time_days: 2,
        safety_stock_days: 1,
        order_uom_units: 10,
        order_uom_level: 2,
        last_received_at: "2026-05-01",
      },
    ]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/purchasing/reorder-analysis");

    expect(status).toBe(200);
    expect(mocks.procurement.getReorderAnalysisData).toHaveBeenCalledWith(30);
    expect(body).toMatchObject({
      lookbackDays: 30,
      summary: {
        totalProducts: 1,
        outOfStock: 0,
        belowReorderPoint: 1,
        orderSoon: 0,
        noMovement: 0,
        totalOnHand: 5,
        excludedCount: 0,
      },
      approvalPolicyImpact: {
        policy: "high_confidence_only",
        candidateScoreGateActive: false,
        qualityGateEligibleCount: 0,
        approvalPolicyEligibleCount: 0,
        approvalPolicyBlockedCount: 0,
        draftMutationEligibleCount: 0,
        heldRecommendations: [],
      },
      items: [
        {
          productId: 5,
          productVariantId: 51,
          sku: "SKU-P1",
          available: 4,
          avgDailyUsage: 2,
          reorderPoint: 6,
          suggestedOrderQty: 2,
          suggestedOrderPieces: 2,
          orderUomLabel: "pieces",
          status: "order_now",
        },
      ],
    });
    // Items keep contribution evidence for the cockpit math drawer; with no
    // demand events in the fixture the capture resolves to an empty array.
    expect(body.items[0].forwardDemandBasis.contributions).toEqual([]);
  });

  it("keeps forward-demand contributions on items and strips them from skippedItems", async () => {
    const contribution = {
      productId: 5,
      productVariantId: 51,
      demandEventId: 900,
      demandEventLineId: 9001,
      eventName: "August Drop",
      eventType: "drop",
      eventStatus: "planned",
      eventStartDate: "2026-08-10",
      eventEndDate: null,
      planningAsOfDate: "2026-07-01",
      expectedPieces: 20,
      confidence: "high",
      confidenceWeightPercent: 100,
      weightedPieces: 20,
      eventUpdatedAt: "2026-06-30T12:00:00.000Z",
      lineUpdatedAt: "2026-06-30T12:00:00.000Z",
    };
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(30);
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      {
        // Actionable: available 4 + 1 on order stays below the forward-adjusted
        // reorder point, so this row lands in items.
        product_id: 5,
        variant_id: 51,
        base_sku: "SKU-ACTIONABLE",
        product_name: "Actionable Product",
        variant_count: 1,
        total_pieces: 5,
        total_reserved_pieces: 1,
        total_outbound_pieces: 60,
        demand_order_count: 12,
        demand_active_days: 10,
        on_order_pieces: 1,
        open_po_count: 1,
        earliest_expected: "2026-08-04T00:00:00.000Z",
        lead_time_days: 2,
        safety_stock_days: 1,
        product_category: "Card Sleeves",
        product_line_names: ["Pro Line", "Shield Line"],
        forward_demand_pieces: 20,
        forward_demand_raw_pieces: 20,
        forward_demand_event_count: 1,
        forward_demand_contributions: [contribution],
        forward_demand_planning_as_of_date: "2026-07-01",
        forward_demand_horizon_days: 90,
      },
      {
        // Skipped: ample stock keeps the row non-actionable, so it lands in
        // skippedItems with the same contribution evidence attached.
        product_id: 6,
        variant_id: 61,
        base_sku: "SKU-SKIPPED",
        product_name: "Skipped Product",
        variant_count: 1,
        total_pieces: 500,
        total_reserved_pieces: 0,
        total_outbound_pieces: 60,
        demand_order_count: 12,
        demand_active_days: 10,
        on_order_pieces: 0,
        open_po_count: 0,
        earliest_expected: null,
        lead_time_days: 2,
        safety_stock_days: 1,
        forward_demand_pieces: 20,
        forward_demand_raw_pieces: 20,
        forward_demand_event_count: 1,
        forward_demand_contributions: [{ ...contribution, productId: 6, productVariantId: 61 }],
        forward_demand_planning_as_of_date: "2026-07-01",
        forward_demand_horizon_days: 90,
      },
    ]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/purchasing/reorder-analysis");

    expect(status).toBe(200);
    // Non-excluded skipped rows are dual-listed in items, so both rows appear.
    expect(body.items).toHaveLength(2);
    const actionable = body.items.find((item: any) => item.sku === "SKU-ACTIONABLE");
    expect(actionable).toMatchObject({
      category: "Card Sleeves",
      productLines: ["Pro Line", "Shield Line"],
      onOrderPieces: 1,
      earliestInboundEta: "2026-08-04",
    });
    expect(actionable.forwardDemandBasis.contributions).toHaveLength(1);
    expect(actionable.forwardDemandBasis.contributions[0]).toMatchObject({
      eventName: "August Drop",
      eventType: "drop",
      expectedPieces: 20,
      confidence: "high",
      weightedPieces: 20,
    });
    // Every entry in items keeps its contribution evidence, including the
    // dual-listed skipped row.
    const skippedInItems = body.items.find((item: any) => item.sku === "SKU-SKIPPED");
    expect(skippedInItems.forwardDemandBasis.contributions).toHaveLength(1);

    const skipped = body.skippedItems.find((item: any) => item.sku === "SKU-SKIPPED");
    expect(skipped).toBeDefined();
    expect(skipped.forwardDemandBasis).not.toHaveProperty("contributions");
    expect(skipped.forwardDemandBasis).toMatchObject({
      forwardDemandPieces: 20,
      forwardDemandEventCount: 1,
    });
    expect(skipped).toMatchObject({
      category: null,
      productLines: [],
      earliestInboundEta: null,
    });
  });

  it("applies stored exclusion rules to reorder analysis through the shared context loader", async () => {
    // Regression for the context/engine key mismatch: loadPurchasingRecommendationContext
    // used to return `rules` while the engine reads `exclusionRules`, so the spread in the
    // reorder-analysis route silently ignored rule-based exclusions.
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(30);
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      {
        product_id: 20,
        variant_id: 201,
        base_sku: "DROP-1",
        product_name: "Dropship Item",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 30,
        on_order_pieces: 0,
        lead_time_days: 2,
        safety_stock_days: 1,
        order_uom_units: 1,
      },
      {
        product_id: 21,
        variant_id: 211,
        base_sku: "KEEP-1",
        product_name: "Kept Item",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 30,
        on_order_pieces: 0,
        lead_time_days: 2,
        safety_stock_days: 1,
        order_uom_units: 1,
      },
    ]);
    // The real context loader runs in this test (only db + storage/base are mocked):
    // db.select().from(reorderExclusionRules) returns the stored rule, and the two
    // db.execute calls serve the settings-defaults and product-meta queries.
    mocks.db.select.mockImplementation(() =>
      selectChain([{ id: 1, field: "category", value: "dropship" }]),
    );
    const stringifySql = (query: unknown) => {
      try {
        return JSON.stringify(query) ?? "";
      } catch {
        return "";
      }
    };
    mocks.db.execute.mockImplementation(async (query: unknown) => {
      const text = stringifySql(query);
      if (text.includes("echelon_settings")) {
        return {
          rows: [
            { key: "default_lead_time_days", value: "4" },
            { key: "default_safety_stock_days", value: "3" },
          ],
        };
      }
      if (text.includes("reorder_excluded")) {
        return {
          rows: [
            { id: 20, category: "dropship", brand: null, product_type: null, sku: "DROP-1", tags: null, reorder_excluded: false },
            { id: 21, category: "singles", brand: null, product_type: null, sku: "KEEP-1", tags: null, reorder_excluded: false },
          ],
        };
      }
      return { rows: [] };
    });
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/purchasing/reorder-analysis");

    expect(status).toBe(200);
    expect(body.items.map((item: any) => item.sku)).toEqual(["KEEP-1"]);
    expect(body.summary.excludedCount).toBe(1);
    expect(body.skippedItems).toHaveLength(1);
    expect(body.skippedItems[0]).toMatchObject({
      productId: 20,
      sku: "DROP-1",
      skippedReason: "excluded",
    });
  });

  it("returns manual reorder approval-policy impact using active candidate score settings", async () => {
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(30);
    mocks.procurement.getAutoDraftSettings.mockResolvedValue({
      autoDraftMode: "draft_po",
      approvalPolicy: "high_confidence_and_strong_candidate",
      includeOrderSoon: false,
      skipOnOpenPo: true,
      skipNoVendor: true,
      candidateScoreStrongThreshold: 95,
      candidateScoreReviewThreshold: 80,
    });
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      {
        product_id: 6,
        variant_id: 61,
        base_sku: "STRICT-REVIEW",
        product_name: "Strict Review Candidate",
        variant_count: 1,
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 90,
        previous_outbound_pieces: 90,
        demand_order_count: 15,
        demand_active_days: 15,
        on_order_pieces: 0,
        open_po_count: 0,
        earliest_expected: null,
        lead_time_days: 2,
        vendor_lead_time_days: 2,
        safety_stock_days: 1,
        order_uom_units: 10,
        order_uom_level: 2,
        vendor_product_id: 7706,
        preferred_vendor_id: 77,
        preferred_vendor_name: "Vendor",
        estimated_cost_cents: 1000,
        vendor_pricing_basis: "per_piece",
        vendor_purchase_uom: null,
        vendor_quoted_unit_cost_mills: 100000,
        vendor_pieces_per_purchase_uom: null,
        vendor_quoted_at: "2026-05-18T12:00:00.000Z",
        vendor_product_updated_at: "2026-05-18T12:00:00.000Z",
      },
    ]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/purchasing/reorder-analysis");

    expect(status).toBe(200);
    expect(body.summary.autoDraftEligibleCount).toBe(1);
    expect(body.items[0].recommendationCandidateScore.band).toBe("review_candidate");
    expect(body.approvalPolicyImpact).toMatchObject({
      policy: "high_confidence_and_strong_candidate",
      candidateScoreGateActive: true,
      qualityGateEligibleCount: 1,
      approvalPolicyEligibleCount: 0,
      approvalPolicyBlockedCount: 1,
      draftMutationEligibleCount: 0,
      blockedCandidateBandCounts: {
        review_candidate: 1,
      },
      heldRecommendations: [
        {
          sku: "STRICT-REVIEW",
          productName: "Strict Review Candidate",
          suggestedOrderQty: 9,
          orderUomLabel: "pieces",
          recommendationCandidateScore: {
            band: "review_candidate",
          },
          qualityGate: {
            autoDraftEligible: true,
          },
        },
      ],
    });
  });

  it("summarizes supplier setup gaps from recommendation quality controls", async () => {
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(30);
    mocks.procurement.getAutoDraftSettings.mockResolvedValue({
      autoDraftMode: "draft_po",
      approvalPolicy: "high_confidence_and_strong_candidate",
      includeOrderSoon: false,
      skipOnOpenPo: true,
      skipNoVendor: true,
      candidateScoreStrongThreshold: 80,
      candidateScoreReviewThreshold: 60,
    });
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      {
        product_id: 101,
        variant_id: 1001,
        base_sku: "NO-VENDOR",
        product_name: "No Vendor Product",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 60,
        previous_outbound_pieces: 58,
        demand_order_count: 12,
        demand_active_days: 10,
        on_order_pieces: 0,
        open_po_count: 0,
        lead_time_days: null,
        vendor_lead_time_days: null,
        safety_stock_days: 1,
        order_uom_units: 10,
        order_uom_level: 2,
      },
      {
        product_id: 102,
        variant_id: 1002,
        base_sku: "MISSING-COST",
        product_name: "Missing Cost Product",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 60,
        previous_outbound_pieces: 60,
        demand_order_count: 12,
        demand_active_days: 10,
        on_order_pieces: 0,
        open_po_count: 0,
        lead_time_days: 5,
        vendor_lead_time_days: null,
        safety_stock_days: 1,
        order_uom_units: 10,
        order_uom_level: 2,
        preferred_vendor_id: 77,
        preferred_vendor_name: "Vendor A",
      },
      {
        product_id: 103,
        variant_id: 1003,
        base_sku: "STALE-COST",
        product_name: "Stale Cost Product",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 60,
        previous_outbound_pieces: 60,
        demand_order_count: 12,
        demand_active_days: 10,
        on_order_pieces: 0,
        open_po_count: 0,
        lead_time_days: 5,
        vendor_lead_time_days: 4,
        safety_stock_days: 1,
        order_uom_units: 10,
        order_uom_level: 2,
        preferred_vendor_id: 88,
        preferred_vendor_name: "Vendor B",
        estimated_cost_cents: 250,
        vendor_quoted_at: "2024-01-01T00:00:00.000Z",
        vendor_product_updated_at: "2024-01-01T00:00:00.000Z",
      },
    ]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/purchasing/supplier-setup-gaps");

    expect(status).toBe(200);
    expect(mocks.procurement.getReorderAnalysisData).toHaveBeenCalledWith(30);
    expect(body).toMatchObject({
      lookbackDays: 30,
      autoDraftMode: "draft_po",
      approvalPolicy: "high_confidence_and_strong_candidate",
      scannedRecommendations: 3,
      skippedRecommendations: 1,
      totalGapItems: 3,
      counts: {
        missingVendor: 1,
        missingSupplierCost: 1,
        staleSupplierCost: 1,
        defaultLeadTime: 1,
        productLeadTimeFallback: 1,
        blockedRecommendations: 1,
        reviewRecommendations: 2,
      },
      codeCounts: {
        missing_vendor: 1,
        missing_supplier_cost: 1,
        stale_supplier_cost: 1,
        default_lead_time: 1,
        product_lead_time_fallback: 1,
      },
    });
    expect(body.generatedAt).toEqual(expect.any(String));
    expect(body.items[0]).toMatchObject({
      sku: "NO-VENDOR",
      skippedReason: "no_vendor",
      action: {
        action: "assign_preferred_vendor",
        label: "Assign vendor",
        href: expect.stringMatching(/^\/suppliers\?/),
      },
    });
    expect(body.items[0].gaps[0]).toMatchObject({
      code: "missing_vendor",
      severity: "block",
    });
    expect(body.items[1]).toMatchObject({
      sku: "MISSING-COST",
      preferredVendorName: "Vendor A",
      vendorProductId: null,
      action: {
        action: "update_supplier_cost",
        label: "Update cost",
      },
    });
    const missingCostUrl = new URL(body.items[1].action.href, "https://echelon.example");
    expect(Object.fromEntries(missingCostUrl.searchParams)).toMatchObject({
      setupProductId: "102",
      setupVariantId: "1002",
      vendorId: "77",
      setupAction: "update_supplier_cost",
      returnTo: "/purchasing",
    });
    expect(body.items[1].gaps[0]).toMatchObject({
      code: "missing_supplier_cost",
      severity: "review",
    });
    expect(body.items.map((item: any) => item.sku)).toContain("STALE-COST");
  });

  it("saves versioned recommendations without requiring a preferred vendor or supplier price", async () => {
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(30);
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([{
      product_id: 301,
      variant_id: 3001,
      base_sku: "RFQ-NO-VENDOR",
      product_name: "RFQ Product",
      total_pieces: 0,
      total_reserved_pieces: 0,
      total_outbound_pieces: 60,
      previous_outbound_pieces: 60,
      demand_order_count: 12,
      demand_active_days: 10,
      on_order_pieces: 0,
      open_po_count: 0,
      lead_time_days: 5,
      safety_stock_days: 1,
      order_uom_units: 10,
      order_uom_level: 2,
      preferred_vendor_id: null,
      estimated_cost_mills: null,
      estimated_cost_cents: null,
    }]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "POST", "/api/purchasing/recommendation-runs");

    expect(status).toBe(201);
    expect(body).toMatchObject({ run: { id: 701 }, lineCount: 1, observationCount: 1 });
    expect(mocks.purchasingService.snapshotPurchaseRecommendations).toHaveBeenCalledTimes(1);
    const input = mocks.purchasingService.snapshotPurchaseRecommendations.mock.calls[0][0];
    expect(input.lines[0]).toMatchObject({
      recommendationKey: "301:3001:30",
      sku: "RFQ-NO-VENDOR",
      productId: 301,
      productVariantId: 3001,
      preferredVendorId: null,
      preferredVendorProductId: null,
    });
    expect(input.lines[0].recommendedPieces).toBeGreaterThan(0);
    expect(input.lines[0]).not.toHaveProperty("estimatedCostMills");
    expect(input.inputSummary).toMatchObject({ candidateCount: 1, evaluatedCount: 1 });
    expect(input.observations).toHaveLength(1);
  });

  it("returns the latest durable recommendation run with allocated and remaining quantities", async () => {
    mocks.db.select
      .mockReturnValueOnce(selectChain([{
        id: 701,
        calculationVersion: "purchasing-recommendation-v2",
        status: "completed",
        asOf: new Date("2026-07-17T12:00:00.000Z"),
        generatedAt: new Date("2026-07-17T12:01:00.000Z"),
        lookbackDays: 30,
        policySnapshot: { seasonalityEnabled: true },
      }]))
      .mockReturnValueOnce(selectChain([{
        id: 11,
        runId: 701,
        recommendationKey: "301:3001:30",
        productId: 301,
        productVariantId: 3001,
        warehouseId: null,
        requiredByDate: null,
        sku: "RFQ-NO-VENDOR",
        productName: "RFQ Product",
        recommendedPieces: 100,
        preferredVendorId: null,
        preferredVendorProductId: null,
        evidenceSnapshot: { availablePieces: 5, onOrderPieces: 10, forecastDailyPieces: 3 },
      }]))
      .mockReturnValueOnce(selectChain([{
        id: 22,
        recommendationLineId: 10,
        productId: 301,
        productVariantId: 3001,
        warehouseId: null,
        requestedPieces: 40,
        lineStatus: "draft",
        rfqId: 33,
        rfqNumber: "RFQ-TEST",
        rfqStatus: "draft",
        vendorId: 77,
        createdAt: new Date("2026-07-17T12:02:00.000Z"),
      }]))
      .mockReturnValueOnce(selectChain([{ id: 77, name: "Supplier 77" }]));
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/purchasing/rfq-queue");

    expect(status).toBe(200);
    expect(body.summary).toMatchObject({ total: 1, partiallyAllocated: 1, activeRfqs: 1 });
    expect(body.items[0]).toMatchObject({
      recommendationLineId: 11,
      recommendedPieces: 100,
      allocatedPieces: 40,
      remainingPieces: 60,
      sourcingStatus: "partially_allocated",
      supplierAssignmentRequired: true,
    });
    expect(body.items[0].allocations[0]).toMatchObject({ rfqNumber: "RFQ-TEST", vendorName: "Supplier 77" });
    expect(body.items[0].allocations[0].recommendationLineId).toBe(10);
  });

  it("creates a supplier-grouped RFQ batch with a strict approval flag and no client-supplied approver", async () => {
    server = await startServer(buildApp());

    const { status } = await requestJson(server.url, "POST", "/api/purchasing/rfq-queue", {
      idempotencyKey: "ui-request-123",
      requestNote: "Quote delivery to the main warehouse",
      lines: [{
        recommendationLineId: 11,
        vendorId: 77,
        vendorSku: "SUP-302",
        requestedPieces: 12,
        quantityOverrideReason: "Build launch inventory",
        allocationOverrideApproved: true,
        allocationOverrideApprovedBy: "forged-user",
      }],
      unitCostCents: 1,
    });

    expect(status).toBe(201);
    expect(mocks.purchasingService.createRfqBatch).toHaveBeenCalledTimes(1);
    const input = mocks.purchasingService.createRfqBatch.mock.calls[0][0];
    expect(input).toMatchObject({
      idempotencyKey: "ui-request-123",
      requestNote: "Quote delivery to the main warehouse",
      lines: [{
        recommendationLineId: 11,
        vendorId: 77,
        vendorSku: "SUP-302",
        requestedPieces: 12,
        quantityOverrideReason: "Build launch inventory",
        allocationOverrideApproved: true,
      }],
    });
    expect(mocks.purchasingService.createRfqBatch.mock.calls[0][1]).toBe("admin-user");
    expect(input).not.toHaveProperty("unitCostCents");
    expect(input).not.toHaveProperty("pricing");
    expect(input.lines[0]).not.toHaveProperty("allocationOverrideApprovedBy");
  });

  it("does not coerce a string into allocation approval", async () => {
    server = await startServer(buildApp());

    const { status } = await requestJson(server.url, "POST", "/api/purchasing/rfq-queue", {
      idempotencyKey: "ui-request-string-approval",
      lines: [{
        recommendationLineId: 11,
        vendorId: 77,
        requestedPieces: 12,
        quantityOverrideReason: "Build launch inventory",
        allocationOverrideApproved: "true",
      }],
    });

    expect(status).toBe(201);
    expect(mocks.purchasingService.createRfqBatch.mock.calls[0][0].lines[0].allocationOverrideApproved).toBe(false);
  });

  it("lists created RFQs newest-first with joined lines and vendor names", async () => {
    const createdAt = new Date("2026-07-21T10:00:00.000Z");
    mocks.db.select
      .mockReturnValueOnce(selectChain([{
        id: 42,
        rfqNumber: "RFQ-2026-0042",
        vendorId: 77,
        status: "draft",
        requestNote: "Quote delivered pricing",
        currency: "USD",
        responseDueDate: "2026-07-30",
        createdBy: "buyer-17",
        createdAt,
        updatedAt: createdAt,
        sentAt: null,
        respondedAt: null,
        cancelledAt: null,
      }]))
      .mockReturnValueOnce(selectChain([{
        id: 501,
        rfqId: 42,
        recommendationLineId: 11,
        recommendationRunId: 3,
        vendorProductId: 44,
        vendorSku: "SUP-302",
        sku: "SKU-RED",
        productName: "Red Card Shell",
        status: "draft",
        requestedPieces: 96,
        recommendedPieces: 96,
        purchaseUom: null,
        piecesPerPurchaseUom: null,
        quantityOverrideReason: null,
        allocationOverrideReason: null,
        allocationOverrideApprovedBy: null,
        allocationOverrideApprovedAt: null,
        allocationOverrideBaselinePieces: null,
        allocationOverrideExcessPieces: null,
        quotedPieces: null,
        quotedUnitCostMills: null,
        quoteReference: null,
        quoteValidUntil: null,
        quotedAt: null,
      }]))
      .mockReturnValueOnce(selectChain([{ id: 77, name: "Supplier 77" }]));
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/purchasing/rfqs?limit=10");

    expect(status).toBe(200);
    expect(body).toMatchObject({ limit: 10, count: 1, statusCounts: { draft: 1 } });
    expect(body.rfqs[0]).toMatchObject({
      rfqNumber: "RFQ-2026-0042",
      status: "draft",
      vendorName: "Supplier 77",
      responseDueDate: "2026-07-30",
      lineCount: 1,
      requestedPiecesTotal: 96,
    });
    expect(body.rfqs[0].lines[0]).toMatchObject({
      sku: "SKU-RED",
      productName: "Red Card Shell",
      vendorSku: "SUP-302",
      requestedPieces: 96,
      status: "draft",
    });
  });

  it("caps the RFQ list limit and returns an empty page without extra queries", async () => {
    const headerChain = selectChain([]);
    mocks.db.select.mockReturnValueOnce(headerChain);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/purchasing/rfqs?limit=99999");

    expect(status).toBe(200);
    expect(headerChain.limit).toHaveBeenCalledWith(100);
    expect(body).toMatchObject({ limit: 100, count: 0, statusCounts: {}, rfqs: [] });
    expect(mocks.db.select).toHaveBeenCalledTimes(1);
  });

  it("returns live forecast input gap diagnostics with actionable samples", async () => {
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(30);
    mocks.procurement.getAutoDraftSettings.mockResolvedValue({
      autoDraftMode: "draft_po",
      approvalPolicy: "high_confidence_only",
      includeOrderSoon: false,
      skipOnOpenPo: true,
      skipNoVendor: true,
      candidateScoreStrongThreshold: 80,
      candidateScoreReviewThreshold: 60,
    });
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      {
        product_id: 211,
        variant_id: 2110,
        base_sku: "STALE-TRUST",
        product_name: "Stale Trust Product",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 60,
        previous_outbound_pieces: 60,
        demand_order_count: 12,
        demand_active_days: 10,
        latest_demand_at: "2026-04-01T00:00:00.000Z",
        short_window_days: 7,
        short_outbound_pieces: 14,
        previous_short_outbound_pieces: 14,
        short_demand_order_count: 5,
        short_demand_active_days: 4,
        long_window_days: 90,
        long_outbound_pieces: 180,
        previous_long_outbound_pieces: 180,
        long_demand_order_count: 24,
        long_demand_active_days: 20,
        seasonal_window_days: 30,
        seasonal_outbound_pieces: 60,
        previous_seasonal_outbound_pieces: 60,
        seasonal_demand_order_count: 12,
        seasonal_demand_active_days: 10,
        on_order_pieces: 0,
        open_po_count: 0,
        vendor_product_id: 21100,
        preferred_vendor_id: 77,
        preferred_vendor_name: "Vendor A",
        vendor_lead_time_days: 3,
        safety_stock_days: 1,
        order_uom_units: 10,
        estimated_cost_cents: 125,
        vendor_pricing_basis: "per_piece",
        vendor_purchase_uom: null,
        vendor_quoted_unit_cost_mills: 12500,
        vendor_pieces_per_purchase_uom: null,
        vendor_quoted_at: new Date().toISOString(),
        vendor_product_updated_at: new Date().toISOString(),
      },
      {
        product_id: 212,
        variant_id: 2120,
        base_sku: "MISSING-LATEST",
        product_name: "Missing Latest Product",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 60,
        previous_outbound_pieces: 60,
        demand_order_count: 12,
        demand_active_days: 10,
        latest_demand_at: null,
        short_window_days: 7,
        short_outbound_pieces: 14,
        previous_short_outbound_pieces: 14,
        short_demand_order_count: 5,
        short_demand_active_days: 4,
        long_window_days: 90,
        long_outbound_pieces: 180,
        previous_long_outbound_pieces: 180,
        long_demand_order_count: 24,
        long_demand_active_days: 20,
        seasonal_window_days: 30,
        seasonal_outbound_pieces: 60,
        previous_seasonal_outbound_pieces: 60,
        seasonal_demand_order_count: 12,
        seasonal_demand_active_days: 10,
        on_order_pieces: 0,
        open_po_count: 0,
        vendor_product_id: 21200,
        preferred_vendor_id: 77,
        preferred_vendor_name: "Vendor A",
        vendor_lead_time_days: 3,
        safety_stock_days: 1,
        order_uom_units: 10,
        estimated_cost_cents: 125,
        vendor_pricing_basis: "per_piece",
        vendor_purchase_uom: null,
        vendor_quoted_unit_cost_mills: 12500,
        vendor_pieces_per_purchase_uom: null,
        vendor_quoted_at: new Date().toISOString(),
        vendor_product_updated_at: new Date().toISOString(),
      },
    ]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/purchasing/forecast-input-gaps?limit=5");

    expect(status).toBe(200);
    expect(body).toMatchObject({
      lookbackDays: 30,
      totalRecommendations: 2,
      totalIssueItems: 2,
      inputGapItems: 1,
      reviewItems: 1,
      watchItems: 1,
      forecastTrustHeldAutoDraft: 1,
      gapCounts: {
        missing_latest_demand_at: 1,
      },
      actionCounts: {
        verify_recent_demand: 1,
        repair_order_velocity_source: 1,
      },
    });
    expect(body.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "verify_recent_demand",
          label: "Verify recent demand",
          severity: "warning",
          count: 1,
        }),
        expect.objectContaining({
          code: "repair_order_velocity_source",
          label: "Repair velocity source",
          severity: "warning",
          count: 1,
        }),
      ]),
    );
    expect(body.generatedAt).toEqual(expect.any(String));
    expect(body.samples).toHaveLength(2);
    expect(body.samples[0]).toMatchObject({
      sku: "STALE-TRUST",
      forecastTrustSignal: "stale_recent_demand",
      forecastTrustSeverity: "review",
      qualityGateReason: "forecast_trust_review",
      action: {
        code: "verify_recent_demand",
        href: "/reorder-analysis?forecastAction=verify_recent_demand&recommendationId=211%3A2110%3A30",
      },
    });
    expect(body.samples[1]).toMatchObject({
      sku: "MISSING-LATEST",
      forecastTrustSignal: "missing_latest_demand_timestamp",
      forecastTrustSeverity: "watch",
      inputGaps: ["missing_latest_demand_at"],
      action: {
        code: "repair_order_velocity_source",
        href: "/reorder-analysis?forecastAction=repair_order_velocity_source&recommendationId=212%3A2120%3A30",
      },
    });
  });

  it("returns a filtered recommendation review queue for skipped, held, and quality-review items", async () => {
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(30);
    mocks.procurement.getAutoDraftSettings.mockResolvedValue({
      autoDraftMode: "draft_po",
      approvalPolicy: "high_confidence_and_strong_candidate",
      includeOrderSoon: false,
      skipOnOpenPo: true,
      skipNoVendor: true,
      candidateScoreStrongThreshold: 95,
      candidateScoreReviewThreshold: 80,
    });
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      {
        product_id: 201,
        variant_id: 2001,
        base_sku: "QUEUE-NO-VENDOR",
        product_name: "Queue No Vendor",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 60,
        previous_outbound_pieces: 58,
        demand_order_count: 12,
        demand_active_days: 10,
        on_order_pieces: 0,
        open_po_count: 0,
        lead_time_days: null,
        vendor_lead_time_days: null,
        safety_stock_days: 1,
        order_uom_units: 10,
        order_uom_level: 2,
      },
      {
        product_id: 202,
        variant_id: 2002,
        base_sku: "QUEUE-HELD",
        product_name: "Queue Held",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 90,
        previous_outbound_pieces: 90,
        demand_order_count: 15,
        demand_active_days: 15,
        on_order_pieces: 0,
        open_po_count: 0,
        earliest_expected: null,
        lead_time_days: 2,
        vendor_lead_time_days: 2,
        safety_stock_days: 1,
        order_uom_units: 10,
        order_uom_level: 2,
        vendor_product_id: 7702,
        preferred_vendor_id: 77,
        preferred_vendor_name: "Vendor",
        estimated_cost_cents: 1000,
        vendor_pricing_basis: "per_piece",
        vendor_purchase_uom: null,
        vendor_quoted_unit_cost_mills: 100000,
        vendor_pieces_per_purchase_uom: null,
        vendor_quoted_at: "2026-05-18T12:00:00.000Z",
        vendor_product_updated_at: "2026-05-18T12:00:00.000Z",
      },
      {
        product_id: 203,
        variant_id: 2003,
        base_sku: "QUEUE-MISSING-COST",
        product_name: "Queue Missing Cost",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 60,
        previous_outbound_pieces: 60,
        demand_order_count: 12,
        demand_active_days: 10,
        on_order_pieces: 0,
        open_po_count: 0,
        lead_time_days: 5,
        vendor_lead_time_days: null,
        safety_stock_days: 1,
        order_uom_units: 10,
        order_uom_level: 2,
        vendor_product_id: 8803,
        preferred_vendor_id: 88,
        preferred_vendor_name: "Vendor B",
        vendor_pricing_basis: "per_piece",
        vendor_purchase_uom: null,
        vendor_quoted_unit_cost_mills: 100,
        vendor_pieces_per_purchase_uom: null,
        vendor_quoted_at: new Date().toISOString(),
      },
    ]);
    server = await startServer(buildApp());

    const allQueue = await requestJson(server.url, "GET", "/api/purchasing/recommendation-review-queue?limit=10");

    expect(allQueue.status).toBe(200);
    expect(mocks.procurement.getReorderAnalysisData).toHaveBeenCalledWith(30);
    expect(allQueue.body).toMatchObject({
      lookbackDays: 30,
      approvalPolicy: "high_confidence_and_strong_candidate",
      summary: {
        total: 3,
        skipped: 1,
        heldByPolicy: 1,
        qualityReviewRequired: 1,
      },
      reasonCounts: {
        no_vendor: 1,
        held_by_approval_policy: 1,
        medium_confidence_review: 1,
      },
      actionCounts: {
        prepare_rfq: 1,
        review_approval_policy: 1,
        review_quality_gate: 1,
      },
      filteredCount: 3,
    });
    expect(allQueue.body.items.map((item: any) => item.kind).sort()).toEqual([
      "held_by_policy",
      "quality_review_required",
      "skipped",
    ]);
    const skippedVendor = allQueue.body.items.find((item: any) => item.kind === "skipped");
    const skippedVendorUrl = new URL(skippedVendor.action.href, "https://echelon.example");
    expect(skippedVendor.action).toMatchObject({ action: "prepare_rfq", label: "Add to RFQ selection" });
    expect(Object.fromEntries(skippedVendorUrl.searchParams)).toMatchObject({
      reviewQueue: "skipped",
      recommendationId: "201:2001:30",
    });
    expect(skippedVendor.forecastAction).toMatchObject({
      code: expect.any(String),
      href: expect.stringContaining("recommendationId=201%3A2001%3A30"),
    });
    const skippedForecastUrl = new URL(skippedVendor.forecastAction.href, "https://echelon.example");
    expect(skippedForecastUrl.searchParams.has("reviewQueue")).toBe(false);
    expect(skippedForecastUrl.searchParams.has("reason")).toBe(false);

    const exactSkippedForecastQueue = await requestJson(
      server.url,
      "GET",
      `/api/purchasing/recommendation-review-queue?forecastAction=${encodeURIComponent(skippedVendor.forecastAction.code)}&recommendationId=201%3A2001%3A30&limit=10`,
    );
    expect(exactSkippedForecastQueue.status).toBe(200);
    expect(exactSkippedForecastQueue.body.filteredCount).toBe(1);
    expect(exactSkippedForecastQueue.body.items[0]).toMatchObject({
      kind: "skipped",
      sku: "QUEUE-NO-VENDOR",
      recommendationId: "201:2001:30",
    });

    const heldQueue = await requestJson(
      server.url,
      "GET",
      "/api/purchasing/recommendation-review-queue?kind=held_by_policy&limit=10",
    );

    expect(heldQueue.status).toBe(200);
    expect(heldQueue.body.filteredCount).toBe(1);
    expect(heldQueue.body.items[0]).toMatchObject({
      kind: "held_by_policy",
      sku: "QUEUE-HELD",
      action: {
        action: "review_approval_policy",
        label: "Review policy hold",
      },
      reason: {
        code: "held_by_approval_policy",
      },
      demandEvidence: {
        lookbackDays: 30,
        periodUsagePieces: 90,
        priorPeriodUsagePieces: 90,
        demandOrderCount: 15,
        demandActiveDays: 15,
      },
    });
    const heldReviewUrl = new URL(heldQueue.body.items[0].action.href, "https://echelon.example");
    expect(Object.fromEntries(heldReviewUrl.searchParams)).toMatchObject({
      reviewQueue: "held_by_policy",
      recommendationId: "202:2002:30",
      candidateBand: "review_candidate",
    });

    const qualityReasonQueue = await requestJson(
      server.url,
      "GET",
      "/api/purchasing/recommendation-review-queue?kind=quality_review_required&reason=medium_confidence_review&limit=10",
    );

    expect(qualityReasonQueue.status).toBe(200);
    expect(qualityReasonQueue.body.filters).toMatchObject({
      kind: "quality_review_required",
      reason: "medium_confidence_review",
    });
    expect(qualityReasonQueue.body.filteredCount).toBe(1);
    expect(qualityReasonQueue.body.items[0]).toMatchObject({
      kind: "quality_review_required",
      sku: "QUEUE-MISSING-COST",
      reason: {
        code: "medium_confidence_review",
      },
    });

    const exactQueue = await requestJson(
      server.url,
      "GET",
      "/api/purchasing/recommendation-review-queue?recommendationId=203%3A2003%3A30&limit=10",
    );
    expect(exactQueue.status).toBe(200);
    expect(exactQueue.body.filters.recommendationId).toBe("203:2003:30");
    expect(exactQueue.body.filteredCount).toBe(1);
    expect(exactQueue.body.items[0].sku).toBe("QUEUE-MISSING-COST");

    const currentControlCodes = exactQueue.body.items[0].qualityControls.map((control: any) => control.code);
    expect(currentControlCodes.length).toBeGreaterThan(0);
    const incompleteReview = await requestJson(server.url, "POST", "/api/purchasing/recommendation-decisions", {
      recommendationId: "203:2003:30",
      kind: "quality_review_required",
      decision: "reviewed",
      note: "Reviewed the demand evidence but omitted active controls.",
      reviewedControlCodes: [],
      acknowledgeAutomationEligibilityUnchanged: true,
      confirmDecision: true,
    });
    expect(incompleteReview.status).toBe(400);
    expect(incompleteReview.body.error).toContain("must acknowledge every current control");
    expect(mocks.recommendationPoHandoffService.recordDecision).not.toHaveBeenCalled();
  });

  it("filters recommendation review queue items by forecast action bucket", async () => {
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(30);
    mocks.procurement.getAutoDraftSettings.mockResolvedValue({
      autoDraftMode: "draft_po",
      approvalPolicy: "high_confidence_only",
      includeOrderSoon: false,
      skipOnOpenPo: true,
      skipNoVendor: true,
      candidateScoreStrongThreshold: 80,
      candidateScoreReviewThreshold: 60,
    });
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      {
        product_id: 211,
        variant_id: 2110,
        base_sku: "STALE-TRUST",
        product_name: "Stale Trust Product",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 60,
        previous_outbound_pieces: 60,
        demand_order_count: 12,
        demand_active_days: 10,
        latest_demand_at: "2026-04-01T00:00:00.000Z",
        short_window_days: 7,
        short_outbound_pieces: 14,
        previous_short_outbound_pieces: 14,
        short_demand_order_count: 5,
        short_demand_active_days: 4,
        long_window_days: 90,
        long_outbound_pieces: 180,
        previous_long_outbound_pieces: 180,
        long_demand_order_count: 24,
        long_demand_active_days: 20,
        seasonal_window_days: 30,
        seasonal_outbound_pieces: 60,
        previous_seasonal_outbound_pieces: 60,
        seasonal_demand_order_count: 12,
        seasonal_demand_active_days: 10,
        on_order_pieces: 0,
        open_po_count: 0,
        vendor_product_id: 21100,
        preferred_vendor_id: 77,
        preferred_vendor_name: "Vendor A",
        vendor_lead_time_days: 3,
        safety_stock_days: 1,
        order_uom_units: 10,
        estimated_cost_cents: 125,
        vendor_pricing_basis: "per_piece",
        vendor_purchase_uom: null,
        vendor_quoted_unit_cost_mills: 12500,
        vendor_pieces_per_purchase_uom: null,
        vendor_quoted_at: new Date().toISOString(),
        vendor_product_updated_at: new Date().toISOString(),
      },
      {
        product_id: 212,
        variant_id: 2120,
        base_sku: "MISSING-LATEST",
        product_name: "Missing Latest Product",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 12,
        previous_outbound_pieces: 12,
        demand_order_count: 1,
        demand_active_days: 1,
        latest_demand_at: null,
        short_window_days: 7,
        short_outbound_pieces: 2,
        previous_short_outbound_pieces: 2,
        short_demand_order_count: 1,
        short_demand_active_days: 1,
        long_window_days: 90,
        long_outbound_pieces: 30,
        previous_long_outbound_pieces: 30,
        long_demand_order_count: 3,
        long_demand_active_days: 3,
        seasonal_window_days: 30,
        seasonal_outbound_pieces: 12,
        previous_seasonal_outbound_pieces: 12,
        seasonal_demand_order_count: 1,
        seasonal_demand_active_days: 1,
        on_order_pieces: 0,
        open_po_count: 0,
        vendor_product_id: 21200,
        preferred_vendor_id: 77,
        preferred_vendor_name: "Vendor A",
        vendor_lead_time_days: 3,
        safety_stock_days: 1,
        order_uom_units: 10,
        estimated_cost_cents: 125,
        vendor_pricing_basis: "per_piece",
        vendor_purchase_uom: null,
        vendor_quoted_unit_cost_mills: 12500,
        vendor_pieces_per_purchase_uom: null,
        vendor_quoted_at: new Date().toISOString(),
        vendor_product_updated_at: new Date().toISOString(),
      },
    ]);
    server = await startServer(buildApp());

    const recentDemandQueue = await requestJson(
      server.url,
      "GET",
      "/api/purchasing/recommendation-review-queue?kind=quality_review_required&forecastAction=verify_recent_demand&limit=10",
    );

    expect(recentDemandQueue.status).toBe(200);
    expect(recentDemandQueue.body.filters).toMatchObject({
      kind: "quality_review_required",
      forecastAction: "verify_recent_demand",
    });
    expect(recentDemandQueue.body.forecastActionCounts).toMatchObject({
      verify_recent_demand: 1,
      repair_order_velocity_source: 1,
    });
    expect(recentDemandQueue.body.filteredCount).toBe(1);
    expect(recentDemandQueue.body.items[0]).toMatchObject({
      sku: "STALE-TRUST",
      reason: {
        code: "forecast_trust_review",
      },
      forecastAction: {
        code: "verify_recent_demand",
        href: "/reorder-analysis?forecastAction=verify_recent_demand&recommendationId=211%3A2110%3A30",
      },
    });

    const sourceRepairQueue = await requestJson(
      server.url,
      "GET",
      "/api/purchasing/recommendation-review-queue?kind=quality_review_required&forecastAction=repair_order_velocity_source&limit=10",
    );

    expect(sourceRepairQueue.status).toBe(200);
    expect(sourceRepairQueue.body.filteredCount).toBe(1);
    expect(sourceRepairQueue.body.items[0]).toMatchObject({
      sku: "MISSING-LATEST",
      forecastAction: {
        code: "repair_order_velocity_source",
        href: "/reorder-analysis?forecastAction=repair_order_velocity_source&recommendationId=212%3A2120%3A30",
      },
    });

    const invalidActionQueue = await requestJson(
      server.url,
      "GET",
      "/api/purchasing/recommendation-review-queue?forecastAction=bad_bucket",
    );

    expect(invalidActionQueue.status).toBe(400);
    expect(invalidActionQueue.body.error).toContain("forecastAction must be one of");
  });

  it("attaches latest operator decisions to recommendation review queue items", async () => {
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(30);
    mocks.procurement.getAutoDraftSettings.mockResolvedValue({
      autoDraftMode: "draft_po",
      approvalPolicy: "high_confidence_and_strong_candidate",
      includeOrderSoon: false,
      skipOnOpenPo: true,
      skipNoVendor: true,
      candidateScoreStrongThreshold: 95,
      candidateScoreReviewThreshold: 80,
    });
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      {
        product_id: 202,
        variant_id: 2002,
        base_sku: "QUEUE-HELD",
        product_name: "Queue Held",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 90,
        previous_outbound_pieces: 90,
        demand_order_count: 15,
        demand_active_days: 15,
        on_order_pieces: 0,
        open_po_count: 0,
        earliest_expected: null,
        lead_time_days: 2,
        vendor_lead_time_days: 2,
        safety_stock_days: 1,
        order_uom_units: 10,
        order_uom_level: 2,
        vendor_product_id: 7702,
        preferred_vendor_id: 77,
        preferred_vendor_name: "Vendor",
        estimated_cost_cents: 1000,
        vendor_pricing_basis: "per_piece",
        vendor_purchase_uom: null,
        vendor_quoted_unit_cost_mills: 100000,
        vendor_pieces_per_purchase_uom: null,
        vendor_quoted_at: "2026-05-18T12:00:00.000Z",
        vendor_product_updated_at: "2026-05-18T12:00:00.000Z",
      },
    ]);
    mocks.procurement.getLatestRecommendationDecisions.mockResolvedValue([
      {
        id: 77,
        recommendationId: "202:2002:30",
        kind: "held_by_policy",
        decision: "reviewed",
        status: "active",
        decisionReason: "held_by_approval_policy",
        sku: "QUEUE-HELD",
        decidedBy: "admin-user",
        decidedAt: "2026-05-22T12:00:00.000Z",
      },
    ]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(
      server.url,
      "GET",
      "/api/purchasing/recommendation-review-queue?kind=held_by_policy&limit=10",
    );

    expect(status).toBe(200);
    expect(mocks.procurement.getLatestRecommendationDecisions).toHaveBeenCalledWith(
      ["202:2002:30"],
      ["held_by_policy"],
    );
    expect(body.decisionCounts).toMatchObject({ reviewed: 1, acceptedForPo: 0, deferred: 0, dismissed: 0 });
    expect(body.items[0]).toMatchObject({
      sku: "QUEUE-HELD",
      latestDecision: {
        id: 77,
        decision: "reviewed",
        decidedBy: "admin-user",
      },
    });
  });

  it("records recommendation decisions with a server-side queue snapshot", async () => {
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(30);
    mocks.procurement.getAutoDraftSettings.mockResolvedValue({
      autoDraftMode: "draft_po",
      approvalPolicy: "high_confidence_and_strong_candidate",
      includeOrderSoon: false,
      skipOnOpenPo: true,
      skipNoVendor: true,
      candidateScoreStrongThreshold: 95,
      candidateScoreReviewThreshold: 80,
    });
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      {
        product_id: 202,
        variant_id: 2002,
        base_sku: "QUEUE-HELD",
        product_name: "Queue Held",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 90,
        previous_outbound_pieces: 90,
        demand_order_count: 15,
        demand_active_days: 15,
        on_order_pieces: 0,
        open_po_count: 0,
        earliest_expected: null,
        lead_time_days: 2,
        vendor_lead_time_days: 2,
        safety_stock_days: 1,
        order_uom_units: 10,
        order_uom_level: 2,
        vendor_product_id: 7702,
        preferred_vendor_id: 77,
        preferred_vendor_name: "Vendor",
        estimated_cost_cents: 1000,
        vendor_pricing_basis: "per_piece",
        vendor_purchase_uom: null,
        vendor_quoted_unit_cost_mills: 100000,
        vendor_pieces_per_purchase_uom: null,
        vendor_quoted_at: "2026-05-18T12:00:00.000Z",
        vendor_product_updated_at: "2026-05-18T12:00:00.000Z",
      },
    ]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "POST", "/api/purchasing/recommendation-decisions", {
      recommendationId: "202:2002:30",
      kind: "held_by_policy",
      decision: "accepted_for_po",
      note: "Looks good for the next PO review.",
      reviewedControlCodes: [],
      acknowledgeAutomationEligibilityUnchanged: true,
      confirmDecision: true,
    });

    expect(status).toBe(201);
    expect(mocks.recommendationPoHandoffService.recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      recommendationId: "202:2002:30",
      kind: "held_by_policy",
      decision: "accepted_for_po",
      decisionReason: "held_by_approval_policy",
      note: "Looks good for the next PO review.",
      productId: 202,
      productVariantId: 2002,
      vendorId: 77,
      sku: "QUEUE-HELD",
      productName: "Queue Held",
      candidateBand: "review_candidate",
      decidedBy: "admin-user",
      recommendationSnapshot: expect.objectContaining({
        lookbackDays: 30,
        approvalPolicy: "high_confidence_and_strong_candidate",
        item: expect.objectContaining({
          sku: "QUEUE-HELD",
          kind: "held_by_policy",
          suggestedOrderPieces: 9,
          orderUomUnits: 1,
          vendorProductId: 7702,
          estimatedCostMills: 100000,
          estimatedCostCents: 1000,
          pricingBasis: "per_piece",
          purchaseUom: null,
          quotedUnitCostMills: 100000,
          piecesPerPurchaseUom: null,
        }),
        reviewEvidence: expect.objectContaining({
          contractVersion: 1,
          reviewedControlCodes: [],
          automationEligibilityAcknowledged: true,
          decisionConfirmed: true,
        }),
      }),
    }));
    expect(body.decision).toMatchObject({
      id: 5001,
      recommendationId: "202:2002:30",
      decision: "accepted_for_po",
      sku: "QUEUE-HELD",
    });

    const unconfirmed = await requestJson(server.url, "POST", "/api/purchasing/recommendation-decisions", {
      recommendationId: "202:2002:30",
      kind: "held_by_policy",
      decision: "accepted_for_po",
      note: "This has enough rationale but is not confirmed.",
      reviewedControlCodes: [],
      acknowledgeAutomationEligibilityUnchanged: true,
    });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.error).toContain("confirmDecision must be true");

    const automationNotAcknowledged = await requestJson(server.url, "POST", "/api/purchasing/recommendation-decisions", {
      recommendationId: "202:2002:30",
      kind: "held_by_policy",
      decision: "accepted_for_po",
      note: "This has enough rationale and is explicitly confirmed.",
      reviewedControlCodes: [],
      confirmDecision: true,
    });
    expect(automationNotAcknowledged.status).toBe(400);
    expect(automationNotAcknowledged.body.error).toContain("acknowledgeAutomationEligibilityUnchanged must be true");

    const unknownControl = await requestJson(server.url, "POST", "/api/purchasing/recommendation-decisions", {
      recommendationId: "202:2002:30",
      kind: "held_by_policy",
      decision: "accepted_for_po",
      note: "This tries to acknowledge a control that is not current.",
      reviewedControlCodes: ["invented_control"],
      acknowledgeAutomationEligibilityUnchanged: true,
      confirmDecision: true,
    });
    expect(unknownControl.status).toBe(400);
    expect(unknownControl.body.error).toContain("not current");

    const duplicateControls = await requestJson(server.url, "POST", "/api/purchasing/recommendation-decisions", {
      recommendationId: "202:2002:30",
      kind: "held_by_policy",
      decision: "deferred",
      note: "This disposition includes a duplicate control acknowledgment.",
      reviewedControlCodes: ["duplicate", "duplicate"],
      confirmDecision: true,
    });
    expect(duplicateControls.status).toBe(400);
    expect(duplicateControls.body.error).toContain("reviewedControlCodes must be an array of unique");
    expect(mocks.recommendationPoHandoffService.recordDecision).toHaveBeenCalledTimes(1);
  });

  // Healthy top-off (owner use case: reach a vendor MOQ / free-freight
  // threshold): a healthy, analyzable item is a "skipped" review-queue member
  // (reason not_actionable_status) with a zero suggestion, and can be
  // accepted for PO; excluded and vendor-less zero-suggestion items stay
  // fail-closed at the decision endpoint.
  it("accepts a healthy zero-suggestion item for a top-off while excluded and vendor-less items stay fail-closed", async () => {
    const healthyRow = (overrides: Record<string, unknown>) => ({
      total_pieces: 500,
      total_reserved_pieces: 0,
      total_outbound_pieces: 30,
      previous_outbound_pieces: 30,
      demand_order_count: 12,
      demand_active_days: 10,
      on_order_pieces: 0,
      open_po_count: 0,
      earliest_expected: null,
      lead_time_days: 2,
      vendor_lead_time_days: 2,
      safety_stock_days: 1,
      order_uom_units: 1,
      order_uom_level: 2,
      ...overrides,
    });
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(30);
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      healthyRow({
        product_id: 301,
        variant_id: 3001,
        base_sku: "HEALTHY-TOPOFF",
        product_name: "Healthy Topoff",
        vendor_product_id: 7703,
        preferred_vendor_id: 77,
        preferred_vendor_name: "Vendor",
        estimated_cost_cents: 1000,
        vendor_pricing_basis: "per_piece",
        vendor_purchase_uom: null,
        vendor_quoted_unit_cost_mills: 100000,
        vendor_pieces_per_purchase_uom: null,
        vendor_moq: 200,
        vendor_quoted_at: "2026-05-18T12:00:00.000Z",
        vendor_product_updated_at: "2026-05-18T12:00:00.000Z",
      }),
      healthyRow({
        product_id: 302,
        variant_id: 3002,
        base_sku: "HEALTHY-NO-VENDOR",
        product_name: "Healthy No Vendor",
      }),
      healthyRow({
        product_id: 303,
        variant_id: 3003,
        base_sku: "EXCLUDED-HEALTHY",
        product_name: "Excluded Healthy",
        vendor_product_id: 7704,
        preferred_vendor_id: 77,
        preferred_vendor_name: "Vendor",
        estimated_cost_cents: 1000,
        vendor_pricing_basis: "per_piece",
        vendor_purchase_uom: null,
        vendor_quoted_unit_cost_mills: 100000,
        vendor_pieces_per_purchase_uom: null,
        vendor_quoted_at: "2026-05-18T12:00:00.000Z",
        vendor_product_updated_at: "2026-05-18T12:00:00.000Z",
      }),
    ]);
    mocks.db.execute.mockImplementation(async (query: unknown) => {
      let text = "";
      try {
        text = JSON.stringify(query) ?? "";
      } catch {
        text = "";
      }
      if (text.includes("reorder_excluded")) {
        return {
          rows: [
            { id: 303, category: null, brand: null, product_type: null, sku: "EXCLUDED-HEALTHY", tags: null, reorder_excluded: true },
          ],
        };
      }
      return { rows: [] };
    });
    server = await startServer(buildApp());

    // Queue membership: all three healthy rows are "skipped" members with a
    // zero suggestion; only the analyzable one is decision-acceptable.
    const queue = await requestJson(server.url, "GET", "/api/purchasing/recommendation-review-queue?limit=10");
    expect(queue.status).toBe(200);
    const healthyEntry = queue.body.items.find((item: any) => item.sku === "HEALTHY-TOPOFF");
    expect(healthyEntry).toMatchObject({
      kind: "skipped",
      recommendationId: "301:3001:30",
      reason: { code: "not_actionable_status" },
      suggestedOrderQty: 0,
      suggestedOrderPieces: 0,
      actionable: false,
      preferredVendorId: 77,
      vendorProductId: 7703,
    });
    expect(queue.body.items.find((item: any) => item.sku === "HEALTHY-NO-VENDOR")).toMatchObject({
      kind: "skipped",
      reason: { code: "not_actionable_status" },
      suggestedOrderPieces: 0,
      preferredVendorId: null,
    });
    expect(queue.body.items.find((item: any) => item.sku === "EXCLUDED-HEALTHY")).toMatchObject({
      kind: "skipped",
      reason: { code: "excluded" },
      suggestedOrderPieces: 0,
    });

    const controlCodes = healthyEntry.qualityControls.map((control: any) => control.code);
    const accepted = await requestJson(server.url, "POST", "/api/purchasing/recommendation-decisions", {
      recommendationId: "301:3001:30",
      kind: "skipped",
      decision: "accepted_for_po",
      note: "Top off this healthy SKU to reach the vendor free-freight threshold.",
      reviewedControlCodes: controlCodes,
      acknowledgeAutomationEligibilityUnchanged: true,
      confirmDecision: true,
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(mocks.recommendationPoHandoffService.recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      recommendationId: "301:3001:30",
      kind: "skipped",
      decision: "accepted_for_po",
      decisionReason: "not_actionable_status",
      productId: 301,
      productVariantId: 3001,
      vendorId: 77,
      sku: "HEALTHY-TOPOFF",
      recommendationSnapshot: expect.objectContaining({
        item: expect.objectContaining({
          suggestedOrderQty: 0,
          suggestedOrderPieces: 0,
          preferredVendorId: 77,
          vendorProductId: 7703,
          pricingBasis: "per_piece",
          quotedUnitCostMills: 100000,
        }),
      }),
    }));

    // Acknowledge each entry's CURRENT controls so the requests pass the
    // evidence validator and prove the analyzability gate is what rejects.
    const controlCodesFor = (sku: string) =>
      queue.body.items.find((entry: any) => entry.sku === sku).qualityControls.map((control: any) => control.code);
    const excludedAccept = await requestJson(server.url, "POST", "/api/purchasing/recommendation-decisions", {
      recommendationId: "303:3003:30",
      kind: "skipped",
      decision: "accepted_for_po",
      note: "Excluded rows must never be orderable through a zero-quantity top-off.",
      reviewedControlCodes: controlCodesFor("EXCLUDED-HEALTHY"),
      acknowledgeAutomationEligibilityUnchanged: true,
      confirmDecision: true,
    });
    expect(excludedAccept.status).toBe(409);
    expect(excludedAccept.body.code).toBe("ZERO_BASELINE_ACCEPTANCE_NOT_ANALYZABLE");

    const noVendorAccept = await requestJson(server.url, "POST", "/api/purchasing/recommendation-decisions", {
      recommendationId: "302:3002:30",
      kind: "skipped",
      decision: "accepted_for_po",
      note: "Vendor-less rows must never be orderable through a zero-quantity top-off.",
      reviewedControlCodes: controlCodesFor("HEALTHY-NO-VENDOR"),
      acknowledgeAutomationEligibilityUnchanged: true,
      confirmDecision: true,
    });
    expect(noVendorAccept.status).toBe(409);
    expect(noVendorAccept.body.code).toBe("ZERO_BASELINE_ACCEPTANCE_NOT_ANALYZABLE");
    expect(mocks.recommendationPoHandoffService.recordDecision).toHaveBeenCalledTimes(1);

    // Non-ordering dispositions on excluded rows stay available.
    const excludedDeferred = await requestJson(server.url, "POST", "/api/purchasing/recommendation-decisions", {
      recommendationId: "303:3003:30",
      kind: "skipped",
      decision: "deferred",
      note: "Keep the exclusion; revisit next quarter.",
      reviewedControlCodes: [],
      confirmDecision: true,
    });
    expect(excludedDeferred.status, JSON.stringify(excludedDeferred.body)).toBe(201);
    expect(mocks.recommendationPoHandoffService.recordDecision).toHaveBeenCalledTimes(2);
  });

  it("returns recent recommendation decision history with operator summary counts", async () => {
    mocks.procurement.getRecentRecommendationDecisions.mockResolvedValue([
      {
        id: 102,
        recommendationId: "202:2002:30",
        kind: "held_by_policy",
        decision: "po_handoff_created",
        status: "active",
        decisionReason: "accepted_recommendation_po_handoff",
        sku: "QUEUE-HELD",
        productName: "Queue Held",
        candidateScore: 88,
        candidateBand: "review_candidate",
        decidedBy: "admin-user",
        decidedAt: "2026-05-23T10:00:00.000Z",
      },
      {
        id: 101,
        recommendationId: "202:2002:30",
        kind: "held_by_policy",
        decision: "accepted_for_po",
        status: "active",
        decisionReason: "held_by_approval_policy",
        sku: "QUEUE-HELD",
        productName: "Queue Held",
        candidateScore: 88,
        candidateBand: "review_candidate",
        decidedBy: "admin-user",
        decidedAt: "2026-05-23T09:00:00.000Z",
      },
      {
        id: 100,
        recommendationId: "303:3003:30",
        kind: "quality_review_required",
        decision: "deferred",
        status: "inactive",
        decisionReason: "medium_confidence_review",
        sku: "PROMO-DEMAND",
        productName: "Promo Demand",
        decidedBy: "admin-user",
        decidedAt: "2026-05-22T18:00:00.000Z",
      },
    ]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/purchasing/recommendation-decisions?limit=10");

    expect(status).toBe(200);
    expect(mocks.procurement.getRecentRecommendationDecisions).toHaveBeenCalledWith(10);
    expect(body.summary).toMatchObject({
      total: 3,
      active: 2,
      acceptedForPo: 1,
      poHandoffCreated: 1,
      deferred: 1,
      dismissed: 0,
      reviewed: 0,
      latestDecidedAt: "2026-05-23T10:00:00.000Z",
      decisionCounts: {
        accepted_for_po: 1,
        po_handoff_created: 1,
        deferred: 1,
      },
      kindCounts: {
        held_by_policy: 2,
        quality_review_required: 1,
      },
      statusCounts: {
        active: 2,
        inactive: 1,
      },
    });
    expect(body.decisions[0]).toMatchObject({
      id: 102,
      recommendationId: "202:2002:30",
      decision: "po_handoff_created",
      sku: "QUEUE-HELD",
      candidateScore: 88,
    });
  });

  it("returns accepted recommendations as a PO review staging queue", async () => {
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(30);
    mocks.procurement.getAutoDraftSettings.mockResolvedValue({
      autoDraftMode: "draft_po",
      approvalPolicy: "high_confidence_and_strong_candidate",
      includeOrderSoon: false,
      skipOnOpenPo: true,
      skipNoVendor: true,
      candidateScoreStrongThreshold: 95,
      candidateScoreReviewThreshold: 80,
    });
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      {
        product_id: 202,
        variant_id: 2002,
        base_sku: "QUEUE-HELD",
        product_name: "Queue Held",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 90,
        previous_outbound_pieces: 90,
        demand_order_count: 15,
        demand_active_days: 15,
        on_order_pieces: 0,
        open_po_count: 0,
        earliest_expected: null,
        lead_time_days: 2,
        vendor_lead_time_days: 2,
        safety_stock_days: 1,
        order_uom_units: 10,
        order_uom_level: 2,
        vendor_product_id: 7702,
        preferred_vendor_id: 77,
        preferred_vendor_name: "Vendor",
        estimated_cost_cents: 1000,
        vendor_pricing_basis: "per_piece",
        vendor_purchase_uom: null,
        vendor_quoted_unit_cost_mills: 100000,
        vendor_pieces_per_purchase_uom: null,
        vendor_quoted_at: "2026-05-18T12:00:00.000Z",
        vendor_product_updated_at: "2026-05-18T12:00:00.000Z",
      },
    ]);
    mocks.procurement.getLatestRecommendationDecisionsByDecision.mockResolvedValue([
      {
        id: 91,
        recommendationId: "202:2002:30",
        kind: "held_by_policy",
        decision: "accepted_for_po",
        status: "active",
        sku: "QUEUE-HELD",
        productName: "Queue Held",
        vendorId: 77,
        decidedAt: "2026-05-22T12:00:00.000Z",
        recommendationSnapshot: {
          lookbackDays: 30,
          item: {
            productId: 202,
            productVariantId: 2002,
            sku: "QUEUE-HELD",
            productName: "Queue Held",
            preferredVendorId: 77,
            vendorProductId: 7702,
            suggestedOrderQty: 9,
            suggestedOrderPieces: 9,
            orderUomUnits: 1,
            orderUomLabel: "pieces",
            preferredVendorName: "Vendor",
            estimatedCostMills: 100000,
            estimatedCostCents: 1000,
            pricingBasis: "per_piece",
            purchaseUom: null,
            quotedUnitCostMills: 100000,
            piecesPerPurchaseUom: null,
            quoteReference: null,
            quotedAt: "2026-05-18T12:00:00.000Z",
            quoteValidUntil: null,
          },
        },
      },
      {
        id: 90,
        recommendationId: "999:product:30",
        kind: "quality_review_required",
        decision: "accepted_for_po",
        status: "active",
        sku: "STALE-ACCEPTED",
        productName: "Stale Accepted",
        decidedAt: "2026-05-21T12:00:00.000Z",
        recommendationSnapshot: {
          item: {
            sku: "STALE-ACCEPTED",
            productName: "Stale Accepted",
            suggestedOrderQty: 2,
            orderUomLabel: "Each",
            candidateScore: { score: 61, band: "review_candidate" },
          },
        },
      },
    ]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/purchasing/recommendation-accepted-queue?limit=10");

    expect(status).toBe(200);
    expect(mocks.procurement.getLatestRecommendationDecisionsByDecision).toHaveBeenCalledWith("accepted_for_po", 10);
    expect(body).toMatchObject({
      lookbackDays: 30,
      approvalPolicy: "high_confidence_and_strong_candidate",
      loadedDecisionCount: 2,
      summary: {
        total: 2,
        current: 1,
        stale: 1,
        vendorCount: 1,
      },
    });
    expect(body.items[0]).toMatchObject({
      recommendationId: "202:2002:30",
      current: true,
      source: "current_recommendation",
      sku: "QUEUE-HELD",
      preferredVendorName: "Vendor",
      action: {
        label: "Review current",
      },
    });
    expect(body.items[1]).toMatchObject({
      recommendationId: "999:product:30",
      current: false,
      source: "decision_snapshot",
      sku: "STALE-ACCEPTED",
      action: {
        label: "Review snapshot",
      },
    });
  });

  it("creates a draft PO handoff from current accepted recommendations", async () => {
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(30);
    mocks.procurement.getAutoDraftSettings.mockResolvedValue({
      autoDraftMode: "draft_po",
      approvalPolicy: "high_confidence_and_strong_candidate",
      includeOrderSoon: false,
      skipOnOpenPo: true,
      skipNoVendor: true,
      candidateScoreStrongThreshold: 95,
      candidateScoreReviewThreshold: 80,
    });
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      {
        product_id: 202,
        variant_id: 2002,
        base_sku: "QUEUE-HELD",
        product_name: "Queue Held",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 90,
        previous_outbound_pieces: 90,
        demand_order_count: 15,
        demand_active_days: 15,
        on_order_pieces: 0,
        open_po_count: 0,
        earliest_expected: null,
        lead_time_days: 2,
        vendor_lead_time_days: 2,
        safety_stock_days: 1,
        order_uom_units: 10,
        order_uom_level: 2,
        vendor_product_id: 7702,
        preferred_vendor_id: 77,
        preferred_vendor_name: "Vendor",
        estimated_cost_cents: 1000,
        vendor_pricing_basis: "per_piece",
        vendor_purchase_uom: null,
        vendor_quoted_unit_cost_mills: 100000,
        vendor_pieces_per_purchase_uom: null,
        vendor_moq: 1,
        vendor_quoted_at: "2026-05-18T12:00:00.000Z",
        vendor_product_updated_at: "2026-05-18T12:00:00.000Z",
      },
    ]);
    const acceptedHandoffDecisionRows = [
      {
        id: 91,
        recommendationId: "202:2002:30",
        kind: "held_by_policy",
        decision: "accepted_for_po",
        status: "active",
        sku: "QUEUE-HELD",
        productName: "Queue Held",
        vendorId: 77,
        decidedAt: "2026-05-22T12:00:00.000Z",
        recommendationSnapshot: {
          lookbackDays: 30,
          item: {
            productId: 202,
            productVariantId: 2002,
            sku: "QUEUE-HELD",
            productName: "Queue Held",
            preferredVendorId: 77,
            vendorProductId: 7702,
            suggestedOrderQty: 9,
            suggestedOrderPieces: 9,
            orderUomUnits: 1,
            orderUomLabel: "pieces",
            preferredVendorName: "Vendor",
            estimatedCostMills: 100000,
            estimatedCostCents: 1000,
            pricingBasis: "per_piece",
            purchaseUom: null,
            quotedUnitCostMills: 100000,
            piecesPerPurchaseUom: null,
            supplierBasis: {
              minimumOrderPieces: 1,
            },
            quoteReference: null,
            quotedAt: "2026-05-18T12:00:00.000Z",
            quoteValidUntil: null,
          },
        },
      },
    ];
    mocks.procurement.getLatestRecommendationDecisions.mockResolvedValue(acceptedHandoffDecisionRows);
    mocks.recommendationPoHandoffService.createAcceptedHandoff.mockResolvedValue({
      pos: [{ id: 12, poNumber: "PO-20260522-001", vendorId: 77, status: "draft" }],
      decisions: [{
        id: 5002,
        recommendationId: "202:2002:30",
        kind: "held_by_policy",
        decision: "po_handoff_created",
        status: "active",
      }],
      handedOff: [{
        acceptedDecisionId: 91,
        handoffDecisionId: 5002,
        recommendationId: "202:2002:30",
        kind: "held_by_policy",
        sku: "QUEUE-HELD",
        poId: 12,
        poLineId: 1201,
        poIds: [12],
      }],
    });
    server = await startServer(buildApp());

    acceptedHandoffDecisionRows[0].recommendationSnapshot.item.suggestedOrderQty = 18;
    acceptedHandoffDecisionRows[0].recommendationSnapshot.item.suggestedOrderPieces = 18;
    const drifted = await requestJson(
      server.url,
      "POST",
      "/api/purchasing/recommendation-accepted-queue/create-po",
      { items: [{ recommendationId: "202:2002:30", kind: "held_by_policy" }] },
    );
    expect(drifted).toMatchObject({
      status: 409,
      body: {
        skipped: [{
          reason: "accepted_economics_changed",
          context: { changedFields: expect.arrayContaining(["suggestedOrderQty", "suggestedOrderPieces"]) },
        }],
      },
    });
    expect(mocks.recommendationPoHandoffService.createAcceptedHandoff).not.toHaveBeenCalled();
    acceptedHandoffDecisionRows[0].recommendationSnapshot.item.suggestedOrderQty = 9;
    acceptedHandoffDecisionRows[0].recommendationSnapshot.item.suggestedOrderPieces = 9;

    acceptedHandoffDecisionRows[0].recommendationSnapshot.item.supplierBasis.minimumOrderPieces = 2;
    const moqDrifted = await requestJson(
      server.url,
      "POST",
      "/api/purchasing/recommendation-accepted-queue/create-po",
      { items: [{ recommendationId: "202:2002:30", kind: "held_by_policy" }] },
    );
    expect(moqDrifted).toMatchObject({
      status: 409,
      body: {
        skipped: [{
          reason: "accepted_economics_changed",
          context: { changedFields: ["minimumOrderPieces"] },
        }],
      },
    });
    expect(mocks.recommendationPoHandoffService.createAcceptedHandoff).not.toHaveBeenCalled();
    acceptedHandoffDecisionRows[0].recommendationSnapshot.item.supplierBasis.minimumOrderPieces = 1;

    const { status, body } = await requestJson(
      server.url,
      "POST",
      "/api/purchasing/recommendation-accepted-queue/create-po",
      {
        items: [{ recommendationId: "202:2002:30", kind: "held_by_policy" }],
      },
    );

    expect(status, JSON.stringify(body)).toBe(201);
    expect(mocks.procurement.getLatestRecommendationDecisions).toHaveBeenCalledWith(
      ["202:2002:30"],
      ["held_by_policy"],
    );
    expect(mocks.recommendationPoHandoffService.createAcceptedHandoff).toHaveBeenCalledWith({
      actorId: "admin-user",
      items: [
        expect.objectContaining({
          acceptedDecisionId: 91,
          recommendationId: "202:2002:30",
          kind: "held_by_policy",
          productId: 202,
          productVariantId: 2002,
          suggestedPieces: 9,
          orderUomUnits: 1,
          vendorProductId: 7702,
          vendorId: 77,
          sku: "QUEUE-HELD",
          recommendationSnapshot: expect.objectContaining({
            approvalPolicy: "high_confidence_and_strong_candidate",
          }),
        }),
      ],
    });
    expect(body).toMatchObject({
      success: true,
      count: 1,
      itemsDrafted: 1,
      handedOff: [
        {
          recommendationId: "202:2002:30",
          kind: "held_by_policy",
          sku: "QUEUE-HELD",
          poId: 12,
          poLineId: 1201,
          poIds: [12],
        },
      ],
      skipped: [],
    });

    // Order Builder quantity override (design spec §14): the edited quantity
    // and its evidence pass through to the handoff service unchanged; the
    // accepted snapshot's pieces remain the suggestedPieces baseline.
    mocks.recommendationPoHandoffService.createAcceptedHandoff.mockClear();
    const override = await requestJson(
      server.url,
      "POST",
      "/api/purchasing/recommendation-accepted-queue/create-po",
      {
        items: [{
          recommendationId: "202:2002:30",
          kind: "held_by_policy",
          requestedPieces: 12,
          quantityOverrideReason: "Vendor price break at 12 pieces",
          allocationOverrideApproved: true,
        }],
      },
    );
    expect(override.status, JSON.stringify(override.body)).toBe(201);
    expect(mocks.recommendationPoHandoffService.createAcceptedHandoff).toHaveBeenCalledWith({
      actorId: "admin-user",
      items: [
        expect.objectContaining({
          acceptedDecisionId: 91,
          suggestedPieces: 9,
          requestedPieces: 12,
          quantityOverrideReason: "Vendor price break at 12 pieces",
          allocationOverrideApproved: true,
        }),
      ],
    });
  });

  // Healthy top-off handoff: an accepted zero-suggestion line reaches the
  // handoff service ONLY with an explicit requested quantity (which exceeds
  // the zero baseline and carries the override-evidence pair); without one it
  // fails closed before any service call.
  it("creates a zero-baseline top-off PO handoff at the requested quantity", async () => {
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(30);
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      {
        product_id: 301,
        variant_id: 3001,
        base_sku: "HEALTHY-TOPOFF",
        product_name: "Healthy Topoff",
        total_pieces: 500,
        total_reserved_pieces: 0,
        total_outbound_pieces: 30,
        previous_outbound_pieces: 30,
        demand_order_count: 12,
        demand_active_days: 10,
        on_order_pieces: 0,
        open_po_count: 0,
        earliest_expected: null,
        lead_time_days: 2,
        vendor_lead_time_days: 2,
        safety_stock_days: 1,
        order_uom_units: 1,
        order_uom_level: 2,
        vendor_product_id: 7703,
        preferred_vendor_id: 77,
        preferred_vendor_name: "Vendor",
        estimated_cost_cents: 1000,
        vendor_pricing_basis: "per_piece",
        vendor_purchase_uom: null,
        vendor_quoted_unit_cost_mills: 100000,
        vendor_pieces_per_purchase_uom: null,
        vendor_moq: 200,
        vendor_quoted_at: "2026-05-18T12:00:00.000Z",
        vendor_product_updated_at: "2026-05-18T12:00:00.000Z",
      },
    ]);
    mocks.procurement.getLatestRecommendationDecisions.mockResolvedValue([
      {
        id: 95,
        recommendationId: "301:3001:30",
        kind: "skipped",
        decision: "accepted_for_po",
        status: "active",
        sku: "HEALTHY-TOPOFF",
        productName: "Healthy Topoff",
        vendorId: 77,
        decidedAt: "2026-05-22T12:00:00.000Z",
        recommendationSnapshot: {
          lookbackDays: 30,
          item: {
            productId: 301,
            productVariantId: 3001,
            sku: "HEALTHY-TOPOFF",
            productName: "Healthy Topoff",
            preferredVendorId: 77,
            vendorProductId: 7703,
            suggestedOrderQty: 0,
            suggestedOrderPieces: 0,
            orderUomUnits: 1,
            orderUomLabel: "pieces",
            preferredVendorName: "Vendor",
            estimatedCostMills: 100000,
            estimatedCostCents: 1000,
            pricingBasis: "per_piece",
            purchaseUom: null,
            quotedUnitCostMills: 100000,
            piecesPerPurchaseUom: null,
            supplierBasis: {
              minimumOrderPieces: 200,
            },
            quoteReference: null,
            quotedAt: "2026-05-18T12:00:00.000Z",
            quoteValidUntil: null,
          },
        },
      },
    ]);
    mocks.recommendationPoHandoffService.createAcceptedHandoff.mockResolvedValue({
      pos: [{ id: 14, poNumber: "PO-20260522-002", vendorId: 77, status: "draft" }],
      decisions: [{
        id: 5003,
        recommendationId: "301:3001:30",
        kind: "skipped",
        decision: "po_handoff_created",
        status: "active",
      }],
      handedOff: [{
        acceptedDecisionId: 95,
        handoffDecisionId: 5003,
        recommendationId: "301:3001:30",
        kind: "skipped",
        sku: "HEALTHY-TOPOFF",
        poId: 14,
        poLineId: 1401,
        poIds: [14],
        orderedPieces: 240,
      }],
    });
    server = await startServer(buildApp());

    // Fail-closed: a zero-baseline acceptance without a requested quantity has
    // nothing to order and must never reach the handoff service.
    const missingRequested = await requestJson(
      server.url,
      "POST",
      "/api/purchasing/recommendation-accepted-queue/create-po",
      { items: [{ recommendationId: "301:3001:30", kind: "skipped" }] },
    );
    expect(missingRequested).toMatchObject({
      status: 409,
      body: {
        skipped: [{
          recommendationId: "301:3001:30",
          kind: "skipped",
          reason: "zero_baseline_requested_pieces_required",
        }],
      },
    });
    expect(mocks.recommendationPoHandoffService.createAcceptedHandoff).not.toHaveBeenCalled();

    const { status, body } = await requestJson(
      server.url,
      "POST",
      "/api/purchasing/recommendation-accepted-queue/create-po",
      {
        items: [{
          recommendationId: "301:3001:30",
          kind: "skipped",
          requestedPieces: 240,
          quantityOverrideReason: "Top off to reach vendor free-freight threshold",
          allocationOverrideApproved: true,
        }],
      },
    );

    expect(status, JSON.stringify(body)).toBe(201);
    expect(mocks.recommendationPoHandoffService.createAcceptedHandoff).toHaveBeenCalledWith({
      actorId: "admin-user",
      items: [
        expect.objectContaining({
          acceptedDecisionId: 95,
          recommendationId: "301:3001:30",
          kind: "skipped",
          productId: 301,
          productVariantId: 3001,
          suggestedPieces: 0,
          requestedPieces: 240,
          quantityOverrideReason: "Top off to reach vendor free-freight threshold",
          allocationOverrideApproved: true,
          orderUomUnits: 1,
          vendorProductId: 7703,
          vendorId: 77,
          sku: "HEALTHY-TOPOFF",
        }),
      ],
    });
    expect(body).toMatchObject({
      success: true,
      count: 1,
      itemsDrafted: 1,
      handedOff: [
        {
          recommendationId: "301:3001:30",
          kind: "skipped",
          sku: "HEALTHY-TOPOFF",
          poId: 14,
          orderedPieces: 240,
        },
      ],
      skipped: [],
    });
  });

  // Handoff-time mirror of the decision-time analyzability gate: if the line
  // became EXCLUDED after acceptance, the zero-baseline top-off must fail
  // closed at PO creation even with a requested quantity and full override
  // evidence — the exclusion outranks the acceptance.
  it("fails closed at handoff when an accepted zero-baseline line became excluded", async () => {
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(30);
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      {
        product_id: 301,
        variant_id: 3001,
        base_sku: "HEALTHY-TOPOFF",
        product_name: "Healthy Topoff",
        total_pieces: 500,
        total_reserved_pieces: 0,
        total_outbound_pieces: 30,
        previous_outbound_pieces: 30,
        demand_order_count: 12,
        demand_active_days: 10,
        on_order_pieces: 0,
        open_po_count: 0,
        earliest_expected: null,
        lead_time_days: 2,
        vendor_lead_time_days: 2,
        safety_stock_days: 1,
        order_uom_units: 1,
        order_uom_level: 2,
        vendor_product_id: 7703,
        preferred_vendor_id: 77,
        preferred_vendor_name: "Vendor",
        estimated_cost_cents: 1000,
        vendor_pricing_basis: "per_piece",
        vendor_purchase_uom: null,
        vendor_quoted_unit_cost_mills: 100000,
        vendor_pieces_per_purchase_uom: null,
        vendor_moq: 200,
        vendor_quoted_at: "2026-05-18T12:00:00.000Z",
        vendor_product_updated_at: "2026-05-18T12:00:00.000Z",
      },
    ]);
    // The product was excluded AFTER the acceptance below was recorded.
    mocks.db.execute.mockImplementation(async (query: unknown) => {
      let text = "";
      try {
        text = JSON.stringify(query) ?? "";
      } catch {
        text = "";
      }
      if (text.includes("reorder_excluded")) {
        return {
          rows: [
            { id: 301, category: null, brand: null, product_type: null, sku: "HEALTHY-TOPOFF", tags: null, reorder_excluded: true },
          ],
        };
      }
      return { rows: [] };
    });
    mocks.procurement.getLatestRecommendationDecisions.mockResolvedValue([
      {
        id: 95,
        recommendationId: "301:3001:30",
        kind: "skipped",
        decision: "accepted_for_po",
        status: "active",
        sku: "HEALTHY-TOPOFF",
        productName: "Healthy Topoff",
        vendorId: 77,
        decidedAt: "2026-05-22T12:00:00.000Z",
        recommendationSnapshot: {
          lookbackDays: 30,
          item: {
            productId: 301,
            productVariantId: 3001,
            sku: "HEALTHY-TOPOFF",
            productName: "Healthy Topoff",
            preferredVendorId: 77,
            vendorProductId: 7703,
            suggestedOrderQty: 0,
            suggestedOrderPieces: 0,
            orderUomUnits: 1,
            orderUomLabel: "pieces",
            preferredVendorName: "Vendor",
            estimatedCostMills: 100000,
            estimatedCostCents: 1000,
            pricingBasis: "per_piece",
            purchaseUom: null,
            quotedUnitCostMills: 100000,
            piecesPerPurchaseUom: null,
            supplierBasis: {
              minimumOrderPieces: 200,
            },
            quoteReference: null,
            quotedAt: "2026-05-18T12:00:00.000Z",
            quoteValidUntil: null,
          },
        },
      },
    ]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(
      server.url,
      "POST",
      "/api/purchasing/recommendation-accepted-queue/create-po",
      {
        items: [{
          recommendationId: "301:3001:30",
          kind: "skipped",
          requestedPieces: 240,
          quantityOverrideReason: "Top off to reach vendor free-freight threshold",
          allocationOverrideApproved: true,
        }],
      },
    );

    expect(status, JSON.stringify(body)).toBe(409);
    expect(body.skipped).toEqual([
      expect.objectContaining({
        recommendationId: "301:3001:30",
        kind: "skipped",
        reason: "zero_baseline_not_analyzable",
        context: { reason: "excluded" },
      }),
    ]);
    expect(mocks.recommendationPoHandoffService.createAcceptedHandoff).not.toHaveBeenCalled();
  });

  it("rejects malformed Order Builder quantity overrides before any handoff work", async () => {
    server = await startServer(buildApp());
    const post = (item: Record<string, unknown>) => requestJson(
      server!.url,
      "POST",
      "/api/purchasing/recommendation-accepted-queue/create-po",
      { items: [{ recommendationId: "202:2002:30", kind: "held_by_policy", ...item }] },
    );

    expect(await post({ requestedPieces: 0 })).toMatchObject({
      status: 400,
      body: { error: "items[].requestedPieces must be a positive integer" },
    });
    expect(await post({ requestedPieces: 1.5 })).toMatchObject({
      status: 400,
      body: { error: "items[].requestedPieces must be a positive integer" },
    });
    expect(await post({ requestedPieces: "12" })).toMatchObject({
      status: 400,
      body: { error: "items[].requestedPieces must be a positive integer" },
    });
    expect(await post({ requestedPieces: 12, quantityOverrideReason: "ab" })).toMatchObject({
      status: 400,
      body: { error: "items[].quantityOverrideReason must be a string of at least 3 characters" },
    });
    expect(await post({ requestedPieces: 12, quantityOverrideReason: 42 })).toMatchObject({
      status: 400,
      body: { error: "items[].quantityOverrideReason must be a string of at least 3 characters" },
    });
    expect(await post({ requestedPieces: 12, quantityOverrideReason: "valid reason", allocationOverrideApproved: "yes" })).toMatchObject({
      status: 400,
      body: { error: "items[].allocationOverrideApproved must be a boolean" },
    });
    expect(mocks.recommendationPoHandoffService.createAcceptedHandoff).not.toHaveBeenCalled();
  });

  it("blocks stale accepted snapshots from draft PO handoff", async () => {
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(30);
    mocks.procurement.getAutoDraftSettings.mockResolvedValue({
      autoDraftMode: "draft_po",
      approvalPolicy: "high_confidence_and_strong_candidate",
      includeOrderSoon: false,
      skipOnOpenPo: true,
      skipNoVendor: true,
      candidateScoreStrongThreshold: 95,
      candidateScoreReviewThreshold: 80,
    });
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([]);
    mocks.procurement.getLatestRecommendationDecisions.mockResolvedValue([
      {
        id: 90,
        recommendationId: "999:product:30",
        kind: "quality_review_required",
        decision: "accepted_for_po",
        status: "active",
        sku: "STALE-ACCEPTED",
        productName: "Stale Accepted",
        decidedAt: "2026-05-21T12:00:00.000Z",
        recommendationSnapshot: {
          item: {
            sku: "STALE-ACCEPTED",
            productName: "Stale Accepted",
            suggestedOrderQty: 2,
            orderUomLabel: "Each",
            candidateScore: { score: 61, band: "review_candidate" },
          },
        },
      },
    ]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(
      server.url,
      "POST",
      "/api/purchasing/recommendation-accepted-queue/create-po",
      {
        items: [{ recommendationId: "999:product:30", kind: "quality_review_required" }],
      },
    );

    expect(status).toBe(409);
    expect(mocks.procurement.getLatestRecommendationDecisions).toHaveBeenCalledWith(
      ["999:product:30"],
      ["quality_review_required"],
    );
    expect(mocks.recommendationPoHandoffService.createAcceptedHandoff).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      error: "No current accepted recommendations are eligible for PO handoff",
      skipped: [
        {
          recommendationId: "999:product:30",
          kind: "quality_review_required",
          sku: "STALE-ACCEPTED",
          reason: "stale_accepted_snapshot",
        },
      ],
    });
  });

  it("starts the auto-draft job for an admin user without awaiting completion", async () => {
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "POST", "/api/purchasing/auto-draft/run");

    expect(status).toBe(202);
    expect(mocks.startAutoDraftJob).toHaveBeenCalledWith({
      triggeredBy: "manual",
      triggeredByUser: "admin-user",
    });
    expect(body).toEqual({
      message: "Auto-draft job started",
      runId: 1001,
      interruptedRunIds: [],
    });
  });

  it("rejects a second manual run while an auto-draft lease is active", async () => {
    mocks.startAutoDraftJob.mockRejectedValue(Object.assign(
      new Error("An auto-draft run is already active"),
      {
        statusCode: 409,
        code: "AUTO_DRAFT_RUN_ALREADY_RUNNING",
        context: { runId: 1001, leaseExpiresAt: "2026-07-12T02:30:00.000Z" },
      },
    ));
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "POST", "/api/purchasing/auto-draft/run");

    expect(status).toBe(409);
    expect(body).toEqual({
      error: "An auto-draft run is already active",
      code: "AUTO_DRAFT_RUN_ALREADY_RUNNING",
      context: { runId: 1001, leaseExpiresAt: "2026-07-12T02:30:00.000Z" },
    });
  });

  it("normalizes interrupted lease state on the auto-draft status endpoint", async () => {
    mocks.procurement.getLatestAutoDraftRun.mockResolvedValue({
      id: 1000,
      run_at: "2026-07-12T01:00:00.000Z",
      triggered_by: "scheduler",
      triggered_by_user: null,
      status: "interrupted",
      heartbeat_at: "2026-07-12T01:10:00.000Z",
      lease_expires_at: null,
      finished_at: "2026-07-12T01:40:00.000Z",
      items_analyzed: 25,
      error_message: "Auto-draft run lease expired before completion.",
    });
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/purchasing/auto-draft/status");

    expect(status).toBe(200);
    expect(body).toMatchObject({
      id: 1000,
      status: "interrupted",
      heartbeatAt: "2026-07-12T01:10:00.000Z",
      leaseExpiresAt: null,
      finishedAt: "2026-07-12T01:40:00.000Z",
      itemsAnalyzed: 25,
      errorMessage: "Auto-draft run lease expired before completion.",
    });
  });

  it("returns normalized recent auto-draft recommendation runs", async () => {
    mocks.procurement.getRecentAutoDraftRuns.mockResolvedValue([
      {
        id: 55,
        runAt: "2026-05-19T01:00:00.000Z",
        triggeredBy: "manual",
        triggeredByUser: "admin-user",
        status: "success",
        itemsAnalyzed: 10,
        posCreated: 0,
        posUpdated: 0,
        linesAdded: 0,
        skippedNoVendor: 2,
        skippedOnOrder: 1,
        skippedExcluded: 3,
        errorMessage: null,
        finishedAt: "2026-05-19T01:00:02.000Z",
        summaryJson: {
          settings: { autoDraftMode: "review_only", approvalPolicy: "high_confidence_and_strong_candidate" },
          recommendationSummary: { actionableCount: 4, autoDraftEligibleCount: 2, autoDraftReviewRequiredCount: 2 },
          approvalPolicyDiagnostics: {
            policy: "high_confidence_and_strong_candidate",
            mode: "review_only",
            candidateScoreGateActive: true,
            qualityGateEligibleCount: 2,
            approvalPolicyEligibleCount: 1,
            approvalPolicyBlockedCount: 1,
            draftMutationEligibleCount: 0,
            approvedCandidateBandCounts: { strong_candidate: 1 },
            blockedCandidateBandCounts: { review_candidate: 1 },
          },
          forecastDiagnostics: {
            recommendationCount: 4,
            forecastMethodCounts: { recent_order_velocity_v1: 4 },
            demandQualityCounts: { normal: 3, thin_history: 1 },
            demandTrendCounts: { stable: 2, rising: 1, not_available: 1 },
            qualityControlCounts: { thin_history: 1, default_lead_time: 2 },
            qualityControlAreaCounts: { demand: 1, lead_time: 2 },
            qualityControlSeverityCounts: { review: 3 },
            autopilotBlockerCounts: { thin_history: 1, default_lead_time: 2 },
            autopilotBlockerAreaCounts: { demand: 1, lead_time: 2 },
            autopilotBlockerSeverityCounts: { review: 3 },
            autopilotBlockerItemCount: 2,
            totalPeriodUsagePieces: 120,
            avgDailyUsagePieces: 1,
            latestDemandAt: "2026-05-18T12:00:00.000Z",
          },
          actionableRecommendations: [
            {
              sku: "ORDER-ME",
              productName: "Order Me",
              suggestedOrderQty: 2,
              orderUomLabel: "Case",
              preferredVendorName: "Vendor",
              explanation: "Below reorder point.",
            },
          ],
          skippedRecommendations: [
            {
              sku: "NO-VENDOR",
              productName: "No Vendor",
              skippedReason: "no_vendor",
              explanation: "No preferred vendor.",
            },
          ],
          approvalPolicyBlockedRecommendations: [
            {
              sku: "REVIEW-CANDIDATE",
              productName: "Review Candidate",
              suggestedOrderQty: 1,
              orderUomLabel: "Case",
              preferredVendorName: "Vendor",
              explanation: "High confidence but not a strong candidate.",
            },
          ],
          poMutations: [],
        },
      },
    ]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/purchasing/auto-draft/runs?limit=999");

    expect(status).toBe(200);
    expect(mocks.procurement.getRecentAutoDraftRuns).toHaveBeenCalledWith(50);
    expect(body).toMatchObject({
      limit: 50,
      runs: [
        {
          id: 55,
          runAt: "2026-05-19T01:00:00.000Z",
          triggeredBy: "manual",
          triggeredByUser: "admin-user",
          status: "success",
          itemsAnalyzed: 10,
          posCreated: 0,
          posUpdated: 0,
          linesAdded: 0,
          skippedNoVendor: 2,
          skippedOnOrder: 1,
          skippedExcluded: 3,
          mode: "review_only",
          approvalPolicy: "high_confidence_and_strong_candidate",
          actionableCount: 4,
          autoDraftEligibleCount: 2,
          autoDraftReviewRequiredCount: 2,
          approvalPolicyEligibleCount: 1,
          approvalPolicyBlockedCount: 1,
          draftMutationEligibleCount: 0,
          approvalPolicyDiagnostics: {
            policy: "high_confidence_and_strong_candidate",
            approvalPolicyEligibleCount: 1,
            approvalPolicyBlockedCount: 1,
          },
          forecastDiagnostics: {
            recommendationCount: 4,
            forecastMethodCounts: { recent_order_velocity_v1: 4 },
            demandQualityCounts: { normal: 3, thin_history: 1 },
            autopilotBlockerCounts: { thin_history: 1, default_lead_time: 2 },
            autopilotBlockerItemCount: 2,
          },
          poMutationCount: 0,
          recommendationSamples: {
            actionable: [
              {
                sku: "ORDER-ME",
                productName: "Order Me",
                suggestedOrderQty: 2,
              },
            ],
            skipped: [
              {
                sku: "NO-VENDOR",
                skippedReason: "no_vendor",
              },
            ],
            approvalPolicyBlocked: [
              {
                sku: "REVIEW-CANDIDATE",
                suggestedOrderQty: 1,
              },
            ],
          },
          recommendationSampleCounts: {
            actionable: 1,
            skipped: 1,
            approvalPolicyBlocked: 1,
          },
          topActionableRecommendation: {
            sku: "ORDER-ME",
            suggestedOrderQty: 2,
            preferredVendorName: "Vendor",
          },
          topSkippedRecommendation: {
            sku: "NO-VENDOR",
            skippedReason: "no_vendor",
          },
          topApprovalPolicyBlockedRecommendation: {
            sku: "REVIEW-CANDIDATE",
            suggestedOrderQty: 1,
            preferredVendorName: "Vendor",
          },
          recommendedActions: expect.arrayContaining([
            {
              action: "assign_vendors",
              label: "Assign vendors",
              detail: "2 recommendations skipped because no preferred vendor was available.",
              href: "/suppliers",
              severity: "critical",
              count: 2,
            },
            {
              action: "review_policy_holds",
              label: "Review policy holds",
              detail: "1 quality-approved recommendation held by the active approval policy.",
              href: "/reorder-analysis?candidateBand=review_candidate&reviewQueue=held_by_policy",
              severity: "warning",
              count: 1,
            },
            {
              action: "review_quality_queue",
              label: "Review quality queue",
              detail: "2 recommendations need demand, lead-time, supplier-cost, or vendor review before autopilot can use them.",
              href: "/reorder-analysis?reviewQueue=quality_review_required",
              severity: "warning",
              count: 2,
            },
            {
              action: "review_open_pos",
              label: "Review open POs",
              detail: "1 recommendation skipped because stock was already on order.",
              href: "/purchase-orders",
              severity: "info",
              count: 1,
            },
            {
              action: "review_exclusions",
              label: "Review exclusions",
              detail: "3 recommendations skipped by purchasing exclusion rules.",
              href: "/purchasing",
              severity: "info",
              count: 3,
            },
          ]),
        },
      ],
    });
  });

  it("returns stale auto-draft PO diagnostics from the shared action plan", async () => {
    mocks.procurement.getAutoDraftSettings.mockResolvedValueOnce({
      stalePoThresholds: {
        reviewPendingWarningDays: 4,
        reviewPendingCriticalDays: 9,
      },
    });
    mocks.db.execute.mockResolvedValueOnce({
      rows: [
        {
          id: 77,
          poNumber: "PO-STALE",
          vendorId: 9,
          vendorName: "Vendor",
          status: "draft",
          physicalStatus: "draft",
          financialStatus: "unbilled",
          lineCount: 2,
          totalCents: 12000,
          source: "auto_draft",
          autoDraftDate: "2020-01-01T00:00:00.000Z",
          orderDate: null,
          approvedAt: null,
          sentToVendorAt: null,
          expectedDeliveryDate: null,
          confirmedDeliveryDate: null,
          actualDeliveryDate: null,
          firstShippedAt: null,
          firstArrivedAt: null,
          firstInvoicedAt: null,
          firstPaidAt: null,
          fullyPaidAt: null,
          createdAt: "2020-01-01T00:00:00.000Z",
          updatedAt: "2020-01-01T00:00:00.000Z",
          openExceptionCount: 0,
        },
      ],
    });
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/purchasing/auto-draft/stale-pos?limit=5");

    expect(status).toBe(200);
    expect(mocks.db.execute).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({
      thresholds: {
        reviewPendingWarningDays: 4,
        reviewPendingCriticalDays: 9,
      },
      scannedAutoDraftPos: 1,
      totalStale: 1,
      counts: {
        critical: 1,
        reviewPending: 1,
      },
      items: [
        {
          poId: 77,
          poNumber: "PO-STALE",
          vendorName: "Vendor",
          stage: "review_pending",
          severity: "critical",
          action: {
            action: "open_lines",
            href: "/purchase-orders/77",
          },
        },
      ],
    });
  });

  it("delegates the direct endpoint to the canonical auto-draft job", async () => {
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(30);
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      {
        product_id: 42,
        variant_id: 420,
        base_sku: "AUTO-1",
        product_name: "Auto Product",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 30,
        previous_outbound_pieces: 28,
        demand_order_count: 10,
        demand_active_days: 8,
        on_order_pieces: 0,
        open_po_count: 0,
        lead_time_days: 3,
        vendor_lead_time_days: 3,
        safety_stock_days: 1,
        order_uom_units: 5,
        order_uom_level: 2,
        vendor_product_id: 7042,
        preferred_vendor_id: 7,
        estimated_cost_mills: 12500,
        vendor_pricing_basis: "per_piece",
        vendor_purchase_uom: null,
        vendor_quoted_unit_cost_mills: 12500,
        vendor_pieces_per_purchase_uom: null,
        vendor_quoted_at: new Date().toISOString(),
        vendor_product_updated_at: new Date().toISOString(),
      },
      {
        product_id: 43,
        variant_id: 430,
        base_sku: "NO-VENDOR",
        product_name: "No Vendor",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 30,
        on_order_pieces: 0,
        open_po_count: 0,
        lead_time_days: 3,
        safety_stock_days: 1,
        order_uom_units: 5,
        order_uom_level: 2,
      },
    ]);
    mocks.runAutoDraftJob.mockResolvedValue({
      success: true,
      pos: [{ id: 9, vendorId: 7 }],
      count: 1,
      itemsDrafted: 1,
      itemsSkippedAfterAnalysis: 0,
      reviewOnly: false,
      recommendationSummary: {
        actionableCount: 1,
        highConfidenceCount: 1,
        autoDraftEligibleCount: 1,
        autoDraftReviewRequiredCount: 0,
        skippedNoVendor: 1,
      },
      recommendationRun: {
        id: 1001,
        detail: {
          recommendationSummary: { actionableCount: 1, autoDraftEligibleCount: 1 },
        },
      },
    });
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "POST", "/api/purchasing/auto-draft-run");

    expect(status).toBe(200);
    expect(mocks.runAutoDraftJob).toHaveBeenCalledWith({
      triggeredBy: "manual",
      triggeredByUser: "admin-user",
    });
    expect(mocks.purchasingService.createPOFromReorder).not.toHaveBeenCalled();
    expect(mocks.procurement.createAutoDraftRun).not.toHaveBeenCalled();
    expect(mocks.procurement.updateAutoDraftRun).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      success: true,
      count: 1,
      itemsDrafted: 1,
      recommendationSummary: {
        actionableCount: 1,
        highConfidenceCount: 1,
        autoDraftEligibleCount: 1,
        autoDraftReviewRequiredCount: 0,
        skippedNoVendor: 1,
      },
      recommendationRun: {
        id: 1001,
        detail: {
          recommendationSummary: {
            actionableCount: 1,
            autoDraftEligibleCount: 1,
          },
        },
      },
    });
  });

  it("keeps medium-confidence direct auto-draft recommendations in review without PO mutations", async () => {
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(30);
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      {
        product_id: 42,
        variant_id: 420,
        base_sku: "REVIEW-1",
        product_name: "Review Product",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 30,
        on_order_pieces: 0,
        open_po_count: 0,
        lead_time_days: 3,
        safety_stock_days: 1,
        order_uom_units: 5,
        order_uom_level: 2,
        preferred_vendor_id: 7,
      },
    ]);
    mocks.runAutoDraftJob.mockResolvedValue({
      success: true,
      pos: [],
      count: 0,
      itemsDrafted: 0,
      itemsSkippedAfterAnalysis: 0,
      reviewOnly: false,
      recommendationSummary: {
        actionableCount: 1,
        mediumConfidenceCount: 1,
        autoDraftEligibleCount: 0,
        autoDraftReviewRequiredCount: 1,
      },
      recommendationRun: {
        id: 1001,
        detail: {
          recommendationSummary: {
            actionableCount: 1,
            autoDraftEligibleCount: 0,
            autoDraftReviewRequiredCount: 1,
          },
        },
      },
    });
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "POST", "/api/purchasing/auto-draft-run");

    expect(status).toBe(200);
    expect(mocks.purchasingService.createPOFromReorder).not.toHaveBeenCalled();
    expect(mocks.runAutoDraftJob).toHaveBeenCalledWith({
      triggeredBy: "manual",
      triggeredByUser: "admin-user",
    });
    expect(mocks.procurement.updateAutoDraftRun).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      success: true,
      pos: [],
      count: 0,
      itemsDrafted: 0,
      reviewOnly: false,
      recommendationSummary: {
        actionableCount: 1,
        mediumConfidenceCount: 1,
        autoDraftEligibleCount: 0,
        autoDraftReviewRequiredCount: 1,
      },
      recommendationRun: {
        id: 1001,
        detail: {
          recommendationSummary: {
            actionableCount: 1,
            autoDraftEligibleCount: 0,
            autoDraftReviewRequiredCount: 1,
          },
        },
      },
    });
  });

  it("records direct auto-draft recommendations without PO mutations in review-only mode", async () => {
    mocks.runAutoDraftJob.mockResolvedValue({
      success: true,
      pos: [],
      count: 0,
      itemsDrafted: 0,
      itemsSkippedAfterAnalysis: 0,
      reviewOnly: true,
      recommendationSummary: {
        actionableCount: 1,
        autoDraftEligibleCount: 0,
        autoDraftReviewRequiredCount: 1,
      },
      recommendationRun: {
        id: 1001,
        detail: {
          settings: { autoDraftMode: "review_only" },
          poMutations: [],
        },
      },
    });
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(30);
    mocks.procurement.getAutoDraftSettings.mockResolvedValue({
      autoDraftMode: "review_only",
      approvalPolicy: "high_confidence_only",
      includeOrderSoon: false,
      skipOnOpenPo: true,
      skipNoVendor: true,
      candidateScoreStrongThreshold: 80,
      candidateScoreReviewThreshold: 60,
    });
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      {
        product_id: 42,
        variant_id: 420,
        base_sku: "AUTO-1",
        product_name: "Auto Product",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 30,
        on_order_pieces: 0,
        open_po_count: 0,
        lead_time_days: 3,
        safety_stock_days: 1,
        order_uom_units: 5,
        order_uom_level: 2,
        preferred_vendor_id: 7,
      },
    ]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "POST", "/api/purchasing/auto-draft-run");

    expect(status).toBe(200);
    expect(mocks.purchasingService.createPOFromReorder).not.toHaveBeenCalled();
    expect(mocks.runAutoDraftJob).toHaveBeenCalledWith({
      triggeredBy: "manual",
      triggeredByUser: "admin-user",
    });
    expect(mocks.procurement.updateAutoDraftRun).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      success: true,
      pos: [],
      count: 0,
      itemsDrafted: 0,
      reviewOnly: true,
      recommendationSummary: {
        actionableCount: 1,
        autoDraftEligibleCount: 0,
        autoDraftReviewRequiredCount: 1,
      },
      recommendationRun: {
        id: 1001,
        detail: {
          settings: {
            autoDraftMode: "review_only",
          },
          poMutations: [],
        },
      },
    });
  });

  it("updates auto-draft mode settings", async () => {
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "PATCH", "/api/purchasing/auto-draft-settings", {
      autoDraftMode: "review_only",
      approvalPolicy: "high_confidence_and_strong_candidate",
      candidateScoreStrongThreshold: 85,
      candidateScoreReviewThreshold: 65,
    });

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(mocks.procurement.updateAutoDraftSettings).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        autoDraftMode: "review_only",
        approvalPolicy: "high_confidence_and_strong_candidate",
        candidateScoreStrongThreshold: 85,
        candidateScoreReviewThreshold: 65,
      }),
    );
  });

  it("validates and updates automatic RFQ draft policy", async () => {
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "PATCH", "/api/purchasing/auto-draft-settings", {
      rfqDraftAutomationMode: "preferred_vendor",
      rfqDraftMinimumConfidence: "medium",
      rfqDraftRequireTrustedForecast: false,
      rfqDraftMaximumLinesPerRun: 250,
    });

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(mocks.procurement.updateAutoDraftSettings).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        rfqDraftAutomationMode: "preferred_vendor",
        rfqDraftMinimumConfidence: "medium",
        rfqDraftRequireTrustedForecast: false,
        rfqDraftMaximumLinesPerRun: 250,
      }),
    );
  });

  it("rejects unsafe automatic RFQ draft policy values", async () => {
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "PATCH", "/api/purchasing/auto-draft-settings", {
      rfqDraftMaximumLinesPerRun: 501,
    });

    expect(status).toBe(400);
    expect(body).toEqual({ error: "rfqDraftMaximumLinesPerRun must be an integer between 1 and 500" });
    expect(mocks.procurement.updateAutoDraftSettings).not.toHaveBeenCalled();
  });

  it("updates stale auto-draft PO aging thresholds", async () => {
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "PATCH", "/api/purchasing/auto-draft-settings", {
      stalePoThresholds: {
        reviewPendingWarningDays: 3,
        reviewPendingCriticalDays: 6,
        supplierSendWarningDays: 3,
        supplierSendCriticalDays: 7,
        supplierFollowupWarningDays: 8,
        supplierFollowupCriticalDays: 15,
        receivingWarningDays: 4,
        receivingCriticalDays: 11,
        apCloseoutWarningDays: 8,
        apCloseoutCriticalDays: 22,
        exceptionBlockedWarningDays: 2,
        exceptionBlockedCriticalDays: 4,
        closeoutWarningDays: 8,
        closeoutCriticalDays: 16,
      },
    });

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(mocks.procurement.updateAutoDraftSettings).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        stalePoThresholds: expect.objectContaining({
          reviewPendingWarningDays: 3,
          reviewPendingCriticalDays: 6,
          exceptionBlockedWarningDays: 2,
          exceptionBlockedCriticalDays: 4,
        }),
      }),
    );
  });

  it("validates and updates the purchasing forecast policy", async () => {
    server = await startServer(buildApp());
    const forecastPolicy = {
      method: "weighted_blend_v1",
      shortWindowDays: 14,
      standardWindowDays: 45,
      longWindowDays: 180,
      seasonalEnabled: true,
      seasonalWindowDays: 45,
      weights: { short: 35, standard: 30, long: 20, seasonal: 15 },
      forwardDemandEnabled: true,
      forwardDemandHorizonDays: 120,
      forwardDemandConfidenceWeights: { high: 100, medium: 75, low: 35 },
      automationMinimumOrderCount: 5,
      automationMinimumActiveDays: 4,
    };

    const { status, body } = await requestJson(server.url, "PATCH", "/api/purchasing/auto-draft-settings", {
      forecastPolicy,
    });

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(mocks.procurement.updateAutoDraftSettings).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ forecastPolicy }),
    );
  });

  it("rejects forecast weights that do not total 100", async () => {
    server = await startServer(buildApp());
    const { status, body } = await requestJson(server.url, "PATCH", "/api/purchasing/auto-draft-settings", {
      forecastPolicy: { weights: { short: 40, standard: 40, long: 20, seasonal: 10 } },
    });

    expect(status).toBe(400);
    expect(body).toEqual({ error: "Forecast weights must total 100" });
    expect(mocks.procurement.updateAutoDraftSettings).not.toHaveBeenCalled();
  });

  it("rejects invalid candidate score threshold settings", async () => {
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "PATCH", "/api/purchasing/auto-draft-settings", {
      candidateScoreStrongThreshold: 55,
      candidateScoreReviewThreshold: 70,
    });

    expect(status).toBe(400);
    expect(body).toEqual({ error: "candidateScoreReviewThreshold must be less than or equal to candidateScoreStrongThreshold" });
    expect(mocks.procurement.updateAutoDraftSettings).not.toHaveBeenCalled();
  });

  it("rejects stale PO aging thresholds where warning exceeds critical", async () => {
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "PATCH", "/api/purchasing/auto-draft-settings", {
      stalePoThresholds: {
        receivingWarningDays: 12,
        receivingCriticalDays: 4,
      },
    });

    expect(status).toBe(400);
    expect(body).toEqual({
      error: "stalePoThresholds.receivingWarningDays must be less than or equal to receivingCriticalDays",
    });
    expect(mocks.procurement.updateAutoDraftSettings).not.toHaveBeenCalled();
  });

  it("rejects invalid auto-draft modes", async () => {
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "PATCH", "/api/purchasing/auto-draft-settings", {
      autoDraftMode: "mutate_everything",
    });

    expect(status).toBe(400);
    expect(body).toEqual({ error: "autoDraftMode must be one of: draft_po, review_only" });
    expect(mocks.procurement.updateAutoDraftSettings).not.toHaveBeenCalled();
  });

  it("rejects unsupported auto-draft approval policies", async () => {
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "PATCH", "/api/purchasing/auto-draft-settings", {
      approvalPolicy: "medium_confidence",
    });

    expect(status).toBe(400);
    expect(body).toEqual({
      error: "approvalPolicy must be one of: high_confidence_only, high_confidence_and_strong_candidate",
    });
    expect(mocks.procurement.updateAutoDraftSettings).not.toHaveBeenCalled();
  });
});
