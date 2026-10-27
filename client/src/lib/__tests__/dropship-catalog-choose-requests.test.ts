import { describe, expect, it } from "vitest";
import { DROPSHIP_CATALOG_READ_ERROR_CODES } from "@shared/dropship/vendor-catalog-reads";
import {
  SELECTION_CHANGE_ERROR_CODES,
  selectionChangeRequestSchema,
  type SelectionChangeAnswer,
  type SelectionChangePreviewAnswer,
  type SelectionChangePreviewRequest,
  type SelectionChangeRequest,
} from "@shared/dropship/vendor-selection-changes";
import {
  CHOOSE_BULK_BODY_LIMIT_BYTES,
  CHOOSE_BUSY_BACKOFF_MS,
  CHOOSE_PAUSED_MAX_SENDS,
  CHOOSE_SAVE_BACKOFF_MS,
  PAUSED_RETRY_WINDOW_MS,
  chooseBodyBytes,
  type ChooseChanges,
} from "../dropship-catalog-choose";
import {
  CHOOSE_EVERYTHING_FILTERS,
  chooseCatalogQueryOptions,
  chooseCatalogUrl,
  chooseCategoriesQueryOptions,
  chooseCategoriesUrl,
  chooseCategoryFilters,
  chooseIdsQueryOptions,
  chooseIdsUrl,
  choosePendingAfter,
  chooseReadErrorData,
  chooseUndoneAfterUnsure,
  describeChooseSaveOutcome,
  describeChooseSaveStatus,
  postChooseChange,
  postChoosePreview,
  readChooseCatalogPage,
  readChooseIds,
  runChooseSave,
  SELECTION_CHANGES_PREVIEW_URL,
  SELECTION_CHANGES_URL,
  type ChooseFetch,
  type ChoosePendingSave,
  type ChooseSaveDeps,
  type ChooseSaveOutcome,
  type ChooseSaveStatus,
} from "../dropship-catalog-choose-requests";
import { CHOOSE_WORDS } from "../dropship-catalog-choose-words";
import { retryPublishRead } from "../dropship-catalog-publish";
import { DROPSHIP_SITE_UPDATING_CODE, DropshipApiError } from "../dropship-ops-surface";
import { NEW_VERSION_SETTLE_MS, OLDER_PROCESS_GRACE_MS } from "../../../../server/modules/dropship/domain/catalog-code-version";

function frozenSet(ids: Iterable<number>): ReadonlySet<number> {
  const set = new Set(ids);
  const refuse = (): never => { throw new Error("a change set was mutated"); };
  Object.assign(set, { add: refuse, delete: refuse, clear: refuse });
  return Object.freeze(set);
}

function changes(add: Iterable<number>, remove: Iterable<number>, baseRevisionId: number | null = 7): ChooseChanges {
  return Object.freeze({ add: frozenSet(add), remove: frozenSet(remove), baseRevisionId });
}

const CHANGES = changes([105, 102], [101]);
const range = (from: number, count: number) => Array.from({ length: count }, (_, index) => from + index);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function preview(overrides: Partial<SelectionChangePreviewAnswer> = {}): SelectionChangePreviewAnswer {
  return Object.freeze({
    headRevisionId: 7, toAdd: 2, toRemove: 1, alreadySelected: 0, alreadyNotSelected: 0, skipped: { count: 0, first: [] },
    selectedBefore: 10, selectedAfter: 11, cap: 10_000, overCapAfter: false, refused: null,
    effects: [{ storeConnectionId: 1, storeName: "Card Corner", platform: "ebay", goesToZero: 1, startsSelling: 2, ends: 1,
      storeConnected: true }],
    effectsHash: HASH_A,
    // PR C: what the change ends, and the other entries' hash the save echoes with it (PLAN-C v4.1 §4.6).
    ends: { listingIds: [501], hiddenRemovedIds: [], otherSizes: 0, stillEnding: 0, endReview: 0, endedReAdd: 0 },
    otherEntriesHash: HASH_C,
    ...overrides,
  } as SelectionChangePreviewAnswer);
}

function answer(overrides: Partial<SelectionChangeAnswer> = {}): SelectionChangeAnswer {
  const { headRevisionId: _head, refused: _refused, ...planned } = preview();
  return Object.freeze({ ...planned, revisionId: 8, confirmedEffectsHash: HASH_A, drifted: false, ...overrides } as SelectionChangeAnswer);
}

const api = (status: number, code: string | null, context: Record<string, unknown> | null = null) =>
  new DropshipApiError({ status, code, context, message: "Server words." });
const busy = () => api(409, SELECTION_CHANGE_ERROR_CODES.busy);
const paused = () => api(503, SELECTION_CHANGE_ERROR_CODES.writesPaused, { reason: "older_version_running" });

type Scripted<T> = Array<T | Error>;

