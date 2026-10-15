import { listingSettingsInvariantFailed } from "./listing-setting-values";

/**
 * Names to ids for the PR 11 conversion (plan D8, 4.A.5; design record
 * REC:891-892, REC:930). Older group rules match a product by its copy of
 * the category name (`catalog.products.category`, compared raw:
 * shared/dropship/catalog-scope.ts matchesCatalogScope), while category
 * settings key by the category id. These two pure functions are the only
 * place the conversion turns one into the other:
 *
 * - `categoryTargets`: the Card Shellz categories a category rule's name
 *   becomes a setting on. Exact string equality, as today's rules match: no
 *   trimming, no case folding. Active and inactive categories both count (the
 *   caller's map holds every category, plan D8). Names are not unique
 *   (shared/schema/catalog.schema.ts), so a name can have two targets.
 * - `categoryNameMismatches`: the chosen products whose copy and category
 *   disagree, so the report can name them; they are never given a value of
 *   their own from a category rule (plan D5).
 *
 * No I/O, no clock, no logging, and no input is ever mutated. An input that
 * cannot happen (a name listed under another name, one category under two
 * names, a product whose sizes disagree on its category) is refused as a
 * fatal invariant, never guessed past.
 */

/** A Card Shellz category as the conversion reads it: its id and its current name. */
export interface ConversionCategory {
  readonly id: number;
  readonly name: string;
}

/**
 * Every Card Shellz category a rule names, by its exact current name: a key
 * for every name that was looked up, holding the categories with exactly that
 * name (empty when none has it). A name with no key was never looked up.
 */
export type ConversionCategoriesByName = ReadonlyMap<string, readonly ConversionCategory[]>;

/** The product fields the name check reads from each chosen size. */
export interface ConversionNameCandidate {
  readonly productId: number;
  readonly productName: string;
  /** The product's copy of its category's name, raw; what older rules match. */
  readonly category: string | null;
  /** catalog.products.category_id; what category settings key by. */
  readonly categoryId: number | null;
}

/** A chosen product whose copy of the category name and whose category disagree (plan 4.A.3 `nameMismatches`). */
export interface ConversionNameMismatch {
  productId: number;
  productName: string;
  /** The product's copy ("listed as"); null when it has none. */
  listedAs: string | null;
  /** Its category's current name; null when it is in no category. */
  categoryName: string | null;
}

/** Names sort the way a person reads them (the read model's order, dropship-listing-settings-facts.ts NAME_ORDER). */
export const CONVERSION_NAME_ORDER = new Intl.Collator("en-US", { sensitivity: "base", numeric: true });

/**
 * The categories a category rule named `categoryName` becomes a setting on:
 * every category whose name is exactly that string, by id. None means the
 * rule is unmatched; two or more mean the name is shared. A name that was
 * never looked up is refused, never read as "no category has it": a loader
 * that missed one would otherwise drop the rule's setting from a clean plan.
 * A new array.
 */
export function categoryTargets(categoryName: string, categoriesByName: ConversionCategoriesByName): ConversionCategory[] {
  const entries = categoriesByName.get(categoryName);
  if (entries === undefined) {
    throw listingSettingsInvariantFailed("A category rule's name was never looked up among the Card Shellz categories.");
  }
  const seen = new Set<number>();
  for (const entry of entries) {
    if (entry.name !== categoryName) {
      throw listingSettingsInvariantFailed("A Card Shellz category was listed under a name it does not have.", { categoryId: entry.id });
    }
    if (!Number.isSafeInteger(entry.id) || entry.id <= 0 || seen.has(entry.id)) {
      throw listingSettingsInvariantFailed("A Card Shellz category was listed twice, or without a valid id.", { categoryId: entry.id });
    }
    seen.add(entry.id);
  }
  return entries.map((entry) => ({ id: entry.id, name: entry.name })).sort((a, b) => a.id - b.id);
}

/**
 * Checks the whole name map once: each category under its own name, and each
 * category id under one name only (a category has one name). Throws a fatal
 * invariant otherwise.
 */
export function assertConversionCategoriesByName(categoriesByName: ConversionCategoriesByName): void {
  const nameById = new Map<number, string>();
  for (const name of categoriesByName.keys()) {
    for (const target of categoryTargets(name, categoriesByName)) {
      const known = nameById.get(target.id);
      if (known !== undefined) {
        throw listingSettingsInvariantFailed("A Card Shellz category was listed under two names.", { categoryId: target.id });
      }
      nameById.set(target.id, name);
    }
  }
}

/**
 * Each chosen product (once) whose copy of the category name differs from
 * its category's current name: a copy with no category, a category with no
 * copy, or two different strings (compared raw: case and spaces count, as
 * they do for the rules). A product with neither is in no category and is not
 * listed. `categoryNames` holds the current name of every chosen product's
 * category (the read model loads it); a category id without one is a fault.
 * Sorted by product name, then id. A new array.
 */
export function categoryNameMismatches(candidates: readonly ConversionNameCandidate[],
  categoryNames: ReadonlyMap<number, string>): ConversionNameMismatch[] {
  const products = new Map<number, ConversionNameCandidate>();
  for (const candidate of candidates) {
    const known = products.get(candidate.productId);
    if (known === undefined) {
      products.set(candidate.productId, candidate);
    } else if (known.category !== candidate.category || known.categoryId !== candidate.categoryId) {
      // A product has one category and one copy; sizes that disagree were loaded wrong.
      throw listingSettingsInvariantFailed("Two sizes of one product disagree on its category.", { productId: candidate.productId });
    }
  }
  const mismatches: ConversionNameMismatch[] = [];
  for (const product of products.values()) {
    const categoryName = product.categoryId === null ? null : categoryNames.get(product.categoryId);
    if (categoryName === undefined) {
      throw listingSettingsInvariantFailed("A chosen product's category has no current name in the inputs.", {
        productId: product.productId, categoryId: product.categoryId,
      });
    }
    if (product.category === categoryName) continue;
    mismatches.push({ productId: product.productId, productName: product.productName, listedAs: product.category, categoryName });
  }
  return mismatches.sort((a, b) => CONVERSION_NAME_ORDER.compare(a.productName, b.productName) || a.productId - b.productId);
}
