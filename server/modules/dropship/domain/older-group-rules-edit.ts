import { isDeepStrictEqual } from "node:util";
import type { EbayCategoryRule, EbayCategoryRulesDraft } from "../../../../shared/dropship/ebay-category-rules";
import type { ContentProfile } from "../../../../shared/dropship/listing-content";
import type { PricingProfile } from "../../../../shared/dropship/pricing-rules";
import { DropshipError } from "./errors";

/**
 * Older group rules are closed (Listing settings PR 12, plan D9-D10; PROPOSAL).
 *
 * A store's older group rules (pricing groups, description groups, eBay
 * category rules) can still be kept as they are, removed, or moved over from
 * the sheet, but never added, changed or (eBay) reordered. No page offers
 * them any more, and a group added after a conversion would be invisible to
 * the hourly job (`S/infrastructure/dropship-rules-conversion-job.source.ts`),
 * so the level can only shrink. The rule below decides it; the writers W1
 * (pricing review and apply), W3 (eBay review and save) and W4 (description
 * templates save) call it after their replay probe and revision check.
 *
 * Pure: no I/O, no clock, inputs never mutated (CLAUDE.md §3, §4). Both lists
 * are already parsed: `stored` by the read's state schema, `requested` by the
 * route's input schema, which refuse duplicate ids on each side.
 */

export const DROPSHIP_LISTING_GROUP_RULES_CLOSED = "DROPSHIP_LISTING_GROUP_RULES_CLOSED";

/**
 * Each id list in the refusal's context holds at most this many ids. A group
 * list holds at most 100 (`pricingProfileSchema`, `contentProfileSchema`,
 * `MAX_EBAY_CATEGORY_RULES`), so a request from a route is never cut; the bound
 * keeps the error small for any other caller.
 */
export const MAX_GROUP_RULE_IDS_IN_REFUSAL = 100;

// Interim (PR 12 PROPOSAL): the same words as the client's LISTING_SETTINGS_SAVE_WORDS.groupRulesClosed (plan 3.1, 8).
export const GROUP_RULES_CLOSED_MESSAGE =
  "Older group rules can't be added or changed any more. Nothing was saved. Use See what changes on Listing settings to move them over.";

export type OlderGroupRulesKind = "pricing" | "description" | "ebay_category";
export type PricingGroupRule = PricingProfile["groups"][number];
export type DescriptionGroupRule = ContentProfile["groups"][number];
export type EbayCategoryRuleDraft = EbayCategoryRulesDraft["rules"][number];

export interface OlderGroupRulesEdit {
  /** True when the request keeps every group it names exactly as stored (eBay: in stored order) and adds none. */
  allowed: boolean;
  /** Requested ids the stored list does not hold, in requested order. A repeated requested id counts as added again. */
  addedIds: string[];
  /** Ids in both lists whose compared values differ, in requested order. */
  changedIds: string[];
  /** eBay only: the kept rules are not in their stored relative order (order is precedence). Always false for the others. */
  reordered: boolean;
}

/**
 * What a save or review does to the store's older group rules.
 *
 * - Pricing and description groups compare by id with deep equality of the
 *   whole parsed group; their order is free (both resolvers sort by priority,
 *   then id).
 * - eBay rules compare `{ id, name, scope, categoryId }`, the stored side's
 *   category id being `category.categoryId` (a draft names categories by
 *   number only). Order is precedence (the first matching rule wins), so the
 *   kept rules must keep their stored relative order.
 * - An empty request is always allowed; a store with no profile allows only
 *   an empty request (every requested id is added).
 */
export function olderGroupRulesEdit(kind: "pricing", stored: readonly PricingGroupRule[],
  requested: readonly PricingGroupRule[]): OlderGroupRulesEdit;
export function olderGroupRulesEdit(kind: "description", stored: readonly DescriptionGroupRule[],
  requested: readonly DescriptionGroupRule[]): OlderGroupRulesEdit;
export function olderGroupRulesEdit(kind: "ebay_category", stored: readonly EbayCategoryRule[],
  requested: readonly EbayCategoryRuleDraft[]): OlderGroupRulesEdit;
export function olderGroupRulesEdit(
  kind: OlderGroupRulesKind,
  stored: readonly (PricingGroupRule | DescriptionGroupRule | EbayCategoryRule)[],
  requested: readonly (PricingGroupRule | DescriptionGroupRule | EbayCategoryRuleDraft)[],
): OlderGroupRulesEdit {
  const storedById = new Map<string, { index: number; value: unknown }>();
  stored.forEach((rule, index) => {
    // The schemas refuse duplicate ids; should one slip through, the first is the stored rule.
    if (!storedById.has(rule.id)) storedById.set(rule.id, { index, value: comparedValue(kind, rule) });
  });
  const addedIds: string[] = [];
  const changedIds: string[] = [];
  const seen = new Set<string>();
  const keptStoredIndexes: number[] = [];
  for (const rule of requested) {
    const held = storedById.get(rule.id);
    if (!held || seen.has(rule.id)) {
      // Not stored, or named twice: the second one is a group the store does not hold.
      addedIds.push(rule.id);
      continue;
    }
    seen.add(rule.id);
    if (!isDeepStrictEqual(comparedValue(kind, rule), held.value)) changedIds.push(rule.id);
    keptStoredIndexes.push(held.index);
  }
  const reordered = kind === "ebay_category" && !isIncreasing(keptStoredIndexes);
  return { allowed: addedIds.length === 0 && changedIds.length === 0 && !reordered, addedIds, changedIds, reordered };
}

/**
 * The permanent refusal (plan 3.1): 422 at every route, never retried, raised
 * before anything is written. Its context carries ids only, never a group's
 * name or text (P11 3.5).
 */
export function olderGroupRulesClosed(storeConnectionId: number, kind: OlderGroupRulesKind, edit: OlderGroupRulesEdit): DropshipError {
  return new DropshipError(DROPSHIP_LISTING_GROUP_RULES_CLOSED, GROUP_RULES_CLOSED_MESSAGE, {
    storeConnectionId,
    kind,
    addedIds: edit.addedIds.slice(0, MAX_GROUP_RULE_IDS_IN_REFUSAL),
    changedIds: edit.changedIds.slice(0, MAX_GROUP_RULE_IDS_IN_REFUSAL),
    reordered: edit.reordered,
    retryable: false,
    classification: "permanent",
  });
}

/** The value two rules with one id are compared by: the whole group, or for eBay the fields a draft can send. */
function comparedValue(kind: OlderGroupRulesKind, rule: PricingGroupRule | DescriptionGroupRule | EbayCategoryRule | EbayCategoryRuleDraft): unknown {
  if (kind !== "ebay_category") return rule;
  const ebay = rule as EbayCategoryRule | EbayCategoryRuleDraft;
  const categoryId = "category" in ebay ? ebay.category.categoryId : ebay.categoryId;
  return { id: ebay.id, name: ebay.name, scope: ebay.scope, categoryId };
}

function isIncreasing(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}
