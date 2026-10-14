import { describe, expect, it, vi } from "vitest";
import { saveProductSettingsInputSchema } from "@shared/dropship/listing-setting-writes";
import { listingSettingsProductOwnSettingsSchema } from "@shared/dropship/listing-settings";
import { DropshipApiError } from "../dropship-ops-surface";
import { listingSettingsQueryKey } from "../dropship-listing-settings";
import {
  LISTING_SETTINGS_SAVE_WORDS,
  nextSaveAttempt,
  productEditorId,
  reduceListingSettingsDraft,
  type ListingSettingsDraft,
  type WriteFailurePhase,
} from "../dropship-listing-settings-drafts";
import { DRAWER_WORDS } from "../dropship-listing-settings-drawer";
import {
  emptyChoices,
  ownTextCheckChoices,
  PRODUCT_SETTINGS_REQUEST_INVALID,
  productSettingsDraftValue,
  productSettingsEditAction,
  type ProductOwnSettings,
  type ProductSettingsChoices,
  type ProductSettingsSaveBody,
} from "../dropship-listing-settings-product-edit";
import {
  loadLatestProductSettings,
  productSettingsEndpoint,
  readSavedProductSettings,
  rereadProductSettings,
  runProductSettingsSave,
  type ProductSettingsQueryClient,
  type ProductSettingsSaveDrafts,
  type ProductSettingsSaveRun,
} from "../dropship-listing-settings-product-requests";
import { LISTING_SETTINGS_EDIT_WORDS } from "../dropship-listing-settings-words";

/** W5 from the drawer (plan PR 10, 4.6, 4.7, 3.3, 3.6). */

const STORE = 22;
const PRODUCT = 11;
const EDITOR = productEditorId(PRODUCT);
const WORDS = LISTING_SETTINGS_EDIT_WORDS;

function own(revisionId: number | null, shippingId: string | null): ProductOwnSettings {
  return listingSettingsProductOwnSettingsSchema.parse({
    storeConnectionId: STORE, productId: PRODUCT, revisionId,
    own: {
      price: null, ebayCategory: null, storeShelf: null,
      shippingPolicy: shippingId === null ? null : { id: shippingId, name: "Fast Free" }, returnPolicy: { id: "R1", name: "30 days" }, paymentPolicy: null,
      textAbove: null, textBelow: null, mainText: null,
    },
    generatedAt: "2026-10-14T12:00:00.000Z",
  });
}

const OWN = own(5, "F2");
/**
 * The product's settings in full, as far as the drawer's reload reads them (the fields a size can keep a
 * leftover for): every policy from the product or the store, no shelf, the Card Shellz text.
 */
const DETAIL_SETTINGS = {
  shippingPolicy: [{ value: { policyId: "F2" }, sources: [{ source: "product", ruleName: null, productVariantIds: [101] }] }],
  returnPolicy: [{ value: { policyId: "R1" }, sources: [{ source: "product", ruleName: null, productVariantIds: [101] }] }],
  paymentPolicy: [{ value: { policyId: "P1" }, sources: [{ source: "store_default", ruleName: null, productVariantIds: [101] }] }],
  storeShelf: [{ value: { names: [] }, sources: [{ source: "none", ruleName: null, productVariantIds: [101] }] }],
  mainText: [{ value: { own: false }, sources: [{ source: "catalog", ruleName: null, productVariantIds: [101] }] }],
};
const PICK: ProductSettingsChoices = { ...emptyChoices(), shippingPolicy: { mode: "set", value: { id: "F9" } }, returnPolicy: { mode: "default" } };
const SENT: ProductSettingsSaveBody = { idempotencyKey: "ls-product:1", expectedRevisionId: 5, patch: { shippingPolicy: { id: "F9" }, returnPolicy: null } };
const ANSWER = { outcome: "changed", productId: PRODUCT, revisionId: 6, sizes: [], clearedSizeCount: 0 };

function settingsDraft(choices: ProductSettingsChoices = PICK): ListingSettingsDraft {
  const opened = reduceListingSettingsDraft(null, { type: "open", editor: EDITOR, place: "Easy Glide Soft Sleeves", base: productSettingsDraftValue(OWN) });
  return reduceListingSettingsDraft(opened, { type: "edit", value: productSettingsDraftValue(OWN, choices) })!;
}

/** The provider's two save calls on the real reducer, minting keys `ls-product:1`, `:2`… */
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

