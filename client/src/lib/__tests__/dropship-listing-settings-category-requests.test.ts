import { describe, expect, it, vi } from "vitest";
import { saveCategorySettingsInputSchema, type SaveCategorySettingsResponse } from "@shared/dropship/listing-setting-writes";
import { listingSettingsCategoryDetailSchema, type ListingSettingsCategoryDetail } from "@shared/dropship/listing-settings";
import { DropshipApiError } from "../dropship-ops-surface";
import { listingSettingsQueryKey } from "../dropship-listing-settings";
import {
  categoryEditorId,
  LISTING_SETTINGS_SAVE_WORDS,
  nextSaveAttempt,
  productEditorId,
  reduceListingSettingsDraft,
  type ListingSettingsDraft,
  type WriteFailurePhase,
} from "../dropship-listing-settings-drafts";
import { DRAWER_WORDS } from "../dropship-listing-settings-drawer";
import {
  CATEGORY_REQUEST_INVALID,
  categoryDraftValue,
  emptyCategoryChoices,
  readCategoryDraft,
  type CategoryChoices,
  type CategorySaveBody,
} from "../dropship-listing-settings-categories";
import {
  categoryFailureFollowUp,
  categorySettingsEndpoint,
  loadLatestCategory,
  readSavedCategorySettings,
  reloadAfterCategorySave,
  rereadAfterCategorySave,
  rereadCategoryCard,
  rereadCategoryDetail,
  runCategorySettingsSave,
  type CategorySaveQueryClient,
  type CategorySettingsSaveRun,
} from "../dropship-listing-settings-category-requests";
import type { ProductSettingsSaveDrafts } from "../dropship-listing-settings-product-requests";
import { LISTING_SETTINGS_BULK_WORDS, LISTING_SETTINGS_CATEGORY_WORDS, LISTING_SETTINGS_EDIT_WORDS } from "../dropship-listing-settings-words";

/** W12 from the category editor (plan PR 10, 8.5, 8.6, 3.3, 3.6). */

const STORE = 22;
const CATEGORY = 40;
const WORDS = LISTING_SETTINGS_EDIT_WORDS;
const GENERATED_AT = "2026-10-07T12:00:00.000Z";

const DETAIL: ListingSettingsCategoryDetail = listingSettingsCategoryDetailSchema.parse({
  storeConnectionId: STORE, categoryId: CATEGORY, name: "Sleeves", productCount: 15, revisionId: 7,
  settings: {
    price: { source: "none", value: null },
    ebayCategory: { source: "none", value: null },
    storeShelf: { source: "store_default", value: { mode: "none" } },
    shippingPolicy: { source: "category", value: { id: "F2", name: "Fast Free" } },
    returnPolicy: { source: "store_default", value: { id: "R1", name: null } },
    paymentPolicy: { source: "none", value: null },
    textAbove: { source: "none", value: null },
    textBelow: { source: "none", value: null },
  },
  ownValues: [{ productId: 12, revisionId: null, fields: ["shippingPolicy"] }, { productId: 11, revisionId: 5, fields: ["shippingPolicy", "storeShelf"] }],
  examples: [],
  generatedAt: GENERATED_AT,
});

const PICK: Partial<CategoryChoices> = { shippingPolicy: { mode: "set", value: { id: "F1" } }, returnPolicy: { mode: "set", value: { id: "R2" } } };
const SENT: CategorySaveBody = {
  idempotencyKey: "ls-cat:1",
  expectedRevisionId: 7,
  patch: { shippingPolicy: { id: "F1" }, returnPolicy: { id: "R2" } },
  clear: { fields: ["shippingPolicy"], products: [{ productId: 11, expectedRevisionId: 5 }, { productId: 12, expectedRevisionId: null }] },
};
const ANSWER: SaveCategorySettingsResponse = { outcome: "changed", categoryId: CATEGORY, revisionId: 8, clearedProductCount: 2 };
const REPLAYED: SaveCategorySettingsResponse = { outcome: "replayed", categoryId: CATEGORY, revisionId: 8, clearedProductCount: null };
const UNCHANGED: SaveCategorySettingsResponse = { outcome: "unchanged", categoryId: CATEGORY, revisionId: 7, clearedProductCount: 0 };

function categoryDraft(choices: Partial<CategoryChoices> = PICK, clear: readonly ("shippingPolicy" | "storeShelf")[] = ["shippingPolicy"], detail = DETAIL): ListingSettingsDraft {
  const opened = reduceListingSettingsDraft(null, { type: "open", editor: categoryEditorId(CATEGORY), place: "Sleeves", base: categoryDraftValue(detail) });
  return reduceListingSettingsDraft(opened, { type: "edit", value: categoryDraftValue(detail, { ...emptyCategoryChoices(), ...choices }, clear) })!;
}

