import { beforeEach, describe, expect, it, vi } from "vitest";

const tables = vi.hoisted(() => ({
  purchaseOrderLines: {
    id: "purchase_order_lines.id",
    purchaseOrderId: "purchase_order_lines.purchase_order_id",
    lineNumber: "purchase_order_lines.line_number",
  },
  purchaseOrders: {
    id: "purchase_orders.id",
    vendorId: "purchase_orders.vendor_id",
    status: "purchase_orders.status",
    financialStatus: "purchase_orders.financial_status",
    firstInvoicedAt: "purchase_orders.first_invoiced_at",
    firstPaidAt: "purchase_orders.first_paid_at",
    fullyPaidAt: "purchase_orders.fully_paid_at",
  },
  vendorInvoiceLines: {
    id: "vendor_invoice_lines.id",
    vendorInvoiceId: "vendor_invoice_lines.vendor_invoice_id",
    purchaseOrderLineId: "vendor_invoice_lines.purchase_order_line_id",
    productVariantId: "vendor_invoice_lines.product_variant_id",
    lineNumber: "vendor_invoice_lines.line_number",
    sku: "vendor_invoice_lines.sku",
    productName: "vendor_invoice_lines.product_name",
    description: "vendor_invoice_lines.description",
    qtyInvoiced: "vendor_invoice_lines.qty_invoiced",
    qtyOrdered: "vendor_invoice_lines.qty_ordered",
    qtyReceived: "vendor_invoice_lines.qty_received",
    unitCostCents: "vendor_invoice_lines.unit_cost_cents",
    lineTotalCents: "vendor_invoice_lines.line_total_cents",
    matchStatus: "vendor_invoice_lines.match_status",
  },
  vendorInvoicePoLinks: {
    id: "vendor_invoice_po_links.id",
    vendorInvoiceId: "vendor_invoice_po_links.vendor_invoice_id",
    purchaseOrderId: "vendor_invoice_po_links.purchase_order_id",
  },
  vendorInvoices: {
    id: "vendor_invoices.id",
    vendorId: "vendor_invoices.vendor_id",
    status: "vendor_invoices.status",
    paidAmountCents: "vendor_invoices.paid_amount_cents",
    invoicedAmountCents: "vendor_invoices.invoiced_amount_cents",
  },
  auditEvents: { id: "audit_events.id" },
  poStatusHistory: { id: "po_status_history.id" },
}));

const mocks = vi.hoisted(() => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
  detectOverpaid: vi.fn(),
  detectPastDue: vi.fn(),
  insertedLine: null as any,
}));

vi.mock("../../../../db", () => ({ db: mocks.db }));
vi.mock("@shared/schema", () => ({
  ...tables,
  apPaymentAllocations: {},
  apPayments: {},
  inboundFreightCosts: {},
  inboundShipments: {},
  vendorInvoiceAttachments: {},
  vendors: {},
}));
vi.mock("@shared/schema/procurement.schema", () => ({}));
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
  const terminal: any = {
    returning: vi.fn(() => Promise.resolve([])),
    then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve([]).then(resolve, reject),
  };
  return { set: vi.fn(() => ({ where: vi.fn(() => terminal) })) };
}

function configureImport(selectResults: unknown[][], insertedLine: any) {
  mocks.insertedLine = insertedLine;
  mocks.db.select.mockImplementation(() => makeSelectChain(selectResults.shift() ?? []));
  mocks.db.transaction.mockImplementation(async (callback: (tx: any) => unknown) => callback(mocks.db));
  mocks.db.insert.mockImplementation((table: unknown) => ({
    values: vi.fn(() => ({
      returning: vi.fn(() => Promise.resolve(
        table === tables.vendorInvoiceLines ? [mocks.insertedLine] : [],
      )),
    })),
  }));
  mocks.db.update.mockImplementation(() => makeUpdateChain());
}

function importSelectResults(poLines: any[], existingLines: any[], totalCents: number) {
  return [
    [{ id: 55, vendorId: 4, status: "received", paidAmountCents: 0 }],
    [{ id: 7, vendorId: 4 }],
    [{ id: 81 }],
    poLines,
    existingLines,
    [{ maxLine: 3 }],
    [{ total: totalCents }],
    [{ id: 55, paidAmountCents: 0 }],
    [{
      status: "sent",
      financialStatus: "unbilled",
      firstInvoicedAt: null,
      firstPaidAt: null,
      fullyPaidAt: null,
    }],
    [{ invoicedAmountCents: totalCents, paidAmountCents: 0 }],
  ];
}

