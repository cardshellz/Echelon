import { describe, expect, it } from "vitest";
import { MAX_SIZE_PRICES_PER_REQUEST, saveSizePricesInputSchema } from "@shared/dropship/listing-setting-writes";
import { listingSettingsPricesResponseSchema, type ListingSettingsPricesResponse, type ListingSettingsSizePrice } from "@shared/dropship/listing-settings";
import { DropshipApiError } from "../dropship-ops-surface";
import { listingSettingsPricesQueryOptions, listingSettingsQueryKey } from "../dropship-listing-settings";
import type { ListingSettingsRight } from "../dropship-listing-settings-access";
import {
  LISTING_SETTINGS_SAVE_WORDS,
  productEditorId,
  reduceListingSettingsDraft,
  SIZE_PRICES_EDITOR_ID,
  type ListingSettingsDraft,
  type ListingSettingsDraftAction,
} from "../dropship-listing-settings-drafts";
import { DRAWER_WORDS, limitNotices, marginNotice } from "../dropship-listing-settings-drawer";
import {
  emptySizePricesDraft,
  noSizePricesRefusal,
  ownSizePricesDraft,
  readSizePricesDraft,
  reloadTyped,
  SIZE_PRICES_PAGE_SIZE,
  SIZE_PRICES_REQUEST_INVALID,
  SIZE_PRICES_SHOW,
  SizePricesRequestError,
  sizeIdOfKey,
  sizePriceKey,
  sizePriceRows,
  sizePriceTyped,
  sizePricesBody,
  sizePricesDiscard,
  sizePricesEntry,
  sizePricesEditAction,
  sizePricesRefusalWithoutSize,
  sizePricesPageQueryOptions,
  sizePricesReadEnabled,
  sizePricesRefusalOf,
  sizePricesRefusalOfError,
  sizePricesSaveRows,
  sizePricesSheetState,
  sizePricesSignature,
  typedSizePrices,
  type SizePricesDraftValue,
  type SizePricesSheetInput,
  type SizePricesSummaryFacts,
} from "../dropship-listing-settings-size-prices";
import { LISTING_SETTINGS_SIZE_PRICES_WORDS } from "../dropship-listing-settings-words";

/** "Give these sizes a price" (W8; plan PR 10f, 9.2, 9.3, 9.5, 9.6; D1, D5, D6, D12, D16, D18; CC-C5). */

const STORE = 22;
const GENERATED_AT = "2026-10-14T12:00:00.000Z";
const WORDS = LISTING_SETTINGS_SIZE_PRICES_WORDS;
const RAW_CODE = /\b[a-z]+_[a-z_]+\b|DROPSHIP_/;

/** Freezes a value and everything under it, so a mutation anywhere would throw. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** A size that can't be priced, as the Prices tab lists it. */
function size(productVariantId: number, overrides: Partial<ListingSettingsSizePrice> = {}): ListingSettingsSizePrice {
  return {
    productVariantId, productId: 11, productName: "Penny Sleeves", sizeName: "Pack of 100", sku: "EG-SLV-STD-100", priceCents: null, source: "none",
    rule: null, basis: null, basisAmountCents: null, issue: "price_unavailable", costCents: 210, belowCostByCents: null, limits: [], pausedSince: null,
    settingRevisionId: 7, ...overrides,
  };
}

function page(rows: ListingSettingsSizePrice[], pageNumber = 0, total = rows.length): ListingSettingsPricesResponse {
  return deepFreeze(listingSettingsPricesResponseSchema.parse({ storeConnectionId: STORE, page: pageNumber, pageSize: SIZE_PRICES_PAGE_SIZE, total, generatedAt: GENERATED_AT, rows }));
}

/** k sizes 101.., for a page of up to 50. */
const sizes = (from: number, count: number) => Array.from({ length: count }, (_, index) => size(from + index, { sizeName: `Size ${from + index}` }));

const TYPED: SizePricesDraftValue = deepFreeze({ "size:101": { text: "14.99", expectedRevisionId: 7 }, "size:102": { text: "5", expectedRevisionId: null } });
const EDITABLE: ListingSettingsRight = { editable: true, reason: null };

/** Applies actions in order, freezing every draft on the way so a mutation would throw. */
function run(actions: readonly ListingSettingsDraftAction[], start: ListingSettingsDraft | null = null): ListingSettingsDraft | null {
  return actions.reduce<ListingSettingsDraft | null>((draft, action) => {
    const next = reduceListingSettingsDraft(draft === null ? null : deepFreeze(draft), deepFreeze(action));
    return next === null ? null : deepFreeze(next);
  }, start);
}

/** The sheet's draft opened on nothing typed, then edited to `value`. */
function sizesDraft(value: SizePricesDraftValue = TYPED, ...after: ListingSettingsDraftAction[]): ListingSettingsDraft {
  const draft = run([
    { type: "open", editor: SIZE_PRICES_EDITOR_ID, place: WORDS.title, base: emptySizePricesDraft() },
    { type: "edit", value },
    ...after,
  ]);
  if (draft === null) throw new Error("expected a draft");
  return draft;
}

const SAVING = sizesDraft(TYPED, { type: "startSave", attempt: { signature: "s", key: "ls-size-prices:1" } });
const failed = (phase: "uncertain" | "conflict" | "refused" | "rate_limited" | "blocked" | "unreachable", message: string) =>
  run([{ type: "failure", key: "ls-size-prices:1", failure: { phase, message, code: null, status: null, fields: [] } }], SAVING)!;

const apiError = (status: number, code: string | null, context?: Record<string, unknown>, message = "Server words.") =>
  new DropshipApiError({ status, code, message, context });

