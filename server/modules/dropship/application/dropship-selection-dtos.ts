import { z } from "zod";
import {
  DROPSHIP_CATALOG_IDS_PURPOSES,
  DROPSHIP_CATALOG_SELECTION_FILTERS,
} from "../../../../shared/dropship/vendor-catalog-reads";
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

/**
 * The filters every catalog GET applies before the selection is decided:
 * search, the category name (kept one release), the category id (step 1 plan
 * S2-5 §4.8), product lines and product.
 */
const catalogFilterFields = {
  vendorId: positiveIdSchema,
  search: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(200).optional(),
  categoryId: positiveIdSchema.optional(),
  productLineId: positiveIdSchema.optional(),
  productLineIds: z.array(positiveIdSchema).max(50).optional(),
  productId: positiveIdSchema.optional(),
  /** Which rows by selection; absent means `selectedOnly`'s answer (§4.8). */
  selection: z.enum(DROPSHIP_CATALOG_SELECTION_FILTERS).optional(),
  /** The one-release alias of `selection: "selected"`, for a page of stage 1. `selection` wins when both are sent. */
  selectedOnly: z.boolean().default(false),
};

export const previewDropshipVendorCatalogInputSchema = z.object({
  ...catalogFilterFields,
  /** The facet scan is a second full scan; the new page sends false and reads the categories GET instead (TESTS9). */
  includeFacets: z.boolean().default(true),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();

/** `GET /api/dropship/catalog?idsOnly=true`: the same filters, no paging, and what the ids are for. */
export const listDropshipVendorCatalogIdsInputSchema = z.object({
  ...catalogFilterFields,
  purpose: z.enum(DROPSHIP_CATALOG_IDS_PURPOSES),
}).strict();

/** `GET /api/dropship/catalog/categories`: the whole exposed catalog, no filters (D26). */
export const listDropshipVendorCatalogCategoriesInputSchema = z.object({
  vendorId: positiveIdSchema,
}).strict();

/** `GET /api/dropship/catalog/selection`: the vendor's selection count, split for one store when named. */
export const readDropshipVendorSelectionSummaryInputSchema = z.object({
  vendorId: positiveIdSchema,
  storeConnectionId: positiveIdSchema.nullable(),
}).strict();

export type ReplaceDropshipVendorSelectionRule = z.infer<typeof replaceDropshipVendorSelectionRuleSchema>;
export type ReplaceDropshipVendorSelectionRulesInput = z.infer<typeof replaceDropshipVendorSelectionRulesInputSchema>;
export type ListDropshipVendorSelectionRulesInput = z.infer<typeof listDropshipVendorSelectionRulesInputSchema>;
export type PreviewDropshipVendorCatalogInput = z.infer<typeof previewDropshipVendorCatalogInputSchema>;
export type ListDropshipVendorCatalogIdsInput = z.infer<typeof listDropshipVendorCatalogIdsInputSchema>;
export type ReadDropshipVendorSelectionSummaryInput = z.infer<typeof readDropshipVendorSelectionSummaryInputSchema>;
/** The filters a candidate scan applies in SQL (every catalog GET's filter fields apart from the selection). */
export type DropshipVendorCatalogCandidateFilter = Pick<
  PreviewDropshipVendorCatalogInput,
  "vendorId" | "search" | "category" | "categoryId" | "productLineId" | "productLineIds" | "productId"
>;

/** The selection filter a catalog GET applies: `selection` when sent, else `selectedOnly`'s alias. */
export function resolveCatalogSelectionFilter(input: { selection?: z.infer<typeof catalogFilterFields.selection>; selectedOnly: boolean }) {
  return input.selection ?? (input.selectedOnly ? "selected" : "all");
}

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