function setup(overrides: Partial<ProductSettingsSaveRun> = {}, start: ListingSettingsDraft = settingsDraft()) {
  const drafts = reducerDrafts(start);
  const sent: ProductSettingsSaveBody[] = [];
  const callbacks = { onSaveStarted: vi.fn(), onSaveSettled: vi.fn() };
  const answers: Array<unknown | Error> = [];
  const send = vi.fn(async (body: ProductSettingsSaveBody) => {
    sent.push(body);
    const next = answers.length > 0 ? answers.shift() : ANSWER;
    if (next instanceof Error) throw next;
    return next;
  });
  const input: ProductSettingsSaveRun = {
    storeConnectionId: STORE, productId: PRODUCT, storeName: "Marz Cards",
    draft: drafts.current(), drafts, callbacks, send,
    reread: vi.fn(async () => undefined),
    onSettingsSaved: vi.fn(), onBlocked: vi.fn(),
    ...overrides,
  };
  /** Save, or Check again, on the draft as it is now. */
  const save = () => runProductSettingsSave({ ...input, draft: drafts.current() });
  return { input, drafts, sent, callbacks, answers, send, save };
}

const apiError = (status: number, code: string | null, context?: Record<string, unknown>, message = "Server words.") =>
  new DropshipApiError({ status, code, message, context });

describe("the W5 request", () => {
  it("puts one product's save under the store's listing settings", () => {
    expect(productSettingsEndpoint(STORE, PRODUCT)).toBe("/api/dropship/listings/stores/22/listing-settings/products/11");
  });

  it("checks an answer against its contract, for this product only", () => {
    expect(readSavedProductSettings(ANSWER, PRODUCT)).toEqual(ANSWER);
    expect(readSavedProductSettings({ outcome: "replayed", productId: PRODUCT, revisionId: 6, sizes: [], clearedSizeCount: null }, PRODUCT).outcome).toBe("replayed");
    for (const bad of [{ ...ANSWER, extra: 1 }, { ...ANSWER, outcome: "replayed" }, { ...ANSWER, revisionId: 0 }, null]) {
      expect(() => readSavedProductSettings(bad, PRODUCT)).toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_OFF_CONTRACT" }));
    }
    expect(() => readSavedProductSettings({ ...ANSWER, productId: 12 }, PRODUCT))
      .toThrow(expect.objectContaining({ context: expect.objectContaining({ write: "W5", issues: [{ path: "productId", code: "other_product" }] }) }));
  });

  it("reads the detail and the own settings again, cancelling reads in flight first (D9)", async () => {
    const calls: string[] = [];
    const client = {
      cancelQueries: vi.fn(async ({ queryKey }: { queryKey: readonly unknown[] }) => { calls.push(`cancel ${String(queryKey[3])}`); }),
      fetchQuery: vi.fn(async ({ queryKey }: { queryKey: readonly unknown[] }) => {
        calls.push(`fetch ${String(queryKey[3])}`);
        return queryKey[3] === "product-own" ? OWN : { settings: DETAIL_SETTINGS };
      }),
    } as unknown as ProductSettingsQueryClient & { fetchQuery: ReturnType<typeof vi.fn>; cancelQueries: ReturnType<typeof vi.fn> };
    await expect(rereadProductSettings(client, STORE, PRODUCT)).resolves.toEqual({ detail: { settings: DETAIL_SETTINGS }, own: OWN });
    expect(calls).toEqual(["cancel product", "cancel product-own", "fetch product", "fetch product-own"]);
    expect(client.cancelQueries).toHaveBeenCalledWith({ queryKey: [...listingSettingsQueryKey(STORE), "product-own", PRODUCT], exact: true });
    expect(client.fetchQuery).toHaveBeenCalledWith(expect.objectContaining({
      queryKey: [...listingSettingsQueryKey(STORE), "product", PRODUCT], staleTime: 0, retry: false,
    }));

    const moved = own(6, "F3");
    let settings: unknown = DETAIL_SETTINGS;
    client.fetchQuery.mockImplementation(async ({ queryKey }: { queryKey: readonly unknown[] }) => (queryKey[3] === "product-own" ? moved : { settings }));
    const mine = productSettingsDraftValue(OWN, PICK);
    await expect(loadLatestProductSettings(client, STORE, PRODUCT, mine)).resolves.toMatchObject({
      edited: { expectedRevisionId: 6, shippingPolicy: { mode: "set", value: { id: "F9" } } }, marked: ["shippingPolicy"], keeps: true,
    });
    // Another window saved the same pick: nothing is left to keep, unless a size's leftover (in the detail read with it) still differs.
    const same = own(6, "F9");
    client.fetchQuery.mockImplementation(async ({ queryKey }: { queryKey: readonly unknown[] }) => (queryKey[3] === "product-own" ? same : { settings }));
    const pickOnly = productSettingsDraftValue(OWN, { ...emptyChoices(), shippingPolicy: { mode: "set", value: { id: "F9" } } });
    await expect(loadLatestProductSettings(client, STORE, PRODUCT, pickOnly)).resolves.toMatchObject({ keeps: false });
    settings = { ...DETAIL_SETTINGS, shippingPolicy: [
      { value: { policyId: "F9" }, sources: [{ source: "product", ruleName: null, productVariantIds: [101] }] },
      { value: { policyId: "F4" }, sources: [{ source: "size", ruleName: null, productVariantIds: [102] }] },
    ] };
    await expect(loadLatestProductSettings(client, STORE, PRODUCT, pickOnly)).resolves.toMatchObject({
      keeps: true, edited: { shippingPolicy: { mode: "set", value: { id: "F9" } } },
    });
    client.fetchQuery.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(loadLatestProductSettings(client, STORE, PRODUCT, mine)).rejects.toThrow("Failed to fetch");
  });
});

