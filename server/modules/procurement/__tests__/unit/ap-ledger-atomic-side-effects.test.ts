import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoFinancialEvidenceInput } from "../../domain/po-financial-evidence";

// These orchestration fixtures contain ordinary goods invoices. PostgreSQL
// shipment-billing-ownership tests exercise the real capability read and rejection.
vi.mock("../../shipment-billing-ownership.repository", () => ({
  readInvoiceSourceCapabilities: vi.fn(async () => {
    const verified = { allowed: true, code: "AP_INVOICE_SOURCE_VERIFIED", reason: "Fixture has ordinary invoice source ownership." };
    return { purchaseOrderLinks: verified, approval: verified, payment: verified, freightSourceLineIds: [] };
  }),
}));

// These owner fixtures isolate financial state changes. The real PostgreSQL
// cost suites verify the shared graph lock and its transaction ordering.
vi.mock("../../../inventory/infrastructure/cost-evidence.repository", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../inventory/infrastructure/cost-evidence.repository")>(),
  lockInventoryCostGraph: vi.fn(async () => undefined),
}));

// These financial orchestration fixtures supply current approval evidence. The
// real PostgreSQL command suite covers inactive actors and revocation while queued.
vi.mock("../../../identity/infrastructure/command-authority.repository", () => ({
  readCommandAuthorityActor: vi.fn(async (_tx, userId: string) => ({ userId, active: true,
    permissions: ["purchasing:approve"], scopedPermissions: [] })),
}));

// Number allocation is exercised with real PostgreSQL in the payment acceptance suite.
// This orchestration fixture keeps allocation independent of balance-read ordering.
vi.mock("../../../../platform/document-numbering/document-number.repository", () => ({
  allocateDocumentNumber: vi.fn(async () => "PAY-20260518-001"),
  readSuggestedInvoiceNumber: vi.fn(),
}));

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
    creditedAmountCents: "vendor_invoices.credited_amount_cents",
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
    status: "purchase_orders.status",
    financialStatus: "purchase_orders.financial_status",
    firstInvoicedAt: "purchase_orders.first_invoiced_at",
    firstPaidAt: "purchase_orders.first_paid_at",
    fullyPaidAt: "purchase_orders.fully_paid_at",
  },
  poStatusHistory: { id: "po_status_history.id" },
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
  readPoFinancialEvidenceSourcesWithClient: vi.fn(),
  detectFinancialExceptions: vi.fn(),
  reconcilePurchaseCostEvidence: vi.fn(),
}));

vi.mock("../../../../db", () => ({ db: mocks.db }));
// Supply source evidence while retaining the actual financial workflow and
// milestone evaluators. The adapter is exercised against PostgreSQL separately.
vi.mock("../../po-financial-evidence.repository", () => ({
  readPoFinancialEvidenceSourcesWithClient: mocks.readPoFinancialEvidenceSourcesWithClient,
}));
vi.mock("@shared/schema", () => tables);
vi.mock("../../po-exceptions.service", () => ({
  detectMatchMismatch: vi.fn(),
  detectFinancialExceptions: mocks.detectFinancialExceptions,
}));
vi.mock("../../../inventory/cogs.service", () => ({ COGSService: class {} }));
vi.mock("../../purchase-cost-application.service", () => ({
  reconcilePurchaseCostEvidence: mocks.reconcilePurchaseCostEvidence,
}));

function financialSource(paid = 0, status = paid === 2500 ? "paid" : "approved", paymentStatus = "completed"): PoFinancialEvidenceInput {
  return {
    purchaseOrderId: 7, vendorId: 4, currency: "USD",
    invoices: [{
      id: 12, vendorId: 4, currency: "USD", status,
      invoicedAmountCents: 2500, paidAmountCents: paid, balanceCents: 2500 - paid,
      links: [{ purchaseOrderId: 7, purchaseOrderVendorId: 4, purchaseOrderCurrency: "USD" }],
      lines: [{ id: 70, purchaseOrderLineId: 50, purchaseOrderId: 7, freightCostId: null, lineTotalCents: 2500 }],
      payments: paid > 0 || paymentStatus === "voided" ? [{ allocationId: 31, paymentId: 21,
        paymentVendorId: 4, paymentCurrency: "USD", paymentStatus, appliedAmountCents: 2500 }] : [],
    }],
  };
}

