import { z } from "zod";

const catalogId = z.number().int().positive().max(2_147_483_647);
export const MAX_NAMED_CATALOG_GROUP_ITEMS = 10_000;
export const CATALOG_TARGET_PAGE_SIZE = 50;
export const catalogTargetsInputSchema = z.object({ type: z.enum(["category", "product_line", "product", "listings"]),
  search: z.string().trim().max(100).default(""), page: z.number().int().min(0).max(200).default(0) }).strict();
export const catalogTargetsResponseSchema = z.object({ total: z.number().int().nonnegative(),
  rows: z.array(z.object({ id: z.string(), name: z.string() }).strict()).max(CATALOG_TARGET_PAGE_SIZE) }).strict();
export const catalogScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("category"), category: z.string().trim().min(1).max(255) }).strict(),
  z.object({ type: z.literal("product_line"), productLineId: catalogId }).strict(),
  z.object({ type: z.literal("product"), productId: catalogId }).strict(),
  z.object({ type: z.literal("listings"), productVariantIds: z.array(catalogId).min(1).max(MAX_NAMED_CATALOG_GROUP_ITEMS)
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate listings are not allowed.") }).strict(),
]);
export type CatalogScope = z.infer<typeof catalogScopeSchema>;
export interface CatalogScopeCandidate {
  productVariantId: number;
  productId: number;
  category: string | null;
  productLineIds: readonly number[];
}
export function matchesCatalogScope(scope: CatalogScope, candidate: CatalogScopeCandidate): boolean {
  switch (scope.type) {
    case "category": return candidate.category === scope.category;
    case "product_line": return candidate.productLineIds.includes(scope.productLineId);
    case "product": return candidate.productId === scope.productId;
    case "listings": return scope.productVariantIds.includes(candidate.productVariantId);
  }
}
