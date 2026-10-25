/**
 * Catalog step 1, "Choose what to sell", on one-time picks (step 1 plan S2-5,
 * PR B; PLAN-B v4.1 §12.1): the checkbox is the vendor's choice, checking or
 * unchecking only marks a change, and one "Save changes" sends every add and
 * remove together as size ids. Nothing changes on eBay before Save, and
 * nothing is ever added later by itself.
 *
 * This module holds the step's rules, with no React, no network and no clock:
 * - the answers the step reads (a catalog page, with `picked` on every row),
 *   as Zod schemas;
 * - the change set (`reduceChooseChanges`): the ids to add, the ids to remove
 *   and the head revision the changes were made on;
 * - the row model (`chooseRowView`: the box and the How column from `picked`
 *   and the reason, V24) and the header box (`shownTick`);
 * - the room under the 10,000 cap (`chooseRoom`);
 * - the bulk controls of §12.3: the "Check all N that match" line
 *   (`chooseMatchLine`), each category's box (`chooseCategoryTicks`, from
 *   what the page learned, `ChooseKnown`) and "Select everything"
 *   (`chooseEverything`);
 * - the save body (`chooseChangeBody`), the save question's lines
 *   (`describeChooseConfirm`), the saved line (`describeChooseSaved`);
 * - the error classes (`classifyChooseSaveError`, §12.4, §12.5, §14) and the
 *   retry schedules the save runner follows;
 * - the paging helpers.
 *
 * It never sends a rule, a category name or a product line (owner Q2, Q3).
 */
import { z } from "zod";
import {
  DROPSHIP_CATALOG_READ_ERROR_CODES,
  dropshipCatalogReadSummarySchema,
  type DropshipCatalogReadSummary,
} from "@shared/dropship/vendor-catalog-reads";
import {
  MAX_SELECTION_CHANGE_IDS,
  SELECTION_CHANGE_CAP,
  SELECTION_CHANGE_ERROR_CODES,
  type SelectionChangeAnswer,
  type SelectionChangePreviewAnswer,
  type SelectionChangePreviewRequest,
} from "@shared/dropship/vendor-selection-changes";
import { CATALOG_PAGE_CLIENT_VERSION } from "./dropship-catalog-publish";
import { DROPSHIP_SITE_UPDATING_CODE, DropshipApiError } from "./dropship-ops-surface";
import { CHOOSE_WORDS } from "./dropship-catalog-choose-words";

/** The leave guard's id for step 1's unsaved changes; not a Listing settings id (`listing-settings:`). */
export const CHOOSE_GUARD_ID = "catalog-choose";
/** Rows read per "Load more": the most the catalog read allows (`limit` ≤ 200, dropship-selection-dtos.ts). */
export const CHOOSE_PAGE_SIZE = 200;
/** At most this many rows are shown: no windowing library is installed, and 1,000 rows stay usable without one. */
export const CHOOSE_MAX_ROWS_SHOWN = 1_000;
/** Typing pauses this long before the list is searched, as step 2 does (LISTING_SETTINGS_SEARCH_DEBOUNCE_MS). */
export const CHOOSE_SEARCH_PAUSE_MS = 300;
/** The catalog read's `search` is 1..200 characters (dropship-selection-dtos.ts). */
export const CHOOSE_SEARCH_MAX_LENGTH = 200;
/**
 * Ids on one side of one change: the server's `[0..10000]` per side (shared/dropship/vendor-selection-changes.ts),
 * so a change set holds at most 20,000 ids. An action that would pass it is refused whole (`chooseActionOverLimit`).
 */
export const CHOOSE_CHANGE_IDS_MAX = MAX_SELECTION_CHANGE_IDS;
/** The most sizes a vendor may have selected; a change that grows past it is refused, removing always works (§7.4). */
export const CHOOSE_SELECTION_CAP = SELECTION_CHANGE_CAP;

// ---------------------------------------------------------------------------
// The save's schedules (§12.4). Each send of one save carries the same key and body.
// ---------------------------------------------------------------------------

