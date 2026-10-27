import { describe, expect, it } from "vitest";
import {
  LISTING_END_OPS_SECTION_WORDS,
  LISTING_END_OPS_URL,
  LISTING_END_OPS_WORDS,
  buildListingEndResolveRequest,
  buildListingEndRetryRequest,
  canActOnListingEnd,
  checkListingEndResolveDraft,
  describeListingEndOpsError,
  describeListingEndResolveProblem,
  fetchListingEnds,
  isTransientListingEndOpsError,
  listingEndOpsListUrl,
  listingEndOpsPager,
  newListingEndStaffKey,
  sendListingEndAction,
  type ListingEndOpsFetch,
} from "../dropship-listing-end-ops";
import { DROPSHIP_SITE_UPDATING_CODE, DROPSHIP_SITE_UPDATING_MESSAGE, DropshipApiError } from "../dropship-ops-surface";
import {
  LISTING_END_REQUEST_STATES,
  listingEndResolveRequestSchema,
  listingEndRetryRequestSchema,
} from "@shared/dropship/listing-end-ops";

/**
 * The admin section's requests and words (PR C, PLAN-C v4.1 §10, §13.3; TST-9): the list, Retry and Mark resolved, each
 * answer read through readDropshipAnswer, so an older server's HTML 200 during a release is "site updating", never a
 * parse crash. The network is a script.
 */

function answer(body: string, init: { status?: number; contentType?: string } = {}): Response {
  return new Response(body, { status: init.status ?? 200, headers: { "content-type": init.contentType ?? "application/json" } });
}

function scripted(responses: Response[]): { fetcher: ListingEndOpsFetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetcher: async (url, init) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next) throw new Error("No answer scripted.");
      return next;
    },
  };
}

async function caught(work: Promise<unknown>): Promise<unknown> {
  return work.then(() => null, (error: unknown) => error);
}

const ROW = {
  endRequestId: 9,
  vendor: { vendorId: 70, memberId: "member-70", businessName: "Shop", email: null },
  store: { storeConnectionId: 801, platform: "ebay", status: "connected", displayName: "Store 801" },
  listing: { listingId: 5, status: "active", externalListingId: "L-1", externalOfferId: "O-1" },
  productId: 7001, productVariantId: 70011, sku: "S-70011", reason: "size_removed", state: "failed",
  code: "DROPSHIP_LISTING_END_WITHDRAW_UNCERTAIN", message: "m",
  context: { lastCode: "DROPSHIP_LISTING_END_WITHDRAW_UNCERTAIN", attemptIds: ["41"], evidence: "published", requiresReview: true },
  attemptCount: 1, deferralCount: 0, withdraw: { callCount: 1, requestedAt: "2026-10-26T09:00:00.000Z", returnedAt: null, outcome: null },
  staffAction: null, decidedAt: "2026-10-26T09:00:00.000Z", createdAt: "2026-10-25T12:00:00.000Z", updatedAt: "2026-10-26T09:00:00.000Z",
} as const;

describe("listing end staff words (§11, PROPOSED)", () => {
  it("are §11's admin words exactly", () => {
    expect(LISTING_END_OPS_WORDS).toEqual({
      staffSection: "eBay listings that couldn't be ended",
      staffRetry: "Retry",
      staffResolve: "Mark resolved",
      staffResolveEnded: "Ended on eBay",
      staffResolveLeft: "Left on sale",
      staffResolveReason: "What did you do on eBay?",
      staffRecoveryRequired: "Settle the open inventory request first (Inventory publication recovery), then retry.",
    });
  });
});