/** Injected deps with scripted answers, an injected clock that sleeps advance, and every call recorded in order. */
function harness(input: {
  previews?: Scripted<SelectionChangePreviewAnswer>;
  posts?: Scripted<{ answer: SelectionChangeAnswer; replay: boolean }>;
  confirms?: boolean[];
  /** Milliseconds each network call takes on the clock. */
  callMs?: number;
  /** False: the clock never moves (sleeps included). */
  clockMoves?: boolean;
} = {}) {
  const previews = [...(input.previews ?? [])];
  const posts = [...(input.posts ?? [])];
  const confirms = [...(input.confirms ?? [])];
  const moves = input.clockMoves !== false;
  let clock = 1_000_000;
  const calls: string[] = [];
  const sleeps: number[] = [];
  const statuses: ChooseSaveStatus[] = [];
  const previewed: SelectionChangePreviewRequest[] = [];
  const posted: SelectionChangeRequest[] = [];
  const questions: Array<{ preview: SelectionChangePreviewAnswer; effectsChanged: boolean }> = [];
  let keys = 0;
  function next<T>(script: Scripted<T>, what: string): T {
    if (moves) clock += input.callMs ?? 0;
    const value = script.shift();
    if (value === undefined) throw new Error(`unscripted ${what}`);
    if (value instanceof Error) throw value;
    return value;
  }
  const deps: ChooseSaveDeps = {
    preview: async (body) => { calls.push("preview"); previewed.push(body); return next(previews, "preview"); },
    post: async (body) => { calls.push("post"); posted.push(body); return next(posts, "post"); },
    confirm: async (shown, context) => {
      calls.push("confirm");
      questions.push({ preview: shown, effectsChanged: context.effectsChanged });
      return confirms.shift() ?? true;
    },
    sleep: async (ms) => { sleeps.push(ms); if (moves) clock += ms; },
    now: () => clock,
    newKey: () => `catalog-selection:key-${++keys}`,
    onStatus: (status) => { statuses.push(status); },
  };
  return { deps, calls, sleeps, statuses, previewed, posted, questions };
}

function sameKeyAndBody(posted: readonly SelectionChangeRequest[]) {
  expect(posted.length).toBeGreaterThan(0);
  for (const body of posted) expect(body).toEqual(posted[0]);
}

