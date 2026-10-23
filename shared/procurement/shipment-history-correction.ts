import { z } from "zod";

export const shipmentHistoryId = z.number().int().positive().max(2_147_483_647);
const pieces = z.number().int().nonnegative().safe();
const cents = z.number().int().safe();
const version = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.getUTCFullYear() >= 1 && parsed.toISOString().slice(0, 10) === value;
}, "Enter a valid document date.");
export const shipmentHistoryInputSchema = z.object({
  sourceVersion: version,
  status: z.enum(["in_transit", "delivered"]),
  departedOn: date,
  deliveredOn: date.nullable(),
  reason: z.string().trim().min(10).max(2000),
  evidenceConfirmed: z.literal(true),
}).strict();
export const shipmentHistoryApprovalSchema = shipmentHistoryInputSchema.extend({ previewVersion: version }).strict();

export const shipmentHistoryStateSchema = z.object({
  status: z.string().min(1), departedOn: date.nullable(), deliveredOn: date.nullable(),
}).strict();
export const shipmentHistoryLineSchema = z.object({
  id: shipmentHistoryId, sku: z.string(), pieces,
  purchaseOrderId: shipmentHistoryId.nullable(), poNumber: z.string().nullable(),
  purchaseOrderLineId: shipmentHistoryId.nullable(), orderedPieces: pieces.nullable(),
  receivedPieces: pieces.nullable(), postedReceiptPieces: pieces.nullable(),
  otherShippedPieces: pieces.nullable(), otherPlannedPieces: pieces.nullable(),
}).strict();
export const shipmentHistoryReceiptSchema = z.object({
  id: shipmentHistoryId, number: z.string(), lineId: shipmentHistoryId,
  purchaseOrderLineId: shipmentHistoryId.nullable(), handledUnits: pieces,
  piecesPerUnit: pieces.positive().nullable(), postedPieces: pieces.nullable(),
  shipmentId: shipmentHistoryId.nullable(), shipmentLineId: shipmentHistoryId.nullable(),
}).strict();
export const shipmentHistoryReviewSchema = z.object({
  before: shipmentHistoryStateSchema, after: shipmentHistoryStateSchema,
  lines: z.array(shipmentHistoryLineSchema), receipts: z.array(shipmentHistoryReceiptSchema),
  charges: z.array(z.object({ currency: z.string().length(3), cents }).strict()),
  plannedPiecesBefore: pieces, shippedPiecesBefore: pieces,
  plannedPiecesAfter: pieces, shippedPiecesAfter: pieces,
  issues: z.array(z.string()),
  protectedRecordsVersion: version,
}).strict();
export const shipmentHistoryPostingSchema = z.object({
  id: z.number().int().positive().safe(), actorId: z.string().min(1), actorName: z.string().min(1),
  approvedAt: z.string().datetime(), reason: z.string(), review: shipmentHistoryReviewSchema,
}).strict();
export const shipmentHistoryContextSchema = z.object({
  shipmentId: shipmentHistoryId, shipmentNumber: z.string(), sourceVersion: version,
  canApprove: z.boolean(), blockedReason: z.string().nullable(),
  current: shipmentHistoryStateSchema,
  lines: z.array(shipmentHistoryLineSchema), receipts: z.array(shipmentHistoryReceiptSchema),
  charges: z.array(z.object({ currency: z.string().length(3), cents }).strict()),
  issues: z.array(z.string()),
  events: z.array(z.object({ status: z.string(), recordedAt: z.string().datetime(), notes: z.string().nullable() }).strict()),
  approvals: z.array(shipmentHistoryPostingSchema),
}).strict();
export const shipmentHistoryPreviewSchema = z.object({
  previewVersion: version, review: shipmentHistoryReviewSchema,
}).strict();

export type ShipmentHistoryInput = z.infer<typeof shipmentHistoryInputSchema>;
export type ShipmentHistoryReview = z.infer<typeof shipmentHistoryReviewSchema>;
export type ShipmentHistoryContext = z.infer<typeof shipmentHistoryContextSchema>;
export type ShipmentHistoryPosting = z.infer<typeof shipmentHistoryPostingSchema>;
export type ShipmentHistoryPreview = z.infer<typeof shipmentHistoryPreviewSchema>;
export type ShipmentHistoryState = z.infer<typeof shipmentHistoryStateSchema>;