describe("listing end staff requests", () => {
  it("builds the list URL with only the values given", () => {
    expect(listingEndOpsListUrl({ state: "failed" })).toBe(`${LISTING_END_OPS_URL}?state=failed`);
    expect(listingEndOpsListUrl({ state: "ended", vendorId: 70, storeConnectionId: null, page: 2, limit: 50 }))
      .toBe(`${LISTING_END_OPS_URL}?state=ended&vendorId=70&page=2&limit=50`);
  });

  it("sends Retry with the key in the body and the header, and no empty reason", () => {
    const request = buildListingEndRetryRequest({ endRequestId: 9, idempotencyKey: "staff-key-0001", reason: "   " });
    expect(request).toMatchObject({ action: "retry", endRequestId: 9, url: `${LISTING_END_OPS_URL}/9/retry`,
      init: { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "Idempotency-Key": "staff-key-0001" } } });
    const body = JSON.parse(String(request.init.body));
    expect(body).toEqual({ idempotencyKey: "staff-key-0001" });
    expect(listingEndRetryRequestSchema.parse(body)).toEqual(body);
    expect(JSON.parse(String(buildListingEndRetryRequest({ endRequestId: 9, idempotencyKey: "staff-key-0001", reason: " Attested " }).init.body)))
      .toEqual({ reason: "Attested", idempotencyKey: "staff-key-0001" });
  });

  it("Mark resolved needs an outcome and a reason; each choice sends its own action", () => {
    expect(checkListingEndResolveDraft({ outcome: null, reason: "Ended it." })).toEqual({ ok: false, problem: "outcome_required" });
    expect(checkListingEndResolveDraft({ outcome: "ended_on_ebay", reason: "  " })).toEqual({ ok: false, problem: "reason_required" });
    expect(checkListingEndResolveDraft({ outcome: "left_on_sale", reason: "r".repeat(501) })).toEqual({ ok: false, problem: "reason_too_long" });
    expect(checkListingEndResolveDraft({ outcome: "left_on_sale", reason: " Kept it. " })).toEqual({ ok: true, outcome: "left_on_sale", reason: "Kept it." });
    expect(describeListingEndResolveProblem("outcome_required")).toBe(LISTING_END_OPS_SECTION_WORDS.outcomeRequired);
    expect(describeListingEndResolveProblem("reason_required")).toBe(LISTING_END_OPS_SECTION_WORDS.reasonRequired);
    expect(describeListingEndResolveProblem("reason_too_long")).toBe(LISTING_END_OPS_SECTION_WORDS.reasonTooLong);

    const ended = buildListingEndResolveRequest({ endRequestId: 9, idempotencyKey: "staff-key-0002", outcome: "ended_on_ebay", reason: "Ended it." });
    expect(ended).toMatchObject({ action: "resolve_ended", url: `${LISTING_END_OPS_URL}/9/resolve` });
    expect(listingEndResolveRequestSchema.parse(JSON.parse(String(ended.init.body))))
      .toEqual({ outcome: "ended_on_ebay", reason: "Ended it.", idempotencyKey: "staff-key-0002" });
    expect(buildListingEndResolveRequest({ endRequestId: 9, idempotencyKey: "staff-key-0003", outcome: "left_on_sale", reason: "x" }).action)
      .toBe("resolve_left");
  });

  it("makes a new key per press, naming the action and the request, inside the server's key bounds", () => {
    const first = newListingEndStaffKey("resolve_ended", 9);
    const second = newListingEndStaffKey("resolve_ended", 9);
    expect(first).toMatch(/^admin-listing-end-resolve_ended-9:/);
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(8);
    expect(first.length).toBeLessThanOrEqual(200);
  });

  it("only a failed end offers Retry and Mark resolved", () => {
    for (const state of LISTING_END_REQUEST_STATES) expect(canActOnListingEnd({ state })).toBe(state === "failed");
  });
});

