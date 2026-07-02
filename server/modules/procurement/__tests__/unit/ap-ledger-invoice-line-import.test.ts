import { describe, it, expect, vi, beforeEach } from "vitest";

const tables = vi.hoisted(() => ({
  purchaseOrderLines: {
    id: "purchase_order_lines.id",
    purchaseOrderId: "purchase_order_lines.purchase_order_id",
    lineNumber: "purchase_order_lines.line_number",
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
}));

const mocks = vi.hoisted(() => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock("../../../../db", () => ({ db: mocks.db }));

vi.mock("@shared/schema", () => ({
  ...tables,
  apPaymentAllocations: {},
  apPayments: {},
  auditEvents: {},
  inboundFreightCosts: {},
  inboundShipments: {},
  purchaseOrders: {},
  vendorInvoiceAttachments: {},
  vendorInvoicePoLinks: {},
  vendorInvoices: {},
  vendors: {},
}));

vi.mock("@shared/schema/procurement.schema", () => ({}));

function selectWithOrderBy(result: any[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(() => Promise.resolve(result)),
      })),
    })),
  };
}

function selectWhere(result: any[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve(result)),
    })),
  };
}

function insertReturning(result: any) {
  return {
    values: vi.fn(() => ({
      returning: vi.fn(() => Promise.resolve([result])),
    })),
  };
}

describe("AP ledger invoice line imports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mocks.db.select
      .mockReturnValueOnce(selectWithOrderBy(poLines))
      .mockReturnValueOnce(selectWhere([{ purchaseOrderLineId: 101 }]))
      .mockReturnValueOnce(selectWhere([{ maxLine: 3 }]));
    mocks.db.insert.mockReturnValue(insertReturning({ id: 202, purchaseOrderLineId: 102 }));

    const { importLinesFromPO } = await import("../../ap-ledger.service");

    const lines = await importLinesFromPO(55, 7);

    expect(lines).toEqual([{ id: 202, purchaseOrderLineId: 102 }]);
    expect(mocks.db.insert).toHaveBeenCalledTimes(1);
    expect(mocks.db.insert.mock.calls[0][0]).toBe(tables.vendorInvoiceLines);
  });

  it("uses the PO line expected receive variant on imported invoice lines", async () => {
    const poLines = [
      {
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
      },
    ];
    mocks.db.select
      .mockReturnValueOnce(selectWithOrderBy(poLines))
      .mockReturnValueOnce(selectWhere([]))
      .mockReturnValueOnce(selectWhere([{ maxLine: 0 }]));
    mocks.db.insert.mockReturnValue(insertReturning({ id: 301, purchaseOrderLineId: 201 }));

    const { importLinesFromPO } = await import("../../ap-ledger.service");

    const lines = await importLinesFromPO(77, 9);

    expect(lines).toEqual([{ id: 301, purchaseOrderLineId: 201 }]);
    const insertBuilder = mocks.db.insert.mock.results[0].value;
    expect(insertBuilder.values).toHaveBeenCalledWith(
      expect.objectContaining({
        vendorInvoiceId: 77,
        purchaseOrderLineId: 201,
        productVariantId: 22,
        sku: "EG-SLV-STD",
        qtyInvoiced: 5000,
        lineTotalCents: 25000,
      }),
    );
  });

  it("falls back to the legacy PO line variant when expected receive variant is invalid", async () => {
    const poLines = [
      {
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
      },
    ];
    mocks.db.select
      .mockReturnValueOnce(selectWithOrderBy(poLines))
      .mockReturnValueOnce(selectWhere([]))
      .mockReturnValueOnce(selectWhere([{ maxLine: 0 }]));
    mocks.db.insert.mockReturnValue(insertReturning({ id: 302, purchaseOrderLineId: 202 }));

    const { importLinesFromPO } = await import("../../ap-ledger.service");

    await importLinesFromPO(78, 10);

    const insertBuilder = mocks.db.insert.mock.results[0].value;
    expect(insertBuilder.values).toHaveBeenCalledWith(
      expect.objectContaining({
        purchaseOrderLineId: 202,
        productVariantId: 33,
      }),
    );
  });
});
