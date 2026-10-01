import { z } from "zod";
import {
  listingDraftItemSchema,
  listingProviderFieldsSchema,
  publicationIdSchema,
  publicationMoneySchema,
  type ListingDraftItem,
} from "@shared/types/channel-listing-publication";
import { dollarsToCents, MAX_DRAFT_ITEMS } from "./model";
import {
  canonicalDraftValue as canonical,
  listingDraftItemsFingerprint,
} from "./draft-item-snapshot";

const MAX_ATTRIBUTE_CHANGES = 250;
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
// Identity, stock and price remain owned by individual item fields/the publication flow.
const INDIVIDUAL_FIELDS = new Set([
  "sku",
  "variantid",
  "productid",
  "identifier",
  "productidentifiers",
  "gtin",
  "upc",
  "ean",
  "isbn",
  "inventory",
  "price",
  "automate_pricing",
  "skuupdate",
  "productidupdate",
]);
const pathSchema = z
  .array(z.string().min(1).max(200))
  .min(2)
  .max(15)
  .refine(
    (path) =>
      ["Orderable", "Visible"].includes(path[0]) &&
      path.every(
        (key) =>
          !RESERVED_KEYS.has(key) && !INDIVIDUAL_FIELDS.has(key.toLowerCase()),
      ),
    "Identifiers, stock and prices cannot be changed through shared attributes",
  );
const attributeChangeSchema = z.discriminatedUnion("action", [
  z
    .object({ path: pathSchema, action: z.literal("set"), value: z.unknown() })
    .strict(),
  z.object({ path: pathSchema, action: z.literal("remove") }).strict(),
]);
export type BulkAttributeChange = z.infer<typeof attributeChangeSchema>;
export const bulkEditPatchSchema = z
  .object({
    method: z.enum(["create", "match"]).optional(),
    productType: z.string().trim().min(1).max(200).optional(),
    title: z.string().trim().min(1).max(500).nullable().optional(),
    description: z.string().min(1).max(30_000).nullable().optional(),
    brand: z.string().trim().min(1).max(200).nullable().optional(),
    images: z
      .array(z.string().url().max(2_000))
      .min(1)
      .max(20)
      .nullable()
      .optional(),
    priceOverrideCents: publicationMoneySchema.nullable().optional(),
    attributeChanges: z
      .array(attributeChangeSchema)
      .max(MAX_ATTRIBUTE_CHANGES)
      .optional(),
  })
  .strict()
  .superRefine((patch, context) => {
    if (Object.values(patch).some((value) => value === undefined))
      context.addIssue({
        code: "custom",
        message: "Omit unchanged fields instead of setting undefined",
      });
    const changes = patch.attributeChanges ?? [];
    for (const [index, change] of changes.entries()) {
      if (
        change.action === "set" &&
        !listingProviderFieldsSchema.safeParse({ value: change.value }).success
      )
        context.addIssue({
          code: "custom",
          path: ["attributeChanges", index, "value"],
          message: "Shared attributes must be bounded JSON values",
        });
      else if (change.action === "set" && hasIndividualField(change.value))
        context.addIssue({
          code: "custom",
          path: ["attributeChanges", index, "value"],
          message:
            "Identifiers, stock and prices cannot be copied through shared attributes",
        });
      if (
        changes
          .slice(0, index)
          .some((previous) => pathsOverlap(previous.path, change.path))
      )
        context.addIssue({
          code: "custom",
          path: ["attributeChanges", index, "path"],
          message: "Each shared attribute must have one unambiguous change",
        });
    }
  });
export type BulkEditPatch = z.infer<typeof bulkEditPatchSchema>;
export interface BulkContext {
  method: ListingDraftItem["method"];
  productType: string;
}
export interface BulkItemPreview {
  variantId: number;
  fields: string[];
  attributesReset: boolean;
}
export interface BulkEditPreview {
  items: BulkItemPreview[];
  changedCount: number;
  resetCount: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasIndividualField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasIndividualField);
  return (
    object(value) &&
    Object.entries(value).some(
      ([key, child]) =>
        INDIVIDUAL_FIELDS.has(key.toLowerCase()) || hasIndividualField(child),
    )
  );
}
function pathsOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left
    .slice(0, Math.min(left.length, right.length))
    .every((key, index) => key === right[index]);
}
function validatedItems(
  items: readonly ListingDraftItem[],
  requireSelection: boolean,
): ListingDraftItem[] {
  if (
    !Array.isArray(items) ||
    items.length > MAX_DRAFT_ITEMS ||
    (requireSelection && items.length === 0)
  )
    throw new Error(`Select between 1 and ${MAX_DRAFT_ITEMS} draft items.`);
  const parsed = items.map((item) => listingDraftItemSchema.parse(item));
  if (new Set(parsed.map((item) => item.variantId)).size !== parsed.length)
    throw new Error("Each selected draft variant must appear once.");
  return parsed;
}