function expectPlain(text: string | null): void {
  if (text === null) return;
  expect(text).not.toMatch(RAW_CODE);
  expect(text.trim()).toBe(text);
  expect(text.length).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------

describe("the reads (plan 9.3, D10, D18)", () => {
  it("lists the Prices tab's Can't be priced pages, the very same read, under the store's prefix, only while the sheet is open and the selection isn't too large", () => {
    const ok: SizePricesSummaryFacts = { data: { catalog: { state: "ok", products: 20, sizes: 60 } } };
    const tooLarge: SizePricesSummaryFacts = { data: { catalog: { state: "too_large", limit: 10_000 } } };
    const open = sizePricesPageQueryOptions(STORE, 1, ok, true);
    expect(open.queryKey).toEqual(listingSettingsPricesQueryOptions(STORE, { search: "", show: "cannot_price", page: 1 }).queryKey);
    expect(open.queryKey.slice(0, 4)).toEqual([...listingSettingsQueryKey(STORE), "prices"]);
    expect(open.queryKey[4]).toMatchObject({ show: "cannot_price", page: 1 });
    // Fresh while the sheet is open (an open editor's read, D10: the rows' revisions are what a save compares, D6); the
    // Prices tab's own observer of the same key keeps the lists' minute.
    expect(open).toMatchObject({ enabled: true, staleTime: 0, retry: false });
    expect(listingSettingsPricesQueryOptions(STORE, { search: "", show: "cannot_price", page: 1 })).toMatchObject({ staleTime: 60_000 });
    expect(sizePricesPageQueryOptions(STORE, 1, ok, false).enabled).toBe(false);
    expect(sizePricesPageQueryOptions(STORE, 1, tooLarge, true).enabled).toBe(false);
    // While the summary loads or failed, it runs: a 422 then goes to the banner (D18).
    expect(sizePricesReadEnabled({ data: undefined })).toBe(true);
    expect(sizePricesReadEnabled({ error: new TypeError("offline") })).toBe(true);
    expect(sizePricesReadEnabled(tooLarge)).toBe(false);
    expect(sizePricesPageQueryOptions(STORE, 0, { data: undefined }, true).enabled).toBe(true);
    expect(SIZE_PRICES_SHOW).toBe("cannot_price");
    expect(SIZE_PRICES_PAGE_SIZE).toBe(50);
  });
});

describe("the Prices tab's way in (plan 9.3)", () => {
  it("offers Give these sizes a price under Can't be priced while the tab's first page lists a size, and hides it otherwise", () => {
    const listed = { data: { total: 3 }, error: null };
    expect(sizePricesEntry({ show: "cannot_price", listsOff: false, page: listed })).toEqual({ label: "Give these sizes a price", shown: true });
    expect(sizePricesEntry({ show: "cannot_price", listsOff: false, page: { data: { total: 0 }, error: null } }).shown).toBe(false);
    expect(sizePricesEntry({ show: "cannot_price", listsOff: false, page: { data: undefined, error: null } }).shown).toBe(false);
    expect(sizePricesEntry({ show: "cannot_price", listsOff: false, page: { data: undefined, error: new TypeError("offline") } }).shown).toBe(false);
    // A refresh that failed keeps the last answer: the button stays.
    expect(sizePricesEntry({ show: "cannot_price", listsOff: false, page: { data: { total: 3 }, error: new TypeError("offline") } }).shown).toBe(true);
    for (const show of ["all", "exact_prices", "below_cost", "paused", "retail_fallback"]) {
      expect(sizePricesEntry({ show, listsOff: false, page: listed }).shown, show).toBe(false);
    }
    expect(sizePricesEntry({ show: "cannot_price", listsOff: true, page: listed }).shown).toBe(false);
  });
});

describe("the draft (plan 9.2, D6, D16)", () => {
  it("keys each typed size by its id, and tells the sheet's draft from any other", () => {
    expect(sizePriceKey(101)).toBe("size:101");
    for (const bad of [0, -1, 1.5, Number.NaN, 2_147_483_648]) expect(() => sizePriceKey(bad)).toThrow(/positive whole-number size id/);
    expect(sizeIdOfKey("size:101")).toBe(101);
    for (const other of ["size:0", "size:01", "size:1.5", "size:", "size:x", "price", "items", "size:99999999999"]) expect(sizeIdOfKey(other)).toBeNull();
    expect(emptySizePricesDraft()).toEqual({});
    expect(Object.isFrozen(emptySizePricesDraft())).toBe(true);
    expect(readSizePricesDraft({})).toEqual({});
    expect(readSizePricesDraft(TYPED)).toBe(TYPED);
    for (const bad of [
      { items: [] }, { productVariantId: 101, expectedRevisionId: 1, exact: "" }, { "size:101": { text: 1, expectedRevisionId: null } },
      { "size:101": { text: "1", expectedRevisionId: 1.5 } }, { "size:101": { text: "1" } }, { "size:x": { text: "1", expectedRevisionId: null } },
      { "size:101": { text: "1", expectedRevisionId: null }, price: null }, { "size:101": null },
    ]) {
      expect(readSizePricesDraft(bad)).toBeNull();
    }
    expect(ownSizePricesDraft(null)).toBeNull();
    expect(ownSizePricesDraft(run([{ type: "open", editor: productEditorId(11), place: "Penny Sleeves", base: { a: 1 } }]))).toBeNull();
    expect(ownSizePricesDraft({ ...sizesDraft(), value: { items: [] } })).toBeNull();
    const own = ownSizePricesDraft(sizesDraft());
    expect(own?.value).toEqual(TYPED);
    expect(own?.draft.changes).toBe(2);
  });

  it("takes a typed price with the revision its row was read with, keeps that revision while the box is edited, and drops an emptied box (D6)", () => {
    const first = sizePriceTyped(emptySizePricesDraft(), size(101), "14.99");
    expect(first).toEqual({ "size:101": { text: "14.99", expectedRevisionId: 7 } });
    expect(Object.isFrozen(first)).toBe(true);
    // The revision stays the one first typed against, whatever the row says now: a moved row is a conflict the server answers (CC-C5).
    expect(sizePriceTyped(first, size(101, { settingRevisionId: 9 }), "15")).toEqual({ "size:101": { text: "15", expectedRevisionId: 7 } });
    expect(sizePriceTyped(first, size(102, { settingRevisionId: null }), " 5 ")).toEqual({ ...first, "size:102": { text: " 5 ", expectedRevisionId: null } });
    expect(sizePriceTyped(sizePriceTyped(first, size(102), "5"), size(101), "   ")).toEqual({ "size:102": { text: "5", expectedRevisionId: 7 } });
    expect(sizePriceTyped(first, size(101), "")).toEqual({});
    // Text as typed stays as typed; the parse is the drawer's rule (R:540), ascending by size.
    expect(typedSizePrices({ "size:102": { text: "abc", expectedRevisionId: null }, "size:101": { text: "14.9", expectedRevisionId: 7 }, "size:103": { text: "0", expectedRevisionId: 2 } })).toEqual([
      { productVariantId: 101, text: "14.9", expectedRevisionId: 7, parsed: { ok: true, cents: 1490 } },
      { productVariantId: 102, text: "abc", expectedRevisionId: null, parsed: { ok: false, message: "Enter a price like 14.99." } },
      { productVariantId: 103, text: "0", expectedRevisionId: 2, parsed: { ok: false, message: DRAWER_WORDS.inputRange } },
    ]);
    expect(typedSizePrices({})).toEqual([]);
    expect(DRAWER_WORDS.inputFormat).toBe("Enter a price like 14.99.");
  });

  it("types into the step's one draft: a clean or missing draft starts on nothing typed, a held one takes the text, a locked one nothing, another editor's asks first (D16)", () => {
    expect(sizePricesEditAction({ draft: null, size: size(101), text: "14.99" })).toEqual({ kind: "start", base: {}, value: { "size:101": { text: "14.99", expectedRevisionId: 7 } } });
    const opened = run([{ type: "open", editor: SIZE_PRICES_EDITOR_ID, place: WORDS.title, base: emptySizePricesDraft() }]);
    expect(sizePricesEditAction({ draft: opened, size: size(101), text: "14.99" })).toMatchObject({ kind: "start" });
    expect(sizePricesEditAction({ draft: sizesDraft(), size: size(103), text: "2" })).toEqual({ kind: "edit", value: { ...TYPED, "size:103": { text: "2", expectedRevisionId: 7 } } });
    expect(sizePricesEditAction({ draft: sizesDraft(), size: size(101), text: "" })).toEqual({ kind: "edit", value: { "size:102": { text: "5", expectedRevisionId: null } } });
    expect(sizePricesEditAction({ draft: SAVING, size: size(103), text: "2" })).toEqual({ kind: "locked" });
    expect(sizePricesEditAction({ draft: failed("uncertain", LISTING_SETTINGS_SAVE_WORDS.uncertain), size: size(103), text: "2" })).toEqual({ kind: "locked" });
    // After a confirmed save the draft is clean on what was saved: a new price starts again on nothing typed, never resending a saved size's old revision.
    const saved = run([{ type: "saved", key: "ls-size-prices:1", nowMs: 1_000, viewStale: false }], SAVING)!;
    expect(saved.changes).toBe(0);
    expect(sizePricesEditAction({ draft: saved, size: size(101, { settingRevisionId: 8 }), text: "16" })).toEqual({ kind: "start", base: {}, value: { "size:101": { text: "16", expectedRevisionId: 8 } } });
    // A refused or conflicted draft still holds its typed sizes: the text goes in.
    expect(sizePricesEditAction({ draft: failed("refused", "Server words."), size: size(103), text: "2" })).toMatchObject({ kind: "edit" });
    // Another editor's unsaved change: the leave guard asks first; its clean draft is just replaced.
    const product = run([{ type: "open", editor: productEditorId(11), place: "Penny Sleeves", base: { a: 1 } }, { type: "edit", value: { a: 2 } }]);
    expect(sizePricesEditAction({ draft: product, size: size(101), text: "14.99" })).toEqual({ kind: "elsewhere" });
    expect(sizePricesEditAction({ draft: run([{ type: "open", editor: productEditorId(11), place: "Penny Sleeves", base: { a: 1 } }]), size: size(101), text: "14.99" })).toMatchObject({ kind: "start" });
    expect(sizePricesEditAction({ draft: run([{ type: "startSave", attempt: { signature: "s", key: "ls-product:1" } }], product), size: size(101), text: "1" })).toEqual({ kind: "elsewhere" });
    // Discard.
    expect(sizePricesDiscard(sizesDraft())).toBe("discard");
    expect(sizePricesDiscard(failed("refused", "Server words."))).toBe("discard");
    for (const none of [null, opened, SAVING, failed("uncertain", LISTING_SETTINGS_SAVE_WORDS.uncertain), product, saved]) expect(sizePricesDiscard(none)).toBe("none");
  });
});

describe("the W8 request (plan 9.4, 9.5; D1, D5, D12)", () => {
  it("sends only the typed sizes as integer cents, ascending, at most 200; a box the parsers refuse or nothing typed sends nothing", () => {
    expect(sizePricesSaveRows({})).toEqual({ ok: false, reason: "none", message: null });
    expect(sizePricesSaveRows({ "size:102": { text: "5", expectedRevisionId: null }, "size:101": { text: "14.99", expectedRevisionId: 7 }, "size:103": { text: "0.01", expectedRevisionId: 2 } })).toEqual({
      ok: true,
      rows: [{ productVariantId: 101, priceCents: 1499, expectedRevisionId: 7 }, { productVariantId: 102, priceCents: 500, expectedRevisionId: null }, { productVariantId: 103, priceCents: 1, expectedRevisionId: 2 }],
    });
    expect(sizePricesSaveRows({ ...TYPED, "size:103": { text: "14.999", expectedRevisionId: null } })).toEqual({ ok: false, reason: "invalid", message: "Enter a price like 14.99." });
    expect(sizePricesSaveRows({ ...TYPED, "size:103": { text: "0", expectedRevisionId: null } })).toEqual({ ok: false, reason: "invalid", message: DRAWER_WORDS.inputRange });
    const many = (count: number): SizePricesDraftValue => Object.fromEntries(Array.from({ length: count }, (_, index) => [sizePriceKey(1_000 + index), { text: "1", expectedRevisionId: null }]));
    expect(MAX_SIZE_PRICES_PER_REQUEST).toBe(200);
    expect(sizePricesSaveRows(many(200))).toMatchObject({ ok: true });
    expect(sizePricesSaveRows(many(201))).toEqual({ ok: false, reason: "too_many", message: "Save up to 200 prices at a time." });
    // Over 200 is told before a bad box is: Save says the count.
    expect(sizePricesSaveRows({ ...many(201), "size:5": { text: "x", expectedRevisionId: null } })).toMatchObject({ reason: "too_many" });
    const rows = sizePricesSaveRows(TYPED);
    if (!rows.ok) throw new Error("expected rows");
    for (const row of rows.rows) expect(Number.isSafeInteger(row.priceCents)).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/text|14\.99/);
  });

  it("signs the request stable under row order, differently by cents, revision, size and store; the body is the shared schema's", () => {
    const rows = [{ productVariantId: 101, priceCents: 1499, expectedRevisionId: 7 }, { productVariantId: 102, priceCents: 500, expectedRevisionId: null }];
    const signature = sizePricesSignature(STORE, rows);
    expect(signature).toBe(sizePricesSignature(STORE, [...rows].reverse()));
    expect(signature).toBe(JSON.stringify(["listing-settings-size-prices-v1", STORE, [[101, 1499, 7], [102, 500, null]]]));
    expect(sizePricesSignature(STORE, [{ ...rows[0], priceCents: 1500 }, rows[1]])).not.toBe(signature);
    expect(sizePricesSignature(STORE, [{ ...rows[0], expectedRevisionId: 8 }, rows[1]])).not.toBe(signature);
    expect(sizePricesSignature(STORE, [rows[0]])).not.toBe(signature);
    expect(sizePricesSignature(STORE + 1, rows)).not.toBe(signature);
    const body = sizePricesBody({ key: "ls-size-prices:1", rows });
    expect(body).toEqual({ idempotencyKey: "ls-size-prices:1", rows });
    expect(body.rows[0]).not.toBe(rows[0]);
    expect(saveSizePricesInputSchema.safeParse(body).success).toBe(true);
    // Outside the contract, never sent: no row, over 200, a size twice, zero cents, a float, a short key.
    const many = Array.from({ length: 201 }, (_, index) => ({ productVariantId: 1_000 + index, priceCents: 1, expectedRevisionId: null }));
    for (const [key, bad] of [
      ["ls-size-prices:1", []], ["ls-size-prices:1", many], ["ls-size-prices:1", [rows[0], rows[0]]], ["ls-size-prices:1", [{ ...rows[0], priceCents: 0 }]],
      ["ls-size-prices:1", [{ ...rows[0], priceCents: 14.99 }]], ["x:1", rows], ["ls-size-prices:1", [{ ...rows[0], expectedRevisionId: 0 }]],
    ] as const) {
      let thrown: unknown;
      try {
        sizePricesBody({ key, rows: bad });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SizePricesRequestError);
      expect(thrown).toMatchObject({ code: SIZE_PRICES_REQUEST_INVALID, message: "These prices can't be sent as they are. Check them and save again.", context: { rowCount: bad.length, issues: expect.any(Array) } });
      expect(SIZE_PRICES_REQUEST_INVALID).toBe("DROPSHIP_LISTING_SETTINGS_SIZE_PRICES_REQUEST_INVALID");
    }
  });

  it("marks the rows a refusal names, from the answer's lists (9.5), and nothing for any other failure", () => {
    expect(sizePricesRefusalOf("DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", { sizes: [{ productVariantId: 101, priceCents: 1, blockers: [] }, { productVariantId: 103 }], sizeCount: 3 }))
      .toEqual({ outsideLimit: new Set([101, 103]), conflicts: new Set() });
    expect(sizePricesRefusalOf("DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", { conflicts: [{ productVariantId: 102, expectedRevisionId: null, actualRevisionId: 4 }], conflictCount: 1 }))
      .toEqual({ outsideLimit: new Set(), conflicts: new Set([102]) });
    // The lists are read for their ids only: a bad entry is skipped, a missing list marks nothing.
    expect(sizePricesRefusalOf("DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", { sizes: [null, 5, { productVariantId: "101" }, { productVariantId: 104 }] })).toEqual({ outsideLimit: new Set([104]), conflicts: new Set() });
    expect(sizePricesRefusalOf("DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", { sizes: "all" })).toEqual({ outsideLimit: new Set(), conflicts: new Set() });
    expect(sizePricesRefusalOf("DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", null)).toEqual({ outsideLimit: new Set(), conflicts: new Set() });
    // A size no longer chosen (404, naming it): marked as a conflict until Load latest drops it (W8's rule, 9.5).
    expect(sizePricesRefusalOf("DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", { productVariantId: 102 })).toEqual({ outsideLimit: new Set(), conflicts: new Set([102]) });
    expect(sizePricesRefusalOf("DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", { productVariantId: "102" })).toEqual(noSizePricesRefusal());
    expect(sizePricesRefusalOf("DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", undefined)).toEqual(noSizePricesRefusal());
    for (const code of ["DROPSHIP_LISTING_SETTINGS_BUSY", null]) {
      expect(sizePricesRefusalOf(code, { sizes: [{ productVariantId: 101 }], conflicts: [{ productVariantId: 101 }], productVariantId: 101 })).toEqual(noSizePricesRefusal());
    }
    // A retyped size loses its mark, the others keep theirs; nothing marked is the same object.
    const marked = { outsideLimit: new Set([101, 103]), conflicts: new Set([102, 103]) };
    expect(sizePricesRefusalWithoutSize(marked, 103)).toEqual({ outsideLimit: new Set([101]), conflicts: new Set([102]) });
    expect(sizePricesRefusalWithoutSize(marked, 101)).toEqual({ outsideLimit: new Set([103]), conflicts: new Set([102, 103]) });
    expect(sizePricesRefusalWithoutSize(marked, 999)).toBe(marked);
    expect(sizePricesRefusalWithoutSize(noSizePricesRefusal(), 101)).toBe(noSizePricesRefusal());
    expect(marked).toEqual({ outsideLimit: new Set([101, 103]), conflicts: new Set([102, 103]) });
    expect(sizePricesRefusalOfError(apiError(422, "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", { sizes: [{ productVariantId: 101 }], sizeCount: 1 }))).toEqual({ outsideLimit: new Set([101]), conflicts: new Set() });
    expect(sizePricesRefusalOfError(new TypeError("Failed to fetch"))).toEqual(noSizePricesRefusal());
    expect(noSizePricesRefusal()).toEqual({ outsideLimit: new Set(), conflicts: new Set() });
  });
});

