import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import http from "http";
import { AddressInfo } from "net";

const mocks = vi.hoisted(() => ({
  storage: {
    getOrderProfitabilityReport: vi.fn(),
    getProductProfitabilityReport: vi.fn(),
    getVendorSpendReport: vi.fn(),
    getCostVarianceReport: vi.fn(),
    getOpenPoSummaryReport: vi.fn(),
    getPoAgingReport: vi.fn(),
    getExpectedReceiptsReport: vi.fn(),
  },
}));

vi.mock("../../../../routes/middleware", () => {
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  return {
    requirePermission: () => pass,
  };
});

vi.mock("../..", () => ({ procurementStorage: mocks.storage }));

import { registerProcurementReportRoutes } from "../../procurement-report.routes";

function buildApp(services: Record<string, any> = {}): Express {
  const app = express();
  app.use(express.json());
  app.locals.services = services;
  registerProcurementReportRoutes(app);
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

async function requestJson(baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("procurement report routes", () => {
  let server: { url: string; close: () => Promise<void> } | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  it("lists order profitability with capped pagination", async () => {
    mocks.storage.getOrderProfitabilityReport.mockResolvedValue([{ orderId: 8 }]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "/api/reports/order-profitability?limit=999&offset=25");

    expect(status).toBe(200);
    expect(mocks.storage.getOrderProfitabilityReport).toHaveBeenCalledWith(200, 25);
    expect(body).toEqual({ orders: [{ orderId: 8 }] });
  });

  it("computes inventory valuation through the lot service", async () => {
    const inventoryLots = { getInventoryValuation: vi.fn().mockResolvedValue({ totalValueCents: 12345 }) };
    server = await startServer(buildApp({ inventoryLots }));

    const { status, body } = await requestJson(server.url, "/api/reports/inventory-valuation");

    expect(status).toBe(200);
    expect(inventoryLots.getInventoryValuation).toHaveBeenCalled();
    expect(body).toEqual({ totalValueCents: 12345 });
  });

  it("returns open PO summary with aggregate totals", async () => {
    mocks.storage.getOpenPoSummaryReport.mockResolvedValue([
      { status: "sent", po_count: "2", total_value_cents: "5000" },
      { status: "approved", po_count: 1, total_value_cents: null },
    ]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "/api/reports/open-po-summary");

    expect(status).toBe(200);
    expect(body).toEqual({
      byStatus: [
        { status: "sent", po_count: "2", total_value_cents: "5000" },
        { status: "approved", po_count: 1, total_value_cents: null },
      ],
      total: { poCount: 3, valueCents: 5000 },
    });
  });
});
