import { describe, expect, it, vi } from "vitest";
import { saveProductsBulkInputSchema } from "@shared/dropship/listing-setting-writes";
import { listingSettingsProductIdsResponseSchema } from "@shared/dropship/listing-settings";
import { DropshipApiError } from "../dropship-ops-surface";
import { listingSettingsQueryKey } from "../dropship-listing-settings";
import {
  BULK_EDITOR_ID,
  LISTING_SETTINGS_SAVE_WORDS,
  nextSaveAttempt,
  productEditorId,
  reduceListingSettingsDraft,
  type ListingSettingsDraft,
  type WriteFailurePhase,
} from "../dropship-listing-settings-drafts";
import { DRAWER_WORDS } from "../dropship-listing-settings-drawer";
import {
  BULK_REQUEST_INVALID,
  bulkDraftValue,
  emptyBulkChoices,
  readBulkDraft,
  type BulkChoices,
  type BulkSaveBody,
} from "../dropship-listing-settings-bulk";
import {
  loadLatestBulk,
  productsBulkEndpoint,
  readSavedProductsBulk,
  rereadAfterBulkSave,
  runProductsBulkSave,
  type BulkSaveQueryClient,
  type ProductsBulkSaveRun,
} from "../dropship-listing-settings-bulk-requests";
import type { ProductSettingsSaveDrafts } from "../dropship-listing-settings-product-requests";
import { emptySelection, reduceListingSettingsSelection } from "../dropship-listing-settings-selection";
import { LISTING_SETTINGS_BULK_WORDS, LISTING_SETTINGS_EDIT_WORDS } from "../dropship-listing-settings-words";

/** W6 from the "Set for selected" sheet (plan PR 10, 6.4, 6.5, 3.3, 3.6). */

const STORE = 22;
const WORDS = LISTING_SETTINGS_EDIT_WORDS;
const PRODUCTS = [{ productId: 12, expectedRevisionId: null }, { productId: 11, expectedRevisionId: 5 }];
const PICK: Partial<BulkChoices> = { shippingPolicy: { mode: "set", value: { id: "F1" } }, mainText: { mode: "default" } };
const SENT: BulkSaveBody = {
  idempotencyKey: "ls-bulk:1",
  products: [{ productId: 11, expectedRevisionId: 5 }, { productId: 12, expectedRevisionId: null }],
  patch: { shippingPolicy: { id: "F1" }, mainText: null },
};
const ANSWER = { outcome: "changed", requestId: 9, productCount: 2, changedProductCount: 2, clearedSizeCount: 0 };
const REPLAYED = { outcome: "replayed", requestId: 9, productCount: 2, changedProductCount: null, clearedSizeCount: null };

function bulkDraft(choices: Partial<BulkChoices> = PICK, products = PRODUCTS): ListingSettingsDraft {
  const opened = reduceListingSettingsDraft(null, { type: "open", editor: BULK_EDITOR_ID, place: "Set for selected", base: bulkDraftValue(products) });
  return reduceListingSettingsDraft(opened, { type: "edit", value: bulkDraftValue(products, { ...emptyBulkChoices(), ...choices }) })!;
}

/** The provider's two save calls on the real reducer, minting keys `ls-bulk:1`, `:2`… */
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

function setup(overrides: Partial<ProductsBulkSaveRun> = {}, start: ListingSettingsDraft = bulkDraft()) {
  const drafts = reducerDrafts(start);
  const sent: BulkSaveBody[] = [];
  const callbacks = { onSaveStarted: vi.fn(), onSaveSettled: vi.fn() };
  const answers: Array<unknown | Error> = [];
  const send = vi.fn(async (body: BulkSaveBody) => {
    sent.push(body);
    const next = answers.length > 0 ? answers.shift() : ANSWER;
    if (next instanceof Error) throw next;
    return next;
  });
  const input: ProductsBulkSaveRun = {
    storeConnectionId: STORE, draft: drafts.current(), drafts, callbacks, send,
    reread: vi.fn(async () => undefined),
    onSettingsSaved: vi.fn(), onBlocked: vi.fn(),
    ...overrides,
  };
  /** Save, or Check again, on the draft as it is now. */
  const save = () => runProductsBulkSave({ ...input, draft: drafts.current() });
  return { input, drafts, sent, callbacks, answers, send, save };
}

