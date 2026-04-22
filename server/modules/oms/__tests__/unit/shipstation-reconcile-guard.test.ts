import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Unit test — hourly ShipStation reconcile WHERE-clause guard.
//
// Bug this guards against (shipstation-sync-audit.md §4 H3):
//   `wms.orders.oms_fulfillment_order_id` is a varchar(128). A subset of rows
//   contain non-numeric values (Shopify GIDs like `gid://shopify/Order/123`,
//   and historically empty strings). The reconcile query JOINs:
//       JOIN oms.oms_orders o ON o.id = w.oms_fulfillment_order_id::int
//   If even ONE row in the scanned set has a non-numeric value, Postgres
//   throws `invalid input syntax for integer` and the entire hourly sweep
//   is aborted by the outer try/catch. No rows get processed.
//
// The fix adds this predicate to the WHERE clause so the ::int cast can
// never see a non-numeric value:
//       AND w.oms_fulfillment_order_id ~ '^[0-9]+$'
//
// What this test proves:
//   1. The SQL fragment is actually present in server/index.ts (prevents
//      silent regressions if someone refactors the reconcile query).
//   2. The regex semantics behave correctly for the four input classes
//      enumerated in the task brief: NULL, empty string, numeric string,
//      GID. Postgres POSIX `~` is a superset of JS regex for this pattern
//      (no anchors/lookahead/backrefs), so a JS `RegExp` is a faithful
//      stand-in for the SQL operator on the cases we care about.
// ─────────────────────────────────────────────────────────────────────────────

const GUARD_REGEX_SQL = "w.oms_fulfillment_order_id ~ '^[0-9]+$'";
const GUARD_REGEX_JS = /^[0-9]+$/;

describe("shipstation reconcile :: cast-safety guard", () => {
  it("is present in server/index.ts", () => {
    // Grounds the test against the actual source of truth; if the reconcile
    // query is rewritten and the guard is dropped, this will fail loudly.
    const indexPath = resolve(__dirname, "../../../../index.ts");
    const src = readFileSync(indexPath, "utf8");
    expect(src).toContain(GUARD_REGEX_SQL);
  });

  describe("regex semantics (POSIX ~ / JS RegExp parity for this pattern)", () => {
    it("does NOT match NULL (handled by JOIN — NULL ::int would error, but NULL ~ 'x' is NULL/false in SQL and the JOIN's equality would also reject)", () => {
      // In SQL, `NULL ~ '^[0-9]+$'` evaluates to NULL, which is falsy in a
      // WHERE clause — NULL rows are excluded. In JS we mirror with
      // null → false.
      const value: string | null = null;
      const matches = value !== null && GUARD_REGEX_JS.test(value);
      expect(matches).toBe(false);
    });

    it("does NOT match empty string", () => {
      // `''::int` would throw — the regex requires at least one digit.
      expect(GUARD_REGEX_JS.test("")).toBe(false);
    });

    it("matches a plain numeric string (cast would succeed)", () => {
      expect(GUARD_REGEX_JS.test("12345")).toBe(true);
      expect(GUARD_REGEX_JS.test("1")).toBe(true);
      expect(GUARD_REGEX_JS.test("0")).toBe(true);
    });

    it("does NOT match a Shopify GID (the exact poison-row shape from prod)", () => {
      expect(GUARD_REGEX_JS.test("gid://shopify/Order/123")).toBe(false);
      expect(GUARD_REGEX_JS.test("gid://shopify/Order/5432109876543")).toBe(false);
    });

    it("does NOT match numeric-with-whitespace, numeric-with-sign, or numeric-with-decimal", () => {
      // ::int would also reject these, but they'd throw instead of being
      // excluded cleanly. The anchored `^[0-9]+$` excludes all of them.
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
});
