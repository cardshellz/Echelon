import { describe, expect, it, vi } from "vitest";
import {
  LISTING_PUSH_RUN_ERROR_CODES,
  type CreateListingPushRunRequest,
  type ListingPushRunView,
} from "@shared/dropship/listing-push-runs";
import {
  CHECK_RETRY_PAUSE_MS,
  checkContextKey,
  retryPublishRead,
  type CheckPreviewAnswer,
} from "../dropship-catalog-publish";
import {
  createPublishRun,
  latestRunUrl,
  postCheckPreview,
  postPublishRun,
  publishRunBody,
  readCheckRowDetail,
  readSelectedIds,
  requestPublishAnswer,
  runDetailQueryOptions,
  runDetailUrl,
  runListingCheck,
  selectedIdsUrl,
  selectedListUrl,
  selectionSummaryQueryOptions,
  selectionSummaryUrl,
  stopPublishRun,
  type ListingCheckDeps,
  type PublishFetch,
} from "../dropship-catalog-publish-requests";
import { PUBLISH_WORDS } from "../dropship-catalog-publish-words";
import { DROPSHIP_SITE_UPDATING_CODE, DropshipApiError } from "../dropship-ops-surface";

/**
 * Catalog step 3's requests (step 1 plan S2-5, PR A, §4.10): the URLs carry this page's version and filters, every
 * answer is checked, a run create keeps its key, and the Check is sequential and stops cleanly. The network and the
 * pause are scripts; nothing waits.
 */

const STAMP = "2026-10-20T12:00:00.000Z";
const RUN: ListingPushRunView = {
  runId: 7, storeConnectionId: 5, scope: "not_live", status: "processing", stopReason: null, selectionRevisionId: 3, targetCount: 3,
  chunkSize: 500, chunkCount: 1, nextChunkIndex: 0, cancelRequestedAt: null, createdAt: STAMP, updatedAt: STAMP, completedAt: null,
};
const BODY: CreateListingPushRunRequest = { storeConnectionId: 5, scope: "not_live", idempotencyKey: "listing-push-run:abc12345", expectedSelectionRevisionId: 3 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
function html(status = 200): Response {
  return new Response("<!doctype html><html></html>", { status, headers: { "content-type": "text/html; charset=UTF-8" } });
}
function apiError(status: number, code: string, context: Record<string, unknown> | null = null) {
  return new DropshipApiError({ status, code, message: "Refused.", context });
}

describe("the URLs", () => {
  it("sends this page's version on every catalog read, and the selected list's alias beside the new filter (CHK7)", () => {
    expect(selectionSummaryUrl(5)).toBe("/api/dropship/catalog/selection?storeConnectionId=5&clientVersion=3");
    expect(selectionSummaryUrl(null)).toBe("/api/dropship/catalog/selection?clientVersion=3");
    expect(selectionSummaryUrl(0)).toBe("/api/dropship/catalog/selection?clientVersion=3");
    expect(selectedListUrl(2)).toBe("/api/dropship/catalog?selection=selected&selectedOnly=true&includeFacets=false&clientVersion=3&page=2&limit=200");
    expect(selectedIdsUrl()).toBe("/api/dropship/catalog?selection=selected&idsOnly=true&purpose=remove&clientVersion=3");
  });

  it("reads the newest run of a store, a run's problems after a size, and refuses a bad run id", () => {
    expect(latestRunUrl(5)).toBe("/api/dropship/listing-push-runs?storeConnectionId=5&limit=1");
    expect(runDetailUrl(7)).toBe("/api/dropship/listing-push-runs/7");
    expect(runDetailUrl(7, 0)).toBe("/api/dropship/listing-push-runs/7");
    expect(runDetailUrl(7, 101)).toBe("/api/dropship/listing-push-runs/7?problemsAfter=101");
    expect(() => runDetailUrl(0)).toThrow();
    expect(() => runDetailUrl(1.5)).toThrow();
  });

  it("keys the summary by store and retries only transient failures", () => {
    expect(selectionSummaryQueryOptions(5).queryKey).toEqual(["/api/dropship/catalog/selection", 5]);
    expect(selectionSummaryQueryOptions(0).queryKey).toEqual(["/api/dropship/catalog/selection", null]);
    expect(selectionSummaryQueryOptions(5).retry).toBe(retryPublishRead);
    expect(runDetailQueryOptions(7).queryKey).toEqual(["/api/dropship/listing-push-runs", "detail", 7]);
  });
});

describe("reading an answer (§4.9 item 3)", () => {
  const schema = { safeParse: (value: unknown) => ({ success: true as const, data: value }) } as never;

  it("sends the portal cookie and a JSON body, and reads the JSON answer", async () => {
    const fetcher = vi.fn<PublishFetch>(async () => json({ ok: true }));
    await expect(requestPublishAnswer(fetcher, "/x", schema, { method: "POST", body: { a: 1 } })).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledWith("/x", expect.objectContaining({ method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ a: 1 }) }));
  });

  it("turns an older dyno's HTML, and an answer without a field this page needs, into site updating", async () => {
    const fromHtml = await postPublishRun(BODY, async () => html()).catch((error: unknown) => error);
    expect(fromHtml).toBeInstanceOf(DropshipApiError);
    expect((fromHtml as DropshipApiError).code).toBe(DROPSHIP_SITE_UPDATING_CODE);
    // A stage 1 server ignores idsOnly and answers a table page: not the id answer's contract.
    const ids = await readSelectedIds(async () => json({ rows: [], total: 0, page: 1, limit: 50, facets: {} })).catch((error: unknown) => error);
    expect((ids as DropshipApiError).code).toBe(DROPSHIP_SITE_UPDATING_CODE);
  });

  it("keeps a JSON refusal's code and context", async () => {
    const error = await stopPublishRun(7, async () => json({ error: { code: LISTING_PUSH_RUN_ERROR_CODES.notFound, message: "That publish was not found." } }, 404))
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 404, code: LISTING_PUSH_RUN_ERROR_CODES.notFound });
  });

  it("reads the selected ids and refuses a null list for the purpose asked", async () => {
    await expect(readSelectedIds(async () => json({ selectedIds: [3, 1], notSelectedIds: [], total: 2 }))).resolves.toEqual([3, 1]);
    await expect(readSelectedIds(async () => json({ selectedIds: null, notSelectedIds: [], total: 20_000 })))
      .rejects.toMatchObject({ code: "DROPSHIP_CATALOG_IDS_OFF_CONTRACT" });
  });
});

