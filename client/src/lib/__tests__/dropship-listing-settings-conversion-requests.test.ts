import { describe, expect, it, vi } from "vitest";
import {
  listingRulesConversionApplyInputSchema,
  listingRulesConversionCheckSchema,
  type ListingRulesConversionApplyInput,
  type ListingRulesConversionApplyResponse,
  type ListingRulesConversionCheck,
} from "@shared/dropship/listing-rules-conversion";
import { LISTING_SETTING_BUSY_REASONS } from "@shared/dropship/listing-setting-writes";
import { DropshipApiError } from "../dropship-ops-surface";
import { listingSettingsQueryKey } from "../dropship-listing-settings";
import { contentProfileQueryKey, ebayCategoryRulesQueryKey } from "../dropship-listing-settings-content-requests";
import {
  CONVERSION_REQUEST_INVALID,
  conversionApplyBody,
  conversionApplyEndpoint,
  conversionDraftValue,
  conversionRefusalReadsCheckAgain,
  conversionRereadKeys,
  conversionSignature,
  heldConversionFor,
  isConversionDraft,
  readConversionApplyAnswer,
  readConversionDraft,
  rereadAfterConversion,
  runConversionApply,
  type ConversionApplyRun,
  type ConversionDraftValue,
  type ConversionQueryClient,
} from "../dropship-listing-settings-conversion-requests";
import {
  CONVERSION_EDITOR_ID,
  LISTING_SETTINGS_KEY_PREFIXES,
  LISTING_SETTINGS_SAVE_WORDS,
  UPDATED_PRODUCTS_EDITOR_ID,
  classifyWriteFailure,
  nextSaveAttempt,
  productEditorId,
  reduceListingSettingsDraft,
  type ListingSettingsDraft,
  type WriteFailurePhase,
} from "../dropship-listing-settings-drafts";
import { DRAWER_WORDS } from "../dropship-listing-settings-drawer";
import type { ProductSettingsSaveDrafts } from "../dropship-listing-settings-product-requests";
import { pricingRulesQueryKey } from "../dropship-listing-settings-recipe";
import { LISTING_SETTINGS_CONVERSION_WORDS, LISTING_SETTINGS_EDIT_WORDS } from "../dropship-listing-settings-words";

/** W11, [Move them over] in "Your older group rules" (plan PR 11, 8.2, 8.3, 8.4, 8.5; PLAN10 3.3, 3.6). */

const STORE = 22;
const WORDS = LISTING_SETTINGS_EDIT_WORDS;
const CW = LISTING_SETTINGS_CONVERSION_WORDS;
const PLAN_A = "a".repeat(64);
const PLAN_B = "b".repeat(64);
const WRITES_A = "c".repeat(64);
const WRITES_B = "d".repeat(64);
/** Page 0's two hashes as shown: what a press sends. */
const SHOWN: ConversionDraftValue = { planHash: PLAN_A, writesHash: WRITES_A };
const SENT: ListingRulesConversionApplyInput = { idempotencyKey: "ls-convert:1", planHash: PLAN_A, writesHash: WRITES_A };
const CONVERTED: ListingRulesConversionApplyResponse = { outcome: "converted", conversionId: 701, categoryCount: 2, productCount: 5 };
const REPLAYED: ListingRulesConversionApplyResponse = { outcome: "replayed", conversionId: 701, categoryCount: 2, productCount: 5 };
const NOTHING: ListingRulesConversionApplyResponse = { outcome: "nothing_to_convert", conversionId: null, categoryCount: 0, productCount: 0 };

const list = <T>(items: readonly T[], total = items.length) => ({ total, items: [...items] });

/** A dry run's page 0, parsed with the strict contract. */
function check(overrides: Partial<ListingRulesConversionCheck> = {}): ListingRulesConversionCheck {
  return listingRulesConversionCheckSchema.parse({
    storeConnectionId: STORE, generatedAt: "2026-10-16T12:00:00.000Z", state: "clean", planHash: PLAN_A, writesHash: WRITES_A,
    olderRules: { pricingGroups: 1, contentGroups: 0, ebayCategoryRules: 0 },
    blocked: { wouldLosePrice: list([]), wouldBlockListing: list([]), tooMuchText: false },
    becomes: { categories: list([]), products: list([]) },
    report: { unmatched: list([]), shared: list([]), nameMismatches: list([]), neverApplies: list([]), ties: list([]), someSizesOnly: list([]), mixed: list([]) },
    kept: { exactPrices: 0, catalogPrices: 0, sizePolicies: 0, sizeShelves: 0, sizeTexts: 0 },
    changes: { page: 0, pageSize: 50, total: 0, rows: [] },
    ...overrides,
  });
}

/** The step's draft for a press on page 0 with these hashes: base and value alike (a no-change sheet draft, plan 8.2). */
function moveDraft(value: ConversionDraftValue = SHOWN): ListingSettingsDraft {
  const opened = reduceListingSettingsDraft(null, { type: "open", editor: CONVERSION_EDITOR_ID, place: CW.sheetTitle, base: value });
  if (opened === null) throw new Error("expected a draft");
  return opened;
}

/** The provider's two save calls on the real reducer, minting keys `ls-convert:1`, `:2`… */
function reducerDrafts(start: ListingSettingsDraft) {
  let draft: ListingSettingsDraft | null = start;
  let keys = 0;
  const drafts: ProductSettingsSaveDrafts & { current: () => ListingSettingsDraft; replace: (next: ListingSettingsDraft) => void } = {
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
    // A new press on new hashes opens the draft afresh (the sheet's `move`), as the provider's `open` does.
    replace: (next) => { draft = reduceListingSettingsDraft(draft, { type: "open", editor: next.editor, place: next.place, base: next.base }); },
  };
  return drafts;
}