const apiError = (status: number, code: string | null, context?: Record<string, unknown>, message = "Server words.") =>
  new DropshipApiError({ status, code, message, context });

describe("the W6 request", () => {
  it("puts Set for selected under the store's listing settings", () => {
    expect(productsBulkEndpoint(STORE)).toBe("/api/dropship/listings/stores/22/listing-settings/products/bulk");
  });

  it("checks an answer against its contract, for as many products as were sent", () => {
    expect(readSavedProductsBulk(ANSWER, 2)).toEqual(ANSWER);
    expect(readSavedProductsBulk(REPLAYED, 2).outcome).toBe("replayed");
    expect(readSavedProductsBulk({ ...ANSWER, outcome: "unchanged", changedProductCount: 0 }, 2).outcome).toBe("unchanged");
    for (const bad of [{ ...ANSWER, extra: 1 }, { ...ANSWER, outcome: "replayed" }, { ...ANSWER, changedProductCount: 3 }, { ...ANSWER, outcome: "unchanged" }, null]) {
      expect(() => readSavedProductsBulk(bad, 2)).toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_OFF_CONTRACT" }));
    }
    expect(() => readSavedProductsBulk(ANSWER, 3))
      .toThrow(expect.objectContaining({ context: expect.objectContaining({ write: "W6", issues: [{ path: "productCount", code: "other_count" }] }) }));
  });

  it("reads every Products page and the ids read again after a save, cancelling reads in flight first (D9)", async () => {
    const calls: string[] = [];
    const client = {
      cancelQueries: vi.fn(async ({ queryKey }: { queryKey: readonly unknown[] }) => { calls.push(`cancel ${String(queryKey[3])}`); }),
      invalidateQueries: vi.fn(async ({ queryKey }: { queryKey: readonly unknown[] }) => { calls.push(`invalidate ${String(queryKey[3])}`); }),
      fetchQuery: vi.fn(async ({ queryKey }: { queryKey: readonly unknown[] }) => { calls.push(`fetch ${String(queryKey[3])}`); return { total: 0, rows: [] }; }),
    };
    const typed = client as unknown as BulkSaveQueryClient;
    await rereadAfterBulkSave(typed, STORE, { search: "sleeve", show: "all" });
    expect(calls).toEqual(["cancel products", "cancel product-ids", "invalidate products", "fetch product-ids"]);
    expect(client.cancelQueries).toHaveBeenCalledWith({ queryKey: [...listingSettingsQueryKey(STORE), "products"] });
    // Every page: a prefix, not one page's key; and a failed refetch is a failed re-read.
    expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: [...listingSettingsQueryKey(STORE), "products"] }, { throwOnError: true });
    // gcTime 0, as the sheet's own read: without it query-core keeps the answer 5 minutes, and the next opening would
    // start on it instead of a read of its own (D6).
    expect(client.fetchQuery).toHaveBeenCalledWith(expect.objectContaining({
      queryKey: [...listingSettingsQueryKey(STORE), "product-ids", { search: "sleeve", show: "all" }], staleTime: 0, gcTime: 0, retry: false,
    }));
    // No ids read without a selection.
    client.fetchQuery.mockClear();
    await rereadAfterBulkSave(typed, STORE, null);
    expect(client.fetchQuery).not.toHaveBeenCalled();
    client.invalidateQueries.mockRejectedValueOnce(new TypeError("offline"));
    await expect(rereadAfterBulkSave(typed, STORE, null)).rejects.toThrow("offline");
    client.fetchQuery.mockRejectedValueOnce(new TypeError("offline"));
    await expect(rereadAfterBulkSave(typed, STORE, { search: "", show: "all" })).rejects.toThrow("offline");
  });

  it("Load latest reads the selection's ids again and keeps the vendor's choices on the revisions read now (plan 6.5)", async () => {
    const ticks = reduceListingSettingsSelection(emptySelection(STORE), { type: "togglePage", productIds: [11, 12, 13] });
    let answer = listingSettingsProductIdsResponseSchema.parse({ total: 2, rows: [{ productId: 11, revisionId: 6 }, { productId: 12, revisionId: 1 }] });
    const client = {
      cancelQueries: vi.fn(async () => undefined),
      fetchQuery: vi.fn(async () => answer),
    };
    const mine = readBulkDraft(bulkDraft().value)!;
    const reload = await loadLatestBulk(client as never, STORE, ticks, mine);
    expect(client.cancelQueries).toHaveBeenCalledWith({ queryKey: [...listingSettingsQueryKey(STORE), "product-ids", { search: "", show: "all" }], exact: true });
    expect(client.fetchQuery).toHaveBeenCalledWith(expect.objectContaining({ staleTime: 0, gcTime: 0, retry: false }));
    expect(reload).toMatchObject({
      kind: "rebase",
      edited: { shippingPolicy: { mode: "set", value: { id: "F1" } }, mainText: { mode: "default" }, products: [{ productId: 11, expectedRevisionId: 6 }, { productId: 12, expectedRevisionId: 1 }] },
      latest: { shippingPolicy: { mode: "leave" } },
      picked: { missing: 1, total: 2 },
    });
    // [Discard] after a 409: no choices, so a fresh start on the products read now.
    await expect(loadLatestBulk(client as never, STORE, ticks, bulkDraftValue(mine.products))).resolves.toMatchObject({
      kind: "restart", base: { shippingPolicy: { mode: "leave" }, products: [{ productId: 11, expectedRevisionId: 6 }, { productId: 12, expectedRevisionId: 1 }] },
    });
    answer = listingSettingsProductIdsResponseSchema.parse({ total: 0, rows: [] });
    await expect(loadLatestBulk(client as never, STORE, ticks, mine)).resolves.toMatchObject({ kind: "none_left", picked: { total: 0, missing: 3 } });
    await expect(loadLatestBulk(client as never, STORE, emptySelection(STORE), mine)).resolves.toMatchObject({ kind: "none_left" });
    client.fetchQuery.mockRejectedValueOnce(new TypeError("offline"));
    await expect(loadLatestBulk(client as never, STORE, ticks, mine)).rejects.toThrow("offline");
  });
});