/** The provider's two save calls on the real reducer, minting keys `ls-cat:1`, `:2`… */
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

function setup(overrides: Partial<CategorySettingsSaveRun> = {}, start: ListingSettingsDraft = categoryDraft()) {
  const drafts = reducerDrafts(start);
  const sent: CategorySaveBody[] = [];
  const callbacks = { onSaveStarted: vi.fn(), onSaveSettled: vi.fn() };
  const answers: Array<unknown | Error> = [];
  const send = vi.fn(async (body: CategorySaveBody) => {
    sent.push(body);
    const next = answers.length > 0 ? answers.shift() : ANSWER;
    if (next instanceof Error) throw next;
    return next;
  });
  const input: CategorySettingsSaveRun = {
    storeConnectionId: STORE, categoryId: CATEGORY, categoryName: "Sleeves", draft: drafts.current(), drafts, callbacks, send,
    reread: vi.fn(async () => undefined),
    rereadCard: vi.fn(async () => undefined),
    onSettingsSaved: vi.fn(), onBlocked: vi.fn(),
    ...overrides,
  };
  /** Save, or Check again, on the draft as it is now. */
  const save = () => runCategorySettingsSave({ ...input, draft: drafts.current() });
  return { input, drafts, sent, callbacks, answers, send, save };
}

const apiError = (status: number, code: string | null, context?: Record<string, unknown>, message = "Server words.") =>
  new DropshipApiError({ status, code, message, context });

