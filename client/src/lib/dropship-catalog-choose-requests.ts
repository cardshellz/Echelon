/**
 * Catalog step 1's requests on one-time picks (step 1 plan S2-5, PR B;
 * PLAN-B v4.1 §12.2, §12.4): the catalog list read 200 rows at a time, the
 * categories, the `idsOnly` reads behind "Check all", a category's box and
 * "Select everything", and the save run from "Save changes" to its outcome.
 *
 * Every answer is read through `readDropshipAnswer` (V11): an answer from code
 * older than this page (its HTML, or JSON without a field this page needs,
 * such as a row's `picked`) is the transient `DROPSHIP_SITE_UPDATING`, and
 * the same request is sent again. Every read and both bodies carry this
 * page's version (`clientVersion`, CATALOG_PAGE_CLIENT_VERSION, §12.6).
 *
 * The one write is `POST /api/dropship/catalog/selection/changes`, after a
 * `…/changes/preview` the vendor confirms. The network calls, the question,
 * the pause, the clock and the key maker are passed into the save runner, so
 * every schedule and outcome runs in a test.
 */
import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { z } from "zod";
import {
  dropshipCatalogCategoriesAnswerSchema,
  dropshipCatalogIdsAnswerSchema,
  type DropshipCatalogIdsAnswer,
  type DropshipCatalogIdsPurpose,
  type DropshipCatalogSelectionFilter,
} from "@shared/dropship/vendor-catalog-reads";
import {
  selectionChangeAnswerSchema,
  selectionChangePreviewAnswerSchema,
  selectionChangePreviewRequestSchema,
  selectionChangeRequestSchema,
  type SelectionChangeAnswer,
  type SelectionChangePreviewAnswer,
  type SelectionChangePreviewRequest,
  type SelectionChangeRequest,
} from "@shared/dropship/vendor-selection-changes";
import { buildQueryUrl, DropshipApiError, readDropshipAnswer } from "./dropship-ops-surface";
import { CATALOG_PAGE_CLIENT_VERSION, publishReadRetryDelayMs, retryPublishRead } from "./dropship-catalog-publish";
import {
  CHOOSE_BUSY_BACKOFF_MS,
  CHOOSE_EFFECTS_REVIEWS_MAX,
  CHOOSE_PAGE_SIZE,
  CHOOSE_PAUSED_MAX_SENDS,
  CHOOSE_SAVE_BACKOFF_MS,
  CHOOSE_SAVE_MAX_TRIES,
  CHOOSE_SEARCH_MAX_LENGTH,
  PAUSED_RETRY_WINDOW_MS,
  chooseBodyBytes,
  chooseCatalogPageSchema,
  chooseChangeBody,
  chooseChangesEmpty,
  chooseChangesKey,
  chooseNextPageParam,
  choosePausedDelayMs,
  classifyChooseSaveError,
  describeChooseSaved,
  type ChooseCatalogPage,
  type ChooseChanges,
  type ChooseSaveErrorClass,
} from "./dropship-catalog-choose";
import { CHOOSE_WORDS } from "./dropship-catalog-choose-words";

export const CHOOSE_CATALOG_URL = "/api/dropship/catalog";
export const CHOOSE_CATEGORIES_URL = "/api/dropship/catalog/categories";
export const SELECTION_CHANGES_URL = "/api/dropship/catalog/selection/changes";
export const SELECTION_CHANGES_PREVIEW_URL = `${SELECTION_CHANGES_URL}/preview`;
/** Step 1's list, apart from step 3's "Selected items" (`SELECTED_LIST_QUERY_KEY`, dropship-catalog-publish-requests.ts). */
export const CHOOSE_CATALOG_QUERY_KEY = [CHOOSE_CATALOG_URL, "choose"] as const;
/** Step 1's id lists, apart from its pages (`idsOnly`). */
export const CHOOSE_IDS_QUERY_KEY = [CHOOSE_CATALOG_URL, "choose-ids"] as const;
export const CHOOSE_CATEGORIES_QUERY_KEY = [CHOOSE_CATEGORIES_URL] as const;

