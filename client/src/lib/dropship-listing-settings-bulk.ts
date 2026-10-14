import { MAX_LISTING_SETTING_BULK_PRODUCTS } from "@shared/dropship/listing-setting-values";
import {
  MAX_BULK_TEXT_BYTES,
  patchTextBytes,
  saveProductsBulkInputSchema,
  type ProductsBulkPatchInput,
} from "@shared/dropship/listing-setting-writes";
import type { ListingSettingsProductIdsResponse } from "@shared/dropship/listing-settings";
import type { ListingSettingsEditRights, ListingSettingsReadState, ListingSettingsRight } from "./dropship-listing-settings-access";
import {
  BULK_EDITOR_ID,
  decideOpen,
  isDraftDirty,
  isDraftLocked,
  type DraftValue,
  type ListingSettingsDraft,
  type WriteFailure,
} from "./dropship-listing-settings-drafts";
import {
  DRAWER_ROW_TARGETS,
  DRAWER_SETTING_ROWS,
  DRAWER_WORDS,
  descriptionPending,
  drawerEditFields,
  drawerFooter,
  fieldPendingWords,
  type DrawerEditTarget,
  type DrawerFieldTarget,
  type DrawerFooter,
  type DrawerRowEdit,
  type DrawerSettingRowModel,
} from "./dropship-listing-settings-drawer";
import {
  DESCRIPTION_EDIT_FIELDS,
  descriptionEditorResult,
  ebayCategoryChoiceReady,
  fieldChoiceReady,
  isProductEditField,
  isProductFieldChoice,
  normalizedVendorText,
  patchSignatureEntries,
  policyFieldEditor,
  PRODUCT_EDIT_FIELDS,
  productFieldRights,
  productSettingsPatch,
  storeShelfEditorChoice,
  storeShelfFieldEditor,
  type DescriptionEditField,
  type DescriptionEditorModel,
  type DescriptionEditorState,
  type EbayCategoryChoiceValue,
  type EbayCategoryFieldEditorModel,
  type FieldChoice,
  type PolicyChoiceValue,
  type PolicyEditField,
  type PolicyFieldEditorModel,
  type ProductEditField,
  type ProductFieldChoice,
  type ProductFieldRights,
  type ProductOwnSettings,
  type StoreShelfChoiceValue,
  type StoreShelfEditorState,
  type StoreShelfFieldEditorModel,
  type TemplateTextChoiceValue,
} from "./dropship-listing-settings-product-edit";
import {
  pageTickState,
  pickSelected,
  reduceListingSettingsSelection,
  sameSelection,
  selectionCount,
  type ListingSettingsSelection,
  type ListingSettingsSelectionAction,
  type PickedProduct,
  type PickedProducts,
  type ShownProducts,
} from "./dropship-listing-settings-selection";
import type { PolicySetupFacts } from "./dropship-listing-settings-store-requests";
import {
  bulkSheetTitleWords,
  checkingProductsWords,
  heldSaveWords,
  leftOutWords,
  LISTING_SETTINGS_BULK_WORDS,
  LISTING_SETTINGS_EDIT_WORDS,
  matchMovedWords,
  pageAllSelectedWords,
  rightReasonLine,
  saveForWords,
  savedForProductsWords,
  savedForSelectedWords,
  selectAllWords,
  selectedCountWords,
  selectionAnnouncementWords,
} from "./dropship-listing-settings-words";
import { DropshipApiError, type DropshipEbayStoreCategoryOption } from "./dropship-ops-surface";

/**
 * "Set for selected" (Listing settings PR 10, plan 6.2-6.5): one change for
 * many products, every setting but price, saved in one transaction (W6,
 * `POST …/listing-settings/products/bulk`). The choices each row can take,
 * the draft that holds them with the products and revisions they go to, the
 * patch and request, the text budget, who may change which row, the rows'
 * and editors' models, and the sheet's state.
 *
 * Rules this module keeps:
 * - Never a price (D1): the patch has no `price` key at all; a price for many
 *   products goes through the price check (10d).
 * - The main text only as a reset (`SW` productsBulkPatchInputSchema): one
 *   patch can't carry each product's catalog hash, so "Use Card Shellz text"
 *   or leave it.
 * - Ids and text only, as W5's patch (`productSettingsPatch`); "Leave as is"
 *   is absent, "Use default" null, "Set" the value. A row is a change exactly
 *   when it isn't "Leave as is": there is no one saved value to compare with.
 * - The products and their revisions come from the ids read when the sheet
 *   opened (D6), and sit in the draft, so a Check again resends exactly them.
 * - The text budget is the server's own pre-check (`MAX_BULK_TEXT_BYTES`,
 *   `patchTextBytes`, `S/application/dropship-listing-products-bulk-service.ts`):
 *   products x the patch's UTF-8 bytes, so Save is off before a send the
 *   server would refuse.
 *
 * Pure: no React, no network, no clock. Never mutates its inputs.
 */

// ---------------------------------------------------------------------------
// The choices
// ---------------------------------------------------------------------------

/** The rows' fields: the drawer's eight (never the price), in the drawer's order. */
export const BULK_EDIT_FIELDS = PRODUCT_EDIT_FIELDS;
export type BulkEditField = ProductEditField;

/** The main text for many products: leave it, or "Use Card Shellz text" (null); never own text. */
export type BulkMainTextChoice = { readonly mode: "leave" } | { readonly mode: "default" };
/** A row's choice: the drawer's field choices (10a, 10b), the main text a reset only. */
export type BulkFieldChoice<F extends BulkEditField> = F extends "mainText" ? BulkMainTextChoice : ProductFieldChoice<F>;
export type BulkChoices = { readonly [F in BulkEditField]: BulkFieldChoice<F> };
/** Some rows' choices at once: what one editor's [Done] puts in the draft. */
export type BulkPicks = { readonly [F in BulkEditField]?: BulkFieldChoice<F> };

