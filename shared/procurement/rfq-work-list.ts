import { z } from "zod";

export const RFQ_LIST_DEFAULT_LIMIT = 25;
export const RFQ_LIST_MAX_LIMIT = 100;
const id = z.number().int().positive().max(2_147_483_647);
const count = z.number().int().nonnegative().safe();
const timestamp = z.string().datetime({ offset: true });
const integerQuery = z.preprocess(value => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value, z.number().int().safe());
export const rfqStoredStatusSchema = z.enum(["draft", "sent", "partially_quoted", "quoted", "declined", "cancelled", "expired"]);
export const rfqWorkListQuerySchema = z.object({
  limit: integerQuery.pipe(z.number().min(1).max(RFQ_LIST_MAX_LIMIT)).default(RFQ_LIST_DEFAULT_LIMIT),
  offset: integerQuery.pipe(z.number().min(0).max(2_147_483_647)).default(0),
  status: rfqStoredStatusSchema.optional(),
  search: z.string().trim().max(200).default(""),
}).strict();
export type RfqWorkListQuery = z.infer<typeof rfqWorkListQuerySchema>;

export const rfqWorkListLineSchema = z.object({
  id, rfqId: id, recommendationLineId: id, recommendationRunId: id.nullable(), vendorProductId: id,
  vendorSku: z.string().nullable(), sku: z.string(), productName: z.string(), status: z.string(),
  requestedPieces: id, recommendedPieces: count.nullable(), purchaseUom: z.string().nullable(), piecesPerPurchaseUom: id.nullable(),
  quantityOverrideReason: z.string().nullable(), allocationOverrideReason: z.string().nullable(),
  allocationOverrideApprovedBy: z.string().nullable(), allocationOverrideApprovedAt: timestamp.nullable(),
  allocationOverrideBaselinePieces: count.nullable(), allocationOverrideExcessPieces: count.nullable(),
  quotedPieces: id.nullable(), quotedUnitCostMills: count.nullable(), quoteReference: z.string().nullable(),
  quoteValidUntil: z.string().date().nullable(), quotedAt: timestamp.nullable(),
}).strict();
export const rfqWorkListHeaderSchema = z.object({
  id, rfqNumber: z.string().min(1), status: rfqStoredStatusSchema, vendorId: id, vendorName: z.string().nullable(),
  requestNote: z.string().nullable(), currency: z.string().regex(/^[A-Z]{3}$/), responseDueDate: z.string().date().nullable(),
  createdBy: z.string().nullable(), createdAt: timestamp, updatedAt: timestamp,
  sentAt: timestamp.nullable(), respondedAt: timestamp.nullable(), cancelledAt: timestamp.nullable(),
}).strict();
export const rfqHandoffSchema = z.object({
  // This records conversion provenance, not approval, receipt or active supply.
  state: z.enum(["not_started", "partially_converted", "converted", "review_required"]),
  linkedLineCount: count, remainingLineCount: count,
  issues: z.array(z.object({ code: z.string().min(1), message: z.string().min(1) }).strict()),
  purchaseOrders: z.array(z.object({ id, poNumber: z.string().min(1), status: z.string().min(1) }).strict()),
}).strict().superRefine((value, context) => {
  if ((value.state === "review_required") !== (value.issues.length > 0)
    || value.state === "not_started" && value.linkedLineCount !== 0
    || ["converted", "partially_converted"].includes(value.state) && value.linkedLineCount === 0
    || new Set(value.purchaseOrders.map(po => po.id)).size !== value.purchaseOrders.length) {
    context.addIssue({ code: "custom", message: "Inconsistent RFQ handoff evidence" });
  }
});
export const rfqWorkListItemSchema = rfqWorkListHeaderSchema.extend({
  lineCount: count, requestedPiecesTotal: count, lines: z.array(rfqWorkListLineSchema), handoff: rfqHandoffSchema,
}).strict().superRefine((value, context) => {
  if (!Number.isSafeInteger(value.requestedPiecesTotal) || !value.lines.every(line => Number.isSafeInteger(line.requestedPieces))) return;
  if (value.lineCount !== value.lines.length || new Set(value.lines.map(line => line.id)).size !== value.lines.length
    || value.lines.some(line => line.rfqId !== value.id)
    || BigInt(value.requestedPiecesTotal) !== value.lines.reduce((sum, line) => sum + BigInt(line.requestedPieces), BigInt(0))
    || value.handoff.linkedLineCount + value.handoff.remainingLineCount > value.lineCount
    || value.handoff.state === "converted" && value.handoff.linkedLineCount !== value.lineCount) {
    context.addIssue({ code: "custom", message: "Inconsistent RFQ line totals" });
  }
});
export const rfqWorkListResponseSchema = z.object({
  limit: z.number().int().min(1).max(RFQ_LIST_MAX_LIMIT), count,
  // Compatibility: these counts describe the returned page, not all matches.
  statusCounts: z.record(count), rfqs: z.array(rfqWorkListItemSchema),
  page: z.object({ total: count, limit: z.number().int().min(1).max(RFQ_LIST_MAX_LIMIT), offset: count, nextOffset: count.nullable() }).strict(),
}).strict().superRefine((value, context) => {
  const { page } = value;
  const expectedCounts: Record<string, number> = {};
  for (const rfq of value.rfqs) expectedCounts[rfq.status] = (expectedCounts[rfq.status] ?? 0) + 1;
  if (value.limit !== page.limit || value.count !== value.rfqs.length
    || value.count !== Math.min(page.limit, Math.max(0, page.total - page.offset))
    || page.nextOffset !== (page.offset + value.count < page.total ? page.offset + value.count : null)
    || new Set(value.rfqs.map(rfq => rfq.id)).size !== value.rfqs.length
    || Object.keys(value.statusCounts).length !== Object.keys(expectedCounts).length
    || Object.entries(expectedCounts).some(([status, total]) => value.statusCounts[status] !== total)) {
    context.addIssue({ code: "custom", message: "Inconsistent RFQ work-list page" });
  }
});
export type RfqWorkListHeader = z.infer<typeof rfqWorkListHeaderSchema>;
export type RfqWorkListLine = z.infer<typeof rfqWorkListLineSchema>;
export type RfqHandoff = z.infer<typeof rfqHandoffSchema>;
export type RfqWorkListItem = z.infer<typeof rfqWorkListItemSchema>;
export type RfqWorkListResponse = z.infer<typeof rfqWorkListResponseSchema>;
