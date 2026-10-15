import { descriptionTextSchema, MAX_DESCRIPTION_TEXT_LENGTH, MAX_TEMPLATE_TEXT_LENGTH } from "@shared/dropship/listing-content";
import { listingSettingTemplateTextSchema } from "@shared/dropship/listing-setting-values";
import {
  listingSettingStoreShelfInputSchema,
  productSettingsPatchInputSchema,
  saveProductSettingsInputSchema,
  type ProductSettingsPatchInput,
} from "@shared/dropship/listing-setting-writes";
import type {
  ListingSettingsPolicyKind,
  ListingSettingsProductDetail,
  ListingSettingsProductOwnSettings,
  ListingSettingsSettingKey,
} from "@shared/dropship/listing-settings";
import { priceChangeReviewIdSchema } from "@shared/dropship/listing-setting-writes";
import { pricingRecipeSchema, type PricingRecipe } from "@shared/dropship/pricing-rules";
import type {
  ListingSettingsEditRights,
  ListingSettingsReadState,
  ListingSettingsRightReason,
} from "./dropship-listing-settings-access";
import {
  isDraftDirty,
  isDraftLocked,
  sameDraftValue,
  type DraftValue,
  type EditorId,
  type ListingSettingsDraft,
} from "./dropship-listing-settings-drafts";
import type { SizePriceDraft } from "./dropship-listing-settings-drawer";
import {
  noPolicyOnEbayWords,
  policyEditorChoices,
  setupReadEbay,
  shelfDraftProblem,
  shelfPickerOptions,
  type PolicyEditorChoice,
  type PolicySetupFacts,
} from "./dropship-listing-settings-store-requests";
import { drawerEbayCategoryValue, LISTING_SETTINGS_EDIT_WORDS, textTooLongWords } from "./dropship-listing-settings-words";
import type { DropshipEbayStoreCategoryOption } from "./dropship-ops-surface";

/**
 * Editing one product's own settings in its drawer (Listing settings PR 10,
 * plan 4.4 and 5.2-5.4): the choices a field can take, the draft that holds
 * them, the W5 patch and request they make, who may change which field, the
 * field editors' models, the text rules and the "Sizes differ" quick picks.
 *
 * Rules this module keeps:
 * - Ids and text only (plan D1, P13): a choice names a policy, an eBay
 *   category or a shelf by its id, and text as typed; the server builds every
 *   stored name and stamps the main text's catalog hash. Never a price in W5:
 *   a product's price is its own kind of change that goes through the price
 *   check (W7, 10d; `ProductPriceChange` below), a size's exact price through W9.
 * - One kind of change per Save (D2): the drawer's draft holds one size's
 *   exact price, the product's settings, or the product's price, never two.
 * - The draft's start (the product's own values) and its revision come from
 *   one own-read answer, so the revision W5 sends is the one the vendor saw.
 * - Text is checked as typed (5.4): the shared schemas bound the raw text
 *   before they trim it, so counters and checks use the raw `length`.
 *
 * Pure: no React, no network, no clock. Never mutates its inputs.
 */

/** Leave as it is (absent from the patch), use the default (null: the category's, else the store default), or set it. */
export type FieldChoice<T> = { mode: "leave" } | { mode: "default" } | { mode: "set"; value: T };

// ---------------------------------------------------------------------------
// The fields
// ---------------------------------------------------------------------------

/**
 * The fields the drawer edits, in the drawer's order (plan 4.4, 5.2): the
 * three policies (10a), then the eBay category, the store shelf and the
 * description's three parts (10b). Never the price (10d).
 */
export const PRODUCT_EDIT_FIELDS = [
  "shippingPolicy", "returnPolicy", "paymentPolicy", "ebayCategory", "storeShelf", "textAbove", "textBelow", "mainText",
] as const;
export type ProductEditField = (typeof PRODUCT_EDIT_FIELDS)[number];

export const POLICY_EDIT_FIELDS = ["shippingPolicy", "returnPolicy", "paymentPolicy"] as const satisfies readonly ProductEditField[];
export type PolicyEditField = (typeof POLICY_EDIT_FIELDS)[number];

/** The Description row's three parts: one editor, three settings (each its own W5 field, plan D8 of PR 9). */
export const DESCRIPTION_EDIT_FIELDS = ["textAbove", "textBelow", "mainText"] as const satisfies readonly ProductEditField[];
export type DescriptionEditField = (typeof DESCRIPTION_EDIT_FIELDS)[number];
export type TemplateTextField = "textAbove" | "textBelow";

const FIELD_SET: ReadonlySet<string> = new Set(PRODUCT_EDIT_FIELDS);
const POLICY_FIELD_SET: ReadonlySet<string> = new Set(POLICY_EDIT_FIELDS);

export function isProductEditField(field: string): field is ProductEditField {
  return FIELD_SET.has(field);
}

export function isPolicyEditField(field: string): field is PolicyEditField {
  return POLICY_FIELD_SET.has(field);
}

/** A policy by its eBay id, as W5 takes it. */
export interface PolicyChoiceValue {
  readonly id: string;
}

/**
 * An eBay category by its number, as W5 takes it. `categoryName` is for the
 * row's pending line only (the picker gives it); the patch never sends it,
 * and two choices with the same number are the same choice.
 */
export interface EbayCategoryChoiceValue {
  readonly categoryId: string;
  readonly categoryName?: string;
}

/** `none`: explicitly no shelf. `own`: one or two shelves by id, first then second. */
export type StoreShelfChoiceValue =
  | { readonly mode: "none" }
  | { readonly mode: "own"; readonly shelfIds: readonly string[] };

/** Text above or below the main text: `none`, or the vendor's own text as typed. */
export type TemplateTextChoiceValue =
  | { readonly mode: "none" }
  | { readonly mode: "own"; readonly text: string };

/** The product's own main text as typed; "Use default" is the Card Shellz text. */
export interface MainTextChoiceValue {
  readonly text: string;
}

/** What a field's `set` choice carries. */
export interface ProductEditValues {
  shippingPolicy: PolicyChoiceValue;
  returnPolicy: PolicyChoiceValue;
  paymentPolicy: PolicyChoiceValue;
  ebayCategory: EbayCategoryChoiceValue;
  storeShelf: StoreShelfChoiceValue;
  textAbove: TemplateTextChoiceValue;
  textBelow: TemplateTextChoiceValue;
  mainText: MainTextChoiceValue;
}

export type ProductFieldChoice<F extends ProductEditField> = FieldChoice<ProductEditValues[F]>;
export type ProductSettingsChoices = { readonly [F in ProductEditField]: ProductFieldChoice<F> };
/** Some fields' choices at once: what one editor's [Done] (or one quick pick) puts in the draft. */
export type ProductSettingsPicks = { readonly [F in ProductEditField]?: ProductFieldChoice<F> };

/** Any field's choice, for code that handles every field. */
type AnyChoice = FieldChoice<ProductEditValues[ProductEditField]>;

/** The own-settings read (`GET …/products/:productId/own`). */
export type ProductOwnSettings = ListingSettingsProductOwnSettings;
export type ProductOwnValues = ProductOwnSettings["own"];

/**
 * `size_price`: one size's exact price (W9). `settings`: the product's own
 * settings (W5). `product_price`: the product's price through the price
 * check (W7, PR 10d; plan D2).
 */
export type DrawerChangeKind = "none" | "size_price" | "settings" | "product_price";

/**
 * The drawer's draft value while it holds the product's settings: one field
 * per choice (so the bar counts each changed setting as one change), and the
 * own values and revision they start from, the same in the draft's base and
 * value. The base has every choice "leave".
 */
export type ProductSettingsDraftValue = ProductSettingsChoices & {
  readonly own: ProductOwnValues;
  /** W5's `expectedRevisionId`: the own read's `revisionId`, from the same answer as `own`. */
  readonly expectedRevisionId: number | null;
};

/** What the drawer's one draft holds: a size's exact price (PR 7's W9 value), the product's settings, or its price (W7). */
export type DrawerDraftValue = SizePriceDraft | ProductSettingsDraftValue | ProductPriceDraftValue;

const LEAVE: FieldChoice<never> = Object.freeze({ mode: "leave" });
const DEFAULT: FieldChoice<never> = Object.freeze({ mode: "default" });

/** Every field left as it is. */
export function emptyChoices(): ProductSettingsChoices {
  return Object.freeze({
    shippingPolicy: LEAVE, returnPolicy: LEAVE, paymentPolicy: LEAVE, ebayCategory: LEAVE, storeShelf: LEAVE,
    textAbove: LEAVE, textBelow: LEAVE, mainText: LEAVE,
  });
}

/**
 * Vendor text as the shared schemas store it: line breaks as "\n", trimmed
 * (the transform of `SH/listing-content.ts` `text()`; a test pins that the
 * two agree). Used only to tell whether a typed text is what is saved.
 */
