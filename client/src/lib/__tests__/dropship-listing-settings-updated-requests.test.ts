import { describe, expect, it, vi } from "vitest";
import {
  acknowledgeCategoryMovesInputSchema,
  type AcknowledgeCategoryMovesInput,
  type AcknowledgeCategoryMovesResponse,
} from "@shared/dropship/listing-setting-writes";
import { DropshipApiError } from "../dropship-ops-surface";
import { listingSettingsQueryKey } from "../dropship-listing-settings";
import {
  LISTING_SETTINGS_SAVE_WORDS,
  UPDATED_PRODUCTS_EDITOR_ID,
  nextSaveAttempt,
  productEditorId,
  reduceListingSettingsDraft,
  type ListingSettingsDraft,
  type WriteFailurePhase,
} from "../dropship-listing-settings-drafts";
import { DRAWER_WORDS } from "../dropship-listing-settings-drawer";
import type { ProductSettingsSaveDrafts } from "../dropship-listing-settings-product-requests";
import {
  UPDATED_PRODUCTS_REQUEST_INVALID,
  gotItOutcomeWords,
  updatedProductsDraftValue,
  type UpdatedProductMoveItem,
} from "../dropship-listing-settings-updated";
import {
  categoryMovesAcknowledgeEndpoint,
  readAcknowledgedCategoryMoves,
  rereadAfterCategoryMoves,
  runCategoryMovesAcknowledge,
  type CategoryMovesAcknowledgeRun,
  type CategoryMovesQueryClient,
} from "../dropship-listing-settings-updated-requests";
import { LISTING_SETTINGS_EDIT_WORDS, LISTING_SETTINGS_UPDATED_WORDS } from "../dropship-listing-settings-words";

/** W13 from "Card Shellz updated products" (plan PR 10, 10.2, 10.4, 10.5, 3.3, 3.6). */

const STORE = 22;
const WORDS = LISTING_SETTINGS_EDIT_WORDS;
/** "Got it for all 3": the read's `moves.items`, as given. */
const ITEMS: UpdatedProductMoveItem[] = [{ productId: 12, shownCategoryId: 42 }, { productId: 11, shownCategoryId: 41 }, { productId: 13, shownCategoryId: null }];
const SENT: AcknowledgeCategoryMovesInput = { idempotencyKey: "ls-moves:1", items: ITEMS };
const ANSWER: AcknowledgeCategoryMovesResponse = { outcome: "acknowledged", acknowledgedProductIds: [11, 12], movedAgainProductIds: [13] };
const REPLAYED: AcknowledgeCategoryMovesResponse = { outcome: "replayed", acknowledgedProductIds: [], movedAgainProductIds: [] };

function gotItDraft(items: readonly UpdatedProductMoveItem[] = ITEMS): ListingSettingsDraft {
  const opened = reduceListingSettingsDraft(null, {
    type: "open", editor: UPDATED_PRODUCTS_EDITOR_ID, place: LISTING_SETTINGS_UPDATED_WORDS.title, base: updatedProductsDraftValue({ items }),
  });
  if (opened === null) throw new Error("expected a draft");
  return opened;
}

/** The provider's two save calls on the real reducer, minting keys `ls-moves:1`, `:2`… */
function reducerDrafts(start: ListingSettingsDraft) {
  let draft: ListingSettingsDraft | null = start;
  let keys = 0;
  const drafts: ProductSettingsSaveDrafts & { current: () => ListingSettingsDraft } = {
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
  };
  return drafts;
}

function setup(overrides: Partial<CategoryMovesAcknowledgeRun> = {}, start: ListingSettingsDraft = gotItDraft()) {
  const drafts = reducerDrafts(start);
  const sent: AcknowledgeCategoryMovesInput[] = [];
  const callbacks = { onSaveStarted: vi.fn(), onSaveSettled: vi.fn() };
  const answers: Array<unknown | Error> = [];
  const send = vi.fn(async (body: AcknowledgeCategoryMovesInput) => {
    sent.push(body);
    const next = answers.length > 0 ? answers.shift() : ANSWER;
    if (next instanceof Error) throw next;
    return next;
  });
  const input: CategoryMovesAcknowledgeRun = {
    storeConnectionId: STORE, draft: drafts.current(), drafts, callbacks, send,
    reread: vi.fn(async () => undefined),
    onSettingsSaved: vi.fn(), onBlocked: vi.fn(),
    ...overrides,
  };
  /** Got it, or Check again, on the draft as it is now. */
  const save = () => runCategoryMovesAcknowledge({ ...input, draft: drafts.current() });
  return { input, drafts, sent, callbacks, answers, send, save };
}

