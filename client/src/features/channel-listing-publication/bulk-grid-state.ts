import type { ListingDraftItem } from "@shared/types/channel-listing-publication";
import { canonicalDraftValue } from "./draft-item-snapshot";
import { fieldValueAtPath } from "./schema-field-model";
import {
  buildBulkFieldPatch,
  parseBulkItemIdentifier,
  type BulkContentField,
} from "./bulk-field-state";

export type BulkGridField = BulkContentField | "identifier";
export interface BulkGridBuffer {
  raw: string;
  error: string | null;
  identifierType?: NonNullable<ListingDraftItem["identifier"]>["type"];
  controlSignature?: string;
  staleControl?: boolean;
}
export interface BulkGridColumn {
  key: BulkGridField;
  label: string;
  group: string;
  width: number;
  long?: boolean;
}
export const BULK_GRID_CORE_COLUMNS: readonly BulkGridColumn[] = [
  { key: "title", label: "Title", group: "Listing content", width: 240 },
  { key: "brand", label: "Brand", group: "Listing content", width: 170 },
  {
    key: "description",
    label: "Description",
    group: "Listing content",
    width: 200,
    long: true,
  },
  {
    key: "images",
    label: "Images",
    group: "Listing content",
    width: 170,
    long: true,
  },
  {
    key: "identifier",
    label: "Product identifier",
    group: "Identity",
    width: 230,
  },
  {
    key: "priceOverrideCents",
    label: "Price (USD)",
    group: "Pricing",
    width: 150,
  },
];

export function bulkGridBufferKey(
  variantId: number | "shared",
  field: string,
): string {
  return `${variantId}:${field}`;
}

/** Parsing occurs only after a deliberate edit; display inheritance stays read-only. */
export function parseBulkGridField(
  field: BulkGridField,
  raw: string,
  identifierType: NonNullable<ListingDraftItem["identifier"]>["type"] = "GTIN",
): unknown {
  return field === "identifier"
    ? parseBulkItemIdentifier(identifierType, raw)
    : buildBulkFieldPatch({ [field]: raw })[field];
}

export function bulkGridValueSummary(value: unknown): string {
  if (value === undefined || value === null || value === "") return "Not set";
  if (Array.isArray(value))
    return `${value.length} ${value.length === 1 ? "value" : "values"}`;
  if (typeof value === "object") return `${Object.keys(value).length} fields`;
  return String(value);
}

export function discardBulkGridBuffers(
  buffers: ReadonlyMap<string, BulkGridBuffer>,
  predicate: (key: string, value: BulkGridBuffer) => boolean,
): ReadonlyMap<string, BulkGridBuffer> {
  const next = new Map(buffers);
  for (const [key, value] of next) if (predicate(key, value)) next.delete(key);
  return next;
}

export function bulkGridAttributePath(
  key: string,
  variantId: number,
): string[] | null {
  const prefix = `${variantId}:attribute:`;
  if (!key.startsWith(prefix)) return null;
  try {
    const value: unknown = JSON.parse(key.slice(prefix.length));
    return Array.isArray(value) &&
      value.every((part) => typeof part === "string")
      ? value
      : null;
  } catch {
    return null;
  }
}

export function bulkGridPathsOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.every((part, index) => right[index] === part) ||
    right.every((part, index) => left[index] === part)
  );
}

/** Choice indexes cannot be reused when a conditional field changes its options. */
export function reconcileBulkGridControls(
  buffers: ReadonlyMap<string, BulkGridBuffer>,
  controls: ReadonlyMap<string, string>,
): ReadonlyMap<string, BulkGridBuffer> {
  const next = new Map(buffers);
  let changed = false;
  for (const [key, value] of buffers) {
    if (!value.controlSignature) continue;
    const signature = controls.get(key.slice(key.indexOf(":") + 1));
    // Hidden conditional fields retain their edit until shown or explicitly discarded.
    if (signature === undefined || signature === value.controlSignature)
      continue;
    if (key.startsWith("shared:") || value.error) {
      const error = "Field options changed. Re-enter or discard this value.";
      if (value.error !== error || !value.staleControl) {
        next.set(key, { ...value, error, staleControl: true });
        changed = true;
      }
    } else {
      next.delete(key);
      changed = true;
    }
  }
  return changed ? next : buffers;
}

const samePath = (
  left: readonly string[],
  right: readonly string[] | undefined,
) =>
  right !== undefined &&
  left.length === right.length &&
  left.every((part, index) => part === right[index]);

/** Arrays write atomically, but the originating leaf still owns its raw buffer. */
export function bulkGridAttributeWriteConflicts(
  buffers: ReadonlyMap<string, BulkGridBuffer>,
  variantId: number,
  path: readonly string[],
  value: unknown,
  attributes: unknown,
  editedPath?: readonly string[],
): boolean {
  return [...buffers].some(([key, pending]) => {
    const otherPath = bulkGridAttributePath(key, variantId);
    if (
      !pending.error ||
      !otherPath ||
      samePath(otherPath, path) ||
      samePath(otherPath, editedPath) ||
      !bulkGridPathsOverlap(path, otherPath)
    )
      return false;
    if (path.length < otherPath.length) {
      const before = fieldValueAtPath(attributes, path);
      const unchangedLength =
        !Array.isArray(before) ||
        (Array.isArray(value) && before.length === value.length);
      if (
        unchangedLength &&
        value !== undefined &&
        canonicalDraftValue(
          fieldValueAtPath(before, otherPath.slice(path.length)),
        ) ===
          canonicalDraftValue(
            fieldValueAtPath(value, otherPath.slice(path.length)),
          )
      )
        return false;
    }
    return true;
  });
}

export function acknowledgeBulkGridAttributeWrite(
  buffers: ReadonlyMap<string, BulkGridBuffer>,
  variantId: number,
  path: readonly string[],
  editedPath?: readonly string[],
): ReadonlyMap<string, BulkGridBuffer> {
  return discardBulkGridBuffers(buffers, (key, pending) => {
    const otherPath = bulkGridAttributePath(key, variantId);
    return (
      otherPath !== null &&
      bulkGridPathsOverlap(path, otherPath) &&
      (!pending.error ||
        samePath(otherPath, path) ||
        samePath(otherPath, editedPath))
    );
  });
}
