import { beforeEach, describe, expect, it, vi } from "vitest";

const tables = vi.hoisted(() => ({
  apPayments: {
    id: "ap_payments.id",
    paymentNumber: "ap_payments.payment_number",
    vendorId: "ap_payments.vendor_id",
    paymentDate: "ap_payments.payment_date",
    paymentMethod: "ap_payments.payment_method",
    referenceNumber: "ap_payments.reference_number",
    checkNumber: "ap_payments.check_number",
    bankAccountLabel: "ap_payments.bank_account_label",
    totalAmountCents: "ap_payments.total_amount_cents",
    currency: "ap_payments.currency",
    status: "ap_payments.status",
    notes: "ap_payments.notes",
    createdBy: "ap_payments.created_by",
    updatedBy: "ap_payments.updated_by",
    updatedAt: "ap_payments.updated_at",
    voidedAt: "ap_payments.voided_at",
    voidedBy: "ap_payments.voided_by",
    voidReason: "ap_payments.void_reason",
  },
  apPaymentAllocations: {
    id: "ap_payment_allocations.id",
    apPaymentId: "ap_payment_allocations.ap_payment_id",
    vendorInvoiceId: "ap_payment_allocations.vendor_invoice_id",
    appliedAmountCents: "ap_payment_allocations.applied_amount_cents",
    notes: "ap_payment_allocations.notes",
  },
  vendorInvoices: {
    id: "vendor_invoices.id",
    vendorId: "vendor_invoices.vendor_id",
    invoiceNumber: "vendor_invoices.invoice_number",
    invoiceDate: "vendor_invoices.invoice_date",
    invoicedAmountCents: "vendor_invoices.invoiced_amount_cents",
    paidAmountCents: "vendor_invoices.paid_amount_cents",
    balanceCents: "vendor_invoices.balance_cents",
    status: "vendor_invoices.status",
    updatedAt: "vendor_invoices.updated_at",
  },
  vendorInvoicePoLinks: {
    id: "vendor_invoice_po_links.id",
    vendorInvoiceId: "vendor_invoice_po_links.vendor_invoice_id",
    purchaseOrderId: "vendor_invoice_po_links.purchase_order_id",
  },
  purchaseOrders: {
    id: "purchase_orders.id",
    financialStatus: "purchase_orders.financial_status",
    firstInvoicedAt: "purchase_orders.first_invoiced_at",
    firstPaidAt: "purchase_orders.first_paid_at",
    fullyPaidAt: "purchase_orders.fully_paid_at",
  },
  vendorInvoiceLines: { id: "vendor_invoice_lines.id" },
  vendorInvoiceAttachments: { id: "vendor_invoice_attachments.id" },
  purchaseOrderLines: { id: "purchase_order_lines.id" },
  vendors: { id: "vendors.id", name: "vendors.name", code: "vendors.code" },
  inboundFreightCosts: { id: "inbound_freight_costs.id" },
  inboundShipments: { id: "inbound_shipments.id" },
  auditEvents: {
    id: "audit_events.id",
    timestamp: "audit_events.timestamp",
    actor: "audit_events.actor",
    action: "audit_events.action",
    target: "audit_events.target",
    context: "audit_events.context",
  },
}));

const mocks = vi.hoisted(() => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    transaction: vi.fn(),
  },
  detectOverpaid: vi.fn(),
  detectPastDue: vi.fn(),
}));

vi.mock("../../../../db", () => ({ db: mocks.db }));
vi.mock("@shared/schema", () => tables);
vi.mock("../../po-exceptions.service", () => ({
  detectMatchMismatch: vi.fn(),
  detectOverpaid: mocks.detectOverpaid,
  detectPastDue: mocks.detectPastDue,
}));

function makeSelectChain(result: unknown[]) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(result));
  chain.offset = vi.fn(() => chain);
  chain.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

function makeUpdateChain() {
  const where = vi.fn(() => Promise.resolve([]));
  return {
    set: vi.fn(() => ({ where })),
  };
}

function buildTx(selectResults: unknown[][]) {
  const tx: any = {
    select: vi.fn(() => makeSelectChain(selectResults.shift() ?? [])),
    insert: vi.fn((table) => ({
      values: vi.fn(() => {
        if (table === tables.apPayments) {
          return {
            returning: vi.fn(() => Promise.resolve([{ id: 21, paymentNumber: "PAY-20260518-001" }])),
          };
        }
        return Promise.resolve([]);
      }),
    })),
    update: vi.fn(() => makeUpdateChain()),
  };
  return tx;
}