export function normalizedVendorText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/** What the product has now for one field, as a choice ("Use default" when it has none of its own). */
function ownChoiceOf(field: ProductEditField, own: ProductOwnValues): AnyChoice {
  switch (field) {
    case "shippingPolicy":
    case "returnPolicy":
    case "paymentPolicy": {
      const saved = own[field];
      return saved === null ? DEFAULT : { mode: "set", value: { id: saved.id } };
    }
    case "ebayCategory":
      return own.ebayCategory === null ? DEFAULT
        : { mode: "set", value: { categoryId: own.ebayCategory.categoryId, categoryName: own.ebayCategory.categoryName } };
    case "storeShelf": {
      const saved = own.storeShelf;
      if (saved === null) return DEFAULT;
      return saved.mode === "none" ? { mode: "set", value: { mode: "none" } }
        : { mode: "set", value: { mode: "own", shelfIds: saved.shelves.map((shelf) => shelf.id) } };
    }
    case "textAbove":
    case "textBelow": {
      const saved = own[field];
      if (saved === null) return DEFAULT;
      return saved.mode === "none" ? { mode: "set", value: { mode: "none" } } : { mode: "set", value: { mode: "own", text: saved.text } };
    }
    case "mainText":
      return own.mainText === null ? DEFAULT : { mode: "set", value: { text: own.mainText.text } };
  }
}

/** What the product has now, as choices: the field editors open on these. Shelves come by id (5.6). */
export function choicesFromOwn(own: Pick<ProductOwnSettings, "own">): ProductSettingsChoices {
  const choices: Record<string, AnyChoice> = {};
  for (const field of PRODUCT_EDIT_FIELDS) choices[field] = ownChoiceOf(field, own.own);
  return Object.freeze(choices) as unknown as ProductSettingsChoices;
}

/** The fields a change touches, in the drawer's order. */
export function changedFields(choices: ProductSettingsChoices): ProductEditField[] {
  return PRODUCT_EDIT_FIELDS.filter((field) => choices[field].mode !== "leave");
}

/** The fields a size can still hold on its own (`S/domain/listing-setting-values.ts` LISTING_SETTING_LEFTOVER_FIELDS). */
const SIZE_LEFTOVER_FIELDS = ["shippingPolicy", "returnPolicy", "paymentPolicy", "storeShelf", "mainText"] as const satisfies readonly ProductEditField[];
type SizeLeftoverField = (typeof SIZE_LEFTOVER_FIELDS)[number];

/**
 * The fields a chosen size still sets for itself: a leftover of the older
 * per-size settings (source `size` in the product's settings in full). A
 * leftover beats the product's own value and its category's, and a W5 save
 * that names the field clears it (`S/domain/listing-setting-values.ts`
 * LISTING_SETTING_LEFTOVER_FIELDS; `S/application/dropship-listing-product-settings-service.ts`
 * `clearSizeLeftovers`). So while one is there, a choice equal to the
 * product's own value is still a change: sending it is the only way to clear
 * it. The eBay category and the text above and below have no per-size table.
 */
export function sizeLeftoverFields(settings: Pick<ListingSettingsProductDetail["settings"], SizeLeftoverField>): ProductEditField[] {
  return SIZE_LEFTOVER_FIELDS.filter((field) => settings[field].some((entry) => entry.sources.some((source) => source.source === "size")));
}

/**
 * A choice's meaning for comparing, by field: ids for eBay values (a renamed
 * policy, category or shelf is the same one), and text as it is stored.
 */
function choiceKey(field: ProductEditField, choice: AnyChoice): string {
  if (choice.mode !== "set") return choice.mode;
  const value = choice.value as unknown as Record<string, unknown>;
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
    case "mainText":
      return JSON.stringify(["set", normalizedVendorText(String(value.text))]);
  }
}

/** Whether `choice` asks for what the product already has: then it is no change. */
function sameAsOwn(field: ProductEditField, choice: AnyChoice, own: ProductOwnValues): boolean {
  if (choice.mode === "leave") return true;
  return choiceKey(field, choice) === choiceKey(field, ownChoiceOf(field, own));
}

/**
 * Fields where a choice equal to what is saved still counts as a change:
 * - a field a size still sets for itself (`sizeLeftoverFields`): sending it
 *   clears the size's leftover;
 * - the main text while it needs a check (5.4 [Keep my text]): W5 stamps the
 *   text it saves with Card Shellz's product as it is now
 *   (`S/application/dropship-listing-product-settings-service.ts` `storedProductPatch`), and the
 *   repository compares the stored value hash included (`changedListingSettingFields`,
 *   `S/domain/listing-setting-values.ts`), so the same text saves as `changed`
 *   and the check clears (A2, checked at build).
 */
function alwaysAChange(field: ProductEditField, own: ProductOwnValues, leftovers: readonly ProductEditField[]): boolean {
  return leftovers.includes(field) || (field === "mainText" && own.mainText?.needsCheck === true);
}

/** A fresh copy of a choice: the draft never shares an object with what it was given. */
function copyChoice(field: ProductEditField, choice: AnyChoice): AnyChoice {
  if (choice.mode === "leave") return LEAVE;
  if (choice.mode === "default") return DEFAULT;
  const value = choice.value as unknown as Record<string, unknown>;
  switch (field) {
    case "shippingPolicy":
    case "returnPolicy":
    case "paymentPolicy":
      return { mode: "set", value: { id: String(value.id) } };
    case "ebayCategory":
      return {
        mode: "set",
        value: typeof value.categoryName === "string"
          ? { categoryId: String(value.categoryId), categoryName: value.categoryName }
          : { categoryId: String(value.categoryId) },
      };
    case "storeShelf":
      return value.mode === "own"
        ? { mode: "set", value: { mode: "own", shelfIds: [...(value.shelfIds as readonly string[])] } }
        : { mode: "set", value: { mode: "none" } };
    case "textAbove":
    case "textBelow":
      return value.mode === "own"
        ? { mode: "set", value: { mode: "own", text: String(value.text) } }
        : { mode: "set", value: { mode: "none" } };
    case "mainText":
      return { mode: "set", value: { text: String(value.text) } };
  }
}

/**
 * The choice as the draft keeps it: one that asks for what is saved is
 * "leave", so it counts as no change, unless the field is always a change
 * (a size's leftover, or a main text that needs a check).
 */
function draftChoice(field: ProductEditField, choice: AnyChoice, own: ProductOwnValues, leftovers: readonly ProductEditField[]): AnyChoice {
  if (choice.mode === "leave" || (!alwaysAChange(field, own, leftovers) && sameAsOwn(field, choice, own))) return LEAVE;
  return copyChoice(field, choice);
}

// ---------------------------------------------------------------------------
// The draft value
// ---------------------------------------------------------------------------

/**
 * The settings draft value on the own read's answer; with no choices, it is
 * the draft's base. `leftovers`: the fields a size still sets for itself
 * (`sizeLeftoverFields` of the product's settings in full).
 */
