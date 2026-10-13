import { describe, expect, it } from "vitest";
import {
  classifyRequestKeyUse,
  type ListingSettingWriter,
  type RequestKeyUse,
  type RequestKeyUseExpectation,
} from "../../domain/listing-setting-request-key-use";

const STORE = 22;
const OTHER_STORE = 24;
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const PRODUCT = 7;
const CATEGORY = 3;

const NOTHING: RequestKeyUse = Object.freeze({ productRevision: null, categoryRevision: null, ledger: null, children: Object.freeze([]) });

type Source = "productRevision" | "categoryRevision" | "ledger" | "size" | "policy" | "shelf" | "content";

/** One row of `source` with the given store and hash, as the probe would return it. Frozen, so a mutation would throw. */
function useOf(source: Source, fields: { storeConnectionId?: number; requestHash?: string; operation?: string;
  productId?: number; categoryId?: number; requestId?: number | null; productVariantId?: number } = {}): RequestKeyUse {
  const storeConnectionId = fields.storeConnectionId ?? STORE;
  const requestHash = fields.requestHash ?? HASH;
  const use = { ...NOTHING, children: [] as RequestKeyUse["children"][number][] } as {
    -readonly [K in keyof RequestKeyUse]: RequestKeyUse[K] };
  if (source === "productRevision") {
    use.productRevision = { revisionId: 12, productId: fields.productId ?? PRODUCT, storeConnectionId, requestHash,
      requestId: fields.requestId === undefined ? null : fields.requestId };
  } else if (source === "categoryRevision") {
    use.categoryRevision = { revisionId: 13, categoryId: fields.categoryId ?? CATEGORY, storeConnectionId, requestHash };
  } else if (source === "ledger") {
    use.ledger = { requestId: 9, operation: (fields.operation ?? "product_settings_bulk") as never, storeConnectionId, requestHash };
  } else {
    use.children = [{ kind: source, revisionId: 40, productVariantId: fields.productVariantId ?? 101, storeConnectionId, requestHash }];
  }
  return deepFreeze(use);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function merge(...uses: RequestKeyUse[]): RequestKeyUse {
  return deepFreeze({
    productRevision: uses.find((use) => use.productRevision)?.productRevision ?? null,
    categoryRevision: uses.find((use) => use.categoryRevision)?.categoryRevision ?? null,
    ledger: uses.find((use) => use.ledger)?.ledger ?? null,
    children: uses.flatMap((use) => use.children),
  });
}

const expect_ = (writer: ListingSettingWriter, extra: Partial<RequestKeyUseExpectation> = {}): RequestKeyUseExpectation =>
  Object.freeze({ writer, storeConnectionId: STORE, requestHash: HASH, ...extra });

/** What each writer may have written, with the expectation that matches it (plan 4.6 table). */
const WRITERS: ReadonlyArray<{ writer: ListingSettingWriter; expected: RequestKeyUseExpectation; sources: Array<{ source: Source; operation?: string }> }> = [
  { writer: "size_prices", expected: expect_("size_prices", { sizeIds: [101] }), sources: [{ source: "size" }] },
  { writer: "product_settings", expected: expect_("product_settings", { productId: PRODUCT }),
    sources: [{ source: "productRevision" }, { source: "size" }, { source: "policy" }, { source: "shelf" }, { source: "content" }] },
  { writer: "product_settings_bulk", expected: expect_("product_settings_bulk"),
    sources: [{ source: "ledger", operation: "product_settings_bulk" }, { source: "policy" }, { source: "shelf" }, { source: "content" }] },
  { writer: "category_settings", expected: expect_("category_settings", { categoryId: CATEGORY }),
    sources: [{ source: "categoryRevision" }, { source: "ledger", operation: "category_settings_clear" }, { source: "policy" }, { source: "shelf" }] },
  { writer: "price_change_apply", expected: expect_("price_change_apply", { categoryId: CATEGORY }),
    sources: [{ source: "ledger", operation: "price_change_apply" }, { source: "categoryRevision" }, { source: "size" }, { source: "policy" }, { source: "shelf" }] },
  { writer: "category_moves_acknowledge", expected: expect_("category_moves_acknowledge"),
    sources: [{ source: "ledger", operation: "category_moves_acknowledge" }] },
];
const ALL_SOURCES: Source[] = ["productRevision", "categoryRevision", "ledger", "size", "policy", "shelf", "content"];

describe("classifyRequestKeyUse (plan PR 9, P16, section 4.6)", () => {
  it.each(WRITERS.map((entry) => [entry.writer, entry] as const))("%s: nothing found is new", (_writer, entry) => {
    expect(classifyRequestKeyUse(NOTHING, entry.expected)).toEqual({ kind: "new" });
  });

  for (const entry of WRITERS) {
    describe(entry.writer, () => {
      for (const { source, operation } of entry.sources) {
        it(`${source}: another store or another hash is a conflict naming the field`, () => {
          expect(classifyRequestKeyUse(useOf(source, { operation, storeConnectionId: OTHER_STORE }), entry.expected))
            .toEqual({ kind: "conflict", mismatched: [`${source}.storeConnectionId`] });
          expect(classifyRequestKeyUse(useOf(source, { operation, requestHash: OTHER_HASH }), entry.expected))
            .toEqual({ kind: "conflict", mismatched: [`${source}.requestHash`] });
          expect(classifyRequestKeyUse(useOf(source, { operation, storeConnectionId: OTHER_STORE, requestHash: OTHER_HASH }), entry.expected))
            .toEqual({ kind: "conflict", mismatched: [`${source}.requestHash`, `${source}.storeConnectionId`] });
        });
      }

      for (const source of ALL_SOURCES.filter((candidate) => !entry.sources.some((own) => own.source === candidate))) {
        it(`${source}: a kind this writer never writes is a conflict`, () => {
          const decision = classifyRequestKeyUse(useOf(source, { operation: "product_settings_bulk" }), entry.expected);
          expect(decision.kind).toBe("conflict");
        });
      }
    });
  }

  it("a ledger operation the writer never writes is a conflict, whatever the store and hash", () => {
    for (const entry of WRITERS) {
      const foreign = ["product_settings_bulk", "category_settings_clear", "category_moves_acknowledge", "price_change_apply"]
        .filter((operation) => !entry.sources.some((own) => own.source === "ledger" && own.operation === operation));
      for (const operation of foreign) {
        expect(classifyRequestKeyUse(useOf("ledger", { operation }), entry.expected), `${entry.writer} ${operation}`)
          .toEqual({ kind: "conflict", mismatched: ["ledger.operation"] });
      }
    }
  });

  describe("size_prices (W8)", () => {
    const sizes = (...ids: number[]) => merge(...ids.map((productVariantId) => useOf("size", { productVariantId })));

    it("replays when the size children are exactly the body's sizes, in any order", () => {
      expect(classifyRequestKeyUse(sizes(101, 102, 103), expect_("size_prices", { sizeIds: [103, 101, 102] }))).toEqual({ kind: "replay" });
    });

    it("is incomplete when the same hash wrote another set of sizes", () => {
      expect(classifyRequestKeyUse(sizes(101, 102), expect_("size_prices", { sizeIds: [101, 102, 103] }))).toEqual({ kind: "incomplete" });
      expect(classifyRequestKeyUse(sizes(101, 102, 104), expect_("size_prices", { sizeIds: [101, 102, 103] }))).toEqual({ kind: "incomplete" });
      expect(classifyRequestKeyUse(sizes(101, 101), expect_("size_prices", { sizeIds: [101] }))).toEqual({ kind: "incomplete" });
    });

    it("refuses a reused key whose sizes are disjoint from the body's: their hash is another request's (C-feas-6)", () => {
      const earlier = merge(useOf("size", { productVariantId: 201, requestHash: OTHER_HASH }), useOf("size", { productVariantId: 202, requestHash: OTHER_HASH }));
      expect(classifyRequestKeyUse(earlier, expect_("size_prices", { sizeIds: [301, 302] })))
        .toEqual({ kind: "conflict", mismatched: ["size.requestHash"] });
    });

    it("refuses a reused key whose overlapping size had another price (another hash)", () => {
      const earlier = merge(useOf("size", { productVariantId: 101, requestHash: OTHER_HASH }), useOf("size", { productVariantId: 102, requestHash: OTHER_HASH }));
      expect(classifyRequestKeyUse(earlier, expect_("size_prices", { sizeIds: [102, 103] })).kind).toBe("conflict");
    });
  });

  describe("product_settings (W5)", () => {
    it("replays on any of its rows: a save that wrote only size prices or clean-ups replays too (C-money-2)", () => {
      for (const source of ["productRevision", "size", "policy", "shelf", "content"] as const) {
        expect(classifyRequestKeyUse(useOf(source), expect_("product_settings", { productId: PRODUCT })), source).toEqual({ kind: "replay" });
      }
      expect(classifyRequestKeyUse(merge(useOf("productRevision"), useOf("size"), useOf("content")),
        expect_("product_settings", { productId: PRODUCT }))).toEqual({ kind: "replay" });
    });

    it("refuses a product revision of another product, or one a ledger row owns", () => {
      expect(classifyRequestKeyUse(useOf("productRevision", { productId: 8 }), expect_("product_settings", { productId: PRODUCT })))
        .toEqual({ kind: "conflict", mismatched: ["productRevision.productId"] });
      expect(classifyRequestKeyUse(useOf("productRevision", { requestId: 4 }), expect_("product_settings", { productId: PRODUCT })))
        .toEqual({ kind: "conflict", mismatched: ["productRevision.requestId"] });
    });
  });

  describe("ledger writers (W6, W7 apply, W13)", () => {
    it("replay only when the ledger row is found", () => {
      expect(classifyRequestKeyUse(merge(useOf("ledger"), useOf("policy")), expect_("product_settings_bulk"))).toEqual({ kind: "replay" });
      expect(classifyRequestKeyUse(useOf("ledger", { operation: "category_moves_acknowledge" }), expect_("category_moves_acknowledge")))
        .toEqual({ kind: "replay" });
    });

    it("W6: children with no ledger row are incomplete", () => {
      for (const source of ["policy", "shelf", "content"] as const) {
        expect(classifyRequestKeyUse(useOf(source), expect_("product_settings_bulk")), source).toEqual({ kind: "incomplete" });
      }
    });

    it("W7 apply: a category revision or children with no ledger row are incomplete", () => {
      // An apply always writes its ledger row (migration 0750's price_change_apply), even when nothing else changed,
      // so a category revision or a child under its key without one cannot be what a committed apply left.
      for (const source of ["categoryRevision", "size", "policy", "shelf"] as const) {
        expect(classifyRequestKeyUse(useOf(source), expect_("price_change_apply", { categoryId: CATEGORY })), source).toEqual({ kind: "incomplete" });
      }
    });

    it("W7 apply: its ledger row replays alone (a release-only or unchanged apply), with its releases, or with its category and clean-ups", () => {
      const ledger = useOf("ledger", { operation: "price_change_apply" });
      expect(classifyRequestKeyUse(ledger, expect_("price_change_apply"))).toEqual({ kind: "replay" });
      const releases = merge(ledger, useOf("size", { productVariantId: 101 }), useOf("size", { productVariantId: 102 }));
      expect(classifyRequestKeyUse(releases, expect_("price_change_apply"))).toEqual({ kind: "replay" });
      const category = merge(ledger, useOf("categoryRevision"), useOf("policy"), useOf("shelf"));
      expect(classifyRequestKeyUse(category, expect_("price_change_apply", { categoryId: CATEGORY }))).toEqual({ kind: "replay" });
    });

    it("W7 apply: a W6, W12 or W13 ledger row under its key is a key reuse, and a W7 ledger row under theirs", () => {
      for (const operation of ["product_settings_bulk", "category_settings_clear", "category_moves_acknowledge"]) {
        expect(classifyRequestKeyUse(useOf("ledger", { operation }), expect_("price_change_apply", { categoryId: CATEGORY })), operation)
          .toEqual({ kind: "conflict", mismatched: ["ledger.operation"] });
      }
      for (const writer of ["product_settings_bulk", "category_settings", "category_moves_acknowledge"] as const) {
        expect(classifyRequestKeyUse(useOf("ledger", { operation: "price_change_apply" }), expect_(writer, { categoryId: CATEGORY })), writer)
          .toEqual({ kind: "conflict", mismatched: ["ledger.operation"] });
      }
      // A content child: W7 never clears a main text (a category has none).
      expect(classifyRequestKeyUse(merge(useOf("ledger", { operation: "price_change_apply" }), useOf("content")), expect_("price_change_apply")))
        .toEqual({ kind: "conflict", mismatched: ["content"] });
    });

    it("W7 apply of products: any category revision is a conflict", () => {
      expect(classifyRequestKeyUse(useOf("categoryRevision"), expect_("price_change_apply")))
        .toEqual({ kind: "conflict", mismatched: ["categoryRevision"] });
    });
  });

  describe("category_settings (W12)", () => {
    it("replays on any of its rows, and refuses another category's revision", () => {
      for (const source of ["categoryRevision", "policy", "shelf"] as const) {
        expect(classifyRequestKeyUse(useOf(source), expect_("category_settings", { categoryId: CATEGORY })), source).toEqual({ kind: "replay" });
      }
      expect(classifyRequestKeyUse(useOf("ledger", { operation: "category_settings_clear" }), expect_("category_settings", { categoryId: CATEGORY })))
        .toEqual({ kind: "replay" });
      expect(classifyRequestKeyUse(useOf("categoryRevision", { categoryId: 5 }), expect_("category_settings", { categoryId: CATEGORY })))
        .toEqual({ kind: "conflict", mismatched: ["categoryRevision.categoryId"] });
    });
  });

  it("names every mismatched field once, sorted", () => {
    const use = merge(useOf("productRevision", { storeConnectionId: OTHER_STORE }), useOf("size", { requestHash: OTHER_HASH }),
      useOf("policy", { requestHash: OTHER_HASH, productVariantId: 102 }), useOf("ledger"));
    expect(classifyRequestKeyUse(use, expect_("size_prices", { sizeIds: [101] }))).toEqual({ kind: "conflict",
      mismatched: ["ledger.operation", "policy", "policy.requestHash", "productRevision", "productRevision.storeConnectionId", "size.requestHash"] });
  });
});