describe("runProductSettingsSave (plan 3.6)", () => {
  it("(1) sends ids only with the draft's ls-product key, re-reads, then tells the step", async () => {
    const run = setup();
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false });
    expect(run.sent).toEqual([SENT]);
    expect(saveProductSettingsInputSchema.safeParse(run.sent[0]).success).toBe(true);
    expect(run.input.reread).toHaveBeenCalledTimes(1);
    expect(run.input.onSettingsSaved).toHaveBeenCalledTimes(1);
    expect(run.callbacks.onSaveStarted).toHaveBeenCalledTimes(1);
    expect(run.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
    expect(run.drafts.current()).toMatchObject({ phase: "saved", changes: 0, attempt: null });
  });

  it("(2) a dropped answer, then Check again, resends the same key and body", async () => {
    const run = setup();
    run.answers.push(new TypeError("Failed to fetch"), { ...ANSWER, outcome: "replayed", clearedSizeCount: null });
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "uncertain", message: "We couldn't confirm your save." } });
    expect(run.drafts.current()).toMatchObject({ phase: "uncertain", changes: 2 });
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false });
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
    expect(run.drafts.current().attempt?.key).toBe("ls-product:1");
    await run.save();
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-product:1", "ls-product:1"]);
  });

  it("(5) after a refusal the next try gets a new key", async () => {
    const run = setup();
    run.answers.push(apiError(422, "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID", { invalidFields: ["shippingPolicy"] }));
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", fields: ["shippingPolicy"] } });
    expect(run.input.onBlocked).not.toHaveBeenCalled();
    await run.save();
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-product:1", "ls-product:2"]);
  });

  it("(6) calls a conflict a conflict", async () => {
    const run = setup();
    run.answers.push(apiError(409, "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", { conflicts: [{ productId: PRODUCT, expectedRevisionId: 5, actualRevisionId: 6 }] }));
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "conflict", message: "This changed in another window." } });
    expect(run.drafts.current()).toMatchObject({ phase: "conflict", attempt: null });
  });

  it("(7) still counts a save whose re-read failed, and says so", async () => {
    const run = setup({ reread: vi.fn(async () => { throw new TypeError("offline"); }) });
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: true });
    expect(run.drafts.current()).toMatchObject({ phase: "saved_view_stale", message: "Saved. We couldn't load the latest view." });
    expect(run.input.onSettingsSaved).toHaveBeenCalledTimes(1);
  });

  it("(8) counts an off-contract 2xx as saved with a stale view, and still reads the views again", async () => {
    for (const answer of [{ productId: PRODUCT }, { ...ANSWER, productId: 12 }, "ok"]) {
      const run = setup();
      run.answers.push(answer);
      await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: true });
      expect(run.input.reread).toHaveBeenCalledTimes(1);
      expect(run.drafts.current().phase).toBe("saved_view_stale");
    }
  });

  it("(9) sends nothing when there is no change, another action runs, or the draft can't take a save", async () => {
    const unchanged = setup();
    await expect(runProductSettingsSave({ ...unchanged.input, draft: settingsDraft(emptyChoices()) })).resolves.toEqual({ kind: "not_started", message: null });
    // Another product's draft is never sent as this one's.
    await expect(runProductSettingsSave({ ...unchanged.input, draft: { ...settingsDraft(), editor: productEditorId(12) } }))
      .resolves.toEqual({ kind: "not_started", message: null });
    expect(unchanged.callbacks.onSaveStarted).not.toHaveBeenCalled();

    const disabled = setup({ callbacks: { disabled: true, onSaveStarted: vi.fn(), onSaveSettled: vi.fn() } });
    await expect(disabled.save()).resolves.toEqual({ kind: "not_started", message: DRAWER_WORDS.busy });
    const refused = setup({ callbacks: { onSaveStarted: () => { throw new Error("Wait for the current listing action to finish."); }, onSaveSettled: vi.fn() } });
    await expect(refused.save()).resolves.toEqual({ kind: "not_started", message: "Wait for the current listing action to finish." });
    expect(refused.input.callbacks.onSaveSettled).not.toHaveBeenCalled();

    const saving = setup();
    saving.drafts.startSave("another request", "ls-product");
    await expect(saving.save()).resolves.toEqual({ kind: "not_started", message: null });
    for (const run of [disabled, refused, saving]) expect(run.send).not.toHaveBeenCalled();
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
    await expect(runProductSettingsSave({ ...run.input, draft: run.drafts.current(), drafts })).resolves.toEqual({
      kind: "failed",
      failure: { phase: "refused", message: WORDS.cantBuild, code: "DROPSHIP_LISTING_SETTINGS_PRODUCT_REQUEST_INVALID", status: null, fields: [] },
    });
    expect(run.send).not.toHaveBeenCalled();
    expect(run.callbacks.onSaveStarted).toHaveBeenCalledTimes(1);
    expect(run.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
    expect(run.drafts.current()).toMatchObject({ phase: "refused", message: WORDS.cantBuild, attempt: null, changes: 2 });
    expect(run.input.onBlocked).not.toHaveBeenCalled();
    // The refusal dropped the key: the next Save sends with a new one.
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false });
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-product:2"]);
  });

  it("(10) never sends twice while one save is in flight", async () => {
    const run = setup();
    let answer: (value: unknown) => void = () => undefined;
    run.send.mockImplementationOnce(async (body: ProductSettingsSaveBody) => {
      run.sent.push(body);
      return new Promise((resolve) => { answer = resolve; });
    });
    const first = run.save();
    await expect(run.save()).resolves.toEqual({ kind: "not_started", message: null });
    answer(ANSWER);
    await expect(first).resolves.toEqual({ kind: "saved", viewStale: false });
    expect(run.send).toHaveBeenCalledTimes(1);
  });

  it("(11) tells the busy answers apart by their reason (D7a)", async () => {
    const cases: Array<[Record<string, unknown> | undefined, WriteFailurePhase, string]> = [
      [{ reason: "heavy_write_in_progress", retryAfterSeconds: 5 }, "unreachable", WORDS.busyHeavy],
      [{ reason: "request_key_changed", retryAfterSeconds: 5 }, "unreachable", WORDS.busyKeyChanged],
      // A lost connection carries no public reason: it may follow a cut-off COMMIT.
      [undefined, "uncertain", "We couldn't confirm your save."],
    ];
    for (const [context, phase, message] of cases) {
      const run = setup();
      run.answers.push(apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY", context));
      await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase, message } });
      // Each keeps the key: nothing this send wrote, or it may have, and the replay answers it.
      expect(run.drafts.current().attempt?.key).toBe("ls-product:1");
    }
  });

  it("(12) a Check again answered busy, by eBay or by a rate limit stays unconfirmed (D7b)", async () => {
    const run = setup();
    run.answers.push(
      new TypeError("Failed to fetch"),
      apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "heavy_write_in_progress" }),
      apiError(502, "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE"),
      apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"),
      apiError(409, "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT"),
    );
    await run.save();
    for (const message of [WORDS.stillUnconfirmed, WORDS.stillUnconfirmed, WORDS.stillUnconfirmedRateLimited]) {
      await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "uncertain", message } });
      expect(run.drafts.current()).toMatchObject({ phase: "uncertain", attempt: { key: "ls-product:1" } });
      expect(run.drafts.current().message).not.toContain("Nothing was saved");
    }
    // An answer that says what happened stands.
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "conflict" } });
    expect(new Set(run.sent.map((body) => body.idempotencyKey))).toEqual(new Set(["ls-product:1"]));
    expect(run.input.onBlocked).not.toHaveBeenCalled();
    // The same answers to a first send are not doubted.
    const fresh = setup();
    fresh.answers.push(apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "heavy_write_in_progress" }));
    await expect(fresh.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "unreachable", message: WORDS.busyHeavy } });
  });

  it("(12) a Check again the write gate refuses stays unconfirmed with its key, and the banner still learns of it (D7b)", async () => {
    // The gate runs before the replay probe, so it says nothing about the first send.
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
      expect(run.drafts.current()).toMatchObject({ phase: "uncertain", attempt: { key: "ls-product:1" } });
      expect(run.drafts.current().message).not.toContain("Nothing was saved");
      expect(run.input.onBlocked).toHaveBeenCalledWith(blocked);
      // Check again later resends the same request, and the replay answers it.
      await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false });
      expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-product:1", "ls-product:1", "ls-product:1"]);
    }
    // eBay's sign-in is asked only for a key not used yet, so it shows nothing was saved: it stands.
    const signIn = setup();
    signIn.answers.push(new TypeError("Failed to fetch"), apiError(403, "DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED", { fields: ["shippingPolicy"] }));
    await signIn.save();
    await expect(signIn.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "blocked", message: "Nothing was saved." } });
    expect(signIn.drafts.current().attempt).toBeNull();
    // The gate on a first send is a block as before.
    const fresh = setup();
    fresh.answers.push(apiError(403, "DROPSHIP_LISTING_VENDOR_BLOCKED", { reason: "paused" }));
    await expect(fresh.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "blocked", message: "Nothing was saved." } });
  });

  it("(13) the three fatal codes are final: refused, a new key next time, never Check again (D7c)", async () => {
    for (const code of ["DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE", "DROPSHIP_LISTING_PRICE_INVARIANT_FAILED"]) {
      const run = setup();
      run.answers.push(apiError(500, code, undefined, "Something went wrong. We couldn't confirm your save."));
      await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", message: WORDS.fatal, code } });
      expect(run.drafts.current()).toMatchObject({ phase: "refused", attempt: null, changes: 2 });
      await run.save();
      expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-product:1", "ls-product:2"]);
    }
  });
});

