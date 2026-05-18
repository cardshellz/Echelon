import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import http from "http";
import { AddressInfo } from "net";

const mocks = vi.hoisted(() => ({
  apLedger: {
    getShipmentCostPaymentStatus: vi.fn(),
    enrichCostsWithInvoiceInfo: vi.fn(),
    createInvoiceFromShipmentCosts: vi.fn(),
    getCostVendorsForShipment: vi.fn(),
    listCostsForInvoiceCreation: vi.fn(),
    getShipmentInvoicesSummary: vi.fn(),
    linkCostToInvoice: vi.fn(),
    unlinkCostFromInvoice: vi.fn(),
  },
  notifications: {
    notify: vi.fn(),
  },
}));

vi.mock("../../../../routes/middleware", () => {
  const pass = (req: Request, _res: Response, next: NextFunction) => {
    (req as any).session = { user: { id: "test-user" } };
    next();
  };
  return {
    requirePermission: () => pass,
  };
});

vi.mock("../../shipment-tracking.service", () => ({
  ShipmentTrackingError: class ShipmentTrackingError extends Error {
    statusCode: number;

    constructor(message: string, statusCode = 400) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

vi.mock("../../ap-ledger.service", () => ({
  ...mocks.apLedger,
  ApLedgerError: class ApLedgerError extends Error {
    statusCode: number;

    constructor(message: string, statusCode = 400) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

vi.mock("../../../notifications/notifications.service", () => mocks.notifications);

import { registerInboundShipmentRoutes } from "../../inbound-shipment.routes";

function buildShipmentTrackingMock(overrides: Record<string, any> = {}) {
  return {
    getShipments: vi.fn(),
    getShipmentsCount: vi.fn(),
    getShipment: vi.fn(),
    getEnrichedLines: vi.fn(),
    getCosts: vi.fn(),
    getStatusHistory: vi.fn(),
    createShipment: vi.fn(),
    updateShipment: vi.fn(),
    deleteShipment: vi.fn(),
    book: vi.fn(),
    markInTransit: vi.fn(),
    markAtPort: vi.fn(),
    markCustomsClearance: vi.fn(),
    markDelivered: vi.fn(),
    startCosting: vi.fn(),
    close: vi.fn(),
    cancel: vi.fn(),
    addLinesFromPO: vi.fn(),
    importPackingList: vi.fn(),
    resolveDimensionsForShipment: vi.fn(),
    updateLineDimensions: vi.fn(),
    removeLine: vi.fn(),
    addCost: vi.fn(),
    getCost: vi.fn(),
    updateCost: vi.fn(),
    removeCost: vi.fn(),
    runAllocation: vi.fn(),
    finalizeAllocations: vi.fn(),
    getShipmentsByPo: vi.fn(),
    pushLandedCostsToLots: vi.fn(),
    ...overrides,
  } as any;
}

function buildApp(shipmentTracking: any): Express {
  const app = express();
  app.use(express.json());
  app.locals.services = { shipmentTracking };
  registerInboundShipmentRoutes(app);
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

describe("inbound shipment routes", () => {
  let server: { url: string; close: () => Promise<void> } | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.notifications.notify.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  it("lists inbound shipments with parsed filters", async () => {
    const shipmentTracking = buildShipmentTrackingMock({
      getShipments: vi.fn().mockResolvedValue([{ id: 11, shipmentNumber: "S-11" }]),
      getShipmentsCount: vi.fn().mockResolvedValue(1),
    });
    server = await startServer(buildApp(shipmentTracking));

    const { status, body } = await requestJson(
      server.url,
      "GET",
      "/api/inbound-shipments?status=booked,in_transit&mode=ocean&warehouseId=1&limit=25&offset=5",
    );

    expect(status).toBe(200);
    expect(shipmentTracking.getShipments).toHaveBeenCalledWith({
      status: ["booked", "in_transit"],
      mode: "ocean",
      warehouseId: 1,
      limit: 25,
      offset: 5,
    });
    expect(shipmentTracking.getShipmentsCount).toHaveBeenCalledWith({
      status: ["booked", "in_transit"],
      mode: "ocean",
      warehouseId: 1,
      limit: 25,
      offset: 5,
    });
    expect(body).toEqual({ shipments: [{ id: 11, shipmentNumber: "S-11" }], total: 1 });
  });

  it("marks shipments delivered and sends the arrival notification", async () => {
    const shipmentTracking = buildShipmentTrackingMock({
      markDelivered: vi.fn().mockResolvedValue({
        id: 44,
        shipmentNumber: "INB-44",
        shipperName: "Fast Freight",
      }),
    });
    server = await startServer(buildApp(shipmentTracking));

    const { status, body } = await requestJson(
      server.url,
      "POST",
      "/api/inbound-shipments/44/delivered",
      { notes: "dock 2", deliveredDate: "2026-05-16T12:00:00.000Z" },
    );

    expect(status).toBe(200);
    expect(body).toEqual({ id: 44, shipmentNumber: "INB-44", shipperName: "Fast Freight" });
    expect(shipmentTracking.markDelivered).toHaveBeenCalledWith(
      44,
      "test-user",
      "dock 2",
      new Date("2026-05-16T12:00:00.000Z"),
    );
    expect(mocks.notifications.notify).toHaveBeenCalledWith("shipment_arrived", {
      title: "Shipment Delivered: INB-44",
      message: "From Fast Freight",
      data: { shipmentId: 44 },
    });
  });

  it("adds shipment lines from selected purchase order lines", async () => {
    const shipmentTracking = buildShipmentTrackingMock({
      addLinesFromPO: vi.fn().mockResolvedValue([{ id: 8, poLineId: 100, qty: 3 }]),
    });
    server = await startServer(buildApp(shipmentTracking));

    const { status, body } = await requestJson(
      server.url,
      "POST",
      "/api/inbound-shipments/12/lines/from-po",
      {
        purchaseOrderId: 55,
        lineSelections: [{ poLineId: 100, qty: 3 }],
      },
    );

    expect(status).toBe(201);
    expect(body).toEqual([{ id: 8, poLineId: 100, qty: 3 }]);
    expect(shipmentTracking.addLinesFromPO).toHaveBeenCalledWith(
      12,
      55,
      [{ poLineId: 100, qty: 3 }],
      undefined,
    );
  });

  it("delegates inbound shipment cost reads through AP enrichment", async () => {
    mocks.apLedger.enrichCostsWithInvoiceInfo.mockResolvedValue([
      { id: 22, amountCents: 1200, invoiceNumber: "INV-22" },
    ]);
    const shipmentTracking = buildShipmentTrackingMock();
    server = await startServer(buildApp(shipmentTracking));

    const { status, body } = await requestJson(server.url, "GET", "/api/inbound-shipments/12/costs");

    expect(status).toBe(200);
    expect(mocks.apLedger.enrichCostsWithInvoiceInfo).toHaveBeenCalledWith(12);
    expect(body).toEqual([{ id: 22, amountCents: 1200, invoiceNumber: "INV-22" }]);
  });

  it("returns landed cost push-to-lots results with skipped reasons", async () => {
    const pushResult = {
      updated: 1,
      total: 2,
      skipped: [
        {
          lotId: 501,
          productVariantId: 10,
          reason: "landed_cost_not_finalized",
          lineIds: [11],
        },
      ],
    };
    const shipmentTracking = buildShipmentTrackingMock({
      pushLandedCostsToLots: vi.fn().mockResolvedValue(pushResult),
    });
    server = await startServer(buildApp(shipmentTracking));

    const { status, body } = await requestJson(
      server.url,
      "POST",
      "/api/inbound-shipments/12/push-costs-to-lots",
    );

    expect(status).toBe(200);
    expect(shipmentTracking.pushLandedCostsToLots).toHaveBeenCalledWith(12);
    expect(body).toEqual(pushResult);
  });
});
