import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";

// ─────────────────────────────────────────────────────────────────────────────
// Route-level tests for Spec A endpoints.
//
// We mount the real procurement routes into a fresh Express app but mock the
// middleware (auth/permission/idempotency) and the purchasing service. This
// isolates HTTP wiring — request parsing, error mapping, route ordering, and
// response shape — from the service implementation (covered by the sibling
// service test file).
// ─────────────────────────────────────────────────────────────────────────────

// Mock the auth middleware to pass through and stub the session user.
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

// Idempotency: bypass — pass through without persisting keys. Unit scope.
vi.mock("../../../../middleware/idempotency", () => ({
  requireIdempotency: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// Mock every other dependency the routes import so nothing hits a real DB.
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

// Now import the router registrar after mocks are in place.
import { registerPurchasingRoutes } from "../../procurement.routes";

function buildPurchasingMock(overrides: Record<string, any> = {}) {
  return {
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
    ...overrides,
  } as any;
}

function buildApp(purchasing: any): Express {
  const app = express();
  app.use(express.json());
  app.locals.services = { purchasing, shipmentTracking: {} };
  registerPurchasingRoutes(app);
  return app;
}

// Minimal fetch-style helper. We call Express handlers directly via supertest-
// like request simulation using Node's http module through supertest. But to
// stay dependency-light we simulate manually with a tiny helper.
import http from "http";
import { AddressInfo } from "net";

function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

async function jsonRequest(
  baseUrl: string,
  method: string,
  path: string,
  body?: any,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "test-key-" + Math.random().toString(36).slice(2),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

describe("GET /api/purchase-orders/new-preload", () => {
  let server: { url: string; close: () => Promise<void> };
  let purchasing: ReturnType<typeof buildPurchasingMock>;

  beforeEach(async () => {
    purchasing = buildPurchasingMock();
    server = await startServer(buildApp(purchasing));
  });

  afterEach(async () => {
    await server.close();
  });

  it("parses variant_ids CSV into integers and forwards to service", async () => {
    purchasing.getNewPoPreload.mockResolvedValue({ vendor: null, lines: [], sourcePo: null });
    await jsonRequest(server.url, "GET", "/api/purchase-orders/new-preload?variant_ids=12,45,67&vendor_id=3");
    expect(purchasing.getNewPoPreload).toHaveBeenCalledWith({
      vendorId: 3,
      variantIds: [12, 45, 67],
      duplicateFrom: undefined,
    });
  });

  it("forwards duplicate_from", async () => {
    purchasing.getNewPoPreload.mockResolvedValue({ vendor: null, lines: [], sourcePo: null });
    await jsonRequest(server.url, "GET", "/api/purchase-orders/new-preload?duplicate_from=4509");
    expect(purchasing.getNewPoPreload).toHaveBeenCalledWith({
      vendorId: undefined,
      variantIds: undefined,
      duplicateFrom: 4509,
    });
  });

  it("returns 200 with service payload", async () => {
    purchasing.getNewPoPreload.mockResolvedValue({
      vendor: { id: 1, name: "Acme" },
      lines: [],
      sourcePo: null,
    });
    const { status, body } = await jsonRequest(
      server.url,
      "GET",
      "/api/purchase-orders/new-preload?vendor_id=1",
    );
    expect(status).toBe(200);
    expect(body.vendor.name).toBe("Acme");
  });
});

describe("POST /api/purchase-orders (dual-mode)", () => {
  let server: { url: string; close: () => Promise<void> };
  let purchasing: ReturnType<typeof buildPurchasingMock>;

  beforeEach(async () => {
    purchasing = buildPurchasingMock();
    server = await startServer(buildApp(purchasing));
  });

  afterEach(async () => {
    await server.close();
  });

  it("legacy empty-create path calls createPO", async () => {
    purchasing.createPO.mockResolvedValue({ id: 1, status: "draft" });
    const { status } = await jsonRequest(server.url, "POST", "/api/purchase-orders", {
      vendorId: 1,
      poType: "standard",
    });
    expect(status).toBe(201);
    expect(purchasing.createPO).toHaveBeenCalled();
    expect(purchasing.createPurchaseOrderWithLines).not.toHaveBeenCalled();
  });

  it("inline-lines path calls createPurchaseOrderWithLines", async () => {
    purchasing.createPurchaseOrderWithLines.mockResolvedValue({ id: 7, poNumber: "PO-1" });
    const { status, body } = await jsonRequest(server.url, "POST", "/api/purchase-orders", {
      vendor_id: 1,
      lines: [{ product_variant_id: 10, quantity_ordered: 3, unit_cost_cents: 250 }],
    });
    expect(status).toBe(201);
    expect(purchasing.createPurchaseOrderWithLines).toHaveBeenCalledTimes(1);
    expect(purchasing.sendPurchaseOrder).not.toHaveBeenCalled();
    expect(body.po.id).toBe(7);
  });

  it("advance_to_sent=true also calls sendPurchaseOrder", async () => {
    purchasing.createPurchaseOrderWithLines.mockResolvedValue({ id: 7, poNumber: "PO-1" });
    purchasing.sendPurchaseOrder.mockResolvedValue({
      po: { id: 7, status: "sent" },
      status: "sent",
      pdf: { pdf_placeholder: true, reason: "PDF generation not yet implemented" },
      pendingApproval: false,
    });
    const { status, body } = await jsonRequest(server.url, "POST", "/api/purchase-orders", {
      vendor_id: 1,
      lines: [{ product_variant_id: 10, quantity_ordered: 3, unit_cost_cents: 250 }],
      advance_to_sent: true,
    });
    expect(status).toBe(201);
    expect(purchasing.sendPurchaseOrder).toHaveBeenCalledWith(7, "test-user");
    expect(body.pdf.pdf_placeholder).toBe(true);
    expect(body.status).toBe("sent");
  });
});

describe("POST /api/purchase-orders/:id/send-pdf", () => {
  let server: { url: string; close: () => Promise<void> };
  let purchasing: ReturnType<typeof buildPurchasingMock>;

  beforeEach(async () => {
    purchasing = buildPurchasingMock();
    server = await startServer(buildApp(purchasing));
  });

  afterEach(async () => {
    await server.close();
  });

  it("returns { po, status, pdf, pending_approval }", async () => {
    purchasing.sendPurchaseOrder.mockResolvedValue({
      po: { id: 42, status: "sent" },
      status: "sent",
      pdf: { pdf_placeholder: true, reason: "PDF generation not yet implemented" },
      pendingApproval: false,
    });
    const { status, body } = await jsonRequest(
      server.url,
      "POST",
      "/api/purchase-orders/42/send-pdf",
    );
    expect(status).toBe(200);
    expect(body.pdf.pdf_placeholder).toBe(true);
    expect(body.pending_approval).toBe(false);
  });

  it("pending_approval path returns no pdf", async () => {
    purchasing.sendPurchaseOrder.mockResolvedValue({
      po: { id: 42, status: "pending_approval" },
      status: "pending_approval",
      pdf: null,
      pendingApproval: true,
    });
    const { body } = await jsonRequest(server.url, "POST", "/api/purchase-orders/42/send-pdf");
    expect(body.pdf).toBeNull();
    expect(body.pending_approval).toBe(true);
  });
});

describe("POST /api/purchase-orders/:id/duplicate", () => {
  let server: { url: string; close: () => Promise<void> };
  let purchasing: ReturnType<typeof buildPurchasingMock>;

  beforeEach(async () => {
    purchasing = buildPurchasingMock();
    server = await startServer(buildApp(purchasing));
  });

  afterEach(async () => {
    await server.close();
  });

  it("returns the new PO id + number", async () => {
    purchasing.duplicatePurchaseOrder.mockResolvedValue({ id: 99, poNumber: "PO-99" });
    const { status, body } = await jsonRequest(
      server.url,
      "POST",
      "/api/purchase-orders/5/duplicate",
      {},
    );
    expect(status).toBe(201);
    expect(body).toEqual({ id: 99, po_number: "PO-99" });
  });
});

describe("Settings endpoints", () => {
  let server: { url: string; close: () => Promise<void> };
  let purchasing: ReturnType<typeof buildPurchasingMock>;

  beforeEach(async () => {
    purchasing = buildPurchasingMock();
    server = await startServer(buildApp(purchasing));
  });

  afterEach(async () => {
    await server.close();
  });

  it("GET /api/settings/procurement returns settings", async () => {
    purchasing.getProcurementSettings.mockResolvedValue({
      requireApproval: false,
      autoSendOnApprove: true,
      useNewPoEditor: false,
    });
    const { status, body } = await jsonRequest(server.url, "GET", "/api/settings/procurement");
    expect(status).toBe(200);
    expect(body.requireApproval).toBe(false);
  });

  it("PATCH accepts { key, value }", async () => {
    purchasing.updateProcurementSetting.mockResolvedValue({ requireApproval: true });
    const { status } = await jsonRequest(server.url, "PATCH", "/api/settings/procurement", {
      key: "requireApproval",
      value: true,
    });
    expect(status).toBe(200);
    expect(purchasing.updateProcurementSetting).toHaveBeenCalledWith(
      "requireApproval",
      true,
      "test-user",
    );
  });

  it("PATCH accepts { updates: [...] } batch form", async () => {
    purchasing.updateProcurementSetting.mockResolvedValue({});
    await jsonRequest(server.url, "PATCH", "/api/settings/procurement", {
      updates: [
        { key: "requireApproval", value: true },
        { key: "useNewPoEditor", value: true },
      ],
    });
    expect(purchasing.updateProcurementSetting).toHaveBeenCalledTimes(2);
  });

  it("PATCH rejects empty body", async () => {
    const { status, body } = await jsonRequest(server.url, "PATCH", "/api/settings/procurement", {});
    expect(status).toBe(400);
    expect(body.error).toMatch(/key, value.*updates/);
  });
});