const apiError = (status: number, code: string | null, context?: Record<string, unknown>, message = "Server words.") =>
  new DropshipApiError({ status, code, message, context });

describe("the W13 request", () => {
  it("puts Got it under the store's listing settings", () => {
    expect(categoryMovesAcknowledgeEndpoint(STORE)).toBe("/api/dropship/listings/stores/22/listing-settings/category-moves/acknowledge");
  });

  it("checks an answer against its contract, for the products that were sent", () => {
    expect(readAcknowledgedCategoryMoves(ANSWER, ITEMS)).toEqual(ANSWER);
    expect(readAcknowledgedCategoryMoves(REPLAYED, ITEMS).outcome).toBe("replayed");
    // A product no longer in the catalog is in neither list.
    expect(readAcknowledgedCategoryMoves({ ...ANSWER, acknowledgedProductIds: [11], movedAgainProductIds: [] }, ITEMS).acknowledgedProductIds).toEqual([11]);
    for (const bad of [
      { ...ANSWER, extra: 1 }, { ...ANSWER, outcome: "replayed" }, { ...ANSWER, movedAgainProductIds: [11] }, { ...REPLAYED, acknowledgedProductIds: [11] },
      { outcome: "acknowledged" }, null, "ok",
    ]) {
      expect(() => readAcknowledgedCategoryMoves(bad, ITEMS)).toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_OFF_CONTRACT" }));
    }
    // A product the request did not send.
    expect(() => readAcknowledgedCategoryMoves({ ...ANSWER, movedAgainProductIds: [14] }, ITEMS))
      .toThrow(expect.objectContaining({ context: expect.objectContaining({ write: "W13", itemCount: 3, issues: [{ path: "productIds", code: "unsent_product" }] }) }));
  });

  it("reads every updated-products page, every Products page and the summary again after a Got it, cancelling reads in flight first (D9)", async () => {
    const calls: string[] = [];
    const client = {
      cancelQueries: vi.fn(async ({ queryKey }: { queryKey: readonly unknown[] }) => { calls.push(`cancel ${String(queryKey[3])}`); }),
      invalidateQueries: vi.fn(async ({ queryKey }: { queryKey: readonly unknown[] }) => { calls.push(`invalidate ${String(queryKey[3])}`); }),
    };
    const typed = client as unknown as CategoryMovesQueryClient;
    await rereadAfterCategoryMoves(typed, STORE);
    expect(calls).toEqual(["cancel updated-products", "cancel products", "cancel summary", "invalidate updated-products", "invalidate products", "invalidate summary"]);
    // Prefixes, not one page's key; and a failed refetch is a failed re-read.
    for (const read of ["updated-products", "products", "summary"]) {
      expect(client.cancelQueries).toHaveBeenCalledWith({ queryKey: [...listingSettingsQueryKey(STORE), read] });
      expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: [...listingSettingsQueryKey(STORE), read] }, { throwOnError: true });
    }
    client.invalidateQueries.mockRejectedValueOnce(new TypeError("offline"));
    await expect(rereadAfterCategoryMoves(typed, STORE)).rejects.toThrow("offline");
  });
});

