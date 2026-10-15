import { afterEach, describe, expect, it, vi } from "vitest";
import { saveSizePricesInputSchema, type SaveSizePricesInput, type SaveSizePricesResponse } from "@shared/dropship/listing-setting-writes";
import { listingSettingsPricesResponseSchema, type ListingSettingsPricesResponse, type ListingSettingsSizePrice } from "@shared/dropship/listing-settings";
import { DropshipApiError } from "../dropship-ops-surface";
import { listingSettingsPricesQueryOptions, listingSettingsQueryKey } from "../dropship-listing-settings";
import {
  LISTING_SETTINGS_SAVE_WORDS,
  nextSaveAttempt,
  productEditorId,
  reduceListingSettingsDraft,
  SIZE_PRICES_EDITOR_ID,
  type ListingSettingsDraft,
  type WriteFailurePhase,
} from "../dropship-listing-settings-drafts";
import { DRAWER_WORDS } from "../dropship-listing-settings-drawer";
import type { ProductSettingsSaveDrafts } from "../dropship-listing-settings-product-requests";
import { emptySizePricesDraft, reloadTyped, SIZE_PRICES_REQUEST_INVALID, sizePriceKey, type SizePricesDraftValue } from "../dropship-listing-settings-size-prices";
import {
  loadLatestSizePrices,
  readSavedSizePrices,
  refreshAfterSizePricesSave,
  rereadSizePricesPages,
  runSizePricesSave,
  sendSizePrices,
  sizePricesEndpoint,
  type SizePricesQueryClient,
  type SizePricesSaveRun,
} from "../dropship-listing-settings-size-prices-requests";
import { LISTING_SETTINGS_EDIT_WORDS, LISTING_SETTINGS_SIZE_PRICES_WORDS } from "../dropship-listing-settings-words";

/** W8 from "Give these sizes a price" (plan PR 10f, 9.4, 9.5, 3.3, 3.6; D5, D6, D7, D9, D12; CC-C5). */

const STORE = 22;
const ENDPOINT = `/api/dropship/listings/stores/${STORE}/listing-settings/size-prices`;
const WORDS = LISTING_SETTINGS_EDIT_WORDS;
const UNCONFIRMED = "We couldn't confirm your save.";
const GENERATED_AT = "2026-10-14T12:00:00.000Z";

/** The sheet's draft: two sizes typed, one with a saved revision, one without (D6). */
const TYPED: SizePricesDraftValue = { "size:101": { text: "14.99", expectedRevisionId: 7 }, "size:102": { text: "5", expectedRevisionId: null } };
const SENT: SaveSizePricesInput = {
  idempotencyKey: "ls-size-prices:1",
  rows: [{ productVariantId: 101, priceCents: 1499, expectedRevisionId: 7 }, { productVariantId: 102, priceCents: 500, expectedRevisionId: null }],
};
const ANSWER: SaveSizePricesResponse = { outcome: "changed", sizes: [{ productVariantId: 101, revisionId: 8, idempotentReplay: false }, { productVariantId: 102, revisionId: 1, idempotentReplay: false }] };
const REPLAYED: SaveSizePricesResponse = { outcome: "replayed", sizes: [{ productVariantId: 101, revisionId: 8, idempotentReplay: true }, { productVariantId: 102, revisionId: 1, idempotentReplay: true }] };

function size(productVariantId: number, overrides: Partial<ListingSettingsSizePrice> = {}): ListingSettingsSizePrice {
  return {
    productVariantId, productId: 11, productName: "Penny Sleeves", sizeName: "Pack of 100", sku: null, priceCents: null, source: "none",
    rule: null, basis: null, basisAmountCents: null, issue: "price_unavailable", costCents: 210, belowCostByCents: null, limits: [], pausedSince: null,
    settingRevisionId: 7, ...overrides,
  };
}

function page(rows: ListingSettingsSizePrice[], pageNumber = 0, total = rows.length): ListingSettingsPricesResponse {
  return listingSettingsPricesResponseSchema.parse({ storeConnectionId: STORE, page: pageNumber, pageSize: 50, total, generatedAt: GENERATED_AT, rows });
}

function sizesDraft(value: SizePricesDraftValue = TYPED): ListingSettingsDraft {
  const opened = reduceListingSettingsDraft(null, { type: "open", editor: SIZE_PRICES_EDITOR_ID, place: LISTING_SETTINGS_SIZE_PRICES_WORDS.title, base: emptySizePricesDraft() });
  return reduceListingSettingsDraft(opened, { type: "edit", value })!;
}

/** The provider's two save calls on the real reducer, minting keys `ls-size-prices:1`, `:2`… */
function reducerDrafts(start: ListingSettingsDraft) {
  let draft: ListingSettingsDraft | null = start;
  let keys = 0;
  const drafts: ProductSettingsSaveDrafts & { current: () => ListingSettingsDraft; minted: () => number } = {
    startSave: (signature, prefix) => {
      const attempt = nextSaveAttempt(draft, signature, () => `${prefix}:${++keys}`);
      if (attempt === null) return null;
      draft = reduceListingSettingsDraft(draft, { type: "startSave", attempt });
      return attempt.key;
    },
    settle: (key, settlement) => {
      draft = settlement.kind === "failure"
        ? reduceListingSettingsDraft(draft, { type: "failure", key, failure: settlement.failure })
        : reduceListingSettingsDraft(draft, { type: "saved", key, nowMs: 1_000, viewStale: settlement.kind === "saved_view_stale" });
    },
    current: () => draft!,
    minted: () => keys,
  };
  return drafts;
}

