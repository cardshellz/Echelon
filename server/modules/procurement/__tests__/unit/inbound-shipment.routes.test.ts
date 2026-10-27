import { requestLocalHttp } from "../../../../__tests__/helpers/local-http";
import { shipmentWorkListQuerySchema } from "@shared/procurement/shipment-work-list";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import http from "http";
import { AddressInfo } from "net";
import type { ServiceRegistry } from "../../../../services";

const mocks = vi.hoisted(() => ({
  idempotencyMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
  requireIdempotency: vi.fn(),
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

mocks.requireIdempotency.mockReturnValue(mocks.idempotencyMiddleware);

vi.mock("../../../../routes/middleware", () => {
  const pass = (req: Request, _res: Response, next: NextFunction) => {
    (req as any).session = { user: { id: "test-user" } };
    next();
  };
  return {
    requirePermission: () => pass,
    requireAuth: pass,
  };
});

vi.mock("../../../../middleware/idempotency", () => ({
  requireIdempotency: mocks.requireIdempotency,
}));

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

    constructor(message: string, statusCode = 400, public details?: Record<string, unknown>) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

vi.mock("../../../notifications/notifications.service", () => mocks.notifications);

import { ApLedgerError } from "../../ap-ledger.service";
import { registerInboundShipmentRoutes } from "../../inbound-shipment.routes";

function buildShipmentTrackingMock(overrides: Record<string, any> = {}) {
  return {
    getShipmentPage: vi.fn(),
    getShipments: vi.fn(),
    getShipmentsCount: vi.fn(),
    getShipment: vi.fn(),
    getReceivingSetup: vi.fn(),
    getShipmentPurchaseOrders: vi.fn().mockResolvedValue([]),
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
    versionCosts: vi.fn(async (costs: unknown[]) => costs),
    getCost: vi.fn(),
    runAllocation: vi.fn(),
    getAllocationStatus: vi.fn(),
    getLandedCostHealth: vi.fn(),
    finalizeAllocations: vi.fn(),
    getShipmentsByPo: vi.fn(),
    pushLandedCostsToLots: vi.fn(),
    ...overrides,
  } as any;
}

function buildApp(shipmentTracking: any): Express {
  const app = express();
  app.use(express.json());
  // This route harness supplies only its shipment dependency; AP is mocked above.
  app.locals.services = { shipmentTracking } as ServiceRegistry;
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
  const res = await requestLocalHttp(`${baseUrl}${path}`, {
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
    mocks.apLedger.enrichCostsWithInvoiceInfo.mockResolvedValue([]);
  });

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  it("reads receiving readiness through its application owner", async () => {
    const setup = { shipmentId: 42, ready: false, issueCount: 0, lines: [] };
    const service = buildShipmentTrackingMock({ getReceivingSetup: vi.fn().mockResolvedValue(setup) });
    server = await startServer(buildApp(service));
    expect(await requestJson(server.url, "GET", "/api/inbound-shipments/42/receiving-setup")).toEqual({ status: 200, body: setup });
    expect(service.getReceivingSetup).toHaveBeenCalledExactlyOnceWith(42);
  });
  it.each(["0", "-1", "42x", "1.5", "2147483648", "0042"])("rejects invalid receiving setup identity %s", async id => {
    const service = buildShipmentTrackingMock(); server = await startServer(buildApp(service));
    expect((await requestJson(server.url, "GET", `/api/inbound-shipments/${id}/receiving-setup`)).status).toBe(400);
    expect(service.getReceivingSetup).not.toHaveBeenCalled();
  });
  it("redacts receiving setup failures and keeps booking unavailable", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = buildShipmentTrackingMock({ getReceivingSetup: vi.fn().mockRejectedValue(new Error("private SQL connection details")) });
    server = await startServer(buildApp(service));
    const result = await requestJson(server.url, "GET", "/api/inbound-shipments/42/receiving-setup");
    expect(result).toMatchObject({ status: 503, body: { code: "SHIPMENT_RECEIVING_SETUP_UNAVAILABLE" } });
    expect(JSON.stringify(result)).not.toContain("private SQL"); expect(logged).toHaveBeenCalled(); logged.mockRestore();
  });

  it("does not wrap durable shipment invoice creation in legacy idempotency", () => {
    buildApp(buildShipmentTrackingMock());

    expect(mocks.requireIdempotency).not.toHaveBeenCalled();
  });

  it("routes every list filter to one snapshot-owned page projection", async () => {
    const page = { shipments: [{ id: 11, shipmentNumber: "S-11" }], total: 6, limit: 25, offset: 5, hasMore: false, costHealthItems: [] };
    const shipmentTracking = buildShipmentTrackingMock({ getShipmentPage: vi.fn().mockResolvedValue(page) });
    server = await startServer(buildApp(shipmentTracking));
    const { status, body } = await requestJson(server.url, "GET",
      "/api/inbound-shipments?status=booked,in_transit&mode=ocean&warehouseId=1&limit=25&offset=5&search=carrier&costFilter=critical");
    expect(status).toBe(200);
    expect(shipmentTracking.getShipmentPage).toHaveBeenCalledWith({ status: "booked,in_transit", mode: "ocean",
      warehouseId: "1", limit: "25", offset: "5", search: "carrier", costFilter: "critical" });
    expect(shipmentTracking.getShipments).not.toHaveBeenCalled();
    expect(shipmentTracking.getShipmentsCount).not.toHaveBeenCalled();
    expect(body).toEqual(page);
  });

  it("classifies malformed page input as400 without exposing diagnostics", async () => {
    const shipmentTracking = buildShipmentTrackingMock({getShipmentPage:vi.fn(async query=>shipmentWorkListQuerySchema.parse(query))});
    server=await startServer(buildApp(shipmentTracking));
    expect(await requestJson(server.url,"GET","/api/inbound-shipments?offset=-1")).toEqual({status:400,
      body:{code:"SHIPMENT_LIST_QUERY_INVALID",error:"Invalid shipment filters or page."}});
  });

  it("classifies unavailable page evidence as500 rather than returning an empty list", async () => {
    const shipmentTracking = buildShipmentTrackingMock({getShipmentPage:vi.fn().mockRejectedValue(new Error("private database details"))});
    server=await startServer(buildApp(shipmentTracking));
    expect(await requestJson(server.url,"GET","/api/inbound-shipments")).toEqual({status:500,
      body:{code:"SHIPMENT_LIST_UNAVAILABLE",error:"Shipments could not be verified. Retry the work list."}});
  });

  it("returns actual PO references alongside shipment detail without changing line associations", async () => {
    const lines = [{ id: 1, purchaseOrderId: 17 }, { id: 2, purchaseOrderId: 99 }];
    const purchaseOrders = [{ id: 17, poNumber: "TEST-PO-17" }, { id: 99, poNumber: "TEST-PO-99" }];
    const shipmentTracking = buildShipmentTrackingMock({
      getShipment: vi.fn().mockResolvedValue({ id: 42, shipmentNumber: "S-42" }),
      getEnrichedLines: vi.fn().mockResolvedValue(lines),
      getShipmentPurchaseOrders: vi.fn().mockResolvedValue(purchaseOrders),
      getCosts: vi.fn().mockResolvedValue([]),
      getStatusHistory: vi.fn().mockResolvedValue([]),
    });
    mocks.apLedger.getShipmentCostPaymentStatus.mockResolvedValue(null);
    server = await startServer(buildApp(shipmentTracking));
    const response = await requestJson(server.url, "GET", "/api/inbound-shipments/42");
    expect(response).toEqual({ status: 200, body: {
      id: 42, shipmentNumber: "S-42", lines, purchaseOrders, costs: [], statusHistory: [], paymentStatus: null,
    } });
    expect(shipmentTracking.getShipmentPurchaseOrders).toHaveBeenCalledExactlyOnceWith(42);
  });

  it("does not conceal a failed purchase-reference read as an unlinked shipment", async () => {
    const shipmentTracking = buildShipmentTrackingMock({
      getShipment: vi.fn().mockResolvedValue({ id: 42, shipmentNumber: "S-42" }),
      getShipmentPurchaseOrders: vi.fn().mockRejectedValue(new Error("Purchase references unavailable")),
    });
    server = await startServer(buildApp(shipmentTracking));
    expect(await requestJson(server.url, "GET", "/api/inbound-shipments/42")).toEqual({
      status: 500, body: { error: "Purchase references unavailable" },
    });
  });

  it("composes invoice status and command versions on the main shipment read", async () => {
    const costs = [{ id: 9, vendorName: "Carrier", vendorInvoiceId: 71, derivedStatus: "voided", linkedInvoice: { id: 71, invoiceNumber: "F-71", status: "voided" } }];
    const versioned = costs.map((cost) => ({ ...cost, version: "a".repeat(64), hasInvoiceSourceReference: true }));
    mocks.apLedger.enrichCostsWithInvoiceInfo.mockResolvedValue(costs);
    const shipmentTracking = buildShipmentTrackingMock({
      getShipment: vi.fn().mockResolvedValue({ id: 42 }),
      getEnrichedLines: vi.fn().mockResolvedValue([]),
      versionCosts: vi.fn().mockResolvedValue(versioned),
      getStatusHistory: vi.fn().mockResolvedValue([]),
    });
    mocks.apLedger.getShipmentCostPaymentStatus.mockResolvedValue(null);
    server = await startServer(buildApp(shipmentTracking));
    const response = await requestJson(server.url, "GET", "/api/inbound-shipments/42");
    expect(response).toMatchObject({ status: 200, body: { costs: versioned } });
    expect(mocks.apLedger.enrichCostsWithInvoiceInfo).toHaveBeenCalledExactlyOnceWith(42);
    expect(shipmentTracking.versionCosts).toHaveBeenCalledExactlyOnceWith(costs);
    expect(shipmentTracking.getCosts).not.toHaveBeenCalled();
  });

  it("keeps original charge ownership visible when its payment totals need review", async () => {
    const costs = [{ id: 9, vendorInvoiceId: 71, billingOwnership: { state: "review_required", referencedInvoiceIds: [71,72] } }];
    mocks.apLedger.enrichCostsWithInvoiceInfo.mockResolvedValue(costs);
    mocks.apLedger.getShipmentCostPaymentStatus.mockRejectedValue(new ApLedgerError("Review ownership",409,{code:"AP_SHIPMENT_BILLING_REVIEW_REQUIRED"}));
    const shipmentTracking = buildShipmentTrackingMock({ getShipment: vi.fn().mockResolvedValue({id:42}), getEnrichedLines:vi.fn().mockResolvedValue([]), getStatusHistory:vi.fn().mockResolvedValue([]) });
    server = await startServer(buildApp(shipmentTracking));
    const response = await requestJson(server.url,"GET","/api/inbound-shipments/42");
    expect(response.status).toBe(200); expect(response.body).toMatchObject({ paymentStatus:null, costs });
  });

  it("does not report unbilled costs when invoice enrichment fails", async () => {
    mocks.apLedger.enrichCostsWithInvoiceInfo.mockRejectedValue(new Error("Invoice evidence unavailable"));
    const shipmentTracking = buildShipmentTrackingMock({ getShipment: vi.fn().mockResolvedValue({ id: 42 }) });
    server = await startServer(buildApp(shipmentTracking));
    expect(await requestJson(server.url, "GET", "/api/inbound-shipments/42")).toMatchObject({
      status: 500, body: { error: "Invoice evidence unavailable" },
    });
  });

  it("returns landed cost health summary", async () => {
    const health = {
      status: "critical",
      scannedShipments: 1,
      critical: 1,
      warning: 0,
      counts: {
        allocationBlockers: 0,
        allocationWarnings: 0,
        pendingFinalization: 0,
        finalizedNotPushed: 0,
        staleProvisionalLots: 1,
      },
      items: [{ id: "stale_provisional_lots-1", shipmentId: 1 }],
    };
    const shipmentTracking = buildShipmentTrackingMock({
      getLandedCostHealth: vi.fn().mockResolvedValue(health),
    });
    server = await startServer(buildApp(shipmentTracking));

    const { status, body } = await requestJson(server.url, "GET", "/api/procurement/landed-cost-health?limit=50");

    expect(status).toBe(200);
    expect(shipmentTracking.getLandedCostHealth).toHaveBeenCalledWith({ limit: 50 });
    expect(body).toEqual(health);
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

  it("returns allocation status for an inbound shipment", async () => {
    const allocationStatus = {
      shipmentId: 12,
      status: "needs_allocation",
      lineCount: 1,
      costCount: 1,
      allocatableCostCount: 1,
      effectiveCostCents: 1200,
      allocatedCostCents: 0,
      unallocatedCents: 1200,
      issueCount: 1,
      blockerCount: 1,
      warningCount: 0,
      costs: [{ costId: 31, status: "needs_allocation" }],
      issues: [{ severity: "blocker", code: "cost_not_allocated", costId: 31 }],
    };
    const shipmentTracking = buildShipmentTrackingMock({
      getAllocationStatus: vi.fn().mockResolvedValue(allocationStatus),
    });
    server = await startServer(buildApp(shipmentTracking));

    const { status, body } = await requestJson(
      server.url,
      "GET",
      "/api/inbound-shipments/12/allocation-status",
    );

    expect(status).toBe(200);
    expect(shipmentTracking.getAllocationStatus).toHaveBeenCalledWith(12);
    expect(body).toEqual(allocationStatus);
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
    expect(shipmentTracking.pushLandedCostsToLots).toHaveBeenCalledWith(12,"test-user");
    expect(body).toEqual(pushResult);
  });
});