describe("runCategoryMovesAcknowledge (plan 3.6)", () => {
  it("(1) sends one POST with the draft's ls-moves key and the read's items as given, hands the answer back, re-reads, then tells the step", async () => {
    const run = setup();
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false, answer: ANSWER });
    expect(run.sent).toEqual([SENT]);
    expect(acknowledgeCategoryMovesInputSchema.safeParse(run.sent[0]).success).toBe(true);
    expect(JSON.stringify(run.sent[0])).not.toMatch(/price|revision/i);
    expect(run.input.reread).toHaveBeenCalledTimes(1);
    expect(run.input.onSettingsSaved).toHaveBeenCalledTimes(1);
    expect(run.callbacks.onSaveStarted).toHaveBeenCalledTimes(1);
    expect(run.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
    expect(run.drafts.current()).toMatchObject({ phase: "saved", changes: 0, attempt: null });
    // What moved again comes from the answer (10.3, 10.6).
    expect(gotItOutcomeWords(ANSWER).movedAgain).toBe("1 product moved again. Check it below. It can take a minute to update.");
  });

  it("(1) Got it for one product sends that product with its shown category, null for no category", async () => {
    const one = setup({}, gotItDraft([{ productId: 13, shownCategoryId: null }]));
    one.answers.push({ outcome: "acknowledged", acknowledgedProductIds: [13], movedAgainProductIds: [] });
    await expect(one.save()).resolves.toMatchObject({ kind: "saved", answer: { acknowledgedProductIds: [13] } });
    expect(one.sent).toEqual([{ idempotencyKey: "ls-moves:1", items: [{ productId: 13, shownCategoryId: null }] }]);
  });

  it("(2) a dropped answer, then Check again, resends the same key and body", async () => {
    const run = setup();
    run.answers.push(new TypeError("Failed to fetch"), REPLAYED);
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "uncertain", message: "We couldn't confirm your save." } });
    expect(run.drafts.current()).toMatchObject({ phase: "uncertain", changes: 0 });
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false, answer: REPLAYED });
    expect(run.sent).toEqual([SENT, SENT]);
  });

  it("a replay names no product: the views are read again and only Done. is said (plan 10.4)", async () => {
    const run = setup();
    run.answers.push(REPLAYED);
    const outcome = await run.save();
    expect(outcome).toEqual({ kind: "saved", viewStale: false, answer: REPLAYED });
    expect(run.input.reread).toHaveBeenCalledTimes(1);
    expect(run.input.onSettingsSaved).toHaveBeenCalledTimes(1);
    expect(gotItOutcomeWords(outcome.kind === "saved" ? outcome.answer : null)).toEqual({ done: "Done.", movedAgain: null });
  });

  it("(3) a block goes to the banner and the draft is kept", async () => {
    const blocked = apiError(403, "DROPSHIP_LISTING_STORE_BLOCKED", { reason: "paused" });
    const run = setup();
    run.answers.push(blocked);
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "blocked", message: "Nothing was saved." } });
    expect(run.input.onBlocked).toHaveBeenCalledWith(blocked);
    expect(run.drafts.current()).toMatchObject({ phase: "blocked", editor: "updatedProducts", attempt: null });
    expect(run.input.onSettingsSaved).not.toHaveBeenCalled();
  });

  it("(4) a 429 keeps the key", async () => {
    const run = setup();
    run.answers.push(apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"));
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "rate_limited", message: LISTING_SETTINGS_SAVE_WORDS.rateLimited } });
    expect(run.drafts.current().attempt?.key).toBe("ls-moves:1");
    await run.save();
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-moves:1", "ls-moves:1"]);
  });

  it("(5) after a refusal the next try gets a new key", async () => {
    const run = setup();
    run.answers.push(apiError(409, "DROPSHIP_IDEMPOTENCY_CONFLICT"));
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", message: LISTING_SETTINGS_SAVE_WORDS.keyReused } });
    expect(run.input.onBlocked).not.toHaveBeenCalled();
    await run.save();
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-moves:1", "ls-moves:2"]);
  });

  it("(6) has no conflict of its own: a mark has no revision, so no 409 is a Load latest", async () => {
    for (const code of ["DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT", "DROPSHIP_LISTING_PRICES_MOVED"]) {
      const run = setup();
      run.answers.push(apiError(409, code, { conflictCount: 1 }));
      await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", message: WORDS.invalid, code } });
      expect(run.drafts.current()).toMatchObject({ phase: "refused", attempt: null });
    }
  });

  it("(7) still counts a Got it whose re-read failed, and says so", async () => {
    const run = setup({ reread: vi.fn(async () => { throw new TypeError("offline"); }) });
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: true, answer: ANSWER });
    expect(run.drafts.current()).toMatchObject({ phase: "saved_view_stale", message: "Saved. We couldn't load the latest view." });
    expect(run.input.onSettingsSaved).toHaveBeenCalledTimes(1);
  });

  it("(8) counts an off-contract 2xx as done with a stale view and no answer to show, and still reads the views again", async () => {
    for (const answer of [{ outcome: "acknowledged" }, { ...ANSWER, movedAgainProductIds: [14] }, { ...ANSWER, outcome: "replayed" }, "ok", null]) {
      const run = setup();
      run.answers.push(answer);
      await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: true, answer: null });
      expect(run.input.reread).toHaveBeenCalledTimes(1);
      expect(run.drafts.current().phase).toBe("saved_view_stale");
    }
  });

  it("(9) sends nothing with another editor's draft, no item, another action running, or a Got it out", async () => {
    const other = setup();
    await expect(runCategoryMovesAcknowledge({ ...other.input, draft: { ...gotItDraft(), editor: productEditorId(11) } })).resolves.toEqual({ kind: "not_started", message: null });
    await expect(runCategoryMovesAcknowledge({ ...other.input, draft: { ...gotItDraft(), value: { items: [] } } })).resolves.toEqual({ kind: "not_started", message: null });
    await expect(runCategoryMovesAcknowledge({ ...other.input, draft: { ...gotItDraft(), value: { policyId: "x" } } })).resolves.toEqual({ kind: "not_started", message: null });
    expect(other.callbacks.onSaveStarted).not.toHaveBeenCalled();

    const disabled = setup({ callbacks: { disabled: true, onSaveStarted: vi.fn(), onSaveSettled: vi.fn() } });
    await expect(disabled.save()).resolves.toEqual({ kind: "not_started", message: DRAWER_WORDS.busy });
    const refused = setup({ callbacks: { onSaveStarted: () => { throw new Error("Wait for the current listing action to finish."); }, onSaveSettled: vi.fn() } });
    await expect(refused.save()).resolves.toEqual({ kind: "not_started", message: "Wait for the current listing action to finish." });
    expect(refused.input.callbacks.onSaveSettled).not.toHaveBeenCalled();

    const saving = setup();
    saving.drafts.startSave("another request", "ls-moves");
    await expect(saving.save()).resolves.toEqual({ kind: "not_started", message: null });
    for (const run of [other, disabled, refused, saving]) expect(run.send).not.toHaveBeenCalled();
    expect(saving.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
  });

  it("(9) at the item limit it sends: 10,000 products in one Got it for all", async () => {
    const many = Array.from({ length: 10_000 }, (_, index) => ({ productId: index + 1, shownCategoryId: index % 2 === 0 ? 41 : null }));
    const run = setup({}, gotItDraft(many));
    run.answers.push({ outcome: "acknowledged", acknowledgedProductIds: many.map((item) => item.productId), movedAgainProductIds: [] });
    await expect(run.save()).resolves.toMatchObject({ kind: "saved", viewStale: false });
    expect(run.sent[0].items).toHaveLength(10_000);
    expect(run.sent[0].items).toEqual(many);
  });

  it("(9) settles a body it can't build as refused, sends nothing, and the next try gets a new key", async () => {
    const run = setup();
    let tries = 0;
    // The first key, "x:1", is one the shared schema refuses (under 8 characters): that body is never built.
    const drafts: ProductSettingsSaveDrafts = {
      startSave: (signature, prefix) => run.drafts.startSave(signature, tries++ === 0 ? "x" : prefix),
      settle: run.drafts.settle,
    };
    await expect(runCategoryMovesAcknowledge({ ...run.input, draft: run.drafts.current(), drafts })).resolves.toEqual({
      kind: "failed",
      failure: { phase: "refused", message: WORDS.cantBuild, code: UPDATED_PRODUCTS_REQUEST_INVALID, status: null, fields: [] },
    });
    expect(run.send).not.toHaveBeenCalled();
    expect(run.callbacks.onSaveStarted).toHaveBeenCalledTimes(1);
    expect(run.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
    expect(run.drafts.current()).toMatchObject({ phase: "refused", message: WORDS.cantBuild, attempt: null });
    expect(run.input.onBlocked).not.toHaveBeenCalled();
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false, answer: ANSWER });
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-moves:2"]);
  });

  it("(10) never sends twice while one Got it is in flight", async () => {
    const run = setup();
    let answer: (value: unknown) => void = () => undefined;
    run.send.mockImplementationOnce(async (body: AcknowledgeCategoryMovesInput) => {
      run.sent.push(body);
      return new Promise((resolve) => { answer = resolve; });
    });
    const first = run.save();
    await expect(run.save()).resolves.toEqual({ kind: "not_started", message: null });
    answer(ANSWER);
    await expect(first).resolves.toEqual({ kind: "saved", viewStale: false, answer: ANSWER });
    expect(run.send).toHaveBeenCalledTimes(1);
  });

  it("(11) tells the busy answers apart by their reason (D7a)", async () => {
    const cases: Array<[Record<string, unknown> | undefined, WriteFailurePhase, string]> = [
      [{ reason: "heavy_write_in_progress", retryAfterSeconds: 5 }, "unreachable", WORDS.busyHeavy],
      [{ reason: "request_key_changed", retryAfterSeconds: 5 }, "unreachable", WORDS.busyKeyChanged],
      [undefined, "uncertain", "We couldn't confirm your save."],
    ];
    for (const [context, phase, message] of cases) {
      const run = setup();
      run.answers.push(apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY", context));
      await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase, message } });
      expect(run.drafts.current().attempt?.key).toBe("ls-moves:1");
      // The same key next time: the gate refused before anything was written, or the replay answers it.
      await run.save();
      expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-moves:1", "ls-moves:1"]);
    }
  });

  it("(12) a Check again answered busy, by a gateway or by a rate limit stays unconfirmed (D7b)", async () => {
    const run = setup();
    run.answers.push(
      new TypeError("Failed to fetch"),
      apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "heavy_write_in_progress" }),
      apiError(502, "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE"),
      apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"),
      apiError(409, "DROPSHIP_IDEMPOTENCY_CONFLICT"),
    );
    await run.save();
    for (const message of [WORDS.stillUnconfirmed, WORDS.stillUnconfirmed, WORDS.stillUnconfirmedRateLimited]) {
      await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "uncertain", message } });
      expect(run.drafts.current()).toMatchObject({ phase: "uncertain", attempt: { key: "ls-moves:1" } });
      expect(run.drafts.current().message).not.toContain("Nothing was saved");
    }
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", message: LISTING_SETTINGS_SAVE_WORDS.keyReused } });
    expect(new Set(run.sent.map((body) => body.idempotencyKey))).toEqual(new Set(["ls-moves:1"]));
    expect(run.input.onBlocked).not.toHaveBeenCalled();
    const fresh = setup();
    fresh.answers.push(apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "heavy_write_in_progress" }));
    await expect(fresh.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "unreachable", message: WORDS.busyHeavy } });
  });

  it("(12) a Check again the write gate refuses stays unconfirmed with its key, and the banner still learns of it (D7b)", async () => {
    const gate: Array<[number, string, Record<string, unknown> | undefined]> = [
      [403, "DROPSHIP_LISTING_VENDOR_BLOCKED", { reason: "paused" }], [403, "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", { reason: "lapsed" }],
      [403, "DROPSHIP_LISTING_STORE_BLOCKED", { reason: "paused" }], [404, "DROPSHIP_STORE_CONNECTION_REQUIRED", undefined],
      [422, "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY", undefined],
    ];
    for (const [status, code, context] of gate) {
      const run = setup();
      const blocked = apiError(status, code, context);
      run.answers.push(new TypeError("Failed to fetch"), blocked);
      await run.save();
      await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "uncertain", message: UNCONFIRMED, code } });
      expect(run.drafts.current()).toMatchObject({ phase: "uncertain", attempt: { key: "ls-moves:1" } });
      expect(run.input.onBlocked).toHaveBeenCalledWith(blocked);
      await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false, answer: ANSWER });
      expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-moves:1", "ls-moves:1", "ls-moves:1"]);
    }
  });

  it("(13) the three fatal codes are final: refused, a new key next time, never Check again (D7c)", async () => {
    for (const code of ["DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE", "DROPSHIP_LISTING_PRICE_INVARIANT_FAILED"]) {
      const run = setup();
      run.answers.push(apiError(500, code, undefined, "Something went wrong. We couldn't confirm your save."));
      await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", message: WORDS.fatal, code } });
      expect(run.drafts.current()).toMatchObject({ phase: "refused", attempt: null });
      await run.save();
      expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-moves:1", "ls-moves:2"]);
    }
  });
});

