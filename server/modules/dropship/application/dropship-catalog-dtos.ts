import { z } from "zod";
import type {
  DropshipCatalogExposureAction,
  DropshipCatalogExposureScope,
} from "../domain/catalog-exposure";

const positiveIdSchema = z.number().int().positive();
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const nullablePositiveIdSchema = positiveIdSchema.nullable().optional();
const nullableStringSchema = z.string().trim().min(1).max(2000).nullable().optional();
const nullableDateSchema = z.preprocess(
  (value) => (value === "" || value === undefined ? null : value),
  z.coerce.date().nullable(),
).optional();

export const dropshipCatalogExposureScopeSchema = z.enum([
  "catalog",
  "product_line",
  "category",
  "product",
  "variant",
]);

export const dropshipCatalogExposureActionSchema = z.enum(["include", "exclude"]);

export const dropshipAdminActorSchema = z.object({
  actorType: z.enum(["admin", "system"]),
  actorId: z.string().trim().min(1).max(255).optional(),
}).strict();

export const replaceDropshipCatalogExposureRuleSchema = z.object({
  scopeType: dropshipCatalogExposureScopeSchema,
  action: dropshipCatalogExposureActionSchema.default("include"),
  productLineId: nullablePositiveIdSchema,
  productId: nullablePositiveIdSchema,
  productVariantId: nullablePositiveIdSchema,
  category: z.string().trim().min(1).max(200).nullable().optional(),
  priority: z.number().int().min(-100000).max(100000).default(0),
  startsAt: nullableDateSchema,
  endsAt: nullableDateSchema,
  notes: nullableStringSchema,
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

  if (rule.startsAt && rule.endsAt && rule.endsAt.getTime() <= rule.startsAt.getTime()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "endsAt must be after startsAt.",
      path: ["endsAt"],
    });
  }
});

export const replaceDropshipCatalogExposureRulesInputSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  actor: dropshipAdminActorSchema,
  rules: z.array(replaceDropshipCatalogExposureRuleSchema).max(500),
}).strict().superRefine((input, context) => {
  const keys = new Set<string>();
  input.rules.forEach((rule, index) => {
    const key = catalogExposureRuleDedupeKey(rule);
    if (keys.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Duplicate catalog exposure rule.",
        path: ["rules", index],
      });
    }
    keys.add(key);
  });
});

export const listDropshipCatalogExposureRulesInputSchema = z.object({
  includeInactive: z.boolean().default(false),
}).strict();

export const previewDropshipCatalogExposureInputSchema = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(200).optional(),
  productLineId: positiveIdSchema.optional(),
  includeInactiveCatalog: z.boolean().default(false),
  exposedOnly: z.boolean().default(false),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();

export type ReplaceDropshipCatalogExposureRule = z.infer<typeof replaceDropshipCatalogExposureRuleSchema>;
export type ReplaceDropshipCatalogExposureRulesInput = z.infer<typeof replaceDropshipCatalogExposureRulesInputSchema>;
export type ListDropshipCatalogExposureRulesInput = z.infer<typeof listDropshipCatalogExposureRulesInputSchema>;
export type PreviewDropshipCatalogExposureInput = z.infer<typeof previewDropshipCatalogExposureInputSchema>;

function catalogExposureRuleDedupeKey(rule: {
  scopeType: DropshipCatalogExposureScope;
  action: DropshipCatalogExposureAction;
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
