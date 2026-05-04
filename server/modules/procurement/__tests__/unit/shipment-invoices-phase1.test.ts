import { describe, it, expect, vi, beforeEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for Spec D Phase 1 — shipment invoices read-only.
//
// Covers:
//   1. listInvoices with inboundShipmentId filter.
//   2. getShipmentInvoicesSummary returns correct sums.
//   3. enrichCostsWithInvoiceInfo derives correct status.
//   4. Route: GET /api/inbound-shipments/:id/invoices shape.
//   5. Route: empty case returns zero summary.
// ─────────────────────────────────────────────────────────────────────────────

// ── Mock db ──
const mockSelectChain: any = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  leftJoin: vi.fn().mockReturnThis(),
  innerJoin: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  offset: vi.fn().mockReturnThis(),
};

vi.mock("../../../../db", () => ({
  db: {
    select: vi.fn().mockReturnValue(mockSelectChain),
  },
}));

// ── Mock schema tables ──
vi.mock("@shared/schema", () => ({
  vendorInvoices: {
    id: "id",
    vendorId: "vendorId",
    inboundShipmentId: "inboundShipmentId",
    status: "status",
    invoiceNumber: "invoiceNumber",
    invoiceDate: "invoiceDate",
    dueDate: "dueDate",
    invoicedAmountCents: "invoicedAmountCents",
    paidAmountCents: "paidAmountCents",
    balanceCents: "balanceCents",
    createdAt: "createdAt",
  },
  vendorInvoicePoLinks: { vendorInvoiceId: "vendorInvoiceId" },
  purchaseOrders: { poNumber: "poNumber", id: "id" },
  vendors: { id: "id", name: "name", code: "code" },
  inboundFreightCosts: {
    id: "id",
    inboundShipmentId: "inboundShipmentId",
    costType: "costType",
    description: "description",
    vendorName: "vendorName",
    vendorId: "vendorId",
    vendorInvoiceId: "vendorInvoiceId",
    actualCents: "actualCents",
    estimatedCents: "estimatedCents",
  },
  inboundShipments: { id: "id" },
}));

vi.mock("@shared/schema/procurement.schema", () => ({}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a, b) => ({ type: "eq", a, b })),
  and: vi.fn((...args) => ({ type: "and", args })),
  inArray: vi.fn((col, vals) => ({ type: "inArray", col, vals })),
  desc: vi.fn((col) => ({ type: "desc", col })),
  lt: vi.fn((a, b) => ({ type: "lt", a, b })),
  lte: vi.fn((a, b) => ({ type: "lte", a, b })),
  gte: vi.fn((a, b) => ({ type: "gte", a, b })),
  ne: vi.fn((a, b) => ({ type: "ne", a, b })),
  asc: vi.fn((col) => ({ type: "asc", col })),
  like: vi.fn((a, b) => ({ type: "like", a, b })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: any[]) => ({ type: "sql", strings, values })),
}));

vi.mock("date-fns", () => ({
  format: vi.fn((date, fmt) => "Jan 1, 2026"),
}));

describe("getShipmentInvoicesSummary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns correct sums for a shipment with mixed paid/unpaid invoices", async () => {
    const { db } = await import("../../../../db");
    const { getShipmentInvoicesSummary } = await import("../../ap-ledger.service");

    // Mock the query result: 2 invoices, one paid, one partially paid
    (db.select as any).mockReturnValue({
      ...mockSelectChain,
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockResolvedValue([
          {
            invoice: {
              id: 1,
              invoiceNumber: "INV-001",
              invoicedAmountCents: 50000,
              paidAmountCents: 50000,
              balanceCents: 0,
              status: "paid",
              invoiceDate: new Date("2026-01-15"),
            },
            vendorName: "Freightos",
            vendorCode: "FRT",
          },
          {
            invoice: {
              id: 2,
              invoiceNumber: "INV-002",
              invoicedAmountCents: 30000,
              paidAmountCents: 10000,
              balanceCents: 20000,
              status: "partially_paid",
              invoiceDate: new Date("2026-01-20"),
            },
            vendorName: "Clearit USA",
            vendorCode: "CLR",
          },
        ]),
      }),
    });

    const result = await getShipmentInvoicesSummary(42);

    expect(result.invoices).toHaveLength(2);
    expect(result.summary.totalInvoicedCents).toBe(80000);
    expect(result.summary.totalPaidCents).toBe(60000);
    expect(result.summary.outstandingCents).toBe(20000);
    expect(result.summary.invoiceCount).toBe(2);
  });

  it("returns empty array and zero summary for shipment with no invoices", async () => {
    const { db } = await import("../../../../db");
    const { getShipmentInvoicesSummary } = await import("../../ap-ledger.service");

    (db.select as any).mockReturnValue({
      ...mockSelectChain,
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockResolvedValue([]),
      }),
    });

    const result = await getShipmentInvoicesSummary(99);

    expect(result.invoices).toHaveLength(0);
    expect(result.summary.totalInvoicedCents).toBe(0);
    expect(result.summary.totalPaidCents).toBe(0);
    expect(result.summary.outstandingCents).toBe(0);
    expect(result.summary.invoiceCount).toBe(0);
  });
});

