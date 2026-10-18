import {
  ebayCategoryBrowseResponseSchema,
  ebayCategoryRulesDraftSchema,
  ebayCategorySearchResponseSchema,
  MAX_EBAY_CATEGORY_QUERY_LENGTH,
  MIN_EBAY_CATEGORY_QUERY_LENGTH,
  type EbayCategory,
  type EbayCategoryBrowseResult,
  type EbayCategoryOption,
  type EbayCategoryRulesDraft,
  type EbayCategoryRulesState,
  type EbayCategorySource,
} from "@shared/dropship/ebay-category-rules";
import type { CatalogScope } from "@shared/dropship/catalog-scope";
import { buildQueryUrl, fetchJson } from "./dropship-ops-surface";

/**
 * Vendor eBay category rules on the client: the editor model the store
 * default eBay category save builds its body from (every saved rule sent back
 * unchanged, `prepareEbayCategoryDefaultSave`), the eBay category picker's
 * search and browse reads, and step 3's source words.
 * Contract: shared/dropship/ebay-category-rules.ts. Design: docs/DROPSHIP-VENDOR-CATALOG-REDESIGN.md §7.
 *
 * The editor keeps eBay's name and path beside each category so the vendor
 * always sees words, never a bare number. The server is sent category numbers
 * only and looks every name up at eBay itself.
 */

/** Returned by the server when the store's eBay connection must be refreshed before eBay can be asked. */
export const EBAY_CATEGORIES_PERMISSION_REQUIRED = "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED";

export interface EbayCategoryRuleEditorRow {
  id: string;
  name: string;
  scope: CatalogScope;
  category: EbayCategory | null;
}

export interface EbayCategoryRulesEditorDraft {
  defaultCategory: EbayCategory | null;
  /** Order is precedence: the first rule that matches a listing wins. */
  rules: EbayCategoryRuleEditorRow[];
}

export type EbayCategoryDraftCheck =
  | { ok: true; draft: EbayCategoryRulesDraft }
  | { ok: false };

export function editorDraftFromState(state: EbayCategoryRulesState): EbayCategoryRulesEditorDraft {
  return {
    defaultCategory: state.profile?.defaultCategory ? copyCategory(state.profile.defaultCategory) : null,
    rules: (state.profile?.rules ?? []).map((rule) => ({
      id: rule.id,
      name: rule.name,
      scope: copyScope(rule.scope),
      category: copyCategory(rule.category),
    })),
  };
}

/** A picked option as the editor stores it. The leaf flag only matters while picking. */
export function categoryFromOption(option: EbayCategoryOption): EbayCategory {
  return { categoryId: option.categoryId, categoryName: option.categoryName, path: [...option.path] };
}

export function setEbayDefaultCategory(draft: EbayCategoryRulesEditorDraft, category: EbayCategory | null): EbayCategoryRulesEditorDraft {
  return { ...draft, defaultCategory: category ? copyCategory(category) : null };
}

/**
 * The request body for a draft, or not ok when the shared draft schema (the
 * server's own) refuses it, so the browser never sends a draft the server
 * refuses on shape: a rule with no name, no target or no category, two rules
 * on one group, or more than 10,000 named listings. It names no rule: since
 * Listing settings PR 12 the only caller sends the saved rules back unchanged
 * with a new store default, and says one sentence for any refusal
 * (`prepareEbayCategoryDefaultSave`; review DUX3).
 */
export function checkEbayCategoryDraft(draft: EbayCategoryRulesEditorDraft): EbayCategoryDraftCheck {
  const parsed = ebayCategoryRulesDraftSchema.safeParse({
    defaultCategoryId: draft.defaultCategory?.categoryId ?? null,
    rules: draft.rules.map((rule) => ({
      id: rule.id,
      name: rule.name.trim(),
      scope: rule.scope,
      categoryId: rule.category?.categoryId,
    })),
  });
  return parsed.success ? { ok: true, draft: parsed.data } : { ok: false };
}

export function categoryPathLabel(category: Pick<EbayCategory, "categoryName" | "path">): string {
  return category.path.length > 0 ? category.path.join(" › ") : category.categoryName;
}

/** Where a listing's eBay category came from, in the vendor's words. */
export function ebayCategorySourceLabel(source: EbayCategorySource, ruleName: string | null | undefined): string {
  switch (source) {
    // Interim (PR 12 PROPOSAL): the step's and the sheet's name for these rules (drawerSourceWords).
    case "rule": return ruleName ? `From your older group rule “${ruleName}”` : "From one of your older group rules";
    // Interim (PR 10 PROPOSAL), in the drawer's words (`drawerSourceWords`): a product's own category is
    // set in Listing settings; a Card Shellz category's is named by the category when a name is given
    // (the preview row carries none, dropship-ebay-category-resolver `fromSetting`), never by an id; the
    // catalog's own pick says so, so it can't be mistaken for the category's setting (mS3 b.1).
    case "product": return "Set in Listing settings";
    case "category": return ruleName ? `From category: ${ruleName}` : "From its Card Shellz category";
    case "store_default": return "From your store default";
    case "catalog": return "Card Shellz picks";
    case "none": return "No eBay category yet";
  }
}

export function ebayCategoryRulesEndpoint(storeConnectionId: number): string {
  return `/api/dropship/listings/stores/${storeConnectionId}/ebay-category-rules`;
}

function ebayCategoriesEndpoint(storeConnectionId: number): string {
  return `/api/dropship/listings/stores/${storeConnectionId}/ebay-categories`;
}

/** Queries the server refuses are never sent: they would only spend the vendor's rate limit. */
export function isSearchableEbayCategoryQuery(query: string): boolean {
  const trimmed = query.trim();
  return trimmed.length >= MIN_EBAY_CATEGORY_QUERY_LENGTH && trimmed.length <= MAX_EBAY_CATEGORY_QUERY_LENGTH;
}

export async function searchEbayCategories(storeConnectionId: number, query: string, signal?: AbortSignal): Promise<EbayCategoryOption[]> {
  const url = buildQueryUrl(`${ebayCategoriesEndpoint(storeConnectionId)}/search`, { q: query.trim() });
  return ebayCategorySearchResponseSchema.parse(await fetchJson(url, { signal })).categories;
}

export async function browseEbayCategories(
  storeConnectionId: number,
  parentId: string | null,
  signal?: AbortSignal,
): Promise<EbayCategoryBrowseResult> {
  const url = buildQueryUrl(ebayCategoriesEndpoint(storeConnectionId), { parentId });
  return ebayCategoryBrowseResponseSchema.parse(await fetchJson(url, { signal }));
}

function copyCategory(category: EbayCategory): EbayCategory {
  return { categoryId: category.categoryId, categoryName: category.categoryName, path: [...category.path] };
}

function copyScope(scope: CatalogScope): CatalogScope {
  return scope.type === "listings" ? { type: "listings", productVariantIds: [...scope.productVariantIds] } : { ...scope };
}
