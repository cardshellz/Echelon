import { z } from "zod";

export const COST_REPORT_MAX_BYTES = 4 * 1024 * 1024;
export const COST_REPORT_ACK_MAX_BYTES = 16 * 1024;
const integer = z.number().int().safe();
const id = integer.positive();
const bigintId = z.string().regex(/^[1-9][0-9]{0,18}$/).refine((value) => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= BigInt("9223372036854775807"));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const component = z.enum(["product", "packaging", "landed"]);
const balance = z.object({ productMills: integer, packagingMills: integer, landedMills: integer }).strict();

/** This is the inventory owner's existing version-1 event, unchanged in transit.
 * It reports an applied cost adjustment; it is not a sale or a journal command. */
export const inventoryCostReportEventSchema = z.object({
  contractVersion: z.literal(1), currency: z.string().regex(/^[A-Z]{3}$/),
  sourceRevisionId: id, sourceFingerprint: hash, component,
  changes: z.array(z.object({
    lotId: id, before: balance,
    after: balance.extend({ totalMills: integer, component, allocatedMills: integer, quantity: id, remainderMills: integer }).strict(),
  }).strict()).max(10_000),
  cogsDeltaCents: integer, actorId: z.string().min(1).max(500), recordedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((event, context) => {
  const ids = new Set<number>();
  for (const [index, change] of event.changes.entries()) {
    const after = change.after;
    if (![after.productMills,after.packagingMills,after.landedMills,after.totalMills,after.quantity,after.allocatedMills,after.remainderMills].every(Number.isSafeInteger)) continue;
    const key = { product: "productMills", packaging: "packagingMills", landed: "landedMills" } as const;
    if (ids.has(change.lotId) || after.component !== event.component
      || BigInt(after.productMills) + BigInt(after.packagingMills) + BigInt(after.landedMills) !== BigInt(after.totalMills)
      || BigInt(after[key[event.component]]) * BigInt(after.quantity) + BigInt(after.remainderMills) !== BigInt(after.allocatedMills)) {
      context.addIssue({ code: "custom", path: ["changes", index], message: "Cost event identities or exact allocation totals conflict" });
    }
    ids.add(change.lotId);
  }
});

export const costReportEnvelopeCoreSchema = z.object({
  contractVersion: z.literal(1), eventType: z.literal("inventory.cost_application_recorded"),
  sourceSystemId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/),
  destinationId: z.string().uuid(), deliveryId: z.string().uuid(), sourceEventId: bigintId,
  applicationId: bigintId, purchaseOrderId: id, purchaseOrderLineId: id,
  payloadHash: hash, payload: inventoryCostReportEventSchema,
}).strict();
export const costReportEnvelopeSchema = costReportEnvelopeCoreSchema.extend({ reportHash: hash }).strict();
export type CostReportEnvelope = z.infer<typeof costReportEnvelopeSchema>;
export type InventoryCostReportEvent = z.infer<typeof inventoryCostReportEventSchema>;

export const costReportAcknowledgementSchema = z.object({
  contractVersion: z.literal(1), disposition: z.literal("accepted_evidence_only"),
  sourceSystemId: costReportEnvelopeCoreSchema.shape.sourceSystemId,
  destinationId: z.string().uuid(), deliveryId: z.string().uuid(), sourceEventId: bigintId,
  payloadHash: hash, reportHash: hash, receiptId: z.string().uuid(),
  acceptedAt: z.string().datetime({ offset: true }),
}).strict();
export type CostReportAcknowledgement = z.infer<typeof costReportAcknowledgementSchema>;

export const costReportDeliveryStatusSchema = z.enum(["queued", "processing", "retry_required", "dead_letter", "acknowledged"]);
export const costReportDeliveryListSchema = z.object({
  purchaseOrderId: id,
  configuration: z.enum(["enabled", "disabled", "not_configured", "invalid"]),
  deliveries: z.array(z.object({
    id: z.string().uuid(), sourceEventId: bigintId, applicationId: bigintId,
    destinationId: z.string().uuid(), state: costReportDeliveryStatusSchema,
    attemptCount: integer.nonnegative(), nextAttemptAt: z.string().datetime().nullable(),
    lastErrorCode: z.string().nullable(), lastErrorMessage: z.string().nullable(),
    acknowledgement: costReportAcknowledgementSchema.nullable(),
    recordedAt: z.string().datetime(), updatedAt: z.string().datetime(),
  }).strict()).max(500),
  unqueuedEventCount: integer.nonnegative(), truncated: z.boolean(),
}).strict();
export type CostReportDeliveryList = z.infer<typeof costReportDeliveryListSchema>;
export const retryCostReportSchema = z.object({
  expectedAttemptCount: integer.nonnegative(), reason: z.string().trim().min(3).max(1000),
}).strict();
