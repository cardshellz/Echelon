import {
  productSettingsPatchInputSchema,
  saveProductSettingsInputSchema,
  type ProductSettingsPatchInput,
} from "@shared/dropship/listing-setting-writes";
import type {
  ListingSettingsPolicyKind,
  ListingSettingsProductDetail,
  ListingSettingsProductOwnSettings,
} from "@shared/dropship/listing-settings";
import type {
  ListingSettingsEditRights,
  ListingSettingsReadState,
  ListingSettingsRightReason,
} from "./dropship-listing-settings-access";
import {
  isDraftDirty,
  isDraftLocked,
  type DraftValue,
  type EditorId,
  type ListingSettingsDraft,
} from "./dropship-listing-settings-drafts";
import type { SizePriceDraft } from "./dropship-listing-settings-drawer";
import {
  noPolicyOnEbayWords,
  policyEditorChoices,
  setupReadEbay,
  type PolicyEditorChoice,
  type PolicySetupFacts,
} from "./dropship-listing-settings-store-requests";

/**
 * Editing one product's own settings in its drawer (Listing settings PR 10,
 * plan 4.4): the choices a field can take, the draft that holds them, the W5
 * patch and request they make, and who may change which field.
 *
 * Rules this module keeps:
 * - Ids only (plan D1, P13): a choice names a policy by its id; the server
 *   builds every stored name. Never a price: a product's price goes through
 *   the price check (10d), a size's exact price through W9.
 * - One kind of change per Save (D2): the drawer's draft holds one size's
 *   exact price or the product's settings, never both.
 * - The draft's start (the product's own values) and its revision come from
 *   one own-read answer, so the revision W5 sends is the one the vendor saw.
 *
 * Pure: no React, no network, no clock. Never mutates its inputs.
 */

/** Leave as it is (absent from the patch), use the default (null: the category's, else the store default), or set it. */
export type FieldChoice<T> = { mode: "leave" } | { mode: "default" } | { mode: "set"; value: T };

/** The fields the drawer edits in 10a; 10b adds ebayCategory, storeShelf, textAbove, textBelow and mainText. */
export const PRODUCT_EDIT_FIELDS = ["shippingPolicy", "returnPolicy", "paymentPolicy"] as const;
export type ProductEditField = (typeof PRODUCT_EDIT_FIELDS)[number];

/** A policy by its eBay id, as W5 takes it. */
export interface PolicyChoiceValue {
  readonly id: string;
}

export type ProductSettingsChoices = { readonly [F in ProductEditField]: FieldChoice<PolicyChoiceValue> };

/** The own-settings read (`GET …/products/:productId/own`). */
export type ProductOwnSettings = ListingSettingsProductOwnSettings;
export type ProductOwnValues = ProductOwnSettings["own"];

/** `size_price`: one size's exact price (W9). `settings`: the product's own settings (W5). 10d adds "product_price". */
export type DrawerChangeKind = "none" | "size_price" | "settings";

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

/** What the drawer's one draft holds: a size's exact price (PR 7's W9 value) or the product's settings. */
export type DrawerDraftValue = SizePriceDraft | ProductSettingsDraftValue;

const LEAVE: FieldChoice<never> = Object.freeze({ mode: "leave" });
const DEFAULT: FieldChoice<never> = Object.freeze({ mode: "default" });

/** Every field left as it is. */
export function emptyChoices(): ProductSettingsChoices {
  return Object.freeze({ shippingPolicy: LEAVE, returnPolicy: LEAVE, paymentPolicy: LEAVE });
}

/** What the product has now, as choices: the field editor opens on these. */
export function choicesFromOwn(own: Pick<ProductOwnSettings, "own">): ProductSettingsChoices {
  const choice = (field: ProductEditField): FieldChoice<PolicyChoiceValue> => {
    const value = own.own[field];
    return value === null ? DEFAULT : { mode: "set", value: { id: value.id } };
  };
  return Object.freeze({ shippingPolicy: choice("shippingPolicy"), returnPolicy: choice("returnPolicy"), paymentPolicy: choice("paymentPolicy") });
}

/** The fields a change touches, in the drawer's order. */
export function changedFields(choices: ProductSettingsChoices): ProductEditField[] {
  return PRODUCT_EDIT_FIELDS.filter((field) => choices[field].mode !== "leave");
}

/**
 * The fields a chosen size still sets for itself: a leftover of the older
 * per-size settings (source `size` in the product's settings in full). A
 * leftover beats the product's own value and its category's, and a W5 save
 * that names the field clears it (`S/domain/listing-setting-values.ts`
 * LISTING_SETTING_LEFTOVER_FIELDS; `S/application/dropship-listing-product-settings-service.ts`
 * `clearSizeLeftovers`). So while one is there, a choice equal to the
 * product's own value is still a change: sending it is the only way to clear it.
 */
