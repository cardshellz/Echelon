/**
 * Sales status resolution, shared by the publication planner (which zeroes a
 * stopped SKU) and the admin UI (which shows why a SKU is stopped), so the two
 * can never disagree.
 *
 * Owner decision 2026-11-07: a SKU sells on a channel only if BOTH its product
 * and the SKU itself are Selling there. A stop always wins:
 * - A product stopped on a channel stops every SKU under it on that channel,
 *   and no SKU setting can override that. (Selling only some SKUs is done by
 *   leaving the product Selling and stopping the other SKUs.)
 * - Within one level (the product, or the SKU), a channel exception beats the
 *   all-channels setting, so "stopped everywhere except Shopify" works for a
 *   product and for a SKU.
 * - With nothing set, everything sells.
 * Because Selling on all channels is the default, an all-channels setting is
 * only ever Stopped; Selling exists only as a channel exception.
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

type Entry = { scopeKey: string; status: SalesStatusValue };

/**
 * One level's own setting on one channel: its channel exception if it has
 * one, else its all-channels setting, else nothing (null).
 */
export function levelSetting<TEntry extends Entry>(
  entries: readonly TEntry[],
  scope: { channelId: number; productId: number; productVariantId: number | null },
): TEntry | null {
  const byKey = new Map(entries.map((entry) => [entry.scopeKey, entry] as const));
  return byKey.get(salesStatusScopeKey(scope))
    ?? byKey.get(salesStatusScopeKey({ ...scope, channelId: null }))
    ?? null;
}

export interface SalesStatusResolution<TEntry> {
  status: SalesStatusValue;
  /**
   * The setting that decided it: the product's stop when the product is
   * stopped (it outranks everything), else the SKU's own setting, else the
   * product's Selling exception; null when nothing is set.
   */
  source: TEntry | null;
  /** True when the SKU is stopped on this channel because its product is. */
  stoppedByProduct: boolean;
}

/**
 * Resolves one SKU on one channel. `entries` may hold settings for other items
 * or channels; only this product's and this SKU's settings for the channel are
 * read.
 */
export function resolveSalesStatus<TEntry extends Entry>(input: {
  channelId: number;
  productId: number;
  productVariantId: number;
  entries: readonly TEntry[];
}): SalesStatusResolution<TEntry> {
  const product = levelSetting(input.entries, { channelId: input.channelId, productId: input.productId, productVariantId: null });
  if (product?.status === "stopped") return { status: "stopped", source: product, stoppedByProduct: true };
  const sku = levelSetting(input.entries, {
    channelId: input.channelId, productId: input.productId, productVariantId: input.productVariantId,
  });
  if (sku?.status === "stopped") return { status: "stopped", source: sku, stoppedByProduct: false };
  return { status: DEFAULT_SALES_STATUS, source: sku ?? product, stoppedByProduct: false };
}
