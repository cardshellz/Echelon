import { z } from "zod";
import {
  publicationIdSchema,
  type ListingDraftItem,
} from "@shared/types/channel-listing-publication";
import { MAX_DRAFT_ITEMS } from "./model";
import { canonicalDraftValue } from "./draft-item-snapshot";
import {
  bulkEditPatchSchema,
  omitBulkAttributeChange,
  prepareBulkEdit,
  updateBulkAttribute,
  validateBulkSelection,
  type BulkEditPatch,
  type BulkEditPreview,
} from "./bulk-edit-model";

export const bulkEditCommandSchema = z
  .object({
    shared: bulkEditPatchSchema,
    itemChanges: z
      .array(
        z
          .object({
            variantId: publicationIdSchema,
            patch: bulkEditPatchSchema,
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

/** Apply shared values first and individual edits second, without mutating or saving the source. */
export function previewBulkEditBatch(
  items: readonly ListingDraftItem[],
  input: BulkEditCommand,
): BulkBatchResult {
  const command = bulkEditCommandSchema.parse(input);
  const shared = prepareBulkEdit(items, command.shared);
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
  const previewItems: BulkBatchPreview["items"] = [];
  const effectiveItems = shared.next.map((item, index) => {
    const planned = prepareBulkEdit([item], patches.get(item.variantId) ?? {});
    const next = planned.next[0];
    const before = items[index];
    const changes = valueChanges(before, next, []);
    previewItems.push({
      variantId: item.variantId,
      fields: changes.map((change) => change.path.join(".")),
      changes,
      attributesReset:
        shared.preview.items[index].attributesReset ||
        planned.preview.items[0].attributesReset,
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

function withAttributeChanges(
  patch: BulkEditPatch,
  changes: NonNullable<BulkEditPatch["attributeChanges"]>,
): BulkEditPatch {
  const { attributeChanges: _previous, ...fields } = patch;
  return changes.length ? { ...fields, attributeChanges: changes } : fields;
}

/** An explicit Apply to all replaces older row overrides for this field, preserving other fields. */
export function setBulkSharedAttribute(
  input: BulkEditCommand,
  path: readonly string[],
  value: unknown,
): BulkEditCommand {
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
    itemChanges: command.itemChanges
      .map((change) => ({
        ...change,
        patch: withAttributeChanges(
          change.patch,
          omitBulkAttributeChange(change.patch.attributeChanges ?? [], path),
        ),
      }))
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