/** Stable comparison ignores property order, but never ignores a changed selected value. */
export function bulkSelectionFingerprint(
  items: readonly ListingDraftItem[],
): string {
  validatedItems(items, true);
  return listingDraftItemsFingerprint(items);
}

export function commonBulkContext(
  items: readonly ListingDraftItem[],
  patch: Pick<BulkEditPatch, "method" | "productType"> = {},
): BulkContext | null {
  if (!items.length) return null;
  const effective = items.map((item) => ({
    method: patch.method ?? item.method,
    productType: patch.productType ?? item.productType,
  }));
  const first = effective[0];
  if (
    effective.some(
      (item) =>
        item.method !== first.method || item.productType !== first.productType,
    )
  )
    return null;
  return first.method === "create" && !first.productType ? null : first;
}

/** Arrays replace explicitly; objects merge recursively so unrelated per-item leaves survive. */
function mergeValue(current: unknown, next: unknown): unknown {
  if (!object(next)) return structuredClone(next);
  if (current !== undefined && !object(current))
    throw new Error(
      "A shared attribute conflicts with an existing value. Edit that item individually.",
    );
  const merged = { ...(object(current) ? current : {}) };
  for (const [key, value] of Object.entries(next))
    merged[key] = mergeValue(merged[key], value);
  return merged;
}
function applyAttribute(
  root: Record<string, unknown>,
  change: BulkAttributeChange,
): Record<string, unknown> {
  const result = structuredClone(root);
  let parent = result;
  for (const key of change.path.slice(0, -1)) {
    const child = parent[key];
    if (child === undefined) {
      if (change.action === "remove") return result;
      parent[key] = {};
    } else if (!object(child))
      throw new Error(
        "A shared attribute conflicts with an existing value. Edit that item individually.",
      );
    parent = parent[key] as Record<string, unknown>;
  }
  const key = change.path[change.path.length - 1];
  if (change.action === "remove") delete parent[key];
  else parent[key] = mergeValue(parent[key], change.value);
  return result;
}
function changedFields(
  before: ListingDraftItem,
  after: ListingDraftItem,
  patch: BulkEditPatch,
): string[] {
  const fields = Object.keys(patch)
    .filter(
      (key): key is Exclude<keyof BulkEditPatch, "attributeChanges"> =>
        key !== "attributeChanges",
    )
    .filter((key) => canonical(before[key]) !== canonical(after[key]));
  const result: string[] = [...fields];
  for (const change of patch.attributeChanges ?? []) {
    const read = (item: ListingDraftItem) =>
      change.path.reduce<unknown>(
        (value, key) => (object(value) ? value[key] : undefined),
        item.attributes,
      );
    if (canonical(read(before)) !== canonical(read(after)))
      result.push(`attributes.${change.path.join(".")}`);
  }
  if (
    canonical(before.attributes) !== canonical(after.attributes) &&
    !result.some((field) => field.startsWith("attributes."))
  )
    result.push("attributes");
  return result;
}
export function prepareBulkEdit(
  items: readonly ListingDraftItem[],
  input: BulkEditPatch,
): { next: ListingDraftItem[]; preview: BulkEditPreview } {
  const patch = bulkEditPatchSchema.parse(input);
  const selected = validatedItems(items, true);
  if (patch.attributeChanges?.length && !commonBulkContext(selected, patch))
    throw new Error(
      "Choose a common listing method and product type before applying shared attributes.",
    );
  const { attributeChanges = [], ...fields } = patch;
  const previews: BulkItemPreview[] = [];
  const next = selected.map((item, index) => {
    const reset =
      (patch.method !== undefined && patch.method !== item.method) ||
      (patch.productType !== undefined &&
        patch.productType !== item.productType);
    let attributes = reset ? {} : structuredClone(item.attributes);
    for (const change of attributeChanges)
      attributes = applyAttribute(attributes, change);
    const updated = listingDraftItemSchema.parse({
      ...item,
      ...fields,
      attributes,
    });
    previews.push({
      variantId: item.variantId,
      fields: changedFields(item, updated, patch),
      attributesReset: reset && Object.keys(item.attributes).length > 0,
    });
    return canonical(item) === canonical(updated) ? items[index] : updated;
  });
  return {
    next,
    preview: {
      items: previews,
      changedCount: previews.filter((item) => item.fields.length > 0).length,
      resetCount: previews.filter((item) => item.attributesReset).length,
    },
  };
}
export function previewBulkEdit(
  items: readonly ListingDraftItem[],
  patch: BulkEditPatch,
): BulkEditPreview {
  return prepareBulkEdit(items, patch).preview;
}

