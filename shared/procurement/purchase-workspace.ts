import { z } from "zod";

const id = z.number().int().positive().safe();
const integer = z.number().int().safe();
const date = z.string().datetime({ offset: true }).nullable();
const money = integer.nullable();

export const purchaseWorkspaceRecordSchema = z.object({
  kind: z.enum(["purchase", "shipment", "receipt", "invoice"]),
  id,
});
export type PurchaseWorkspaceRecord = z.infer<typeof purchaseWorkspaceRecordSchema>;

export const purchaseWorkspaceSchema = z.object({
  purchase: z.object({
    id,
    poNumber: z.string(),
    status: z.string(),
    physicalStatus: z.string(),
    financialStatus: z.string(),
    currency: z.string().nullable(),
    vendorName: z.string().nullable(),
    totalCents: money,
    // Existing owner rollups currently sum whole linked invoices, including shared invoices.
    // They must not be displayed as this purchase's allocated spend or debt.
    invoicedTotalCents: money,
    paidTotalCents: money,
    outstandingCents: money,
    expectedDeliveryDate: date,
    confirmedDeliveryDate: date,
    actualDeliveryDate: date,
    lines: z.array(z.object({
      id,
      sku: z.string().nullable(),
      productName: z.string().nullable(),
      lineType: z.string(),
      orderedQty: integer,
      receivedQty: integer.nullable(),
      cancelledQty: integer.nullable(),
      quantityBasis: z.enum(["pieces", "not_applicable"]),
    })),
  }),
  shipments: z.array(z.object({
    id,
    shipmentNumber: z.string(),
    status: z.string(),
    mode: z.string().nullable(),
    containerNumber: z.string().nullable(),
    eta: date,
    deliveredDate: date,
    estimatedTotalCostCents: money,
    actualTotalCostCents: money,
    amountScope: z.literal("whole_shipment"),
    purchaseOrderIds: z.array(id),
    unlinkedLineCount: integer.nonnegative(),
    lines: z.array(z.object({
      id,
      purchaseOrderId: id.nullable(),
      purchaseOrderLineId: id.nullable(),
      purchaseOrderLinePurchaseOrderId: id.nullable(),
      sku: z.string().nullable(),
      qtyShipped: integer,
      allocatedCostCents: money,
    })),
  })),
  receipts: z.array(z.object({
    id,
    receiptNumber: z.string(),
    status: z.string(),
    purchaseOrderId: id.nullable(),
    inboundShipmentId: id.nullable(),
    expectedDate: date,
    receivedDate: date,
    closedDate: date,
  })),
  invoices: z.array(z.object({
    id,
    invoiceNumber: z.string(),
    status: z.string(),
    currency: z.string().nullable(),
    invoiceDate: date,
    dueDate: date,
    inboundShipmentId: id.nullable(),
    invoicedAmountCents: money,
    paidAmountCents: money,
    balanceCents: money,
    amountScope: z.literal("whole_invoice"),
    allocatedToPurchaseCents: money,
    purchaseOrderIds: z.array(id),
  })),
  edges: z.array(z.object({
    from: purchaseWorkspaceRecordSchema,
    to: purchaseWorkspaceRecordSchema,
    relationship: z.enum([
      "purchase_shipment",
      "purchase_receipt",
      "purchase_invoice",
      "shipment_receipt",
      "shipment_invoice",
    ]),
  })),
  limitations: z.array(z.string()),
});
export type PurchaseWorkspace = z.infer<typeof purchaseWorkspaceSchema>;
export type PurchaseWorkspaceEdge = PurchaseWorkspace["edges"][number];
