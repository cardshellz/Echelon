import { describe, expect, it } from "vitest";
import {
  listingSettingsUpdatedProductsResponseSchema,
  type ListingSettingsSummary,
  type ListingSettingsUpdatedProductsResponse,
} from "@shared/dropship/listing-settings";
import { CATEGORY_LISTING_SETTING_FIELDS } from "@shared/dropship/listing-setting-values";
import { acknowledgeCategoryMovesInputSchema } from "@shared/dropship/listing-setting-writes";
import { DropshipApiError } from "../dropship-ops-surface";
import { LISTING_SETTINGS_INVALID_REQUEST, listingSettingsQueryKey } from "../dropship-listing-settings";
import type { ListingSettingsRight } from "../dropship-listing-settings-access";
import {
  LISTING_SETTINGS_SAVE_WORDS,
  UPDATED_PRODUCTS_EDITOR_ID,
  productEditorId,
  reduceListingSettingsDraft,
  type ListingSettingsDraft,
  type ListingSettingsDraftAction,
} from "../dropship-listing-settings-drafts";
import { DRAWER_WORDS } from "../dropship-listing-settings-drawer";
import {
  UPDATED_PRODUCTS_PAGE_SIZE,
  UPDATED_PRODUCTS_REQUEST_INVALID,
  UpdatedProductsRequestError,
  acknowledgeBody,
  gotItAllBody,
  gotItBody,
  gotItOutcomeWords,
  gotItSignature,
  heldGotItFor,
  isUpdatedProductsDraft,
  ownTextCheckAction,
  readUpdatedProductsDraft,
  uniqueUpdatedProductRows,
  updatedCategoryName,
  updatedProductRow,
  updatedProductRows,
  updatedProductsDraftValue,
  updatedProductsLine,
  updatedProductsLineQueryOptions,
  updatedProductsPaging,
  updatedProductsReadEnabled,
  updatedProductsSheetQueryOptions,
  updatedProductsSheetState,
  type UpdatedProductsSheetInput,
} from "../dropship-listing-settings-updated";
import { LISTING_SETTINGS_EDIT_WORDS, LISTING_SETTINGS_UPDATED_WORDS, UNNAMED_PRODUCT_WORDS } from "../dropship-listing-settings-words";

/** "Card Shellz updated products" (plan PR 10, 10.2, 10.3, 10.5, D16, D18). */

const STORE = 22;
const GENERATED_AT = "2026-10-14T12:00:00.000Z";
/** A raw code or enum value leaking into vendor words: snake_case or a DROPSHIP_ code. */
const RAW_CODE = /\b[a-z]+_[a-z_]+\b|DROPSHIP_/;

type View = ListingSettingsUpdatedProductsResponse;
type Row = View["rows"][number];

const SLEEVES = { categoryId: 40, name: "Sleeves" };
const TOPLOADERS = { categoryId: 41, name: "Toploaders" };
const BAGS = { categoryId: 42, name: "Bags" };
const NONE = { categoryId: null, name: null };
/** A category Card Shellz deleted since: the mark keeps its id, the name is gone. */
const REMOVED = { categoryId: 43, name: null };

const ROWS: Row[] = [
  { productId: 11, productName: "Penny Sleeves", ownTextNeedsCheck: false, move: { from: SLEEVES, to: TOPLOADERS, changedFields: ["price", "shippingPolicy"] } },
  { productId: 12, productName: "Team Bags", ownTextNeedsCheck: true, move: { from: NONE, to: BAGS, changedFields: [] } },
  { productId: 13, productName: "Shellz Pro Toploader 35pt", ownTextNeedsCheck: false, move: { from: REMOVED, to: NONE, changedFields: ["textAbove", "textBelow"] } },
  { productId: 14, productName: "  ", ownTextNeedsCheck: true, move: null },
];

/** A page the server could send: checked against the shared contract. */
function view(overrides: Partial<View> = {}): View {
  return listingSettingsUpdatedProductsResponseSchema.parse({
    storeConnectionId: STORE,
    page: 0,
    pageSize: 50,
    total: ROWS.length,
    rows: ROWS,
    moves: { total: 3, items: [{ productId: 11, shownCategoryId: 41 }, { productId: 12, shownCategoryId: 42 }, { productId: 13, shownCategoryId: null }] },
    generatedAt: GENERATED_AT,
    ...overrides,
  });
}

