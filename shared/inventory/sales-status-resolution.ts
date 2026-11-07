/**
 * Sales status precedence, shared by the publication planner (which zeroes a
 * stopped SKU) and the admin UI (which shows why a SKU is stopped), so the two
 * can never disagree.
 *
 * Owner decision 2026-11-07: the most specific item wins first, then the most
 * specific channel:
 *   SKU on this channel -> SKU on all channels -> product on this channel ->
 *   product on all channels -> Selling.
 * So "SKU X stopped on all channels" stops X even where its product has a
 * "Selling on Shopify" exception, and "Selling on Shopify" for X beats
 * "SKU X stopped on all channels".
 */

export type SalesStatusValue = "selling" | "stopped";

/** Where a setting applies. channelId null = every channel; productVariantId null = the whole product. */
export interface SalesStatusScopeInput {
  channelId: number | null;
  productId: number;
  productVariantId: number | null;
}

/** The status an item gets when no scope sets one. */
export const DEFAULT_SALES_STATUS: SalesStatusValue = "selling";

/**
 * Stable identity of a scope. A SKU scope is keyed by the SKU alone, because a
 * SKU setting belongs to the SKU (the stored row has no product id).
 * Examples: "all:product:11", "channel:36:variant:22".
 */
export function salesStatusScopeKey(scope: SalesStatusScopeInput): string {
  const channel = scope.channelId === null ? "all" : `channel:${scope.channelId}`;
  const item = scope.productVariantId === null
    ? `product:${scope.productId}`
    : `variant:${scope.productVariantId}`;
  return `${channel}:${item}`;
}

/** The four scopes that can decide one SKU on one channel, most decisive first. */
export function salesStatusPrecedence(input: {
  channelId: number;
  productId: number;
  productVariantId: number;
}): string[] {
  return [
    salesStatusScopeKey({ channelId: input.channelId, productId: input.productId, productVariantId: input.productVariantId }),
    salesStatusScopeKey({ channelId: null, productId: input.productId, productVariantId: input.productVariantId }),
    salesStatusScopeKey({ channelId: input.channelId, productId: input.productId, productVariantId: null }),
    salesStatusScopeKey({ channelId: null, productId: input.productId, productVariantId: null }),
  ];
}

export interface SalesStatusResolution<TEntry> {
  status: SalesStatusValue;
  /** The setting that decided it; null when nothing is set and the default applies. */
  source: TEntry | null;
}

/**
 * Resolves one SKU on one channel. `entries` may hold settings for other
 * items or channels; only the four scopes in the precedence list are read.
 */
export function resolveSalesStatus<TEntry extends { scopeKey: string; status: SalesStatusValue }>(input: {
  channelId: number;
  productId: number;
  productVariantId: number;
  entries: readonly TEntry[];
}): SalesStatusResolution<TEntry> {
  const byKey = new Map(input.entries.map((entry) => [entry.scopeKey, entry] as const));
  for (const scopeKey of salesStatusPrecedence(input)) {
    const entry = byKey.get(scopeKey);
    if (entry) return { status: entry.status, source: entry };
  }
  return { status: DEFAULT_SALES_STATUS, source: null };
}
