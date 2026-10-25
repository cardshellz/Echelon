import { describe, expect, it } from "vitest";
import {
  CATALOG_ARRIVALS_ERROR_CODES,
  CATALOG_ARRIVALS_LEDGER_INTERVAL_MS,
  catalogChooseUrl,
  catalogNewItemsIdempotencyKey,
  catalogNewItemsPayload,
  classifyCatalogJobError,
  decideAcknowledge,
  decideNewForVendor,
  describeCatalogNewItemsEmail,
  describeSelectionRulesConvertedNotice,
  groupNewItems,
  isLedgerStageDue,
  ledgerArrivalsFromSubjects,
  marksNamedByStoredPayload,
  planFirstMarks,
  selectionRulesConvertedIdempotencyKey,
  utcDayOf,
  type CatalogArrivalFact,
  type CatalogArrivalSubject,
  type CatalogNewItemsCategory,
} from "../../domain/catalog-arrivals";
import type { DropshipCatalogExposureRule } from "../../domain/catalog-exposure";
import { DropshipError } from "../../domain/errors";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const CATALOG_INCLUDE: DropshipCatalogExposureRule = { id: 1, scopeType: "catalog", action: "include" };

function subject(overrides: Partial<CatalogArrivalSubject> & { productVariantId: number }): CatalogArrivalSubject {
  return {
    productId: 100, productLineIds: [], category: "Armalope", categoryId: 7, productIsActive: true, variantIsActive: true,
    ...overrides,
  };
}

function arrival(overrides: Partial<CatalogArrivalFact> & { arrivalId: number; productVariantId: number }): CatalogArrivalFact {
  return { productId: 100, categoryId: 7, baseline: false, picked: false, turnedOff: false, ...overrides };
}

function category(overrides: Partial<CatalogNewItemsCategory> & { categoryId: number; categoryName: string }): CatalogNewItemsCategory {
  return { productCount: 1, sizeCount: 1, throughArrivalId: 10, ...overrides };
}