describe("Load latest after a conflict (plan 9.5, CC-C5)", () => {
  it("keeps each typed size still listed with its new revision from the pages read again, drops the rest with the line, and never reads a conflict's actualRevisionId", () => {
    const typed: SizePricesDraftValue = { "size:101": { text: "14.99", expectedRevisionId: 7 }, "size:102": { text: "5", expectedRevisionId: null }, "size:103": { text: "2", expectedRevisionId: 3 } };
    const pages = [page([size(101, { settingRevisionId: 8 }), size(104)], 0, 60), page([size(102, { settingRevisionId: 2 }), size(101, { settingRevisionId: 99 })], 1, 60)];
    const reload = reloadTyped(typed, pages);
    expect(reload).toEqual({
      value: { "size:101": { text: "14.99", expectedRevisionId: 8 }, "size:102": { text: "5", expectedRevisionId: 2 } },
      kept: 2, dropped: 1, line: "1 size left this list and wasn't saved.", keeps: true,
    });
    expect(Object.isFrozen(reload.value)).toBe(true);
    // The first listing of a size wins (a size can't move between the pages of one read).
    expect(reload.value["size:101"].expectedRevisionId).toBe(8);
    // A size listed again with no saved revision takes null.
    expect(reloadTyped(typed, [page([size(101, { settingRevisionId: null })])]).value).toEqual({ "size:101": { text: "14.99", expectedRevisionId: null } });
    // Nothing left: the draft goes; nothing typed: nothing to keep.
    expect(reloadTyped(typed, [page([size(104)])])).toEqual({ value: {}, kept: 0, dropped: 3, line: "3 sizes left this list and weren't saved.", keeps: false });
    expect(reloadTyped(typed, [])).toMatchObject({ kept: 0, dropped: 3, keeps: false });
    expect(reloadTyped({}, pages)).toEqual({ value: {}, kept: 0, dropped: 0, line: null, keeps: false });
    // The pages are the only source of a revision: there is no conflict answer to read one from (CC-C5).
    expect(reloadTyped.length).toBe(2);
    expect(JSON.stringify(reload)).not.toMatch(/actualRevisionId|"expectedRevisionId":99/);
  });
});

