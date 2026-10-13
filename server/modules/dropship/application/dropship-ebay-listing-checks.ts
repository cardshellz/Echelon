import type { EbayCategory, EbayCategoryOption } from "../../../../shared/dropship/ebay-category-rules";
import { DropshipError } from "../domain/errors";
import {
  evaluateDropshipEbayFulfillmentPolicyCompatibility,
  type DropshipEbayFulfillmentCapability,
  type DropshipEbayFulfillmentPolicy,
} from "../domain/ebay-fulfillment-policy-compatibility";
import { EBAY_BUSINESS_POLICY_FIELDS, type EbayBusinessPolicyField } from "../domain/ebay-listing-setup-config";
// Types only: the setup service imports this module at runtime, so a runtime
// import back would be a cycle.
import type {
  DropshipEbayFulfillmentPolicyOption,
  DropshipEbayListingSetupDiscovery,
  DropshipEbayListingSetupOption,
  DropshipEbayListingSetupSelection,
} from "./dropship-ebay-listing-setup-service";
import type { DropshipEbayStoreCategory } from "./dropship-ebay-store-category-service";

/**
 * The eBay checks the listing writers share (PR 9, sub-PR 9b): the
 * store-default policies (W2 setup save), store shelves (W2 and the per-size
 * shelf service) and eBay categories (W3 category rules).
 *
 * Pure: no eBay call, no database read, no clock. The caller asks eBay and
 * passes what eBay answered. Each check returns the values with the fields the
 * listing settings store (shared/dropship/listing-setting-values.ts), or throws
 * the refusal its caller has always answered, with the same words and context.
 *
 * The values are NOT bounded to the stored limits: a policy name, shelf path
 * or category name is eBay's as is (only a policy name is trimmed). A caller
 * that stores them applies the stored limits first (PR 9 plan P13: a policy
 * name over 200 characters becomes null; a shelf id or path over its limit and
 * an eBay category the stored schema refuses are 422s). W3 does that by parsing
 * its profile with ebayCategoryRulesProfileSchema.
 */

/** A listing setting's policy key (the stored shape), by the listing config's policy id field. */
export type CheckedListingPolicyKey = "shippingPolicy" | "returnPolicy" | "paymentPolicy";

/** eBay calls the shipping policy a fulfillment policy; the listing settings call it the shipping policy. */
export const CHECKED_LISTING_POLICY_KEYS: Readonly<Record<EbayBusinessPolicyField, CheckedListingPolicyKey>> = {
  fulfillmentPolicyId: "shippingPolicy",
  returnPolicyId: "returnPolicy",
  paymentPolicyId: "paymentPolicy",
};

/** The policy ids a save sends, by listing config field. A field left out is not checked. */
export type ListingPolicyIdRequest = Readonly<Partial<Record<EbayBusinessPolicyField, string>>>;

/** A policy as the listing settings store it: eBay's id, and the name eBay lists for it now (null when eBay lists none). */
export interface CheckedListingPolicy {
  id: string;
  name: string | null;
}

/** The checked policies, only for the fields the request sent. */
export type CheckedListingPolicies = Partial<Record<CheckedListingPolicyKey, CheckedListingPolicy>>;

/** A store shelf as the listing settings store it: eBay's id and the path name an offer sends. */
export interface ResolvedStoreShelf {
  id: string;
  name: string;
}

/** One eBay category a category rules draft names: the store default (`ruleId` null) or a rule's. */
export interface EbayCategoryRequest {
  categoryId: string;
  ruleId: string | null;
}

type ListingPolicySelection = Pick<DropshipEbayListingSetupSelection, EbayBusinessPolicyField>;

const NO_SELECTED_POLICIES: ListingPolicySelection = {
  fulfillmentPolicyId: null,
  returnPolicyId: null,
  paymentPolicyId: null,
};

/**
 * Each eBay shipping policy with whether it fits Card Shellz shipping. With
 * no capability (Card Shellz shipping could not be read) every policy is
 * unchecked and not compatible, so nothing can pick it until it is checked.
 */
export function buildFulfillmentPolicyOptions(
  policies: readonly DropshipEbayFulfillmentPolicy[],
  capability: DropshipEbayFulfillmentCapability | null,
): DropshipEbayFulfillmentPolicyOption[] {
  return policies.map((policy) => {
    if (!capability) {
      return {
        id: policy.id,
        name: policy.name,
        compatible: false,
        compatibilityChecked: false,
        compatibilityIssues: [],
      };
    }
    const compatibility = evaluateDropshipEbayFulfillmentPolicyCompatibility({
      capability,
      policy,
    });
    return {
      id: policy.id,
      name: policy.name,
      compatible: compatibility.compatible,
      compatibilityChecked: true,
      compatibilityIssues: compatibility.issues,
    };
  });
}

/**
 * Checks each policy the request sends against eBay's current lists (and the
 * shipping policy against Card Shellz shipping). Fields the request leaves out
 * are not checked: they keep their saved value, and the preview's live check
 * reports any that eBay no longer lists. Returns each sent policy with the
 * name eBay lists for it now.
 */
