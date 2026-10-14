import { ebayCategorySchema, type EbayCategory, type EbayCategoryOption } from "../../../../shared/dropship/ebay-category-rules";
import {
  MAX_LISTING_POLICY_NAME_LENGTH,
  MAX_LISTING_SHELF_ID_LENGTH,
  MAX_LISTING_SHELF_NAME_LENGTH,
  type ListingSettingPolicy,
  type ListingSettingStoreShelf,
  type ProductListingSettingValues,
} from "../../../../shared/dropship/listing-setting-values";
import type { ProductSettingsPatchInput } from "../../../../shared/dropship/listing-setting-writes";
import { DropshipError } from "../domain/errors";
import { listingSettingsInvariantFailed } from "../domain/listing-setting-values";
import type { DropshipEbayFulfillmentCapability } from "../domain/ebay-fulfillment-policy-compatibility";
import { EBAY_BUSINESS_POLICY_FIELDS, type EbayBusinessPolicyField } from "../domain/ebay-listing-setup-config";
import type { EbayCategoryIdentity } from "./dropship-ebay-category-rules-service";
import {
  CHECKED_LISTING_POLICY_KEYS,
  checkListingPolicyIds,
  resolveStoreShelfIds,
  verifyEbayLeafCategories,
  type CheckedListingPolicies,
  type CheckedListingPolicyKey,
} from "./dropship-ebay-listing-checks";
import type { DropshipEbayListingSetupDiscovery } from "./dropship-ebay-listing-setup-service";
import type { DropshipEbayStoreCategory } from "./dropship-ebay-store-category-service";
import { listingSettingEbaySignInRequired } from "./dropship-listing-setting-write-support";

/**
 * The eBay values of a listing-settings change (plan PR 9, P13, section 6.5
 * step 3): route inputs name eBay values by id only, and this builds the
 * values the settings store, with the names and paths eBay gives.
 *
 * - An id the target already stores ("known") keeps its stored value: no
 *   eBay call, so "Card Shellz picks" and re-saves work while eBay needs a
 *   sign-in.
 * - Only new ids ask eBay, in a fixed order: category, policies, shelves.
 *   W9's rule holds: no eBay call inside a write transaction.
 * - A store that needs a sign-in is refused before any eBay call when the
 *   change has a new id (403 DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED).
 * - When the preflight found the request key already used (a replay or a
 *   conflict, plan P16), nothing asks eBay: the write transaction answers it.
 * - eBay's values are bounded to the stored contract here, so the writer's
 *   own parse never fails on them (a writer breach is fatal): a policy name
 *   over 200 characters is stored as null, a shelf id over 40 or a path over
 *   500 is a 422, an eBay category the stored schema refuses is a 422.
 *
 * Each provider failure propagates with its own code (plan 3.3 rows). 9b's
 * policy and category refusals keep their code, words and reason, and are
 * re-stated in these routes' field names (see inListingSettingTerms).
 */

/** The eBay reads a listing-settings write needs, over today's providers (dropship-listing-setting-ebay.adapter.ts). */
export interface ListingSettingEbayPort {
  /** eBay's current values for the requested category ids; an id eBay does not list is absent. */
  describeCategories(identity: EbayCategoryIdentity, categoryIds: readonly string[]): Promise<Map<string, EbayCategoryOption>>;
  /** The store's business policies on eBay now. */
  discoverPolicies(input: { vendorId: number; storeConnectionId: number; marketplaceId: string }): Promise<DropshipEbayListingSetupDiscovery>;
  /** What Card Shellz can ship, read fresh, to check a shipping policy against (W2's check). */
  loadFulfillmentCapability(input: { storeConnectionId: number; marketplaceId: string }): Promise<DropshipEbayFulfillmentCapability>;
  /** The store's leaf shelves (store categories) on eBay now, each with its path. */
  listStoreShelves(input: { vendorId: number; storeConnectionId: number }): Promise<DropshipEbayStoreCategory[]>;
}

/** The fields whose values come from eBay, in the stored shape's order (refusals name fields in this order). */
export const LISTING_SETTING_EBAY_FIELDS = ["ebayCategory", "storeShelf", "shippingPolicy", "returnPolicy", "paymentPolicy"] as const;
export type ListingSettingEbayField = (typeof LISTING_SETTING_EBAY_FIELDS)[number];

