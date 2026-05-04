import { describe, it, expect, vi, beforeEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for Spec D Phase 2 — Add Invoice flow from shipment costs.
//
// Covers:
//   1. createInvoiceFromShipmentCosts — happy path.
//   2. createInvoiceFromShipmentCosts — rejects no candidate rows (400).
//   3. createInvoiceFromShipmentCosts — rejects missing vendor (404).
//   4. createInvoiceFromShipmentCosts — rejects cancelled shipment (400).
//   5. createInvoiceFromShipmentCosts — rejects empty invoice number (400).
//   6. createInvoiceFromShipmentCosts — lineOverrides applied correctly.
//   7. createInvoiceFromShipmentCosts — rejects already-invoiced rows (409).
// ─────────────────────────────────────────────────────────────────────────────

// ── Hoisted mock state (must be declared before vi.mock calls) ──
const {
  mockTxExecute,
  mockTxInsertCallCount,
  mockTxInsertValues,
  mockDbTransactionCallCount,
  mockSelectResults,
} = vi.hoisted(() => {
  return {
    mockTxExecute: vi.fn(),
    mockTxInsertCallCount: { value: 0 },
    mockTxInsertValues: { values: [] as any[] },
    mockDbTransactionCallCount: { value: 0 },
    mockSelectResults: { results: [] as any[][] },
  };
});

// ── Mock db ──
vi.mock("../../../../db", () => ({
  db: {
    transaction: vi.fn().mockImplementation(async (fn: any) => {
      mockDbTransactionCallCount.value++;
      const tx = {
        execute: mockTxExecute,
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockImplementation((vals: any) => {
            mockTxInsertCallCount.value++;
            mockTxInsertValues.values.push(vals);
            return {
              returning: vi.fn().mockResolvedValue([{ id: 999 }]),
            };
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue({}),
          }),
        }),
      };
      return fn(tx);
    }),
    select: vi.fn().mockImplementation(() => {
      const idx = mockSelectResults.results.length > 0 ? 0 : 0;
      const result = mockSelectResults.results.shift() || [{ shipmentNumber: "SHP-001", status: "delivered" }];
      return {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(result),
      };
    }),
  },
}));

// ── Mock schema tables ──
vi.mock("@shared/schema", () => ({
  inboundFreightCosts: {
    id: "id",
    inboundShipmentId: "inboundShipmentId",
    vendorId: "vendorId",
    vendorInvoiceId: "vendorInvoiceId",
    costType: "costType",
    actualCents: "actualCents",
    estimatedCents: "estimatedCents",
    performedByName: "performedByName",
    costStatus: "costStatus",
    invoiceNumber: "invoiceNumber",
    invoiceDate: "invoiceDate",
    dueDate: "dueDate",
  },
  inboundShipments: {
    id: "id",
    shipmentNumber: "shipmentNumber",
    status: "status",
  },
  vendors: {
    id: "id",
    name: "name",
    paymentTermsDays: "paymentTermsDays",
  },
  vendorInvoices: {
    id: "id",
    invoiceNumber: "invoiceNumber",
    vendorId: "vendorId",
    inboundShipmentId: "inboundShipmentId",
    status: "status",
    invoiceDate: "invoiceDate",
    receivedDate: "receivedDate",
    dueDate: "dueDate",
    invoicedAmountCents: "invoicedAmountCents",
    balanceCents: "balanceCents",
    paidAmountCents: "paidAmountCents",
    currency: "currency",
    notes: "notes",
  },
  vendorInvoiceLines: {
    id: "id",
    vendorInvoiceId: "vendorInvoiceId",
    lineNumber: "lineNumber",
    freightCostId: "freightCostId",
    description: "description",
    productName: "productName",
    qtyInvoiced: "qtyInvoiced",
    unitCostCents: "unitCostCents",
    lineTotalCents: "lineTotalCents",
    matchStatus: "matchStatus",
  },
}));

// ── Mock drizzle-orm ──
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: any, b: any) => ({ type: "eq", left: a, right: b })),
  and: vi.fn((...args: any[]) => ({ type: "and", args })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: any[]) => ({
      type: "sql",
      strings,
      values,
    })),
    { join: vi.fn((arr: any[], sep: any) => ({ type: "join", arr, sep })) },
  ),
  desc: vi.fn((x: any) => ({ type: "desc", value: x })),
  ne: vi.fn((a: any, b: any) => ({ type: "ne", left: a, right: b })),
  inArray: vi.fn((a: any, b: any) => ({ type: "inArray", left: a, right: b })),
}));

// ── Import after mocks ──
import {
  createInvoiceFromShipmentCosts,
  ApLedgerError,
} from "../../ap-ledger.service";

// ── Reset helper ──
function resetMocks() {
  mockTxExecute.mockReset();
  mockTxInsertCallCount.value = 0;
  mockTxInsertValues.values = [];
  mockDbTransactionCallCount.value = 0;
  mockSelectResults.results = [];
}

// ── Tests ──

