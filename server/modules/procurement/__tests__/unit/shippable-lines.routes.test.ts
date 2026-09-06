import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import http from "http";
import { AddressInfo } from "net";

// Quantity evidence is covered by the source-capacity domain tests. HTTP
// forwards the shared projection, including separate unknown/review rows.
const capacityRead = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../shipment-source-capacity", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../shipment-source-capacity")>(),
  getShippablePurchaseOrderLines: capacityRead.get,
}));

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
  beforeEach(() => { capacityRead.get.mockReset(); });
  afterEach(async () => { await server?.close(); });

  async function mount(projection: { lines: any[]; reviewRequiredLines?: any[] } = { lines: [] }) {
    purchasing = buildPurchasingMock();
    shipmentTracking = { getShippedQtyByPoLines: vi.fn(), getLinesByPo: vi.fn() };
    capacityRead.get.mockResolvedValue({ reviewRequiredLines: [], ...projection });
    server = await startServer(buildApp(purchasing, shipmentTracking));
  }

  it("forwards shared capacity instead of recomputing an incomplete tally", async () => {
    const line = productLine({ alreadyShippedQty: 100, directReceivedQty: 50, remainingQty: 150 });
    await mount({ lines: [line] });
    const { status, body } = await get(server.url, "/api/purchase-orders/112/shippable-lines");
    expect(status).toBe(200);
    expect(body).toEqual({ lines: [line], reviewRequiredLines: [] });
    expect(capacityRead.get).toHaveBeenCalledWith({}, 112);
    expect(shipmentTracking.getShippedQtyByPoLines).not.toHaveBeenCalled();
    expect(purchasing.getPurchaseOrderLines).not.toHaveBeenCalled();
  });

  it("returns unknown remaining quantities separately from selectable lines", async () => {
    const review = productLine({ remainingQty: null, code: "SHIPMENT_LINE_SOURCE_REVIEW_REQUIRED", error: "Finish or cancel the direct receipt." });
    await mount({ lines: [], reviewRequiredLines: [review] });
    const { status, body } = await get(server.url, "/api/purchase-orders/112/shippable-lines");
    expect(status).toBe(200);
    expect(body.lines).toEqual([]);
    expect(body.reviewRequiredLines).toEqual([review]);
  });

  it.each(["0", "-1", "12garbage", "1.5", "2147483648"])("rejects invalid ID %s before reading", async (id) => {
    await mount();
    const { status } = await get(server.url, `/api/purchase-orders/${id}/shippable-lines`);
    expect(status).toBe(400);
    expect(capacityRead.get).not.toHaveBeenCalled();
  });

  it("does not turn failed reads into empty success or expose raw errors", async () => {
    await mount();
    capacityRead.get.mockRejectedValue(new Error("raw database detail"));
    const { status, body } = await get(server.url, "/api/purchase-orders/112/shippable-lines");
    expect(status).toBe(500);
    expect(body.code).toBe("SHIPMENT_LINE_SOURCE_READ_FAILED");
    expect(JSON.stringify(body)).not.toContain("raw database detail");
  });
});
