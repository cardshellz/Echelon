/**
 * Catalog step 1's new-items notice requests (step 1 plan S2-5, PR B;
 * PLAN-B v4.1 §11.4, §12.2): the notice's read and "Got it".
 *
 * - `GET /api/dropship/catalog/new-items?clientVersion=2` once per step 1
 *   visit, after each save and after each "Got it"; read through
 *   `readDropshipAnswer` like every step 1 read (V11), so an older server's
 *   answer is "site updating" and read again on step 3's schedule.
 * - `POST /api/dropship/catalog/new-items/acknowledge { clientVersion,
 *   categoryId, throughArrivalId }`: idempotent by state on the server (a
 *   second press answers `already_seen`), so a press whose answer never came
 *   is sent again, with no key. `DROPSHIP_CATALOG_NOTICE_ACK_INVALID` (an
 *   arrival id past the newest, §14) is not retried: the notice is read again.
 *
 * The network and the pause are passed in, so every outcome runs in a test.
 */
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import {
  DROPSHIP_CATALOG_READ_ERROR_CODES,
  dropshipCatalogNewItemsAnswerSchema,
  dropshipCatalogNoticeAcknowledgeAnswerSchema,
  dropshipCatalogNoticeAcknowledgeRequestSchema,
  type DropshipCatalogNewItemsAnswer,
  type DropshipCatalogNoticeAcknowledgeAnswer,
  type DropshipCatalogNoticeAcknowledgeRequest,
} from "@shared/dropship/vendor-catalog-reads";
import { buildQueryUrl, DropshipApiError } from "./dropship-ops-surface";
import { CATALOG_PAGE_CLIENT_VERSION, isTransientPublishError, publishReadRetryDelayMs, retryPublishRead } from "./dropship-catalog-publish";
import { CHOOSE_CATALOG_QUERY_KEY, requestChooseAnswer, type ChooseFetch } from "./dropship-catalog-choose-requests";
import { withoutAcknowledged, type NewItemsNoticeLine } from "./dropship-catalog-new-items";
import { NEW_ITEMS_WORDS } from "./dropship-catalog-new-items-words";

export const CATALOG_NEW_ITEMS_URL = "/api/dropship/catalog/new-items";
export const CATALOG_NEW_ITEMS_ACKNOWLEDGE_URL = `${CATALOG_NEW_ITEMS_URL}/acknowledge`;
export const CATALOG_NEW_ITEMS_QUERY_KEY = [CATALOG_NEW_ITEMS_URL] as const;
/**
 * A "Got it" is sent at most this many times (the first press and three more) when its answer says "try again" (no
 * answer, a 5xx, a 408, a 429, an older server's answer), on step 3's read pauses: about nine seconds, then the line
 * says so and the button works again. Not the reads' long schedule: a press should not wait minutes.
 */
export const NEW_ITEMS_ACKNOWLEDGE_MAX_SENDS = 4;

const defaultFetch: ChooseFetch = (url, init) => fetch(url, init);

/** The notice's read: this page's version only (the server answers 503 to a newer page, which is read again). */
export function catalogNewItemsUrl(): string {
  return buildQueryUrl(CATALOG_NEW_ITEMS_URL, { clientVersion: CATALOG_PAGE_CLIENT_VERSION });
}

/**
 * The notice as a query, mounted inside step 1 only (V26): never read again on focus (lines never move under the
 * vendor's hand); a transient failure is read again on step 3's schedule, like every step 1 read (V11).
 */
export function catalogNewItemsQueryOptions(fetcher: ChooseFetch = defaultFetch) {
  return queryOptions({
    queryKey: CATALOG_NEW_ITEMS_QUERY_KEY,
    queryFn: async ({ signal }) => (await requestChooseAnswer(fetcher, catalogNewItemsUrl(), dropshipCatalogNewItemsAnswerSchema, { signal })).answer,
    refetchOnWindowFocus: false,
    retry: retryPublishRead,
    retryDelay: publishReadRetryDelayMs,
  });
}

/** POST …/new-items/acknowledge; its answer checked with the shared schema. */
export async function postCatalogNewItemsAcknowledge(body: DropshipCatalogNoticeAcknowledgeRequest,
  fetcher: ChooseFetch = defaultFetch): Promise<DropshipCatalogNoticeAcknowledgeAnswer> {
  return (await requestChooseAnswer(fetcher, CATALOG_NEW_ITEMS_ACKNOWLEDGE_URL, dropshipCatalogNoticeAcknowledgeAnswerSchema, { method: "POST", body })).answer;
}

export interface NewItemsAcknowledgeDeps {
  send(body: DropshipCatalogNoticeAcknowledgeRequest): Promise<DropshipCatalogNoticeAcknowledgeAnswer>;
  sleep(ms: number): Promise<void>;
}

