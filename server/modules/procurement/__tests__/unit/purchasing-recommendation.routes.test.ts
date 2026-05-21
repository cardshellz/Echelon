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
  purchasingService: {
    createPOFromReorder: vi.fn(),
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
}));

import {
  registerPurchasingRecommendationAdminRoutes,
  registerPurchasingRecommendationRoutes,
} from "../../purchasing-recommendation.routes";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.locals.services = { purchasing: mocks.purchasingService };
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
    mocks.runAutoDraftJob.mockResolvedValue(undefined);
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
    mocks.purchasingService.createPOFromReorder.mockResolvedValue([]);
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
        total_pieces: 200,
        total_reserved_pieces: 0,
        total_outbound_pieces: 1,
        on_order_pieces: 0,
        lead_time_days: 2,
        safety_stock_days: 1,
        unit_cost_cents: 100,
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
      idleCapitalCents: 20000,
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
          suggestedOrderQty: 1,
          suggestedOrderPieces: 10,
          orderUomLabel: "Box",
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
        preferred_vendor_id: 77,
        preferred_vendor_name: "Vendor",
        estimated_cost_cents: 1000,
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
          suggestedOrderQty: 1,
          orderUomLabel: "Box",
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
        preferred_vendor_id: 77,
        preferred_vendor_name: "Vendor",
        estimated_cost_cents: 1000,
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
        preferred_vendor_id: 88,
        preferred_vendor_name: "Vendor B",
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
  });

  it("starts the auto-draft job for an admin user without awaiting completion", async () => {
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "POST", "/api/purchasing/auto-draft/run");

    expect(status).toBe(202);
    expect(mocks.runAutoDraftJob).toHaveBeenCalledWith({
      triggeredBy: "manual",
      triggeredByUser: "admin-user",
    });
    expect(body).toEqual({ message: "Auto-draft job started" });
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

  it("uses the shared recommendation engine for direct auto-draft items", async () => {
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
        preferred_vendor_id: 7,
        estimated_cost_mills: 12500,
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
    mocks.purchasingService.createPOFromReorder.mockResolvedValue([{ id: 9 }]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "POST", "/api/purchasing/auto-draft-run");

    expect(status).toBe(200);
    expect(mocks.purchasingService.createPOFromReorder).toHaveBeenCalledWith(
      [
        {
          productId: 42,
          productVariantId: 420,
          suggestedQty: 1,
          vendorId: 7,
        },
      ],
      "admin-user",
    );
    expect(mocks.procurement.createAutoDraftRun).toHaveBeenCalledWith({
      triggeredBy: "manual",
      triggeredByUser: "admin-user",
      status: "running",
    });
    expect(mocks.procurement.updateAutoDraftRun).toHaveBeenCalledWith(
      1001,
      expect.objectContaining({
        status: "success",
        itemsAnalyzed: 2,
        linesAdded: 1,
        skippedNoVendor: 1,
        summaryJson: expect.objectContaining({
          recommendationSummary: expect.objectContaining({
            actionableCount: 1,
            highConfidenceCount: 1,
            autoDraftEligibleCount: 1,
            autoDraftReviewRequiredCount: 0,
            skippedNoVendor: 1,
          }),
          settings: expect.objectContaining({
            autoDraftMode: "draft_po",
          }),
          actionableRecommendations: [
            expect.objectContaining({
              sku: "AUTO-1",
              suggestedOrderQty: 1,
              explanation: expect.any(String),
              qualityGate: expect.objectContaining({
                autoDraftEligible: true,
                reason: "high_confidence",
              }),
            }),
          ],
          skippedRecommendations: [
            expect.objectContaining({
              sku: "NO-VENDOR",
              skippedReason: "no_vendor",
            }),
          ],
        }),
      }),
    );
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
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "POST", "/api/purchasing/auto-draft-run");

    expect(status).toBe(200);
    expect(mocks.purchasingService.createPOFromReorder).not.toHaveBeenCalled();
    expect(mocks.procurement.updateAutoDraftRun).toHaveBeenCalledWith(
      1001,
      expect.objectContaining({
        status: "success",
        itemsAnalyzed: 1,
        linesAdded: 0,
        summaryJson: expect.objectContaining({
          recommendationSummary: expect.objectContaining({
            actionableCount: 1,
            mediumConfidenceCount: 1,
            autoDraftEligibleCount: 0,
            autoDraftReviewRequiredCount: 1,
          }),
          settings: expect.objectContaining({
            autoDraftMode: "draft_po",
          }),
          actionableRecommendations: [
            expect.objectContaining({
              sku: "REVIEW-1",
              suggestedOrderQty: 1,
              qualityGate: expect.objectContaining({
                autoDraftEligible: false,
                reason: "medium_confidence_review",
              }),
            }),
          ],
          poMutations: [],
        }),
      }),
    );
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
    expect(mocks.procurement.updateAutoDraftRun).toHaveBeenCalledWith(
      1001,
      expect.objectContaining({
        status: "success",
        itemsAnalyzed: 1,
        posCreated: 0,
        posUpdated: 0,
        linesAdded: 0,
        skippedNoVendor: 0,
        summaryJson: expect.objectContaining({
          recommendationSummary: expect.objectContaining({
            actionableCount: 1,
            autoDraftEligibleCount: 0,
            autoDraftReviewRequiredCount: 1,
          }),
          settings: expect.objectContaining({
            autoDraftMode: "review_only",
          }),
          actionableRecommendations: [
            expect.objectContaining({
              sku: "AUTO-1",
              suggestedOrderQty: 1,
              qualityGate: expect.objectContaining({
                autoDraftEligible: false,
                reason: "medium_confidence_review",
              }),
            }),
          ],
          poMutations: [],
        }),
      }),
    );
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