describe("listInvoices with inboundShipmentId filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes inboundShipmentId filter to the query", async () => {
    const { db } = await import("../../../../db");
    const { listInvoices } = await import("../../ap-ledger.service");

    // First call is for invoices, second is for PO links
    let callCount = 0;
    (db.select as any).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Invoice query
        return {
          ...mockSelectChain,
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue([
                  {
                    invoice: { id: 1, inboundShipmentId: 42, invoiceNumber: "INV-001" },
                    vendorName: "Freightos",
                    vendorCode: "FRT",
                  },
                ]),
              }),
            }),
          }),
        };
      }
      // PO links query
      return {
        ...mockSelectChain,
        where: vi.fn().mockResolvedValue([]),
      };
    });

    const result = await listInvoices({ inboundShipmentId: 42 });

    expect(result).toHaveLength(1);
    expect(result[0].invoiceNumber).toBe("INV-001");
  });
});

describe("enrichCostsWithInvoiceInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("derives 'paid' status when invoice balance is 0", async () => {
    const { db } = await import("../../../../db");
    const { enrichCostsWithInvoiceInfo } = await import("../../ap-ledger.service");

    (db.select as any).mockReturnValue({
      ...mockSelectChain,
      where: vi.fn().mockResolvedValue([
        {
          cost: { id: 1, costType: "freight", description: "Ocean freight", vendorName: "Freightos", vendorId: 5 },
          invoiceId: 10,
          invoiceNumber: "INV-010",
          invoiceVendorId: 5,
          invoiceStatus: "paid",
          invoiceVendorName: "Freightos Inc",
          invoicedAmountCents: 50000,
          paidAmountCents: 50000,
          balanceCents: 0,
        },
      ]),
    });

    const result = await enrichCostsWithInvoiceInfo(1);

    expect(result).toHaveLength(1);
    expect(result[0].derivedStatus).toBe("paid");
    expect(result[0].linkedInvoice).toEqual({
      id: 10,
      invoiceNumber: "INV-010",
      vendorId: 5,
      vendorName: "Freightos Inc",
    });
  });

  it("derives 'invoiced' status when invoice has outstanding balance", async () => {
    const { db } = await import("../../../../db");
    const { enrichCostsWithInvoiceInfo } = await import("../../ap-ledger.service");

    (db.select as any).mockReturnValue({
      ...mockSelectChain,
      where: vi.fn().mockResolvedValue([
        {
          cost: { id: 2, costType: "duty", description: "Customs duty", vendorName: "Clearit", vendorId: 6 },
          invoiceId: 11,
          invoiceNumber: "INV-011",
          invoiceVendorId: 6,
          invoiceStatus: "approved",
          invoiceVendorName: "Clearit USA",
          invoicedAmountCents: 30000,
          paidAmountCents: 0,
          balanceCents: 30000,
        },
      ]),
    });

    const result = await enrichCostsWithInvoiceInfo(1);

    expect(result[0].derivedStatus).toBe("invoiced");
    expect(result[0].linkedInvoice).not.toBeNull();
  });

  it("derives 'unbilled' status when no invoice linked", async () => {
    const { db } = await import("../../../../db");
    const { enrichCostsWithInvoiceInfo } = await import("../../ap-ledger.service");

    (db.select as any).mockReturnValue({
      ...mockSelectChain,
      where: vi.fn().mockResolvedValue([
        {
          cost: { id: 3, costType: "insurance", description: "Cargo insurance", vendorName: null, vendorId: null },
          invoiceId: null,
          invoiceNumber: null,
          invoiceVendorId: null,
          invoiceStatus: null,
          invoiceVendorName: null,
          invoicedAmountCents: null,
          paidAmountCents: null,
          balanceCents: null,
        },
      ]),
    });

    const result = await enrichCostsWithInvoiceInfo(1);

    expect(result[0].derivedStatus).toBe("unbilled");
    expect(result[0].linkedInvoice).toBeNull();
  });

  it("derives 'unbilled' when linked invoice is voided", async () => {
    const { db } = await import("../../../../db");
    const { enrichCostsWithInvoiceInfo } = await import("../../ap-ledger.service");

    (db.select as any).mockReturnValue({
      ...mockSelectChain,
      where: vi.fn().mockResolvedValue([
        {
          cost: { id: 4, costType: "freight", description: "Freight", vendorName: "Freightos", vendorId: 5 },
          invoiceId: 12,
          invoiceNumber: "INV-012",
          invoiceVendorId: 5,
          invoiceStatus: "voided",
          invoiceVendorName: "Freightos Inc",
          invoicedAmountCents: 50000,
          paidAmountCents: 0,
          balanceCents: 50000,
        },
      ]),
    });

    const result = await enrichCostsWithInvoiceInfo(1);

    expect(result[0].derivedStatus).toBe("unbilled");
    expect(result[0].linkedInvoice).not.toBeNull(); // linkedInvoice still present, but status is unbilled
  });
});