describe("reads (§12.2)", () => {
  it("Q1 the list sends search, the category id, Show, no facets, this page's version, the page and 200 rows; never selectedOnly or a name", () => {
    const url = chooseCatalogUrl({ search: "  toploader ", categoryId: 5, show: "not_selected" }, 2);
    expect(url).toBe("/api/dropship/catalog?search=toploader&categoryId=5&selection=not_selected&includeFacets=false&clientVersion=3&page=2&limit=200");
    expect(chooseCatalogUrl({ search: "", categoryId: null, show: "all" }, 1))
      .toBe("/api/dropship/catalog?selection=all&includeFacets=false&clientVersion=3&page=1&limit=200");
    expect(chooseCatalogUrl({ search: "x".repeat(250), categoryId: null, show: "selected" }, 1)).toContain(`search=${"x".repeat(200)}&`);
    for (const value of [url, chooseIdsUrl({ search: "a", categoryId: 5, show: "all" }, "add")]) {
      expect(value).not.toMatch(/selectedOnly|category=|productLine|productId/);
    }
  });

  it("Q2 the id reads: Check all with the table's filters, a category's box with its id only, Select everything with none", () => {
    expect(chooseIdsUrl({ search: "sleeve", categoryId: null, show: "selected" }, "remove"))
      .toBe("/api/dropship/catalog?search=sleeve&selection=selected&idsOnly=true&purpose=remove&clientVersion=3");
    expect(chooseIdsUrl(chooseCategoryFilters(12), "add")).toBe("/api/dropship/catalog?categoryId=12&selection=all&idsOnly=true&purpose=add&clientVersion=3");
    expect(chooseIdsUrl(CHOOSE_EVERYTHING_FILTERS, "add")).toBe("/api/dropship/catalog?selection=all&idsOnly=true&purpose=add&clientVersion=3");
    expect(chooseCategoriesUrl()).toBe("/api/dropship/catalog/categories?clientVersion=3");
  });

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
  const goodRow = {
    productId: 1, productVariantId: 2, productSku: null, productName: "P", variantSku: null, variantName: "S", category: null, categoryId: 5,
    selectionDecision: { selected: true, reason: "selected", marketplaceQuantity: 4, picked: true },
  };

  it("Q3 a page from older code (HTML, or a row without picked) is site updating; a page of the contract is read", async () => {
    const html = fetcher(respond("<!doctype html><html></html>", 200, "text/html"));
    await expect(readChooseCatalogPage("/x", html.fetch)).rejects.toMatchObject({ code: DROPSHIP_SITE_UPDATING_CODE, context: { reason: "not_json" } });
    const { picked: _picked, ...olderDecision } = goodRow.selectionDecision;
    const older = fetcher(respond({ rows: [{ ...goodRow, selectionDecision: olderDecision }], total: 1, page: 1, limit: 200, facets: null,
      summary: { matching: 1, matchingSelected: 1 } }));
    await expect(readChooseCatalogPage("/x", older.fetch)).rejects.toMatchObject({ code: DROPSHIP_SITE_UPDATING_CODE, context: { reason: "answer_shape" } });
    const good = fetcher(respond({ rows: [goodRow], total: 1, page: 1, limit: 200, facets: null, summary: { matching: 1, matchingSelected: 1 } }));
    expect((await readChooseCatalogPage("/x", good.fetch)).rows[0].selectionDecision.picked).toBe(true);
    expect(good.requests[0].init).toMatchObject({ method: "GET", credentials: "include" });
  });

  it("Q4 every step 1 read retries the transient failures on step 3's schedule, never retry: false", () => {
    const filters = { search: "", categoryId: null, show: "all" as const };
    expect(chooseCatalogQueryOptions(filters).retry).toBe(retryPublishRead);
    expect(chooseCategoriesQueryOptions().retry).toBe(retryPublishRead);
    expect(chooseIdsQueryOptions(filters, "add").retry).toBe(retryPublishRead);
    expect(chooseCatalogQueryOptions(filters).queryKey).toEqual(["/api/dropship/catalog", "choose", { search: "", categoryId: null, show: "all" }]);
    expect(retryPublishRead(0, new DropshipApiError({ status: 503, code: DROPSHIP_SITE_UPDATING_CODE, message: "x" }))).toBe(true);
    expect(retryPublishRead(0, new DropshipApiError({ status: 422, code: DROPSHIP_CATALOG_READ_ERROR_CODES.idsTooMany, message: "x" }))).toBe(false);
  });

  it("Q5 an id read whose needed list is null is off its contract; the other list may be null", async () => {
    const offContract = fetcher(respond({ selectedIds: [1], notSelectedIds: null, total: 10_050 }));
    await expect(readChooseIds(CHOOSE_EVERYTHING_FILTERS, "add", offContract.fetch)).rejects.toMatchObject({ code: "DROPSHIP_CATALOG_IDS_OFF_CONTRACT" });
    const fine = fetcher(respond({ selectedIds: null, notSelectedIds: [3, 4], total: 10_052 }));
    expect(await readChooseIds(CHOOSE_EVERYTHING_FILTERS, "add", fine.fetch)).toEqual({ selectedIds: null, notSelectedIds: [3, 4], total: 10_052 });
    expect(fine.requests[0].url).toBe("/api/dropship/catalog?selection=all&idsOnly=true&purpose=add&clientVersion=3");
  });

  it("Q6 a failure card names the code and, for older code's answer, why", () => {
    expect(chooseReadErrorData(new DropshipApiError({ status: 503, code: DROPSHIP_SITE_UPDATING_CODE, context: { reason: "answer_shape" }, message: "x" })))
      .toEqual({ "data-error-code": DROPSHIP_SITE_UPDATING_CODE, "data-error-reason": "answer_shape" });
    expect(chooseReadErrorData(new TypeError("Failed to fetch"))).toEqual({});
  });

  it("Q7 the two POSTs send JSON to their routes; the save tells a replay (200) from a first answer (201)", async () => {
    const body = { clientVersion: 3, expectedRevisionId: 7, add: { productVariantIds: [1] }, remove: { productVariantIds: [] } };
    const previewFetch = fetcher(respond(preview()));
    expect(await postChoosePreview(body, previewFetch.fetch)).toEqual(preview());
    expect(previewFetch.requests[0]).toMatchObject({ url: SELECTION_CHANGES_PREVIEW_URL,
      init: { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } });
    const saveBody = { ...body, idempotencyKey: "catalog-selection:k-1", expectedEffectsHash: HASH_A };
    const first = fetcher(respond(answer(), 201));
    expect(await postChooseChange(saveBody, first.fetch)).toEqual({ answer: answer(), replay: false });
    expect(first.requests[0].url).toBe(SELECTION_CHANGES_URL);
    const replay = fetcher(respond(answer(), 200));
    expect((await postChooseChange(saveBody, replay.fetch)).replay).toBe(true);
  });

  it("Q8 (C11) the save answered HTML, then a 413 without code, then writes paused, then saved: same key and body, paused shown", async () => {
    const saveFetch = fetcher(
      respond("<!doctype html>", 200, "text/html"),
      respond({ error: { message: "request entity too large" } }, 413),
      respond({ error: { code: SELECTION_CHANGE_ERROR_CODES.writesPaused, message: "x", context: { reason: "older_version_running" } } }, 503),
      respond(answer(), 201),
    );
    const run = harness({ previews: [preview()] });
    run.deps.post = (sent) => { run.posted.push(sent); return postChooseChange(sent, saveFetch.fetch); };
    const outcome = await runChooseSave(run.deps, { changes: CHANGES, pending: null });
    expect(outcome).toEqual({ kind: "saved", answer: answer(), replay: false });
    expect(run.posted).toHaveLength(4);
    sameKeyAndBody(run.posted);
    expect(saveFetch.requests.map((request) => request.init?.body)).toEqual(Array(4).fill(JSON.stringify(run.posted[0])));
    expect(run.sleeps).toEqual([2_000, 4_000, 8_000]);
    expect(run.statuses).toEqual(["paused", "paused", "paused"]);
  });
});