function setup(overrides: Partial<SizePricesSaveRun> = {}, start: ListingSettingsDraft = sizesDraft()) {
  const drafts = reducerDrafts(start);
  const sent: SaveSizePricesInput[] = [];
  const callbacks = { onSaveStarted: vi.fn(), onSaveSettled: vi.fn() };
  const answers: Array<unknown | Error> = [];
  const send = vi.fn(async (body: SaveSizePricesInput) => {
    sent.push(body);
    const next = answers.length > 0 ? answers.shift() : ANSWER;
    if (next instanceof Error) throw next;
    return next;
  });
  const input: SizePricesSaveRun = {
    storeConnectionId: STORE, draft: drafts.current(), drafts, callbacks, send,
    reread: vi.fn(async () => undefined), onSettingsSaved: vi.fn(), onBlocked: vi.fn(),
    ...overrides,
  };
  /** Save, or Check again, on the draft as it is now. */
  const save = () => runSizePricesSave({ ...input, draft: drafts.current() });
  return { input, drafts, sent, callbacks, answers, send, save };
}

const apiError = (status: number, code: string | null, context?: Record<string, unknown>, message = "Server words.") =>
  new DropshipApiError({ status, code, message, context });
const networkDrop = () => new TypeError("Failed to fetch");
const NO_REFUSAL = { outsideLimit: new Set<number>(), conflicts: new Set<number>() };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The request, its answer and the reads (plan 9.4, D9)
// ---------------------------------------------------------------------------

