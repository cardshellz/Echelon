import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Unit test — hourly ShipStation reconcile JOIN shape.
//
// Two invariants this test protects:
//
//   1. P0 cast-safety guard (shipstation-sync-audit.md §4 H3):
//      `wms.orders.oms_fulfillment_order_id` is a varchar(128). A subset of
//      rows contain non-numeric values (Shopify GIDs like
//      `gid://shopify/Order/123`, and historically empty strings). If the
//      JOIN cast `w.oms_fulfillment_order_id::int` ever runs against a
//      non-numeric value, Postgres throws `invalid input syntax for integer`
//      and the outer try/catch aborts the entire hourly sweep. The JOIN
//      must gate the `::int` cast behind the numeric regex so the cast can
//      only ever see digit-only input.
//
//   2. P1 GID coverage (widen reconcile to the 53k historical Shopify-GID
//      rows): when `w.oms_fulfillment_order_id` has shape
//      `gid://shopify/Order/NNN`, the JOIN must match via
//      `o.external_order_id = w.oms_fulfillment_order_id` so those rows are
//      visible to the sweep.
//
// We assert against the actual source of server/index.ts (the runtime truth)
// so a refactor that drops either path fails this test loudly.
// ─────────────────────────────────────────────────────────────────────────────

const INDEX_PATH = resolve(__dirname, "../../../../index.ts");

// Path A — numeric branch, guarded by the regex so the ::int cast can never
// see a non-numeric value.
const PATH_A_REGEX_GUARD = "w.oms_fulfillment_order_id ~ '^[0-9]+$'";
const PATH_A_CAST_JOIN = "o.id = w.oms_fulfillment_order_id::int";

// Path B — Shopify GID branch, joined via external_order_id.
const PATH_B_GID_GUARD = "w.oms_fulfillment_order_id LIKE 'gid://shopify/Order/%'";
const PATH_B_JOIN = "o.external_order_id = w.oms_fulfillment_order_id";

const GUARD_REGEX_JS = /^[0-9]+$/;
// POSIX LIKE semantics mirror — `%` matches any sequence of characters. We
// only need to test whole-string matching of the literal prefix for this
// test since the SQL pattern is anchored implicitly by the LIKE operator
// having no leading wildcard.
const GID_PREFIX_RE = /^gid:\/\/shopify\/Order\/.+$/;

