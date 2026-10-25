/**
 * Catalog step 1, "Choose what to sell" (step 1 stage 1, "The checkbox is the
 * choice"): the checkbox is the vendor's choice, checking or unchecking only
 * marks a change, and one "Save changes" sends every add and remove together.
 * Nothing changes on eBay before Save.
 *
 * This module holds the step's rules, with no React, no network and no clock:
 * - the answers the step reads (catalog page, selection rules), as Zod schemas;
 * - the change set (`reduceChooseChanges`): one mark per changed size;
 * - the row model (`chooseRowView`) and the header box (`shownTick`);
 * - what the bar says after a save (`ChooseBarOutcome`, `describeChooseMove`);
 * - the save builder (`buildChooseSelectionSave`): the vendor's saved rules,
 *   untouched except for the marked sizes, in the compact form the server
 *   stores and hashes exactly as the full form (see `toSelectionRuleInput`);
 * - the stops before sending (`chooseSaveBlock`): the server's 500-rule cap and
 *   its 100 KiB body limit;
 * - the stale check (`rulesFingerprint`, `sameRuleContent`), the error classes
 *   (`classifyChooseSaveError`) and the paging helpers.
 *
 * Stage 1 writes `variant` rules only: one-time picks (owner Q3). It never
 * writes a category, product line or catalog-wide rule, and never sends a
 * product line (owner Q2).
 */
import { z } from "zod";
import { DROPSHIP_CATALOG_READ_ERROR_CODES } from "@shared/dropship/vendor-catalog-reads";
import { DropshipApiError } from "./dropship-ops-surface";
import { CHOOSE_WORDS } from "./dropship-catalog-choose-words";

/** The leave guard's id for step 1's unsaved changes; not a Listing settings id (`listing-settings:`). */
export const CHOOSE_GUARD_ID = "catalog-choose";
/** Rows read per "Load more": the most the catalog read allows (`limit` ≤ 200, dropship-selection-dtos.ts). */
export const CHOOSE_PAGE_SIZE = 200;
/** At most this many rows are shown: no windowing library is installed, and 1,000 rows stay usable without one. */
export const CHOOSE_MAX_ROWS_SHOWN = 1_000;
/** Typing pauses this long before the list is searched, as step 2 does (LISTING_SETTINGS_SEARCH_DEBOUNCE_MS). */
export const CHOOSE_SEARCH_PAUSE_MS = 300;
/** The catalog read's `search` and `category` are 1..200 characters (dropship-selection-dtos.ts). */
export const CHOOSE_SEARCH_MAX_LENGTH = 200;
/** The server's cap on rules in one save (`rules: z.array(...).max(500)`, dropship-selection-dtos.ts). Owner Q4 keeps it. */
export const MAX_SELECTION_RULES = 500;
/**
 * The global JSON body limit the save goes through (`GLOBAL_JSON_LIMIT_BYTES`,
 * rate-table-admin-body.middleware.ts); the route is not a bulk path. A body
 * above it is refused with 413 before the route runs.
 */
export const SELECTION_SAVE_BODY_LIMIT_BYTES = 100 * 1024;
/** The longest idempotency key the server accepts (`min(8).max(200)`); the size check measures with one this long. */
export const SELECTION_SAVE_KEY_MAX_LENGTH = 200;
/** One save is sent at most this many times, always with the same key and body. */
export const CHOOSE_SAVE_MAX_TRIES = 3;
/** The pause before the second and third send. */
export const CHOOSE_SAVE_BACKOFF_MS: readonly number[] = Object.freeze([1_000, 2_000]);
/** Today's pick shapes (the step's former builder): an include outranks older broad rules, a keep-out outranks it. */
export const PICK_INCLUDE_PRIORITY = 100;
export const PICK_EXCLUDE_PRIORITY = 200;
export const PICK_RULE_SOURCE = "portal_catalog";

// ---------------------------------------------------------------------------
// What the step reads
// ---------------------------------------------------------------------------

/** The server's reasons, exactly (`DropshipVendorCatalogSelectionReason`, domain/vendor-selection.ts). */
export const chooseSelectionReasonSchema = z.enum([
  "selected",
  "not_exposed_by_admin",
  "excluded_by_vendor_rule",
  "missing_vendor_include_rule",
  "disabled_by_vendor_override",
]);
export type ChooseSelectionReason = z.infer<typeof chooseSelectionReasonSchema>;

const ruleIdSchema = z.number().int().positive();
const countSchema = z.number().int().nonnegative();

/** The server's listing tiers, exactly (`DROPSHIP_LISTING_TIERS`, domain/listing-tiers.ts); pinned by the server contract test. */
export const chooseListingTierNameSchema = z.enum(["pack", "case"]);
/** The server's tier block reasons, exactly (`DropshipListingTierBlockReason`, domain/listing-tiers.ts); pinned likewise. */
export const chooseListingTierReasonSchema = z.enum(["autopay_off", "reserve_below_tier", "balance_below_tier"]);

/**
 * A catalog row as step 1 reads it. Unknown fields are dropped, so the
 * product-line fields the server still sends never reach the table (owner Q2).
 */
export const chooseCatalogRowSchema = z.object({
  productId: ruleIdSchema,
  productVariantId: ruleIdSchema,
  productSku: z.string().nullable(),
  productName: z.string(),
  variantSku: z.string().nullable(),
  variantName: z.string(),
  category: z.string().nullable(),
  selectionDecision: z.object({
    selected: z.boolean(),
    reason: chooseSelectionReasonSchema,
    marketplaceQuantity: countSchema,
    // The rules that matched this size when the row was read (domain/vendor-selection.ts): the How column and the
    // builder reason from them.
    includeRuleIds: z.array(ruleIdSchema),
    excludeRuleIds: z.array(ruleIdSchema),
  }),
  listingTier: z.object({
    tier: chooseListingTierNameSchema,
    eligible: z.boolean(),
    reason: chooseListingTierReasonSchema.nullable(),
    policyMinimumCents: countSchema,
    reserveShortfallCents: countSchema,
    balanceShortfallCents: countSchema,
  }).optional(),
});
export type ChooseCatalogRow = z.infer<typeof chooseCatalogRowSchema>;