describe("the W8 request", () => {
  it("PUTs the body under the store's listing settings, and resolves with the answer unread", async () => {
    expect(sizePricesEndpoint(STORE)).toBe(ENDPOINT);
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(JSON.stringify(ANSWER), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendSizePrices(STORE, SENT)).resolves.toEqual(ANSWER);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(ENDPOINT);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual(SENT);
    // A refusal is the API error, with its code and context.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", message: "Moved.", context: { conflictCount: 1 } } }), { status: 409, headers: { "Content-Type": "application/json" } }));
    await expect(sendSizePrices(STORE, SENT)).rejects.toMatchObject({ status: 409, code: "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", context: { conflictCount: 1 } });
  });

  it("checks an answer against its contract, for the sizes it was sent for", () => {
    expect(readSavedSizePrices(ANSWER, SENT.rows)).toEqual(ANSWER);
    expect(readSavedSizePrices(REPLAYED, SENT.rows)).toEqual(REPLAYED);
    expect(readSavedSizePrices({ ...ANSWER, sizes: [...ANSWER.sizes].reverse() }, SENT.rows).sizes).toHaveLength(2);
    for (const bad of [
      { ...ANSWER, extra: 1 }, { ...ANSWER, outcome: "replayed" }, { ...REPLAYED, outcome: "changed" }, { ...ANSWER, outcome: "unchanged" },
      { ...ANSWER, sizes: [ANSWER.sizes[0]] }, { ...ANSWER, sizes: [...ANSWER.sizes, { productVariantId: 103, revisionId: 1, idempotentReplay: false }] },
      { ...ANSWER, sizes: [ANSWER.sizes[0], { ...ANSWER.sizes[0] }] }, { ...ANSWER, sizes: [ANSWER.sizes[0], { ...ANSWER.sizes[1], productVariantId: 103 }] },
      { ...ANSWER, sizes: [{ ...ANSWER.sizes[0], revisionId: null }, ANSWER.sizes[1]] }, { outcome: "changed" }, null, "ok",
    ]) {
      expect(() => readSavedSizePrices(bad, SENT.rows)).toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_OFF_CONTRACT", context: expect.objectContaining({ write: "W8", sizeCount: 2, issues: expect.any(Array) }) }));
    }
    expect(() => readSavedSizePrices(ANSWER, [SENT.rows[0]])).toThrow(expect.objectContaining({ context: expect.objectContaining({ sizeCount: 1, issues: [{ path: "sizes", code: "other_sizes" }] }) }));
  });

  it("reads every Prices page, the Products list, every product's detail, the summary and the size prices again after a save, cancelling reads in flight first (D9)", async () => {
    const calls: string[] = [];
    const client = {
      cancelQueries: vi.fn(async ({ queryKey }: { queryKey: readonly unknown[] }) => { calls.push(`cancel ${String(queryKey[3])}`); }),
      invalidateQueries: vi.fn(async (filter: { queryKey?: readonly unknown[]; predicate?: (query: { queryKey: readonly unknown[] }) => boolean }) => {
        calls.push(filter.queryKey ? `invalidate ${String(filter.queryKey[3])}` : "invalidate sizes");
        if (filter.predicate) {
          expect(filter.predicate({ queryKey: [`/api/dropship/listings/stores/${STORE}/variants/101/price`] })).toBe(true);
          expect(filter.predicate({ queryKey: [`/api/dropship/listings/stores/${STORE + 1}/variants/101/price`] })).toBe(false);
          expect(filter.predicate({ queryKey: [...listingSettingsQueryKey(STORE), "prices"] })).toBe(false);
        }
      }),
      fetchQuery: vi.fn(),
    };
    await refreshAfterSizePricesSave(client as unknown as SizePricesQueryClient, STORE);
    expect(calls).toEqual([
      "cancel prices", "cancel products", "cancel product", "cancel summary",
      "invalidate prices", "invalidate products", "invalidate product", "invalidate summary", "invalidate sizes",
    ]);
    for (const read of ["prices", "products", "product", "summary"]) {
      expect(client.cancelQueries).toHaveBeenCalledWith({ queryKey: [...listingSettingsQueryKey(STORE), read] });
      expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: [...listingSettingsQueryKey(STORE), read] }, { throwOnError: true });
    }
    // Never from the answer: nothing is fetched or set here.
    expect(client.fetchQuery).not.toHaveBeenCalled();
    client.invalidateQueries.mockRejectedValueOnce(networkDrop());
    await expect(refreshAfterSizePricesSave(client as unknown as SizePricesQueryClient, STORE)).rejects.toThrow("Failed to fetch");
  });

  it("reads the loaded pages again, fresh, and Load latest keeps the typed sizes on them with their new revisions, never a conflict's actualRevisionId (9.5, CC-C5)", async () => {
    const pages = [page([size(101, { settingRevisionId: 8 }), size(104)], 0, 51), page([size(103, { settingRevisionId: 2 })], 1, 51)];
    const client = {
      cancelQueries: vi.fn(async () => undefined),
      fetchQuery: vi.fn(async ({ queryKey }: { queryKey: readonly unknown[] }) => pages[(queryKey[4] as { page: number }).page]),
    };
    await expect(rereadSizePricesPages(client as never, STORE, 2)).resolves.toEqual(pages);
    for (const pageNumber of [0, 1]) {
      const options = listingSettingsPricesQueryOptions(STORE, { search: "", show: "cannot_price", page: pageNumber });
      expect(client.cancelQueries).toHaveBeenCalledWith({ queryKey: options.queryKey, exact: true });
      expect(client.fetchQuery).toHaveBeenCalledWith(expect.objectContaining({ queryKey: options.queryKey, staleTime: 0, retry: false }));
    }
    expect(client.fetchQuery).toHaveBeenCalledTimes(2);
    // At least the first page, whatever the count says.
    await rereadSizePricesPages(client as never, STORE, 0);
    expect(client.fetchQuery).toHaveBeenCalledTimes(3);
    client.fetchQuery.mockRejectedValueOnce(networkDrop());
    await expect(rereadSizePricesPages(client as never, STORE, 1)).rejects.toThrow("Failed to fetch");
    // Load latest: 101 stays with revision 8 from its row, 102 left the list, 103 wasn't typed.
    const reload = await loadLatestSizePrices(client as never, STORE, 2, { ...TYPED, "size:103": { text: "2", expectedRevisionId: 1 } });
    expect(reload).toEqual({
      value: { "size:101": { text: "14.99", expectedRevisionId: 8 }, "size:103": { text: "2", expectedRevisionId: 2 } },
      kept: 2, dropped: 1, line: "1 size left this list and wasn't saved.", keeps: true,
    });
    expect(JSON.stringify(reload)).not.toMatch(/actualRevisionId/);
    client.fetchQuery.mockRejectedValueOnce(networkDrop());
    await expect(loadLatestSizePrices(client as never, STORE, 1, TYPED)).rejects.toThrow("Failed to fetch");
  });
});

// ---------------------------------------------------------------------------
// Running a save (plan 3.6)
// ---------------------------------------------------------------------------