/** No answer, a 5xx, a 408 or a 429: one save is sent at most this many times, with these pauses between. */
export const CHOOSE_SAVE_MAX_TRIES = 3;
export const CHOOSE_SAVE_BACKOFF_MS: readonly number[] = Object.freeze([1_000, 2_000]);
/** `PUBLICATION_SELECTION_BUSY`: after the first busy answer, one more send after each of these pauses, then `busy`. */
export const CHOOSE_BUSY_BACKOFF_MS: readonly number[] = Object.freeze([2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
/** Writes paused, an older dyno's answer (site updating, a 413 without its code): these pauses first… */
export const CHOOSE_PAUSED_BACKOFF_MS: readonly number[] = Object.freeze([2_000, 4_000, 8_000]);
/** …then one send every 15 s: longer than the server's `Retry-After: 5`, so the header need not be read. */
export const CHOOSE_PAUSED_RETRY_MS = 15_000;
/**
 * How long the page keeps sending a paused save by itself, from the first paused answer, on the injected clock:
 * the server's settle plus grace (NEW_VERSION_SETTLE_MS 300,000 + OLDER_PROCESS_GRACE_MS 120,000,
 * server/modules/dropship/domain/catalog-code-version.ts; pinned equal by the requests test), so the pause of a
 * release is always outlived (FIDELITY-7). Then `pausedStill`, the changes kept.
 */
export const PAUSED_RETRY_WINDOW_MS = 420_000;
/**
 * The bulk parser's body limit (DROPSHIP_BULK_JSON_LIMIT_BYTES, dropship-bulk-json.middleware.ts; pinned equal by
 * the contract test). A 413 without its code for a body at most this large came from an older dyno's 100 KiB global
 * parser (§12.5): transient, not "too large".
 */
export const CHOOSE_BULK_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * A backstop for a clock that does not move: the most sends one paused window takes on the schedule above (32: the
 * first, three after the short pauses, then one per 15 s until 420 s have passed). With a moving clock the window
 * ends the sends first or at the same send.
 */
export const CHOOSE_PAUSED_MAX_SENDS = 1 + CHOOSE_PAUSED_BACKOFF_MS.length
  + Math.ceil((PAUSED_RETRY_WINDOW_MS - CHOOSE_PAUSED_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0)) / CHOOSE_PAUSED_RETRY_MS);
/** A save question asked again after the effects moved (§12.4 `effectsChanged`) at most this many times in one press. */
export const CHOOSE_EFFECTS_REVIEWS_MAX = 3;

/** The pause before paused retry `attempt` (0-based): 2 s, 4 s, 8 s, then 15 s each. */
export function choosePausedDelayMs(attempt: number): number {
  return CHOOSE_PAUSED_BACKOFF_MS[Math.max(0, attempt)] ?? CHOOSE_PAUSED_RETRY_MS;
}

// ---------------------------------------------------------------------------
// What the step reads
// ---------------------------------------------------------------------------

/**
 * The server's reasons, exactly (`DropshipVendorCatalogSelectionReason`, domain/vendor-selection.ts). B's server
 * never answers `excluded_by_vendor_rule` (a keep-out reads as not picked, §7.1); the union keeps it.
 */
export const chooseSelectionReasonSchema = z.enum([
  "selected",
  "not_exposed_by_admin",
  "excluded_by_vendor_rule",
  "missing_vendor_include_rule",
  "disabled_by_vendor_override",
]);
export type ChooseSelectionReason = z.infer<typeof chooseSelectionReasonSchema>;

const idSchema = z.number().int().positive();
const countSchema = z.number().int().nonnegative();

/** The server's listing tiers, exactly (`DROPSHIP_LISTING_TIERS`, domain/listing-tiers.ts); pinned by the server contract test. */
export const chooseListingTierNameSchema = z.enum(["pack", "case"]);
/** The server's tier block reasons, exactly (`DropshipListingTierBlockReason`, domain/listing-tiers.ts); pinned likewise. */
export const chooseListingTierReasonSchema = z.enum(["autopay_off", "reserve_below_tier", "balance_below_tier"]);

/**
 * A catalog row as step 1 reads it. Unknown fields are dropped, so the
 * product-line fields and the rule ids the server still sends for older tabs
 * never reach the table (owner Q2). `picked` is required: a row from an older
 * dyno has none, so its page is "site updating" and read again (V11).
 */
export const chooseCatalogRowSchema = z.object({
  productId: idSchema,
  productVariantId: idSchema,
  productSku: z.string().nullable(),
  productName: z.string(),
  variantSku: z.string().nullable(),
  variantName: z.string(),
  category: z.string().nullable(),
  /** `catalog.products.category_id`: what the categories read and the Category filter key on (V40). */
  categoryId: idSchema.nullable(),
  selectionDecision: z.object({
    selected: z.boolean(),
    reason: chooseSelectionReasonSchema,
    marketplaceQuantity: countSchema,
    /** The vendor's saved pick of this size (V24): the box's saved state. */
    picked: z.boolean(),
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

/**
 * One page of `GET /api/dropship/catalog` with `includeFacets=false`: the
 * facets (null) are dropped, the categories come from their own read (V40),
 * and the filter's `summary` is required (VCR:53-56).
 */
export const chooseCatalogPageSchema = z.object({
  rows: z.array(chooseCatalogRowSchema),
  total: countSchema,
  page: z.number().int().min(1),
  limit: z.number().int().min(1),
  summary: dropshipCatalogReadSummarySchema,
});
export type ChooseCatalogPage = z.infer<typeof chooseCatalogPageSchema>;

// ---------------------------------------------------------------------------
// The change set
// ---------------------------------------------------------------------------

export interface ChooseChanges {
  /** Ids to check (picked by the save), ascending when serialised. Never shares an id with `remove`. */
  add: ReadonlySet<number>;
  /** Ids to uncheck. */
  remove: ReadonlySet<number>;
  /** The head selection revision the changes were made on (the save's `expectedRevisionId`); null before any save. */
  baseRevisionId: number | null;
}

/** A row as a "check all shown" press sees it: its saved state and whether its box can change. */
export interface ChooseShownRow {
  productVariantId: number;
  savedChecked: boolean;
  changeable: boolean;
}

export type ChooseChangesAction =
  /** One box: the vendor flips what it shows. */
  | { type: "toggle"; productVariantId: number; savedChecked: boolean }
  /** The header box: every changeable row shown to `checked`. */
  | { type: "setShown"; rows: readonly ChooseShownRow[]; checked: boolean }
  /**
   * An `idsOnly` answer ("Check all N", a category box, "Select everything"): `checked` adds every not-selected id and
   * clears the pending removes of the selected ones; unchecked the reverse. A null list (over 10,000, VCR:65-69)
   * leaves the other side's pending changes as they are.
   */
  | { type: "applyIds"; selectedIds: readonly number[] | null; notSelectedIds: readonly number[] | null; checked: boolean }
  /** The head revision the page now counts from (another tab's save, the first summary read, this page's save); the changes stay. */
  | { type: "rebase"; revisionId: number | null }
  | { type: "undo" }
  | { type: "saved" };

const NO_IDS: ReadonlySet<number> = new Set<number>();

export const EMPTY_CHOOSE_CHANGES: ChooseChanges = Object.freeze({ add: NO_IDS, remove: NO_IDS, baseRevisionId: null });

/** True with no pending add or remove. */
export function chooseChangesEmpty(changes: Pick<ChooseChanges, "add" | "remove">): boolean {
  return changes.add.size === 0 && changes.remove.size === 0;
}

/** Copies made on first write, so an action that changes nothing allocates nothing and returns its input. */
class ChangeDraft {
  private add: Set<number> | null = null;
  private remove: Set<number> | null = null;
  constructor(private readonly base: ChooseChanges) {}

  private addSet(): Set<number> { return (this.add ??= new Set(this.base.add)); }
  private removeSet(): Set<number> { return (this.remove ??= new Set(this.base.remove)); }
  private hasAdd(id: number): boolean { return (this.add ?? this.base.add).has(id); }
  private hasRemove(id: number): boolean { return (this.remove ?? this.base.remove).has(id); }

  /** The id ends up in `add` (and not in `remove`). */
  toAdd(id: number): void {
    if (this.hasRemove(id)) this.removeSet().delete(id);
    if (!this.hasAdd(id)) this.addSet().add(id);
  }

  /** The id ends up in `remove` (and not in `add`). */
  toRemove(id: number): void {
    if (this.hasAdd(id)) this.addSet().delete(id);
    if (!this.hasRemove(id)) this.removeSet().add(id);
  }

  /** The id has no pending change. */
  clear(id: number): void {
    if (this.hasAdd(id)) this.addSet().delete(id);
    if (this.hasRemove(id)) this.removeSet().delete(id);
  }

  /** The box's state now: a pending change, else the saved state. */
  shown(id: number, savedChecked: boolean): boolean {
    if (this.hasAdd(id)) return true;
    if (this.hasRemove(id)) return false;
    return savedChecked;
  }

  /** The box to `checked`: a change only where it differs from the saved state. */
  setTo(id: number, checked: boolean, savedChecked: boolean): void {
    if (checked === savedChecked) this.clear(id);
    else if (checked) this.toAdd(id);
    else this.toRemove(id);
  }

  result(): ChooseChanges {
    if (this.add === null && this.remove === null) return this.base;
    return { add: this.add ?? this.base.add, remove: this.remove ?? this.base.remove, baseRevisionId: this.base.baseRevisionId };
  }
}

/** The change set an action leads to, before the limit is checked. */
function applyChooseAction(changes: ChooseChanges, action: ChooseChangesAction): ChooseChanges {
  switch (action.type) {
    case "toggle": {
      const draft = new ChangeDraft(changes);
      draft.setTo(action.productVariantId, !draft.shown(action.productVariantId, action.savedChecked), action.savedChecked);
      return draft.result();
    }
    case "setShown": {
      const draft = new ChangeDraft(changes);
      for (const row of action.rows) {
        if (row.changeable) draft.setTo(row.productVariantId, action.checked, row.savedChecked);
      }
      return draft.result();
    }
    case "applyIds": {
      const draft = new ChangeDraft(changes);
      // The ids whose saved state is the target lose their pending change; the others get one.
      const toTarget = action.checked ? action.notSelectedIds : action.selectedIds;
      const atTarget = action.checked ? action.selectedIds : action.notSelectedIds;
      for (const id of toTarget ?? []) {
        if (action.checked) draft.toAdd(id);
        else draft.toRemove(id);
      }
      for (const id of atTarget ?? []) draft.clear(id);
      return draft.result();
    }
    case "rebase":
      return action.revisionId === changes.baseRevisionId ? changes : { ...changes, baseRevisionId: action.revisionId };
    case "undo":
    case "saved":
      // The base stays: after a save the page rebases to the save's own revision, and adopts a newer head once its
      // summary read lands (`chooseAdoptsHead`, forward only).
      return chooseChangesEmpty(changes) ? changes : { add: NO_IDS, remove: NO_IDS, baseRevisionId: changes.baseRevisionId };
    default: {
      const unknownAction: never = action;
      throw new Error(`Unknown catalog choose action: ${JSON.stringify(unknownAction)}`);
    }
  }
}

function overLimit(changes: Pick<ChooseChanges, "add" | "remove">): boolean {
  return changes.add.size > CHOOSE_CHANGE_IDS_MAX || changes.remove.size > CHOOSE_CHANGE_IDS_MAX;
}

/**
 * The side counts an action would leave when it passes CHOOSE_CHANGE_IDS_MAX on either side (the reducer then
 * refuses it whole, so the page says `tooManyMatch` instead), or null when it fits.
 */
export function chooseActionOverLimit(changes: ChooseChanges, action: ChooseChangesAction): { add: number; remove: number } | null {
  const next = applyChooseAction(changes, action);
  return overLimit(next) ? { add: next.add.size, remove: next.remove.size } : null;
}

/**
 * Step 1's change set. Pure: never mutates its input (its sets are copied on
 * the first write), returns the same object when nothing changes (so a press
 * that changes nothing re-renders nothing), and refuses whole an action that
 * would hold more than CHOOSE_CHANGE_IDS_MAX ids on a side.
 */
export function reduceChooseChanges(changes: ChooseChanges, action: ChooseChangesAction): ChooseChanges {
  const next = applyChooseAction(changes, action);
  return next !== changes && overLimit(next) ? changes : next;
}

/**
 * True when `headRevisionId` is newer than `baseRevisionId`, or is the first head known (base null). Revision ids are
 * serial and the head is the vendor's newest revision, so a head only moves forward: an older head is a count read
 * before the base was set (a cached summary while it is read again after this page's own save; review round 1 CLI-4).
 */
export function chooseHeadMovedPast(baseRevisionId: number | null, headRevisionId: number | null): boolean {
  return headRevisionId !== null && (baseRevisionId === null || headRevisionId > baseRevisionId);
}

/**
 * True when the page should count from `headRevisionId`: no pending change, and the head moved past the base. Never
 * backwards: after a save the base is the save's own revision while the count may still say the one before.
 */
export function chooseAdoptsHead(changes: ChooseChanges, headRevisionId: number | null): boolean {
  return chooseChangesEmpty(changes) && chooseHeadMovedPast(changes.baseRevisionId, headRevisionId);
}

export function chooseCounts(changes: Pick<ChooseChanges, "add" | "remove">): { add: number; remove: number } {
  return { add: changes.add.size, remove: changes.remove.size };
}

function ascending(ids: ReadonlySet<number>): number[] {
  return [...ids].sort((left, right) => left - right);
}

/**
 * The preview body of the change (§8.2): both sides ascending, the base revision and this page's version (§12.6).
 * The save body adds the key and the confirmed effects hash.
 */
export function chooseChangeBody(changes: ChooseChanges): SelectionChangePreviewRequest {
  return {
    clientVersion: CATALOG_PAGE_CLIENT_VERSION,
    expectedRevisionId: changes.baseRevisionId,
    add: { productVariantIds: ascending(changes.add) },
    remove: { productVariantIds: ascending(changes.remove) },
  };
}

/** The change in one string: a kept save is sent again only for exactly these changes on this base. */
export function chooseChangesKey(changes: ChooseChanges): string {
  return `${changes.baseRevisionId ?? "none"}|${ascending(changes.add).join(",")}|${ascending(changes.remove).join(",")}`;
}

/** UTF-8 bytes of a body as it is sent (JSON). */
export function chooseBodyBytes(body: unknown): number {
  return new TextEncoder().encode(JSON.stringify(body)).length;
}

// ---------------------------------------------------------------------------
// The row model
// ---------------------------------------------------------------------------

/** The How column's state; the words are CHOOSE_WORDS.how[key]. */
export type ChooseHow = keyof typeof CHOOSE_WORDS.how;

export interface ChooseRowView {
  /** What the box shows: a pending change, else the saved pick. */
  checked: boolean;
  /** The saved pick. */
  savedChecked: boolean;
  /** A pending change that differs from the saved pick. */
  changed: "add" | "remove" | null;
  /** False for rows no box press can change. */
  changeable: boolean;
  how: ChooseHow;
  /** The marketplace quantity of a selected size; null for every other reason (the server sends 0 for those). */
  quantity: number | null;
  /** A selected size whose listing tier is not on sale (the tier badge). */
  tierOff: boolean;
  /** Turned off for the vendor while their pick is saved: the box can only remove the pick (verify V6). */
  pickTurnedOff: boolean;
}

/**
 * A row's saved state, from `picked` and the reason (V24): the box shows the
 * pick. A size Card Shellz no longer offers cannot be changed. A size turned
 * off for the vendor can only lose their pick (its box is checked while the
 * pick is saved), and with no pick it cannot be changed.
 */
export function chooseSavedState(row: ChooseCatalogRow): ChooseShownRow {
  const { reason, picked } = row.selectionDecision;
  const changeable = reason === "selected" || reason === "missing_vendor_include_rule" || reason === "excluded_by_vendor_rule"
    || (reason === "disabled_by_vendor_override" && picked);
  return { productVariantId: row.productVariantId, savedChecked: picked, changeable };
}

function savedHow(reason: ChooseSelectionReason): ChooseHow {
  if (reason === "selected") return "picked";
  if (reason === "disabled_by_vendor_override") return "turnedOff";
  // Defensive: the catalog read drops rows Card Shellz does not offer (dropship-selection-atp-service.ts).
  if (reason === "not_exposed_by_admin") return "notOffered";
  return "notSelected";
}

/** One row as the table shows it, with the pending changes. */
export function chooseRowView(row: ChooseCatalogRow, changes: Pick<ChooseChanges, "add" | "remove">): ChooseRowView {
  const { reason, marketplaceQuantity, picked } = row.selectionDecision;
  const saved = chooseSavedState(row);
  const id = row.productVariantId;
  const checked = changes.add.has(id) ? true : changes.remove.has(id) ? false : saved.savedChecked;
  const changed = checked === saved.savedChecked ? null : checked ? "add" : "remove";
  return {
    checked,
    savedChecked: saved.savedChecked,
    changed,
    changeable: saved.changeable,
    how: changed === "add" ? "willAdd" : changed === "remove" ? "willRemove" : savedHow(reason),
    quantity: reason === "selected" ? marketplaceQuantity : null,
    tierOff: reason === "selected" && row.listingTier !== undefined && !row.listingTier.eligible,
    pickTurnedOff: reason === "disabled_by_vendor_override" && picked,
  };
}

export type ChooseShownTick = "all" | "some" | "none";

/**
 * The header box over the rows shown: "all" when every changeable row is
 * checked, "some" when some are, "none" otherwise; `changeable` 0 turns it off.
 * A click on "all" unchecks them (`setShown(false)`), otherwise checks them.
 */
export function shownTick(rows: readonly ChooseCatalogRow[], changes: Pick<ChooseChanges, "add" | "remove">): { tick: ChooseShownTick; changeable: number } {
  let changeable = 0;
  let checked = 0;
  for (const row of rows) {
    const view = chooseRowView(row, changes);
    if (!view.changeable) continue;
    changeable += 1;
    if (view.checked) checked += 1;
  }
  const tick: ChooseShownTick = changeable > 0 && checked === changeable ? "all" : checked > 0 ? "some" : "none";
  return { tick, changeable };
}

// ---------------------------------------------------------------------------
// Room under the cap (§12.3)
// ---------------------------------------------------------------------------

export interface ChooseRoom {
  /** Selected now (saved). */
  selected: number;
  /** Selected after the pending changes, counting each pending id as written (the server's count may be lower). */
  after: number;
  /** `cap − after`, never below 0: how many more can be added. */
  room: number;
  /** The pending changes grow the count. */
  grows: boolean;
  /** Save stays off: the change grows the count past the cap (`overCapAdd`). A shrinking change is always allowed. */
  overCapAdd: boolean;
  /** The saved selection is over the cap (`overCapState`). */
  overCapState: boolean;
}

/** `room = cap − selectedTotal − add + remove` from the selection summary (§12.3). */
export function chooseRoom(selection: { selectedTotal: number; cap: number }, changes: Pick<ChooseChanges, "add" | "remove">): ChooseRoom {
  const after = selection.selectedTotal + changes.add.size - changes.remove.size;
  const grows = changes.add.size > changes.remove.size;
  return {
    selected: selection.selectedTotal,
    after,
    room: Math.max(0, selection.cap - after),
    grows,
    overCapAdd: grows && after > selection.cap,
    overCapState: selection.selectedTotal > selection.cap,
  };
}

// ---------------------------------------------------------------------------
// "Check all N that match" (§12.3)
// ---------------------------------------------------------------------------

export type ChooseIdsPurpose = "add" | "remove";

export interface ChooseMatchLine {
  /** `add`: "Check all {total} that match"; `remove`: "Uncheck all {total} that match". */
  purpose: ChooseIdsPurpose;
  /** The number the button says. */
  total: number;
  /** The changeable rows shown, all checked ("All {shown} shown are checked."); null for `remove`. */
  shownChecked: number | null;
  /** More matched than the button said at the last press: the line says so and asks again with the new number. */
  changed: { now: number; was: number } | null;
}

/**
 * The line under the header box, or null (§12.3). It follows a press of the
 * header box while more rows match than are shown: "Check all" once the press
 * checked every changeable row shown (and they still are), "Uncheck all" once
 * it unchecked them. Hidden once its own press is applied (`applied`, until
 * the next change), and after a save (the page forgets the header press).
 */
export function chooseMatchLine(input: {
  tick: ChooseShownTick;
  /** Changeable rows shown (`shownTick`). */
  changeable: number;
  /** Rows shown. */
  shown: number;
  /** Rows that match (the page's `total`). */
  total: number;
  /** The header box's last press on these filters: true checked the rows shown, false unchecked them. */
  lastHeader: boolean | null;
  /** The last press found more matching than the button said. */
  changed: { purpose: ChooseIdsPurpose; now: number; was: number } | null;
  applied: boolean;
}): ChooseMatchLine | null {
  if (input.applied || input.total <= input.shown || input.changeable === 0) return null;
  const purpose: ChooseIdsPurpose | null = input.tick === "all" && input.lastHeader === true ? "add"
    : input.tick === "none" && input.lastHeader === false ? "remove" : null;
  if (purpose === null) return null;
  const changed = input.changed !== null && input.changed.purpose === purpose ? { now: input.changed.now, was: input.changed.was } : null;
  return { purpose, total: changed?.now ?? input.total, shownChecked: purpose === "add" ? input.changeable : null, changed };
}

/**
 * An `idsOnly` answer against the number its button said. The answer counts
 * only the changeable sizes (a size turned off for the vendor is in the
 * page's `total` but never in the ids), so fewer is not a change; more is:
 * the press would check (or uncheck) more than the vendor was told, so the
 * page asks again (§12.3 "If `total` changed…, the line says so and asks
 * again").
 */
export function chooseMatchGrew(answerTotal: number, said: number): boolean {
  return answerTotal > said;
}

// ---------------------------------------------------------------------------
// The categories card (§12.3): what the page knows, and each category's box
// ---------------------------------------------------------------------------

/** One size as the page knows it: its category (null: none) and whether it is selected (saved). */
export interface ChooseKnownSize {
  categoryId: number | null;
  selected: boolean;
}

/** The complete changeable id lists of a scope (an `idsOnly` answer with neither list null). */
export interface ChooseIdLists {
  selectedIds: ReadonlySet<number>;
  notSelectedIds: ReadonlySet<number>;
}

/**
 * What the page learned at one saved revision, from the rows it read and the
 * id reads it made, so a category's box can count pending changes whose rows
 * are not on screen. Facts of an older revision are dropped (`chooseKnownAt`).
 */
export interface ChooseKnown {
  revisionId: number | null;
  sizes: ReadonlyMap<number, ChooseKnownSize>;
  /** A category's complete lists, from an id read with only its category id (D26). */
  categories: ReadonlyMap<number, ChooseIdLists>;
  /** The whole catalog's complete lists, from an id read with no filter ("Select everything"). */
  everything: ChooseIdLists | null;
}

export function emptyChooseKnown(revisionId: number | null): ChooseKnown {
  return { revisionId, sizes: new Map(), categories: new Map(), everything: null };
}

/** The facts for `revisionId`: kept while it is the one they were learned at, else none. */
export function chooseKnownAt(known: ChooseKnown, revisionId: number | null): ChooseKnown {
  return known.revisionId === revisionId ? known : emptyChooseKnown(revisionId);
}

/** The facts with these rows' categories and saved states; the same object when nothing is new. */
export function learnChooseRows(known: ChooseKnown, rows: readonly ChooseCatalogRow[]): ChooseKnown {
  let sizes: Map<number, ChooseKnownSize> | null = null;
  for (const row of rows) {
    const fact = { categoryId: row.categoryId, selected: row.selectionDecision.selected };
    const had = (sizes ?? known.sizes).get(row.productVariantId);
    if (had && had.categoryId === fact.categoryId && had.selected === fact.selected) continue;
    sizes ??= new Map(known.sizes);
    sizes.set(row.productVariantId, fact);
  }
  return sizes === null ? known : { ...known, sizes };
}

/**
 * The facts after an `idsOnly` answer. `scope.categoryId`: the read named
 * that category, so every id in it is that category's. `scope.whole`: the
 * read had no search and no Show filter, so its lists are the scope's
 * complete changeable sizes (a category's, or with no category the whole
 * catalog's). A null list is not complete.
 */
export function learnChooseIds(known: ChooseKnown, scope: { categoryId: number | null; whole: boolean },
  answer: { selectedIds: readonly number[] | null; notSelectedIds: readonly number[] | null }): ChooseKnown {
  let next = known;
  if (scope.categoryId !== null) {
    const sizes = new Map(known.sizes);
    for (const id of answer.selectedIds ?? []) sizes.set(id, { categoryId: scope.categoryId, selected: true });
    for (const id of answer.notSelectedIds ?? []) sizes.set(id, { categoryId: scope.categoryId, selected: false });
    next = { ...next, sizes };
  }
  if (!scope.whole || answer.selectedIds === null || answer.notSelectedIds === null) return next;
  const lists: ChooseIdLists = { selectedIds: new Set(answer.selectedIds), notSelectedIds: new Set(answer.notSelectedIds) };
  if (scope.categoryId === null) return { ...next, everything: lists };
  const categories = new Map(next.categories);
  categories.set(scope.categoryId, lists);
  return { ...next, categories };
}

export interface ChooseCategoryTick {
  tick: ChooseShownTick;
  /** Nothing in it can be changed (known from its own id read): its box is off. */
  empty: boolean;
}

/** A category as the categories read counts it (VCR:73-81). */
export interface ChooseCategoryCounts {
  categoryId: number;
  rowCount: number;
  selectedCount: number;
}

function bump(counts: Map<number, number>, key: number): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function tickOf(checked: number, total: number): ChooseShownTick {
  if (total > 0 && checked >= total) return "all";
  return checked > 0 ? "some" : "none";
}

/**
 * Each category's box, with the pending changes (§12.3, B2a's observation):
 * 1. After its own id read, exactly: its selected sizes not marked to remove
 *    plus its not-selected sizes marked to add, of all its changeable sizes.
 * 2. Else after "Select everything" while the category of every size it read
 *    that is not checked now is known: ticked when none of them is in it.
 * 3. Else from the counts: `selectedCount` plus its known pending adds of
 *    sizes not selected, minus its known pending removes of selected sizes,
 *    of `rowCount`. (The counts
 *    include sizes turned off for the vendor, so such a category reads
 *    "some" until its box is pressed once and case 1 applies.)
 * A pending change whose size's category is unknown counts nowhere.
 */
export function chooseCategoryTicks(categories: readonly ChooseCategoryCounts[], changes: Pick<ChooseChanges, "add" | "remove">,
  known: ChooseKnown): Map<number, ChooseCategoryTick> {
  const addsIn = new Map<number, number>();
  const removesIn = new Map<number, number>();
  for (const id of changes.add) {
    const size = known.sizes.get(id);
    // A pending add of a size already selected (kept after a stale stop: another tab picked it) is in `selectedCount`
    // already: counting it again would tick a category that is not fully selected (review round 1 CLI-5).
    if (size && size.categoryId !== null && !size.selected) bump(addsIn, size.categoryId);
  }
  for (const id of changes.remove) {
    const size = known.sizes.get(id);
    // A pick turned off for the vendor is not in `selectedCount`: removing it moves nothing.
    if (size && size.categoryId !== null && size.selected) bump(removesIn, size.categoryId);
  }
  const missingIn = everythingMissing(known, changes);
  const ticks = new Map<number, ChooseCategoryTick>();
  for (const category of categories) {
    const lists = known.categories.get(category.categoryId);
    if (lists) {
      let checked = 0;
      for (const id of lists.selectedIds) if (!changes.remove.has(id)) checked += 1;
      for (const id of lists.notSelectedIds) if (changes.add.has(id)) checked += 1;
      const total = lists.selectedIds.size + lists.notSelectedIds.size;
      ticks.set(category.categoryId, { tick: tickOf(checked, total), empty: total === 0 });
    } else if (missingIn !== null) {
      // `rowCount − missing` may count sizes turned off for the vendor as checked: it only tells "some" from "none".
      const missing = missingIn.get(category.categoryId) ?? 0;
      const tick: ChooseShownTick = missing === 0 ? (category.rowCount > 0 ? "all" : "none")
        : category.rowCount - missing > 0 ? "some" : "none";
      ticks.set(category.categoryId, { tick, empty: false });
    } else {
      const after = category.selectedCount + (addsIn.get(category.categoryId) ?? 0) - (removesIn.get(category.categoryId) ?? 0);
      ticks.set(category.categoryId, { tick: tickOf(after, category.rowCount), empty: false });
    }
  }
  return ticks;
}

/**
 * After "Select everything": per category, the sizes of its complete lists
 * that are not checked now (not marked to add, or marked to remove). Null
 * when there is no such read, or any such size's category is unknown.
 */
function everythingMissing(known: ChooseKnown, changes: Pick<ChooseChanges, "add" | "remove">): Map<number, number> | null {
  if (known.everything === null) return null;
  const missing = new Map<number, number>();
  const count = (id: number): boolean => {
    const size = known.sizes.get(id);
    if (!size) return false;
    if (size.categoryId !== null) bump(missing, size.categoryId);
    return true;
  };
  for (const id of known.everything.notSelectedIds) if (!changes.add.has(id) && !count(id)) return null;
  for (const id of known.everything.selectedIds) if (changes.remove.has(id) && !count(id)) return null;
  return missing;
}

/** A category box's press: a ticked box unticks (reads the ids to remove), any other ticks (reads the ids to add). */
export function chooseCategoryPurpose(tick: ChooseShownTick): ChooseIdsPurpose {
  return tick === "all" ? "remove" : "add";
}

export interface ChooseEverything {
  /** Every size Card Shellz offers the vendor (the categories read's rows plus those with no category). */
  offered: number;
  /** "Select everything" is off: nothing is left to add, or the room left is smaller than what is not yet selected (D27). */
  disabled: boolean;
  /** The off state has a reason worth saying (the room). */
  overRoom: boolean;
}

/**
 * "Select everything ({offered})": off while the room left under the cap is
 * smaller than the number not yet selected, counting the pending changes as
 * the bar does (D27). The number offered counts sizes turned off for the
 * vendor too, so it can say more than one press adds.
 */
export function chooseEverything(categories: { categories: readonly { rowCount: number }[]; uncategorizedCount: number },
  selection: { selectedTotal: number; cap: number }, changes: Pick<ChooseChanges, "add" | "remove">): ChooseEverything {
  const offered = categories.categories.reduce((sum, category) => sum + category.rowCount, 0) + categories.uncategorizedCount;
  const room = chooseRoom(selection, changes);
  const notYetSelected = Math.max(0, offered - room.after);
  const overRoom = room.room < notYetSelected;
  return { offered, disabled: notYetSelected === 0 || overRoom, overRoom };
}

// ---------------------------------------------------------------------------
// The save question and the saved line (§13)
// ---------------------------------------------------------------------------

/**
 * The save question's lines from the server's preview, in order: the counts;
 * per store (ascending, as the server sends them) its quantity 0 and its
 * resumes, or `confirmNone` when no store has any; that removed listings are
 * not ended (B only), when the save sets any listing to quantity 0; that the
 * choice is for every store. Only what Echelon does (FIDELITY2): a removal no
 * store has an entry for (no listing, ended on eBay, no change in whether it
 * sells; V20) sets nothing to quantity 0, so that line is left out then
 * (review round 1 CLI-6). A listing that ended on eBay is counted nowhere.
 */
export function describeChooseConfirm(preview: SelectionChangePreviewAnswer): string[] {
  const lines = [CHOOSE_WORDS.confirmCounts(preview.toAdd, preview.toRemove, preview.alreadySelected + preview.alreadyNotSelected)];
  let entries = 0;
  let toZero = 0;
  for (const store of preview.effects) {
    if (store.goesToZero > 0) lines.push(CHOOSE_WORDS.confirmZero(store.storeName, store.goesToZero));
    if (store.startsSelling > 0) lines.push(CHOOSE_WORDS.confirmResume(store.storeName, store.startsSelling));
    entries += store.goesToZero + store.startsSelling;
    toZero += store.goesToZero;
  }
  if (entries === 0) lines.push(CHOOSE_WORDS.confirmNone);
  if (preview.toRemove > 0 && toZero > 0) lines.push(CHOOSE_WORDS.confirmNotEnded);
  lines.push(CHOOSE_WORDS.confirmScope);
  return lines;
}

/**
 * The bar after a save, from the server's answer: `saved`, or `savedDrift`
 * when the effects moved between the question and the save (a change with
 * no adds goes through, §7.5); then `skipped` when any added size was no
 * longer offered.
 */
export function describeChooseSaved(answer: SelectionChangeAnswer): string {
  const zero = answer.effects.reduce((sum, store) => sum + store.goesToZero, 0);
  const head = answer.drifted ? CHOOSE_WORDS.savedDrift(zero) : CHOOSE_WORDS.saved(answer.toAdd, answer.toRemove);
  return answer.skipped.count > 0 ? `${head} ${CHOOSE_WORDS.skipped(answer.skipped.count)}` : head;
}

// ---------------------------------------------------------------------------
// Errors (CLAUDE.md §6; PLAN-B v4.1 §12.4, §12.5, §14)
// ---------------------------------------------------------------------------

/** The busy answer while a stock update finishes, after the server's own retries (§8.3): nothing was written. */
export const PUBLICATION_SELECTION_BUSY_CODE = SELECTION_CHANGE_ERROR_CODES.busy;
/** 410: an older page's rules save once PR B froze the rules; with C's 409 page outdated, the page reloads. */
export const SELECTION_RULES_RETIRED_CODE = DROPSHIP_CATALOG_READ_ERROR_CODES.rulesRetired;

export type ChooseSaveErrorClass =
  /**
   * No answer, a 5xx, a 2xx the page can't read, a 408 or a 429: sent again (CHOOSE_SAVE_MAX_TRIES).
   * `mayHaveCommitted`: the server may have saved it (no answer, a 5xx, an unreadable 2xx), so the kept save is sent
   * again with its key on the next press, which replays it (review MC1). False when the answer says nothing was written.
   */
  | { kind: "network"; mayHaveCommitted: boolean }
  /** `PUBLICATION_SELECTION_BUSY` (409, transient): sent again on the busy schedule. */
  | { kind: "busy" }
  /** Writes paused (503), an answer from code older than this page, or that code's 413: the paused schedule. */
  | { kind: "paused" }
  /** The head revision moved (409): read again, keep the changes, new key. `headRevisionId` when the server named it. */
  | { kind: "stale"; headRevisionId: number | null | undefined }
  /** The effects moved since the question (409): ask again, new key. */
  | { kind: "effectsChanged" }
  /** The key was used for another change (409): refused, a new key on the next press. */
  | { kind: "keyConflict" }
  /** 410 rules retired, or PR C's 409 page outdated: only a reload helps. */
  | { kind: "retired" }
  /** The bulk parser's 413 (permanent). */
  | { kind: "tooLarge" }
  /** 422: the change grows the selection past the cap. `after` when the server named it. */
  | { kind: "overCap"; after: number | null }
  /** Any other refusal, in words; never sent again. */
  | { kind: "permanent"; message: string };

function contextNumber(error: DropshipApiError, key: string): number | null | undefined {
  const value = error.context?.[key];
  if (value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * One failed send, classified. `bodyBytes` is the size of the body that was
 * sent: a 413 without `DROPSHIP_REQUEST_TOO_LARGE` for a body within the bulk
 * limit can only be an older dyno's global parser (100 KiB), which is
 * replaced during the release (§12.5).
 */
export function classifyChooseSaveError(error: unknown, sent: { bodyBytes: number }): ChooseSaveErrorClass {
  if (error instanceof DropshipApiError) {
    if (error.code === DROPSHIP_SITE_UPDATING_CODE) return { kind: "paused" };
    if (error.status === 503 && error.code === SELECTION_CHANGE_ERROR_CODES.writesPaused) return { kind: "paused" };
    if (error.status === 413) {
      if (error.code === SELECTION_CHANGE_ERROR_CODES.requestTooLarge) return { kind: "tooLarge" };
      return sent.bodyBytes <= CHOOSE_BULK_BODY_LIMIT_BYTES ? { kind: "paused" } : { kind: "tooLarge" };
    }
    if (error.status === 409) {
      switch (error.code) {
        case SELECTION_CHANGE_ERROR_CODES.busy: return { kind: "busy" };
        case SELECTION_CHANGE_ERROR_CODES.revisionConflict: return { kind: "stale", headRevisionId: contextNumber(error, "currentRevisionId") };
        case SELECTION_CHANGE_ERROR_CODES.effectsChanged: return { kind: "effectsChanged" };
        case SELECTION_CHANGE_ERROR_CODES.keyConflict: return { kind: "keyConflict" };
        case SELECTION_CHANGE_ERROR_CODES.pageOutdated: return { kind: "retired" };
        default: break;
      }
    }
    if (error.status === 410 && error.code === SELECTION_CHANGE_ERROR_CODES.rulesRetired) return { kind: "retired" };
    if (error.status === 422 && error.code === SELECTION_CHANGE_ERROR_CODES.tooLarge) {
      return { kind: "overCap", after: contextNumber(error, "selectedAfter") ?? null };
    }
    if (error.status >= 500) return { kind: "network", mayHaveCommitted: true };
    if (error.status === 408 || error.status === 429) return { kind: "network", mayHaveCommitted: false };
    // A 400 (the body, the key) says the save can't be made from this page; never the server's words for it.
    if (error.status === 400) return { kind: "permanent", message: CHOOSE_WORDS.rejected };
    return { kind: "permanent", message: error.message.trim() || CHOOSE_WORDS.rejected };
  }
  // fetch rejects with a TypeError when no answer came, an aborted answer is a DOMException, and a 2xx cut short is
  // response.json()'s SyntaxError: the save may have committed, and sending the same key and body again replays it.
  if (error instanceof TypeError || error instanceof SyntaxError || (typeof DOMException !== "undefined" && error instanceof DOMException)) {
    return { kind: "network", mayHaveCommitted: true };
  }
  return { kind: "permanent", message: CHOOSE_WORDS.rejected };
}

/**
 * An `idsOnly` read refused for too many ids (422 `DROPSHIP_CATALOG_IDS_TOO_MANY`, SVC:340-345): `tooManyMatch` with
 * the count the server needed, or null when it named none. Null for any other error.
 */
export function chooseIdsTooMany(error: unknown): { needed: number | null } | null {
  if (!(error instanceof DropshipApiError) || error.status !== 422 || error.code !== DROPSHIP_CATALOG_READ_ERROR_CODES.idsTooMany) return null;
  return { needed: contextNumber(error, "needed") ?? null };
}

/**
 * Why a "Check all", category or "Select everything" press changed nothing, in words: more ids than one change
 * takes (`tooManyMatch` with the server's count, else `fallback`), or the read gave up after its retries.
 */
export function describeChooseIdsFailure(error: unknown, fallback: number): string {
  const tooMany = chooseIdsTooMany(error);
  if (tooMany) return CHOOSE_WORDS.tooManyMatch(tooMany.needed ?? fallback);
  return CHOOSE_WORDS.catalogFailedText;
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

export interface ChooseMergedPages {
  /** De-duplicated by size (the server's order has no unique tiebreak) and capped at CHOOSE_MAX_ROWS_SHOWN. */
  rows: ChooseCatalogRow[];
  /** From the newest page. */
  total: number;
  /** The filter's counts apart from Show, from the newest page. */
  summary: DropshipCatalogReadSummary | null;
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
    summary: newest?.summary ?? null,
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
