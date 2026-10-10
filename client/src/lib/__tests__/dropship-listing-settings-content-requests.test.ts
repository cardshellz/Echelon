import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  ebayCategoryRulesStateSchema,
  saveEbayCategoryRulesInputSchema,
  type EbayCategoryRulesState,
} from "@shared/dropship/ebay-category-rules";
import {
  contentProfileStateSchema,
  saveContentProfileInputSchema,
  type ContentProfileState,
} from "@shared/dropship/listing-content";
import { ebayCategoryRulesEndpoint } from "../dropship-ebay-category-rules";
import {
  LISTING_SETTINGS_SAVE_WORDS,
  nextSaveAttempt,
  reduceListingSettingsDraft,
  type DraftValue,
  type EditorId,
  type ListingSettingsDraft,
} from "../dropship-listing-settings-drafts";
import { LISTING_SETTINGS_OFF_CONTRACT, ListingSettingsReadError } from "../dropship-listing-settings";
import { DropshipApiError } from "../dropship-ops-surface";
import {
  checkDescriptionDefaultAnswer,
  checkEbayCategoryDefaultAnswer,
  contentProfileQueryKey,
  DESCRIPTION_DEFAULT_WORDS,
  descriptionDefaultSaveInput,
  descriptionDefaultValue,
  descriptionLengthWords,
  EBAY_CATEGORY_DEFAULT_WORDS,
  ebayCategoryDefaultSaveInput,
  ebayCategoryDefaultValue,
  ebayCategoryRulesQueryKey,
  prepareDescriptionDefaultSave,
  prepareEbayCategoryDefaultSave,
  readDescriptionDefaultValue,
  readEbayCategoryDefaultValue,
  rereadStoreDefault,
  runStoreDefaultSave,
  settleConflictBeforeSending,
  STORE_DEFAULT_DESCRIPTION_INVALID,
  STORE_DEFAULT_EDITOR_WORDS,
  STORE_DEFAULT_OLDER_RULE_INVALID,
  STORE_DEFAULT_REQUEST_INVALID,
  storeDefaultBaseMoved,
  storeDefaultContentProfileQueryOptions,
  storeDefaultEbayCategoryCompactValue,
  storeDefaultEbayCategoryRulesQueryOptions,
  storeDefaultEditorFooter,
  StoreDefaultRequestError,
  type StoreDefaultSaveRun,
} from "../dropship-listing-settings-content-requests";

const UPDATED_AT = "2026-10-01T12:00:00.000Z";
const SLEEVES = { categoryId: "183435", categoryName: "Card Sleeves", path: ["Collectibles", "Trading Cards", "Card Sleeves"] };
const TOPLOADERS = { categoryId: "183436", categoryName: "Toploaders", path: ["Collectibles", "Trading Cards", "Toploaders"] };
const SUPPLIES = { categoryId: "261328", categoryName: "Card Supplies", path: ["Collectibles", "Card Supplies"] };

/** Three older rules in a deliberate order: order is precedence, so it must survive the save. */
const RULES_STATE: EbayCategoryRulesState = ebayCategoryRulesStateSchema.parse({
  revisionId: 7,
  updatedAt: UPDATED_AT,
  profile: {
    version: 1,
    defaultCategory: SLEEVES,
    rules: [
      { id: "toploaders", name: "Toploaders", scope: { type: "category", category: "Toploaders" }, category: TOPLOADERS },
      { id: "named_sizes", name: "Named sizes", scope: { type: "listings", productVariantIds: [12, 11] }, category: SUPPLIES },
      { id: "line_4", name: "Line four", scope: { type: "product_line", productLineId: 4 }, category: SLEEVES },
    ],
  },
});

const GROUPS = [
  { id: "envelopes", name: "Envelopes", priority: 10, scope: { type: "category", category: "Envelopes" },
    template: { introduction: "Ships flat.", footer: "Thanks for buying." } },
  { id: "named", name: "Named sizes", priority: 20, scope: { type: "listings", productVariantIds: [101, 102] },
    template: { introduction: "", footer: "Sold in packs." } },
];

const PROFILE_STATE: ContentProfileState = contentProfileStateSchema.parse({
  revisionId: 41,
  updatedAt: UPDATED_AT,
  profile: { defaultTemplate: { introduction: "Welcome.", footer: "" }, groups: GROUPS },
});

const EDITABLE = { editable: true } as const;
const NOT_EDITABLE = { editable: false } as const;
const signal = new AbortController().signal;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * The draft provider's save calls over the real reducer, as
 * ListingSettingsDraftsProvider wires them, with numbered request keys.
 */
function fakeDrafts(editor: EditorId, base: DraftValue, value: DraftValue) {
  let draft: ListingSettingsDraft | null = reduceListingSettingsDraft(null, { type: "open", editor, place: "Test", base });
  draft = reduceListingSettingsDraft(draft, { type: "edit", value });
  let keys = 0;
  const made: string[] = [];
  return {
    get draft() { return draft; },
    made,
    startSave(signature: string, prefix: string): string | null {
      const attempt = nextSaveAttempt(draft, signature, () => {
        keys += 1;
        const key = `${prefix}:${keys}`;
        made.push(key);
        return key;
      });
      if (attempt === null) return null;
      draft = reduceListingSettingsDraft(draft, { type: "startSave", attempt });
      return attempt.key;
    },
    settle(key: string, settlement: Parameters<StoreDefaultSaveRun<unknown>["drafts"]["settle"]>[1]) {
      draft = settlement.kind === "failure"
        ? reduceListingSettingsDraft(draft, { type: "failure", key, failure: settlement.failure })
        : reduceListingSettingsDraft(draft, { type: "saved", key, nowMs: 5_000, viewStale: settlement.kind === "saved_view_stale" });
    },
    edit(next: DraftValue) {
      draft = reduceListingSettingsDraft(draft, { type: "edit", value: next });
    },
  };
}