/**
 * Every code the write routes answer, through the runner (plan 3.3 rows 1-23,
 * 10.5): [status, code, context, phase, words (null: the server's), fields].
 * W13 asks eBay nothing and writes no setting, so every eBay value refusal
 * and every other writer's refusal is "can't happen" (row 22): refused with
 * the plain words, never unconfirmed and never another writer's advice.
 */
const SHIPPING_OUTAGE = (code: string) => `Can't check Card Shellz shipping right now. Try again in a few minutes. Reference: ${code}`;
const SHIPPING_SETUP = (code: string) => `Card Shellz is finishing shipping setup for your store, so this can't be saved yet. Reference: ${code}`;
const EBAY_DOWN = "Can't reach eBay right now. Nothing was saved. Try again.";
const UNCONFIRMED = "We couldn't confirm your save.";
type Row = readonly [number, string | null, Record<string, unknown> | undefined, WriteFailurePhase, string | null, readonly string[]];

const W13_ROWS: readonly Row[] = [
  [429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED", undefined, "rate_limited", LISTING_SETTINGS_SAVE_WORDS.rateLimited, []],
  [401, "DROPSHIP_AUTH_REQUIRED", undefined, "refused", WORDS.signedOut, []],
  [503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "heavy_write_in_progress" }, "unreachable", WORDS.busyHeavy, []],
  [503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "request_key_changed" }, "unreachable", WORDS.busyKeyChanged, []],
  [503, "DROPSHIP_LISTING_SETTINGS_BUSY", undefined, "uncertain", UNCONFIRMED, []],
  // 5xx the shared write routes can answer (never for W13 in practice): before any write, so nothing was saved.
  [503, "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE", { retryable: true }, "unreachable", SHIPPING_OUTAGE("DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE"), []],
  [502, "DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_UNAVAILABLE", { retryable: true }, "unreachable", SHIPPING_OUTAGE("DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_UNAVAILABLE"), []],
  ...[
    "DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE", "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE", "DROPSHIP_EBAY_STORE_CATEGORIES_INVALID_RESPONSE",
  ].map((code): Row => [502, code, undefined, "unreachable", EBAY_DOWN, []]),
  ...[
    "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", "DROPSHIP_EBAY_REFRESH_LOCK_UNAVAILABLE", "DROPSHIP_CREDENTIAL_CHANGED",
    "DROPSHIP_EBAY_TOKEN_REFRESH_INVALID_RESPONSE", "DROPSHIP_EBAY_OAUTH_NOT_CONFIGURED",
  ].map((code): Row => [503, code, undefined, "unreachable", EBAY_DOWN, []]),
  [502, null, undefined, "uncertain", UNCONFIRMED, []],
  [503, null, undefined, "uncertain", UNCONFIRMED, []],
  [504, null, undefined, "uncertain", UNCONFIRMED, []],
  [500, "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", undefined, "refused", WORDS.fatal, []],
  [500, "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE", undefined, "refused", WORDS.fatal, []],
  [500, "DROPSHIP_LISTING_PRICE_INVARIANT_FAILED", undefined, "refused", WORDS.fatal, []],
  [500, "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", undefined, "uncertain", UNCONFIRMED, []],
  [409, "DROPSHIP_IDEMPOTENCY_CONFLICT", undefined, "refused", "Something changed since you last tried. Save again.", []],
  // Card Shellz shipping checks (W2's 409s): the route's codes, worded as W5 and W6 word them.
  ...["SERVICES_REQUIRED", "ROUTING_REQUIRED", "NO_RATE_BOOK"]
    .map((suffix): Row => [409, `DROPSHIP_EBAY_FULFILLMENT_${suffix}`, undefined, "refused", SHIPPING_SETUP(`DROPSHIP_EBAY_FULFILLMENT_${suffix}`), ["shippingPolicy"]]),
  [409, "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED", undefined, "blocked", "Nothing was saved.", []],
  [422, "DROPSHIP_EBAY_CATEGORY_MARKETPLACE_UNSUPPORTED", undefined, "blocked", "Nothing was saved.", []],
  [413, "DROPSHIP_REQUEST_TOO_LARGE", undefined, "refused", WORDS.tooBig, []],
  [400, "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT", { issues: [{ path: "items", code: "custom" }] }, "refused", WORDS.invalid, []],
  [400, "DROPSHIP_LISTING_SETTINGS_BULK_INVALID", undefined, "refused", WORDS.invalid, []],
  [400, "DROPSHIP_REQUEST_JSON_INVALID", undefined, "refused", WORDS.invalid, []],
  // The write gate (3.3 row 16): the banner, after the step reads the account, summary and setup again.
  [403, "DROPSHIP_LISTING_VENDOR_BLOCKED", { reason: "paused" }, "blocked", "Nothing was saved.", []],
  [403, "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", { reason: "lapsed" }, "blocked", "Nothing was saved.", []],
  [403, "DROPSHIP_LISTING_STORE_BLOCKED", { reason: "paused" }, "blocked", "Nothing was saved.", []],
  [404, "DROPSHIP_STORE_CONNECTION_REQUIRED", undefined, "blocked", "Nothing was saved.", []],
  [409, "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED", undefined, "blocked", "Nothing was saved.", []],
  [409, "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_TOKEN_REQUIRED", undefined, "blocked", "Nothing was saved.", []],
  [422, "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY", undefined, "blocked", "Nothing was saved.", []],
  ...[
    "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED", "DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED", "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED",
    "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED", "DROPSHIP_EBAY_STORE_CATEGORIES_ACCESS_DENIED", "DROPSHIP_EBAY_CATEGORIES_ACCESS_DENIED",
  ].map((code): Row => [403, code, undefined, "blocked", "Nothing was saved.", []]),
  // The store text cap (row 21) keeps its words; a TOO_LARGE with no reason keeps the server's.
  [422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", { reason: "store_text_limit", textBytes: 30_000_100, maxTextBytes: 30_000_000 }, "refused", WORDS.storeTextLimit, []],
  [422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", undefined, "refused", null, []],
  // Codes this page's W13 can't get (row 22): refused with the plain words, never unconfirmed, never a Load latest and
  // never a sign-in banner or "pick another policy" (W13 names no eBay value); the fields a refusal names are still named.
  ...[
    [422, "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST"], [422, "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT"], [422, "DROPSHIP_PRICING_RULES_NOT_CONFIGURED"],
    [422, "DROPSHIP_LISTING_PRICE_RELEASE_LIMIT"], [409, "DROPSHIP_LISTING_PRICES_MOVED"], [409, "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT"],
    [404, "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE"], [409, "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT"],
    [409, "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT"], [409, "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT"],
    [422, "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE"], [404, "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND"],
    [404, "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND"], [404, "DROPSHIP_PRICING_REVIEW_NOT_FOUND"],
    [422, "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID"], [422, "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE"],
    [422, "DROPSHIP_EBAY_CATEGORY_RULE_INVALID"], [422, "DROPSHIP_EBAY_STORE_CATEGORY_INVALID"],
  ].map(([status, code]): Row => [status as number, code as string, undefined, "refused", WORDS.invalid, []]),
  [403, "DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED", { fields: ["ebayCategory"] }, "refused", WORDS.invalid, ["ebayCategory"]],
  [422, "DROPSHIP_EBAY_CATEGORY_RULE_INVALID", { reason: "not_leaf", invalidFields: ["ebayCategory"] }, "refused", WORDS.invalid, ["ebayCategory"]],
  [418, null, undefined, "refused", null, []],
  [422, "DROPSHIP_SOMETHING_NEW", undefined, "refused", null, []],
];

const KEY_KEPT: ReadonlySet<WriteFailurePhase> = new Set(["uncertain", "unreachable", "rate_limited"]);

describe("W13's answers, code by code, through the runner (plan 3.3, 10.5)", () => {
  it.each(W13_ROWS.map((row) => [row[0], row[1] ?? "no code", row] as const))("%i %s", async (_status, _code, row) => {
    const [status, code, context, phase, words, fields] = row;
    const error = apiError(status, code, context);
    const run = setup();
    run.answers.push(error);
    const outcome = await run.save();
    expect(outcome).toEqual({ kind: "failed", failure: { phase, message: words ?? "Server words.", code, status, fields } });
    expect(run.drafts.current()).toMatchObject({ phase, changes: 0, message: words ?? "Server words." });
    expect(run.drafts.current().attempt?.key ?? null).toBe(KEY_KEPT.has(phase) ? "ls-moves:1" : null);
    // Only a block goes to the banner; a refusal never does (D8). A mark has no revision: nothing is a conflict.
    expect(run.input.onBlocked).toHaveBeenCalledTimes(phase === "blocked" ? 1 : 0);
    expect(run.input.onSettingsSaved).not.toHaveBeenCalled();
    expect(phase).not.toBe("conflict");
    const spoken = (words ?? "Server words.").replace(/ Reference: DROPSHIP_[A-Z_]+$/, "");
    expect(spoken).not.toMatch(/DROPSHIP_|[a-z]+_[a-z_]+/);
  });

  it("a dropped connection is unconfirmed, with the same key", async () => {
    const run = setup();
    run.answers.push(new TypeError("Failed to fetch"));
    await expect(run.save()).resolves.toEqual({
      kind: "failed", failure: { phase: "uncertain", message: UNCONFIRMED, code: null, status: null, fields: [] },
    });
    expect(run.drafts.current().attempt?.key).toBe("ls-moves:1");
  });
});