describe("the save (§12.4)", () => {
  it("S1 preview, question, save: both bodies carry clientVersion 3, the base revision and every id; the save adds the key, the confirmed hash and the ends echo", async () => {
    const run = harness({ previews: [preview()], posts: [{ answer: answer(), replay: false }] });
    const outcome = await runChooseSave(run.deps, { changes: CHANGES, pending: null });
    expect(outcome).toEqual({ kind: "saved", answer: answer(), replay: false });
    expect(run.calls).toEqual(["preview", "confirm", "post"]);
    expect(run.previewed[0]).toEqual({ clientVersion: 3, expectedRevisionId: 7, add: { productVariantIds: [102, 105] }, remove: { productVariantIds: [101] } });
    expect(run.posted[0]).toEqual({ ...run.previewed[0], idempotencyKey: "catalog-selection:key-1", expectedEffectsHash: HASH_A,
      expectedEnds: { listingIds: [501], hiddenRemovedIds: [] }, expectedOtherEntriesHash: HASH_C });
    expect(run.questions).toEqual([{ preview: preview(), effectsChanged: false }]);
    // The save ended the one eBay listing the question named (PLAN-C v4.1 §11 savedEnding).
    expect(describeChooseSaveOutcome(outcome)).toEqual({ kind: "saved", message: "Saved. 2 added, 1 removed. 1 eBay listing is being ended." });
  });

  it("S2 a head revision other than the base stops before the question: stale, nothing sent, the changes untouched", async () => {
    const run = harness({ previews: [preview({ headRevisionId: 9 })] });
    expect(await runChooseSave(run.deps, { changes: CHANGES, pending: null })).toEqual({ kind: "stale", headRevisionId: 9 });
    expect(run.calls).toEqual(["preview"]);
    expect(describeChooseSaveOutcome({ kind: "stale", headRevisionId: 9 })).toEqual({ kind: "error", message: CHOOSE_WORDS.stale });
  });

  it("S3 Cancel sends nothing; a change over the cap is stopped before the question", async () => {
    const cancelled = harness({ previews: [preview()], confirms: [false] });
    expect(await runChooseSave(cancelled.deps, { changes: CHANGES, pending: null })).toEqual({ kind: "cancelled" });
    expect(cancelled.calls).toEqual(["preview", "confirm"]);
    expect(describeChooseSaveOutcome({ kind: "cancelled" })).toBeNull();
    const over = harness({ previews: [preview({ refused: "too_large", selectedAfter: 10_001, overCapAfter: true })] });
    expect(await runChooseSave(over.deps, { changes: CHANGES, pending: null })).toEqual({ kind: "overCap", after: 10_001 });
    expect(over.calls).toEqual(["preview"]);
    expect(describeChooseSaveOutcome({ kind: "overCap", after: 10_001 })?.message).toBe(CHOOSE_WORDS.overCapAdd(10_001));
  });

  it("S4 busy: six more sends on 2, 4, 8, 15, 15, 15 s with savingStill, the same key and body each time, then busy", async () => {
    const run = harness({ previews: [preview()], posts: Array.from({ length: 7 }, busy) });
    const outcome = await runChooseSave(run.deps, { changes: CHANGES, pending: null });
    expect(outcome.kind).toBe("busy");
    expect(run.posted).toHaveLength(7);
    sameKeyAndBody(run.posted);
    expect(run.sleeps).toEqual([...CHOOSE_BUSY_BACKOFF_MS]);
    expect(run.sleeps).toEqual([2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
    expect(run.statuses).toEqual(Array(6).fill("savingStill"));
    expect(describeChooseSaveStatus("savingStill")).toBe(CHOOSE_WORDS.savingStill);
    expect(describeChooseSaveOutcome(outcome)).toEqual({ kind: "error", message: CHOOSE_WORDS.busy });
    // The next press of the same changes sends the kept save again, with no preview and no question.
    const kept = choosePendingAfter(outcome, null);
    expect(kept?.body).toEqual(run.posted[0]);
    const again = harness({ posts: [{ answer: answer(), replay: false }] });
    expect((await runChooseSave(again.deps, { changes: CHANGES, pending: kept })).kind).toBe("saved");
    expect(again.calls).toEqual(["post"]);
    expect(again.posted[0]).toEqual(run.posted[0]);
  });

  it("S5 busy twice, then saved, with the same key", async () => {
    const run = harness({ previews: [preview()], posts: [busy(), busy(), { answer: answer(), replay: false }] });
    expect((await runChooseSave(run.deps, { changes: CHANGES, pending: null })).kind).toBe("saved");
    sameKeyAndBody(run.posted);
    expect(run.sleeps).toEqual([2_000, 4_000]);
  });

  it("S6 paused: 2, 4, 8 s, then every 15 s on the injected clock until 420,000 ms since the first paused answer, then pausedStill", async () => {
    expect(PAUSED_RETRY_WINDOW_MS).toBe(NEW_VERSION_SETTLE_MS + OLDER_PROCESS_GRACE_MS);
    expect(PAUSED_RETRY_WINDOW_MS).toBe(420_000);
    const run = harness({ previews: [preview()], posts: Array.from({ length: 40 }, paused) });
    const outcome = await runChooseSave(run.deps, { changes: CHANGES, pending: null });
    expect(outcome.kind).toBe("pausedStill");
    // 32 sends: the window has passed at the 32nd answer (434 s), not at the 31st (419 s).
    expect(run.posted).toHaveLength(32);
    expect(run.posted).toHaveLength(CHOOSE_PAUSED_MAX_SENDS);
    sameKeyAndBody(run.posted);
    expect(run.sleeps).toEqual([2_000, 4_000, 8_000, ...Array(28).fill(15_000)]);
    expect(run.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(434_000);
    expect(run.statuses).toEqual(Array(31).fill("paused"));
    expect(describeChooseSaveStatus("paused")).toBe(CHOOSE_WORDS.paused);
    expect(describeChooseSaveOutcome(outcome)).toEqual({ kind: "error", message: CHOOSE_WORDS.pausedStill });
    // The changes stay; the next press starts a new window with the same key and body.
    const kept = choosePendingAfter(outcome, null);
    expect(kept?.body).toEqual(run.posted[0]);
    const again = harness({ posts: [paused(), { answer: answer(), replay: true }] });
    expect(await runChooseSave(again.deps, { changes: CHANGES, pending: kept })).toEqual({ kind: "saved", answer: answer(), replay: true });
    expect(again.posted).toEqual([run.posted[0], run.posted[0]]);
    expect(again.sleeps).toEqual([2_000]);
  });

  it("S7 the window is time, not sends: slow answers end it sooner; a clock that never moves ends it at the send cap", async () => {
    const slow = harness({ previews: [preview()], posts: Array.from({ length: 40 }, paused), callMs: 30_000 });
    expect((await runChooseSave(slow.deps, { changes: CHANGES, pending: null })).kind).toBe("pausedStill");
    // Measured from the first paused answer: answer n lands 0, 32, 66, 104 s, then 45 s apart (15 s pause + 30 s call),
    // so the 11th lands at 419 s and the 12th at 464 s, past the window.
    expect(slow.posted.length).toBeLessThan(CHOOSE_PAUSED_MAX_SENDS);
    expect(slow.posted).toHaveLength(12);
    expect(slow.sleeps).toEqual([2_000, 4_000, 8_000, ...Array(8).fill(15_000)]);
    const frozen = harness({ previews: [preview()], posts: Array.from({ length: 40 }, paused), clockMoves: false });
    expect((await runChooseSave(frozen.deps, { changes: CHANGES, pending: null })).kind).toBe("pausedStill");
    expect(frozen.posted).toHaveLength(CHOOSE_PAUSED_MAX_SENDS);
  });

  it("S8 the preview retries any transient failure on the paused schedule (it writes nothing), then asks", async () => {
    const run = harness({
      previews: [paused(), api(413, null), new TypeError("Failed to fetch"), api(503, DROPSHIP_SITE_UPDATING_CODE, { reason: "not_json" }), preview()],
      posts: [{ answer: answer(), replay: false }],
    });
    expect((await runChooseSave(run.deps, { changes: CHANGES, pending: null })).kind).toBe("saved");
    expect(run.calls).toEqual(["preview", "preview", "preview", "preview", "preview", "confirm", "post"]);
    expect(run.sleeps).toEqual([2_000, 4_000, 8_000, 15_000]);
    expect(run.statuses).toEqual(["paused", "paused", "retrying", "paused"]);
    for (const body of run.previewed) expect(body).toEqual(run.previewed[0]);
  });

  it("S9 a preview paused past the window says pausedStill; one that never answered says not saved; neither keeps a save", async () => {
    const stillPaused = harness({ previews: Array.from({ length: 40 }, paused) });
    const outcome = await runChooseSave(stillPaused.deps, { changes: CHANGES, pending: null });
    expect(outcome).toEqual({ kind: "pausedStill", pending: null });
    expect(stillPaused.calls).not.toContain("confirm");
    const noAnswer = harness({ previews: Array.from({ length: 40 }, () => new TypeError("Failed to fetch")) });
    expect(await runChooseSave(noAnswer.deps, { changes: CHANGES, pending: null })).toEqual({ kind: "notSaved", pending: null });
    expect(choosePendingAfter({ kind: "pausedStill", pending: null }, null)).toBeNull();
  });

  it("S10 no answer or a 5xx: three sends on 1 s and 2 s, then unconfirmed with the save kept; the next press replays it", async () => {
    const run = harness({ previews: [preview()], posts: [new TypeError("Failed to fetch"), api(502, null), api(500, "DROPSHIP_VENDOR_CATALOG_INTERNAL_ERROR")] });
    const outcome = await runChooseSave(run.deps, { changes: CHANGES, pending: null });
    expect(outcome.kind).toBe("unconfirmed");
    expect(run.sleeps).toEqual([...CHOOSE_SAVE_BACKOFF_MS]);
    expect(run.sleeps).toEqual([1_000, 2_000]);
    expect(run.statuses).toEqual(["retrying", "retrying"]);
    expect(describeChooseSaveStatus("retrying")).toBeNull();
    sameKeyAndBody(run.posted);
    expect(describeChooseSaveOutcome(outcome)).toEqual({ kind: "error", message: CHOOSE_WORDS.unconfirmed });
    const kept = choosePendingAfter(outcome, null);
    const again = harness({ posts: [{ answer: answer(), replay: true }] });
    expect(await runChooseSave(again.deps, { changes: CHANGES, pending: kept })).toEqual({ kind: "saved", answer: answer(), replay: true });
    expect(again.posted[0]).toEqual(run.posted[0]);
  });

  it("S11 408 and 429 three times wrote nothing: not saved, the save kept", async () => {
    const run = harness({ previews: [preview()], posts: [api(429, DROPSHIP_CATALOG_READ_ERROR_CODES.rateLimited), api(408, null), api(429, null)] });
    const outcome = await runChooseSave(run.deps, { changes: CHANGES, pending: null });
    expect(outcome.kind).toBe("notSaved");
    expect(choosePendingAfter(outcome, null)?.body).toEqual(run.posted[0]);
    expect(describeChooseSaveOutcome(outcome)).toEqual({ kind: "error", message: CHOOSE_WORDS.notSaved });
  });

  it("S12 effects changed: the question is asked again saying so, and the next save has a new key", async () => {
    const run = harness({
      previews: [preview(), preview({ effectsHash: HASH_B })],
      posts: [api(409, SELECTION_CHANGE_ERROR_CODES.effectsChanged), { answer: answer({ effectsHash: HASH_B, confirmedEffectsHash: HASH_B }), replay: false }],
    });
    const outcome = await runChooseSave(run.deps, { changes: CHANGES, pending: null });
    expect(outcome.kind).toBe("saved");
    expect(run.calls).toEqual(["preview", "confirm", "post", "preview", "confirm", "post"]);
    expect(run.questions.map((question) => question.effectsChanged)).toEqual([false, true]);
    expect(run.posted.map((body) => [body.idempotencyKey, body.expectedEffectsHash])).toEqual([
      ["catalog-selection:key-1", HASH_A], ["catalog-selection:key-2", HASH_B],
    ]);
    expect(run.sleeps).toEqual([]);
  });

  it("S13 effects that keep moving stop after three questions; Cancel on the second question sends nothing more", async () => {
    const moved = () => api(409, SELECTION_CHANGE_ERROR_CODES.effectsChanged);
    const run = harness({ previews: [preview(), preview(), preview()], posts: [moved(), moved(), moved()] });
    const outcome = await runChooseSave(run.deps, { changes: CHANGES, pending: null });
    expect(outcome).toEqual({ kind: "effectsChanged" });
    expect(run.posted.map((body) => body.idempotencyKey)).toEqual(["catalog-selection:key-1", "catalog-selection:key-2", "catalog-selection:key-3"]);
    expect(describeChooseSaveOutcome(outcome)).toEqual({ kind: "error", message: CHOOSE_WORDS.effectsChanged });
    const cancelled = harness({ previews: [preview(), preview()], posts: [moved()], confirms: [true, false] });
    expect(await runChooseSave(cancelled.deps, { changes: CHANGES, pending: null })).toEqual({ kind: "cancelled" });
    expect(cancelled.posted).toHaveLength(1);
  });

  it("S14 the save's revision conflict is stale with the head the server named; a key conflict is rejected (a new key next press)", async () => {
    const stale = harness({ previews: [preview()], posts: [api(409, SELECTION_CHANGE_ERROR_CODES.revisionConflict, { currentRevisionId: 11 })] });
    const staleOutcome = await runChooseSave(stale.deps, { changes: CHANGES, pending: null });
    expect(staleOutcome).toEqual({ kind: "stale", headRevisionId: 11 });
    expect(choosePendingAfter(staleOutcome, null)).toBeNull();
    const conflict = harness({ previews: [preview()], posts: [api(409, SELECTION_CHANGE_ERROR_CODES.keyConflict)] });
    const conflictOutcome = await runChooseSave(conflict.deps, { changes: CHANGES, pending: null });
    expect(conflictOutcome).toEqual({ kind: "rejected", message: CHOOSE_WORDS.rejected });
    expect(choosePendingAfter(conflictOutcome, null)).toBeNull();
    expect(conflict.posted).toHaveLength(1);
  });

  it("S15 PR C's 409 page outdated and the 410 both say retired with Reload; the bulk parser's 413 is too large; none is sent again", async () => {
    for (const [error, expected] of [
      [api(409, SELECTION_CHANGE_ERROR_CODES.pageOutdated), { kind: "retired" }],
      [api(410, SELECTION_CHANGE_ERROR_CODES.rulesRetired), { kind: "retired" }],
      [api(413, SELECTION_CHANGE_ERROR_CODES.requestTooLarge), { kind: "tooLarge" }],
      [api(422, SELECTION_CHANGE_ERROR_CODES.tooLarge, { selectedAfter: 10_002 }), { kind: "overCap", after: 10_002 }],
      // PR C (FID-4): a removal over the facts or end bound has its own outcome and words.
      [api(422, SELECTION_CHANGE_ERROR_CODES.removalTooLarge, { factSizes: 30_001 }), { kind: "tooManyRemoved" }],
      [api(400, SELECTION_CHANGE_ERROR_CODES.invalidInput), { kind: "rejected", message: CHOOSE_WORDS.rejected }],
      [api(403, "DROPSHIP_VENDOR_CATALOG_ACCESS_BLOCKED"), { kind: "rejected", message: "Server words." }],
    ] as const) {
      const run = harness({ previews: [preview()], posts: [error] });
      expect(await runChooseSave(run.deps, { changes: CHANGES, pending: null })).toEqual(expected);
      expect(run.posted).toHaveLength(1);
      expect(run.sleeps).toEqual([]);
    }
    expect(describeChooseSaveOutcome({ kind: "retired" })).toEqual({ kind: "error", message: CHOOSE_WORDS.retired, reload: true });
    expect(describeChooseSaveOutcome({ kind: "tooLarge" })).toEqual({ kind: "error", message: CHOOSE_WORDS.tooLarge });
    expect(describeChooseSaveOutcome({ kind: "tooManyRemoved" })).toEqual({ kind: "error", message: CHOOSE_WORDS.tooManyRemoved });
    expect(CHOOSE_WORDS.tooManyRemoved).toBe("That's too many items to change at once. Remove fewer products in one save.");
    // The preview's 422 for a removal too large stops before the question, with the same words.
    const removalTooLarge = harness({ previews: [api(422, SELECTION_CHANGE_ERROR_CODES.removalTooLarge, { factSizes: 30_001 })] });
    expect(await runChooseSave(removalTooLarge.deps, { changes: CHANGES, pending: null })).toEqual({ kind: "tooManyRemoved" });
    expect(removalTooLarge.calls).toEqual(["preview"]);
    // The preview's refusals stop too, before any question.
    const outdated = harness({ previews: [api(409, SELECTION_CHANGE_ERROR_CODES.pageOutdated)] });
    expect(await runChooseSave(outdated.deps, { changes: CHANGES, pending: null })).toEqual({ kind: "retired" });
    expect(outdated.calls).toEqual(["preview"]);
  });

  it("S16 savedDrift: a removal whose effects moved went through; the bar says so with the save's quantity-0 and end count, then the ends", async () => {
    const drifted = answer({ toAdd: 0, toRemove: 3, drifted: true, effectsHash: HASH_B,
      effects: [{ storeConnectionId: 1, storeName: "Card Corner", platform: "ebay", goesToZero: 2, startsSelling: 0, ends: 0,
        storeConnected: true }], ends: { listingIds: [], hiddenRemovedIds: [], otherSizes: 0, stillEnding: 0, endReview: 0, endedReAdd: 0 } });
    const run = harness({ previews: [preview({ toAdd: 0, toRemove: 3 })], posts: [{ answer: drifted, replay: false }] });
    const outcome = await runChooseSave(run.deps, { changes: changes([], [101, 102, 103]), pending: null });
    expect(describeChooseSaveOutcome(outcome)).toEqual({
      kind: "saved", message: "Saved. A few listings changed on eBay while you were deciding; 2 listings are set to quantity 0.",
    });
    // PR C (PLAN-C v4.1 §11, FID-14): fewer ends than confirmed went through; the drift line counts them, then savedEnding.
    const fewer = answer({ toAdd: 0, toRemove: 2, drifted: true, effectsHash: HASH_B,
      effects: [{ storeConnectionId: 1, storeName: "Card Corner", platform: "ebay", goesToZero: 0, startsSelling: 0, ends: 1, storeConnected: true }] });
    const second = harness({ previews: [preview({ toAdd: 0, toRemove: 2, ends: { ...preview().ends, listingIds: [501, 502] } })],
      posts: [{ answer: fewer, replay: false }] });
    const fewerOutcome = await runChooseSave(second.deps, { changes: changes([], [101, 102]), pending: null });
    expect(second.posted[0].expectedEnds).toEqual({ listingIds: [501, 502], hiddenRemovedIds: [] });
    expect(describeChooseSaveOutcome(fewerOutcome)).toEqual({
      kind: "saved", message: "Saved. A few listings changed on eBay while you were deciding; 1 listing is set to quantity 0. 1 eBay listing is being ended.",
    });
  });

  it("S16b (PLAN-C v4.1 §13.3, TST-8) the largest echo, 30,000 + 30,000 end ids beside 10,000 + 10,000 ids, is sent in one body under the bulk limit", async () => {
    const ends = { listingIds: range(1_000_001, 30_000), hiddenRemovedIds: range(2_000_001, 30_000), otherSizes: 29_999, stillEnding: 0,
      endReview: 0, endedReAdd: 0 };
    const big = changes(range(1, 10_000), range(100_001, 10_000));
    const run = harness({ previews: [preview({ toAdd: 10_000, toRemove: 10_000, ends })], posts: [{ answer: answer(), replay: false }] });
    expect((await runChooseSave(run.deps, { changes: big, pending: null })).kind).toBe("saved");
    const sent = run.posted[0];
    expect(sent.expectedEnds).toEqual({ listingIds: ends.listingIds, hiddenRemovedIds: ends.hiddenRemovedIds });
    expect(selectionChangeRequestSchema.safeParse(sent).success).toBe(true);
    // The page's mirror of the bulk parser's 1 MiB (dropship-bulk-json.middleware.ts): the body fits with room to spare.
    expect(chooseBodyBytes(sent)).toBeLessThan(CHOOSE_BULK_BODY_LIMIT_BYTES);
    expect(new TextEncoder().encode(JSON.stringify(sent)).length).toBe(chooseBodyBytes(sent));
  });

  it("S17 a kept save is sent again only for exactly its changes; other changes get a new preview, question and key", async () => {
    const first = harness({ previews: [preview()], posts: [busy(), busy(), busy(), busy(), busy(), busy(), busy()] });
    const kept = choosePendingAfter(await runChooseSave(first.deps, { changes: CHANGES, pending: null }), null) as ChoosePendingSave;
    const other = harness({ previews: [preview()], posts: [{ answer: answer(), replay: false }] });
    expect((await runChooseSave(other.deps, { changes: changes([105], [101]), pending: kept })).kind).toBe("saved");
    expect(other.calls).toEqual(["preview", "confirm", "post"]);
    expect(other.posted[0].idempotencyKey).toBe("catalog-selection:key-1");
    expect(other.posted[0].add.productVariantIds).toEqual([105]);
    // A rebase moves the base, so the kept save (counted from the old base) is not reused either.
    const rebased = harness({ previews: [preview({ headRevisionId: 9 })], posts: [{ answer: answer(), replay: false }] });
    expect((await runChooseSave(rebased.deps, { changes: changes([105, 102], [101], 9), pending: kept })).kind).toBe("saved");
    expect(rebased.calls).toEqual(["preview", "confirm", "post"]);
    // Cancel keeps an earlier kept save as it was.
    expect(choosePendingAfter({ kind: "cancelled" }, kept)).toBe(kept);
    expect(choosePendingAfter({ kind: "saved", answer: answer(), replay: false }, kept)).toBeNull();
  });

  it("S18 20,000 ids go in one body that parses with the server's schema; the frozen change set is never written", async () => {
    const big = changes(range(1, 10_000), range(100_001, 10_000));
    const run = harness({ previews: [preview({ toAdd: 10_000, toRemove: 10_000 })], posts: [{ answer: answer(), replay: false }] });
    expect((await runChooseSave(run.deps, { changes: big, pending: null })).kind).toBe("saved");
    const sent = run.posted[0];
    expect(sent.add.productVariantIds).toHaveLength(10_000);
    expect(sent.remove.productVariantIds).toHaveLength(10_000);
    expect(sent.add.productVariantIds[0]).toBe(1);
    expect(sent.remove.productVariantIds.at(-1)).toBe(110_000);
    expect(selectionChangeRequestSchema.safeParse(sent).success).toBe(true);
    expect([big.add.size, big.remove.size]).toEqual([10_000, 10_000]);
  });

  it("S19 a press with no changes, or a body the schema refuses, is a programming error before anything is sent", async () => {
    const run = harness();
    await expect(runChooseSave(run.deps, { changes: changes([], []), pending: null })).rejects.toThrow(/at least one change/);
    await expect(runChooseSave(run.deps, { changes: changes([0], []), pending: null })).rejects.toThrow();
    expect(run.calls).toEqual([]);
  });

  it("S21 (review round 1 CLI-1, TST-2) a kept save says whether it may have committed: after unconfirmed yes, and busy, paused or 408s on a later press keep it", async () => {
    const lost = [new TypeError("Failed to fetch"), api(502, null), api(500, "DROPSHIP_VENDOR_CATALOG_INTERNAL_ERROR")];
    const unsure = await runChooseSave(harness({ previews: [preview()], posts: [...lost] }).deps, { changes: CHANGES, pending: null });
    const kept = choosePendingAfter(unsure, null);
    expect(unsure.kind).toBe("unconfirmed");
    expect(kept?.mayHaveCommitted).toBe(true);
    // Every answer said nothing was written: a fresh save that was never unsure.
    const refused = await runChooseSave(harness({ previews: [preview()], posts: [api(429, null), api(408, null), api(429, null)] }).deps,
      { changes: CHANGES, pending: null });
    expect(refused.kind).toBe("notSaved");
    expect(choosePendingAfter(refused, null)?.mayHaveCommitted).toBe(false);
    const busyOnly = await runChooseSave(harness({ previews: [preview()], posts: Array.from({ length: 7 }, busy) }).deps, { changes: CHANGES, pending: null });
    expect(choosePendingAfter(busyOnly, null)?.mayHaveCommitted).toBe(false);
    // An earlier press may have committed, so a later press that only hears 408s, busy or paused keeps saying so.
    for (const posts of [[api(408, null), api(429, null), api(408, null)], Array.from({ length: 7 }, busy), Array.from({ length: 40 }, paused)]) {
      const later = await runChooseSave(harness({ posts }).deps, { changes: CHANGES, pending: kept });
      expect(["notSaved", "busy", "pausedStill"]).toContain(later.kind);
      const keptAgain = choosePendingAfter(later, kept);
      expect(keptAgain?.mayHaveCommitted).toBe(true);
      expect(keptAgain?.body).toEqual(kept?.body);
    }
    // One send of a press with no sure answer, then busy past every try: it may have committed too.
    const mixed = await runChooseSave(harness({ previews: [preview()], posts: [api(502, null), ...Array.from({ length: 7 }, busy)] }).deps,
      { changes: CHANGES, pending: null });
    expect(mixed.kind).toBe("busy");
    expect(choosePendingAfter(mixed, null)?.mayHaveCommitted).toBe(true);
    // A preview that never answered sent no save: the kept one stays as it was, flag and all.
    const previewLost = await runChooseSave(harness({ previews: Array.from({ length: 40 }, () => new TypeError("Failed to fetch")) }).deps,
      { changes: changes([105], [101]), pending: kept });
    expect(choosePendingAfter(previewLost, kept)).toBe(kept);
  });

  it("S22 (review round 1 CLI-1, TST-2) the page reads the saved choices again when the changes are gone while a kept save may have committed, and only then", () => {
    const pending = (mayHaveCommitted: boolean) => ({ body: {} as SelectionChangeRequest, changesKey: "k", confirmed: preview(), mayHaveCommitted });
    const none = changes([], []);
    // Undo, or every box unticked back, after an unsure save.
    expect(chooseUndoneAfterUnsure(pending(true), none)).toBe(true);
    // Changes still pending: the next press sends the kept save, which replays it (review MC1).
    expect(chooseUndoneAfterUnsure(pending(true), CHANGES)).toBe(false);
    expect(chooseUndoneAfterUnsure(pending(true), changes([102], []))).toBe(false);
    // Nothing of it can have been written (408s, 429s, busy, paused), or no save kept: nothing to read.
    expect(chooseUndoneAfterUnsure(pending(false), none)).toBe(false);
    expect(chooseUndoneAfterUnsure(null, none)).toBe(false);
  });

  it("S20 every outcome has words, except Cancel", () => {
    const pending = { body: {} as SelectionChangeRequest, changesKey: "k", confirmed: preview(), mayHaveCommitted: false };
    const outcomes: ChooseSaveOutcome[] = [
      { kind: "saved", answer: answer({ skipped: { count: 1, first: [9] } }), replay: false },
      { kind: "stale", headRevisionId: undefined }, { kind: "overCap", after: null }, { kind: "retired" }, { kind: "tooLarge" },
      { kind: "rejected", message: "Refused." }, { kind: "effectsChanged" }, { kind: "busy", pending }, { kind: "pausedStill", pending },
      { kind: "unconfirmed", pending }, { kind: "notSaved", pending: null }, { kind: "tooManyRemoved" },
    ];
    expect(outcomes.map((outcome) => describeChooseSaveOutcome(outcome)?.message)).toEqual([
      "Saved. 2 added, 1 removed. 1 eBay listing is being ended. 1 is no longer offered by Card Shellz and was skipped.",
      CHOOSE_WORDS.stale, CHOOSE_WORDS.rejected, CHOOSE_WORDS.retired, CHOOSE_WORDS.tooLarge, "Refused.", CHOOSE_WORDS.effectsChanged,
      CHOOSE_WORDS.busy, CHOOSE_WORDS.pausedStill, CHOOSE_WORDS.unconfirmed, CHOOSE_WORDS.notSaved, CHOOSE_WORDS.tooManyRemoved,
    ]);
  });
});
