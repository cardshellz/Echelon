import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock("../../../../db", () => ({ db: mocks.db }));
vi.mock("@shared/schema", () => ({
  apPaymentAllocations: {},
  apPayments: {},
  auditEvents: {},
  inboundFreightCosts: {},
  inboundShipments: {},
  poStatusHistory: {},
  purchaseOrderLines: {},
  purchaseOrders: {},
  vendorInvoiceAttachments: {},
  vendorInvoiceLines: {},
  vendorInvoicePoLinks: {},
  vendorInvoices: {},
  vendors: {},
}));
vi.mock("../../po-exceptions.service", () => ({
  detectMatchMismatch: vi.fn(),
  detectOverpaid: vi.fn(),
  detectPastDue: vi.fn(),
}));

describe("AP invoice editing boundary validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unsupported invoice-create fields before opening a transaction", async () => {
    const { createInvoice } = await import("../../ap-ledger.service");

    await expect(createInvoice({
      invoiceNumber: "INV-100",
      vendorId: 4,
      status: "paid",
    } as any)).rejects.toMatchObject({
      name: "ApLedgerError",
      statusCode: 400,
      details: {
        code: "AP_INPUT_FIELDS_UNSUPPORTED",
        unexpectedFields: ["status"],
      },
    });
    expect(mocks.db.transaction).not.toHaveBeenCalled();
  });

  it("rejects fractional invoice money before opening a transaction", async () => {
    const { createInvoice } = await import("../../ap-ledger.service");

    await expect(createInvoice({
      invoiceNumber: "INV-100",
      vendorId: 4,
      invoicedAmountCents: 125.5,
    })).rejects.toMatchObject({
      name: "ApLedgerError",
      statusCode: 400,
      details: { code: "AP_INPUT_NONNEGATIVE_INTEGER_REQUIRED" },
    });
    expect(mocks.db.transaction).not.toHaveBeenCalled();
  });

  it("rejects non-USD invoices until an FX authority exists", async () => {
    const { createInvoice } = await import("../../ap-ledger.service");

    await expect(createInvoice({
      invoiceNumber: "INV-EUR-100",
      vendorId: 4,
      currency: "EUR",
    })).rejects.toMatchObject({
      name: "ApLedgerError",
      statusCode: 422,
      details: {
        code: "AP_FX_RATE_REQUIRED",
        currency: "EUR",
        reportingCurrency: "USD",
      },
    });
    expect(mocks.db.transaction).not.toHaveBeenCalled();
  });

  it("rejects non-USD payments before opening a transaction", async () => {
    const { recordPayment } = await import("../../ap-ledger.service");

    await expect(recordPayment({
      vendorId: 4,
      paymentDate: new Date("2026-07-20T12:00:00.000Z"),
      paymentMethod: "wire",
      totalAmountCents: 1_000,
      currency: "EUR",
      allocations: [],
    })).rejects.toMatchObject({
      name: "ApLedgerError",
      statusCode: 422,
      details: {
        code: "AP_FX_RATE_REQUIRED",
        currency: "EUR",
        reportingCurrency: "USD",
      },
    });
    expect(mocks.db.transaction).not.toHaveBeenCalled();
  });

  it("rejects conflicting cent and mill line costs before opening a transaction", async () => {
    const { addInvoiceLine } = await import("../../ap-ledger.service");

    await expect(addInvoiceLine(12, {
      qtyInvoiced: 5,
      unitCostCents: 1,
      unitCostMills: 250,
    })).rejects.toMatchObject({
      name: "ApLedgerError",
      statusCode: 400,
      details: { code: "AP_UNIT_COST_PRECISION_MISMATCH" },
    });
    expect(mocks.db.transaction).not.toHaveBeenCalled();
  });

  it("rejects arbitrary invoice-line patch fields before opening a transaction", async () => {
    const { updateInvoiceLine } = await import("../../ap-ledger.service");

    await expect(updateInvoiceLine(33, {
      qtyInvoiced: 5,
      vendorInvoiceId: 999,
    } as any)).rejects.toMatchObject({
      name: "ApLedgerError",
      statusCode: 400,
      details: {
        code: "AP_INPUT_FIELDS_UNSUPPORTED",
        unexpectedFields: ["vendorInvoiceId"],
      },
    });
    expect(mocks.db.transaction).not.toHaveBeenCalled();
  });

  it("rejects negative PO allocation money before opening a transaction", async () => {
    const { linkPoToInvoice } = await import("../../ap-ledger.service");

    await expect(linkPoToInvoice(12, 55, -1)).rejects.toMatchObject({
      name: "ApLedgerError",
      statusCode: 400,
      details: { code: "AP_INPUT_NONNEGATIVE_INTEGER_REQUIRED" },
    });
    expect(mocks.db.transaction).not.toHaveBeenCalled();
  });
});