describe("runSizePricesSave (plan 3.6)", () => {
  it("(1) sends one PUT with the draft's ls-size-prices key, the typed sizes as integer cents with the revisions their rows were read with, re-reads, then tells the step", async () => {
    const run = setup();
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false, sizeCount: 2 });
    expect(run.sent).toEqual([SENT]);
    expect(saveSizePricesInputSchema.safeParse(run.sent[0]).success).toBe(true);
    expect(JSON.stringify(run.sent[0])).not.toMatch(/text|14\.99|actualRevisionId/);
    expect(run.input.reread).toHaveBeenCalledTimes(1);
    expect(run.input.onSettingsSaved).toHaveBeenCalledTimes(1);
    expect(run.callbacks.onSaveStarted).toHaveBeenCalledTimes(1);
    expect(run.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
    expect(run.input.onBlocked).not.toHaveBeenCalled();
    expect(run.drafts.current()).toMatchObject({ phase: "saved", changes: 0, attempt: null });
    // The order typed doesn't count: the same sizes send the same body.
    const reversed = setup({}, sizesDraft({ "size:102": TYPED["size:102"], "size:101": TYPED["size:101"] }));
    await reversed.save();
    expect(reversed.sent).toEqual([SENT]);
  });

  it("(2) a dropped answer, then Check again, resends the same key and body; a replay counts as saved", async () => {
    const run = setup();
    run.answers.push(networkDrop(), REPLAYED);
    await expect(run.save()).resolves.toEqual({ kind: "failed", failure: { phase: "uncertain", message: UNCONFIRMED, code: null, status: null, fields: [] }, refusal: NO_REFUSAL });
    expect(run.drafts.current()).toMatchObject({ phase: "uncertain", changes: 2, attempt: { key: "ls-size-prices:1" } });
    expect(run.input.onSettingsSaved).not.toHaveBeenCalled();
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false, sizeCount: 2 });
    expect(run.sent).toEqual([SENT, SENT]);
    expect(run.drafts.minted()).toBe(1);
    expect(run.input.reread).toHaveBeenCalledTimes(1);
  });

  it("(3) a block goes to the banner and the draft is kept", async () => {
    const blocked = apiError(403, "DROPSHIP_LISTING_STORE_BLOCKED", { reason: "paused" });
    const run = setup();
    run.answers.push(blocked);
    await expect(run.save()).resolves.toEqual({ kind: "failed", failure: { phase: "blocked", message: "Nothing was saved.", code: "DROPSHIP_LISTING_STORE_BLOCKED", status: 403, fields: [] }, refusal: NO_REFUSAL });
    expect(run.input.onBlocked).toHaveBeenCalledWith(blocked);
    expect(run.drafts.current()).toMatchObject({ phase: "blocked", changes: 2, attempt: null });
    expect(run.input.onSettingsSaved).not.toHaveBeenCalled();
    expect(run.input.reread).not.toHaveBeenCalled();
  });

  it("(4) a 429 keeps the key, and Save sends the same request", async () => {
    const run = setup();
    run.answers.push(apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"));
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "rate_limited", message: LISTING_SETTINGS_SAVE_WORDS.rateLimited } });
    expect(run.drafts.current().attempt?.key).toBe("ls-size-prices:1");
    await expect(run.save()).resolves.toMatchObject({ kind: "saved" });
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-size-prices:1", "ls-size-prices:1"]);
  });

  it("(5) a refusal means the next try gets a new key; a limit refusal names its rows and is counted from sizeCount, a size no longer chosen says so (9.5)", async () => {
    const run = setup();
    run.answers.push(apiError(422, "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", { sizes: [{ productVariantId: 101, priceCents: 1499, blockers: ["pricing:above_ceiling:policy_3"] }], sizeCount: 1 }));
    await expect(run.save()).resolves.toEqual({
      kind: "failed",
      failure: { phase: "refused", message: "1 size's price would be outside what Card Shellz allows. Enter prices Card Shellz allows.", code: "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", status: 422, fields: [] },
      refusal: { outsideLimit: new Set([101]), conflicts: new Set() },
    });
    expect(run.drafts.current()).toMatchObject({ phase: "refused", attempt: null, changes: 2 });
    expect(run.input.onBlocked).not.toHaveBeenCalled();
    await expect(run.save()).resolves.toMatchObject({ kind: "saved" });
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-size-prices:1", "ls-size-prices:2"]);
    // Rows past the first 100 are marked by a re-read: the count is the server's, the marks the list's.
    const capped = setup();
    capped.answers.push(apiError(422, "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", { sizes: [{ productVariantId: 101 }], sizeCount: 130 }));
    await expect(capped.save()).resolves.toMatchObject({ failure: { message: "130 sizes' prices would be outside what Card Shellz allows. Enter prices Card Shellz allows." }, refusal: { outsideLimit: new Set([101]) } });
    // A size no longer chosen (404, naming it): a conflict with its words, the size marked, and Load latest the way out
    // (the pages read again no longer list it, so it leaves the draft): never resent under another key (9.5, W6's rule).
    const gone = setup();
    gone.answers.push(apiError(404, "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", { productVariantId: 102 }));
    await expect(gone.save()).resolves.toEqual({
      kind: "failed", failure: { phase: "conflict", message: "This size isn't chosen any more. Load the list again.", code: "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", status: 404, fields: [] },
      refusal: { outsideLimit: new Set(), conflicts: new Set([102]) },
    });
    expect(gone.drafts.current()).toMatchObject({ phase: "conflict", attempt: null, changes: 2 });
    expect(reloadTyped(TYPED, [page([size(101, { settingRevisionId: 7 })])])).toMatchObject({ value: { "size:101": TYPED["size:101"] }, dropped: 1, line: "1 size left this list and wasn't saved." });
  });

  it("(6) a version conflict is called a conflict, counted by the server, with the sizes it names marked, and the key dropped for Load latest (9.5)", async () => {
    const run = setup();
    run.answers.push(apiError(409, "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", { conflicts: [{ productVariantId: 101, expectedRevisionId: 7, actualRevisionId: 8 }], conflictCount: 1 }));
    await expect(run.save()).resolves.toEqual({
      kind: "failed",
      failure: { phase: "conflict", message: "1 size's price changed in another window.", code: "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", status: 409, fields: [] },
      refusal: { outsideLimit: new Set(), conflicts: new Set([101]) },
    });
    expect(run.drafts.current()).toMatchObject({ phase: "conflict", message: "1 size's price changed in another window.", attempt: null, changes: 2 });
    expect(run.input.onSettingsSaved).not.toHaveBeenCalled();
    // The typed sizes keep the revisions they were read with: Load latest re-reads the pages (CC-C5).
    expect(run.drafts.current().value).toEqual(TYPED);
    const many = setup();
    many.answers.push(apiError(409, "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", { conflicts: [{ productVariantId: 101 }, { productVariantId: 102 }], conflictCount: 3 }));
    await expect(many.save()).resolves.toMatchObject({ failure: { phase: "conflict", message: "3 sizes' prices changed in another window." }, refusal: { conflicts: new Set([101, 102]) } });
    // The next Save (after Load latest moved the revisions) is a new request: a new key, never the conflict's.
    await expect(run.save()).resolves.toMatchObject({ kind: "saved" });
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-size-prices:1", "ls-size-prices:2"]);
  });

  it("(7) saved, then the re-read fails: saved with a stale view", async () => {
    const run = setup({ reread: vi.fn(async () => { throw networkDrop(); }) });
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: true, sizeCount: 2 });
    expect(run.drafts.current()).toMatchObject({ phase: "saved_view_stale", message: LISTING_SETTINGS_SAVE_WORDS.savedViewStale, changes: 0 });
    expect(run.input.onSettingsSaved).toHaveBeenCalledTimes(1);
  });

  it("(8) an off-contract 2xx, or one for other sizes, counts as saved with a stale view, never as data", async () => {
    for (const answer of [{ ...ANSWER, extra: 1 }, { ...ANSWER, sizes: [ANSWER.sizes[0]] }, { ...ANSWER, sizes: [ANSWER.sizes[0], { ...ANSWER.sizes[1], productVariantId: 103 }] }, { outcome: "changed" }, null]) {
      const run = setup();
      run.answers.push(answer);
      await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: true, sizeCount: 2 });
      expect(run.input.reread).toHaveBeenCalledTimes(1);
      expect(run.input.onSettingsSaved).toHaveBeenCalledTimes(1);
      expect(run.drafts.current()).toMatchObject({ phase: "saved_view_stale" });
    }
  });

  it("(9) sends nothing with another editor's draft, nothing typed, a box the parsers refuse, over 200 typed, another action running, or a save out", async () => {
    const other = setup({}, { ...sizesDraft(), editor: productEditorId(11) });
    await expect(other.save()).resolves.toEqual({ kind: "not_started", message: null });
    const untyped = setup({}, sizesDraft({}));
    await expect(untyped.save()).resolves.toEqual({ kind: "not_started", message: null });
    const notMine = setup({}, { ...sizesDraft(), value: { items: [] } });
    await expect(notMine.save()).resolves.toEqual({ kind: "not_started", message: null });
    const bad = setup({}, sizesDraft({ ...TYPED, "size:103": { text: "abc", expectedRevisionId: null } }));
    await expect(bad.save()).resolves.toEqual({ kind: "invalid", message: "Enter a price like 14.99." });
    const zero = setup({}, sizesDraft({ "size:103": { text: "0", expectedRevisionId: null } }));
    await expect(zero.save()).resolves.toEqual({ kind: "invalid", message: DRAWER_WORDS.inputRange });
    const many: SizePricesDraftValue = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [sizePriceKey(1_000 + index), { text: "1", expectedRevisionId: null }]));
    const over = setup({}, sizesDraft(many));
    await expect(over.save()).resolves.toEqual({ kind: "invalid", message: "Save up to 200 prices at a time." });
    for (const run of [other, untyped, notMine, bad, zero, over]) {
      expect(run.send).not.toHaveBeenCalled();
      expect(run.callbacks.onSaveStarted).not.toHaveBeenCalled();
      expect(run.drafts.current().phase).toBe("editing");
    }
    // Exactly 200 is one request (D12).
    const full = setup({}, sizesDraft(Object.fromEntries(Object.entries(many).slice(0, 200))));
    await expect(full.save()).resolves.toMatchObject({ kind: "saved", viewStale: true, sizeCount: 200 });
    expect(full.sent[0].rows).toHaveLength(200);

    const disabled = setup({ callbacks: { disabled: true, onSaveStarted: vi.fn(), onSaveSettled: vi.fn() } });
    await expect(disabled.save()).resolves.toEqual({ kind: "not_started", message: DRAWER_WORDS.busy });
    const refusing = setup({ callbacks: { onSaveStarted: () => { throw new Error("Wait for the current listing action to finish."); }, onSaveSettled: vi.fn() } });
    await expect(refusing.save()).resolves.toEqual({ kind: "not_started", message: "Wait for the current listing action to finish." });
    expect(refusing.input.callbacks.onSaveSettled).not.toHaveBeenCalled();
    const saving = setup();
    saving.drafts.startSave("another request", "ls-size-prices");
    await expect(saving.save()).resolves.toEqual({ kind: "not_started", message: null });
    for (const run of [disabled, refusing, saving]) expect(run.send).not.toHaveBeenCalled();
    expect(saving.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
  });

  it("(9) settles a body it can't build as refused, sends nothing, and the next try gets a new key", async () => {
    const run = setup();
    let tries = 0;
    // The first key, "x:1", is one the shared schema refuses (under 8 characters): that body is never built.
    const drafts: ProductSettingsSaveDrafts = {
      startSave: (signature, prefix) => run.drafts.startSave(signature, tries++ === 0 ? "x" : prefix),
      settle: run.drafts.settle,
    };
    await expect(runSizePricesSave({ ...run.input, draft: run.drafts.current(), drafts })).resolves.toEqual({
      kind: "failed",
      failure: { phase: "refused", message: "These prices can't be sent as they are. Check them and save again.", code: SIZE_PRICES_REQUEST_INVALID, status: null, fields: [] },
      refusal: NO_REFUSAL,
    });
    expect(run.send).not.toHaveBeenCalled();
    expect(run.callbacks.onSaveStarted).toHaveBeenCalledTimes(1);
    expect(run.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
    expect(run.drafts.current()).toMatchObject({ phase: "refused", attempt: null, changes: 2 });
    expect(run.input.onBlocked).not.toHaveBeenCalled();
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false, sizeCount: 2 });
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-size-prices:2"]);
  });

  it("(10) never sends twice while one save is in flight", async () => {
    const run = setup();
    let resolve: (value: unknown) => void = () => undefined;
    run.send.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const first = run.save();
    await expect(run.save()).resolves.toEqual({ kind: "not_started", message: null });
    resolve(ANSWER);
    await expect(first).resolves.toMatchObject({ kind: "saved" });
    expect(run.send).toHaveBeenCalledTimes(1);
    expect(run.callbacks.onSaveSettled).toHaveBeenCalledTimes(2);
  });

  it("(11) BUSY by reason: heavy and key changed say nothing was saved; no reason is unconfirmed (D7a); all keep the key", async () => {
    const cases: Array<[Record<string, unknown> | undefined, WriteFailurePhase, string]> = [
      [{ reason: "heavy_write_in_progress", retryAfterSeconds: 5 }, "unreachable", WORDS.busyHeavy],
      [{ reason: "request_key_changed" }, "unreachable", WORDS.busyKeyChanged],
      [undefined, "uncertain", UNCONFIRMED],
    ];
    for (const [context, phase, message] of cases) {
      const run = setup();
      run.answers.push(apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY", context));
      await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase, message }, refusal: NO_REFUSAL });
      expect(run.drafts.current().attempt?.key).toBe("ls-size-prices:1");
      await expect(run.save()).resolves.toMatchObject({ kind: "saved" });
      expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-size-prices:1", "ls-size-prices:1"]);
    }
  });

  it("(12) a Check again answered by BUSY, a 429 or the write gate stays unconfirmed, with the same key (D7b)", async () => {
    const run = setup();
    run.answers.push(networkDrop(), apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "heavy_write_in_progress" }), apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"));
    await run.save();
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "uncertain", message: WORDS.stillUnconfirmed } });
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "uncertain", message: WORDS.stillUnconfirmedRateLimited } });
    expect(run.drafts.current()).toMatchObject({ phase: "uncertain", attempt: { key: "ls-size-prices:1" } });
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-size-prices:1", "ls-size-prices:1", "ls-size-prices:1"]);
    const gate = setup();
    const blocked = apiError(403, "DROPSHIP_LISTING_STORE_BLOCKED", { reason: "paused" });
    gate.answers.push(networkDrop(), blocked);
    await gate.save();
    await expect(gate.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "uncertain", message: UNCONFIRMED } });
    expect(gate.input.onBlocked).toHaveBeenCalledWith(blocked);
    expect(gate.drafts.current()).toMatchObject({ phase: "uncertain", attempt: { key: "ls-size-prices:1" } });
    // A refusal or a conflict after a Check again stands.
    const moved = setup();
    moved.answers.push(networkDrop(), apiError(409, "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", { conflicts: [{ productVariantId: 101 }], conflictCount: 1 }));
    await moved.save();
    await expect(moved.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "conflict" } });
  });

  it("(13) the three fatal codes are final: refused, a new key next time, never Check again (D7c)", async () => {
    for (const code of ["DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE", "DROPSHIP_LISTING_PRICE_INVARIANT_FAILED"]) {
      const run = setup();
      run.answers.push(apiError(500, code, undefined, "Something went wrong."));
      await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", message: WORDS.fatal, code }, refusal: NO_REFUSAL });
      expect(run.drafts.current()).toMatchObject({ phase: "refused", attempt: null, changes: 2 });
      await run.save();
      expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-size-prices:1", "ls-size-prices:2"]);
      // Not even after a Check again: a dropped answer, then the fatal code, is final too.
      const after = setup();
      after.answers.push(networkDrop(), apiError(500, code));
      await after.save();
      await expect(after.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", message: WORDS.fatal } });
      expect(after.drafts.current()).toMatchObject({ phase: "refused", attempt: null });
    }
  });
});