export const chooseCategoryFacetSchema = z.object({ category: z.string(), label: z.string(), rowCount: countSchema });
export type ChooseCategoryFacet = z.infer<typeof chooseCategoryFacetSchema>;

/** One page of `GET /api/dropship/catalog`. The product and product-line facets are dropped (owner Q2; no Product menu). */
export const chooseCatalogPageSchema = z.object({
  rows: z.array(chooseCatalogRowSchema),
  total: countSchema,
  page: z.number().int().min(1),
  limit: z.number().int().min(1),
  facets: z.object({ categories: z.array(chooseCategoryFacetSchema) }),
});
export type ChooseCatalogPage = z.infer<typeof chooseCatalogPageSchema>;

/** The server's scopes and actions (`dropshipVendorSelectionScopeSchema`, `…ActionSchema`, dropship-selection-dtos.ts); pinned likewise. */
export const chooseSelectionScopeSchema = z.enum(["catalog", "product_line", "category", "product", "variant"]);
export const chooseSelectionActionSchema = z.enum(["include", "exclude"]);

/** One saved rule as `GET /api/dropship/catalog/selection-rules` returns it (columns NOT NULL except metadata, migration 0086). */
export const chooseSelectionRuleSchema = z.object({
  id: ruleIdSchema,
  revisionId: z.number().int().nullable().optional(),
  scopeType: chooseSelectionScopeSchema,
  action: chooseSelectionActionSchema,
  productLineId: ruleIdSchema.nullable().optional(),
  productId: ruleIdSchema.nullable().optional(),
  productVariantId: ruleIdSchema.nullable().optional(),
  category: z.string().nullable().optional(),
  autoConnectNewSkus: z.boolean(),
  autoListNewSkus: z.boolean(),
  priority: z.number().int(),
  metadata: z.record(z.unknown()).nullable().optional(),
  isActive: z.boolean(),
});
export type ChooseSelectionRule = z.infer<typeof chooseSelectionRuleSchema>;

export const chooseSelectionRulesResponseSchema = z.object({ rules: z.array(chooseSelectionRuleSchema) });
export type ChooseSelectionRulesResponse = z.infer<typeof chooseSelectionRulesResponseSchema>;