describe("runProductsBulkSave (plan 3.6)", () => {
  it("(1) sends one POST with the draft's ls-bulk key, the ids read's revisions and no price, re-reads, then tells the step", async () => {
    const run = setup();
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false, productCount: 2 });
    expect(run.sent).toEqual([SENT]);
    expect(saveProductsBulkInputSchema.safeParse(run.sent[0]).success).toBe(true);
    expect(JSON.stringify(run.sent[0])).not.toMatch(/price/i);
    expect(run.input.reread).toHaveBeenCalledTimes(1);
    expect(run.input.onSettingsSaved).toHaveBeenCalledTimes(1);
    expect(run.callbacks.onSaveStarted).toHaveBeenCalledTimes(1);
    expect(run.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
    expect(run.drafts.current()).toMatchObject({ phase: "saved", changes: 0, attempt: null });
  });

  it("(2) a dropped answer, then Check again, resends the same key and body", async () => {
    const run = setup();
    run.answers.push(new TypeError("Failed to fetch"), REPLAYED);
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "uncertain", message: "We couldn't confirm your save." } });
    expect(run.drafts.current()).toMatchObject({ phase: "uncertain", changes: 2 });
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false, productCount: 2 });
    expect(run.sent).toEqual([SENT, SENT]);
  });

  it("(3) a block goes to the banner and the draft is kept", async () => {
    const blocked = apiError(403, "DROPSHIP_LISTING_STORE_BLOCKED", { reason: "paused" });
    const run = setup();
    run.answers.push(blocked);
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "blocked", message: "Nothing was saved." } });
    expect(run.input.onBlocked).toHaveBeenCalledWith(blocked);
    expect(run.drafts.current()).toMatchObject({ phase: "blocked", changes: 2, attempt: null });
    expect(run.input.onSettingsSaved).not.toHaveBeenCalled();
  });

  it("(4) a 429 keeps the key", async () => {
    const run = setup();
    run.answers.push(apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"));
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "rate_limited", message: LISTING_SETTINGS_SAVE_WORDS.rateLimited } });
    expect(run.drafts.current().attempt?.key).toBe("ls-bulk:1");
    await run.save();
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-bulk:1", "ls-bulk:1"]);
  });

  it("(5) after a refusal the next try gets a new key", async () => {
    const run = setup();
    run.answers.push(apiError(422, "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID", { invalidFields: ["shippingPolicy"] }));
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", fields: ["shippingPolicy"] } });
    expect(run.input.onBlocked).not.toHaveBeenCalled();
    await run.save();
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-bulk:1", "ls-bulk:2"]);
  });

  it("(6) calls a conflict a conflict, counted as the server counts it", async () => {
    const run = setup();
    run.answers.push(apiError(409, "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", {
      conflicts: [{ productId: 11, expectedRevisionId: 5, actualRevisionId: 6 }], conflictCount: 3,
    }));
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "conflict", message: "3 of the selected products changed in another window." } });
    expect(run.drafts.current()).toMatchObject({ phase: "conflict", attempt: null, changes: 2 });
  });

  it("(7) still counts a save whose re-read failed, and says so", async () => {
    const run = setup({ reread: vi.fn(async () => { throw new TypeError("offline"); }) });
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: true, productCount: 2 });
    expect(run.drafts.current()).toMatchObject({ phase: "saved_view_stale", message: "Saved. We couldn't load the latest view." });
    expect(run.input.onSettingsSaved).toHaveBeenCalledTimes(1);
  });

  it("(8) counts an off-contract 2xx as saved with a stale view, and still reads the views again", async () => {
    for (const answer of [{ requestId: 9 }, { ...ANSWER, productCount: 3 }, "ok"]) {
      const run = setup();
      run.answers.push(answer);
      await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: true, productCount: 2 });
      expect(run.input.reread).toHaveBeenCalledTimes(1);
      expect(run.drafts.current().phase).toBe("saved_view_stale");
    }
  });

  it("(9) sends nothing with no change, another product's draft, no product, too much text, another action running, or a save out", async () => {
    const unchanged = setup();
    await expect(runProductsBulkSave({ ...unchanged.input, draft: bulkDraft({}) })).resolves.toEqual({ kind: "not_started", message: null });
    await expect(runProductsBulkSave({ ...unchanged.input, draft: { ...bulkDraft(), editor: productEditorId(11) } }))
      .resolves.toEqual({ kind: "not_started", message: null });
    await expect(runProductsBulkSave({ ...unchanged.input, draft: bulkDraft(PICK, []) }))
      .resolves.toEqual({ kind: "not_started", message: LISTING_SETTINGS_BULK_WORDS.noneChosen });
    // The server's own text pre-check would refuse it: 3,751 products x 8,000 bytes (S/application/dropship-listing-products-bulk-service.ts).
    const many = Array.from({ length: 3_751 }, (_, index) => ({ productId: index + 1, expectedRevisionId: null }));
    const heavy = bulkDraft({ textAbove: { mode: "set", value: { mode: "own", text: "é".repeat(4_000) } } }, many);
    await expect(runProductsBulkSave({ ...unchanged.input, draft: heavy })).resolves.toEqual({ kind: "not_started", message: LISTING_SETTINGS_BULK_WORDS.tooMuchText });
    expect(unchanged.callbacks.onSaveStarted).not.toHaveBeenCalled();

    const disabled = setup({ callbacks: { disabled: true, onSaveStarted: vi.fn(), onSaveSettled: vi.fn() } });
    await expect(disabled.save()).resolves.toEqual({ kind: "not_started", message: DRAWER_WORDS.busy });
    const refused = setup({ callbacks: { onSaveStarted: () => { throw new Error("Wait for the current listing action to finish."); }, onSaveSettled: vi.fn() } });
    await expect(refused.save()).resolves.toEqual({ kind: "not_started", message: "Wait for the current listing action to finish." });
    expect(refused.input.callbacks.onSaveSettled).not.toHaveBeenCalled();

    const saving = setup();
    saving.drafts.startSave("another request", "ls-bulk");
    await expect(saving.save()).resolves.toEqual({ kind: "not_started", message: null });
    for (const run of [unchanged, disabled, refused, saving]) expect(run.send).not.toHaveBeenCalled();
    expect(saving.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
  });

  it("(9) at the text budget it sends: 3,750 products x 8,000 bytes", async () => {
    const many = Array.from({ length: 3_750 }, (_, index) => ({ productId: index + 1, expectedRevisionId: null }));
    const run = setup({}, bulkDraft({ textAbove: { mode: "set", value: { mode: "own", text: "é".repeat(4_000) } } }, many));
    run.answers.push({ ...ANSWER, productCount: 3_750, changedProductCount: 3_750 });
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false, productCount: 3_750 });
    expect(run.sent[0].products).toHaveLength(3_750);
  });

  it("(9) settles a body it can't build as refused, sends nothing, and the next try gets a new key", async () => {
    const run = setup();
    let tries = 0;
    // The first key, "x:1", is one the shared schema refuses (under 8 characters): that body is never built.
    const drafts: ProductSettingsSaveDrafts = {
      startSave: (signature, prefix) => run.drafts.startSave(signature, tries++ === 0 ? "x" : prefix),
      settle: run.drafts.settle,
    };
    await expect(runProductsBulkSave({ ...run.input, draft: run.drafts.current(), drafts })).resolves.toEqual({
      kind: "failed",
      failure: { phase: "refused", message: WORDS.cantBuild, code: BULK_REQUEST_INVALID, status: null, fields: [] },
    });
    expect(run.send).not.toHaveBeenCalled();
    expect(run.callbacks.onSaveStarted).toHaveBeenCalledTimes(1);
    expect(run.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
    expect(run.drafts.current()).toMatchObject({ phase: "refused", message: WORDS.cantBuild, attempt: null, changes: 2 });
    expect(run.input.onBlocked).not.toHaveBeenCalled();
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false, productCount: 2 });
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-bulk:2"]);
  });

  it("(10) never sends twice while one save is in flight", async () => {
    const run = setup();
    let answer: (value: unknown) => void = () => undefined;
    run.send.mockImplementationOnce(async (body: BulkSaveBody) => {
      run.sent.push(body);
      return new Promise((resolve) => { answer = resolve; });
    });
    const first = run.save();
    await expect(run.save()).resolves.toEqual({ kind: "not_started", message: null });
    answer(ANSWER);
    await expect(first).resolves.toEqual({ kind: "saved", viewStale: false, productCount: 2 });
    expect(run.send).toHaveBeenCalledTimes(1);
  });

  it("(11) tells the busy answers apart by their reason (D7a): W6 is a heavy write", async () => {
    const cases: Array<[Record<string, unknown> | undefined, WriteFailurePhase, string]> = [
      [{ reason: "heavy_write_in_progress", retryAfterSeconds: 5 }, "unreachable", WORDS.busyHeavy],
      [{ reason: "request_key_changed", retryAfterSeconds: 5 }, "unreachable", WORDS.busyKeyChanged],
      [undefined, "uncertain", "We couldn't confirm your save."],
    ];
    for (const [context, phase, message] of cases) {
      const run = setup();
      run.answers.push(apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY", context));
      await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase, message } });
      expect(run.drafts.current().attempt?.key).toBe("ls-bulk:1");
      // The same key next time: the gate refused before anything was written, or the replay answers it.
      await run.save();
      expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-bulk:1", "ls-bulk:1"]);
    }
  });

  it("(12) a Check again answered busy, by eBay or by a rate limit stays unconfirmed (D7b)", async () => {
    const run = setup();
    run.answers.push(
      new TypeError("Failed to fetch"),
      apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "heavy_write_in_progress" }),
      apiError(502, "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE"),
      apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"),
      apiError(409, "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", { conflictCount: 1 }),
    );
    await run.save();
    for (const message of [WORDS.stillUnconfirmed, WORDS.stillUnconfirmed, WORDS.stillUnconfirmedRateLimited]) {
      await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "uncertain", message } });
      expect(run.drafts.current()).toMatchObject({ phase: "uncertain", attempt: { key: "ls-bulk:1" } });
      expect(run.drafts.current().message).not.toContain("Nothing was saved");
    }
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "conflict", message: "1 of the selected products changed in another window." } });
    expect(new Set(run.sent.map((body) => body.idempotencyKey))).toEqual(new Set(["ls-bulk:1"]));
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
      expect(run.drafts.current()).toMatchObject({ phase: "uncertain", attempt: { key: "ls-bulk:1" } });
      expect(run.input.onBlocked).toHaveBeenCalledWith(blocked);
      await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false, productCount: 2 });
      expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-bulk:1", "ls-bulk:1", "ls-bulk:1"]);
    }
    // eBay's sign-in is asked only for a key not used yet, so it shows nothing was saved: it stands.
    const signIn = setup();
    signIn.answers.push(new TypeError("Failed to fetch"), apiError(403, "DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED", { fields: ["shippingPolicy"] }));
    await signIn.save();
    await expect(signIn.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "blocked", message: "Nothing was saved." } });
    expect(signIn.drafts.current().attempt).toBeNull();
  });

  it("(13) the three fatal codes are final: refused, a new key next time, never Check again (D7c)", async () => {
    for (const code of ["DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE", "DROPSHIP_LISTING_PRICE_INVARIANT_FAILED"]) {
      const run = setup();
      run.answers.push(apiError(500, code, undefined, "Something went wrong. We couldn't confirm your save."));
      await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", message: WORDS.fatal, code } });
      expect(run.drafts.current()).toMatchObject({ phase: "refused", attempt: null, changes: 2 });
      await run.save();
      expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-bulk:1", "ls-bulk:2"]);
    }
  });
});