const VIEW = view();

function catalog(state: "ok" | "too_large"): { data: Pick<ListingSettingsSummary, "catalog"> } {
  return { data: { catalog: state === "ok" ? { state: "ok", products: 3, sizes: 9 } : { state: "too_large", limit: 10_000 } } };
}

const EDITABLE: ListingSettingsRight = { editable: true, reason: null };

/** Applies actions in order, freezing every draft on the way so a mutation would throw. */
function run(actions: readonly ListingSettingsDraftAction[], start: ListingSettingsDraft | null = null): ListingSettingsDraft | null {
  return actions.reduce<ListingSettingsDraft | null>((draft, action) => {
    const next = reduceListingSettingsDraft(draft === null ? null : Object.freeze(draft), Object.freeze(action));
    return next === null ? null : Object.freeze(next);
  }, start);
}

const ATTEMPT = Object.freeze({ signature: gotItSignature(STORE, [{ productId: 11, shownCategoryId: 41 }]), key: "ls-moves:first" });

/** A "Got it" draft for Penny Sleeves, sent with ATTEMPT. */
function gotItDraft(...after: ListingSettingsDraftAction[]): ListingSettingsDraft {
  const draft = run([
    { type: "open", editor: UPDATED_PRODUCTS_EDITOR_ID, place: LISTING_SETTINGS_UPDATED_WORDS.title, base: updatedProductsDraftValue(gotItBody(ROWS[0])) },
    { type: "startSave", attempt: ATTEMPT },
    ...after,
  ]);
  if (draft === null) throw new Error("expected a draft");
  return draft;
}

function sheet(overrides: Partial<UpdatedProductsSheetInput> = {}) {
  return updatedProductsSheetState({
    read: { data: VIEW, error: null }, draft: null, right: EDITABLE, busy: false, nowMs: 1_000, lastAnswer: null, lastDone: false, ...overrides,
  });
}

function expectPlain(text: string | null): void {
  if (text === null) return;
  expect(text).not.toMatch(RAW_CODE);
  expect(text.trim()).toBe(text);
  expect(text.length).toBeGreaterThan(0);
}

describe("the read (plan 10.2, D10, D18)", () => {
  it("runs page 0 for the line under the store's prefix, at most a minute old, only while the selection isn't too large", () => {
    const options = updatedProductsLineQueryOptions(STORE, catalog("ok"));
    expect(options.queryKey).toEqual([...listingSettingsQueryKey(STORE), "updated-products", 0]);
    expect(options).toMatchObject({ enabled: true, staleTime: 60_000, retry: false });
    // While the summary loads, or failed, the read runs; a 422 then goes to the banner (D18).
    expect(updatedProductsReadEnabled({ data: undefined, error: null })).toBe(true);
    expect(updatedProductsReadEnabled({ data: undefined, error: new TypeError("offline") })).toBe(true);
    expect(updatedProductsReadEnabled(catalog("ok"))).toBe(true);
    expect(updatedProductsReadEnabled(catalog("too_large"))).toBe(false);
    expect(updatedProductsLineQueryOptions(STORE, catalog("too_large")).enabled).toBe(false);
  });

  it("reads the open sheet's page fresh each time, off while closed or too large, and refuses a page outside the contract", async () => {
    const open = updatedProductsSheetQueryOptions(STORE, 2, catalog("ok"), true);
    expect(open.queryKey).toEqual([...listingSettingsQueryKey(STORE), "updated-products", 2]);
    expect(open).toMatchObject({ enabled: true, staleTime: 0, retry: false });
    // The line's page 0 and the sheet's page 0 share one cached answer.
    expect(updatedProductsSheetQueryOptions(STORE, 0, catalog("ok"), true).queryKey).toEqual(updatedProductsLineQueryOptions(STORE, catalog("ok")).queryKey);
    expect(updatedProductsSheetQueryOptions(STORE, 0, catalog("ok"), false).enabled).toBe(false);
    expect(updatedProductsSheetQueryOptions(STORE, 0, catalog("too_large"), true).enabled).toBe(false);
    for (const page of [-1, 1.5, 200, Number.NaN]) {
      const bad = updatedProductsSheetQueryOptions(STORE, page, catalog("ok"), true);
      expect({ page, enabled: bad.enabled }).toEqual({ page, enabled: false });
      await expect(bad.queryFn({ signal: new AbortController().signal })).rejects.toMatchObject({ code: LISTING_SETTINGS_INVALID_REQUEST, context: { read: "updated-products" } });
    }
    expect(updatedProductsSheetQueryOptions(0, 0, catalog("ok"), true).enabled).toBe(false);
  });
});

