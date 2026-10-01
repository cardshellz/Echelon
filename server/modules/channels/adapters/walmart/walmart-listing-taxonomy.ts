import { z } from "zod";
import {
  LISTING_TAXONOMY_LIMITS,
  listingTaxonomySchema,
  type ListingTaxonomy,
  type ListingTaxonomyEntry,
} from "@shared/types/channel-listing-publication";
import { WalmartApiError } from "./walmart-client";

// Bound the full provider response before traversing its nested arrays. This is
// separate from the limit on selectable leaves, which may have multiple paths.
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_CATEGORIES = 1_000;
const MAX_GROUPS_PER_CATEGORY = 2_000;
const ancestorSchema = z.string().trim().max(LISTING_TAXONOMY_LIMITS.nameLength).nullish();
const leafSchema = z.object({
  productTypeName: z.string().trim().min(1).max(LISTING_TAXONOMY_LIMITS.nameLength),
  description: z.string().trim().max(LISTING_TAXONOMY_LIMITS.descriptionLength).nullish(),
});
const categorySchema = z.object({
  category: ancestorSchema,
  productTypeGroup: z.array(z.object({
    productTypeGroupName: ancestorSchema,
    productType: z.array(leafSchema).max(LISTING_TAXONOMY_LIMITS.entries),
  })).max(MAX_GROUPS_PER_CATEGORY),
});
const responseSchema = z.object({
  // Walmart's reference models one category; its US guide uses an array.
  itemTaxonomy: z.union([
    z.array(categorySchema).max(MAX_CATEGORIES),
    categorySchema.transform((category) => [category]),
  ]),
});

/** Preserve only provider-supplied category -> product type group ancestry.
 * Missing ancestor labels retain an ungrouped/partial-path leaf, never a guessed category.
 * https://developer.walmart.com/us-marketplace/docs/understanding-the-requirements-for-listing-an-item
 */
export function normalizeWalmartListingTaxonomy(value: unknown): ListingTaxonomy {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw invalidResponse();
  }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_RESPONSE_BYTES)
    throw invalidResponse();
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) throw invalidResponse();
  const entries = new Map<string, ListingTaxonomyEntry>();
  let leafCount = 0;
  for (const category of parsed.data.itemTaxonomy) {
    for (const group of category.productTypeGroup) {
      const path = [category.category, group.productTypeGroupName]
        .filter((name): name is string => typeof name === "string" && name.length > 0);
      for (const leaf of group.productType) {
        if (++leafCount > LISTING_TAXONOMY_LIMITS.entries) throw invalidResponse();
        const key = JSON.stringify([path, leaf.productTypeName]);
        const description = leaf.description || null;
        const existing = entries.get(key);
        // Duplicate provider paths can repeat descriptions. Select one supplied
        // description deterministically so provider order never changes the result.
        if (!existing || (description !== null &&
          (existing.description === null || description < existing.description))) {
          entries.set(key, { productType: leaf.productTypeName, path: [...path], description });
        }
      }
    }
  }
  const normalizedEntries = [...entries.values()].sort(compareEntries);
  const result = listingTaxonomySchema.safeParse({
    productTypes: [...new Set(normalizedEntries.map((entry) => entry.productType))].sort(),
    entries: normalizedEntries,
  });
  if (!result.success) throw invalidResponse();
  return result.data;
}

function compareEntries(left: ListingTaxonomyEntry, right: ListingTaxonomyEntry): number {
  for (let index = 0; index < Math.min(left.path.length, right.path.length); index++) {
    const compared = compareNames(left.path[index], right.path[index]);
    if (compared !== 0) return compared;
  }
  return left.path.length - right.path.length || compareNames(left.productType, right.productType);
}
function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function invalidResponse(): WalmartApiError {
  return new WalmartApiError(
    "WALMART_LISTING_RESPONSE_INVALID",
    "Walmart returned an invalid or oversized product type taxonomy",
    false,
  );
}
