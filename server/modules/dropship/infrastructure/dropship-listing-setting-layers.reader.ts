import type { PoolClient } from "pg";
import type { CategoryListingSettingRow } from "../../../../shared/dropship/listing-setting-values";
import {
  EMPTY_LISTING_SETTING_LAYERS,
  type ListingSettingLayers,
} from "../application/dropship-listing-setting-layers";
import type { ConversionCategory } from "../domain/listing-rules-conversion-names";
import { listingSettingsInvariantFailed } from "../domain/listing-setting-values";
import { readCategoryListingSettings } from "./dropship-category-listing-settings.repository";
import { readProductListingSettings } from "./dropship-product-listing-settings.repository";

/**
 * The product and category layers for a set of catalog candidates (plan PR
 * 8b, section 4.3), read on the caller's client so they share its
 * transaction: the preview's read-only snapshot, the queue re-check under the
 * store lock, W9's, W1's and W3's transactions, the facts snapshot.
 *
 * Pure reads: no lock text, no write (CLAUDE.md §8). Rows are parsed with the
 * stored contract by PR 8a's readers, so a row that breaks it is
 * DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED (fatal, plan D27), never a guess.
 */

type Reader = Pick<PoolClient, "query">;

/** int4 keys (catalog.product_categories.id). */
const MAX_INT4_ID = 2_147_483_647;

/**
 * At most two indexed `ANY` reads, products then categories. Each is skipped
 * when its id list is empty: no candidates read nothing, and candidates
 * without a Card Shellz category send no category read (the rule-price golden
 * pins both counts, plan F10). Only `null` means "no category"; any other
 * value goes to the category reader, which refuses a non-id (fatal) rather
 * than silently skipping the category's settings.
 */
export async function readListingSettingLayers(client: Reader, input: {
  vendorId: number;
  storeConnectionId: number;
  candidates: readonly { productId: number; categoryId: number | null }[];
}): Promise<ListingSettingLayers> {
  if (input.candidates.length === 0) return EMPTY_LISTING_SETTING_LAYERS;
  const productIds = [...new Set(input.candidates.map((candidate) => candidate.productId))];
  const categoryIds = [...new Set(input.candidates.flatMap((candidate) => candidate.categoryId === null ? [] : [candidate.categoryId]))];
  const products = await readProductListingSettings(client, {
    vendorId: input.vendorId,
    storeConnectionId: input.storeConnectionId,
    productIds,
  });
  const categories = categoryIds.length === 0
    ? new Map<number, CategoryListingSettingRow>()
    : await readCategoryListingSettings(client, {
        vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId,
        categoryIds,
      });
  return { products, categories };
}

/**
 * The live Card Shellz names of categories, for display only (plan D19: a
 * revision keeps the name at save, readers show the current one; names never
 * enter a hash, D15). A category that does not exist is absent. No ids, no
 * query. Card Shellz refuses a blank name (catalog.routes.ts, create and
 * update), so a blank or non-text name means its writer was bypassed: fatal,
 * as the category settings writer treats it at save.
 */
export async function readCatalogCategoryNames(client: Reader, categoryIds: readonly number[]): Promise<Map<number, string>> {
  if (!categoryIds.every(isCategoryId)) {
    throw listingSettingsInvariantFailed("Card Shellz category names were read for an invalid category id.", {
      invalidCount: categoryIds.filter((categoryId) => !isCategoryId(categoryId)).length,
    });
  }
  const asked = new Set(categoryIds);
  const ids = [...asked].sort((left, right) => left - right);
  const names = new Map<number, string>();
  if (ids.length === 0) return names;
  const result = await client.query<{ id: unknown; name: unknown }>(
    "SELECT id, name FROM catalog.product_categories WHERE id = ANY($1::int[]) ORDER BY id",
    [ids],
  );
  for (const row of result.rows) {
    const categoryId = Number(row.id);
    if (!asked.has(categoryId)) {
      throw listingSettingsInvariantFailed("A Card Shellz category was read that was not asked for.", { categoryId: row.id });
    }
    if (typeof row.name !== "string" || row.name.trim() === "") {
      throw listingSettingsInvariantFailed("A Card Shellz category name is blank or not text.", { categoryId });
    }
    names.set(categoryId, row.name);
  }
  return names;
}

/**
 * Every Card Shellz category whose current name is exactly one of `names`,
 * by name (PR 11, plan D8, 4.B.1): the conversion's names-to-ids read. A key
 * for every name asked, holding its categories by id, or none (an empty
 * list: looked up, no category has it), so the planner can tell "no category
 * has this name" from "never looked up". Raw and exact: no trimming, no case
 * folding, and no `is_active` filter (an inactive category is a target, as
 * category settings read live names, plan D8). One parameterized `ANY` read;
 * no names, no query. A row whose name is not exactly one asked for (a
 * database collation that compares text loosely), or that is blank, not
 * text or without a valid id, is fatal, never a guess.
 */
export async function readCatalogCategoriesByName(client: Reader, names: readonly string[]):
  Promise<Map<string, ConversionCategory[]>> {
  if (!names.every((name) => typeof name === "string" && name.trim() !== "")) {
    throw listingSettingsInvariantFailed("Card Shellz categories were read for a blank or non-text name.", {
      invalidCount: names.filter((name) => typeof name !== "string" || name.trim() === "").length,
    });
  }
  // By UTF-16 code units, so the statement's parameter is the same whatever order the names come in.
  const asked = [...new Set(names)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const byName = new Map<string, ConversionCategory[]>(asked.map((name) => [name, []]));
  if (asked.length === 0) return byName;
  const result = await client.query<{ id: unknown; name: unknown }>(
    "SELECT id, name FROM catalog.product_categories WHERE name = ANY($1::text[]) ORDER BY id",
    [asked],
  );
  for (const row of result.rows) {
    // As readCatalogCategoryNames reads it.
    const categoryId = Number(row.id);
    if (!isCategoryId(categoryId)) {
      throw listingSettingsInvariantFailed("A Card Shellz category was read without a valid id.", { categoryId: row.id });
    }
    const entries = typeof row.name === "string" ? byName.get(row.name) : undefined;
    if (entries === undefined) {
      throw listingSettingsInvariantFailed("A Card Shellz category was read under a name that was not asked for.", { categoryId });
    }
    entries.push({ id: categoryId, name: row.name as string });
  }
  return byName;
}

function isCategoryId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_INT4_ID;
}
