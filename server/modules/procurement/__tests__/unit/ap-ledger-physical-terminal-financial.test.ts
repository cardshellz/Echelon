import { beforeEach, describe, expect, it, vi } from "vitest";

const tables = vi.hoisted(() => ({
  vendorInvoices: {
    id: "vendor_invoices.id",
    vendorId: "vendor_invoices.vendor_id",
    currency: "vendor_invoices.currency",
    status: "vendor_invoices.status",
    paidAmountCents: "vendor_invoices.paid_amount_cents",
  },
  vendorInvoiceLines: {
    id: "vendor_invoice_lines.id",
    vendorInvoiceId: "vendor_invoice_lines.vendor_invoice_id",
    purchaseOrderLineId: "vendor_invoice_lines.purchase_order_line_id",
    lineNumber: "vendor_invoice_lines.line_number",
  },
  vendorInvoicePoLinks: {
    id: "vendor_invoice_po_links.id",
    vendorInvoiceId: "vendor_invoice_po_links.vendor_invoice_id",
    purchaseOrderId: "vendor_invoice_po_links.purchase_order_id",
  },
  purchaseOrders: {
    id: "purchase_orders.id",
    vendorId: "purchase_orders.vendor_id",
    currency: "purchase_orders.currency",
    status: "purchase_orders.status",
  },
  purchaseOrderLines: {
    id: "purchase_order_lines.id",
    purchaseOrderId: "purchase_order_lines.purchase_order_id",
  },
  auditEvents: {},
  vendorInvoiceAttachments: {},
  apPayments: {},
  apPaymentAllocations: {},
  vendors: {},
  inboundFreightCosts: {},
  inboundShipments: {},
  poStatusHistory: {},
}));

const mocks = vi.hoisted(() => ({
  db: { transaction: vi.fn() },
}));

vi.mock("../../../../db", () => ({ db: mocks.db }));
vi.mock("@shared/schema", () => tables);
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
  and: vi.fn((...conditions: unknown[]) => conditions),
  inArray: vi.fn((field: unknown, values: unknown[]) => ({ field, values })),
  sql: vi.fn(),
  desc: vi.fn((value: unknown) => value),
  lt: vi.fn(),
  lte: vi.fn(),
  gte: vi.fn(),
  ne: vi.fn(),
  asc: vi.fn((value: unknown) => value),
  like: vi.fn(),
}));
vi.mock("../../po-exceptions.service", () => ({
  detectMatchMismatch: vi.fn(),
  detectOverpaid: vi.fn(),
  detectPastDue: vi.fn(),
}));
vi.mock("../../../inventory/cogs.service", () => ({ COGSService: class {} }));

function selectChain(rows: unknown[]) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  chain.for = vi.fn(() => Promise.resolve(rows));
  chain.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function buildTx(selectResults: unknown[][], writeReached: Error) {
  return {
    select: vi.fn(() => selectChain(selectResults.shift() ?? [])),
    insert: vi.fn(() => {
      throw writeReached;
    }),
  } as any;
}

const invoice = {
  id: 12,
  vendorId: 4,
  status: "received",
  paidAmountCents: 0,
};

describe("AP financial work after physical PO terminal states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["closed", "cancelled"] as const)(
    "allows invoice linking to reach its write after locking a %s PO",
    async (status) => {
      const writeReached = new Error("link write reached");
      const tx = buildTx([
        [invoice],
        [{ id: 55, vendorId: 4, status }],
      ], writeReached);
      mocks.db.transaction.mockImplementationOnce(async (callback: any) => callback(tx));
      const { linkPoToInvoice } = await import("../../ap-ledger.service");

      await expect(linkPoToInvoice(12, 55)).rejects.toBe(writeReached);
      expect(tx.insert).toHaveBeenCalledWith(tables.vendorInvoicePoLinks);
    },
  );

  it("allows a mapped invoice-line write after locking a physically closed PO", async () => {
    const writeReached = new Error("line write reached");
    const tx = buildTx([
      [invoice],
      [{ purchaseOrderId: 55 }],
      [{ id: 55, status: "closed" }],
      [{ purchaseOrderId: 55 }],
      [{ id: 91 }],
      [{ maxLine: 1 }],
    ], writeReached);
    mocks.db.transaction.mockImplementationOnce(async (callback: any) => callback(tx));
    const { addInvoiceLine } = await import("../../ap-ledger.service");

    await expect(addInvoiceLine(12, {
      purchaseOrderLineId: 88,
      qtyInvoiced: 10,
      unitCostMills: 125,
    })).rejects.toBe(writeReached);
    expect(tx.insert).toHaveBeenCalledWith(tables.vendorInvoiceLines);
  });

  it("rejects linking invoice and PO amounts denominated in different currencies", async () => {
    const writeReached = new Error("link write reached");
    const tx = buildTx([
      [{ ...invoice, currency: "EUR" }],
      [{ id: 55, vendorId: 4, status: "received", currency: "USD" }],
    ], writeReached);
    mocks.db.transaction.mockImplementationOnce(async (callback: any) => callback(tx));
    const { linkPoToInvoice } = await import("../../ap-ledger.service");

    await expect(linkPoToInvoice(12, 55)).rejects.toMatchObject({
      statusCode: 422,
      details: {
        code: "AP_INVOICE_PO_CURRENCY_MISMATCH",
        purchaseOrderId: 55,
        invoiceCurrency: "EUR",
        purchaseOrderCurrency: "USD",
      },
    });
    expect(tx.insert).not.toHaveBeenCalled();
  });
});
