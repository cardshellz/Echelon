/**
 * Pure helpers for Product Lines selection hygiene.
 *
 * Why this exists:
 *   Selection state (`selectedIds`) on the Product Lines page is a set of
 *   product IDs that persists across paginations inside a stable filter
 *   context, but MUST NOT leak across filter / scope / category / search
 *   changes. Before this module, selection survived a scope change, so the
 *   "X selected" banner could show 55 items under scope=Active that only
 *   has 36 visible rows. Invoking "Move to Line" in that state would ship
 *   19 invisible product IDs to the server (draft/archived products the
 *   user could not see, still valid assignment targets on the backend) —
 *   a silent footgun.
 *
 * Contract:
 *   1. {@link clampSelectionToVisible} returns a new Set that is the
 *      intersection of `selected` and `visible`. This is the value that
 *      MUST be used for:
 *        - the selection-count banner,
 *        - bulk-action button enable/disable,
 *        - bulk-action network payloads.
 *      The raw `selected` set is kept around only as the "user's ambient
 *      intent" for the current filter context.
 *   2. {@link filterContextKey} produces a canonical string identity for
 *      the filter context. When this string changes between renders,
 *      `selectedIds` MUST be reset to the empty set — stale IDs from a
 *      previous filter context are not trustworthy and could send the
 *      backend IDs the user never saw.
 *
 * The helpers are intentionally pure (no React, no DOM, no side effects)
 * so they can be unit-tested under the repo's node-env vitest setup
 * without pulling in jsdom or React Testing Library.
 */

/**
 * Return the subset of `selected` that is present in `visible`.
 *
 * Does not mutate either input. Preserves insertion order from `selected`,
 * which makes downstream `Array.from(...)` deterministic for tests and
 * audit logs.
 */
export function clampSelectionToVisible(
  selected: ReadonlySet<number>,
  visible: ReadonlySet<number>,
): Set<number> {
  if (selected.size === 0 || visible.size === 0) return new Set();
  const out = new Set<number>();
  for (const id of selected) {
    if (visible.has(id)) out.add(id);
  }
  return out;
}

/**
 * Canonical string identity for a Product Lines filter context.
 *
 * Inputs are normalized (whitespace trimmed) so that selection does not
 * get wiped on every keystroke of leading/trailing whitespace in the
 * search box. Status "" and "all" are treated as distinct because the
 * caller's `<Select>` surfaces them as distinct user choices (empty
 * string is never emitted in practice — guard kept for safety).
 *
 * Every field that mutates the server-side product set MUST be part of
 * this key. Page number is intentionally EXCLUDED so that paginating
 * inside a stable filter context preserves the user's selection.
 */
/**
 * MIME type used for drag-and-drop payloads from the Product Lines table
 * to the sidebar. Centralized so the emitter and the parser cannot drift.
 */
export const DRAGGED_PRODUCTS_MIME = "application/x-echelon-products";

/**
 * Extract the dragged product ID list from a drag event's dataTransfer.
 *
 * Returns an empty array (never throws) for any of:
 *   - null / undefined dataTransfer,
 *   - missing MIME payload,
 *   - unparseable JSON,
 *   - JSON that is not an array of finite integers.
 *
 * Rejecting non-integer entries is important: the backend treats these
 * values as primary keys, so silently passing through strings or NaN
 * would turn into a malformed mutation payload.
 */
export function parseDraggedProductIds(
  dataTransfer: DataTransfer | null | undefined,
): number[] {
  if (!dataTransfer) return [];
  const raw = dataTransfer.getData(DRAGGED_PRODUCTS_MIME);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: number[] = [];
  for (const v of parsed) {
    if (typeof v === "number" && Number.isInteger(v) && Number.isFinite(v)) {
      out.push(v);
    }
  }
  return out;
}

export function filterContextKey(parts: {
  selectionKey: string;
  search: string;
  vendor: string;
  status: string;
}): string {
  return [
    parts.selectionKey,
    parts.search.trim(),
    parts.vendor.trim(),
    parts.status,
  ].join("|");
}
