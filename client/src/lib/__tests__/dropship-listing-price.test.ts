import { describe, expect, it, vi } from "vitest";
import type { ListingPriceSetting } from "@shared/dropship/listing-price";
import { displayListingPrice, draftFromListingPrice, isListingPriceDirty, listingPriceEndpoint,
  listingPriceInput, parseListingPriceCents, prepareListingPriceSave, readListingPrice, readSavedListingPrice,
  reconcileListingPriceDraft } from "../dropship-listing-price";

const identity = { storeConnectionId: 12, productVariantId: 34 };
function price(): ListingPriceSetting {
  return { ...identity, revisionId: 9, overridePriceCents: 999, effectivePriceCents: 999,
    defaultPriceCents: 899, source: "override", updatedAt: "2026-09-06T12:00:00.000Z" };
}

describe("listing-price decimal boundary", () => {
  it.each([["8.99", 899], ["1", 100], ["1.2", 120], ["0.01", 1], [" 08.09 ", 809],
    ["21474836.47", 2147483647], ["0.29", 29]] as const)("parses %s into exact integer cents", (text, cents) => {
    expect(parseListingPriceCents(text)).toBe(cents);
  });
  it.each(["", " ", "0", "0.00", "-1", "+1", "1.001", "1e3", "1,000", "$8.99", ".99", "9.",
    "Infinity", "NaN", "21474836.48", "9999999999999999999999999999999999999", "0x10"])("rejects %s without rounding", (text) => {
    expect(() => parseListingPriceCents(text)).toThrow();
  });
  it("formats cents without treating an unavailable amount as zero", () => {
    expect(listingPriceInput(809)).toBe("8.09");
    expect(listingPriceInput(1)).toBe("0.01");
    expect(listingPriceInput(null)).toBe("");
    expect(displayListingPrice(null)).toBe("Unavailable");
    expect(displayListingPrice(999)).toBe("$9.99");
    expect(() => listingPriceInput(1.5)).toThrow();
  });
});

