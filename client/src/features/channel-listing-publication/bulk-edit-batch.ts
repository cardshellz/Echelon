import { z } from "zod";
import {
  listingDraftItemSchema,
  publicationIdSchema,
  type ListingDraftItem,
} from "@shared/types/channel-listing-publication";
import { MAX_DRAFT_ITEMS } from "./model";
import { canonicalDraftValue } from "./draft-item-snapshot";
import {
  bulkEditPatchSchema,
  commonBulkContext,
  omitBulkAttributeChange,
  prepareBulkEdit,
  updateBulkAttribute,
  validateBulkSelection,
  type BulkEditPatch,
  type BulkEditPreview,
} from "./bulk-edit-model";
import { BULK_CONTENT_FIELDS, type BulkContentField } from "./bulk-field-state";

export type BulkItemPatch = BulkEditPatch & {
  identifier?: ListingDraftItem["identifier"];
};
export type BulkItemField = Exclude<keyof BulkItemPatch, "attributeChanges">;
export type BulkDefaultMode = "preserve-overrides" | "replace-all";
const ITEM_FIELDS = new Set<string>([
  ...BULK_CONTENT_FIELDS,
  "method",
  "productType",
  "identifier",
]);
const owns = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

/** Identifiers are editable only on one explicit row, never a shared default. */
export const bulkItemPatchSchema: z.ZodType<
  BulkItemPatch,
  z.ZodTypeDef,
  unknown
> = z.unknown().transform((input, context) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    context.addIssue({
      code: "custom",
      message: "An item change must contain named fields.",
    });
    return z.NEVER;
  }
  if (
    Object.getPrototypeOf(input) !== Object.prototype &&
    Object.getPrototypeOf(input) !== null
  ) {
    context.addIssue({
      code: "custom",
      message: "An item change must be a plain object.",
    });
    return z.NEVER;
  }
  const { identifier, ...fields } = input as Record<string, unknown>;
  const base = bulkEditPatchSchema.safeParse(fields);
  if (!base.success) {
    base.error.issues.forEach((issue) => context.addIssue(issue));
    return z.NEVER;
  }
  if (!owns(input, "identifier")) return base.data;
  const parsed =
    identifier === undefined
      ? null
      : listingDraftItemSchema.shape.identifier.safeParse(identifier);
  if (!parsed?.success) {
    context.addIssue({
      code: "custom",
      path: ["identifier"],
      message:
        "Provide one row's identifier or explicitly inherit its catalog identifier.",
    });
    return z.NEVER;
  }
  return { ...base.data, identifier: parsed.data };
});

export const bulkEditCommandSchema = z
  .object({
    shared: bulkEditPatchSchema,
    itemChanges: z
      .array(
        z
          .object({
            variantId: publicationIdSchema,
            patch: bulkItemPatchSchema,
          })
          .strict(),
      )
      .max(MAX_DRAFT_ITEMS),
  })
  .strict()
  .superRefine((command, context) => {
    if (
      new Set(command.itemChanges.map((change) => change.variantId)).size !==
      command.itemChanges.length
    )
      context.addIssue({
        code: "custom",
        path: ["itemChanges"],
        message: "Each draft item can have only one set of individual changes.",
      });
  });