/** The network, as the reads and the save use it (window.fetch in the page; a script in tests). */
export type ChooseFetch = (url: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: ChooseFetch = (url, init) => fetch(url, init);

/** One request with the portal's cookie, its answer read and checked with `schema`; the status tells a replay (200). */
export async function requestChooseAnswer<T>(fetcher: ChooseFetch, url: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  init: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal } = {}): Promise<{ answer: T; status: number }> {
  const response = await fetcher(url, {
    method: init.method ?? "GET",
    credentials: "include",
    signal: init.signal,
    ...(init.body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) }),
  });
  return { answer: await readDropshipAnswer(response, schema), status: response.status };
}

/**
 * The failure card's data attributes for a read that gave up (review CT7): its code and, for an answer from older
 * code, why (`not_json`, `answer_shape`), so support can see which without a client logger. Empty for any other error.
 */
export function chooseReadErrorData(error: unknown): Record<string, string> {
  if (!(error instanceof DropshipApiError) || error.code === null) return {};
  const reason = error.context?.reason;
  return { "data-error-code": error.code, ...(typeof reason === "string" ? { "data-error-reason": reason } : {}) };
}

// ---------------------------------------------------------------------------
// Reads (§12.2)
// ---------------------------------------------------------------------------

/**
 * Show: every row, what is saved as selected, what is not, or (PR B3, §11.4) `new`: the new-items notice's Review,
 * the sizes Card Shellz added that are new for the vendor, counted as the notice counts them (`selection=new`, sent
 * with the line's `categoryId`; an older server answers it 503, never every row).
 */
export type ChooseShow = DropshipCatalogSelectionFilter;

export interface ChooseFilters {
  /** Already trimmed by the page; trimmed and capped again here. */
  search: string;
  /** A category id from the categories read (V40), or null for every category. */
  categoryId: number | null;
  show: ChooseShow;
}

/** The filter values every step 1 list and id read sends: search, the category id and Show. Never a category name. */
function filterParams(filters: ChooseFilters) {
  const search = filters.search.trim().slice(0, CHOOSE_SEARCH_MAX_LENGTH);
  const categoryId = filters.categoryId !== null && Number.isSafeInteger(filters.categoryId) && filters.categoryId > 0
    ? filters.categoryId : undefined;
  return { search: search || undefined, categoryId, selection: filters.show };
}

/**
 * One page of the step's list: search, the category id, Show, no facets (the
 * categories have their own read, TESTS9), this page's version, the page and
 * 200 rows. Never `selectedOnly`, a category name, a product line or a
 * product (owner Q2).
 */
export function chooseCatalogUrl(filters: ChooseFilters, page: number): string {
  return buildQueryUrl(CHOOSE_CATALOG_URL, {
    ...filterParams(filters),
    includeFacets: false,
    clientVersion: CATALOG_PAGE_CLIENT_VERSION,
    page,
    limit: CHOOSE_PAGE_SIZE,
  });
}

/**
 * The changeable ids that match the filters, for one purpose (VCR:65-69): `add` needs the not-selected ids, `remove`
 * the selected ones. "Check all" sends the table's filters; a category's box only its id; "Select everything" none.
 */
export function chooseIdsUrl(filters: ChooseFilters, purpose: DropshipCatalogIdsPurpose): string {
  return buildQueryUrl(CHOOSE_CATALOG_URL, {
    ...filterParams(filters),
    idsOnly: true,
    purpose,
    clientVersion: CATALOG_PAGE_CLIENT_VERSION,
  });
}

/** A category's box reads its ids with only the category id (D26): its numbers are the whole category. */
export function chooseCategoryFilters(categoryId: number): ChooseFilters {
  return { search: "", categoryId, show: "all" };
}

/** "Select everything" reads the whole catalog's ids, no filter. */
export const CHOOSE_EVERYTHING_FILTERS: ChooseFilters = Object.freeze({ search: "", categoryId: null, show: "all" });

export function chooseCategoriesUrl(): string {
  return buildQueryUrl(CHOOSE_CATEGORIES_URL, { clientVersion: CATALOG_PAGE_CLIENT_VERSION });
}

