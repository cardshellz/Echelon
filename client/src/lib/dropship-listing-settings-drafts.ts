import { DropshipApiError } from "./dropship-ops-surface";
import { LISTING_SETUP_RELOAD_MESSAGE, listingSetupSaveErrorMessage } from "./dropship-ebay-listing-setup";
import {
  bulkConflictWords,
  LISTING_SETTINGS_BULK_WORDS,
  LISTING_SETTINGS_EDIT_WORDS,
  productNotFoundWords,
} from "./dropship-listing-settings-words";
import { describeLeavePrompt } from "./dropship-unsaved-changes";

/**
 * The editor framework of the Listing settings step (Listing settings PR 7,
 * plan 4.5 and 4.6): one draft at a time, its save phases, its request key,
 * how a failed save is classified, and the words of the bottom bar.
 *
 * Pure: no React, no network, no clock. Every time is passed in (`nowMs`), and
 * every new request key comes from the caller's key maker, so the same inputs
 * always give the same draft.
 *
 * Words marked "interim" are not in the design record yet; they live here so a
 * later PR can change them in one place.
 */

export { describeLeavePrompt };

/** The seven rows of the Store defaults card, in the record's order (R:90). */
export const STORE_DEFAULT_FIELDS = ["price", "shipping", "return", "payment", "ebayCategory", "shelf", "description"] as const;
export type StoreDefaultField = (typeof STORE_DEFAULT_FIELDS)[number];

/** Each row's name as the vendor sees it (R:90). */
export const STORE_DEFAULT_LABELS: Readonly<Record<StoreDefaultField, string>> = Object.freeze({
  price: "Price",
  shipping: "Shipping policy",
  return: "Return policy",
  payment: "Payment policy",
  ebayCategory: "eBay category",
  shelf: "Store shelf",
  description: "Description",
});

/**
 * Each row's name on a phone (R:433-442). Shipping, Returns, Payment and Store
 * shelf read on one line ("Shipping · Free Standard ›"); the others put their
 * value on a second line ("Price ›" over "Retail + 20%, up to .99").
 */
export const STORE_DEFAULT_COMPACT_LABELS: Readonly<Record<StoreDefaultField, string>> = Object.freeze({
  price: "Price",
  shipping: "Shipping",
  return: "Returns",
  payment: "Payment",
  ebayCategory: "eBay category",
  shelf: "Store shelf",
  description: "Description",
});

/** The phone rows whose value sits on the same line as the name (R:436-439). */
export const STORE_DEFAULT_ONE_LINE_FIELDS: ReadonlySet<StoreDefaultField> = new Set(["shipping", "return", "payment", "shelf"]);

/** The Store defaults card (R:89, R:121, R:583). */
export const STORE_DEFAULTS_CARD_WORDS = Object.freeze({
  title: "Store defaults",
  intro: "Every product uses these unless you change it below.",
  footer: "Card Shellz packs and ships every order.",
} as const);

/**
 * Who holds the step's one draft: a Store defaults row, the ship-from repair
 * under Shipping, the product drawer of one product, or "Set for selected"
 * (`bulk`, many products at once; plan PR 10, D16).
 */
export type EditorId = StoreDefaultField | "shipFrom" | `product:${number}` | "bulk";

/** "Set for selected"'s editor id: one sheet for the ticked products (plan PR 10, 6.2, D16). */
export const BULK_EDITOR_ID = "bulk" satisfies EditorId;

/** The drawer's editor id for one product. Refuses an id that is not a positive whole number. */
export function productEditorId(productId: number): EditorId {
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    throw new Error(`A product editor needs a positive whole-number product id, not ${String(productId)}.`);
  }
  return `product:${productId}`;
}

/**
 * Where a draft stands.
 * - `editing`: open, changes (if any) not sent.
 * - `saving`: sent; the editor is locked.
 * - `saved`: confirmed; "Saved" shows for SAVED_FLASH_MS.
 * - `saved_view_stale`: confirmed, but the re-read failed.
 * - the rest: a failed save, by its class (`classifyWriteFailure`).
 */
export type SavePhase =
  | "editing"
  | "saving"
  | "saved"
  | "saved_view_stale"
  | "uncertain"
  | "unreachable"
  | "conflict"
  | "refused"
  | "rate_limited"
  | "reload_required"
  | "blocked";

/** The class of a failed save. Each one decides whether the draft and its request key are kept. */
export type WriteFailurePhase = Extract<
  SavePhase,
  "uncertain" | "unreachable" | "conflict" | "refused" | "rate_limited" | "reload_required" | "blocked"
>;

/**
 * A draft value: a flat record of the editor's fields, each JSON-like
 * (text, numbers, booleans, null, arrays and plain objects).
 */
export type DraftValue = Readonly<Record<string, unknown>>;

/** One save attempt: the request it sends (as a signature) and the request key it uses. */
export interface SaveAttempt {
  signature: string;
  key: string;
}

export interface ListingSettingsDraft<V extends DraftValue = DraftValue> {
  editor: EditorId;
  /** The place the bar and the leave prompt name: "Price", "Shipping policy", a product's name. */
  place: string;
  /** The saved value when the editor opened (or the latest one after "Load latest"). */
  base: V;
  /** The vendor's value. */
  value: V;
  /** How many fields of `value` differ from `base`. */
  changes: number;
  /** Fields both the vendor and another window changed, marked after "Load latest" (C20). */
  marked: readonly string[];
  /** Whether the editor surface is showing. A closed draft with changes is kept (browser Back). */
  open: boolean;
  phase: SavePhase;
  /** Words for the phase, when it has any. */
  message: string | null;
  /** The server's error code behind a failed save, for words a row adds itself. */
  code: string | null;
  /** The request in flight or to resend; null when the next save needs a new key. */
  attempt: SaveAttempt | null;
  /** When the last save was confirmed (from the injected clock). */
  savedAtMs: number | null;
}

