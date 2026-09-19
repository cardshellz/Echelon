import { z } from "zod";
import { productDefinitionReviewSchema, productDefinitionReceiptSchema, productDefinitionProgressSchema } from "./inventory-product-definition";
import { promiseSafetyAdminValueSchema } from "./inventory-promise-safety-admin";

export const safetyDefinitionSelectionSchema = z.object({
  scopeKey: z.string().max(160).regex(/^(business|network:variant:[1-9]\d*|warehouse:[1-9]\d*:variant:[1-9]\d*)$/),
  draftPolicyId: z.number().int().positive().max(2_147_483_647),
  expectedHeadRevision: z.string().regex(/^(0|[1-9]\d{0,18})$/),
  expectedDefinitionHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const safetyDefinitionReviewSchema = productDefinitionReviewSchema.omit({ selection: true, previousModel: true }).extend({
  selection: safetyDefinitionSelectionSchema,
  previousPolicy: z.object({ id: z.number().int().positive(), definitionHash: z.string().regex(/^[a-f0-9]{64}$/), value: promiseSafetyAdminValueSchema }).strict().nullable(),
  proposedPolicy: promiseSafetyAdminValueSchema,
}).strict();
export const applySafetyDefinitionSchema = safetyDefinitionSelectionSchema.extend({
  expectedReviewHash: z.string().regex(/^[a-f0-9]{64}$/), idempotencyKey: z.string().trim().min(1).max(120),
}).strict();
export const safetyDefinitionReceiptSchema = productDefinitionReceiptSchema.omit({ productId: true, modelId: true }).extend({
  scopeKey: safetyDefinitionSelectionSchema.shape.scopeKey, policyId: safetyDefinitionSelectionSchema.shape.draftPolicyId,
}).strict();
export const safetyDefinitionProgressSchema = productDefinitionProgressSchema.extend({ receipt: safetyDefinitionReceiptSchema }).strict();
export type SafetyDefinitionSelection = z.infer<typeof safetyDefinitionSelectionSchema>;
export type SafetyDefinitionReview = z.infer<typeof safetyDefinitionReviewSchema>;
export type ApplySafetyDefinition = z.infer<typeof applySafetyDefinitionSchema>;
export type SafetyDefinitionReceipt = z.infer<typeof safetyDefinitionReceiptSchema>;
export type SafetyDefinitionProgress = z.infer<typeof safetyDefinitionProgressSchema>;
