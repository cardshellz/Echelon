import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { ListingRulesConversionNoticeResponse } from "@shared/dropship/listing-rules-conversion";
import type { ListingSettingsSummary } from "@shared/dropship/listing-settings";
import { LISTING_SETTINGS_OFF_CONTRACT, listingSettingsQueryKey } from "../dropship-listing-settings";
import {
  conversionNoticeAcknowledgeEndpoint,
  conversionNoticeModel,
  conversionNoticeQueryKey,
  conversionNoticeQueryOptions,
  hideConversionNotice,
  noticeLineModel,
  rereadConversionNotice,
  runConversionNoticeAcknowledge,
  type ConversionNoticeAcknowledgeRun,
} from "../dropship-listing-settings-conversion-notice";
import { LISTING_SETTINGS_SAVE_WORDS } from "../dropship-listing-settings-drafts";
import { LISTING_SETTINGS_CONVERSION_WORDS, LISTING_SETTINGS_EDIT_WORDS, conversionNoticeMovedWords } from "../dropship-listing-settings-words";
import { DropshipApiError } from "../dropship-ops-surface";

/*
 * The one-time notice of a system conversion (PR 11e1, plan 9.2, 9.3, 9.4,
 * 11.3, 11.4): its read, its words by the record's counts (singular, plural,
 * one count 0, both 0), the line's gate on the summary (hidden while the store
 * holds older group rules again, D21; shown over 10,000 sizes), and the
 * [Got it] runner (one send, no key, PLAN10 3.3 rows 1-2, a failure keeps
 * the notice, a 404 reads it again).
 */

const STORE = 22;
const W = LISTING_SETTINGS_CONVERSION_WORDS;
const RAW_CODE = /\b[a-z]+_[a-z_]+\b|DROPSHIP_/;

const answer = (notice: Partial<NonNullable<ListingRulesConversionNoticeResponse["notice"]>> | null): ListingRulesConversionNoticeResponse => ({
  storeConnectionId: STORE,
  notice: notice === null ? null : { conversionId: 41, convertedAt: "2026-10-16T09:00:00.000Z", categoryCount: 2, productCount: 5, ...notice },
});
const read = (data: ListingRulesConversionNoticeResponse | undefined, error: unknown = null) => ({ data, error });

/** The summary's older-rules counts, as the line reads them; `too_large` keeps the profiles' counts (the server's too-large summary). */
function summary(groupRules: { price?: number; ebay?: number; description?: number } = {}, catalog: "ok" | "too_large" = "ok") {
  return {
    data: {
      catalog: catalog === "ok" ? { state: "ok", products: 1, sizes: 1 } : { state: "too_large", limit: 10_000 },
      storeDefaults: {
        price: { recipe: null, groupRules: groupRules.price ?? 0 },
        ebayCategory: { category: null, groupRules: groupRules.ebay ?? 0 },
        description: { hasIntroduction: false, hasFooter: false, groupRules: groupRules.description ?? 0 },
      },
    } as unknown as Pick<ListingSettingsSummary, "storeDefaults">,
    error: null,
  };
}