function callbacks() {
  return { disabled: false, onSaveStarted: vi.fn(), onSaveSettled: vi.fn() };
}

function preparedSignature(prepared: ReturnType<typeof prepareEbayCategoryDefaultSave> | ReturnType<typeof prepareDescriptionDefaultSave>): string {
  if (!prepared.ok) throw new Error(`expected a request, got ${prepared.code}`);
  return prepared.signature;
}

describe("store default reads open only with their editor (D8)", () => {
  it("keeps the eBay category rules read off while the editor is closed or W3 won't take a save", () => {
    expect(storeDefaultEbayCategoryRulesQueryOptions(22, { editorOpen: false, right: EDITABLE }).enabled).toBe(false);
    expect(storeDefaultEbayCategoryRulesQueryOptions(22, { editorOpen: true, right: NOT_EDITABLE }).enabled).toBe(false);
    expect(storeDefaultEbayCategoryRulesQueryOptions(22, { editorOpen: false, right: NOT_EDITABLE }).enabled).toBe(false);
    expect(storeDefaultEbayCategoryRulesQueryOptions(0, { editorOpen: true, right: EDITABLE }).enabled).toBe(false);
    expect(storeDefaultEbayCategoryRulesQueryOptions(22, { editorOpen: true, right: EDITABLE }).enabled).toBe(true);
  });

  it("keeps the description profile read off while the editor is closed or W4 won't take a save", () => {
    expect(storeDefaultContentProfileQueryOptions(22, { editorOpen: false, right: EDITABLE }).enabled).toBe(false);
    expect(storeDefaultContentProfileQueryOptions(22, { editorOpen: true, right: NOT_EDITABLE }).enabled).toBe(false);
    expect(storeDefaultContentProfileQueryOptions(-3, { editorOpen: true, right: EDITABLE }).enabled).toBe(false);
    expect(storeDefaultContentProfileQueryOptions(22, { editorOpen: true, right: EDITABLE }).enabled).toBe(true);
  });

  it("shares the old category panel's key, gives the profile its own, reads fresh on open and never retries out of sight", () => {
    const rules = storeDefaultEbayCategoryRulesQueryOptions(22, { editorOpen: true, right: EDITABLE });
    expect(rules.queryKey).toEqual([ebayCategoryRulesEndpoint(22)]);
    expect(ebayCategoryRulesQueryKey(22)).toEqual(["/api/dropship/listings/stores/22/ebay-category-rules"]);
    expect(rules.retry).toBe(false);
    expect(rules.staleTime).toBe(0);
    const profile = storeDefaultContentProfileQueryOptions(22, { editorOpen: true, right: EDITABLE });
    expect(profile.queryKey).toEqual(["/api/dropship/listings/stores/22/content-profile"]);
    expect(contentProfileQueryKey(22)).toEqual(profile.queryKey);
    expect(profile.retry).toBe(false);
    expect(profile.staleTime).toBe(0);
  });

  it("reads each document against its contract and passes a refusal on", async () => {
    const fetchMock = stubFetch(RULES_STATE);
    await expect(storeDefaultEbayCategoryRulesQueryOptions(22, { editorOpen: true, right: EDITABLE }).queryFn({ signal }))
      .resolves.toEqual(RULES_STATE);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/dropship/listings/stores/22/ebay-category-rules");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "include", signal });

    stubFetch(PROFILE_STATE);
    await expect(storeDefaultContentProfileQueryOptions(22, { editorOpen: true, right: EDITABLE }).queryFn({ signal }))
      .resolves.toEqual(PROFILE_STATE);

    stubFetch({ ...PROFILE_STATE, extra: true });
    const offContract = await storeDefaultContentProfileQueryOptions(22, { editorOpen: true, right: EDITABLE }).queryFn({ signal })
      .catch((error: unknown) => error);
    expect(offContract).toBeInstanceOf(ListingSettingsReadError);
    expect(offContract).toMatchObject({ code: LISTING_SETTINGS_OFF_CONTRACT, context: { read: "content_profile" } });
    expect(JSON.stringify((offContract as ListingSettingsReadError).context)).not.toContain("Welcome.");

    stubFetch({ error: { code: "DROPSHIP_CONTENT_NOT_ALLOWED", message: "Not allowed." } }, 403);
    const refused = await storeDefaultContentProfileQueryOptions(22, { editorOpen: true, right: EDITABLE }).queryFn({ signal })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DropshipApiError);
    expect(refused).toMatchObject({ status: 403 });
  });
});

