import { CATEGORY_LISTING_SETTING_FIELDS, type CategoryListingSettingField } from "@shared/dropship/listing-setting-values";
import {
  CATEGORY_CLEAR_FIELDS,
  PRICE_CHANGE_CLEAR_FIELDS,
  reviewPriceChangesInputSchema,
  saveCategorySettingsInputSchema,
  type CategoryClearField,
  type CategorySettingsPatchInput,
  type PriceChangeClearField,
  type ReviewPriceChangesInput,
  type SaveCategorySettingsInput,
} from "@shared/dropship/listing-setting-writes";
import { pricingRecipeSchema, type PricingRecipe } from "@shared/dropship/pricing-rules";
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
  sameDraftValue,
  type DraftValue,
  type EditorId,
  type ListingSettingsDraft,
  type SavePhase,
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
import {
  productPriceEditorModel,
  productPriceEditorResult,
  type ProductPriceEditorModel,
  type ProductPriceEditorState,
} from "./dropship-listing-settings-price-check";
import { recipeWords } from "./dropship-listing-settings-price-words";
import {
  choicesFromOwn,
  descriptionEditorResult,
  descriptionFieldEditor,
  ebayCategoryFieldEditor,
  isPriceCheckRef,
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
  type PriceCheckRef,
  type ProductEditField,
  type ProductFieldChoice,
  type ProductFieldRights,
  type ProductOwnSettings,
  type ProductPriceChange,
  type ProductSettingsChoices,
  type StoreShelfFieldEditorModel,
} from "./dropship-listing-settings-product-edit";
import { PRICE_DEFAULT_WORDS } from "./dropship-listing-settings-recipe";
import { shelfPathWords, type PolicySetupFacts } from "./dropship-listing-settings-store-requests";
import {
  alsoClearLabelWords,
  categoryCheckAlsoWords,
  categoryEditorTitleWords,
  categoryExamplesWords,
  categoryRowWords,
  changeCategoryLabel,
  changeSettingLabel,
  drawerDescriptionTemplateValue,
  drawerEbayCategoryValue,
  drawerPolicyValue,
  drawerStoreShelfValue,
  LISTING_SETTINGS_CATEGORY_WORDS,
  LISTING_SETTINGS_EDIT_WORDS,
  LISTING_SETTINGS_PRICE_CHECK_WORDS,
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
 * plan 8.1-8.4; the category price, PR 10f, plan 9.1-9.4): the reads the card
 * and the editor make, the older-rules check (D11), the card's rows and state,
 * the choices a category's seven fields can take, its price (a recipe or "Use
 * store default", saved through the price check, W7 `category_price`), the
 * draft that holds them with "Also clear theirs", the W12 patch and request
 * they make, the W7 review request a price change makes, who may change which
 * field, the field editors' models, "Load latest", and the editor's state.
 *
 * Rules this module keeps:
 * - Never a price and never a main text in W12 (plan P34; `SW`
 *   saveCategorySettingsInputSchema has neither): a category price goes through
 *   the price check (W7, `categoryPriceReviewBody`, PR 10f, plan 9.7), which
 *   carries the editor's other changes and "Also clear theirs" with it in one
 *   check (D2); a category has no main text.
 * - The client never computes a price (D1): the recipe is parsed with PR 7's
 *   integer parsers (`productPriceEditorResult`); the examples shown are the
 *   server's current prices, labelled "Now:" and hidden while the price is
 *   changed (CC-C23).
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

// ---------------------------------------------------------------------------
// The price (PR 10f, plan 9.1, 9.2; D1, D2, D16)
// ---------------------------------------------------------------------------

/**
 * The category's price as the editor changes it (plan 9.2): the recipe
 * (`set`), "Use store default" (`default`, W7 `price: null`) or leave it, and
 * the check made for it (the W7 review the vendor saw, D16). One field of the
 * draft, so the bar counts the price as one change, and the check never
 * counts as a change. Saved only through the price check (W7, plan 9.7).
 */
export interface CategoryPriceChange {
  readonly choice: FieldChoice<PricingRecipe>;
  readonly check: PriceCheckRef | null;
}

const NO_PRICE_CHANGE: CategoryPriceChange = Object.freeze({ choice: LEAVE, check: null });

/** The price left as it is, with no check. */
export function emptyCategoryPriceChange(): CategoryPriceChange {
  return NO_PRICE_CHANGE;
}

function isRecipeChoice(value: unknown): value is FieldChoice<PricingRecipe> {
  if (typeof value !== "object" || value === null) return false;
  const choice = value as { mode?: unknown; value?: unknown };
  if (choice.mode === "leave" || choice.mode === "default") return true;
  return choice.mode === "set" && pricingRecipeSchema.safeParse(choice.value).success;
}

/** Whether `value` is a price change of the shape above (a leave, the default or a recipe the contract takes, and a check or none). */
export function isCategoryPriceChange(value: unknown): value is CategoryPriceChange {
  if (typeof value !== "object" || value === null) return false;
  const { choice, check } = value as Record<string, unknown>;
  return isRecipeChoice(choice) && (check === null || isPriceCheckRef(check));
}

/** The category's own recipe (the setting's value when its source is `category`); null when the store default, or nothing, gives it. */
export function categoryOwnPrice(settings: Pick<ListingSettingsCategorySettings, "price">): PricingRecipe | null {
  return settings.price.source === "category" ? settings.price.value : null;
}

/** The store price the category would follow with "Use store default" (the setting's value when its source is `store_default`); null when none is set. */
export function categoryStoreRecipe(settings: Pick<ListingSettingsCategorySettings, "price">): PricingRecipe | null {
  return settings.price.source === "store_default" ? settings.price.value : null;
}