/** The eBay fields of a route patch, ids only. */
export type ListingSettingEbayIdsPatch = Pick<ProductSettingsPatchInput, ListingSettingEbayField>;
/** The same fields as the settings store them; a field the patch leaves out is absent. */
export type ListingSettingEbayValues = Partial<Pick<ProductListingSettingValues, ListingSettingEbayField>>;
/** The target's stored eBay values, to tell known ids from new ones; null when it has no row. */
export type KnownListingSettingEbayValues = Pick<ProductListingSettingValues, ListingSettingEbayField> | null;

/** What the read-only preflight learned (plan 6.5 step 2). */
export interface ListingSettingEbayPreflight {
  /** False when the request key already wrote rows: the write transaction answers it, and eBay is not asked. */
  keyIsNew: boolean;
  storeStatus: string;
  marketplaceId: string;
  known: KnownListingSettingEbayValues;
}

export type ListingSettingEbayResolution =
  | { status: "skipped" }
  | { status: "resolved"; values: ListingSettingEbayValues; askedEbay: boolean };

/** The marketplace whose category tree the taxonomy reads (W3's rule): dropship eBay listings are US only. */
const SUPPORTED_EBAY_CATEGORY_MARKETPLACE_ID = "EBAY_US";
/** A store that needs a sign-in can save known values only. */
const SIGN_IN_REQUIRED_STORE_STATUS = "needs_reauth";

/** Each policy field with the listing config field 9b's check takes, from 9b's own mapping. */
const POLICY_FIELDS: ReadonlyArray<{ field: CheckedListingPolicyKey; request: EbayBusinessPolicyField }> =
  EBAY_BUSINESS_POLICY_FIELDS.map((request) => ({ field: CHECKED_LISTING_POLICY_KEYS[request], request }));
/** The patch's policy fields: shipping, return, payment. */
export const LISTING_SETTING_POLICY_FIELDS: readonly CheckedListingPolicyKey[] = POLICY_FIELDS.map(({ field }) => field);

/** True when the patch sets an eBay id: an eBay category, an own shelf or a policy (plan 6.5 step 2). */
export function setsListingSettingEbayId(patch: ListingSettingEbayIdsPatch): boolean {
  return patch.ebayCategory != null || patch.storeShelf?.mode === "own"
    || POLICY_FIELDS.some(({ field }) => patch[field] != null);
}

/**
 * The fields whose set id is not the one the target stores, in the stored shape's order.
 * A shelf compares its id list in order. Nulls and `none` set no id.
 */
export function newListingSettingEbayFields(patch: ListingSettingEbayIdsPatch, known: KnownListingSettingEbayValues): ListingSettingEbayField[] {
  const fresh: ListingSettingEbayField[] = [];
  if (patch.ebayCategory != null && patch.ebayCategory.categoryId !== known?.ebayCategory?.categoryId) fresh.push("ebayCategory");
  if (patch.storeShelf?.mode === "own" && !sameShelves(patch.storeShelf.shelfIds, known?.storeShelf ?? null)) fresh.push("storeShelf");
  for (const { field } of POLICY_FIELDS) {
    const sent = patch[field];
    if (sent != null && sent.id !== known?.[field]?.id) fresh.push(field);
  }
  return fresh;
}

