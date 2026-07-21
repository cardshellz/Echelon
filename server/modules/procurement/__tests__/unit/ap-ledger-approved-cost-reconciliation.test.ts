import { beforeEach, describe, expect, it, vi } from "vitest";

const tables = vi.hoisted(() => ({
  purchaseOrderLines: {
    id: "purchase_order_lines.id",
    purchaseOrderId: "purchase_order_lines.purchase_order_id",
    lineType: "purchase_order_lines.line_type",
    status: "purchase_order_lines.status",
    orderQty: "purchase_order_lines.order_qty",
    receivedQty: "purchase_order_lines.received_qty",
    unitCostCents: "purchase_order_lines.unit_cost_cents",
    unitCostMills: "purchase_order_lines.unit_cost_mills",
    expectedReceiveVariantId: "purchase_order_lines.expected_receive_variant_id",
    productVariantId: "purchase_order_lines.product_variant_id",
  },
  vendorInvoiceLines: {
    id: "vendor_invoice_lines.id",
    vendorInvoiceId: "vendor_invoice_lines.vendor_invoice_id",
    purchaseOrderLineId: "vendor_invoice_lines.purchase_order_line_id",
    productVariantId: "vendor_invoice_lines.product_variant_id",
    qtyInvoiced: "vendor_invoice_lines.qty_invoiced",
    unitCostCents: "vendor_invoice_lines.unit_cost_cents",
    unitCostMills: "vendor_invoice_lines.unit_cost_mills",
  },
  vendorInvoices: {
    id: "vendor_invoices.id",
    invoiceNumber: "vendor_invoices.invoice_number",
    status: "vendor_invoices.status",
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
  reconcileInvoiceVariance: vi.fn(),
}));

vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("@shared/schema", () => tables);
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
  and: vi.fn(),
  inArray: vi.fn((field: unknown, values: unknown[]) => ({ field, values })),
  sql: vi.fn(),
  desc: vi.fn(),
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
vi.mock("../../../inventory/cogs.service", () => ({
  COGSService: class {
    reconcileInvoiceVariance(...args: any[]) {
      return mocks.reconcileInvoiceVariance(...args);
    }
  },
}));

function selectChain(rows: unknown[]) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.for = vi.fn(() => Promise.resolve(rows));
  chain.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function clientFor(selectResults: unknown[][]) {
  const audits: unknown[] = [];
  return {
    select: vi.fn(() => selectChain(selectResults.shift() ?? [])),
    insert: vi.fn(() => ({
      values: vi.fn((row: unknown) => {
        audits.push(row);
        return Promise.resolve([]);
      }),
    })),
    audits,
  } as any;
}

const poLine = {
  id: 50,
  purchaseOrderId: 7,
  lineType: "product",
  status: "open",
  orderQty: 100,
  receivedQty: 0,
  unitCostCents: 5,
  unitCostMills: 500,
  expectedReceiveVariantId: 6,
  productVariantId: 5,
};

function invoiceLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 70,
    vendorInvoiceId: 12,
    productVariantId: 6,
    qtyInvoiced: 100,
    unitCostCents: 6,
    unitCostMills: 550,
    ...overrides,
  };
}

describe("approved invoice PO-line cost reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reconcileInvoiceVariance.mockResolvedValue({
      lotsUpdated: 1,
      cogsRowsUpdated: 2,
      totalCogsDeltaCents: 10,
    });
  });

  it("uses invoice actuals only with complete, single-cost approved coverage", async () => {
    const client = clientFor([
      [poLine],
      [invoiceLine()],
      [{ id: 12, invoiceNumber: "INV-001", status: "approved" }],
    ]);
    const { reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction } =
      await import("../../ap-ledger.service");

    const result = await reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction(
      50,
      client,
      "ops-user",
    );

    expect(result).toMatchObject({
      state: "invoice_actual",
      authoritativeUnitCostMills: 550,
      approvedInvoiceIds: [12],
      approvedQty: "100",
    });
    expect(mocks.reconcileInvoiceVariance).toHaveBeenCalledWith(expect.objectContaining({
      purchaseOrderId: 7,
      purchaseOrderLineId: 50,
      invoiceUnitCostMills: 550,
      costSource: "invoice",
    }), client);
  });

  it("keeps PO cost while approved invoice quantity is incomplete", async () => {
    const client = clientFor([
      [poLine],
      [invoiceLine({ qtyInvoiced: 40 })],
      [{ id: 12, invoiceNumber: "INV-001", status: "approved" }],
    ]);
    const { reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction } =
      await import("../../ap-ledger.service");

    const result = await reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction(50, client);

    expect(result).toMatchObject({
      state: "po_fallback_incomplete_invoice_quantity",
      authoritativeUnitCostMills: 500,
      approvedQty: "40",
    });
    expect(mocks.reconcileInvoiceVariance).toHaveBeenCalledWith(expect.objectContaining({
      invoiceUnitCostMills: 500,
      costSource: "po",
    }), client);
  });

  it("uses quantity-weighted invoice mills when complete approved lines have different prices", async () => {
    const client = clientFor([
      [poLine],
      [
        invoiceLine({ qtyInvoiced: 40, unitCostMills: 550 }),
        invoiceLine({ id: 71, vendorInvoiceId: 13, qtyInvoiced: 60, unitCostMills: 575 }),
      ],
      [
        { id: 12, invoiceNumber: "INV-001", status: "paid" },
        { id: 13, invoiceNumber: "INV-002", status: "approved" },
      ],
    ]);
    const { reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction } =
      await import("../../ap-ledger.service");

    const result = await reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction(50, client);

    expect(result).toMatchObject({
      state: "invoice_actual",
      authoritativeUnitCostMills: 565,
      approvedInvoiceIds: [12, 13],
      approvedQty: "100",
    });
    expect(mocks.reconcileInvoiceVariance).toHaveBeenCalledWith(expect.objectContaining({
      invoiceUnitCostMills: 565,
      costSource: "invoice",
    }), client);
  });

  it("uses final received pieces as cost coverage for a short-closed PO line", async () => {
    const client = clientFor([
      [{ ...poLine, status: "closed", receivedQty: 60 }],
      [invoiceLine({ qtyInvoiced: 60 })],
      [{ id: 12, invoiceNumber: "INV-SHORT", status: "approved" }],
    ]);
    const { reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction } =
      await import("../../ap-ledger.service");

    const result = await reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction(50, client);

    expect(result).toMatchObject({
      state: "invoice_actual",
      authoritativeUnitCostMills: 550,
      approvedQty: "60",
    });
  });

  it("ignores disputed and voided invoices when selecting actual cost", async () => {
    const client = clientFor([
      [poLine],
      [invoiceLine()],
      [{ id: 12, invoiceNumber: "INV-001", status: "voided" }],
    ]);
    const { reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction } =
      await import("../../ap-ledger.service");

    const result = await reconcileApprovedInvoiceVarianceForPurchaseOrderLineInTransaction(50, client);

    expect(result).toMatchObject({
      state: "po_fallback_no_approved_invoice",
      authoritativeUnitCostMills: 500,
      approvedInvoiceIds: [],
      approvedQty: "0",
    });
  });
});