describe("rereadStoreDefault (D9)", () => {
  it("reads the saved document again even when the cache would keep it forever, and updates the cache", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const options = storeDefaultContentProfileQueryOptions(22, { editorOpen: true, right: EDITABLE });
    client.setQueryData(options.queryKey, PROFILE_STATE);
    const latest = { ...PROFILE_STATE, revisionId: 42 };
    stubFetch(latest);
    await expect(rereadStoreDefault(client, options)).resolves.toEqual(latest);
    expect(client.getQueryData(options.queryKey)).toEqual(latest);
    client.clear();
  });

  it("throws when the read fails, so the save shows its view is out of date", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubFetch({ error: { code: "DROPSHIP_INTERNAL", message: "Down." } }, 500);
    await expect(rereadStoreDefault(client, storeDefaultContentProfileQueryOptions(22, { editorOpen: true, right: EDITABLE })))
      .rejects.toBeInstanceOf(DropshipApiError);
    client.clear();
  });
});

describe("W3 store default eBay category request", () => {
  const savedRulesInDraftShape = RULES_STATE.profile!.rules.map((rule) => ({
    id: rule.id, name: rule.name, scope: rule.scope, categoryId: rule.category.categoryId,
  }));

  it("sends every saved rule back in saved order, in the shape the save takes", () => {
    const prepared = prepareEbayCategoryDefaultSave(RULES_STATE, { defaultCategory: TOPLOADERS });
    if (!prepared.ok) throw new Error("expected a request");
    expect(prepared.body.expectedRevisionId).toBe(7);
    expect(prepared.body.draft.defaultCategoryId).toBe("183436");
    expect(prepared.body.draft.rules).toEqual(savedRulesInDraftShape);
    expect(prepared.body.draft.rules.map((rule) => rule.id)).toEqual(["toploaders", "named_sizes", "line_4"]);
    // Named listings keep their order too.
    expect(prepared.body.draft.rules[1].scope).toEqual({ type: "listings", productVariantIds: [12, 11] });
    const input = ebayCategoryDefaultSaveInput(prepared.signature, "ls-category:abc-123");
    expect(saveEbayCategoryRulesInputSchema.safeParse(input).success).toBe(true);
    expect(input).toEqual({ ...prepared.body, idempotencyKey: "ls-category:abc-123" });
  });

  it("sends category numbers only, never eBay's names or paths", () => {
    const signature = preparedSignature(prepareEbayCategoryDefaultSave(RULES_STATE, { defaultCategory: TOPLOADERS }));
    expect(signature).not.toContain("categoryName");
    expect(signature).not.toContain("path");
    expect(signature).not.toContain("Trading Cards");
  });

  it("sends defaultCategoryId null to go back to Card Shellz picks, keeping every rule", () => {
    const prepared = prepareEbayCategoryDefaultSave(RULES_STATE, { defaultCategory: null });
    if (!prepared.ok) throw new Error("expected a request");
    expect(prepared.body.draft).toEqual({ defaultCategoryId: null, rules: savedRulesInDraftShape });
  });

  it("sends no rules and no revision for a store that never saved any", () => {
    const empty = ebayCategoryRulesStateSchema.parse({ revisionId: null, profile: null, updatedAt: null });
    const prepared = prepareEbayCategoryDefaultSave(empty, { defaultCategory: SLEEVES });
    if (!prepared.ok) throw new Error("expected a request");
    expect(prepared.body).toEqual({ expectedRevisionId: null, draft: { defaultCategoryId: "183435", rules: [] } });
  });

  it("refuses with plain words, and sends nothing, when an older rule can't go back as saved", () => {
    const broken: EbayCategoryRulesState = {
      ...RULES_STATE,
      profile: { ...RULES_STATE.profile!, rules: [{ ...RULES_STATE.profile!.rules[0], name: "   " }] },
    };
    expect(prepareEbayCategoryDefaultSave(broken, { defaultCategory: null })).toEqual({
      ok: false, code: STORE_DEFAULT_OLDER_RULE_INVALID, message: EBAY_CATEGORY_DEFAULT_WORDS.olderRuleInvalid,
    });
  });

  it("refuses to rebuild a request that is not one W3 takes", () => {
    expect(() => ebayCategoryDefaultSaveInput("not json", "ls-category:1")).toThrow(StoreDefaultRequestError);
    expect(() => ebayCategoryDefaultSaveInput("[1]", "ls-category:1")).toThrow(StoreDefaultRequestError);
    const extra = JSON.stringify({ expectedRevisionId: 7, draft: { defaultCategoryId: null, rules: [] }, sneaky: true });
    const error = (() => { try { ebayCategoryDefaultSaveInput(extra, "ls-category:1"); } catch (caught) { return caught; } return null; })();
    expect(error).toBeInstanceOf(StoreDefaultRequestError);
    expect(error).toMatchObject({ code: STORE_DEFAULT_REQUEST_INVALID, context: { writer: "W3", reason: "off_contract" } });
    const good = preparedSignature(prepareEbayCategoryDefaultSave(RULES_STATE, { defaultCategory: null }));
    expect(() => ebayCategoryDefaultSaveInput(good, "has space")).toThrow(StoreDefaultRequestError);
  });

  it("checks a 2xx answer against its contract", () => {
    expect(() => checkEbayCategoryDefaultAnswer({ state: RULES_STATE, idempotentReplay: false })).not.toThrow();
    expect(() => checkEbayCategoryDefaultAnswer({ state: RULES_STATE })).toThrow();
  });
});