/**
 * The price choice as the draft keeps it: one that asks for what the category
 * has now (the same recipe, or "Use store default" while it has none of its
 * own) is "leave", so it counts as no change; a recipe is copied through the
 * contract, so the draft never shares an object with an editor.
 */
function priceChoiceFor(choice: FieldChoice<PricingRecipe>, ownPrice: PricingRecipe | null): FieldChoice<PricingRecipe> {
  if (choice.mode === "leave") return LEAVE;
  if (choice.mode === "default") return ownPrice === null ? LEAVE : DEFAULT;
  if (ownPrice !== null && sameDraftValue(choice.value, ownPrice)) return LEAVE;
  return { mode: "set", value: pricingRecipeSchema.parse(choice.value) };
}

/** The price change as the draft keeps it: the choice normalised, and its check only while there is a change to check. */
function priceChangeFor(price: CategoryPriceChange, ownPrice: PricingRecipe | null): CategoryPriceChange {
  const choice = priceChoiceFor(price.choice, ownPrice);
  if (choice.mode === "leave") return NO_PRICE_CHANGE;
  return { choice, check: price.check === null ? null : { ...price.check } };
}

/** Whether the draft's price asks for anything: a recipe other than the category's, or "Use store default" over its own. */
export function categoryPriceChanged(value: Pick<CategoryDraftValue, "price">): boolean {
  return value.price.choice.mode !== "leave";
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
 * What the draft starts from: the category, its revision, its own values
 * (its price among them, PR 10f) and its products' own values, all from one
 * read (D6). A type, not an interface, so the draft value built on it is a
 * `DraftValue` the provider takes as it is.
 */
export type CategoryDraftFacts = {
  readonly categoryId: number;
  /** W12's `expectedRevisionId`, and the W7 category check's: the detail's `revisionId`. */
  readonly expectedRevisionId: number | null;
  readonly own: CategoryOwnValues;
  /** The category's own recipe (`categoryOwnPrice`); null when the store default, or nothing, gives its price. */
  readonly ownPrice: PricingRecipe | null;
  readonly ownValues: readonly CategoryOwnValueEntry[];
};

/**
 * The editor's draft value: one field per choice (so the bar counts each
 * changed setting as one change), the price as one field (`price`, PR 10f:
 * its choice and the check made for it), "Also clear theirs" as one field
 * (`clear`, the ticked settings in the stored shape's order: one change
 * however many are ticked; the price among them only with a price change,
 * which goes through the check), and the facts the draft started from, the
 * same in the draft's base and value. The base has every choice "leave", the
 * price left, and nothing ticked.
 */
export type CategoryDraftValue = CategoryChoices & CategoryDraftFacts & {
  readonly price: CategoryPriceChange;
  readonly clear: readonly PriceChangeClearField[];
};

export function categoryDraftFacts(detail: Pick<ListingSettingsCategoryDetail, "categoryId" | "revisionId" | "settings" | "ownValues">): CategoryDraftFacts {
  return Object.freeze({
    categoryId: detail.categoryId,
    expectedRevisionId: detail.revisionId,
    own: categoryOwnValues(detail.settings),
    ownPrice: categoryOwnPrice(detail.settings),
    ownValues: Object.freeze(detail.ownValues.map((entry) => Object.freeze({
      productId: entry.productId, revisionId: entry.revisionId, fields: Object.freeze([...entry.fields]),
    }))),
  });
}

/** The `ownValues` entries that hold their own value in `field` (plan 8.4): the products "Also clear theirs" would clear for it. */
export function clearCandidates(facts: Pick<CategoryDraftFacts, "ownValues">, field: PriceChangeClearField): CategoryOwnValueEntry[] {
  return facts.ownValues.filter((entry) => (entry.fields as readonly string[]).includes(field));
}

/**
 * Whether "Also clear theirs" can be ticked on `field` (plan 8.4, CC-C4,
 * CC-C15): products hold their own value in it, and the save sets it on the
 * category: the vendor sets it, or the category already sets it (the current
 * value is sent again). Never with "Use store default", and never on a field
 * the store default gives: every cleared field is non-null in the patch
 * (`SW:438-445`), so the store default is never pinned on the category. The
 * price (PR 10f) can be cleared only with a recipe set: a price clear rides
 * on the price check (W7), which needs a price change (plan 9.6; W12 never
 * carries it, P34).
 */
export function clearAllowed(facts: Pick<CategoryDraftFacts, "own" | "ownValues">, field: PriceChangeClearField, choice: AnyChoice): boolean {
  if (clearCandidates(facts, field).length === 0) return false;
  if (choice.mode === "set") return true;
  if (field === "price") return false;
  return choice.mode === "leave" && facts.own[field] !== null;
}

/** The draft value on `facts`; with no choices, the price left and nothing ticked, it is the draft's base. */
export function categoryDraftValueOn(
  facts: CategoryDraftFacts,
  choices: CategoryChoices = emptyCategoryChoices(),
  clear: readonly PriceChangeClearField[] = [],
  price: CategoryPriceChange = NO_PRICE_CHANGE,
): CategoryDraftValue {
  const value: Record<string, unknown> = {};
  for (const field of CATEGORY_EDIT_FIELDS) value[field] = draftChoice(field, choices[field], facts.own);
  const priceChange = priceChangeFor(price, facts.ownPrice);
  const wanted = new Set(clear);
  const choiceOf = (field: PriceChangeClearField): AnyChoice => (field === "price" ? priceChange.choice : value[field] as AnyChoice);
  const kept = PRICE_CHANGE_CLEAR_FIELDS.filter((field) => wanted.has(field) && clearAllowed(facts, field, choiceOf(field)));
  return {
    ...value,
    price: priceChange,
    clear: Object.freeze(kept),
    categoryId: facts.categoryId,
    expectedRevisionId: facts.expectedRevisionId,
    own: facts.own,
    ownPrice: facts.ownPrice,
    ownValues: facts.ownValues,
  } as unknown as CategoryDraftValue;
}

/** The draft value on the detail read; with no choices, the price left and nothing ticked, it is the draft's base. */
export function categoryDraftValue(
  detail: Pick<ListingSettingsCategoryDetail, "categoryId" | "revisionId" | "settings" | "ownValues">,
  choices: CategoryChoices = emptyCategoryChoices(),
  clear: readonly PriceChangeClearField[] = [],
  price: CategoryPriceChange = NO_PRICE_CHANGE,
): CategoryDraftValue {
  return categoryDraftValueOn(categoryDraftFacts(detail), choices, clear, price);
}

const MAX_ID = 2_147_483_647;
/** The settings a W12 clear can name (never the price). */
const CLEAR_FIELD_SET: ReadonlySet<string> = new Set(CATEGORY_CLEAR_FIELDS);
/** The settings a tick can name in the draft: W12's, and the price for the check (PR 10f). */
const DRAFT_CLEAR_FIELD_SET: ReadonlySet<string> = new Set(PRICE_CHANGE_CLEAR_FIELDS);
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

function isClearFields(value: unknown): value is readonly PriceChangeClearField[] {
  return isFieldList(value, DRAFT_CLEAR_FIELD_SET);
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
  const { categoryId, expectedRevisionId, own, ownPrice, ownValues, clear, price } = value;
  if (!isId(categoryId) || !isRevision(expectedRevisionId)) return null;
  if (typeof own !== "object" || own === null || !isOwnValueEntries(ownValues) || !isClearFields(clear)) return null;
  if (ownPrice !== null && !pricingRecipeSchema.safeParse(ownPrice).success) return null;
  if (!isCategoryPriceChange(price)) return null;
  if (!CATEGORY_EDIT_FIELDS.every((field) => isProductFieldChoice(field, value[field]))) return null;
  return value as unknown as CategoryDraftValue;
}

/** Whether the draft asks for anything: a changed field, a changed price (PR 10f), or "Also clear theirs" ticked (a clear-only save). */
export function categoryHasChange(value: Pick<CategoryDraftValue, CategoryEditField | "clear" | "price">): boolean {
  return categoryChangedFields(value).length > 0 || value.clear.length > 0 || categoryPriceChanged(value);
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
 * The price change a pick or a tick keeps (PR 10f, plan 9.4): the choice,
 * with no check. A check is of the whole request (the price with the other
 * changes and the clear set, D2), so any change after it needs a new one;
 * keeping the old check would show it over a draft it no longer answers, and
 * [Save new prices] would apply the stored review while the editor reports
 * the newer change as saved.
 */
function priceChangeWithoutCheck(value: Pick<CategoryDraftValue, "price">): CategoryPriceChange {
  return { choice: value.price.choice, check: null };
}

/**
 * [Done] in a field editor: its choices go in the editor's draft. A choice
 * that asks for what the category has is no change; "Use store default" on a
 * field drops its "Also clear theirs" tick (the clear needs a set value). A
 * held price check goes: the request changed (PR 10f).
 */
export function categoryPickAction(input: CategoryEditFacts & { picks: CategoryPicks }): CategoryEditAction {
  const picks = checkedPicks(input.picks);
  const from = categoryEditFrom(input);
  if ("kind" in from) return from;
  const choices: Record<string, AnyChoice> = {};
  for (const field of CATEGORY_EDIT_FIELDS) choices[field] = from.current[field];
  for (const [field, choice] of picks) choices[field] = choice;
  const value = categoryDraftValueOn(from.current, choices as unknown as CategoryChoices, from.current.clear, priceChangeWithoutCheck(from.current));
  return from.start === null ? { kind: "edit", value } : { kind: "start", ...from.start, value };
}

/**
 * "Also clear theirs" ticked or unticked on `field`: the draft takes it when
 * the box can show (`clearAllowed`); otherwise the tick is dropped. The price
 * (PR 10f) can be ticked only while a recipe is set: its clear rides on the
 * price check. A held price check goes: the request changed.
 */
export function categoryClearAction(input: CategoryEditFacts & { field: PriceChangeClearField; ticked: boolean }): CategoryEditAction {
  if (!DRAFT_CLEAR_FIELD_SET.has(input.field)) throw new Error(`A category clear names a setting it can't clear: ${input.field}.`);
  const from = categoryEditFrom(input);
  if ("kind" in from) return from;
  const clear = input.ticked ? [...from.current.clear, input.field] : from.current.clear.filter((field) => field !== input.field);
  const value = categoryDraftValueOn(from.current, from.current, clear, priceChangeWithoutCheck(from.current));
  return from.start === null ? { kind: "edit", value } : { kind: "start", ...from.start, value };
}

/**
 * [Check new prices] in the price editor (PR 10f, plan 9.2): the editor's
 * choice goes in the draft as the category's price change, with no check yet
 * (the check runner adds it); a choice that asks for what the category has is
 * no change, and a price tick stays only while a recipe is set. The other
 * fields' choices and ticks stay as they are: they ride along in the one
 * check (D2).
 */
export function categoryPriceAction(input: CategoryEditFacts & { choice: FieldChoice<PricingRecipe> }): CategoryEditAction {
  if (!isRecipeChoice(input.choice)) throw new Error("A category price edit names a choice the editor doesn't set.");
  const from = categoryEditFrom(input);
  if ("kind" in from) return from;
  const value = categoryDraftValueOn(from.current, from.current, from.current.clear, { choice: input.choice, check: null });
  return from.start === null ? { kind: "edit", value } : { kind: "start", ...from.start, value };
}

/** The check the runner made, put in the draft (the choices stay; `null` drops a check, e.g. "Back to editing"). */
export function categoryPriceDraftWithCheck(value: CategoryDraftValue, check: PriceCheckRef | null): CategoryDraftValue {
  return { ...value, price: { choice: value.price.choice, check: check === null ? null : { ...check } } };
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
  // A price tick (PR 10f) is the check's: W12 never carries the price (P34).
  for (const field of CATEGORY_CLEAR_FIELDS) {
    if (!value.clear.includes(field)) continue;
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
  return { fields, products: clearProductsFor(value.ownValues, fields) };
}

/** The union of the `ownValues` entries holding any of `fields`, each once, ascending, with the revision it was read with (plan 8.4). */
function clearProductsFor(ownValues: readonly CategoryOwnValueEntry[], fields: readonly PriceChangeClearField[]): Array<{ productId: number; expectedRevisionId: number | null }> {
  const ticked = new Set<string>(fields);
  return ownValues
    .filter((entry) => entry.fields.some((field) => ticked.has(field)))
    .map((entry) => ({ productId: entry.productId, expectedRevisionId: entry.revisionId }))
    .sort((left, right) => left.productId - right.productId);
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
  // A price clear is the price check's (PR 10f, P34): never W12's.
  const uncleared = (input.clear?.fields ?? []).filter((field) => !CLEAR_FIELD_SET.has(field));
  if (uncleared.length > 0) throw new CategoryRequestError("This change clears a setting the category editor doesn't save.", { fields: uncleared });
  const unset = (input.clear?.fields ?? []).filter((field) => input.patch[field as CategoryClearField] == null);
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
// The W7 request: the category price check (PR 10f, plan 9.2, 9.4; D1, D2, D5, D6)
// ---------------------------------------------------------------------------

/** The `category_price` review as the contract takes it (`SW` reviewPriceChangesInputSchema). */
export type CategoryPriceReviewInput = Extract<ReviewPriceChangesInput, { kind: "category_price" }>;

/**
 * The check's patch (plan 9.2): the price as the vendor chose it (a recipe,
 * or null for "Use store default"; the contract requires one), and the
 * editor's other changes as the W12 patch carries them (ids and text only,
 * clear-only resends included). Throws when the price isn't changed: there is
 * nothing to check, and a W12 save is the way (plan 9.7).
 */
export function categoryPricePatch(value: Pick<CategoryDraftValue, CategoryEditField | "own" | "clear" | "price">): CategoryPriceReviewInput["patch"] {
  const choice = value.price.choice;
  if (choice.mode === "leave") throw new CategoryRequestError("There is no price change to check.", { fields: ["price"] });
  return { price: choice.mode === "default" ? null : pricingRecipeSchema.parse(choice.value), ...categoryPatch(value) };
}

/**
 * "Also clear theirs" as the check takes it (plan 9.2, 9.6): the ticked
 * settings in the stored shape's order, the price among them, and the union
 * of the `ownValues` entries holding any of them, each once, ascending, with
 * the revision it was read with. Undefined when nothing is ticked.
 */
export function categoryPriceClearBody(value: Pick<CategoryDraftValue, "clear" | "ownValues">): CategoryPriceReviewInput["clear"] | undefined {
  const fields = PRICE_CHANGE_CLEAR_FIELDS.filter((field) => value.clear.includes(field));
  if (fields.length === 0) return undefined;
  return { fields: [...fields], products: clearProductsFor(value.ownValues, fields) };
}

/** "Also clear theirs" as given to the check: the ticked fields (the price among them) and the products, read-only (never mutated). */
export type CategoryPriceClearInput = {
  readonly fields: readonly PriceChangeClearField[];
  readonly products: ReadonlyArray<{ readonly productId: number; readonly expectedRevisionId: number | null }>;
};

/**
 * The W7 `category_price` review body (plan 9.2, 9.4), checked by the shared
 * input schema before it is sent: the category, the revision the editor
 * opened on (D6), the patch with its price, and "Also clear theirs" when
 * ticked. Throws a CategoryRequestError for a patch without a price, a
 * cleared field the patch doesn't set, or anything else the schema refuses
 * (never sent). What is sent is the schema's output. Never a main text.
 */
export function categoryPriceReviewBody(input: {
  categoryId: number;
  expectedRevisionId: number | null;
  patch: CategoryPriceReviewInput["patch"];
  clear?: CategoryPriceClearInput | undefined;
}): CategoryPriceReviewInput {
  if (input.patch.price === undefined) throw new CategoryRequestError("A price check needs a price.", { fields: ["price"] });
  const outside = Object.keys(input.patch).filter((field) => input.patch[field as keyof CategoryPriceReviewInput["patch"]] !== undefined && field !== "price" && !FIELD_SET.has(field));
  if (outside.length > 0) throw new CategoryRequestError("This check names a setting the category editor doesn't save.", { fields: outside });
  const unset = (input.clear?.fields ?? []).filter((field) => input.patch[field] == null);
  if (unset.length > 0) throw new CategoryRequestError("A cleared setting must be set on the category by this change.", { fields: unset });
  const parsed = reviewPriceChangesInputSchema.safeParse({
    kind: "category_price",
    categoryId: input.categoryId,
    expectedRevisionId: input.expectedRevisionId,
    patch: input.patch,
    ...(input.clear === undefined ? {} : { clear: { fields: [...input.clear.fields], products: input.clear.products.map((product) => ({ ...product })) } }),
  });
  if (!parsed.success || parsed.data.kind !== "category_price") {
    throw new CategoryRequestError("This check can't be sent as it is.", {
      issues: parsed.success ? [{ path: "kind", code: "other_kind" }] : parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join("."), code: issue.code })),
    });
  }
  return parsed.data;
}

/** The check's request from the draft (plan 9.2): the body `categoryPriceReviewBody` checks, on the draft's revision and clear set (D6). */
export function categoryPriceReviewRequest(value: CategoryDraftValue): CategoryPriceReviewInput {
  return categoryPriceReviewBody({
    categoryId: value.categoryId,
    expectedRevisionId: value.expectedRevisionId,
    patch: categoryPricePatch(value),
    clear: categoryPriceClearBody(value),
  });
}

/**
 * Whether a check's answer is for the draft as it is now (plan 9.4): the
 * request the draft builds now is the one that was sent. A draft changed
 * while the check was out (a pick, a tick, a price the editor can't build a
 * request for any more) needs a new check, so the answer is dropped.
 */
export function categoryPriceCheckAnswers(value: CategoryDraftValue, request: ReviewPriceChangesInput): boolean {
  try {
    return sameDraftValue(categoryPriceReviewRequest(value), request);
  } catch {
    // Deliberate: a draft with no price change to check builds no request, so no check answers it.
    return false;
  }
}

/**
 * What the check was made against (plan 9.4, D6): the category's revision
 * and the clear set it sends. Before each check, and again before the
 * automatic re-check after a refused apply, the detail is read again and
 * compared (`categoryPriceBaseMoved`): a moved revision or set is the
 * editor's conflict (Load latest), and nothing is sent.
 */
export interface CategoryPriceCheckBase {
  readonly expectedRevisionId: number | null;
  readonly clear: CategoryPriceClearInput | undefined;
}

export function categoryPriceCheckBaseOf(value: Pick<CategoryDraftValue, "expectedRevisionId" | "clear" | "ownValues">): CategoryPriceCheckBase {
  return { expectedRevisionId: value.expectedRevisionId, clear: categoryPriceClearBody(value) };
}

/** Whether the category's revision, or the clear set the check sends, moved away from the base on the detail read now (plan 9.4). */
export function categoryPriceBaseMoved(base: CategoryPriceCheckBase, latest: Pick<ListingSettingsCategoryDetail, "revisionId" | "ownValues">): boolean {
  if (base.expectedRevisionId !== latest.revisionId) return true;
  if (base.clear === undefined) return false;
  const now = clearProductsFor(latest.ownValues, base.clear.fields);
  const sent = [...base.clear.products].sort((left, right) => left.productId - right.productId);
  return JSON.stringify(now.map((product) => [product.productId, product.expectedRevisionId]))
    !== JSON.stringify(sent.map((product) => [product.productId, product.expectedRevisionId]));
}

/** What else the check saves (plan 9.2, UX-m9): the other changed settings in the stored shape's order, and each ticked clear with its count. */
export interface CategoryPriceCheckAlso {
  fields: CategoryListingSettingField[];
  clears: Array<{ field: CategoryListingSettingField; count: number }>;
}

export function categoryPriceCheckAlso(value: Pick<CategoryDraftValue, CategoryEditField | "clear" | "ownValues">): CategoryPriceCheckAlso {
  const changed = new Set<string>(categoryChangedFields(value));
  return {
    fields: CATEGORY_LISTING_SETTING_FIELDS.filter((field) => changed.has(field)),
    clears: PRICE_CHANGE_CLEAR_FIELDS.filter((field) => value.clear.includes(field)).map((field) => ({ field, count: clearCandidates(value, field).length })),
  };
}

/** "Also saves: shipping policy." and "Clears 3 products' own shipping policy.": the lines over the check (`categoryCheckAlsoWords`). */
export function categoryPriceCheckAlsoLines(value: Pick<CategoryDraftValue, CategoryEditField | "clear" | "ownValues">): string[] {
  return categoryCheckAlsoWords(categoryPriceCheckAlso(value));
}

/** The price change as the check's footer and head read it (10d's `priceCheckFooter`, `priceCheckChangeWords`): a category check releases nothing. */
export function categoryPriceCheckChange(value: Pick<CategoryDraftValue, "price">): Pick<ProductPriceChange, "price" | "releaseExactPrices"> {
  return { price: value.price.choice, releaseExactPrices: false };
}

/** The check body the editor shows in place of its own (D20), and the draft phase it is in. */
export interface CategoryPriceCheckShown {
  check: PriceCheckRef;
  phase: SavePhase;
  message: string | null;
  code: string | null;
  /** The draft is locked (a save out or unconfirmed): Back closes the editor and keeps it (D21). */
  locked: boolean;
  /** "Also saves: …" and "Clears …" (plan 9.2). */
  also: string[];
  change: Pick<ProductPriceChange, "price" | "releaseExactPrices">;
}

/**
 * Whether the editor shows the check: its draft holds a price change with a
 * check (made, or kept from before Back, D21). Null shows the editor's own
 * body: before any check, after a save (the views are read again; a clean
 * draft holding a check is a saved one, whatever its phase once "Saved" has
 * gone), and while the draft shows a conflict (plan 9.4: the editor's Load
 * latest re-reads the category; the check it holds goes with the rebase).
 */
export function categoryPriceCheckShown(draft: ListingSettingsDraft | null, categoryId: number): CategoryPriceCheckShown | null {
  const own = ownCategoryDraft(draft, categoryId);
  if (own === null || own.value.price.check === null || !categoryPriceChanged(own.value)) return null;
  const { phase } = own.draft;
  if (phase === "saved" || phase === "saved_view_stale" || phase === "conflict") return null;
  // A check is held only with a change to save; without one the check was applied (the base took the value).
  if (!isDraftDirty(own.draft)) return null;
  return {
    check: own.value.price.check,
    phase,
    message: own.draft.message,
    code: own.draft.code,
    locked: isDraftLocked(own.draft),
    also: categoryPriceCheckAlsoLines(own.value),
    change: categoryPriceCheckChange(own.value),
  };
}

/**
 * The check the editor's body shows in place of its own (D20): the draft's
 * (`categoryPriceCheckShown`), or, while a refused apply's new check is being
 * made (`rechecking`), the one shown last as "Saving…" (locked, no words), so
 * the body doesn't flash back to the rows between the refusal and the new
 * check. Null for the editor's own body: nothing held, or the draft is in
 * conflict (the re-check's guard found the category moved: Load latest is the
 * editor's, plan 9.4).
 */
export function categoryPriceCheckBody(input: {
  shown: CategoryPriceCheckShown | null;
  lastShown: CategoryPriceCheckShown | null;
  rechecking: boolean;
  draft: ListingSettingsDraft | null;
  categoryId: number;
}): CategoryPriceCheckShown | null {
  if (input.shown !== null) return input.shown;
  if (!input.rechecking || input.lastShown === null) return null;
  if (ownCategoryDraft(input.draft, input.categoryId)?.draft.phase === "conflict") return null;
  return { ...input.lastShown, phase: "saving", message: null, code: null, locked: true };
}

/**
 * Whether this category's draft went through the price check (W7): it holds a
 * check (a saved draft keeps its value, so after a confirmed apply too). The
 * editor's [Reload] after "Saved. We couldn't load the latest view." then
 * reads the apply's views again (`refreshAfterCategoryPriceApply`), not W12's.
 */
export function categorySavedThroughCheck(draft: ListingSettingsDraft | null, categoryId: number): boolean {
  const own = ownCategoryDraft(draft, categoryId);
  return own !== null && own.value.price.check !== null;
}

/** What "Back to editing" does over a category check (D20, D21). */
export type CategoryPriceCheckBack =
  /** Back to the editor's body: the check leaves the draft (send `value` to `drafts.edit`), the changes stay. */
  | { kind: "edit"; value: CategoryDraftValue }
  /** The draft is locked (a save out or unconfirmed): the editor closes and keeps it; reopening shows Check again. */
  | { kind: "close" }
  | { kind: "none" };

export function categoryPriceCheckBack(draft: ListingSettingsDraft | null, categoryId: number): CategoryPriceCheckBack {
  const own = ownCategoryDraft(draft, categoryId);
  if (own === null || own.value.price.check === null) return { kind: "none" };
  if (isDraftLocked(own.draft)) return { kind: "close" };
  return { kind: "edit", value: categoryPriceDraftWithCheck(own.value, null) };
}

// ---------------------------------------------------------------------------
// Who may change which field (D3, D4)
// ---------------------------------------------------------------------------

/**
 * The rights the editor reads: W12's, the rights its fields pick eBay values
 * with, and W7's for the price (PR 10f; left out, the Price row stays
 * read-only, as before 10f).
 */
export type CategorySettingsRights = Pick<ListingSettingsEditRights, "categorySettings" | "shipping" | "policies" | "ebayCategory" | "shelfPick">
  & { priceCheck?: ListingSettingsRight };

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

/**
 * The price's rights (PR 10f, D3): W7's right alone, as the drawer's price
 * editor (`productPriceRights`): a recipe and "Use store default" both need
 * it, and nothing else (a price names no eBay value). Without W7's right at
 * hand (`rights.priceCheck` left out) nothing can be chosen, with no reason
 * of its own: the row then reads as before 10f.
 */
export function categoryPriceRights(rights: Pick<CategorySettingsRights, "priceCheck">): ProductFieldRights {
  const right = rights.priceCheck;
  if (right === undefined) return { canSet: false, canDefault: false, canNone: false, reason: null };
  return right.editable
    ? { canSet: true, canDefault: true, canNone: false, reason: null }
    : { canSet: false, canDefault: false, canNone: false, reason: right.reason };
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
  /** The vendor's choices on what is saved now, the clear set rebuilt from the new `ownValues`, the price's check dropped: send it to the draft first. */
  edited: CategoryDraftValue;
  /** What is saved now, the draft's new base: rebase on it with `marked`. */
  latest: CategoryDraftValue;
  /** The fields the vendor changed whose category value another window moved too (R:542, C20); `price` among them (PR 10f). */
  marked: Array<CategoryEditField | "price">;
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
  // The check was of the old revision and set: it goes; the price choice stays (PR 10f).
  const edited = categoryDraftValue(latest, mine, mine.clear, { choice: mine.price.choice, check: null });
  const changed = categoryChangedFields(edited);
  const priceMoved = !sameDraftValue(mine.ownPrice, edited.ownPrice);
  const marked: Array<CategoryEditField | "price"> = changed.filter((field) => ownValueMoved(field, mine.own, edited.own));
  if (priceMoved && categoryPriceChanged(mine) && categoryPriceChanged(edited)) marked.push("price");
  return {
    edited,
    latest: categoryDraftValue(latest),
    marked,
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

/** The price editor's model (PR 10f): 10d's editor without "Clear exact prices too" (a category check releases nothing). */
export type CategoryPriceEditorModel = ProductPriceEditorModel;
export type CategoryPriceEditorState = ProductPriceEditorState;

/**
 * The Price row's editor (plan 9.2; 10d's `productPriceEditorModel`): where it
 * opens (the draft's choice first, else the category's own recipe, else "Use
 * store default" over the store price, or the suggestion while the store has
 * none), and what can be chosen (W7's right, `categoryPriceRights`). The
 * component words the default "Use store default" (D17).
 */
export function categoryPriceEditorModel(input: {
  rights: Pick<ProductFieldRights, "canSet" | "canDefault" | "reason">;
  draftChoice: FieldChoice<PricingRecipe>;
  /** The category's own recipe, and the store's (`categoryOwnPrice`, `categoryStoreRecipe`). */
  ownPrice: PricingRecipe | null;
  storeRecipe: PricingRecipe | null;
}): CategoryPriceEditorModel {
  return productPriceEditorModel({
    rights: input.rights,
    change: { price: input.draftChoice, releaseExactPrices: false },
    ownPrice: input.ownPrice,
    storeRecipe: input.storeRecipe,
  });
}

export type CategoryPriceEditorResult =
  /** The choice to put in the draft (`categoryPriceAction`), then check. */
  | { ok: true; choice: FieldChoice<PricingRecipe> }
  /** A field the parsers refuse (W1's words), or a choice the rights don't allow (`errors` empty: the button is just off). */
  | { ok: false; errors: Partial<Record<"percent" | "flat", string>> };

/** [Check new prices] in the price editor: the recipe parsed with the integer parsers (D1), or "Use store default". Nothing is computed from it here. */
export function categoryPriceEditorResult(model: Pick<CategoryPriceEditorModel, "canSet" | "canDefault">, state: CategoryPriceEditorState): CategoryPriceEditorResult {
  const result = productPriceEditorResult(model, { ...state, releaseExactPrices: false });
  return result.ok ? { ok: true, choice: result.change.price } : result;
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
  /** The row whose editor is open; one at a time (the Price row's is `"price"`, PR 10f). */
  openTarget: CategoryEditorTarget | null;
  /** The last refused save, with the fields it named (`WriteFailure.fields`); shown by its rows only while the draft is refused. */
  failure: Pick<WriteFailure, "message" | "fields"> | null;
  /** Another listing action is running, or a read for the footer is in flight. */
  busy: boolean;
  /**
   * A price check is out (PR 10f, plan 9.4): every [Change] and every "Also clear theirs" box waits for its answer,
   * so the check lands on the draft it was made for (a pick or a tick meanwhile would need a new one). Absent: false.
   */
  checking?: boolean;
  /** "Saved" shows now (3 seconds after a confirmed save, R:538). */
  savedFlashVisible: boolean;
  compact: boolean;
  /** A row's editor is open: its pick isn't in the draft until [Done]. */
  fieldEditorOpen: boolean;
}

/** "Also clear theirs" under one field (plan 8.4). */
export interface CategoryClearBox {
  /** A category setting; the price's box (PR 10f) shows under the Price row and rides on the price check. */
  field: PriceChangeClearField;
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

/** The Price row (plan 9.2, 9.3; UX-m9 lifted in PR 10f): the category's price now, its change, its examples and its [Change]. */
export interface CategoryPriceRow {
  label: string;
  /** "Retail price + 20%, round up to .99", or the no-store-price words. */
  value: string;
  /** "Set for Sleeves" or "Store default"; null when nothing gives a price (the value says so itself). */
  tag: string | null;
  /**
   * Why there is no [Change]: the right's line, or, with no W7 right handed
   * in (`rights.priceCheck` left out), the words from before 10f; null when
   * [Change] shows or a banner says why.
   */
  line: string | null;
  /** "Now: Pack of 100 $4.99 · Box of 5 $21.99": current prices (CC-C23), hidden while the price is changed; null with none. */
  examples: string | null;
  /** "→ Retail price + 20%, round up to .99 · Not saved" or "→ Use store default · Not saved"; null with no change. */
  pending: string | null;
  /**
   * [Change price], named with its category ("Change price for Sleeves", plan 3.4; the name starts with the label, WCAG
   * 2.5.3): hidden under D11 and without the right, off while the draft waits, a save is out or unconfirmed, or a check is out.
   */
  change: { label: string; ariaLabel: string; shown: boolean; disabled: boolean };
  /** The editor's model when it opens (`categoryPriceEditorModel`). */
  editor: CategoryPriceEditorModel;
  /** The price editor is open (`openTarget === "price"`). */
  open: boolean;
  /** Another window changed the price too (R:542, after Load latest). */
  marked: boolean;
  /** The last refused save named the price. */
  fieldError: string | null;
  /**
   * "Also clear theirs" for the price (plan 9.1, 9.6): shown only with a recipe set and products holding their own
   * price (`clearAllowed`), since the clear rides on the price check (W7 carries the price among its clear fields,
   * P25); never while [Change] is hidden.
   */
  clears: CategoryClearBox[];
}

/** The price editor's target in `openTarget` (PR 10f), beside the drawer's rows'. */
export const CATEGORY_PRICE_TARGET = "price" as const;
export type CategoryEditorTarget = DrawerEditTarget | typeof CATEGORY_PRICE_TARGET;

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
  /** The price check the editor shows in place of its body (D20, PR 10f); null for the body. */
  priceCheck: CategoryPriceCheckShown | null;
  /** The draft holds a price change: the footer's Save runs the check (plan 9.2); the other changes ride along (D2). */
  priceHoldsChange: boolean;
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

/** "→ Retail price + 20%, round up to .99 · Not saved" / "→ Use store default · Not saved" (D17); null with no change. */
export function categoryPricePending(choice: FieldChoice<PricingRecipe>): string | null {
  if (choice.mode === "leave") return null;
  return pendingSettingWords(choice.mode === "default" ? LISTING_SETTINGS_CATEGORY_WORDS.useStoreDefault : recipeWords(choice.value));
}

/**
 * The Price row (plan 9.2, 9.3): the category's own price, else the store
 * default; its examples as current prices, hidden while the price is changed
 * (CC-C23); its pending change; [Change price] under the same rules as the
 * rows' [Change] (D11, W7's right, the draft waiting or locked); and the
 * editor's model.
 */
function priceRow(input: {
  view: Pick<ListingSettingsCategoryDetail, "settings" | "examples">;
  name: string;
  value: CategoryDraftValue | null;
  ownPrice: PricingRecipe | null;
  rights: ProductFieldRights;
  gated: boolean;
  waiting: boolean;
  open: boolean;
  marked: boolean;
  fieldError: string | null;
  /** W7's right was handed in at all (`rights.priceCheck`); without it the row reads as before 10f. */
  rightKnown: boolean;
  /** The price's "Also clear theirs" box, when it can show; built by the editor's state with the rows' rule. */
  clears: CategoryClearBox[];
}): CategoryPriceRow {
  const price = input.view.settings.price;
  const choice = input.value?.price.choice ?? LEAVE;
  const shown = !input.gated && (input.rights.canSet || input.rights.canDefault);
  let line: string | null = null;
  if (!shown) {
    if (!input.rightKnown) line = LISTING_SETTINGS_CATEGORY_WORDS.priceReadOnly;
    else if (!input.gated && input.rights.reason !== null) line = rightReasonLine(input.rights.reason);
  }
  return {
    label: DRAWER_WORDS.priceHead,
    value: price.value === null ? DRAWER_WORDS.noStorePrice : recipeWords(price.value),
    tag: sourceTag(price.source, input.name),
    line,
    examples: choice.mode === "leave" ? categoryExamplesWords(input.view.examples) : null,
    pending: categoryPricePending(choice),
    // The drawer's PRICE head words (10d), named as the rows' [Change] is: "Change price for Sleeves".
    change: { label: LISTING_SETTINGS_PRICE_CHECK_WORDS.changePrice, ariaLabel: changeSettingLabel(DRAWER_WORDS.priceHead, input.name), shown, disabled: input.waiting },
    editor: categoryPriceEditorModel({ rights: input.rights, draftChoice: choice, ownPrice: input.ownPrice, storeRecipe: categoryStoreRecipe(input.view.settings) }),
    open: input.open,
    marked: input.marked,
    fieldError: input.fieldError,
    clears: shown ? input.clears : [],
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
  // A check out (PR 10f): the rows, the boxes and the Price row wait, as they do for a save (the check answers this draft).
  const waiting = own === null || locked || input.checking === true;
  // The facts the rows and the boxes read: the draft's while it holds a change or a save (D6), else the read's.
  const facts: CategoryDraftFacts | null = value ?? (view === null ? null : categoryDraftFacts(view));
  const failure = own?.draft.phase === "refused" ? input.failure : null;
  const shelves = input.shelves ?? null;
  // The draft holds a price change (PR 10f): Save is the price check, which needs W7's right and carries the rest (D2).
  const priceHoldsChange = value !== null && categoryPriceChanged(value);
  const priceRights = categoryPriceRights(input.rights);
  const editable = priceHoldsChange ? priceRights.canSet : input.rights.categorySettings.editable;
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
      change: { shown, disabled: waiting },
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
        disabled: waiting || !editable,
      }));
    return {
      key,
      row: { key, label, groups: [{ entries: [settingEntry(key, view.settings, name, input.setup)], differ: null }], notes: [], edit },
      fields,
      clears,
    };
  });

  const namesRow = (failure?.fields ?? []).some((field) => FIELD_SET.has(field) || field === CATEGORY_PRICE_TARGET);
  const drawn = drawerFooter({
    draft: own?.draft ?? null,
    editable: editable && view !== null && !gated,
    busy: input.busy,
    clear: null,
    savedFlashVisible: input.savedFlashVisible,
    compact: input.compact,
    showRefusal: !namesRow,
    fieldEditorOpen: input.fieldEditorOpen,
    // A price change is saved through the check (plan 9.2): Save becomes [Check new prices], on a phone too (10d's rule).
    saveLabel: priceHoldsChange ? PRICE_DEFAULT_WORDS.checkNewPrices : DRAWER_WORDS.save,
    ...(priceHoldsChange ? { compactSaveLabel: PRICE_DEFAULT_WORDS.checkNewPrices } : {}),
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
    price: view === null || facts === null ? null : priceRow({
      view,
      name,
      value,
      ownPrice: facts.ownPrice,
      rights: priceRights,
      gated,
      waiting,
      open: input.openTarget === CATEGORY_PRICE_TARGET,
      marked: own !== null && own.draft.marked.includes(CATEGORY_PRICE_TARGET),
      fieldError: failure?.fields?.includes(CATEGORY_PRICE_TARGET) === true ? failure.message : null,
      rightKnown: input.rights.priceCheck !== undefined,
      // The price's box under the same rule as the rows' (8.4), which for the price needs a recipe set (`clearAllowed`, 9.6).
      clears: !clearAllowed(facts, CATEGORY_PRICE_TARGET, value?.price.choice ?? LEAVE) ? [] : [{
        field: CATEGORY_PRICE_TARGET,
        count: clearCandidates(facts, CATEGORY_PRICE_TARGET).length,
        line: ownValuesLineWords(clearCandidates(facts, CATEGORY_PRICE_TARGET).length, name, CATEGORY_PRICE_TARGET),
        label: alsoClearLabelWords(productCount),
        ticked: value?.clear.includes(CATEGORY_PRICE_TARGET) === true,
        disabled: waiting || !editable,
      }],
    }),
    priceCheck: categoryPriceCheckShown(input.draft, categoryId),
    priceHoldsChange,
    footer,
    escapeKeepsOpen: locked,
    held: locked,
  };
}