describe("the rows (plan 10.3)", () => {
  it("Got it sends the product with the category it is shown in now, null for no category; a row without a move has nothing to send", () => {
    expect(gotItBody(ROWS[0])).toEqual({ items: [{ productId: 11, shownCategoryId: 41 }] });
    expect(gotItBody(ROWS[2])).toEqual({ items: [{ productId: 13, shownCategoryId: null }] });
    expect(() => gotItBody(ROWS[3])).toThrow(/Only a moved product/);
    // Each is what W13 takes, as it is.
    for (const row of ROWS.slice(0, 3)) expect(acknowledgeCategoryMovesInputSchema.safeParse({ idempotencyKey: "ls-moves:1", ...gotItBody(row) }).success).toBe(true);
  });

  it("Got it for all sends moves.items unchanged", () => {
    const all = gotItAllBody(VIEW);
    expect(all.items).toBe(VIEW.moves.items);
    expect(all).toEqual({ items: [{ productId: 11, shownCategoryId: 41 }, { productId: 12, shownCategoryId: 42 }, { productId: 13, shownCategoryId: null }] });
    expect(acknowledgeCategoryMovesInputSchema.safeParse({ idempotencyKey: "ls-moves:1", ...all }).success).toBe(true);
  });

  it("lists the category settings that differ in the stored order, as given, never re-sorted", () => {
    expect(updatedProductRow(ROWS[0]).move?.changes).toBe("Category settings that differ: price, shipping policy.");
    expect(updatedProductRow(ROWS[2]).move?.changes).toBe("Category settings that differ: text above, text below.");
    // The server's order stands even when it isn't the stored shape's (the page never sorts).
    const reversed: Row = { ...ROWS[0], move: { ...ROWS[0].move!, changedFields: ["textBelow", "price"] } };
    expect(updatedProductRow(reversed).move?.changes).toBe("Category settings that differ: text below, price.");
    const every: Row = { ...ROWS[0], move: { ...ROWS[0].move!, changedFields: [...CATEGORY_LISTING_SETTING_FIELDS] } };
    expect(updatedProductRow(every).move?.changes)
      .toBe("Category settings that differ: price, eBay category, store shelf, shipping policy, return policy, payment policy, text above, text below.");
  });

  it("says \"No category setting changes for it.\" when none differ, never \"Nothing changes\" (UX-M6)", () => {
    const row = updatedProductRow(ROWS[1]);
    expect(row.move?.changes).toBe("No category setting changes for it.");
    expect(row.move?.changes).not.toMatch(/Nothing changes/);
    expect(LISTING_SETTINGS_UPDATED_WORDS.noChanges).toBe("No category setting changes for it.");
  });

  it("names no category and a category Card Shellz removed (CC-C21)", () => {
    expect(updatedCategoryName(SLEEVES)).toBe("Sleeves");
    expect(updatedCategoryName(NONE)).toBe("no category");
    expect(updatedCategoryName(REMOVED)).toBe("a category Card Shellz removed");
    expect(updatedProductRow(ROWS[0]).move?.text).toBe("Moved from Sleeves to Toploaders.");
    expect(updatedProductRow(ROWS[1]).move?.text).toBe("Moved from no category to Bags.");
    expect(updatedProductRow(ROWS[2]).move?.text).toBe("Moved from a category Card Shellz removed to no category.");
  });

  it("builds each row's buttons, named for its product, and the own-text Check that opens the drawer's Description (D20)", () => {
    const rows = updatedProductRows(VIEW);
    expect(rows.map((row) => [row.key, row.productName, row.move !== null, row.ownText !== null])).toEqual([
      ["product:11", "Penny Sleeves", true, false],
      ["product:12", "Team Bags", true, true],
      ["product:13", "Shellz Pro Toploader 35pt", true, false],
      ["product:14", "A product", false, true],
    ]);
    expect(rows[0].move?.gotIt).toEqual({ label: "Got it", ariaLabel: "Got it for Penny Sleeves", body: { items: [{ productId: 11, shownCategoryId: 41 }] } });
    expect(rows[1].ownText).toEqual({
      text: "Card Shellz changed this product. Check your text still fits.",
      check: {
        label: "Check",
        ariaLabel: "Check the text of Team Bags",
        action: { kind: "open_product", label: "Check", productId: 12, fix: "own_text_needs_check", row: "descriptionTemplate" },
      },
    });
    expect(rows[1].ownText?.text).toBe(LISTING_SETTINGS_EDIT_WORDS.ownTextCheck);
    expect(rows[3].move).toBeNull();
    expect(rows[3].productName).toBe(UNNAMED_PRODUCT_WORDS);
    expect(rows[3].ownText?.check.ariaLabel).toBe("Check the text of A product");
    expect(ownTextCheckAction({ productId: 7 })).toEqual({ kind: "open_product", label: "Check", productId: 7, fix: "own_text_needs_check", row: "descriptionTemplate" });
    for (const row of rows) {
      expectPlain(row.productName);
      if (row.move) for (const text of [row.move.text, row.move.changes, row.move.gotIt.label, row.move.gotIt.ariaLabel]) expectPlain(text);
      if (row.ownText) for (const text of [row.ownText.text, row.ownText.check.label, row.ownText.check.ariaLabel]) expectPlain(text);
    }
  });

  it("lists a phone's loaded pages together with each product once, the first row winning, in the pages' order", () => {
    const [penny, team, pro, unnamed] = updatedProductRows(VIEW);
    // After a Got it on page 0, page 0's new answer lists the product that led page 1 while page 1's old answer still does.
    expect(uniqueUpdatedProductRows([[penny, team, pro], [pro, unnamed]])).toEqual([penny, team, pro, unnamed]);
    // The first row for a product wins (page 0's, the fresher one when the pages are read again in order).
    const older = { ...pro, productName: "An older name" };
    expect(uniqueUpdatedProductRows([[pro], [older]]).map((row) => row.productName)).toEqual([pro.productName]);
    expect(uniqueUpdatedProductRows([[penny, team], [pro, unnamed]])).toEqual([penny, team, pro, unnamed]);
    expect(uniqueUpdatedProductRows([])).toEqual([]);
    expect(uniqueUpdatedProductRows([[], []])).toEqual([]);
  });
});