export async function readChooseCatalogPage(url: string, fetcher: ChooseFetch = defaultFetch, signal?: AbortSignal): Promise<ChooseCatalogPage> {
  return (await requestChooseAnswer(fetcher, url, chooseCatalogPageSchema, { signal })).answer;
}

/**
 * The step's list: 200 rows a page, "Load more" up to 1,000 rows. The rows of
 * the last filter stay on screen while the next load (boxes off meanwhile);
 * never read again on focus, so rows never reorder under the vendor's hand.
 * A transient failure (site updating, a 5xx, a 408, a 429, no answer) is read
 * again on step 3's schedule (V11), replacing stage 1's `retry: false`.
 */
export function chooseCatalogQueryOptions(filters: ChooseFilters, fetcher: ChooseFetch = defaultFetch) {
  return infiniteQueryOptions({
    queryKey: [...CHOOSE_CATALOG_QUERY_KEY, { search: filters.search, categoryId: filters.categoryId, show: filters.show }] as const,
    queryFn: ({ pageParam, signal }) => readChooseCatalogPage(chooseCatalogUrl(filters, pageParam), fetcher, signal),
    initialPageParam: 1,
    getNextPageParam: (lastPage: ChooseCatalogPage, allPages: ChooseCatalogPage[]) => chooseNextPageParam(lastPage, allPages),
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    retry: retryPublishRead,
    retryDelay: publishReadRetryDelayMs,
  });
}

/** Every category with its counts (VCR:73-81), read once per step 1 visit and after each save (§12.2). */
export function chooseCategoriesQueryOptions(fetcher: ChooseFetch = defaultFetch) {
  return queryOptions({
    queryKey: CHOOSE_CATEGORIES_QUERY_KEY,
    queryFn: async ({ signal }) => (await requestChooseAnswer(fetcher, chooseCategoriesUrl(), dropshipCatalogCategoriesAnswerSchema, { signal })).answer,
    refetchOnWindowFocus: false,
    retry: retryPublishRead,
    retryDelay: publishReadRetryDelayMs,
  });
}

/**
 * One `idsOnly` read. The list the purpose needs is never null (the server
 * refuses with 422 `DROPSHIP_CATALOG_IDS_TOO_MANY` instead, `chooseIdsTooMany`):
 * a null one is an answer off its contract.
 */
export async function readChooseIds(filters: ChooseFilters, purpose: DropshipCatalogIdsPurpose, fetcher: ChooseFetch = defaultFetch,
  signal?: AbortSignal): Promise<DropshipCatalogIdsAnswer> {
  const { answer } = await requestChooseAnswer(fetcher, chooseIdsUrl(filters, purpose), dropshipCatalogIdsAnswerSchema, { signal });
  const needed = purpose === "add" ? answer.notSelectedIds : answer.selectedIds;
  if (needed === null) {
    throw new DropshipApiError({ message: CHOOSE_WORDS.catalogFailedText, status: 500, code: "DROPSHIP_CATALOG_IDS_OFF_CONTRACT" });
  }
  return answer;
}

/** An id read as a query (the page fetches it on a press), retried like every step 1 read; never kept stale. */
export function chooseIdsQueryOptions(filters: ChooseFilters, purpose: DropshipCatalogIdsPurpose, fetcher: ChooseFetch = defaultFetch) {
  return queryOptions({
    queryKey: [...CHOOSE_IDS_QUERY_KEY, { search: filters.search, categoryId: filters.categoryId, show: filters.show, purpose }] as const,
    queryFn: ({ signal }) => readChooseIds(filters, purpose, fetcher, signal),
    staleTime: 0,
    retry: retryPublishRead,
    retryDelay: publishReadRetryDelayMs,
  });
}

// ---------------------------------------------------------------------------
// The save (§12.4)
// ---------------------------------------------------------------------------