describe("createInvoiceFromShipmentCosts", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("happy path: creates invoice, lines, and updates cost row denorms in one tx", async () => {
    // Shipment lookup → vendor lookup
    mockSelectResults.results = [
      [{ shipmentNumber: "SHP-001", status: "delivered" }],
      [{ id: 42, name: "Freightos", paymentTermsDays: 30 }],
    ];

    mockTxExecute.mockResolvedValue({
      rows: [
        {
          id: 101,
          cost_type: "freight",
          description: "Ocean freight",
          actual_cents: 50000,
          estimated_cents: 45000,
          performed_by_name: "ExFreight Zeta",
          vendor_id: 42,
          vendor_invoice_id: null,
          cost_status: "estimated",
        },
        {
          id: 102,
          cost_type: "duty",
          description: "Customs duty",
          actual_cents: null,
          estimated_cents: 12000,
          performed_by_name: "Clearit USA",
          vendor_id: 42,
          vendor_invoice_id: null,
          cost_status: "estimated",
        },
      ],
    });

    const result = await createInvoiceFromShipmentCosts(1, {
      vendorId: 42,
      invoiceNumber: "INV-001",
      invoiceDate: new Date("2026-05-01"),
    });

    // Transaction was used
    expect(mockDbTransactionCallCount.value).toBe(1);

    // Lines were inserted (2 cost rows)
    const lineInserts = mockTxInsertValues.values.filter(
      (v) => v.vendorInvoiceId === 999,
    );
    expect(lineInserts.length).toBe(2);
    expect(lineInserts[0].freightCostId).toBe(101);
    expect(lineInserts[0].lineTotalCents).toBe(50000);
    expect(lineInserts[0].description).toContain("freight");
    expect(lineInserts[1].freightCostId).toBe(102);
    expect(lineInserts[1].lineTotalCents).toBe(12000);

    // Result includes invoice data
    expect(result.id).toBe(999);
    expect(result.inboundShipmentId).toBe(1);
  });

  it("rejects with 400 when no candidate cost rows", async () => {
    mockSelectResults.results = [
      [{ shipmentNumber: "SHP-001", status: "delivered" }],
      [{ id: 42, name: "Freightos", paymentTermsDays: 30 }],
    ];

    mockTxExecute.mockResolvedValue({ rows: [] });

    await expect(
      createInvoiceFromShipmentCosts(1, {
        vendorId: 42,
        invoiceNumber: "INV-001",
      }),
    ).rejects.toThrow(ApLedgerError);
  });

  it("rejects with 404 when vendor not found", async () => {
    mockSelectResults.results = [
      [{ shipmentNumber: "SHP-001", status: "delivered" }],
      [], // No vendor found
    ];

    await expect(
      createInvoiceFromShipmentCosts(1, {
        vendorId: 999,
        invoiceNumber: "INV-001",
      }),
    ).rejects.toThrow("Vendor not found");
  });

  it("rejects with 400 when shipment is cancelled", async () => {
    mockSelectResults.results = [
      [{ shipmentNumber: "SHP-001", status: "cancelled" }],
    ];

    await expect(
      createInvoiceFromShipmentCosts(1, {
        vendorId: 42,
        invoiceNumber: "INV-001",
      }),
    ).rejects.toThrow("Cannot create invoice for a cancelled shipment");
  });

  it("rejects with 400 when invoice number is empty", async () => {
    mockSelectResults.results = [
      [{ shipmentNumber: "SHP-001", status: "delivered" }],
      [{ id: 42, name: "Freightos", paymentTermsDays: 30 }],
    ];

    await expect(
      createInvoiceFromShipmentCosts(1, {
        vendorId: 42,
        invoiceNumber: "",
      }),
    ).rejects.toThrow("Invoice number is required");
  });

  it("applies lineOverrides for variance scenarios", async () => {
    mockSelectResults.results = [
      [{ shipmentNumber: "SHP-001", status: "delivered" }],
      [{ id: 42, name: "Freightos", paymentTermsDays: 30 }],
    ];

    mockTxExecute.mockResolvedValue({
      rows: [
        {
          id: 101,
          cost_type: "freight",
          description: "Ocean freight",
          actual_cents: 50000,
          estimated_cents: 45000,
          performed_by_name: "ExFreight Zeta",
          vendor_id: 42,
          vendor_invoice_id: null,
          cost_status: "estimated",
        },
      ],
    });

    await createInvoiceFromShipmentCosts(1, {
      vendorId: 42,
      invoiceNumber: "INV-002",
      lineOverrides: [
        {
          freightCostId: 101,
          qtyInvoiced: 1,
          unitCostCents: 48000,
          description: "Freight: negotiated rate",
        },
      ],
    });

    const lineInserts = mockTxInsertValues.values.filter(
      (v) => v.vendorInvoiceId === 999,
    );
    expect(lineInserts.length).toBe(1);
    expect(lineInserts[0].unitCostCents).toBe(48000);
    expect(lineInserts[0].lineTotalCents).toBe(48000);
    expect(lineInserts[0].description).toBe("Freight: negotiated rate");
  });

  it("defense-in-depth: rejects with 409 when cost row already invoiced", async () => {
    mockSelectResults.results = [
      [{ shipmentNumber: "SHP-001", status: "delivered" }],
      [{ id: 42, name: "Freightos", paymentTermsDays: 30 }],
    ];

    mockTxExecute.mockResolvedValue({
      rows: [
        {
          id: 101,
          cost_type: "freight",
          actual_cents: 50000,
          estimated_cents: 45000,
          vendor_id: 42,
          vendor_invoice_id: 777,
          cost_status: "invoiced",
        },
      ],
    });

    try {
      await createInvoiceFromShipmentCosts(1, {
        vendorId: 42,
        invoiceNumber: "INV-003",
      });
      expect(true).toBe(false); // Should not reach here
    } catch (e: any) {
      expect(e).toBeInstanceOf(ApLedgerError);
      expect(e.statusCode).toBe(409);
    }
  });
});