const LEAVE: { readonly mode: "leave" } = Object.freeze({ mode: "leave" });
const DEFAULT: { readonly mode: "default" } = Object.freeze({ mode: "default" });

/** Every row "Leave as is". */
export function emptyBulkChoices(): BulkChoices {
  return Object.freeze({
    shippingPolicy: LEAVE, returnPolicy: LEAVE, paymentPolicy: LEAVE, ebayCategory: LEAVE, storeShelf: LEAVE,
    textAbove: LEAVE, textBelow: LEAVE, mainText: LEAVE,
  });
}

/** The rows a change touches, in the drawer's order. */
export function bulkChangedFields(choices: BulkChoices): BulkEditField[] {
  return BULK_EDIT_FIELDS.filter((field) => choices[field].mode !== "leave");
}

/** Whether `value` is a choice this row can take: the drawer's for its field, and for the main text only leave or the default. */
export function isBulkChoice(field: BulkEditField, value: unknown): boolean {
  if (field === "mainText") {
    if (typeof value !== "object" || value === null) return false;
    const mode = (value as { mode?: unknown }).mode;
    return Object.keys(value).length === 1 && (mode === "leave" || mode === "default");
  }
  return isProductFieldChoice(field, value);
}

/** A choice as the draft keeps it: its own copy, so the draft never shares an object with an editor. */
function copyChoice<T>(choice: T): T {
  return JSON.parse(JSON.stringify(choice)) as T;
}

// ---------------------------------------------------------------------------
// The draft value
// ---------------------------------------------------------------------------

/**
 * The sheet's draft value: one field per row (so the bar counts each changed
 * row as one change), and the products and revisions the save names, the same
 * array in the draft's base and value (from `pickSelected`, D6). The base has
 * every row "Leave as is".
 */
export type BulkDraftValue = BulkChoices & { readonly products: readonly PickedProduct[] };

/** The draft value on the ids read's products (ascending); with no choices it is the draft's base. */
export function bulkDraftValue(products: readonly PickedProduct[], choices: BulkChoices = emptyBulkChoices()): BulkDraftValue {
  const value: Record<string, unknown> = {};
  for (const field of BULK_EDIT_FIELDS) value[field] = choices[field].mode === "leave" ? LEAVE : copyChoice(choices[field]);
  const copied = Object.freeze([...products]
    .map((product) => Object.freeze({ productId: product.productId, expectedRevisionId: product.expectedRevisionId }))
    .sort((left, right) => left.productId - right.productId));
  return { ...value, products: copied } as unknown as BulkDraftValue;
}

function isRevision(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function isPickedProducts(value: unknown): value is readonly PickedProduct[] {
  if (!Array.isArray(value) || value.length > MAX_LISTING_SETTING_BULK_PRODUCTS) return false;
  const seen = new Set<number>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return false;
    const { productId, expectedRevisionId } = entry as Record<string, unknown>;
    if (typeof productId !== "number" || !Number.isSafeInteger(productId) || productId <= 0 || seen.has(productId)) return false;
    if (!isRevision(expectedRevisionId)) return false;
    seen.add(productId);
  }
  return true;
}

/** The sheet's draft value, or null when `value` is not one (a product's draft, a Store defaults row's). */
export function readBulkDraft(value: DraftValue): BulkDraftValue | null {
  if (!isPickedProducts(value.products)) return null;
  if (!BULK_EDIT_FIELDS.every((field) => isBulkChoice(field, value[field]))) return null;
  return value as unknown as BulkDraftValue;
}

/** The sheet's draft and its value, when the step's one draft is the sheet's. */
function ownBulkDraft(draft: ListingSettingsDraft | null): { draft: ListingSettingsDraft; value: BulkDraftValue } | null {
  if (draft === null || draft.editor !== BULK_EDITOR_ID) return null;
  const value = readBulkDraft(draft.value);
  return value === null ? null : { draft, value };
}

/** What putting a row editor's choice in the sheet's draft does ([Done]; nothing is sent until Save). */
export type BulkEditAction =
  /** The draft takes the choices: send `value` to `drafts.edit`. */
  | { kind: "edit"; value: BulkDraftValue }
  /** A save is in flight or unconfirmed: nothing changes until it ends (R:539, R:541). */
  | { kind: "locked" }
  /** The sheet's draft isn't open yet (its ids read hasn't answered). */
  | { kind: "not_open" };

/**
 * [Done] in a row's editor: its choices go in the sheet's draft, on the same
 * products and revisions. A row's choice of another shape, or a field the
 * sheet doesn't set, is a programming fault (thrown).
 */
export function bulkEditAction(input: { draft: ListingSettingsDraft | null; picks: BulkPicks }): BulkEditAction {
  const picks = Object.entries(input.picks).filter(([, choice]) => choice !== undefined);
  for (const [field, choice] of picks) {
    if (!isProductEditField(field) || !isBulkChoice(field, choice)) {
      throw new Error(`A "Set for selected" edit names a field or a choice the sheet doesn't set: ${field}.`);
    }
  }
  const own = ownBulkDraft(input.draft);
  if (own === null) return { kind: "not_open" };
  if (isDraftLocked(own.draft)) return { kind: "locked" };
  const value: Record<string, unknown> = { ...own.value };
  for (const [field, choice] of picks) value[field] = (choice as { mode: string }).mode === "leave" ? LEAVE : copyChoice(choice);
  return { kind: "edit", value: value as unknown as BulkDraftValue };
}

