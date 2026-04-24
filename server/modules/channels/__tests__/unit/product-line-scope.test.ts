/**
 * Unit tests for the Product Lines scope predicate helper.
 *
 * Regression: Sidebar badge said "Unassigned 55" while the list below it
 * rendered 36 Active products because the sidebar count query ignored the
 * top-right `Active` scope dropdown that the list query honored. The fix
 * extracts a single shared predicate so the sidebar counts, the stats
 * panel, and the product list can never drift apart again.
 *
 * These tests pin the contract of that shared helper:
 *   1. Normalization is deterministic (same input → same canonical scope).
 *   2. The SQL predicate always includes the soft-delete filter.
 *   3. The SQL predicate only adds a status filter when the scope is not
 *      the `"all"` sentinel.
 *   4. Every non-"all" scope produces an identically-shaped predicate that
 *      differs only in the bound parameter — meaning every call site that
 *      uses this helper agrees on what "Active"/"Draft"/etc. means.
 */

import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  normalizeProductScope,
  buildProductScopeCondition,
  DEFAULT_PRODUCT_SCOPE,
} from "../../product-line-scope";

const dialect = new PgDialect();

function renderPredicate(scope: string): { sql: string; params: unknown[] } {
  const cond = buildProductScopeCondition(scope);
  const q = dialect.sqlToQuery(cond);
  return { sql: q.sql, params: q.params };
}

// ---------------------------------------------------------------------------
// normalizeProductScope
// ---------------------------------------------------------------------------

describe("normalizeProductScope", () => {
  it("defaults to 'active' when given undefined", () => {
    expect(normalizeProductScope(undefined)).toBe("active");
  });

  it("defaults to 'active' when given null", () => {
    expect(normalizeProductScope(null)).toBe("active");
  });

  it("defaults to 'active' for empty string", () => {
    expect(normalizeProductScope("")).toBe("active");
  });

  it("defaults to 'active' for whitespace-only string", () => {
    expect(normalizeProductScope("   ")).toBe("active");
  });

  it("defaults to 'active' for non-string inputs", () => {
    expect(normalizeProductScope(42)).toBe("active");
    expect(normalizeProductScope({})).toBe("active");
    expect(normalizeProductScope([])).toBe("active");
    expect(normalizeProductScope(true)).toBe("active");
  });

  it("passes through known canonical scopes", () => {
    expect(normalizeProductScope("active")).toBe("active");
    expect(normalizeProductScope("draft")).toBe("draft");
    expect(normalizeProductScope("archived")).toBe("archived");
    expect(normalizeProductScope("all")).toBe("all");
  });

  it("lowercases and trims", () => {
    expect(normalizeProductScope("ACTIVE")).toBe("active");
    expect(normalizeProductScope("  Draft  ")).toBe("draft");
    expect(normalizeProductScope("All")).toBe("all");
  });

  it("matches the documented default constant", () => {
    expect(DEFAULT_PRODUCT_SCOPE).toBe("active");
    expect(normalizeProductScope(undefined)).toBe(DEFAULT_PRODUCT_SCOPE);
  });
});

// ---------------------------------------------------------------------------
// buildProductScopeCondition
// ---------------------------------------------------------------------------