export function sizeLeftoverFields(settings: Pick<ListingSettingsProductDetail["settings"], ProductEditField>): ProductEditField[] {
  return PRODUCT_EDIT_FIELDS.filter((field) => settings[field].some((entry) => entry.sources.some((source) => source.source === "size")));
}

/** Whether `choice` asks for what the product already has: then it is no change. */
function sameAsOwn(field: ProductEditField, choice: FieldChoice<PolicyChoiceValue>, own: ProductOwnValues): boolean {
  const saved = own[field];
  if (choice.mode === "default") return saved === null;
  if (choice.mode === "set") return saved !== null && saved.id === choice.value.id;
  return true;
}

/**
 * The choice as the draft keeps it: one that asks for what is saved is
 * "leave", so it counts as no change, unless a size's leftover makes the
 * field read otherwise (`sizeLeftoverFields`), which only a save clears.
 */
function draftChoice(
  field: ProductEditField,
  choice: FieldChoice<PolicyChoiceValue>,
  own: ProductOwnValues,
  leftovers: readonly ProductEditField[],
): FieldChoice<PolicyChoiceValue> {
  if (choice.mode === "leave" || (!leftovers.includes(field) && sameAsOwn(field, choice, own))) return LEAVE;
  return choice.mode === "set" ? { mode: "set", value: { id: choice.value.id } } : DEFAULT;
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
  return {
    shippingPolicy: draftChoice("shippingPolicy", choices.shippingPolicy, own.own, leftovers),
    returnPolicy: draftChoice("returnPolicy", choices.returnPolicy, own.own, leftovers),
    paymentPolicy: draftChoice("paymentPolicy", choices.paymentPolicy, own.own, leftovers),
    own: own.own,
    expectedRevisionId: own.revisionId,
  };
}