function setup(overrides: Partial<ConversionApplyRun> = {}, start: ListingSettingsDraft = moveDraft()) {
  const drafts = reducerDrafts(start);
  const sent: ListingRulesConversionApplyInput[] = [];
  const callbacks = { onSaveStarted: vi.fn(), onSaveSettled: vi.fn() };
  const answers: Array<unknown | Error> = [];
  const send = vi.fn(async (body: ListingRulesConversionApplyInput) => {
    sent.push(body);
    const next = answers.length > 0 ? answers.shift() : CONVERTED;
    if (next instanceof Error) throw next;
    return next;
  });
  const input: ConversionApplyRun = {
    storeConnectionId: STORE, draft: drafts.current(), drafts, callbacks, send,
    reread: vi.fn(async () => undefined),
    rereadCheck: vi.fn(async () => undefined),
    onSettingsSaved: vi.fn(), onBlocked: vi.fn(),
    ...overrides,
  };
  /** [Move them over], or [Check again], on the draft as it is now. */
  const press = () => runConversionApply({ ...input, draft: drafts.current() });
  return { input, drafts, sent, callbacks, answers, send, press };
}

const apiError = (status: number, code: string | null, context?: Record<string, unknown>, message = "Server words.") =>
  new DropshipApiError({ status, code, message, context });
const UNCONFIRMED = CW.uncertain;