/**
 * Every code W5's routes answer, through the runner (plan 3.3 rows 1-23, 4.7):
 * [status, code, context, phase, words (null: the server's), fields, key kept].
 */
const SHIPPING_SETUP = (code: string) => `Card Shellz is finishing shipping setup for your store, so this can't be saved yet. Reference: ${code}`;
const SHIPPING_OUTAGE = (code: string) => `Can't check Card Shellz shipping right now. Try again in a few minutes. Reference: ${code}`;
const EBAY_DOWN = "Can't reach eBay right now. Nothing was saved. Try again.";
const UNCONFIRMED = "We couldn't confirm your save.";
type Row = readonly [number, string | null, Record<string, unknown> | undefined, WriteFailurePhase, string | null, readonly string[]];

const W5_ROWS: readonly Row[] = [
  [429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED", undefined, "rate_limited", LISTING_SETTINGS_SAVE_WORDS.rateLimited, []],
  [401, "DROPSHIP_AUTH_REQUIRED", undefined, "refused", WORDS.signedOut, []],
  [503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "heavy_write_in_progress" }, "unreachable", WORDS.busyHeavy, []],
  [503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "request_key_changed" }, "unreachable", WORDS.busyKeyChanged, []],
  [503, "DROPSHIP_LISTING_SETTINGS_BUSY", undefined, "uncertain", UNCONFIRMED, []],
  [503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "unknown_reason" }, "uncertain", UNCONFIRMED, []],
  [503, "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE", { retryable: true }, "unreachable", SHIPPING_OUTAGE("DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE"), []],
  [502, "DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_UNAVAILABLE", { retryable: true }, "unreachable", SHIPPING_OUTAGE("DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_UNAVAILABLE"), []],
  [502, "DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_INVALID_RESPONSE", undefined, "unreachable", SHIPPING_SETUP("DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_INVALID_RESPONSE"), []],
  [502, "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE", undefined, "unreachable", EBAY_DOWN, []],
  [502, "DROPSHIP_EBAY_STORE_CATEGORIES_INVALID_RESPONSE", undefined, "unreachable", EBAY_DOWN, []],
  [502, "DROPSHIP_EBAY_MANAGED_LOCATION_UNAVAILABLE", undefined, "unreachable", EBAY_DOWN, []],
  // Every other coded 502 the write routes list (dropship-listing-setting-write-errors.ts): eBay, before the write.
  ...[
    "DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE", "DROPSHIP_EBAY_CATEGORIES_INVALID_RESPONSE", "DROPSHIP_EBAY_LISTING_SETUP_INVALID_RESPONSE",
    "DROPSHIP_EBAY_MANAGED_LOCATION_INVALID_RESPONSE", "DROPSHIP_EBAY_MANAGED_LOCATION_CREATE_CONFLICT", "DROPSHIP_EBAY_STORE_CATEGORIES_UNAVAILABLE",
  ].map((code): Row => [502, code, undefined, "unreachable", EBAY_DOWN, []]),
  [503, "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", undefined, "unreachable", EBAY_DOWN, []],
  [503, "DROPSHIP_EBAY_REFRESH_LOCK_UNAVAILABLE", undefined, "unreachable", EBAY_DOWN, []],
  [503, "DROPSHIP_CREDENTIAL_CHANGED", undefined, "unreachable", EBAY_DOWN, []],
  [503, "DROPSHIP_EBAY_TOKEN_REFRESH_INVALID_RESPONSE", undefined, "unreachable", EBAY_DOWN, []],
  [503, "DROPSHIP_EBAY_OAUTH_NOT_CONFIGURED", undefined, "unreachable", EBAY_DOWN, []],
  // A gateway's answer with no code may follow a commit.
  [502, null, undefined, "uncertain", UNCONFIRMED, []],
  [503, null, undefined, "uncertain", UNCONFIRMED, []],
  [504, null, undefined, "uncertain", UNCONFIRMED, []],
  [500, "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", undefined, "refused", WORDS.fatal, []],
  [500, "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE", undefined, "refused", WORDS.fatal, []],
  [500, "DROPSHIP_LISTING_PRICE_INVARIANT_FAILED", undefined, "refused", WORDS.fatal, []],
  [500, "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", undefined, "uncertain", UNCONFIRMED, []],
  [409, "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", undefined, "conflict", "This changed in another window.", []],
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
  [422, "DROPSHIP_EBAY_CATEGORY_RULE_INVALID", { reason: "not_storable" }, "refused", WORDS.categoryGone, ["ebayCategory"]],
  [422, "DROPSHIP_EBAY_STORE_CATEGORY_INVALID", { reason: "not_found", invalidFields: ["storeShelf"] }, "refused", "That shelf is gone from your eBay store.", ["storeShelf"]],
  [422, "DROPSHIP_EBAY_STORE_CATEGORY_INVALID", { reason: "too_long" }, "refused", WORDS.shelfTooLong, ["storeShelf"]],
  // Too large is a refusal for a writer, never the banner (D8).
  [422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", { reason: "store_text_limit", textBytes: 30_000_100, maxTextBytes: 30_000_000 }, "refused", WORDS.storeTextLimit, []],
  [422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", undefined, "refused", null, []],
  [404, "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND", undefined, "refused", "This product isn't chosen for Marz Cards. Choose it in step 1.", []],
  // Codes this page's W5 can't get (row 22): refused, never unconfirmed.
  ...[
    [422, "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST"], [422, "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT"], [422, "DROPSHIP_PRICING_RULES_NOT_CONFIGURED"],
    [422, "DROPSHIP_LISTING_PRICE_RELEASE_LIMIT"], [409, "DROPSHIP_LISTING_PRICES_MOVED"], [409, "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT"],
    [404, "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE"], [409, "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT"],
    [409, "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT"], [422, "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE"],
    [404, "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND"], [404, "DROPSHIP_PRICING_REVIEW_NOT_FOUND"],
  ].map(([status, code]): Row => [status as number, code as string, undefined, "refused", WORDS.invalid, []]),
  // Anything else: the server's words.
  [418, null, undefined, "refused", null, []],
  [401, "DROPSHIP_SESSION_ODD", undefined, "refused", null, []],
  [422, "DROPSHIP_SOMETHING_NEW", undefined, "refused", null, []],
];

const KEY_KEPT: ReadonlySet<WriteFailurePhase> = new Set(["uncertain", "unreachable", "rate_limited"]);

describe("W5's answers, code by code, through the runner (plan 3.3, 4.7)", () => {
  it.each(W5_ROWS.map((row) => [row[0], row[1] ?? "no code", row] as const))("%i %s", async (_status, _code, row) => {
    const [status, code, context, phase, words, fields] = row;
    const error = apiError(status, code, context);
    const run = setup();
    run.answers.push(error);
    const outcome = await run.save();
    expect(outcome).toEqual({ kind: "failed", failure: { phase, message: words ?? "Server words.", code, status, fields } });
    expect(run.drafts.current()).toMatchObject({ phase, changes: 2, message: words ?? "Server words." });
    expect(run.drafts.current().attempt?.key ?? null).toBe(KEY_KEPT.has(phase) ? "ls-product:1" : null);
    // Only a block goes to the banner; a refusal (too large included) never does (D8).
    expect(run.input.onBlocked).toHaveBeenCalledTimes(phase === "blocked" ? 1 : 0);
    if (phase === "blocked") expect(run.input.onBlocked).toHaveBeenCalledWith(error);
    expect(run.input.onSettingsSaved).not.toHaveBeenCalled();
    // Words never carry a raw code, except Card Shellz shipping's reference for support.
    const spoken = (words ?? "Server words.").replace(/ Reference: DROPSHIP_[A-Z_]+$/, "");
    expect(spoken).not.toMatch(/DROPSHIP_|[a-z]+_[a-z_]+/);
  });

  it("a dropped connection is unconfirmed, with the same key", async () => {
    const run = setup();
    run.answers.push(new TypeError("Failed to fetch"));
    await expect(run.save()).resolves.toEqual({
      kind: "failed", failure: { phase: "uncertain", message: UNCONFIRMED, code: null, status: null, fields: [] },
    });
    expect(run.drafts.current().attempt?.key).toBe("ls-product:1");
  });
});

// ---------------------------------------------------------------------------
// 10b: the eBay category, the shelf and the text (plan 5.2-5.6)
// ---------------------------------------------------------------------------

describe("10b's fields through the runner (plan 5.4-5.6; 3.3 rows 19-21)", () => {
  /** A product with its own text above and main text, the main text written before Card Shellz changed the product. */
  const TEXTED = listingSettingsProductOwnSettingsSchema.parse({
    storeConnectionId: STORE, productId: PRODUCT, revisionId: 8,
    own: {
      price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null,
      textAbove: { mode: "own", text: "Ships in 1 day." }, textBelow: { mode: "own", text: "Thanks!" },
      mainText: { text: "Our own words.", needsCheck: true },
    },
    generatedAt: "2026-10-14T12:00:00.000Z",
  });
  const draftOn = (base: ProductOwnSettings, choices: Partial<ProductSettingsChoices>): ListingSettingsDraft => {
    const opened = reduceListingSettingsDraft(null, { type: "open", editor: EDITOR, place: "Easy Glide Soft Sleeves", base: productSettingsDraftValue(base) });
    return reduceListingSettingsDraft(opened, { type: "edit", value: productSettingsDraftValue(base, { ...emptyChoices(), ...choices }) })!;
  };

  it("sends the eBay category and shelves by id, text as the server stores it, None as none and the default as null", async () => {
    const run = setup({}, draftOn(TEXTED, {
      ebayCategory: { mode: "set", value: { categoryId: "183454", categoryName: "Card Sleeves" } },
      storeShelf: { mode: "set", value: { mode: "own", shelfIds: ["S2", "S1"] } },
      textAbove: { mode: "set", value: { mode: "own", text: "  Ships today.\r\n" } },
      textBelow: { mode: "set", value: { mode: "none" } },
      mainText: { mode: "default" },
    }));
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false });
    expect(run.sent).toEqual([{
      idempotencyKey: "ls-product:1", expectedRevisionId: 8,
      patch: {
        ebayCategory: { categoryId: "183454" },
        storeShelf: { mode: "own", shelfIds: ["S2", "S1"] },
        textAbove: { mode: "own", text: "Ships today." },
        textBelow: { mode: "none" },
        mainText: null,
      },
    }]);
    expect(saveProductSettingsInputSchema.safeParse(run.sent[0]).success).toBe(true);
    // Never a name, a catalog hash or a price (D1, P13).
    expect(JSON.stringify(run.sent[0])).not.toMatch(/Card Sleeves|catalogHash|price|sizePrices|expectedPrices/);
  });

  it("sends Use default as null for the eBay category, the shelf and text above: the choice a sign-in leaves (D4, review T2)", async () => {
    const owned = listingSettingsProductOwnSettingsSchema.parse({ ...TEXTED, own: { ...TEXTED.own,
      ebayCategory: { categoryId: "183454", categoryName: "Card Sleeves" },
      storeShelf: { mode: "own", shelves: [{ id: "S1", name: "Sleeves" }] } } });
    const run = setup({}, draftOn(owned, { ebayCategory: { mode: "default" }, storeShelf: { mode: "default" }, textAbove: { mode: "default" } }));
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false });
    expect(run.sent).toEqual([{ idempotencyKey: "ls-product:1", expectedRevisionId: 8, patch: { ebayCategory: null, storeShelf: null, textAbove: null } }]);
    expect(saveProductSettingsInputSchema.safeParse(run.sent[0]).success).toBe(true);
  });

  it("[Keep my text] resends the same text, so the server checks it against the product as it is now (5.4, A2)", async () => {
    const check = ownTextCheckChoices(TEXTED)!;
    const action = productSettingsEditAction({ draft: null, editor: EDITOR, own: TEXTED, field: "mainText", choice: check.keep! });
    expect(action.kind).toBe("start");
    if (action.kind !== "start") return;
    const opened = reduceListingSettingsDraft(null, { type: "open", editor: EDITOR, place: "Easy Glide Soft Sleeves", base: action.base });
    const run = setup({}, reduceListingSettingsDraft(opened, { type: "edit", value: action.value })!);
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false });
    expect(run.sent).toEqual([{ idempotencyKey: "ls-product:1", expectedRevisionId: 8, patch: { mainText: { text: "Our own words." } } }]);
  });

  it("refuses text over its limit before sending: nothing is sent, and the next try gets a new key", async () => {
    for (const choices of [
      { textAbove: { mode: "set", value: { mode: "own", text: "x".repeat(4_001) } } },
      { textBelow: { mode: "set", value: { mode: "own", text: "x".repeat(4_001) } } },
      { mainText: { mode: "set", value: { text: "x".repeat(20_001) } } },
      // Over as typed with a CRLF, though stored it would be at the limit (review T1).
      { textAbove: { mode: "set", value: { mode: "own", text: `${"x".repeat(1_999)}\r\n${"x".repeat(2_000)}` } } },
      { mainText: { mode: "set", value: { text: `${"x".repeat(9_999)}\r\n${"x".repeat(10_000)}` } } },
    ] as Array<Partial<ProductSettingsChoices>>) {
      const run = setup({}, draftOn(TEXTED, choices));
      await expect(run.save()).resolves.toEqual({
        kind: "failed", failure: { phase: "refused", message: WORDS.cantBuild, code: PRODUCT_SETTINGS_REQUEST_INVALID, status: null, fields: [] },
      });
      expect(run.send).not.toHaveBeenCalled();
      expect(run.drafts.current().attempt).toBeNull();
    }
    // At the limit it is sent: text above or below at 4,000, the main text at 20,000 (review T1).
    const atLimit = setup({}, draftOn(TEXTED, { textAbove: { mode: "set", value: { mode: "own", text: "x".repeat(4_000) } } }));
    await expect(atLimit.save()).resolves.toEqual({ kind: "saved", viewStale: false });
    const mainAtLimit = setup({}, draftOn(TEXTED, { mainText: { mode: "set", value: { text: "x".repeat(20_000) } } }));
    await expect(mainAtLimit.save()).resolves.toEqual({ kind: "saved", viewStale: false });
    expect(mainAtLimit.sent[0]).toMatchObject({ patch: { mainText: { text: "x".repeat(20_000) } } });
  });

  it("lands eBay's category and shelf refusals on their fields, and the store text cap on words, never the banner (rows 19-21, D8)", async () => {
    const cases: Array<[Partial<ProductSettingsChoices>, DropshipApiError, string, string[]]> = [
      [{ ebayCategory: { mode: "set", value: { categoryId: "99" } } },
        apiError(422, "DROPSHIP_EBAY_CATEGORY_RULE_INVALID", { reason: "not_leaf", invalidFields: ["ebayCategory"] }), "Pick a final eBay category.", ["ebayCategory"]],
      [{ ebayCategory: { mode: "set", value: { categoryId: "99" } } },
        apiError(422, "DROPSHIP_EBAY_CATEGORY_RULE_INVALID", { reason: "not_found", invalidFields: ["ebayCategory"] }), WORDS.categoryGone, ["ebayCategory"]],
      [{ storeShelf: { mode: "set", value: { mode: "own", shelfIds: ["S9"] } } },
        apiError(422, "DROPSHIP_EBAY_STORE_CATEGORY_INVALID", { reason: "not_found", invalidFields: ["storeShelf"] }), "That shelf is gone from your eBay store.", ["storeShelf"]],
      [{ storeShelf: { mode: "set", value: { mode: "own", shelfIds: ["S9"] } } },
        apiError(422, "DROPSHIP_EBAY_STORE_CATEGORY_INVALID", { reason: "too_long", invalidFields: ["storeShelf"] }), WORDS.shelfTooLong, ["storeShelf"]],
      [{ textAbove: { mode: "set", value: { mode: "own", text: "Longer words." } } },
        apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", { reason: "store_text_limit", textBytes: 30_000_100, maxTextBytes: 30_000_000 }), WORDS.storeTextLimit, []],
    ];
    for (const [choices, error, words, fields] of cases) {
      const run = setup({}, draftOn(TEXTED, choices));
      run.answers.push(error);
      await expect(run.save()).resolves.toEqual({ kind: "failed", failure: { phase: "refused", message: words, code: error.code, status: 422, fields } });
      expect(run.input.onBlocked).not.toHaveBeenCalled();
      expect(run.drafts.current()).toMatchObject({ phase: "refused", changes: 1, attempt: null });
    }
  });
});