/** "Saved" shows beside the button for 3 seconds (R:538). */
export const SAVED_FLASH_MS = 3000;

/** Every request key prefix the step uses (`createDropshipIdempotencyKey(prefix)` gives `prefix:uuid`). */
export const LISTING_SETTINGS_KEY_PREFIXES = Object.freeze({
  policy: "ls-policy",
  shelf: "ls-shelf",
  shipFrom: "ls-ship-from",
  pricingApply: "ls-apply",
  category: "ls-category",
  description: "ls-text",
  sizePrice: "ls-price",
  // W5, one product's own settings (plan PR 10, D5).
  productSettings: "ls-product",
  // W6, "Set for selected": many products' settings, never a price (plan PR 10, D5).
  bulkSettings: "ls-bulk",
} as const);

/** The words every editor shares (R:535-545). */
export const LISTING_SETTINGS_SAVE_WORDS = Object.freeze({
  notSaved: "Not saved",
  save: "Save",
  saving: "Saving…",
  saved: "Saved",
  cancel: "Cancel",
  change: "Change",
  uncertain: "We couldn't confirm your save.",
  checkAgain: "Check again",
  unreachable: "Can't reach eBay right now. Nothing was saved. Try again.",
  tryAgain: "Try again",
  conflict: "This changed in another window.",
  loadLatest: "Load latest and keep my changes",
  rebased: "Here's what's saved now. Your changes are on top; fields you both changed are marked.",
  rateLimited: "Too many saves in a minute. Wait a moment and try again.",
  reloadRequired: LISTING_SETUP_RELOAD_MESSAGE,
  savedViewStale: "Saved. We couldn't load the latest view.",
  reload: "Reload",
  // Interim: the record gives no words for a save refused while a banner explains why.
  blocked: "Nothing was saved.",
  // Interim: the same request key came back with another request (a retry raced an edit).
  keyReused: "Something changed since you last tried. Save again.",
  shelfGone: "That shelf is gone from your eBay store.",
  pickFinalCategory: "Pick a final eBay category.",
  // Interim (2B): a refusal that names a category of an older eBay category rule.
  olderCategoryRule: "One of your older eBay category rules uses a category eBay no longer accepts.",
  // Interim (2B): the description fields the server refused.
  descriptionInvalid: "Keep each text to 4,000 characters, with no special characters.",
  // Interim (2B): a body over the server's size limit (413 with no code).
  tooLarge: "This is too big to save here. Contact support.",
  // Interim (2C): the review was dropped by the server; a new check is needed.
  pricingReviewGone: "This price check has expired. Check new prices again.",
  // Interim (2C): the M3 footer says which sizes block it.
  pricingReviewBlocked: "Some sizes can't be priced this way, so nothing was saved.",
  // Interim (2A): the shipping policy refused by the Card Shellz check.
  shippingPolicyIncompatible: "This shipping policy doesn't work with Card Shellz shipping. Check eBay again, then pick another one.",
} as const);

// ---------------------------------------------------------------------------
// Field comparison
// ---------------------------------------------------------------------------

/** Deep equality for JSON-like values. A missing field equals an undefined one. */
export function sameDraftValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => sameDraftValue(item, right[index]));
  }
  if (isPlainRecord(left) && isPlainRecord(right)) {
    return fieldNames(left, right).every((name) => sameDraftValue(left[name], right[name]));
  }
  return false;
}

/** The fields of `value` that differ from `base`, in a stable order (base's fields first). */
export function changedFields(base: DraftValue, value: DraftValue): string[] {
  return fieldNames(base, value).filter((name) => !sameDraftValue(base[name], value[name]));
}

/**
 * The fields the vendor and another window both changed from `base`, to
 * different values (R:542, C20). A field both set to the same value is not
 * marked: after "Load latest" it is no longer a change.
 */
export function bothChangedFields(base: DraftValue, mine: DraftValue, latest: DraftValue): string[] {
  return fieldNames(base, mine, latest).filter((name) =>
    !sameDraftValue(base[name], mine[name])
    && !sameDraftValue(base[name], latest[name])
    && !sameDraftValue(mine[name], latest[name]));
}