describe("after a Got it (plan 10.3, 10.6)", () => {
  it("counts what moved again from the answer, singular and plural, and says Done. with none", () => {
    expect(gotItOutcomeWords({ outcome: "acknowledged", acknowledgedProductIds: [11], movedAgainProductIds: [12, 13] })).toEqual({
      done: "Done.",
      movedAgain: "2 products moved again. Check them below. It can take a minute to update.",
    });
    expect(gotItOutcomeWords({ outcome: "acknowledged", acknowledgedProductIds: [], movedAgainProductIds: [12] }).movedAgain)
      .toBe("1 product moved again. Check it below. It can take a minute to update.");
    expect(gotItOutcomeWords({ outcome: "acknowledged", acknowledgedProductIds: [11, 12, 13], movedAgainProductIds: [] })).toEqual({ done: "Done.", movedAgain: null });
    const many = Array.from({ length: 1_240 }, (_, index) => index + 1);
    expect(gotItOutcomeWords({ outcome: "acknowledged", acknowledgedProductIds: [], movedAgainProductIds: many }).movedAgain)
      .toBe("1,240 products moved again. Check them below. It can take a minute to update.");
  });

  it("a replay names no product: Done. and the re-read only; an answer the page couldn't read says Done. too", () => {
    expect(gotItOutcomeWords({ outcome: "replayed", acknowledgedProductIds: [], movedAgainProductIds: [] })).toEqual({ done: "Done.", movedAgain: null });
    expect(gotItOutcomeWords(null)).toEqual({ done: "Done.", movedAgain: null });
  });
});

