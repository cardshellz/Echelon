import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import http from "http";
import { AddressInfo } from "net";

// ─────────────────────────────────────────────────────────────────────────────
// Route-level regression test for GET /api/purchase-orders/:id/shippable-lines.
//
// The bug this guards against: the endpoint used to tally already-shipped qty
// from ALL inbound_shipment_lines with no shipment-status filter, so a CANCELLED
// shipment's lines still counted — zeroing out `remaining` and hiding every line
// from the Create Shipment modal (button greyed as "all lines shipped") even
// though nothing was really shipped.
//
// The fix routes the tally through the shared, status-aware
// shipmentTracking.getShippedQtyByPoLines (cancelled excluded), the SAME source
// the add-lines write path uses. Here we mock that helper and assert the
// endpoint's remaining-qty math and filtering are correct, and that it no longer
// uses the old unfiltered getLinesByPo path.
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPurchasingMock(overrides: Record<string, any> = {}): any {
  return {
    // Minimal surface needed to register routes without crashing.
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
    transitionPhysical: vi.fn(),
    transitionFinancial: vi.fn(),
    ...overrides,
  };
}

function buildApp(purchasing: any, shipmentTracking: any): Express {
  const app = express();
  app.use(express.json());
  app.locals.services = {
    purchasing,
    shipmentTracking,
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

async function get(baseUrl: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function productLine(overrides: Record<string, any> = {}) {
  return { id: 1, lineType: "product", status: "open", orderQty: 300, cancelledQty: 0, ...overrides };
}

describe("GET /api/purchase-orders/:id/shippable-lines", () => {
  let server: { url: string; close: () => Promise<void> };
  let purchasing: ReturnType<typeof buildPurchasingMock>;
  let shipmentTracking: { getShippedQtyByPoLines: any; getLinesByPo: any };

  afterEach(async () => { await server.close(); });

  async function mount(lines: any[], shippedMap: Map<number, number>) {
    purchasing = buildPurchasingMock();
    purchasing.getPurchaseOrderLines.mockResolvedValue(lines);
    shipmentTracking = {
      getShippedQtyByPoLines: vi.fn().mockResolvedValue(shippedMap),
      // Old, unfiltered path — must NOT be used anymore.
      getLinesByPo: vi.fn().mockResolvedValue([]),
    };
    server = await startServer(buildApp(purchasing, shipmentTracking));
  }

  it("REGRESSION: a line whose only shipment was cancelled (tally returns 0) is offered as shippable", async () => {
    // The shared tally excludes the cancelled shipment, so shipped = 0.
    await mount([productLine({ id: 1, orderQty: 300 })], new Map());

    const { status, body } = await get(server.url, "/api/purchase-orders/112/shippable-lines");

    expect(status).toBe(200);
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]).toMatchObject({ id: 1, alreadyShippedQty: 0, remainingQty: 300 });
    // Delegated to the shared status-aware tally, not the old unfiltered path.
    expect(shipmentTracking.getShippedQtyByPoLines).toHaveBeenCalledWith([1]);
    expect(shipmentTracking.getLinesByPo).not.toHaveBeenCalled();
  });

  it("filters out a line that is genuinely fully shipped on a live shipment", async () => {
    await mount([productLine({ id: 1, orderQty: 300 })], new Map([[1, 300]]));

    const { status, body } = await get(server.url, "/api/purchase-orders/1/shippable-lines");

    expect(status).toBe(200);
    expect(body.lines).toHaveLength(0);
  });

  it("computes remaining qty from the shared tally (partial shipment)", async () => {
    await mount([productLine({ id: 1, orderQty: 300 })], new Map([[1, 100]]));

    const { body } = await get(server.url, "/api/purchase-orders/1/shippable-lines");

    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]).toMatchObject({ alreadyShippedQty: 100, remainingQty: 200 });
  });

  it("still excludes non-product and closed/cancelled PO lines", async () => {
    await mount(
      [
        productLine({ id: 1, orderQty: 300 }),
        productLine({ id: 2, lineType: "discount", orderQty: 1 }),
        productLine({ id: 3, status: "cancelled", orderQty: 50 }),
      ],
      new Map(),
    );

    const { body } = await get(server.url, "/api/purchase-orders/1/shippable-lines");

    expect(body.lines.map((l: any) => l.id)).toEqual([1]);
  });
});