describe("shipstation reconcile :: JOIN shape", () => {
  describe("source-of-truth assertions against server/index.ts", () => {
    const src = readFileSync(INDEX_PATH, "utf8");

    it("Path A (numeric) — regex guard on ::int cast is present", () => {
      // Prevents regression of the P0 cast-crash bug. Must appear inside the
      // disjunctive JOIN, paired with the ::int cast.
      expect(src).toContain(PATH_A_REGEX_GUARD);
      expect(src).toContain(PATH_A_CAST_JOIN);
    });

    it("Path B (GID) — external_order_id join is present", () => {
      // Without both fragments, the 53k historical Shopify-GID WMS rows are
      // invisible to the reconcile sweep.
      expect(src).toContain(PATH_B_GID_GUARD);
      expect(src).toContain(PATH_B_JOIN);
    });

    it("the redundant WHERE regex was removed (now subsumed by JOIN)", () => {
      // The pre-P1 shape had the guard duplicated in both JOIN and WHERE.
      // After P1 the WHERE predicate is gone; the JOIN alone enforces it.
      // This is a softer invariant — we just want to know if a future
      // refactor re-adds it so we can re-evaluate.
      const occurrences = src.split(PATH_A_REGEX_GUARD).length - 1;
      // Occurs exactly once: inside the JOIN.
      expect(occurrences).toBe(1);
    });
  });

  describe("Path A regex semantics (POSIX ~ / JS RegExp parity)", () => {
    it("does NOT match NULL", () => {
      const value: string | null = null;
      const matches = value !== null && GUARD_REGEX_JS.test(value);
      expect(matches).toBe(false);
    });

    it("does NOT match empty string", () => {
      expect(GUARD_REGEX_JS.test("")).toBe(false);
    });

    it("matches a plain numeric string (cast would succeed)", () => {
      expect(GUARD_REGEX_JS.test("12345")).toBe(true);
      expect(GUARD_REGEX_JS.test("1")).toBe(true);
      expect(GUARD_REGEX_JS.test("0")).toBe(true);
    });

    it("does NOT match a Shopify GID (Path A must reject — handled by Path B instead)", () => {
      expect(GUARD_REGEX_JS.test("gid://shopify/Order/123")).toBe(false);
      expect(GUARD_REGEX_JS.test("gid://shopify/Order/5432109876543")).toBe(false);
    });

    it("does NOT match numeric-with-whitespace, numeric-with-sign, or numeric-with-decimal", () => {
      expect(GUARD_REGEX_JS.test(" 123")).toBe(false);
      expect(GUARD_REGEX_JS.test("123 ")).toBe(false);
      expect(GUARD_REGEX_JS.test("-123")).toBe(false);
      expect(GUARD_REGEX_JS.test("+123")).toBe(false);
      expect(GUARD_REGEX_JS.test("12.3")).toBe(false);
    });

    it("does NOT match alphanumeric or arbitrary non-numeric text", () => {
      expect(GUARD_REGEX_JS.test("abc")).toBe(false);
      expect(GUARD_REGEX_JS.test("123abc")).toBe(false);
      expect(GUARD_REGEX_JS.test("abc123")).toBe(false);
    });
  });

  describe("Path B LIKE semantics (GID prefix)", () => {
    it("matches a canonical Shopify order GID", () => {
      expect(GID_PREFIX_RE.test("gid://shopify/Order/123")).toBe(true);
      expect(GID_PREFIX_RE.test("gid://shopify/Order/5432109876543")).toBe(true);
    });

    it("does NOT match a plain numeric string", () => {
      // Plain numeric IDs belong to Path A, not Path B. Both paths matching
      // the same row would still be correct (the JOIN is an OR), but we
      // assert the shapes are disjoint for clarity.
      expect(GID_PREFIX_RE.test("12345")).toBe(false);
    });

    it("does NOT match other Shopify GID resource types", () => {
      // Only Order GIDs carry an oms_fulfillment_order_id mapping. Customer,
      // ProductVariant, FulfillmentOrder, etc. GIDs must be excluded.
      expect(GID_PREFIX_RE.test("gid://shopify/Customer/123")).toBe(false);
      expect(GID_PREFIX_RE.test("gid://shopify/ProductVariant/123")).toBe(false);
      expect(GID_PREFIX_RE.test("gid://shopify/FulfillmentOrder/123")).toBe(false);
    });

    it("does NOT match NULL or empty string", () => {
      const nullValue: string | null = null;
      expect(nullValue !== null && GID_PREFIX_RE.test(nullValue)).toBe(false);
      expect(GID_PREFIX_RE.test("")).toBe(false);
    });
  });

  describe("disjoint-branch safety — no value can crash the ::int cast", () => {
    // The JOIN is `(A_guard AND A_cast) OR (B_guard AND B_join)`. In
    // Postgres, AND short-circuits: if A_guard is false for a row, A_cast
    // is not evaluated. We mirror that here to prove no input class
    // reaches the cast branch except pure digits.
    const cases: Array<{ label: string; input: string | null }> = [
      { label: "NULL", input: null },
      { label: "empty string", input: "" },
      { label: "GID", input: "gid://shopify/Order/42" },
      { label: "whitespace-padded numeric", input: " 42 " },
      { label: "negative numeric", input: "-42" },
      { label: "decimal", input: "42.5" },
      { label: "alphanumeric", input: "42abc" },
      { label: "pure numeric", input: "42" },
    ];

    for (const { label, input } of cases) {
      it(`input=${label}: cast-branch gate matches iff purely digits`, () => {
        const castGate = input !== null && GUARD_REGEX_JS.test(input);
        const expectedGate = input === "42"; // only the pure-numeric case
        expect(castGate).toBe(expectedGate);
      });
    }
  });
});
