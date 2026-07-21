import { beforeEach, describe, expect, it, vi } from "vitest";

const tables = vi.hoisted(() => ({
  vendorInvoices: {
    id: "vendor_invoices.id",
    vendorId: "vendor_invoices.vendor_id",
    invoiceNumber: "vendor_invoices.invoice_number",
    status: "vendor_invoices.status",
    paidAmountCents: "vendor_invoices.paid_amount_cents",
  },
  vendorInvoiceLines: {
    id: "vendor_invoice_lines.id",
    vendorInvoiceId: "vendor_invoice_lines.vendor_invoice_id",
    purchaseOrderLineId: "vendor_invoice_lines.purchase_order_line_id",
    lineNumber: "vendor_invoice_lines.line_number",
  },
  purchaseOrderLines: {
    id: "purchase_order_lines.id",
  },
  auditEvents: { id: "audit_events.id" },
  vendorInvoicePoLinks: {},
  vendorInvoiceAttachments: {},
  apPayments: {},
  apPaymentAllocations: {},
  purchaseOrders: {},
  vendors: {},
  inboundFreightCosts: {},
  inboundShipments: {},
  poStatusHistory: {},
}));

const mocks = vi.hoisted(() => ({
  db: {
    transaction: vi.fn(),
  },
  detectMatchMismatch: vi.fn(),
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
  detectMatchMismatch: mocks.detectMatchMismatch,
  detectOverpaid: vi.fn(),
  detectPastDue: vi.fn(),
}));
vi.mock("../../../inventory/cogs.service", () => ({ COGSService: class {} }));

function selectChain(rows: unknown[]) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  chain.for = vi.fn(() => Promise.resolve(rows));
  chain.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function buildTx(selectResults: unknown[][]) {
  const updates: Array<{ table: unknown; patch: Record<string, unknown> }> = [];
  const audits: unknown[] = [];
  const tx: any = {
    select: vi.fn(() => selectChain(selectResults.shift() ?? [])),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        updates.push({ table, patch });
        return { where: vi.fn(() => Promise.resolve([])) };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((row: unknown) => {
        audits.push(row);
        return Promise.resolve([]);
      }),
    })),
    updates,
    audits,
  };
  return tx;
}

const poLine = {
  id: 50,
  orderQty: 100,
  receivedQty: 100,
  unitCostCents: 7,
  unitCostMills: 650,
};

function invoiceLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 70,
    vendorInvoiceId: 12,
    purchaseOrderLineId: 50,
    lineNumber: 1,
    qtyInvoiced: 100,
    qtyReceived: 0,
    unitCostCents: 7,
    unitCostMills: 650,
    matchStatus: "pending",
    ...overrides,
  };
}

describe("runInvoiceMatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detectMatchMismatch.mockResolvedValue(undefined);
  });

  it.each(["approved", "partially_paid", "paid"])(
    "recomputes derived match state when the invoice is %s",
    async (status) => {
      const line = invoiceLine();
      const tx = buildTx([
        [{ id: 12, vendorId: 4, status, paidAmountCents: status === "paid" ? 700 : 0 }],
        [line],
        [poLine],
        [line],
        [{ id: 12, status }],
      ]);
      mocks.db.transaction.mockImplementationOnce(async (callback: any) => callback(tx));
      const { runInvoiceMatch } = await import("../../ap-ledger.service");

      const result = await runInvoiceMatch(12, "ops-user");

      expect(result).toEqual([expect.objectContaining({ id: 70, matchStatus: "matched" })]);
      expect(tx.updates).toContainEqual(expect.objectContaining({
        table: tables.vendorInvoiceLines,
        patch: expect.objectContaining({ qtyReceived: 100, matchStatus: "matched" }),
      }));
    },
  );

  it("aggregates split lines across non-voided invoices for the same PO line", async () => {
    const targetLine = invoiceLine({ qtyInvoiced: 40 });
    const secondLine = invoiceLine({ id: 71, vendorInvoiceId: 13, qtyInvoiced: 60 });
    const tx = buildTx([
      [{ id: 12, vendorId: 4, status: "approved", paidAmountCents: 0 }],
      [targetLine],
      [poLine],
      [targetLine, secondLine],
      [{ id: 12, status: "approved" }, { id: 13, status: "received" }],
    ]);
    mocks.db.transaction.mockImplementationOnce(async (callback: any) => callback(tx));
    const { runInvoiceMatch } = await import("../../ap-ledger.service");

    const result = await runInvoiceMatch(12, "ops-user");

    expect(result[0]).toMatchObject({ id: 70, matchStatus: "matched" });
    expect(tx.updates.filter((entry: any) => entry.table === tables.vendorInvoiceLines))
      .toEqual([
        expect.objectContaining({ patch: expect.objectContaining({ matchStatus: "matched" }) }),
        expect.objectContaining({ patch: expect.objectContaining({ matchStatus: "matched" }) }),
      ]);
    expect(tx.audits).toHaveLength(2);
  });

  it("rejects matching a voided invoice before touching lines", async () => {
    const tx = buildTx([
      [{ id: 12, vendorId: 4, status: "voided", paidAmountCents: 0 }],
    ]);
    mocks.db.transaction.mockImplementationOnce(async (callback: any) => callback(tx));
    const { runInvoiceMatch } = await import("../../ap-ledger.service");

    await expect(runInvoiceMatch(12, "ops-user")).rejects.toMatchObject({
      statusCode: 409,
      details: { code: "AP_INVOICE_MATCH_VOIDED", invoiceId: 12 },
    });
    expect(tx.updates).toHaveLength(0);
  });
});
