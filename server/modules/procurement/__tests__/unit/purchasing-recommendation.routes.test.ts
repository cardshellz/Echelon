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

describe("purchasing recommendation routes", () => {
  let server: { url: string; close: () => Promise<void> } | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.db.execute.mockResolvedValue({ rows: [] });
    mocks.db.select.mockReturnValue({ from: vi.fn().mockResolvedValue([]) });
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
        href: "/suppliers",
      },
    });
    expect(body.items[0].gaps[0]).toMatchObject({
      code: "missing_vendor",
      severity: "block",
    });
    expect(body.items[1]).toMatchObject({
      sku: "MISSING-COST",
      preferredVendorName: "Vendor A",
      action: {
        action: "update_supplier_cost",
        label: "Update cost",
      },
    });
    expect(body.items[1].gaps[0]).toMatchObject({
      code: "missing_supplier_cost",
      severity: "review",
    });
    expect(body.items.map((item: any) => item.sku)).toContain("STALE-COST");
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
        href: "/reorder-analysis?reviewQueue=quality_review_required&reason=forecast_trust_review&forecastAction=verify_recent_demand",
      },
    });
    expect(body.samples[1]).toMatchObject({
      sku: "MISSING-LATEST",
      forecastTrustSignal: "missing_latest_demand_timestamp",
      forecastTrustSeverity: "watch",
      inputGaps: ["missing_latest_demand_at"],
      action: {
        code: "repair_order_velocity_source",
        href: "/reorder-analysis?reviewQueue=quality_review_required&forecastAction=repair_order_velocity_source",
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
        assign_vendor: 1,
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
        href: "/reorder-analysis?reviewQueue=quality_review_required&reason=forecast_trust_review&forecastAction=verify_recent_demand",
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
        href: "/reorder-analysis?reviewQueue=quality_review_required&forecastAction=repair_order_velocity_source",
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
      }),
    }));
    expect(body.decision).toMatchObject({
      id: 5001,
      recommendationId: "202:2002:30",
      decision: "accepted_for_po",
      sku: "QUEUE-HELD",
    });
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
