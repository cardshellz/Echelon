import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";

/** Immutable request facts; a channel adapter can prove a narrower effect only
 * from complete saved evidence. Missing or ambiguous evidence stays unknown. */
export const retainedPublicationEffectEvidenceSchema = z.object({
  attemptId: z.string().regex(/^[1-9][0-9]*$/), ownerKind: z.string(), requestCount: z.number().int().nonnegative(),
  method: z.string().nullable(), path: z.string().nullable(), requestHash: z.string().nullable(),
  desiredQuantity: z.string().nullable(), inventoryItemId: z.string().nullable(),
  productVariantId: z.number().int().positive().nullable(), connectionId: z.number().int().positive().nullable(),
  accountId: z.string().nullable(),
}).strict();
export type RetainedPublicationEffectEvidence = z.infer<typeof retainedPublicationEffectEvidenceSchema>;

const retainedStockEffectProofSchema = z.object({ attemptId: z.string().regex(/^[1-9][0-9]*$/),
  productVariantId: z.number().int().positive(), inventoryItemId: z.string().min(1).max(240),
  providerResourceId: z.string().min(1).max(240), desiredQuantity: z.string().regex(/^(0|[1-9][0-9]*)$/),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const reconciliationContentVerificationSchema = z.object({
  kind: z.enum(["provider_match", "stock_only"]), checkedAt: z.date(), evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  identityHash: z.string().regex(/^[a-f0-9]{64}$/), proof: z.array(retainedStockEffectProofSchema).min(1).max(250).nullable(),
}).strict().superRefine((value, context) => {
  if ((value.kind === "provider_match") !== (value.proof === null))
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The check kind and retained proof must agree." });
  if (value.proof && createHash("sha256").update(canonicalJson(value.proof)).digest("hex") !== value.evidenceHash)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "The stock-only evidence hash does not match its retained proof." });
});
export type ReconciliationContentVerification = z.infer<typeof reconciliationContentVerificationSchema>;