// ---------------------------------------------------------------------------
// The W6 request
// ---------------------------------------------------------------------------

/** "Leave as is" → absent, "Use default" → null, "Set" → ids and text only (W5's patch, `productSettingsPatch`). Never a price key. */
export function bulkPatch(choices: BulkChoices): ProductsBulkPatchInput {
  return productSettingsPatch(choices);
}

/** Own text as the shared schema stores it (CRLF→LF, trimmed): what the server counts. */
function storedTextPatch(patch: ProductsBulkPatchInput): ProductsBulkPatchInput {
  const stored: Record<string, unknown> = { ...patch };
  for (const field of ["textAbove", "textBelow"] as const) {
    const part = patch[field];
    if (part != null && part.mode === "own") stored[field] = { mode: "own", text: normalizedVendorText(part.text) };
  }
  return stored as ProductsBulkPatchInput;
}

/** The text a save of `patch` for `count` products carries, in UTF-8 bytes: the server's pre-check (`patchTextBytes`, once per product). */
export function bulkTextBytes(count: number, patch: ProductsBulkPatchInput): number {
  return count * patchTextBytes(storedTextPatch(patch));
}

/**
 * Whether the server would refuse the save for its text before reading
 * anything (422 BULK_TOO_LARGE, plan 6.5): products x the patch's text over
 * `MAX_BULK_TEXT_BYTES`. The server also counts the products' stored text
 * (K10), so a save under it can still be refused; that answer is worded too.
 */
export function bulkTextTooLarge(count: number, patch: ProductsBulkPatchInput): boolean {
  return bulkTextBytes(count, patch) > MAX_BULK_TEXT_BYTES;
}

/** The W6 body this page sends: the request key, the products with their revisions, the patch. */
export interface BulkSaveBody {
  idempotencyKey: string;
  products: PickedProduct[];
  patch: ProductsBulkPatchInput;
}

export const BULK_REQUEST_INVALID = "DROPSHIP_LISTING_SETTINGS_BULK_REQUEST_INVALID";

/** A W6 body this page would build outside the contract: never sent. */
export class BulkRequestError extends Error {
  readonly code = BULK_REQUEST_INVALID;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(message: string, context: Record<string, unknown>) {
    super(message);
    this.name = "BulkRequestError";
    this.context = Object.freeze({ ...context });
  }
}

const BULK_FIELD_SET: ReadonlySet<string> = new Set(BULK_EDIT_FIELDS);

function sortedProducts(products: readonly PickedProduct[]): PickedProduct[] {
  return [...products]
    .map((product) => ({ productId: product.productId, expectedRevisionId: product.expectedRevisionId }))
    .sort((left, right) => left.productId - right.productId);
}

/**
 * The W6 body, checked by the shared input schema before it is sent. Throws a
 * BulkRequestError for a field this page doesn't set (a price above all,
 * D1), a main text that isn't a reset, an empty patch, no products or more
 * than 10,000, a product twice, text the server's budget refuses, or
 * anything else the schema refuses. What is sent is the schema's output (own
 * text with its line breaks as "\n" and trimmed), products ascending.
 */
export function bulkSaveBody(input: { key: string; products: readonly PickedProduct[]; patch: ProductsBulkPatchInput }): BulkSaveBody {
  const sent = Object.keys(input.patch).filter((field) => input.patch[field as keyof ProductsBulkPatchInput] !== undefined);
  const outside = sent.filter((field) => !BULK_FIELD_SET.has(field));
  if (outside.length > 0) throw new BulkRequestError("This change names a setting Set for selected doesn't save.", { fields: outside });
  if (sent.length === 0) throw new BulkRequestError("There is no change to save.", { fields: [] });
  if (input.patch.mainText != null) throw new BulkRequestError("The main text can only be reset for many products.", { fields: ["mainText"] });
  const parsed = saveProductsBulkInputSchema.safeParse({ idempotencyKey: input.key, products: sortedProducts(input.products), patch: input.patch });
  if (!parsed.success) {
    throw new BulkRequestError("This change can't be sent as it is.", {
      issues: parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join("."), code: issue.code })),
    });
  }
  const textBytes = bulkTextBytes(parsed.data.products.length, parsed.data.patch);
  if (textBytes > MAX_BULK_TEXT_BYTES) {
    throw new BulkRequestError("This change carries too much text for this many products.", {
      reason: "text_budget", textBytes, maxTextBytes: MAX_BULK_TEXT_BYTES, productCount: parsed.data.products.length,
    });
  }
  return { idempotencyKey: parsed.data.idempotencyKey, products: parsed.data.products, patch: parsed.data.patch };
}

/**
 * Everything a W6 request sends except its key: the same request always
 * reuses its key (a retry is answered by the first save), and any edit, or
 * new revisions after "Load latest", get a new one. The products' order
 * doesn't count (the server sorts them too); their revisions do.
 */
export function bulkSignature(storeConnectionId: number, products: readonly PickedProduct[], patch: ProductsBulkPatchInput): string {
  const named = sortedProducts(products).map((product) => [product.productId, product.expectedRevisionId]);
  return JSON.stringify(["listing-settings-products-bulk-v1", storeConnectionId, named, patchSignatureEntries(patch)]);
}

// ---------------------------------------------------------------------------
// Who may change which row (D3, D4)
// ---------------------------------------------------------------------------

