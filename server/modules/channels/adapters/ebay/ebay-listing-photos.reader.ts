import type { EbayInventoryItem, EbayInventoryItemGroup } from "./ebay-types";
import type { EbayPhotoVariant, EbayListingPhotoPlan } from "../../ebay-listing-photos.domain";
import { assertEbayPhotoUrl, assertEbayPhotoVariants } from "../../ebay-listing-photos.domain";

export interface EbayListingPhotoReadClient {
  getInventoryItem(sku: string): Promise<EbayInventoryItem | null>;
  getInventoryItemGroup(groupKey: string): Promise<EbayInventoryItemGroup | null>;
}

/** The external snapshot is scoped to each SKU; group pictures never stand in for a different SKU. */
export async function readExistingEbayListingPhotos(
  client: EbayListingPhotoReadClient,
  input: { groupKey: string | null; variants: readonly EbayPhotoVariant[] },
): Promise<EbayListingPhotoPlan> {
  assertEbayPhotoVariants(input.variants);
  if (input.groupKey === null ? input.variants.length !== 1
    : typeof input.groupKey !== "string" || !input.groupKey || input.groupKey.trim() !== input.groupKey) {
    throw new Error("An exact eBay listing group key is required.");
  }
  const group = input.groupKey === null ? null : await client.getInventoryItemGroup(input.groupKey);
  if (group?.inventoryItemGroupKey !== undefined && group.inventoryItemGroupKey !== input.groupKey) {
    throw new Error("eBay returned another listing group while reading photos.");
  }
  const groupImageUrls = validatedUrls(group?.imageUrls ?? []);
  const byVariantId = new Map<number, readonly string[]>();
  // Keep provider reads serial: the client's existing rate-limit/retry policy owns pacing.
  for (const variant of input.variants) {
    const item = await client.getInventoryItem(variant.sku);
    if (item?.sku !== undefined && item.sku !== variant.sku) throw new Error("eBay returned another SKU while reading listing photos.");
    byVariantId.set(variant.variantId, validatedUrls(item?.product?.imageUrls ?? []));
  }
  return { byVariantId, groupImageUrls };
}

function validatedUrls(value: readonly string[]): string[] {
  if (!Array.isArray(value)) throw new Error("eBay listing photos returned an invalid response.");
  value.forEach(assertEbayPhotoUrl);
  return [...value];
}
