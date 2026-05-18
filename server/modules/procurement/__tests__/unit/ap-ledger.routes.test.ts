import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import http from "http";
import { AddressInfo } from "net";

const mocks = vi.hoisted(() => ({
  apLedger: {
    listInvoices: vi.fn(),
    generateInvoiceNumber: vi.fn(),
    createInvoice: vi.fn(),
    getInvoiceById: vi.fn(),
    updateInvoice: vi.fn(),
    approveInvoice: vi.fn(),
    disputeInvoice: vi.fn(),
    voidInvoice: vi.fn(),
    linkPoToInvoice: vi.fn(),
    unlinkPoFromInvoice: vi.fn(),
    getInvoicesForPo: vi.fn(),
    importLinesFromPO: vi.fn(),
    addInvoiceLine: vi.fn(),
    updateInvoiceLine: vi.fn(),
    removeInvoiceLine: vi.fn(),
    runInvoiceMatch: vi.fn(),
    addAttachment: vi.fn(),
    getAttachments: vi.fn(),
    getAttachmentById: vi.fn(),
    removeAttachment: vi.fn(),
    listPayments: vi.fn(),
    recordPayment: vi.fn(),
    getPaymentById: vi.fn(),
    voidPayment: vi.fn(),
    executeApLedgerCommand: vi.fn(),
    getApSummary: vi.fn(),
  },
}));

vi.mock("../../../../routes/middleware", () => {
  const pass = (req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { id: "test-user" };
    (req as any).session = { user: { id: "test-user" } };
    next();
  };
  return {
    requirePermission: () => pass,
    upload: {
      single: () => pass,
    },
  };
});

