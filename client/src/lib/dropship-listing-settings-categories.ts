import { CATEGORY_LISTING_SETTING_FIELDS, type CategoryListingSettingField } from "@shared/dropship/listing-setting-values";
import {
  CATEGORY_CLEAR_FIELDS,
  saveCategorySettingsInputSchema,
  type CategoryClearField,
  type CategorySettingsPatchInput,
  type SaveCategorySettingsInput,
} from "@shared/dropship/listing-setting-writes";
import type {
  ListingSettingsCategoriesResponse,
  ListingSettingsCategoryDetail,
  ListingSettingsCategorySettingSource,
  ListingSettingsCategorySettings,
  ListingSettingsSummary,
} from "@shared/dropship/listing-settings";
import { listingSettingsCategoriesQueryOptions, listingSettingsCategoryQueryOptions } from "./dropship-listing-settings";
import type { ListingSettingsEditRights, ListingSettingsReadState, ListingSettingsRight } from "./dropship-listing-settings-access";
import {
  categoryEditorId,
  decideOpen,
  isDraftDirty,
  isDraftLocked,
  LISTING_SETTINGS_SAVE_WORDS,
  type DraftValue,
  type EditorId,
  type ListingSettingsDraft,
  type WriteFailure,
} from "./dropship-listing-settings-drafts";
import {
  DRAWER_ROW_TARGETS,
  DRAWER_SETTING_ROWS,
  DRAWER_WORDS,
  drawerEditFields,
  drawerFooter,
  fieldPendingWords,
  type DrawerEditTarget,
  type DrawerFieldTarget,
  type DrawerFooter,
  type DrawerRowEdit,
  type DrawerSettingEntry,
  type DrawerSettingRowKey,
  type DrawerSettingRowModel,
} from "./dropship-listing-settings-drawer";
import { recipeWords } from "./dropship-listing-settings-price-words";
import {
  choicesFromOwn,
  descriptionEditorResult,
  descriptionFieldEditor,
  ebayCategoryFieldEditor,
  isProductFieldChoice,
  normalizedVendorText,
  patchSignatureEntries,
  policyFieldEditor,
  productFieldRights,
  productSettingsPatch,
  storeShelfFieldEditor,
  type DescriptionEditorModel,
  type DescriptionEditorState,
  type EbayCategoryFieldEditorModel,
  type FieldChoice,
  type PolicyEditField,
  type PolicyFieldEditorModel,
  type ProductEditField,
  type ProductFieldChoice,
  type ProductFieldRights,
  type ProductOwnSettings,
  type ProductSettingsChoices,
  type StoreShelfFieldEditorModel,
} from "./dropship-listing-settings-product-edit";
import { shelfPathWords, type PolicySetupFacts } from "./dropship-listing-settings-store-requests";
import {
  alsoClearLabelWords,
  categoryEditorTitleWords,
  categoryRowWords,
  changeCategoryLabel,
  drawerDescriptionTemplateValue,
  drawerEbayCategoryValue,
  drawerPolicyValue,
  drawerStoreShelfValue,
  LISTING_SETTINGS_CATEGORY_WORDS,
  LISTING_SETTINGS_EDIT_WORDS,
  loadingCategoryWords,
  ownValuesLineWords,
  pendingSettingWords,
  rightReasonLine,
  setForCategoryWords,
  storeDefaultEbayCategoryValue,
  uncategorizedWords,
  type CategoryRowWords,
} from "./dropship-listing-settings-words";
import { DropshipApiError, type DropshipEbayStoreCategoryOption } from "./dropship-ops-surface";

/**
 * The Category settings card and the category editor (Listing settings PR 10e,
 * plan 8.1-8.4): the reads the card and the editor make, the older-rules check
 * (D11), the card's rows and state, the choices a category's seven fields can
 * take (never the price, read-only until 10f, UX-m9), the draft that holds them
 * with "Also clear theirs", the W12 patch and request they make, who may change
 * which field, the field editors' models, "Load latest", and the editor's state.
 *
 * Rules this module keeps:
 * - Never a price and never a main text in W12 (plan P34; `SW`
 *   saveCategorySettingsInputSchema has neither): a category price goes through
 *   the price check (W7, PR 10f); a category has no main text.
 * - Ids and text only, as W5's patch (`productSettingsPatch`): "Use store
 *   default" is null, "Set" the value, a field left alone is absent, unless
 *   "Also clear theirs" is ticked on it: then the category's current value is
 *   sent again as ids-only input, which saves the category as `unchanged`
 *   (plan P20, 8.4; `SW:438-445` every cleared field is non-null in the patch).
 * - The revision W12 sends, and the "Also clear theirs" set, come from the
 *   one `GET …/categories/:id` answer the editor opened on (D6).
 * - `clear.products` is the union of the `ownValues` entries holding any
 *   ticked field, each once, with the revision it was read with (8.4); the
 *   server derives the same set and answers 409 for any other.
 * - While the store holds older group rules (D11), no save is offered: the
 *   card's rows have no [Change]; the 409 stays the backstop.
 *
 * Pure: no React, no network, no clock. Never mutates its inputs.
 */

// ---------------------------------------------------------------------------
// The reads (plan 8.2, D10, D18)
// ---------------------------------------------------------------------------

/** What the reads need from the summary: whether the selection is too large to check. */
export type CategoriesSummaryFacts = ListingSettingsReadState<Pick<ListingSettingsSummary, "catalog">>;

/**
 * Whether the categories reads may run (D18): only while the summary's
 * catalog state is not `too_large`. While the summary is still loading they
 * run; a 422 from them then goes to the banner through `onTooLarge`.
 */
export function categoriesReadEnabled(summary: CategoriesSummaryFacts): boolean {
  return summary.data?.catalog.state !== "too_large";
}

/** The card's read: every category of the chosen products, a list read (at most 60 seconds old), off while too large. */
export function categoriesCardQueryOptions(storeConnectionId: number, summary: CategoriesSummaryFacts) {
  return listingSettingsCategoriesQueryOptions(storeConnectionId, { enabled: categoriesReadEnabled(summary) });
}

/**
 * The open editor's read of one category: fresh each time (staleTime 0),
 * because its revision and its "Also clear theirs" set come from this answer
 * (D6); off while the editor is closed or the selection is too large.
 */
export function categoryEditorQueryOptions(storeConnectionId: number, categoryId: number, summary: CategoriesSummaryFacts, open: boolean) {
  return listingSettingsCategoryQueryOptions(storeConnectionId, categoryId, { enabled: open && categoriesReadEnabled(summary) });
}

// ---------------------------------------------------------------------------
// Older group rules (D11; plan P21)
// ---------------------------------------------------------------------------

/** What the older-rules check reads from the summary. */
export type OlderRulesSummaryFacts = Pick<ListingSettingsSummary, "storeDefaults">;

/**
 * Whether the store still holds older group rules (D11): the summary's three
 * counts, the same the writers refuse with (`S/application/dropship-listing-setting-write-support.ts`
 * listingSettingOlderRulesPresent; `SR` storeDefaults.*.groupRules). Any one
 * above zero means no category save goes through until PR 11.
 */
export function olderGroupRulesPresent(summary: OlderRulesSummaryFacts): boolean {
  const { price, ebayCategory, description } = summary.storeDefaults;
  return price.groupRules + ebayCategory.groupRules + description.groupRules > 0;
}

/** The check as the card uses it: unknown while the summary loads or after its latest attempt failed (UX-M9). */
export type OlderRulesState = "present" | "absent" | "unknown";

export function olderRulesState(summary: ListingSettingsReadState<OlderRulesSummaryFacts>): OlderRulesState {
  if (summary.error !== undefined && summary.error !== null) return "unknown";
  if (summary.data === undefined) return "unknown";
  return olderGroupRulesPresent(summary.data) ? "present" : "absent";
}

// ---------------------------------------------------------------------------
// The card (plan 8.3, 3.7, D11, D18)
// ---------------------------------------------------------------------------

export interface CategoryCardInput {
  /** The card's read (`categoriesCardQueryOptions`), as React Query holds it. */
  read: ListingSettingsReadState<ListingSettingsCategoriesResponse>;
  /** The step's summary read: the catalog state (D18) and the older-rules counts (D11). */
  summary: ListingSettingsReadState<Pick<ListingSettingsSummary, "catalog" | "storeDefaults">>;
  /** The step's one draft, whoever holds it. */
  draft: ListingSettingsDraft | null;
  /** W12's right (`rights.categorySettings`, D3). */
  right: ListingSettingsRight;
  /** A line the step has for the card: the editor closed because no chosen product is in its category any more (8.6). */
  notice?: string | null;
}