/** The preview POST: what the change would do, written nowhere (§8.2). */
export async function postChoosePreview(body: SelectionChangePreviewRequest, fetcher: ChooseFetch = defaultFetch): Promise<SelectionChangePreviewAnswer> {
  return (await requestChooseAnswer(fetcher, SELECTION_CHANGES_PREVIEW_URL, selectionChangePreviewAnswerSchema, { method: "POST", body })).answer;
}

/** The save POST (§8.3): 201 the first time, 200 when the same key's stored answer is sent again (a replay). */
export async function postChooseChange(body: SelectionChangeRequest, fetcher: ChooseFetch = defaultFetch): Promise<{ answer: SelectionChangeAnswer; replay: boolean }> {
  const { answer, status } = await requestChooseAnswer(fetcher, SELECTION_CHANGES_URL, selectionChangeAnswerSchema, { method: "POST", body });
  return { answer, replay: status === 200 };
}

/** A confirmed save kept after a press that ended unsure or paused: the next press of the same changes sends it again. */
export interface ChoosePendingSave {
  /** The body as sent, key and confirmed effects hash included; sent again unchanged. */
  body: SelectionChangeRequest;
  /** `chooseChangesKey` of the changes it was built from. */
  changesKey: string;
  /** The preview the vendor confirmed. */
  confirmed: SelectionChangePreviewAnswer;
  /**
   * A send of it got no sure answer (no answer, a 5xx, a 2xx cut short): the server may hold it although the page
   * shows the choices from before it. Kept through later presses that hear only busy, paused, 408 or 429, since those
   * say nothing of the earlier send (review round 1 CLI-1, TST-2; `chooseUndoneAfterUnsure`).
   */
  mayHaveCommitted: boolean;
}

/** What the bar says while the runner sends the same save again. `retrying`: no words beyond "Saving…". */
export type ChooseSaveStatus = "paused" | "savingStill" | "retrying";

export interface ChooseSaveDeps {
  preview(body: SelectionChangePreviewRequest): Promise<SelectionChangePreviewAnswer>;
  /** Resolves once the server answered 2xx: the save committed (`replay` for the same key's stored answer). */
  post(body: SelectionChangeRequest): Promise<{ answer: SelectionChangeAnswer; replay: boolean }>;
  /** The save question with the server's counts; true for Save, false for Cancel. `effectsChanged`: asked again (§13). */
  confirm(preview: SelectionChangePreviewAnswer, context: { effectsChanged: boolean }): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  /** Milliseconds on the page's clock; only differences are used (the paused window). */
  now(): number;
  newKey(): string;
  onStatus?(status: ChooseSaveStatus): void;
}

export interface ChooseSaveInput {
  changes: ChooseChanges;
  /** A save kept from an earlier press; sent again only for exactly the same changes. */
  pending: ChoosePendingSave | null;
}

export type ChooseSaveOutcome =
  /** Committed (201), or the same key's stored answer (200). */
  | { kind: "saved"; answer: SelectionChangeAnswer; replay: boolean }
  /** The vendor pressed Cancel: nothing was sent. */
  | { kind: "cancelled" }
  /** The head revision moved since the changes were made: read again, keep the changes, new key. */
  | { kind: "stale"; headRevisionId: number | null | undefined }
  /** The change would grow the selection past the cap (preview `too_large`, or 422). */
  | { kind: "overCap"; after: number | null }
  /** Only a reload helps (410 rules retired, PR C's 409 page outdated). */
  | { kind: "retired" }
  /** The bulk parser's 413. */
  | { kind: "tooLarge" }
  /** PR C's 422: the removal covers more than one save may; nothing was written. */
  | { kind: "tooManyRemoved" }
  /** Refused for good; the next press makes a new save with a new key. */
  | { kind: "rejected"; message: string }
  /** The effects moved again after every question this press allowed (CHOOSE_EFFECTS_REVIEWS_MAX). */
  | { kind: "effectsChanged" }
  /** Busy past every try: nothing was written; the next press sends `pending` again. */
  | { kind: "busy"; pending: ChoosePendingSave }
  /** Paused past the window: the next press starts a new window with `pending` (null when no question was answered yet). */
  | { kind: "pausedStill"; pending: ChoosePendingSave | null }
  /** No sure answer: it may have committed; the next press sends `pending` again, which replays it if it did (review MC1). */
  | { kind: "unconfirmed"; pending: ChoosePendingSave }
  /** Every answer said nothing was written (408, 429), or the preview never answered. */
  | { kind: "notSaved"; pending: ChoosePendingSave | null };