describe("W4 store default description request", () => {
  it("resends every saved group unchanged with the new store text", () => {
    const prepared = prepareDescriptionDefaultSave(PROFILE_STATE, { introduction: "Hello there.", footer: "Bye." });
    if (!prepared.ok) throw new Error("expected a request");
    expect(prepared.body.expectedRevisionId).toBe(41);
    expect(prepared.body.profile.defaultTemplate).toEqual({ introduction: "Hello there.", footer: "Bye." });
    expect(prepared.body.profile.groups).toEqual(PROFILE_STATE.profile!.groups);
    expect(prepared.body.profile.groups).toEqual(GROUPS);
    const input = descriptionDefaultSaveInput(prepared.signature, "ls-text:abc-123");
    expect(saveContentProfileInputSchema.safeParse(input).success).toBe(true);
    expect(input).toEqual({ ...prepared.body, idempotencyKey: "ls-text:abc-123" });
  });

  it("sends the text the way the server stores it: trimmed, with plain line breaks", () => {
    const prepared = prepareDescriptionDefaultSave(PROFILE_STATE, { introduction: "  Line one\r\nLine two  ", footer: "\n" });
    if (!prepared.ok) throw new Error("expected a request");
    expect(prepared.body.profile.defaultTemplate).toEqual({ introduction: "Line one\nLine two", footer: "" });
  });

  it("sends no groups and no revision for a store that never saved text", () => {
    const empty = contentProfileStateSchema.parse({ revisionId: null, profile: null, updatedAt: null });
    const prepared = prepareDescriptionDefaultSave(empty, { introduction: "Hi.", footer: "" });
    if (!prepared.ok) throw new Error("expected a request");
    expect(prepared.body).toEqual({ expectedRevisionId: null, profile: { defaultTemplate: { introduction: "Hi.", footer: "" }, groups: [] } });
  });

  it("refuses text over 4,000 characters or with special characters, with the field words", () => {
    const refused = { ok: false, code: STORE_DEFAULT_DESCRIPTION_INVALID, message: DESCRIPTION_DEFAULT_WORDS.invalid };
    expect(prepareDescriptionDefaultSave(PROFILE_STATE, { introduction: "a".repeat(4_001), footer: "" })).toEqual(refused);
    expect(prepareDescriptionDefaultSave(PROFILE_STATE, { introduction: "", footer: "bell\u0007" })).toEqual(refused);
    expect(prepareDescriptionDefaultSave(PROFILE_STATE, { introduction: "a".repeat(4_000), footer: "" }).ok).toBe(true);
    expect(DESCRIPTION_DEFAULT_WORDS.invalid).toBe("Keep each text to 4,000 characters, with no special characters.");
  });

  it("refuses with older-rule words when a saved group can't go back as saved", () => {
    const broken: ContentProfileState = {
      ...PROFILE_STATE,
      profile: { ...PROFILE_STATE.profile!, groups: [{ ...PROFILE_STATE.profile!.groups[0], priority: 0 }] },
    };
    expect(prepareDescriptionDefaultSave(broken, { introduction: "Hi.", footer: "" })).toEqual({
      ok: false, code: STORE_DEFAULT_OLDER_RULE_INVALID, message: DESCRIPTION_DEFAULT_WORDS.olderRuleInvalid,
    });
  });

  it("counts characters as the server does: N / 4,000", () => {
    expect(descriptionLengthWords("")).toBe("0 / 4,000");
    expect(descriptionLengthWords("abc")).toBe("3 / 4,000");
    expect(descriptionLengthWords("a".repeat(4_000))).toBe("4,000 / 4,000");
  });

  it("checks a 2xx answer against its contract", () => {
    expect(() => checkDescriptionDefaultAnswer({ state: PROFILE_STATE, idempotentReplay: true })).not.toThrow();
    expect(() => checkDescriptionDefaultAnswer({ state: { ...PROFILE_STATE, revisionId: "41" }, idempotentReplay: false })).toThrow();
  });
});

describe("draft values", () => {
  it("start from what is saved, and from nothing when nothing is", () => {
    expect(ebayCategoryDefaultValue(RULES_STATE)).toEqual({ defaultCategory: SLEEVES });
    expect(ebayCategoryDefaultValue(null)).toEqual({ defaultCategory: null });
    expect(descriptionDefaultValue(PROFILE_STATE)).toEqual({ introduction: "Welcome.", footer: "" });
    expect(descriptionDefaultValue(undefined)).toEqual({ introduction: "", footer: "" });
  });

  it("never share the saved document's arrays, so an edit can't change the cache", () => {
    const value = ebayCategoryDefaultValue(RULES_STATE);
    expect(value.defaultCategory!.path).not.toBe(RULES_STATE.profile!.defaultCategory!.path);
  });

  it("read back only their own shape", () => {
    expect(readEbayCategoryDefaultValue({ defaultCategory: SLEEVES })).toEqual({ defaultCategory: SLEEVES });
    expect(readEbayCategoryDefaultValue({ defaultCategory: null })).toEqual({ defaultCategory: null });
    expect(readEbayCategoryDefaultValue({ defaultCategory: { categoryId: "x" } })).toBeNull();
    expect(readEbayCategoryDefaultValue({ introduction: "", footer: "" })).toBeNull();
    expect(readDescriptionDefaultValue({ introduction: "a", footer: "" })).toEqual({ introduction: "a", footer: "" });
    expect(readDescriptionDefaultValue({ defaultCategory: null })).toBeNull();
  });

  it("know when what is saved moved away from where the draft started", () => {
    expect(storeDefaultBaseMoved({ defaultCategory: SLEEVES }, ebayCategoryDefaultValue(RULES_STATE))).toBe(false);
    expect(storeDefaultBaseMoved({ defaultCategory: null }, ebayCategoryDefaultValue(RULES_STATE))).toBe(true);
    expect(storeDefaultBaseMoved({ introduction: "Welcome.", footer: "" }, descriptionDefaultValue(PROFILE_STATE))).toBe(false);
    expect(storeDefaultBaseMoved({ introduction: "Welcome.", footer: "x" }, descriptionDefaultValue(PROFILE_STATE))).toBe(true);
  });

  it("say 'Card Shellz picks' on a phone, or the category's name, never its number", () => {
    expect(storeDefaultEbayCategoryCompactValue(null)).toBe("Card Shellz picks");
    expect(storeDefaultEbayCategoryCompactValue({ categoryName: "Card Sleeves" })).toBe("Card Sleeves");
  });
});

