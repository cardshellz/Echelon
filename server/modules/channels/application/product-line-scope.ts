/**
 * product-line-scope
 *
 * Single source of truth for the `status` scope filter applied to the
 * Product Lines → Available Products view.
 *
 * The sidebar counts ("Unassigned 55"), the per-line counts, the inventory
 * stats panel, AND the paginated product list MUST all derive from the same
 * scope predicate. When they drifted apart, the sidebar reported 55
 * "Unassigned" products while the list rendered 36 — because the sidebar
 * count ignored the top-right `Active` dropdown that the list honored.
 *
 * This helper exists so those call sites can never disagree again:
 *   - Same input  → same normalized scope value
 *   - Same scope  → same SQL predicate applied to `products`
 *
 * Contract (locked):
 *   - Scope `"all"`                → no predicate on `products.status`
 *   - Any other string             → `eq(products.status, scope)`
 *   - `undefined` / `""` / `null`  → treated as default scope (`"active"`)
 *
 * `products.status` is the varchar column with domain
 * `'active' | 'draft' | 'archived'`. It is NOT the same as the
 * `products.isActive` boolean (which is a soft-delete flag). The UI scope
 * dropdown controls `products.status`, so this helper targets that column.
 */

// Import the schema directly from `@shared/schema` rather than from
// `../../storage/base`, because `storage/base` eagerly initializes the
// database client at module load. This helper must stay pure so it can be
// unit-tested without a live DATABASE_URL.
import { and, eq, type SQL } from "drizzle-orm";
import { products } from "@shared/schema/catalog.schema";

/**
 * Canonical scope value type. `"all"` is the sentinel for "no filter";
 * every other string is treated as an exact `products.status` match.
 */
export type ProductScope = string;

/** Default scope applied when the caller passes nothing. */
export const DEFAULT_PRODUCT_SCOPE: ProductScope = "active";

/**
 * Normalize a raw scope value (from a query string, form input, or caller)
 * into the canonical form used by the predicate.
 *
 * - `undefined` / `null` / empty / whitespace → DEFAULT_PRODUCT_SCOPE
 * - Anything else → trimmed, lowercased
 */
export function normalizeProductScope(raw: unknown): ProductScope {
  if (raw === undefined || raw === null) return DEFAULT_PRODUCT_SCOPE;
  if (typeof raw !== "string") return DEFAULT_PRODUCT_SCOPE;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return DEFAULT_PRODUCT_SCOPE;
  return trimmed;
}

/**
 * Build the Drizzle SQL predicate for the given scope.
 *
 * The predicate ALWAYS includes `products.isActive = true` (soft-delete
 * filter) so that soft-deleted products never leak into any product-line
 * view, regardless of their `status` value. The `status` scope is applied
 * on top of that:
 *   - `"all"` scope → only the `isActive` predicate
 *   - any other scope → `isActive=true AND status = scope`
 *
 * Never returns `undefined`: every caller gets a predicate to compose into
 * their `where(...)` clause. This makes it impossible for a call site to
 * "forget" the shared filter.
 */
export function buildProductScopeCondition(scope: ProductScope): SQL {
  const activeOnly = eq(products.isActive, true);
  if (scope === "all") return activeOnly;
  // NOTE: `and(...)` return type is `SQL | undefined` in Drizzle typings
  // (because of variadic undefineds), but with two concrete predicates it
  // always returns a real SQL fragment. The `as SQL` narrows it safely.
  return and(activeOnly, eq(products.status, scope)) as SQL;
}