function expectPlain(text: string): void {
  expect(text, text).not.toMatch(RAW_CODE);
  expect(text).not.toMatch(/undefined|null|NaN|\[object|41/);
  expect(text.trim()).toBe(text);
}

describe("the notice's read (9.2, D18)", () => {
  it("is a mount read under the store's prefix, at most 60 seconds old, with no retry, on every store", () => {
    const options = conversionNoticeQueryOptions(STORE);
    expect(options.queryKey).toEqual([...listingSettingsQueryKey(STORE), "conversion-notice"]);
    expect(conversionNoticeQueryKey(STORE)).toEqual(options.queryKey);
    expect(options).toMatchObject({ enabled: true, staleTime: 60_000, retry: false });
    // A store id the contract refuses is never asked for.
    expect(conversionNoticeQueryOptions(0).enabled).toBe(false);
  });

  it("asks the notice route and parses its answer strictly: off the contract, or another store's, never reaches the line", async () => {
    const options = conversionNoticeQueryOptions(STORE);
    const original = globalThis.fetch;
    const asked: string[] = [];
    const respond = (body: unknown) => {
      globalThis.fetch = (async (url: string) => {
        asked.push(String(url));
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch;
    };
    try {
      respond(answer({}));
      await expect(options.queryFn({ signal: new AbortController().signal })).resolves.toEqual(answer({}));
      expect(asked).toEqual([`/api/dropship/listings/stores/${STORE}/listing-settings/conversion/notice`]);
      for (const body of [{ ...answer({}), extra: true }, { ...answer({}), storeConnectionId: 23 }, answer({ categoryCount: 1.5 })]) {
        respond(body);
        await expect(options.queryFn({ signal: new AbortController().signal }))
          .rejects.toMatchObject({ code: LISTING_SETTINGS_OFF_CONTRACT, context: { read: "conversion-notice" } });
      }
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("the notice's words (11.4)", () => {
  it("says what moved by the record's counts, then what products chosen later follow", () => {
    expect(conversionNoticeModel(read(answer({}))))
      .toEqual({ conversionId: 41, text: "We moved your older group rules. 2 categories and 5 products now have their own settings. Nothing in your "
        + "listings changed. Products you choose later use their category's settings or your store defaults.",
      gotIt: { label: "Got it", ariaLabel: "Got it, hide this note" }, failure: null });
  });

  it.each([
    [1, 1, "1 category and 1 product now have their own settings."],
    [1, 0, "1 category now has its own settings."],
    [0, 1, "1 product now has its own settings."],
    [3, 0, "3 categories now have their own settings."],
    [0, 12, "12 products now have their own settings."],
    [2, 1, "2 categories and 1 product now have their own settings."],
    [1_200, 10_000, "1,200 categories and 10,000 products now have their own settings."],
  ])("counts %s categories and %s products in plain words", (categories, products, middle) => {
    const text = conversionNoticeMovedWords(categories, products);
    expect(text).toBe(`We moved your older group rules. ${middle} Nothing in your listings changed.`);
    expect(conversionNoticeModel(read(answer({ categoryCount: categories, productCount: products })))?.text).toBe(`${text} ${W.noticeLater}`);
    expectPlain(text);
  });

  it("says the rules were removed when they decided no category and no product (both counts 0)", () => {
    expect(conversionNoticeModel(read(answer({ categoryCount: 0, productCount: 0 })))?.text)
      .toBe("We removed your older group rules. They didn't decide any of your listings.");
  });

  it("pins the plan's words (PROPOSAL), each plain", () => {
    expect(W).toMatchObject({
      noticeLater: "Products you choose later use their category's settings or your store defaults.",
      noticeRemoved: "We removed your older group rules. They didn't decide any of your listings.",
      gotIt: "Got it",
      gotItName: "Got it, hide this note",
      noticeFailed: "Couldn't save that. Try again.",
    });
    for (const text of [W.noticeLater, W.noticeRemoved, W.gotIt, W.gotItName, W.noticeFailed]) expectPlain(text);
  });
});

describe("the notice's model and the line's gate (9.3, 11.1, D21)", () => {
  it("shows nothing while the read loads, after it failed, and when the store has no unseen notice", () => {
    expect(conversionNoticeModel(read(undefined))).toBeNull();
    expect(conversionNoticeModel(read(answer({}), new TypeError("offline")))).toBeNull();
    expect(conversionNoticeModel(read(answer(null)))).toBeNull();
  });

  it("keeps a failed Got it's words on the notice, which stays", () => {
    expect(conversionNoticeModel(read(answer({})), W.noticeFailed)).toMatchObject({ conversionId: 41, failure: "Couldn't save that. Try again." });
  });

  it("puts the line in the slot only while the summary says the store holds no older group rules", () => {
    expect(noticeLineModel(read(answer({})), summary())).toMatchObject({ conversionId: 41 });
    // A group added back in Older settings (D21): the older-rules line shows instead, never both.
    for (const counts of [{ price: 1 }, { ebay: 2 }, { description: 1 }]) {
      expect(noticeLineModel(read(answer({})), summary(counts))).toBeNull();
    }
    // While the summary loads, or after it failed, nothing is said.
    expect(noticeLineModel(read(answer({})), { data: undefined, error: null })).toBeNull();
    expect(noticeLineModel(read(answer({})), { ...summary(), error: new TypeError("offline") })).toBeNull();
  });

  it("still shows over 10,000 chosen sizes: the server reads no selection for it, and the summary still counts the profiles' rules", () => {
    expect(noticeLineModel(read(answer({})), summary({}, "too_large"))).toMatchObject({ conversionId: 41 });
    expect(noticeLineModel(read(answer({})), summary({ price: 1 }, "too_large"))).toBeNull();
  });
});

describe("[Got it] (9.3; PLAN10 3.3 rows 1-2)", () => {
  function run(overrides: Partial<ConversionNoticeAcknowledgeRun> = {}) {
    const calls: string[] = [];
    const send = vi.fn(async (body: unknown) => { calls.push(`send ${JSON.stringify(body)}`); return { outcome: "acknowledged" }; });
    const hide = vi.fn(async () => { calls.push("hide"); });
    const reread = vi.fn(async () => { calls.push("reread"); });
    return { calls, send, hide, reread, input: { storeConnectionId: STORE, conversionId: 41, send, hide, reread, ...overrides } };
  }

  it("sends one press with the notice's id and no key, then takes the notice off at once and reads it again", async () => {
    const { calls, input } = run();
    await expect(runConversionNoticeAcknowledge(input)).resolves.toEqual({ kind: "acknowledged", outcome: "acknowledged" });
    expect(calls).toEqual(['send {"conversionId":41}', "hide", "reread"]);
    expect(conversionNoticeAcknowledgeEndpoint(STORE)).toBe("/api/dropship/listings/stores/22/listing-settings/conversion/notice/acknowledge");
  });

  it("treats already seen (another device, or an earlier press whose answer was lost) as done, and an answer off its contract too", async () => {
    for (const [raw, outcome] of [[{ outcome: "already_seen" }, "already_seen"], [{ outcome: "seen" }, null], [null, null]] as const) {
      const { input, hide, reread } = run({ send: async () => raw });
      await expect(runConversionNoticeAcknowledge(input)).resolves.toEqual({ kind: "acknowledged", outcome });
      expect([hide.mock.calls.length, reread.mock.calls.length]).toEqual([1, 1]);
    }
  });

  it("stays done when the re-read or the hide fails: the notice is seen, and the read's own error hides the line", async () => {
    const { input } = run({ hide: async () => { throw new Error("cache"); }, reread: async () => { throw new TypeError("offline"); } });
    await expect(runConversionNoticeAcknowledge(input)).resolves.toEqual({ kind: "acknowledged", outcome: "acknowledged" });
  });

  it.each([
    ["429", new DropshipApiError({ status: 429, code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED", message: "Too many." }), LISTING_SETTINGS_SAVE_WORDS.rateLimited],
    ["a signed-out 401", new DropshipApiError({ status: 401, code: "DROPSHIP_AUTH_REQUIRED", message: "Sign in." }), LISTING_SETTINGS_EDIT_WORDS.signedOut],
    ["a dropped answer", new TypeError("Failed to fetch"), W.noticeFailed],
    ["a 503 busy", new DropshipApiError({ status: 503, code: "DROPSHIP_LISTING_SETTINGS_BUSY", message: "Try again." }), W.noticeFailed],
    ["a 500", new DropshipApiError({ status: 500, code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", message: "x" }), W.noticeFailed],
    ["the store's 404", new DropshipApiError({ status: 404, code: "DROPSHIP_STORE_CONNECTION_REQUIRED", message: "x" }), W.noticeFailed],
    ["a 400", new DropshipApiError({ status: 400, code: "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT", message: "x" }), W.noticeFailed],
  ])("keeps the notice after %s, in the page's words, and takes nothing off", async (_label, error, message) => {
    const { input, hide, reread } = run({ send: async () => { throw error; } });
    const outcome = await runConversionNoticeAcknowledge(input);
    expect(outcome).toMatchObject({ kind: "failed", message });
    expectPlain(message);
    expect([hide.mock.calls.length, reread.mock.calls.length]).toEqual([0, 0]);
  });

  it("reads the notice again, with no words, when the server has no such notice for this store (404)", async () => {
    const notFound = new DropshipApiError({ status: 404, code: "DROPSHIP_LISTING_CONVERSION_NOTICE_NOT_FOUND", message: "Not found." });
    const { input, hide, reread } = run({ send: async () => { throw notFound; } });
    await expect(runConversionNoticeAcknowledge(input)).resolves.toEqual({ kind: "gone" });
    expect([hide.mock.calls.length, reread.mock.calls.length]).toEqual([0, 1]);
    // A failed re-read changes nothing: the line hides on the read's error.
    const failing = run({ send: async () => { throw notFound; }, reread: async () => { throw new TypeError("offline"); } });
    await expect(runConversionNoticeAcknowledge(failing.input)).resolves.toEqual({ kind: "gone" });
  });

  it("never sends a body the contract refuses", async () => {
    const { input, send } = run({ conversionId: 0 });
    await expect(runConversionNoticeAcknowledge(input)).resolves.toMatchObject({ kind: "failed", message: W.noticeFailed });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("the notice in the page's cache (9.3)", () => {
  it("takes off only the notice pressed, cancelling reads in flight first, and reads exactly its key again", async () => {
    const queryClient = new QueryClient();
    const key = [...conversionNoticeQueryKey(STORE)];
    queryClient.setQueryData(key, answer({}));
    const cancel = vi.spyOn(queryClient, "cancelQueries");
    await hideConversionNotice(queryClient, STORE, 99);
    expect(queryClient.getQueryData(key)).toEqual(answer({}));
    await hideConversionNotice(queryClient, STORE, 41);
    expect(queryClient.getQueryData(key)).toEqual(answer(null));
    expect(cancel).toHaveBeenCalledWith({ queryKey: key, exact: true });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
    await rereadConversionNotice(queryClient, STORE);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key, exact: true }, { throwOnError: true });
  });
});
