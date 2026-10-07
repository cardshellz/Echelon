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
/** Review sends every populated editable field, including unchanged values.
 * The maintenance schema excludes creation-only and protected attributes that
 * may still be present in a previous submission. Blank controls are omitted. */
export function listingUpdateSubmission(
  current: ListingUpdateFields,
  maintenanceSchema: Record<string, unknown>,
): ListingUpdateChanges {
  const changes: ListingUpdateChanges = {};
  if (current.price.trim()) {
    const cents = dollarsToCents(current.price);
    if (cents === null)
      throw new Error(
        "Enter a positive price with at most two decimal places.",
      );
    changes.priceCents = cents;
  }
  for (const key of ["title", "description", "brand"] as const) {
    if (current[key].trim()) changes[key] = current[key].trim();
  }
  if (current.images.trim())
    changes.images = current.images
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  const properties = object(maintenanceSchema.properties);
  for (const section of ["Orderable", "Visible"] as const) {
    const sectionSchema = object(properties[section]);
    if (
      sectionSchema.properties === null ||
      typeof sectionSchema.properties !== "object" ||
      Array.isArray(sectionSchema.properties)
    ) {
      throw new Error(
        "Load the selected product type's editable fields before reviewing the listing.",
      );
    }
    const allowed = object(sectionSchema.properties);
    for (const [key, value] of Object.entries(
      object(current.attributes[section]),
    )) {
      if (
        !Object.hasOwn(allowed, key) ||
        value === undefined ||
        value === null ||
        (typeof value === "string" && !value.trim())
      )
        continue;
      changes.attributes ??= {};
      changes.attributes[section] ??= {};
      changes.attributes[section]![key] = structuredClone(value);
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