/** A refresh of a view already shown failed (3.7): the view stays, with these words and Try again, as the drawer's "Couldn't load the latest view.". */
export type CategoryLatestReadFailure = { kind: "failed" | "rate_limited"; text: string; retryLabel: string };

export interface CategoryCardRow {
  /** Stable among the rows: the category. */
  key: string;
  categoryId: number;
  name: string;
  productCount: number;
  /** The category's settings revision as the card read it (null when it has none); the editor reads its own, fresh (D6). */
  revisionId: number | null;
  words: CategoryRowWords;
  /** "Sleeves · 15 products · Sets: shipping policy, store shelf". */
  text: string;
  /** [Change]: hidden while the store holds older group rules (D11), off while the check or the right waits. */
  change: { label: string; ariaLabel: string; shown: boolean; disabled: boolean };
  /** Why [Change] is off, in words; null when it isn't, or a banner says why. */
  line: string | null;
  /** This category's draft is saving or unconfirmed: its [Change] stays, so [Check again] is reachable (D11, CC-C25). */
  held: boolean;
}

export type CategoryCardReadProblem = { kind: "failed" | "rate_limited"; text: string; retryLabel: string };

export interface CategoryCardState {
  title: string;
  intro: string;
  /** The selection is too large (D18): the card is hidden and the banner explains. */
  hidden: boolean;
  /** `failed` only while nothing is shown: a failed refresh keeps the rows and says so in `latestFailed`. */
  read: "loading" | "failed" | "answered";
  problem: CategoryCardReadProblem | null;
  /** The rows are the last answer's and their refresh failed; null otherwise. */
  latestFailed: CategoryLatestReadFailure | null;
  rows: CategoryCardRow[];
  /** "4 products have no Card Shellz category. They use your store defaults."; null for none. */
  uncategorized: string | null;
  /** "None of your chosen products is in a Card Shellz category." when the read lists none; null otherwise. */
  empty: string | null;
  olderRules: OlderRulesState;
  /** The one line while the store holds older group rules (D11); null otherwise. */
  olderRulesLine: string | null;
  /** The step's line under the card (`CategoryCardInput.notice`); null for none. */
  notice: string | null;
}

const TOO_LARGE_CODE = "DROPSHIP_LISTING_SETTINGS_TOO_LARGE";
const CATEGORY_NOT_FOUND_CODE = "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND";
const HTTP_TOO_MANY_REQUESTS = 429;

function isTooLarge(error: unknown): boolean {
  return error instanceof DropshipApiError && error.code === TOO_LARGE_CODE;
}

function isCategoryNotFound(error: unknown): boolean {
  return error instanceof DropshipApiError && error.code === CATEGORY_NOT_FOUND_CODE;
}

function isRateLimited(error: unknown): boolean {
  return error instanceof DropshipApiError && error.status === HTTP_TOO_MANY_REQUESTS;
}

/** A failed card read in the vendor's words: too many checks in a minute (D10), else Try again. */
function cardReadProblem(error: unknown): CategoryCardReadProblem {
  if (isRateLimited(error)) return { kind: "rate_limited", text: DRAWER_WORDS.readRateLimited, retryLabel: LISTING_SETTINGS_SAVE_WORDS.tryAgain };
  return { kind: "failed", text: LISTING_SETTINGS_CATEGORY_WORDS.readFailed, retryLabel: LISTING_SETTINGS_SAVE_WORDS.tryAgain };
}

/** A failed refresh of a view still shown, in the vendor's words: too many checks in a minute (D10), else the drawer's. */
function latestReadFailure(error: unknown): CategoryLatestReadFailure {
  if (isRateLimited(error)) return { kind: "rate_limited", text: DRAWER_WORDS.readRateLimited, retryLabel: LISTING_SETTINGS_SAVE_WORDS.tryAgain };
  return { kind: "failed", text: DRAWER_WORDS.latestFailed, retryLabel: LISTING_SETTINGS_SAVE_WORDS.tryAgain };
}

/**
 * The card from its read, the summary, the step's draft and W12's right
 * (plan 8.3, 3.7). Rows are in the read's order (the server sorts by name,
 * then id). [Change] follows D11: while the store holds older group rules,
 * no row has one (the one line says why), except a category whose draft is
 * saving or unconfirmed; while that is unknown (the summary loading or
 * failed), [Change] is off with "Checking…"; otherwise W12's right decides.
 * The rows are the last answer's: a refresh that failed keeps them and says
 * so (React Query keeps `data` beside `error`), as the drawer keeps its rows.
 */
export function categorySettingsCardState(input: CategoryCardInput): CategoryCardState {
  const { read, summary } = input;
  const hidden = summary.data?.catalog.state === "too_large" || isTooLarge(read.error);
  const error = read.error ?? null;
  const view = read.data ?? null;
  const failed = error !== null && view === null;
  const older = olderRulesState(summary);
  const rows = (view?.categories ?? []).map((category): CategoryCardRow => {
    const draft = input.draft !== null && input.draft.editor === categoryEditorId(category.categoryId) ? input.draft : null;
    const held = draft !== null && isDraftLocked(draft);
    const words = categoryRowWords(category);
    let shown = true;
    let disabled = false;
    let line: string | null = null;
    // A held save keeps its [Change] whatever the rest says: its [Check again] must stay reachable (CC-C25; the
    // replay probe runs before the older-rules check, so a committed save still replays).
    if (!held) {
      if (older === "present") {
        shown = false;
      } else if (older === "unknown") {
        disabled = true;
        line = rightReasonLine("loading");
      } else if (!input.right.editable) {
        disabled = true;
        line = rightReasonLine(input.right.reason);
      }
    }
    return {
      key: `category:${category.categoryId}`,
      categoryId: category.categoryId,
      name: category.name,
      productCount: category.productCount,
      revisionId: category.revisionId,
      words,
      text: words.text,
      change: { label: LISTING_SETTINGS_SAVE_WORDS.change, ariaLabel: changeCategoryLabel(category.name), shown, disabled },
      line,
      held,
    };
  });
  return {
    title: LISTING_SETTINGS_CATEGORY_WORDS.title,
    intro: LISTING_SETTINGS_CATEGORY_WORDS.intro,
    hidden,
    read: failed ? "failed" : view === null ? "loading" : "answered",
    problem: failed && !hidden ? cardReadProblem(error) : null,
    latestFailed: error !== null && view !== null && !hidden ? latestReadFailure(error) : null,
    rows,
    uncategorized: view === null ? null : uncategorizedWords(view.uncategorizedProductCount),
    empty: view !== null && view.categories.length === 0 ? LISTING_SETTINGS_CATEGORY_WORDS.empty : null,
    olderRules: older,
    olderRulesLine: older === "present" && view !== null && view.categories.length > 0 ? LISTING_SETTINGS_CATEGORY_WORDS.olderRules : null,
    notice: input.notice ?? null,
  };
}

// ---------------------------------------------------------------------------
// The fields and their choices (plan 8.2, 8.3, D17)
// ---------------------------------------------------------------------------

/**
 * The fields the editor changes, in the drawer's order (plan 8.2): the three
 * policies, the eBay category, the store shelf, and the text above and below.
 * Never the price (read-only until 10f, UX-m9) and never a main text (a
 * category has none). The same seven "Also clear theirs" can clear
 * (`CATEGORY_CLEAR_FIELDS`, in the stored shape's order; a test pins the sets equal).
 */
export const CATEGORY_EDIT_FIELDS = [
  "shippingPolicy", "returnPolicy", "paymentPolicy", "ebayCategory", "storeShelf", "textAbove", "textBelow",
] as const satisfies readonly ProductEditField[];
export type CategoryEditField = (typeof CATEGORY_EDIT_FIELDS)[number];

/** A field's choice: leave it, "Use store default" (`default`, W12 null, D17), or set it (the drawer's value shapes). */
export type CategoryFieldChoice<F extends CategoryEditField> = ProductFieldChoice<F>;
export type CategoryChoices = { readonly [F in CategoryEditField]: CategoryFieldChoice<F> };
/** Some fields' choices at once: what one editor's [Done] puts in the draft. */
export type CategoryPicks = { readonly [F in CategoryEditField]?: CategoryFieldChoice<F> };

/** Any field's choice, for code that handles every field. */
type AnyChoice = FieldChoice<unknown>;