describe("AP ledger invoice line imports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detectOverpaid.mockResolvedValue(undefined);
    mocks.detectPastDue.mockResolvedValue(undefined);
  });

  it("does not duplicate PO-backed invoice lines on repeated import", async () => {
    const poLines = [
      {
        id: 101,
        status: "open",
        productVariantId: 11,
        sku: "SKU-1",
        productName: "Product 1",
        description: "Line 1",
        orderQty: 2,
        receivedQty: 1,
        unitCostCents: 100,
        lineTotalCents: 200,
      },
      {
        id: 102,
        status: "open",
        productVariantId: 12,
        sku: "SKU-2",
        productName: "Product 2",
        description: "Line 2",
        orderQty: 1,
        receivedQty: 1,
        unitCostCents: 500,
        lineTotalCents: 500,
      },
    ];
    configureImport(
      importSelectResults(poLines, [{ purchaseOrderLineId: 101 }], 500),
      { id: 202, purchaseOrderLineId: 102 },
    );

    const { importLinesFromPO } = await import("../../ap-ledger.service");
    const lines = await importLinesFromPO(55, 7, "ops-user");

    expect(lines).toEqual([{ id: 202, purchaseOrderLineId: 102 }]);
    const lineInsertIndex = mocks.db.insert.mock.calls.findIndex(
      ([table]) => table === tables.vendorInvoiceLines,
    );
    expect(lineInsertIndex).toBeGreaterThanOrEqual(0);
    expect(mocks.db.insert).toHaveBeenCalledWith(tables.poStatusHistory);
    expect(mocks.db.insert).toHaveBeenCalledWith(tables.auditEvents);
  });

  it("uses the PO line expected receive variant on imported invoice lines", async () => {
    const poLines = [{
      id: 201,
      status: "open",
      productVariantId: 11,
      expectedReceiveVariantId: 22,
      sku: "EG-SLV-STD",
      productName: "Easy Glide Soft Sleeves Standard",
      description: null,
      orderQty: 5000,
      receivedQty: 0,
      unitCostCents: 5,
      lineTotalCents: 25000,
    }];
    configureImport(
      importSelectResults(poLines, [], 25000),
      { id: 301, purchaseOrderLineId: 201 },
    );

    const { importLinesFromPO } = await import("../../ap-ledger.service");
    const lines = await importLinesFromPO(55, 7, "ops-user");

    expect(lines).toEqual([{ id: 301, purchaseOrderLineId: 201 }]);
    const lineInsertIndex = mocks.db.insert.mock.calls.findIndex(
      ([table]) => table === tables.vendorInvoiceLines,
    );
    const insertBuilder = mocks.db.insert.mock.results[lineInsertIndex].value;
    expect(insertBuilder.values).toHaveBeenCalledWith(expect.objectContaining({
      vendorInvoiceId: 55,
      purchaseOrderLineId: 201,
      productVariantId: 22,
      sku: "EG-SLV-STD",
      qtyInvoiced: 5000,
      unitCostMills: 500,
      lineTotalCents: 25000,
    }));
  });

  it("preserves authoritative sub-cent PO unit cost on imported invoice lines", async () => {
    const poLines = [{
      id: 203,
      status: "open",
      productVariantId: 44,
      expectedReceiveVariantId: 44,
      sku: "SUBCENT-SKU",
      productName: "Sub-cent item",
      description: null,
      orderQty: 5,
      receivedQty: 0,
      unitCostCents: 1,
      unitCostMills: 55,
      lineTotalCents: 3,
    }];
    configureImport(
      importSelectResults(poLines, [], 3),
      { id: 303, purchaseOrderLineId: 203 },
    );

    const { importLinesFromPO } = await import("../../ap-ledger.service");
    await importLinesFromPO(55, 7, "ops-user");

    const lineInsertIndex = mocks.db.insert.mock.calls.findIndex(
      ([table]) => table === tables.vendorInvoiceLines,
    );
    const insertBuilder = mocks.db.insert.mock.results[lineInsertIndex].value;
    expect(insertBuilder.values).toHaveBeenCalledWith(expect.objectContaining({
      purchaseOrderLineId: 203,
      unitCostCents: 1,
      unitCostMills: 55,
      lineTotalCents: 3,
    }));
  });

  it("falls back to the legacy PO line variant when expected receive variant is invalid", async () => {
    const poLines = [{
      id: 202,
      status: "open",
      productVariantId: 33,
      expectedReceiveVariantId: 0,
      sku: "LEGACY-SKU",
      productName: "Legacy item",
      description: null,
      orderQty: 10,
      receivedQty: 0,
      unitCostCents: 100,
      lineTotalCents: 1000,
    }];
    configureImport(
      importSelectResults(poLines, [], 1000),
      { id: 302, purchaseOrderLineId: 202 },
    );

    const { importLinesFromPO } = await import("../../ap-ledger.service");
    await importLinesFromPO(55, 7, "ops-user");

    const lineInsertIndex = mocks.db.insert.mock.calls.findIndex(
      ([table]) => table === tables.vendorInvoiceLines,
    );
    const insertBuilder = mocks.db.insert.mock.results[lineInsertIndex].value;
    expect(insertBuilder.values).toHaveBeenCalledWith(expect.objectContaining({
      purchaseOrderLineId: 202,
      productVariantId: 33,
    }));
  });
});
