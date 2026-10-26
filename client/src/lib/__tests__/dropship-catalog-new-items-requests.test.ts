import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  DROPSHIP_CATALOG_READ_ERROR_CODES,
  type DropshipCatalogNewItemsAnswer,
  type DropshipCatalogNoticeAcknowledgeAnswer,
  type DropshipCatalogNoticeAcknowledgeRequest,
} from "@shared/dropship/vendor-catalog-reads";
import {
  CATALOG_NEW_ITEMS_ACKNOWLEDGE_URL,
  CATALOG_NEW_ITEMS_QUERY_KEY,
  CATALOG_NEW_ITEMS_URL,
  NEW_ITEMS_ACKNOWLEDGE_MAX_SENDS,
  catalogNewItemsQueryOptions,
  catalogNewItemsUrl,
  hideAcknowledgedNewItems,
  isNewItemsListQueryKey,
  markNewItemsListsStale,
  postCatalogNewItemsAcknowledge,
  runNewItemsAcknowledge,
  type NewItemsAcknowledgeDeps,
  type NewItemsNoticeQueryClient,
} from "../dropship-catalog-new-items-requests";
import { CHOOSE_CATALOG_QUERY_KEY, CHOOSE_IDS_QUERY_KEY, chooseCatalogUrl, chooseIdsUrl, type ChooseFetch } from "../dropship-catalog-choose-requests";
import { newItemsReviewFilters } from "../dropship-catalog-new-items";
import { NEW_ITEMS_WORDS } from "../dropship-catalog-new-items-words";
import { publishReadRetryDelayMs, retryPublishRead } from "../dropship-catalog-publish";
import { DROPSHIP_SITE_UPDATING_CODE, DropshipApiError } from "../dropship-ops-surface";

function respond(body: unknown, status = 200, contentType = "application/json"): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": contentType } });
}

function fetcher(...answers: Response[]): { fetch: ChooseFetch; requests: Array<{ url: string; init?: RequestInit }> } {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  return {
    requests,
    fetch: async (url, init) => {
      requests.push({ url, init });
      const next = answers.shift();
      if (!next) throw new Error("unscripted fetch");
      return next;
    },
  };
}

const api = (status: number, code: string | null) => new DropshipApiError({ status, code, message: "Server words." });
const NEW_ITEMS: DropshipCatalogNewItemsAnswer = Object.freeze({
  categories: Object.freeze([
    Object.freeze({ categoryId: 61, categoryName: "Armalope", productCount: 1, sizeCount: 3, throughArrivalId: 104 }),
    Object.freeze({ categoryId: 40, categoryName: "Sleeves", productCount: 1, sizeCount: 1, throughArrivalId: 99 }),
  ]) as DropshipCatalogNewItemsAnswer["categories"],
});
const ACKNOWLEDGED: DropshipCatalogNoticeAcknowledgeAnswer = Object.freeze({ outcome: "acknowledged", categoryId: 61, seenThroughArrivalId: 104 });
const LINE = Object.freeze({ categoryId: 61, throughArrivalId: 104 });