/** Apply to current state atomically; newer unselected edits are retained and stale selections fail closed. */
export function validateBulkSelection(
  currentItems: readonly ListingDraftItem[],
  selectedSnapshot: readonly ListingDraftItem[],
  options: { canEdit: boolean } = { canEdit: true },
): ListingDraftItem[] {
  if (!options.canEdit)
    throw new Error("You do not have permission to edit these drafts.");
  validatedItems(currentItems, false);
  validatedItems(selectedSnapshot, true);
  const currentById = new Map(
    currentItems.map((item) => [item.variantId, item]),
  );
  const selectedCurrent = selectedSnapshot.map((item) => {
    publicationIdSchema.parse(item.variantId);
    const current = currentById.get(item.variantId);
    if (!current)
      throw new Error(
        "A selected draft item is no longer available. Close bulk editing and select the items again.",
      );
    return current;
  });
  if (
    bulkSelectionFingerprint(selectedCurrent) !==
    bulkSelectionFingerprint(selectedSnapshot)
  )
    throw new Error(
      "A selected draft changed while bulk editing was open. Close bulk editing and review the latest drafts.",
    );
  return selectedCurrent;
}

export function applyBulkEdit(
  currentItems: readonly ListingDraftItem[],
  selectedSnapshot: readonly ListingDraftItem[],
  patch: BulkEditPatch,
  options: { canEdit: boolean } = { canEdit: true },
): ListingDraftItem[] {
  const selectedCurrent = validateBulkSelection(
    currentItems,
    selectedSnapshot,
    options,
  );
  const result = prepareBulkEdit(selectedCurrent, patch);
  if (!result.preview.changedCount)
    throw new Error("Choose at least one change to apply.");
  const updated = new Map(result.next.map((item) => [item.variantId, item]));
  return currentItems.map((item) => updated.get(item.variantId) ?? item);
}

export function bulkFixedPriceCents(value: string): number {
  const cents = dollarsToCents(value);
  if (cents === null)
    throw new Error(
      "Enter a positive fixed price with at most two decimal places.",
    );
  return cents;
}

function leafChanges(change: BulkAttributeChange): BulkAttributeChange[] {
  if (
    change.action !== "set" ||
    !object(change.value) ||
    !Object.keys(change.value).length
  )
    return [change];
  return Object.entries(change.value).flatMap(([key, value]) =>
    leafChanges({ path: [...change.path, key], action: "set", value }),
  );
}

function assertNoRemovedAncestor(
  changes: readonly BulkAttributeChange[],
  path: readonly string[],
): void {
  const removed = changes.find(
    (change) =>
      change.action === "remove" &&
      change.path.length < path.length &&
      change.path.every((segment, index) => segment === path[index]),
  );
  // Dropping a parent removal to set/undo one leaf would restore unrelated
  // original siblings. Without the original item here, reject that ambiguity.
  if (removed)
    throw new Error(
      `Undo the pending clear of ${removed.path.join(" › ")} before editing a field inside that group.`,
    );
}

/** Undo only a pending field edit, retaining sibling edits in a changed object. */
export function omitBulkAttributeChange(
  changes: readonly BulkAttributeChange[],
  path: readonly string[],
): BulkAttributeChange[] {
  bulkEditPatchSchema.parse({
    attributeChanges: [{ path: [...path], action: "remove" }],
  });
  const validated = bulkEditPatchSchema.parse({ attributeChanges: changes });
  assertNoRemovedAncestor(validated.attributeChanges ?? [], path);
  return (validated.attributeChanges ?? [])
    .flatMap(leafChanges)
    .filter((change) => !pathsOverlap(change.path, path));
}

/** Preserve sibling edits when an object value is subsequently edited one leaf at a time. */
export function updateBulkAttribute(
  changes: readonly BulkAttributeChange[],
  path: readonly string[],
  value: unknown,
): BulkAttributeChange[] {
  // Validate before walking values so malformed/cyclic objects cannot enter recursion.
  const previous = bulkEditPatchSchema.parse({
    attributeChanges: changes,
  }).attributeChanges!;
  const next =
    value === undefined
      ? { path: [...path], action: "remove" as const }
      : { path: [...path], action: "set" as const, value };
  const validatedNext = bulkEditPatchSchema.parse({ attributeChanges: [next] })
    .attributeChanges![0];
  assertNoRemovedAncestor(previous, path);
  const result = [
    ...previous
      .flatMap(leafChanges)
      .filter((change) => !pathsOverlap(change.path, path)),
    ...leafChanges(validatedNext),
  ];
  return bulkEditPatchSchema.parse({ attributeChanges: result })
    .attributeChanges!;
}