/** The rights "Set for selected" reads: W6's, and the rights its rows pick eBay values with. */
export type BulkSettingsRights = Pick<ListingSettingsEditRights, "bulkSettings" | "shipping" | "policies" | "ebayCategory" | "shelfPick">;

/**
 * A row's rights: W6's right AND the field's own pick right, as the drawer's
 * (`productFieldRights`): a paused vendor or inactive .ops takes W6 away, so
 * nothing can be chosen (D3); a sign-in or eBay refusing access leaves "Use
 * default" (and "None" for the shelf and text) only, since W6 asks eBay about
 * every id it sets (D4). The main text can't be set, only reset.
 */
export function bulkFieldRights(rights: BulkSettingsRights, field: BulkEditField): ProductFieldRights {
  const base = productFieldRights({
    productSettings: rights.bulkSettings, shipping: rights.shipping, policies: rights.policies,
    ebayCategory: rights.ebayCategory, shelfPick: rights.shelfPick,
  }, field);
  return field === "mainText" ? { ...base, canSet: false } : base;
}

// ---------------------------------------------------------------------------
// The rows (plan 6.3): one per setting, reading "Leave as is" with [Change]
// ---------------------------------------------------------------------------

export interface BulkRowsInput {
  /** The step's one draft, whoever holds it. */
  draft: ListingSettingsDraft | null;
  rights: BulkSettingsRights;
  /** The row whose editor is open; one at a time. */
  openTarget: DrawerEditTarget | null;
  /** The last failed save, with the fields it named (`WriteFailure.fields`); shown by its rows only while the draft is refused. */
  failure: Pick<WriteFailure, "message" | "fields"> | null;
  /** The live eBay setup read, to name a picked policy. */
  setup: ListingSettingsReadState<PolicySetupFacts>;
  /** The step's shelves read, to name a picked shelf; null or absent while it can't be read. */
  shelves?: readonly DropshipEbayStoreCategoryOption[] | null;
}

/**
 * The sheet's rows, in the drawer's order, as the drawer's row model so
 * `DrawerSettingRow` draws them: each reads "Leave as is", its pending change
 * below it, and [Change]. [Change] waits for the draft (the ids read) and
 * while a save is out or unconfirmed. No "Sizes differ" picks, no check.
 */
export function bulkSettingRows(input: BulkRowsInput): DrawerSettingRowModel[] {
  const own = ownBulkDraft(input.draft);
  const locked = own !== null && isDraftLocked(own.draft);
  const holding = own !== null && (isDraftDirty(own.draft) || locked);
  const choices = holding ? own.value : emptyBulkChoices();
  // A refusal's words sit by the rows it named until the vendor changes something (the draft is then editing again).
  const failure = own?.draft.phase === "refused" ? input.failure : null;
  return DRAWER_SETTING_ROWS.map(({ key, label }) => {
    const target = DRAWER_ROW_TARGETS[key];
    const fields = drawerEditFields(target);
    // The description's three parts share W6's right (text names no eBay value).
    const rights = bulkFieldRights(input.rights, fields[0]);
    const shown = rights.canSet || rights.canDefault || rights.canNone;
    let line: string | null = null;
    if (!shown) line = rights.reason === null ? null : rightReasonLine(rights.reason);
    else if (!rights.canSet && rights.reason !== null) {
      line = rights.reason === "sign_in" ? LISTING_SETTINGS_EDIT_WORDS.signInFieldLine
        : rightReasonLine(rights.reason) ?? LISTING_SETTINGS_EDIT_WORDS.defaultOnlyLine;
    }
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
      const parts = { textAbove: choices.textAbove, textBelow: choices.textBelow, mainText: choices.mainText };
      edit = { ...state, kind: "description", target, fields: DESCRIPTION_EDIT_FIELDS, choices: parts, pending: descriptionPending(parts), check: null };
    } else {
      const field = target as DrawerFieldTarget;
      const choice = choices[field] as ProductFieldChoice<DrawerFieldTarget>;
      edit = {
        ...state, kind: "field", target: field, field, choice,
        pending: fieldPendingWords(field, choice, input.setup, null, input.shelves ?? null),
      } as DrawerRowEdit;
    }
    return {
      key,
      label,
      groups: [{ entries: [{ value: LISTING_SETTINGS_BULK_WORDS.leaveAsIs, tags: [], usedBy: null }], differ: null }],
      notes: [],
      edit,
    };
  });
}

// ---------------------------------------------------------------------------
// The rows' editors in "bulk" mode: the drawer's models, opening on the draft's choice or "Leave as is"
// ---------------------------------------------------------------------------

/** No product's own row: the editors list eBay's values, and open on the draft's choice. */
const NO_OWN: Pick<ProductOwnSettings, "own"> = Object.freeze({
  own: Object.freeze({
    price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null,
    textAbove: null, textBelow: null, mainText: null,
  }),
});

/**
 * A policy row's editor (`DrawerFieldEditor`): eBay's policies from the live
 * setup read while a new one can be picked, "Use default", opening on the
 * draft's choice, else with nothing picked ("Leave as is").
 */
export function bulkPolicyFieldEditor(input: {
  field: PolicyEditField;
  rights: Pick<ProductFieldRights, "canSet" | "canDefault">;
  draftChoice: FieldChoice<PolicyChoiceValue>;
  setup: ListingSettingsReadState<PolicySetupFacts>;
}): PolicyFieldEditorModel {
  // `leftover`: the editor opens with nothing picked unless the draft holds a choice, as here.
  return policyFieldEditor({ ...input, own: NO_OWN, leftover: true });
}

