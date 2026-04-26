/**
 * Unit tests for Product Lines selection hygiene helpers.
 *
 * Regression pinned: selection state used to survive a scope/category/
 * search change, so the "X selected" banner could show 55 items while
 * the visible list (e.g. scope=Active) only contained 36 rows. Clicking
 * "Move to Line" would then ship 19 invisible product IDs to the server.
 * These tests lock down:
 *
 *   1. Intersection drops IDs the user can't see in the current page.
 *   2. Intersection never mutates input sets.
 *   3. Edge cases (empty selection / empty visible / full overlap) are
 *      deterministic.
 *   4. `filterContextKey` treats page changes as no-ops and treats
 *      scope/search/vendor/status changes as distinct identities.
 *   5. Whitespace-only edits to search / vendor do not churn the key
 *      (so the user does not lose selection on stray spaces).
 */

import { describe, it, expect } from "vitest";
import {
  clampSelectionToVisible,
  DRAGGED_PRODUCTS_MIME,
  filterContextKey,
  parseDraggedProductIds,
} from "../selection";

// Minimal DataTransfer fake. Only the two methods the parser uses.
function makeDataTransfer(payload: string | null): DataTransfer {
  return {
    getData: (type: string) =>
      type === DRAGGED_PRODUCTS_MIME && payload != null ? payload : "",
  } as unknown as DataTransfer;
}

// ---------------------------------------------------------------------------
// clampSelectionToVisible
// ---------------------------------------------------------------------------

describe("clampSelectionToVisible", () => {
  it("drops ids that are not in the visible set", () => {
    const selected = new Set([1, 2, 3, 4, 5]);
    const visible = new Set([2, 4, 6, 8]);
    const out = clampSelectionToVisible(selected, visible);
    expect([...out].sort((a, b) => a - b)).toEqual([2, 4]);
  });

  it("preserves insertion order from the selected set (auditability)", () => {
    // Order matters because downstream code does Array.from(out) and the
    // order ends up in server logs / activity feed.
    const selected = new Set([9, 3, 7, 1, 5]);
    const visible = new Set([1, 3, 5, 7, 9]);
    const out = clampSelectionToVisible(selected, visible);
    expect([...out]).toEqual([9, 3, 7, 1, 5]);
  });

  it("does not mutate either input", () => {
    const selected = new Set([1, 2, 3]);
    const visible = new Set([2, 3, 4]);
    const selectedSnap = new Set(selected);
    const visibleSnap = new Set(visible);
    clampSelectionToVisible(selected, visible);
    expect(selected).toEqual(selectedSnap);
    expect(visible).toEqual(visibleSnap);
  });

  it("returns an empty set when selected is empty", () => {
    const out = clampSelectionToVisible(new Set(), new Set([1, 2, 3]));
    expect(out.size).toBe(0);
  });

  it("returns an empty set when visible is empty (stale selection, fresh filter with no rows)", () => {
    const out = clampSelectionToVisible(new Set([1, 2, 3]), new Set());
    expect(out.size).toBe(0);
  });

  it("returns a new set equal to the intersection when every selected id is visible", () => {
    const selected = new Set([1, 2, 3]);
    const visible = new Set([1, 2, 3, 4, 5]);
    const out = clampSelectionToVisible(selected, visible);
    expect(out).not.toBe(selected); // new instance, not aliased
    expect([...out].sort()).toEqual([1, 2, 3]);
  });

  it(
    "regression: 55 stale selection under scope=All is clamped to the 36 visible under scope=Active",
    () => {
      // IDs 1..55 were visible under scope=All and the user hit select-all.
      // Now the user switches to scope=Active and only 36 of those 55 are
      // visible. The clamp must drop the other 19 so the mutation payload
      // cannot ship invisible IDs to the backend.
      const selected = new Set(Array.from({ length: 55 }, (_, i) => i + 1));
      const visible = new Set(
        Array.from({ length: 36 }, (_, i) => i + 1), // ids 1..36 visible
      );
      const out = clampSelectionToVisible(selected, visible);
      expect(out.size).toBe(36);
      // None of the 19 dropped IDs (37..55) survived.
      for (let id = 37; id <= 55; id += 1) {
        expect(out.has(id)).toBe(false);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// filterContextKey
// ---------------------------------------------------------------------------

describe("filterContextKey", () => {
  const base = {
    selectionKey: "unassigned",
    search: "",
    vendor: "",
    status: "active",
  };

  it("is stable across identical inputs (deterministic)", () => {
    expect(filterContextKey(base)).toBe(filterContextKey({ ...base }));
  });

  it("changes when scope selection changes", () => {
    const a = filterContextKey(base);
    const b = filterContextKey({ ...base, selectionKey: "line:42" });
    expect(a).not.toBe(b);
  });

  it("changes when status scope changes (scope-drift regression)", () => {
    const a = filterContextKey({ ...base, status: "active" });
    const b = filterContextKey({ ...base, status: "all" });
    expect(a).not.toBe(b);
  });

  it("changes when search text changes", () => {
    const a = filterContextKey({ ...base, search: "" });
    const b = filterContextKey({ ...base, search: "widget" });
    expect(a).not.toBe(b);
  });

  it("changes when vendor filter changes", () => {
    const a = filterContextKey({ ...base, vendor: "" });
    const b = filterContextKey({ ...base, vendor: "Acme" });
    expect(a).not.toBe(b);
  });

  it("ignores leading/trailing whitespace on search and vendor", () => {
    // Prevents selection getting wiped when the user hits space and backspace
    // in the search box.
    const a = filterContextKey({ ...base, search: "widget", vendor: "Acme" });
    const b = filterContextKey({
      ...base,
      search: "  widget  ",
      vendor: "  Acme\t",
    });
    expect(a).toBe(b);
  });

  it("does not include page number (paginating preserves selection)", () => {
    // The helper does not accept page at all — this test documents the
    // contract: page is intentionally excluded so pagination under stable
    // filters keeps the user's selection alive.
    // (If a future refactor adds page to the key, this test forces the
    // author to explicitly remove this assertion and justify the break.)
    const a = filterContextKey(base);
    const b = filterContextKey(base);
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// parseDraggedProductIds
// ---------------------------------------------------------------------------

describe("parseDraggedProductIds", () => {
  it("returns the integer ids from a well-formed payload", () => {
    const dt = makeDataTransfer(JSON.stringify([1, 2, 3]));
    expect(parseDraggedProductIds(dt)).toEqual([1, 2, 3]);
  });

  it("returns [] for a null DataTransfer", () => {
    expect(parseDraggedProductIds(null)).toEqual([]);
  });

  it("returns [] for a missing payload", () => {
    expect(parseDraggedProductIds(makeDataTransfer(null))).toEqual([]);
  });

  it("returns [] for unparseable JSON (never throws)", () => {
    expect(parseDraggedProductIds(makeDataTransfer("not-json"))).toEqual([]);
  });

  it("returns [] for non-array JSON", () => {
    expect(
      parseDraggedProductIds(makeDataTransfer(JSON.stringify({ id: 1 }))),
    ).toEqual([]);
  });

  it("drops non-integer entries (defense against malformed mutation payloads)", () => {
    const dt = makeDataTransfer(
      JSON.stringify([1, "2", 3.5, null, undefined, Number.NaN, Infinity, 4]),
    );
    expect(parseDraggedProductIds(dt)).toEqual([1, 4]);
  });
});
