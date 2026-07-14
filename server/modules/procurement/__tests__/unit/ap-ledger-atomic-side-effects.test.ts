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
  chain.for = vi.fn(() => chain);
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
    execute: vi.fn(() => Promise.resolve()),
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
      [{ id: 12, vendorId: 4, status: "approved", balanceCents: 2500 }],
      [],
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
    expect(tx.execute).toHaveBeenCalledOnce();
    expect(tx.insert).toHaveBeenCalledWith(tables.apPaymentAllocations);
    expect(tx.update).toHaveBeenCalledWith(tables.vendorInvoices);
    expect(tx.update).toHaveBeenCalledWith(tables.purchaseOrders);
    expect(mocks.detectOverpaid).toHaveBeenCalledWith(7);
    expect(mocks.detectPastDue).toHaveBeenCalledWith(7);
  });

  it("locks allocated invoices and rejects cross-vendor payments before inserting cash movement", async () => {
    const { recordPayment } = await import("../../ap-ledger.service");
    const tx = buildTx([
      [{ id: 12, vendorId: 99, status: "approved", balanceCents: 2500 }],
    ]);
    mocks.db.transaction.mockImplementation(async (callback) => callback(tx));

    await expect(recordPayment({
      vendorId: 4,
      paymentDate: new Date("2026-05-18T12:00:00Z"),
      paymentMethod: "ach",
      totalAmountCents: 2500,
      allocations: [{ vendorInvoiceId: 12, appliedAmountCents: 2500 }],
      createdBy: "ops-user",
    })).rejects.toMatchObject({
      name: "ApLedgerError",
      statusCode: 422,
      details: { code: "AP_PAYMENT_ALLOCATION_VENDOR_MISMATCH" },
    });

    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("requires AP command audit persistence inside the caller-owned payment transaction", async () => {
    const { executeApPaymentCommandInTransaction } = await import("../../ap-ledger.service");
    const tx = buildTx([
      [{ id: 12, vendorId: 4, status: "approved", balanceCents: 2500 }],
      [],
      [{ total: 2500 }],
      [{ invoicedAmountCents: 2500, status: "approved" }],
      [{ purchaseOrderId: 7 }],
      [{ invoicedAmountCents: 2500, paidAmountCents: 2500 }],
      [{ financialStatus: "invoiced", firstInvoicedAt: new Date(), firstPaidAt: null, fullyPaidAt: null }],
    ]);
    const originalInsert = tx.insert;
    tx.insert = vi.fn((table) => {
      if (table === tables.auditEvents) {
        return { values: vi.fn(() => Promise.reject(new Error("audit unavailable"))) };
      }
      return originalInsert(table);
    });

    await expect(executeApPaymentCommandInTransaction("record_payment", {
      payment: {
        vendorId: 4,
        paymentDate: new Date("2026-05-18T12:00:00Z"),
        paymentMethod: "ach",
        totalAmountCents: 2500,
        allocations: [{ vendorInvoiceId: 12, appliedAmountCents: 2500 }],
        createdBy: "ops-user",
      },
    }, tx)).rejects.toThrow("audit unavailable");

    expect(tx.insert).toHaveBeenCalledWith(tables.apPayments);
    expect(tx.execute).toHaveBeenCalledOnce();
    expect(tx.insert).toHaveBeenCalledWith(tables.auditEvents);
  });

  it("keeps invoice transition, PO aggregates, and required audit in the caller-owned transaction", async () => {
    const { executeApInvoiceCommandInTransaction } = await import("../../ap-ledger.service");
    const tx = buildTx([
      [{ id: 12, status: "received", paidAmountCents: 0 }],
      [{ purchaseOrderId: 7 }],
      [{ invoicedAmountCents: 2500, paidAmountCents: 0 }],
      [{ financialStatus: "unbilled", firstInvoicedAt: null, firstPaidAt: null, fullyPaidAt: null }],
    ]);
    tx.update = vi.fn((table) => {
      if (table === tables.vendorInvoices) {
        return {
          set: vi.fn(() => ({
            where: vi.fn(() => ({
              returning: vi.fn(() => Promise.resolve([{ id: 12, status: "approved" }])),
            })),
          })),
        };
      }
      return makeUpdateChain();
    });
    const originalInsert = tx.insert;
    tx.insert = vi.fn((table) => {
      if (table === tables.auditEvents) {
        return { values: vi.fn(() => Promise.reject(new Error("invoice audit unavailable"))) };
      }
      return originalInsert(table);
    });

    await expect(executeApInvoiceCommandInTransaction("approve_invoice", {
      invoiceId: 12,
      userId: "ops-user",
    }, tx)).rejects.toThrow("invoice audit unavailable");

    expect(tx.update).toHaveBeenCalledWith(tables.vendorInvoices);
    expect(tx.update).toHaveBeenCalledWith(tables.purchaseOrders);
    expect(tx.insert).toHaveBeenCalledWith(tables.auditEvents);
  });

  it("returns operator-visible AP command outcome metadata", async () => {
    const { executeApPaymentCommandInTransaction } = await import("../../ap-ledger.service");
    const tx = buildTx([
      [{ id: 12, vendorId: 4, status: "approved", balanceCents: 2500 }],
      [],
      [{ total: 2500 }],
      [{ invoicedAmountCents: 2500, status: "approved" }],
      [{ purchaseOrderId: 7 }],
      [{ invoicedAmountCents: 2500, paidAmountCents: 2500 }],
      [{ financialStatus: "invoiced", firstInvoicedAt: new Date(), firstPaidAt: null, fullyPaidAt: null }],
    ]);
    const result = await executeApPaymentCommandInTransaction("record_payment", {
      payment: {
        vendorId: 4,
        paymentDate: new Date("2026-05-18T12:00:00Z"),
        paymentMethod: "ach",
        totalAmountCents: 2500,
        allocations: [{ vendorInvoiceId: 12, appliedAmountCents: 2500 }],
        createdBy: "ops-user",
      },
    }, tx);

    expect(result.apLedgerOutcome).toMatchObject({
      command: "record_payment",
      entityType: "payment",
      entityId: 21,
      affectedInvoiceIds: [12],
      affectedPaymentIds: [21],
      affectedPurchaseOrderIds: [7],
    });
    expect(tx.insert).toHaveBeenCalledWith(tables.auditEvents);
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