export type BulkEditCommand = z.infer<typeof bulkEditCommandSchema>;
export interface BulkValueChange {
  path: string[];
  before: unknown;
  after: unknown;
}
export interface BulkBatchPreview extends Omit<BulkEditPreview, "items"> {
  items: Array<
    BulkEditPreview["items"][number] & { changes: BulkValueChange[] }
  >;
}
export interface BulkBatchResult {
  effectiveItems: ListingDraftItem[];
  preview: BulkBatchPreview;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Arrays remain one value; object leaves provide exact, readable before/after changes. */
function valueChanges(
  before: unknown,
  after: unknown,
  path: string[],
): BulkValueChange[] {
  if (canonicalDraftValue(before) === canonicalDraftValue(after)) return [];
  if (
    (object(before) || before === undefined) &&
    (object(after) || after === undefined)
  ) {
    const previous = object(before) ? before : {};
    const next = object(after) ? after : {};
    const keys = [
      ...new Set([...Object.keys(previous), ...Object.keys(next)]),
    ].sort();
    if (keys.length)
      return keys.flatMap((key) =>
        valueChanges(previous[key], next[key], [...path, key]),
      );
  }
  return [{ path, before, after }];
}

/** Resolve final context once, then apply shared values followed by row overrides. */
export function previewBulkEditBatch(
  items: readonly ListingDraftItem[],
  input: BulkEditCommand,
): BulkBatchResult {
  const command = bulkEditCommandSchema.parse(input);
  const selected = prepareBulkEdit(items, {}).next;
  const selectedIds = new Set(items.map((item) => item.variantId));
  for (const change of command.itemChanges) {
    if (!selectedIds.has(change.variantId))
      throw new Error(
        "An individual change refers to a draft outside this selection.",
      );
  }
  const patches = new Map(
    command.itemChanges.map((change) => [change.variantId, change.patch]),
  );
  const { attributeChanges: sharedAttributes = [], ...sharedFields } =
    command.shared;
  const preparedRows = selected.map((item) => {
    const patch = patches.get(item.variantId) ?? {};
    const {
      identifier: _identifier,
      attributeChanges: _attributes,
      ...rowFields
    } = patch;
    return prepareBulkEdit([item], { ...sharedFields, ...rowFields });
  });
  if (
    sharedAttributes.length &&
    !commonBulkContext(preparedRows.map((row) => row.next[0]))
  )
    throw new Error(
      "Choose a common listing method and product type before applying shared attributes.",
    );
  const previewItems: BulkBatchPreview["items"] = [];
  const effectiveItems = preparedRows.map((prepared, index) => {
    const before = items[index];
    const patch = patches.get(before.variantId) ?? {};
    const shared = sharedAttributes.length
      ? prepareBulkEdit(prepared.next, { attributeChanges: sharedAttributes })
          .next
      : prepared.next;
    const row = patch.attributeChanges?.length
      ? prepareBulkEdit(shared, { attributeChanges: patch.attributeChanges })
          .next[0]
      : shared[0];
    const next = owns(patch, "identifier")
      ? listingDraftItemSchema.parse({ ...row, identifier: patch.identifier })
      : row;
    const changes = valueChanges(before, next, []);
    previewItems.push({
      variantId: before.variantId,
      fields: changes.map((change) => change.path.join(".")),
      changes,
      attributesReset: prepared.preview.items[0].attributesReset,
    });
    return changes.length ? next : before;
  });
  return {
    effectiveItems,
    preview: {
      items: previewItems,
      changedCount: previewItems.filter((item) => item.changes.length > 0)
        .length,
      resetCount: previewItems.filter((item) => item.attributesReset).length,
    },
  };
}

/** Validate the complete selection and every row before committing one local draft update. */
export function applyBulkEditBatch(
  currentItems: readonly ListingDraftItem[],
  selectedSnapshot: readonly ListingDraftItem[],
  command: BulkEditCommand,
  options: { canEdit: boolean } = { canEdit: true },
): ListingDraftItem[] {
  const selectedCurrent = validateBulkSelection(
    currentItems,
    selectedSnapshot,
    options,
  );
  const planned = previewBulkEditBatch(selectedCurrent, command);
  if (!planned.preview.changedCount)
    throw new Error("Change at least one field before applying.");
  const updated = new Map(
    planned.effectiveItems.map((item) => [item.variantId, item]),
  );
  return currentItems.map((item) => updated.get(item.variantId) ?? item);
}

function withAttributeChanges<T extends BulkItemPatch>(
  patch: T,
  changes: NonNullable<BulkEditPatch["attributeChanges"]>,
): T {
  const { attributeChanges: _previous, ...fields } = patch;
  return (
    changes.length ? { ...fields, attributeChanges: changes } : fields
  ) as T;
}

/** An explicit Apply to all replaces older row overrides for this field, preserving other fields. */
export function setBulkSharedAttribute(
  input: BulkEditCommand,
  path: readonly string[],
  value: unknown,
  mode: BulkDefaultMode = "replace-all",
): BulkEditCommand {
  z.enum(["preserve-overrides", "replace-all"]).parse(mode);
  const command = bulkEditCommandSchema.parse(input);
  return bulkEditCommandSchema.parse({
    shared: {
      ...command.shared,
      attributeChanges: updateBulkAttribute(
        command.shared.attributeChanges ?? [],
        path,
        value,
      ),
    },
    itemChanges:
      mode === "preserve-overrides"
        ? command.itemChanges
        : command.itemChanges
            .map((change) => ({
              ...change,
              patch: withAttributeChanges(
                change.patch,
                omitBulkAttributeChange(
                  change.patch.attributeChanges ?? [],
                  path,
                ),
              ),
            }))
            .filter((change) => Object.keys(change.patch).length > 0),
  });
}

function assertItemField(field: string): asserts field is BulkItemField {
  if (!ITEM_FIELDS.has(field))
    throw new Error("This field cannot be changed through item editing.");
}

export function setBulkItemField(
  input: BulkEditCommand,
  variantId: number,
  field: BulkItemField,
  value: unknown,
): BulkEditCommand {
  const command = bulkEditCommandSchema.parse(input);
  publicationIdSchema.parse(variantId);
  assertItemField(field);
  const previous =
    command.itemChanges.find((change) => change.variantId === variantId)
      ?.patch ?? {};
  const parsed = bulkItemPatchSchema.parse({ ...previous, [field]: value });
  // Clear schema-bound edits only when the pending context actually changes.
  // Compare normalized values so repeating a selection cannot discard edits.
  if (
    (field === "method" || field === "productType") &&
    (!owns(previous, field) || previous[field] !== parsed[field])
  )
    delete parsed.attributeChanges;
  return bulkEditCommandSchema.parse({
    ...command,
    itemChanges: [
      ...command.itemChanges.filter((change) => change.variantId !== variantId),
      { variantId, patch: parsed },
    ],
  });
}

export function undoBulkItemField(
  input: BulkEditCommand,
  variantId: number,
  field: BulkItemField,
): BulkEditCommand {
  const command = bulkEditCommandSchema.parse(input);
  publicationIdSchema.parse(variantId);
  assertItemField(field);
  return bulkEditCommandSchema.parse({
    ...command,
    itemChanges: command.itemChanges
      .map((change) => {
        if (change.variantId !== variantId || !owns(change.patch, field))
          return change;
        const patch = { ...change.patch };
        delete patch[field];
        if (field === "method" || field === "productType")
          delete patch.attributeChanges;
        return { ...change, patch };
      })
      .filter((change) => Object.keys(change.patch).length > 0),
  });
}

/** A column default preserves deliberate row overrides unless replacing all is explicit. */
export function setBulkSharedField(
  input: BulkEditCommand,
  field: BulkContentField,
  value: unknown,
  mode: BulkDefaultMode = "preserve-overrides",
): BulkEditCommand {
  const command = bulkEditCommandSchema.parse(input);
  if (!(BULK_CONTENT_FIELDS as readonly string[]).includes(field))
    throw new Error(
      "Identifiers and item identity cannot be copied as a column default.",
    );
  z.enum(["preserve-overrides", "replace-all"]).parse(mode);
  const shared = bulkEditPatchSchema.parse({
    ...command.shared,
    [field]: value,
  });
  return bulkEditCommandSchema.parse({
    shared,
    itemChanges:
      mode === "preserve-overrides"
        ? command.itemChanges
        : command.itemChanges
            .map((change) => {
              const patch = { ...change.patch };
              delete patch[field];
              return { ...change, patch };
            })
            .filter((change) => Object.keys(change.patch).length > 0),
  });
}

export function setBulkItemAttribute(
  input: BulkEditCommand,
  variantId: number,
  path: readonly string[],
  value: unknown,
): BulkEditCommand {
  const command = bulkEditCommandSchema.parse(input);
  publicationIdSchema.parse(variantId);
  const previous =
    command.itemChanges.find((change) => change.variantId === variantId)
      ?.patch ?? {};
  const patch = {
    ...previous,
    attributeChanges: updateBulkAttribute(
      previous.attributeChanges ?? [],
      path,
      value,
    ),
  };
  return bulkEditCommandSchema.parse({
    ...command,
    itemChanges: [
      ...command.itemChanges.filter((change) => change.variantId !== variantId),
      { variantId, patch },
    ],
  });
}

export function undoBulkItemAttribute(
  input: BulkEditCommand,
  variantId: number,
  path: readonly string[],
): BulkEditCommand {
  const command = bulkEditCommandSchema.parse(input);
  publicationIdSchema.parse(variantId);
  // Validate the path even when this row does not yet have an override.
  omitBulkAttributeChange([], path);
  return bulkEditCommandSchema.parse({
    ...command,
    itemChanges: command.itemChanges
      .map((change) =>
        change.variantId !== variantId
          ? change
          : {
              ...change,
              patch: withAttributeChanges(
                change.patch,
                omitBulkAttributeChange(
                  change.patch.attributeChanges ?? [],
                  path,
                ),
              ),
            },
      )
      .filter((change) => Object.keys(change.patch).length > 0),
  });
}

export function undoBulkSharedAttribute(
  input: BulkEditCommand,
  path: readonly string[],
): BulkEditCommand {
  const command = bulkEditCommandSchema.parse(input);
  return {
    ...command,
    shared: withAttributeChanges(
      command.shared,
      omitBulkAttributeChange(command.shared.attributeChanges ?? [], path),
    ),
  };
}

/** Schema changes invalidate pending attribute edits, but never unrelated content/price edits. */
export function resetBulkAttributeEdits(
  input: BulkEditCommand,
): BulkEditCommand {
  const command = bulkEditCommandSchema.parse(input);
  return {
    shared: withAttributeChanges(command.shared, []),
    itemChanges: command.itemChanges
      .map((change) => ({
        ...change,
        patch: withAttributeChanges(change.patch, []),
      }))
      .filter((change) => Object.keys(change.patch).length > 0),
  };
}