/** A rule as the save sends it: only its one target, no ids (`replaceDropshipVendorSelectionRuleSchema`). */
export interface ChooseRuleInput {
  scopeType: ChooseSelectionRule["scopeType"];
  action: ChooseSelectionRule["action"];
  productLineId?: number;
  productId?: number;
  productVariantId?: number;
  category?: string;
  autoConnectNewSkus: boolean;
  autoListNewSkus: boolean;
  priority: number;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The change set
// ---------------------------------------------------------------------------

export type ChooseTarget = "selected" | "not_selected";

/** The row's saved decision when the change was marked: what the builder reasons from. */
export interface ChooseBasis {
  reason: ChooseSelectionReason;
  includeRuleIds: readonly number[];
  excludeRuleIds: readonly number[];
}

export interface ChooseMark {
  productVariantId: number;
  to: ChooseTarget;
  basis: ChooseBasis;
}

export interface ChooseChanges {
  /** One per changed size, ascending by productVariantId; never a mark equal to the saved state. */
  marks: readonly ChooseMark[];
  /** `rulesFingerprint` of the rules shown when the first mark was made; null with no marks. */
  baseFingerprint: string | null;
}

/** The rules the page shows: their fingerprint and the rules by id (own pick vs older rule). */
export interface ChooseRulesView {
  fingerprint: string;
  byId: ReadonlyMap<number, ChooseSelectionRule>;
}

export type ChooseChangesAction =
  | { type: "toggle"; row: ChooseCatalogRow; rules: ChooseRulesView }
  | { type: "setShown"; rows: readonly ChooseCatalogRow[]; checked: boolean; rules: ChooseRulesView }
  | { type: "reconcile"; rows: readonly ChooseCatalogRow[]; rules: ChooseRulesView | null }
  /**
   * The rules moved (another tab, or an earlier save of ours whose answer was lost). `committedMarksKey` is that earlier
   * save's `chooseMarksKey` when it went through: those marks are saved, so they go whether their rows are loaded or not.
   */
  | { type: "rebase"; rows: readonly ChooseCatalogRow[]; rules: ChooseRulesView; committedMarksKey?: string }
  | { type: "undo" }
  | { type: "saved" };

export const EMPTY_CHOOSE_CHANGES: ChooseChanges = Object.freeze({ marks: Object.freeze([]) as readonly ChooseMark[], baseFingerprint: null });

/** The view of the rules the page holds: active rules only (the read returns active rules; a stray inactive one never counts). */
export function chooseRulesView(rules: readonly ChooseSelectionRule[]): ChooseRulesView {
  const active = rules.filter((rule) => rule.isActive !== false);
  return { fingerprint: rulesFingerprint(active), byId: new Map(active.map((rule) => [rule.id, rule])) };
}

function isOwnPick(rule: Pick<ChooseSelectionRule, "scopeType" | "productVariantId">, productVariantId: number): boolean {
  return rule.scopeType === "variant" && rule.productVariantId === productVariantId;
}

/**
 * A size turned off for the vendor whose matching includes hold their own pick of it. The server checks the override
 * only after an include matched (domain/vendor-selection.ts), so the pick stays saved, counts toward the cap, and
 * selects the size again once the override is lifted: it is the vendor's choice, and the box shows and removes it
 * (verify V6).
 */
function isTurnedOffOwnPick(row: ChooseCatalogRow, rulesById: ReadonlyMap<number, ChooseSelectionRule>): boolean {
  return row.selectionDecision.reason === "disabled_by_vendor_override" && row.selectionDecision.includeRuleIds.some((id) => {
    const rule = rulesById.get(id);
    return rule !== undefined && rule.action === "include" && isOwnPick(rule, row.productVariantId);
  });
}

/**
 * The box's saved state: checked when the size is selected, and when it is turned off for the vendor while their own
 * pick of it is saved (the How words say it can't be sold now). With the rules not known, selected only.
 */
function savedTarget(row: ChooseCatalogRow, rulesById: ReadonlyMap<number, ChooseSelectionRule> | null): ChooseTarget {
  if (row.selectionDecision.reason === "selected") return "selected";
  return rulesById !== null && isTurnedOffOwnPick(row, rulesById) ? "selected" : "not_selected";
}

/**
 * Whether the vendor can change this row with its box. A size Card Shellz no
 * longer offers, or one an older broad rule keeps out, cannot be: exclude
 * always wins (domain/vendor-selection.ts), so a pick could not select it. A
 * size turned off for them can only lose their own pick of it (remove only:
 * its box is checked, see `savedTarget`); with no own pick it cannot be
 * changed. An exclusion whose rules are not all in `rulesById` (the row was
 * read under other rules) counts as changeable; the builder then treats its
 * basis as not fresh.
 */
export function isChangeableRow(row: ChooseCatalogRow, rulesById: ReadonlyMap<number, ChooseSelectionRule>): boolean {
  const { reason, excludeRuleIds } = row.selectionDecision;
  if (reason === "selected" || reason === "missing_vendor_include_rule") return true;
  if (reason === "disabled_by_vendor_override") return isTurnedOffOwnPick(row, rulesById);
  if (reason !== "excluded_by_vendor_rule") return false;
  return excludeRuleIds.every((id) => {
    const rule = rulesById.get(id);
    return rule === undefined || isOwnPick(rule, row.productVariantId);
  });
}

function basisOf(row: ChooseCatalogRow): ChooseBasis {
  return {
    reason: row.selectionDecision.reason,
    includeRuleIds: [...row.selectionDecision.includeRuleIds],
    excludeRuleIds: [...row.selectionDecision.excludeRuleIds],
  };
}

function sameBasis(left: ChooseBasis, right: ChooseBasis): boolean {
  return left.reason === right.reason
    && sameNumbers(left.includeRuleIds, right.includeRuleIds)
    && sameNumbers(left.excludeRuleIds, right.excludeRuleIds);
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** New marks sorted by size, with the fingerprint rule: set on 0 → 1, kept while marks remain, cleared at 0. */
function withMarks(changes: ChooseChanges, marks: ChooseMark[], fingerprint: string | null): ChooseChanges {
  if (marks.length === 0) return changes.marks.length === 0 ? changes : EMPTY_CHOOSE_CHANGES;
  marks.sort((left, right) => left.productVariantId - right.productVariantId);
  return { marks, baseFingerprint: changes.marks.length === 0 ? fingerprint : changes.baseFingerprint };
}

/**
 * Step 1's change set. Pure: never mutates its input, and returns the same
 * object when nothing changes (so a reload that changes nothing re-renders
 * nothing).
 */
export function reduceChooseChanges(changes: ChooseChanges, action: ChooseChangesAction): ChooseChanges {
  switch (action.type) {
    case "toggle": {
      const { row, rules } = action;
      if (!isChangeableRow(row, rules.byId)) return changes;
      const existing = changes.marks.find((mark) => mark.productVariantId === row.productVariantId);
      const marks = changes.marks.filter((mark) => mark.productVariantId !== row.productVariantId);
      if (!existing) {
        marks.push({ productVariantId: row.productVariantId, to: savedTarget(row, rules.byId) === "selected" ? "not_selected" : "selected", basis: basisOf(row) });
      }
      return withMarks(changes, marks, rules.fingerprint);
    }
    case "setShown": {
      const target: ChooseTarget = action.checked ? "selected" : "not_selected";
      const byId = new Map(changes.marks.map((mark) => [mark.productVariantId, mark]));
      let changed = false;
      for (const row of action.rows) {
        if (!isChangeableRow(row, action.rules.byId)) continue;
        const existing = byId.get(row.productVariantId);
        if (savedTarget(row, action.rules.byId) === target) {
          if (existing) { byId.delete(row.productVariantId); changed = true; }
        } else if (!existing || existing.to !== target) {
          byId.set(row.productVariantId, { productVariantId: row.productVariantId, to: target, basis: basisOf(row) });
          changed = true;
        }
      }
      return changed ? withMarks(changes, Array.from(byId.values()), action.rules.fingerprint) : changes;
    }
    case "reconcile":
      return reconcileMarks(changes, action.rows, action.rules);
    case "rebase": {
      const reconciled = reconcileMarks(withoutCommitted(changes, action.committedMarksKey), action.rows, action.rules);
      if (reconciled.marks.length === 0) return reconciled;
      if (reconciled.baseFingerprint === action.rules.fingerprint) return reconciled;
      return { marks: reconciled.marks, baseFingerprint: action.rules.fingerprint };
    }
    case "undo":
    case "saved":
      return changes.marks.length === 0 && changes.baseFingerprint === null ? changes : EMPTY_CHOOSE_CHANGES;
    default: {
      const unknownAction: never = action;
      throw new Error(`Unknown catalog choose action: ${JSON.stringify(unknownAction)}`);
    }
  }
}

/** The marks without those an earlier save sent and committed (`"id:to"` in `committedMarksKey`). */
function withoutCommitted(changes: ChooseChanges, committedMarksKey: string | undefined): ChooseChanges {
  if (!committedMarksKey || changes.marks.length === 0) return changes;
  const committed = new Set(committedMarksKey.split(","));
  const marks = changes.marks.filter((mark) => !committed.has(`${mark.productVariantId}:${mark.to}`));
  if (marks.length === changes.marks.length) return changes;
  return marks.length === 0 ? EMPTY_CHOOSE_CHANGES : { marks, baseFingerprint: changes.baseFingerprint };
}

/**
 * An add whose basis names an older broad keep-out the rules now hold: exclude always wins, so no save could apply it
 * (the builder refuses it). The row may have been read under rules that did not hold that keep-out yet.
 */
function keptOutByOlderRule(mark: ChooseMark, rulesById: ReadonlyMap<number, ChooseSelectionRule>): boolean {
  return mark.to === "selected" && mark.basis.excludeRuleIds.some((id) => {
    const rule = rulesById.get(id);
    return rule !== undefined && !isOwnPick(rule, mark.productVariantId);
  });
}

/**
 * Rows read again: each loaded row's mark is dropped when the row now reads
 * as the mark wants (saved here or in another tab) or when it can no longer be
 * changed (turned off with no own pick to remove, or kept out by an older
 * broad rule: no save could apply it); otherwise its basis is refreshed from
 * the row. With the rules not known, a turned-off row counts as unchangeable. A mark whose row is not
 * loaded stays as it is, unless the rules now show its add can never apply
 * (review MC8: it would otherwise keep Save refused with nothing on screen to
 * say which change is stuck).
 */
function reconcileMarks(changes: ChooseChanges, rows: readonly ChooseCatalogRow[], rules: ChooseRulesView | null): ChooseChanges {
  if (changes.marks.length === 0) return changes;
  const rowsById = new Map(rows.map((row) => [row.productVariantId, row]));
  let changed = false;
  const marks: ChooseMark[] = [];
  for (const mark of changes.marks) {
    const row = rowsById.get(mark.productVariantId);
    if (!row) {
      if (rules !== null && keptOutByOlderRule(mark, rules.byId)) { changed = true; continue; }
      marks.push(mark);
      continue;
    }
    const byId = rules?.byId ?? null;
    const unchangeable = row.selectionDecision.reason === "not_exposed_by_admin"
      || (byId !== null ? !isChangeableRow(row, byId) : row.selectionDecision.reason === "disabled_by_vendor_override");
    if (savedTarget(row, byId) === mark.to || unchangeable) { changed = true; continue; }
    const basis = basisOf(row);
    if (sameBasis(basis, mark.basis)) { marks.push(mark); continue; }
    marks.push({ ...mark, basis });
    changed = true;
  }
  if (!changed) return changes;
  return marks.length === 0 ? EMPTY_CHOOSE_CHANGES : { marks, baseFingerprint: changes.baseFingerprint };
}

/**
 * What a save did, from the rows read again after it (review MC4, CT3): a mark
 * whose reloaded row reads as marked took; one whose row still reads otherwise
 * did not (turned off for the vendor, or an older include that still selects
 * it), and its row's How words say why. A mark whose row is not loaded, or
 * every mark when the rows couldn't be read again (`rowsAfter` null), counts
 * as sent: its rule was saved, but its effect is not checked here. "Took" is
 * about selling: an add took when the size now reads selected (a pick on a
 * size turned off for the vendor is saved but did not take), a remove when it
 * no longer does.
 */
export function chooseSaveResult(
  marks: readonly ChooseMark[],
  rowsAfter: readonly ChooseCatalogRow[] | null,
): { add: number; remove: number; notTaken: number } {
  const rowsById = new Map((rowsAfter ?? []).map((row) => [row.productVariantId, row]));
  let add = 0;
  let remove = 0;
  let notTaken = 0;
  for (const mark of marks) {
    const row = rowsById.get(mark.productVariantId);
    const sellsNow = row?.selectionDecision.reason === "selected";
    if (row && sellsNow !== (mark.to === "selected")) notTaken += 1;
    else if (mark.to === "selected") add += 1;
    else remove += 1;
  }
  return { add, remove, notTaken };
}

/** What the bar says after a save, until the next change. `notTaken`: saved changes whose rows still don't read as marked. */
export type ChooseBarOutcome =
  | { kind: "saved"; add: number; remove: number; notTaken: number }
  /** Good news with nothing left to do, in the status line (verify V1). */
  | { kind: "info"; message: string }
  /** `reload`: the bar offers Reload beside the words (a save refused because this page is out of date, §4.9 item 2). */
  | { kind: "error"; message: string; reload?: true };

/**
 * The bar after a press that found the saved rules moved: an earlier save of
 * ours whose answer was lost went through (`committedEarlier`), or another tab
 * saved (`stale`); the marks were then rebased on the rules read again. Marks
 * left: the vendor reviews them and saves again. None left: nothing failed, so
 * it is never an error (verify V1): our earlier save is told as a save, with
 * what took; another tab's save that already matches is told as such.
 */
export function describeChooseMove(
  moved: "committedEarlier" | "stale",
  marksLeft: number,
  sent: readonly ChooseMark[],
  rowsAfter: readonly ChooseCatalogRow[] | null,
): ChooseBarOutcome {
  if (marksLeft > 0) return { kind: "error", message: moved === "stale" ? CHOOSE_WORDS.stale : CHOOSE_WORDS.lastSaveWentThrough };
  if (moved === "committedEarlier") return { kind: "saved", ...chooseSaveResult(sent, rowsAfter) };
  return { kind: "info", message: CHOOSE_WORDS.staleNothingLeft };
}

export function chooseCounts(changes: Pick<ChooseChanges, "marks">): { add: number; remove: number } {
  let add = 0;
  for (const mark of changes.marks) if (mark.to === "selected") add += 1;
  return { add, remove: changes.marks.length - add };
}

/** The marks as "id:to" joined ascending: one save attempt is reused only for exactly these marks. */
export function chooseMarksKey(marks: readonly ChooseMark[]): string {
  return [...marks]
    .sort((left, right) => left.productVariantId - right.productVariantId)
    .map((mark) => `${mark.productVariantId}:${mark.to}`)
    .join(",");
}

// ---------------------------------------------------------------------------
// The row model
// ---------------------------------------------------------------------------

/** The How column's state; the words are CHOOSE_WORDS.how[key]. */
export type ChooseHow =
  | "willAdd"
  | "willRemove"
  | "picked"
  | "olderInclude"
  | "removed"
  | "olderExclude"
  | "notSelected"
  | "turnedOff"
  | "notOffered"
  | "selected"
  | "keptOut";

export interface ChooseRowView {
  /** Saved selected, or marked to add. */
  checked: boolean;
  changed: "add" | "remove" | null;
  /** False while the rules load, and for rows no pick can change. */
  changeable: boolean;
  how: ChooseHow;
  /** The marketplace quantity of a selected size; null for every other reason (the server sends 0 for those). */
  quantity: number | null;
  /** A selected size whose listing tier is not on sale (the tier badge). */
  tierOff: boolean;
}

/**
 * One row as the table shows it. "Own pick" is a `variant` rule for this size
 * among the row's matching rules; any other matching rule is an older,
 * broader setting (category, product, product line or catalog rules from older
 * data), named generically (owner Q2, Q3). Rule ids the page does not hold
 * (rules still loading, or the row read under other rules) fall back to the
 * plain "Selected" / "Kept out".
 */
export function chooseRowView(
  row: ChooseCatalogRow,
  mark: ChooseMark | null | undefined,
  rulesById: ReadonlyMap<number, ChooseSelectionRule> | null,
): ChooseRowView {
  const { reason, marketplaceQuantity, includeRuleIds, excludeRuleIds } = row.selectionDecision;
  const savedChecked = savedTarget(row, rulesById) === "selected";
  const quantity = reason === "selected" ? marketplaceQuantity : null;
  const tierOff = reason === "selected" && row.listingTier !== undefined && !row.listingTier.eligible;
  const changeable = rulesById !== null && isChangeableRow(row, rulesById);
  if (mark) {
    return { checked: mark.to === "selected", changed: mark.to === "selected" ? "add" : "remove", changeable, how: mark.to === "selected" ? "willAdd" : "willRemove", quantity, tierOff };
  }
  return { checked: savedChecked, changed: null, changeable, how: savedHow(row.productVariantId, reason, includeRuleIds, excludeRuleIds, rulesById), quantity, tierOff };
}

function savedHow(
  productVariantId: number,
  reason: ChooseSelectionReason,
  includeRuleIds: readonly number[],
  excludeRuleIds: readonly number[],
  rulesById: ReadonlyMap<number, ChooseSelectionRule> | null,
): ChooseHow {
  if (reason === "missing_vendor_include_rule") return "notSelected";
  if (reason === "disabled_by_vendor_override") return "turnedOff";
  // Defensive: the catalog read drops rows Card Shellz does not offer (dropship-selection-atp-service.ts).
  if (reason === "not_exposed_by_admin") return "notOffered";
  if (reason === "selected") {
    if (rulesById === null) return "selected";
    if (includeRuleIds.some((id) => { const rule = rulesById.get(id); return rule !== undefined && isOwnPick(rule, productVariantId); })) return "picked";
    return includeRuleIds.length > 0 && includeRuleIds.every((id) => rulesById.has(id)) ? "olderInclude" : "selected";
  }
  if (rulesById === null) return "keptOut";
  const known = excludeRuleIds.map((id) => rulesById.get(id)).filter((rule): rule is ChooseSelectionRule => rule !== undefined);
  if (known.some((rule) => !isOwnPick(rule, productVariantId))) return "olderExclude";
  return excludeRuleIds.length > 0 && known.length === excludeRuleIds.length ? "removed" : "keptOut";
}

export type ChooseShownTick = "all" | "some" | "none";

/**
 * The header box over the rows shown: "all" when every changeable row is
 * checked, "some" when some are, "none" otherwise; `changeable` 0 turns it off.
 * A click on "all" unchecks them (`setShown(false)`), otherwise checks them.
 */
export function shownTick(
  rows: readonly ChooseCatalogRow[],
  changes: Pick<ChooseChanges, "marks">,
  rulesById: ReadonlyMap<number, ChooseSelectionRule> | null,
): { tick: ChooseShownTick; changeable: number } {
  if (rulesById === null) return { tick: "none", changeable: 0 };
  const marks = new Map(changes.marks.map((mark) => [mark.productVariantId, mark]));
  let changeable = 0;
  let checked = 0;
  for (const row of rows) {
    if (!isChangeableRow(row, rulesById)) continue;
    changeable += 1;
    if (chooseRowView(row, marks.get(row.productVariantId), rulesById).checked) checked += 1;
  }
  const tick: ChooseShownTick = changeable > 0 && checked === changeable ? "all" : checked > 0 ? "some" : "none";
  return { tick, changeable };
}

// ---------------------------------------------------------------------------
// The save
// ---------------------------------------------------------------------------

/** A mark the builder cannot apply: a programming error, never sent (the page never makes one). */
export class ChooseBuildRefusal extends Error {
  readonly code = "DROPSHIP_CATALOG_CHOOSE_MARK_REFUSED";
  readonly productVariantId: number;
  constructor(productVariantId: number, why: string) {
    super(`Catalog choose mark for size ${productVariantId} refused: ${why}`);
    this.name = "ChooseBuildRefusal";
    this.productVariantId = productVariantId;
  }
}

/**
 * A saved rule in the compact form the save sends: its one target only, the
 * category trimmed, flags, priority and `metadata ?? {}`; null targets are
 * left out. The server turns an omitted target into null and an omitted
 * metadata into {} before it hashes or stores (`normalizeVendorSelectionRule`),
 * so this stores and hashes exactly what the full form did, and 500 rules fit
 * the 100 KiB body (the full form fits about 450).
 */
export function toSelectionRuleInput(rule: Omit<ChooseSelectionRule, "id" | "isActive"> | ChooseRuleInput): ChooseRuleInput {
  const category = rule.category?.trim();
  return {
    scopeType: rule.scopeType,
    action: rule.action,
    ...(typeof rule.productLineId === "number" ? { productLineId: rule.productLineId } : {}),
    ...(typeof rule.productId === "number" ? { productId: rule.productId } : {}),
    ...(typeof rule.productVariantId === "number" ? { productVariantId: rule.productVariantId } : {}),
    ...(category ? { category } : {}),
    autoConnectNewSkus: rule.autoConnectNewSkus,
    autoListNewSkus: rule.autoListNewSkus,
    priority: rule.priority,
    metadata: rule.metadata ?? {},
  };
}

function pickRule(productVariantId: number, action: "include" | "exclude"): ChooseRuleInput {
  return {
    scopeType: "variant",
    action,
    productVariantId,
    autoConnectNewSkus: action === "include",
    autoListNewSkus: false,
    priority: action === "include" ? PICK_INCLUDE_PRIORITY : PICK_EXCLUDE_PRIORITY,
    metadata: { source: PICK_RULE_SOURCE },
  };
}

/** The server's duplicate key (`vendorSelectionRuleDedupeKey`, dropship-selection-dtos.ts). */
function ruleDedupeKey(rule: ChooseRuleInput): string {
  return [
    rule.scopeType,
    rule.action,
    rule.productLineId ?? "",
    rule.productId ?? "",
    rule.productVariantId ?? "",
    rule.category?.trim().toLowerCase() ?? "",
  ].join(":");
}

/**
 * The rules one save sends: `rules` (just read again) untouched except for the
 * marked sizes, plus the rules the marks need. Order: the existing rules in the
 * server's order, then new rules by ascending size. Pure and deterministic.
 *
 * Per mark, with `own(v)` = active `variant` rules for the size, and the basis
 * fresh when every rule id it names is still active:
 * - Add: drop own excludes; keep an own include, or add one, unless the basis
 *   is fresh and holds an older broad include (dropping the keep-out is then
 *   enough). A basis kept out by an older broad rule is refused: exclude always
 *   wins, so no pick could select it.
 * - Remove: drop own includes. Fresh and no broad include: nothing else, so
 *   the pick is gone and its slot freed. Fresh with a broad include, or a basis
 *   not fresh (the row was read under other rules and is not on screen now):
 *   add a keep-out unless one exists. An exclude always ends "not selected"
 *   whatever else matches; the cost is one slot.
 * Two rules the server would call duplicates are never sent: the first is
 * kept (both mean the same thing; a duplicate would be a permanent 400).
 */
export function buildChooseSelectionSave(rules: readonly ChooseSelectionRule[], marks: readonly ChooseMark[]): ChooseRuleInput[] {
  const active = rules.filter((rule) => rule.isActive !== false);
  const byId = new Map(active.map((rule) => [rule.id, rule]));
  const dropped = new Set<number>();
  const added: ChooseRuleInput[] = [];
  for (const mark of uniqueMarks(marks)) {
    const size = mark.productVariantId;
    const own = active.filter((rule) => isOwnPick(rule, size));
    const ownIncludes = own.filter((rule) => rule.action === "include");
    const ownExcludes = own.filter((rule) => rule.action === "exclude");
    const fresh = [...mark.basis.includeRuleIds, ...mark.basis.excludeRuleIds].every((id) => byId.has(id));
    const broadInclude = mark.basis.includeRuleIds.some((id) => { const rule = byId.get(id); return rule !== undefined && !isOwnPick(rule, size); });
    if (mark.to === "selected") {
      if (keptOutByOlderRule(mark, byId)) throw new ChooseBuildRefusal(size, "an older broad rule keeps it out");
      for (const rule of ownExcludes) dropped.add(rule.id);
      if (ownIncludes.length === 0 && !(fresh && broadInclude)) added.push(pickRule(size, "include"));
    } else {
      for (const rule of ownIncludes) dropped.add(rule.id);
      // A fresh basis with no broad include needs nothing more: deleting the pick leaves the size "Not selected".
      if ((!fresh || broadInclude) && ownExcludes.length === 0) added.push(pickRule(size, "exclude"));
    }
  }
  const kept = active.filter((rule) => !dropped.has(rule.id)).map((rule) => toSelectionRuleInput(rule));
  added.sort((left, right) => (left.productVariantId ?? 0) - (right.productVariantId ?? 0)
    || (left.action === right.action ? 0 : left.action === "include" ? -1 : 1));
  const seen = new Set<string>();
  const out: ChooseRuleInput[] = [];
  for (const rule of [...kept, ...added]) {
    const key = ruleDedupeKey(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rule);
  }
  return out;
}

/** Marks by size, sorted; the same size twice in one direction counts once, in both directions it is refused. */
function uniqueMarks(marks: readonly ChooseMark[]): ChooseMark[] {
  const bySize = new Map<number, ChooseMark>();
  for (const mark of marks) {
    if (!Number.isSafeInteger(mark.productVariantId) || mark.productVariantId <= 0) {
      throw new ChooseBuildRefusal(mark.productVariantId, "not a size id");
    }
    const existing = bySize.get(mark.productVariantId);
    if (existing && existing.to !== mark.to) throw new ChooseBuildRefusal(mark.productVariantId, "marked both ways");
    if (!existing) bySize.set(mark.productVariantId, mark);
  }
  return Array.from(bySize.values()).sort((left, right) => left.productVariantId - right.productVariantId);
}

export type ChooseSaveBlock =
  | { kind: "tooManyRules"; count: number }
  | { kind: "tooLarge" }
  | { kind: "refused" };

/** UTF-8 bytes of the save body with the longest key the server allows, so the real body is never larger. */
export function chooseSaveBodyBytes(rules: readonly ChooseRuleInput[]): number {
  return new TextEncoder().encode(JSON.stringify({ idempotencyKey: "k".repeat(SELECTION_SAVE_KEY_MAX_LENGTH), rules })).length;
}

/**
 * Why this save must not be sent, or null. The bar shows it live as soon as
 * the marks would pass a limit, and the save runner checks it again on the
 * rules just read, so the vendor never presses into a refusal.
 */
export function chooseSaveBlock(rules: readonly ChooseSelectionRule[], marks: readonly ChooseMark[]): ChooseSaveBlock | null {
  let built: ChooseRuleInput[];
  try {
    built = buildChooseSelectionSave(rules, marks);
  } catch (error) {
    if (error instanceof ChooseBuildRefusal) return { kind: "refused" };
    throw error;
  }
  if (built.length > MAX_SELECTION_RULES) return { kind: "tooManyRules", count: built.length };
  if (chooseSaveBodyBytes(built) > SELECTION_SAVE_BODY_LIMIT_BYTES) return { kind: "tooLarge" };
  return null;
}

/** The vendor's words for a block. */
export function describeChooseSaveBlock(block: ChooseSaveBlock): string {
  if (block.kind === "tooManyRules") return CHOOSE_WORDS.tooManyChoices(block.count, MAX_SELECTION_RULES);
  if (block.kind === "tooLarge") return CHOOSE_WORDS.tooLarge;
  return CHOOSE_WORDS.rejected;
}

// ---------------------------------------------------------------------------
// Another tab: the fingerprint and the content compare
// ---------------------------------------------------------------------------

/**
 * The active rule ids, ascending and joined ("" for none). Every committed
 * save that keeps a rule re-inserts every rule with new ids
 * (dropship-selection-atp.repository.ts), so any save changes it; the nullable
 * `revisionId` is not used. Two empty sets compare equal, and a save on either
 * builds on the same empty set.
 */
export function rulesFingerprint(rules: readonly Pick<ChooseSelectionRule, "id" | "isActive">[]): string {
  return rules
    .filter((rule) => rule.isActive !== false)
    .map((rule) => rule.id)
    .sort((left, right) => left - right)
    .join(",");
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((sorted, key) => {
      sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
      return sorted;
    }, {});
  }
  return value;
}

/** The server's canonical rule (`hashVendorSelectionRules` over `normalizeVendorSelectionRule`), as a string. */
function canonicalRule(rule: ChooseRuleInput): string {
  return JSON.stringify({
    scopeType: rule.scopeType,
    action: rule.action,
    productLineId: rule.productLineId ?? null,
    productId: rule.productId ?? null,
    productVariantId: rule.productVariantId ?? null,
    category: rule.category?.trim() || null,
    autoConnectNewSkus: rule.autoConnectNewSkus,
    autoListNewSkus: rule.autoListNewSkus,
    priority: rule.priority,
    metadata: sortJsonValue(rule.metadata ?? {}),
  });
}

/**
 * True when two rule sets hold the same rules in the server's canonical
 * fields, in any order and in full or compact form: how the page tells "our
 * earlier save went through" (the rules now are what it sent, under new ids)
 * from "another tab saved".
 */
export function sameRuleContent(
  left: readonly (ChooseSelectionRule | ChooseRuleInput)[],
  right: readonly (ChooseSelectionRule | ChooseRuleInput)[],
): boolean {
  const canonical = (rules: readonly (ChooseSelectionRule | ChooseRuleInput)[]) => rules
    .filter((rule) => !("isActive" in rule) || rule.isActive !== false)
    .map((rule) => canonicalRule(toSelectionRuleInput(rule)))
    .sort();
  const a = canonical(left);
  const b = canonical(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// ---------------------------------------------------------------------------
// Errors (CLAUDE.md §6)
// ---------------------------------------------------------------------------

/** The busy answer while a stock update finishes (publication-selection-work.ts): the save wrote nothing; retry. */
export const PUBLICATION_SELECTION_BUSY_CODE = "PUBLICATION_SELECTION_BUSY";
/**
 * Step 1 plan S2-5 §4.9 item 2: once PR B froze the rules table, this page's PUT is refused with 410 and this code
 * (dropship-selection-atp.repository.ts `SELECTION_RULES_RETIRED_DB_MESSAGE`). Nothing was saved, and saving from this
 * page can never work again: the vendor reloads to get the new page.
 */
export const SELECTION_RULES_RETIRED_CODE = DROPSHIP_CATALOG_READ_ERROR_CODES.rulesRetired;
const PERMANENT_REJECTED_CODES: ReadonlySet<string> = new Set(["DROPSHIP_IDEMPOTENCY_CONFLICT"]);

/**
 * A 2xx answer the page can't read (not JSON, or not the route's contract). The route always answers its contract in
 * JSON, so this may come from something in between (a proxy, a captive portal): the save may or may not have gone
 * through, and the rules are read to tell (review CT6).
 */
export class ChooseUnverifiedAnswerError extends Error {
  readonly code = "DROPSHIP_CATALOG_CHOOSE_ANSWER_UNVERIFIED";
  constructor(why: string) {
    super(`Catalog choose save answer could not be read: ${why}`);
    this.name = "ChooseUnverifiedAnswerError";
  }
}

export type ChooseSaveErrorClass =
  /**
   * `mayHaveCommitted`: the server may have saved it (no answer, a 5xx, an unreadable 2xx), so "not saved" can't be said
   * until the rules show it (review MC1). False when the answer itself says nothing was written (busy, 408, 429).
   */
  | { classification: "transient"; busyMessage: string | null; mayHaveCommitted: boolean }
  /** `reload`: only a reload can help (the page is older than the server, §4.9 item 2); the bar offers Reload. */
  | { classification: "permanent"; message: string; reload?: true };

/**
 * Transient (sent again with the same key and body): no answer (a network
 * failure or an aborted answer), any 5xx, an unreadable 2xx, the busy 409, 408
 * and 429. Permanent (never sent again): every other refusal. A 413 says the
 * body is too large, a 400 or a key conflict says the save can't be made from
 * this page; any other refusal shows the server's own words. Stale is not an
 * error: the runner stops before sending.
 *
 * A 5xx may have committed: the app commits in its own transaction, and a
 * router timeout (Heroku answers 503 at 30 s) can answer while the app still
 * commits. Busy, 408 and 429 are answered before anything is written.
 */
export function classifyChooseSaveError(error: unknown): ChooseSaveErrorClass {
  if (error instanceof DropshipApiError) {
    if (error.status === 409 && error.code === PUBLICATION_SELECTION_BUSY_CODE) {
      return { classification: "transient", busyMessage: error.message || null, mayHaveCommitted: false };
    }
    if (error.status >= 500) return { classification: "transient", busyMessage: null, mayHaveCommitted: true };
    if (error.status === 408 || error.status === 429) return { classification: "transient", busyMessage: null, mayHaveCommitted: false };
    if (error.status === 413) return { classification: "permanent", message: CHOOSE_WORDS.tooLarge };
    if (error.status === 410 && error.code === SELECTION_RULES_RETIRED_CODE) {
      return { classification: "permanent", message: CHOOSE_WORDS.retired, reload: true };
    }
    if (error.status === 400 || (error.status === 409 && error.code !== null && PERMANENT_REJECTED_CODES.has(error.code))) {
      return { classification: "permanent", message: CHOOSE_WORDS.rejected };
    }
    return { classification: "permanent", message: error.message.trim() || CHOOSE_WORDS.rejected };
  }
  // fetch rejects with a TypeError when no answer came; an aborted answer is a DOMException. Either way the save
  // may or may not have committed, and sending the same key and body again is safe (it replays).
  if (error instanceof TypeError || (typeof DOMException !== "undefined" && error instanceof DOMException)) {
    return { classification: "transient", busyMessage: null, mayHaveCommitted: true };
  }
  if (error instanceof ChooseUnverifiedAnswerError) return { classification: "transient", busyMessage: null, mayHaveCommitted: true };
  return { classification: "permanent", message: CHOOSE_WORDS.rejected };
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

export interface ChooseMergedPages {
  /** De-duplicated by size (the server's order has no unique tiebreak) and capped at CHOOSE_MAX_ROWS_SHOWN. */
  rows: ChooseCatalogRow[];
  /** From the newest page. */
  total: number;
  categories: ChooseCategoryFacet[];
  /** More rows match than may be shown. */
  capped: boolean;
}

export function mergeChoosePages(pages: readonly ChooseCatalogPage[]): ChooseMergedPages {
  const seen = new Set<number>();
  const rows: ChooseCatalogRow[] = [];
  for (const page of pages) {
    for (const row of page.rows) {
      if (seen.has(row.productVariantId) || rows.length >= CHOOSE_MAX_ROWS_SHOWN) continue;
      seen.add(row.productVariantId);
      rows.push(row);
    }
  }
  const newest = pages[pages.length - 1];
  const total = newest?.total ?? 0;
  return {
    rows,
    total,
    // Facets ignore the category and Show filters (they apply search only), so the first page's list is the list.
    categories: pages[0]?.facets.categories ?? [],
    capped: rows.length >= CHOOSE_MAX_ROWS_SHOWN && total > rows.length,
  };
}

/**
 * The line over the table. Past the most rows shown: search or filter. Every
 * page read (no next page) yet fewer rows than the total: a row was skipped
 * between pages (the server's order has no unique tiebreak), so say how to
 * reach it (review DUX11).
 */
export function describeChooseShown(merged: ChooseMergedPages, hasNextPage: boolean): string {
  if (merged.capped) return CHOOSE_WORDS.shownCapLine(merged.rows.length, merged.total);
  if (!hasNextPage && merged.rows.length < merged.total) return CHOOSE_WORDS.shownShortLine(merged.rows.length, merged.total);
  return CHOOSE_WORDS.shownLine(merged.rows.length, merged.total);
}

/** The next page to read, or undefined: none past the total, and none past CHOOSE_MAX_ROWS_SHOWN rows. */
export function chooseNextPageParam(lastPage: ChooseCatalogPage, allPages: readonly ChooseCatalogPage[]): number | undefined {
  if (lastPage.page * lastPage.limit >= lastPage.total) return undefined;
  if (allPages.length * CHOOSE_PAGE_SIZE >= CHOOSE_MAX_ROWS_SHOWN) return undefined;
  return lastPage.page + 1;
}