describe("a run create (§4.10)", () => {
  function deps(answers: Array<() => Promise<{ run: ListingPushRunView; idempotentReplay: boolean }>>) {
    const sent: CreateListingPushRunRequest[] = [];
    const pauses: number[] = [];
    const retries: unknown[] = [];
    return {
      sent, pauses, retries,
      deps: {
        post: async (body: CreateListingPushRunRequest) => {
          sent.push(body);
          const next = answers.shift();
          if (!next) throw new Error("no scripted answer");
          return next();
        },
        sleep: async (ms: number) => { pauses.push(ms); },
        onRetry: (error: unknown) => { retries.push(error); },
      },
    };
  }

  it("sends once and returns the run made", async () => {
    const script = deps([async () => ({ run: RUN, idempotentReplay: false })]);
    await expect(createPublishRun(script.deps, BODY)).resolves.toEqual({ kind: "created", run: RUN, replay: false });
    expect(script.sent).toEqual([BODY]);
    expect(script.pauses).toEqual([]);
  });

  it("P3 a lost answer: the retry carries the same key and body and gets the replay", async () => {
    const script = deps([
      async () => { throw new TypeError("Failed to fetch"); },
      async () => ({ run: RUN, idempotentReplay: true }),
    ]);
    await expect(createPublishRun(script.deps, BODY)).resolves.toEqual({ kind: "created", run: RUN, replay: true });
    expect(script.sent).toEqual([BODY, BODY]);
    expect(script.pauses).toEqual([1_000]);
    expect(script.retries).toHaveLength(1);
  });

  it("P12 an older dyno's HTML once, then a busy lock: the same key three times", async () => {
    const script = deps([
      async () => { throw apiError(503, DROPSHIP_SITE_UPDATING_CODE); },
      async () => { throw apiError(409, LISTING_PUSH_RUN_ERROR_CODES.busy); },
      async () => ({ run: RUN, idempotentReplay: false }),
    ]);
    await expect(createPublishRun(script.deps, BODY)).resolves.toMatchObject({ kind: "created" });
    expect(new Set(script.sent.map((body) => body.idempotencyKey))).toEqual(new Set([BODY.idempotencyKey]));
    expect(script.pauses).toEqual([1_000, 2_000]);
    expect((script.retries[0] as DropshipApiError).code).toBe(DROPSHIP_SITE_UPDATING_CODE);
  });

  it("gives up after three transient answers without a sure answer, telling the page to keep the key", async () => {
    const script = deps([1, 2, 3].map(() => async () => { throw apiError(502, "BAD_GATEWAY"); }));
    const outcome = await createPublishRun(script.deps, BODY);
    expect(outcome.kind).toBe("notSent");
    expect(script.sent).toHaveLength(3);
    expect(script.pauses).toEqual([1_000, 2_000]);
    // No pause or retry note after the last try.
    expect(script.retries).toHaveLength(2);
  });

  it("stops at once on a refusal, with what the press does next", async () => {
    for (const [error, kind] of [
      [apiError(409, LISTING_PUSH_RUN_ERROR_CODES.selectionRevisionConflict), "reread"],
      [apiError(409, LISTING_PUSH_RUN_ERROR_CODES.runActive, { runId: 41 }), "showRun"],
      [apiError(403, "DROPSHIP_STEP_UP_REQUIRED"), "stepUp"],
      [apiError(422, LISTING_PUSH_RUN_ERROR_CODES.tooLarge), "permanent"],
    ] as const) {
      const script = deps([async () => { throw error; }]);
      const outcome = await createPublishRun(script.deps, BODY);
      expect(outcome.kind).toBe("refused");
      if (outcome.kind === "refused") expect(outcome.refusal.kind).toBe(kind);
      expect(script.sent).toHaveLength(1);
    }
  });

  it("stops at the create limiter's 429 at once: another try only spends the budget (verify VC6)", async () => {
    const script = deps([async () => { throw apiError(429, LISTING_PUSH_RUN_ERROR_CODES.rateLimited); }]);
    const outcome = await createPublishRun(script.deps, BODY);
    expect(outcome).toMatchObject({ kind: "refused", refusal: { kind: "rateLimited", message: PUBLISH_WORDS.runRateLimited } });
    expect(script.sent).toHaveLength(1);
    expect(script.pauses).toEqual([]);
    // After an unanswered try too: the page keeps the key (PublishStep), so the next press replays it.
    const later = deps([async () => { throw new TypeError("Failed to fetch"); }, async () => { throw apiError(429, "TOO_MANY_REQUESTS"); }]);
    expect((await createPublishRun(later.deps, BODY)).kind).toBe("refused");
    expect(later.sent).toEqual([BODY, BODY]);
  });

  it("sends the same key again after an answer whose JSON was cut short: the run may have been made (verify VC11)", async () => {
    const script = deps([
      async () => { throw new SyntaxError("Unexpected end of JSON input"); },
      async () => ({ run: RUN, idempotentReplay: true }),
    ]);
    await expect(createPublishRun(script.deps, BODY)).resolves.toEqual({ kind: "created", run: RUN, replay: true });
    expect(script.sent).toEqual([BODY, BODY]);
    // Three cut answers: no sure answer, so the page keeps the key (notSent), never a new key and a second run.
    const cut = deps([1, 2, 3].map(() => async () => { throw new SyntaxError("Unexpected end of JSON input"); }));
    expect((await createPublishRun(cut.deps, BODY)).kind).toBe("notSent");
  });

  it("checks the body with the server's own schema before anything is sent", async () => {
    const script = deps([]);
    await expect(createPublishRun(script.deps, { ...BODY, idempotencyKey: "short" })).rejects.toThrow();
    await expect(createPublishRun(script.deps, { ...BODY, productVariantIds: [1] } as never)).rejects.toThrow();
    expect(script.sent).toEqual([]);
    expect(publishRunBody({ storeConnectionId: 5, scope: "all", expectedSelectionRevisionId: null, idempotencyKey: "listing-push-run:k1234567" }))
      .toEqual({ storeConnectionId: 5, scope: "all", expectedSelectionRevisionId: null, idempotencyKey: "listing-push-run:k1234567" });
  });
});