const LEAVE: FieldChoice<never> = Object.freeze({ mode: "leave" });
const DEFAULT: FieldChoice<never> = Object.freeze({ mode: "default" });
const FIELD_SET: ReadonlySet<string> = new Set(CATEGORY_EDIT_FIELDS);

export function isCategoryEditField(field: string): field is CategoryEditField {
  return FIELD_SET.has(field);
}

/** Every field left as it is. */
export function emptyCategoryChoices(): CategoryChoices {
  return Object.freeze({
    shippingPolicy: LEAVE, returnPolicy: LEAVE, paymentPolicy: LEAVE, ebayCategory: LEAVE, storeShelf: LEAVE, textAbove: LEAVE, textBelow: LEAVE,
  });
}

/** The fields a change touches, in the drawer's order. */
export function categoryChangedFields(choices: CategoryChoices): CategoryEditField[] {
  return CATEGORY_EDIT_FIELDS.filter((field) => choices[field].mode !== "leave");
}

/**
 * What the category sets itself, per field: the setting's value when its
 * source is `category`, null when the store default (or nothing) gives it.
 * The value shapes are the ones a product's own row stores (`SR`: the two
 * views share them), so the drawer's editors and words take them as they are.
 */
export type CategoryOwnValues = {
  readonly [F in CategoryEditField]: NonNullable<ListingSettingsCategorySettings[F]["value"]> | null;
};

export function categoryOwnValues(settings: ListingSettingsCategorySettings): CategoryOwnValues {
  const own: Record<string, unknown> = {};
  for (const field of CATEGORY_EDIT_FIELDS) {
    const setting = settings[field];
    own[field] = setting.source === "category" ? setting.value : null;
  }
  return Object.freeze(own) as CategoryOwnValues;
}

/** The category's own values in a product's own row's shape (no price, no main text), for the drawer's editors and words. */
export function categoryAsOwn(own: CategoryOwnValues): Pick<ProductOwnSettings, "own"> {
  return { own: { price: null, mainText: null, ...own } };
}

/** What the category has now, as choices: the field editors open on these ("Use store default" when it sets nothing of its own). */
export function choicesFromCategory(settings: ListingSettingsCategorySettings): CategoryChoices {
  const fromOwn = choicesFromOwn(categoryAsOwn(categoryOwnValues(settings)));
  const choices: Record<string, AnyChoice> = {};
  for (const field of CATEGORY_EDIT_FIELDS) choices[field] = fromOwn[field];
  return Object.freeze(choices) as unknown as CategoryChoices;
}

/**
 * A choice's meaning for comparing, by field: ids for eBay values (a renamed
 * policy, category or shelf is the same one), and text as it is stored.
 */
function choiceKey(field: CategoryEditField, choice: AnyChoice): string {
  if (choice.mode !== "set") return choice.mode;
  const value = choice.value as Record<string, unknown>;
  switch (field) {
    case "shippingPolicy":
    case "returnPolicy":
    case "paymentPolicy":
      return JSON.stringify(["set", value.id]);
    case "ebayCategory":
      return JSON.stringify(["set", value.categoryId]);
    case "storeShelf":
      return JSON.stringify(["set", value.mode, value.mode === "own" ? value.shelfIds : null]);
    case "textAbove":
    case "textBelow":
      return JSON.stringify(["set", value.mode, value.mode === "own" ? normalizedVendorText(String(value.text)) : null]);
  }
}

/** A choice as the draft keeps it: its own copy (the choices are JSON-like), so the draft never shares an object with an editor. */
function copyChoice<T>(choice: T): T {
  return JSON.parse(JSON.stringify(choice)) as T;
}

/**
 * The choice as the draft keeps it: one that asks for what the category has
 * now is "leave" ("Use store default" while it sets nothing of its own, or
 * its own value again), so it counts as no change. A clear-only save is the
 * `clear` field's, never a choice's.
 */
function draftChoice(field: CategoryEditField, choice: AnyChoice, own: CategoryOwnValues): AnyChoice {
  if (choice.mode === "leave") return LEAVE;
  const current = choicesFromOwn(categoryAsOwn(own))[field] as AnyChoice;
  if (choiceKey(field, choice) === choiceKey(field, current)) return LEAVE;
  return choice.mode === "default" ? DEFAULT : copyChoice(choice);
}

// ---------------------------------------------------------------------------
// The draft value (plan 8.2, 8.4, D6, D16)
// ---------------------------------------------------------------------------

/** One of the detail's `ownValues` entries: a chosen product with its own value in these settings, and its revision. */
export interface CategoryOwnValueEntry {
  readonly productId: number;
  /** The product's own settings revision; null when its own value is a size's leftover (W12 takes null). */
  readonly revisionId: number | null;
  /**
   * The category settings it holds its own value for, in the stored shape's
   * order. The price can be among them (the server's `ownCategoryFields`),
   * but no clear names it (plan P34): it never makes a product a candidate.
   */
  readonly fields: readonly CategoryListingSettingField[];
}

/**
 * What the draft starts from: the category, its revision, its own values and
 * its products' own values, all from one read (D6). A type, not an interface,
 * so the draft value built on it is a `DraftValue` the provider takes as it is.
 */
export type CategoryDraftFacts = {
  readonly categoryId: number;
  /** W12's `expectedRevisionId`: the detail's `revisionId`. */
  readonly expectedRevisionId: number | null;
  readonly own: CategoryOwnValues;
  readonly ownValues: readonly CategoryOwnValueEntry[];
};

/**
 * The editor's draft value: one field per choice (so the bar counts each
 * changed setting as one change), "Also clear theirs" as one field (`clear`,
 * the ticked settings in the stored shape's order: one change however many
 * are ticked), and the facts the draft started from, the same in the draft's
 * base and value. The base has every choice "leave" and nothing ticked.
 */
export type CategoryDraftValue = CategoryChoices & CategoryDraftFacts & {
  readonly clear: readonly CategoryClearField[];
};

export function categoryDraftFacts(detail: Pick<ListingSettingsCategoryDetail, "categoryId" | "revisionId" | "settings" | "ownValues">): CategoryDraftFacts {
  return Object.freeze({
    categoryId: detail.categoryId,
    expectedRevisionId: detail.revisionId,
    own: categoryOwnValues(detail.settings),
    ownValues: Object.freeze(detail.ownValues.map((entry) => Object.freeze({
      productId: entry.productId, revisionId: entry.revisionId, fields: Object.freeze([...entry.fields]),
    }))),
  });
}

/** The `ownValues` entries that hold their own value in `field` (plan 8.4): the products "Also clear theirs" would clear for it. */
export function clearCandidates(facts: Pick<CategoryDraftFacts, "ownValues">, field: CategoryClearField): CategoryOwnValueEntry[] {
  return facts.ownValues.filter((entry) => (entry.fields as readonly string[]).includes(field));
}

/**
 * Whether "Also clear theirs" can be ticked on `field` (plan 8.4, CC-C4,
 * CC-C15): products hold their own value in it, and the save sets it on the
 * category: the vendor sets it, or the category already sets it (the current
 * value is sent again). Never with "Use store default", and never on a field
 * the store default gives: every cleared field is non-null in the patch
 * (`SW:438-445`), so the store default is never pinned on the category.
 */
export function clearAllowed(facts: Pick<CategoryDraftFacts, "own" | "ownValues">, field: CategoryClearField, choice: AnyChoice): boolean {
  if (clearCandidates(facts, field).length === 0) return false;
  if (choice.mode === "set") return true;
  return choice.mode === "leave" && facts.own[field] !== null;
}

/** The draft value on `facts`; with no choices and nothing ticked, it is the draft's base. */
export function categoryDraftValueOn(
  facts: CategoryDraftFacts,
  choices: CategoryChoices = emptyCategoryChoices(),
  clear: readonly CategoryClearField[] = [],
): CategoryDraftValue {
  const value: Record<string, unknown> = {};
  for (const field of CATEGORY_EDIT_FIELDS) value[field] = draftChoice(field, choices[field], facts.own);
  const wanted = new Set(clear);
  const kept = CATEGORY_CLEAR_FIELDS.filter((field) => wanted.has(field) && clearAllowed(facts, field, value[field] as AnyChoice));
  return {
    ...value,
    clear: Object.freeze(kept),
    categoryId: facts.categoryId,
    expectedRevisionId: facts.expectedRevisionId,
    own: facts.own,
    ownValues: facts.ownValues,
  } as unknown as CategoryDraftValue;
}