function useFinancialSource(source: PoFinancialEvidenceInput) {
  mocks.readPoFinancialEvidenceSourcesWithClient.mockResolvedValue(new Map([[source.purchaseOrderId, source]]));
}

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

function buildTx(selectResults: unknown[][], returnedPayment = { id: 21, paymentNumber: "PAY-20260518-001" } as Record<string, unknown>) {
  const tx: any = {
    select: vi.fn((projection) => {
      // This suite's ordinary invoice fixtures have no previous cash allocations.
      // The real PostgreSQL credit/payment suite verifies the settlement reader.
      if (projection?.payment === tables.apPayments && projection?.amount === tables.apPaymentAllocations.appliedAmountCents) {
        return makeSelectChain([]);
      }
      const rows = (selectResults.shift() ?? []).map((value) => {
        if (!value || typeof value !== "object") return value;
        const row = value as Record<string, unknown>;
        const isInvoiceProjection = "invoicedAmountCents" in row || "paidAmountCents" in row || "balanceCents" in row;
        return isInvoiceProjection ? { id: 12, vendorId: 4, currency: "USD", status: "approved",
          invoicedAmountCents: 2500, paidAmountCents: 0, creditedAmountCents: 0, balanceCents: 2500, ...row } : row;
      });
      return makeSelectChain(rows);
    }),
    // No credit documents or applications exist in these orchestration fixtures.
    execute: vi.fn(async () => ({ rows: [] })),
    insert: vi.fn((table) => ({
      values: vi.fn(() => {
        if (table === tables.apPayments) {
          return {
            returning: vi.fn(() => Promise.resolve([returnedPayment])),
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
    useFinancialSource(financialSource());
    mocks.detectFinancialExceptions.mockResolvedValue(undefined);
    mocks.reconcilePurchaseCostEvidence.mockResolvedValue({
      lotsUpdated: 0,
      cogsRowsUpdated: 0,
      totalCogsDeltaCents: 0, costApplications: [],
    });
    mocks.db.select.mockReturnValue(makeSelectChain([]));
    mocks.db.insert.mockReturnValue({ values: vi.fn(() => Promise.resolve([])) });
  });

  it.each(["record_payment", "apply_payment", "void_payment"] as const)("rejects a missing/invalid %s clock before any database operation", async (command) => {
    const { executeApPaymentCommandInTransaction } = await import("../../ap-ledger.service");
    const { lockInventoryCostGraph } = await import("../../../inventory/infrastructure/cost-evidence.repository");
    const tx = buildTx([]);
    for (const now of [undefined, null, new Date("invalid"), "2026-10-25"]) {
      await expect(executeApPaymentCommandInTransaction(command, { now: now as Date, userId: "ops-user" }, tx))
        .rejects.toMatchObject({ statusCode: 500, details: { code: "AP_PAYMENT_CLOCK_INVALID" } });
    }
    expect(lockInventoryCostGraph).not.toHaveBeenCalled();
    expect(tx.execute).not.toHaveBeenCalled();
    expect(tx.select).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("records payment, allocations, invoice balance, and PO aggregate inside one transaction", async () => {
    useFinancialSource(financialSource(2500));
    const { recordPayment } = await import("../../ap-ledger.service");
    const tx = buildTx([
      [{ id: 12, vendorId: 4, status: "approved", balanceCents: 2500 }],
      [{ invoicedAmountCents: 2500, status: "approved" }],
      [{ total: 2500 }],
      [{ purchaseOrderId: 7 }],
      [{ status: "received", financialStatus: "invoiced", firstInvoicedAt: new Date(), firstPaidAt: null, fullyPaidAt: null }],
      [{ invoicedAmountCents: 2500, paidAmountCents: 2500, status: "paid" }],
    ]);
    mocks.db.transaction.mockImplementation(async (callback) => callback(tx));

    const payment = await recordPayment({
      vendorId: 4,
      paymentDate: new Date("2026-05-18T12:00:00Z"),
      paymentMethod: "ach",
      totalAmountCents: 2500,
      allocations: [{ vendorInvoiceId: 12, appliedAmountCents: 2500 }],
      createdBy: "ops-user",
    }, { now: new Date("2026-10-25T12:00:00.000Z") });

    expect(payment).toEqual({ id: 21, paymentNumber: "PAY-20260518-001" });
    expect(mocks.db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledWith(tables.apPayments);
    // Allocation is isolated above; both credit-evidence reads still use this transaction.
    expect(tx.execute).toHaveBeenCalledTimes(2);
    expect(tx.insert).toHaveBeenCalledWith(tables.apPaymentAllocations);
    const paymentWrite = tx.insert.mock.results[tx.insert.mock.calls.findIndex(([table]: [unknown]) => table === tables.apPayments)].value;
    const allocationWrite = tx.insert.mock.results[tx.insert.mock.calls.findIndex(([table]: [unknown]) => table === tables.apPaymentAllocations)].value;
    expect(paymentWrite.values).toHaveBeenCalledWith(expect.objectContaining({ createdAt: new Date("2026-10-25T12:00:00.000Z"), updatedAt: new Date("2026-10-25T12:00:00.000Z") }));
    expect(allocationWrite.values).toHaveBeenCalledWith([expect.objectContaining({ createdAt: new Date("2026-10-25T12:00:00.000Z") })]);
    for (const result of tx.update.mock.results) expect(result.value.set).toHaveBeenCalledWith(expect.objectContaining({ updatedAt: new Date("2026-10-25T12:00:00.000Z") }));
    const historyWrite = tx.insert.mock.results[tx.insert.mock.calls.findIndex(([table]: [unknown]) => table === tables.poStatusHistory)].value;
    expect(historyWrite.values).toHaveBeenCalledWith(expect.objectContaining({ changedAt: new Date("2026-10-25T12:00:00.000Z") }));
    expect(tx.update).toHaveBeenCalledWith(tables.vendorInvoices);
    expect(tx.update).toHaveBeenCalledWith(tables.purchaseOrders);
    expect(mocks.detectFinancialExceptions).toHaveBeenCalledWith(7);
  });

  it("locks the PO and writes financial transition history in the aggregate transaction", async () => {
    const { recomputePoFinancialAggregates } = await import("../../ap-ledger.service");
    const tx = buildTx([
      [{
        status: "received",
        financialStatus: "unbilled",
        firstInvoicedAt: null,
        firstPaidAt: null,
        fullyPaidAt: null,
      }],
      [{ invoicedAmountCents: 2500, paidAmountCents: 0 }],
    ]);

    await recomputePoFinancialAggregates(7, {
      client: tx,
      runDetection: false,
      actorId: "ops-user",
      reason: "Vendor invoice 12 approved.",
      now: new Date("2026-05-18T12:00:00.000Z"),
    } as any);

    expect(tx.update).toHaveBeenCalledWith(tables.purchaseOrders);
    expect(mocks.readPoFinancialEvidenceSourcesWithClient).toHaveBeenCalledWith(tx, [7]);
    expect(tx.insert).toHaveBeenCalledWith(tables.poStatusHistory);
    const historyInsert = tx.insert.mock.results.find(
      (result: any, index: number) => tx.insert.mock.calls[index][0] === tables.poStatusHistory,
    )?.value;
    expect(historyInsert.values).toHaveBeenCalledWith({
      purchaseOrderId: 7,
      fromStatus: "received",
      toStatus: "received",
      changedBy: "ops-user",
      changedAt: new Date("2026-05-18T12:00:00.000Z"),
      notes: "Financial status: unbilled -> invoiced. Vendor invoice 12 approved.",
    });
  });

  it("does not write duplicate history when aggregate recomputation leaves status unchanged", async () => {
    const { recomputePoFinancialAggregates } = await import("../../ap-ledger.service");
    const tx = buildTx([
      [{
        status: "received",
        financialStatus: "invoiced",
        firstInvoicedAt: new Date("2026-05-17T12:00:00.000Z"),
        firstPaidAt: null,
        fullyPaidAt: null,
      }],
      [{ invoicedAmountCents: 2500, paidAmountCents: 0 }],
    ]);

    await recomputePoFinancialAggregates(7, { client: tx, runDetection: false } as any);

    expect(tx.update).toHaveBeenCalledWith(tables.purchaseOrders);
    expect(tx.insert).not.toHaveBeenCalledWith(tables.poStatusHistory);
  });

  it("derives disputed PO state from an active disputed invoice", async () => {
    useFinancialSource(financialSource(0, "disputed"));
    const { recomputePoFinancialAggregates } = await import("../../ap-ledger.service");
    const tx = buildTx([
      [{
        status: "received",
        financialStatus: "invoiced",
        firstInvoicedAt: new Date("2026-05-17T12:00:00.000Z"),
        firstPaidAt: null,
        fullyPaidAt: null,
      }],
      [{ invoicedAmountCents: 2500, paidAmountCents: 0, status: "disputed" }],
    ]);

    await recomputePoFinancialAggregates(7, {
      client: tx,
      runDetection: false,
      actorId: "ops-user",
      reason: "Vendor invoice 12 disputed.",
    } as any);

    const poUpdate = tx.update.mock.results.find(
      (_result: any, index: number) => tx.update.mock.calls[index][0] === tables.purchaseOrders,
    )?.value;
    expect(poUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      financialStatus: "disputed",
    }));
    expect(tx.insert).toHaveBeenCalledWith(tables.poStatusHistory);
  });

  it("resolves disputed PO state when the invoice resolution command removes the dispute", async () => {
    const { recomputePoFinancialAggregates } = await import("../../ap-ledger.service");
    const tx = buildTx([
      [{
        status: "received",
        financialStatus: "disputed",
        firstInvoicedAt: new Date("2026-05-17T12:00:00.000Z"),
        firstPaidAt: null,
        fullyPaidAt: null,
      }],
      [{ invoicedAmountCents: 2500, paidAmountCents: 0, status: "approved" }],
    ]);

    await recomputePoFinancialAggregates(7, {
      client: tx,
      runDetection: false,
      resolveDispute: true,
      actorId: "ops-user",
      reason: "Vendor invoice 12 approved.",
    } as any);

    const poUpdate = tx.update.mock.results.find(
      (_result: any, index: number) => tx.update.mock.calls[index][0] === tables.purchaseOrders,
    )?.value;
    expect(poUpdate.set).toHaveBeenCalledWith(expect.objectContaining({
      financialStatus: "invoiced",
    }));
    expect(tx.insert).toHaveBeenCalledWith(tables.poStatusHistory);
  });

  it("fails the aggregate command when required financial transition history cannot persist", async () => {
    const { recomputePoFinancialAggregates } = await import("../../ap-ledger.service");
    const tx = buildTx([
      [{
        status: "received",
        financialStatus: "unbilled",
        firstInvoicedAt: null,
        firstPaidAt: null,
        fullyPaidAt: null,
      }],
      [{ invoicedAmountCents: 2500, paidAmountCents: 0 }],
    ]);
    const originalInsert = tx.insert;
    tx.insert = vi.fn((table) => {
      if (table === tables.poStatusHistory) {
        return { values: vi.fn(() => Promise.reject(new Error("history unavailable"))) };
      }
      return originalInsert(table);
    });

    await expect(recomputePoFinancialAggregates(7, {
      client: tx,
      runDetection: false,
    } as any)).rejects.toThrow("history unavailable");

    expect(tx.update).toHaveBeenCalledWith(tables.purchaseOrders);
    expect(tx.insert).toHaveBeenCalledWith(tables.poStatusHistory);
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

  it("rejects unsafe invoice balance values before inserting cash movement", async () => {
    const { recordPayment } = await import("../../ap-ledger.service");
    const tx = buildTx([[
      {
        id: 12,
        vendorId: 4,
        status: "approved",
        balanceCents: Number.MAX_SAFE_INTEGER + 1,
      },
    ]]);
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
      statusCode: 500,
      details: {
        code: "AP_DATABASE_MONEY_INVALID",
        field: "invoice[12].balanceCents",
      },
    });

    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("rejects unsafe paid totals before updating an invoice total", async () => {
    const { updateInvoice } = await import("../../ap-ledger.service");
    const tx = buildTx([
      [{
        id: 12,
        vendorId: 4,
        status: "received",
        paidAmountCents: Number.MAX_SAFE_INTEGER + 1,
      }],
      [{ count: 0 }],
    ]);
    mocks.db.transaction.mockImplementation(async (callback) => callback(tx));

    await expect(updateInvoice(12, {
      invoicedAmountCents: 2500,
    }, "ops-user")).rejects.toMatchObject({
      name: "ApLedgerError",
      statusCode: 409,
      details: {
        code: "AP_INVOICE_SOURCE_REVIEW_REQUIRED",
      },
    });

    expect(tx.update).not.toHaveBeenCalled();
  });

  it("requires AP command audit persistence inside the caller-owned payment transaction", async () => {
    useFinancialSource(financialSource(2500));
    const { executeApPaymentCommandInTransaction } = await import("../../ap-ledger.service");
    const tx = buildTx([
      [{ id: 12, vendorId: 4, status: "approved", balanceCents: 2500 }],
      [{ invoicedAmountCents: 2500, status: "approved" }],
      [{ total: 2500 }],
      [{ purchaseOrderId: 7 }],
      [{ status: "received", financialStatus: "invoiced", firstInvoicedAt: new Date(), firstPaidAt: null, fullyPaidAt: null }],
      [{ invoicedAmountCents: 2500, paidAmountCents: 2500, status: "paid" }],
    ]);
    const originalInsert = tx.insert;
    tx.insert = vi.fn((table) => {
      if (table === tables.auditEvents) {
        return { values: vi.fn(() => Promise.reject(new Error("audit unavailable"))) };
      }
      return originalInsert(table);
    });

    await expect(executeApPaymentCommandInTransaction("record_payment", { now: new Date("2026-10-25T12:00:00.000Z"),
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
    // Allocation is isolated above; both credit-evidence reads still use this transaction.
    expect(tx.execute).toHaveBeenCalledTimes(2);
    expect(tx.insert).toHaveBeenCalledWith(tables.auditEvents);
  });

  it("keeps invoice transition, PO aggregates, and required audit in the caller-owned transaction", async () => {
    const { executeApInvoiceCommandInTransaction } = await import("../../ap-ledger.service");
    const tx = buildTx([
      [{ id: 12, status: "received", paidAmountCents: 0 }],
      [{ purchaseOrderId: 7 }],
      [{ status: "received", financialStatus: "unbilled", firstInvoicedAt: null, firstPaidAt: null, fullyPaidAt: null }],
      [{ invoicedAmountCents: 2500, paidAmountCents: 0, status: "approved" }],
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

  it("rejects invoice approval before success audit when COGS reconciliation fails", async () => {
    const { executeApInvoiceCommandInTransaction } = await import("../../ap-ledger.service");
    const tx = buildTx([
      [{ id: 12, status: "received", paidAmountCents: 0 }],
      [{ purchaseOrderId: 7 }],
      [{
        status: "received",
        financialStatus: "unbilled",
        firstInvoicedAt: null,
        firstPaidAt: null,
        fullyPaidAt: null,
      }],
      [{ invoicedAmountCents: 2500, paidAmountCents: 0, status: "approved" }],
      [{
        purchaseOrderLineId: 50,
        productVariantId: 6,
        qtyInvoiced: 1,
        matchStatus: "price_discrepancy",
        unitCostCents: 551,
        unitCostMills: 55055,
      }],
      [{
        id: 50,
        purchaseOrderId: 7,
        lineType: "product",
        status: "open",
        orderQty: 1,
        receivedQty: 0,
        unitCostCents: 500,
        unitCostMills: 50000,
        expectedReceiveVariantId: 6,
        productVariantId: 6,
      }],
      [{
        id: 70,
        vendorInvoiceId: 12,
        productVariantId: 6,
        qtyInvoiced: 1,
        unitCostCents: 551,
        unitCostMills: 55055,
      }],
      [{ id: 12, invoiceNumber: "INV-001", status: "approved" }],
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
    mocks.reconcilePurchaseCostEvidence.mockRejectedValueOnce(new Error("COGS write failed"));

    await expect(executeApInvoiceCommandInTransaction("approve_invoice", {
      invoiceId: 12,
      userId: "ops-user",
    }, tx)).rejects.toThrow("COGS write failed");

    expect(mocks.reconcilePurchaseCostEvidence).toHaveBeenCalledWith(tx, 50, expect.any(Object), "ops-user", expect.any(Date));
    expect(tx.insert).not.toHaveBeenCalledWith(tables.auditEvents);
  });

  it("persists invoice attachment metadata and audit in one transaction", async () => {
    const { addAttachment } = await import("../../ap-ledger.service");
    const tx = buildTx([[{ id: 12 }]]);
    const originalInsert = tx.insert;
    tx.insert = vi.fn((table) => {
      if (table === tables.vendorInvoiceAttachments) {
        return {
          values: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([{
              id: 44,
              vendorInvoiceId: 12,
              fileName: "invoice.pdf",
            }])),
          })),
        };
      }
      return originalInsert(table);
    });
    mocks.db.transaction.mockImplementation(async (callback) => callback(tx));

    const attachment = await addAttachment(12, {
      fileName: "invoice.pdf",
      fileType: "application/pdf",
      fileSizeBytes: 2048,
      filePath: "uploads/invoices/12/invoice.pdf",
      uploadedBy: "ops-user",
    });

    expect(attachment.id).toBe(44);
    expect(mocks.db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledWith(tables.vendorInvoiceAttachments);
    expect(tx.insert).toHaveBeenCalledWith(tables.auditEvents);
  });

  it("returns operator-visible AP command outcome metadata", async () => {
    useFinancialSource(financialSource(2500));
    const { executeApPaymentCommandInTransaction } = await import("../../ap-ledger.service");
    const tx = buildTx([
      [{ id: 12, vendorId: 4, status: "approved", balanceCents: 2500 }],
      [{ invoicedAmountCents: 2500, status: "approved" }],
      [{ total: 2500 }],
      [{ purchaseOrderId: 7 }],
      [{ status: "received", financialStatus: "invoiced", firstInvoicedAt: new Date(), firstPaidAt: null, fullyPaidAt: null }],
      [{ invoicedAmountCents: 2500, paidAmountCents: 2500, status: "paid" }],
      [{ allocationId: 31, vendorInvoiceId: 12, appliedAmountCents: 2500 }],
      [{ id: 31, apPaymentId: 21, vendorInvoiceId: 12, appliedAmountCents: 2500, invoiceVendorId: 4, invoiceCurrency: "USD", invoiceStatus: "paid" }],
    ], { id: 21, paymentNumber: "PAY-20260518-001", vendorId: 4, currency: "USD", status: "completed", totalAmountCents: 2500, paymentCalendarDate: null });
    const result = await executeApPaymentCommandInTransaction("record_payment", { now: new Date("2026-10-25T12:00:00.000Z"),
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
    expect(result).toMatchObject({ applications: [{ allocationId: 31, vendorInvoiceId: 12, appliedAmountCents: 2500 }],
      paymentBalance: { state: "fully_applied", appliedAmountCents: 2500, unappliedAmountCents: 0 } });
    expect(tx.insert).toHaveBeenCalledWith(tables.auditEvents);
  });

  it("voids payment, reverses invoice balance, and recomputes PO aggregate inside one transaction", async () => {
    useFinancialSource(financialSource(0, "approved", "voided"));
    const { voidPayment } = await import("../../ap-ledger.service");
    const tx = buildTx([
      [{ id: 21, status: "completed" }],
      [{ vendorInvoiceId: 12 }],
      [{ invoicedAmountCents: 2500, status: "paid" }],
      [{ total: 0 }],
      [{ purchaseOrderId: 7 }],
      [{ status: "received", financialStatus: "paid", firstInvoicedAt: new Date(), firstPaidAt: new Date(), fullyPaidAt: new Date() }],
      [{ invoicedAmountCents: 2500, paidAmountCents: 0, status: "approved" }],
    ]);
    mocks.db.transaction.mockImplementation(async (callback) => callback(tx));

    await voidPayment(21, "duplicate", "ops-user", { now: new Date("2026-10-25T12:00:00.000Z") });
    for (const result of tx.update.mock.results) expect(result.value.set).toHaveBeenCalledWith(expect.objectContaining({ updatedAt: new Date("2026-10-25T12:00:00.000Z") }));
    expect(tx.update.mock.results[0].value.set).toHaveBeenCalledWith(expect.objectContaining({ voidedAt: new Date("2026-10-25T12:00:00.000Z") }));

    expect(mocks.db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledWith(tables.apPayments);
    expect(tx.update).toHaveBeenCalledWith(tables.vendorInvoices);
    expect(tx.update).toHaveBeenCalledWith(tables.purchaseOrders);
    expect(mocks.detectFinancialExceptions).toHaveBeenCalledWith(7);
  });
});