describe("the W12 request", () => {
  it("puts one category's save under the store's listing settings", () => {
    expect(categorySettingsEndpoint(STORE, CATEGORY)).toBe("/api/dropship/listings/stores/22/listing-settings/categories/40");
  });

  it("checks an answer against its contract, for this category only", () => {
    expect(readSavedCategorySettings(ANSWER, CATEGORY)).toEqual(ANSWER);
    expect(readSavedCategorySettings(REPLAYED, CATEGORY).outcome).toBe("replayed");
    expect(readSavedCategorySettings(UNCHANGED, CATEGORY).outcome).toBe("unchanged");
    expect(readSavedCategorySettings({ ...ANSWER, revisionId: null }, CATEGORY).revisionId).toBeNull();
    for (const bad of [{ ...ANSWER, extra: 1 }, { ...ANSWER, outcome: "replayed" }, { ...REPLAYED, clearedProductCount: 1 }, { ...UNCHANGED, clearedProductCount: 1 }, { outcome: "changed" }, null, "ok"]) {
      expect(() => readSavedCategorySettings(bad, CATEGORY)).toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_OFF_CONTRACT" }));
    }
    expect(() => readSavedCategorySettings(ANSWER, 41))
      .toThrow(expect.objectContaining({ context: expect.objectContaining({ write: "W12", categoryId: 41, issues: [{ path: "categoryId", code: "other_category" }] }) }));
  });

  it("reads the list, the detail, every Products page and the summary again after a save, the products' own reads too when it cleared (D9)", async () => {
    const calls: string[] = [];
    const client = {
      cancelQueries: vi.fn(async ({ queryKey }: { queryKey: readonly unknown[] }) => { calls.push(`cancel ${String(queryKey[3])}`); }),
      invalidateQueries: vi.fn(async ({ queryKey }: { queryKey: readonly unknown[] }) => { calls.push(`invalidate ${String(queryKey[3])}`); }),
      fetchQuery: vi.fn(async ({ queryKey }: { queryKey: readonly unknown[] }) => { calls.push(`fetch ${String(queryKey[3])}:${String(queryKey[4])}`); return DETAIL; }),
    };
    const typed = client as unknown as CategorySaveQueryClient;
    await rereadAfterCategorySave(typed, STORE, CATEGORY, { clearedProducts: false });
    expect(calls).toEqual(["cancel categories", "cancel products", "cancel summary", "cancel category", "invalidate categories", "invalidate products", "invalidate summary", "fetch category:40"]);
    for (const read of ["categories", "products", "summary"]) {
      expect(client.cancelQueries).toHaveBeenCalledWith({ queryKey: [...listingSettingsQueryKey(STORE), read] });
      expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: [...listingSettingsQueryKey(STORE), read] }, { throwOnError: true });
    }
    expect(client.cancelQueries).toHaveBeenCalledWith({ queryKey: [...listingSettingsQueryKey(STORE), "category", CATEGORY], exact: true });
    expect(client.fetchQuery).toHaveBeenCalledWith(expect.objectContaining({ queryKey: [...listingSettingsQueryKey(STORE), "category", CATEGORY], staleTime: 0, retry: false }));
    calls.length = 0;
    await rereadAfterCategorySave(typed, STORE, CATEGORY, { clearedProducts: true });
    expect(calls).toEqual([
      "cancel categories", "cancel products", "cancel summary", "cancel product-own", "cancel product", "cancel category",
      "invalidate categories", "invalidate products", "invalidate summary", "invalidate product-own", "invalidate product", "fetch category:40",
    ]);
    // A failed refetch or detail read is a failed re-read.
    client.invalidateQueries.mockRejectedValueOnce(new TypeError("offline"));
    await expect(rereadAfterCategorySave(typed, STORE, CATEGORY, { clearedProducts: false })).rejects.toThrow("offline");
    client.fetchQuery.mockRejectedValueOnce(new TypeError("offline"));
    await expect(rereadAfterCategorySave(typed, STORE, CATEGORY, { clearedProducts: false })).rejects.toThrow("offline");
    // The card after a refusal it must learn of: the summary and the list.
    calls.length = 0;
    await rereadCategoryCard(typed, STORE);
    expect(calls).toEqual(["cancel summary", "cancel categories", "invalidate summary", "invalidate categories"]);
  });

  it("Reload after a stale view reads the same views again, the products' too only when the saved request named any (D9)", async () => {
    const calls: string[] = [];
    const client = {
      cancelQueries: vi.fn(async () => undefined),
      invalidateQueries: vi.fn(async ({ queryKey }: { queryKey: readonly unknown[] }) => { calls.push(String(queryKey[3])); }),
      fetchQuery: vi.fn(async () => DETAIL),
    } as unknown as CategorySaveQueryClient;
    // The draft after a save with "Also clear theirs" ticked: the reducer keeps the saved value as the base.
    const saving = reduceListingSettingsDraft(categoryDraft(), { type: "startSave", attempt: { signature: "s", key: "ls-cat:1" } });
    const cleared = reduceListingSettingsDraft(saving, { type: "saved", key: "ls-cat:1", nowMs: 1_000, viewStale: true });
    await reloadAfterCategorySave(client, STORE, CATEGORY, cleared);
    expect(calls).toEqual(["categories", "products", "summary", "product-own", "product"]);
    calls.length = 0;
    const noClear = reduceListingSettingsDraft(reduceListingSettingsDraft(categoryDraft(PICK, []), { type: "startSave", attempt: { signature: "s", key: "ls-cat:2" } }), { type: "saved", key: "ls-cat:2", nowMs: 1_000, viewStale: true });
    await reloadAfterCategorySave(client, STORE, CATEGORY, noClear);
    expect(calls).toEqual(["categories", "products", "summary"]);
    // No draft, or another editor's: the list reads alone.
    for (const draft of [null, reduceListingSettingsDraft(null, { type: "open", editor: productEditorId(11), place: "Penny Sleeves", base: {} })]) {
      calls.length = 0;
      await reloadAfterCategorySave(client, STORE, CATEGORY, draft);
      expect(calls).toEqual(["categories", "products", "summary"]);
    }
    (client.fetchQuery as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError("offline"));
    await expect(reloadAfterCategorySave(client, STORE, CATEGORY, cleared)).rejects.toThrow("offline");
  });

  it("Load latest reads the detail again, fresh, and keeps the vendor's choices on it (plan 8.6)", async () => {
    const latest = listingSettingsCategoryDetailSchema.parse({
      ...DETAIL, revisionId: 9,
      settings: { ...DETAIL.settings, shippingPolicy: { source: "category", value: { id: "F3", name: "Slow" } } },
      ownValues: [{ productId: 11, revisionId: 6, fields: ["shippingPolicy"] }],
    });
    const client = { cancelQueries: vi.fn(async () => undefined), fetchQuery: vi.fn(async () => latest) };
    await expect(rereadCategoryDetail(client as never, STORE, CATEGORY)).resolves.toBe(latest);
    expect(client.cancelQueries).toHaveBeenCalledWith({ queryKey: [...listingSettingsQueryKey(STORE), "category", CATEGORY], exact: true });
    expect(client.fetchQuery).toHaveBeenCalledWith(expect.objectContaining({ staleTime: 0, retry: false }));
    const mine = readCategoryDraft(categoryDraft().value)!;
    const reload = await loadLatestCategory(client as never, STORE, CATEGORY, mine);
    expect(reload).toMatchObject({
      keeps: true, marked: ["shippingPolicy"],
      edited: { expectedRevisionId: 9, shippingPolicy: { mode: "set", value: { id: "F1" } }, returnPolicy: { mode: "set", value: { id: "R2" } }, clear: ["shippingPolicy"], ownValues: [{ productId: 11, revisionId: 6 }] },
      latest: { expectedRevisionId: 9, shippingPolicy: { mode: "leave" }, clear: [] },
    });
    client.fetchQuery.mockRejectedValueOnce(new TypeError("offline"));
    await expect(loadLatestCategory(client as never, STORE, CATEGORY, mine)).rejects.toThrow("offline");
  });

  it("says what follows a failure: Load latest after a conflict, the card after older rules, close after a gone category, else nothing", () => {
    expect(categoryFailureFollowUp({ phase: "conflict", code: "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT" })).toBe("load_latest");
    expect(categoryFailureFollowUp({ phase: "conflict", code: "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT" })).toBe("load_latest");
    expect(categoryFailureFollowUp({ phase: "refused", code: "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT" })).toBe("reread_card");
    expect(categoryFailureFollowUp({ phase: "refused", code: "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND" })).toBe("close");
    for (const failure of [
      { phase: "refused" as const, code: "DROPSHIP_IDEMPOTENCY_CONFLICT" }, { phase: "uncertain" as const, code: null }, { phase: "blocked" as const, code: "DROPSHIP_LISTING_STORE_BLOCKED" },
      { phase: "unreachable" as const, code: "DROPSHIP_LISTING_SETTINGS_BUSY" }, { phase: "rate_limited" as const, code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED" },
    ]) expect(categoryFailureFollowUp(failure)).toBeNull();
  });
});