/** The draft value on the detail read; with no choices and nothing ticked, it is the draft's base. */
export function categoryDraftValue(
  detail: Pick<ListingSettingsCategoryDetail, "categoryId" | "revisionId" | "settings" | "ownValues">,
  choices: CategoryChoices = emptyCategoryChoices(),
  clear: readonly CategoryClearField[] = [],
): CategoryDraftValue {
  return categoryDraftValueOn(categoryDraftFacts(detail), choices, clear);
}

const MAX_ID = 2_147_483_647;
const CLEAR_FIELD_SET: ReadonlySet<string> = new Set(CATEGORY_CLEAR_FIELDS);
const SETTING_FIELD_SET: ReadonlySet<string> = new Set(CATEGORY_LISTING_SETTING_FIELDS);

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_ID;
}

function isRevision(value: unknown): value is number | null {
  return value === null || isId(value);
}

function isFieldList(value: unknown, known: ReadonlySet<string>): value is readonly string[] {
  return Array.isArray(value) && value.every((field) => typeof field === "string" && known.has(field)) && new Set(value).size === value.length;
}

function isClearFields(value: unknown): value is readonly CategoryClearField[] {
  return isFieldList(value, CLEAR_FIELD_SET);
}

function isOwnValueEntries(value: unknown): value is readonly CategoryOwnValueEntry[] {
  if (!Array.isArray(value)) return false;
  const seen = new Set<number>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return false;
    const { productId, revisionId, fields } = entry as Record<string, unknown>;
    if (!isId(productId) || seen.has(productId) || !isRevision(revisionId) || !isFieldList(fields, SETTING_FIELD_SET) || fields.length === 0) return false;
    seen.add(productId);
  }
  return true;
}

/** The editor's draft value, or null when `value` is not one (a product's draft, a Store defaults row's, the sheet's). */
export function readCategoryDraft(value: DraftValue): CategoryDraftValue | null {
  const { categoryId, expectedRevisionId, own, ownValues, clear } = value;
  if (!isId(categoryId) || !isRevision(expectedRevisionId)) return null;
  if (typeof own !== "object" || own === null || !isOwnValueEntries(ownValues) || !isClearFields(clear)) return null;
  if (!CATEGORY_EDIT_FIELDS.every((field) => isProductFieldChoice(field, value[field]))) return null;
  return value as unknown as CategoryDraftValue;
}

/** Whether the draft asks for anything: a changed field, or "Also clear theirs" ticked (a clear-only save). */
export function categoryHasChange(value: Pick<CategoryDraftValue, CategoryEditField | "clear">): boolean {
  return categoryChangedFields(value).length > 0 || value.clear.length > 0;
}

/** This category's draft and its value, when the step's one draft is it; null otherwise. */
export function ownCategoryDraft(draft: ListingSettingsDraft | null, categoryId: number): { draft: ListingSettingsDraft; value: CategoryDraftValue } | null {
  if (draft === null || draft.editor !== categoryEditorId(categoryId)) return null;
  const value = readCategoryDraft(draft.value);
  return value === null ? null : { draft, value };
}

/** Whether the step's one draft is this category's save, out or unconfirmed: the editor opens on it (D21), the card keeps its [Change] (D11). */
export function categoryHoldsSave(draft: ListingSettingsDraft | null, categoryId: number): boolean {
  const own = ownCategoryDraft(draft, categoryId);
  return own !== null && isDraftLocked(own.draft);
}

/**
 * The editor's read answered 404 (8.6: no chosen product is in the category
 * any more; the editor closes): whether its draft goes with it. This
 * category's draft does, unless a save is out or unconfirmed: a save the
 * surface can't confirm is never dropped (3.4), its Check again is answered
 * by the replay probe before the chosen check
 * (`S/application/dropship-listing-category-settings-service.ts` write).
 */
export function categoryGoneDiscards(draft: ListingSettingsDraft | null, categoryId: number): boolean {
  return draft !== null && draft.editor === categoryEditorId(categoryId) && !isDraftLocked(draft);
}

/** What putting a choice, or a tick, in the editor's draft does (nothing is sent until Save). */
export type CategoryEditAction =
  /** The draft takes it: send `value` to `drafts.edit`. */
  | { kind: "edit"; value: CategoryDraftValue }
  /**
   * The draft starts again on the detail read now (D6): `drafts.open(editor, place, base)`,
   * then `drafts.edit(value)`. A clean draft after a confirmed save holds the revision and the
   * "Also clear theirs" set the save moved, so the next change starts from the read made after it.
   */
  | { kind: "start"; editor: EditorId; place: string; base: CategoryDraftValue; value: CategoryDraftValue }
  /** A save is in flight or unconfirmed: nothing changes until it ends (R:539, R:541). */
  | { kind: "locked" }
  /** The editor's draft isn't open yet (its read hasn't answered), or another editor holds a change. */
  | { kind: "not_open" };

/** What a pick or a tick starts from: the step's one draft, the category, and the detail read now (when the editor has it). */
export interface CategoryEditFacts {
  draft: ListingSettingsDraft | null;
  categoryId: number;
  /** The editor's detail read as it is now; left out, the draft's own facts are the only ones (step 1's callers). */
  detail?: Pick<ListingSettingsCategoryDetail, "categoryId" | "name" | "revisionId" | "settings" | "ownValues"> | null;
}

type CategoryEditStart = Extract<CategoryEditAction, { kind: "start" }>;

/**
 * The value a pick or a tick goes on, and whether the draft must open again
 * first: a draft holding a change, or one with no read to start from, takes
 * the pick on the facts it was made against (D6); a clean draft (or none)
 * with the detail read at hand starts again on that read, since after a
 * confirmed save its revision and clear set have moved (the reducer opens a
 * clean draft anew on its base). Another editor's unsaved change, or a read
 * for another category, opens nothing.
 */
function categoryEditFrom(input: CategoryEditFacts): { current: CategoryDraftValue; start: Omit<CategoryEditStart, "kind" | "value"> | null } | Extract<CategoryEditAction, { kind: "locked" | "not_open" }> {
  const own = ownCategoryDraft(input.draft, input.categoryId);
  if (own !== null && isDraftLocked(own.draft)) return { kind: "locked" };
  const detail = input.detail !== undefined && input.detail !== null && input.detail.categoryId === input.categoryId ? input.detail : null;
  if (own !== null && (isDraftDirty(own.draft) || detail === null)) return { current: own.value, start: null };
  const editor = categoryEditorId(input.categoryId);
  if (detail !== null && decideOpen(input.draft, editor) === "open") {
    const base = categoryDraftValue(detail);
    return { current: base, start: { editor, place: detail.name, base } };
  }
  return own === null ? { kind: "not_open" } : { current: own.value, start: null };
}

/** The picks one call puts in the draft, checked against each field's shape; a mismatch is a programming fault. */
function checkedPicks(picks: Readonly<Record<string, unknown>>): Array<[CategoryEditField, AnyChoice]> {
  return Object.keys(picks).filter((field) => picks[field] !== undefined).map((field) => {
    const choice = picks[field];
    if (!isCategoryEditField(field) || !isProductFieldChoice(field, choice)) {
      throw new Error(`A category edit names a field or a choice the editor doesn't set: ${field}.`);
    }
    return [field, choice as AnyChoice];
  });
}

/**
 * [Done] in a field editor: its choices go in the editor's draft. A choice
 * that asks for what the category has is no change; "Use store default" on a
 * field drops its "Also clear theirs" tick (the clear needs a set value).
 */
export function categoryPickAction(input: CategoryEditFacts & { picks: CategoryPicks }): CategoryEditAction {
  const picks = checkedPicks(input.picks);
  const from = categoryEditFrom(input);
  if ("kind" in from) return from;
  const choices: Record<string, AnyChoice> = {};
  for (const field of CATEGORY_EDIT_FIELDS) choices[field] = from.current[field];
  for (const [field, choice] of picks) choices[field] = choice;
  const value = categoryDraftValueOn(from.current, choices as unknown as CategoryChoices, from.current.clear);
  return from.start === null ? { kind: "edit", value } : { kind: "start", ...from.start, value };
}

/** "Also clear theirs" ticked or unticked on `field`: the draft takes it when the box can show (`clearAllowed`); otherwise the tick is dropped. */
export function categoryClearAction(input: CategoryEditFacts & { field: CategoryClearField; ticked: boolean }): CategoryEditAction {
  if (!CLEAR_FIELD_SET.has(input.field)) throw new Error(`A category clear names a setting it can't clear: ${input.field}.`);
  const from = categoryEditFrom(input);
  if ("kind" in from) return from;
  const clear = input.ticked ? [...from.current.clear, input.field] : from.current.clear.filter((field) => field !== input.field);
  const value = categoryDraftValueOn(from.current, from.current, clear);
  return from.start === null ? { kind: "edit", value } : { kind: "start", ...from.start, value };
}

