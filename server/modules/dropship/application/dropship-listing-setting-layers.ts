import type {
  CategoryListingSettingRow,
  CategoryListingSettingValues,
  ListingSettingStoreShelf,
  ProductListingSettingRow,
  ProductListingSettingValues,
} from "../../../../shared/dropship/listing-setting-values";
import {
  EBAY_BUSINESS_POLICY_FIELDS,
  type EbayBusinessPolicyField,
  type EbayStoreShelfDefault,
} from "../domain/ebay-listing-setup-config";
import { listingSettingsInvariantFailed } from "../domain/listing-setting-values";

/**
 * The product and category layers of a store's listing settings (plan PR 8b,
 * section 4.3; design record 5.1 and 8.3), and the two pure rules that fold
 * them into the per-size values the preview and the listing-settings facts
 * already use: the policy override and the store shelf.
 *
 * Precedence is the record's one rule: the size's own value, then the
 * product's, then its Card Shellz category's, then the store default. For
 * policies and shelves a size's own value is a leftover from today's per-size
 * panels. With both layers empty every function here returns exactly what the
 * readers use today (plan D1), so no preview hash moves until a product or
 * category row exists. The one exception is the store shelf default, which
 * reaches listings here for the first time (plan 4.10 item 2).
 *
 * Pure: no I/O, no clock, and no input is ever mutated (CLAUDE.md §3, §4).
 * Names never decide anything here (plan D7): a policy is its id, a shelf is
 * sent by its path name.
 */

/** One read of a store's product and category rows (plan D26): one per preview, or one per caller transaction. */
export interface ListingSettingLayers {
  /** productId → the product's current row. A product with no row is absent. */
  readonly products: ReadonlyMap<number, ProductListingSettingRow>;
  /** catalog.product_categories.id → the category's current row. A category with no row is absent. */
  readonly categories: ReadonlyMap<number, CategoryListingSettingRow>;
}

/** No product or category settings: every reader takes today's path (plan D1). Frozen; the maps are typed read-only. */
export const EMPTY_LISTING_SETTING_LAYERS: ListingSettingLayers = Object.freeze({
  products: new Map<number, ProductListingSettingRow>(),
  categories: new Map<number, CategoryListingSettingRow>(),
});

/** The two layers one size follows. */
export interface ListingSettingLayerValues {
  product: ProductListingSettingValues | null;
  category: CategoryListingSettingValues | null;
}

/**
 * The product's and its category's values for one size. A product with no
 * Card Shellz category (`categoryId` null) skips the category step and
 * follows the store default (R:§5.1), whatever category rows exist.
 */
export function layersFor(
  layers: ListingSettingLayers,
  candidate: { productId: number; categoryId: number | null },
): ListingSettingLayerValues {
  return {
    product: layers.products.get(candidate.productId)?.values ?? null,
    category: candidate.categoryId === null ? null : layers.categories.get(candidate.categoryId)?.values ?? null,
  };
}

// ---------------------------------------------------------------------------
// Policies (shipping, return, payment)
// ---------------------------------------------------------------------------

/**
 * The three ids a policy override carries: what
 * applyEbayListingPolicyOverride, the preview row builder and the two
 * preflights read. A null id follows the store's own policy.
 */
export type ListingPolicyOverrideIds = {
  productVariantId: number;
  fulfillmentPolicyId: string | null;
  returnPolicyId: string | null;
  paymentPolicyId: string | null;
};

/** Where one merged policy id came from; null = no override, the store default applies. */
export type ListingPolicyOverrideSource = "size" | "product" | "category";

export interface MergedListingPolicyOverride {
  override: ListingPolicyOverrideIds | null;
  sources: Record<EbayBusinessPolicyField, ListingPolicyOverrideSource | null>;
}

/** The product/category setting that holds each eBay business policy id (eBay's fulfillment policy is the vendor's shipping policy). */
const POLICY_SETTING_BY_FIELD = {
  fulfillmentPolicyId: "shippingPolicy",
  returnPolicyId: "returnPolicy",
  paymentPolicyId: "paymentPolicy",
} as const satisfies Record<EbayBusinessPolicyField, keyof CategoryListingSettingValues>;

