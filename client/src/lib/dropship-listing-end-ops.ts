/**
 * The admin page's section "eBay listings that couldn't be ended" (PR C, PLAN-C v4.1 §10, DC33): the list, Retry and
 * Mark resolved ("Ended on eBay" or "Left on sale", reason required). Kept out of `dropship-ops-surface.ts`, which most
 * portal pages import, so this section's changes select only its own tests (TST-11).
 *
 * Every answer is read through `readDropshipAnswer` (TST-9): while Card Shellz deploys, an older server answers these
 * new routes with the app's HTML and status 200; that answer is the transient `DROPSHIP_SITE_UPDATING`, never a parse
 * crash. A press keeps its idempotency key while its failure is transient, so pressing again replays the same action
 * (the server answers a key it already took with the row as it now is); any other answer ends the key.
 */
import {
  LISTING_END_OPS_ERROR_CODES,
  LISTING_END_STAFF_REASON_MAX_LENGTH,
  listingEndOpsActionAnswerSchema,
  listingEndOpsListAnswerSchema,
  type ListingEndOpsActionAnswer,
  type ListingEndOpsListAnswer,
  type ListingEndOpsRow,
  type ListingEndRequestState,
  type ListingEndStaffAction,
  type ListingEndStaffOutcome,
} from "@shared/dropship/listing-end-ops";
import {
  buildQueryUrl,
  createDropshipIdempotencyKey,
  DROPSHIP_SITE_UPDATING_MESSAGE,
  DropshipApiError,
  isDropshipSiteUpdatingError,
  readDropshipAnswer,
} from "./dropship-ops-surface";

export const LISTING_END_OPS_URL = "/api/dropship/admin/listing-ends";
/** Every list query's key starts with this, so an action can mark every page stale at once. */
export const LISTING_END_OPS_QUERY_KEY = [LISTING_END_OPS_URL] as const;

// Stage 4 (step 1 plan S2-5): PROPOSED.
export const LISTING_END_OPS_WORDS = Object.freeze({
  staffSection: "eBay listings that couldn't be ended",
  staffRetry: "Retry",
  staffResolve: "Mark resolved",
  staffResolveEnded: "Ended on eBay",
  staffResolveLeft: "Left on sale",
  staffResolveReason: "What did you do on eBay?",
  staffRecoveryRequired: "Settle the open inventory request first (Inventory publication recovery), then retry.",
});

// Stage 4 (step 1 plan S2-5): PROPOSED. The section's other words (not in §11; BUILD-NOTES D-C5-7).
export const LISTING_END_OPS_SECTION_WORDS = Object.freeze({
  intro: "Card Shellz couldn't end these eBay listings by itself. They stay at quantity 0 until a person decides.",
  empty: "No eBay listing ends in this state.",
  reasonRequired: "Write what you did on eBay first.",
  reasonTooLong: "Keep it to 500 characters or fewer.",
  outcomeRequired: "Choose Ended on eBay or Left on sale first.",
  retried: "The end will be tried again.",
  resolved: "Marked resolved.",
  failedToLoad: "The list couldn't be loaded.",
  stateFilter: "State",
  cancel: "Cancel",
  previous: "Previous",
  next: "Next",
  columns: Object.freeze({
    listing: "Listing",
    vendorStore: "Vendor/store",
    size: "Size",
    state: "State",
    problem: "Problem",
    tries: "Tries",
    decided: "Decided",
    action: "Action",
  }),
});

/** The network as the section uses it (window.fetch in the page; a script in tests). */
export type ListingEndOpsFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ListingEndOpsQuery {
  state: ListingEndRequestState;
  vendorId?: number | null;
  storeConnectionId?: number | null;
  page?: number;
  limit?: number;
}

export function listingEndOpsListUrl(query: ListingEndOpsQuery): string {
  return buildQueryUrl(LISTING_END_OPS_URL, {
    state: query.state,
    vendorId: query.vendorId ?? undefined,
    storeConnectionId: query.storeConnectionId ?? undefined,
    page: query.page,
    limit: query.limit,
  });
}

export async function fetchListingEnds(fetcher: ListingEndOpsFetch, query: ListingEndOpsQuery, signal?: AbortSignal):
  Promise<ListingEndOpsListAnswer> {
  const response = await fetcher(listingEndOpsListUrl(query), { method: "GET", credentials: "include", signal });
  return readDropshipAnswer(response, listingEndOpsListAnswerSchema);
}

/** One staff action, ready to send: the key travels in the body and in the header (the routes read either). */
export interface ListingEndOpsActionRequest {
  action: ListingEndStaffAction;
  endRequestId: number;
  url: string;
  init: RequestInit;
}

function actionRequest(action: ListingEndStaffAction, endRequestId: number, path: "retry" | "resolve", idempotencyKey: string,
  body: Record<string, unknown>): ListingEndOpsActionRequest {
  return {
    action,
    endRequestId,
    url: `${LISTING_END_OPS_URL}/${endRequestId}/${path}`,
    init: {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ ...body, idempotencyKey }),
    },
  };
}

export function buildListingEndRetryRequest(input: { endRequestId: number; idempotencyKey: string; reason?: string | null }):
  ListingEndOpsActionRequest {
  const reason = input.reason?.trim() ?? "";
  return actionRequest("retry", input.endRequestId, "retry", input.idempotencyKey, reason === "" ? {} : { reason });
}