describe("the W11 request (plan 7.B.2, 8.2)", () => {
  it("puts the move under the store's listing settings", () => {
    expect(conversionApplyEndpoint(STORE)).toBe("/api/dropship/listings/stores/22/listing-settings/conversion/apply");
  });

  it("takes page 0's two hashes as shown, and nothing from a page with no plan (D1)", () => {
    expect(conversionDraftValue(check())).toEqual(SHOWN);
    expect(conversionDraftValue(check({ state: "not_clean", planHash: PLAN_B, writesHash: WRITES_B, changes: { page: 0, pageSize: 50, total: 0, rows: [] },
      blocked: { wouldLosePrice: list([]), wouldBlockListing: list([]), tooMuchText: true } }))).toEqual({ planHash: PLAN_B, writesHash: WRITES_B });
    expect(conversionDraftValue(check({ state: "no_older_rules", planHash: null, writesHash: null, olderRules: { pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 0 } }))).toBeNull();
    // The draft value is frozen: nothing downstream can change what is sent.
    expect(Object.isFrozen(conversionDraftValue(check()))).toBe(true);
  });

  it("reads a move's draft only from two sha256 hashes", () => {
    expect(readConversionDraft(SHOWN)).toEqual(SHOWN);
    for (const bad of [{}, { planHash: PLAN_A }, { planHash: PLAN_A, writesHash: "C".repeat(64) }, { planHash: "a".repeat(63), writesHash: WRITES_A },
      { planHash: 1, writesHash: WRITES_A }, { items: [] }]) {
      expect(readConversionDraft(bad as never)).toBeNull();
    }
    expect(isConversionDraft(moveDraft())).toBe(true);
    expect(isConversionDraft({ editor: UPDATED_PRODUCTS_EDITOR_ID })).toBe(false);
    expect(isConversionDraft(null)).toBe(false);
  });

  it("signs a move by its store and both hashes, so one plan reuses one key and another plan or store never does (D12)", () => {
    const signature = conversionSignature(STORE, SHOWN);
    expect(conversionSignature(STORE, { ...SHOWN })).toBe(signature);
    expect(conversionSignature(STORE, { planHash: PLAN_B, writesHash: WRITES_A })).not.toBe(signature);
    expect(conversionSignature(STORE, { planHash: PLAN_A, writesHash: WRITES_B })).not.toBe(signature);
    expect(conversionSignature(23, SHOWN)).not.toBe(signature);
  });

  it("builds the body with the shared schema: the key and the two hashes, nothing else; a reserved or malformed key is never sent", () => {
    const body = conversionApplyBody({ key: "ls-convert:1", value: SHOWN });
    expect(body).toEqual(SENT);
    expect(Object.keys(body).sort()).toEqual(["idempotencyKey", "planHash", "writesHash"]);
    expect(listingRulesConversionApplyInputSchema.safeParse(body).success).toBe(true);
    for (const key of ["rules-conversion:22", `lc:${"e".repeat(64)}:category:40`, "x:1", "ls convert:1"]) {
      expect(() => conversionApplyBody({ key, value: SHOWN })).toThrow(expect.objectContaining({ code: CONVERSION_REQUEST_INVALID }));
    }
    expect(() => conversionApplyBody({ key: "ls-convert:1", value: { planHash: "x", writesHash: WRITES_A } })).toThrow(expect.objectContaining({ code: CONVERSION_REQUEST_INVALID }));
  });

  it("checks an answer against its strict contract", () => {
    expect(readConversionApplyAnswer(CONVERTED)).toEqual(CONVERTED);
    expect(readConversionApplyAnswer(REPLAYED)).toEqual(REPLAYED);
    expect(readConversionApplyAnswer(NOTHING)).toEqual(NOTHING);
    for (const bad of [
      { ...CONVERTED, extra: 1 }, { ...CONVERTED, conversionId: null }, { ...NOTHING, conversionId: 3 }, { ...NOTHING, categoryCount: 1 },
      { ...CONVERTED, outcome: "moved" }, { ...CONVERTED, productCount: -1 }, { ...CONVERTED, categoryCount: 1.5 }, null, "ok",
    ]) {
      expect(() => readConversionApplyAnswer(bad)).toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_OFF_CONTRACT", context: expect.objectContaining({ write: "W11" }) }));
    }
  });

  it("holds a rate limited or unreachable move for the same plan with its key, and nothing else (PLAN10 D5)", () => {
    const run = setup();
    run.answers.push(apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"));
    return run.press().then(() => {
      const held = run.drafts.current();
      expect(heldConversionFor(held, STORE, SHOWN)).toBe(held);
      // Another plan is a new request: the draft opens afresh and gets a new key.
      expect(heldConversionFor(held, STORE, { planHash: PLAN_B, writesHash: WRITES_A })).toBeNull();
      expect(heldConversionFor(held, 23, SHOWN)).toBeNull();
      expect(heldConversionFor(moveDraft(), STORE, SHOWN)).toBeNull();
      expect(heldConversionFor({ ...held, editor: UPDATED_PRODUCTS_EDITOR_ID }, STORE, SHOWN)).toBeNull();
      expect(heldConversionFor({ ...held, phase: "uncertain" }, STORE, SHOWN)).toBeNull();
      expect(heldConversionFor({ ...held, phase: "refused" }, STORE, SHOWN)).toBeNull();
      expect(heldConversionFor(null, STORE, SHOWN)).toBeNull();
    });
  });
});

describe("the re-reads after a confirmed move (plan 8.4)", () => {
  it("invalidates the listing-settings prefix, the pricing rules, the eBay rules, the content profile and every size price, cancelling reads in flight first", async () => {
    const calls: string[] = [];
    const name = (filter: { queryKey?: readonly unknown[]; predicate?: unknown }) =>
      filter.predicate !== undefined ? "size prices" : JSON.stringify(filter.queryKey);
    const client = {
      cancelQueries: vi.fn(async (filter: { queryKey?: readonly unknown[]; predicate?: unknown }) => { calls.push(`cancel ${name(filter)}`); }),
      invalidateQueries: vi.fn(async (filter: { queryKey?: readonly unknown[]; predicate?: unknown }) => { calls.push(`invalidate ${name(filter)}`); }),
    };
    const typed = client as unknown as ConversionQueryClient;
    await rereadAfterConversion(typed, STORE);
    const keys = [listingSettingsQueryKey(STORE), pricingRulesQueryKey(STORE), ebayCategoryRulesQueryKey(STORE), contentProfileQueryKey(STORE)];
    expect(conversionRereadKeys(STORE)).toEqual(keys);
    // The content profile key (CFC#10) is among them.
    expect(conversionRereadKeys(STORE)).toContainEqual(contentProfileQueryKey(STORE));
    // Every cancel before any invalidation.
    expect(calls.slice(0, 5).every((call) => call.startsWith("cancel"))).toBe(true);
    expect(calls.slice(5).every((call) => call.startsWith("invalidate"))).toBe(true);
    for (const queryKey of keys) {
      expect(client.cancelQueries).toHaveBeenCalledWith({ queryKey: [...queryKey] });
      // Invalidations only: a query refetches only if mounted, so Older settings' closed forms read nothing now.
      expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: [...queryKey] }, { throwOnError: true });
    }
    // Every size price read of this store, and only this store's.
    const predicateCall = (client.invalidateQueries.mock.calls as unknown as Array<[{ predicate?: unknown }, unknown]>).find(([filter]) => filter.predicate !== undefined);
    const predicate = predicateCall?.[0].predicate as (query: { queryKey: readonly unknown[] }) => boolean;
    expect(predicate({ queryKey: [`/api/dropship/listings/stores/${STORE}/variants/101/price`] })).toBe(true);
    expect(predicate({ queryKey: ["/api/dropship/listings/stores/23/variants/101/price"] })).toBe(false);
    expect(predicateCall?.[1]).toEqual({ throwOnError: true });
    // The prefix covers the summary, the categories, the products, the prices and the dry run's pages.
    for (const read of ["summary", "categories", "products", "prices", "conversion"]) {
      expect([...listingSettingsQueryKey(STORE), read].slice(0, 3)).toEqual([...listingSettingsQueryKey(STORE)]);
    }
    client.invalidateQueries.mockRejectedValueOnce(new TypeError("offline"));
    await expect(rereadAfterConversion(typed, STORE)).rejects.toThrow("offline");
  });

  it("reads page 0 again after exactly the refusals that say the plan moved (8.3)", () => {
    const yes = [
      apiError(409, "DROPSHIP_LISTING_CONVERSION_CHANGED", { reason: "settings_changed" }),
      apiError(409, "DROPSHIP_LISTING_CONVERSION_CHANGED", { reason: "listed_changes_moved" }),
      apiError(422, "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", { sizeCount: 2 }),
      apiError(422, "DROPSHIP_LISTING_CONVERSION_WOULD_BLOCK_LISTING", { sizeCount: 1 }),
      apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", { reason: "store_text_limit" }),
      apiError(409, "DROPSHIP_IDEMPOTENCY_CONFLICT"),
    ];
    const no = [
      apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE"), apiError(503, "DROPSHIP_LISTING_CONVERSION_CHECK_UNAVAILABLE"),
      apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "catalog_changed" }), apiError(500, "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED"),
      apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"), apiError(403, "DROPSHIP_LISTING_STORE_BLOCKED"), new TypeError("Failed to fetch"),
    ];
    for (const error of yes) expect(conversionRefusalReadsCheckAgain(error)).toBe(true);
    for (const error of no) expect(conversionRefusalReadsCheckAgain(error)).toBe(false);
  });
});