/** The eBay category row's editor: the category picker while one can be picked, "Use default", opening on the draft's choice. */
export function bulkEbayCategoryFieldEditor(input: {
  rights: Pick<ProductFieldRights, "canSet" | "canDefault">;
  draftChoice: FieldChoice<EbayCategoryChoiceValue>;
}): EbayCategoryFieldEditorModel {
  const initial = input.draftChoice;
  return {
    field: "ebayCategory",
    canSet: input.rights.canSet,
    canDefault: input.rights.canDefault,
    initial,
    initialQuery: initial.mode === "set" ? initial.value.categoryName?.trim() ?? "" : "",
  };
}

/** The store shelf row's editor: one or two shelves from the shelves read, None, "Use default", opening on the draft's choice. */
export function bulkStoreShelfFieldEditor(input: {
  rights: Pick<ProductFieldRights, "canSet" | "canDefault" | "canNone">;
  draftChoice: FieldChoice<StoreShelfChoiceValue>;
  shelves: readonly DropshipEbayStoreCategoryOption[] | null;
}): StoreShelfFieldEditorModel {
  return storeShelfFieldEditor({ ...input, own: NO_OWN, leftover: true });
}

/**
 * Whether [Done] can put this choice in the draft: "Leave as is" always (it
 * takes the row back to no change), else the drawer's own check (a usable
 * eBay policy the list offers, a picked category, or "Use default" when allowed).
 */
export function bulkFieldChoiceReady(
  model: Pick<PolicyFieldEditorModel, "choices" | "canSet" | "canDefault"> | Pick<EbayCategoryFieldEditorModel, "canSet" | "canDefault">,
  choice: FieldChoice<PolicyChoiceValue> | FieldChoice<EbayCategoryChoiceValue>,
): boolean {
  if (choice.mode === "leave") return true;
  if ("choices" in model) return fieldChoiceReady(model, choice as FieldChoice<PolicyChoiceValue>);
  return ebayCategoryChoiceReady(model, choice as FieldChoice<EbayCategoryChoiceValue>);
}

/** The shelf editor's [Done]: "Leave as is" takes the row back to no change; anything else as the drawer's (`storeShelfEditorChoice`). */
export function bulkStoreShelfEditorChoice(
  model: Pick<StoreShelfFieldEditorModel, "canSet" | "canDefault" | "canNone" | "options">,
  state: StoreShelfEditorState,
): { ok: true; choice: FieldChoice<StoreShelfChoiceValue> } | { ok: false; problem: string | null } {
  return state.mode === "leave" ? { ok: true, choice: LEAVE } : storeShelfEditorChoice(model, state);
}

function templateEditorState(choice: FieldChoice<TemplateTextChoiceValue>): DescriptionEditorState["textAbove"] {
  if (choice.mode !== "set") return { mode: choice.mode, text: "" };
  return choice.value.mode === "none" ? { mode: "none", text: "" } : { mode: "own", text: choice.value.text };
}

/**
 * The Description row's editor (`DrawerDescriptionEditor`): text above and
 * below with "Use default", None or own text; the main text with "Use Card
 * Shellz text" only (`mainTextOwn: false`). Each part opens on the draft's
 * choice, else with nothing picked and an empty box. No check, no tie line.
 */
export function bulkDescriptionFieldEditor(input: {
  rights: Pick<ProductFieldRights, "canSet" | "canDefault" | "canNone">;
  draftChoices: Pick<BulkChoices, DescriptionEditField>;
}): DescriptionEditorModel {
  return {
    initial: {
      textAbove: templateEditorState(input.draftChoices.textAbove),
      textBelow: templateEditorState(input.draftChoices.textBelow),
      mainText: { mode: input.draftChoices.mainText.mode, text: "" },
    },
    canSet: input.rights.canSet,
    canDefault: input.rights.canDefault,
    canNone: input.rights.canNone,
    mainTextOwn: false,
    check: null,
    conflictLine: null,
  };
}

export type BulkDescriptionEditorResult =
  | { ok: true; picks: Pick<BulkPicks, DescriptionEditField> }
  | { ok: false; problems: Partial<Record<DescriptionEditField, string>> };

/**
 * The Description editor's [Done] in "bulk" mode: each part the vendor
 * changed (own text checked as typed, the drawer's `descriptionEditorResult`),
 * and a part taken back to "Leave as is" as a leave. Own main text can't be
 * chosen for many products; a state that holds it is a programming fault.
 */
export function bulkDescriptionEditorResult(model: DescriptionEditorModel, state: DescriptionEditorState): BulkDescriptionEditorResult {
  if (state.mainText.mode === "own") throw new Error("Set for selected can only reset the main text.");
  const result = descriptionEditorResult(model, state);
  if (!result.ok) return result;
  const picks: Record<string, unknown> = { ...result.picks };
  for (const field of DESCRIPTION_EDIT_FIELDS) {
    if (state[field].mode === "leave" && model.initial[field].mode !== "leave") picks[field] = LEAVE;
  }
  return { ok: true, picks: picks as Pick<BulkPicks, DescriptionEditField> };
}

// ---------------------------------------------------------------------------
// Opening the sheet, and "Load latest and keep my changes"
// ---------------------------------------------------------------------------

/**
 * What a new ids read does to the sheet's draft after a 409 ("Load latest and
 * keep my changes", 6.5) or [Discard] on a conflict:
 * - `rebase`: the vendor's choices on the products and revisions read now:
 *   `drafts.edit(edited)`, then `drafts.rebase(latest, [])` (no marks: W6 has
 *   no one saved value per row to compare);
 * - `restart`: nothing of the vendor's is left to put on top, so the sheet
 *   starts again on the products read now: `drafts.discard()`, then
 *   `drafts.open(…, base)`;
 * - `none_left`: none of the products is chosen any more: `drafts.discard()`,
 *   and Save stays off with the none-left words.
 */
