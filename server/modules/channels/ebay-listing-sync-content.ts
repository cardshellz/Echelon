import Decimal from "decimal.js";
import { canonicalJson } from "@shared/utils/canonical-json";
import { syncStageHash } from "./ebay-listing-sync.domain";
import type {
  BuiltEbayListingDraft,
  BuiltItemGroup,
} from "./adapters/ebay/ebay-listing-builder";
import type {
  EbayInventoryItem,
  EbayInventoryItemGroup,
  EbayOffer,
} from "./adapters/ebay/ebay-types";

/** Quantity is refreshed by inventory publication and is not this content job's completion contract. */
export function inventoryItemSyncContent(
  payload: Omit<EbayInventoryItem, "sku">,
): Omit<EbayInventoryItem, "sku" | "availability"> {
  const { availability: _quantity, ...content } = payload;
  return content;
}
export function offerSyncContent(
  payload: EbayOffer,
): Omit<EbayOffer, "availableQuantity"> {
  const { availableQuantity: _quantity, ...content } = payload;
  return content;
}
export function itemGroupSyncContent(
  payload: EbayInventoryItemGroup,
): Omit<EbayInventoryItemGroup, "inventoryItemGroupKey"> {
  const { inventoryItemGroupKey: _requestKey, ...content } = payload;
  return {
    ...content,
    ...(content.variantSKUs ? { variantSKUs: [...content.variantSKUs].sort() } : {}),
  };
}

/** Bind durable verification to the exact desired content, independently of changing ATP. */
export function syncContentIntentHash(
  draft: Pick<BuiltEbayListingDraft, "inventoryItems" | "offers"> & {
    itemGroup?: BuiltItemGroup | null;
  },
): string {
  return syncStageHash({
    inventoryItems: draft.inventoryItems
      .map((item) => ({
        sku: item.sku,
        payload: inventoryItemSyncContent(item.payload),
      }))
      .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0)),
    offers: draft.offers
      .map((offer) => ({
        variantId: offer.variantId,
        sku: offer.sku,
        payload: offerSyncContent(offer.payload),
      }))
      .sort((a, b) => a.variantId - b.variantId),
    itemGroup: draft.itemGroup
      ? {
          groupKey: draft.itemGroup.groupKey,
          payload: itemGroupSyncContent(draft.itemGroup.payload),
        }
      : null,
  });
}

/** Return only a field path, never provider values such as private image URLs. */
export function findEbaySyncContentMismatch(
  actual: unknown,
  expected: unknown,
  path = "content",
): string | null {
  if (expected && typeof expected === "object" && "currency" in expected && "value" in expected) {
    const observed = actual && typeof actual === "object"
      ? (actual as Record<string, unknown>)
      : null;
    if (!observed || observed.currency !== expected.currency) return `${path}.currency`;
    if (
      typeof observed.value !== "string" || typeof expected.value !== "string"
      || !/^[0-9]+(?:\.[0-9]+)?$/.test(observed.value)
      || !/^[0-9]+(?:\.[0-9]+)?$/.test(expected.value)
      || !new Decimal(observed.value).equals(new Decimal(expected.value))
    ) return `${path}.value`;
    return null;
  }
  if (expected === null || typeof expected !== "object") return actual === expected ? null : path;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && canonicalJson(actual) === canonicalJson(expected)
      ? null
      : path;
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return path;
  for (const [key, value] of Object.entries(expected)) {
    if (value === undefined) continue;
    const observed = (actual as Record<string, unknown>)[key];
    let mismatch: string | null;
    if (key === "variantSKUs" && Array.isArray(value)) {
      const sameMembers = Array.isArray(observed)
        && canonicalJson([...observed].sort()) === canonicalJson([...value].sort());
      mismatch = sameMembers ? null : `${path}.${key}`;
    } else {
      mismatch = findEbaySyncContentMismatch(observed, value, `${path}.${key}`);
    }
    if (mismatch) return mismatch;
  }
  return null;
}
