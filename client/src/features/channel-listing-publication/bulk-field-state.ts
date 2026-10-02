import {
  listingDraftItemSchema,
  type ListingCatalogItem,
  type ListingDraftItem,
} from "@shared/types/channel-listing-publication";
import {
  bulkEditPatchSchema,
  bulkFixedPriceCents,
  type BulkEditPatch,
} from "./bulk-edit-model";
import { parseImageOverride } from "./content-inheritance";
import { canonicalDraftValue } from "./draft-item-snapshot";
import { money } from "./model";

export const BULK_CONTENT_FIELDS = [
  "brand",
  "title",
  "description",
  "images",
  "priceOverrideCents",
] as const;
export type BulkContentField = (typeof BULK_CONTENT_FIELDS)[number];
export type BulkPresentationField = BulkContentField | "method" | "productType";
/** Absent keys are untouched; null restores inheritance; strings preserve the raw edit buffer. */
export type BulkFieldEdits = Partial<Record<BulkContentField, string | null>>;
type BulkContentPatch = Pick<BulkEditPatch, BulkContentField>;
type FieldSource = "catalog" | "pricing" | "custom" | "draft";
export interface BulkFieldPresentation {
  status: "common" | "mixed" | "unavailable";
  value: string;
  source: FieldSource | "mixed" | null;
  unavailableCount: number;
}
interface EffectiveValue {
  value: string | string[] | number | undefined;
  source: FieldSource;
}
const FIELD_LABELS: Record<BulkContentField, string> = {
  brand: "Brand",
  title: "Title",
  description: "Description",
  images: "Images",
  priceOverrideCents: "Fixed price",
};

function effectiveValue(
  item: ListingDraftItem,
  catalog: ListingCatalogItem | undefined,
  field: BulkPresentationField,
  inherit: boolean,
): EffectiveValue {
  if (field === "method" || field === "productType")
    return { value: item[field], source: "draft" };
  const override = item[field];
  if (!inherit && override !== null)
    return { value: override, source: "custom" };
  const source = field === "priceOverrideCents" ? "pricing" : "catalog";
  if (!catalog || catalog.variantId !== item.variantId)
    return { value: undefined, source };
  if (field === "priceOverrideCents") {
    const cents = catalog.priceCents;
    return {
      value:
        cents !== null && Number.isSafeInteger(cents) && cents >= 0
          ? cents
          : undefined,
      source,
    };
  }
  return { value: catalog[field] ?? "", source };
}

/** Read-only display projection. No common value becomes an explicit draft override. */
export function projectBulkField(
  items: readonly ListingDraftItem[],
  metadata: ReadonlyMap<number, ListingCatalogItem>,
  field: BulkPresentationField,
  options: { inherit?: boolean } = {},
): BulkFieldPresentation {
  const effective = items.map((item) =>
    effectiveValue(
      item,
      metadata.get(item.variantId),
      field,
      options.inherit ?? false,
    ),
  );
  const unavailableCount = effective.filter(
    (item) => item.value === undefined,
  ).length;
  const sources = new Set(effective.map((item) => item.source));
  const source = sources.size > 1 ? "mixed" : (effective[0]?.source ?? null);
  if (items.length === 0 || unavailableCount > 0)
    return { status: "unavailable", value: "", source, unavailableCount };
  const first = effective[0].value!;
  if (
    effective.some(
      (item) => canonicalDraftValue(item.value) !== canonicalDraftValue(first),
    )
  )
    return { status: "mixed", value: "", source, unavailableCount: 0 };
  const value = Array.isArray(first)
    ? first.join("\n")
    : typeof first === "number"
      ? money(first).slice(1)
      : first;
  return { status: "common", value, source, unavailableCount: 0 };
}

function assertField(field: string): asserts field is BulkContentField {
  if (!(BULK_CONTENT_FIELDS as readonly string[]).includes(field))
    throw new Error(
      "This field cannot be changed through shared content editing.",
    );
}

export function setBulkFieldEdit(
  edits: BulkFieldEdits,
  field: BulkContentField,
  value: string | null,
): BulkFieldEdits {
  assertField(field);
  if (value !== null && typeof value !== "string")
    throw new Error("Enter a text value or explicitly restore inheritance.");
  return { ...edits, [field]: value };
}

export function undoBulkFieldEdit(
  edits: BulkFieldEdits,
  field: BulkContentField,
): BulkFieldEdits {
  assertField(field);
  const result = { ...edits };
  delete result[field];
  return result;
}

/** Only explicit edits reach this boundary; invalid buffers stay intact in the caller. */
export function buildBulkFieldPatch(edits: BulkFieldEdits): BulkContentPatch {
  const patch: BulkContentPatch = {};
  for (const [key, value] of Object.entries(edits)) {
    assertField(key);
    if (value !== null && typeof value !== "string")
      throw new Error(
        `${FIELD_LABELS[key]}: leave untouched fields out of the edit.`,
      );
    if (value === null || value.trim().length === 0) patch[key] = null;
    else if (key === "priceOverrideCents")
      patch.priceOverrideCents = bulkFixedPriceCents(value);
    else if (key === "images") patch.images = parseImageOverride(value);
    else patch[key] = value;
  }
  const parsed = bulkEditPatchSchema.safeParse(patch);
  if (!parsed.success)
    throw new Error(
      parsed.error.issues
        .slice(0, 3)
        .map((issue) => {
          const field = String(issue.path[0]) as BulkContentField;
          return `${FIELD_LABELS[field] ?? "Shared content"}: ${issue.message}`;
        })
        .join("; "),
    );
  return parsed.data;
}

export interface BulkIdentifierPresentation {
  value: ListingDraftItem["identifier"];
  source: "custom" | "catalog" | "unavailable";
}

/** Display inheritance without copying one item's identifier into another row. */
export function projectBulkIdentifier(
  item: ListingDraftItem,
  catalog: ListingCatalogItem | undefined,
): BulkIdentifierPresentation {
  if (item.identifier !== null)
    return { value: { ...item.identifier }, source: "custom" };
  if (!catalog || catalog.variantId !== item.variantId)
    return { value: null, source: "unavailable" };
  return {
    value: catalog.identifier ? { ...catalog.identifier } : null,
    source: "catalog",
  };
}

export function parseBulkItemIdentifier(
  type: NonNullable<ListingDraftItem["identifier"]>["type"],
  raw: string,
): ListingDraftItem["identifier"] {
  return listingDraftItemSchema.shape.identifier.parse(
    raw.trim() ? { type, value: raw } : null,
  );
}