describe("runConversionApply (plan PLAN10 3.6, 8.5)", () => {
  it("(1) sends one POST with the draft's ls-convert key and page 0's two hashes, re-reads, then tells the step", async () => {
    const run = setup();
    await expect(run.press()).resolves.toEqual({ kind: "applied", viewStale: false, answer: CONVERTED });
    expect(run.sent).toEqual([SENT]);
    expect(run.sent[0].idempotencyKey).toMatch(new RegExp(`^${LISTING_SETTINGS_KEY_PREFIXES.conversion}:`));
    expect(run.input.reread).toHaveBeenCalledTimes(1);
    expect(run.input.rereadCheck).not.toHaveBeenCalled();
    expect(run.input.onSettingsSaved).toHaveBeenCalledTimes(1);
    expect(run.callbacks.onSaveStarted).toHaveBeenCalledTimes(1);
    expect(run.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
    expect(run.drafts.current()).toMatchObject({ editor: "convert", phase: "saved", changes: 0, attempt: null });
    // The body is page 0's, as a press on it takes them (D1).
    expect(conversionDraftValue(check())).toEqual({ planHash: run.sent[0].planHash, writesHash: run.sent[0].writesHash });
  });

  it("(1) a not-clean plan nothing blocks is sent the same way, with its own hashes", async () => {
    const run = setup({}, moveDraft({ planHash: PLAN_B, writesHash: WRITES_B }));
    await run.press();
    expect(run.sent).toEqual([{ idempotencyKey: "ls-convert:1", planHash: PLAN_B, writesHash: WRITES_B }]);
  });

  it("nothing_to_convert is a confirmed outcome: re-read and told, as a move (8.3)", async () => {
    const run = setup();
    run.answers.push(NOTHING);
    await expect(run.press()).resolves.toEqual({ kind: "applied", viewStale: false, answer: NOTHING });
    expect(run.input.reread).toHaveBeenCalledTimes(1);
    expect(run.input.onSettingsSaved).toHaveBeenCalledTimes(1);
    expect(run.drafts.current().phase).toBe("saved");
  });

  it("(2) a dropped answer, then Check again, resends the same key and body; the replay is the outcome", async () => {
    const run = setup();
    run.answers.push(new TypeError("Failed to fetch"), REPLAYED);
    await expect(run.press()).resolves.toMatchObject({ kind: "failed", failure: { phase: "uncertain", message: UNCONFIRMED }, checkAgain: false });
    expect(run.drafts.current()).toMatchObject({ phase: "uncertain", changes: 0, attempt: { key: "ls-convert:1" } });
    expect(run.input.rereadCheck).not.toHaveBeenCalled();
    await expect(run.press()).resolves.toEqual({ kind: "applied", viewStale: false, answer: REPLAYED });
    expect(run.sent).toEqual([SENT, SENT]);
  });

  it("(3) a block goes to the banner and the draft is kept", async () => {
    const blocked = apiError(403, "DROPSHIP_LISTING_STORE_BLOCKED", { reason: "paused" });
    const run = setup();
    run.answers.push(blocked);
    await expect(run.press()).resolves.toMatchObject({ kind: "failed", failure: { phase: "blocked", message: "Nothing was saved." } });
    expect(run.input.onBlocked).toHaveBeenCalledWith(blocked);
    expect(run.drafts.current()).toMatchObject({ phase: "blocked", editor: "convert", attempt: null });
    expect(run.input.onSettingsSaved).not.toHaveBeenCalled();
  });

  it("(4) a 429 keeps the key", async () => {
    const run = setup();
    run.answers.push(apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"));
    await expect(run.press()).resolves.toMatchObject({ kind: "failed", failure: { phase: "rate_limited", message: LISTING_SETTINGS_SAVE_WORDS.rateLimited } });
    expect(run.drafts.current().attempt?.key).toBe("ls-convert:1");
    await run.press();
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-convert:1", "ls-convert:1"]);
  });

  it("(5) after a refusal the next try gets a new key: a key conflict reads page 0 again and is worded as such", async () => {
    const run = setup();
    run.answers.push(apiError(409, "DROPSHIP_IDEMPOTENCY_CONFLICT"));
    await expect(run.press()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", message: CW.idempotencyConflict }, checkAgain: true });
    expect(run.input.rereadCheck).toHaveBeenCalledTimes(1);
    expect(run.input.onBlocked).not.toHaveBeenCalled();
    expect(run.drafts.current()).toMatchObject({ phase: "refused", attempt: null });
    await run.press();
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-convert:1", "ls-convert:2"]);
  });

  it("(6) CHANGED is a conflict worded by its reason; page 0 is read again and nothing is sent by itself; the next press on the new hashes gets a new key", async () => {
    for (const [reason, words] of [["settings_changed", CW.changed], ["listed_changes_moved", CW.listedChangesMoved], [undefined, CW.changed]] as const) {
      const run = setup();
      run.answers.push(apiError(409, "DROPSHIP_LISTING_CONVERSION_CHANGED", reason === undefined ? undefined : { reason }));
      await expect(run.press()).resolves.toMatchObject({ kind: "failed", failure: { phase: "conflict", message: words }, checkAgain: true });
      expect(run.input.rereadCheck).toHaveBeenCalledTimes(1);
      // Never a second send by itself: the vendor presses again (8.3).
      expect(run.send).toHaveBeenCalledTimes(1);
      expect(run.input.onSettingsSaved).not.toHaveBeenCalled();
      expect(run.drafts.current()).toMatchObject({ phase: "conflict", attempt: null });
      // Page 0 read again brings new hashes; the press opens the draft on them and gets a new key.
      run.drafts.replace(moveDraft({ planHash: PLAN_B, writesHash: WRITES_A }));
      await expect(run.press()).resolves.toMatchObject({ kind: "applied" });
      expect(run.sent).toEqual([SENT, { idempotencyKey: "ls-convert:2", planHash: PLAN_B, writesHash: WRITES_A }]);
    }
  });

  it("the three blocks refuse with the plan-moved words and read page 0 again, whose section says why (8.3)", async () => {
    for (const error of [
      apiError(422, "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", { sizeCount: 2, sizes: [{ productVariantId: 101, priceCents: 499 }] }),
      apiError(422, "DROPSHIP_LISTING_CONVERSION_WOULD_BLOCK_LISTING", { sizeCount: 1, sizes: [{ productVariantId: 102, blockers: ["no_ebay_category"] }] }),
      apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", { reason: "store_text_limit", textBytes: 30_000_001, maxTextBytes: 30_000_000 }),
    ]) {
      const run = setup();
      run.answers.push(error);
      await expect(run.press()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", message: CW.changed, code: error.code }, checkAgain: true });
      expect(run.input.rereadCheck).toHaveBeenCalledTimes(1);
      expect(run.input.onBlocked).not.toHaveBeenCalled();
      expect(run.drafts.current().attempt).toBeNull();
    }
  });

  it("a page 0 re-read that fails never hides the refusal", async () => {
    const run = setup({ rereadCheck: vi.fn(async () => { throw new TypeError("offline"); }) });
    run.answers.push(apiError(409, "DROPSHIP_LISTING_CONVERSION_CHANGED", { reason: "settings_changed" }));
    await expect(run.press()).resolves.toMatchObject({ kind: "failed", failure: { phase: "conflict", message: CW.changed }, checkAgain: true });
  });

  it("(7) still counts a move whose re-read failed, and says so", async () => {
    const run = setup({ reread: vi.fn(async () => { throw new TypeError("offline"); }) });
    await expect(run.press()).resolves.toEqual({ kind: "applied", viewStale: true, answer: CONVERTED });
    expect(run.drafts.current()).toMatchObject({ phase: "saved_view_stale" });
    expect(run.input.onSettingsSaved).toHaveBeenCalledTimes(1);
  });

  it("(8) counts an off-contract 2xx as moved with a stale view and no answer, and still reads the views again", async () => {
    for (const answer of [{ outcome: "converted" }, { ...CONVERTED, conversionId: null }, { ...NOTHING, productCount: 3 }, "ok", null]) {
      const run = setup();
      run.answers.push(answer);
      await expect(run.press()).resolves.toEqual({ kind: "applied", viewStale: true, answer: null });
      expect(run.input.reread).toHaveBeenCalledTimes(1);
      expect(run.drafts.current().phase).toBe("saved_view_stale");
    }
  });

  it("(9) sends nothing with another editor's draft, no or bad hashes, another action running, or a move out", async () => {
    const other = setup();
    await expect(runConversionApply({ ...other.input, draft: { ...moveDraft(), editor: productEditorId(11) } })).resolves.toEqual({ kind: "not_started", message: null });
    await expect(runConversionApply({ ...other.input, draft: { ...moveDraft(), value: { planHash: null, writesHash: null } } })).resolves.toEqual({ kind: "not_started", message: null });
    await expect(runConversionApply({ ...other.input, draft: { ...moveDraft(), value: { planHash: "x", writesHash: WRITES_A } } })).resolves.toEqual({ kind: "not_started", message: null });
    expect(other.callbacks.onSaveStarted).not.toHaveBeenCalled();

    const disabled = setup({ callbacks: { disabled: true, onSaveStarted: vi.fn(), onSaveSettled: vi.fn() } });
    await expect(disabled.press()).resolves.toEqual({ kind: "not_started", message: DRAWER_WORDS.busy });
    const refused = setup({ callbacks: { onSaveStarted: () => { throw new Error("Wait for the current listing action to finish."); }, onSaveSettled: vi.fn() } });
    await expect(refused.press()).resolves.toEqual({ kind: "not_started", message: "Wait for the current listing action to finish." });
    expect(refused.input.callbacks.onSaveSettled).not.toHaveBeenCalled();

    const saving = setup();
    saving.drafts.startSave("another request", "ls-convert");
    await expect(saving.press()).resolves.toEqual({ kind: "not_started", message: null });
    for (const run of [other, disabled, refused, saving]) expect(run.send).not.toHaveBeenCalled();
    expect(saving.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
  });

  it("(9) settles a body it can't build as refused, sends nothing, and the next try gets a new key", async () => {
    const run = setup();
    let tries = 0;
    // The first key, "lc:1", has a prefix only a conversion's own revisions may use: that body is never built.
    const drafts: ProductSettingsSaveDrafts = {
      startSave: (signature, prefix) => run.drafts.startSave(signature, tries++ === 0 ? "lc" : prefix),
      settle: run.drafts.settle,
    };
    await expect(runConversionApply({ ...run.input, draft: run.drafts.current(), drafts })).resolves.toEqual({
      kind: "failed", checkAgain: false,
      failure: { phase: "refused", message: WORDS.cantBuild, code: CONVERSION_REQUEST_INVALID, status: null, fields: [] },
    });
    expect(run.send).not.toHaveBeenCalled();
    expect(run.callbacks.onSaveStarted).toHaveBeenCalledTimes(1);
    expect(run.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
    expect(run.drafts.current()).toMatchObject({ phase: "refused", message: WORDS.cantBuild, attempt: null });
    await expect(run.press()).resolves.toEqual({ kind: "applied", viewStale: false, answer: CONVERTED });
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-convert:2"]);
  });

  it("(10) never sends twice while one move is in flight", async () => {
    const run = setup();
    let answer: (value: unknown) => void = () => undefined;
    run.send.mockImplementationOnce(async (body: ListingRulesConversionApplyInput) => {
      run.sent.push(body);
      return new Promise((resolve) => { answer = resolve; });
    });
    const first = run.press();
    await expect(run.press()).resolves.toEqual({ kind: "not_started", message: null });
    answer(CONVERTED);
    await expect(first).resolves.toEqual({ kind: "applied", viewStale: false, answer: CONVERTED });
    expect(run.send).toHaveBeenCalledTimes(1);
  });

  it("(11) tells the busy answers apart by their reason: refused before a write keeps the key as nothing moved; no reason is unconfirmed", async () => {
    const cases: Array<[Record<string, unknown> | undefined, WriteFailurePhase, string]> = [
      [{ reason: LISTING_SETTING_BUSY_REASONS.heavyWrite, retryAfterSeconds: 5 }, "unreachable", WORDS.busyHeavy],
      [{ reason: LISTING_SETTING_BUSY_REASONS.requestKeyChanged, retryAfterSeconds: 5 }, "unreachable", WORDS.busyKeyChanged],
      [{ reason: LISTING_SETTING_BUSY_REASONS.catalogChanged, retryAfterSeconds: 5 }, "unreachable", CW.busyCatalogChanged],
      [undefined, "uncertain", UNCONFIRMED],
    ];
    for (const [context, phase, message] of cases) {
      const run = setup();
      run.answers.push(apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY", context));
      await expect(run.press()).resolves.toMatchObject({ kind: "failed", failure: { phase, message } });
      expect(run.drafts.current().attempt?.key).toBe("ls-convert:1");
      await run.press();
      expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-convert:1", "ls-convert:1"]);
    }
  });

  it("W11's 503 CHECK_UNAVAILABLE is unreachable with the key kept: nothing was moved, never \"couldn't confirm\" (3.6, CUX#4)", async () => {
    const run = setup();
    run.answers.push(apiError(503, "DROPSHIP_LISTING_CONVERSION_CHECK_UNAVAILABLE", { retryable: true, classification: "transient" }));
    await expect(run.press()).resolves.toMatchObject({ kind: "failed", failure: { phase: "unreachable", message: CW.checkUnavailableApply }, checkAgain: false });
    expect(CW.checkUnavailableApply).toContain("Nothing was moved");
    expect(CW.checkUnavailableApply).not.toMatch(/confirm/i);
    expect(run.drafts.current().attempt?.key).toBe("ls-convert:1");
    expect(run.input.rereadCheck).not.toHaveBeenCalled();
    await run.press();
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-convert:1", "ls-convert:1"]);
  });

  it("(12) a Check again answered by the costs, busy, a gateway or a rate limit stays unconfirmed with the move's words (D7b)", async () => {
    const run = setup();
    run.answers.push(
      new TypeError("Failed to fetch"),
      apiError(503, "DROPSHIP_LISTING_CONVERSION_CHECK_UNAVAILABLE"),
      apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "catalog_changed" }),
      apiError(502, "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE"),
      apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"),
      apiError(409, "DROPSHIP_IDEMPOTENCY_CONFLICT"),
    );
    await run.press();
    for (const message of [CW.stillUnconfirmed, CW.stillUnconfirmed, CW.stillUnconfirmed, CW.stillUnconfirmedRateLimited]) {
      await expect(run.press()).resolves.toMatchObject({ kind: "failed", failure: { phase: "uncertain", message } });
      expect(run.drafts.current()).toMatchObject({ phase: "uncertain", attempt: { key: "ls-convert:1" } });
      expect(run.drafts.current().message).not.toContain("Nothing was moved");
    }
    await expect(run.press()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", message: CW.idempotencyConflict } });
    expect(new Set(run.sent.map((body) => body.idempotencyKey))).toEqual(new Set(["ls-convert:1"]));
    expect(run.input.onBlocked).not.toHaveBeenCalled();
    const fresh = setup();
    fresh.answers.push(apiError(503, "DROPSHIP_LISTING_CONVERSION_CHECK_UNAVAILABLE"));
    await expect(fresh.press()).resolves.toMatchObject({ kind: "failed", failure: { phase: "unreachable", message: CW.checkUnavailableApply } });
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
      await run.press();
      await expect(run.press()).resolves.toMatchObject({ kind: "failed", failure: { phase: "uncertain", message: UNCONFIRMED, code } });
      expect(run.drafts.current()).toMatchObject({ phase: "uncertain", attempt: { key: "ls-convert:1" } });
      expect(run.input.onBlocked).toHaveBeenCalledWith(blocked);
      await expect(run.press()).resolves.toEqual({ kind: "applied", viewStale: false, answer: CONVERTED });
      expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-convert:1", "ls-convert:1", "ls-convert:1"]);
    }
  });

  it("(13) the three fatal codes are final: refused, a new key next time, never Check again (D7c)", async () => {
    for (const code of ["DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE", "DROPSHIP_LISTING_PRICE_INVARIANT_FAILED"]) {
      const run = setup();
      run.answers.push(apiError(500, code, { causeCode: "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT" }, "Something went wrong. We couldn't confirm your save."));
      await expect(run.press()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", message: WORDS.fatal, code }, checkAgain: false });
      expect(run.drafts.current()).toMatchObject({ phase: "refused", attempt: null });
      expect(run.input.rereadCheck).not.toHaveBeenCalled();
      await run.press();
      expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-convert:1", "ls-convert:2"]);
    }
  });

  it("a reasonless 422 TOO_LARGE is refused (more than 10,000 sizes), never the banner and never a page 0 re-read", async () => {
    const run = setup();
    run.answers.push(apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", { storeConnectionId: STORE }));
    await expect(run.press()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", message: CW.tooLargeApply }, checkAgain: false });
    expect(run.input.onBlocked).not.toHaveBeenCalled();
    expect(run.input.rereadCheck).not.toHaveBeenCalled();
  });
});

/**
 * Every code the write routes answer, through the runner (PLAN10 3.3 rows
 * 1-23, plan 8.3): [status, code, context, phase, words (null: the
 * server's), fields]. W11 asks eBay nothing and names no product, category,
 * size price or review, so every such refusal is "can't happen" (row 22):
 * refused with the plain words, never unconfirmed and never another writer's
 * advice.
 */
const SHIPPING_OUTAGE = (code: string) => `Can't check Card Shellz shipping right now. Try again in a few minutes. Reference: ${code}`;
const SHIPPING_SETUP = (code: string) => `Card Shellz is finishing shipping setup for your store, so this can't be saved yet. Reference: ${code}`;
const EBAY_DOWN = "Can't reach eBay right now. Nothing was saved. Try again.";
type Row = readonly [number, string | null, Record<string, unknown> | undefined, WriteFailurePhase, string | null, readonly string[]];

const W11_ROWS: readonly Row[] = [
  [429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED", undefined, "rate_limited", LISTING_SETTINGS_SAVE_WORDS.rateLimited, []],
  [401, "DROPSHIP_AUTH_REQUIRED", undefined, "refused", WORDS.signedOut, []],
  [503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "heavy_write_in_progress" }, "unreachable", WORDS.busyHeavy, []],
  [503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "request_key_changed" }, "unreachable", WORDS.busyKeyChanged, []],
  [503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "catalog_changed" }, "unreachable", CW.busyCatalogChanged, []],
  [503, "DROPSHIP_LISTING_SETTINGS_BUSY", undefined, "uncertain", UNCONFIRMED, []],
  [503, "DROPSHIP_LISTING_SETTINGS_BUSY", { failure: "connection_lost" }, "uncertain", UNCONFIRMED, []],
  // W11's own 503 (3.6): named before the 5xx fall-through.
  [503, "DROPSHIP_LISTING_CONVERSION_CHECK_UNAVAILABLE", { retryable: true, classification: "transient" }, "unreachable", CW.checkUnavailableApply, []],
  // 5xx the shared write routes can answer (never for W11 in practice): before any write, so nothing was saved.
  [503, "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE", { retryable: true }, "unreachable", SHIPPING_OUTAGE("DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE"), []],
  [502, "DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_UNAVAILABLE", { retryable: true }, "unreachable", SHIPPING_OUTAGE("DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_UNAVAILABLE"), []],
  ...["DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE", "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE", "DROPSHIP_EBAY_STORE_CATEGORIES_INVALID_RESPONSE"]
    .map((code): Row => [502, code, undefined, "unreachable", EBAY_DOWN, []]),
  ...["DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", "DROPSHIP_EBAY_REFRESH_LOCK_UNAVAILABLE", "DROPSHIP_CREDENTIAL_CHANGED",
    "DROPSHIP_EBAY_TOKEN_REFRESH_INVALID_RESPONSE", "DROPSHIP_EBAY_OAUTH_NOT_CONFIGURED"].map((code): Row => [503, code, undefined, "unreachable", EBAY_DOWN, []]),
  [502, null, undefined, "uncertain", UNCONFIRMED, []],
  [503, null, undefined, "uncertain", UNCONFIRMED, []],
  [504, null, undefined, "uncertain", UNCONFIRMED, []],
  [500, "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", { causeCode: "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT" }, "refused", WORDS.fatal, []],
  [500, "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE", undefined, "refused", WORDS.fatal, []],
  [500, "DROPSHIP_LISTING_PRICE_INVARIANT_FAILED", undefined, "refused", WORDS.fatal, []],
  [500, "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", undefined, "uncertain", UNCONFIRMED, []],
  // W11's own refusals (8.3).
  [409, "DROPSHIP_LISTING_CONVERSION_CHANGED", { reason: "settings_changed" }, "conflict", CW.changed, []],
  [409, "DROPSHIP_LISTING_CONVERSION_CHANGED", { reason: "listed_changes_moved" }, "conflict", CW.listedChangesMoved, []],
  [409, "DROPSHIP_IDEMPOTENCY_CONFLICT", undefined, "refused", CW.idempotencyConflict, []],
  [422, "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", { sizeCount: 3 }, "refused", CW.changed, []],
  [422, "DROPSHIP_LISTING_CONVERSION_WOULD_BLOCK_LISTING", { sizeCount: 1 }, "refused", CW.changed, []],
  [422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", { reason: "store_text_limit", textBytes: 30_000_100, maxTextBytes: 30_000_000 }, "refused", CW.changed, []],
  [422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", undefined, "refused", CW.tooLargeApply, []],
  // Card Shellz shipping checks (W2's 409s): the route's codes, worded as the other PR 9 writers word them.
  ...["SERVICES_REQUIRED", "ROUTING_REQUIRED", "NO_RATE_BOOK"]
    .map((suffix): Row => [409, `DROPSHIP_EBAY_FULFILLMENT_${suffix}`, undefined, "refused", SHIPPING_SETUP(`DROPSHIP_EBAY_FULFILLMENT_${suffix}`), ["shippingPolicy"]]),
  [409, "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED", undefined, "blocked", "Nothing was saved.", []],
  [422, "DROPSHIP_EBAY_CATEGORY_MARKETPLACE_UNSUPPORTED", undefined, "blocked", "Nothing was saved.", []],
  [413, "DROPSHIP_REQUEST_TOO_LARGE", undefined, "refused", WORDS.tooBig, []],
  // A reserved key or a body off the contract: the route's 400.
  [400, "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT", { issues: [{ path: "idempotencyKey", code: "custom" }] }, "refused", WORDS.invalid, []],
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
  ...["DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED", "DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED", "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED",
    "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED", "DROPSHIP_EBAY_STORE_CATEGORIES_ACCESS_DENIED", "DROPSHIP_EBAY_CATEGORIES_ACCESS_DENIED",
  ].map((code): Row => [403, code, undefined, "blocked", "Nothing was saved.", []]),
  // Codes this page's W11 can't get (row 22): refused with the plain words, never unconfirmed, never a Load latest and
  // never a sign-in banner or "pick another policy" (W11 names no eBay value); the fields a refusal names are still named.
  ...[
    [422, "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT"], [422, "DROPSHIP_PRICING_RULES_NOT_CONFIGURED"], [422, "DROPSHIP_LISTING_PRICE_RELEASE_LIMIT"],
    [409, "DROPSHIP_LISTING_PRICES_MOVED"], [409, "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT"], [404, "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE"],
    [409, "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT"], [409, "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT"],
    [409, "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT"], [422, "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE"],
    [404, "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND"], [404, "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND"], [404, "DROPSHIP_PRICING_REVIEW_NOT_FOUND"],
    [422, "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID"], [422, "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE"],
    [422, "DROPSHIP_EBAY_CATEGORY_RULE_INVALID"], [422, "DROPSHIP_EBAY_STORE_CATEGORY_INVALID"],
  ].map(([status, code]): Row => [status as number, code as string, undefined, "refused", WORDS.invalid, []]),
  [403, "DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED", { fields: ["ebayCategory"] }, "refused", WORDS.invalid, ["ebayCategory"]],
  [418, null, undefined, "refused", null, []],
  [422, "DROPSHIP_SOMETHING_NEW", undefined, "refused", null, []],
];

const KEY_KEPT: ReadonlySet<WriteFailurePhase> = new Set(["uncertain", "unreachable", "rate_limited"]);

describe("W11's answers, code by code, through the runner (PLAN10 3.3, plan 8.3)", () => {
  it.each(W11_ROWS.map((row) => [row[0], row[1] ?? "no code", JSON.stringify(row[2] ?? {}), row] as const))("%i %s %s", async (_status, _code, _context, row) => {
    const [status, code, context, phase, words, fields] = row;
    const error = apiError(status, code, context);
    const run = setup();
    run.answers.push(error);
    const outcome = await run.press();
    expect(outcome).toMatchObject({ kind: "failed", failure: { phase, message: words ?? "Server words.", code, status, fields } });
    expect(run.drafts.current()).toMatchObject({ phase, changes: 0, message: words ?? "Server words." });
    expect(run.drafts.current().attempt?.key ?? null).toBe(KEY_KEPT.has(phase) ? "ls-convert:1" : null);
    // Only a block goes to the banner; a refusal never does (PLAN10 D8).
    expect(run.input.onBlocked).toHaveBeenCalledTimes(phase === "blocked" ? 1 : 0);
    expect(run.input.onSettingsSaved).not.toHaveBeenCalled();
    // Page 0 is read again exactly after the refusals that say the plan moved (8.3).
    expect(run.input.rereadCheck).toHaveBeenCalledTimes(conversionRefusalReadsCheckAgain(error) ? 1 : 0);
    // Never an id or a code in the words (owner rule); a Card Shellz shipping reference is the one sanctioned code.
    const spoken = (words ?? "Server words.").replace(/ Reference: DROPSHIP_[A-Z_]+$/, "");
    expect(spoken).not.toMatch(/DROPSHIP_|[a-z]+_[a-z_]+/);
    // The words are the classifier's for W11 (one table).
    expect(classifyWriteFailure("W11", error)).toMatchObject({ phase, message: words ?? "Server words." });
  });

  it("a dropped connection is unconfirmed, with the same key, in the move's words", async () => {
    const run = setup();
    run.answers.push(new TypeError("Failed to fetch"));
    await expect(run.press()).resolves.toEqual({
      kind: "failed", checkAgain: false, failure: { phase: "uncertain", message: UNCONFIRMED, code: null, status: null, fields: [] },
    });
    expect(run.drafts.current().attempt?.key).toBe("ls-convert:1");
    expect(UNCONFIRMED).toBe("We couldn't confirm the move.");
  });
});