function isChoice(value: unknown): value is FieldChoice<PolicyChoiceValue> {
  if (typeof value !== "object" || value === null) return false;
  const choice = value as { mode?: unknown; value?: unknown };
  if (choice.mode === "leave" || choice.mode === "default") return true;
  if (choice.mode !== "set" || typeof choice.value !== "object" || choice.value === null) return false;
  const id = (choice.value as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0;
}

function isRevision(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

/** The settings draft value, or null when `value` is not one (a size's price, or another editor's draft). */
export function readProductSettingsDraft(value: DraftValue): ProductSettingsDraftValue | null {
  const { own, expectedRevisionId } = value;
  if (typeof own !== "object" || own === null || !isRevision(expectedRevisionId)) return null;
  if (!PRODUCT_EDIT_FIELDS.every((field) => isChoice(value[field]))) return null;
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
  // The drawer's draft holds one of two values; anything that isn't settings is PR 7's size price.
  return readProductSettingsDraft(draft.value) !== null ? "settings" : "size_price";
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

/**
 * [Done] in a field editor. A settings draft with changes keeps its start (the
 * revision the vendor saw); any other edit starts from the own read as it is
 * now, so it never sends an old revision. `leftovers`: the fields a size still
 * sets for itself (`sizeLeftoverFields`), where the product's own value is
 * still a change.
 */
export function productSettingsEditAction(input: {
  draft: ListingSettingsDraft | null;
  editor: EditorId;
  own: ProductOwnSettings;
  leftovers?: readonly ProductEditField[];
  field: ProductEditField;
  choice: FieldChoice<PolicyChoiceValue>;
}): ProductSettingsEditAction {
  const { draft, editor, field, choice } = input;
  const leftovers = input.leftovers ?? [];
  const ownDraft = draft !== null && draft.editor === editor ? draft : null;
  if (ownDraft !== null && isDraftLocked(ownDraft)) return { kind: "locked" };
  const kind = drawerChangeKind(draft, editor);
  if (kind === "settings" && ownDraft !== null) {
    const current = readProductSettingsDraft(ownDraft.value)!;
    return { kind: "edit", reopen: !ownDraft.open, value: { ...current, [field]: draftChoice(field, choice, current.own, leftovers) } };
  }
  const chosen = draftChoice(field, choice, input.own.own, leftovers);
  if (chosen.mode === "leave") return { kind: "no_change" };
  if (decideDrawerEdit(kind, "settings") === "finish_first") return { kind: "finish_first" };
  const base = productSettingsDraftValue(input.own);
  return { kind: "start", base, value: { ...base, [field]: chosen } };
}

// ---------------------------------------------------------------------------
// The W5 request
// ---------------------------------------------------------------------------

/** leave → absent, default → null, set → the id alone. */
export function productSettingsPatch(choices: ProductSettingsChoices): ProductSettingsPatchInput {
  const patch: Record<string, { id: string } | null> = {};
  for (const field of PRODUCT_EDIT_FIELDS) {
    const choice = choices[field];
    if (choice.mode === "default") patch[field] = null;
    else if (choice.mode === "set") patch[field] = { id: choice.value.id };
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

const EDIT_FIELD_SET: ReadonlySet<string> = new Set(PRODUCT_EDIT_FIELDS);

/**
 * The W5 body, checked by the shared input schema before it is sent. Throws a
 * ProductSettingsRequestError for an empty patch, a field this part doesn't
 * edit (a price above all, D1) or anything the schema refuses.
 */
export function productSettingsSaveBody(input: { key: string; expectedRevisionId: number | null; patch: ProductSettingsPatchInput }): ProductSettingsSaveBody {
  const sent = Object.keys(input.patch).filter((field) => input.patch[field as keyof ProductSettingsPatchInput] !== undefined);
  const outside = sent.filter((field) => !EDIT_FIELD_SET.has(field));
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
 * Everything a W5 request sends except its key: the same request always
 * reuses its key (a retry is answered by the first save), and any edit, or a
 * new revision after "Load latest", gets a new one.
 */
export function productSettingsSignature(
  storeConnectionId: number,
  productId: number,
  expectedRevisionId: number | null,
  patch: ProductSettingsPatchInput,
): string {
  const entries = PATCH_KEY_ORDER
    .filter((field) => patch[field as keyof ProductSettingsPatchInput] !== undefined)
    .map((field) => [field, canonical(patch[field as keyof ProductSettingsPatchInput])]);
  return JSON.stringify(["listing-settings-product-settings-v1", storeConnectionId, productId, expectedRevisionId, entries]);
}

// ---------------------------------------------------------------------------
// Who may change which field (D3, D4, CC-C16)
// ---------------------------------------------------------------------------

/** The W2 right a field also needs to pick a new eBay value: the policy lists come from the live setup read. */
const FIELD_PICK_RIGHT: Readonly<Record<ProductEditField, "shipping" | "policies">> = {
  shippingPolicy: "shipping",
  returnPolicy: "policies",
  paymentPolicy: "policies",
};

/** The rights a product's own settings read: W5's, and the W2 rights its fields pick eBay values with. */
export type ProductSettingsRights = Pick<ListingSettingsEditRights, "productSettings" | "shipping" | "policies">;

export interface ProductFieldRights {
  /** A new value can be picked. */
  canSet: boolean;
  /** "Use default" can be chosen: it names no eBay value, so W5 asks eBay nothing (P13). */
  canDefault: boolean;
  /** Why not everything can be chosen; null when it can. */
  reason: ListingSettingsRightReason | null;
}

/**
 * A field's rights: W5's right AND the field's own pick right. A paused
 * vendor or inactive .ops takes W5 away, so nothing can be chosen (C16). A
 * sign-in or eBay refusing access takes the pick right away and leaves "Use
 * default" (D4); so does eBay not answering, or Card Shellz shipping not
 * being ready for a shipping policy.
 */
export function productFieldRights(rights: ProductSettingsRights, field: ProductEditField): ProductFieldRights {
  const product = rights.productSettings;
  if (!product.editable) return { canSet: false, canDefault: false, reason: product.reason };
  const pick = rights[FIELD_PICK_RIGHT[field]];
  return pick.editable ? { canSet: true, canDefault: true, reason: null } : { canSet: false, canDefault: true, reason: pick.reason };
}

// ---------------------------------------------------------------------------
// "Load latest and keep my changes" (R:542, C20)
// ---------------------------------------------------------------------------

/** Whether a field's saved value differs between two reads. A renamed policy is the same policy. */
function ownValueMoved(field: ProductEditField, before: ProductOwnValues, after: ProductOwnValues): boolean {
  return (before[field]?.id ?? null) !== (after[field]?.id ?? null);
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
 * keeps it one.
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

const POLICY_KIND_BY_FIELD: Readonly<Record<ProductEditField, ListingSettingsPolicyKind>> = {
  shippingPolicy: "shipping",
  returnPolicy: "return",
  paymentPolicy: "payment",
};

export interface PolicyFieldEditorModel {
  field: ProductEditField;
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

/**
 * The editor a policy row opens (plan 4.5, D4): eBay's policies from the
 * live setup read when a new one can be picked, and "Use default" when it can
 * be chosen. The list is only ever the latest read's: an older answer a
 * failed refetch left behind is not offered (`liveSetup` in the rows).
 */
export function policyFieldEditor(input: {
  field: ProductEditField;
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
  const live = input.setup.data !== undefined && (input.setup.error === undefined || input.setup.error === null) ? input.setup.data : null;
  const choices = rights.canSet && live !== null && setupReadEbay(live) ? policyEditorChoices(live, kind) : null;
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