describe("runCategorySettingsSave (plan 3.6)", () => {
  it("(1) sends one PUT with the draft's ls-cat key, the detail's revision and clear set, no price, re-reads the cleared products' views too, then tells the step", async () => {
    const run = setup();
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false, clearedProductCount: 2 });
    expect(run.sent).toEqual([SENT]);
    expect(saveCategorySettingsInputSchema.safeParse(run.sent[0]).success).toBe(true);
    expect(JSON.stringify(run.sent[0])).not.toMatch(/price|mainText|Fast Free/);
    expect(run.input.reread).toHaveBeenCalledWith({ clearedProducts: true });
    expect(run.input.onSettingsSaved).toHaveBeenCalledTimes(1);
    expect(run.input.rereadCard).not.toHaveBeenCalled();
    expect(run.callbacks.onSaveStarted).toHaveBeenCalledTimes(1);
    expect(run.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
    expect(run.drafts.current()).toMatchObject({ phase: "saved", changes: 0, attempt: null });
  });

  it("(1) a save with nothing to clear sends no clear and re-reads the products' views only as the list", async () => {
    const run = setup({}, categoryDraft({ returnPolicy: { mode: "set", value: { id: "R2" } }, shippingPolicy: { mode: "default" } }, []));
    run.answers.push({ ...ANSWER, clearedProductCount: 0 });
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false, clearedProductCount: 0 });
    // "Use store default" on the category's own shipping policy is null; on the return policy the store already gives, it would be no change.
    expect(run.sent).toEqual([{ idempotencyKey: "ls-cat:1", expectedRevisionId: 7, patch: { shippingPolicy: null, returnPolicy: { id: "R2" } } }]);
    expect(run.sent[0]).not.toHaveProperty("clear");
    expect(run.input.reread).toHaveBeenCalledWith({ clearedProducts: false });
  });

  it("(1) a clear-only save resends the category's own value, and saves as unchanged on the category", async () => {
    const run = setup({}, categoryDraft({}, ["shippingPolicy"]));
    run.answers.push({ ...ANSWER, outcome: "changed", revisionId: 7, clearedProductCount: 2 });
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false, clearedProductCount: 2 });
    expect(run.sent).toEqual([{ idempotencyKey: "ls-cat:1", expectedRevisionId: 7, patch: { shippingPolicy: { id: "F2" } }, clear: SENT.clear }]);
  });

  it("(2) a dropped answer, then Check again, resends the same key and body; a replay re-reads the cleared products too", async () => {
    const run = setup();
    run.answers.push(new TypeError("Failed to fetch"), REPLAYED);
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "uncertain", message: "We couldn't confirm your save." }, followUp: null });
    expect(run.drafts.current()).toMatchObject({ phase: "uncertain", changes: 3 });
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false, clearedProductCount: null });
    expect(run.sent).toEqual([SENT, SENT]);
    expect(run.input.reread).toHaveBeenLastCalledWith({ clearedProducts: true });
  });

  it("(3) a block goes to the banner and the draft is kept", async () => {
    const blocked = apiError(403, "DROPSHIP_LISTING_STORE_BLOCKED", { reason: "paused" });
    const run = setup();
    run.answers.push(blocked);
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "blocked", message: "Nothing was saved." }, followUp: null });
    expect(run.input.onBlocked).toHaveBeenCalledWith(blocked);
    expect(run.drafts.current()).toMatchObject({ phase: "blocked", changes: 3, attempt: null });
    expect(run.input.onSettingsSaved).not.toHaveBeenCalled();
  });

  it("(4) a 429 keeps the key", async () => {
    const run = setup();
    run.answers.push(apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"));
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "rate_limited", message: LISTING_SETTINGS_SAVE_WORDS.rateLimited } });
    expect(run.drafts.current().attempt?.key).toBe("ls-cat:1");
    await run.save();
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-cat:1", "ls-cat:1"]);
  });

  it("(5) after a refusal the next try gets a new key", async () => {
    const run = setup();
    run.answers.push(apiError(422, "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID", { invalidFields: ["shippingPolicy"] }));
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", fields: ["shippingPolicy"] }, followUp: null });
    expect(run.input.onBlocked).not.toHaveBeenCalled();
    expect(run.input.rereadCard).not.toHaveBeenCalled();
    await run.save();
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-cat:1", "ls-cat:2"]);
  });

  it("(6) calls the category's conflict and the clear set's conflict a conflict, each in its words, with Load latest to follow (8.6)", async () => {
    const category = setup();
    category.answers.push(apiError(409, "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT", { categoryId: CATEGORY, expectedRevisionId: 7, actualRevisionId: 8 }));
    await expect(category.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "conflict", message: "This changed in another window." }, followUp: "load_latest" });
    expect(category.drafts.current()).toMatchObject({ phase: "conflict", attempt: null, changes: 3 });
    const products = setup();
    products.answers.push(apiError(409, "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", { conflicts: [{ productId: 12 }], conflictCount: 1 }));
    await expect(products.save()).resolves.toMatchObject({
      kind: "failed", followUp: "load_latest",
      failure: { phase: "conflict", message: "The products in Sleeves changed. Load the latest and save again. A Card Shellz change can take a minute to show." },
    });
  });

  it("(6) older rules refuse the save for good, in the D11 line, and the card is read again (8.6, D11)", async () => {
    const run = setup();
    run.answers.push(apiError(409, "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT", { pricingGroups: 1, contentGroups: 0, ebayCategoryRules: 0 }));
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", message: LISTING_SETTINGS_CATEGORY_WORDS.olderRules }, followUp: "reread_card" });
    expect(run.input.rereadCard).toHaveBeenCalledTimes(1);
    expect(run.drafts.current()).toMatchObject({ phase: "refused", attempt: null, changes: 3 });
    // A failed card read never hides the refusal.
    const failing = setup({ rereadCard: vi.fn(async () => { throw new TypeError("offline"); }) });
    failing.answers.push(apiError(409, "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT"));
    await expect(failing.save()).resolves.toMatchObject({ kind: "failed", followUp: "reread_card" });
    const none = setup({ rereadCard: undefined });
    none.answers.push(apiError(409, "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT"));
    await expect(none.save()).resolves.toMatchObject({ kind: "failed", followUp: "reread_card" });
  });

  it("(6) a category no chosen product is in any more is refused, the editor closes and the card is read again (8.6)", async () => {
    const run = setup();
    run.answers.push(apiError(404, "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND", { categoryId: CATEGORY }));
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", message: "No chosen product is in this category any more." }, followUp: "close" });
    expect(run.input.rereadCard).toHaveBeenCalledTimes(1);
    expect(run.input.onSettingsSaved).not.toHaveBeenCalled();
  });

  it("(7) still counts a save whose re-read failed, and says so", async () => {
    const run = setup({ reread: vi.fn(async () => { throw new TypeError("offline"); }) });
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: true, clearedProductCount: 2 });
    expect(run.drafts.current()).toMatchObject({ phase: "saved_view_stale", message: "Saved. We couldn't load the latest view." });
    expect(run.input.onSettingsSaved).toHaveBeenCalledTimes(1);
  });

  it("(8) counts an off-contract 2xx as saved with a stale view, and still reads the views again, the products' too when the request named any", async () => {
    for (const answer of [{ revisionId: 8 }, { ...ANSWER, categoryId: 41 }, { ...ANSWER, outcome: "replayed" }, "ok", null]) {
      const run = setup();
      run.answers.push(answer);
      await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: true, clearedProductCount: null });
      expect(run.input.reread).toHaveBeenCalledWith({ clearedProducts: true });
      expect(run.drafts.current().phase).toBe("saved_view_stale");
    }
    const noClear = setup({}, categoryDraft({ returnPolicy: { mode: "set", value: { id: "R2" } } }, []));
    noClear.answers.push("ok");
    await noClear.save();
    expect(noClear.input.reread).toHaveBeenCalledWith({ clearedProducts: false });
  });

  it("(9) sends nothing with no change, another editor's draft, another category's draft, another action running, or a save out", async () => {
    const unchanged = setup();
    await expect(runCategorySettingsSave({ ...unchanged.input, draft: categoryDraft({}, []) })).resolves.toEqual({ kind: "not_started", message: null });
    await expect(runCategorySettingsSave({ ...unchanged.input, draft: { ...categoryDraft(), editor: productEditorId(11) } })).resolves.toEqual({ kind: "not_started", message: null });
    await expect(runCategorySettingsSave({ ...unchanged.input, draft: { ...categoryDraft(), editor: categoryEditorId(41) } })).resolves.toEqual({ kind: "not_started", message: null });
    await expect(runCategorySettingsSave({ ...unchanged.input, draft: { ...categoryDraft(), value: { items: [] } } })).resolves.toEqual({ kind: "not_started", message: null });
    expect(unchanged.callbacks.onSaveStarted).not.toHaveBeenCalled();

    const disabled = setup({ callbacks: { disabled: true, onSaveStarted: vi.fn(), onSaveSettled: vi.fn() } });
    await expect(disabled.save()).resolves.toEqual({ kind: "not_started", message: DRAWER_WORDS.busy });
    const refused = setup({ callbacks: { onSaveStarted: () => { throw new Error("Wait for the current listing action to finish."); }, onSaveSettled: vi.fn() } });
    await expect(refused.save()).resolves.toEqual({ kind: "not_started", message: "Wait for the current listing action to finish." });
    expect(refused.input.callbacks.onSaveSettled).not.toHaveBeenCalled();

    const saving = setup();
    saving.drafts.startSave("another request", "ls-cat");
    await expect(saving.save()).resolves.toEqual({ kind: "not_started", message: null });
    for (const run of [unchanged, disabled, refused, saving]) expect(run.send).not.toHaveBeenCalled();
    expect(saving.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
  });

  it("(9) never sends a price change through W12: a draft holding one is the price check's, whatever else it holds (PR 10f, plan 9.2, 9.7)", async () => {
    const recipe = { basis: "catalog_retail" as const, markupBps: 2000, flatCents: 0, rounding: "up_99" as const };
    for (const price of [{ mode: "set" as const, value: recipe }]) {
      const opened = reduceListingSettingsDraft(null, { type: "open", editor: categoryEditorId(CATEGORY), place: "Sleeves", base: categoryDraftValue(DETAIL) });
      const priceOnly = reduceListingSettingsDraft(opened, { type: "edit", value: categoryDraftValue(DETAIL, emptyCategoryChoices(), [], { choice: price, check: null }) })!;
      const riding = reduceListingSettingsDraft(opened, { type: "edit", value: categoryDraftValue(DETAIL, { ...emptyCategoryChoices(), ...PICK }, ["shippingPolicy"], { choice: price, check: null }) })!;
      expect(priceOnly.changes).toBe(1);
      expect(riding.changes).toBe(4);
      for (const draft of [priceOnly, riding]) {
        const run = setup({}, draft);
        await expect(run.save()).resolves.toEqual({ kind: "not_started", message: null });
        expect(run.send).not.toHaveBeenCalled();
        expect(run.callbacks.onSaveStarted).not.toHaveBeenCalled();
        expect(run.drafts.current()).toMatchObject({ phase: "editing", attempt: null, changes: draft.changes });
      }
    }
  });

  it("(9) settles a body it can't build as refused, sends nothing, and the next try gets a new key", async () => {
    const run = setup();
    let tries = 0;
    // The first key, "x:1", is one the shared schema refuses (under 8 characters): that body is never built.
    const drafts: ProductSettingsSaveDrafts = {
      startSave: (signature, prefix) => run.drafts.startSave(signature, tries++ === 0 ? "x" : prefix),
      settle: run.drafts.settle,
    };
    await expect(runCategorySettingsSave({ ...run.input, draft: run.drafts.current(), drafts })).resolves.toEqual({
      kind: "failed",
      failure: { phase: "refused", message: WORDS.cantBuild, code: CATEGORY_REQUEST_INVALID, status: null, fields: [] },
      followUp: null,
    });
    expect(run.send).not.toHaveBeenCalled();
    expect(run.callbacks.onSaveStarted).toHaveBeenCalledTimes(1);
    expect(run.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
    expect(run.drafts.current()).toMatchObject({ phase: "refused", message: WORDS.cantBuild, attempt: null, changes: 3 });
    expect(run.input.onBlocked).not.toHaveBeenCalled();
    await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false, clearedProductCount: 2 });
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-cat:2"]);
  });

  it("(10) never sends twice while one save is in flight", async () => {
    const run = setup();
    let answer: (value: unknown) => void = () => undefined;
    run.send.mockImplementationOnce(async (body: CategorySaveBody) => {
      run.sent.push(body);
      return new Promise((resolve) => { answer = resolve; });
    });
    const first = run.save();
    await expect(run.save()).resolves.toEqual({ kind: "not_started", message: null });
    answer(ANSWER);
    await expect(first).resolves.toEqual({ kind: "saved", viewStale: false, clearedProductCount: 2 });
    expect(run.send).toHaveBeenCalledTimes(1);
  });

  it("(11) tells the busy answers apart by their reason (D7a): a clear is a heavy write", async () => {
    const cases: Array<[Record<string, unknown> | undefined, WriteFailurePhase, string]> = [
      [{ reason: "heavy_write_in_progress", retryAfterSeconds: 5 }, "unreachable", WORDS.busyHeavy],
      [{ reason: "request_key_changed", retryAfterSeconds: 5 }, "unreachable", WORDS.busyKeyChanged],
      [undefined, "uncertain", "We couldn't confirm your save."],
    ];
    for (const [context, phase, message] of cases) {
      const run = setup();
      run.answers.push(apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY", context));
      await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase, message } });
      expect(run.drafts.current().attempt?.key).toBe("ls-cat:1");
      // The same key next time: the gate refused before anything was written, or the replay answers it.
      await run.save();
      expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-cat:1", "ls-cat:1"]);
    }
  });

  it("(12) a Check again answered busy, by eBay or by a rate limit stays unconfirmed (D7b)", async () => {
    const run = setup();
    run.answers.push(
      new TypeError("Failed to fetch"),
      apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "heavy_write_in_progress" }),
      apiError(502, "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE"),
      apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"),
      apiError(409, "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT"),
    );
    await run.save();
    for (const message of [WORDS.stillUnconfirmed, WORDS.stillUnconfirmed, WORDS.stillUnconfirmedRateLimited]) {
      await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "uncertain", message } });
      expect(run.drafts.current()).toMatchObject({ phase: "uncertain", attempt: { key: "ls-cat:1" } });
      expect(run.drafts.current().message).not.toContain("Nothing was saved");
    }
    await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "conflict", message: "This changed in another window." } });
    expect(new Set(run.sent.map((body) => body.idempotencyKey))).toEqual(new Set(["ls-cat:1"]));
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
      expect(run.drafts.current()).toMatchObject({ phase: "uncertain", attempt: { key: "ls-cat:1" } });
      expect(run.input.onBlocked).toHaveBeenCalledWith(blocked);
      await expect(run.save()).resolves.toEqual({ kind: "saved", viewStale: false, clearedProductCount: 2 });
      expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-cat:1", "ls-cat:1", "ls-cat:1"]);
    }
    // The older-rules check runs after the replay probe (CC-C25): a Check again it refuses shows the first send saved nothing.
    const older = setup();
    older.answers.push(new TypeError("Failed to fetch"), apiError(409, "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT"));
    await older.save();
    await expect(older.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", message: LISTING_SETTINGS_CATEGORY_WORDS.olderRules }, followUp: "reread_card" });
    expect(older.drafts.current().attempt).toBeNull();
  });

  it("(13) the three fatal codes are final: refused, a new key next time, never Check again (D7c)", async () => {
    for (const code of ["DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE", "DROPSHIP_LISTING_PRICE_INVARIANT_FAILED"]) {
      const run = setup();
      run.answers.push(apiError(500, code, undefined, "Something went wrong. We couldn't confirm your save."));
      await expect(run.save()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", message: WORDS.fatal, code }, followUp: null });
      expect(run.drafts.current()).toMatchObject({ phase: "refused", attempt: null, changes: 3 });
      await run.save();
      expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-cat:1", "ls-cat:2"]);
    }
  });
});