/** The outcome of a refusal that is not retried. */
function refusalOutcome(failure: Exclude<ChooseSaveErrorClass, { kind: "network" | "busy" | "paused" }>): ChooseSaveOutcome {
  switch (failure.kind) {
    case "stale": return { kind: "stale", headRevisionId: failure.headRevisionId };
    case "effectsChanged": return { kind: "effectsChanged" };
    // The key was used for another change: refused; the next press makes a new key (§12.4).
    case "keyConflict": return { kind: "rejected", message: CHOOSE_WORDS.rejected };
    case "retired": return { kind: "retired" };
    case "tooLarge": return { kind: "tooLarge" };
    case "tooManyRemoved": return { kind: "tooManyRemoved" };
    case "overCap": return { kind: "overCap", after: failure.after };
    case "permanent": return { kind: "rejected", message: failure.message };
    default: {
      const unknownFailure: never = failure;
      throw new Error(`Unknown catalog choose refusal: ${JSON.stringify(unknownFailure)}`);
    }
  }
}

/**
 * The preview, sent again on the paused schedule after any transient failure
 * (no answer, a 5xx, writes paused, an older dyno's answer or 413): a preview
 * writes nothing (§12.4 step 1). Past the paused window: `pausedStill` when
 * the last failure was a pause, else `notSaved`.
 */
async function previewWithRetries(deps: ChooseSaveDeps, body: SelectionChangePreviewRequest):
  Promise<{ kind: "previewed"; preview: SelectionChangePreviewAnswer } | { kind: "stopped"; outcome: ChooseSaveOutcome }> {
  const bodyBytes = chooseBodyBytes(body);
  let firstFailureAt: number | null = null;
  for (let sends = 1; ; sends += 1) {
    try {
      return { kind: "previewed", preview: await deps.preview(body) };
    } catch (error) {
      const failure = classifyChooseSaveError(error, { bodyBytes });
      if (failure.kind !== "network" && failure.kind !== "busy" && failure.kind !== "paused") {
        return { kind: "stopped", outcome: refusalOutcome(failure) };
      }
      firstFailureAt ??= deps.now();
      if (deps.now() - firstFailureAt >= PAUSED_RETRY_WINDOW_MS || sends >= CHOOSE_PAUSED_MAX_SENDS) {
        return { kind: "stopped", outcome: failure.kind === "paused" ? { kind: "pausedStill", pending: null } : { kind: "notSaved", pending: null } };
      }
      deps.onStatus?.(failure.kind === "paused" ? "paused" : "retrying");
      await deps.sleep(choosePausedDelayMs(sends - 1));
    }
  }
}

/**
 * One confirmed save, sent with the same key and body every time (§12.4 step 3):
 * - no answer, a 5xx, a 408 or a 429: up to CHOOSE_SAVE_MAX_TRIES sends, then `unconfirmed` (it may have committed)
 *   or `notSaved`;
 * - busy: up to six more sends on CHOOSE_BUSY_BACKOFF_MS, showing `savingStill`, then `busy`;
 * - writes paused, site updating, an older dyno's 413: 2 s, 4 s, 8 s, then every 15 s, showing `paused`, until
 *   PAUSED_RETRY_WINDOW_MS has passed since the first paused answer, then `pausedStill`;
 * - anything else: its outcome at once, never sent again.
 */