// ---------------------------------------------------------------------------
// The W12 request (plan 8.4, 8.5, D1, D5)
// ---------------------------------------------------------------------------

/** The category's own value as the ids-only input W12 takes: what a clear-only save sends again (plan 8.4, P20). */
function ownValueAsInput(field: CategoryEditField, value: NonNullable<CategoryOwnValues[CategoryEditField]>): unknown {
  switch (field) {
    case "shippingPolicy":
    case "returnPolicy":
    case "paymentPolicy":
      return { id: (value as { id: string }).id };
    case "ebayCategory":
      return { categoryId: (value as { categoryId: string }).categoryId };
    case "storeShelf": {
      const shelf = value as NonNullable<CategoryOwnValues["storeShelf"]>;
      return shelf.mode === "own" ? { mode: "own", shelfIds: shelf.shelves.map((entry) => entry.id) } : { mode: "none" };
    }
    case "textAbove":
    case "textBelow": {
      const text = value as NonNullable<CategoryOwnValues["textAbove"]>;
      return text.mode === "own" ? { mode: "own", text: text.text } : { mode: "none" };
    }
  }
}

/**
 * leave → absent, "Use store default" → null, set → ids and text only (W5's
 * patch, `productSettingsPatch`); a field left alone with "Also clear theirs"
 * ticked → the category's current value as ids-only input, so the field is
 * set on the category by this save (`SW:438-445`) and the save is
 * `unchanged` for it (P20). Never a price, never a main text.
 */
export function categoryPatch(value: Pick<CategoryDraftValue, CategoryEditField | "own" | "clear">): CategorySettingsPatchInput {
  const choices: Record<string, AnyChoice> = { mainText: LEAVE };
  for (const field of CATEGORY_EDIT_FIELDS) choices[field] = value[field];
  const patch: Record<string, unknown> = productSettingsPatch(choices as unknown as ProductSettingsChoices);
  for (const field of value.clear) {
    const own = value.own[field];
    if (value[field].mode === "leave" && own !== null) patch[field] = ownValueAsInput(field, own);
  }
  return patch as CategorySettingsPatchInput;
}

/**
 * "Also clear theirs" as W12 takes it (plan 8.4): the ticked fields in the
 * stored shape's order, and the union of the `ownValues` entries holding any
 * of them, each once, ascending, with the revision it was read with (null
 * allowed). Undefined when nothing is ticked.
 */
export function categoryClearBody(value: Pick<CategoryDraftValue, "clear" | "ownValues">): SaveCategorySettingsInput["clear"] | undefined {
  const fields = CATEGORY_CLEAR_FIELDS.filter((field) => value.clear.includes(field));
  if (fields.length === 0) return undefined;
  const ticked = new Set<string>(fields);
  const products = value.ownValues
    .filter((entry) => entry.fields.some((field) => ticked.has(field)))
    .map((entry) => ({ productId: entry.productId, expectedRevisionId: entry.revisionId }))
    .sort((left, right) => left.productId - right.productId);
  return { fields, products };
}

/** "Also clear theirs" as given to the body and the signature: the ticked fields and the products, read-only (never mutated). */
export type CategoryClearInput = {
  readonly fields: readonly CategoryClearField[];
  readonly products: ReadonlyArray<{ readonly productId: number; readonly expectedRevisionId: number | null }>;
};

/** The W12 body this page sends: the request key, the revision, the patch, and "Also clear theirs" when ticked. */
export type CategorySaveBody = SaveCategorySettingsInput;

export const CATEGORY_REQUEST_INVALID = "DROPSHIP_LISTING_SETTINGS_CATEGORY_REQUEST_INVALID";

/** A W12 body this page would build outside the contract: never sent. */
export class CategoryRequestError extends Error {
  readonly code = CATEGORY_REQUEST_INVALID;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(message: string, context: Record<string, unknown>) {
    super(message);
    this.name = "CategoryRequestError";
    this.context = Object.freeze({ ...context });
  }
}

/**
 * The W12 body, checked by the shared input schema before it is sent. Throws
 * a CategoryRequestError for a field this page doesn't edit (a price or a
 * main text above all, D1, P34), an empty patch, a cleared field the patch
 * doesn't set, a clear with no product, or anything else the schema refuses
 * (text over its limit included). What is sent is the schema's output: own
 * text with its line breaks as "\n" and trimmed, as the server stores it.
 */
export function categorySaveBody(input: {
  key: string;
  expectedRevisionId: number | null;
  patch: CategorySettingsPatchInput;
  clear?: CategoryClearInput | undefined;
}): CategorySaveBody {
  const sent = Object.keys(input.patch).filter((field) => input.patch[field as keyof CategorySettingsPatchInput] !== undefined);
  const outside = sent.filter((field) => !FIELD_SET.has(field));
  if (outside.length > 0) throw new CategoryRequestError("This change names a setting the category editor doesn't save.", { fields: outside });
  if (sent.length === 0) throw new CategoryRequestError("There is no change to save.", { fields: [] });
  const unset = (input.clear?.fields ?? []).filter((field) => input.patch[field] == null);
  if (unset.length > 0) throw new CategoryRequestError("A cleared setting must be set on the category by this change.", { fields: unset });
  const parsed = saveCategorySettingsInputSchema.safeParse({
    idempotencyKey: input.key,
    expectedRevisionId: input.expectedRevisionId,
    patch: input.patch,
    ...(input.clear === undefined ? {} : { clear: { fields: [...input.clear.fields], products: input.clear.products.map((product) => ({ ...product })) } }),
  });
  if (!parsed.success) {
    throw new CategoryRequestError("This change can't be sent as it is.", {
      issues: parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join("."), code: issue.code })),
    });
  }
  return parsed.data;
}

/**
 * Everything a W12 request sends except its key: the same request always
 * reuses its key (a retry is answered by the first save), and any edit, a
 * tick, or a new revision after "Load latest" gets a new one. The order of the
 * clear's fields and products doesn't count (the server sorts both too);
 * their revisions do, and so does shelf order (first, then second).
 */
export function categorySignature(
  storeConnectionId: number,
  categoryId: number,
  expectedRevisionId: number | null,
  patch: CategorySettingsPatchInput,
  clear: CategoryClearInput | undefined,
): string {
  const cleared = clear === undefined ? null : [
    CATEGORY_CLEAR_FIELDS.filter((field) => clear.fields.includes(field)),
    [...clear.products].sort((left, right) => left.productId - right.productId).map((product) => [product.productId, product.expectedRevisionId]),
  ];
  return JSON.stringify(["listing-settings-category-settings-v1", storeConnectionId, categoryId, expectedRevisionId, patchSignatureEntries(patch), cleared]);
}

// ---------------------------------------------------------------------------
// Who may change which field (D3, D4)
// ---------------------------------------------------------------------------

/** The rights the editor reads: W12's, and the rights its fields pick eBay values with. */
export type CategorySettingsRights = Pick<ListingSettingsEditRights, "categorySettings" | "shipping" | "policies" | "ebayCategory" | "shelfPick">;

/**
 * A field's rights: W12's right AND the field's own pick right, as the
 * drawer's (`productFieldRights`): a paused vendor or inactive .ops takes W12
 * away, so nothing can be chosen (D3); a sign-in or eBay refusing access
 * leaves "Use store default" (and "None" for the shelf and text) only, since
 * W12 asks eBay about every id the category doesn't store yet (D4; the
 * category's own ids are known, so a clear-only save works under a sign-in).
 */
export function categoryFieldRights(rights: CategorySettingsRights, field: CategoryEditField): ProductFieldRights {
  return productFieldRights({
    productSettings: rights.categorySettings, shipping: rights.shipping, policies: rights.policies,
    ebayCategory: rights.ebayCategory, shelfPick: rights.shelfPick,
  }, field);
}

// ---------------------------------------------------------------------------
// Opening the editor, "Load latest and keep my changes", Discard (D6, D16, D21; plan 8.6)
// ---------------------------------------------------------------------------