/**
 * Per field: the size's leftover id, else the product's, else the category's,
 * else null (= the store default, applied by applyEbayListingPolicyOverride).
 * Only ids are merged; a stored policy name is display-only (plan D7).
 *
 * When no field comes from a layer, `override` is the `size` object itself
 * (null when the size has no row), so with empty layers every caller passes
 * on exactly what it passes today. Otherwise it is a new object carrying only
 * the three ids. A size row for another size is a programming fault.
 */
export function mergeListingPolicyOverride(input: {
  productVariantId: number;
  size: ListingPolicyOverrideIds | null;
  product: ProductListingSettingValues | null;
  category: CategoryListingSettingValues | null;
}): MergedListingPolicyOverride {
  const { size, product, category } = input;
  if (size !== null && size.productVariantId !== input.productVariantId) {
    throw listingSettingsInvariantFailed("A size's policy override was merged for another size.", {
      productVariantId: input.productVariantId,
      overrideProductVariantId: size.productVariantId,
    });
  }
  const merged: ListingPolicyOverrideIds = {
    productVariantId: input.productVariantId,
    fulfillmentPolicyId: null,
    returnPolicyId: null,
    paymentPolicyId: null,
  };
  const sources: MergedListingPolicyOverride["sources"] = {
    fulfillmentPolicyId: null,
    returnPolicyId: null,
    paymentPolicyId: null,
  };
  let fromLayer = false;
  for (const field of EBAY_BUSINESS_POLICY_FIELDS) {
    const setting = POLICY_SETTING_BY_FIELD[field];
    // A size id counts whenever it is not null, as applyEbayListingPolicyOverride counts it today.
    const sizeId = size === null ? null : size[field];
    const productId = product?.[setting]?.id ?? null;
    const categoryId = category?.[setting]?.id ?? null;
    if (sizeId !== null) {
      merged[field] = sizeId;
      sources[field] = "size";
    } else if (productId !== null) {
      merged[field] = productId;
      sources[field] = "product";
      fromLayer = true;
    } else if (categoryId !== null) {
      merged[field] = categoryId;
      sources[field] = "category";
      fromLayer = true;
    }
  }
  return { override: fromLayer ? merged : size, sources };
}

// ---------------------------------------------------------------------------
// Store shelf
// ---------------------------------------------------------------------------

export type ListingStoreShelfSource = "size" | "product" | "category" | "store_default" | "none";

export interface ResolvedListingStoreShelf {
  /** Shelf path names in order, first shelf then second; empty = no shelf. Always a new array. */
  names: string[];
  source: ListingStoreShelfSource;
}

/**
 * The size's leftover shelf row, else the product's own shelves or its
 * explicit "none", else the category's, else the store default saved in the
 * listing config (readEbayStoreShelfDefault), else no shelf.
 *
 * A per-size row always holds one or two names (migration 215's CHECK, and
 * the old writer deletes a row it would empty), so an empty `sizeNames` reads
 * as no row, exactly as the preview and the facts read it today (`[]`, source
 * `none`). An explicit "none" on the product or category stops the fall
 * through: it beats a category's shelves and the store default.
 */
export function resolveListingStoreShelf(input: {
  sizeNames: readonly string[] | null;
  product: ProductListingSettingValues | null;
  category: CategoryListingSettingValues | null;
  storeDefault: EbayStoreShelfDefault | null;
}): ResolvedListingStoreShelf {
  if (input.sizeNames !== null && input.sizeNames.length > 0) return { names: [...input.sizeNames], source: "size" };
  const productShelf = input.product?.storeShelf ?? null;
  if (productShelf !== null) return { names: layerShelfNames(productShelf), source: "product" };
  const categoryShelf = input.category?.storeShelf ?? null;
  if (categoryShelf !== null) return { names: layerShelfNames(categoryShelf), source: "category" };
  if (input.storeDefault !== null) return { names: [...input.storeDefault.names], source: "store_default" };
  return { names: [], source: "none" };
}

function layerShelfNames(shelf: ListingSettingStoreShelf): string[] {
  return shelf.mode === "none" ? [] : shelf.shelves.map((entry) => entry.name);
}
