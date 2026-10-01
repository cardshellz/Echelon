import type { ListingDraftItem } from "@shared/types/channel-listing-publication";

export type InheritedContentState =
  | "custom"
  | "catalog"
  | "catalog_empty"
  | "catalog_unavailable";

export function inheritedContentState(
  override: string | null,
  catalogValue: string | undefined,
): InheritedContentState {
  if (override !== null && override.trim().length > 0) return "custom";
  if (catalogValue === undefined) return "catalog_unavailable";
  return catalogValue.trim().length > 0 ? "catalog" : "catalog_empty";
}

/** Only empty edits fall back. Nonempty description whitespace remains content. */
export function normalizeTextOverride(value: string | null): string | null {
  return value === null || value.trim().length === 0 ? null : value;
}

export function parseImageOverride(value: string | null): string[] | null {
  if (value === null) return null;
  const images = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return images.length > 0 ? images : null;
}

/** Displayed catalog values never become overrides merely by opening or saving. */
export function normalizeListingContent(
  draft: ListingDraftItem,
  images: string | null,
): ListingDraftItem {
  return {
    ...draft,
    title: normalizeTextOverride(draft.title),
    description: normalizeTextOverride(draft.description),
    brand: normalizeTextOverride(draft.brand),
    images: parseImageOverride(images),
  };
}
