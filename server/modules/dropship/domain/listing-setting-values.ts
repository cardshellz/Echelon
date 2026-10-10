import { createHash } from "node:crypto";
import {
  LISTING_SETTING_KEY_PATTERN,
  type CategoryListingSettingValues,
  type ProductListingSettingValues,
} from "../../../../shared/dropship/listing-setting-values";
import { DropshipError } from "./errors";

/**
 * Pure rules for product and category listing settings (plan PR 8a, section
 * 3.6): merging a change into stored values, telling which settings changed,
 * the audit form of a bulk change, child request keys and the request hash.
 * No clock, no I/O, and no input is ever mutated (CLAUDE.md §4).
 */

/** "Follow the default" for every setting. Frozen: callers merge into it, never write to it. */
export const EMPTY_PRODUCT_LISTING_SETTING_VALUES: Readonly<ProductListingSettingValues> = Object.freeze({
  price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null,
  textAbove: null, textBelow: null, mainText: null,
});
export const EMPTY_CATEGORY_LISTING_SETTING_VALUES: Readonly<CategoryListingSettingValues> = Object.freeze({
  price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null,
  textAbove: null, textBelow: null,
});

/**
 * A new object: absent key = keep, null = clear (follow the default), value =
 * set. A key present with `undefined` cannot come from JSON and is treated as
 * absent. Nested values are shared with the inputs, never copied or changed:
 * they are parsed, plain data. The caller parses the result with its values
 * schema before storing it.
 */
export function applyListingSettingPatch<V extends object>(before: Readonly<V>, patch: Readonly<Partial<V>>): V {
  const after = { ...before } as V;
  for (const key of Object.keys(patch) as Array<keyof V>) {
    const value = patch[key];
    if (value !== undefined) after[key] = value as V[keyof V];
  }
  return after;
}

/**
 * The settings whose value differs, in `fields` order. Values are compared by
 * canonical JSON (object keys sorted, array order kept), so key order never
 * counts as a change. No stored row (`before` null) reads as every setting
 * following the default, so a first save of only nulls changes nothing.
 */
export function changedListingSettingFields<V extends object>(
  before: Readonly<V> | null,
  after: Readonly<V>,
  fields: readonly (keyof V)[],
): Array<keyof V> {
  return fields.filter((field) => canonicalJson(before?.[field] ?? null) !== canonicalJson(after[field] ?? null));
}

/**
 * The audit form of a bulk change (plan D28): only `fields`, and texts by
 * digest so 10,000 audit rows never carry 10,000 copies of a text. Own text
 * above or below becomes `{ mode: "own", length, sha256 }`, the main text
 * `{ length, sha256, catalogHash }`; every other value is kept as stored. The
 * full texts stay in the immutable revisions the audit row names. `length` is
 * in UTF-16 code units, the unit the values schema bounds.
 */
export function listingSettingBulkAuditValues<V extends object>(
  values: Readonly<V> | null,
  fields: readonly (keyof V)[],
): Record<string, unknown> | null {
  if (values === null) return null;
  const audit: Record<string, unknown> = {};
  for (const field of fields) {
    audit[String(field)] = auditValue(String(field), values[field] ?? null);
  }
  return audit;
}

function auditValue(field: string, value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if ((field === "textAbove" || field === "textBelow") && record.mode === "own" && typeof record.text === "string") {
    return { mode: "own", ...textDigest(record.text) };
  }
  if (field === "mainText" && typeof record.text === "string") {
    return { ...textDigest(record.text), catalogHash: record.catalogHash };
  }
  return value;
}

function textDigest(text: string): { length: number; sha256: string } {
  return { length: text.length, sha256: createHash("sha256").update(text, "utf8").digest("hex") };
}

/** What a child request key belongs to: a product row of a bulk change, a size price, a size's content, the store's eBay category rules. */
export const LISTING_SETTING_CHILD_KINDS = ["product", "size", "content", "ebay_rules"] as const;
export type ListingSettingChildKind = (typeof LISTING_SETTING_CHILD_KINDS)[number];

/** Child ids are int4 keys (product, size, store connection). */
const MAX_LISTING_SETTING_CHILD_ID = 2_147_483_647;
const CHILD_ID_PATTERN = /^[1-9][0-9]{0,9}$/;

/**
 * `ls:<sha256hex(parentKey)>:<kind>:<id>` (plan D10): at most 89 characters
 * for any parent, so it fits every varchar(200) key column and matches
 * LISTING_SETTING_KEY_PATTERN. Appending to the parent instead could reach
 * 219 characters. A malformed parent key or a non-positive integer id is a
 * programming fault.
 */
export function listingSettingChildKey(parentKey: string, kind: ListingSettingChildKind, id: number): string {
  if (!LISTING_SETTING_KEY_PATTERN.test(parentKey)) {
    throw listingSettingsInvariantFailed("A listing setting child key needs a valid parent request key.", { kind });
  }
  if (!(LISTING_SETTING_CHILD_KINDS as readonly string[]).includes(kind)) {
    throw listingSettingsInvariantFailed("A listing setting child key needs a known kind.", { kind: String(kind) });
  }
  if (!Number.isSafeInteger(id) || id <= 0 || id > MAX_LISTING_SETTING_CHILD_ID) {
    throw listingSettingsInvariantFailed("A listing setting child key needs a positive integer id.", { kind, id: String(id) });
  }
  return `${childKeyPrefix(parentKey, kind)}${id}`;
}

/**
 * True when `key` is a child key of `parentKey` of this kind: for this `id`
 * when one is given (a guard on one target passes it, so another size's key
 * is refused), otherwise for any valid id.
 */
export function isListingSettingChildKey(parentKey: string, key: string, kind: ListingSettingChildKind, id?: number): boolean {
  if (!LISTING_SETTING_KEY_PATTERN.test(parentKey)) return false;
  const prefix = childKeyPrefix(parentKey, kind);
  if (!key.startsWith(prefix)) return false;
  const idText = key.slice(prefix.length);
  if (!CHILD_ID_PATTERN.test(idText) || Number(idText) > MAX_LISTING_SETTING_CHILD_ID) return false;
  return id === undefined || Number(idText) === id;
}

function childKeyPrefix(parentKey: string, kind: ListingSettingChildKind): string {
  return `ls:${createHash("sha256").update(parentKey, "utf8").digest("hex")}:${kind}:`;
}

/**
 * sha256 of JSON.stringify, as pricingHash and contentHash do. Pass a
 * Zod-parsed value: Zod rebuilds objects in shape order, so equal requests
 * hash equal.
 */
export function listingSettingRequestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** JSON with object keys sorted at every level; array order is kept. undefined object values are left out, as JSON.stringify does. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) sorted[key] = sortKeys(record[key]);
  }
  return sorted;
}

/**
 * A programming fault or a stored row that breaks its contract (plan D27):
 * fatal, never retried, and never answered with a guess.
 */
export function listingSettingsInvariantFailed(message: string, context: Record<string, unknown> = {}): DropshipError {
  return new DropshipError("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", message, {
    ...context, retryable: false, classification: "fatal",
  });
}