export function productSettingsDraftValue(
  own: Pick<ProductOwnSettings, "own" | "revisionId">,
  choices: ProductSettingsChoices = emptyChoices(),
  leftovers: readonly ProductEditField[] = [],
): ProductSettingsDraftValue {
  const value: Record<string, unknown> = {};
  for (const field of PRODUCT_EDIT_FIELDS) value[field] = draftChoice(field, choices[field], own.own, leftovers);
  return { ...value, own: own.own, expectedRevisionId: own.revisionId } as unknown as ProductSettingsDraftValue;
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

function isNonBlankId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Whether `value` is a `set` value of this field's shape. */
function isSetValue(field: ProductEditField, value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  switch (field) {
    case "shippingPolicy":
    case "returnPolicy":
    case "paymentPolicy":
      return isNonBlankId(record.id);
    case "ebayCategory":
      return isNonBlankId(record.categoryId) && (record.categoryName === undefined || isText(record.categoryName));
    case "storeShelf":
      if (record.mode === "none") return true;
      return record.mode === "own" && Array.isArray(record.shelfIds) && record.shelfIds.length > 0 && record.shelfIds.every(isNonBlankId);
    case "textAbove":
    case "textBelow":
      return record.mode === "none" || (record.mode === "own" && isText(record.text));
    case "mainText":
      return isText(record.text);
  }
}

/** Whether `value` is a choice of this field's shape (leave, default, or a `set` of its value); "Set for selected" checks its own with it. */
export function isProductFieldChoice(field: ProductEditField, value: unknown): value is FieldChoice<ProductEditValues[ProductEditField]> {
  return isChoiceFor(field, value);
}

function isChoiceFor(field: ProductEditField, value: unknown): value is AnyChoice {
  if (typeof value !== "object" || value === null) return false;
  const choice = value as { mode?: unknown; value?: unknown };
  if (choice.mode === "leave" || choice.mode === "default") return true;
  return choice.mode === "set" && isSetValue(field, choice.value);
}

function isRevision(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

/** The settings draft value, or null when `value` is not one (a size's price, or another editor's draft). */
export function readProductSettingsDraft(value: DraftValue): ProductSettingsDraftValue | null {
  const { own, expectedRevisionId } = value;
  if (typeof own !== "object" || own === null || !isRevision(expectedRevisionId)) return null;
  if (!PRODUCT_EDIT_FIELDS.every((field) => isChoiceFor(field, value[field]))) return null;
  return value as unknown as ProductSettingsDraftValue;
}

/**
 * What this product's draft holds: its kind while it holds a change or a save
 * that is out or unconfirmed, else "none". Another editor's draft is "none"
 * here (opening asks first, `decideOpen`).
 */
export function drawerChangeKind(draft: ListingSettingsDraft | null, editor: EditorId): DrawerChangeKind {
  if (draft === null || draft.editor !== editor) return "none";
  if (!isDraftDirty(draft) && !isDraftLocked(draft)) return "none";
  // The drawer's draft holds one of three values; anything that isn't settings or the price is PR 7's size price.
  if (readProductSettingsDraft(draft.value) !== null) return "settings";
  return readProductPriceDraft(draft.value) !== null ? "product_price" : "size_price";
}

/** Starting a change of kind `wanted` while the draft holds `current` (D2): one kind per Save. */
export function decideDrawerEdit(current: DrawerChangeKind, wanted: DrawerChangeKind): "edit" | "finish_first" {
  return current === "none" || current === wanted ? "edit" : "finish_first";
}

/** What putting a field editor's choice in the draft does ([Done]; nothing is sent until Save). */
export type ProductSettingsEditAction =
  /** The product's settings draft holds changes: the choice joins them (`reopen` when the drawer was hidden by Back). */
  | { kind: "edit"; reopen: boolean; value: ProductSettingsDraftValue }
  /** A new settings draft on the own read: opened on `base` (asking first if another editor holds changes), then `value`. */
  | { kind: "start"; base: ProductSettingsDraftValue; value: ProductSettingsDraftValue }
  /** A size's price holds a change: "Save or discard your other change first." (D2). */
  | { kind: "finish_first" }
  /** A save is in flight or unconfirmed: nothing changes until it ends (R:539, R:541). */
  | { kind: "locked" }
  /**
   * The choice is what the product has, and the draft holds no settings
   * change: nothing to put in the draft, so no draft opens (and no other
   * editor's changes are asked about). The editor just closes.
   */
  | { kind: "no_change" };

interface ProductSettingsEditBase {
  draft: ListingSettingsDraft | null;
  editor: EditorId;
  own: ProductOwnSettings;
  leftovers?: readonly ProductEditField[];
}

/** The picks one call puts in the draft, checked against each field's shape; a mismatch is a programming fault. */
function checkedPicks(picks: Readonly<Record<string, unknown>>): Array<[ProductEditField, AnyChoice]> {
  return Object.keys(picks).filter((field) => picks[field] !== undefined).map((field) => {
    const choice = picks[field];
    if (!isProductEditField(field) || !isChoiceFor(field, choice)) {
      throw new Error(`A drawer edit names a field or a choice the drawer doesn't edit: ${field}.`);
    }
    return [field, choice];
  });
}

/**
 * [Done] in a field editor, or a "Sizes differ" quick pick: one field's
 * choice (`field` + `choice`), or several fields' at once (`picks`, the
 * description editor's parts). A settings draft with changes keeps its start
 * (the revision the vendor saw); any other edit starts from the own read as
 * it is now, so it never sends an old revision. `leftovers`: the fields a
 * size still sets for itself (`sizeLeftoverFields`), where the product's own
 * value is still a change.
 */
export function productSettingsEditAction<F extends ProductEditField>(
  input: ProductSettingsEditBase & { field: F; choice: ProductFieldChoice<F> },
): ProductSettingsEditAction;
export function productSettingsEditAction(input: ProductSettingsEditBase & { picks: ProductSettingsPicks }): ProductSettingsEditAction;
export function productSettingsEditAction(
  input: ProductSettingsEditBase & { field?: ProductEditField; choice?: AnyChoice; picks?: ProductSettingsPicks },
): ProductSettingsEditAction {
  const { draft, editor } = input;
  const leftovers = input.leftovers ?? [];
  const picks = checkedPicks(input.picks ?? (input.field === undefined ? {} : { [input.field]: input.choice }));
  const ownDraft = draft !== null && draft.editor === editor ? draft : null;
  if (ownDraft !== null && isDraftLocked(ownDraft)) return { kind: "locked" };
  const kind = drawerChangeKind(draft, editor);
  if (kind === "settings" && ownDraft !== null) {
    const current = readProductSettingsDraft(ownDraft.value)!;
    const value: Record<string, unknown> = { ...current };
    for (const [field, choice] of picks) value[field] = draftChoice(field, choice, current.own, leftovers);
    return { kind: "edit", reopen: !ownDraft.open, value: value as unknown as ProductSettingsDraftValue };
  }
  const chosen = picks.map(([field, choice]) => [field, draftChoice(field, choice, input.own.own, leftovers)] as const);
  if (chosen.every(([, choice]) => choice.mode === "leave")) return { kind: "no_change" };
  if (decideDrawerEdit(kind, "settings") === "finish_first") return { kind: "finish_first" };
  const base = productSettingsDraftValue(input.own);
  const value: Record<string, unknown> = { ...base };
  for (const [field, choice] of chosen) value[field] = choice;
  return { kind: "start", base, value: value as unknown as ProductSettingsDraftValue };
}

// ---------------------------------------------------------------------------
// The W5 request
// ---------------------------------------------------------------------------

/** One field's `set` value as W5 takes it: ids and text only, never a name. */
function patchValue(field: ProductEditField, choice: Extract<AnyChoice, { mode: "set" }>): unknown {
  const value = choice.value as unknown as Record<string, unknown>;
  switch (field) {
    case "shippingPolicy":
    case "returnPolicy":
    case "paymentPolicy":
      return { id: value.id };
    case "ebayCategory":
      // The number alone: the server reads the name from eBay or from what the product stores (P13).
      return { categoryId: value.categoryId };
    case "storeShelf":
      return value.mode === "own" ? { mode: "own", shelfIds: [...(value.shelfIds as readonly string[])] } : { mode: "none" };
    case "textAbove":
    case "textBelow":
      return value.mode === "own" ? { mode: "own", text: value.text } : { mode: "none" };
    case "mainText":
      // The text alone: the server stamps the catalog hash it is written against (plan 6.13 #5 of PR 9).
      return { text: value.text };
  }
}

/** leave → absent, default → null, set → ids and text only. */
export function productSettingsPatch(choices: ProductSettingsChoices): ProductSettingsPatchInput {
  const patch: Record<string, unknown> = {};
  for (const field of PRODUCT_EDIT_FIELDS) {
    const choice = choices[field] as AnyChoice;
    if (choice.mode === "default") patch[field] = null;
    else if (choice.mode === "set") patch[field] = patchValue(field, choice);
  }
  return patch as ProductSettingsPatchInput;
}

/** The W5 body this page sends: never `sizePrices` or `expectedPrices` (D1), so it carries no price at all. */
export interface ProductSettingsSaveBody {
  idempotencyKey: string;
  expectedRevisionId: number | null;
  patch: ProductSettingsPatchInput;
}

export const PRODUCT_SETTINGS_REQUEST_INVALID = "DROPSHIP_LISTING_SETTINGS_PRODUCT_REQUEST_INVALID";

/** A W5 body this page would build outside the contract: never sent. */
export class ProductSettingsRequestError extends Error {
  readonly code = PRODUCT_SETTINGS_REQUEST_INVALID;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(message: string, context: Record<string, unknown>) {
    super(message);
    this.name = "ProductSettingsRequestError";
    this.context = Object.freeze({ ...context });
  }
}

/**
 * The W5 body, checked by the shared input schema before it is sent. Throws a
 * ProductSettingsRequestError for an empty patch, a field this page doesn't
 * edit (a price above all, D1) or anything the schema refuses (text over its
 * limit included, 5.4). What is sent is the schema's output: text with its
 * line breaks as "\n" and trimmed, as the server stores it.
 */
export function productSettingsSaveBody(input: { key: string; expectedRevisionId: number | null; patch: ProductSettingsPatchInput }): ProductSettingsSaveBody {
  const sent = Object.keys(input.patch).filter((field) => input.patch[field as keyof ProductSettingsPatchInput] !== undefined);
  const outside = sent.filter((field) => !FIELD_SET.has(field));
  if (outside.length > 0) throw new ProductSettingsRequestError("This change names a setting the drawer doesn't save.", { fields: outside });
  if (sent.length === 0) throw new ProductSettingsRequestError("There is no change to save.", { fields: [] });
  const parsed = saveProductSettingsInputSchema.safeParse({ idempotencyKey: input.key, expectedRevisionId: input.expectedRevisionId, patch: input.patch });
  if (!parsed.success) {
    throw new ProductSettingsRequestError("This change can't be sent as it is.", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })),
    });
  }
  // The parsed body without the schema's defaults (`sizePrices: []`): what is sent is what was checked.
  return { idempotencyKey: parsed.data.idempotencyKey, expectedRevisionId: parsed.data.expectedRevisionId, patch: parsed.data.patch };
}

/** The patch's keys in the stored shape's order (the server's request hash is order-free too). */
const PATCH_KEY_ORDER: readonly string[] = Object.keys(productSettingsPatchInputSchema.shape);

/** JSON with every object's keys sorted, so equal values always write the same text. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/**
 * A patch's sent fields in the stored shape's order, each value canonical:
 * the part of a request signature W5 and W6 share (W6: "Set for selected").
 */
export function patchSignatureEntries(patch: ProductSettingsPatchInput): Array<[string, unknown]> {
  return PATCH_KEY_ORDER
    .filter((field) => patch[field as keyof ProductSettingsPatchInput] !== undefined)
    .map((field) => [field, canonical(patch[field as keyof ProductSettingsPatchInput])]);
}

/**
 * Everything a W5 request sends except its key: the same request always
 * reuses its key (a retry is answered by the first save), and any edit, or a
 * new revision after "Load latest", gets a new one. Shelf order counts (first,
 * then second).
 */
export function productSettingsSignature(
  storeConnectionId: number,
  productId: number,
  expectedRevisionId: number | null,
  patch: ProductSettingsPatchInput,
): string {
  return JSON.stringify(["listing-settings-product-settings-v1", storeConnectionId, productId, expectedRevisionId, patchSignatureEntries(patch)]);
}

// ---------------------------------------------------------------------------
// Who may change which field (D3, D4, CC-C16)
// ---------------------------------------------------------------------------