/** The stored values for every eBay field the patch names: known ones as stored, new ones from eBay. */
export async function resolveListingSettingEbayValues(port: ListingSettingEbayPort, input: {
  vendorId: number;
  storeConnectionId: number;
  patch: ListingSettingEbayIdsPatch;
  preflight: ListingSettingEbayPreflight;
}): Promise<ListingSettingEbayResolution> {
  const { patch, preflight, storeConnectionId } = input;
  if (!preflight.keyIsNew) return { status: "skipped" };
  const fresh = new Set(newListingSettingEbayFields(patch, preflight.known));
  if (fresh.size > 0 && preflight.storeStatus === SIGN_IN_REQUIRED_STORE_STATUS) {
    throw listingSettingEbaySignInRequired(storeConnectionId, LISTING_SETTING_EBAY_FIELDS.filter((field) => fresh.has(field)));
  }
  const identity = { vendorId: input.vendorId, storeConnectionId };
  const known = preflight.known;
  const values: ListingSettingEbayValues = {};

  if (patch.ebayCategory !== undefined) {
    values.ebayCategory = patch.ebayCategory === null ? null
      : fresh.has("ebayCategory") ? await newEbayCategory(port, identity, patch.ebayCategory.categoryId, preflight.marketplaceId)
        : known!.ebayCategory;
  }

  const freshPolicies = POLICY_FIELDS.filter(({ field }) => fresh.has(field));
  const checked = freshPolicies.length > 0 ? await newPolicies(port, identity, patch, freshPolicies, preflight.marketplaceId) : {};
  for (const { field } of POLICY_FIELDS) {
    const sent = patch[field];
    if (sent === undefined) continue;
    values[field] = sent === null ? null : fresh.has(field) ? checked[field]! : known![field];
  }

  if (patch.storeShelf !== undefined) {
    const shelf = patch.storeShelf;
    values.storeShelf = shelf === null ? null : shelf.mode === "none" ? { mode: "none" }
      : fresh.has("storeShelf") ? await newShelves(port, identity, shelf.shelfIds) : known!.storeShelf;
  }
  return { status: "resolved", values, askedEbay: fresh.size > 0 };
}

/** W3's checks for one new category: US only, then eBay's value, a leaf, storable as the settings keep it. */
async function newEbayCategory(port: ListingSettingEbayPort, identity: EbayCategoryIdentity, categoryId: string,
  marketplaceId: string): Promise<EbayCategory> {
  if (marketplaceId !== SUPPORTED_EBAY_CATEGORY_MARKETPLACE_ID) {
    throw new DropshipError("DROPSHIP_EBAY_CATEGORY_MARKETPLACE_UNSUPPORTED", "eBay categories are available for eBay US stores only.", {
      storeConnectionId: identity.storeConnectionId, marketplaceId, invalidFields: ["ebayCategory"],
      retryable: false, classification: "permanent",
    });
  }
  const described = await port.describeCategories(identity, [categoryId]);
  const verified = inListingSettingTerms(identity.storeConnectionId, () => verifyEbayLeafCategories({
    storeConnectionId: identity.storeConnectionId, described, requests: [{ categoryId, ruleId: null }] })).get(categoryId);
  const stored = ebayCategorySchema.safeParse(verified);
  if (!stored.success) {
    throw new DropshipError("DROPSHIP_EBAY_CATEGORY_RULE_INVALID",
      "eBay names this category in a way listing settings cannot keep. Pick another eBay category.", {
        storeConnectionId: identity.storeConnectionId, invalidFields: ["ebayCategory"], reason: "not_storable",
        retryable: false, classification: "permanent",
      });
  }
  return stored.data;
}

/**
 * W2's checks for the new policies only: Card Shellz shipping (read fresh)
 * only when the shipping policy is new, then eBay's policy lists once.
 */
async function newPolicies(port: ListingSettingEbayPort, identity: EbayCategoryIdentity, patch: ListingSettingEbayIdsPatch,
  fields: typeof POLICY_FIELDS, marketplaceId: string): Promise<Partial<Record<CheckedListingPolicyKey, ListingSettingPolicy>>> {
  const request: Partial<Record<EbayBusinessPolicyField, string>> = {};
  for (const { field, request: key } of fields) request[key] = patch[field]!.id;
  const capability = request.fulfillmentPolicyId !== undefined
    ? await port.loadFulfillmentCapability({ storeConnectionId: identity.storeConnectionId, marketplaceId })
    : null;
  const discovery = await port.discoverPolicies({ ...identity, marketplaceId });
  const checked: CheckedListingPolicies = inListingSettingTerms(identity.storeConnectionId,
    () => checkListingPolicyIds(request, discovery, capability, identity.storeConnectionId));
  const policies: Partial<Record<CheckedListingPolicyKey, ListingSettingPolicy>> = {};
  for (const { field } of fields) {
    const policy = checked[field];
    if (!policy) throw listingSettingsInvariantFailed("The eBay policy check returned no value for a policy it was sent.", { field });
    // The name is display only (plan D7): one longer than the column is stored as unknown, never cut.
    policies[field] = { id: policy.id, name: policy.name !== null && policy.name.length <= MAX_LISTING_POLICY_NAME_LENGTH ? policy.name : null };
  }
  return policies;
}