describe("catalog arrivals domain (PLAN-B v4.1 §11)", () => {
  it("runs the ledger stage on the first tick, then at most once an interval (injected clock)", () => {
    expect(CATALOG_ARRIVALS_LEDGER_INTERVAL_MS).toBe(3_600_000);
    expect(isLedgerStageDue(null, NOW)).toBe(true);
    expect(isLedgerStageDue(new Date(NOW.getTime() - 3_599_999), NOW)).toBe(false);
    expect(isLedgerStageDue(new Date(NOW.getTime() - 3_600_000), NOW)).toBe(true);
    // A clock that moved back (another process's tick) never runs it early.
    expect(isLedgerStageDue(new Date(NOW.getTime() + 60_000), NOW)).toBe(false);
  });

  it("admits a size to the ledger only when exposed now and in a category, ascending", () => {
    const later = new Date("2026-10-24T13:00:00.000Z");
    const rules: DropshipCatalogExposureRule[] = [
      { id: 1, scopeType: "category", action: "include", category: " ARMALOPE " },
      { id: 2, scopeType: "product", action: "include", productId: 300, startsAt: later },
    ];
    const subjects = [
      subject({ productVariantId: 5 }),
      subject({ productVariantId: 2 }),
      subject({ productVariantId: 3, categoryId: null }),
      subject({ productVariantId: 4, productId: 200, category: "Toploaders", categoryId: 8 }),
      subject({ productVariantId: 6, productId: 300, category: "Sleeves", categoryId: 9 }),
      subject({ productVariantId: 7, productIsActive: false }),
    ];
    expect(ledgerArrivalsFromSubjects(subjects, rules, NOW)).toEqual([
      { productVariantId: 2, productId: 100, categoryId: 7 },
      { productVariantId: 5, productId: 100, categoryId: 7 },
    ]);
    // A rule that starts later admits its size only once it is effective (announced once effective).
    expect(ledgerArrivalsFromSubjects(subjects, rules, later).map((row) => row.productVariantId)).toEqual([2, 5, 6]);
    expect(subjects.map((row) => row.productVariantId)).toEqual([5, 2, 3, 4, 6, 7]);
  });

  it("first-marks every unmarked sell-from category at the highest arrival id, once each, ascending (FIDELITY-5)", () => {
    expect(planFirstMarks({ sellFromCategoryIds: [9, 7, 8, 9], markedCategoryIds: new Set([8]), maxArrivalId: 42 }))
      .toEqual([{ categoryId: 7, throughArrivalId: 42 }, { categoryId: 9, throughArrivalId: 42 }]);
    expect(planFirstMarks({ sellFromCategoryIds: [7], markedCategoryIds: new Set([7]), maxArrivalId: 42 })).toEqual([]);
    expect(planFirstMarks({ sellFromCategoryIds: [], markedCategoryIds: new Set(), maxArrivalId: 0 })).toEqual([]);
  });

  it("decides new for a vendor: past its watermark, not baseline, sellable, still in the category, exposed, not off, not picked", () => {
    const subjects = new Map([1, 2, 3, 4, 5, 6, 7, 9].map((id) => [id, subject({ productVariantId: id })]));
    subjects.set(6, subject({ productVariantId: 6, categoryId: 8 }));
    subjects.set(9, subject({ productVariantId: 9, productId: 101, categoryId: 7 }));
    const arrivals = [
      arrival({ arrivalId: 20, productVariantId: 1 }), // new
      arrival({ arrivalId: 10, productVariantId: 2 }), // at the watermark
      arrival({ arrivalId: 21, productVariantId: 3, baseline: true }),
      arrival({ arrivalId: 22, productVariantId: 4, picked: true }),
      arrival({ arrivalId: 23, productVariantId: 5, turnedOff: true }),
      arrival({ arrivalId: 24, productVariantId: 6 }), // moved to category 8 since
      arrival({ arrivalId: 25, productVariantId: 8 }), // no longer sellable (no subject)
      arrival({ arrivalId: 26, productVariantId: 9 }), // a new size of another product: new
      arrival({ arrivalId: 27, productVariantId: 7, categoryId: 99 }), // a category without a mark
    ];
    const fresh = decideNewForVendor({ arrivals, watermarks: new Map([[7, 10], [8, 0]]), subjects, exposureRules: [CATALOG_INCLUDE], now: NOW });
    expect(fresh.map((row) => row.arrivalId)).toEqual([20, 26]);
    // Not exposed now (no include rule): nothing is new.
    expect(decideNewForVendor({ arrivals, watermarks: new Map([[7, 10]]), subjects, exposureRules: [], now: NOW })).toEqual([]);
    // No mark means nothing is new, never watermark 0 (FIDELITY-5).
    expect(decideNewForVendor({ arrivals, watermarks: new Map(), subjects, exposureRules: [CATALOG_INCLUDE], now: NOW })).toEqual([]);
  });

  it("counts a new size of a product the vendor already sells (v3 Q1 default)", () => {
    // The pick is per size: size 2 of product 100 is picked, size 1 of the same product arrives.
    const fresh = decideNewForVendor({
      arrivals: [arrival({ arrivalId: 30, productVariantId: 1 }), arrival({ arrivalId: 31, productVariantId: 2, picked: true })],
      watermarks: new Map([[7, 0]]),
      subjects: new Map([[1, subject({ productVariantId: 1 })], [2, subject({ productVariantId: 2 })]]),
      exposureRules: [CATALOG_INCLUDE], now: NOW,
    });
    expect(fresh.map((row) => row.productVariantId)).toEqual([1]);
  });

  it("groups new sizes by category with product and size counts and the highest arrival id, by name then id", () => {
    const grouped = groupNewItems([
      arrival({ arrivalId: 5, productVariantId: 1, categoryId: 8, productId: 1 }),
      arrival({ arrivalId: 9, productVariantId: 2, categoryId: 8, productId: 1 }),
      arrival({ arrivalId: 7, productVariantId: 3, categoryId: 8, productId: 2 }),
      arrival({ arrivalId: 6, productVariantId: 4, categoryId: 7, productId: 3 }),
      arrival({ arrivalId: 8, productVariantId: 5, categoryId: 6, productId: 4 }),
      arrival({ arrivalId: 11, productVariantId: 6, categoryId: 5, productId: 5 }),
    ], new Map([[8, "Armalope"], [7, "toploaders"], [6, "Armalope"]]));
    expect(grouped).toEqual([
      { categoryId: 6, categoryName: "Armalope", productCount: 1, sizeCount: 1, throughArrivalId: 8 },
      { categoryId: 8, categoryName: "Armalope", productCount: 2, sizeCount: 3, throughArrivalId: 9 },
      { categoryId: 7, categoryName: "toploaders", productCount: 1, sizeCount: 1, throughArrivalId: 6 },
    ]);
    expect(groupNewItems([], new Map())).toEqual([]);
  });

  it("keys the email per vendor and UTC day, and the conversion notice per vendor", () => {
    expect(utcDayOf(new Date("2026-10-24T23:59:59.999Z"))).toBe("2026-10-24");
    expect(catalogNewItemsIdempotencyKey(12, new Date("2026-10-24T23:59:59.999Z"))).toBe("catalog-new-items:12:2026-10-24");
    expect(catalogNewItemsIdempotencyKey(12, new Date("2026-10-25T00:00:00.000Z"))).toBe("catalog-new-items:12:2026-10-25");
    // A time zone offset is irrelevant: the day is UTC's.
    expect(catalogNewItemsIdempotencyKey(12, new Date("2026-10-24T20:00:00.000-05:00"))).toBe("catalog-new-items:12:2026-10-25");
    expect(selectionRulesConvertedIdempotencyKey(12)).toBe("selection-rules-converted:12");
    for (const bad of [new Date(Number.NaN), new Date("+012026-01-01T00:00:00.000Z")]) {
      expect(() => utcDayOf(bad)).toThrow(DropshipError);
      try {
        utcDayOf(bad);
      } catch (error) {
        expect(error).toMatchObject({ code: CATALOG_ARRIVALS_ERROR_CODES.invariantFailed, context: { classification: "fatal" } });
      }
    }
  });

  it("writes the §13 email words with and without the portal URL, and caps the list at 20 categories", () => {
    const two = [category({ categoryId: 1, categoryName: "Armalope", sizeCount: 3 }), category({ categoryId: 2, categoryName: "Toploaders", sizeCount: 1_433 })];
    expect(describeCatalogNewItemsEmail({ categories: two, catalogUrl: "https://cardshellz.io/catalog/choose" })).toEqual({
      title: "New items from Card Shellz",
      message: "Card Shellz added new items in categories you sell from: Armalope (3), Toploaders (1,433). Nothing is added until you "
        + "choose them in Catalog, step 1 (Choose what to sell), and publish them in step 3: https://cardshellz.io/catalog/choose",
    });
    expect(describeCatalogNewItemsEmail({ categories: two, catalogUrl: null }).message).toBe(
      "Card Shellz added new items in categories you sell from: Armalope (3), Toploaders (1,433). Nothing is added until you "
      + "choose them in Catalog, step 1 (Choose what to sell), in your Card Shellz dropship portal, and publish them in step 3.");
    const many = Array.from({ length: 21 }, (_, index) => category({ categoryId: index + 1, categoryName: `C${index + 1}` }));
    const oneMore = describeCatalogNewItemsEmail({ categories: many, catalogUrl: null }).message;
    expect(oneMore).toContain("C20 (1) and 1 more category. Nothing");
    expect(oneMore).not.toContain("C21");
    const moreMessage = describeCatalogNewItemsEmail({ categories: [...many, category({ categoryId: 22, categoryName: "C22" })], catalogUrl: null }).message;
    expect(moreMessage).toContain("C20 (1) and 2 more categories. Nothing");
    // The notification service caps a message at 5,000 characters: 20 names of 100 characters stay under it.
    const long = Array.from({ length: 300 }, (_, index) => category({ categoryId: index + 1, categoryName: "x".repeat(100), sizeCount: 999_999 }));
    expect(describeCatalogNewItemsEmail({ categories: long, catalogUrl: `https://${"p".repeat(200)}.example/catalog/choose` }).message.length)
      .toBeLessThan(5_000);
    expect(() => describeCatalogNewItemsEmail({ categories: [], catalogUrl: null })).toThrow(DropshipError);
  });

  it("builds step 1's address from the portal URL, or none for anything unusable", () => {
    expect(catalogChooseUrl("https://cardshellz.io")).toBe("https://cardshellz.io/catalog/choose");
    expect(catalogChooseUrl(" https://cardshellz.io/ ")).toBe("https://cardshellz.io/catalog/choose");
    expect(catalogChooseUrl("https://echelon.example/dropship-portal")).toBe("https://echelon.example/dropship-portal/catalog/choose");
    expect(catalogChooseUrl("http://localhost:5000")).toBe("http://localhost:5000/catalog/choose");
    for (const unusable of [undefined, null, "", "   ", "cardshellz.io", "ftp://cardshellz.io", "javascript:alert(1)"]) {
      expect(catalogChooseUrl(unusable)).toBeNull();
    }
  });

  it("stores the email's categories and through ids, and reads back exactly the marks it named", () => {
    const categories = [category({ categoryId: 8, categoryName: "B", throughArrivalId: 30 }), category({ categoryId: 7, categoryName: "A", throughArrivalId: 12 })];
    const payload = catalogNewItemsPayload(categories);
    expect(payload.throughArrivalId).toBe(30);
    expect(marksNamedByStoredPayload(JSON.parse(JSON.stringify(payload)))).toEqual([
      { categoryId: 7, throughArrivalId: 12 }, { categoryId: 8, throughArrivalId: 30 },
    ]);
    // The caller's categories are not mutated.
    expect(categories[0]).toEqual(category({ categoryId: 8, categoryName: "B", throughArrivalId: 30 }));
    for (const broken of [{}, { throughArrivalId: 1, categories: [] }, { throughArrivalId: 1, categories: [{ categoryId: "7", throughArrivalId: 1 }] },
      { throughArrivalId: -1, categories: [{ categoryId: 7, throughArrivalId: 1 }] }, null]) {
      expect(() => marksNamedByStoredPayload(broken)).toThrow(DropshipError);
    }
    expect(() => catalogNewItemsPayload([])).toThrow(DropshipError);
  });

  it("writes the §13 conversion notice words with the selected count", () => {
    expect(describeSelectionRulesConvertedNotice(1_433)).toEqual({
      title: "Your automatic choices were turned into items",
      message: "Your setting that added new items by itself (for a category, a product or everything) has been replaced. The 1,433 "
        + "items it covered today stay chosen. When Card Shellz adds new items to a category you sell from, you'll see them in "
        + "Catalog, step 1, and nothing is added until you choose it.",
    });
    expect(describeSelectionRulesConvertedNotice(1).message).toContain(" The 1 item it covered today stays chosen. ");
    expect(describeSelectionRulesConvertedNotice(0).message).toContain(" The 0 items it covered today stay chosen. ");
    for (const bad of [-1, 1.5, Number.NaN]) expect(() => describeSelectionRulesConvertedNotice(bad)).toThrow(DropshipError);
  });

  it("decides Got it: refused past the newest arrival, idempotent by state, both watermarks forward only", () => {
    expect(decideAcknowledge({ mark: null, throughArrivalId: 11, maxArrivalId: 10 })).toEqual({ kind: "invalid" });
    expect(decideAcknowledge({ mark: null, throughArrivalId: 10, maxArrivalId: 10 }))
      .toEqual({ kind: "advance", seenThroughArrivalId: 10, notifiedThroughArrivalId: 10 });
    expect(decideAcknowledge({ mark: { seenThroughArrivalId: 9, notifiedThroughArrivalId: 9 }, throughArrivalId: 9, maxArrivalId: 10 }))
      .toEqual({ kind: "already_seen" });
    expect(decideAcknowledge({ mark: { seenThroughArrivalId: 9, notifiedThroughArrivalId: 3 }, throughArrivalId: 5, maxArrivalId: 10 }))
      .toEqual({ kind: "advance", seenThroughArrivalId: 9, notifiedThroughArrivalId: 5 });
    expect(decideAcknowledge({ mark: { seenThroughArrivalId: 0, notifiedThroughArrivalId: 0 }, throughArrivalId: 0, maxArrivalId: 0 }))
      .toEqual({ kind: "already_seen" });
  });

  it.each([
    ["a held publication gate", Object.assign(new Error("PUBLICATION_SELECTION_BUSY"), { code: "55P03" }), "busy", "55P03"],
    ["a deadlock", Object.assign(new Error("deadlock detected"), { code: "40P01" }), "busy", "40P01"],
    ["a serialization failure", Object.assign(new Error("could not serialize"), { code: "40001" }), "busy", "40001"],
    ["an administrator shutdown", Object.assign(new Error("terminating connection"), { code: "57P01" }), "busy", "57P01"],
    ["a reset socket", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), "busy", "ECONNRESET"],
    ["a dropped connection", new Error("Connection terminated unexpectedly"), "busy", null],
    ["a pool with no free client", new Error("timeout exceeded when trying to connect"), "busy", null],
    ["a statement timeout", Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }), "transient", "57014"],
    ["a unique violation", Object.assign(new Error("duplicate key"), { code: "23505" }), "permanent", "23505"],
    ["a check violation", Object.assign(new Error("violates check"), { code: "23514" }), "permanent", "23514"],
    ["a raised exception", Object.assign(new Error("DROPSHIP_SELECTION_RULES_RETIRED"), { code: "P0001" }), "permanent", "P0001"],
    ["a transient DropshipError", new DropshipError("DROPSHIP_LISTING_SETTINGS_BUSY", "busy", { classification: "transient" }), "transient",
      "DROPSHIP_LISTING_SETTINGS_BUSY"],
    ["a permanent DropshipError", new DropshipError("X_REFUSED", "no", { classification: "permanent" }), "permanent", "X_REFUSED"],
    ["a DropshipError without a class", new DropshipError("DROPSHIP_NOTIFICATION_INVALID_SEND", "no"), "permanent",
      "DROPSHIP_NOTIFICATION_INVALID_SEND"],
    ["a fatal DropshipError", new DropshipError("X_INVARIANT", "broken", { classification: "fatal" }), "fatal", "X_INVARIANT"],
    ["an unknown SQLSTATE", Object.assign(new Error("permission denied"), { code: "42501" }), "fatal", "42501"],
    ["a plain error", new TypeError("cannot read properties of undefined"), "fatal", null],
    ["a thrown string", "boom", "fatal", null],
  ])("classifies %s", (_label, error, errorClass, code) => {
    expect(classifyCatalogJobError(error)).toEqual({ errorClass, code });
  });
});
