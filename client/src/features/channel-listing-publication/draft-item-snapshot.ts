import {
  listingDraftItemSchema,
  type ListingDraftItem,
} from "@shared/types/channel-listing-publication";
import { MAX_DRAFT_ITEMS } from "./model";

/** Callers validate JSON values before comparison; undefined represents an absent field. */
export function canonicalDraftValue(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalDraftValue).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalDraftValue((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

/** Validate first, then compare original values without hiding changes through DTO normalization. */
export function listingDraftItemsFingerprint(
  items: readonly ListingDraftItem[],
): string {
  if (!Array.isArray(items) || items.length > MAX_DRAFT_ITEMS)
    throw new Error(`A draft can contain at most ${MAX_DRAFT_ITEMS} items.`);
  const parsed = items.map((item) => listingDraftItemSchema.parse(item));
  if (new Set(parsed.map((item) => item.variantId)).size !== parsed.length)
    throw new Error("Each draft variant must appear once.");
  return canonicalDraftValue(
    [...items].sort((left, right) => left.variantId - right.variantId),
  );
}

/** Only the edited item is compared, so unrelated draft changes remain mergeable. */
export function assertListingDraftItemUnchanged(
  snapshot: ListingDraftItem,
  current: ListingDraftItem | null | undefined,
): void {
  if (!current)
    throw new Error(
      "This draft item is no longer available. Close the editor and review the latest draft.",
    );
  if (
    listingDraftItemsFingerprint([snapshot]) !==
    listingDraftItemsFingerprint([current])
  )
    throw new Error(
      "This draft item changed while editing was open. Close the editor and review the latest draft before editing again.",
    );
}