describe("the rows (plan 9.3)", () => {
  it("lists each size of the loaded pages once with its product, size, cost and box, the typed text parsed, and the drawer's notes under it", () => {
    const limits = [{ policyId: 3, floorCents: 500, ceilingCents: 2_000, mode: "block_listing" as const, breached: null }];
    const pages = [page([size(101), size(102, { productName: "Toploaders", sizeName: "Box of 25", sku: null, costCents: null, settingRevisionId: null })], 0, 51), page([size(103, { limits }), size(101)], 1, 51)];
    const value: SizePricesDraftValue = { "size:101": { text: "14.9", expectedRevisionId: 7 }, "size:103": { text: "25", expectedRevisionId: 7 }, "size:102": { text: "abc", expectedRevisionId: null }, "size:999": { text: "1", expectedRevisionId: null } };
    const rows = sizePriceRows({ pages, value, refusal: noSizePricesRefusal(), readOnly: false });
    expect(rows.map((row) => row.productVariantId)).toEqual([101, 102, 103]);
    expect(rows[0]).toEqual({
      key: "size:101", productVariantId: 101, productId: 11, productName: "Penny Sleeves", size: "Pack of 100 · EG-SLV-STD-100", cost: "Your cost $2.10", costAmount: "$2.10",
      box: { text: "14.9", label: "Exact price for Penny Sleeves, Pack of 100", invalid: null, readOnly: false },
      notices: [marginNotice(1490, 210)], typed: true, outsideLimit: false, conflict: false,
    });
    expect(rows[1]).toMatchObject({ productName: "Toploaders", size: "Box of 25", cost: null, costAmount: null, box: { text: "abc", label: "Exact price for Toploaders, Box of 25", invalid: "Enter a price like 14.99." }, notices: [], typed: true });
    expect(rows[2]).toMatchObject({ box: { text: "25" }, notices: [marginNotice(2_500, 210), ...limitNotices(limits, 2_500)], typed: true });
    expect(rows[2].notices.length).toBeGreaterThan(1);
    // Untyped rows, read-only boxes, no draft at all.
    const untyped = sizePriceRows({ pages, value: null, refusal: noSizePricesRefusal(), readOnly: true });
    expect(untyped.map((row) => [row.typed, row.box.text, row.box.readOnly, row.notices])).toEqual([[false, "", true, []], [false, "", true, []], [false, "", true, []]]);
    expect(sizePriceRows({ pages: [], value, refusal: noSizePricesRefusal(), readOnly: false })).toEqual([]);
    // A refusal's marks: the limit's note first, under the typed price's own; a conflict's flag.
    const marked = sizePriceRows({ pages, value, refusal: { outsideLimit: new Set([103]), conflicts: new Set([101]) }, readOnly: false });
    expect(marked[2]).toMatchObject({ outsideLimit: true, conflict: false, notices: [{ tone: "alert", text: "Outside a Card Shellz price limit" }, marginNotice(2_500, 210), ...limitNotices(limits, 2_500)] });
    expect(marked[0]).toMatchObject({ outsideLimit: false, conflict: true });
    for (const row of [...rows, ...marked]) {
      expectPlain(row.box.label);
      expectPlain(row.size);
      expectPlain(row.cost);
      for (const notice of row.notices) expectPlain(notice.text);
    }
  });
});