type PickRightName = "shipping" | "policies" | "ebayCategory" | "shelfPick";

/**
 * The right a field also needs to pick a new eBay value: the policy lists
 * come from the live setup read (W2), the shelves from the shelves read (W2),
 * and the category picker reads eBay itself (W3's right). Text names no eBay
 * value, so W5's right is all it needs.
 */
const FIELD_PICK_RIGHT: Readonly<Record<ProductEditField, PickRightName | null>> = {
  shippingPolicy: "shipping",
  returnPolicy: "policies",
  paymentPolicy: "policies",
  ebayCategory: "ebayCategory",
  storeShelf: "shelfPick",
  textAbove: null,
  textBelow: null,
  mainText: null,
};

/** The fields that also offer "None" (explicitly nothing): the shelf and the text above and below. */
const FIELDS_WITH_NONE: ReadonlySet<ProductEditField> = new Set(["storeShelf", "textAbove", "textBelow"]);

/** The rights a product's own settings read: W5's, and the rights its fields pick eBay values with. */
export type ProductSettingsRights = Pick<ListingSettingsEditRights, "productSettings" | "shipping" | "policies" | "ebayCategory" | "shelfPick">;

export interface ProductFieldRights {
  /** A new value can be picked (for text: own text can be written). */
  canSet: boolean;
  /** "Use default" can be chosen: it names no eBay value, so W5 asks eBay nothing (P13). */
  canDefault: boolean;
  /** "None" can be chosen (shelf, text above and below): it names no eBay value either (D4). */
  canNone: boolean;
  /** Why not everything can be chosen; null when it can. */
  reason: ListingSettingsRightReason | null;
}

/**
 * A field's rights: W5's right AND the field's own pick right. A paused
 * vendor or inactive .ops takes W5 away, so nothing can be chosen (C16). A
 * sign-in or eBay refusing access takes the pick right away and leaves "Use
 * default" and "None" (D4); so does eBay not answering, or Card Shellz
 * shipping not being ready for a shipping policy. Own text needs no eBay.
 */
export function productFieldRights(rights: ProductSettingsRights, field: ProductEditField): ProductFieldRights {
  const product = rights.productSettings;
  if (!product.editable) return { canSet: false, canDefault: false, canNone: false, reason: product.reason };
  const canNone = FIELDS_WITH_NONE.has(field);
  const pickRight = FIELD_PICK_RIGHT[field];
  const pick = pickRight === null ? null : rights[pickRight];
  if (pick === null || pick.editable) return { canSet: true, canDefault: true, canNone, reason: null };
  return { canSet: false, canDefault: true, canNone, reason: pick.reason };
}

// ---------------------------------------------------------------------------
// "Load latest and keep my changes" (R:542, C20)
// ---------------------------------------------------------------------------

/** Whether a field's saved value differs between two reads. A renamed policy, category or shelf is the same one. */
function ownValueMoved(field: ProductEditField, before: ProductOwnValues, after: ProductOwnValues): boolean {
  return choiceKey(field, ownChoiceOf(field, before)) !== choiceKey(field, ownChoiceOf(field, after));
}

/** The fields the vendor changed whose saved value another window moved since the vendor's read (C20). */
export function markedAfterReload(
  before: Pick<ProductOwnSettings, "own">,
  after: Pick<ProductOwnSettings, "own">,
  changed: readonly ProductEditField[],
): ProductEditField[] {
  return PRODUCT_EDIT_FIELDS.filter((field) => changed.includes(field) && ownValueMoved(field, before.own, after.own));
}

/** "Load latest": the vendor's choices on what is saved now, and whether any of them is still a change. */
export interface ProductSettingsReload {
  /** The vendor's choices on what is saved now: send it to the draft first. */
  edited: ProductSettingsDraftValue;
  /** What is saved now, the draft's new base: rebase on it with `marked`. */
  latest: ProductSettingsDraftValue;
  marked: ProductEditField[];
  /**
   * False when nothing of the vendor's is left to keep (another window saved
   * the same choices): the draft is discarded instead, so it never says
   * "Your changes are on top" over no change.
   */
  keeps: boolean;
}

/**
 * After a 409: the vendor's choices on what is saved now (`edited`), and what
 * is saved now (`latest`), the draft's new base, with the fields to mark.
 * Send `edited` first, then rebase on `latest` with `marked`. A choice that
 * now matches what is saved is no longer a change, and is not marked, unless
 * a size's leftover (`leftovers`, from the product's settings read with it)
 * or a main text that still needs a check keeps it one.
 */
export function rebaseProductSettingsDraft(
  mine: ProductSettingsDraftValue,
  latest: ProductOwnSettings,
  leftovers: readonly ProductEditField[] = [],
): ProductSettingsReload {
  const edited = productSettingsDraftValue(latest, mine, leftovers);
  const changed = changedFields(edited);
  return {
    edited,
    latest: productSettingsDraftValue(latest),
    marked: markedAfterReload({ own: mine.own }, latest, changed),
    keeps: changed.length > 0,
  };
}

// ---------------------------------------------------------------------------
// A policy row's editor (plan 4.5): what it lists, and where it starts
// ---------------------------------------------------------------------------

const POLICY_KIND_BY_FIELD: Readonly<Record<PolicyEditField, ListingSettingsPolicyKind>> = {
  shippingPolicy: "shipping",
  returnPolicy: "return",
  paymentPolicy: "payment",
};

export interface PolicyFieldEditorModel {
  field: PolicyEditField;
  kind: ListingSettingsPolicyKind;
  /**
   * eBay's policies to pick from, in eBay's order, each shipping policy with
   * whether it works with Card Shellz shipping; null when no new policy can be
   * picked now (the row's line says why), so only "Use default" shows.
   */
  choices: PolicyEditorChoice[] | null;
  /** Words in place of an empty list ("You don't have a … policy on eBay yet."); null otherwise. */
  emptyLine: string | null;
  /**
   * What the editor opens on: the draft's change, else what the product has
   * ("Use default" when it has none of its own). Nothing is picked while a
   * size's leftover makes the row read otherwise, so the vendor picks.
   */
  initial: FieldChoice<PolicyChoiceValue>;
  canSet: boolean;
  canDefault: boolean;
}

/** The latest setup answer, or null while it loads or after a refetch failed (an older answer is not offered). */
function liveSetupOf(setup: ListingSettingsReadState<PolicySetupFacts>): PolicySetupFacts | null {
  return setup.data !== undefined && (setup.error === undefined || setup.error === null) ? setup.data : null;
}

/**
 * The editor a policy row opens (plan 4.5, D4): eBay's policies from the
 * live setup read when a new one can be picked, and "Use default" when it can
 * be chosen. The list is only ever the latest read's: an older answer a
 * failed refetch left behind is not offered (`liveSetup` in the rows).
 */
/** The policies a row's editor lists: the latest setup read's, while a new one can be picked and eBay was read; else null. */
function livePolicyChoices(
  field: PolicyEditField,
  canSet: boolean,
  setup: ListingSettingsReadState<PolicySetupFacts>,
): PolicyEditorChoice[] | null {
  const live = liveSetupOf(setup);
  return canSet && live !== null && setupReadEbay(live) ? policyEditorChoices(live, POLICY_KIND_BY_FIELD[field]) : null;
}

export function policyFieldEditor(input: {
  field: PolicyEditField;
  rights: Pick<ProductFieldRights, "canSet" | "canDefault">;
  /** The draft's choice for this field ("leave" while it holds none). */
  draftChoice: FieldChoice<PolicyChoiceValue>;
  own: Pick<ProductOwnSettings, "own">;
  /** A size still sets this field for itself (`sizeLeftoverFields`). */
  leftover?: boolean;
  setup: ListingSettingsReadState<PolicySetupFacts>;
}): PolicyFieldEditorModel {
  const { field, rights } = input;
  const kind = POLICY_KIND_BY_FIELD[field];
  const choices = livePolicyChoices(field, rights.canSet, input.setup);
  return {
    field,
    kind,
    choices,
    emptyLine: choices !== null && choices.length === 0 ? noPolicyOnEbayWords(kind) : null,
    initial: input.draftChoice.mode !== "leave" ? input.draftChoice : input.leftover === true ? LEAVE : choicesFromOwn(input.own)[field],
    canSet: rights.canSet,
    canDefault: rights.canDefault,
  };
}

/** Whether [Done] can put this choice in the draft: a usable eBay policy the list offers, or "Use default" when allowed. */
export function fieldChoiceReady(model: Pick<PolicyFieldEditorModel, "choices" | "canSet" | "canDefault">, choice: FieldChoice<PolicyChoiceValue>): boolean {
  if (choice.mode === "default") return model.canDefault;
  if (choice.mode === "set") return model.canSet && (model.choices ?? []).some((option) => option.id === choice.value.id && option.choosable);
  return false;
}

// ---------------------------------------------------------------------------
// The eBay category row's editor (plan 5.2)
// ---------------------------------------------------------------------------

export interface EbayCategoryFieldEditorModel {
  field: "ebayCategory";
  /** A category can be picked: the picker searches eBay (W3's right), so it shows only then. */
  canSet: boolean;
  canDefault: boolean;
  /** The draft's change, else what the product has ("Use default" when it has none of its own). */
  initial: FieldChoice<EbayCategoryChoiceValue>;
  /** The picker's search starts from the category shown now: its name, never its number. */
  initialQuery: string;
}