/** Injected deps with scripted answers; every body sent and every pause recorded. */
function harness(...answers: Array<DropshipCatalogNoticeAcknowledgeAnswer | Error>) {
  const sent: DropshipCatalogNoticeAcknowledgeRequest[] = [];
  const sleeps: number[] = [];
  const deps: NewItemsAcknowledgeDeps = {
    send: async (body) => {
      sent.push(body);
      const next = answers.shift();
      if (next === undefined) throw new Error("unscripted send");
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async (ms) => { sleeps.push(ms); },
  };
  return { deps, sent, sleeps };
}

describe("the notice's read (§11.4, §12.2)", () => {
  it("Q1 reads GET /api/dropship/catalog/new-items with this page's version only, with the portal's cookie, through the shared schema", async () => {
    expect(catalogNewItemsUrl()).toBe("/api/dropship/catalog/new-items?clientVersion=3");
    const good = fetcher(respond(NEW_ITEMS));
    const options = catalogNewItemsQueryOptions(good.fetch);
    expect(options.queryKey).toEqual([CATALOG_NEW_ITEMS_URL]);
    expect(CATALOG_NEW_ITEMS_QUERY_KEY).toEqual(["/api/dropship/catalog/new-items"]);
    const read = await (options.queryFn as (context: { signal: AbortSignal }) => Promise<DropshipCatalogNewItemsAnswer>)({ signal: new AbortController().signal });
    expect(read).toEqual(NEW_ITEMS);
    expect(good.requests[0]).toMatchObject({ url: "/api/dropship/catalog/new-items?clientVersion=3", init: { method: "GET", credentials: "include" } });
  });

  it("Q2 retried on step 3's schedule like every step 1 read (V11), never on focus", () => {
    const options = catalogNewItemsQueryOptions();
    expect(options.retry).toBe(retryPublishRead);
    expect(options.retryDelay).toBe(publishReadRetryDelayMs);
    expect(options.refetchOnWindowFocus).toBe(false);
  });

  it("Q3 an older server's answer (its HTML, or JSON without throughArrivalId) is site updating, which is read again", async () => {
    const queryFn = (fetch: ChooseFetch) => catalogNewItemsQueryOptions(fetch).queryFn as (context: { signal: AbortSignal }) => Promise<unknown>;
    const signal = new AbortController().signal;
    const html = fetcher(respond("<!doctype html><html></html>", 200, "text/html"));
    await expect(queryFn(html.fetch)({ signal })).rejects.toMatchObject({ code: DROPSHIP_SITE_UPDATING_CODE, context: { reason: "not_json" } });
    const older = fetcher(respond({ categories: [{ categoryId: 61, categoryName: "Armalope", productCount: 1, sizeCount: 3 }] }));
    await expect(queryFn(older.fetch)({ signal })).rejects.toMatchObject({ code: DROPSHIP_SITE_UPDATING_CODE, context: { reason: "answer_shape" } });
    expect(retryPublishRead(0, new DropshipApiError({ status: 503, code: DROPSHIP_SITE_UPDATING_CODE, message: "x" }))).toBe(true);
  });

  it("Q4 (LR Show new) Review's list and id reads send selection=new with the line's category id, the page's version, no search", () => {
    const review = newItemsReviewFilters(61);
    expect(chooseCatalogUrl(review, 1)).toBe("/api/dropship/catalog?categoryId=61&selection=new&includeFacets=false&clientVersion=3&page=1&limit=200");
    expect(chooseIdsUrl(review, "add")).toBe("/api/dropship/catalog?categoryId=61&selection=new&idsOnly=true&purpose=add&clientVersion=3");
  });
});

describe("Got it (§11.4, §14)", () => {
  it("K1 sends the line's category and throughArrivalId with this page's version, once, and returns the server's answer", async () => {
    const { deps, sent, sleeps } = harness(ACKNOWLEDGED);
    expect(await runNewItemsAcknowledge(deps, LINE)).toEqual({ kind: "acknowledged", answer: ACKNOWLEDGED });
    expect(sent).toEqual([{ clientVersion: 3, categoryId: 61, throughArrivalId: 104 }]);
    expect(sleeps).toEqual([]);
    // An earlier press (another tab) is the same outcome: the line goes.
    const seen = { ...ACKNOWLEDGED, outcome: "already_seen" as const };
    expect(await runNewItemsAcknowledge(harness(seen).deps, LINE)).toEqual({ kind: "acknowledged", answer: seen });
  });

  it("K2 an answer that says try again (no answer, an older server, a 5xx, a 429) is sent again, the same body, on the read pauses", async () => {
    const { deps, sent, sleeps } = harness(new TypeError("Failed to fetch"), api(503, DROPSHIP_SITE_UPDATING_CODE), ACKNOWLEDGED);
    expect(await runNewItemsAcknowledge(deps, LINE)).toEqual({ kind: "acknowledged", answer: ACKNOWLEDGED });
    expect(sent).toHaveLength(3);
    for (const body of sent) expect(body).toEqual(sent[0]);
    expect(sleeps).toEqual([publishReadRetryDelayMs(0), publishReadRetryDelayMs(1)]);
    expect(sleeps).toEqual([3_000, 3_000]);
  });

  it("K3 past NEW_ITEMS_ACKNOWLEDGE_MAX_SENDS sends: failed in the kept words, and the line stays", async () => {
    expect(NEW_ITEMS_ACKNOWLEDGE_MAX_SENDS).toBe(4);
    const { deps, sent, sleeps } = harness(api(500, "DROPSHIP_VENDOR_CATALOG_INTERNAL_ERROR"), api(502, null), api(429, "DROPSHIP_RATE_LIMITED"),
      api(503, DROPSHIP_CATALOG_READ_ERROR_CODES.writesPaused), ACKNOWLEDGED);
    expect(await runNewItemsAcknowledge(deps, LINE)).toEqual({ kind: "failed", message: NEW_ITEMS_WORDS.gotItFailed,
      code: DROPSHIP_CATALOG_READ_ERROR_CODES.writesPaused, status: 503 });
    expect(sent).toHaveLength(NEW_ITEMS_ACKNOWLEDGE_MAX_SENDS);
    expect(sleeps).toHaveLength(NEW_ITEMS_ACKNOWLEDGE_MAX_SENDS - 1);
  });

  it("K4 an arrival id past the newest (400 NOTICE_ACK_INVALID) is stale at once: no words, the notice is read again (§14)", async () => {
    const { deps, sent, sleeps } = harness(api(400, DROPSHIP_CATALOG_READ_ERROR_CODES.noticeAcknowledgeInvalid));
    expect(await runNewItemsAcknowledge(deps, LINE)).toEqual({ kind: "stale" });
    expect(sent).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("K5 any other refusal is failed at once, never sent again (permanent: a malformed body, signed out)", async () => {
    for (const refusal of [api(400, DROPSHIP_CATALOG_READ_ERROR_CODES.newItemsInvalidInput), api(401, "DROPSHIP_AUTH_REQUIRED")]) {
      const { deps, sent, sleeps } = harness(refusal, ACKNOWLEDGED);
      expect(await runNewItemsAcknowledge(deps, LINE)).toMatchObject({ kind: "failed", message: NEW_ITEMS_WORDS.gotItFailed, status: refusal.status });
      expect(sent).toHaveLength(1);
      expect(sleeps).toEqual([]);
    }
  });

  it("K6 a line the server's strict schema refuses (no arrival id, not a whole number) is never sent", async () => {
    for (const line of [{ categoryId: 61, throughArrivalId: 0 }, { categoryId: 61, throughArrivalId: 1.5 }, { categoryId: -1, throughArrivalId: 3 }]) {
      const { deps, sent } = harness(ACKNOWLEDGED);
      expect(await runNewItemsAcknowledge(deps, line)).toEqual({ kind: "failed", message: NEW_ITEMS_WORDS.gotItFailed, code: null, status: null });
      expect(sent).toEqual([]);
    }
  });

  it("K7 the POST sends JSON to its route with the portal's cookie; its answer is read through the shared schema", async () => {
    const body = { clientVersion: 3, categoryId: 61, throughArrivalId: 104 };
    const good = fetcher(respond(ACKNOWLEDGED));
    expect(await postCatalogNewItemsAcknowledge(body, good.fetch)).toEqual(ACKNOWLEDGED);
    expect(good.requests[0]).toMatchObject({ url: CATALOG_NEW_ITEMS_ACKNOWLEDGE_URL,
      init: { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } });
    expect(CATALOG_NEW_ITEMS_ACKNOWLEDGE_URL).toBe("/api/dropship/catalog/new-items/acknowledge");
    // An older server that does not know the route answers its HTML with 200: site updating, sent again.
    const html = fetcher(respond("<!doctype html>", 200, "text/html"));
    await expect(postCatalogNewItemsAcknowledge(body, html.fetch)).rejects.toMatchObject({ code: DROPSHIP_SITE_UPDATING_CODE });
    // A refusal keeps its code.
    const refused = fetcher(respond({ error: { code: DROPSHIP_CATALOG_READ_ERROR_CODES.noticeAcknowledgeInvalid, message: "x" } }, 400));
    await expect(postCatalogNewItemsAcknowledge(body, refused.fetch)).rejects.toMatchObject({ status: 400,
      code: DROPSHIP_CATALOG_READ_ERROR_CODES.noticeAcknowledgeInvalid });
  });

  it("K8 once the server took it, the line goes from this page's notice at once, reads in flight cancelled first", async () => {
    const calls: string[] = [];
    let data: DropshipCatalogNewItemsAnswer | undefined = NEW_ITEMS;
    const queryClient = {
      cancelQueries: async (filters: unknown) => { calls.push(`cancel ${JSON.stringify(filters)}`); },
      setQueryData: (key: unknown, updater: (current: DropshipCatalogNewItemsAnswer | undefined) => DropshipCatalogNewItemsAnswer | undefined) => {
        calls.push(`set ${JSON.stringify(key)}`);
        data = updater(data);
        return data;
      },
    } as unknown as NewItemsNoticeQueryClient;
    await hideAcknowledgedNewItems(queryClient, ACKNOWLEDGED);
    expect(calls).toEqual([
      `cancel ${JSON.stringify({ queryKey: ["/api/dropship/catalog/new-items"], exact: true })}`,
      `set ${JSON.stringify(["/api/dropship/catalog/new-items"])}`,
    ]);
    expect(data?.categories.map((category) => category.categoryId)).toEqual([40]);
    expect(NEW_ITEMS.categories).toHaveLength(2);
    // Nothing read yet: nothing to take off.
    data = undefined;
    await hideAcknowledgedNewItems(queryClient, ACKNOWLEDGED);
    expect(data).toBeUndefined();
  });

  it("K9 after a taken Got it every cached New-from-Card-Shellz list is stale, the shown one read again unless the review ends (UIT-1)", async () => {
    const list = (categoryId: number | null, show: string, search = "") => [...CHOOSE_CATALOG_QUERY_KEY, { search, categoryId, show }];
    const keys = {
      reviewed: list(61, "new"), all: list(null, "new"), searched: list(62, "new", "sleeve"), everyRow: list(61, "all"),
      ids: [...CHOOSE_IDS_QUERY_KEY, { search: "", categoryId: 61, show: "new", purpose: "add" }],
    };
    expect(Object.entries(keys).filter(([, key]) => isNewItemsListQueryKey(key)).map(([name]) => name)).toEqual(["reviewed", "all", "searched"]);
    expect(isNewItemsListQueryKey(["/api/other", "choose", { show: "new" }])).toBe(false);

    for (const reviewEnds of [false, true]) {
      // The app's client: no stale time, so without this a cached list comes back as it was, with no request.
      const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
      for (const key of Object.values(keys)) queryClient.setQueryData(key, { rows: ["read before Got it"] });
      const reads: string[] = [];
      // The list on screen ("All categories", Show new) has an observer: it is the active query.
      const shown = new QueryObserver(queryClient, { queryKey: keys.all, queryFn: async () => { reads.push("all"); return { rows: [] }; } });
      const unsubscribe = shown.subscribe(() => undefined);
      await markNewItemsListsStale(queryClient, { reviewEnds });
      // The shown list is read again now while the review goes on (and is fresh after it); otherwise, like every list not
      // shown, it stays stale and is read when it is shown again. Neither the all-rows list nor an id list is touched.
      const invalidated = Object.entries(keys).filter(([, key]) => queryClient.getQueryState(key)?.isInvalidated).map(([name]) => name);
      expect(invalidated, String(reviewEnds)).toEqual(reviewEnds ? ["reviewed", "all", "searched"] : ["reviewed", "searched"]);
      expect(reads, String(reviewEnds)).toEqual(reviewEnds ? [] : ["all"]);
      expect(queryClient.getQueryData(keys.all), String(reviewEnds)).toEqual(reviewEnds ? { rows: ["read before Got it"] } : { rows: [] });
      unsubscribe();
      queryClient.clear();
    }
  });
});
