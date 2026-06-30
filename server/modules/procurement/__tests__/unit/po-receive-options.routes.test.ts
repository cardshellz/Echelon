import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import http from "http";
import { AddressInfo } from "net";

vi.mock("../../../../routes/middleware", () => {
  const pass = (req: Request, _res: Response, next: NextFunction) => {
    (req as any).session = { user: { id: "test-user" } };
    next();
  };
  return {
    requirePermission: () => pass,
    requireAuth: pass,
    requireInternalApiKey: pass,
    upload: { single: () => pass },
  };
});

vi.mock("../../../../middleware/idempotency", () => ({
  requireIdempotency: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../../../modules/catalog", () => ({ catalogStorage: {} }));
vi.mock("../../../../modules/warehouse", () => ({ warehouseStorage: {} }));
vi.mock("../../../../modules/inventory", () => ({ inventoryStorage: {} }));
vi.mock("../../../../modules/orders", () => ({ ordersStorage: {} }));
vi.mock("../../procurement", () => ({ procurementStorage: { getVendorById: vi.fn() } }));
vi.mock("../../ap-ledger.service", () => ({}));
vi.mock("../../po-document", () => ({ renderPoHtml: vi.fn() }));
vi.mock("../../../notifications/email.service", () => ({}));
vi.mock("../../../notifications/notifications.service", () => ({}));

import { registerPurchasingRoutes } from "../../procurement.routes";

function buildPurchasingMock(overrides: Record<string, any> = {}) {
  return {
    getPurchaseOrderReceiveOptions: vi.fn(),
    createReceiptFromShipment: vi.fn(),
    ...overrides,
  } as any;
}

function buildApp(purchasing: any): Express {
  const app = express();
  app.use(express.json());
  app.locals.services = {
    purchasing,
    shipmentTracking: {},
    receiving: {},
    poExceptions: {},
  };
  registerPurchasingRoutes(app);
  return app;
}

function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
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

describe("PO receive option routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let purchasing: ReturnType<typeof buildPurchasingMock>;

  beforeEach(async () => {
    purchasing = buildPurchasingMock();
    server = await startServer(buildApp(purchasing));
  });

  afterEach(async () => {
    await server.close();
  });

  it("returns backend-owned receive options for a PO", async () => {
    const options = {
      purchaseOrderId: 140,
      shipmentOptions: [
        { shipmentId: 84, purchaseOrderId: 140, receivable: true, action: "create_receipt" },
      ],
      poDirect: { allowed: true, warning: "No inbound shipment exists for this PO." },
    };
    purchasing.getPurchaseOrderReceiveOptions.mockResolvedValue(options);

    const { status, body } = await requestJson(server.url, "GET", "/api/purchase-orders/140/receive-options");

    expect(status).toBe(200);
    expect(body).toEqual(options);
    expect(purchasing.getPurchaseOrderReceiveOptions).toHaveBeenCalledWith(140);
  });

  it("forwards purchaseOrderId when creating a receipt from a shipment", async () => {
    const receipt = { id: 999, receiptNumber: "RCV-TEST-001", purchaseOrderId: 140, inboundShipmentId: 84 };
    purchasing.createReceiptFromShipment.mockResolvedValue(receipt);

    const { status, body } = await requestJson(
      server.url,
      "POST",
      "/api/inbound-shipments/84/create-receipt",
      { purchaseOrderId: 140 },
    );

    expect(status).toBe(201);
    expect(body).toEqual(receipt);
    expect(purchasing.createReceiptFromShipment).toHaveBeenCalledWith(84, "test-user", { purchaseOrderId: 140 });
  });

  it("rejects invalid purchaseOrderId before creating a shipment receipt", async () => {
    const { status, body } = await requestJson(
      server.url,
      "POST",
      "/api/inbound-shipments/84/create-receipt",
      { purchaseOrderId: "not-a-number" },
    );

    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid purchase order id/i);
    expect(purchasing.createReceiptFromShipment).not.toHaveBeenCalled();
  });
});