export function ebayCategoryFieldEditor(input: {
  rights: Pick<ProductFieldRights, "canSet" | "canDefault">;
  draftChoice: FieldChoice<EbayCategoryChoiceValue>;
  own: Pick<ProductOwnSettings, "own">;
}): EbayCategoryFieldEditorModel {
  const initial = input.draftChoice.mode !== "leave" ? input.draftChoice : choicesFromOwn(input.own).ebayCategory;
  return {
    field: "ebayCategory",
    canSet: input.rights.canSet,
    canDefault: input.rights.canDefault,
    initial,
    initialQuery: initial.mode === "set" ? initial.value.categoryName?.trim() ?? "" : "",
  };
}

/** The picker's category as a choice: its number to send, its name for the pending line only. */
export function ebayCategoryPick(category: { categoryId: string; categoryName: string }): FieldChoice<EbayCategoryChoiceValue> {
  return { mode: "set", value: { categoryId: category.categoryId, categoryName: category.categoryName } };
}

/**
 * The eBay category editor's own category radio, named as the row names it:
 * its name, else "An eBay category" (a quick pick from a value eBay gave no
 * name for); never its number, and never the picker's button words.
 */
export function ebayCategoryChoiceLabel(value: EbayCategoryChoiceValue): string {
  return drawerEbayCategoryValue({ categoryId: value.categoryId, categoryName: value.categoryName ?? null });
}

/** Whether [Done] can put this choice in the draft. */
export function ebayCategoryChoiceReady(model: Pick<EbayCategoryFieldEditorModel, "canSet" | "canDefault">, choice: FieldChoice<EbayCategoryChoiceValue>): boolean {
  if (choice.mode === "default") return model.canDefault;
  return choice.mode === "set" && model.canSet && isSetValue("ebayCategory", choice.value);
}

// ---------------------------------------------------------------------------
// The store shelf row's editor (plan 5.2): one or two shelves, None, or the default
// ---------------------------------------------------------------------------

/** The shelf editor's local state: "leave" while nothing is picked yet (a size's leftover makes the row read otherwise). */
export interface StoreShelfEditorState {
  mode: "leave" | "default" | "none" | "own";
  first: string | null;
  second: string | null;
}

export interface StoreShelfFieldEditorModel {
  field: "storeShelf";
  canSet: boolean;
  canDefault: boolean;
  canNone: boolean;
  /**
   * The shelves to pick from: the shelves read, plus each of the product's
   * own shelves the read doesn't have (marked as gone), so a saved pick still
   * shows. Null when no new shelf can be picked now (only None and Use default show).
   */
  options: DropshipEbayStoreCategoryOption[] | null;
  initial: StoreShelfEditorState;
}

function shelfState(choice: FieldChoice<StoreShelfChoiceValue>): StoreShelfEditorState {
  if (choice.mode === "leave") return { mode: "leave", first: null, second: null };
  if (choice.mode === "default") return { mode: "default", first: null, second: null };
  if (choice.value.mode === "none") return { mode: "none", first: null, second: null };
  return { mode: "own", first: choice.value.shelfIds[0] ?? null, second: choice.value.shelfIds[1] ?? null };
}

export function storeShelfFieldEditor(input: {
  rights: Pick<ProductFieldRights, "canSet" | "canDefault" | "canNone">;
  draftChoice: FieldChoice<StoreShelfChoiceValue>;
  own: Pick<ProductOwnSettings, "own">;
  /** A size still sets its own shelf (`sizeLeftoverFields`). */
  leftover?: boolean;
  /** The step's shelves read (`categories`), or null while it can't be read. */
  shelves: readonly DropshipEbayStoreCategoryOption[] | null;
}): StoreShelfFieldEditorModel {
  const saved = input.own.own.storeShelf;
  const savedShelves = saved !== null && saved.mode === "own"
    ? { ids: saved.shelves.map((shelf) => shelf.id), names: saved.shelves.map((shelf) => shelf.name) }
    : null;
  const options = input.rights.canSet && input.shelves !== null ? shelfPickerOptions(input.shelves, savedShelves) : null;
  const initialChoice = input.draftChoice.mode !== "leave" ? input.draftChoice
    : input.leftover === true ? LEAVE : choicesFromOwn(input.own).storeShelf;
  return {
    field: "storeShelf",
    canSet: input.rights.canSet,
    canDefault: input.rights.canDefault,
    canNone: input.rights.canNone,
    options,
    initial: shelfState(initialChoice),
  };
}

/**
 * The shelf editor's [Done]: the choice its state makes, or why it can't be
 * put in the draft yet (`problem` null: nothing to say, [Done] is just off).
 * Two shelves must differ, and a second needs a first (the store default
 * editor's words); a picked shelf must be one the editor offers.
 */
export function storeShelfEditorChoice(
  model: Pick<StoreShelfFieldEditorModel, "canSet" | "canDefault" | "canNone" | "options">,
  state: StoreShelfEditorState,
): { ok: true; choice: FieldChoice<StoreShelfChoiceValue> } | { ok: false; problem: string | null } {
  switch (state.mode) {
    case "leave":
      return { ok: false, problem: null };
    case "default":
      return model.canDefault ? { ok: true, choice: DEFAULT } : { ok: false, problem: null };
    case "none":
      return model.canNone ? { ok: true, choice: { mode: "set", value: { mode: "none" } } } : { ok: false, problem: null };
    case "own": {
      if (!model.canSet || model.options === null) return { ok: false, problem: null };
      const problem = shelfDraftProblem(state);
      if (problem !== null) return { ok: false, problem };
      if (state.first === null) return { ok: false, problem: null };
      const shelfIds = state.second === null ? [state.first] : [state.first, state.second];
      const offered = new Set(model.options.map((option) => option.categoryId));
      if (!shelfIds.every((id) => offered.has(id))) return { ok: false, problem: null };
      const parsed = listingSettingStoreShelfInputSchema.safeParse({ mode: "own", shelfIds });
      if (!parsed.success) return { ok: false, problem: parsed.error.issues[0]?.message ?? null };
      return { ok: true, choice: { mode: "set", value: { mode: "own", shelfIds } } };
    }
  }
}

// ---------------------------------------------------------------------------
// Text (plan 5.4, 5.5)
// ---------------------------------------------------------------------------

/** The longest text above or below, and the longest main text, in UTF-16 units of the raw text (Zod's `max`). */
export const PRODUCT_TEXT_LIMITS: Readonly<Record<DescriptionEditField, number>> = Object.freeze({
  textAbove: MAX_TEMPLATE_TEXT_LENGTH,
  textBelow: MAX_TEMPLATE_TEXT_LENGTH,
  mainText: MAX_DESCRIPTION_TEXT_LENGTH,
});

/**
 * Why own text above or below can't be saved as typed, or null. Checked on
 * the raw text with the shared schema (`listingSettingTemplateTextSchema`,
 * ≤ 4,000), which bounds the length before it trims (`SH/listing-content.ts`).
 */
export function templateTextProblem(text: string): string | null {
  if (text.length > MAX_TEMPLATE_TEXT_LENGTH) return textTooLongWords(MAX_TEMPLATE_TEXT_LENGTH);
  if (listingSettingTemplateTextSchema.safeParse({ mode: "own", text }).success) return null;
  if (normalizedVendorText(text) === "") return LISTING_SETTINGS_EDIT_WORDS.textEmpty;
  // The only other refusal: control characters a paste can bring.
  return LISTING_SETTINGS_EDIT_WORDS.textBadCharacters;
}

/** Why an own main text can't be saved as typed, or null (`descriptionTextSchema`, ≤ 20,000, on the raw text). */
export function mainTextProblem(text: string): string | null {
  if (text.length > MAX_DESCRIPTION_TEXT_LENGTH) return textTooLongWords(MAX_DESCRIPTION_TEXT_LENGTH);
  if (descriptionTextSchema.safeParse(text).success) return null;
  if (normalizedVendorText(text) === "") return LISTING_SETTINGS_EDIT_WORDS.mainTextEmpty;
  return LISTING_SETTINGS_EDIT_WORDS.textBadCharacters;
}

/** A text box's counter: the raw `value.length` against its limit, as the server counts it (5.4). */
export interface TextCounter {
  count: number;
  max: number;
  over: boolean;
}

export function textCounter(text: string, field: DescriptionEditField): TextCounter {
  const max = PRODUCT_TEXT_LIMITS[field];
  return { count: text.length, max, over: text.length > max };
}

/** "Card Shellz changed this product. Check your text still fits." and its two answers (5.4). */
export interface OwnTextCheck {
  /**
   * [Keep my text]: the product's own text sent again, so it is checked
   * against the product as it is now; null unless that is all the save does
   * (see `ownTextCheckChoices`).
   */
  keep: FieldChoice<MainTextChoiceValue> | null;
  /** [Use Card Shellz text]: the default, which also clears a size's own text. */
  useCardShellz: FieldChoice<MainTextChoiceValue>;
}

/**
 * The answers to the main text's check (5.4), shown when the product's own
 * text needs a check (the own read's `needsCheck`) or a size's own text does
 * (its `own_text_needs_check` fix, `detail`). Null when nothing needs one.
 *
 * [Use Card Shellz text] = `default`. [Keep my text] = `set` with the same
 * text, offered only when the product's own text is the one that needs the
 * check and no chosen size keeps its own main text (`leftovers`, from the
 * sizes whose main text source is `size`; a size the product's own text
 * flags carries the same fix with no text of its own): any W5 main
 * text save clears every size's own text of the product
 * (`S/application/dropship-listing-product-settings-service.ts` `clearSizeLeftovers`,
 * `S/infrastructure/dropship-listing-setting-leftovers.repository.ts` content), so
 * a "keep" would delete the size's text, the very text the check is about.
 * The row's [Change] then picks one text for all sizes (5.3's line).
 */
