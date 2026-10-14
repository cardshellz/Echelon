import { listingDraftItemSchema, type ListingDraftItem } from "@shared/types/channel-listing-publication";

const section = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

/** Only these offer fields are shared by the full-item and match schemas.
 * Keep identity, price and content overrides on the draft; validate the new
 * method's remaining attributes against its requirements during review. */
export function selectListingMethod(item: ListingDraftItem, method: ListingDraftItem["method"]): ListingDraftItem {
  if (item.method === method) return item;
  const orderable = section(item.attributes.Orderable);
  const visible = section(item.attributes.Visible);
  const condition = item.method === "create" ? visible.condition : orderable.condition;
  const weight = orderable.ShippingWeight;
  return listingDraftItemSchema.parse({
    ...item,
    method,
    attributes: {
      Orderable: {
        ...(weight !== undefined ? { ShippingWeight: weight } : {}),
        ...(method === "match" && condition !== undefined ? { condition } : {}),
      },
      ...(method === "create" && condition !== undefined ? { Visible: { condition } } : {}),
    },
  });
}
