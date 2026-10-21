/**
 * Catalog step 3's requests on publish runs (step 1 plan S2-5, PR A, §4.10):
 * the selection summary, the "Selected items" pages, the selected ids and the
 * chunked Check, a run's create, detail, list and stop. Every answer is read
 * through `readDropshipAnswer` (§4.9 item 3): an answer from code older than
 * this page (its HTML, or JSON without a field this page needs) is the
 * transient `DROPSHIP_SITE_UPDATING`, and the same request is sent again.
 *
 * The network call, the pause and the "still current" check are passed into
 * the two runners (`createPublishRun`, `runListingCheck`), so every path runs
 * in a test with no network and no clock.
 */
import { infiniteQueryOptions, keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { z } from "zod";
import {
  createListingPushRunRequestSchema,
  createListingPushRunResponseSchema,
  listListingPushRunsResponseSchema,
  listingPushRunDetailResponseSchema,
  stopListingPushRunResponseSchema,
  type CreateListingPushRunRequest,
  type ListingPushRunDetail,
  type ListingPushRunScope,
  type ListingPushRunView,
} from "@shared/dropship/listing-push-runs";
import {
  dropshipCatalogIdsAnswerSchema,
  dropshipCatalogSelectionSummarySchema,
  type DropshipCatalogSelectionSummary,
} from "@shared/dropship/vendor-catalog-reads";
import { buildQueryUrl, DropshipApiError, readDropshipAnswer } from "./dropship-ops-surface";
import {
  CATALOG_PAGE_CLIENT_VERSION,
  CHECK_RETRY_PAUSE_MS,
  RUN_CREATE_BACKOFF_MS,
  RUN_CREATE_MAX_TRIES,
  SELECTED_LIST_PAGE_SIZE,
  checkDetailAnswerSchema,
  checkPreviewAnswerSchema,
  checkResult,
  chunkIds,
  classifyRunCreateError,
  isAbortError,
  isTransientPublishError,
  publishReadRetryDelayMs,
  retryPublishRead,
  selectedListNextPage,
  selectedListPageSchema,
  toCheckRow,
  type CheckDetailRow,
  type CheckPreviewAnswer,
  type CheckResult,
  type CheckRow,
  type RunCreateErrorClass,
  type SelectedListPage,
} from "./dropship-catalog-publish";

export const CATALOG_URL = "/api/dropship/catalog";
export const SELECTION_SUMMARY_URL = "/api/dropship/catalog/selection";
export const LISTING_PREVIEW_URL = "/api/dropship/listings/preview";
export const LISTING_PUSH_RUNS_URL = "/api/dropship/listing-push-runs";
/** Every step 3 query's key starts with one of these, so a save or a run's end can mark them stale together. */
export const SELECTION_SUMMARY_QUERY_KEY = [SELECTION_SUMMARY_URL] as const;
export const SELECTED_LIST_QUERY_KEY = [CATALOG_URL, "publish-selected"] as const;
export const LISTING_PUSH_RUNS_QUERY_KEY = [LISTING_PUSH_RUNS_URL] as const;

/** The network, as the runners and queries use it (window.fetch in the page; a script in tests). */
export type PublishFetch = (url: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: PublishFetch = (url, init) => fetch(url, init);

/** One request with the portal's cookie, its answer read and checked with `schema`. */
export async function requestPublishAnswer<T>(fetcher: PublishFetch, url: string, schema: z.ZodType<T>,
  init: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetcher(url, {
    method: init.method ?? "GET",
    credentials: "include",
    signal: init.signal,
    ...(init.body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) }),
  });
  return readDropshipAnswer(response, schema);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** `GET /api/dropship/catalog/selection`: the count, with the store's live and not-live split when a store is named. */
export function selectionSummaryUrl(storeConnectionId: number | null): string {
  return buildQueryUrl(SELECTION_SUMMARY_URL, {
    storeConnectionId: storeConnectionId !== null && storeConnectionId > 0 ? storeConnectionId : undefined,
    clientVersion: CATALOG_PAGE_CLIENT_VERSION,
  });
}

/**
 * The selection summary: step 1's count and the rail (stage 1's "N selected"), and step 3's buttons. The previous
 * store's answer stays on screen while a switch reads the new one (the count is the same; step 3 checks the store,
 * `describePublishChoices`). Read again after each save and after a run ends.
 */
export function selectionSummaryQueryOptions(storeConnectionId: number | null, fetcher: PublishFetch = defaultFetch) {
  const store = storeConnectionId !== null && storeConnectionId > 0 ? storeConnectionId : null;
  return queryOptions<DropshipCatalogSelectionSummary>({
    queryKey: [...SELECTION_SUMMARY_QUERY_KEY, store] as const,
    queryFn: ({ signal }) => requestPublishAnswer(fetcher, selectionSummaryUrl(store), dropshipCatalogSelectionSummarySchema, { signal }),
    placeholderData: keepPreviousData,
    retry: retryPublishRead,
    retryDelay: publishReadRetryDelayMs,
    refetchOnWindowFocus: false,
  });
}

/**
 * One page of "Selected items" (§4.10): `selection=selected` with stage 1's `selectedOnly=true` beside it (a stage 1
 * server honours the old value), no facets (one scan, TESTS9), this page's version (CHK7), 200 rows.
 */
export function selectedListUrl(page: number): string {
  return buildQueryUrl(CATALOG_URL, {
    selection: "selected",
    selectedOnly: true,
    includeFacets: false,
    clientVersion: CATALOG_PAGE_CLIENT_VERSION,
    page,
    limit: SELECTED_LIST_PAGE_SIZE,
  });
}

export function selectedListQueryOptions(fetcher: PublishFetch = defaultFetch) {
  return infiniteQueryOptions({
    queryKey: SELECTED_LIST_QUERY_KEY,
    queryFn: ({ pageParam, signal }) => requestPublishAnswer(fetcher, selectedListUrl(pageParam), selectedListPageSchema, { signal }),
    initialPageParam: 1,
    getNextPageParam: (lastPage: SelectedListPage, allPages: SelectedListPage[]) => selectedListNextPage(lastPage, allPages),
    retry: retryPublishRead,
    retryDelay: publishReadRetryDelayMs,
    refetchOnWindowFocus: false,
  });
}

/**
 * Every selected size's id, for the Check: `idsOnly` with purpose `remove` lists the selected changeable sizes (a
 * selected size is always changeable: an override that turns it off makes it not selected). More than 10,000 is
 * refused (422 `DROPSHIP_CATALOG_IDS_TOO_MANY`).
 */
export function selectedIdsUrl(): string {
  return buildQueryUrl(CATALOG_URL, {
    selection: "selected",
    idsOnly: true,
    purpose: "remove",
    clientVersion: CATALOG_PAGE_CLIENT_VERSION,
  });
}

export async function readSelectedIds(fetcher: PublishFetch = defaultFetch, signal?: AbortSignal): Promise<number[]> {
  const answer = await requestPublishAnswer(fetcher, selectedIdsUrl(), dropshipCatalogIdsAnswerSchema, { signal });
  // Never null for the purpose asked (the read is refused instead); a null here is an answer off its contract.
  if (answer.selectedIds === null) throw new DropshipApiError({ message: "The selected ids could not be read.", status: 500, code: "DROPSHIP_CATALOG_IDS_OFF_CONTRACT" });
  return answer.selectedIds;
}

/** The newest run on a store (`limit=1`): a run still processing shows its card again when the page opens (§4.10). */
export function latestRunUrl(storeConnectionId: number): string {
  return buildQueryUrl(LISTING_PUSH_RUNS_URL, { storeConnectionId, limit: 1 });
}

export function latestRunQueryOptions(storeConnectionId: number, fetcher: PublishFetch = defaultFetch) {
  return queryOptions({
    queryKey: [...LISTING_PUSH_RUNS_QUERY_KEY, "latest", storeConnectionId] as const,
    queryFn: async ({ signal }) => {
      const answer = await requestPublishAnswer(fetcher, latestRunUrl(storeConnectionId), listListingPushRunsResponseSchema, { signal });
      return answer.runs[0] ?? null;
    },
    enabled: storeConnectionId > 0,
    retry: retryPublishRead,
    retryDelay: publishReadRetryDelayMs,
    refetchOnWindowFocus: false,
  });
}

export function runDetailUrl(runId: number, problemsAfter?: number): string {
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("The publish id is invalid.");
  return buildQueryUrl(`${LISTING_PUSH_RUNS_URL}/${runId}`, { problemsAfter: problemsAfter && problemsAfter > 0 ? problemsAfter : undefined });
}

export function runDetailQueryKey(runId: number) {
  return [...LISTING_PUSH_RUNS_QUERY_KEY, "detail", runId] as const;
}

/** A run's counts and its first 50 problem sizes. The card polls it (refetchInterval) while the run goes on. */
export function runDetailQueryOptions(runId: number, fetcher: PublishFetch = defaultFetch) {
  return queryOptions<ListingPushRunDetail>({
    queryKey: runDetailQueryKey(runId),
    queryFn: ({ signal }) => requestPublishAnswer(fetcher, runDetailUrl(runId), listingPushRunDetailResponseSchema, { signal }),
    retry: retryPublishRead,
    retryDelay: publishReadRetryDelayMs,
    refetchOnWindowFocus: false,
  });
}

/** The next 50 problem sizes after `problemsAfter` (a size id), for "Show more". */
export function readRunProblemsPage(runId: number, problemsAfter: number, fetcher: PublishFetch = defaultFetch): Promise<ListingPushRunDetail> {
  return requestPublishAnswer(fetcher, runDetailUrl(runId, problemsAfter), listingPushRunDetailResponseSchema);
}

/** `POST …/:runId/stop`. Idempotent by state: a second press answers 200 with the run as it is. No step-up (§4.6). */
export function stopPublishRun(runId: number, fetcher: PublishFetch = defaultFetch) {
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("The publish id is invalid.");
  return requestPublishAnswer(fetcher, `${LISTING_PUSH_RUNS_URL}/${runId}/stop`, stopListingPushRunResponseSchema, { method: "POST", body: {} });
}

// ---------------------------------------------------------------------------
// Run create
// ---------------------------------------------------------------------------

export interface CreatePublishRunDeps {
  /** The POST. Resolves with the parsed answer (202 new, 200 replay); rejects with the failure. */
  post(body: CreateListingPushRunRequest): Promise<{ run: ListingPushRunView; idempotentReplay: boolean }>;
  sleep(ms: number): Promise<void>;
  /** Told before each pause between tries, with the transient failure (the page shows "site updating" for that one). */
  onRetry?(error: unknown): void;
}

export type CreatePublishRunOutcome =
  /** The run exists (made now, or an earlier send with this key made it). */
  | { kind: "created"; run: ListingPushRunView; replay: boolean }
  /** Refused, in words; never sent again with this key. */
  | { kind: "refused"; refusal: Exclude<RunCreateErrorClass, { kind: "transient" }>; error: unknown }
  /**
   * Every try was answered "try again", or not at all: a run may exist (a lost answer). The page keeps the key for the
   * next press of the same choice, which replays it if it was made; a different press is refused while it runs.
   */
  | { kind: "notSent"; error: unknown };

/** The POST as the page sends it: the key is in the body (the server's strict schema reads it there first). */
export function postPublishRun(body: CreateListingPushRunRequest, fetcher: PublishFetch = defaultFetch) {
  return requestPublishAnswer(fetcher, LISTING_PUSH_RUNS_URL, createListingPushRunResponseSchema, { method: "POST", body });
}

/**
 * One press of "Publish {n} new" or "Publish all {n}" (§4.10): the same body and key on every try, at most
 * RUN_CREATE_MAX_TRIES tries with RUN_CREATE_BACKOFF_MS between them, only while each answer was transient. A refusal
 * stops at once. The body is checked with the server's own schema before anything is sent.
 */
export async function createPublishRun(deps: CreatePublishRunDeps, body: CreateListingPushRunRequest): Promise<CreatePublishRunOutcome> {
  const checked = createListingPushRunRequestSchema.parse(body);
  let lastError: unknown = null;
  for (let tryIndex = 0; tryIndex < RUN_CREATE_MAX_TRIES; tryIndex += 1) {
    if (tryIndex > 0) await deps.sleep(RUN_CREATE_BACKOFF_MS[tryIndex - 1] ?? RUN_CREATE_BACKOFF_MS[RUN_CREATE_BACKOFF_MS.length - 1]);
    try {
      const answer = await deps.post(checked);
      return { kind: "created", run: answer.run, replay: answer.idempotentReplay };
    } catch (error) {
      const refusal = classifyRunCreateError(error, checked.scope);
      if (refusal.kind !== "transient") return { kind: "refused", refusal, error };
      lastError = error;
      if (tryIndex < RUN_CREATE_MAX_TRIES - 1) deps.onRetry?.(error);
    }
  }
  return { kind: "notSent", error: lastError };
}

/** A new press's body; the key is new unless the page kept an unconfirmed press of the same choice. */
export function publishRunBody(input: {
  storeConnectionId: number;
  scope: ListingPushRunScope;
  expectedSelectionRevisionId: number | null;
  idempotencyKey: string;
}): CreateListingPushRunRequest {
  return createListingPushRunRequestSchema.parse(input);
}

// ---------------------------------------------------------------------------
// The chunked Check (D15)
// ---------------------------------------------------------------------------

export interface ListingCheckDeps {
  /** One preview of at most CHECK_CHUNK_SIZE sizes on the store. */
  preview(storeConnectionId: number, productVariantIds: readonly number[], signal: AbortSignal): Promise<CheckPreviewAnswer>;
  /** False once the store or the selection revision the check was started for has moved: the check stops, its rows dropped. */
  stillCurrent(): boolean;
  sleep(ms: number): Promise<void>;
}

export interface ListingCheckInput {
  storeConnectionId: number;
  ids: readonly number[];
  /** The store and revision it is for (`checkContextKey`). */
  contextKey: string;
  signal: AbortSignal;
  onProgress(done: number, total: number): void;
}

export type ListingCheckOutcome =
  | { kind: "done"; result: CheckResult }
  /** Stopped by the vendor, a store switch or a selection change: nothing is shown (no `checkFailed`, §4.13 P10). */
  | { kind: "aborted" }
  | { kind: "failed"; done: number; total: number; error: unknown };

/**
 * One checked size's full preview, read when its sheet opens (review round 2 DUX2): the same read-only preview POST
 * with one id, its answer checked with the detail schema (the Check's row plus its presentation). Null when the
 * answer has no row for that size.
 */
export async function readCheckRowDetail(storeConnectionId: number, productVariantId: number, signal: AbortSignal,
  fetcher: PublishFetch = defaultFetch): Promise<CheckDetailRow | null> {
  const answer = await requestPublishAnswer(fetcher, LISTING_PREVIEW_URL, checkDetailAnswerSchema,
    { method: "POST", body: { storeConnectionId, productVariantIds: [productVariantId] }, signal });
  if (answer.preview.storeConnectionId !== storeConnectionId) return null;
  return answer.preview.rows.find((row) => row.productVariantId === productVariantId) ?? null;
}

/** The preview POST one Check chunk sends. */
export function postCheckPreview(storeConnectionId: number, productVariantIds: readonly number[], signal: AbortSignal,
  fetcher: PublishFetch = defaultFetch): Promise<CheckPreviewAnswer> {
  return requestPublishAnswer(fetcher, LISTING_PREVIEW_URL, checkPreviewAnswerSchema,
    { method: "POST", body: { storeConnectionId, productVariantIds: [...productVariantIds] }, signal });
}

/**
 * "Check listings" (§4.10): the selected ids in chunks of 200, one chunk at a time (never in parallel: each is a full
 * preview on the server), each chunk sent once more after a transient failure. It stops on an abort (Stop checking,
 * a store switch) or when the store or selection moved between chunks, and then shows nothing. A chunk answered for
 * another store fails the check (the page never shows one store's rows under another).
 */
export async function runListingCheck(deps: ListingCheckDeps, input: ListingCheckInput): Promise<ListingCheckOutcome> {
  const chunks = chunkIds(input.ids);
  const total = input.ids.length;
  const rows: CheckRow[] = [];
  // Sizes sent and answered so far: the progress counts ids, as the vendor's selection does.
  let processed = 0;
  let meta: { vendorId: number; platform: string; generatedAt: string } | null = null;
  input.onProgress(0, total);
  for (const chunk of chunks) {
    if (input.signal.aborted || !deps.stillCurrent()) return { kind: "aborted" };
    let answer: CheckPreviewAnswer | null = null;
    for (let attempt = 0; attempt < 2 && answer === null; attempt += 1) {
      try {
        answer = await deps.preview(input.storeConnectionId, chunk, input.signal);
      } catch (error) {
        if (input.signal.aborted || isAbortError(error)) return { kind: "aborted" };
        if (attempt === 0 && isTransientPublishError(error)) {
          await deps.sleep(CHECK_RETRY_PAUSE_MS);
          if (input.signal.aborted || !deps.stillCurrent()) return { kind: "aborted" };
          continue;
        }
        return { kind: "failed", done: processed, total, error };
      }
    }
    if (answer === null) return { kind: "failed", done: processed, total, error: null };
    if (input.signal.aborted || !deps.stillCurrent()) return { kind: "aborted" };
    if (answer.preview.storeConnectionId !== input.storeConnectionId) {
      return { kind: "failed", done: processed, total,
        error: new DropshipApiError({ message: "The check answered for another store.", status: 500, code: "DROPSHIP_LISTING_CHECK_STORE_MISMATCH" }) };
    }
    meta ??= { vendorId: answer.preview.vendorId, platform: answer.preview.platform, generatedAt: answer.preview.generatedAt };
    for (const row of answer.preview.rows) rows.push(toCheckRow(row));
    processed += chunk.length;
    input.onProgress(processed, total);
  }
  return {
    kind: "done",
    result: checkResult({
      contextKey: input.contextKey,
      vendorId: meta?.vendorId ?? 0,
      storeConnectionId: input.storeConnectionId,
      platform: meta?.platform ?? "ebay",
      generatedAt: meta?.generatedAt ?? new Date(0).toISOString(),
      rows,
    }),
  };
}
