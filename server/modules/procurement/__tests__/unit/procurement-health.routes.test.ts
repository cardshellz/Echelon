import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import http from "http";
import { AddressInfo } from "net";

const mocks = vi.hoisted(() => ({
  procurement: {
    getAutoDraftSettings: vi.fn(),
    getReorderAnalysisData: vi.fn(),
  },
  inventory: {
    getVelocityLookbackDays: vi.fn(),
  },
  db: {},
  fetchAutoDraftPoAgingRows: vi.fn(),
  fetchInFlightPoAgingRows: vi.fn(),
  loadPurchasingRecommendationContext: vi.fn(),
  sendProcurementHealthCriticalEscalation: vi.fn(),
  shipmentTracking: {
    getLandedCostHealth: vi.fn(),
  },
}));

vi.mock("../../../../routes/middleware", () => {
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  return {
    requirePermission: () => pass,
  };
});

vi.mock("../..", () => ({ procurementStorage: mocks.procurement }));
vi.mock("../../../../modules/inventory", () => ({ inventoryStorage: mocks.inventory }));
vi.mock("../../../../db", () => ({ db: mocks.db }));
vi.mock("../../auto-draft-po-aging.repository", () => ({
  fetchAutoDraftPoAgingRows: mocks.fetchAutoDraftPoAgingRows,
}));
vi.mock("../../in-flight-po-aging.repository", () => ({
  fetchInFlightPoAgingRows: mocks.fetchInFlightPoAgingRows,
}));
vi.mock("../../purchasing-recommendation-context.service", () => ({
  loadPurchasingRecommendationContext: mocks.loadPurchasingRecommendationContext,
}));
vi.mock("../../procurement-health-escalation.service", () => ({
  sendProcurementHealthCriticalEscalation: mocks.sendProcurementHealthCriticalEscalation,
}));

import { registerProcurementHealthRoutes } from "../../procurement-health.routes";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.locals.services = { shipmentTracking: mocks.shipmentTracking };
  registerProcurementHealthRoutes(app);
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

async function requestJson(baseUrl: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("procurement health routes", () => {
  let server: { url: string; close: () => Promise<void> } | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchAutoDraftPoAgingRows.mockResolvedValue([]);
    mocks.fetchInFlightPoAgingRows.mockResolvedValue([]);
    mocks.inventory.getVelocityLookbackDays.mockResolvedValue(30);
    mocks.procurement.getAutoDraftSettings.mockResolvedValue({
      autoDraftMode: "draft_po",
      approvalPolicy: "high_confidence_and_strong_candidate",
      skipNoVendor: true,
      stalePoThresholds: undefined,
    });
    mocks.loadPurchasingRecommendationContext.mockResolvedValue({
      defaults: { leadTimeDays: 5, safetyStockDays: 2 },
      rules: [],
      productMetaById: new Map(),
    });
    mocks.shipmentTracking.getLandedCostHealth.mockResolvedValue({
      status: "healthy",
      critical: 0,
      warning: 0,
    });
    mocks.sendProcurementHealthCriticalEscalation.mockResolvedValue({
      sent: true,
      suppressed: false,
      reason: "sent",
      criticalCount: 1,
      signature: "supplier_setup_gaps:1:0:1",
      notificationTypeKey: "procurement_health_critical",
    });
  });

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  it("includes supplier setup gaps in the health summary", async () => {
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      {
        product_id: 101,
        variant_id: 1001,
        base_sku: "NO-VENDOR",
        product_name: "No Vendor Product",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 60,
        previous_outbound_pieces: 60,
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
    ]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/procurement/health?limit=10");

    expect(status).toBe(200);
    expect(mocks.shipmentTracking.getLandedCostHealth).toHaveBeenCalledWith({ limit: 10 });
    expect(mocks.inventory.getVelocityLookbackDays).toHaveBeenCalled();
    expect(mocks.procurement.getReorderAnalysisData).toHaveBeenCalledWith(30);
    expect(body).toMatchObject({
      status: "critical",
      critical: 1,
      warning: 0,
      total: 1,
    });
    expect(body.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "supplier_setup_gaps",
        status: "critical",
        critical: 1,
        warning: 0,
        total: 1,
        href: "/suppliers",
      }),
    ]));
  });

  it("includes in-flight PO aging in the health summary", async () => {
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([]);
    mocks.fetchInFlightPoAgingRows.mockResolvedValue([
      {
        id: 301,
        poNumber: "PO-301",
        vendorId: 10,
        vendorName: "Vendor",
        status: "acknowledged",
        physicalStatus: "arrived",
        financialStatus: "unbilled",
        lineCount: 2,
        totalCents: 5000,
        source: "manual",
        orderDate: "2026-05-01T00:00:00.000Z",
        sentToVendorAt: "2026-05-01T00:00:00.000Z",
        expectedDeliveryDate: "2026-05-01T00:00:00.000Z",
        confirmedDeliveryDate: null,
        actualDeliveryDate: null,
        firstShippedAt: null,
        firstArrivedAt: "2026-05-01T00:00:00.000Z",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
        openExceptionCount: 0,
      },
    ]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/procurement/health?limit=10");

    expect(status).toBe(200);
    expect(mocks.fetchInFlightPoAgingRows).toHaveBeenCalled();
    expect(body.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "in_flight_po_aging",
        status: "critical",
        critical: 1,
        warning: 0,
        total: 1,
        href: "/purchase-orders",
      }),
    ]));
  });

  it("includes forecast trust health in the health summary", async () => {
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      {
        product_id: 201,
        variant_id: 2001,
        base_sku: "STALE-DEMAND",
        product_name: "Stale Demand Product",
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
        vendor_product_id: 7001,
        preferred_vendor_id: 7,
        vendor_lead_time_days: 3,
        safety_stock_days: 1,
        order_uom_units: 10,
        estimated_cost_cents: 125,
        vendor_product_updated_at: "2026-05-20T00:00:00.000Z",
      },
    ]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/procurement/health?limit=10");

    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "warning",
      critical: 0,
      warning: 1,
      total: 1,
    });
    expect(body.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "forecast_trust_health",
        status: "warning",
        critical: 0,
        warning: 1,
        total: 1,
        href: "/reorder-analysis",
      }),
    ]));
  });

  it("can send a deduped critical health escalation from the shared health summary", async () => {
    mocks.procurement.getReorderAnalysisData.mockResolvedValue([
      {
        product_id: 101,
        variant_id: 1001,
        base_sku: "NO-VENDOR",
        product_name: "No Vendor Product",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 60,
        previous_outbound_pieces: 60,
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
    ]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "POST", "/api/procurement/health/escalation?limit=10", {
      force: true,
      dedupeHours: 12,
    });

    expect(status).toBe(200);
    expect(mocks.sendProcurementHealthCriticalEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "critical",
        critical: 1,
      }),
      { dedupeHours: 12, force: true },
    );
    expect(body).toMatchObject({
      health: {
        status: "critical",
        critical: 1,
      },
      escalation: {
        sent: true,
        notificationTypeKey: "procurement_health_critical",
      },
    });
  });
});