describe("listing end staff answers (TST-9)", () => {
  it("reads the list and an action's answer through their schemas", async () => {
    const list = scripted([answer(JSON.stringify({ items: [ROW], total: 1, page: 1, limit: 50, state: "failed" }))]);
    await expect(fetchListingEnds(list.fetcher, { state: "failed", page: 1, limit: 50 })).resolves.toMatchObject({ total: 1, items: [{ endRequestId: 9 }] });
    expect(list.calls[0]).toMatchObject({ url: `${LISTING_END_OPS_URL}?state=failed&page=1&limit=50`, init: { method: "GET", credentials: "include" } });

    const action = scripted([answer(JSON.stringify({ endRequest: { ...ROW, state: "pending" }, action: "retry", idempotentReplay: false }))]);
    await expect(sendListingEndAction(action.fetcher, buildListingEndRetryRequest({ endRequestId: 9, idempotencyKey: "staff-key-0001" })))
      .resolves.toMatchObject({ action: "retry", endRequest: { state: "pending" } });
    expect(action.calls[0]?.url).toBe(`${LISTING_END_OPS_URL}/9/retry`);
  });

  it("reads an older server's HTML 200 (an unknown route during the release) as the transient 'site updating', keeping the key", async () => {
    for (const work of [
      (fetcher: ListingEndOpsFetch) => fetchListingEnds(fetcher, { state: "failed" }),
      (fetcher: ListingEndOpsFetch) => sendListingEndAction(fetcher, buildListingEndRetryRequest({ endRequestId: 9, idempotencyKey: "staff-key-0001" })),
    ]) {
      const error = await caught(work(scripted([answer("<!doctype html><html></html>", { contentType: "text/html; charset=UTF-8" })]).fetcher));
      expect(error).toMatchObject({ code: DROPSHIP_SITE_UPDATING_CODE, context: { reason: "not_json", answerStatus: 200 } });
      expect(isTransientListingEndOpsError(error)).toBe(true);
      expect(describeListingEndOpsError(error)).toBe(DROPSHIP_SITE_UPDATING_MESSAGE);
    }
    // JSON without a field the section needs (an older server's other shape) is the same transient.
    const error = await caught(fetchListingEnds(scripted([answer(JSON.stringify({ items: [] }))]).fetcher, { state: "failed" }));
    expect(error).toMatchObject({ code: DROPSHIP_SITE_UPDATING_CODE, context: { reason: "answer_shape" } });
  });

  it("shows §11's words for the recovery refusal and the server's words otherwise; refusals end the key", async () => {
    const recovery = await caught(sendListingEndAction(scripted([answer(JSON.stringify({ error: {
      code: "DROPSHIP_LISTING_END_QUANTITY_RECOVERY_REQUIRED", message: "server words", context: { attemptIds: ["41"] } } }), { status: 409 })]).fetcher,
    buildListingEndRetryRequest({ endRequestId: 9, idempotencyKey: "staff-key-0001" })));
    expect(describeListingEndOpsError(recovery)).toBe(LISTING_END_OPS_WORDS.staffRecoveryRequired);
    expect(isTransientListingEndOpsError(recovery)).toBe(false);

    const state = new DropshipApiError({ message: "Only an end request that failed can be retried or marked resolved.", status: 409,
      code: "DROPSHIP_LISTING_END_STAFF_STATE_INVALID" });
    expect(describeListingEndOpsError(state)).toBe("Only an end request that failed can be retried or marked resolved.");
    expect(isTransientListingEndOpsError(state)).toBe(false);

    expect(isTransientListingEndOpsError(new DropshipApiError({ message: "busy", status: 503, code: "DROPSHIP_LISTING_END_STAFF_BUSY" }))).toBe(true);
    expect(isTransientListingEndOpsError(new TypeError("Failed to fetch"))).toBe(true);
    expect(describeListingEndOpsError("nothing")).toBe(LISTING_END_OPS_SECTION_WORDS.failedToLoad);
  });
});

/**
 * Review TST-1: Retry and Mark resolved move a row out of the state staff filter on, and the action refetches the same
 * page, so it can empty the last page. Once that answer has settled the section steps back to the last page that has
 * rows, and any page past the first keeps a way back while nothing is read. The network is a script; the page's state
 * is the `page` the section passes in.
 */