export function ownTextCheckChoices(
  own: Pick<ProductOwnSettings, "own">,
  detail: Pick<ListingSettingsProductDetail, "sizes"> | null = null,
  leftovers: readonly ProductEditField[] = [],
): OwnTextCheck | null {
  const productText = own.own.mainText;
  const sizeNeedsCheck = detail !== null && detail.sizes.some((size) => size.fixes.includes("own_text_needs_check"));
  if (productText?.needsCheck !== true && !sizeNeedsCheck) return null;
  // A size flagged by the product's own text has no text of its own; one with its own text is a leftover (source `size`).
  const keepsOnlyProductText = productText?.needsCheck === true && !leftovers.includes("mainText");
  return {
    keep: productText !== null && keepsOnlyProductText ? { mode: "set", value: { text: productText.text } } : null,
    useCardShellz: DEFAULT,
  };
}

// ---------------------------------------------------------------------------
// The Description row's editor (plan 5.2): text above, text below, main text
// ---------------------------------------------------------------------------

/** One text part's local state. "leave": nothing picked yet (a size's leftover main text makes the row read otherwise). */
export interface TemplateTextEditorState {
  mode: "leave" | "default" | "none" | "own";
  text: string;
}

export interface MainTextEditorState {
  mode: "leave" | "default" | "own";
  text: string;
}

export interface DescriptionEditorState {
  textAbove: TemplateTextEditorState;
  textBelow: TemplateTextEditorState;
  mainText: MainTextEditorState;
}

export interface DescriptionEditorModel {
  /** Where each part opens: the draft's change, else what the product has; the text box keeps the product's own text to come back to. */
  initial: DescriptionEditorState;
  /** Own text can be written (W5's right: text names no eBay value). */
  canSet: boolean;
  canDefault: boolean;
  /** Text above and below can be set to "None". */
  canNone: boolean;
  /**
   * Whether the main text offers "Own text"; absent means it does whenever
   * `canSet` says so. "Set for selected" sets it false: for many products the
   * main text is only a reset to the Card Shellz text (`SW` productsBulkPatchInputSchema).
   */
  mainTextOwn?: boolean;
  /** The main text's check and its two answers; null when nothing needs a check or the draft already answers it. */
  check: OwnTextCheck | null;
  /**
   * While two older description rules tie for the product (`groupConflict`):
   * the line saying both parts must be set; null otherwise. Only the
   * product's own text above and below (own or None) takes the tie away
   * (`S/application/dropship-listing-content-resolver.ts` `templateFor`).
   */
  conflictLine: string | null;
}

function templateState(choice: FieldChoice<TemplateTextChoiceValue>, ownText: string): TemplateTextEditorState {
  if (choice.mode === "leave") return { mode: "leave", text: ownText };
  if (choice.mode === "default") return { mode: "default", text: ownText };
  return choice.value.mode === "none" ? { mode: "none", text: ownText } : { mode: "own", text: choice.value.text };
}

function mainState(choice: FieldChoice<MainTextChoiceValue>, ownText: string): MainTextEditorState {
  if (choice.mode === "leave") return { mode: "leave", text: ownText };
  if (choice.mode === "default") return { mode: "default", text: ownText };
  return { mode: "own", text: choice.value.text };
}

function ownTemplateText(own: ProductOwnValues, field: TemplateTextField): string {
  const saved = own[field];
  return saved !== null && saved.mode === "own" ? saved.text : "";
}

/**
 * The description editor's model (plan 5.2, 5.4). Each part opens on the
 * draft's change, else on what the product has. Nothing is picked where the
 * row reads otherwise, so choosing what the box holds is a change:
 * - the main text while a size keeps its own text (a leftover): the box holds
 *   the product's own text, empty when it has none (5.4, PROPOSAL), and
 *   choosing it sends it for every size (W5 clears the sizes' texts; the
 *   10a CE1 rule of the policy and shelf editors);
 * - text above or below the product doesn't set while two older description
 *   rules tie (`groupConflict`): "Use default" would leave the tie, so the
 *   vendor picks own text or None, and `conflictLine` says both are needed.
 */
export function descriptionFieldEditor(input: {
  /** The text fields' rights (`productFieldRights(rights, "textAbove")`; all three are W5's alone). */
  rights: Pick<ProductFieldRights, "canSet" | "canDefault" | "canNone">;
  draftChoices: Pick<ProductSettingsChoices, DescriptionEditField>;
  own: Pick<ProductOwnSettings, "own">;
  leftovers?: readonly ProductEditField[];
  /** The product's settings in full: a size's main text that needs a check, and a description rule tie. */
  detail?: (Pick<ListingSettingsProductDetail, "sizes"> & { settings?: Pick<ListingSettingsProductDetail["settings"], "descriptionTemplate"> }) | null;
}): DescriptionEditorModel {
  const own = input.own.own;
  const leftovers = input.leftovers ?? [];
  const fromOwn = choicesFromOwn(input.own);
  const conflict = input.detail?.settings?.descriptionTemplate.some((entry) => entry.value.groupConflict) === true;
  const pick = <F extends DescriptionEditField>(field: F): ProductFieldChoice<F> => {
    if (input.draftChoices[field].mode !== "leave") return input.draftChoices[field];
    if (field === "mainText" && leftovers.includes("mainText")) return LEAVE;
    if (field !== "mainText" && conflict && own[field as TemplateTextField] === null) return LEAVE;
    return fromOwn[field];
  };
  return {
    initial: {
      textAbove: templateState(pick("textAbove"), ownTemplateText(own, "textAbove")),
      textBelow: templateState(pick("textBelow"), ownTemplateText(own, "textBelow")),
      mainText: mainState(pick("mainText"), own.mainText?.text ?? ""),
    },
    canSet: input.rights.canSet,
    canDefault: input.rights.canDefault,
    canNone: input.rights.canNone,
    // Once the draft answers it ([Keep my text] or any main text change), the pending line says so instead.
    check: input.draftChoices.mainText.mode === "leave" ? ownTextCheckChoices(input.own, input.detail ?? null, leftovers) : null,
    conflictLine: conflict ? LISTING_SETTINGS_EDIT_WORDS.descriptionConflictBoth : null,
  };
}

function samePart(a: { mode: string; text: string }, b: { mode: string; text: string }): boolean {
  return a.mode === b.mode && (a.mode !== "own" || a.text === b.text);
}

export type DescriptionEditorResult =
  /** The parts the vendor changed, to put in the draft (`productSettingsEditAction({ picks })`); an untouched part is left out, so the draft keeps what it had. */
  | { ok: true; picks: Pick<ProductSettingsPicks, DescriptionEditField> }
  /** Text that can't be saved as typed, by part: nothing goes in the draft, so nothing is sent (5.4, 5.5). */
  | { ok: false; problems: Partial<Record<DescriptionEditField, string>> };

/**
 * The description editor's [Done]: each part the vendor changed as a choice,
 * own text checked as typed against its schema first. A part left as it
 * opened is not a pick, so a prefilled main text never re-saves by itself:
 * only [Keep my text] does (`ownTextCheckChoices`).
 */
export function descriptionEditorResult(
  model: Pick<DescriptionEditorModel, "initial" | "canSet" | "canDefault" | "canNone" | "mainTextOwn">,
  state: DescriptionEditorState,
): DescriptionEditorResult {
  const picks: Record<string, AnyChoice> = {};
  const problems: Partial<Record<DescriptionEditField, string>> = {};
  for (const field of ["textAbove", "textBelow"] as const) {
    const part = state[field];
    if (samePart(part, model.initial[field]) || part.mode === "leave") continue;
    if (part.mode === "default" && model.canDefault) picks[field] = DEFAULT;
    else if (part.mode === "none" && model.canNone) picks[field] = { mode: "set", value: { mode: "none" } };
    else if (part.mode === "own" && model.canSet) {
      const problem = templateTextProblem(part.text);
      if (problem !== null) problems[field] = problem;
      else picks[field] = { mode: "set", value: { mode: "own", text: part.text } };
    }
  }
  const main = state.mainText;
  if (!samePart(main, model.initial.mainText) && main.mode !== "leave") {
    if (main.mode === "default" && model.canDefault) picks.mainText = DEFAULT;
    else if (main.mode === "own" && model.canSet && model.mainTextOwn !== false) {
      const problem = mainTextProblem(main.text);
      if (problem !== null) problems.mainText = problem;
      else picks.mainText = { mode: "set", value: { text: main.text } };
    }
  }
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  return { ok: true, picks: picks as Pick<ProductSettingsPicks, DescriptionEditField> };
}

/**
 * The check's notice in the open description editor (5.4): shown only while
 * the main text part is as it opened. Once the vendor edits the main text or
 * picks Card Shellz's, that is the answer ([Done] saves it), so the notice
 * steps back and [Keep my text] can never drop what was typed in the box.
 */
export function descriptionEditorCheck(
  model: Pick<DescriptionEditorModel, "initial" | "check">,
  state: DescriptionEditorState,
): OwnTextCheck | null {
  return samePart(state.mainText, model.initial.mainText) ? model.check : null;
}