describe("the sheet (plan 9.3, 3.7)", () => {
  const sheet = (overrides: Partial<SizePricesSheetInput> = {}) => sizePricesSheetState({
    pages: [{ data: page(sizes(101, 2), 0, 2), error: null }], draft: null, right: EDITABLE, busy: false, savedFlashVisible: false, compact: false, refusal: noSizePricesRefusal(),
    ...overrides,
  });
  const fifty = (pageNumber: number, total = 120) => page(sizes(1_000 + pageNumber * 50, Math.min(50, total - pageNumber * 50)), pageNumber, total);

  it("says it is loading, that the read failed with Try again, or too many checks in a minute (D10), and that every size has a price", () => {
    const loading = sheet({ pages: [{ data: undefined, error: null }] });
    expect(loading).toMatchObject({ title: "Give these sizes a price", intro: WORDS.intro, read: "loading", loadingLine: "Checking which sizes need a price…", problem: null, rows: [], empty: null, typedCount: 0, footerShown: false });
    expect(loading.loadMore).toEqual({ label: "Load more", shown: false, nextPage: 0, loading: false, problem: null });
    expect(loading.footer).toMatchObject({ notSaved: null, primary: { action: "save", label: "Save prices", disabled: true }, discardDisabled: true, message: null });
    expect(sheet({ pages: [] })).toMatchObject({ read: "loading", loadingLine: WORDS.loading, footerShown: false });
    expect(sheet({ pages: [{ data: undefined, error: new TypeError("offline") }] })).toMatchObject({ read: "failed", loadingLine: null, problem: { kind: "failed", text: "Couldn't check which sizes need a price. Try again.", retryLabel: "Try again" }, rows: [], footerShown: false });
    expect(sheet({ pages: [{ data: undefined, error: apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED") }] })).toMatchObject({ read: "failed", problem: { kind: "rate_limited", text: DRAWER_WORDS.readRateLimited, retryLabel: "Try again" } });
    const none = sheet({ pages: [{ data: page([], 0, 0), error: null }] });
    expect(none).toMatchObject({ read: "answered", empty: "Every size has a price.", rows: [], loadMore: { shown: false }, footerShown: false });
    // A page answered keeps its rows across a failed refresh (React Query keeps data beside error).
    const kept = sheet({ pages: [{ data: page(sizes(101, 2), 0, 2), error: new TypeError("offline") }] });
    expect(kept).toMatchObject({ read: "answered", problem: null, empty: null, footerShown: true });
    expect(kept.rows).toHaveLength(2);
    // The footer stays in reach with typed prices or a save out or unconfirmed, whatever the first page's read did (D21,
    // 3.7): after Back and a failed re-read, Check again, Discard and the count still show.
    const failedFirst = { data: undefined, error: new TypeError("offline") };
    expect(sheet({ pages: [failedFirst], draft: sizesDraft() })).toMatchObject({ read: "failed", typedCount: 2, footerShown: true });
    expect(sheet({ pages: [failedFirst], draft: failed("uncertain", LISTING_SETTINGS_SAVE_WORDS.uncertain) })).toMatchObject({ read: "failed", held: true, footerShown: true, footer: { primary: { action: "resend" } } });
    expect(sheet({ pages: [{ data: undefined, error: null }], draft: SAVING })).toMatchObject({ read: "loading", footerShown: true });
    // "Saved" with every size gone: the footer shows while the words do.
    const savedAll = run([{ type: "saved", key: "ls-size-prices:1", nowMs: 1_000, viewStale: false }], SAVING)!;
    expect(sheet({ pages: [{ data: page([], 0, 0), error: null }], draft: savedAll, savedFlashVisible: true })).toMatchObject({ empty: "Every size has a price.", footerShown: true });
    expect(sheet({ pages: [{ data: page([], 0, 0), error: null }], draft: savedAll, savedFlashVisible: false })).toMatchObject({ footerShown: false });
    for (const text of [loading.title, loading.intro, loading.loadingLine, none.empty]) expectPlain(text);
  });

  it("keeps the loaded pages together as one list with Load more while another page follows, and its own loading and failure (9.3, 9.5)", () => {
    const one = sheet({ pages: [{ data: fifty(0), error: null }] });
    expect(one).toMatchObject({ loadMore: { label: "Load more", shown: true, nextPage: 1, loading: false, problem: null } });
    expect(one.rows).toHaveLength(50);
    const two = sheet({ pages: [{ data: fifty(0), error: null }, { data: fifty(1), error: null }] });
    expect(two).toMatchObject({ loadMore: { shown: true, nextPage: 2 } });
    expect(two.rows.map((row) => row.productVariantId)).toEqual([...Array.from({ length: 100 }, (_, index) => 1_000 + index)]);
    const all = sheet({ pages: [{ data: fifty(0), error: null }, { data: fifty(1), error: null }, { data: fifty(2), error: null }] });
    expect(all).toMatchObject({ loadMore: { shown: false, nextPage: 3 } });
    expect(all.rows).toHaveLength(120);
    expect(sheet({ pages: [{ data: fifty(0), error: null }, { data: undefined, error: null }] })).toMatchObject({ read: "answered", loadMore: { shown: true, nextPage: 1, loading: true, problem: null } });
    const lastFailed = sheet({ pages: [{ data: fifty(0), error: null }, { data: undefined, error: new TypeError("offline") }] });
    expect(lastFailed).toMatchObject({ read: "answered", problem: null, loadMore: { shown: true, nextPage: 1, loading: false, problem: { kind: "failed", text: WORDS.readFailed, retryLabel: "Try again" } } });
    expect(lastFailed.rows).toHaveLength(50);
    expect(sheet({ pages: [{ data: fifty(0), error: null }, { data: undefined, error: apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED") }] }).loadMore.problem).toMatchObject({ kind: "rate_limited" });
    // An exact fifty: no next page.
    expect(sheet({ pages: [{ data: page(sizes(1, 50), 0, 50), error: null }] }).loadMore.shown).toBe(false);
  });

  it("counts the typed prices in the footer with Save prices, turns Save off over 200 with the line, or for a box the parsers refuse (D12)", () => {
    const typed = sheet({ draft: sizesDraft() });
    expect(typed).toMatchObject({ typedCount: 2, boxesReadOnly: false, reason: null, escapeKeepsOpen: false, held: false, footerShown: true });
    expect(typed.footer).toEqual({ notSaved: "● Not saved · 2 prices", primary: { action: "save", label: "Save prices", disabled: false }, discardDisabled: false, message: null });
    expect(sheet({ draft: sizesDraft(), compact: true }).footer).toMatchObject({ notSaved: "● Not saved · 2", primary: { label: "Save prices" } });
    expect(sheet({ draft: sizesDraft({ "size:101": { text: "14.99", expectedRevisionId: 7 } }) }).footer.notSaved).toBe("● Not saved · 1 price");
    expect(typed.rows.map((row) => [row.typed, row.box.text])).toEqual([[true, "14.99"], [true, "5"]]);
    const many: SizePricesDraftValue = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [sizePriceKey(1_000 + index), { text: "1", expectedRevisionId: null }]));
    const over = sheet({ draft: sizesDraft(many) });
    expect(over).toMatchObject({ typedCount: 201, footer: { notSaved: "● Not saved · 201 prices", primary: { action: "save", label: "Save prices", disabled: true }, message: { text: WORDS.tooMany, tone: "status" } } });
    const bad = sheet({ draft: sizesDraft({ ...TYPED, "size:102": { text: "abc", expectedRevisionId: null } }) });
    expect(bad).toMatchObject({ typedCount: 2, footer: { primary: { disabled: true }, message: null } });
    expect(bad.rows[1].box.invalid).toBe("Enter a price like 14.99.");
    // Nothing typed yet: Save off, nothing to discard.
    expect(sheet({ draft: run([{ type: "open", editor: SIZE_PRICES_EDITOR_ID, place: WORDS.title, base: emptySizePricesDraft() }]) }).footer).toMatchObject({ notSaved: null, primary: { disabled: true }, discardDisabled: true });
    // Another editor's draft is not this sheet's: nothing typed here, and nothing locked here but the page's counter.
    const other = run([{ type: "open", editor: productEditorId(11), place: "Penny Sleeves", base: { a: 1 } }, { type: "edit", value: { a: 2 } }]);
    expect(sheet({ draft: other })).toMatchObject({ typedCount: 0, footer: { notSaved: null, primary: { disabled: true } }, boxesReadOnly: false, held: false });
  });

  it("locks the boxes and the footer while a save is out or unconfirmed, words each phase, and marks the rows a refusal named (3.7, 9.5)", () => {
    const saving = sheet({ draft: SAVING });
    expect(saving).toMatchObject({ boxesReadOnly: true, escapeKeepsOpen: true, held: true, footer: { notSaved: "● Not saved · 2 prices", primary: { action: "none", label: "Saving…", disabled: true }, discardDisabled: true } });
    expect(saving.rows.every((row) => row.box.readOnly)).toBe(true);
    expect(sheet({ draft: failed("uncertain", LISTING_SETTINGS_SAVE_WORDS.uncertain) })).toMatchObject({
      boxesReadOnly: true, held: true, footer: { primary: { action: "resend", label: "Check again", disabled: false }, message: { text: LISTING_SETTINGS_SAVE_WORDS.uncertain, tone: "alert" } },
    });
    expect(sheet({ draft: failed("conflict", "3 sizes' prices changed in another window.") })).toMatchObject({
      boxesReadOnly: false, held: false, footer: { primary: { action: "load_latest", label: "Load latest and keep my changes", disabled: false }, message: { text: "3 sizes' prices changed in another window.", tone: "alert" } },
    });
    expect(sheet({ draft: failed("refused", "3 sizes' prices would be outside what Card Shellz allows. Enter prices Card Shellz allows.") }).footer)
      .toMatchObject({ primary: { action: "save", label: "Save prices", disabled: false }, message: { text: "3 sizes' prices would be outside what Card Shellz allows. Enter prices Card Shellz allows.", tone: "alert" } });
    expect(sheet({ draft: failed("rate_limited", LISTING_SETTINGS_SAVE_WORDS.rateLimited) }).footer.message).toEqual({ text: LISTING_SETTINGS_SAVE_WORDS.rateLimited, tone: "alert" });
    expect(sheet({ draft: failed("blocked", LISTING_SETTINGS_SAVE_WORDS.blocked) }).footer.message).toEqual({ text: "Nothing was saved.", tone: "alert" });
    expect(sheet({ draft: failed("unreachable", LISTING_SETTINGS_SAVE_WORDS.unreachable) }).footer.message).toEqual({ text: LISTING_SETTINGS_SAVE_WORDS.unreachable, tone: "alert" });
    const saved = run([{ type: "saved", key: "ls-size-prices:1", nowMs: 1_000, viewStale: false }], SAVING)!;
    expect(sheet({ draft: saved, savedFlashVisible: true }).footer).toMatchObject({ notSaved: null, primary: { action: "save", disabled: true }, message: { text: "Saved", tone: "status" } });
    expect(sheet({ draft: saved, savedFlashVisible: false }).footer.message).toBeNull();
    const stale = run([{ type: "saved", key: "ls-size-prices:1", nowMs: 1_000, viewStale: true }], SAVING)!;
    expect(sheet({ draft: stale }).footer).toMatchObject({ primary: { action: "reload", label: "Reload" }, message: { text: LISTING_SETTINGS_SAVE_WORDS.savedViewStale, tone: "status" } });
    // The rows a refusal named, kept by the sheet until the next save; the line after Load latest.
    const marked = sheet({ draft: failed("refused", "Server words."), refusal: { outsideLimit: new Set([101]), conflicts: new Set() } });
    expect(marked.rows.map((row) => row.outsideLimit)).toEqual([true, false]);
    expect(marked.rows[0].notices[0]).toEqual({ tone: "alert", text: WORDS.outsideLimit });
    expect(sheet({ draft: failed("conflict", "1 size's price changed in another window."), refusal: { outsideLimit: new Set(), conflicts: new Set([102]) } }).rows.map((row) => row.conflict)).toEqual([false, true]);
    expect(sheet({ reloadLine: "1 size left this list and wasn't saved." }).reloadLine).toBe("1 size left this list and wasn't saved.");
    expect(sheet().reloadLine).toBeNull();
  });

  it("takes the boxes and Save away while W8 can't be used, saying why, and while another action runs", () => {
    const signIn = sheet({ draft: sizesDraft(), right: { editable: false, reason: "sign_in" } });
    expect(signIn).toMatchObject({ boxesReadOnly: true, reason: "Reconnect eBay to change this.", footer: { primary: { action: "save", disabled: true } } });
    expect(sheet({ draft: sizesDraft(), right: { editable: false, reason: "banner" } })).toMatchObject({ boxesReadOnly: true, reason: null });
    expect(sheet({ draft: sizesDraft(), busy: true })).toMatchObject({ boxesReadOnly: true, reason: null, footer: { primary: { disabled: true } } });
    expect(sheet({ draft: sizesDraft(), busy: true }).rows.every((row) => row.box.readOnly)).toBe(true);
    // Check again needs the right too.
    expect(sheet({ draft: failed("uncertain", LISTING_SETTINGS_SAVE_WORDS.uncertain), right: { editable: false, reason: "sign_in" } }).footer.primary).toMatchObject({ action: "resend", disabled: true });
    // While the first page hasn't answered, Save is off whatever is typed.
    expect(sheet({ pages: [{ data: undefined, error: null }], draft: sizesDraft() }).footer.primary).toMatchObject({ action: "save", disabled: true });
  });
});

describe("never mutates its inputs", () => {
  it("builds every value from frozen inputs without throwing, and returns fresh objects", () => {
    const pages = [page(sizes(101, 3), 0, 3)];
    const draft = sizesDraft();
    const before = JSON.stringify([pages, draft, TYPED]);
    const typed = sizePriceTyped(TYPED, deepFreeze(size(103)), "2");
    expect(typed).not.toBe(TYPED);
    sizePricesEditAction({ draft, size: deepFreeze(size(103)), text: "2" });
    typedSizePrices(typed);
    const rows = sizePricesSaveRows(typed);
    if (rows.ok) {
      sizePricesSignature(STORE, deepFreeze(rows.rows));
      sizePricesBody({ key: "ls-size-prices:1", rows: deepFreeze(rows.rows) });
    }
    sizePricesRefusalOf("DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", deepFreeze({ sizes: [{ productVariantId: 101 }], sizeCount: 1 }));
    reloadTyped(typed, pages);
    sizePriceRows({ pages, value: typed, refusal: deepFreeze({ outsideLimit: new Set([101]), conflicts: new Set() }), readOnly: false });
    sizePricesSheetState(deepFreeze({ pages: [{ data: pages[0], error: null }], draft, right: EDITABLE, busy: false, savedFlashVisible: false, compact: false, refusal: noSizePricesRefusal() }));
    expect(JSON.stringify([pages, draft, TYPED])).toBe(before);
  });
});