function fieldNames(...records: readonly DraftValue[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const name of Object.keys(record)) {
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }
  return names;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

/** A draft's changes count as unsaved (the leave prompt and the bar name them). */
export function isDraftDirty(draft: Pick<ListingSettingsDraft, "changes"> | null): boolean {
  return draft !== null && draft.changes > 0;
}

/** While saving, or after a save nobody could confirm, the vendor can't change the draft (R:539, R:541). */
export function isDraftLocked(draft: Pick<ListingSettingsDraft, "phase"> | null): boolean {
  return draft !== null && (draft.phase === "saving" || draft.phase === "uncertain");
}

/** Whether "Saved" shows at `nowMs`: for SAVED_FLASH_MS after the save was confirmed. */
export function isSavedFlashVisible(
  draft: Pick<ListingSettingsDraft, "phase" | "savedAtMs"> | null,
  nowMs: number,
): boolean {
  if (draft === null || draft.phase !== "saved" || draft.savedAtMs === null) return false;
  const elapsed = nowMs - draft.savedAtMs;
  return elapsed >= 0 && elapsed < SAVED_FLASH_MS;
}

/**
 * What opening `editor` does to the current draft (R:97, R:539):
 * - `open`: nothing to lose (no draft, an unchanged one, or this editor's own draft, which reopens);
 * - `ask`: another editor holds changes, so the vendor is asked first;
 * - `refuse`: another editor is saving; nothing opens until it ends.
 *
 * The ship-from repair (W10) holds no change, so another editor opens over it even
 * when nobody could confirm it, and its key goes. That is safe: "Update now" reads
 * the setup again before it plans (`readShipFromRepairStart`), so a repair that
 * landed is not sent again, and the revision check stops a second write.
 */
export type OpenDecision = "open" | "ask" | "refuse";

export function decideOpen(draft: ListingSettingsDraft | null, editor: EditorId): OpenDecision {
  if (draft === null || draft.editor === editor) return "open";
  if (draft.phase === "saving") return "refuse";
  return isDraftDirty(draft) ? "ask" : "open";
}

/**
 * The attempt for a save of the request with this signature: the draft's own
 * when the signature is the same (a retry reuses its key, so the server
 * answers it from the first save), or a new one with a new key. Null when no
 * save can start: no draft, a save in flight, or an unconfirmed save whose
 * request differs ("Check again" must resend the same request).
 */
export function nextSaveAttempt(
  draft: ListingSettingsDraft | null,
  signature: string,
  newKey: () => string,
): SaveAttempt | null {
  if (draft === null || draft.phase === "saving") return null;
  if (draft.attempt !== null && draft.attempt.signature === signature) return draft.attempt;
  if (draft.phase === "uncertain") return null;
  return { signature, key: newKey() };
}

export type ListingSettingsDraftAction =
  | { type: "open"; editor: EditorId; place: string; base: DraftValue }
  | { type: "edit"; value: DraftValue }
  | { type: "startSave"; attempt: SaveAttempt }
  | { type: "saved"; key: string; nowMs: number; viewStale?: boolean }
  | { type: "failure"; key: string; failure: WriteFailure }
  /**
   * `marked`: the fields to mark, when the editor knows them better than a
   * field-by-field comparison can (a product's settings, whose saved values
   * sit in one field of the draft; `rebaseProductSettingsDraft`). Absent: the
   * fields both changed (`bothChangedFields`).
   */
  | { type: "rebase"; latest: DraftValue; marked?: readonly string[] }
  | { type: "close" }
  | { type: "discard" }
  | { type: "tick"; nowMs: number };

/** Classes of failed save after which the same request may be sent again with the same key. */
const KEY_KEEPING_FAILURES: ReadonlySet<WriteFailurePhase> = new Set(["uncertain", "unreachable", "rate_limited"]);

/**
 * The step's one draft. Never mutates `draft`; returns it unchanged when the
 * action does not apply (a stale save answer, an edit while locked, opening
 * a second editor over unsaved changes).
 */
export function reduceListingSettingsDraft(
  draft: ListingSettingsDraft | null,
  action: ListingSettingsDraftAction,
): ListingSettingsDraft | null {
  switch (action.type) {
    case "open": {
      if (draft !== null && draft.editor === action.editor) {
        // Reopening keeps the vendor's changes and the base they started from;
        // an unchanged draft takes the latest saved value instead.
        if (isDraftDirty(draft) || isDraftLocked(draft)) return { ...draft, open: true, place: action.place };
        return newDraft(action.editor, action.place, action.base);
      }
      if (decideOpen(draft, action.editor) !== "open") return draft;
      return newDraft(action.editor, action.place, action.base);
    }
    case "edit": {
      if (draft === null || isDraftLocked(draft)) return draft;
      return {
        ...draft,
        value: action.value,
        changes: changedFields(draft.base, action.value).length,
        phase: "editing",
        message: null,
        code: null,
        savedAtMs: null,
      };
    }
    case "startSave": {
      if (draft === null || draft.phase === "saving") return draft;
      if (draft.phase === "uncertain" && draft.attempt?.signature !== action.attempt.signature) return draft;
      return { ...draft, phase: "saving", message: null, code: null, attempt: action.attempt };
    }
    case "saved": {
      if (!answersAttempt(draft, action.key)) return draft;
      return {
        ...draft,
        // Rows redraw from the server's answer; the saved value is only the base for the next edit.
        base: draft.value,
        changes: 0,
        marked: [],
        phase: action.viewStale ? "saved_view_stale" : "saved",
        message: action.viewStale ? LISTING_SETTINGS_SAVE_WORDS.savedViewStale : null,
        code: null,
        attempt: null,
        savedAtMs: action.nowMs,
      };
    }
    case "failure": {
      if (!answersAttempt(draft, action.key)) return draft;
      return {
        ...draft,
        phase: action.failure.phase,
        message: action.failure.message,
        code: action.failure.code,
        // Refused, conflicting, blocked and reload answers were not saved, and the
        // next request differs, so it gets a new key.
        attempt: KEY_KEEPING_FAILURES.has(action.failure.phase) ? draft.attempt : null,
      };
    }
    case "rebase": {
      if (draft === null || isDraftLocked(draft)) return draft;
      if (!isDraftDirty(draft)) {
        // Nothing of the vendor's to keep on top: the draft takes the latest saved value as it
        // is, as an unchanged draft does when it reopens. Keeping the old value would show a
        // change the vendor never made, and saving it would undo the other window's save.
        return { ...draft, base: action.latest, value: action.latest, changes: 0, marked: [], phase: "editing", message: null, code: null, attempt: null };
      }
      return {
        ...draft,
        base: action.latest,
        changes: changedFields(action.latest, draft.value).length,
        marked: action.marked ? [...action.marked] : bothChangedFields(draft.base, draft.value, action.latest),
        phase: "editing",
        message: LISTING_SETTINGS_SAVE_WORDS.rebased,
        code: null,
        attempt: null,
      };
    }
    case "close": {
      if (draft === null) return null;
      const keep = isDraftDirty(draft) || isDraftLocked(draft)
        || draft.phase === "saved" || draft.phase === "saved_view_stale";
      return keep ? { ...draft, open: false } : null;
    }
    case "discard":
      return null;
    case "tick": {
      if (draft === null || draft.phase !== "saved" || isSavedFlashVisible(draft, action.nowMs)) return draft;
      return draft.open ? { ...draft, phase: "editing", savedAtMs: null } : null;
    }
  }
}

function newDraft(editor: EditorId, place: string, base: DraftValue): ListingSettingsDraft {
  return {
    editor,
    place,
    base,
    value: base,
    changes: 0,
    marked: [],
    open: true,
    phase: "editing",
    message: null,
    code: null,
    attempt: null,
    savedAtMs: null,
  };
}

/** Whether a save answer belongs to the draft's attempt in flight; a late answer for a discarded draft does not. */
function answersAttempt(draft: ListingSettingsDraft | null, key: string): draft is ListingSettingsDraft {
  return draft !== null && draft.phase === "saving" && draft.attempt !== null && draft.attempt.key === key;
}

// ---------------------------------------------------------------------------
// Failed saves
// ---------------------------------------------------------------------------

/**
 * The step's writers (plan 4.5): W1 the store price (pricing review apply),
 * W2 the eBay listing setup (policies and store shelf), W3 eBay category
 * rules, W4 the description profile, W9 one size's price, W10 the ship-from
 * repair; and the PR 9 writers as PR 10 adds them: W5 one product's own
 * settings (plan PR 10, 4.6), W6 many products' settings ("Set for
 * selected", plan PR 10, 6.4).
 */
export type ListingSettingsWriter = "W1" | "W2" | "W3" | "W4" | "W5" | "W6" | "W9" | "W10";

export interface WriteFailure {
  phase: WriteFailurePhase;
  /** Vendor words for the editor (a `blocked` failure is explained by the banner). */
  message: string;
  code: string | null;
  /** HTTP status, or null when no answer arrived. */
  status: number | null;
  /**
   * The fields the refusal names (`context.invalidFields` / `context.fields`,
   * plus the field a code is about), for a PR 9 writer only (plan 3.3); absent
   * for the PR 7 writers, whose failures stay as they were.
   */
  fields?: readonly string[];
}

export interface ClassifyWriteFailureOptions {
  /** W3: the eBay category the vendor picked, to tell a bad pick from an older rule's category. */
  pickedEbayCategoryId?: string | null;
  /** W5: the store's name, for "This product isn't chosen for <store>." */
  storeName?: string;
}

interface WriterCodes {
  conflict: ReadonlySet<string>;
  refused: ReadonlySet<string>;
  blocked: ReadonlySet<string>;
  reloadRequired: ReadonlySet<string>;
  /** Whether a 502/503 means the request stopped at eBay before anything was written. */
  unreachableOnBadGateway: boolean;
}

const NONE: ReadonlySet<string> = new Set();

/** The PR 7 writers, classified by the table below; the PR 9 writers have their own rules (`classifyPr9WriteFailure`). */
type Pr7Writer = Exclude<ListingSettingsWriter, Pr9Writer>;

/** The codes each writer's routes send (plan 4.5; status maps in each `*.routes.ts`). */
const WRITER_CODES: Readonly<Record<Pr7Writer, WriterCodes>> = (() => {
  // W2 and W10 share one route file (`dropship-ebay-listing-setup.routes.ts`).
  const listingSetup: WriterCodes = {
    conflict: new Set(["DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT"]),
    refused: new Set([
      "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT",
      "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE",
      "DROPSHIP_EBAY_STORE_SHELF_DEFAULT_INVALID",
    ]),
    blocked: new Set([
      "DROPSHIP_LISTING_CONFIG_STORE_PAUSED",
      "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTING",
      "DROPSHIP_LISTING_CONFIG_STORE_DISCONNECTED",
      "DROPSHIP_LISTING_CONFIG_STORE_NOT_WRITABLE",
      "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED",
      "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_TOKEN_REQUIRED",
      "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED",
      "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED",
      "DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED",
      "DROPSHIP_EBAY_STORE_CATEGORIES_ACCESS_DENIED",
      "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED",
      "DROPSHIP_ENTITLEMENT_REQUIRED",
      "DROPSHIP_LISTING_CONFIG_VENDOR_BLOCKED",
    ]),
    reloadRequired: new Set(["DROPSHIP_LISTING_CONFIG_REVISION_REQUIRED"]),
    unreachableOnBadGateway: true,
  };
  return {
    W1: {
      conflict: new Set(["DROPSHIP_PRICING_REVIEW_STALE"]),
      refused: new Set([
        "DROPSHIP_IDEMPOTENCY_CONFLICT",
        "DROPSHIP_PRICING_REVIEW_BLOCKED",
        "DROPSHIP_PRICING_REVIEW_TOO_LARGE",
        "DROPSHIP_PRICING_INVALID_INPUT",
        "DROPSHIP_PRICING_REVIEW_NOT_FOUND",
      ]),
      blocked: new Set(["DROPSHIP_PRICING_NOT_ALLOWED"]),
      reloadRequired: NONE,
      unreachableOnBadGateway: false,
    },
    W2: listingSetup,
    W10: listingSetup,
    W3: {
      conflict: new Set(["DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT"]),
      refused: new Set([
        "DROPSHIP_IDEMPOTENCY_CONFLICT",
        "DROPSHIP_EBAY_CATEGORY_RULE_INVALID",
        "DROPSHIP_EBAY_CATEGORY_RULES_INVALID_INPUT",
        "DROPSHIP_EBAY_CATEGORY_NOT_FOUND",
      ]),
      blocked: new Set([
        "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED",
        "DROPSHIP_EBAY_CATEGORIES_ACCESS_DENIED",
        "DROPSHIP_EBAY_CATEGORY_RULES_NOT_ALLOWED",
        "DROPSHIP_EBAY_STORE_CONNECTION_BLOCKED",
        "DROPSHIP_EBAY_CATEGORY_MARKETPLACE_UNSUPPORTED",
      ]),
      reloadRequired: NONE,
      // Categories are checked with eBay before anything is written.
      unreachableOnBadGateway: true,
    },
    W4: {
      conflict: new Set(["DROPSHIP_CONTENT_VERSION_CONFLICT"]),
      refused: new Set(["DROPSHIP_IDEMPOTENCY_CONFLICT", "DROPSHIP_CONTENT_INVALID_INPUT"]),
      blocked: new Set(["DROPSHIP_CONTENT_NOT_ALLOWED"]),
      reloadRequired: NONE,
      unreachableOnBadGateway: false,
    },
    W9: {
      conflict: new Set(["DROPSHIP_LISTING_PRICE_VERSION_CONFLICT"]),
      refused: new Set([
        "DROPSHIP_IDEMPOTENCY_CONFLICT",
        "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT",
        "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST",
        "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE",
        "DROPSHIP_LISTING_PRICE_INVALID_INPUT",
      ]),
      blocked: new Set([
        "DROPSHIP_LISTING_VENDOR_BLOCKED",
        "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED",
        "DROPSHIP_LISTING_STORE_BLOCKED",
      ]),
      reloadRequired: NONE,
      unreachableOnBadGateway: false,
    },
  };
})();

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_BAD_GATEWAY = 502;
const HTTP_SERVICE_UNAVAILABLE = 503;

/**
 * Card Shellz's own shipping and warehouse codes (the test in
 * `listingSetupSaveErrorMessage`). They are not eBay outages, so they keep
 * Card Shellz words instead of "Can't reach eBay".
 */
const CARD_SHELLZ_SHIPPING_CODE = /^DROPSHIP_EBAY_(FULFILLMENT|MANAGED_LOCATION_WAREHOUSE|MANAGED_LOCATION_COUNTRY)_/;

/**
 * The class of a failed save, and its words (plan 4.5, C8). Anything that is
 * not an answer from the server (a dropped connection) is `uncertain`: the
 * save may have happened, so the same request is sent again with the same
 * key. Codes the table does not name: another 4xx is `refused` with the
 * server's message, another 5xx is `uncertain`.
 */
export function classifyWriteFailure(
  writer: ListingSettingsWriter,
  error: unknown,
  options: ClassifyWriteFailureOptions = {},
): WriteFailure {
  if (isPr9Writer(writer)) return classifyPr9WriteFailure(writer, error, options);
  if (!(error instanceof DropshipApiError)) {
    return { phase: "uncertain", message: LISTING_SETTINGS_SAVE_WORDS.uncertain, code: null, status: null };
  }
  const { status, code } = error;
  const codes = WRITER_CODES[writer];
  const failure = (phase: WriteFailurePhase, message: string): WriteFailure => ({ phase, message, code, status });

  if (status === HTTP_TOO_MANY_REQUESTS) return failure("rate_limited", LISTING_SETTINGS_SAVE_WORDS.rateLimited);
  if (code !== null && codes.reloadRequired.has(code)) return failure("reload_required", LISTING_SETTINGS_SAVE_WORDS.reloadRequired);
  if (code !== null && codes.conflict.has(code)) return failure("conflict", LISTING_SETTINGS_SAVE_WORDS.conflict);
  if (code !== null && codes.blocked.has(code)) return failure("blocked", LISTING_SETTINGS_SAVE_WORDS.blocked);
  if (status >= 500) {
    if (codes.unreachableOnBadGateway && (status === HTTP_BAD_GATEWAY || status === HTTP_SERVICE_UNAVAILABLE)) {
      return failure("unreachable", unreachableWords(writer, error));
    }
    return failure("uncertain", LISTING_SETTINGS_SAVE_WORDS.uncertain);
  }
  if (status >= 400) return failure("refused", refusedWords(writer, error, options));
  // A DropshipApiError is only made from a failed answer; anything else could not be confirmed.
  return failure("uncertain", LISTING_SETTINGS_SAVE_WORDS.uncertain);
}

function unreachableWords(writer: Pr7Writer, error: DropshipApiError): string {
  if ((writer === "W2" || writer === "W10") && error.code !== null && CARD_SHELLZ_SHIPPING_CODE.test(error.code)) {
    return listingSetupSaveErrorMessage(error, LISTING_SETTINGS_SAVE_WORDS.uncertain, writer === "W10" ? "ship_from_repair" : "save");
  }
  return LISTING_SETTINGS_SAVE_WORDS.unreachable;
}

function refusedWords(writer: Pr7Writer, error: DropshipApiError, options: ClassifyWriteFailureOptions): string {
  const code = error.code;
  if (code === "DROPSHIP_IDEMPOTENCY_CONFLICT" || code === "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT") {
    return LISTING_SETTINGS_SAVE_WORDS.keyReused;
  }
  switch (writer) {
    case "W1":
      if (code === "DROPSHIP_PRICING_REVIEW_NOT_FOUND") return LISTING_SETTINGS_SAVE_WORDS.pricingReviewGone;
      if (code === "DROPSHIP_PRICING_REVIEW_BLOCKED") return LISTING_SETTINGS_SAVE_WORDS.pricingReviewBlocked;
      break;
    case "W2":
    case "W10":
      if (code === "DROPSHIP_EBAY_STORE_SHELF_DEFAULT_INVALID") return LISTING_SETTINGS_SAVE_WORDS.shelfGone;
      if (code === "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE") return LISTING_SETTINGS_SAVE_WORDS.shippingPolicyIncompatible;
      // Card Shellz shipping or warehouse setup the vendor can't fix: plain words and a reference.
      if (code !== null && CARD_SHELLZ_SHIPPING_CODE.test(code)) {
        return listingSetupSaveErrorMessage(error, error.message, writer === "W10" ? "ship_from_repair" : "save");
      }
      break;
    case "W3":
      if (code === "DROPSHIP_EBAY_CATEGORY_NOT_FOUND") return LISTING_SETTINGS_SAVE_WORDS.pickFinalCategory;
      if (code === "DROPSHIP_EBAY_CATEGORY_RULE_INVALID") {
        return refusesAnOlderRule(error, options.pickedEbayCategoryId ?? null)
          ? LISTING_SETTINGS_SAVE_WORDS.olderCategoryRule
          : LISTING_SETTINGS_SAVE_WORDS.pickFinalCategory;
      }
      break;
    case "W4":
      // The server's 413 comes from the body parser and carries no code.
      if (error.status === HTTP_PAYLOAD_TOO_LARGE) return LISTING_SETTINGS_SAVE_WORDS.tooLarge;
      if (code === "DROPSHIP_CONTENT_INVALID_INPUT") return LISTING_SETTINGS_SAVE_WORDS.descriptionInvalid;
      break;
    case "W9":
      // DROPSHIP_LISTING_PRICE_WOULD_BE_LOST and …_OUTSIDE_LIMIT keep the server's words
      // (dropship-listing-price-service.ts, refusalMessage). Only they say whether the size
      // would have no price at all or a price a Card Shellz limit refuses, and name that limit.
      // Under owner decision L1 a cleared price falls back to retail, so the limit case is the
      // usual one; fixed words here would tell the vendor the wrong reason.
      break;
  }
  return error.message;
}

/** A W3 refusal names a category (context.categoryId) other than the one the vendor picked. */
function refusesAnOlderRule(error: DropshipApiError, pickedCategoryId: string | null): boolean {
  const named = error.context?.categoryId;
  if (typeof named !== "string" && typeof named !== "number") return false;
  return pickedCategoryId === null || String(named) !== pickedCategoryId;
}

// ---------------------------------------------------------------------------
// Failed saves of the PR 9 writers (plan PR 10, 3.3, 4.7, D7, D8)
// ---------------------------------------------------------------------------

type Pr9Writer = "W5" | "W6";
const PR9_WRITERS: ReadonlySet<ListingSettingsWriter> = new Set<Pr9Writer>(["W5", "W6"]);

function isPr9Writer(writer: ListingSettingsWriter): writer is Pr9Writer {
  return PR9_WRITERS.has(writer);
}

interface Pr9WriterCodes {
  conflict: ReadonlySet<string>;
  /**
   * 4xx codes the write routes list that this writer can't answer to a
   * request this page builds (3.3 row 22): refused with the "couldn't be
   * saved" words, never `uncertain`.
   */
  cannotHappen: ReadonlySet<string>;
}

/** Each PR 9 writer's own codes (dropship-listing-setting-write-errors.ts lists every code with its status). */
const PR9_WRITER_CODES: Readonly<Record<Pr9Writer, Pr9WriterCodes>> = {
  W5: {
    conflict: new Set(["DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT"]),
    cannotHappen: new Set([
      // This page's W5 never carries a price, a size price or the prices shown (D1).
      "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", "DROPSHIP_PRICING_RULES_NOT_CONFIGURED",
      "DROPSHIP_LISTING_PRICE_RELEASE_LIMIT", "DROPSHIP_LISTING_PRICES_MOVED", "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT",
      "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE",
      // Other writers' refusals: W5 is not refused by older group rules (P21) and checks no category or review.
      "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT", "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT",
      "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND", "DROPSHIP_PRICING_REVIEW_NOT_FOUND",
    ]),
  },
  W6: {
    // The bulk writer's compare-and-set, one stale product refusing all (`I/dropship-product-listing-settings.repository.ts`
    // assertExpectedRevisions), with `conflictCount` (plan 6.5).
    conflict: new Set(["DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT"]),
    cannotHappen: new Set([
      // W6 never carries a price, not even null (D1; `SW` productsBulkPatchInputSchema), so no price check can refuse it.
      "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", "DROPSHIP_PRICING_RULES_NOT_CONFIGURED",
      "DROPSHIP_LISTING_PRICE_RELEASE_LIMIT", "DROPSHIP_LISTING_PRICES_MOVED", "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT",
      "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE",
      // Other writers' refusals: W6 checks no older group rules, no category and no review
      // (`S/application/dropship-listing-products-bulk-service.ts`).
      "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT", "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT",
      "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND", "DROPSHIP_PRICING_REVIEW_NOT_FOUND",
    ]),
  },
};

const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
const HTTP_INTERNAL_ERROR = 500;
const BUSY_CODE = "DROPSHIP_LISTING_SETTINGS_BUSY";
/** BUSY reasons that are refused before anything is written: the same key may be sent again (D7a). */
const BUSY_HEAVY_WRITE = "heavy_write_in_progress";
const BUSY_REQUEST_KEY_CHANGED = "request_key_changed";
/**
 * 500s with their own code: a broken contract or a replay that can't be
 * answered. The same key would repeat them forever, so they are final (D7c);
 * REPLAY_INCOMPLETE follows a recorded save, so the words never say nothing was saved.
 */
const FATAL_CODES: ReadonlySet<string> = new Set([
  "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED",
  "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE",
  "DROPSHIP_LISTING_PRICE_INVARIANT_FAILED",
]);
/** eBay's token step answers 503 before the write transaction opens (3.3 row 7). */
const EBAY_TOKEN_CODES: ReadonlySet<string> = new Set([
  "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", "DROPSHIP_EBAY_REFRESH_LOCK_UNAVAILABLE", "DROPSHIP_CREDENTIAL_CHANGED",
  "DROPSHIP_EBAY_TOKEN_REFRESH_INVALID_RESPONSE", "DROPSHIP_EBAY_OAUTH_NOT_CONFIGURED",
]);
/** Another eBay site: the banner says so (3.3 row 12). */
const OTHER_SITE_CODES: ReadonlySet<string> = new Set([
  "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED", "DROPSHIP_EBAY_CATEGORY_MARKETPLACE_UNSUPPORTED",
]);
const SIGN_IN_REQUIRED_CODE = "DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED";
/**
 * Blocks a banner explains (3.3 row 16). The PR 9 gate names the vendor, .ops
 * or store status in `reason`, which the banner does not read: the step reads
 * the account, summary and setup again and the banner follows from them.
 */
const PR9_BLOCKED_CODES: ReadonlySet<string> = new Set([
  "DROPSHIP_LISTING_VENDOR_BLOCKED", "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", "DROPSHIP_LISTING_STORE_BLOCKED",
  "DROPSHIP_STORE_CONNECTION_REQUIRED", "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED", "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_TOKEN_REQUIRED",
  "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY",
  "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED", "DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED",
  "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED",
  "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED", "DROPSHIP_EBAY_STORE_CATEGORIES_ACCESS_DENIED", "DROPSHIP_EBAY_CATEGORIES_ACCESS_DENIED",
]);
const UNREADABLE_REQUEST_CODES: ReadonlySet<string> = new Set([
  "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT", "DROPSHIP_LISTING_SETTINGS_BULK_INVALID", "DROPSHIP_REQUEST_JSON_INVALID",
]);
const IDEMPOTENCY_CONFLICT_CODE = "DROPSHIP_IDEMPOTENCY_CONFLICT";
const PRODUCT_NOT_FOUND_CODE = "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND";
const TOO_LARGE_CODE = "DROPSHIP_LISTING_SETTINGS_TOO_LARGE";
const BULK_TOO_LARGE_CODE = "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE";
const STORE_TEXT_LIMIT = "store_text_limit";

/** The fields a refusal names, once each (`fields` from the sign-in refusal, `invalidFields` from eBay's value checks). */
function namedFields(error: DropshipApiError, also: readonly string[] = []): string[] {
  const named = [error.context?.invalidFields, error.context?.fields]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .filter((name): name is string => typeof name === "string");
  return [...new Set([...named, ...also])];
}

function contextReason(error: DropshipApiError): string | null {
  const reason = error.context?.reason;
  return typeof reason === "string" ? reason : null;
}

/** How many products a W6 version conflict names in all (`conflictCount`); null when the answer gives none. Never the list's length (`WE:93`). */
function conflictCountOf(error: DropshipApiError): number | null {
  const count = error.context?.conflictCount;
  return typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? count : null;
}

/**
 * A PR 9 writer's failed save (plan 3.3, rules top to bottom; 4.7 for W5, 6.5 for W6).
 * Classified by code, not status: a status with no code the table names is a
 * gateway's or a proxy's, which may follow a commit, so a 5xx without a known
 * code is `uncertain`. `TOO_LARGE` is a refusal here, never a banner (D8).
 */
function classifyPr9WriteFailure(writer: Pr9Writer, error: unknown, options: ClassifyWriteFailureOptions): WriteFailure {
  const words = LISTING_SETTINGS_EDIT_WORDS;
  if (!(error instanceof DropshipApiError)) {
    // No answer arrived (row 9): the save may have happened.
    return { phase: "uncertain", message: LISTING_SETTINGS_SAVE_WORDS.uncertain, code: null, status: null, fields: [] };
  }
  const { status, code } = error;
  const codes = PR9_WRITER_CODES[writer];
  const failure = (phase: WriteFailurePhase, message: string, also: readonly string[] = []): WriteFailure =>
    ({ phase, message, code, status, fields: namedFields(error, also) });

  if (status === HTTP_TOO_MANY_REQUESTS) return failure("rate_limited", LISTING_SETTINGS_SAVE_WORDS.rateLimited);
  if (status === HTTP_UNAUTHORIZED && code === "DROPSHIP_AUTH_REQUIRED") return failure("refused", words.signedOut);
  if (code === BUSY_CODE) {
    // A busy answer without a reason is a lost connection, which may follow a cut-off COMMIT (D7a).
    const reason = contextReason(error);
    if (reason === BUSY_HEAVY_WRITE) return failure("unreachable", words.busyHeavy);
    if (reason === BUSY_REQUEST_KEY_CHANGED) return failure("unreachable", words.busyKeyChanged);
    return failure("uncertain", LISTING_SETTINGS_SAVE_WORDS.uncertain);
  }
  if ((status === HTTP_BAD_GATEWAY || status === HTTP_SERVICE_UNAVAILABLE) && code !== null && CARD_SHELLZ_SHIPPING_CODE.test(code)) {
    // Card Shellz shipping, read before the write (3.3 row 6): its own words and a reference.
    return failure("unreachable", listingSetupSaveErrorMessage(error, LISTING_SETTINGS_SAVE_WORDS.uncertain, "save"));
  }
  if ((status === HTTP_BAD_GATEWAY && code !== null) || (status === HTTP_SERVICE_UNAVAILABLE && code !== null && EBAY_TOKEN_CODES.has(code))) {
    // eBay runs before the write transaction (3.3 row 7).
    return failure("unreachable", LISTING_SETTINGS_SAVE_WORDS.unreachable);
  }
  if (status === HTTP_INTERNAL_ERROR && code !== null && FATAL_CODES.has(code)) return failure("refused", words.fatal);
  if (status >= 500) return failure("uncertain", LISTING_SETTINGS_SAVE_WORDS.uncertain);
  if (status < 400) return failure("uncertain", LISTING_SETTINGS_SAVE_WORDS.uncertain);

  if (code !== null && codes.conflict.has(code)) {
    // W6: "3 of the selected products changed in another window." (plan 6.5), as the server counts them.
    const count = writer === "W6" ? conflictCountOf(error) : null;
    return failure("conflict", count === null ? LISTING_SETTINGS_SAVE_WORDS.conflict : bulkConflictWords(count));
  }
  if (code === IDEMPOTENCY_CONFLICT_CODE) return failure("refused", LISTING_SETTINGS_SAVE_WORDS.keyReused);
  if (code !== null && OTHER_SITE_CODES.has(code)) return failure("blocked", LISTING_SETTINGS_SAVE_WORDS.blocked);
  if (status === HTTP_CONFLICT && code !== null && CARD_SHELLZ_SHIPPING_CODE.test(code)) {
    // Card Shellz can't back a new shipping policy yet (3.3 row 11): plain words and a reference.
    return failure("refused", listingSetupSaveErrorMessage(error, error.message, "save"), ["shippingPolicy"]);
  }
  if (status === HTTP_PAYLOAD_TOO_LARGE) return failure("refused", words.tooBig);
  if (code !== null && UNREADABLE_REQUEST_CODES.has(code)) return failure("refused", words.invalid);
  if (code === SIGN_IN_REQUIRED_CODE) return failure("blocked", LISTING_SETTINGS_SAVE_WORDS.blocked);
  if (code !== null && PR9_BLOCKED_CODES.has(code)) return failure("blocked", LISTING_SETTINGS_SAVE_WORDS.blocked);
  switch (code) {
    case "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID":
      return failure("refused", words.policyGone);
    case "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE":
      return failure("refused", LISTING_SETTINGS_SAVE_WORDS.shippingPolicyIncompatible, ["shippingPolicy"]);
    case "DROPSHIP_EBAY_CATEGORY_RULE_INVALID":
      return failure("refused", contextReason(error) === "not_leaf" ? LISTING_SETTINGS_SAVE_WORDS.pickFinalCategory : words.categoryGone,
        ["ebayCategory"]);
    case "DROPSHIP_EBAY_STORE_CATEGORY_INVALID":
      return failure("refused", contextReason(error) === "too_long" ? words.shelfTooLong : LISTING_SETTINGS_SAVE_WORDS.shelfGone,
        ["storeShelf"]);
    case TOO_LARGE_CODE:
      return failure("refused", contextReason(error) === STORE_TEXT_LIMIT ? words.storeTextLimit : error.message);
    case BULK_TOO_LARGE_CODE:
      // W6's text budget (plan 6.5; `S/application/dropship-listing-setting-write-support.ts` listingSettingBulkTooLarge).
      if (writer === "W6") return failure("refused", LISTING_SETTINGS_BULK_WORDS.tooMuchText);
      break;
    case PRODUCT_NOT_FOUND_CODE:
      if (writer === "W5") return failure("refused", productNotFoundWords(options.storeName ?? ""));
      // W6: a product Card Shellz deleted since the ids read, with a value set (the writer's foreign key, plan 6.5).
      // A conflict, not a refusal: the same products would be refused again under every key, so the sheet offers
      // Load latest, whose new ids read no longer lists the product (CLAUDE.md §6: never retry a permanent error).
      return failure("conflict", LISTING_SETTINGS_BULK_WORDS.productGone);
    default:
      break;
  }
  if (code !== null && codes.cannotHappen.has(code)) return failure("refused", words.invalid);
  return failure("refused", error.message);
}

/**
 * The PR 9 write gate's refusals (`authorizeListingSettingWrite`, and the
 * wrapper's store check before it): the vendor, .ops, the store's status or
 * platform. Every PR 9 writer runs the gate before its replay probe, in the
 * preflight and in the transaction (`S/application/dropship-listing-product-settings-service.ts`
 * `readPreflight`, `write`), so one of these says nothing about a save sent
 * earlier with the same key. Every other block (eBay's sign-in or access, the
 * eBay site) is asked only for a key not used yet, so it does.
 */
const PR9_GATE_CODES: ReadonlySet<string> = new Set([
  "DROPSHIP_STORE_CONNECTION_REQUIRED", "DROPSHIP_LISTING_VENDOR_BLOCKED", "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED",
  "DROPSHIP_LISTING_STORE_BLOCKED", "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY",
]);

/**
 * A Check again keeps its doubt (D7b): a resend of an unconfirmed save that
 * is answered "not now" (eBay or Card Shellz not answering, busy, too many
 * saves) or by the write gate (a paused account, .ops or store, refused before
 * the replay probe) says nothing about the first send, which may have saved.
 * It stays `uncertain`, locked with the same key, and the words say why it
 * couldn't be checked; after a gate refusal the banner says why, and [Check
 * again] comes back with the right. Any other answer stands as it is. For the
 * PR 9 writers' runners, which still hand a gate refusal to the banner.
 */
export function failureAfterUnconfirmed(wasUncertain: boolean, failure: WriteFailure): WriteFailure {
  if (!wasUncertain) return failure;
  const words = LISTING_SETTINGS_EDIT_WORDS;
  if (failure.phase === "blocked" && failure.code !== null && PR9_GATE_CODES.has(failure.code)) {
    return { ...failure, phase: "uncertain", message: LISTING_SETTINGS_SAVE_WORDS.uncertain };
  }
  if (failure.phase !== "unreachable" && failure.phase !== "rate_limited") return failure;
  return {
    ...failure,
    phase: "uncertain",
    message: failure.phase === "rate_limited" ? words.stillUnconfirmedRateLimited : words.stillUnconfirmed,
  };
}

// ---------------------------------------------------------------------------
// The bottom bar (R:93, R:597)
// ---------------------------------------------------------------------------

/**
 * The leave-guard id of the step's draft is this prefix and the store id.
 * Every other guard id on step 2 is an older panel's (plan 4.1).
 */
export const LISTING_SETTINGS_GUARD_ID_PREFIX = "listing-settings:";

/** How many leave-guard drafts belong to the older panels under "Older settings". */
export function countOlderSettingsDrafts(drafts: readonly { id: string }[]): number {
  return drafts.filter((draft) => !draft.id.startsWith(LISTING_SETTINGS_GUARD_ID_PREFIX)).length;
}

export interface ListingSettingsBarInput {
  /** The step's draft, if any. */
  draft: Pick<ListingSettingsDraft, "place" | "changes" | "phase"> | null;
  /** Drafts the old panels under "Older settings" hold. */
  olderDraftCount: number;
  /** Any save on the page still in flight (the page's pending-save counter). */
  saving: boolean;
}

/** "All saved", "Not saved · 2 changes in Price", "Not saved · changes in Older settings" or "Saving…". */
export function describeListingSettingsBar({ draft, olderDraftCount, saving }: ListingSettingsBarInput): string {
  if (saving || draft?.phase === "saving") return LISTING_SETTINGS_SAVE_WORDS.saving;
  if (draft !== null && isDraftDirty(draft)) {
    return `Not saved · ${draft.changes} ${draft.changes === 1 ? "change" : "changes"} in ${draft.place}`;
  }
  if (olderDraftCount > 0) return "Not saved · changes in Older settings";
  return "All saved";
}
