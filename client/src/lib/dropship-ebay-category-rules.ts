import {
  ebayCategoryBrowseResponseSchema,
  ebayCategoryRulesDraftSchema,
  ebayCategoryRulesReviewSchema,
  ebayCategoryRulesStateSchema,
  ebayCategorySearchResponseSchema,
  MAX_EBAY_CATEGORY_QUERY_LENGTH,
  MAX_EBAY_CATEGORY_RULES,
  MIN_EBAY_CATEGORY_QUERY_LENGTH,
  saveEbayCategoryRulesResponseSchema,
  type EbayCategory,
  type EbayCategoryBrowseResult,
  type EbayCategoryOption,
  type EbayCategoryRulesDraft,
  type EbayCategoryRulesReview,
  type EbayCategoryRulesState,
  type EbayCategorySource,
} from "@shared/dropship/ebay-category-rules";
import { MAX_NAMED_CATALOG_GROUP_ITEMS, type CatalogScope } from "@shared/dropship/catalog-scope";
import { buildQueryUrl, fetchJson, postJson, putJson } from "./dropship-ops-surface";

/**
 * Vendor eBay category rules, as the Catalog page edits them.
 * Contract: shared/dropship/ebay-category-rules.ts. Design: docs/DROPSHIP-VENDOR-CATALOG-REDESIGN.md §7.
 *
 * The editor keeps eBay's name and path beside each category so the vendor
 * always sees words, never a bare number. The server is sent category numbers
 * only and looks every name up at eBay itself.
 */

/** Returned by the server when the store's eBay connection must be refreshed before eBay can be asked. */
export const EBAY_CATEGORIES_PERMISSION_REQUIRED = "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED";
/** Returned when the saved rules changed after the editor loaded them (another tab or person). */
export const EBAY_CATEGORY_RULES_VERSION_CONFLICT = "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT";

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
  | { ok: false; message: string; ruleId: string | null };

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

export function addEbayCategoryRule(draft: EbayCategoryRulesEditorDraft, id: string): EbayCategoryRulesEditorDraft {
  if (draft.rules.length >= MAX_EBAY_CATEGORY_RULES) return draft;
  return { ...draft, rules: [...draft.rules, { id, name: "", scope: { type: "category", category: "" }, category: null }] };
}

export function updateEbayCategoryRule(
  draft: EbayCategoryRulesEditorDraft,
  id: string,
  patch: Partial<Omit<EbayCategoryRuleEditorRow, "id">>,
): EbayCategoryRulesEditorDraft {
  return { ...draft, rules: draft.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)) };
}

export function removeEbayCategoryRule(draft: EbayCategoryRulesEditorDraft, id: string): EbayCategoryRulesEditorDraft {
  return { ...draft, rules: draft.rules.filter((rule) => rule.id !== id) };
}

/** Moves a rule one place up (-1) or down (+1). Moving past either end changes nothing. */
export function moveEbayCategoryRule(draft: EbayCategoryRulesEditorDraft, id: string, direction: -1 | 1): EbayCategoryRulesEditorDraft {
  const from = draft.rules.findIndex((rule) => rule.id === id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= draft.rules.length) return draft;
  const rules = [...draft.rules];
  [rules[from], rules[to]] = [rules[to], rules[from]];
  return { ...draft, rules };
}

export function setEbayDefaultCategory(draft: EbayCategoryRulesEditorDraft, category: EbayCategory | null): EbayCategoryRulesEditorDraft {
  return { ...draft, defaultCategory: category ? copyCategory(category) : null };
}

export function namedListingCount(draft: EbayCategoryRulesEditorDraft): number {
  return draft.rules.reduce((total, rule) => total + (rule.scope.type === "listings" ? rule.scope.productVariantIds.length : 0), 0);
}