/**
 * Every code W6's route answers, through the runner (plan 3.3 rows 1-23, 6.5):
 * [status, code, context, phase, words (null: the server's), fields].
 */
const SHIPPING_SETUP = (code: string) => `Card Shellz is finishing shipping setup for your store, so this can't be saved yet. Reference: ${code}`;
const SHIPPING_OUTAGE = (code: string) => `Can't check Card Shellz shipping right now. Try again in a few minutes. Reference: ${code}`;
const EBAY_DOWN = "Can't reach eBay right now. Nothing was saved. Try again.";
const UNCONFIRMED = "We couldn't confirm your save.";
type Row = readonly [number, string | null, Record<string, unknown> | undefined, WriteFailurePhase, string | null, readonly string[]];

const W6_ROWS: readonly Row[] = [
  [429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED", undefined, "rate_limited", LISTING_SETTINGS_SAVE_WORDS.rateLimited, []],
  [401, "DROPSHIP_AUTH_REQUIRED", undefined, "refused", WORDS.signedOut, []],
  [503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "heavy_write_in_progress" }, "unreachable", WORDS.busyHeavy, []],
  [503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "request_key_changed" }, "unreachable", WORDS.busyKeyChanged, []],
  [503, "DROPSHIP_LISTING_SETTINGS_BUSY", undefined, "uncertain", UNCONFIRMED, []],
  [503, "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE", { retryable: true }, "unreachable", SHIPPING_OUTAGE("DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE"), []],
  [502, "DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_UNAVAILABLE", { retryable: true }, "unreachable", SHIPPING_OUTAGE("DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_UNAVAILABLE"), []],
  ...[
    "DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE", "DROPSHIP_EBAY_CATEGORIES_INVALID_RESPONSE", "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE",
    "DROPSHIP_EBAY_LISTING_SETUP_INVALID_RESPONSE", "DROPSHIP_EBAY_MANAGED_LOCATION_UNAVAILABLE", "DROPSHIP_EBAY_MANAGED_LOCATION_INVALID_RESPONSE",
    "DROPSHIP_EBAY_MANAGED_LOCATION_CREATE_CONFLICT", "DROPSHIP_EBAY_STORE_CATEGORIES_UNAVAILABLE", "DROPSHIP_EBAY_STORE_CATEGORIES_INVALID_RESPONSE",
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
  // Plan 6.5: the conflict, counted by the server.
  [409, "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", { conflictCount: 3, conflicts: [{ productId: 11, expectedRevisionId: 5, actualRevisionId: 6 }] },
    "conflict", "3 of the selected products changed in another window.", []],
  [409, "DROPSHIP_IDEMPOTENCY_CONFLICT", undefined, "refused", "Something changed since you last tried. Save again.", []],
  ...[
    "SERVICES_REQUIRED", "ROUTING_REQUIRED", "ROUTING_MISMATCH", "WAREHOUSE_REQUIRED", "SLA_REQUIRED", "RATE_TABLE_REQUIRED",
    "DESTINATION_COVERAGE_REQUIRED", "NO_RATE_BOOK", "AMBIGUOUS_RATE_BOOK",
  ].map((suffix): Row => [409, `DROPSHIP_EBAY_FULFILLMENT_${suffix}`, undefined, "refused", SHIPPING_SETUP(`DROPSHIP_EBAY_FULFILLMENT_${suffix}`), ["shippingPolicy"]]),
  [409, "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED", undefined, "blocked", "Nothing was saved.", []],
  [422, "DROPSHIP_EBAY_CATEGORY_MARKETPLACE_UNSUPPORTED", undefined, "blocked", "Nothing was saved.", []],
  [413, "DROPSHIP_REQUEST_TOO_LARGE", undefined, "refused", WORDS.tooBig, []],
  [400, "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT", { issues: [{ path: "patch", code: "custom" }] }, "refused", WORDS.invalid, []],
  [400, "DROPSHIP_LISTING_SETTINGS_BULK_INVALID", undefined, "refused", WORDS.invalid, []],
  [400, "DROPSHIP_REQUEST_JSON_INVALID", undefined, "refused", WORDS.invalid, []],
  [403, "DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED", { fields: ["shippingPolicy"] }, "blocked", "Nothing was saved.", ["shippingPolicy"]],
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
  [422, "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID", { invalidFields: ["returnPolicy", "paymentPolicy"] }, "refused", WORDS.policyGone, ["returnPolicy", "paymentPolicy"]],
  [422, "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE", { invalidFields: ["shippingPolicy"] }, "refused", LISTING_SETTINGS_SAVE_WORDS.shippingPolicyIncompatible, ["shippingPolicy"]],
  [422, "DROPSHIP_EBAY_CATEGORY_RULE_INVALID", { reason: "not_leaf", invalidFields: ["ebayCategory"] }, "refused", "Pick a final eBay category.", ["ebayCategory"]],
  [422, "DROPSHIP_EBAY_CATEGORY_RULE_INVALID", { reason: "not_found" }, "refused", WORDS.categoryGone, ["ebayCategory"]],
  [422, "DROPSHIP_EBAY_STORE_CATEGORY_INVALID", { reason: "not_found", invalidFields: ["storeShelf"] }, "refused", "That shelf is gone from your eBay store.", ["storeShelf"]],
  [422, "DROPSHIP_EBAY_STORE_CATEGORY_INVALID", { reason: "too_long" }, "refused", WORDS.shelfTooLong, ["storeShelf"]],
  // Plan 6.5: W6's text budget, and a product Card Shellz deleted since the ids read; too large is a refusal, never the banner (D8).
  [422, "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", { textBytes: 30_008_000, maxTextBytes: 30_000_000, productCount: 3_751 }, "refused", LISTING_SETTINGS_BULK_WORDS.tooMuchText, []],
  // A conflict (Load latest), never a refusal Save would repeat under each new key (CLAUDE.md §6).
  [404, "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND", { productId: 11 }, "conflict", LISTING_SETTINGS_BULK_WORDS.productGone, []],
  [422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", { reason: "store_text_limit", textBytes: 30_000_100, maxTextBytes: 30_000_000 }, "refused", WORDS.storeTextLimit, []],
  [422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", undefined, "refused", null, []],
  // Codes this page's W6 can't get (row 22): refused, never unconfirmed.
  ...[
    [422, "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST"], [422, "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT"], [422, "DROPSHIP_PRICING_RULES_NOT_CONFIGURED"],
    [422, "DROPSHIP_LISTING_PRICE_RELEASE_LIMIT"], [409, "DROPSHIP_LISTING_PRICES_MOVED"], [409, "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT"],
    [404, "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE"], [409, "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT"],
    [409, "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT"], [404, "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND"], [404, "DROPSHIP_PRICING_REVIEW_NOT_FOUND"],
  ].map(([status, code]): Row => [status as number, code as string, undefined, "refused", WORDS.invalid, []]),
  [418, null, undefined, "refused", null, []],
  [422, "DROPSHIP_SOMETHING_NEW", undefined, "refused", null, []],
];

const KEY_KEPT: ReadonlySet<WriteFailurePhase> = new Set(["uncertain", "unreachable", "rate_limited"]);

describe("W6's answers, code by code, through the runner (plan 3.3, 6.5)", () => {
  it.each(W6_ROWS.map((row) => [row[0], row[1] ?? "no code", row] as const))("%i %s", async (_status, _code, row) => {
    const [status, code, context, phase, words, fields] = row;
    const error = apiError(status, code, context);
    const run = setup();
    run.answers.push(error);
    const outcome = await run.save();
    expect(outcome).toEqual({ kind: "failed", failure: { phase, message: words ?? "Server words.", code, status, fields } });
    expect(run.drafts.current()).toMatchObject({ phase, changes: 2, message: words ?? "Server words." });
    expect(run.drafts.current().attempt?.key ?? null).toBe(KEY_KEPT.has(phase) ? "ls-bulk:1" : null);
    // Only a block goes to the banner; a refusal (both too-large codes included) never does (D8).
    expect(run.input.onBlocked).toHaveBeenCalledTimes(phase === "blocked" ? 1 : 0);
    expect(run.input.onSettingsSaved).not.toHaveBeenCalled();
    const spoken = (words ?? "Server words.").replace(/ Reference: DROPSHIP_[A-Z_]+$/, "");
    expect(spoken).not.toMatch(/DROPSHIP_|[a-z]+_[a-z_]+/);
  });

  it("a dropped connection is unconfirmed, with the same key", async () => {
    const run = setup();
    run.answers.push(new TypeError("Failed to fetch"));
    await expect(run.save()).resolves.toEqual({
      kind: "failed", failure: { phase: "uncertain", message: UNCONFIRMED, code: null, status: null, fields: [] },
    });
    expect(run.drafts.current().attempt?.key).toBe("ls-bulk:1");
  });
});