export type BulkReload =
  | { kind: "rebase"; edited: BulkDraftValue; latest: BulkDraftValue; picked: PickedProducts }
  | { kind: "restart"; base: BulkDraftValue; picked: PickedProducts }
  | { kind: "none_left"; picked: PickedProducts };

export function bulkReload(mine: BulkDraftValue, picked: PickedProducts): BulkReload {
  if (picked.total === 0) return { kind: "none_left", picked };
  if (bulkChangedFields(mine).length === 0) return { kind: "restart", base: bulkDraftValue(picked.products), picked };
  return { kind: "rebase", edited: bulkDraftValue(picked.products, mine), latest: bulkDraftValue(picked.products), picked };
}

/** Whether two product lists name the same products, whatever their revisions. */
function sameProductIds(left: readonly PickedProduct[], right: readonly PickedProduct[]): boolean {
  if (left.length !== right.length) return false;
  const ids = new Set(left.map((product) => product.productId));
  return right.every((product) => ids.has(product.productId));
}

/** What opening the sheet does to the step's one draft (D6, D16, D21). */
export type BulkSheetOpen =
  /** The ids read made for this opening hasn't answered yet: wait for it. */
  | { kind: "wait" }
  /**
   * Another editor holds a change, or is saving one (D16; the address opened the
   * sheet without [Set for selected]'s question, e.g. browser Forward): the sheet closes, nothing is read.
   */
  | { kind: "elsewhere" }
  /** `drafts.open(BULK_EDITOR_ID, LISTING_SETTINGS_BULK_WORDS.setForSelected, base)`. */
  | { kind: "open"; base: BulkDraftValue }
  /**
   * The sheet's draft stays as it is (reopen it with `drafts.open`, which
   * keeps it): a save is out or unconfirmed, so Check again resends exactly
   * that request (D21; no ids read is needed), or it holds changes for these
   * very products. Their revisions stay the ones the change was made against,
   * so a product saved elsewhere since is the server's 409, worded (6.5).
   */
  | { kind: "keep" }
  /**
   * The sheet's draft holds changes made for other products: discard it, open
   * on `base`, then `drafts.edit(value)`; the choices are kept and the sheet
   * says so. A product the change was already for keeps the revision it was
   * made against (a save elsewhere since is the 409); the others take the read's.
   */
  | { kind: "restart"; base: BulkDraftValue; value: BulkDraftValue }
  /** None of the products is chosen any more: no draft opens, Save stays off. */
  | { kind: "none_left" };

/**
 * Opening the sheet, before its ids read (`picked` null: wait, unless a held
 * save or another editor decides it) and once that read, made for this
 * opening, answered.
 */
export function bulkSheetOpen(draft: ListingSettingsDraft | null, picked: PickedProducts | null): BulkSheetOpen {
  if (decideOpen(draft, BULK_EDITOR_ID) !== "open") return { kind: "elsewhere" };
  const own = ownBulkDraft(draft);
  if (own !== null && isDraftLocked(own.draft)) return { kind: "keep" };
  if (picked === null) return { kind: "wait" };
  if (picked.total === 0) return { kind: "none_left" };
  if (own === null || !isDraftDirty(own.draft)) return { kind: "open", base: bulkDraftValue(picked.products) };
  if (sameProductIds(own.value.products, picked.products)) return { kind: "keep" };
  const held = new Map(own.value.products.map((product) => [product.productId, product.expectedRevisionId]));
  const products = picked.products.map((product) => (held.has(product.productId)
    ? { productId: product.productId, expectedRevisionId: held.get(product.productId) ?? null }
    : product));
  return { kind: "restart", base: bulkDraftValue(products), value: bulkDraftValue(products, own.value) };
}

/**
 * [Discard] in the sheet: every row back to "Leave as is" on the same
 * products (`reset`, send `value` to `drafts.edit`); after a 409 the draft's
 * revisions are known to be old, so the ids read is made again instead
 * (`reread`, then `bulkReload` with no choices); `none` without a sheet draft.
 */
export type BulkDiscard = { kind: "reset"; value: BulkDraftValue } | { kind: "reread" } | { kind: "none" };

export function bulkDiscard(draft: ListingSettingsDraft | null): BulkDiscard {
  const own = ownBulkDraft(draft);
  if (own === null || isDraftLocked(own.draft)) return { kind: "none" };
  if (own.draft.phase === "conflict") return { kind: "reread" };
  return { kind: "reset", value: bulkDraftValue(own.value.products) };
}

/** Whether the step's one draft is a "Set for selected" save that is out or unconfirmed: the sheet opens on it, ticks or none (D21). */
export function bulkHoldsSave(draft: ListingSettingsDraft | null): boolean {
  const own = ownBulkDraft(draft);
  return own !== null && isDraftLocked(own.draft);
}

// ---------------------------------------------------------------------------
// The sheet (plan 6.3, 3.7)
// ---------------------------------------------------------------------------