/**
 * Every code W12's route answers, through the runner (plan 3.3 rows 1-23, 8.6):
 * [status, code, context, phase, words (null: the server's), fields].
 */
const SHIPPING_SETUP = (code: string) => `Card Shellz is finishing shipping setup for your store, so this can't be saved yet. Reference: ${code}`;
const SHIPPING_OUTAGE = (code: string) => `Can't check Card Shellz shipping right now. Try again in a few minutes. Reference: ${code}`;
const EBAY_DOWN = "Can't reach eBay right now. Nothing was saved. Try again.";
const UNCONFIRMED = "We couldn't confirm your save.";
const PRODUCTS_CHANGED = "The products in Sleeves changed. Load the latest and save again. A Card Shellz change can take a minute to show.";
type Row = readonly [number, string | null, Record<string, unknown> | undefined, WriteFailurePhase, string | null, readonly string[]];

const W12_ROWS: readonly Row[] = [
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
  // Plan 8.6: the category's conflict, the clear set's conflict, the older-rules backstop, the category gone, the text budget.
  [409, "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT", { categoryId: 40, expectedRevisionId: 7, actualRevisionId: 8 }, "conflict", "This changed in another window.", []],
  [409, "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", { conflicts: [{ productId: 12 }], conflictCount: 1 }, "conflict", PRODUCTS_CHANGED, []],
  [409, "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT", { pricingGroups: 0, contentGroups: 1, ebayCategoryRules: 0 }, "refused", LISTING_SETTINGS_CATEGORY_WORDS.olderRules, []],
  [404, "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND", { categoryId: 40 }, "refused", LISTING_SETTINGS_CATEGORY_WORDS.categoryNotFound, []],
  [422, "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", { textBytes: 30_008_000, maxTextBytes: 30_000_000, productCount: 2 }, "refused", LISTING_SETTINGS_BULK_WORDS.tooMuchText, []],
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
  // W12 asks eBay about an id the category doesn't store yet (D4): a sign-in is a block with its fields.
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
  [422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", { reason: "store_text_limit", textBytes: 30_000_100, maxTextBytes: 30_000_000 }, "refused", WORDS.storeTextLimit, []],
  [422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", undefined, "refused", null, []],
  // Codes this page's W12 can't get (row 22): refused, never unconfirmed and never a Load latest.
  ...[
    [422, "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST"], [422, "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT"], [422, "DROPSHIP_PRICING_RULES_NOT_CONFIGURED"],
    [422, "DROPSHIP_LISTING_PRICE_RELEASE_LIMIT"], [409, "DROPSHIP_LISTING_PRICES_MOVED"], [409, "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT"],
    [404, "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE"], [404, "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND"], [404, "DROPSHIP_PRICING_REVIEW_NOT_FOUND"],
  ].map(([status, code]): Row => [status as number, code as string, undefined, "refused", WORDS.invalid, []]),
  [418, null, undefined, "refused", null, []],
  [422, "DROPSHIP_SOMETHING_NEW", undefined, "refused", null, []],
];

const KEY_KEPT: ReadonlySet<WriteFailurePhase> = new Set(["uncertain", "unreachable", "rate_limited"]);
const CARD_REREAD_CODES: ReadonlySet<string> = new Set(["DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT", "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND"]);

describe("W12's answers, code by code, through the runner (plan 3.3, 8.6)", () => {
  it.each(W12_ROWS.map((row) => [row[0], row[1] ?? "no code", row] as const))("%i %s", async (_status, _code, row) => {
    const [status, code, context, phase, words, fields] = row;
    const error = apiError(status, code, context);
    const run = setup();
    run.answers.push(error);
    const outcome = await run.save();
    expect(outcome).toMatchObject({ kind: "failed", failure: { phase, message: words ?? "Server words.", code, status, fields } });
    expect(run.drafts.current()).toMatchObject({ phase, changes: 3, message: words ?? "Server words." });
    expect(run.drafts.current().attempt?.key ?? null).toBe(KEY_KEPT.has(phase) ? "ls-cat:1" : null);
    // Only a block goes to the banner; a refusal (both too-large codes included) never does (D8).
    expect(run.input.onBlocked).toHaveBeenCalledTimes(phase === "blocked" ? 1 : 0);
    expect(run.input.onSettingsSaved).not.toHaveBeenCalled();
    // The card learns of the two refusals it must (8.6), and of no other answer.
    expect(run.input.rereadCard).toHaveBeenCalledTimes(code !== null && CARD_REREAD_CODES.has(code) ? 1 : 0);
    expect(outcome.kind === "failed" && outcome.followUp).toBe(phase === "conflict" ? "load_latest" : code === "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT" ? "reread_card" : code === "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND" ? "close" : null);
    const spoken = (words ?? "Server words.").replace(/ Reference: DROPSHIP_[A-Z_]+$/, "");
    expect(spoken).not.toMatch(/DROPSHIP_|[a-z]+_[a-z_]+/);
  });

  it("a dropped connection is unconfirmed, with the same key", async () => {
    const run = setup();
    run.answers.push(new TypeError("Failed to fetch"));
    await expect(run.save()).resolves.toEqual({
      kind: "failed", failure: { phase: "uncertain", message: UNCONFIRMED, code: null, status: null, fields: [] }, followUp: null,
    });
    expect(run.drafts.current().attempt?.key).toBe("ls-cat:1");
  });
});
