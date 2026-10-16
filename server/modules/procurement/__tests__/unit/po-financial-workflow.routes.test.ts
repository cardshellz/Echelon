import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServiceRegistry } from "../../../../services";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { buildPoFinancialWorkflow } from "../../domain/po-financial-workflow";

const mocks = vi.hoisted(() => ({
  readWorkflow: vi.fn(),
  getPo: vi.fn(),
  vendor: vi.fn(),
  permission: true,
  count: vi.fn(),
  list: vi.fn(),
  log: vi.fn(),
}));
vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../../catalog", () => ({ catalogStorage: {} }));
vi.mock("../../../warehouse", () => ({ warehouseStorage: {} }));
vi.mock("../../../inventory", () => ({ inventoryStorage: {} }));
vi.mock("../../../orders", () => ({ ordersStorage: {} }));
vi.mock("../..", () => ({
  procurementStorage: { getVendorById: mocks.vendor },
}));
vi.mock("../../ap-ledger.service", () => ({}));
vi.mock("../../po-exceptions.service", () => ({
  countOpenExceptions: mocks.count,
  listExceptions: mocks.list,
  PoExceptionError: class extends Error {},
}));
vi.mock("../../../../platform/observability/logger", () => ({
  logger: { error: mocks.log },
}));
vi.mock("../../po-email-outbox.service", () => ({
  enqueuePurchaseOrderEmail: vi.fn(),
  listPurchaseOrderEmailDeliveries: vi.fn(),
  replayDeadLetterPurchaseOrderEmail: vi.fn(),
  PoEmailOutboxError: class extends Error {},
}));
vi.mock("../../../../routes/middleware", () => {
  const permission =
    () => (req: Request, res: Response, next: NextFunction) => {
      if (!mocks.permission)
        return res.status(403).json({ error: "Forbidden" });
      req.session = {
        user: { id: "financial-workflow-reader" },
      } as typeof req.session;
      next();
    };
  return { requirePermission: permission, requireAnyPermission: permission };
});
vi.mock("../../../../middleware/idempotency", () => ({
  requireIdempotency:
    () => (_req: Request, _res: Response, next: NextFunction) =>
      next(),
}));
import { registerPurchaseOrderRoutes } from "../../purchase-order.routes";

function workflow(status: "received" | "approved" | "disputed" | "paid") {
  const settled = status === "paid";
  return buildPoFinancialWorkflow({
    purchaseOrderId: 10,
    vendorId: 5,
    currency: "USD",
    invoices: [
      {
        id: 1,
        vendorId: 5,
        currency: "USD",
        status,
        invoicedAmountCents: 1000,
        paidAmountCents: settled ? 1000 : 0,
        balanceCents: settled ? 0 : 1000,
        links: [
          {
            purchaseOrderId: 10,
            purchaseOrderVendorId: 5,
            purchaseOrderCurrency: "USD",
          },
        ],
        lines: [
          {
            id: 1,
            purchaseOrderLineId: 21,
            purchaseOrderId: 10,
            freightCostId: null,
            lineTotalCents: 1000,
          },
        ],
        payments: settled
          ? [
              {
                allocationId: 1,
                paymentId: 1,
                paymentVendorId: 5,
                paymentCurrency: "USD",
                paymentStatus: "completed",
                appliedAmountCents: 1000,
              },
            ]
          : [],
      },
    ],
  });
}

describe("PO detail financial workflow HTTP boundary", () => {
  let server: Server, base: string;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    const purchasing = new Proxy(
      {
        getPurchaseOrderById: mocks.getPo,
        getPurchaseOrderLines: async () => [{ id: 21 }],
        getPoStatusHistory: async () => [],
      },
      {
        get(target, key) {
          if (key in target) return target[key as keyof typeof target];
          throw new Error(`Unexpected purchasing method ${String(key)}`);
        },
      },
    );
    app.locals.services = {
      purchasing,
      shipmentTracking: {},
    } as unknown as ServiceRegistry;
    registerPurchaseOrderRoutes(app, { readWorkflow: mocks.readWorkflow });
    server = createServer(app);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permission = true;
    mocks.getPo.mockResolvedValue({
      id: 10,
      vendorId: 5,
      source: "auto_draft",
      status: "closed",
      physicalStatus: "received",
      financialStatus: "paid",
    });
    mocks.vendor.mockResolvedValue({ id: 5, name: "Synthetic vendor" });
    mocks.count.mockResolvedValue({ count: 0, maxSeverity: null });
    mocks.list.mockResolvedValue([]);
    mocks.readWorkflow.mockResolvedValue(workflow("disputed"));
  });
  it.each([
    ["received", "review_invoice_approval"],
    ["approved", "record_payment"],
    ["disputed", "review_financial_evidence"],
    ["paid", "done"],
  ] as const)(
    "publishes current %s evidence and derived action despite cached paid",
    async (status, action) => {
      mocks.readWorkflow.mockResolvedValue(workflow(status));
      const response = await fetch(`${base}/api/purchase-orders/10`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.financialWorkflow).toEqual(workflow(status));
      expect(body.autoDraftActionPlan.primaryAction.id).toBe(action);
      expect(body.financialStatus).toBe("paid");
      expect(mocks.readWorkflow).toHaveBeenCalledWith(10);
    },
  );
  it("rejects permission before reading financial evidence", async () => {
    mocks.permission = false;
    expect((await fetch(`${base}/api/purchase-orders/10`)).status).toBe(403);
    expect(mocks.getPo).not.toHaveBeenCalled();
    expect(mocks.readWorkflow).not.toHaveBeenCalled();
  });
  it("returns not found without reading evidence for an absent PO", async () => {
    mocks.getPo.mockResolvedValue(null);
    expect((await fetch(`${base}/api/purchase-orders/10`)).status).toBe(404);
    expect(mocks.readWorkflow).not.toHaveBeenCalled();
  });
  it("fails unavailable without leaking source errors or returning cached completion", async () => {
    mocks.readWorkflow.mockRejectedValue(
      new Error("private_connection_secret"),
    );
    const response = await fetch(`${base}/api/purchase-orders/10`);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain("PURCHASE_ORDER_DETAIL_UNAVAILABLE");
    expect(text).not.toContain("private_connection_secret");
    expect(text).not.toContain("autoDraftActionPlan");
    expect(mocks.log).toHaveBeenCalledWith(
      "procurement.purchase_order_detail",
      expect.objectContaining({ error_class: "Error" }),
    );
  });
  it("rejects a wrong-PO workflow response", async () => {
    const wrong = workflow("paid");
    mocks.readWorkflow.mockResolvedValue({
      ...wrong,
      purchaseOrderId: 20,
      evidence: { ...wrong.evidence, purchaseOrderId: 20 },
    });
    expect((await fetch(`${base}/api/purchase-orders/10`)).status).toBe(503);
  });
});