async function sendChooseSave(deps: ChooseSaveDeps, pending: ChoosePendingSave): Promise<ChooseSaveOutcome> {
  const bodyBytes = chooseBodyBytes(pending.body);
  let networkFailures = 0;
  let busyFailures = 0;
  let pausedFailures = 0;
  let pausedSince: number | null = null;
  let mayHaveCommitted = false;
  // The save kept for the next press, marked when this press or an earlier one may have committed it.
  const kept = (): ChoosePendingSave => (mayHaveCommitted && !pending.mayHaveCommitted ? { ...pending, mayHaveCommitted: true } : pending);
  for (;;) {
    let delay: number;
    try {
      const { answer, replay } = await deps.post(pending.body);
      return { kind: "saved", answer, replay };
    } catch (error) {
      const failure = classifyChooseSaveError(error, { bodyBytes });
      if (failure.kind === "network") {
        networkFailures += 1;
        mayHaveCommitted = mayHaveCommitted || failure.mayHaveCommitted;
        if (networkFailures >= CHOOSE_SAVE_MAX_TRIES) return mayHaveCommitted ? { kind: "unconfirmed", pending: kept() } : { kind: "notSaved", pending: kept() };
        delay = CHOOSE_SAVE_BACKOFF_MS[networkFailures - 1] ?? CHOOSE_SAVE_BACKOFF_MS[CHOOSE_SAVE_BACKOFF_MS.length - 1];
        deps.onStatus?.("retrying");
      } else if (failure.kind === "busy") {
        busyFailures += 1;
        if (busyFailures > CHOOSE_BUSY_BACKOFF_MS.length) return { kind: "busy", pending: kept() };
        delay = CHOOSE_BUSY_BACKOFF_MS[busyFailures - 1];
        deps.onStatus?.("savingStill");
      } else if (failure.kind === "paused") {
        pausedFailures += 1;
        pausedSince ??= deps.now();
        if (deps.now() - pausedSince >= PAUSED_RETRY_WINDOW_MS || pausedFailures >= CHOOSE_PAUSED_MAX_SENDS) return { kind: "pausedStill", pending: kept() };
        delay = choosePausedDelayMs(pausedFailures - 1);
        deps.onStatus?.("paused");
      } else {
        return refusalOutcome(failure);
      }
    }
    await deps.sleep(delay);
  }
}

/**
 * One press of "Save changes" (PLAN-B v4.1 §12.4), in this order:
 * 1. A save kept from an earlier press of exactly these changes is sent again
 *    as it was (same key and body; a new paused window), with no question.
 * 2. Otherwise the preview (retried on the paused schedule). A head revision
 *    other than the changes' base stops with `stale` (the changes stay); a
 *    change over the cap stops with `overCap`.
 * 3. The question, with the server's counts and effects. Cancel sends nothing.
 * 4. The save, with a new key, sent on its schedules (`sendChooseSave`). When
 *    the effects moved (409) the preview and the question run again and the
 *    next save gets a new key, at most CHOOSE_EFFECTS_REVIEWS_MAX times.
 * Both bodies are checked with the server's own schemas before they are sent.
 */
export async function runChooseSave(deps: ChooseSaveDeps, input: ChooseSaveInput): Promise<ChooseSaveOutcome> {
  if (chooseChangesEmpty(input.changes)) throw new Error("runChooseSave needs at least one change to save.");
  const changesKey = chooseChangesKey(input.changes);
  const previewBody = selectionChangePreviewRequestSchema.parse(chooseChangeBody(input.changes));
  let pending = input.pending !== null && input.pending.changesKey === changesKey ? input.pending : null;
  let effectsChanged = false;
  for (let round = 0; round < CHOOSE_EFFECTS_REVIEWS_MAX; round += 1) {
    if (pending === null) {
      const previewed = await previewWithRetries(deps, previewBody);
      if (previewed.kind === "stopped") return previewed.outcome;
      const preview = previewed.preview;
      if (preview.headRevisionId !== input.changes.baseRevisionId) return { kind: "stale", headRevisionId: preview.headRevisionId };
      if (preview.refused === "too_large") return { kind: "overCap", after: preview.selectedAfter };
      if (!(await deps.confirm(preview, { effectsChanged }))) return { kind: "cancelled" };
      pending = {
        body: selectionChangeRequestSchema.parse({
          ...previewBody, idempotencyKey: deps.newKey(), expectedEffectsHash: preview.effectsHash,
          // PR C (PLAN-C v4.1 §4.6): the confirmed ends, echoed, so the save never ends more than the vendor saw.
          expectedEnds: { listingIds: preview.ends.listingIds, hiddenRemovedIds: preview.ends.hiddenRemovedIds },
          expectedOtherEntriesHash: preview.otherEntriesHash,
        }),
        changesKey,
        confirmed: preview,
        mayHaveCommitted: false,
      };
    }
    const sent = await sendChooseSave(deps, pending);
    if (sent.kind !== "effectsChanged") return sent;
    effectsChanged = true;
    pending = null;
  }
  return { kind: "effectsChanged" };
}