/** True when the two drafts would save the same rules (names are compared as the server trims them). */
export function sameEbayCategoryDraft(left: EbayCategoryRulesEditorDraft, right: EbayCategoryRulesEditorDraft): boolean {
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

/**
 * Checks the draft before anything is sent and builds the request body. Each
 * refusal names the rule in words the vendor recognizes; the shared schema is
 * the final gate, so the browser can never send a draft the server refuses on shape.
 */
export function checkEbayCategoryDraft(draft: EbayCategoryRulesEditorDraft): EbayCategoryDraftCheck {
  for (const [index, rule] of draft.rules.entries()) {
    const label = ruleLabel(rule, index);
    if (!rule.name.trim()) return refuse(`Name ${label}.`, rule.id);
    if (!scopeChosen(rule.scope)) return refuse(`Choose what ${label} applies to.`, rule.id);
    if (!rule.category) return refuse(`Pick an eBay category for ${label}.`, rule.id);
  }
  const groups = new Map<string, EbayCategoryRuleEditorRow>();
  for (const [index, rule] of draft.rules.entries()) {
    const key = groupKey(rule.scope);
    if (!key) continue;
    const earlier = groups.get(key);
    if (earlier) {
      return refuse(`${capitalize(ruleLabel(rule, index))} targets the same group as rule "${earlier.name.trim()}". `
        + "Keep one rule per category, product line or product.", rule.id);
    }
    groups.set(key, rule);
  }
  if (namedListingCount(draft) > MAX_NAMED_CATALOG_GROUP_ITEMS) {
    return refuse(`Rules can name up to ${MAX_NAMED_CATALOG_GROUP_ITEMS.toLocaleString("en-US")} listings in total. `
      + "Use a category, product line or product rule for broader coverage.", null);
  }
  const parsed = ebayCategoryRulesDraftSchema.safeParse({
    defaultCategoryId: draft.defaultCategory?.categoryId ?? null,
    rules: draft.rules.map((rule) => ({
      id: rule.id,
      name: rule.name.trim(),
      scope: rule.scope,
      categoryId: rule.category?.categoryId,
    })),
  });
  if (!parsed.success) return refuse(parsed.error.issues[0]?.message ?? "Check the eBay category rules.", null);
  return { ok: true, draft: parsed.data };
}

export function categoryPathLabel(category: Pick<EbayCategory, "categoryName" | "path">): string {
  return category.path.length > 0 ? category.path.join(" › ") : category.categoryName;
}

/** Where a listing's eBay category came from, in the vendor's words. */
export function ebayCategorySourceLabel(source: EbayCategorySource, ruleName: string | null | undefined): string {
  switch (source) {
    case "rule": return ruleName ? `From your rule "${ruleName}"` : "From one of your rules";
    case "store_default": return "From your store default";
    case "catalog": return "From the Card Shellz category";
    case "none": return "No eBay category yet";
  }
}

export interface EbayCategoryReviewSummary {
  headline: string;
  details: string[];
}

/** The impact review as plain sentences, shown before the vendor confirms a save. */
export function describeEbayCategoryReview(review: EbayCategoryRulesReview): EbayCategoryReviewSummary {
  if (review.selectedCount === 0) {
    return {
      headline: "No listings are selected in this store yet.",
      details: ["The rules apply to listings as you select them."],
    };
  }
  const headline = review.changedCount === 0
    ? `No listing changes eBay category. ${plural(review.selectedCount, "selected listing")} checked.`
    : `${review.changedCount.toLocaleString("en-US")} of ${plural(review.selectedCount, "selected listing")} `
      + `${review.changedCount === 1 ? "changes" : "change"} eBay category.`;
  const details: string[] = [];
  const gained = review.withoutCategoryBefore - review.withoutCategoryAfter;
  if (gained > 0) details.push(`${plural(gained, "listing")} without an eBay category now get one.`);
  if (review.withoutCategoryAfter > 0) {
    details.push(`${plural(review.withoutCategoryAfter, "listing")} still ${review.withoutCategoryAfter === 1 ? "has" : "have"} no eBay category `
      + "and cannot be published until a rule or your store default covers them.");
  }
  const sources = [
    [review.bySource.rule, "from your rules"],
    [review.bySource.store_default, "from your store default"],
    [review.bySource.catalog, "from Card Shellz categories"],
  ] as const;
  const used = sources.filter(([count]) => count > 0).map(([count, label]) => `${count.toLocaleString("en-US")} ${label}`);
  if (used.length > 0) details.push(`After saving: ${used.join(" · ")}.`);
  return { headline, details };
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

export async function fetchEbayCategoryRules(storeConnectionId: number): Promise<EbayCategoryRulesState> {
  return ebayCategoryRulesStateSchema.parse(await fetchJson(ebayCategoryRulesEndpoint(storeConnectionId)));
}

export async function reviewEbayCategoryRules(
  storeConnectionId: number,
  input: { expectedRevisionId: number | null; draft: EbayCategoryRulesDraft },
): Promise<EbayCategoryRulesReview> {
  return ebayCategoryRulesReviewSchema.parse(await postJson(`${ebayCategoryRulesEndpoint(storeConnectionId)}/review`, input));
}

export async function saveEbayCategoryRules(
  storeConnectionId: number,
  input: { expectedRevisionId: number | null; draft: EbayCategoryRulesDraft; idempotencyKey: string },
) {
  return saveEbayCategoryRulesResponseSchema.parse(await putJson(ebayCategoryRulesEndpoint(storeConnectionId), input));
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

/** The scope picker emits placeholders (empty category, id 0, no listings) until a target is chosen. */
function scopeChosen(scope: CatalogScope): boolean {
  switch (scope.type) {
    case "category": return scope.category.trim().length > 0;
    case "product_line": return scope.productLineId > 0;
    case "product": return scope.productId > 0;
    case "listings": return scope.productVariantIds.length > 0;
  }
}

/** Same grouping the server refuses twice (shared/dropship/ebay-category-rules.ts). Named listings never collide. */
function groupKey(scope: CatalogScope): string | null {
  switch (scope.type) {
    case "category": return `category:${scope.category}`;
    case "product_line": return `product_line:${scope.productLineId}`;
    case "product": return `product:${scope.productId}`;
    case "listings": return null;
  }
}

function ruleLabel(rule: EbayCategoryRuleEditorRow, index: number): string {
  const name = rule.name.trim();
  return name ? `rule "${name}"` : `rule ${index + 1}`;
}

function comparable(draft: EbayCategoryRulesEditorDraft) {
  return {
    defaultCategoryId: draft.defaultCategory?.categoryId ?? null,
    rules: draft.rules.map((rule) => ({ id: rule.id, name: rule.name.trim(), scope: rule.scope, categoryId: rule.category?.categoryId ?? null })),
  };
}

function refuse(message: string, ruleId: string | null): EbayCategoryDraftCheck {
  return { ok: false, message, ruleId };
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