describe("the editor's footer", () => {
  const base = { ready: true, editable: true, busy: false, complete: true };
  const draft = (phase: ListingSettingsDraft["phase"], changes = 1, attempt: ListingSettingsDraft["attempt"] = null, message: string | null = null) =>
    ({ phase, changes, attempt, message });
  const attempt = { signature: "{}", key: "ls-text:1" };

  it("keeps Save off with no change, before the saved document answers, or while it can't be saved", () => {
    expect(storeDefaultEditorFooter({ ...base, draft: draft("editing", 0) }).primary).toEqual({ label: "Save", action: "save", disabled: true });
    expect(storeDefaultEditorFooter({ ...base, draft: draft("editing", 1) }).primary).toEqual({ label: "Save", action: "save", disabled: false });
    expect(storeDefaultEditorFooter({ ...base, ready: false, draft: draft("editing") }).primary.disabled).toBe(true);
    expect(storeDefaultEditorFooter({ ...base, editable: false, draft: draft("editing") }).primary.disabled).toBe(true);
    expect(storeDefaultEditorFooter({ ...base, busy: true, draft: draft("editing") }).primary.disabled).toBe(true);
    expect(storeDefaultEditorFooter({ ...base, complete: false, draft: draft("editing") }).primary.disabled).toBe(true);
    expect(storeDefaultEditorFooter({ ...base, draft: null }).primary.disabled).toBe(true);
  });

  it("locks everything while saving", () => {
    expect(storeDefaultEditorFooter({ ...base, draft: draft("saving", 1, attempt) }))
      .toEqual({ primary: { label: "Saving…", action: "none", disabled: true }, cancelDisabled: true, message: null });
  });

  it("offers Check again for an unconfirmed save, even under a banner, and never Cancel", () => {
    const footer = storeDefaultEditorFooter({ ...base, editable: false, draft: draft("uncertain", 1, attempt, LISTING_SETTINGS_SAVE_WORDS.uncertain) });
    expect(footer.primary).toEqual({ label: "Check again", action: "resend", disabled: false });
    expect(footer.cancelDisabled).toBe(true);
    expect(footer.message).toEqual({ text: "We couldn't confirm your save.", tone: "alert" });
    expect(storeDefaultEditorFooter({ ...base, busy: true, draft: draft("uncertain", 1, attempt) }).primary.disabled).toBe(true);
  });

  it("resends the same request for eBay unreachable and too many saves", () => {
    expect(storeDefaultEditorFooter({ ...base, draft: draft("unreachable", 1, attempt) }).primary)
      .toEqual({ label: "Try again", action: "resend", disabled: false });
    expect(storeDefaultEditorFooter({ ...base, draft: draft("rate_limited", 1, attempt) }).primary)
      .toEqual({ label: "Save", action: "resend", disabled: false });
    expect(storeDefaultEditorFooter({ ...base, editable: false, draft: draft("unreachable", 1, attempt) }).primary.disabled).toBe(true);
  });

  it("offers Load latest and keep my changes after a conflict", () => {
    const footer = storeDefaultEditorFooter({ ...base, draft: draft("conflict", 1, null, LISTING_SETTINGS_SAVE_WORDS.conflict) });
    expect(footer.primary).toEqual({ label: "Load latest and keep my changes", action: "load_latest", disabled: false });
    expect(footer.cancelDisabled).toBe(false);
  });

  it("turns Load latest off while its read runs, so a second press can't cancel the first read", () => {
    // The rows pass `reading` in `busy`; a cancelled first read would show "Couldn't load what's saved" over a load that worked.
    const reading = storeDefaultEditorFooter({ ...base, busy: true, draft: draft("conflict", 1, null, LISTING_SETTINGS_SAVE_WORDS.conflict) });
    expect(reading.primary).toEqual({ label: "Load latest and keep my changes", action: "load_latest", disabled: true });
    // Cancel stays on: the vendor may still drop the draft.
    expect(reading.cancelDisabled).toBe(false);
    // Load latest only reads, so a row that can't be saved still offers it.
    expect(storeDefaultEditorFooter({ ...base, editable: false, draft: draft("conflict", 1, null, LISTING_SETTINGS_SAVE_WORDS.conflict) }).primary.disabled)
      .toBe(false);
  });

  it("shows a refusal as an alert and the Load latest line as a status", () => {
    expect(storeDefaultEditorFooter({ ...base, draft: draft("refused", 1, null, "Pick a final eBay category.") }).message)
      .toEqual({ text: "Pick a final eBay category.", tone: "alert" });
    expect(storeDefaultEditorFooter({ ...base, draft: draft("editing", 1, null, LISTING_SETTINGS_SAVE_WORDS.rebased) }).message)
      .toEqual({ text: LISTING_SETTINGS_SAVE_WORDS.rebased, tone: "status" });
  });
});

