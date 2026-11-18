import { z } from "zod";
import { costFingerprintSchema } from "./cost-source-contracts";
import { poAmendmentImpactSchema } from "./po-amendment-impact";

const id = z.number().int().positive().max(2_147_483_647);
const quantity = z.number().int().nonnegative().safe();
const money = z.number().int().nonnegative().safe();
export const receiptInvoiceAllocationSchema = z
  .object({
    receivingLineId: id,
    invoiceLineId: id,
    receiptStartPiece: quantity,
    invoiceStartPiece: quantity,
    pieces: quantity.positive(),
  })
  .strict();
export type ReceiptInvoiceAllocation = z.infer<
  typeof receiptInvoiceAllocationSchema
>;
export const receiptCostingReceiptSchema = z
  .object({
    receivingLineId: id,
    receiptId: id,
    receiptNumber: z.string(),
    inboundShipmentLineId: id.nullable().optional(),
    startBasePiece: quantity,
    pieces: quantity.positive(),
  })
  .strict();
export type ReceiptCostingReceipt = z.infer<typeof receiptCostingReceiptSchema>;
export {
  receiptCostSegmentSchema,
  type ReceiptCostSegment,
} from "./receipt-cost-segments";
export const receiptInvoiceChangeSchema = z
  .object({
    purchaseOrderLineId: id,
    allocations: z.array(receiptInvoiceAllocationSchema).max(500),
  })
  .strict();
export const receiptInvoicePreviewRequestSchema = z
  .object({
    sourceVersion: costFingerprintSchema,
    change: receiptInvoiceChangeSchema,
  })
  .strict();
export const receiptInvoiceApprovalRequestSchema =
  receiptInvoicePreviewRequestSchema
    .extend({
      previewVersion: costFingerprintSchema,
      reason: z.string().trim().min(10).max(2000),
      approvalConfirmed: z.literal(true),
    })
    .strict();
export const receiptInvoiceCostRowSchema = receiptCostingReceiptSchema
  .extend({
    confirmedPieces: quantity,
    provisionalPieces: quantity,
    supplierMills: money.nullable(),
  })
  .strict();
export const receiptInvoiceContextSchema = z
  .object({
    purchaseOrderLineId: id,
    purchaseOrderId: id,
    label: z.string(),
    sourceVersion: costFingerprintSchema,
    canApprove: z.boolean(),
    enabled: z.boolean(),
    allocations: z.array(receiptInvoiceAllocationSchema),
    receipts: z.array(receiptCostingReceiptSchema),
    invoices: z.array(
      z
        .object({
          id,
          invoiceId: id,
          invoiceNumber: z.string(),
          pieces: quantity.positive(),
          amountCents: money,
          ready: z.boolean(),
        })
        .strict(),
    ),
    costs: z.array(receiptInvoiceCostRowSchema),
    approvals: z.array(
      z
        .object({
          actorName: z.string(),
          approvedAt: z.string(),
          reason: z.string(),
          preview: z.lazy(() => receiptInvoicePreviewSchema),
        })
        .strict(),
    ),
  })
  .strict();
export const receiptInvoicePreviewSchema = z
  .object({
    sourceVersion: costFingerprintSchema,
    previewVersion: costFingerprintSchema,
    change: receiptInvoiceChangeSchema,
    before: z.array(receiptInvoiceCostRowSchema),
    after: z.array(receiptInvoiceCostRowSchema),
    unassignedInvoicePieces: quantity,
    impact: poAmendmentImpactSchema.pick({
      lots: true,
      orderCosts: true,
      historicalCosts: true,
    }),
    inventoryValues: z.array(
      z
        .object({
          lotId: id,
          lotNumber: z.string(),
          onHandUnits: quantity,
          beforeMills: money.nullable(),
          afterMills: money.nullable(),
          reviewReason: z.string().nullable(),
        })
        .strict(),
    ),
    issues: z.array(
      z.object({ code: z.string(), message: z.string() }).strict(),
    ),
  })
  .strict();
export const receiptInvoiceResultSchema = z
  .object({
    auditEventId: z.number().int().positive().safe(),
    preview: receiptInvoicePreviewSchema,
  })
  .strict();

export const receiptInvoiceApprovalHistorySchema = z
  .array(
    receiptInvoiceContextSchema.shape.approvals.element.extend({
      purchaseOrderLineId: id,
      label: z.string(),
    }),
  )
  .max(20);
