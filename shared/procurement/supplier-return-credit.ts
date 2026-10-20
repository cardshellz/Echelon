import { z } from "zod";
import { supplierReturnCostTotalsSchema, supplierReturnIntervalSchema, supplierReturnCreditLinkSchema } from "./supplier-return";
const id = z.number().int().positive().safe();
/** A credit claims money against already recorded physical custody. This
 * snapshot never changes the receipt denominator or retained inventory price. */
export const acceptedReturnCreditSourceSchema = z.object({
    contractVersion: z.literal(1), returnId: id, returnLineId: id, returnAllocationId: id,
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/), entitlementId: id.nullable(),
    quantity: id, unitsPerVariant: id, intervals: z.array(supplierReturnIntervalSchema).min(1).max(10000),
    evidenceReference: z.string().min(1).max(1000),
    reviewedCosts: supplierReturnCostTotalsSchema,
    reviewedEntryIds: z.array(id).min(3).max(10000),
}).strict().superRefine((value, context) => {
    if (!Number.isSafeInteger(value.quantity) || !value.intervals.every(row => Number.isSafeInteger(row.quantity)))
        return;
    if (value.intervals.reduce((sum, row) => sum + BigInt(row.quantity), BigInt(0)) !== BigInt(value.quantity)
        || new Set(value.reviewedEntryIds).size !== value.reviewedEntryIds.length) {
        context.addIssue({ code: "custom", message: "Return credit source must retain exact selected quantity and unique value history." });
    }
});
export type AcceptedReturnCreditSource = z.infer<typeof acceptedReturnCreditSourceSchema>;
const cents = z.number().int().nonnegative().safe();
export const supplierReturnCreditAssignmentSchema = z.object({
    creditLinkId: id, productCents: cents, packagingCents: cents, landedCents: cents,
}).strict().superRefine((value, context) => {
    if (![value.productCents, value.packagingCents, value.landedCents].every(Number.isSafeInteger))
        return;
    const sum = BigInt(value.productCents) + BigInt(value.packagingCents) + BigInt(value.landedCents);
    if (sum < BigInt(1) || sum > BigInt(Number.MAX_SAFE_INTEGER))
        context.addIssue({ code: "custom", message: "Credit attribution requires a positive exact supported total." });
});
export const supplierReturnCreditReviewDispositionSchema = z.enum(["attribution_only", "awaiting_supplier_note", "supplier_declined"]);
export const supplierReturnCreditReviewInputSchema = z.object({
    expectedVersion: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().trim().min(3).max(2000),
    evidenceReference: z.string().trim().min(1).max(1000),
    disposition: supplierReturnCreditReviewDispositionSchema,
    assignments: z.array(supplierReturnCreditAssignmentSchema).max(1000),
}).strict().refine(value => new Set(value.assignments.map(row => row.creditLinkId)).size === value.assignments.length, { message: "Attribute each supplier credit link once." });
export type SupplierReturnCreditReviewInput = z.infer<typeof supplierReturnCreditReviewInputSchema>;
export const supplierReturnCreditReviewEntrySchema = z.object({
    id, sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/), expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
    disposition: supplierReturnCreditReviewDispositionSchema,
    assignments: z.array(supplierReturnCreditAssignmentSchema).max(1000),
    evidenceReference: z.string(), reason: z.string(), recordedBy: z.string(), recordedAt: z.string().datetime({ offset: true }),
}).strict();
export const supplierReturnCreditReviewSchema = z.object({
    entitlementId: id, returnId: id, returnLineId: id, quantity: id, version: z.string().regex(/^[a-f0-9]{64}$/),
    currentCosts: supplierReturnCostTotalsSchema,
    creditLinks: z.array(supplierReturnCreditLinkSchema.extend({ id, attributionComponents: z.array(z.enum(["product", "packaging", "landed"])) })).max(1000),
    differences: z.object({ productMills: z.number().int().safe(), packagingMills: z.number().int().safe(),
        landedMills: z.number().int().safe(), totalMills: z.number().int().safe(), unassignedCreditCents: cents }).strict(),
    latestReview: supplierReturnCreditReviewEntrySchema.nullable(), reviewHistory: z.array(supplierReturnCreditReviewEntrySchema).max(1000),
    reviewCurrent: z.boolean(),
}).strict();
export type SupplierReturnCreditReview = z.infer<typeof supplierReturnCreditReviewSchema>;
export const supplierReturnCreditReviewCommandResultSchema = z.object({
    command: z.literal("review_credit_difference"), entitlementId: id, actorId: z.string().min(1), idempotencyKey: z.string().min(1).max(200),
    request: supplierReturnCreditReviewInputSchema, review: supplierReturnCreditReviewSchema,
}).strict().refine(value => value.entitlementId === value.review.entitlementId, { message: "Return credit review command identity conflicts." });

export type SupplierReturnCreditReviewCommandResult = z.infer<typeof supplierReturnCreditReviewCommandResultSchema>;