describe("the chunked Check (D15)", () => {
  function previewOf(storeConnectionId: number, ids: readonly number[]): CheckPreviewAnswer {
    return { preview: { vendorId: 1, storeConnectionId, platform: "ebay", generatedAt: STAMP, rows: ids.map((id) => ({
      productVariantId: id, productId: 1, sku: null, title: `Size ${id}`, platform: "ebay", listingMode: null, currentListingStatus: "not_listed",
      previewStatus: id % 10 === 0 ? "blocked" as const : "ready" as const, blockers: [], warnings: [], marketplaceQuantity: 1, priceCents: 100,
      marketplaceCategoryId: null, marketplaceCategoryName: null, storeCategoryNames: [], businessPolicySelection: null, previewHash: "h",
    })) } };
  }

  function setup(overrides: Partial<ListingCheckDeps> = {}) {
    const calls: number[][] = [];
    const progress: Array<[number, number]> = [];
    const pauses: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const deps: ListingCheckDeps = {
      preview: async (storeConnectionId, ids) => {
        calls.push([...ids]);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return previewOf(storeConnectionId, ids);
      },
      stillCurrent: () => true,
      sleep: async (ms) => { pauses.push(ms); },
      ...overrides,
    };
    return { deps, calls, progress, pauses, maxInFlight: () => maxInFlight };
  }

  const ids = Array.from({ length: 1_234 }, (_, index) => index + 1);
  const input = (signal = new AbortController().signal) => ({ storeConnectionId: 5, ids, contextKey: checkContextKey(5, 3), signal });

  it("P1 runs 7 sequential previews of at most 200, with progress, and sums them", async () => {
    const script = setup();
    const outcome = await runListingCheck(script.deps, { ...input(), onProgress: (done, total) => script.progress.push([done, total]) });
    expect(outcome.kind).toBe("done");
    expect(script.calls.map((chunk) => chunk.length)).toEqual([200, 200, 200, 200, 200, 200, 34]);
    expect(script.calls.flat()).toEqual(ids);
    expect(script.maxInFlight()).toBe(1);
    expect(script.progress).toEqual([[0, 1_234], [200, 1_234], [400, 1_234], [600, 1_234], [800, 1_234], [1_000, 1_234], [1_200, 1_234], [1_234, 1_234]]);
    if (outcome.kind === "done") {
      expect(outcome.result.summary).toEqual({ total: 1_234, ready: 1_111, warnings: 0, blocked: 123 });
      expect(outcome.result.contextKey).toBe("5:3");
      expect(outcome.result.preview.storeConnectionId).toBe(5);
      expect(PUBLISH_WORDS.checking(400, 1_234)).toBe("Checking 400 of 1,234…");
    }
  });

  it("sends a chunk once more after a transient failure, and stops at a second", async () => {
    let failures = 1;
    const script = setup({
      preview: async (storeConnectionId, chunk) => {
        if (chunk[0] === 401 && failures > 0) { failures -= 1; throw apiError(503, DROPSHIP_SITE_UPDATING_CODE); }
        return previewOf(storeConnectionId, chunk);
      },
    });
    await expect(runListingCheck(script.deps, { ...input(), onProgress: () => undefined })).resolves.toMatchObject({ kind: "done" });
    expect(script.pauses).toEqual([CHECK_RETRY_PAUSE_MS]);

    const twice = setup({ preview: async (storeConnectionId, chunk) => {
      if (chunk[0] === 401) throw new TypeError("Failed to fetch");
      return previewOf(storeConnectionId, chunk);
    } });
    const failed = await runListingCheck(twice.deps, { ...input(), onProgress: () => undefined });
    expect(failed).toMatchObject({ kind: "failed", done: 400, total: 1_234 });
    expect(PUBLISH_WORDS.checkFailed(400, 1_234)).toBe("Checking stopped at 400 of 1,234. Try again.");
  });

  it("stops at once on a refusal (an account block keeps its error for the page's notice)", async () => {
    const blocked = apiError(403, "DROPSHIP_LISTING_VENDOR_BLOCKED");
    const script = setup({ preview: async () => { throw blocked; } });
    await expect(runListingCheck(script.deps, { ...input(), onProgress: () => undefined }))
      .resolves.toEqual({ kind: "failed", done: 0, total: 1_234, error: blocked });
    expect(script.pauses).toEqual([]);
  });

  it("P10 stops and shows nothing on an abort or when the store or selection moved between chunks", async () => {
    const controller = new AbortController();
    let previews = 0;
    const aborting = setup({ preview: async (storeConnectionId, chunk) => {
      previews += 1;
      if (previews === 2) controller.abort();
      return previewOf(storeConnectionId, chunk);
    } });
    await expect(runListingCheck(aborting.deps, { ...input(controller.signal), onProgress: () => undefined })).resolves.toEqual({ kind: "aborted" });
    expect(previews).toBe(2);

    let current = true;
    let movingPreviews = 0;
    const moving = setup({ stillCurrent: () => current, preview: async (storeConnectionId, chunk) => {
      movingPreviews += 1;
      current = false;
      return previewOf(storeConnectionId, chunk);
    } });
    await expect(runListingCheck(moving.deps, { ...input(), onProgress: () => undefined })).resolves.toEqual({ kind: "aborted" });
    expect(movingPreviews).toBe(1);

    const abortError = setup({ preview: async () => { throw new DOMException("The operation was aborted.", "AbortError"); } });
    await expect(runListingCheck(abortError.deps, { ...input(), onProgress: () => undefined })).resolves.toEqual({ kind: "aborted" });
  });

  it("fails rather than show one store's rows under another", async () => {
    const script = setup({ preview: async (_storeConnectionId, chunk) => previewOf(9, chunk) });
    const outcome = await runListingCheck(script.deps, { ...input(), onProgress: () => undefined });
    expect(outcome).toMatchObject({ kind: "failed", done: 0 });
  });

  it("posts each chunk's ids to the preview route", async () => {
    const fetcher = vi.fn<PublishFetch>(async () => json(previewOf(5, [1, 2])));
    await postCheckPreview(5, [1, 2], new AbortController().signal, fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/dropship/listings/preview", expect.objectContaining({
      method: "POST", body: JSON.stringify({ storeConnectionId: 5, productVariantIds: [1, 2] }) }));
  });

  it("DUX2 reads one checked size's full preview, with its content, when its sheet opens (review round 2)", async () => {
    const presentation = { source: "resolved_listing", title: "Envelope", descriptionText: "Holds one card.", productName: "Envelope",
      variantName: "Pack of 50", unitsPerVariant: 50, brand: "Card Shellz", condition: "New", itemSpecifics: [], images: [], issues: [] };
    const answer = previewOf(5, [7]);
    const full = { preview: { ...answer.preview, rows: [{ ...answer.preview.rows[0], presentation }] } };
    const fetcher = vi.fn<PublishFetch>(async () => json(full));
    const row = await readCheckRowDetail(5, 7, new AbortController().signal, fetcher);
    expect(fetcher).toHaveBeenCalledWith("/api/dropship/listings/preview", expect.objectContaining({
      method: "POST", body: JSON.stringify({ storeConnectionId: 5, productVariantIds: [7] }) }));
    expect(row?.presentation?.descriptionText).toBe("Holds one card.");
    // Another store's answer, or no row for the size, is nothing to show.
    expect(await readCheckRowDetail(6, 7, new AbortController().signal, fetcher)).toBeNull();
    expect(await readCheckRowDetail(5, 8, new AbortController().signal, fetcher)).toBeNull();
    // An answer off the contract is "site updating", as every step 3 read.
    const broken = vi.fn<PublishFetch>(async () => json({ preview: { ...full.preview, rows: [{ ...full.preview.rows[0], marketplaceQuantity: "1" }] } }));
    await expect(readCheckRowDetail(5, 7, new AbortController().signal, broken)).rejects.toMatchObject({ code: DROPSHIP_SITE_UPDATING_CODE });
  });
});