/** What opening the editor does to the step's one draft. */
export type CategoryEditorOpen =
  /** The detail read made for this opening hasn't answered yet: wait for it. */
  | { kind: "wait" }
  /** Another editor holds a change, or is saving one (D16; the address opened the editor without [Change]'s question): close, read nothing. */
  | { kind: "elsewhere" }
  /** `drafts.open(categoryEditorId(id), <the category's name>, base)`. */
  | { kind: "open"; base: CategoryDraftValue }
  /**
   * The editor's draft stays as it is (reopen it with `drafts.open`, which
   * keeps it): a save is out or unconfirmed, so Check again resends exactly
   * that request (D21), or it holds changes. Its revision and clear set stay
   * the ones the change was made against: a category or product saved
   * elsewhere since is the server's 409, worded (8.6), with Load latest.
   */
  | { kind: "keep" };

export function categoryEditorOpen(
  draft: ListingSettingsDraft | null,
  categoryId: number,
  detail: Pick<ListingSettingsCategoryDetail, "categoryId" | "revisionId" | "settings" | "ownValues"> | null,
): CategoryEditorOpen {
  if (decideOpen(draft, categoryEditorId(categoryId)) !== "open") return { kind: "elsewhere" };
  const own = ownCategoryDraft(draft, categoryId);
  if (own !== null && (isDraftLocked(own.draft) || isDraftDirty(own.draft))) return { kind: "keep" };
  if (detail === null) return { kind: "wait" };
  return { kind: "open", base: categoryDraftValue(detail) };
}

/** "Load latest": the vendor's choices and ticks on what is saved now, and whether any of them is still a change. */
export interface CategoryReload {
  /** The vendor's choices on what is saved now, the clear set rebuilt from the new `ownValues`: send it to the draft first. */
  edited: CategoryDraftValue;
  /** What is saved now, the draft's new base: rebase on it with `marked`. */
  latest: CategoryDraftValue;
  /** The fields the vendor changed whose category value another window moved too (R:542, C20). */
  marked: CategoryEditField[];
  /** False when nothing of the vendor's is left to keep: the draft is discarded instead. */
  keeps: boolean;
}

/** Whether a field's saved value differs between two reads. A renamed policy, category or shelf is the same one. */
function ownValueMoved(field: CategoryEditField, before: CategoryOwnValues, after: CategoryOwnValues): boolean {
  const key = (own: CategoryOwnValues) => choiceKey(field, choicesFromOwn(categoryAsOwn(own))[field] as AnyChoice);
  return key(before) !== key(after);
}

/**
 * After a 409 (plan 8.6): the vendor's choices on the detail read now
 * (`edited`), with the clear set rebuilt from the new `ownValues` (a tick
 * whose field can't be cleared any more is dropped), and what is saved now
 * (`latest`), the draft's new base, with the fields both changed marked.
 * Send `edited` first, then rebase on `latest` with `marked`. A choice that
 * now matches what is saved is no longer a change, and is not marked.
 */
export function rebaseCategoryDraft(
  mine: CategoryDraftValue,
  latest: Pick<ListingSettingsCategoryDetail, "categoryId" | "revisionId" | "settings" | "ownValues">,
): CategoryReload {
  const edited = categoryDraftValue(latest, mine, mine.clear);
  const changed = categoryChangedFields(edited);
  return {
    edited,
    latest: categoryDraftValue(latest),
    marked: changed.filter((field) => ownValueMoved(field, mine.own, edited.own)),
    keeps: categoryHasChange(edited),
  };
}

/**
 * [Discard] in the editor: every field back to as it is and nothing ticked
 * (`reset`, send `value` to `drafts.edit`); after a 409 the draft's revision
 * and clear set are known to be old, so the detail is read again instead
 * (`reread`, then `rebaseCategoryDraft` with nothing kept); `none` without
 * an editor draft, or while one is locked.
 */
export type CategoryDiscard = { kind: "reset"; value: CategoryDraftValue } | { kind: "reread" } | { kind: "none" };

export function categoryDiscard(draft: ListingSettingsDraft | null, categoryId: number): CategoryDiscard {
  const own = ownCategoryDraft(draft, categoryId);
  if (own === null || isDraftLocked(own.draft)) return { kind: "none" };
  if (own.draft.phase === "conflict") return { kind: "reread" };
  return { kind: "reset", value: categoryDraftValueOn(own.value) };
}

// ---------------------------------------------------------------------------
// The rows' editors (plan 8.2, D17): the drawer's models, opening on the draft's choice, else the category's value
// ---------------------------------------------------------------------------

/** A policy row's editor (`DrawerFieldEditor`, its "Use default" worded "Use store default", D17). */
export function categoryPolicyFieldEditor(input: {
  field: PolicyEditField;
  rights: Pick<ProductFieldRights, "canSet" | "canDefault">;
  draftChoice: CategoryFieldChoice<PolicyEditField>;
  own: CategoryOwnValues;
  setup: ListingSettingsReadState<PolicySetupFacts>;
}): PolicyFieldEditorModel {
  return policyFieldEditor({ field: input.field, rights: input.rights, draftChoice: input.draftChoice, own: categoryAsOwn(input.own), setup: input.setup });
}

/** The eBay category row's editor: the category picker while one can be picked, "Use store default", opening on the draft's choice. */
export function categoryEbayCategoryFieldEditor(input: {
  rights: Pick<ProductFieldRights, "canSet" | "canDefault">;
  draftChoice: CategoryFieldChoice<"ebayCategory">;
  own: CategoryOwnValues;
}): EbayCategoryFieldEditorModel {
  return ebayCategoryFieldEditor({ rights: input.rights, draftChoice: input.draftChoice, own: categoryAsOwn(input.own) });
}

/** The store shelf row's editor: one or two shelves from the shelves read (the category's own kept, marked when gone), None, "Use store default". */
export function categoryStoreShelfFieldEditor(input: {
  rights: Pick<ProductFieldRights, "canSet" | "canDefault" | "canNone">;
  draftChoice: CategoryFieldChoice<"storeShelf">;
  own: CategoryOwnValues;
  shelves: readonly DropshipEbayStoreCategoryOption[] | null;
}): StoreShelfFieldEditorModel {
  return storeShelfFieldEditor({ rights: input.rights, draftChoice: input.draftChoice, own: categoryAsOwn(input.own), shelves: input.shelves });
}

/** The Description row's two parts: text above and below. A category has no main text, so the editor shows none (`mainTextOwn` false; the component hides the part). */
export const CATEGORY_DESCRIPTION_FIELDS = ["textAbove", "textBelow"] as const satisfies readonly CategoryEditField[];
export type CategoryDescriptionField = (typeof CATEGORY_DESCRIPTION_FIELDS)[number];

/**
 * The Description row's editor (`DrawerDescriptionEditor`): text above and
 * below with "Use store default", None or own text, each opening on the
 * draft's choice, else the category's value. No main text (a category has
 * none: `mainTextOwn` false, its part at the default, which the component
 * hides), no check, no tie line.
 */
export function categoryDescriptionFieldEditor(input: {
  rights: Pick<ProductFieldRights, "canSet" | "canDefault" | "canNone">;
  draftChoices: Pick<CategoryChoices, CategoryDescriptionField>;
  own: CategoryOwnValues;
}): DescriptionEditorModel {
  const model = descriptionFieldEditor({
    rights: input.rights,
    draftChoices: { textAbove: input.draftChoices.textAbove, textBelow: input.draftChoices.textBelow, mainText: LEAVE },
    own: categoryAsOwn(input.own),
  });
  return { ...model, mainTextOwn: false, check: null, conflictLine: null };
}

export type CategoryDescriptionEditorResult =
  | { ok: true; picks: Pick<CategoryPicks, CategoryDescriptionField> }
  | { ok: false; problems: Partial<Record<CategoryDescriptionField, string>> };

/** The Description editor's [Done]: each part the vendor changed (own text checked as typed, the drawer's `descriptionEditorResult`); never a main text. */
export function categoryDescriptionEditorResult(model: DescriptionEditorModel, state: DescriptionEditorState): CategoryDescriptionEditorResult {
  const result = descriptionEditorResult({ ...model, mainTextOwn: false }, { ...state, mainText: model.initial.mainText });
  if (!result.ok) {
    const { mainText: _mainText, ...problems } = result.problems;
    return { ok: false, problems };
  }
  const { mainText: _mainText, ...picks } = result.picks;
  return { ok: true, picks };
}

// ---------------------------------------------------------------------------
// The editor (plan 8.3, 8.4, 3.7)
// ---------------------------------------------------------------------------

