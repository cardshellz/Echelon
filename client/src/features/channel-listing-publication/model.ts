import {
  listingDraftItemSchema,
  type ListingCatalogItem,
  type ListingDraftItem,
  type ListingPriceRule,
} from "@shared/types/channel-listing-publication";

export const MAX_DRAFT_ITEMS = 100;

export function money(cents: number | null): string {
  if (cents === null || !Number.isSafeInteger(cents) || cents < 0)
    return "Price unavailable";
  const value = BigInt(cents);
  return `$${value / BigInt(100)}.${String(value % BigInt(100)).padStart(2, "0")}`;
}

export function dollarsToCents(value: string): number | null {
  if (!/^\d{1,14}(\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().split(".");
  const cents =
    BigInt(whole) * BigInt(100) + BigInt((fraction + "00").slice(0, 2));
  return cents > BigInt(0) && cents <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(cents)
    : null;
}

export function previewRulePrice(
  item: ListingCatalogItem,
  rule: ListingPriceRule,
): number | null {
  if (
    item.priceSource === "channel_pricing" ||
    (item.appliedRuleScope !== null && item.appliedRuleScope !== "channel")
  )
    return item.priceCents;
  if (
    item.basePriceCents === null ||
    !Number.isSafeInteger(item.basePriceCents) ||
    item.basePriceCents < 0 ||
    !/^\d{1,7}(\.\d{1,2})?$/.test(rule.value)
  )
    return null;
  const [whole, fraction = ""] = rule.value.split(".");
  const scaled =
    BigInt(whole) * BigInt(100) + BigInt((fraction + "00").slice(0, 2));
  const base = BigInt(item.basePriceCents);
  const result =
    rule.type === "override"
      ? scaled
      : rule.type === "fixed"
        ? base + scaled
        : (base * (BigInt(10_000) + scaled) + BigInt(5_000)) / BigInt(10_000);
  return result > BigInt(0) && result <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(result)
    : null;
}

export function draftItemFor(item: ListingCatalogItem): ListingDraftItem {
  return listingDraftItemSchema.parse({
    variantId: item.variantId,
    identifier: item.identifier,
  });
}

/** Selection is explicit, bounded and stable across catalog pages. */
export function addDraftItems(
  current: readonly ListingDraftItem[],
  chosen: readonly ListingCatalogItem[],
): ListingDraftItem[] {
  const result = [...current];
  const selected = new Set(current.map((item) => item.variantId));
  for (const item of chosen) {
    if (!item.eligible || item.alreadyLinked || selected.has(item.variantId))
      continue;
    if (result.length >= MAX_DRAFT_ITEMS)
      throw new Error(
        `A draft can contain at most ${MAX_DRAFT_ITEMS} variants.`,
      );
    result.push(draftItemFor(item));
    selected.add(item.variantId);
  }
  return result;
}

/** A rejected submission can be edited again; existing local edits always win. */
export function mergeRetryDraftItems(
  current: readonly ListingDraftItem[],
  retryItems: readonly ListingDraftItem[],
): ListingDraftItem[] {
  const merged = new Map(current.map((item) => [item.variantId, item]));
  for (const item of retryItems)
    if (!merged.has(item.variantId)) merged.set(item.variantId, item);
  if (merged.size > MAX_DRAFT_ITEMS)
    throw new Error(
      `These failed items would exceed the ${MAX_DRAFT_ITEMS}-variant draft limit. Submit or remove other draft items first.`,
    );
  return [...merged.values()];
}

export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The request failed. Please try again.";
}

export function labelForKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ");
}

export function priceSourceLabel(source: string | null | undefined): string {
  if (source === "channel_pricing") return "Saved channel price";
  if (source === "retail_cache") return "Retail price";
  if (source === "catalog_variant") return "Catalog retail price";
  return "Price not resolved";
}