// ---------------------------------------------------------------------------
// Every code W8's route answers (plan 3.3, 9.5)
// ---------------------------------------------------------------------------

/** [status, code, context, phase, words (null: the server's), the rows marked]. */
const EBAY_DOWN = "Can't reach eBay right now. Nothing was saved. Try again.";
const SHIPPING_OUTAGE = (code: string) => `Can't check Card Shellz shipping right now. Try again in a few minutes. Reference: ${code}`;
type Row = readonly [number, string | null, Record<string, unknown> | undefined, WriteFailurePhase, string | null, { outsideLimit: number[]; conflicts: number[] }];
const NONE = { outsideLimit: [], conflicts: [] };
const W8_ROWS: readonly Row[] = [
  // Plan 9.5: W8's own rows.
  [409, "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", { conflicts: [{ productVariantId: 101, expectedRevisionId: 7, actualRevisionId: 8 }], conflictCount: 2 }, "conflict", "2 sizes' prices changed in another window.", { outsideLimit: [], conflicts: [101] }],
  [409, "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", { conflicts: [{ productVariantId: 101 }, { productVariantId: 102 }] }, "conflict", LISTING_SETTINGS_SAVE_WORDS.conflict, { outsideLimit: [], conflicts: [101, 102] }],
  [422, "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", { sizes: [{ productVariantId: 102, priceCents: 500, blockers: ["pricing:below_floor:policy_3"] }], sizeCount: 2 }, "refused", "2 sizes' prices would be outside what Card Shellz allows. Enter prices Card Shellz allows.", { outsideLimit: [102], conflicts: [] }],
  [422, "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", { sizes: [{ productVariantId: 102 }] }, "refused", null, { outsideLimit: [102], conflicts: [] }],
  [404, "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", { productVariantId: 102 }, "conflict", LISTING_SETTINGS_SIZE_PRICES_WORDS.notAvailable, { outsideLimit: [], conflicts: [102] }],
  [404, "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", undefined, "conflict", LISTING_SETTINGS_SIZE_PRICES_WORDS.notAvailable, NONE],
  [500, "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE", undefined, "refused", WORDS.fatal, NONE],
  // Plan 3.3: the shared rows (6, 7, 8, 9, 12, 16, 21 among them), as W5's and W12's tables carry them.
  [429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED", undefined, "rate_limited", LISTING_SETTINGS_SAVE_WORDS.rateLimited, NONE],
  [401, "DROPSHIP_AUTH_REQUIRED", undefined, "refused", WORDS.signedOut, NONE],
  [503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "heavy_write_in_progress" }, "unreachable", WORDS.busyHeavy, NONE],
  [503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "request_key_changed" }, "unreachable", WORDS.busyKeyChanged, NONE],
  [503, "DROPSHIP_LISTING_SETTINGS_BUSY", undefined, "uncertain", UNCONFIRMED, NONE],
  [503, "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE", { retryable: true }, "unreachable", SHIPPING_OUTAGE("DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE"), NONE],
  [502, "DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_UNAVAILABLE", { retryable: true }, "unreachable", SHIPPING_OUTAGE("DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_UNAVAILABLE"), NONE],
  ...["DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", "DROPSHIP_EBAY_REFRESH_LOCK_UNAVAILABLE", "DROPSHIP_CREDENTIAL_CHANGED", "DROPSHIP_EBAY_TOKEN_REFRESH_INVALID_RESPONSE", "DROPSHIP_EBAY_OAUTH_NOT_CONFIGURED"]
    .map((code): Row => [503, code, undefined, "unreachable", EBAY_DOWN, NONE]),
  [502, null, undefined, "uncertain", UNCONFIRMED, NONE],
  [504, null, undefined, "uncertain", UNCONFIRMED, NONE],
  [500, "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", undefined, "refused", WORDS.fatal, NONE],
  [500, "DROPSHIP_LISTING_PRICE_INVARIANT_FAILED", undefined, "refused", WORDS.fatal, NONE],
  [500, "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", undefined, "uncertain", UNCONFIRMED, NONE],
  [409, "DROPSHIP_IDEMPOTENCY_CONFLICT", undefined, "refused", LISTING_SETTINGS_SAVE_WORDS.keyReused, NONE],
  [413, "DROPSHIP_REQUEST_TOO_LARGE", undefined, "refused", WORDS.tooBig, NONE],
  [400, "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT", { issues: [] }, "refused", WORDS.invalid, NONE],
  [400, "DROPSHIP_REQUEST_JSON_INVALID", undefined, "refused", WORDS.invalid, NONE],
  [422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", undefined, "refused", null, NONE],
  [422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", { reason: "store_text_limit", textBytes: 30_000_100, maxTextBytes: 30_000_000 }, "refused", WORDS.storeTextLimit, NONE],
  [409, "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED", undefined, "blocked", "Nothing was saved.", NONE],
  [422, "DROPSHIP_EBAY_CATEGORY_MARKETPLACE_UNSUPPORTED", undefined, "blocked", "Nothing was saved.", NONE],
  [403, "DROPSHIP_LISTING_VENDOR_BLOCKED", { reason: "paused" }, "blocked", "Nothing was saved.", NONE],
  [403, "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", { reason: "lapsed" }, "blocked", "Nothing was saved.", NONE],
  [403, "DROPSHIP_LISTING_STORE_BLOCKED", { reason: "paused" }, "blocked", "Nothing was saved.", NONE],
  [404, "DROPSHIP_STORE_CONNECTION_REQUIRED", undefined, "blocked", "Nothing was saved.", NONE],
  [409, "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED", undefined, "blocked", "Nothing was saved.", NONE],
  [422, "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY", undefined, "blocked", "Nothing was saved.", NONE],
  [409, "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_TOKEN_REQUIRED", undefined, "blocked", "Nothing was saved.", NONE],
  ...[
    "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED", "DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED", "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED",
    "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED", "DROPSHIP_EBAY_STORE_CATEGORIES_ACCESS_DENIED", "DROPSHIP_EBAY_CATEGORIES_ACCESS_DENIED",
  ].map((code): Row => [403, code, undefined, "blocked", "Nothing was saved.", NONE]),
  [422, "DROPSHIP_SOMETHING_NEW", undefined, "refused", null, NONE],
  // What W8 can't be answered (every row is a typed price; no product, category, text or eBay value is named): refused, never retried.
  ...([
    [422, "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST"], [422, "DROPSHIP_PRICING_RULES_NOT_CONFIGURED"], [422, "DROPSHIP_LISTING_PRICE_RELEASE_LIMIT"],
    [409, "DROPSHIP_LISTING_PRICES_MOVED"], [404, "DROPSHIP_PRICING_REVIEW_NOT_FOUND"], [409, "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT"],
    [409, "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT"], [409, "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT"],
    [404, "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND"], [404, "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND"], [422, "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE"],
    [403, "DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED"], [422, "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID"], [422, "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE"],
    [422, "DROPSHIP_EBAY_CATEGORY_RULE_INVALID"], [422, "DROPSHIP_EBAY_STORE_CATEGORY_INVALID"],
  ] as const).map(([status, code]): Row => [status, code, { productVariantId: 101, sizes: [{ productVariantId: 101 }], sizeCount: 1, conflictCount: 1, conflicts: [{ productVariantId: 101 }] }, "refused", WORDS.invalid, NONE]),
];
const KEY_KEPT: ReadonlySet<WriteFailurePhase> = new Set(["uncertain", "unreachable", "rate_limited"]);

describe("every W8 code through the runner (plan 3.3, 9.5)", () => {
  it.each(W8_ROWS.map((entry) => [entry[0], entry[1] ?? "no code", entry] as const))("%i %s", async (_status, _code, entry) => {
    const [status, code, context, phase, words, marks] = entry;
    const run = setup();
    run.answers.push(apiError(status, code, context));
    await expect(run.save()).resolves.toEqual({
      kind: "failed",
      failure: { phase, message: words ?? "Server words.", code, status, fields: [] },
      refusal: { outsideLimit: new Set(marks.outsideLimit), conflicts: new Set(marks.conflicts) },
    });
    expect(run.drafts.current()).toMatchObject({ phase, changes: 2, message: words ?? "Server words." });
    expect(run.drafts.current().attempt?.key ?? null).toBe(KEY_KEPT.has(phase) ? "ls-size-prices:1" : null);
    // Only a block goes to the banner; a refusal never does (D8); nothing is read again or told to the step.
    expect(run.input.onBlocked).toHaveBeenCalledTimes(phase === "blocked" ? 1 : 0);
    expect(run.input.onSettingsSaved).not.toHaveBeenCalled();
    expect(run.input.reread).not.toHaveBeenCalled();
    expect(run.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
    // Plain words, but for a shipping outage's reference (3.3 row 6), as W12's table reads them.
    expect((words ?? "Server words.").replace(/ Reference: DROPSHIP_[A-Z_]+$/, "")).not.toMatch(/DROPSHIP_|[a-z]+_[a-z_]+/);
    // Whatever the answer, the typed sizes keep the revisions their rows were read with (CC-C5).
    expect(run.drafts.current().value).toEqual(TYPED);
  });

  it("a dropped connection is unconfirmed, with the same key", async () => {
    const run = setup();
    run.answers.push(networkDrop());
    await expect(run.save()).resolves.toEqual({ kind: "failed", failure: { phase: "uncertain", message: UNCONFIRMED, code: null, status: null, fields: [] }, refusal: NO_REFUSAL });
    expect(run.drafts.current()).toMatchObject({ phase: "uncertain", attempt: { key: "ls-size-prices:1" } });
  });
});
