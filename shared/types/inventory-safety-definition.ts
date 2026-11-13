import { z } from "zod";
import { productDefinitionReviewSchema, productDefinitionReceiptSchema, productDefinitionProgressSchema } from "./inventory-product-definition";
import { promiseSafetyAdminScopeSchema, promiseSafetyAdminValueSchema } from "./inventory-promise-safety-admin";

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

/**
 * One-step set (owner decision 2026-11-07: a save takes effect). The server
 * saves the setting, checks what it changes and applies it in ONE transaction;
 * a refused or failed set leaves no saved version behind.
 */
export const setSafetyDefinitionSchema = z.object({
  scope: promiseSafetyAdminScopeSchema,
  value: promiseSafetyAdminValueSchema,
  /** The head revision the operator was shown; null when this scope has never had a setting. */
  expectedHeadRevision: z.string().regex(/^(0|[1-9]\d{0,18})$/).nullable(),
  changeReason: z.string().trim().max(1000).nullable().optional().transform(value => (value ? value : null)),
  /** 100, not 120: the version row stores it behind a fixed prefix in a 120-character column. */
  idempotencyKey: z.string().trim().min(1).max(100),
}).strict().superRefine((command, context) => {
  if (command.scope.scopeType === "business" && command.value.policyMode === "inherit") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["value", "policyMode"],
      message: "The business setting cannot inherit from another scope." });
  }
});

/** What a committed set did: the receipt an apply returns, plus the availability it changed. */
export const safetyDefinitionSetResultSchema = z.object({
  receipt: safetyDefinitionReceiptSchema,
  affectedProducts: z.number().int().nonnegative(),
  /** Only SKU/warehouse rows whose available quantity moved, capped; `changedRows` is the full count. */
  changes: z.array(z.object({ sku: z.string().nullable(), warehouseName: z.string(),
    current: z.string().regex(/^(0|[1-9]\d*)$/).nullable(), proposed: z.string().regex(/^(0|[1-9]\d*)$/) }).strict()).max(50),
  changedRows: z.number().int().nonnegative(),
  skippedDestinations: z.array(z.string()),
}).strict();

const overviewSetting = z.object({
  scopeKey: safetyDefinitionSelectionSchema.shape.scopeKey,
  /** Fence for the next set of this scope. */
  revision: z.string().regex(/^(0|[1-9]\d{0,18})$/),
  /** The setting in effect; null when a version was saved for this scope but never applied. */
  value: promiseSafetyAdminValueSchema.nullable(),
  updatedAt: z.string().datetime().nullable(),
  updatedBy: z.string().nullable(),
  /** A version saved in the older three-step screen and never applied. It has no effect. */
  hasUnappliedChange: z.boolean(),
}).strict();

/** Everything the Available stock screen shows: the business setting and every SKU-level one. */
export const promiseSafetyOverviewSchema = z.object({
  runtimeAuthority: z.enum(["legacy", "canonical"]),
  business: overviewSetting.nullable(),
  exceptions: z.array(overviewSetting.extend({
    productId: z.number().int().positive(), productName: z.string(),
    productVariantId: z.number().int().positive(), sku: z.string().nullable(), variantName: z.string(),
    unitsPerVariant: z.number().int().positive(),
    /** Set only for a per-warehouse setting. */
    warehouseId: z.number().int().positive().nullable(), warehouseCode: z.string().nullable(),
  }).strict()).max(5000),
}).strict();

export type SafetyDefinitionSelection = z.infer<typeof safetyDefinitionSelectionSchema>;
export type SetSafetyDefinition = z.infer<typeof setSafetyDefinitionSchema>;
export type SafetyDefinitionSetResult = z.infer<typeof safetyDefinitionSetResultSchema>;
export type PromiseSafetyOverview = z.infer<typeof promiseSafetyOverviewSchema>;
export type SafetyDefinitionReview = z.infer<typeof safetyDefinitionReviewSchema>;
export type ApplySafetyDefinition = z.infer<typeof applySafetyDefinitionSchema>;
export type SafetyDefinitionReceipt = z.infer<typeof safetyDefinitionReceiptSchema>;
export type SafetyDefinitionProgress = z.infer<typeof safetyDefinitionProgressSchema>;
