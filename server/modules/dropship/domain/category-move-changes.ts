import {
  CATEGORY_LISTING_SETTING_FIELDS,
  type CategoryListingSettingField,
  type CategoryListingSettingValues,
  type ListingSettingPolicy,
  type ListingSettingStoreShelf,
  type ListingSettingTemplateText,
  type ProductListingSettingField,
} from "../../../../shared/dropship/listing-setting-values";
import { changedListingSettingFields, LISTING_SETTING_LEFTOVER_FIELDS, type ListingSettingLeftoverField } from "./listing-setting-values";

/**
 * "Card Shellz updated products" (plan PR 9, 10.6; P27): which category
 * settings change for a product Card Shellz moved from one category to
 * another, so the vendor sees what the move does to the listing. Pure: no
 * clock, no I/O, and no input is changed (CLAUDE.md §4).
 *
 * Each side is the category's own settings row (null when the category has
 * none, or for no category). A setting is compared by what decides the
 * listing (the push sends ids and names, not labels):
 * - a policy by its id (its name is a label kept at save);
 * - the eBay category by its id (eBay lists by the id; the name is a label);
 * - the store shelf by its mode and the path names eBay is sent, first then
 *   second (resolveListingStoreShelf sends names; a shelf's id is not sent);
 * - the price by its recipe;
 * - text above and below by mode and text.
 * Null means "follow the store default" on both sides, so null against a
 * value is a change even when that value equals the store default (the store
 * defaults are not compared here; a stated simplification, see the 9g notes).
 *
 * The result lists the category SETTINGS that differ, not every way a move
 * can change a listing. The store's older group rules (pricing groups,
 * content groups, eBay category rules; D16, until PR 11 converts them) sit
 * ahead of the category and match a `category` scope by the product's
 * category NAME (shared/dropship/catalog-scope.ts matchesCatalogScope), which
 * Card Shellz changes with the id on a move. In a store that holds such
 * rules a move can therefore change a listing through them while this list
 * is empty (rule "A" stops, rule "B" starts), and a field listed here can be
 * one a group rule still decides. Both need an older group rule with a
 * `category` scope in the store.
 *
 * A setting the move cannot reach is masked (left out): one the product's own
 * row sets (a product's value beats its category's), the price when every
 * chosen size owns its price (a saved setting that never follows the rules:
 * a typed price or the catalog default), and a policy or the shelf when every
 * chosen size keeps its own leftover from today's per-size panels (a size's
 * value beats both). One chosen size without its own value is enough for the
 * category's value to reach a listing, so the field stays.
 */

/** The fields a size can own on its own row in today's per-size tables that are also category settings. */
const SIZE_OWNABLE_CATEGORY_FIELDS = LISTING_SETTING_LEFTOVER_FIELDS.filter(
  (field): field is Exclude<ListingSettingLeftoverField, "mainText"> => field !== "mainText",
);

/** One chosen size's own values, as the facts read them (9e's per-size own-field facts). */
export interface CategoryMoveSizeOwnFields {
  /**
   * The size's saved price setting never follows the rules, so no category
   * price can reach it: a typed price, the catalog default, or a legacy row
   * with no mode (shared/dropship/listing-price.ts listingPriceFollowsRules).
   */
  ownsPrice: boolean;
  /** The settings the size keeps from today's per-size panels (LISTING_SETTING_LEFTOVER_FIELDS order). */
  leftovers: readonly ListingSettingLeftoverField[];
}

/**
 * The category settings a move cannot change for this product: those its own
 * row sets, the price when every chosen size owns its price, and each policy
 * and the shelf when every chosen size keeps its own. A product with no chosen
 * size masks only what its row sets.
 */
export function categoryMoveMaskedFields(input: {
  productOwnFields: ReadonlySet<ProductListingSettingField> | null;
  sizes: readonly CategoryMoveSizeOwnFields[];
}): Set<CategoryListingSettingField> {
  const masked = new Set<CategoryListingSettingField>();
  for (const field of CATEGORY_LISTING_SETTING_FIELDS) {
    if (input.productOwnFields?.has(field)) masked.add(field);
  }
  if (input.sizes.length === 0) return masked;
  if (input.sizes.every((size) => size.ownsPrice)) masked.add("price");
  for (const field of SIZE_OWNABLE_CATEGORY_FIELDS) {
    if (input.sizes.every((size) => size.leftovers.includes(field))) masked.add(field);
  }
  return masked;
}

/**
 * The category settings whose listing-deciding value differs between the
 * category the product came from and the one it is in now, minus the masked
 * ones, in CATEGORY_LISTING_SETTING_FIELDS order.
 */
export function categoryMoveChangedFields(input: {
  from: Readonly<CategoryListingSettingValues> | null;
  to: Readonly<CategoryListingSettingValues> | null;
  masked: ReadonlySet<CategoryListingSettingField>;
}): CategoryListingSettingField[] {
  return changedListingSettingFields(listingDecidingValues(input.from), listingDecidingValues(input.to), CATEGORY_LISTING_SETTING_FIELDS)
    .filter((field) => !input.masked.has(field));
}

type ListingDecidingValues = Record<CategoryListingSettingField, unknown>;

/** New plain objects with only what decides the listing; null stays null (follow the store default). */
function listingDecidingValues(values: Readonly<CategoryListingSettingValues> | null): ListingDecidingValues {
  return {
    price: values?.price ?? null,
    ebayCategory: values?.ebayCategory ? { categoryId: values.ebayCategory.categoryId } : null,
    storeShelf: shelfValue(values?.storeShelf ?? null),
    shippingPolicy: policyValue(values?.shippingPolicy ?? null),
    returnPolicy: policyValue(values?.returnPolicy ?? null),
    paymentPolicy: policyValue(values?.paymentPolicy ?? null),
    textAbove: templateTextValue(values?.textAbove ?? null),
    textBelow: templateTextValue(values?.textBelow ?? null),
  };
}

function policyValue(policy: ListingSettingPolicy | null): { id: string } | null {
  return policy === null ? null : { id: policy.id };
}

function shelfValue(shelf: ListingSettingStoreShelf | null): { mode: "none" } | { mode: "own"; names: string[] } | null {
  if (shelf === null) return null;
  return shelf.mode === "none" ? { mode: "none" } : { mode: "own", names: shelf.shelves.map((entry) => entry.name) };
}

function templateTextValue(text: ListingSettingTemplateText | null): { mode: "none" } | { mode: "own"; text: string } | null {
  if (text === null) return null;
  return text.mode === "none" ? { mode: "none" } : { mode: "own", text: text.text };
}