/**
 * [Keep my text] or [Use Card Shellz text] pressed in the open description
 * editor (5.4): the main text takes the check's answer, and the other two
 * parts go in as [Done] would put them (checked first), so nothing the vendor
 * typed above or below is lost. The notice shows only while the main text
 * box is as it opened (`descriptionEditorCheck`), so no typed main text is lost.
 */
export function descriptionEditorAnswer(
  model: Pick<DescriptionEditorModel, "initial" | "canSet" | "canDefault" | "canNone">,
  state: DescriptionEditorState,
  answer: FieldChoice<MainTextChoiceValue>,
): DescriptionEditorResult {
  const rest = descriptionEditorResult(model, { ...state, mainText: model.initial.mainText });
  if (!rest.ok) return rest;
  return { ok: true, picks: { ...rest.picks, mainText: answer } };
}

// ---------------------------------------------------------------------------
// "Sizes differ" (plan 5.3; UX-M5, CC-C17)
// ---------------------------------------------------------------------------

type ProductDetailSettings = ListingSettingsProductDetail["settings"];

/** One setting of the product's settings in full, with its values (more than one: the sizes differ). */
export type SizesDifferSetting = { [K in ListingSettingsSettingKey]: { key: K; values: ProductDetailSettings[K] } }[ListingSettingsSettingKey];
type SettingEntry = ProductDetailSettings[ListingSettingsSettingKey][number];

/** The fields a "Sizes differ" button sets for the whole product. */
export type SizesDifferField = PolicyEditField | "ebayCategory";

export type SizesDifferPick =
  /** Nothing to offer for this value. */
  | { kind: "none" }
  /** The store shelf and the description: only the line, the row's [Change] picks one for all sizes. */
  | { kind: "line"; line: string }
  /**
   * One button: "Use default for all sizes" (`default`) or "Use for all sizes"
   * (`set` this value). `picks` goes to `productSettingsEditAction({ picks })`;
   * nothing is sent until Save.
   */
  | {
    kind: "button";
    action: "use_default" | "use_this";
    label: string;
    field: SizesDifferField;
    picks: ProductSettingsPicks;
  };

const NO_PICK: SizesDifferPick = Object.freeze({ kind: "none" });
/** Sources a "Use default" gives back to every size: the category's value and the store default (W5 null). */
const DEFAULT_SOURCES: ReadonlySet<string> = new Set(["category", "store_default"]);

function differButton(
  field: SizesDifferField,
  setting: SizesDifferSetting,
  entry: SettingEntry,
  rights: Pick<ProductFieldRights, "canSet" | "canDefault">,
  value: PolicyChoiceValue | EbayCategoryChoiceValue,
  /** Whether the row's editor would take this value now; false hides "Use for all sizes". */
  settable: boolean,
): SizesDifferPick {
  // An older group rule sits after the product but before the defaults, so "Use default" can't take its sizes back (M5).
  const groupRule = setting.values.some((other) => other.sources.some((source) => source.source === "group_rule"));
  const defaultable = !groupRule && entry.sources.every((source) => DEFAULT_SOURCES.has(source.source));
  if (defaultable) {
    return rights.canDefault
      ? { kind: "button", action: "use_default", label: LISTING_SETTINGS_EDIT_WORDS.useDefaultForAllSizes, field, picks: { [field]: DEFAULT } }
      : NO_PICK;
  }
  return rights.canSet && settable
    ? { kind: "button", action: "use_this", label: LISTING_SETTINGS_EDIT_WORDS.useForAllSizes, field, picks: { [field]: { mode: "set", value } } }
    : NO_PICK;
}

/**
 * The quick pick beside one value of a setting whose sizes differ (plan 5.3),
 * from the product's settings in full (`SR:205-246`):
 * - a policy or eBay category value with nothing set: none;
 * - a value every size gets from its category or the store default, while no
 *   value of the setting comes from an older group rule: "Use default for all
 *   sizes" (W5 null; for a policy it also clears the sizes' leftovers);
 * - any other value: "Use for all sizes" (`set` its id); for a policy only
 *   when the row's own editor would take it (`fieldChoiceReady` on the live
 *   setup read: still on eBay, and a shipping policy that works with Card
 *   Shellz shipping), so the button never offers what the Save would refuse;
 * - the store shelf and the description: the line only, while the row can be
 *   changed, since the line points at its [Change].
 * A `set` button shows only when `canSet`, a `default` one only when
 * `canDefault` (D4: a sign-in hides "Use for all sizes"). A setting whose
 * sizes agree offers nothing.
 */
export function sizesDifferPick(
  setting: SizesDifferSetting,
  entry: SettingEntry,
  rights: Pick<ProductFieldRights, "canSet" | "canDefault">,
  /** The live eBay setup read (the drawer's `setup`), for the policies' "Use for all sizes". */
  setup: ListingSettingsReadState<PolicySetupFacts>,
): SizesDifferPick {
  if (setting.values.length <= 1) return NO_PICK;
  switch (setting.key) {
    case "storeShelf":
    case "descriptionTemplate":
    case "mainText":
      return rights.canSet || rights.canDefault ? { kind: "line", line: LISTING_SETTINGS_EDIT_WORDS.sizesDifferChange } : NO_PICK;
    case "ebayCategory": {
      const value = entry.value as ProductDetailSettings["ebayCategory"][number]["value"];
      if (value.categoryId === null) return NO_PICK;
      const choice: EbayCategoryChoiceValue = value.categoryName === null
        ? { categoryId: value.categoryId }
        : { categoryId: value.categoryId, categoryName: value.categoryName };
      // The picker reads eBay itself, and W5 checks the number (3.3 row 19): nothing to check against here.
      return differButton("ebayCategory", setting, entry, rights, choice, true);
    }
    case "shippingPolicy":
    case "returnPolicy":
    case "paymentPolicy": {
      const value = entry.value as ProductDetailSettings["shippingPolicy"][number]["value"];
      if (value.policyId === null) return NO_PICK;
      const policy: PolicyChoiceValue = { id: value.policyId };
      const editor = { choices: livePolicyChoices(setting.key, rights.canSet, setup), canSet: rights.canSet, canDefault: rights.canDefault };
      return differButton(setting.key, setting, entry, rights, policy, fieldChoiceReady(editor, { mode: "set", value: policy }));
    }
  }
}

// ---------------------------------------------------------------------------
// The product's price (W7 `product_prices`; PR 10d, plan 7.2, 7.6, D1, D2, D6a)
// ---------------------------------------------------------------------------

/**
 * Why a check replaced an earlier one (plan 7.5): the apply found the prices
 * moved (R:683 words), the check already applied under another key, or no
 * such check any more (`expired`); or a page read found no such check before
 * any apply was tried (`page_expired`, the owner's own re-check). Null for a
 * first check. A check made after an apply's refusal is the last: a second
 * refusal is shown, never looped (CC-C11); one made after a page read's 404
 * still counts as a first check, since no apply has been tried for it.
 */
export type PriceCheckAfter = "prices_moved" | "already_applied" | "expired" | "page_expired";

/**
 * The check the draft holds (plan 7.2, D5): the review the server stored and
 * the hash it was shown with. The apply's signature is exactly these two, so
 * a Check again resends the same apply with the same key (D21).
 */
export interface PriceCheckRef {
  readonly reviewId: string;
  readonly reviewHash: string;
  readonly after: PriceCheckAfter | null;
}

/**
 * The product's price as the drawer, or "Set for selected", changes it (plan
 * 7.2): the recipe (`set`), "Use default" (`default`: the category's price,
 * else the store price; W7 `price: null`) or leave it, with "Clear exact
 * prices too" (W7 `releaseExactPrices`), and the check made for it. It is
 * one field of the draft, so the bar counts the price as one change however
 * many of its parts moved, and the check never counts as a change.
 */
export interface ProductPriceChange {
  readonly price: FieldChoice<PricingRecipe>;
  readonly releaseExactPrices: boolean;
  readonly check: PriceCheckRef | null;
}

/**
 * The product's draft value while it holds its price: the change, and the
 * price and revision read when it started (D6a). A type, not an interface, so
 * it is a `DraftValue` the provider takes as it is.
 */
export type ProductPriceDraftValue = {
  readonly priceChange: ProductPriceChange;
  /** The product's own price as the own read gave it (`own.price`); null when it follows the default. */
  readonly ownPrice: PricingRecipe | null;
  /** The own read's `revisionId`, from the same answer as `ownPrice`. */
  readonly revisionId: number | null;
};

const NO_PRICE_CHANGE: ProductPriceChange = Object.freeze({ price: LEAVE, releaseExactPrices: false, check: null });

/** Nothing changed: the price left as it is, no release, no check. */
export function emptyProductPriceChange(): ProductPriceChange {
  return NO_PRICE_CHANGE;
}

const REVIEW_HASH = /^[a-f0-9]{64}$/;

/** Whether `value` is a check reference the draft can hold. */
export function isPriceCheckRef(value: unknown): value is PriceCheckRef {
  if (typeof value !== "object" || value === null) return false;
  const { reviewId, reviewHash, after } = value as Record<string, unknown>;
  return typeof reviewId === "string" && priceChangeReviewIdSchema.safeParse(reviewId).success
    && typeof reviewHash === "string" && REVIEW_HASH.test(reviewHash)
    && (after === null || after === "prices_moved" || after === "already_applied" || after === "expired" || after === "page_expired");
}