export interface CategoryEditorInput {
  /** The card's row the editor opened from (its name and count name the editor while the detail loads); null from the address alone. */
  category: { categoryId: number; name: string; productCount: number } | null;
  categoryId: number;
  /** The editor's read (`categoryEditorQueryOptions`), as React Query holds it. */
  detail: ListingSettingsReadState<ListingSettingsCategoryDetail>;
  /** The step's summary read: the older-rules counts (D11); while they are present no save is offered here either. */
  summary: ListingSettingsReadState<OlderRulesSummaryFacts>;
  /** The step's one draft, whoever holds it. */
  draft: ListingSettingsDraft | null;
  rights: CategorySettingsRights;
  /** The live eBay setup read, to name policies. */
  setup: ListingSettingsReadState<PolicySetupFacts>;
  /** The step's shelves read, to name a picked shelf; null or absent while it can't be read. */
  shelves?: readonly DropshipEbayStoreCategoryOption[] | null;
  /** The row whose editor is open; one at a time. */
  openTarget: DrawerEditTarget | null;
  /** The last refused save, with the fields it named (`WriteFailure.fields`); shown by its rows only while the draft is refused. */
  failure: Pick<WriteFailure, "message" | "fields"> | null;
  /** Another listing action is running, or a read for the footer is in flight. */
  busy: boolean;
  /** "Saved" shows now (3 seconds after a confirmed save, R:538). */
  savedFlashVisible: boolean;
  compact: boolean;
  /** A row's editor is open: its pick isn't in the draft until [Done]. */
  fieldEditorOpen: boolean;
}

/** "Also clear theirs" under one field (plan 8.4). */
export interface CategoryClearBox {
  field: CategoryClearField;
  /** How many of the category's products hold their own value in the field. */
  count: number;
  /** "3 products in Sleeves have their own shipping policy." */
  line: string;
  /** "Also clear theirs, so all 15 use this one." */
  label: string;
  ticked: boolean;
  /** Off while the draft isn't open, a save is out or unconfirmed, or W12 can't be used. */
  disabled: boolean;
}

export interface CategoryEditorRow {
  key: DrawerSettingRowKey;
  /** The row as `DrawerSettingRow` draws it: the value with "Set for Sleeves" or "Store default", the pending change, [Change]. */
  row: DrawerSettingRowModel;
  /** The fields the row's editor changes. */
  fields: readonly CategoryEditField[];
  /** "Also clear theirs" for each of its fields that can take it, in field order (none while it can't, 8.4). */
  clears: CategoryClearBox[];
}

/** The Price row, read-only until the category price check (10f, UX-m9). */
export interface CategoryPriceRow {
  label: string;
  /** "Retail price + 20%, round up to .99", or the no-store-price words. */
  value: string;
  /** "Set for Sleeves" or "Store default"; null when nothing gives a price (the value says so itself). */
  tag: string | null;
  /** Why there is no [Change]. */
  line: string;
}

export type CategoryEditorReadProblem = { kind: "not_found" | "too_large" | "rate_limited" | "failed"; text: string; retryLabel: string | null };

export interface CategoryEditorState {
  /** "Sleeves · 15 products". */
  title: string;
  name: string;
  /** `failed` only while nothing is shown: a failed refresh keeps the rows and says so in `latestFailed`. */
  read: "loading" | "failed" | "answered";
  /** "Loading Sleeves…" while the detail reads; null otherwise. */
  loadingLine: string | null;
  problem: CategoryEditorReadProblem | null;
  /** The rows are the last answer's and their refresh failed (a save's re-read, Load latest, Reload); null otherwise. */
  latestFailed: CategoryLatestReadFailure | null;
  /** The answer the rows show, for this category: kept across a failed refresh; null until one answers, or once a 404 or a 422 replaced it. */
  detail: ListingSettingsCategoryDetail | null;
  rows: CategoryEditorRow[];
  /**
   * The category's own values the rows and their editors read: the draft's while it holds a change
   * or a save (D6), else the detail read's; null until the read answers.
   */
  own: CategoryOwnValues | null;
  price: CategoryPriceRow | null;
  footer: DrawerFooter;
  /** Esc keeps the editor open: a save is out or unconfirmed (3.4). */
  escapeKeepsOpen: boolean;
  /** This category's save is out or unconfirmed. */
  held: boolean;
}

/**
 * A one-field row's change before Save, by name only: the drawer's words,
 * except "Use store default" for the default (D17).
 */
export function categoryFieldPending(
  field: DrawerFieldTarget,
  choice: ProductFieldChoice<DrawerFieldTarget>,
  setup: ListingSettingsReadState<PolicySetupFacts>,
  own: CategoryOwnValues,
  shelves: readonly DropshipEbayStoreCategoryOption[] | null,
): string | null {
  if (choice.mode === "default") return pendingSettingWords(LISTING_SETTINGS_CATEGORY_WORDS.useStoreDefault);
  return fieldPendingWords(field, choice, setup, categoryAsOwn(own), shelves);
}

/** The Description row's change before Save: each part it changes, never the text itself ("→ Text above: Use store default, text below: None · Not saved", D17). */
export function categoryDescriptionPending(choices: Pick<CategoryChoices, CategoryDescriptionField>): string | null {
  const parts = CATEGORY_DESCRIPTION_FIELDS.flatMap((field) => {
    const choice = choices[field];
    if (choice.mode === "leave") return [];
    const label = LISTING_SETTINGS_EDIT_WORDS[field];
    const value = choice.mode === "default" ? LISTING_SETTINGS_CATEGORY_WORDS.useStoreDefault
      : choice.value.mode === "none" ? LISTING_SETTINGS_EDIT_WORDS.none : "your own";
    return [`${label}: ${value}`];
  });
  if (parts.length === 0) return null;
  return pendingSettingWords(parts.map((part, index) => (index === 0 ? part : part.charAt(0).toLowerCase() + part.slice(1))).join(", "));
}

/** The tag beside a value, by where it comes from (8.3): "Set for Sleeves", "Store default", or none when nothing gives it (the value says so itself, as the drawer's `none`). */
function sourceTag(source: ListingSettingsCategorySettingSource, name: string): string | null {
  switch (source) {
    case "category":
      return setForCategoryWords(name);
    case "store_default":
      return LISTING_SETTINGS_CATEGORY_WORDS.storeDefault;
    case "none":
      return null;
  }
}

/** The tags of a row's value: each source's tag once, in the order given, none for a source without one. */
function sourceTags(sources: readonly ListingSettingsCategorySettingSource[], name: string): string[] {
  return [...new Set(sources.map((source) => sourceTag(source, name)).filter((tag): tag is string => tag !== null))];
}

type SettingOf<K extends keyof ListingSettingsCategorySettings> = ListingSettingsCategorySettings[K];

function policyEntry(key: PolicyEditField, setting: SettingOf<PolicyEditField>, name: string, setup: ListingSettingsReadState<PolicySetupFacts>): DrawerSettingEntry {
  return {
    value: drawerPolicyValue(key, { policyId: setting.value?.id ?? null }, setup, setting.value?.name ?? null),
    tags: sourceTags([setting.source], name),
    usedBy: null,
  };
}

function ebayCategoryEntry(setting: SettingOf<"ebayCategory">, name: string): DrawerSettingEntry {
  return {
    value: setting.value === null ? storeDefaultEbayCategoryValue(null) : drawerEbayCategoryValue(setting.value),
    tags: sourceTags([setting.source], name),
    usedBy: null,
  };
}

function storeShelfEntry(setting: SettingOf<"storeShelf">, name: string): DrawerSettingEntry {
  const shelf = setting.value;
  return {
    value: shelf === null || shelf.mode === "none" ? LISTING_SETTINGS_EDIT_WORDS.none : drawerStoreShelfValue({ names: shelf.shelves.map((entry) => shelfPathWords(entry.name)) }),
    tags: sourceTags([setting.source], name),
    usedBy: null,
  };
}

function descriptionEntry(settings: ListingSettingsCategorySettings, name: string): DrawerSettingEntry {
  const tags = sourceTags([settings.textAbove.source, settings.textBelow.source], name);
  return {
    value: drawerDescriptionTemplateValue({
      hasIntroduction: settings.textAbove.value?.mode === "own",
      hasFooter: settings.textBelow.value?.mode === "own",
      groupConflict: false,
    }),
    tags,
    usedBy: null,
  };
}