/** What staff filled in to mark an end resolved. */
export interface ListingEndResolveDraft {
  outcome: ListingEndStaffOutcome | null;
  reason: string;
}

export type ListingEndResolveCheck =
  | { ok: true; outcome: ListingEndStaffOutcome; reason: string }
  | { ok: false; problem: "outcome_required" | "reason_required" | "reason_too_long" };

/** Mark resolved needs an outcome and a reason of 1-500 characters (SAF-8); nothing is sent without both. */
export function checkListingEndResolveDraft(draft: ListingEndResolveDraft): ListingEndResolveCheck {
  if (draft.outcome === null) return { ok: false, problem: "outcome_required" };
  const reason = draft.reason.trim();
  if (reason === "") return { ok: false, problem: "reason_required" };
  if (reason.length > LISTING_END_STAFF_REASON_MAX_LENGTH) return { ok: false, problem: "reason_too_long" };
  return { ok: true, outcome: draft.outcome, reason };
}

export function buildListingEndResolveRequest(input: { endRequestId: number; idempotencyKey: string; outcome: ListingEndStaffOutcome;
  reason: string }): ListingEndOpsActionRequest {
  return actionRequest(input.outcome === "ended_on_ebay" ? "resolve_ended" : "resolve_left", input.endRequestId, "resolve",
    input.idempotencyKey, { outcome: input.outcome, reason: input.reason.trim() });
}

export async function sendListingEndAction(fetcher: ListingEndOpsFetch, request: ListingEndOpsActionRequest):
  Promise<ListingEndOpsActionAnswer> {
  return readDropshipAnswer(await fetcher(request.url, request.init), listingEndOpsActionAnswerSchema);
}

/** A key for one press on one request (the action and the id in its prefix, so the audit trail reads it). */
export function newListingEndStaffKey(action: ListingEndStaffAction, endRequestId: number): string {
  return createDropshipIdempotencyKey(`admin-listing-end-${action}-${endRequestId}`);
}

/** The press is worth sending again with the same key: the site was updating, a lock was busy, or the network failed. */
export function isTransientListingEndOpsError(error: unknown): boolean {
  if (isDropshipSiteUpdatingError(error)) return true;
  if (error instanceof DropshipApiError) return error.code === LISTING_END_OPS_ERROR_CODES.staffBusy || error.status >= 500;
  return error instanceof TypeError;
}

/** What the section's pager shows on the page staff stand on (review TST-1). */
export interface ListingEndOpsPager {
  /** Previous/Next show when the answer names more than one page, or on any page past the first (a way back). */
  show: boolean;
  /** "page / last" while the page is one the answer has; the page alone before an answer or past the last page. */
  label: string;
  /** The last page the newest answer names; null before the first answer for this page. */
  lastPage: number | null;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The page to step back to: the settled answer says the page staff stand on is past the last one. */
  stepBackTo: number | null;
}

/**
 * Retry and Mark resolved move a row out of the state staff filter on, and the action refetches the same page, so an
 * action can empty the last page (51 failed ends, the one on page 2 resolved: offset 50 answers nothing, total 50). Once
 * that answer has settled the section steps back to the last page that has rows. It never steps back on an answer
 * whose refetch is still running: that answer may be an older total than the one on its way.
 */
export function listingEndOpsPager(input: {
  page: number;
  limit: number;
  /** The newest answer for this page and whether its fetch has settled; null before the first answer. */
  answer: { total: number; settled: boolean } | null;
}): ListingEndOpsPager {
  const { page, limit, answer } = input;
  const lastPage = answer === null ? null : Math.max(1, Math.ceil(answer.total / limit));
  const pastLastPage = lastPage !== null && page > lastPage;
  return {
    show: page > 1 || (lastPage ?? 1) > 1,
    label: lastPage === null || pastLastPage ? `${page}` : `${page} / ${lastPage}`,
    lastPage,
    canGoBack: page > 1,
    canGoForward: lastPage !== null && page < lastPage,
    stepBackTo: pastLastPage && answer?.settled ? lastPage : null,
  };
}

/** Only a failed end takes a staff action; `pending`/`ending` are the worker's and every other state is final. */
export function canActOnListingEnd(row: Pick<ListingEndOpsRow, "state">): boolean {
  return row.state === "failed";
}

export function describeListingEndOpsError(error: unknown): string {
  if (isDropshipSiteUpdatingError(error)) return DROPSHIP_SITE_UPDATING_MESSAGE;
  if (error instanceof DropshipApiError) {
    if (error.code === LISTING_END_OPS_ERROR_CODES.quantityRecoveryRequired) return LISTING_END_OPS_WORDS.staffRecoveryRequired;
    return error.message;
  }
  return error instanceof Error && error.message ? error.message : LISTING_END_OPS_SECTION_WORDS.failedToLoad;
}

export function describeListingEndResolveProblem(problem: Exclude<ListingEndResolveCheck, { ok: true }>["problem"]): string {
  if (problem === "outcome_required") return LISTING_END_OPS_SECTION_WORDS.outcomeRequired;
  if (problem === "reason_too_long") return LISTING_END_OPS_SECTION_WORDS.reasonTooLong;
  return LISTING_END_OPS_SECTION_WORDS.reasonRequired;
}
