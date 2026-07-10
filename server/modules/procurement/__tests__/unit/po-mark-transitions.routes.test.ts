import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import http from "http";
import { AddressInfo } from "net";

// ─────────────────────────────────────────────────────────────────────────────
// Route-level tests for Phase 3 physical-status transition endpoints:
//   POST /api/purchase-orders/:id/mark-shipped
//   POST /api/purchase-orders/:id/mark-in-transit
//   POST /api/purchase-orders/:id/mark-arrived
//
// We mount the real procurement routes into a fresh Express app but mock the
// middleware (auth/permission/idempotency) and the purchasing service so we
// can test HTTP wiring independently of the DB.
// ─────────────────────────────────────────────────────────────────────────────

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

// Stub every downstream module so imports don't fail.
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
import { PurchasingError } from "../../purchasing.service";

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPurchasingMock(overrides: Record<string, any> = {}): any {
  return {
    // Minimal surface needed to register routes without crashing
    createPO: vi.fn(),
    getPurchaseOrders: vi.fn(),
    getPurchaseOrdersCount: vi.fn(),
    getPurchaseOrderById: vi.fn(),
    getPurchaseOrderLines: vi.fn(),
    createPurchaseOrderWithLines: vi.fn(),
    sendPurchaseOrder: vi.fn(),
    duplicatePurchaseOrder: vi.fn(),
    getNewPoPreload: vi.fn(),
    getProcurementSettings: vi.fn(),
    updateProcurementSetting: vi.fn(),
    updateDeliverySchedule: vi.fn(),
    acknowledge: vi.fn(),
    cancel: vi.fn(),
    voidPO: vi.fn(),
    closeShort: vi.fn(),
    createReceiptFromPO: vi.fn(),
    getPoReceipts: vi.fn(),
    getPoStatusHistory: vi.fn(),
    getPaymentsForPo: vi.fn(),
    getInvoicesForPo: vi.fn(),
    onReceivingOrderClosed: vi.fn(),
    recomputeFinancialAggregates: vi.fn(),
    findOpenPoLineByProduct: vi.fn(),
    createPOFromReorder: vi.fn(),
    getOnOrderQty: vi.fn(),
    // The three under test
    executeLifecycleCommand: vi.fn(),
    transitionPhysical: vi.fn(),
    transitionFinancial: vi.fn(),
    ...overrides,
  };
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
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function post(baseUrl: string, path: string, body: any = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function patch(baseUrl: string, path: string, body: any = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/purchase-orders/:id/mark-shipped", () => {
  let server: { url: string; close: () => Promise<void> };
  let purchasing: ReturnType<typeof buildPurchasingMock>;

  beforeEach(async () => {
    purchasing = buildPurchasingMock();
    server = await startServer(buildApp(purchasing));
  });

  afterEach(async () => { await server.close(); });

  it("(1) returns 200 and the updated PO when transitioning from acknowledged", async () => {
    const updatedPo = { id: 10, physicalStatus: "shipped" };
    purchasing.executeLifecycleCommand.mockResolvedValue(updatedPo);

    const { status, body } = await post(server.url, "/api/purchase-orders/10/mark-shipped");

    expect(status).toBe(200);
    expect(body.physicalStatus).toBe("shipped");
    expect(purchasing.executeLifecycleCommand).toHaveBeenCalledWith(10, "mark_shipped", {}, "test-user");
  });

  it("(2) returns 4xx when transitioning from draft (invalid transition)", async () => {
    purchasing.executeLifecycleCommand.mockRejectedValue(
      new PurchasingError("Cannot transition physical status from 'draft' to 'shipped'", 400),
    );

    const { status, body } = await post(server.url, "/api/purchase-orders/10/mark-shipped");

    expect(status).toBe(400);
    expect(body.error).toMatch(/cannot transition/i);
  });
});

describe("POST /api/purchase-orders/:id/mark-in-transit", () => {
  let server: { url: string; close: () => Promise<void> };
  let purchasing: ReturnType<typeof buildPurchasingMock>;

  beforeEach(async () => {
    purchasing = buildPurchasingMock();
    server = await startServer(buildApp(purchasing));
  });

  afterEach(async () => { await server.close(); });

  it("(3) returns 200 and the updated PO when transitioning from shipped", async () => {
    const updatedPo = { id: 11, physicalStatus: "in_transit" };
    purchasing.executeLifecycleCommand.mockResolvedValue(updatedPo);

    const { status, body } = await post(server.url, "/api/purchase-orders/11/mark-in-transit");

    expect(status).toBe(200);
    expect(body.physicalStatus).toBe("in_transit");
    expect(purchasing.executeLifecycleCommand).toHaveBeenCalledWith(11, "mark_in_transit", {}, "test-user");
  });
});

describe("POST /api/purchase-orders/:id/mark-arrived", () => {
  let server: { url: string; close: () => Promise<void> };
  let purchasing: ReturnType<typeof buildPurchasingMock>;

  beforeEach(async () => {
    purchasing = buildPurchasingMock();
    server = await startServer(buildApp(purchasing));
  });

  afterEach(async () => { await server.close(); });

  it("(4) returns 200 when transitioning from in_transit", async () => {
    const updatedPo = { id: 12, physicalStatus: "arrived" };
    purchasing.executeLifecycleCommand.mockResolvedValue(updatedPo);

    const { status, body } = await post(server.url, "/api/purchase-orders/12/mark-arrived");

    expect(status).toBe(200);
    expect(body.physicalStatus).toBe("arrived");
    expect(purchasing.executeLifecycleCommand).toHaveBeenCalledWith(12, "mark_arrived", {}, "test-user");
  });

  it("(5) returns 200 when transitioning from shipped (skip in_transit allowed)", async () => {
    // VALID_PHYSICAL_TRANSITIONS: shipped → ["in_transit", "arrived", "cancelled"]
    // shipped → arrived is valid (skipping in_transit).
    const updatedPo = { id: 13, physicalStatus: "arrived" };
    purchasing.executeLifecycleCommand.mockResolvedValue(updatedPo);

    const { status, body } = await post(server.url, "/api/purchase-orders/13/mark-arrived");

    expect(status).toBe(200);
    expect(body.physicalStatus).toBe("arrived");
    // Service validates the transition; route just forwards the command.
    expect(purchasing.executeLifecycleCommand).toHaveBeenCalledWith(13, "mark_arrived", {}, "test-user");
  });

  it("forwards optional notes from request body to the lifecycle command", async () => {
    purchasing.executeLifecycleCommand.mockResolvedValue({ id: 14, physicalStatus: "arrived" });

    await post(server.url, "/api/purchase-orders/14/mark-arrived", { notes: "Arrived at warehouse" });

    expect(purchasing.executeLifecycleCommand).toHaveBeenCalledWith(
      14,
      "mark_arrived",
      { notes: "Arrived at warehouse" },
      "test-user",
    );
  });
});

describe("PATCH /api/purchase-orders/:id/delivery-schedule", () => {
  let server: { url: string; close: () => Promise<void> };
  let purchasing: ReturnType<typeof buildPurchasingMock>;

  beforeEach(async () => {
    purchasing = buildPurchasingMock();
    server = await startServer(buildApp(purchasing));
  });

  afterEach(async () => { await server.close(); });

  it("parses nullable schedule dates and forwards the audited update", async () => {
    purchasing.updateDeliverySchedule.mockResolvedValue({ id: 15, status: "acknowledged" });

    const { status } = await patch(server.url, "/api/purchase-orders/15/delivery-schedule", {
      expectedDeliveryDate: "2026-08-20",
      confirmedDeliveryDate: null,
      notes: "Correct vendor schedule",
    });

    expect(status).toBe(200);
    expect(purchasing.updateDeliverySchedule).toHaveBeenCalledWith(
      15,
      {
        expectedDeliveryDate: new Date("2026-08-20"),
        confirmedDeliveryDate: null,
        notes: "Correct vendor schedule",
      },
      "test-user",
    );
  });

  it("rejects malformed dates before calling the service", async () => {
    const { status, body } = await patch(server.url, "/api/purchase-orders/15/delivery-schedule", {
      confirmedDeliveryDate: "not-a-date",
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/valid date/i);
    expect(purchasing.updateDeliverySchedule).not.toHaveBeenCalled();
  });
});