/** The store's current leaf shelves for the new id list, each with its path, within the stored bounds. */
async function newShelves(port: ListingSettingEbayPort, identity: EbayCategoryIdentity,
  shelfIds: readonly string[]): Promise<ListingSettingStoreShelf> {
  const leaves = await port.listStoreShelves(identity);
  const shelves = resolveStoreShelfIds(shelfIds, leaves, () => shelfInvalid(identity.storeConnectionId, "not_found"));
  if (shelves.some((shelf) => shelf.id.length > MAX_LISTING_SHELF_ID_LENGTH || shelf.name.length > MAX_LISTING_SHELF_NAME_LENGTH)) {
    throw shelfInvalid(identity.storeConnectionId, "too_long");
  }
  return { mode: "own", shelves };
}

function shelfInvalid(storeConnectionId: number, reason: "not_found" | "too_long"): DropshipError {
  return new DropshipError("DROPSHIP_EBAY_STORE_CATEGORY_INVALID",
    reason === "not_found"
      ? "That store shelf is not in your eBay store now. Reload the shelves and pick again."
      : "eBay names that store shelf in a way listing settings cannot keep. Pick another shelf.", {
      storeConnectionId, invalidFields: ["storeShelf"], reason, retryable: false, classification: "permanent",
    });
}

/**
 * Runs one of 9b's checks and re-states its refusal in these routes' terms
 * (review round, H2). 9b answers W2 and W3, whose fields are the listing
 * config's (`returnPolicyId`) and whose `categoryId` is eBay's number; here
 * the fields are the patch's (`returnPolicy`), and `categoryId` means a Card
 * Shellz category. The code, the words and `reason` stay 9b's; the context is
 * rebuilt so a page can mark the field the vendor chose:
 * - a policy eBay no longer lists: `invalidFields` mapped to the patch fields;
 * - a shipping policy Card Shellz cannot ship: `invalidFields: ["shippingPolicy"]`
 *   and each issue as `{ path: ["shippingPolicy"], code }` (the issue's own
 *   message can quote eBay's values, so it stays out);
 * - an eBay category not found or not a leaf: `invalidFields: ["ebayCategory"]`.
 * Anything else (a provider failure, 9b's invariant) propagates unchanged.
 */
function inListingSettingTerms<T>(storeConnectionId: number, check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (!(error instanceof DropshipError)) throw error;
    const permanent = { storeConnectionId, retryable: false, classification: "permanent" } as const;
    if (error.code === "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID") {
      const sent = Array.isArray(error.context?.invalidFields) ? error.context.invalidFields : [];
      const invalidFields = POLICY_FIELDS.filter(({ request }) => sent.includes(request)).map(({ field }) => field);
      throw new DropshipError(error.code, error.message, { ...permanent, invalidFields });
    }
    if (error.code === "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE") {
      const issues = Array.isArray(error.context?.issues) ? error.context.issues : [];
      throw new DropshipError(error.code, error.message, {
        ...permanent,
        invalidFields: ["shippingPolicy"],
        issues: issues.flatMap((issue: unknown) => issue !== null && typeof issue === "object"
          && typeof (issue as { code?: unknown }).code === "string"
          ? [{ path: ["shippingPolicy"], code: (issue as { code: string }).code }] : []),
      });
    }
    if (error.code === "DROPSHIP_EBAY_CATEGORY_RULE_INVALID") {
      const reason = error.context?.reason;
      throw new DropshipError(error.code, error.message, {
        ...permanent, invalidFields: ["ebayCategory"], ...(typeof reason === "string" ? { reason } : {}),
      });
    }
    throw error;
  }
}

function sameShelves(ids: readonly string[], stored: ListingSettingStoreShelf | null): boolean {
  if (stored?.mode !== "own" || stored.shelves.length !== ids.length) return false;
  return stored.shelves.every((shelf, index) => shelf.id === ids[index]);
}