describe("runStoreDefaultSave", () => {
  const W3_BASE = { defaultCategory: SLEEVES };
  const W3_VALUE = { defaultCategory: TOPLOADERS };

  function w3Run(drafts: ReturnType<typeof fakeDrafts>, overrides: Partial<StoreDefaultSaveRun<ReturnType<typeof ebayCategoryDefaultSaveInput>>> = {}) {
    const steps: string[] = [];
    const cb = callbacks();
    cb.onSaveStarted.mockImplementation(() => { steps.push("started"); });
    cb.onSaveSettled.mockImplementation(() => { steps.push("settled"); });
    const send = vi.fn(async (input: ReturnType<typeof ebayCategoryDefaultSaveInput>) => {
      steps.push(`send ${input.idempotencyKey}`);
      return { state: RULES_STATE, idempotentReplay: false };
    });
    const reread = vi.fn(async () => { steps.push("reread"); return RULES_STATE; });
    const onSaved = vi.fn(() => { steps.push("onSaved"); });
    const onBlocked = vi.fn();
    const run: StoreDefaultSaveRun<ReturnType<typeof ebayCategoryDefaultSaveInput>> = {
      writer: "W3",
      signature: preparedSignature(prepareEbayCategoryDefaultSave(RULES_STATE, W3_VALUE)),
      drafts,
      callbacks: cb,
      request: ebayCategoryDefaultSaveInput,
      send,
      checkAnswer: checkEbayCategoryDefaultAnswer,
      reread,
      onSaved,
      onBlocked,
      classify: { pickedEbayCategoryId: "183436" },
      ...overrides,
    };
    return { run, steps, cb, send, reread, onSaved, onBlocked };
  }

  it("sends with a ls-category key, reads the rules again, then settles saved and tells the step", async () => {
    const drafts = fakeDrafts("ebayCategory", W3_BASE, W3_VALUE);
    const { run, steps, send } = w3Run(drafts);
    await expect(runStoreDefaultSave(run)).resolves.toEqual({ kind: "saved", viewStale: false });
    expect(steps).toEqual(["started", "send ls-category:1", "reread", "onSaved", "settled"]);
    expect(send.mock.calls[0][0]).toEqual({ ...JSON.parse(run.signature), idempotencyKey: "ls-category:1" });
    expect(drafts.draft).toMatchObject({ phase: "saved", changes: 0, attempt: null, savedAtMs: 5_000 });
  });

  it("re-reads after a replayed save too, never trusting the answer (D9)", async () => {
    const drafts = fakeDrafts("ebayCategory", W3_BASE, W3_VALUE);
    const { run, reread } = w3Run(drafts, { send: async () => ({ state: { ...RULES_STATE, revisionId: 3 }, idempotentReplay: true }) });
    await expect(runStoreDefaultSave(run)).resolves.toEqual({ kind: "saved", viewStale: false });
    expect(reread).toHaveBeenCalledTimes(1);
  });

  it("keeps the save when the re-read fails or the answer is off contract, and says the view is out of date", async () => {
    const failedRead = fakeDrafts("ebayCategory", W3_BASE, W3_VALUE);
    const first = w3Run(failedRead, { reread: async () => { throw new DropshipApiError({ status: 503, message: "Down." }); } });
    await expect(runStoreDefaultSave(first.run)).resolves.toEqual({ kind: "saved", viewStale: true });
    expect(failedRead.draft).toMatchObject({ phase: "saved_view_stale", message: "Saved. We couldn't load the latest view.", changes: 0 });
    expect(first.onSaved).toHaveBeenCalledTimes(1);
    expect(first.cb.onSaveSettled).toHaveBeenCalledTimes(1);

    const offContract = fakeDrafts("ebayCategory", W3_BASE, W3_VALUE);
    const second = w3Run(offContract, { send: async () => ({ unexpected: true }) });
    await expect(runStoreDefaultSave(second.run)).resolves.toEqual({ kind: "saved", viewStale: true });
    expect(second.reread).not.toHaveBeenCalled();
  });

  it("locks an unconfirmed save; Check again sends the very same body with the same key, so it can never save twice", async () => {
    const drafts = fakeDrafts("ebayCategory", W3_BASE, W3_VALUE);
    const dropped = w3Run(drafts, { send: async () => { throw new TypeError("Failed to fetch"); } });
    await expect(runStoreDefaultSave(dropped.run)).resolves.toMatchObject({ kind: "failed", failure: { phase: "uncertain" } });
    expect(drafts.draft).toMatchObject({ phase: "uncertain", message: "We couldn't confirm your save.", attempt: { key: "ls-category:1" } });
    // Locked: an edit is ignored.
    drafts.edit({ defaultCategory: SUPPLIES });
    expect(drafts.draft?.value).toEqual(W3_VALUE);

    // Check again resends the draft's own signature, as the row does.
    const again = w3Run(drafts, { signature: drafts.draft!.attempt!.signature });
    await expect(runStoreDefaultSave(again.run)).resolves.toEqual({ kind: "saved", viewStale: false });
    expect(again.send.mock.calls[0][0]).toEqual({ ...JSON.parse(dropped.run.signature), idempotencyKey: "ls-category:1" });
    expect(drafts.made).toEqual(["ls-category:1"]);
  });

  it("refuses to send another request while a save is unconfirmed", async () => {
    const drafts = fakeDrafts("ebayCategory", W3_BASE, W3_VALUE);
    await runStoreDefaultSave(w3Run(drafts, { send: async () => { throw new TypeError("Failed to fetch"); } }).run);
    const other = w3Run(drafts, { signature: preparedSignature(prepareEbayCategoryDefaultSave(RULES_STATE, { defaultCategory: null })) });
    await expect(runStoreDefaultSave(other.run)).resolves.toEqual({ kind: "not_started", message: null });
    expect(other.send).not.toHaveBeenCalled();
    expect(other.cb.onSaveSettled).toHaveBeenCalledTimes(1);
  });

  it("says nothing was saved when eBay can't be reached (502), and Try again keeps the key", async () => {
    const drafts = fakeDrafts("ebayCategory", W3_BASE, W3_VALUE);
    const down = w3Run(drafts, {
      send: async () => { throw new DropshipApiError({ status: 502, code: "DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE", message: "eBay is down." }); },
    });
    await runStoreDefaultSave(down.run);
    expect(drafts.draft).toMatchObject({ phase: "unreachable", message: "Can't reach eBay right now. Nothing was saved. Try again.", attempt: { key: "ls-category:1" } });
    const retry = w3Run(drafts, { signature: drafts.draft!.attempt!.signature });
    await runStoreDefaultSave(retry.run);
    expect(retry.send.mock.calls[0][0].idempotencyKey).toBe("ls-category:1");
  });

  it("keeps the draft and its key after too many saves (429)", async () => {
    const drafts = fakeDrafts("description", { introduction: "", footer: "" }, { introduction: "Hi.", footer: "" });
    const signature = preparedSignature(prepareDescriptionDefaultSave(PROFILE_STATE, { introduction: "Hi.", footer: "" }));
    const outcome = await runStoreDefaultSave({
      ...w3Run(drafts).run,
      writer: "W4",
      signature,
      request: descriptionDefaultSaveInput,
      send: async () => { throw new DropshipApiError({ status: 429, code: "DROPSHIP_CONTENT_RATE_LIMITED", message: "Slow down." }); },
      checkAnswer: checkDescriptionDefaultAnswer,
      classify: undefined,
    });
    expect(outcome).toMatchObject({ kind: "failed", failure: { phase: "rate_limited" } });
    expect(drafts.draft).toMatchObject({ phase: "rate_limited", message: "Too many saves in a minute. Wait a moment and try again.",
      attempt: { key: "ls-text:1", signature }, value: { introduction: "Hi.", footer: "" } });
  });

  it("shows a conflict for a 409, clears the key, and does not tell the step anything was saved", async () => {
    const drafts = fakeDrafts("ebayCategory", W3_BASE, W3_VALUE);
    const { run, onSaved, cb } = w3Run(drafts, {
      send: async () => { throw new DropshipApiError({ status: 409, code: "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT", message: "Changed." }); },
    });
    await runStoreDefaultSave(run);
    expect(drafts.draft).toMatchObject({ phase: "conflict", message: "This changed in another window.", attempt: null, value: W3_VALUE });
    expect(onSaved).not.toHaveBeenCalled();
    expect(cb.onSaveSettled).toHaveBeenCalledTimes(1);
  });

  it("tells a bad pick from an older rule's category in a W3 refusal", async () => {
    const pickRefused = fakeDrafts("ebayCategory", W3_BASE, W3_VALUE);
    await runStoreDefaultSave(w3Run(pickRefused, {
      send: async () => { throw new DropshipApiError({ status: 422, code: "DROPSHIP_EBAY_CATEGORY_RULE_INVALID", message: "x", context: { categoryId: "183436" } }); },
    }).run);
    expect(pickRefused.draft).toMatchObject({ phase: "refused", message: "Pick a final eBay category.", attempt: null });

    const olderRefused = fakeDrafts("ebayCategory", W3_BASE, W3_VALUE);
    await runStoreDefaultSave(w3Run(olderRefused, {
      send: async () => { throw new DropshipApiError({ status: 422, code: "DROPSHIP_EBAY_CATEGORY_RULE_INVALID", message: "x", context: { categoryId: "261328" } }); },
    }).run);
    expect(olderRefused.draft).toMatchObject({ phase: "refused", message: "One of your older eBay category rules uses a category eBay no longer accepts." });
  });

  it("says a description too big to save (413 with no code) needs support", async () => {
    const drafts = fakeDrafts("description", { introduction: "", footer: "" }, { introduction: "Hi.", footer: "" });
    await runStoreDefaultSave({
      ...w3Run(drafts).run,
      writer: "W4",
      signature: preparedSignature(prepareDescriptionDefaultSave(PROFILE_STATE, { introduction: "Hi.", footer: "" })),
      request: descriptionDefaultSaveInput,
      send: async () => { throw new DropshipApiError({ status: 413, message: "request entity too large" }); },
      checkAnswer: checkDescriptionDefaultAnswer,
      classify: undefined,
    });
    expect(drafts.draft).toMatchObject({ phase: "refused", message: "This is too big to save here. Contact support.", value: { introduction: "Hi.", footer: "" } });
  });

  it("hands a blocked save to the step for its banner and keeps the draft", async () => {
    const drafts = fakeDrafts("ebayCategory", W3_BASE, W3_VALUE);
    const error = new DropshipApiError({ status: 403, code: "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED", message: "Reconnect." });
    const { run, onBlocked } = w3Run(drafts, { send: async () => { throw error; } });
    await runStoreDefaultSave(run);
    expect(onBlocked).toHaveBeenCalledWith(error);
    expect(drafts.draft).toMatchObject({ phase: "blocked", value: W3_VALUE, changes: 1 });
  });

  it("sends nothing and leaves the draft alone while another listing action runs", async () => {
    const drafts = fakeDrafts("ebayCategory", W3_BASE, W3_VALUE);
    const before = drafts.draft;
    const busy = w3Run(drafts);
    busy.cb.onSaveStarted.mockImplementation(() => { throw new Error("Wait for the current listing action to finish before saving listing changes."); });
    await expect(runStoreDefaultSave(busy.run)).resolves.toEqual({
      kind: "not_started", message: "Wait for the current listing action to finish before saving listing changes.",
    });
    expect(busy.send).not.toHaveBeenCalled();
    expect(busy.cb.onSaveSettled).not.toHaveBeenCalled();
    expect(drafts.draft).toBe(before);

    const disabled = w3Run(drafts);
    await expect(runStoreDefaultSave({ ...disabled.run, callbacks: { ...disabled.cb, disabled: true } }))
      .resolves.toEqual({ kind: "not_started", message: STORE_DEFAULT_EDITOR_WORDS.busy });
    expect(disabled.cb.onSaveStarted).not.toHaveBeenCalled();
    expect(disabled.send).not.toHaveBeenCalled();
  });

  it("never sends a request it can't build, and the next try gets a new key", async () => {
    const drafts = fakeDrafts("ebayCategory", W3_BASE, W3_VALUE);
    const broken = w3Run(drafts, { signature: "not json" });
    await expect(runStoreDefaultSave(broken.run)).resolves.toMatchObject({
      kind: "failed", failure: { phase: "refused", code: STORE_DEFAULT_REQUEST_INVALID, status: null },
    });
    expect(broken.send).not.toHaveBeenCalled();
    expect(drafts.draft).toMatchObject({ phase: "refused", attempt: null });
    expect(broken.cb.onSaveSettled).toHaveBeenCalledTimes(1);
  });

  it("gives an edited request a new key, and the same request the same key", () => {
    const drafts = fakeDrafts("ebayCategory", W3_BASE, W3_VALUE);
    const signature = preparedSignature(prepareEbayCategoryDefaultSave(RULES_STATE, W3_VALUE));
    // Built twice from the same saved rules and pick, the request is the same.
    expect(preparedSignature(prepareEbayCategoryDefaultSave(RULES_STATE, W3_VALUE))).toBe(signature);
    const key = drafts.startSave(signature, "ls-category");
    drafts.settle(key!, { kind: "failure", failure: { phase: "unreachable", message: "x", code: null, status: 502 } });
    expect(drafts.startSave(signature, "ls-category")).toBe(key);
    drafts.settle(key!, { kind: "failure", failure: { phase: "unreachable", message: "x", code: null, status: 502 } });
    drafts.edit({ defaultCategory: SUPPLIES });
    const edited = preparedSignature(prepareEbayCategoryDefaultSave(RULES_STATE, { defaultCategory: SUPPLIES }));
    expect(edited).not.toBe(signature);
    expect(drafts.startSave(edited, "ls-category")).toBe("ls-category:2");
  });
});