describe("saved price draft and retry identity", () => {
  it("starts pristine and only becomes dirty after an actual price change or reset", () => {
    const draft = draftFromListingPrice(price());
    expect(draft).toMatchObject({ useDefault: false, value: "9.99" });
    expect(isListingPriceDirty(draft)).toBe(false);
    expect(isListingPriceDirty({ ...draft, value: "09.99" })).toBe(false);
    expect(isListingPriceDirty({ ...draft, value: "10" })).toBe(true);
    expect(isListingPriceDirty({ ...draft, value: "" })).toBe(true);
    expect(isListingPriceDirty({ ...draft, useDefault: true })).toBe(true);
  });
  it("keeps legacy saved-listing prices distinct from an explicit catalog reset", () => {
    const saved = { ...price(), revisionId: null, overridePriceCents: null, source: "saved_listing" as const, updatedAt: null };
    const draft = draftFromListingPrice(saved);
    expect(draft.useDefault).toBe(false);
    expect(isListingPriceDirty(draft)).toBe(false);
    expect(isListingPriceDirty({ ...draft, useDefault: true })).toBe(true);
    expect(prepareListingPriceSave(identity, { ...draft, useDefault: true }, null, () => "reset-key").request)
      .toEqual({ priceCents: null, expectedRevisionId: null, idempotencyKey: "reset-key" });
  });
  it("uses a real default and leaves missing defaults unavailable", () => {
    const defaults = draftFromListingPrice({ ...price(), overridePriceCents: null, effectivePriceCents: 899, source: "catalog_default" });
    expect(defaults).toMatchObject({ useDefault: true, value: "8.99" });
    expect(isListingPriceDirty(defaults)).toBe(false);
    const unavailable = draftFromListingPrice({ ...price(), overridePriceCents: null, effectivePriceCents: null,
      defaultPriceCents: null, source: "unavailable" });
    expect(unavailable.value).toBe("");
    expect(isListingPriceDirty(unavailable)).toBe(false);
  });
  it("reuses exactly the same payload and key for an ambiguous retry", () => {
    const draft = { ...draftFromListingPrice(price()), value: "12.34" };
    const createKey = vi.fn(() => "first-key");
    const first = prepareListingPriceSave(identity, draft, null, createKey);
    const retry = prepareListingPriceSave(identity, { ...draft, value: "012.34" }, first, createKey);
    expect(retry).toBe(first);
    expect(first.request).toEqual({ priceCents: 1234, expectedRevisionId: 9, idempotencyKey: "first-key" });
    expect(createKey).toHaveBeenCalledTimes(1);
  });
  it("allocates a new key for a changed amount, revision, store or variant", () => {
    const draft = { ...draftFromListingPrice(price()), value: "12.34" };
    const first = prepareListingPriceSave(identity, draft, null, () => "first-key");
    const cases = [
      { identity, draft: { ...draft, value: "12.35" } },
      { identity, draft: { ...draft, baseline: { ...draft.baseline, revisionId: 10 } } },
      { identity: { ...identity, storeConnectionId: 13 }, draft },
      { identity: { ...identity, productVariantId: 35 }, draft },
    ];
    for (const value of cases) {
      const next = prepareListingPriceSave(value.identity, value.draft, first, () => "changed-key");
      expect(next.request.idempotencyKey).toBe("changed-key");
      expect(next.fingerprint).not.toBe(first.fingerprint);
    }
  });
  it("never accepts invalid keys or identities", () => {
    const draft = { ...draftFromListingPrice(price()), value: "12.34" };
    expect(() => prepareListingPriceSave(identity, draft, null, () => "unsafe key")).toThrow();
    expect(() => listingPriceEndpoint({ ...identity, storeConnectionId: 0 })).toThrow();
    expect(() => listingPriceEndpoint({ ...identity, productVariantId: 2147483648 })).toThrow();
    expect(listingPriceEndpoint(identity)).toBe("/api/dropship/listings/stores/12/variants/34/price");
  });
  it("preserves an unsaved amount and concurrency revision on a background refresh", () => {
    const draft = { ...draftFromListingPrice(price()), value: "12.34" };
    const changed = { ...price(), revisionId: 10, overridePriceCents: 1500, effectivePriceCents: 1500 };
    expect(reconcileListingPriceDraft(draft, changed)).toBe(draft);
    expect(reconcileListingPriceDraft(draft, changed).baseline.revisionId).toBe(9);
    expect(reconcileListingPriceDraft(draftFromListingPrice(price()), changed)).toMatchObject({ value: "15.00", baseline: { revisionId: 10 } });
    expect(reconcileListingPriceDraft(null, changed)).toMatchObject({ value: "15.00", baseline: { revisionId: 10 } });
  });
});

describe("price response boundary", () => {
  it("validates reads and saves, including idempotent replays", () => {
    expect(readListingPrice({ price: price() }, identity)).toEqual(price());
    expect(readSavedListingPrice({ price: price(), idempotentReplay: true }, identity)).toEqual(price());
  });
  it.each([{ storeConnectionId: 99 }, { productVariantId: 99 }, { effectivePriceCents: -1 },
    { revisionId: "9" }, { source: "guessed" }, { extraSecret: "not allowed" }])("rejects mismatched or malformed responses %s", (change) => {
    expect(() => readListingPrice({ price: { ...price(), ...change } }, identity)).toThrow();
    expect(() => readSavedListingPrice({ price: { ...price(), ...change }, idempotentReplay: false }, identity)).toThrow();
  });
  it("requires the save replay indicator and does not accept a save response for a GET", () => {
    expect(() => readSavedListingPrice({ price: price() }, identity)).toThrow();
    expect(() => readListingPrice({ price: price(), idempotentReplay: true }, identity)).toThrow();
  });
});
