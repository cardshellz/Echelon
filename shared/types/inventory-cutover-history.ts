import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const bigintId = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= BigInt("9223372036854775807"));
const id = z.number().int().positive().max(2_147_483_647);
export const historyTreatmentSchema = z.enum([
  "settled_order_notification", "fulfilled_digital_notification", "unresolved_channel_quarantine",
  "closed_shipment_intention", "terminal_order_posting_debt", "duplicate_correction_intention",
]);
const decisionFields = z.object({
  kind: z.enum(["receipt", "shipment"]), id: bigintId, treatment: historyTreatmentSchema,
  factsHash: hash, reviewEvidenceHash: hash.nullable(), sourceItemIds: z.array(id).max(10_000),
}).strict();
function validateDecision(value: z.infer<typeof decisionFields>, context: z.RefinementCtx): void {
  const receiptTreatment = ["settled_order_notification", "fulfilled_digital_notification", "unresolved_channel_quarantine"].includes(value.treatment);
  if ((value.kind === "receipt") !== receiptTreatment
    || value.kind === "receipt" && (value.sourceItemIds.length !== 0 || value.reviewEvidenceHash === null)
    || value.kind === "shipment" && /^[1-9][0-9]{0,18}$/.test(value.id) && BigInt(value.id) > BigInt(2_147_483_647)
    || new Set(value.sourceItemIds).size !== value.sourceItemIds.length) {
    context.addIssue({ code: "custom", message: "History treatment must match its exact owner and distinct source membership." });
  }
}
export const historyDecisionSchema = decisionFields.superRefine(validateDecision);
export const historyReviewSchema = z.object({
  contractVersion: z.literal("inventory_cutover_history_review_v1"),
  authorityRevision: bigintId, configurationRunId: bigintId.nullable(), sourceEvidenceHash: hash,
  decisions: z.array(historyDecisionSchema).max(100_000),
  blockers: z.array(z.object({ code: z.string(), subject: z.string() }).strict()),
  unresolvedReceiptIds: z.array(bigintId).max(100_000),
  preservedCurrentOrderItemIds: z.array(id).max(100_000),
  readyForRetirement: z.boolean(), activatesInventory: z.literal(false), reviewHash: hash,
}).strict().superRefine((value, context) => {
  if (value.readyForRetirement !== (value.blockers.length === 0)
    || new Set(value.decisions.map(row => `${row.kind}:${row.id}`)).size !== value.decisions.length) {
    context.addIssue({ code: "custom", message: "Readiness and distinct membership must match the complete review." });
  }
});
export const retireHistoryRequestSchema = z.object({
  expectedReviewHash: hash, expectedAuthorityRevision: bigintId,
  expectedConfigurationRunId: bigintId.nullable(),
  acceptUnresolvedOrigin: z.boolean(),
  reason: z.string().trim().min(1).max(1_000),
  idempotencyKey: z.string().trim().min(1).max(120),
}).strict();
export const historyRetirementResultSchema = z.object({
  batchId: bigintId, reviewHash: hash, retiredReceipts: z.number().int().nonnegative(),
  retiredShipments: z.number().int().nonnegative(), quarantinedReceipts: z.number().int().nonnegative(),
  actor: z.string().min(1).max(100), reason: z.string().min(1).max(1_000),
  occurredAt: z.string().datetime(), alreadyApplied: z.boolean(),
  inventoryChanged: z.literal(false), authorityChanged: z.literal(false),
}).strict();
/** Included in the original census, not a deletion or rewrite of source history. */
export const retiredHistoryEvidenceSchema = decisionFields.extend({
  batchId: bigintId, reviewHash: hash, sourceItemsHash: hash,
}).strict().superRefine(validateDecision);
export type HistoryDecision = z.infer<typeof historyDecisionSchema>;
export type HistoryReview = z.infer<typeof historyReviewSchema>;
export type RetireHistoryRequest = z.infer<typeof retireHistoryRequestSchema>;
export type HistoryRetirementResult = z.infer<typeof historyRetirementResultSchema>;
export type RetiredHistoryEvidence = z.infer<typeof retiredHistoryEvidenceSchema>;
