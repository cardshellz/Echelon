import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import http from "http";
import { AddressInfo } from "net";

const mocks = vi.hoisted(() => {
  const idempotencyMiddleware = vi.fn((_req: any, _res: any, next: any) => next());
  return {
    idempotencyMiddleware,
    requireIdempotency: vi.fn(() => idempotencyMiddleware),
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
      getApSummary: vi.fn(),
      listApLedgerCommandAudit: vi.fn(),
    },
    apPaymentCommands: {
      recordPayment: vi.fn(),
      voidPayment: vi.fn(),
    },
    apInvoiceCommands: {
      approveInvoice: vi.fn(),
      disputeInvoice: vi.fn(),
      voidInvoice: vi.fn(),
    },
  };
});

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
  requireIdempotency: mocks.requireIdempotency,
}));

vi.mock("../../ap-ledger.service", () => ({
  ...mocks.apLedger,
}));

vi.mock("../../ap-payment-commands", () => ({
  apPaymentCommands: mocks.apPaymentCommands,
}));

vi.mock("../../ap-invoice-commands", () => ({
  apInvoiceCommands: mocks.apInvoiceCommands,
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
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    idempotencyReplayed: res.headers.get("idempotency-replayed"),
  };
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

  it("keeps legacy idempotency only on AP writes not yet using the transactional ledger", () => {
    buildApp();

    expect(mocks.requireIdempotency).toHaveBeenCalledTimes(4);
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
    mocks.apInvoiceCommands.approveInvoice.mockResolvedValue({
      commandId: 81,
      replayed: false,
      httpStatus: 200,
      body: { id: 12, status: "approved", apLedgerOutcome },
      terminalState: "succeeded",
    });
    server = await startServer(buildApp());

    const { status, body, idempotencyReplayed } = await requestJson(server.url, "POST", "/api/vendor-invoices/12/approve");

    expect(status).toBe(200);
    expect(idempotencyReplayed).toBe("false");
    expect(mocks.apInvoiceCommands.approveInvoice).toHaveBeenCalledWith(12, {
      userId: "test-user",
    }, expect.objectContaining({
      commandName: "ap.invoice.approve",
      resourceKey: "vendor_invoice:12",
      routeTemplate: "/api/vendor-invoices/:id/approve",
    }));
    expect(body).toEqual({ id: 12, status: "approved", apLedgerOutcome });
  });

  it("dispatches invoice disputes through the AP command boundary", async () => {
    mocks.apInvoiceCommands.disputeInvoice.mockResolvedValue({
      commandId: 82,
      replayed: true,
      httpStatus: 200,
      body: { id: 12, status: "disputed" },
      terminalState: "succeeded",
    });
    server = await startServer(buildApp());

    const { status, body, idempotencyReplayed } = await requestJson(server.url, "POST", "/api/vendor-invoices/12/dispute", {
      reason: "price mismatch",
    });

    expect(status).toBe(200);
    expect(idempotencyReplayed).toBe("true");
    expect(mocks.apInvoiceCommands.disputeInvoice).toHaveBeenCalledWith(12, {
      reason: "price mismatch",
      userId: "test-user",
    }, expect.objectContaining({
      commandName: "ap.invoice.dispute",
      resourceKey: "vendor_invoice:12",
      routeTemplate: "/api/vendor-invoices/:id/dispute",
    }));
    expect(body).toEqual({ id: 12, status: "disputed" });
  });

  it("dispatches invoice voids through the durable AP command boundary", async () => {
    mocks.apInvoiceCommands.voidInvoice.mockResolvedValue({
      commandId: 83,
      replayed: false,
      httpStatus: 200,
      body: { id: 12, status: "voided" },
      terminalState: "succeeded",
    });
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "POST", "/api/vendor-invoices/12/void", {
      reason: "duplicate invoice",
    });

    expect(status).toBe(200);
    expect(mocks.apInvoiceCommands.voidInvoice).toHaveBeenCalledWith(12, {
      reason: "duplicate invoice",
      userId: "test-user",
    }, expect.objectContaining({
      commandName: "ap.invoice.void",
      resourceKey: "vendor_invoice:12",
      routeTemplate: "/api/vendor-invoices/:id/void",
    }));
    expect(body).toEqual({ id: 12, status: "voided" });
  });

  it("records AP payments with normalized date, allocations, and creator", async () => {
    mocks.apPaymentCommands.recordPayment.mockResolvedValue({
      commandId: 91,
      replayed: false,
      httpStatus: 201,
      body: { id: 21, paymentNumber: "PAY-21" },
      terminalState: "succeeded",
    });
    server = await startServer(buildApp());

    const { status, body, idempotencyReplayed } = await requestJson(server.url, "POST", "/api/ap-payments", {
      vendorId: 4,
      paymentDate: "2026-05-16T12:00:00.000Z",
      paymentMethod: "ach",
      totalAmountCents: 2500,
      allocations: [{ vendorInvoiceId: 12, appliedAmountCents: 2500 }],
    });

    expect(status).toBe(201);
    expect(idempotencyReplayed).toBe("false");
    expect(mocks.apPaymentCommands.recordPayment).toHaveBeenCalledWith({
      payment: {
        vendorId: 4,
        paymentDate: new Date("2026-05-16T12:00:00.000Z"),
        paymentMethod: "ach",
        totalAmountCents: 2500,
        allocations: [{ vendorInvoiceId: 12, appliedAmountCents: 2500 }],
        createdBy: "test-user",
      },
    }, expect.objectContaining({
      actorId: "test-user",
      commandName: "ap.payment.record",
      resourceKey: "vendor:4",
      routeTemplate: "/api/ap-payments",
    }));
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
    mocks.apPaymentCommands.voidPayment.mockResolvedValue({
      commandId: 92,
      replayed: true,
      httpStatus: 200,
      body: { ok: true, apLedgerOutcome },
      terminalState: "succeeded",
    });
    server = await startServer(buildApp());

    const { status, body, idempotencyReplayed } = await requestJson(server.url, "POST", "/api/ap-payments/21/void", {
      reason: "duplicate",
    });

    expect(status).toBe(200);
    expect(idempotencyReplayed).toBe("true");
    expect(mocks.apPaymentCommands.voidPayment).toHaveBeenCalledWith(21, {
      reason: "duplicate",
      userId: "test-user",
    }, expect.objectContaining({
      actorId: "test-user",
      commandName: "ap.payment.void",
      resourceKey: "ap_payment:21",
      routeTemplate: "/api/ap-payments/:id/void",
    }));
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

  it("returns recent AP command audit events", async () => {
    mocks.apLedger.listApLedgerCommandAudit.mockResolvedValue([
      {
        id: 1,
        command: "record_payment",
        actor: "test-user",
        affectedInvoiceIds: [12],
        affectedPaymentIds: [21],
        affectedPurchaseOrderIds: [55],
        message: "record payment completed. Updated 1 linked PO.",
      },
    ]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "GET", "/api/ap/command-events?limit=5");

    expect(status).toBe(200);
    expect(mocks.apLedger.listApLedgerCommandAudit).toHaveBeenCalledWith(5);
    expect(body).toEqual({
      events: [
        {
          id: 1,
          command: "record_payment",
          actor: "test-user",
          affectedInvoiceIds: [12],
          affectedPaymentIds: [21],
          affectedPurchaseOrderIds: [55],
          message: "record payment completed. Updated 1 linked PO.",
        },
      ],
    });
  });
});