export function checkListingPolicyIds(
  request: ListingPolicyIdRequest,
  discovery: DropshipEbayListingSetupDiscovery | null,
  capability: DropshipEbayFulfillmentCapability | null,
  storeConnectionId: number,
): CheckedListingPolicies {
  const sent = EBAY_BUSINESS_POLICY_FIELDS.filter((field) => request[field] !== undefined);
  if (sent.length === 0) return {};
  if (!discovery) {
    throw new DropshipError(
      "DROPSHIP_EBAY_LISTING_SETUP_INVARIANT_FAILED",
      "eBay's policy lists are required to check a policy save.",
      { storeConnectionId, retryable: false },
    );
  }
  const fulfillmentPolicies = buildFulfillmentPolicyOptions(discovery.fulfillmentPolicies, capability);
  const optionsByField: Record<EbayBusinessPolicyField, readonly DropshipEbayListingSetupOption[]> = {
    fulfillmentPolicyId: fulfillmentPolicies,
    returnPolicyId: discovery.returnPolicies,
    paymentPolicyId: discovery.paymentPolicies,
  };
  const invalidFields = sent.filter((field) => !hasOption(request[field]!, optionsByField[field]));
  if (invalidFields.length > 0) {
    throw new DropshipError(
      "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID",
      "One or more eBay listing setup selections are no longer available.",
      { storeConnectionId, invalidFields, retryable: false },
    );
  }
  if (request.fulfillmentPolicyId !== undefined) {
    const selectedFulfillmentPolicy = fulfillmentPolicies.find(
      (policy) => policy.id === request.fulfillmentPolicyId,
    );
    if (!selectedFulfillmentPolicy?.compatibilityChecked || !selectedFulfillmentPolicy.compatible) {
      throw new DropshipError(
        "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE",
        "The selected eBay fulfillment policy exceeds Card Shellz fulfillment capabilities.",
        {
          storeConnectionId,
          fulfillmentPolicyId: request.fulfillmentPolicyId,
          issues: selectedFulfillmentPolicy?.compatibilityIssues ?? [],
          retryable: false,
        },
      );
    }
  }
  const ids: Partial<Record<EbayBusinessPolicyField, string>> = Object.fromEntries(
    sent.map((field) => [field, request[field]!]),
  );
  // Names for the sent ids only: nothing is "kept" from a current selection here.
  const names = listingPolicyNamesFromDiscovery(discovery, NO_SELECTED_POLICIES, ids);
  const checked: CheckedListingPolicies = {};
  for (const field of sent) {
    checked[CHECKED_LISTING_POLICY_KEYS[field]] = { id: request[field]!, name: names[field] ?? null };
  }
  return checked;
}

/**
 * The names eBay lists now for each policy id the config will hold after the
 * change: the changed id where `policies` sets one (null removes it), else the
 * current one. A name eBay lists as blank is left out.
 */
export function listingPolicyNamesFromDiscovery(
  discovery: DropshipEbayListingSetupDiscovery,
  current: ListingPolicySelection,
  policies: Readonly<Partial<Record<EbayBusinessPolicyField, string | null>>>,
): Partial<Record<EbayBusinessPolicyField, string>> {
  const optionsByField: Record<EbayBusinessPolicyField, readonly DropshipEbayListingSetupOption[]> = {
    fulfillmentPolicyId: discovery.fulfillmentPolicies,
    returnPolicyId: discovery.returnPolicies,
    paymentPolicyId: discovery.paymentPolicies,
  };
  const names: Partial<Record<EbayBusinessPolicyField, string>> = {};
  for (const field of EBAY_BUSINESS_POLICY_FIELDS) {
    const finalId = policies[field] !== undefined ? policies[field] : current[field];
    if (!finalId) continue;
    const name = optionsByField[field].find((option) => option.id === finalId)?.name.trim();
    if (name) names[field] = name;
  }
  return names;
}

/**
 * The connected store's current leaf shelves (store categories) for the
 * requested ids, in request order, each with the path an offer sends (eBay
 * takes store categories by name). The first id the store does not have
 * throws the caller's own refusal: the setup save and the per-size shelf
 * service word it differently, and the client shows those words as they are.
 */
export function resolveStoreShelfIds(
  ids: readonly string[],
  leaves: readonly DropshipEbayStoreCategory[],
  invalidShelf: (shelfId: string) => DropshipError,
): ResolvedStoreShelf[] {
  const leavesById = new Map(leaves.map((leaf) => [leaf.categoryId, leaf]));
  return ids.map((id) => {
    const leaf = leavesById.get(id);
    if (!leaf) throw invalidShelf(id);
    return { id: leaf.categoryId, name: leaf.path };
  });
}

/**
 * eBay's own value for each requested category, by requested id. Requests are
 * checked in order (the caller puts the store default first, then the rules),
 * and the first one eBay does not list, or lists above the last level, is
 * refused with its rule. Nothing from the client is stored as a name.
 */
export function verifyEbayLeafCategories(input: {
  storeConnectionId: number;
  /** eBay's answer for the requested ids; an id eBay does not list is absent. */
  described: ReadonlyMap<string, EbayCategoryOption>;
  requests: readonly EbayCategoryRequest[];
}): Map<string, EbayCategory> {
  const verified = new Map<string, EbayCategory>();
  for (const { categoryId, ruleId } of input.requests) {
    const option = input.described.get(categoryId);
    if (!option) {
      throw new DropshipError("DROPSHIP_EBAY_CATEGORY_RULE_INVALID",
        "That eBay category is not in eBay's current category list. Search again and pick a current category.",
        { storeConnectionId: input.storeConnectionId, categoryId, ruleId, reason: "not_found" });
    }
    if (!option.leaf) {
      throw new DropshipError("DROPSHIP_EBAY_CATEGORY_RULE_INVALID",
        "Pick a more specific eBay category. eBay accepts listings only in the last level of a category path.",
        { storeConnectionId: input.storeConnectionId, categoryId, ruleId, reason: "not_leaf" });
    }
    if (!verified.has(categoryId)) {
      verified.set(categoryId, { categoryId: option.categoryId, categoryName: option.categoryName, path: [...option.path] });
    }
  }
  return verified;
}

function hasOption(selectedId: string, options: readonly DropshipEbayListingSetupOption[]): boolean {
  return options.some((option) => option.id === selectedId);
}