function settingEntry(key: DrawerSettingRowKey, settings: ListingSettingsCategorySettings, name: string, setup: ListingSettingsReadState<PolicySetupFacts>): DrawerSettingEntry {
  switch (key) {
    case "shippingPolicy":
    case "returnPolicy":
    case "paymentPolicy":
      return policyEntry(key, settings[key], name, setup);
    case "ebayCategory":
      return ebayCategoryEntry(settings.ebayCategory, name);
    case "storeShelf":
      return storeShelfEntry(settings.storeShelf, name);
    case "descriptionTemplate":
      return descriptionEntry(settings, name);
  }
}

/** Why the detail couldn't be read, in the vendor's words (3.7): the category is gone, too large, too many checks, else Try again. */
function editorReadProblem(error: unknown): CategoryEditorReadProblem {
  if (isCategoryNotFound(error)) return { kind: "not_found", text: LISTING_SETTINGS_CATEGORY_WORDS.categoryNotFound, retryLabel: null };
  if (isTooLarge(error)) return { kind: "too_large", text: LISTING_SETTINGS_CATEGORY_WORDS.readTooLarge, retryLabel: null };
  if (isRateLimited(error)) return { kind: "rate_limited", text: DRAWER_WORDS.readRateLimited, retryLabel: LISTING_SETTINGS_SAVE_WORDS.tryAgain };
  return { kind: "failed", text: LISTING_SETTINGS_CATEGORY_WORDS.readFailed, retryLabel: LISTING_SETTINGS_SAVE_WORDS.tryAgain };
}

/** The Price row (UX-m9): the category's own price, else the store default, read-only. */
function priceRow(settings: ListingSettingsCategorySettings, name: string): CategoryPriceRow {
  const price = settings.price;
  return {
    label: DRAWER_WORDS.priceHead,
    value: price.value === null ? DRAWER_WORDS.noStorePrice : recipeWords(price.value),
    tag: sourceTag(price.source, name),
    line: LISTING_SETTINGS_CATEGORY_WORDS.priceReadOnly,
  };
}

/**
 * The editor from its detail read, the step's draft and the rights (plan
 * 8.3, 8.4, 3.7): the six setting rows as the drawer's row model (each value
 * with "Set for Sleeves" or "Store default", its change below it, [Change]),
 * each with its "Also clear theirs" boxes, the read-only Price row, and the
 * footer ("● Not saved · 2 changes" [Discard] [Save]). [Change] waits for the
 * draft (the detail read) and while a save is out or unconfirmed.
 *
 * The rows show the last answer for this category: a refresh that failed (a
 * save's re-read, Load latest, Reload; React Query keeps `data` beside
 * `error`) keeps them, the footer and a held draft's Check again, and says so
 * in `latestFailed`; only a 404 or a 422 replaces the view. While the store
 * holds older group rules (D11) no save is offered here either, as on the
 * card: no [Change], no box, Save off with the one line, unless this
 * category's save is out or unconfirmed (its Check again stays, CC-C25).
 */
export function categoryEditorState(input: CategoryEditorInput): CategoryEditorState {
  const { detail, categoryId } = input;
  const error = detail.error ?? null;
  // The category is gone, or the selection too large: nothing of the old answer can be shown (8.6, D18).
  const replaced = error !== null && (isCategoryNotFound(error) || isTooLarge(error));
  const view = !replaced && detail.data !== undefined && detail.data.categoryId === categoryId ? detail.data : null;
  const failed = error !== null && view === null;
  const name = view?.name ?? input.category?.name ?? "";
  const productCount = view?.productCount ?? input.category?.productCount ?? 0;
  const own = ownCategoryDraft(input.draft, categoryId);
  const locked = own !== null && isDraftLocked(own.draft);
  const holding = own !== null && (isDraftDirty(own.draft) || locked);
  const value = holding ? own.value : null;
  // The facts the rows and the boxes read: the draft's while it holds a change or a save (D6), else the read's.
  const facts: CategoryDraftFacts | null = value ?? (view === null ? null : categoryDraftFacts(view));
  const failure = own?.draft.phase === "refused" ? input.failure : null;
  const shelves = input.shelves ?? null;
  const editable = input.rights.categorySettings.editable;
  // D11, checked up front from the summary as the card does: the 409 stays the backstop for the race.
  const gated = olderRulesState(input.summary) === "present" && !locked;

  const rows = view === null || facts === null ? [] : DRAWER_SETTING_ROWS.map(({ key, label }): CategoryEditorRow => {
    const target = DRAWER_ROW_TARGETS[key];
    const fields = drawerEditFields(target).filter(isCategoryEditField);
    const rights = categoryFieldRights(input.rights, fields[0]);
    const shown = !gated && (rights.canSet || rights.canDefault || rights.canNone);
    let line: string | null = null;
    // The footer's line says why under D11; a banner says why when the right is off.
    if (!shown) line = gated || rights.reason === null ? null : rightReasonLine(rights.reason);
    else if (!rights.canSet && rights.reason !== null) {
      line = rights.reason === "sign_in" ? LISTING_SETTINGS_EDIT_WORDS.signInFieldLine : rightReasonLine(rights.reason) ?? LISTING_SETTINGS_EDIT_WORDS.defaultOnlyLine;
    }
    const choiceOf = <F extends CategoryEditField>(field: F): CategoryFieldChoice<F> => (value?.[field] ?? LEAVE) as CategoryFieldChoice<F>;
    const state = {
      canSet: rights.canSet,
      canDefault: rights.canDefault,
      canNone: rights.canNone,
      change: { shown, disabled: own === null || locked },
      picksDisabled: true,
      line,
      open: input.openTarget === target,
      marked: own !== null && fields.some((field) => own.draft.marked.includes(field)),
      fieldError: fields.some((field) => failure?.fields?.includes(field) === true) ? failure?.message ?? null : null,
    };
    let edit: DrawerRowEdit;
    if (target === "description") {
      const choices = { textAbove: choiceOf("textAbove"), textBelow: choiceOf("textBelow"), mainText: LEAVE as ProductSettingsChoices["mainText"] };
      edit = { ...state, kind: "description", target, fields: CATEGORY_DESCRIPTION_FIELDS, choices, pending: categoryDescriptionPending(choices), check: null };
    } else {
      const field = target as DrawerFieldTarget;
      const choice = choiceOf(field);
      edit = {
        ...state, kind: "field", target: field, field, choice,
        pending: categoryFieldPending(field, choice, input.setup, facts.own, shelves),
      } as DrawerRowEdit;
    }
    // A row that offers no [Change] clears nothing: no box under it (the tick, if held, stays in the draft).
    const clears = !shown ? [] : fields
      .filter((field) => clearAllowed(facts, field, choiceOf(field)))
      .map((field): CategoryClearBox => ({
        field,
        count: clearCandidates(facts, field).length,
        line: ownValuesLineWords(clearCandidates(facts, field).length, name, field),
        label: alsoClearLabelWords(productCount),
        ticked: value?.clear.includes(field) === true,
        disabled: own === null || locked || !editable,
      }));
    return {
      key,
      row: { key, label, groups: [{ entries: [settingEntry(key, view.settings, name, input.setup)], differ: null }], notes: [], edit },
      fields,
      clears,
    };
  });

  const namesRow = (failure?.fields ?? []).some((field) => FIELD_SET.has(field));
  const drawn = drawerFooter({
    draft: own?.draft ?? null,
    editable: editable && view !== null && !gated,
    busy: input.busy,
    clear: null,
    savedFlashVisible: input.savedFlashVisible,
    compact: input.compact,
    showRefusal: !namesRow,
    fieldEditorOpen: input.fieldEditorOpen,
    saveLabel: DRAWER_WORDS.save,
  });
  // Under D11 the footer says why Save is off, unless it has words of its own (a refusal, "Saved", a conflict's Load latest).
  const footer: DrawerFooter = gated && view !== null && drawn.primary.action === "save" && drawn.message === null
    ? { ...drawn, message: { text: LISTING_SETTINGS_CATEGORY_WORDS.olderRules, tone: "status" } }
    : drawn;

  return {
    title: categoryEditorTitleWords(name, productCount),
    name,
    read: failed ? "failed" : view === null ? "loading" : "answered",
    loadingLine: !failed && view === null ? loadingCategoryWords(name) : null,
    problem: failed ? editorReadProblem(error) : null,
    latestFailed: error !== null && view !== null ? latestReadFailure(error) : null,
    detail: view,
    rows,
    own: view === null ? null : facts?.own ?? null,
    price: view === null ? null : priceRow(view.settings, name),
    footer,
    escapeKeepsOpen: locked,
    held: locked,
  };
}