describe("listing end staff pager (review TST-1)", () => {
  const LIMIT = 50;
  const rows = (count: number, newestId: number) => Array.from({ length: count }, (_, index) => ({ ...ROW, endRequestId: newestId - index }));
  const listAnswer = (page: number, total: number, count: number, newestId: number) =>
    answer(JSON.stringify({ items: rows(count, newestId), total, page, limit: LIMIT, state: "failed" }));

  it("shows Previous/Next only when there is more than one page", () => {
    expect(listingEndOpsPager({ page: 1, limit: LIMIT, answer: { total: 0, settled: true } }))
      .toEqual({ show: false, label: "1 / 1", lastPage: 1, canGoBack: false, canGoForward: false, stepBackTo: null });
    expect(listingEndOpsPager({ page: 1, limit: LIMIT, answer: { total: 50, settled: true } })).toMatchObject({ show: false, lastPage: 1 });
    expect(listingEndOpsPager({ page: 1, limit: LIMIT, answer: { total: 51, settled: true } }))
      .toEqual({ show: true, label: "1 / 2", lastPage: 2, canGoBack: false, canGoForward: true, stepBackTo: null });
    expect(listingEndOpsPager({ page: 2, limit: LIMIT, answer: { total: 51, settled: true } }))
      .toEqual({ show: true, label: "2 / 2", lastPage: 2, canGoBack: true, canGoForward: false, stepBackTo: null });
  });

  it("51 failed ends, the one on page 2 marked resolved: steps back to page 1 instead of an empty page with no pager", async () => {
    const net = scripted([
      listAnswer(2, 51, 1, 1),
      // The refetch after Mark resolved (the row left `failed`): offset 50 has nothing, 50 remain.
      listAnswer(2, 50, 0, 0),
      listAnswer(1, 50, 50, 51),
    ]);
    let page = 2;
    const before = await fetchListingEnds(net.fetcher, { state: "failed", page, limit: LIMIT });
    expect(listingEndOpsPager({ page, limit: LIMIT, answer: { total: before.total, settled: true } }))
      .toMatchObject({ show: true, label: "2 / 2", stepBackTo: null });

    const emptied = await fetchListingEnds(net.fetcher, { state: "failed", page, limit: LIMIT });
    expect(emptied.items).toEqual([]);
    // While the refetch runs the old answer stays on screen; nothing moves on it.
    expect(listingEndOpsPager({ page, limit: LIMIT, answer: { total: before.total, settled: false } }).stepBackTo).toBeNull();
    const settled = listingEndOpsPager({ page, limit: LIMIT, answer: { total: emptied.total, settled: true } });
    expect(settled).toEqual({ show: true, label: "2", lastPage: 1, canGoBack: true, canGoForward: false, stepBackTo: 1 });

    page = settled.stepBackTo ?? page;
    const back = await fetchListingEnds(net.fetcher, { state: "failed", page, limit: LIMIT });
    expect(back.items).toHaveLength(50);
    expect(listingEndOpsPager({ page, limit: LIMIT, answer: { total: back.total, settled: true } }))
      .toEqual({ show: false, label: "1 / 1", lastPage: 1, canGoBack: false, canGoForward: false, stepBackTo: null });
    expect(net.calls.map((call) => call.url)).toEqual([
      `${LISTING_END_OPS_URL}?state=failed&page=2&limit=50`,
      `${LISTING_END_OPS_URL}?state=failed&page=2&limit=50`,
      `${LISTING_END_OPS_URL}?state=failed&page=1&limit=50`,
    ]);
  });

  it("101 failed ends, the one on page 3 retried: steps back to page 2 and never reads '3 / 2'", () => {
    const emptied = listingEndOpsPager({ page: 3, limit: LIMIT, answer: { total: 100, settled: true } });
    expect(emptied).toMatchObject({ stepBackTo: 2, lastPage: 2, label: "3" });
    expect(emptied.label).not.toBe("3 / 2");
    expect(listingEndOpsPager({ page: 2, limit: LIMIT, answer: { total: 100, settled: true } }))
      .toEqual({ show: true, label: "2 / 2", lastPage: 2, canGoBack: true, canGoForward: false, stepBackTo: null });
    // Every row gone (all moved out of the state): back to page 1.
    expect(listingEndOpsPager({ page: 7, limit: LIMIT, answer: { total: 0, settled: true } })).toMatchObject({ stepBackTo: 1 });
  });

  it("does not step back on a cached answer while its refetch runs (the newer total may have more pages)", () => {
    expect(listingEndOpsPager({ page: 2, limit: LIMIT, answer: { total: 50, settled: false } }))
      .toEqual({ show: true, label: "2", lastPage: 1, canGoBack: true, canGoForward: false, stepBackTo: null });
  });

  it("keeps a way back on any page past the first while no answer is read (loading, or the list failed)", () => {
    expect(listingEndOpsPager({ page: 2, limit: LIMIT, answer: null }))
      .toEqual({ show: true, label: "2", lastPage: null, canGoBack: true, canGoForward: false, stepBackTo: null });
    expect(listingEndOpsPager({ page: 1, limit: LIMIT, answer: null }))
      .toEqual({ show: false, label: "1", lastPage: null, canGoBack: false, canGoForward: false, stepBackTo: null });
  });
});