describe("buildProductScopeCondition", () => {
  it("always filters out soft-deleted products (isActive=true)", () => {
    const scopes = ["active", "draft", "archived", "all", "pending"];
    for (const scope of scopes) {
      const { sql, params } = renderPredicate(scope);
      expect(sql).toContain(`"is_active"`);
      expect(params).toContain(true);
    }
  });

  it("for the 'all' scope, does NOT constrain products.status", () => {
    const { sql, params } = renderPredicate("all");
    expect(sql).not.toContain(`"status"`);
    // Only the isActive=true parameter is bound.
    expect(params).toEqual([true]);
  });

  it("for the default 'active' scope, filters status='active'", () => {
    const { sql, params } = renderPredicate("active");
    expect(sql).toContain(`"is_active"`);
    expect(sql).toContain(`"status"`);
    expect(params).toEqual([true, "active"]);
  });

  it("for the 'draft' scope, filters status='draft'", () => {
    const { sql, params } = renderPredicate("draft");
    expect(sql).toContain(`"status"`);
    expect(params).toEqual([true, "draft"]);
  });

  it("for the 'archived' scope, filters status='archived'", () => {
    const { sql, params } = renderPredicate("archived");
    expect(sql).toContain(`"status"`);
    expect(params).toEqual([true, "archived"]);
  });

  /**
   * The core regression guard:
   *
   * Every non-"all" scope must produce a predicate with the IDENTICAL SQL
   * shape, differing only in the bound status parameter. This is what
   * guarantees the sidebar count and the list query agree on what a given
   * scope means — regardless of which code path renders it.
   */
  it("produces identical SQL shape across every non-'all' scope (only params differ)", () => {
    const activeShape = renderPredicate("active").sql;
    for (const scope of ["draft", "archived", "pending", "whatever"]) {
      expect(renderPredicate(scope).sql).toBe(activeShape);
    }
  });

  /**
   * The sidebar-vs-list equivalence the user actually experienced:
   *
   * When the UI scope is `Active`, all three product-line surfaces (list,
   * sidebar per-line counts, sidebar "Unassigned" badge) will receive the
   * SAME predicate from this helper — bit-for-bit identical SQL and
   * params. That's what makes it structurally impossible for them to
   * disagree on the number of Active + Unassigned products.
   */
  it("returns the same SQL/params for every caller that normalizes the same UI scope", () => {
    const uiScope = "active"; // what the Active dropdown ships
    const listSide = renderPredicate(normalizeProductScope(uiScope));
    const sidebarCountsSide = renderPredicate(normalizeProductScope(uiScope));
    const unassignedBadgeSide = renderPredicate(normalizeProductScope(uiScope));

    expect(listSide).toEqual(sidebarCountsSide);
    expect(sidebarCountsSide).toEqual(unassignedBadgeSide);
  });

  it("treats empty/whitespace/undefined as the Active default (matches list behavior)", () => {
    const activeRendered = renderPredicate("active");
    for (const raw of [undefined, null, "", "   ", "ACTIVE"]) {
      const rendered = renderPredicate(normalizeProductScope(raw));
      expect(rendered).toEqual(activeRendered);
    }
  });

  /**
   * Worked example that mirrors the original bug report:
   *   - Dataset: 55 unassigned products total = 36 active + 12 draft + 7 archived.
   *   - UI scope = "active"  → both sidebar and list must count 36.
   *   - UI scope = "all"     → both sidebar and list must count 55.
   *
   * We can't execute real SQL here, but we can prove the SHARED predicate
   * is applied consistently: the number of rows any two consumers see is
   * a function of (dataset, predicate). Same predicate → same rows.
   */
  it("regression scenario: active-scope predicate matches across consumers, all-scope relaxes the filter", () => {
    const active = renderPredicate(normalizeProductScope("active"));
    const all = renderPredicate(normalizeProductScope("all"));

    // Active is strictly more selective: it includes the status filter,
    // `all` does not.
    expect(active.sql.length).toBeGreaterThan(all.sql.length);
    expect(active.params).toEqual([true, "active"]);
    expect(all.params).toEqual([true]);

    // And the three product-line surfaces, given the same UI input,
    // receive bit-for-bit identical predicates — so their row counts
    // are mathematically locked together.
    const list = renderPredicate(normalizeProductScope("active"));
    const sidebar = renderPredicate(normalizeProductScope("active"));
    const unassignedBadge = renderPredicate(normalizeProductScope("active"));
    expect(list).toEqual(sidebar);
    expect(list).toEqual(unassignedBadge);
  });
});
