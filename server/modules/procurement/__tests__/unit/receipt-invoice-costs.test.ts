import { describe, expect, it } from "vitest";
import { resolvePurchaseCostSource } from "../../domain/purchase-cost-source";
import {
  validateReceiptInvoiceAllocations,
  type ReceiptInvoiceSource,
} from "../../domain/receipt-invoice-costs";
import {
  receiptSegmentCost,
  receiptCostSegmentSchema,
} from "@shared/procurement/receipt-cost-segments";
import { costSourceRevisionSchema } from "@shared/procurement/cost-source-contracts";
import {
  projectTaxedShipmentSupplierCost,
  projectPurchaseTaxCosts,
} from "../../domain/purchase-tax-costs";
import { supplierCostReviewTasks } from "@shared/procurement/cost-review-tasks";
import { purchaseCostStatusSchema } from "@shared/procurement/purchase-cost-status";
import { receiptInvoiceCostRows } from "../../domain/receipt-invoice-preview";

function source(): ReceiptInvoiceSource {
  return {
    purchaseOrderLine: {
      id: 21,
      purchase_order_id: 10,
      line_type: "product",
      order_qty: 100,
      received_qty: 100,
      status: "received",
      currency: "USD",
      total_product_cost_cents: 10000,
      packaging_cost_cents: 0,
      discount_cents: 0,
      tax_cents: 0,
    },
    approvedInvoices: [invoice(1, 40, 480000), invoice(2, 60, 900000)],
    receiptCosting: {
      receipts: [
        {
          receivingLineId: 101,
          receiptId: 11,
          receiptNumber: "RCV-A",
          startBasePiece: 0,
          pieces: 40,
        },
        {
          receivingLineId: 102,
          receiptId: 12,
          receiptNumber: "RCV-B",
          startBasePiece: 40,
          pieces: 60,
        },
      ],
      allocations: [],
    },
  };
}
function invoice(id: number, pieces: number, productMills: number) {
  return {
    id,
    vendor_invoice_id: id,
    qty_invoiced: pieces,
    line_total_cents: productMills / 100,
    currency: "USD",
    cost_component_evidence: {
      contractVersion: 1,
      source: "operator_review",
      packagingTreatment: "included_in_product",
      productMills,
      packagingMills: 0,
      adjustmentMills: 0,
    },
  };
}
function product(input: ReceiptInvoiceSource) {
  return resolvePurchaseCostSource(input).find(
    (row) => row.component === "product",
  )!;
}
const first = {
  receivingLineId: 101,
  invoiceLineId: 1,
  receiptStartPiece: 0,
  invoiceStartPiece: 0,
  pieces: 40,
};
const second = {
  receivingLineId: 102,
  invoiceLineId: 2,
  receiptStartPiece: 0,
  invoiceStartPiece: 0,
  pieces: 60,
};