export interface BulkSheetInput {
  selection: ListingSettingsSelection;
  /** The sheet's ids read (`listingSettingsProductIdsQueryOptions(store, idsRequestFor(selection))`). */
  ids: ListingSettingsReadState<ListingSettingsProductIdsResponse>;
  /** The step's one draft, whoever holds it. */
  draft: ListingSettingsDraft | null;
  /** What this opening did to the draft (`bulkSheetOpen`'s kind once it decided); null before. */
  opening: BulkSheetOpen["kind"] | null;
  rights: Pick<ListingSettingsEditRights, "bulkSettings">;
  /** Another listing action is running, or a read for the footer is in flight. */
  busy: boolean;
  /** "Saved" shows now (3 seconds after a confirmed save, R:538). */
  savedFlashVisible: boolean;
  compact: boolean;
  /** A row's editor is open: its pick isn't in the draft until [Done]. */
  fieldEditorOpen: boolean;
  /** The last refused save, with the fields it named. */
  failure: Pick<WriteFailure, "fields"> | null;
}

export interface BulkSheetState {
  /** The ids read: still loading (the rows are busy), failed, or answered. */
  read: "loading" | "failed" | "answered";
  /**
   * "Set for 312 products": a save out or unconfirmed names its own products
   * (Check again resends exactly them, D21); otherwise the ids read's count
   * once it answered (D22), the selection's before.
   */
  title: string;
  /** "Checking 312 products…" while the ids read answers; null otherwise. */
  loadingLine: string | null;
  /** Why the ids read failed, with [Try again]; null otherwise. */
  readProblem: string | null;
  /**
   * What the vendor should know about the products: "312 now match (was
   * 310).", "2 products are no longer chosen and are left out.", a change
   * kept from before for other products, or a held save's own products.
   */
  lines: string[];
  /** "None of these products is chosen any more." (Save off, Check again kept); null otherwise. */
  noneLeft: string | null;
  /** Esc keeps the sheet open: a save is out or unconfirmed (3.4). */
  escapeKeepsOpen: boolean;
  footer: DrawerFooter;
}

const HTTP_TOO_MANY_REQUESTS = 429;

/** The sheet's state from its ids read, the step's draft and the rights. */
export function bulkSheetState(input: BulkSheetInput): BulkSheetState {
  const { ids } = input;
  const failed = ids.error !== undefined && ids.error !== null;
  const picked = !failed && ids.data !== undefined ? pickSelected(ids.data, input.selection) : null;
  const read: BulkSheetState["read"] = failed ? "failed" : picked === null ? "loading" : "answered";
  const own = ownBulkDraft(input.draft);
  // A save out or unconfirmed is for its own products, whatever is ticked or read now (D21); it needs no ids read.
  const held = own !== null && isDraftLocked(own.draft) ? own.value.products : null;
  const count = own?.value.products.length ?? picked?.total ?? selectionCount(input.selection);

  const lines: string[] = [];
  if (held !== null && (picked === null || !sameProductIds(held, picked.products))) {
    lines.push(heldSaveWords(held.length));
  } else {
    if (picked?.matched && picked.matched.now !== picked.matched.before) lines.push(matchMovedWords(picked.matched.now, picked.matched.before));
    if (picked !== null && picked.missing > 0) lines.push(leftOutWords(picked.missing));
    if (input.opening === "restart" && own !== null && isDraftDirty(own.draft)) lines.push(LISTING_SETTINGS_BULK_WORDS.carried);
  }
  const noneLeft = held === null && picked !== null && picked.total === 0 ? LISTING_SETTINGS_BULK_WORDS.noneChosen : null;

  const patch = own === null ? null : bulkPatch(own.value);
  const textTooLarge = own !== null && patch !== null && bulkTextTooLarge(own.value.products.length, patch);
  const namesRow = (input.failure?.fields ?? []).some((field) => BULK_FIELD_SET.has(field));
  let footer = drawerFooter({
    draft: own?.draft ?? null,
    editable: input.rights.bulkSettings.editable && count > 0,
    busy: input.busy,
    clear: null,
    savedFlashVisible: input.savedFlashVisible,
    compact: input.compact,
    showRefusal: !namesRow,
    fieldEditorOpen: input.fieldEditorOpen,
    saveLabel: saveForWords(count),
  });
  if (footer.primary.action === "save" && noneLeft !== null) {
    // The ticked products aren't chosen any more: nothing to save for them here (a save out or unconfirmed keeps Check again).
    footer = { ...footer, primary: { ...footer.primary, disabled: true } };
  } else if (footer.primary.action === "save" && textTooLarge) {
    // The server's own pre-check would refuse it (422 BULK_TOO_LARGE): Save is off and says why, nothing is sent.
    footer = { ...footer, primary: { ...footer.primary, disabled: true }, message: { text: LISTING_SETTINGS_BULK_WORDS.tooMuchText, tone: "alert" } };
  }
  return {
    read,
    title: bulkSheetTitleWords(held?.length ?? picked?.total ?? selectionCount(input.selection)),
    loadingLine: read === "loading" && held === null ? checkingProductsWords(selectionCount(input.selection)) : null,
    readProblem: failed && held === null ? bulkReadProblem(ids.error) : null,
    lines,
    noneLeft,
    escapeKeepsOpen: held !== null,
    footer,
  };
}

/** A failed ids read in the vendor's words: too many checks in a minute, else Try again. */
function bulkReadProblem(error: unknown): string {
  if (error instanceof DropshipApiError && error.status === HTTP_TOO_MANY_REQUESTS) return DRAWER_WORDS.readRateLimited;
  return LISTING_SETTINGS_BULK_WORDS.readFailed;
}

// ---------------------------------------------------------------------------
// After a confirmed save (D22): the tab's ticks and its status
// ---------------------------------------------------------------------------

/** What the sheet's draft was opened on (or loaded latest from): the selection, and what its ids read gave. */
export interface BulkOpenedOn {
  selection: ListingSettingsSelection;
  picked: PickedProducts;
}

