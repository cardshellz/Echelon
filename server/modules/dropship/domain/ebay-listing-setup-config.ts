/**
 * Store-level eBay listing settings kept in a store's listing config
 * (dropship_store_listing_configs.marketplace_config) beside the ids eBay
 * needs (design M2, PR 6). Pure: reads and writes plain objects only.
 */

/**
 * Policy names as eBay listed them when they were saved, each with the id it
 * names: { fulfillmentPolicyId: { id, name }, ... }. For people to read, never
 * sent to eBay. A name is shown only while its id is still the saved one, so a
 * policy changed by any other writer never shows the old policy's name.
 */
export const EBAY_BUSINESS_POLICY_NAMES_KEY = "businessPolicyNames";
/** The store's default eBay store shelves (store categories): one or two, with their names. */
export const EBAY_STORE_SHELF_DEFAULT_KEY = "storeShelfDefault";
/** eBay accepts a primary and a secondary store category on an offer. */
export const MAX_EBAY_STORE_SHELVES = 2;

/**
 * Keys kept out of a listing's intent, whose JSON is part of the preview hash.
 * Names are display-only, so a rename on eBay must not change every preview.
 * A shelf default reaches a listing only as that listing's storeCategoryNames,
 * which the intent already carries.
 */
const KEYS_OUTSIDE_THE_LISTING_INTENT: readonly string[] = [
  EBAY_BUSINESS_POLICY_NAMES_KEY,
  EBAY_STORE_SHELF_DEFAULT_KEY,
];

export type EbayBusinessPolicyField = "fulfillmentPolicyId" | "returnPolicyId" | "paymentPolicyId";

export const EBAY_BUSINESS_POLICY_FIELDS: readonly EbayBusinessPolicyField[] = [
  "fulfillmentPolicyId",
  "returnPolicyId",
  "paymentPolicyId",
];

export interface EbayBusinessPolicyNames {
  fulfillmentPolicyName: string | null;
  returnPolicyName: string | null;
  paymentPolicyName: string | null;
}

const NAME_KEY_BY_FIELD: Readonly<Record<EbayBusinessPolicyField, keyof EbayBusinessPolicyNames>> = {
  fulfillmentPolicyId: "fulfillmentPolicyName",
  returnPolicyId: "returnPolicyName",
  paymentPolicyId: "paymentPolicyName",
};

/** One stored policy name and the id it belongs to. */
export interface StoredEbayPolicyName {
  id: string;
  name: string;
}

export interface EbayStoreShelfDefault {
  /** eBay store category ids, primary first; one or two. */
  ids: string[];
  /** The shelf paths eBay offers are given (store categories are sent by name). */
  names: string[];
}

export function ebayPolicyNameKey(field: EbayBusinessPolicyField): keyof EbayBusinessPolicyNames {
  return NAME_KEY_BY_FIELD[field];
}

/** A copy of the marketplace config without the keys that are not part of the listing intent. */
export function marketplaceConfigForListingIntent(
  marketplaceConfig: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...marketplaceConfig };
  for (const key of KEYS_OUTSIDE_THE_LISTING_INTENT) delete copy[key];
  return copy;
}

/** The stored name of each saved policy; null when none is stored or it names another id. */
export function readEbayBusinessPolicyNames(
  marketplaceConfig: Readonly<Record<string, unknown>>,
): EbayBusinessPolicyNames {
  const result: EbayBusinessPolicyNames = {
    fulfillmentPolicyName: null,
    returnPolicyName: null,
    paymentPolicyName: null,
  };
  for (const field of EBAY_BUSINESS_POLICY_FIELDS) {
    result[NAME_KEY_BY_FIELD[field]] = readStoredEbayPolicyName(marketplaceConfig, field)?.name ?? null;
  }
  return result;
}

/** The stored { id, name } for one policy, only when its id is the saved policy id. */
export function readStoredEbayPolicyName(
  marketplaceConfig: Readonly<Record<string, unknown>>,
  field: EbayBusinessPolicyField,
): StoredEbayPolicyName | null {
  const policies = isRecord(marketplaceConfig.businessPolicies) ? marketplaceConfig.businessPolicies : {};
  const savedId = nonBlankString(policies[field]);
  const stored = marketplaceConfig[EBAY_BUSINESS_POLICY_NAMES_KEY];
  const entry = isRecord(stored) && isRecord(stored[field]) ? stored[field] : null;
  if (!savedId || !entry) return null;
  const id = nonBlankString(entry.id);
  const name = nonBlankString(entry.name);
  return id === savedId && name ? { id, name } : null;
}

/**
 * The stored shelf default, or null when there is none. A malformed value
 * (wrong shape, more than two shelves, ids and names that don't pair up)
 * also reads as null: it was never written by this code, and guessing at it
 * could publish the wrong shelf.
 */
export function readEbayStoreShelfDefault(
  marketplaceConfig: Readonly<Record<string, unknown>>,
): EbayStoreShelfDefault | null {
  const stored = marketplaceConfig[EBAY_STORE_SHELF_DEFAULT_KEY];
  if (!isRecord(stored) || !Array.isArray(stored.ids) || !Array.isArray(stored.names)) return null;
  const ids = stored.ids.map(nonBlankString);
  const names = stored.names.map(nonBlankString);
  if (ids.length < 1 || ids.length > MAX_EBAY_STORE_SHELVES || ids.length !== names.length) return null;
  if (ids.some((id) => id === null) || names.some((name) => name === null)) return null;
  if (new Set(ids).size !== ids.length) return null;
  return { ids: ids as string[], names: names as string[] };
}

function nonBlankString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