describe("settleConflictBeforeSending", () => {
  it("shows the conflict without sending anything, so Load latest works as for a 409", () => {
    const drafts = fakeDrafts("description", { introduction: "", footer: "" }, { introduction: "Mine.", footer: "" });
    expect(settleConflictBeforeSending(drafts, "W4")).toBe(true);
    expect(drafts.draft).toMatchObject({ phase: "conflict", message: "This changed in another window.", attempt: null, value: { introduction: "Mine.", footer: "" } });
    // Load latest: another window wrote the footer; the vendor's text stays on top and nothing is marked.
    const rebased = reduceListingSettingsDraft(drafts.draft, { type: "rebase", latest: { introduction: "", footer: "Theirs." } });
    expect(rebased).toMatchObject({ phase: "editing", base: { introduction: "", footer: "Theirs." }, value: { introduction: "Mine.", footer: "" }, marked: [] });
  });

  it("marks a field both windows changed after Load latest", () => {
    const drafts = fakeDrafts("ebayCategory", { defaultCategory: SLEEVES }, { defaultCategory: TOPLOADERS });
    settleConflictBeforeSending(drafts, "W3");
    const rebased = reduceListingSettingsDraft(drafts.draft, { type: "rebase", latest: { defaultCategory: SUPPLIES } });
    expect(rebased?.marked).toEqual(["defaultCategory"]);
  });

  it("does nothing while a save is in flight", () => {
    const drafts = fakeDrafts("description", { introduction: "", footer: "" }, { introduction: "Mine.", footer: "" });
    drafts.startSave("{}", "ls-text");
    expect(settleConflictBeforeSending(drafts, "W4")).toBe(false);
    expect(drafts.draft?.phase).toBe("saving");
  });
});