describe("the line under the attention strip (plan 10.2, UX-M9, UX-M10)", () => {
  it("counts the moved products, singular and plural, with [Review]", () => {
    expect(updatedProductsLine({ data: VIEW }, catalog("ok"))).toEqual({ text: "Card Shellz moved 3 products to another category.", label: "Review" });
    expect(updatedProductsLine({ data: { moves: { total: 1, items: [{ productId: 11, shownCategoryId: 41 }] } } }, catalog("ok"))?.text)
      .toBe("Card Shellz moved 1 product to another category.");
    const items = Array.from({ length: 1_240 }, (_, index) => ({ productId: index + 1, shownCategoryId: 41 }));
    expect(updatedProductsLine({ data: { moves: { total: 1_240, items } } }, catalog("ok"))?.text).toBe("Card Shellz moved 1,240 products to another category.");
    // While the summary loads or failed the read runs, and its answer shows.
    expect(updatedProductsLine({ data: VIEW }, { data: undefined, error: null })?.text).toBe("Card Shellz moved 3 products to another category.");
    expect(updatedProductsLine({ data: VIEW }, { data: undefined, error: new TypeError("offline") })).not.toBeNull();
  });

  it("shows nothing while the read loads, failed or counts no move, or while the selection is too large: a failed mount read hides the line, no banner", () => {
    expect(updatedProductsLine({ data: undefined, error: null }, catalog("ok"))).toBeNull();
    expect(updatedProductsLine({ data: { moves: { total: 0, items: [] } } }, catalog("ok"))).toBeNull();
    // The latest attempt wins: an older answer a failed refetch replaced is not shown.
    expect(updatedProductsLine({ data: VIEW, error: new TypeError("offline") }, catalog("ok"))).toBeNull();
    expect(updatedProductsLine({ data: undefined, error: new DropshipApiError({ status: 422, code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", message: "Too large." }) }, catalog("ok"))).toBeNull();
    // D18: the read is off while the summary says too large, and an answer read before it said so is not shown either (the banner explains).
    expect(updatedProductsLine({ data: VIEW }, catalog("too_large"))).toBeNull();
    expect(updatedProductsLine({ data: undefined, error: null }, catalog("too_large"))).toBeNull();
  });
});

describe("the request (plan 10.2, 10.4, D5, D16)", () => {
  it("the draft holds the items as base and value, frozen, and reads them back; anything else is not a Got it", () => {
    const value = updatedProductsDraftValue(gotItAllBody(VIEW));
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.items)).toBe(true);
    expect(readUpdatedProductsDraft(value)).toEqual({ items: VIEW.moves.items });
    const draft = run([{ type: "open", editor: UPDATED_PRODUCTS_EDITOR_ID, place: LISTING_SETTINGS_UPDATED_WORDS.title, base: value }]);
    expect(draft).toMatchObject({ editor: "updatedProducts", changes: 0, phase: "editing" });
    expect(isUpdatedProductsDraft(draft)).toBe(true);
    expect(isUpdatedProductsDraft(null)).toBe(false);
    expect(isUpdatedProductsDraft({ editor: productEditorId(11) })).toBe(false);
    for (const bad of [{}, { items: [] }, { items: [{ productId: 11, shownCategoryId: 41 }, { productId: 11, shownCategoryId: 41 }] }, { items: [{ productId: 0, shownCategoryId: null }] }, { policyId: "x" }]) {
      expect(readUpdatedProductsDraft(bad)).toBeNull();
    }
  });

  it("a Got it pressed again after a rate limit or a lost connection is the held draft, with its key; any other press is a new request", () => {
    const items = gotItBody(ROWS[0]).items;
    const limited = gotItDraft({ type: "failure", key: ATTEMPT.key, failure: { phase: "rate_limited", message: LISTING_SETTINGS_SAVE_WORDS.rateLimited, code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED", status: 429 } });
    expect(limited.attempt).toEqual(ATTEMPT);
    expect(heldGotItFor(limited, STORE, items)).toBe(limited);
    const unreachable = gotItDraft({ type: "failure", key: ATTEMPT.key, failure: { phase: "unreachable", message: LISTING_SETTINGS_SAVE_WORDS.unreachable, code: null, status: null } });
    expect(heldGotItFor(unreachable, STORE, items)).toBe(unreachable);
    // Other items, or another store: a new request.
    expect(heldGotItFor(limited, STORE, gotItBody(ROWS[1]).items)).toBeNull();
    expect(heldGotItFor(limited, 23, items)).toBeNull();
    // A Got it out or unconfirmed is never pressed again from a row; a refused one, a confirmed one and no draft start afresh.
    expect(heldGotItFor(gotItDraft(), STORE, items)).toBeNull();
    const uncertain = gotItDraft({ type: "failure", key: ATTEMPT.key, failure: { phase: "uncertain", message: LISTING_SETTINGS_SAVE_WORDS.uncertain, code: null, status: null } });
    expect(heldGotItFor(uncertain, STORE, items)).toBeNull();
    const refused = gotItDraft({ type: "failure", key: ATTEMPT.key, failure: { phase: "refused", message: "Nothing was saved.", code: "DROPSHIP_IDEMPOTENCY_CONFLICT", status: 409 } });
    expect(refused.attempt).toBeNull();
    expect(heldGotItFor(refused, STORE, items)).toBeNull();
    expect(heldGotItFor(gotItDraft({ type: "saved", key: ATTEMPT.key, nowMs: 1_000 }), STORE, items)).toBeNull();
    expect(heldGotItFor(null, STORE, items)).toBeNull();
    // Another editor's draft is never a Got it.
    expect(heldGotItFor(run([{ type: "open", editor: productEditorId(11), place: "Penny Sleeves", base: {} }]), STORE, items)).toBeNull();
  });

  it("the signature names the store and the items in any order, so the same Got it reuses its key", () => {
    const one = gotItSignature(STORE, [{ productId: 12, shownCategoryId: 42 }, { productId: 11, shownCategoryId: 41 }]);
    expect(one).toBe(gotItSignature(STORE, [{ productId: 11, shownCategoryId: 41 }, { productId: 12, shownCategoryId: 42 }]));
    expect(JSON.parse(one)).toEqual({ v: 1, writer: "W13", storeConnectionId: STORE, items: [{ productId: 11, shownCategoryId: 41 }, { productId: 12, shownCategoryId: 42 }] });
    expect(one).not.toBe(gotItSignature(STORE, [{ productId: 11, shownCategoryId: 41 }]));
    expect(one).not.toBe(gotItSignature(STORE, [{ productId: 12, shownCategoryId: null }, { productId: 11, shownCategoryId: 41 }]));
    expect(one).not.toBe(gotItSignature(23, [{ productId: 12, shownCategoryId: 42 }, { productId: 11, shownCategoryId: 41 }]));
  });

  it("builds the body the shared schema accepts, items in the order given, and refuses what it would refuse before anything is sent", () => {
    const body = acknowledgeBody({ key: "ls-moves:first", items: VIEW.moves.items });
    expect(body).toEqual({ idempotencyKey: "ls-moves:first", items: [{ productId: 11, shownCategoryId: 41 }, { productId: 12, shownCategoryId: 42 }, { productId: 13, shownCategoryId: null }] });
    expect(acknowledgeCategoryMovesInputSchema.safeParse(body).success).toBe(true);
    const tooMany = Array.from({ length: 10_001 }, (_, index) => ({ productId: index + 1, shownCategoryId: null }));
    for (const [name, input] of [
      ["a key under 8 characters", { key: "x:1", items: VIEW.moves.items }],
      ["a key with a space", { key: "ls moves:first", items: VIEW.moves.items }],
      ["no item", { key: "ls-moves:first", items: [] }],
      ["a product twice", { key: "ls-moves:first", items: [{ productId: 11, shownCategoryId: 41 }, { productId: 11, shownCategoryId: null }] }],
      ["10,001 items", { key: "ls-moves:first", items: tooMany }],
    ] as const) {
      let caught: unknown;
      try {
        acknowledgeBody(input);
      } catch (error) {
        caught = error;
      }
      expect({ name, caught: caught instanceof UpdatedProductsRequestError }).toEqual({ name, caught: true });
      expect((caught as UpdatedProductsRequestError).code).toBe(UPDATED_PRODUCTS_REQUEST_INVALID);
    }
    expect(acknowledgeBody({ key: "ls-moves:first", items: Array.from({ length: 10_000 }, (_, index) => ({ productId: index + 1, shownCategoryId: null })) }).items).toHaveLength(10_000);
  });
});

describe("paging (plan 10.3)", () => {
  it("counts 50 a page, with Load more for a phone", () => {
    expect(UPDATED_PRODUCTS_PAGE_SIZE).toBe(50);
    expect(updatedProductsPaging({ page: 0, total: 120 })).toEqual({ page: 0, pageCount: 3, hasPrevious: false, hasNext: true, text: "1–50 of 120", loadMoreLabel: "Load more" });
    expect(updatedProductsPaging({ page: 2, total: 120 })).toMatchObject({ pageCount: 3, hasPrevious: true, hasNext: false, text: "101–120 of 120" });
    expect(updatedProductsPaging({ page: 0, total: 4 })).toMatchObject({ pageCount: 1, hasPrevious: false, hasNext: false, text: "1–4 of 4" });
    expect(updatedProductsPaging({ page: 0, total: 0 })).toMatchObject({ pageCount: 1, hasNext: false, text: null });
    expect(updatedProductsPaging({ page: 0, total: 1_240 }).text).toBe("1–50 of 1,240");
    // A page past the rows (they shrank after a Got it): no text, and no next.
    expect(updatedProductsPaging({ page: 3, total: 120 })).toMatchObject({ hasPrevious: true, hasNext: false, text: null });
  });
});

describe("the sheet (plan 10.3, 3.7)", () => {
  it("shows its title, the rows, Got it for all N and the paging from an answered read", () => {
    const state = sheet();
    expect(state).toMatchObject({
      title: "Card Shellz updated products", read: "answered", loadingLine: null, problem: null, empty: null,
      buttonsDisabled: false, reason: null, lines: [], checkAgain: { label: "Check again", shown: false }, reload: { label: "Reload", shown: false },
      escapeKeepsOpen: false,
    });
    expect(state.rows.map((row) => row.key)).toEqual(["product:11", "product:12", "product:13", "product:14"]);
    expect(state.gotItAll).toEqual({ label: "Got it for all 3", shown: true, disabled: false, body: { items: VIEW.moves.items } });
    expect(state.paging?.text).toBe("1–4 of 4");
  });

  it("says it is checking, that the read failed with Try again, or that too many checks were made (D10)", () => {
    expect(sheet({ read: { data: undefined, error: null } })).toMatchObject({ read: "loading", loadingLine: LISTING_SETTINGS_UPDATED_WORDS.loading, rows: [], buttonsDisabled: true, gotItAll: { shown: false, disabled: true, body: null }, paging: null });
    expect(sheet({ read: { data: VIEW, error: new TypeError("offline") } })).toMatchObject({
      read: "failed", problem: { kind: "failed", text: "Couldn't check what Card Shellz updated. Try again.", retryLabel: "Try again" }, rows: [], buttonsDisabled: true,
    });
    expect(sheet({ read: { data: undefined, error: new DropshipApiError({ status: 429, code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED", message: "Slow down." }) } }).problem)
      .toEqual({ kind: "rate_limited", text: DRAWER_WORDS.readRateLimited, retryLabel: "Try again" });
  });

  it("says nothing is here when the page has no row, and hides Got it for all", () => {
    const empty = view({ total: 0, rows: [], moves: { total: 0, items: [] } });
    expect(sheet({ read: { data: empty } })).toMatchObject({ read: "answered", empty: "Nothing here. Card Shellz hasn't updated any of your products.", rows: [], gotItAll: { shown: false, disabled: true, body: null } });
    // Own-text rows only: rows, but no move to Got it for.
    const textOnly = view({ total: 1, rows: [ROWS[3]], moves: { total: 0, items: [] } });
    expect(sheet({ read: { data: textOnly } })).toMatchObject({ empty: null, gotItAll: { label: "Got it for all 0", shown: false } });
    expect(sheet({ read: { data: textOnly } }).rows).toHaveLength(1);
  });

  it("takes the buttons away without the right (its own line, or the banner's), while another action runs, and while a Got it is out", () => {
    expect(sheet({ right: { editable: false, reason: "loading" } })).toMatchObject({ buttonsDisabled: true, reason: "Checking…", gotItAll: { disabled: true } });
    expect(sheet({ right: { editable: false, reason: "banner" } })).toMatchObject({ buttonsDisabled: true, reason: null });
    expect(sheet({ busy: true })).toMatchObject({ buttonsDisabled: true, reason: null });
    const saving = sheet({ draft: gotItDraft() });
    expect(saving).toMatchObject({ buttonsDisabled: true, lines: [{ text: "Saving…", tone: "info" }], escapeKeepsOpen: true, checkAgain: { shown: false } });
    // Another editor's draft locks nothing here.
    const other = run([{ type: "open", editor: productEditorId(11), place: "Penny Sleeves", base: { a: 1 } }, { type: "edit", value: { a: 2 } }]);
    expect(sheet({ draft: other })).toMatchObject({ buttonsDisabled: false, lines: [], escapeKeepsOpen: false });
  });

  it("offers Check again on an unconfirmed Got it, its words, and Reload after one whose re-read failed", () => {
    const uncertain = gotItDraft({ type: "failure", key: ATTEMPT.key, failure: { phase: "uncertain", message: LISTING_SETTINGS_SAVE_WORDS.uncertain, code: null, status: null } });
    expect(sheet({ draft: uncertain })).toMatchObject({
      buttonsDisabled: true, lines: [{ text: "We couldn't confirm your save.", tone: "alert" }], checkAgain: { shown: true }, escapeKeepsOpen: true,
    });
    const refused = gotItDraft({ type: "failure", key: ATTEMPT.key, failure: { phase: "refused", message: "Something changed since you last tried. Save again.", code: "DROPSHIP_IDEMPOTENCY_CONFLICT", status: 409 } });
    expect(sheet({ draft: refused })).toMatchObject({ buttonsDisabled: false, lines: [{ text: "Something changed since you last tried. Save again.", tone: "alert" }], checkAgain: { shown: false }, escapeKeepsOpen: false });
    const blocked = gotItDraft({ type: "failure", key: ATTEMPT.key, failure: { phase: "blocked", message: "Nothing was saved.", code: "DROPSHIP_LISTING_STORE_BLOCKED", status: 403 } });
    expect(sheet({ draft: blocked, right: { editable: false, reason: "banner" } })).toMatchObject({ buttonsDisabled: true, lines: [{ text: "Nothing was saved.", tone: "alert" }] });
    const stale = gotItDraft({ type: "saved", key: ATTEMPT.key, nowMs: 1_000, viewStale: true });
    expect(sheet({ draft: stale, lastDone: true })).toMatchObject({ reload: { shown: true }, lines: [{ text: "Saved. We couldn't load the latest view.", tone: "alert" }] });
  });

  it("says Done. after a confirmed Got it, with what moved again from the answer, and keeps it after the flash", () => {
    const saved = gotItDraft({ type: "saved", key: ATTEMPT.key, nowMs: 1_000 });
    const answer = { outcome: "acknowledged" as const, acknowledgedProductIds: [11], movedAgainProductIds: [12, 13] };
    expect(sheet({ draft: saved, lastAnswer: answer, lastDone: true, nowMs: 2_000 }).lines).toEqual([
      { text: "Done.", tone: "ok" },
      { text: "2 products moved again. Check them below. It can take a minute to update.", tone: "info" },
    ]);
    // After the flash the draft goes (the provider's tick closes it): the sheet keeps the words it was given.
    expect(sheet({ draft: null, lastAnswer: answer, lastDone: true, nowMs: 9_000 }).lines).toHaveLength(2);
    expect(sheet({ draft: saved, lastAnswer: { ...answer, movedAgainProductIds: [] }, lastDone: true, nowMs: 2_000 }).lines).toEqual([{ text: "Done.", tone: "ok" }]);
    expect(sheet({ draft: saved, lastAnswer: null, lastDone: true, nowMs: 2_000 }).lines).toEqual([{ text: "Done.", tone: "ok" }]);
    // Nothing confirmed yet: no line.
    expect(sheet({ lastAnswer: answer, lastDone: false }).lines).toEqual([]);
    // A new Got it out replaces the words.
    expect(sheet({ draft: gotItDraft(), lastAnswer: answer, lastDone: true }).lines).toEqual([{ text: "Saving…", tone: "info" }]);
  });

  it("keeps every word plain", () => {
    for (const words of Object.values(LISTING_SETTINGS_UPDATED_WORDS)) expectPlain(words);
    const state = sheet({ draft: gotItDraft({ type: "saved", key: ATTEMPT.key, nowMs: 1_000 }), lastAnswer: { outcome: "acknowledged", acknowledgedProductIds: [11], movedAgainProductIds: [12] }, lastDone: true });
    for (const text of [state.title, state.gotItAll.label, state.paging?.text ?? null, ...state.lines.map((line) => line.text)]) expectPlain(text);
  });
});
