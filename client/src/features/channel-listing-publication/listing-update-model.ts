import {
  listingUpdateChangesSchema,
  type ListingUpdateChanges,
  type ListingUpdateContext,
} from "@shared/types/channel-listing-update";
import { dollarsToCents, money } from "./model";

export interface ListingUpdateFields {
  productType: string;
  price: string;
  title: string;
  description: string;
  brand: string;
  images: string;
  attributes: Record<string, unknown>;
}
export function initialListingUpdateFields(
  context: ListingUpdateContext,
): ListingUpdateFields {
  return {
    productType: context.suggestedProductType,
    price:
      context.current.priceCents === null
        ? ""
        : money(context.current.priceCents).slice(1),
    title: context.current.title,
    description: context.lastSubmitted?.description ?? "",
    brand: context.lastSubmitted?.brand ?? "",
    images: context.lastSubmitted?.images?.join("\n") ?? "",
    attributes: structuredClone(context.lastSubmitted?.attributes ?? {}),
  };
}
/** Missing/blank controls mean leave unchanged. Compound fields and lists replace
 * their complete attribute so a changed unit cannot silently keep an old measure. */
export function listingUpdateChanges(
  original: ListingUpdateFields,
  current: ListingUpdateFields,
): ListingUpdateChanges {
  const changes: ListingUpdateChanges = {};
  if (current.price.trim() && current.price !== original.price) {
    const cents = dollarsToCents(current.price);
    if (cents === null)
      throw new Error(
        "Enter a positive price with at most two decimal places.",
      );
    changes.priceCents = cents;
  }
  for (const key of ["title", "description", "brand"] as const) {
    if (current[key].trim() && current[key] !== original[key])
      changes[key] = current[key].trim();
  }
  if (current.images.trim() && current.images !== original.images)
    changes.images = current.images
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  for (const section of ["Orderable", "Visible"] as const) {
    const before = object(original.attributes[section]);
    const next = object(current.attributes[section]);
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined || value === null || value === "") continue;
      if (
        JSON.stringify(value) === JSON.stringify(before[key]) &&
        !(section === "Visible" && current.productType !== original.productType)
      )
        continue;
      changes.attributes ??= {};
      changes.attributes[section] ??= {};
      changes.attributes[section]![key] = value;
    }
  }
  const parsed = listingUpdateChangesSchema.safeParse(changes);
  if (!parsed.success)
    throw new Error(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .slice(0, 5)
        .join("; "),
    );
  return parsed.data;
}
export function updateFieldLabel(
  schema: Record<string, unknown> | undefined,
  section: string,
  key: string,
): string {
  const field = object(
    object(object(object(schema?.properties)[section]).properties)[key],
  );
  return typeof field.title === "string" ? field.title : key;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