vi.mock("../../../../middleware/idempotency", () => ({
  requireIdempotency: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock("../../ap-ledger.service", () => ({
  ...mocks.apLedger,
}));

import { registerApLedgerRoutes } from "../../ap-ledger.routes";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  registerApLedgerRoutes(app);
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
    headers: { "content-type": "application/json", "idempotency-key": "test-key" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("AP ledger routes", () => {
  let server: { url: string; close: () => Promise<void> } | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  it("lists vendor invoices with parsed filters", async () => {
    mocks.apLedger.listInvoices.mockResolvedValue([{ id: 9, invoiceNumber: "INV-9" }]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(
      server.url,
      "GET",
      "/api/vendor-invoices?vendorId=7&inboundShipmentId=8&status=draft,approved&overdue=true&dueBefore=2026-05-20&limit=20&offset=10",
    );

    expect(status).toBe(200);
    expect(mocks.apLedger.listInvoices).toHaveBeenCalledWith({
      vendorId: 7,
      inboundShipmentId: 8,
      status: ["draft", "approved"],
      overdue: true,
      dueBefore: new Date("2026-05-20"),
      limit: 20,
      offset: 10,
    });
    expect(body).toEqual({ invoices: [{ id: 9, invoiceNumber: "INV-9" }] });
  });

  it("creates vendor invoices with normalized dates and creator", async () => {
    mocks.apLedger.createInvoice.mockResolvedValue({ id: 12, invoiceNumber: "INV-12" });
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "POST", "/api/vendor-invoices", {
      vendorId: 3,
      invoiceNumber: "INV-12",
      invoiceDate: "2026-05-16T00:00:00.000Z",
      dueDate: "2026-06-16T00:00:00.000Z",
    });

    expect(status).toBe(201);
    expect(mocks.apLedger.createInvoice).toHaveBeenCalledWith({
      vendorId: 3,
      invoiceNumber: "INV-12",
      invoiceDate: new Date("2026-05-16T00:00:00.000Z"),
      dueDate: new Date("2026-06-16T00:00:00.000Z"),
      createdBy: "test-user",
    });
    expect(body).toEqual({ id: 12, invoiceNumber: "INV-12" });
  });

  it("returns PO-linked invoices through the AP owner", async () => {
    mocks.apLedger.getInvoicesForPo.mockResolvedValue([{ id: 31, purchaseOrderId: 55 }]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/purchase-orders/55/invoices");

    expect(status).toBe(200);
    expect(mocks.apLedger.getInvoicesForPo).toHaveBeenCalledWith(55);
    expect(body).toEqual({ invoices: [{ id: 31, purchaseOrderId: 55 }] });
  });

  it("dispatches invoice approval through the AP command boundary", async () => {
    const apLedgerOutcome = {
      command: "approve_invoice",
      entityType: "invoice",
      entityId: 12,
      affectedInvoiceIds: [12],
      affectedPaymentIds: [],
      affectedPurchaseOrderIds: [55],
      message: "approve invoice completed. Updated 1 linked PO.",
    };
    mocks.apLedger.executeApLedgerCommand.mockResolvedValue({ id: 12, status: "approved", apLedgerOutcome });
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "POST", "/api/vendor-invoices/12/approve");

    expect(status).toBe(200);
    expect(mocks.apLedger.executeApLedgerCommand).toHaveBeenCalledWith("approve_invoice", {
      invoiceId: 12,
      userId: "test-user",
    });
    expect(body).toEqual({ id: 12, status: "approved", apLedgerOutcome });
  });

  it("dispatches invoice disputes through the AP command boundary", async () => {
    mocks.apLedger.executeApLedgerCommand.mockResolvedValue({ id: 12, status: "disputed" });
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "POST", "/api/vendor-invoices/12/dispute", {
      reason: "price mismatch",
    });

    expect(status).toBe(200);
    expect(mocks.apLedger.executeApLedgerCommand).toHaveBeenCalledWith("dispute_invoice", {
      invoiceId: 12,
      reason: "price mismatch",
      userId: "test-user",
    });
    expect(body).toEqual({ id: 12, status: "disputed" });
  });

  it("records AP payments with normalized date, allocations, and creator", async () => {
    mocks.apLedger.executeApLedgerCommand.mockResolvedValue({ id: 21, paymentNumber: "PAY-21" });
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "POST", "/api/ap-payments", {
      vendorId: 4,
      paymentDate: "2026-05-16T12:00:00.000Z",
      paymentMethod: "ach",
      totalAmountCents: 2500,
      allocations: [{ vendorInvoiceId: 12, appliedAmountCents: 2500 }],
    });

    expect(status).toBe(201);
    expect(mocks.apLedger.executeApLedgerCommand).toHaveBeenCalledWith("record_payment", {
      payment: {
        vendorId: 4,
        paymentDate: new Date("2026-05-16T12:00:00.000Z"),
        paymentMethod: "ach",
        totalAmountCents: 2500,
        allocations: [{ vendorInvoiceId: 12, appliedAmountCents: 2500 }],
        createdBy: "test-user",
      },
    });
    expect(body).toEqual({ id: 21, paymentNumber: "PAY-21" });
  });

  it("dispatches payment voids through the AP command boundary", async () => {
    const apLedgerOutcome = {
      command: "void_payment",
      entityType: "payment",
      entityId: 21,
      affectedInvoiceIds: [12],
      affectedPaymentIds: [21],
      affectedPurchaseOrderIds: [55],
      message: "void payment completed. Updated 1 linked PO.",
    };
    mocks.apLedger.executeApLedgerCommand.mockResolvedValue({ ok: true, apLedgerOutcome });
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "POST", "/api/ap-payments/21/void", {
      reason: "duplicate",
    });

    expect(status).toBe(200);
    expect(mocks.apLedger.executeApLedgerCommand).toHaveBeenCalledWith("void_payment", {
      paymentId: 21,
      reason: "duplicate",
      userId: "test-user",
    });
    expect(body).toEqual({ ok: true, apLedgerOutcome });
  });

  it("returns AP summary data", async () => {
    mocks.apLedger.getApSummary.mockResolvedValue({ totalOpenCents: 12345 });
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/ap/summary");

    expect(status).toBe(200);
    expect(mocks.apLedger.getApSummary).toHaveBeenCalled();
    expect(body).toEqual({ totalOpenCents: 12345 });
  });
});
