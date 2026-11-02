import { z } from "zod";
import { costFingerprintSchema } from "./cost-source-contracts";
import { poAmendmentImpactSchema } from "./po-amendment-impact";

export const freightInvoiceIdSchema = z.number().int().positive().max(2_147_483_647);
const cents = z.number().int().nonnegative().safe();
const amountChange = z.object({ before: cents.nullable(), after: cents }).strict();
export const freightInvoiceChargeSchema = z.object({
  chargeId: freightInvoiceIdSchema,
  shipmentId: freightInvoiceIdSchema,
  label: z.string(),
  estimatedCents: cents.nullable(),
  actualCents: cents.nullable(),
  invoiceCents: cents,
}).strict();
export const freightInvoicePreviewRequestSchema = z.object({ sourceVersion: costFingerprintSchema }).strict();
export const freightInvoiceApprovalRequestSchema = freightInvoicePreviewRequestSchema.extend({
  previewVersion: costFingerprintSchema,
  reason: z.string().trim().min(10).max(2000),
  approvalConfirmed: z.literal(true),
}).strict();
export const freightInvoicePreviewSchema = z.object({
  invoiceId: freightInvoiceIdSchema,
  invoiceNumber: z.string(),
  sourceVersion: costFingerprintSchema,
  previewVersion: costFingerprintSchema,
  invoiceAmountCents: cents,
  paidAmountCents: cents,
  balanceCents: z.number().int().safe(),
  invoiceStatus: z.object({ before: z.string(), after: z.string() }).strict(),
  charges: z.array(freightInvoiceChargeSchema).min(1).max(500),
  shipmentStates: z.array(z.object({ shipmentId: freightInvoiceIdSchema, shipmentNumber: z.string(),
    state: z.enum(["applied", "review_required", "pending_finalization"]) }).strict()),
  allocations: z.array(z.object({
    chargeId: freightInvoiceIdSchema,
    shipmentId: freightInvoiceIdSchema,
    shipmentLineId: freightInvoiceIdSchema,
    purchaseOrderId: freightInvoiceIdSchema.nullable(),
    purchaseOrderNumber: z.string().nullable(),
    purchaseOrderLineId: freightInvoiceIdSchema.nullable(),
    label: z.string(),
    shippedPieces: cents,
    amountCents: amountChange,
  }).strict()).max(10_000),
  impact: poAmendmentImpactSchema.pick({ lots: true, orderCosts: true, historicalCosts: true }),
  inventoryValues: z.array(z.object({
    lotId: freightInvoiceIdSchema, lotNumber: z.string(), onHandUnits: cents,
    beforeMills: cents.nullable(), afterMills: cents.nullable(), reviewReason: z.string().nullable(),
  }).strict()),
  issues: z.array(z.object({ code: z.string(), message: z.string() }).strict()),
}).strict();
export const freightInvoiceApprovalHistorySchema = z.array(z.object({
  actorName: z.string(), approvedAt: z.string(), reason: z.string(), preview: freightInvoicePreviewSchema,
}).strict()).max(20);
export const freightInvoiceContextSchema = z.object({
  invoiceId: freightInvoiceIdSchema, invoiceNumber: z.string(), sourceVersion: costFingerprintSchema,
  canApprove: z.boolean(), blockedReason: z.string().nullable(),
  requiresChange: z.boolean(), charges: z.array(freightInvoiceChargeSchema),
  shipments: z.array(z.object({ id: freightInvoiceIdSchema, number: z.string(), status: z.string() }).strict()),
  invoiceStatus: z.string(), invoiceAmountCents: cents, paidAmountCents: cents, balanceCents: z.number().int().safe(),
  originalApproval: z.object({ actorId: z.string().nullable(), actorName: z.string().nullable(), approvedAt: z.string().nullable() }).strict(),
  history: freightInvoiceApprovalHistorySchema,
}).strict();
export const freightInvoiceResultSchema = z.object({
  auditEventId: z.number().int().positive().safe(), preview: freightInvoicePreviewSchema,
}).strict();
export type FreightInvoiceCharge = z.infer<typeof freightInvoiceChargeSchema>;
export type FreightInvoicePreview = z.infer<typeof freightInvoicePreviewSchema>;