/** What the bar says after a press, until the next change. */
export type ChooseBarOutcome =
  | { kind: "saved"; message: string }
  /** Good news with nothing left to do, in the status line (verify V1). */
  | { kind: "info"; message: string }
  /** `reload`: the bar offers Reload beside the words (only a reload can help, §4.9 item 2). */
  | { kind: "error"; message: string; reload?: true };

/** The bar's words for an outcome; null after Cancel (nothing happened). */
export function describeChooseSaveOutcome(outcome: ChooseSaveOutcome): ChooseBarOutcome | null {
  switch (outcome.kind) {
    case "saved": return { kind: "saved", message: describeChooseSaved(outcome.answer) };
    case "cancelled": return null;
    case "stale": return { kind: "error", message: CHOOSE_WORDS.stale };
    case "overCap": return { kind: "error", message: outcome.after !== null ? CHOOSE_WORDS.overCapAdd(outcome.after) : CHOOSE_WORDS.rejected };
    case "retired": return { kind: "error", message: CHOOSE_WORDS.retired, reload: true };
    case "tooLarge": return { kind: "error", message: CHOOSE_WORDS.tooLarge };
    case "tooManyRemoved": return { kind: "error", message: CHOOSE_WORDS.tooManyRemoved };
    case "rejected": return { kind: "error", message: outcome.message };
    case "effectsChanged": return { kind: "error", message: CHOOSE_WORDS.effectsChanged };
    case "busy": return { kind: "error", message: CHOOSE_WORDS.busy };
    case "pausedStill": return { kind: "error", message: CHOOSE_WORDS.pausedStill };
    case "unconfirmed": return { kind: "error", message: CHOOSE_WORDS.unconfirmed };
    case "notSaved": return { kind: "error", message: CHOOSE_WORDS.notSaved };
    default: {
      const unknownOutcome: never = outcome;
      throw new Error(`Unknown catalog choose outcome: ${JSON.stringify(unknownOutcome)}`);
    }
  }
}

/** The bar's line while the same save is sent again; null for a plain retry ("Saving…" says it). */
export function describeChooseSaveStatus(status: ChooseSaveStatus | null): string | null {
  if (status === "paused") return CHOOSE_WORDS.paused;
  if (status === "savingStill") return CHOOSE_WORDS.savingStill;
  return null;
}

/**
 * The changes are gone (Undo, every box unticked back) while a kept save may have committed: the page shows the
 * choices from before that save, and no press of Save can follow (there is nothing to save), so the page reads the
 * saved choices again now (review round 1 CLI-1, TST-2; stage 1's review MC1 rule, which plan V25 had removed with the
 * rules probe). Never while changes are pending: the next press sends the kept save, which replays it if it went through.
 */
export function chooseUndoneAfterUnsure(pending: ChoosePendingSave | null, changes: Pick<ChooseChanges, "add" | "remove">): boolean {
  return pending !== null && pending.mayHaveCommitted && chooseChangesEmpty(changes);
}

/** The kept save after an outcome: kept only while the next press should send it again. */
export function choosePendingAfter(outcome: ChooseSaveOutcome, previous: ChoosePendingSave | null): ChoosePendingSave | null {
  if (outcome.kind === "busy" || outcome.kind === "unconfirmed") return outcome.pending;
  if (outcome.kind === "pausedStill" || outcome.kind === "notSaved") return outcome.pending ?? previous;
  // Cancel sent nothing: an earlier kept save of other changes stays as it was.
  if (outcome.kind === "cancelled") return previous;
  return null;
}
