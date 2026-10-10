import type { QueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import {
  ebayCategoryRulesStateSchema,
  ebayCategorySchema,
  saveEbayCategoryRulesInputSchema,
  saveEbayCategoryRulesResponseSchema,
  type EbayCategory,
  type EbayCategoryRulesDraft,
  type EbayCategoryRulesState,
  type SaveEbayCategoryRulesInput,
} from "@shared/dropship/ebay-category-rules";
import {
  contentProfileSchema,
  contentProfileStateSchema,
  MAX_TEMPLATE_TEXT_LENGTH,
  saveContentProfileInputSchema,
  saveContentProfileResponseSchema,
  type ContentProfile,
  type ContentProfileState,
  type SaveContentProfileInput,
} from "@shared/dropship/listing-content";
import {
  checkEbayCategoryDraft,
  ebayCategoryRulesEndpoint,
  editorDraftFromState,
  setEbayDefaultCategory,
} from "./dropship-ebay-category-rules";
import {
  classifyWriteFailure,
  LISTING_SETTINGS_KEY_PREFIXES,
  LISTING_SETTINGS_SAVE_WORDS,
  sameDraftValue,
  type ClassifyWriteFailureOptions,
  type DraftValue,
  type ListingSettingsDraft,
  type WriteFailure,
} from "./dropship-listing-settings-drafts";
import { LISTING_SETTINGS_OFF_CONTRACT, ListingSettingsReadError } from "./dropship-listing-settings";
import type { ListingSettingsRight } from "./dropship-listing-settings-access";
import { fetchJson, putJson, queryErrorMessage } from "./dropship-ops-surface";

/**
 * The eBay category (W3) and Description (W4) rows of the Store defaults card
 * (Listing settings PR 7, sub-part 2B): their reads, the requests they send,
 * the words only these rows use, and how a save runs.
 *
 * Both writers replace a whole document: W3 the eBay category rules (the store
 * default plus every older rule), W4 the description profile (the store text
 * plus every older group). These rows change only the store default, so each
 * request carries the rest of the document exactly as the server last gave it
 * (writers.md 4.6, 5.2).
 *
 * A request's signature is its body without the request key, as JSON. The
 * draft keeps the signature with the key, so "Check again" rebuilds the very
 * request it sent before, even after the row was left and opened again.
 *
 * No React here. The clock and the request keys come from the draft provider.
 * Words marked "interim" are not in the design record; they live here so a
 * later PR can change them in one place.
 */

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** The eBay category row and its editor (R:580, R:438). */
export const EBAY_CATEGORY_DEFAULT_WORDS = Object.freeze({
  cardShellzPicks: "Card Shellz picks one for each product (recommended)",
  cardShellzPicksHelp: "Each product uses the eBay category Card Shellz chose for it.",
  oneCategory: "One eBay category for every product",
  /** The phone row's value when Card Shellz picks (R:438). */
  cardShellzPicksShort: "Card Shellz picks",
  // Interim: the picker's name and its buttons inside this editor.
  pickerLabel: "eBay category for every product",
  pickCategory: "Pick an eBay category",
  pickAnother: "Pick another",
  // Interim: a saved older rule this editor can't send back (it never should happen).
  olderRuleInvalid: "One of your older eBay category rules needs a fix. Open it under Older settings.",
} as const);

/** The Description row and its editor (R:582). */
export const DESCRIPTION_DEFAULT_WORDS = Object.freeze({
  textAbove: "Text above (optional)",
  mainText: "Card Shellz writes the main text for each product.",
  textBelow: "Text below (optional)",
  invalid: LISTING_SETTINGS_SAVE_WORDS.descriptionInvalid,
  // Interim: a saved older description group this editor can't send back (it never should happen).
  olderRuleInvalid: "One of your older description rules needs a fix. Open it under Older settings.",
} as const);

/** Words both editors share that the framework doesn't give. All interim. */
export const STORE_DEFAULT_EDITOR_WORDS = Object.freeze({
  /** While the row's saved document loads. */
  loading: "Checking…",
  /** The row's saved document couldn't be read; nothing can be saved until it is. */
  readFailed: "Couldn't load what's saved. Try again.",
  tryAgain: LISTING_SETTINGS_SAVE_WORDS.tryAgain,
  /** Beside a field the vendor and another window both changed (R:542). */
  bothChanged: "Also changed in another window",
  /** A save the page held back because another listing action is running. */
  busy: "Wait for the current listing action to finish, then save again.",
} as const);

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

/** "12 / 4,000" (R:582). Counts what the server counts: UTF-16 units of the text as typed. */
export function descriptionLengthWords(text: string): string {
  return `${NUMBER_FORMAT.format(text.length)} / ${NUMBER_FORMAT.format(MAX_TEMPLATE_TEXT_LENGTH)}`;
}

/** The phone row's eBay category value (R:438): "Card Shellz picks", or the category's name. */
export function storeDefaultEbayCategoryCompactValue(category: { categoryName: string } | null): string {
  if (category === null) return EBAY_CATEGORY_DEFAULT_WORDS.cardShellzPicksShort;
  return category.categoryName.trim() || EBAY_CATEGORY_DEFAULT_WORDS.oneCategory;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A request this page built that is not one its writer takes. A bug, never the vendor's doing. */
export const STORE_DEFAULT_REQUEST_INVALID = "DROPSHIP_LISTING_SETTINGS_STORE_DEFAULT_REQUEST_INVALID";
/** A saved older rule or group the row would have to send back, and can't. */
export const STORE_DEFAULT_OLDER_RULE_INVALID = "DROPSHIP_LISTING_SETTINGS_OLDER_RULE_INVALID";
/** The vendor's description text breaks the contract (too long, control characters). */
export const STORE_DEFAULT_DESCRIPTION_INVALID = "DROPSHIP_LISTING_SETTINGS_DESCRIPTION_INVALID";

export class StoreDefaultRequestError extends Error {
  readonly code: typeof STORE_DEFAULT_REQUEST_INVALID;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(message: string, context: Record<string, unknown>) {
    super(message);
    this.name = "StoreDefaultRequestError";
    this.code = STORE_DEFAULT_REQUEST_INVALID;
    this.context = Object.freeze({ ...context });
  }
}

/** At most this many contract issues are kept on an error: enough to find the field, never the values. */
const MAX_REPORTED_ISSUES = 5;

function issuePaths(error: z.ZodError): string[] {
  return error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => issue.path.join("."));
}

// ---------------------------------------------------------------------------
// Reads (plan 4.2, D8)
// ---------------------------------------------------------------------------

/** Whether a row editor's own read may run: only while its editor is open and its writer would take a save (D8). */
export interface StoreDefaultReadGate {
  editorOpen: boolean;
  right: Pick<ListingSettingsRight, "editable">;
}

function isStoreId(storeConnectionId: number): boolean {
  return Number.isSafeInteger(storeConnectionId) && storeConnectionId > 0;
}

export function storeDefaultReadEnabled(storeConnectionId: number, gate: StoreDefaultReadGate): boolean {
  return isStoreId(storeConnectionId) && gate.editorOpen && gate.right.editable;
}

type ContentRead = "ebay_category_rules" | "content_profile";

async function readContentState<T>(
  read: ContentRead,
  url: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  signal: AbortSignal | undefined,
): Promise<T> {
  // fetchJson throws a DropshipApiError (status, code, context) for a refused or failed request.
  const parsed = schema.safeParse(await fetchJson<unknown>(url, { signal }));
  if (parsed.success) return parsed.data;
  throw new ListingSettingsReadError({
    code: LISTING_SETTINGS_OFF_CONTRACT,
    message: "This page couldn't read Card Shellz's answer. Reload the page and try again.",
    context: { read, issues: issuePaths(parsed.error) },
  });
}

/** The eBay category rules read, under the key the old category panel uses too, so it is one cached read. */
export function ebayCategoryRulesQueryKey(storeConnectionId: number) {
  return [ebayCategoryRulesEndpoint(storeConnectionId)] as const;
}

export function storeDefaultEbayCategoryRulesQueryOptions(storeConnectionId: number, gate: StoreDefaultReadGate) {
  return {
    queryKey: ebayCategoryRulesQueryKey(storeConnectionId),
    queryFn: ({ signal }: { signal?: AbortSignal }): Promise<EbayCategoryRulesState> =>
      readContentState("ebay_category_rules", ebayCategoryRulesEndpoint(storeConnectionId), ebayCategoryRulesStateSchema, signal),
    enabled: storeDefaultReadEnabled(storeConnectionId, gate),
    // Opening the editor reads the saved rules again, so it starts from what is saved now.
    staleTime: 0,
    retry: false,
  } as const;
}

export function contentProfileEndpoint(storeConnectionId: number): string {
  return `/api/dropship/listings/stores/${storeConnectionId}/content-profile`;
}

/** The description profile read. The old templates panel reads it outside React Query, so this key is the step's own. */
export function contentProfileQueryKey(storeConnectionId: number) {
  return [contentProfileEndpoint(storeConnectionId)] as const;
}

export function storeDefaultContentProfileQueryOptions(storeConnectionId: number, gate: StoreDefaultReadGate) {
  return {
    queryKey: contentProfileQueryKey(storeConnectionId),
    queryFn: ({ signal }: { signal?: AbortSignal }): Promise<ContentProfileState> =>
      readContentState("content_profile", contentProfileEndpoint(storeConnectionId), contentProfileStateSchema, signal),
    enabled: storeDefaultReadEnabled(storeConnectionId, gate),
    staleTime: 0,
    retry: false,
  } as const;
}

/**
 * Reads a row's saved document again after a save, a conflict or [Reload]
 * (D9: never from a save's answer, which may be an older replay). Any read in
 * flight is cancelled first, so its older answer can't land afterwards.
 * Throws when the read fails.
 */
export async function rereadStoreDefault<T>(
  queryClient: Pick<QueryClient, "cancelQueries" | "fetchQuery">,
  options: { queryKey: readonly unknown[]; queryFn: (context: { signal?: AbortSignal }) => Promise<T> },
): Promise<T> {
  await queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
  return queryClient.fetchQuery({
    queryKey: options.queryKey,
    queryFn: ({ signal }) => options.queryFn({ signal }),
    staleTime: 0,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Draft values
// ---------------------------------------------------------------------------

/** The eBay category editor's one field: the store default category, or null when Card Shellz picks. */
export type EbayCategoryDefaultValue = { readonly defaultCategory: EbayCategory | null };

/** The Description editor's two fields, as typed. */
export type DescriptionDefaultValue = { readonly introduction: string; readonly footer: string };

export function ebayCategoryDefaultValue(state: EbayCategoryRulesState | null | undefined): EbayCategoryDefaultValue {
  const category = state?.profile?.defaultCategory ?? null;
  return { defaultCategory: category === null ? null : { categoryId: category.categoryId, categoryName: category.categoryName, path: [...category.path] } };
}

export function descriptionDefaultValue(state: ContentProfileState | null | undefined): DescriptionDefaultValue {
  const template = state?.profile?.defaultTemplate;
  return { introduction: template?.introduction ?? "", footer: template?.footer ?? "" };
}

/** The draft's value as this editor stores it; null when it is not one (another editor's draft). */
export function readEbayCategoryDefaultValue(value: DraftValue): EbayCategoryDefaultValue | null {
  const parsed = ebayCategorySchema.nullable().safeParse(value.defaultCategory);
  return parsed.success ? { defaultCategory: parsed.data } : null;
}

export function readDescriptionDefaultValue(value: DraftValue): DescriptionDefaultValue | null {
  return typeof value.introduction === "string" && typeof value.footer === "string"
    ? { introduction: value.introduction, footer: value.footer }
    : null;
}

/**
 * Whether what is saved now moved away from what the draft started from
 * (another window or the older panel saved). Then the vendor is shown the
 * conflict before anything is sent, as for a 409, so a change made elsewhere
 * is never overwritten unseen.
 */
export function storeDefaultBaseMoved(base: DraftValue, latest: DraftValue): boolean {
  return !sameDraftValue(base, latest);
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export type PreparedStoreDefaultSave<Body> =
  | { ok: true; body: Body; signature: string }
  | { ok: false; code: typeof STORE_DEFAULT_OLDER_RULE_INVALID | typeof STORE_DEFAULT_DESCRIPTION_INVALID; message: string };

export type EbayCategoryDefaultSaveBody = { expectedRevisionId: number | null; draft: EbayCategoryRulesDraft };
export type DescriptionDefaultSaveBody = { expectedRevisionId: number | null; profile: ContentProfile };

/**
 * The W3 body for a new store default: every saved rule goes back in saved
 * order (order is precedence) in the shape the save takes, `{ id, name,
 * scope, categoryId }`. The saved rules carry their eBay names, which the
 * save refuses, so they are converted with the old panel's own helpers
 * (checker change 3). `expectedRevisionId` is the revision `state` was read at.
 */
export function prepareEbayCategoryDefaultSave(
  state: EbayCategoryRulesState,
  value: EbayCategoryDefaultValue,
): PreparedStoreDefaultSave<EbayCategoryDefaultSaveBody> {
  const check = checkEbayCategoryDraft(setEbayDefaultCategory(editorDraftFromState(state), value.defaultCategory));
  if (!check.ok) return { ok: false, code: STORE_DEFAULT_OLDER_RULE_INVALID, message: EBAY_CATEGORY_DEFAULT_WORDS.olderRuleInvalid };
  const body: EbayCategoryDefaultSaveBody = { expectedRevisionId: state.revisionId, draft: check.draft };
  return { ok: true, body, signature: JSON.stringify(body) };
}

/**
 * The W4 body for new store text: the store text as typed (the server trims
 * it and normalizes line breaks, so this sends it the same way) and every
 * saved group unchanged.
 */
export function prepareDescriptionDefaultSave(
  state: ContentProfileState,
  value: DescriptionDefaultValue,
): PreparedStoreDefaultSave<DescriptionDefaultSaveBody> {
  const parsed = contentProfileSchema.safeParse({
    defaultTemplate: { introduction: value.introduction, footer: value.footer },
    groups: state.profile?.groups ?? [],
  });
  if (!parsed.success) {
    const vendorText = parsed.error.issues.every((issue) => issue.path[0] === "defaultTemplate");
    return vendorText
      ? { ok: false, code: STORE_DEFAULT_DESCRIPTION_INVALID, message: DESCRIPTION_DEFAULT_WORDS.invalid }
      : { ok: false, code: STORE_DEFAULT_OLDER_RULE_INVALID, message: DESCRIPTION_DEFAULT_WORDS.olderRuleInvalid };
  }
  const body: DescriptionDefaultSaveBody = { expectedRevisionId: state.revisionId, profile: parsed.data };
  return { ok: true, body, signature: JSON.stringify(body) };
}

function bodyFromSignature(writer: "W3" | "W4", signature: string): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(signature);
  } catch (error) {
    throw new StoreDefaultRequestError("This save couldn't be rebuilt. Reload the page and try again.",
      { writer, reason: "signature_not_json", detail: error instanceof Error ? error.name : "unknown" });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new StoreDefaultRequestError("This save couldn't be rebuilt. Reload the page and try again.", { writer, reason: "signature_not_object" });
  }
  return body as Record<string, unknown>;
}

/** The W3 request for a signature and its key, checked against the save's own schema. */
export function ebayCategoryDefaultSaveInput(signature: string, idempotencyKey: string): SaveEbayCategoryRulesInput {
  const parsed = saveEbayCategoryRulesInputSchema.safeParse({ ...bodyFromSignature("W3", signature), idempotencyKey });
  if (parsed.success) return parsed.data;
  throw new StoreDefaultRequestError("This save couldn't be rebuilt. Reload the page and try again.",
    { writer: "W3", reason: "off_contract", issues: issuePaths(parsed.error) });
}

/** The W4 request for a signature and its key, checked against the save's own schema. */
export function descriptionDefaultSaveInput(signature: string, idempotencyKey: string): SaveContentProfileInput {
  const parsed = saveContentProfileInputSchema.safeParse({ ...bodyFromSignature("W4", signature), idempotencyKey });
  if (parsed.success) return parsed.data;
  throw new StoreDefaultRequestError("This save couldn't be rebuilt. Reload the page and try again.",
    { writer: "W4", reason: "off_contract", issues: issuePaths(parsed.error) });
}

/** PUT …/ebay-category-rules. Resolves with the server's answer, unread (D9). */
export function sendEbayCategoryDefaultSave(storeConnectionId: number, input: SaveEbayCategoryRulesInput): Promise<unknown> {
  return putJson<unknown>(ebayCategoryRulesEndpoint(storeConnectionId), input);
}

/** PUT …/content-profile. Not through useContentDraft, which locks the draft on any 4xx (useContentDraft.ts:88). */
export function sendDescriptionDefaultSave(storeConnectionId: number, input: SaveContentProfileInput): Promise<unknown> {
  return putJson<unknown>(contentProfileEndpoint(storeConnectionId), input);
}

/** A 2xx answer to a W3 save still has to match its contract. Throws when it doesn't. */
export function checkEbayCategoryDefaultAnswer(answer: unknown): void {
  saveEbayCategoryRulesResponseSchema.parse(answer);
}

export function checkDescriptionDefaultAnswer(answer: unknown): void {
  saveContentProfileResponseSchema.parse(answer);
}

// ---------------------------------------------------------------------------
// The editor's footer (plan 4.5)
// ---------------------------------------------------------------------------

/**
 * What the main button does:
 * - `save`: build a request from the draft (a new key unless it is the same request);
 * - `resend`: send the draft's last request again with its key (unconfirmed, eBay unreachable, too many saves);
 * - `load_latest`: read what is saved now and put the vendor's changes on top (a conflict);
 * - `none`: a save is in flight.
 */
export type StoreDefaultEditorAction = "save" | "resend" | "load_latest" | "none";

export interface StoreDefaultEditorFooter {
  primary: { label: string; action: StoreDefaultEditorAction; disabled: boolean };
  cancelDisabled: boolean;
  /** The draft's words: an alert for a failed save, a status line otherwise. */
  message: { text: string; tone: "alert" | "status" } | null;
}

export interface StoreDefaultEditorFooterInput {
  draft: Pick<ListingSettingsDraft, "phase" | "changes" | "message" | "attempt"> | null;
  /** The row's saved document has answered, so a request can be built. */
  ready: boolean;
  /** The writer would take a save (plan 4.3). */
  editable: boolean;
  /** Another listing action is running, so the page holds saves back, or the editor is reading what's saved. */
  busy: boolean;
  /** The value can be sent (the eBay category editor needs a pick for "One eBay category"). */
  complete: boolean;
}

const FAILURE_PHASES: ReadonlySet<string> = new Set([
  "uncertain", "unreachable", "conflict", "refused", "rate_limited", "reload_required", "blocked", "saved_view_stale",
]);

export function storeDefaultEditorFooter(input: StoreDefaultEditorFooterInput): StoreDefaultEditorFooter {
  const { draft } = input;
  const words = LISTING_SETTINGS_SAVE_WORDS;
  const message = draft?.message ? { text: draft.message, tone: FAILURE_PHASES.has(draft.phase) ? "alert" as const : "status" as const } : null;
  const resendable = draft?.attempt != null;
  switch (draft?.phase) {
    case "saving":
      return { primary: { label: words.saving, action: "none", disabled: true }, cancelDisabled: true, message };
    case "uncertain":
      // Locked until settled (R:541): "Check again" sends the same request with the same key, so it can never save twice.
      // It may run while a banner shows, since it only learns what happened.
      return { primary: { label: words.checkAgain, action: "resend", disabled: input.busy || !resendable }, cancelDisabled: true, message };
    case "unreachable":
      return { primary: { label: words.tryAgain, action: "resend", disabled: input.busy || !input.editable || !resendable }, cancelDisabled: false, message };
    case "rate_limited":
      return { primary: { label: words.save, action: "resend", disabled: input.busy || !input.editable || !resendable }, cancelDisabled: false, message };
    case "conflict":
      // Off while the read runs: a second press cancels the first read, whose failure then shows
      // "Couldn't load what's saved" over a load that worked.
      return { primary: { label: words.loadLatest, action: "load_latest", disabled: input.busy }, cancelDisabled: false, message };
    default:
      return {
        primary: {
          label: words.save,
          action: "save",
          disabled: !input.ready || !input.editable || input.busy || !input.complete || draft === null || draft.changes === 0
            || draft.phase === "reload_required",
        },
        cancelDisabled: false,
        message,
      };
  }
}

// ---------------------------------------------------------------------------
// Running a save (plan 4.5, D9)
// ---------------------------------------------------------------------------

/** The page's pending-save counter (D10): it holds back a queue or push while a save runs. */
export interface StoreDefaultSaveCallbacks {
  disabled?: boolean;
  /** Throws when another listing action is running; then nothing is sent. */
  onSaveStarted: () => void;
  onSaveSettled: () => void;
}

/** The draft provider's two save calls (ListingSettingsDraftsProvider). */
export interface StoreDefaultSaveDrafts {
  startSave: (signature: string, keyPrefix: string) => string | null;
  settle: (
    key: string,
    settlement: { kind: "saved" } | { kind: "saved_view_stale" } | { kind: "failure"; failure: WriteFailure },
  ) => void;
}

export interface StoreDefaultSaveRun<Input> {
  writer: "W3" | "W4";
  /** The request to send (a prepared signature, or the draft's last one when resending). */
  signature: string;
  drafts: StoreDefaultSaveDrafts;
  callbacks: StoreDefaultSaveCallbacks;
  /** Builds the request for the signature and key; throws a StoreDefaultRequestError when it can't. */
  request: (signature: string, key: string) => Input;
  send: (input: Input) => Promise<unknown>;
  /** Checks a 2xx answer against its contract; throws when it doesn't match. */
  checkAnswer: (answer: unknown) => void;
  /** Reads the saved document again (D9). */
  reread: () => Promise<unknown>;
  /** The step marks the step 3 preview stale and reads the summary again. */
  onSaved: () => void;
  /** A save refused because of a block a banner explains (plan 4.4); the step decides which banner. */
  onBlocked?: (error: unknown) => void;
  classify?: ClassifyWriteFailureOptions;
}

export type StoreDefaultSaveOutcome =
  | { kind: "not_started"; message: string | null }
  | { kind: "saved"; viewStale: boolean }
  | { kind: "failed"; failure: WriteFailure };

const KEY_PREFIX: Readonly<Record<"W3" | "W4", string>> = {
  W3: LISTING_SETTINGS_KEY_PREFIXES.category,
  W4: LISTING_SETTINGS_KEY_PREFIXES.description,
};

/**
 * One save of a store default, start to finish:
 * 1. the page's pending-save counter starts, or the save does not (another listing action runs);
 * 2. the draft takes its request key: the same request reuses its key;
 * 3. the request is sent; a failure is classified and settles the draft;
 * 4. a 2xx means saved. The saved document is read again (never taken from the
 *    answer, D9); if that read or the answer's contract check fails, the save
 *    still stands and the vendor sees "Saved. We couldn't load the latest view.";
 * 5. the step is told, and the counter always ends once it started.
 */
export async function runStoreDefaultSave<Input>(run: StoreDefaultSaveRun<Input>): Promise<StoreDefaultSaveOutcome> {
  if (run.callbacks.disabled) return { kind: "not_started", message: STORE_DEFAULT_EDITOR_WORDS.busy };
  try {
    run.callbacks.onSaveStarted();
  } catch (error) {
    // Nothing was sent, so the draft is untouched and Save works again once the other action ends.
    return { kind: "not_started", message: queryErrorMessage(error, STORE_DEFAULT_EDITOR_WORDS.busy) };
  }
  try {
    const key = run.drafts.startSave(run.signature, KEY_PREFIX[run.writer]);
    if (key === null) return { kind: "not_started", message: null };

    let input: Input;
    try {
      input = run.request(run.signature, key);
    } catch (error) {
      // Never sent; the next try gets a new key.
      const failure: WriteFailure = {
        phase: "refused",
        message: queryErrorMessage(error, "This save couldn't be built. Reload the page and try again."),
        code: error instanceof StoreDefaultRequestError ? error.code : STORE_DEFAULT_REQUEST_INVALID,
        status: null,
      };
      run.drafts.settle(key, { kind: "failure", failure });
      return { kind: "failed", failure };
    }

    let answer: unknown;
    try {
      answer = await run.send(input);
    } catch (error) {
      const failure = classifyWriteFailure(run.writer, error, run.classify);
      run.drafts.settle(key, { kind: "failure", failure });
      if (failure.phase === "blocked") run.onBlocked?.(error);
      return { kind: "failed", failure };
    }

    let viewStale = false;
    try {
      run.checkAnswer(answer);
      await run.reread();
    } catch {
      // Deliberate: the server answered 2xx, so the save stands. Only the view is out of date,
      // and the draft says so with [Reload] ("saved_view_stale").
      viewStale = true;
    }
    run.drafts.settle(key, { kind: viewStale ? "saved_view_stale" : "saved" });
    run.onSaved();
    return { kind: "saved", viewStale };
  } finally {
    run.callbacks.onSaveSettled();
  }
}

/** The request signature a conflict found before sending settles under (nothing is sent with it). */
const BASE_MOVED_SIGNATURE = "store-default-base-moved";

/**
 * Shows "This changed in another window." when what is saved moved away from
 * the draft's start before anything was sent (`storeDefaultBaseMoved`). The
 * draft goes through the same conflict state as a 409, so [Load latest and
 * keep my changes] works the same way. Returns false when the draft can't
 * take it now (a save in flight).
 */
export function settleConflictBeforeSending(drafts: StoreDefaultSaveDrafts, writer: "W3" | "W4"): boolean {
  const key = drafts.startSave(BASE_MOVED_SIGNATURE, KEY_PREFIX[writer]);
  if (key === null) return false;
  drafts.settle(key, {
    kind: "failure",
    failure: { phase: "conflict", message: LISTING_SETTINGS_SAVE_WORDS.conflict, code: null, status: null },
  });
  return true;
}