function isRecipeChoice(value: unknown): value is FieldChoice<PricingRecipe> {
  if (typeof value !== "object" || value === null) return false;
  const choice = value as { mode?: unknown; value?: unknown };
  if (choice.mode === "leave" || choice.mode === "default") return true;
  return choice.mode === "set" && pricingRecipeSchema.safeParse(choice.value).success;
}

/** Whether `value` is a price change of the shape above (a leave, the default or a recipe the contract takes). */
export function isProductPriceChange(value: unknown): value is ProductPriceChange {
  if (typeof value !== "object" || value === null) return false;
  const { price, releaseExactPrices, check } = value as Record<string, unknown>;
  return isRecipeChoice(price) && typeof releaseExactPrices === "boolean" && (check === null || isPriceCheckRef(check));
}

/** Whether the change asks for anything: a price other than what is saved, or a release. */
export function isProductPriceChanged(change: Pick<ProductPriceChange, "price" | "releaseExactPrices">): boolean {
  return change.price.mode !== "leave" || change.releaseExactPrices;
}

/**
 * The price choice as the draft keeps it: a choice that asks for what the
 * product already has (the same recipe, or "Use default" while it has none)
 * is "leave", so it counts as no change; a recipe is copied through the
 * contract, so the draft never shares an object with an editor.
 */
function priceChoiceFor(choice: FieldChoice<PricingRecipe>, ownPrice: PricingRecipe | null): FieldChoice<PricingRecipe> {
  if (choice.mode === "leave") return LEAVE;
  if (choice.mode === "default") return ownPrice === null ? LEAVE : DEFAULT;
  if (ownPrice !== null && sameDraftValue(choice.value, ownPrice)) return LEAVE;
  return { mode: "set", value: pricingRecipeSchema.parse(choice.value) };
}

/** The price draft value on the own read's answer; with no change, it is the draft's base (every part at rest). */
export function productPriceDraftValue(
  own: Pick<ProductOwnSettings, "own" | "revisionId">,
  change: ProductPriceChange = NO_PRICE_CHANGE,
): ProductPriceDraftValue {
  return productPriceDraftValueOn(productPriceBaseOf(own), change);
}

/** The same on a base a draft already holds (the price and revision it started from). */
export function productPriceDraftValueOn(base: ProductPriceBase, change: ProductPriceChange = NO_PRICE_CHANGE): ProductPriceDraftValue {
  const price = priceChoiceFor(change.price, base.ownPrice);
  const releaseExactPrices = change.releaseExactPrices === true;
  // A check belongs to a change; with nothing to check there is none.
  const check = price.mode === "leave" && !releaseExactPrices ? null : change.check === null ? null : { ...change.check };
  return {
    priceChange: price === LEAVE && !releaseExactPrices && check === null ? NO_PRICE_CHANGE : { price, releaseExactPrices, check },
    ownPrice: base.ownPrice,
    revisionId: base.revisionId,
  };
}

/** The price draft value, or null when `value` is not one (a size's price, the settings, another editor's draft). */
export function readProductPriceDraft(value: DraftValue): ProductPriceDraftValue | null {
  const { priceChange, ownPrice, revisionId } = value;
  if (!isProductPriceChange(priceChange) || !isRevision(revisionId)) return null;
  if (ownPrice !== null && !pricingRecipeSchema.safeParse(ownPrice).success) return null;
  return value as unknown as ProductPriceDraftValue;
}

/** This product's price draft and its value, when the step's one draft is it; null otherwise. */
export function ownProductPriceDraft(draft: ListingSettingsDraft | null, editor: EditorId): { draft: ListingSettingsDraft; value: ProductPriceDraftValue } | null {
  if (draft === null || draft.editor !== editor) return null;
  const value = readProductPriceDraft(draft.value);
  return value === null ? null : { draft, value };
}

/** What putting the price editor's choice in the draft does ([Check new prices]; nothing is sent until the check and its Save). */
export type ProductPriceEditAction =
  /** The product's price draft holds a change: the choice replaces it (`reopen` when the drawer was hidden by Back). */
  | { kind: "edit"; reopen: boolean; value: ProductPriceDraftValue }
  /** A new price draft on the own read: opened on `base` (asking first if another editor holds changes), then `value`. */
  | { kind: "start"; base: ProductPriceDraftValue; value: ProductPriceDraftValue }
  /** A size's price or the settings hold a change: "Save or discard your other change first." (D2). */
  | { kind: "finish_first" }
  /** A save is in flight or unconfirmed: nothing changes until it ends (R:539, R:541). */
  | { kind: "locked" }
  /**
   * The choice is what the product has and nothing is released: nothing to
   * check, so the editor closes. `value` is the clean draft value when the
   * draft held a price change the choice undoes (send it to `drafts.edit`:
   * the bar then reads "All saved"); null when no draft opens.
   */
  | { kind: "no_change"; value: ProductPriceDraftValue | null };

/**
 * [Check new prices] in the price editor: the editor's choice goes in the
 * draft as the product's price change, with no check yet (the check runner
 * adds it). A price draft with changes keeps its start (the price and
 * revision the vendor saw, D6a); any other edit starts from the own read as
 * it is now.
 */
export function productPriceEditAction(input: {
  draft: ListingSettingsDraft | null;
  editor: EditorId;
  own: Pick<ProductOwnSettings, "own" | "revisionId">;
  change: Pick<ProductPriceChange, "price" | "releaseExactPrices">;
}): ProductPriceEditAction {
  const { draft, editor } = input;
  const ownDraft = draft !== null && draft.editor === editor ? draft : null;
  if (ownDraft !== null && isDraftLocked(ownDraft)) return { kind: "locked" };
  const kind = drawerChangeKind(draft, editor);
  const change: ProductPriceChange = { price: input.change.price, releaseExactPrices: input.change.releaseExactPrices, check: null };
  if (kind === "product_price" && ownDraft !== null) {
    const current = readProductPriceDraft(ownDraft.value)!;
    const value = productPriceDraftValueOn(current, change);
    // The choice brings the price back to what the product has: the draft takes it (clean), and there is nothing to check.
    if (!isProductPriceChanged(value.priceChange)) return { kind: "no_change", value };
    return { kind: "edit", reopen: !ownDraft.open, value };
  }
  const value = productPriceDraftValue(input.own, change);
  if (!isProductPriceChanged(value.priceChange)) return { kind: "no_change", value: null };
  if (decideDrawerEdit(kind, "product_price") === "finish_first") return { kind: "finish_first" };
  return { kind: "start", base: productPriceDraftValue(input.own), value };
}

/** The check the runner made, put in the price draft (the change stays; `null` drops a check, e.g. "Back to editing"). */
export function productPriceDraftWithCheck(value: ProductPriceDraftValue, check: PriceCheckRef | null): ProductPriceDraftValue {
  return { ...value, priceChange: { ...value.priceChange, check: check === null ? null : { ...check } } };
}

/** The price and revision a price draft started from, and the same of an own read: what D6a compares. */
export interface ProductPriceBase {
  readonly ownPrice: PricingRecipe | null;
  readonly revisionId: number | null;
}

export function productPriceBaseOf(own: Pick<ProductOwnSettings, "own" | "revisionId">): ProductPriceBase {
  return { ownPrice: own.own.price, revisionId: own.revisionId };
}

/**
 * Whether the product's price or its settings revision moved away from what
 * the draft started from (D6a): another window saved, so the check would
 * price over something the vendor never saw. Then nothing is sent and the
 * draft shows the conflict.
 */
export function productPriceBaseMoved(base: ProductPriceBase, latest: ProductPriceBase): boolean {
  return base.revisionId !== latest.revisionId || !sameDraftValue(base.ownPrice, latest.ownPrice);
}

/** "Load latest": the vendor's price change on what is saved now, and whether it is still a change. */
export interface ProductPriceReload {
  /** The vendor's change on the price and revision read now, its check dropped: send it to the draft first. */
  edited: ProductPriceDraftValue;
  /** What is saved now, the draft's new base: rebase on it with `marked`. */
  latest: ProductPriceDraftValue;
  /** `["priceChange"]` when the vendor changed the price and another window moved it too (R:542). */
  marked: readonly string[];
  /** False when nothing of the vendor's is left to keep (the other window saved the same price): discard instead. */
  keeps: boolean;
}

/** After a conflict (D6a): the vendor's change on the own read as it is now. The check is dropped: it was of the old price. */
export function rebaseProductPriceDraft(mine: ProductPriceDraftValue, latest: Pick<ProductOwnSettings, "own" | "revisionId">): ProductPriceReload {
  const edited = productPriceDraftValue(latest, { ...mine.priceChange, check: null });
  const priceMoved = !sameDraftValue(mine.ownPrice, latest.own.price);
  return {
    edited,
    latest: productPriceDraftValue(latest),
    marked: priceMoved && mine.priceChange.price.mode !== "leave" && edited.priceChange.price.mode !== "leave" ? ["priceChange"] : [],
    keeps: isProductPriceChanged(edited.priceChange),
  };
}

/** The rights the price editor reads: W7's (plan D3). A price names no eBay value, so nothing else is asked. */
export type ProductPriceRights = Pick<ListingSettingsEditRights, "priceCheck">;

/** W7's right as the editor's: a recipe, "Use default" and the release all need it, and nothing else. */
export function productPriceRights(rights: ProductPriceRights): ProductFieldRights {
  const right = rights.priceCheck;
  return right.editable
    ? { canSet: true, canDefault: true, canNone: false, reason: null }
    : { canSet: false, canDefault: false, canNone: false, reason: right.reason };
}