export type NewItemsAcknowledgeOutcome =
  /** The server took it: `acknowledged` now, or `already_seen` (an earlier press, here or in another tab). */
  | { kind: "acknowledged"; answer: DropshipCatalogNoticeAcknowledgeAnswer }
  /** 400 `DROPSHIP_CATALOG_NOTICE_ACK_INVALID`: the line is older than the server's ledger; the notice is read again, no words (§14). */
  | { kind: "stale" }
  /** No sure answer after every send, or a refusal: the line stays with `message`, and the button works again. */
  | { kind: "failed"; message: string; code: string | null; status: number | null };

/**
 * One "Got it", start to finish:
 * 1. the body (this page's version, the line's category and `throughArrivalId`) is checked by the server's own
 *    strict schema; one it refuses is never sent;
 * 2. it is sent; an answer that says "try again" is sent again, the same body, up to NEW_ITEMS_ACKNOWLEDGE_MAX_SENDS
 *    times on step 3's read pauses (safe: the server decides by state, not by request);
 * 3. 400 `DROPSHIP_CATALOG_NOTICE_ACK_INVALID` is `stale` at once; any other refusal is `failed` at once.
 */
export async function runNewItemsAcknowledge(deps: NewItemsAcknowledgeDeps,
  line: Pick<NewItemsNoticeLine, "categoryId" | "throughArrivalId">): Promise<NewItemsAcknowledgeOutcome> {
  const body = dropshipCatalogNoticeAcknowledgeRequestSchema.safeParse({
    clientVersion: CATALOG_PAGE_CLIENT_VERSION, categoryId: line.categoryId, throughArrivalId: line.throughArrivalId,
  });
  if (!body.success) return { kind: "failed", message: NEW_ITEMS_WORDS.gotItFailed, code: null, status: null };
  for (let sends = 1; ; sends += 1) {
    try {
      return { kind: "acknowledged", answer: await deps.send(body.data) };
    } catch (error) {
      const code = error instanceof DropshipApiError ? error.code : null;
      const status = error instanceof DropshipApiError ? error.status : null;
      if (code === DROPSHIP_CATALOG_READ_ERROR_CODES.noticeAcknowledgeInvalid) return { kind: "stale" };
      if (!isTransientPublishError(error) || sends >= NEW_ITEMS_ACKNOWLEDGE_MAX_SENDS) {
        return { kind: "failed", message: NEW_ITEMS_WORDS.gotItFailed, code, status };
      }
      await deps.sleep(publishReadRetryDelayMs(sends - 1));
    }
  }
}

export type NewItemsNoticeQueryClient = Pick<QueryClient, "cancelQueries" | "setQueryData">;

/**
 * After a "Got it" the server took: the line goes from this page's notice at once (`withoutAcknowledged`), so it
 * can't be pressed twice while the read goes out; reads in flight are cancelled first, so an older answer can't bring
 * it back. The caller then reads the notice again.
 */
export async function hideAcknowledgedNewItems(queryClient: NewItemsNoticeQueryClient, answer: DropshipCatalogNoticeAcknowledgeAnswer): Promise<void> {
  await queryClient.cancelQueries({ queryKey: [...CATALOG_NEW_ITEMS_QUERY_KEY], exact: true });
  queryClient.setQueryData<DropshipCatalogNewItemsAnswer>([...CATALOG_NEW_ITEMS_QUERY_KEY],
    (current) => (current ? withoutAcknowledged(current, answer) : current));
}

export type NewItemsListsQueryClient = Pick<QueryClient, "invalidateQueries">;

/** Whether a cached step 1 list (CHOOSE_CATALOG_QUERY_KEY plus its filters) shows "New from Card Shellz". */
export function isNewItemsListQueryKey(queryKey: readonly unknown[]): boolean {
  const filters = queryKey[CHOOSE_CATALOG_QUERY_KEY.length];
  return queryKey[0] === CHOOSE_CATALOG_QUERY_KEY[0] && queryKey[1] === CHOOSE_CATALOG_QUERY_KEY[1]
    && typeof filters === "object" && filters !== null && (filters as { show?: unknown }).show === "new";
}

/**
 * After a "Got it" the server took (UIT-1): every cached "New from Card Shellz" list (any category, any search) was
 * read before it, and lists read with no stale time are otherwise shown from the cache as they were, so each is
 * marked stale and read again the next time it is shown. The list on screen is read again now, unless the press ends
 * the review (the step then shows "All", so that read would be wasted). Nothing is removed: a list keeps its rows on
 * screen until its new read answers, and a failed read keeps its own error and Try again.
 */
export function markNewItemsListsStale(queryClient: NewItemsListsQueryClient, input: { reviewEnds: boolean }): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: [...CHOOSE_CATALOG_QUERY_KEY],
    predicate: (query) => isNewItemsListQueryKey(query.queryKey),
    refetchType: input.reviewEnds ? "none" : "active",
  });
}