/** A confirmed save, as the sheet tells the tab. */
export interface BulkSavedFor {
  productCount: number;
  /** The selection whose ids read gave the saved products; null when they came from another one (an unconfirmed save resent). */
  selection: ListingSettingsSelection | null;
  /** "Select all N" only: how many products that read matched; null for ticks. */
  matchedNow: number | null;
}

/** A confirmed save: the products it named, and the selection they were picked for (`bulkSavedFor`). */
export function bulkSavedFor(input: { products: readonly PickedProduct[]; openedOn: BulkOpenedOn | null }): BulkSavedFor {
  const { openedOn } = input;
  const productCount = input.products.length;
  if (openedOn === null || !sameProductIds(input.products, openedOn.picked.products)) return { productCount, selection: null, matchedNow: null };
  return { productCount, selection: openedOn.selection, matchedNow: openedOn.picked.matched?.now ?? null };
}

/** The tab's status after a save: "Still selected." only while `selection` is the tab's selection. */
export interface BulkSavedStatus {
  productCount: number;
  selection: ListingSettingsSelection | null;
}

/**
 * After a confirmed save (D22): the ticks stay; under "Select all N" the bar
 * counts what the sheet's read matched (`matched`), as the sheet did; and the
 * status the tab shows until the ticks change.
 */
export function bulkAfterSave(saved: BulkSavedFor): { action: ListingSettingsSelectionAction | null; status: BulkSavedStatus } {
  const all = saved.selection?.all ?? null;
  const action: ListingSettingsSelectionAction | null = all !== null && saved.matchedNow !== null
    ? { type: "matched", filter: all.filter, total: saved.matchedNow }
    : null;
  const selection = saved.selection === null || action === null ? saved.selection : reduceListingSettingsSelection(saved.selection, action);
  return { action, status: { productCount: saved.productCount, selection } };
}

// ---------------------------------------------------------------------------
// The Products tab's selection bar (plan 6.3, D3, D22)
// ---------------------------------------------------------------------------

export interface BulkSelectionBarInput {
  selection: ListingSettingsSelection;
  /** What the list shows now (`shownForSelection`): a wide page, or every page a phone loaded; null while none answered. */
  shown: ShownProducts | null;
  compact: boolean;
  /** W6's right (D3): [Set for selected] is off while it can't be used. */
  right: ListingSettingsRight;
  /** The last confirmed save, until the ticks change (`bulkAfterSave`); null for none. */
  saved: BulkSavedStatus | null;
  /** A "Set for selected" save is out or unconfirmed (`bulkHoldsSave`): [Set for selected] opens on it, ticks or none (D21). */
  heldSave: boolean;
}

export interface BulkSelectionBar {
  /** The bar shows: something is ticked, or a save's status is still to be said. */
  visible: boolean;
  /** "3 selected", as far as the page knows before the sheet's ids read (D22). */
  count: string;
  setForSelected: { label: string; disabled: boolean };
  /** Why [Set for selected] is off, in words; null when it isn't, or a banner says why. */
  reason: string | null;
  clear: string;
  /**
   * After every product shown is ticked and more match: "All 50 on this page
   * are selected." (phone "All 100 shown are selected.") [Select all 312];
   * null otherwise, and while "Select all N" is already on.
   */
  offer: { line: string; label: string; total: number } | null;
  /** "Saved for 312 products. Still selected." after a confirmed save (only "Saved for 312 products." once they aren't), until the ticks change. */
  status: string | null;
  /** The phone's "Select all shown" box: every product shown ticked, some, or none. */
  shownTick: "all" | "some" | "none";
  /** What the page's status region reads out (3.4): the count, the offer and the status; "" while the bar is hidden. */
  announcement: string;
}

/**
 * The bar over the Products list (plan 6.3): "3 selected · [Set for selected]
 * · [Clear]", "Select all N" once every product shown is ticked (REC:820),
 * and the status after a save; the ticks stay (D22). "Select all N" is
 * offered only for a list W6 can name at once (10,000 products at most). A
 * save out or unconfirmed keeps [Set for selected] on with nothing ticked,
 * so its Check again stays in reach (D21).
 */
export function bulkSelectionBar(input: BulkSelectionBarInput): BulkSelectionBar {
  const count = selectionCount(input.selection);
  const shown = input.shown;
  const shownTick = shown === null || shown.productIds.length === 0 ? "none" : pageTickState(input.selection, shown.productIds);
  const offer = shown !== null && input.selection.all === null && shownTick === "all"
    && shown.total > shown.productIds.length && shown.total <= MAX_LISTING_SETTING_BULK_PRODUCTS
    ? { line: pageAllSelectedWords(shown.productIds.length, input.compact), label: selectAllWords(shown.total), total: shown.total }
    : null;
  const { saved } = input;
  const status = saved === null ? null
    : saved.selection !== null && sameSelection(saved.selection, input.selection)
      ? savedForSelectedWords(saved.productCount)
      : savedForProductsWords(saved.productCount);
  const visible = count > 0 || status !== null || input.heldSave;
  const countWords = selectedCountWords(count);
  return {
    visible,
    count: countWords,
    setForSelected: { label: LISTING_SETTINGS_BULK_WORDS.setForSelected, disabled: (count === 0 && !input.heldSave) || !input.right.editable },
    reason: input.right.editable ? null : rightReasonLine(input.right.reason),
    clear: LISTING_SETTINGS_BULK_WORDS.clear,
    offer,
    status,
    shownTick,
    announcement: visible ? selectionAnnouncementWords({ count: countWords, offer, status }) : "",
  };
}
