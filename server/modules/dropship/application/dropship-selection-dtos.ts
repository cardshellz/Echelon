import { z } from "zod";
import type {
  DropshipVendorSelectionAction,
  DropshipVendorSelectionScope,
} from "../domain/vendor-selection";

const positiveIdSchema = z.number().int().positive();
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const nullablePositiveIdSchema = positiveIdSchema.nullable().optional();

export const dropshipVendorSelectionScopeSchema = z.enum([
  "catalog",
  "product_line",
  "category",
  "product",
  "variant",
]);

export const dropshipVendorSelectionActionSchema = z.enum(["include", "exclude"]);

export const dropshipVendorCatalogActorSchema = z.object({
  actorType: z.enum(["vendor", "admin", "system"]),
  actorId: z.string().trim().min(1).max(255).optional(),
}).strict();

export const replaceDropshipVendorSelectionRuleSchema = z.object({
  scopeType: dropshipVendorSelectionScopeSchema,
  action: dropshipVendorSelectionActionSchema.default("include"),
  productLineId: nullablePositiveIdSchema,
  productId: nullablePositiveIdSchema,
  productVariantId: nullablePositiveIdSchema,
  category: z.string().trim().min(1).max(200).nullable().optional(),
  autoConnectNewSkus: z.boolean().default(true),
  autoListNewSkus: z.boolean().default(false),
  priority: z.number().int().min(-100000).max(100000).default(0),
  metadata: z.record(z.unknown()).optional(),
}).strict().superRefine((rule, context) => {
  const normalizedTargets = [
    rule.productLineId,
    rule.productId,
    rule.productVariantId,
    rule.category?.trim() || null,
  ].filter((value) => value !== null && value !== undefined);

  const targetMatchesScope =
    (rule.scopeType === "catalog" && normalizedTargets.length === 0)
    || (rule.scopeType === "product_line" && typeof rule.productLineId === "number" && normalizedTargets.length === 1)
    || (rule.scopeType === "category" && typeof rule.category === "string" && normalizedTargets.length === 1)
    || (rule.scopeType === "product" && typeof rule.productId === "number" && normalizedTargets.length === 1)
    || (rule.scopeType === "variant" && typeof rule.productVariantId === "number" && normalizedTargets.length === 1);

  if (!targetMatchesScope) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Rule target must match its scope exactly.",
      path: ["scopeType"],
    });
  }
});

export const replaceDropshipVendorSelectionRulesInputSchema = z.object({
  vendorId: positiveIdSchema,
  idempotencyKey: idempotencyKeySchema,
  actor: dropshipVendorCatalogActorSchema,
  rules: z.array(replaceDropshipVendorSelectionRuleSchema).max(500),
}).strict().superRefine((input, context) => {
  const keys = new Set<string>();
  input.rules.forEach((rule, index) => {
    const key = vendorSelectionRuleDedupeKey(rule);
    if (keys.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Duplicate vendor selection rule.",
        path: ["rules", index],
      });
    }
    keys.add(key);
  });
});

export const listDropshipVendorSelectionRulesInputSchema = z.object({
  vendorId: positiveIdSchema,
  includeInactive: z.boolean().default(false),
}).strict();

export const previewDropshipVendorCatalogInputSchema = z.object({
  vendorId: positiveIdSchema,
  search: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(200).optional(),
  productLineId: positiveIdSchema.optional(),
  selectedOnly: z.boolean().default(false),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();

export type ReplaceDropshipVendorSelectionRule = z.infer<typeof replaceDropshipVendorSelectionRuleSchema>;
export type ReplaceDropshipVendorSelectionRulesInput = z.infer<typeof replaceDropshipVendorSelectionRulesInputSchema>;
export type ListDropshipVendorSelectionRulesInput = z.infer<typeof listDropshipVendorSelectionRulesInputSchema>;
export type PreviewDropshipVendorCatalogInput = z.infer<typeof previewDropshipVendorCatalogInputSchema>;

function vendorSelectionRuleDedupeKey(rule: {
  scopeType: DropshipVendorSelectionScope;
  action: DropshipVendorSelectionAction;
  productLineId?: number | null;
  productId?: number | null;
  productVariantId?: number | null;
  category?: string | null;
}): string {
  return [
    rule.scopeType,
    rule.action,
    rule.productLineId ?? "",
    rule.productId ?? "",
    rule.productVariantId ?? "",
    rule.category?.trim().toLowerCase() ?? "",
  ].join(":");
}