describe("AP ledger atomic side effects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detectOverpaid.mockResolvedValue(undefined);
    mocks.detectPastDue.mockResolvedValue(undefined);
    mocks.db.select.mockReturnValue(makeSelectChain([]));
    mocks.db.insert.mockReturnValue({ values: vi.fn(() => Promise.resolve([])) });
  });

  it("records payment, allocations, invoice balance, and PO aggregate inside one transaction", async () => {
    const { recordPayment } = await import("../../ap-ledger.service");
    const tx = buildTx([
      [{ total: 2500 }],
      [{ invoicedAmountCents: 2500, status: "approved" }],
      [{ purchaseOrderId: 7 }],
      [{ invoicedAmountCents: 2500, paidAmountCents: 2500 }],
      [{ financialStatus: "invoiced", firstInvoicedAt: new Date(), firstPaidAt: null, fullyPaidAt: null }],
    ]);
    mocks.db.transaction.mockImplementation(async (callback) => callback(tx));

    const payment = await recordPayment({
      vendorId: 4,
      paymentDate: new Date("2026-05-18T12:00:00Z"),
      paymentMethod: "ach",
      totalAmountCents: 2500,
      allocations: [{ vendorInvoiceId: 12, appliedAmountCents: 2500 }],
      createdBy: "ops-user",
    });

    expect(payment).toEqual({ id: 21, paymentNumber: "PAY-20260518-001" });
    expect(mocks.db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledWith(tables.apPayments);
    expect(tx.insert).toHaveBeenCalledWith(tables.apPaymentAllocations);
    expect(tx.update).toHaveBeenCalledWith(tables.vendorInvoices);
    expect(tx.update).toHaveBeenCalledWith(tables.purchaseOrders);
    expect(mocks.detectOverpaid).toHaveBeenCalledWith(7);
    expect(mocks.detectPastDue).toHaveBeenCalledWith(7);
  });

  it("returns operator-visible AP command outcome metadata", async () => {
    const { executeApLedgerCommand } = await import("../../ap-ledger.service");
    const tx = buildTx([
      [{ total: 2500 }],
      [{ invoicedAmountCents: 2500, status: "approved" }],
      [{ purchaseOrderId: 7 }],
      [{ invoicedAmountCents: 2500, paidAmountCents: 2500 }],
      [{ financialStatus: "invoiced", firstInvoicedAt: new Date(), firstPaidAt: null, fullyPaidAt: null }],
    ]);
    mocks.db.transaction.mockImplementation(async (callback) => callback(tx));
    mocks.db.select
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([{ purchaseOrderId: 7 }]));

    const result = await executeApLedgerCommand("record_payment", {
      payment: {
        vendorId: 4,
        paymentDate: new Date("2026-05-18T12:00:00Z"),
        paymentMethod: "ach",
        totalAmountCents: 2500,
        allocations: [{ vendorInvoiceId: 12, appliedAmountCents: 2500 }],
        createdBy: "ops-user",
      },
    });

    expect(result.apLedgerOutcome).toMatchObject({
      command: "record_payment",
      entityType: "payment",
      entityId: 21,
      affectedInvoiceIds: [12],
      affectedPaymentIds: [21],
      affectedPurchaseOrderIds: [7],
    });
    expect(mocks.db.insert).toHaveBeenCalledWith(tables.auditEvents);
  });

  it("does not fail a completed AP command when audit persistence fails", async () => {
    const { executeApLedgerCommand } = await import("../../ap-ledger.service");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const tx = buildTx([
      [{ total: 2500 }],
      [{ invoicedAmountCents: 2500, status: "approved" }],
      [{ purchaseOrderId: 7 }],
      [{ invoicedAmountCents: 2500, paidAmountCents: 2500 }],
      [{ financialStatus: "invoiced", firstInvoicedAt: new Date(), firstPaidAt: null, fullyPaidAt: null }],
    ]);
    mocks.db.transaction.mockImplementation(async (callback) => callback(tx));
    mocks.db.select
      .mockReturnValueOnce(makeSelectChain([]))
      .mockReturnValueOnce(makeSelectChain([{ purchaseOrderId: 7 }]));
    mocks.db.insert.mockReturnValueOnce({
      values: vi.fn(() => Promise.reject(new Error('relation "audit_events" does not exist'))),
    });

    const result = await executeApLedgerCommand("record_payment", {
      payment: {
        vendorId: 4,
        paymentDate: new Date("2026-05-18T12:00:00Z"),
        paymentMethod: "ach",
        totalAmountCents: 2500,
        allocations: [{ vendorInvoiceId: 12, appliedAmountCents: 2500 }],
        createdBy: "ops-user",
      },
    });

    expect(result.apLedgerOutcome).toMatchObject({
      command: "record_payment",
      entityType: "payment",
      entityId: 21,
    });
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("[AP Ledger Audit] Failed to persist audit event for record_payment"),
    );

    consoleError.mockRestore();
  });

  it("voids payment, reverses invoice balance, and recomputes PO aggregate inside one transaction", async () => {
    const { voidPayment } = await import("../../ap-ledger.service");
    const tx = buildTx([
      [{ id: 21, status: "completed" }],
      [{ vendorInvoiceId: 12 }],
      [{ total: 0 }],
      [{ invoicedAmountCents: 2500, status: "paid" }],
      [{ purchaseOrderId: 7 }],
      [{ invoicedAmountCents: 2500, paidAmountCents: 0 }],
      [{ financialStatus: "paid", firstInvoicedAt: new Date(), firstPaidAt: new Date(), fullyPaidAt: new Date() }],
    ]);
    mocks.db.transaction.mockImplementation(async (callback) => callback(tx));

    await voidPayment(21, "duplicate", "ops-user");

    expect(mocks.db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledWith(tables.apPayments);
    expect(tx.update).toHaveBeenCalledWith(tables.vendorInvoices);
    expect(tx.update).toHaveBeenCalledWith(tables.purchaseOrders);
    expect(mocks.detectOverpaid).toHaveBeenCalledWith(7);
    expect(mocks.detectPastDue).toHaveBeenCalledWith(7);
  });
});
