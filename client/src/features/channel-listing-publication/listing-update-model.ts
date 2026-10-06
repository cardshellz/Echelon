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

/** An explicit content resubmission must not diff against the prefilled values:
 * those are prior requests, not evidence that Walmart applied this product type.
 * Only carry fields exposed by the maintenance schema. Creation-only values
 * such as condition and country of origin must not leak into the repair feed. */
export function listingUpdateContentResubmission(
  original: ListingUpdateFields,
  current: ListingUpdateFields,
  maintenanceSchema: Record<string, unknown>,
): ListingUpdateChanges {
  const properties = object(maintenanceSchema.properties);
  const visibleProperties = object(object(properties.Visible).properties);
  if (Object.keys(visibleProperties).length === 0) {
    throw new Error(
      "Load the selected product type's editable fields before resubmitting content.",
    );
  }
  const changes = listingUpdateChanges(original, current);
  for (const key of ["title", "description", "brand"] as const) {
    if (current[key].trim()) changes[key] = current[key].trim();
  }
  if (current.images.trim()) {
    changes.images = current.images
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  }
  const visible = Object.fromEntries(
    Object.entries(object(current.attributes.Visible)).filter(
      ([key, value]) =>
        Object.hasOwn(visibleProperties, key) &&
        value !== undefined && value !== null && value !== "",
    ),
  );
  changes.attributes = {
    ...changes.attributes,
    Visible: structuredClone(visible),
  };
  return listingUpdateChangesSchema.parse(changes);
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