describe("receipt-specific supplier source and exact intervals", () => {
  it("uses each split shipment's own receipt rate and keeps unreceived goods at the quote", () => {
    const input = source();
    input.receiptCosting!.receipts = input.receiptCosting!.receipts.map(
      (row, index) => ({ ...row, inboundShipmentLineId: 501 + index }),
    );
    input.receiptCosting!.allocations = [first, second];
    expect(projectTaxedShipmentSupplierCost(input, 40, false, 501)).toEqual({
      unitCostMills: 12000,
      reason: null,
    });
    expect(projectTaxedShipmentSupplierCost(input, 60, false, 502)).toEqual({
      unitCostMills: 15000,
      reason: null,
    });
    expect(projectTaxedShipmentSupplierCost(input, 20, false, 503)).toEqual({
      unitCostMills: 10000,
      reason: null,
    });
  });
  it("shows exact actual-plus-provisional PO totals without averaging the receipts", () => {
    const input = source();
    input.receiptCosting!.allocations = [first];
    const result = projectPurchaseTaxCosts([input.purchaseOrderLine], [input], {
      lines: [],
      recoverableByShipmentLine: new Map(),
      complete: true,
    });
    expect(result).toMatchObject({
      supplierInventoryMills: 1080000,
      supplierInventoryCents: 10800,
      inventoryLandedCents: 10800,
      reason: null,
    });
    expect(
      receiptInvoiceCostRows(input, input.receiptCosting!.receipts).map(
        (row) => row.supplierMills,
      ),
    ).toEqual([480000, 600000]);
  });
  it("keeps receipt coverage through the shared status boundary with the direct owning task", () => {
    const input = source();
    input.receiptCosting!.allocations = [first];
    const status = purchaseCostStatusSchema.parse({
      lines: [
        {
          purchaseOrderId: 10,
          purchaseOrderLineId: 21,
          sku: "GOODS",
          components: ["product", "packaging"].map((component) => ({
            component,
            status: "applied",
            sourceEvidence: "estimated",
            sourceCurrent: true,
            sourceRevisionId: 1,
            applicationId: 1,
            issues: [],
          })),
          receipts: [],
          invoices: [],
          lots: [],
          receiptCosting: {
            receipts: receiptInvoiceCostRows(
              input,
              input.receiptCosting!.receipts,
            ),
            provisionalPieces: 60,
            unassignedInvoicePieces: 60,
          },
        },
      ],
    });
    const line = purchaseCostStatusSchema.parse(
      JSON.parse(JSON.stringify(status)),
    ).lines[0];
    expect(line.receiptCosting?.receipts[1]).toMatchObject({
      supplierMills: 600000,
      provisionalPieces: 60,
    });
    expect(supplierCostReviewTasks(line)).toEqual([
      expect.objectContaining({
        action: "receipt_invoice",
        title: "Assign invoice costs to receipts",
      }),
    ]);
    const withoutReceivedCapacity=structuredClone(line);
    withoutReceivedCapacity.receiptCosting!.receipts=[];
    expect(supplierCostReviewTasks(withoutReceivedCapacity)).toEqual([expect.objectContaining({action:"receive_goods",title:"Receive the invoiced goods"})]);
    line.receiptCosting!.unassignedInvoicePieces = 0;
    expect(supplierCostReviewTasks(line)).toEqual([
      expect.objectContaining({
        action: "record_invoice",
        title: "Remaining pieces use provisional PO costs",
      }),
    ]);
    line.components = line.components.map((row) => ({
      ...row,
      sourceEvidence: "confirmed",
    }));
    expect(supplierCostReviewTasks(line)).toEqual([]);
  });
  it("rejects mixed interval identities and unsafe interval ends at the persisted boundary", () => {
    const row = {
      startBasePiece: 0,
      pieces: 1,
      receivingLineId: null,
      invoiceLineId: null,
      sourceStartPiece: 0,
      sourceBasePieces: 1,
      sourceTotalMills: 0,
      evidence: "estimated",
    };
    expect(
      receiptCostSegmentSchema.safeParse({ ...row, invoiceLineId: 1 }).success,
    ).toBe(false);
    expect(
      receiptCostSegmentSchema.safeParse({
        ...row,
        startBasePiece: Number.MAX_SAFE_INTEGER,
      }).success,
    ).toBe(false);
    expect(receiptCostSegmentSchema.safeParse(row).success).toBe(true);
  });
  it("keeps differently priced receipts separate while conserving total source money", () => {
    const input = source();
    input.receiptCosting!.allocations = [first, second];
    const before = structuredClone(input),
      selected = product(input);
    expect(selected).toMatchObject({
      evidence: "confirmed",
      basePieces: 100,
      totalMills: 1380000,
    });
    expect(
      receiptSegmentCost(selected.receiptCostSegments!, 0, 40, 101),
    ).toEqual({
      totalMills: 480000,
      confirmedPieces: 40,
      provisionalPieces: 0,
    });
    expect(
      receiptSegmentCost(selected.receiptCostSegments!, 40, 60, 102),
    ).toEqual({
      totalMills: 900000,
      confirmedPieces: 60,
      provisionalPieces: 0,
    });
    expect(input).toEqual(before);
  });
  it("leaves uninvoiced receipts at their own provisional PO source", () => {
    const input = source();
    input.receiptCosting!.allocations = [first];
    const selected = product(input);
    expect(selected).toMatchObject({
      evidence: "estimated",
      totalMills: 1080000,
    });
    expect(
      receiptSegmentCost(selected.receiptCostSegments!, 40, 60, 102),
    ).toEqual({
      totalMills: 600000,
      confirmedPieces: 0,
      provisionalPieces: 60,
    });
  });
  it("supports partial receipt coverage without pricing its remaining pieces from that invoice", () => {
    const input = source();
    input.receiptCosting!.allocations = [{ ...first, pieces: 20 }];
    const selected = product(input);
    expect(
      receiptSegmentCost(selected.receiptCostSegments!, 0, 40, 101),
    ).toEqual({
      totalMills: 440000,
      confirmedPieces: 20,
      provisionalPieces: 20,
    });
  });
  it("does not reprice the first receipt when a later invoice is assigned", () => {
    const input = source();
    input.receiptCosting!.allocations = [first];
    const before = product(input);
    input.receiptCosting!.allocations.push(second);
    const after = product(input);
    expect(receiptSegmentCost(after.receiptCostSegments!, 0, 40, 101)).toEqual(
      receiptSegmentCost(before.receiptCostSegments!, 0, 40, 101),
    );
  });
  it("uses frozen invoice offsets so rounding remainders survive splitting", () => {
    const input = source();
    input.approvedInvoices = [invoice(1, 100, 100)];
    input.receiptCosting!.allocations = [
      { ...first, pieces: 40 },
      { ...second, invoiceLineId: 1, invoiceStartPiece: 40, pieces: 60 },
    ];
    const selected = product(input);
    expect(selected.totalMills).toBe(100);
    expect(
      receiptSegmentCost(selected.receiptCostSegments!, 0, 40, 101).totalMills,
    ).toBe(40);
    expect(
      receiptSegmentCost(selected.receiptCostSegments!, 40, 60, 102).totalMills,
    ).toBe(60);
  });
  it("uses zero only when the supplier explicitly recorded zero", () => {
    const input = source();
    input.approvedInvoices = [invoice(1, 40, 0)];
    input.receiptCosting!.allocations = [first];
    expect(
      receiptSegmentCost(product(input).receiptCostSegments!, 0, 40, 101)
        .totalMills,
    ).toBe(0);
  });
  it("retains capitalized supplier tax and excludes explicitly recoverable tax", () => {
    const input = source();
    const bill = invoice(1, 40, 480000);
    bill.line_total_cents = 5280;
    bill.cost_component_evidence.adjustmentMills = 48000;
    input.approvedInvoices = [
      {
        ...bill,
        tax_cost_evidence: [
          {
            taxTypeId: 1,
            treatment: "recoverable",
            amountMills: 48000,
            source: "invoice_line:1",
          },
        ],
      },
    ];
    input.receiptCosting!.allocations = [first];
    expect(
      receiptSegmentCost(product(input).receiptCostSegments!, 0, 40, 101)
        .totalMills,
    ).toBe(480000);
    (
      input.approvedInvoices[0].tax_cost_evidence as Array<{
        treatment: string;
      }>
    )[0].treatment = "inventory";
    expect(
      receiptSegmentCost(product(input).receiptCostSegments!, 0, 40, 101)
        .totalMills,
    ).toBe(528000);
  });
  it.each([
    [
      "receipt overlap",
      [
        { ...first, pieces: 25 },
        {
          ...first,
          invoiceLineId: 2,
          receiptStartPiece: 20,
          invoiceStartPiece: 0,
          pieces: 20,
        },
      ],
    ],
    [
      "invoice overlap",
      [
        first,
        { ...second, invoiceLineId: 1, invoiceStartPiece: 20, pieces: 20 },
      ],
    ],
    ["receipt overrun", [{ ...first, pieces: 41 }]],
    ["invoice overrun", [{ ...second, invoiceLineId: 1, pieces: 41 }]],
    ["wrong receipt", [{ ...first, receivingLineId: 999 }]],
    ["wrong invoice", [{ ...first, invoiceLineId: 999 }]],
    ["negative offset", [{ ...first, receiptStartPiece: -1 }]],
    ["fractional pieces", [{ ...first, pieces: 1.5 }]],
    ["zero pieces", [{ ...first, pieces: 0 }]],
    ["unsafe quantity", [{ ...first, pieces: Number.MAX_SAFE_INTEGER + 1 }]],
  ])("rejects %s", (_name, rows) => {
    expect(() => validateReceiptInvoiceAllocations(source(), rows)).toThrow();
  });
  it("retains a visible review when an assigned invoice disappears", () => {
    const input = source();
    input.receiptCosting!.allocations = [first];
    input.approvedInvoices = [];
    expect(product(input)).toMatchObject({
      evidence: "review_required",
      issue: { code: "RECEIPT_INVOICE_ALLOCATION_REVIEW" },
    });
  });
  it("does not invent packaging evidence for an incomplete invoice", () => {
    const input = source();
    input.approvedInvoices[0].cost_component_evidence = null;
    input.receiptCosting!.allocations = [first];
    expect(product(input).evidence).toBe("review_required");
  });
  it("rejects a root interval tied to the wrong receipt", () => {
    const input = source();
    input.receiptCosting!.allocations = [first];
    expect(() =>
      receiptSegmentCost(product(input).receiptCostSegments!, 0, 40, 102),
    ).toThrow(/different receipt/);
  });
  it("validates persisted total conservation rather than trusting JSON fields", () => {
    const input = source();
    input.receiptCosting!.allocations = [first];
    const selected = product(input);
    expect(
      costSourceRevisionSchema.safeParse({
        ...selected,
        revision: 1,
        fingerprint: "a".repeat(64),
      }).success,
    ).toBe(true);
    expect(
      costSourceRevisionSchema.safeParse({
        ...selected,
        totalMills: selected.totalMills! + 1,
        revision: 1,
        fingerprint: "a".repeat(64),
      }).success,
    ).toBe(false);
  });
});
