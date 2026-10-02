import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ListingCatalogItem,
  ListingDraftItem,
} from "@shared/types/channel-listing-publication";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fieldValueAtPath, type FieldSchema } from "./schema-field-model";
import {
  buildBulkAttributeColumns,
  parseBulkAttributeCellInput,
  type BulkAttributeColumn,
} from "./bulk-attribute-columns";
import {
  ListingBulkAttributeCell,
  displayBulkAttributeValue,
} from "./ListingBulkAttributeCell";
import { ListingBulkContentCell } from "./ListingBulkContentCell";
import { ListingBulkItemInspector } from "./ListingBulkItemInspector";
import {
  buildBulkFieldPatch,
  projectBulkField,
  type BulkContentField,
} from "./bulk-field-state";
import {
  BULK_GRID_CORE_COLUMNS,
  bulkGridBufferKey,
  bulkGridAttributeWriteConflicts,
  acknowledgeBulkGridAttributeWrite,
  bulkGridPathsOverlap,
  bulkGridValueSummary,
  discardBulkGridBuffers,
  reconcileBulkGridControls,
  type BulkGridBuffer,
  type BulkGridColumn,
  type BulkGridField,
} from "./bulk-grid-state";
import type { BulkEditPatch } from "./bulk-edit-model";
import type { BulkItemPatch } from "./bulk-edit-batch";
import { canonicalDraftValue } from "./draft-item-snapshot";
import { errorMessage } from "./model";

interface Props {
  items: readonly ListingDraftItem[];
  originalItems?: readonly ListingDraftItem[];
  metadata: ReadonlyMap<number, ListingCatalogItem>;
  schema?: FieldSchema;
  sharedPatch?: BulkEditPatch;
  itemChanges: readonly { variantId: number; patch: BulkItemPatch }[];
  canEdit: boolean;
  providerFieldsDisabled?: boolean;
  attributeResetRevision?: number;
  onItemAttribute(id: number, path: readonly string[], value: unknown): boolean;
  onSharedAttribute(
    path: readonly string[],
    value: unknown,
    replaceOverrides?: boolean,
  ): boolean;
  onUndoItemAttribute(id: number, path: readonly string[]): boolean;
  onUndoItem(id: number): boolean;
  onItemField(id: number, field: BulkGridField, value: unknown): boolean;
  onUndoItemField(id: number, field: BulkGridField): boolean;
  onSharedField(
    field: BulkContentField,
    value: string | null,
    replaceOverrides: boolean,
  ): boolean;
  onValidityChange(error: string | null): void;
}
type Column =
  | { kind: "core"; key: string; field: BulkGridColumn }
  | { kind: "attribute"; key: string; field: BulkAttributeColumn };
type Inspector = { variantId: number; field: Column | null };
const EMPTY_SCHEMA: FieldSchema = Object.freeze({
  type: "object",
  properties: {},
});
const has = (value: object | undefined, key: string) =>
  value !== undefined && Object.prototype.hasOwnProperty.call(value, key);
const overlaps = bulkGridPathsOverlap;
const controlSignature = (column: BulkAttributeColumn) =>
  canonicalDraftValue([column.type, column.schema.enum]);

export function ListingBulkItemTable({
  items,
  originalItems = items,
  metadata,
  schema,
  sharedPatch = {},
  itemChanges,
  canEdit,
  providerFieldsDisabled = false,
  attributeResetRevision = 0,
  onItemAttribute,
  onSharedAttribute,
  onUndoItemAttribute,
  onUndoItem,
  onItemField,
  onUndoItemField,
  onSharedField,
  onValidityChange,
}: Props) {
  const model = useMemo(
    () =>
      buildBulkAttributeColumns(
        schema ?? EMPTY_SCHEMA,
        items.map((item) => item.attributes),
      ),
    [schema, items],
  );
  const [buffers, setBuffers] = useState<ReadonlyMap<string, BulkGridBuffer>>(
    new Map(),
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [group, setGroup] = useState("all");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [inspector, setInspector] = useState<Inspector | null>(null);
  const [showDefaults, setShowDefaults] = useState(true);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const cells = useRef(new Map<string, HTMLTableCellElement>());
  const revision = useRef(attributeResetRevision);
  const itemById = useMemo(
    () => new Map(items.map((item) => [item.variantId, item])),
    [items],
  );
  const originalById = useMemo(
    () => new Map(originalItems.map((item) => [item.variantId, item])),
    [originalItems],
  );
  const changesById = useMemo(
    () =>
      new Map(itemChanges.map((change) => [change.variantId, change.patch])),
    [itemChanges],
  );
  const allColumns = useMemo<Column[]>(
    () => [
      ...BULK_GRID_CORE_COLUMNS.map((field) => ({
        kind: "core" as const,
        key: "core:" + field.key,
        field,
      })),
      ...model.columns.map((field) => ({
        kind: "attribute" as const,
        key: "attribute:" + field.key,
        field,
      })),
    ],
    [model.columns],
  );
  const groups = [
    ...new Set(
      allColumns.map((column) => column.field.group || "Product attributes"),
    ),
  ];
  const controls = useMemo(
    () =>
      new Map(
        model.columns.map((column) => [
          "attribute:" + column.key,
          controlSignature(column),
        ]),
      ),
    [model.columns],
  );
  function changed(column: Column) {
    if ([...buffers.keys()].some((key) => key.endsWith(":" + column.key)))
      return true;
    return items.some((item) => {
      const original = originalById.get(item.variantId);
      if (!original) return true;
      return column.kind === "core"
        ? canonicalDraftValue(item[column.field.key]) !==
            canonicalDraftValue(original[column.field.key])
        : canonicalDraftValue(
            fieldValueAtPath(item.attributes, column.field.path),
          ) !==
            canonicalDraftValue(
              fieldValueAtPath(original.attributes, column.field.path),
            );
    });
  }
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const columns = allColumns.filter(
    (column) =>
      (group === "all" ||
        (column.field.group || "Product attributes") === group) &&
      words.every((word) =>
        `${column.field.group} ${column.kind === "attribute" ? column.field.pathLabel : column.field.label}`
          .toLowerCase()
          .includes(word),
      ) &&
      (filter !== "required" ||
        column.kind === "core" ||
        column.field.required) &&
      (filter !== "changed" || changed(column)),
  );
  const headerGroups: Array<{ label: string; count: number }> = [];
  for (const column of columns) {
    const label = column.field.group || "Product attributes";
    const last = headerGroups[headerGroups.length - 1];
    if (last?.label === label) last.count++;
    else headerGroups.push({ label, count: 1 });
  }
  const errors = [...buffers].filter(([, value]) => value.error !== null);
  const pending = [...buffers].filter(([key]) => key.startsWith("shared:"));
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(items.length / pageSize) - 1),
  );
  const offset = currentPage * pageSize;
  const rows = items.slice(offset, offset + pageSize);
  const detailItem = inspector ? itemById.get(inspector.variantId) : undefined;
  const skuFor = (item: ListingDraftItem) =>
    metadata.get(item.variantId)?.sku ?? `Variant ${item.variantId}`;
  useEffect(() => {
    onValidityChange(
      errors.length
        ? "Correct or discard invalid cell values before saving."
        : pending.length
          ? "Apply or discard pending column defaults before saving."
          : null,
    );
  }, [errors.length, pending.length, onValidityChange]);
  useEffect(() => {
    if (revision.current === attributeResetRevision) return;
    revision.current = attributeResetRevision;
    setBuffers((previous) =>
      discardBulkGridBuffers(previous, (key) => key.includes(":attribute:")),
    );
    setInspector((previous) =>
      previous?.field?.kind === "core" ? previous : null,
    );
  }, [attributeResetRevision]);
  useEffect(() => {
    if (!focusKey) return;
    const cell = cells.current.get(focusKey);
    if (!cell) return;
    cell.scrollIntoView({ block: "nearest", inline: "nearest" });
    cell.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    setFocusKey(null);
  }, [focusKey, columns, currentPage]);
  useEffect(() => {
    setBuffers((previous) => reconcileBulkGridControls(previous, controls));
  }, [controls]);
  function buffer(key: string, value: BulkGridBuffer) {
    setBuffers((previous) => new Map(previous).set(key, value));
  }
  function discard(key: string) {
    setBuffers((previous) =>
      discardBulkGridBuffers(previous, (candidate) => candidate === key),
    );
  }
  function applyItemAttribute(
    id: number,
    path: readonly string[],
    value: unknown,
    editedPath?: readonly string[],
  ): boolean {
    if (!canEdit || providerFieldsDisabled) return false;
    const key = bulkGridBufferKey(id, "attribute:" + JSON.stringify(path));
    const conflicting = bulkGridAttributeWriteConflicts(
      buffers,
      id,
      path,
      value,
      itemById.get(id)?.attributes,
      editedPath,
    );
    let accepted = false;
    let error = conflicting
      ? "Discard the invalid value inside this field before replacing the group."
      : "This change could not be applied. Correct or discard it before saving.";
    try {
      accepted = !conflicting && onItemAttribute(id, path, value);
    } catch (cause) {
      error = errorMessage(cause);
    }
    if (!accepted) {
      const column = model.columns.find(
        (column) => JSON.stringify(column.path) === JSON.stringify(path),
      );
      buffer(key, {
        raw:
          column?.kind === "scalar"
            ? displayBulkAttributeValue(column, value)
            : value === undefined
              ? ""
              : JSON.stringify(value, null, 2),
        error,
        ...(column?.kind === "scalar"
          ? { controlSignature: controlSignature(column) }
          : {}),
      });
      return false;
    }
    setBuffers((previous) =>
      acknowledgeBulkGridAttributeWrite(previous, id, path, editedPath),
    );
    return true;
  }
  function rowOverride(item: ListingDraftItem, column: Column) {
    const patch = changesById.get(item.variantId);
    return column.kind === "core"
      ? has(patch, column.field.key)
      : Boolean(
          patch?.attributeChanges?.some((change) =>
            overlaps(change.path, column.field.path),
          ),
        );
  }
  function sharedValue(column: Column) {
    return column.kind === "core"
      ? has(sharedPatch, column.field.key)
      : Boolean(
          sharedPatch.attributeChanges?.some((change) =>
            overlaps(change.path, column.field.path),
          ),
        );
  }
  function jump(key: string) {
    setQuery("");
    setGroup("all");
    setFilter("all");
    setShowDefaults(true);
    const index = items.findIndex(
      (item) => item.variantId === Number(key.split(":", 1)[0]),
    );
    if (index >= 0) setPage(Math.floor(index / pageSize));
    if (!allColumns.some((column) => key.endsWith(":" + column.key))) {
      if (index >= 0)
        setInspector({ variantId: items[index].variantId, field: null });
      setFocusKey(null);
      return;
    }
    setFocusKey(key);
  }
  function undoCell(item: ListingDraftItem, column: Column) {
    if (!canEdit) return;
    const accepted =
      column.kind === "core"
        ? onUndoItemField(item.variantId, column.field.key)
        : onUndoItemAttribute(item.variantId, column.field.path);
    if (accepted) discard(bulkGridBufferKey(item.variantId, column.key));
  }
  function applyDefault(column: Column, replaceOverrides: boolean) {
    const key = bulkGridBufferKey("shared", column.key);
    const candidate = buffers.get(key);
    if (
      !canEdit ||
      (column.kind === "attribute" && providerFieldsDisabled) ||
      !candidate ||
      candidate.error
    )
      return;
    // An explicit replacement must not silently drop unfinished invalid input.
    if (
      replaceOverrides &&
      [...buffers].some(
        ([rowKey, value]) =>
          rowKey !== key && rowKey.endsWith(":" + column.key) && value.error,
      )
    ) {
      buffer(key, {
        ...candidate,
        error:
          "Discard invalid row values in this column before replacing row edits.",
      });
      return;
    }
    try {
      let accepted = false;
      if (column.kind === "core" && column.field.key !== "identifier")
        accepted = onSharedField(
          column.field.key,
          candidate.raw,
          replaceOverrides,
        );
      else if (column.kind === "attribute" && column.field.appliesToAll) {
        const parsed = parseBulkAttributeCellInput(column.field, candidate.raw);
        if (parsed.error) throw new Error(parsed.error);
        accepted = onSharedAttribute(
          column.field.path,
          parsed.value,
          replaceOverrides,
        );
      }
      if (!accepted)
        throw new Error("This column default could not be applied.");
      setBuffers((previous) =>
        discardBulkGridBuffers(previous, (rowKey, value) => {
          if (rowKey === key) return true;
          if (!rowKey.endsWith(":" + column.key) || value.error) return false;
          const item = itemById.get(Number(rowKey.split(":", 1)[0]));
          return (
            replaceOverrides ||
            (item !== undefined && !rowOverride(item, column))
          );
        }),
      );
    } catch (cause) {
      buffer(key, { ...candidate, error: errorMessage(cause) });
    }
  }
  function renderDefault(column: Column) {
    const key = bulkGridBufferKey("shared", column.key);
    const candidate = buffers.get(key);
    if (column.kind === "core" && column.field.key === "identifier")
      return (
        <p className="text-[10px] text-muted-foreground">Unique to each item</p>
      );
    if (
      column.kind === "attribute" &&
      (column.field.kind === "complex" || !column.field.appliesToAll)
    )
      return (
        <p className="text-[10px] text-muted-foreground">Edit in each item</p>
      );
    let control: React.ReactNode;
    if (column.kind === "attribute") {
      const first = items[0]
        ? fieldValueAtPath(items[0].attributes, column.field.path)
        : undefined;
      const common = items.every(
        (item) =>
          canonicalDraftValue(
            fieldValueAtPath(item.attributes, column.field.path),
          ) === canonicalDraftValue(first),
      )
        ? first
        : undefined;
      control = (
        <ListingBulkAttributeCell
          column={column.field}
          value={common}
          sku="all selected items"
          disabled={!canEdit || providerFieldsDisabled}
          buffer={candidate}
          onBufferChange={(value) =>
            buffer(key, {
              ...value,
              controlSignature: controlSignature(column.field),
            })
          }
          onChange={() => true}
        />
      );
    } else {
      const field = column.field.key as BulkContentField;
      const common = projectBulkField(items, metadata, field);
      const props = {
        "aria-label": `${column.field.label} for all selected items`,
        disabled: !canEdit,
        value: candidate?.raw ?? common.value,
        placeholder:
          common.status === "mixed"
            ? "Mixed values"
            : common.status === "unavailable"
              ? "Catalog unavailable"
              : "Not set",
        onChange: (
          event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
        ) => {
          let error: string | null = null;
          try {
            buildBulkFieldPatch({ [field]: event.target.value });
          } catch (cause) {
            error = errorMessage(cause);
          }
          buffer(key, { raw: event.target.value, error });
        },
      };
      control = column.field.long ? (
        <Textarea
          {...props}
          rows={1}
          className="h-8 min-h-8 resize-y px-2 py-1 text-xs"
        />
      ) : (
        <Input
          {...props}
          className="h-8 px-2 text-xs"
          inputMode={field === "priceOverrideCents" ? "decimal" : undefined}
        />
      );
    }
    return (
      <div className="space-y-1">
        {control}
        {candidate && (
          <div className="flex flex-wrap gap-x-2 gap-y-1 text-[10px]">
            <button
              type="button"
              className="text-primary underline disabled:opacity-50"
              title="Keep individual row edits"
              aria-label={`Apply ${column.field.label} to all`}
              disabled={
                !canEdit ||
                (column.kind === "attribute" && providerFieldsDisabled) ||
                Boolean(candidate.error)
              }
              onClick={() => applyDefault(column, false)}
            >
              Apply default
            </button>
            <button
              type="button"
              className="text-primary underline disabled:opacity-50"
              aria-label={`Replace ${column.field.label} row edits`}
              disabled={
                !canEdit ||
                (column.kind === "attribute" && providerFieldsDisabled) ||
                Boolean(candidate.error)
              }
              onClick={() => applyDefault(column, true)}
            >
              Replace row edits
            </button>
            <button
              type="button"
              className="underline"
              aria-label={`Discard ${column.kind === "attribute" ? column.field.pathLabel : column.field.label} column value`}
              onClick={() => discard(key)}
            >
              Discard
            </button>
          </div>
        )}
        {column.kind === "core" && candidate?.error && (
          <p role="alert" className="text-xs text-destructive">
            {candidate.error}
          </p>
        )}
      </div>
    );
  }
  function renderCell(
    item: ListingDraftItem,
    column: Column,
    rowIndex: number,
  ) {
    const key = bulkGridBufferKey(item.variantId, column.key);
    const cellBuffer = buffers.get(key);
    const override = rowOverride(item, column);
    const applicable =
      column.kind === "core" ||
      model.applicableKeysByRow[rowIndex]?.includes(column.field.key);
    return (
      <td
        key={column.key}
        ref={(element) => {
          if (element) cells.current.set(key, element);
          else cells.current.delete(key);
        }}
        className="border-r border-b px-2 py-2 align-top"
        style={{ minWidth: width(column), width: width(column) }}
      >
        {!applicable ? (
          <span className="text-xs text-muted-foreground">
            Not used for this item
          </span>
        ) : column.kind === "core" ? (
          <ListingBulkContentCell
            item={item}
            metadata={metadata}
            field={column.field.key}
            label={column.field.label}
            sku={skuFor(item)}
            buffer={cellBuffer}
            disabled={!canEdit}
            onBufferChange={(value) => buffer(key, value)}
            onDiscardBuffer={() => discard(key)}
            onChange={(value) =>
              onItemField(item.variantId, column.field.key, value)
            }
            onExpand={() =>
              setInspector({ variantId: item.variantId, field: column })
            }
          />
        ) : column.field.kind === "complex" ? (
          <button
            type="button"
            className="h-8 w-full truncate rounded-md border px-2 text-left text-xs hover:bg-muted"
            aria-label={`Edit ${column.field.pathLabel} for ${skuFor(item)}`}
            onClick={() =>
              setInspector({ variantId: item.variantId, field: column })
            }
          >
            {bulkGridValueSummary(
              fieldValueAtPath(item.attributes, column.field.path),
            )}{" "}
            · Edit
          </button>
        ) : (
          <ListingBulkAttributeCell
            column={column.field}
            value={fieldValueAtPath(item.attributes, column.field.path)}
            sku={skuFor(item)}
            buffer={cellBuffer}
            disabled={!canEdit || providerFieldsDisabled}
            required={model.requiredKeysByRow[rowIndex]?.includes(
              column.field.key,
            )}
            onBufferChange={(value) =>
              buffer(key, {
                ...value,
                controlSignature: controlSignature(column.field),
              })
            }
            onChange={(value) =>
              applyItemAttribute(item.variantId, column.field.path, value)
            }
          />
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[10px] leading-3">
          {override ? (
            <>
              <span className="text-primary">Row edit</span>
              <button
                type="button"
                className="underline disabled:opacity-50"
                aria-label={`Undo ${column.field.label} change for ${skuFor(item)}`}
                disabled={!canEdit}
                onClick={() => undoCell(item, column)}
              >
                Undo
              </button>
            </>
          ) : sharedValue(column) ? (
            <span className="text-muted-foreground">Column default</span>
          ) : null}
          {cellBuffer?.error && (
            <button
              type="button"
              className="text-destructive underline"
              aria-label={`Discard invalid ${column.field.label} value for ${skuFor(item)}`}
              onClick={() => discard(key)}
            >
              Discard invalid value
            </button>
          )}
          {column.kind === "core" &&
            (item[column.field.key] !== null || cellBuffer) && (
              <button
                type="button"
                disabled={!canEdit}
                className="text-muted-foreground underline disabled:opacity-50"
                aria-label={`Use ${column.field.key === "priceOverrideCents" ? "pricing rules" : "catalog"} for ${column.field.label.toLowerCase()} for ${skuFor(item)}`}
                onClick={() => {
                  if (onItemField(item.variantId, column.field.key, null))
                    discard(key);
                }}
              >
                {column.field.key === "priceOverrideCents"
                  ? "Use rules"
                  : "Use catalog"}
              </button>
            )}
        </div>
      </td>
    );
  }
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
      aria-label="Per-item listing attributes"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div
          className="flex rounded-md border p-0.5"
          aria-label="Field filters"
        >
          {[
            ["all", "All fields"],
            ["required", "Required"],
            ["changed", "Changed"],
          ].map(([value, label]) => (
            <Button
              key={value}
              type="button"
              size="sm"
              className="h-7 px-2 text-xs"
              variant={filter === value ? "secondary" : "ghost"}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </Button>
          ))}
        </div>
        <select
          aria-label="Field group"
          value={group}
          onChange={(event) => setGroup(event.target.value)}
          className="h-8 max-w-60 rounded-md border bg-background px-2 text-xs"
        >
          <option value="all">All groups</option>
          {groups.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <Input
          aria-label="Search attribute columns"
          placeholder="Find a field"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-8 w-48 text-xs"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          aria-pressed={showDefaults}
          onClick={() => setShowDefaults(!showDefaults)}
        >
          Column defaults
        </Button>
        <p className="ml-auto text-xs text-muted-foreground">
          {columns.length} of {allColumns.length} fields · {items.length} items
        </p>
      </div>
      {showDefaults && (
        <p className="shrink-0 text-xs text-muted-foreground">
          Set a value for all selected items; keep row edits made here, or
          replace those too.
        </p>
      )}
      {(errors.length > 0 || pending.length > 0) && (
        <div className="shrink-0 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs dark:bg-amber-950/20">
          <p role="alert">
            {errors.length > 0
              ? `${errors.length} invalid values. Correct or discard before saving.`
              : `${pending.length} column defaults need Apply or Discard before saving.`}{" "}
            You can continue editing other fields.
          </p>
          <div className="mt-1 flex flex-wrap gap-3">
            {(errors.length ? errors : pending).slice(0, 3).map(([key]) => (
              <button
                key={key}
                type="button"
                className="underline"
                onClick={() => jump(key)}
              >
                Go to {bufferLabel(key)}
              </button>
            ))}
            <button
              type="button"
              className="underline"
              onClick={() =>
                setBuffers((previous) =>
                  discardBulkGridBuffers(previous, (key, value) =>
                    errors.length
                      ? Boolean(value.error)
                      : key.startsWith("shared:"),
                  ),
                )
              }
            >
              {errors.length
                ? "Discard all invalid cell values"
                : "Discard pending column defaults"}
            </button>
          </div>
        </div>
      )}
      {!schema && (
        <p className="shrink-0 text-xs text-muted-foreground">
          Content, identifiers and prices are available now. Choose a shared
          product type to show its attributes.
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-2 xl:flex-row">
        <div
          className={`${detailItem ? "hidden xl:block" : ""} min-h-0 min-w-0 flex-1 overflow-auto rounded-md border`}
        >
          <table
            className="w-max border-separate border-spacing-0 text-xs"
            aria-label="Draft item attributes"
          >
            <thead className="sticky top-0 z-20 bg-background">
              <tr>
                <th
                  rowSpan={2}
                  className="sticky left-0 z-30 w-52 min-w-52 max-w-52 border-b border-r bg-background px-3 py-2 text-left"
                >
                  Product / SKU
                </th>
                {headerGroups.map((value, index) => (
                  <th
                    key={`${value.label}-${index}`}
                    colSpan={value.count}
                    className="border-b border-r bg-muted/60 px-2 py-1 text-left text-[10px] font-medium"
                  >
                    {value.label}
                  </th>
                ))}
              </tr>
              <tr>
                {columns.map((column) => (
                  <th
                    scope="col"
                    key={column.key}
                    className="border-b border-r bg-background px-2 py-2 text-left font-medium"
                    style={{ minWidth: width(column), width: width(column) }}
                  >
                    {column.kind === "attribute" &&
                      column.field.pathLabel !== column.field.label && (
                        <span className="mb-0.5 block whitespace-normal text-[10px] font-normal text-muted-foreground">
                          {column.field.pathLabel
                            .split(" › ")
                            .slice(0, -1)
                            .join(" / ")}
                        </span>
                      )}
                    {column.field.label}
                    {column.kind === "attribute" && column.field.required && (
                      <span
                        className="ml-1 text-destructive"
                        title={
                          column.field.requiredForSome
                            ? "Required for some items"
                            : "Required"
                        }
                      >
                        *
                      </span>
                    )}
                    {column.kind === "attribute" &&
                      column.field.help.length > 0 && (
                        <details className="mt-1 max-w-48 font-normal">
                          <summary
                            className="cursor-pointer text-[10px] text-primary"
                            aria-label={`Help for ${column.field.pathLabel}`}
                          >
                            Field help
                          </summary>
                          {column.field.help.map((help) => (
                            <p
                              key={JSON.stringify(help.path)}
                              className="mt-1 whitespace-normal text-xs"
                            >
                              <strong>{help.label}: </strong>
                              {help.description}
                            </p>
                          ))}
                        </details>
                      )}
                  </th>
                ))}
              </tr>
              {showDefaults && (
                <tr>
                  <th className="sticky left-0 z-30 w-52 min-w-52 max-w-52 border-b border-r bg-muted px-3 py-2 text-left align-top font-medium">
                    Column defaults
                    <span className="block text-[10px] font-normal text-muted-foreground">
                      All {items.length} selected items
                    </span>
                  </th>
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      ref={(element) => {
                        const key = bulkGridBufferKey("shared", column.key);
                        if (element) cells.current.set(key, element);
                        else cells.current.delete(key);
                      }}
                      className="border-b border-r bg-muted px-2 py-2 align-top"
                      style={{ minWidth: width(column), width: width(column) }}
                    >
                      {renderDefault(column)}
                    </td>
                  ))}
                </tr>
              )}
            </thead>
            <tbody>
              {rows.map((item, rowIndex) => (
                <tr key={item.variantId}>
                  <th
                    scope="row"
                    className="sticky left-0 z-10 w-52 min-w-52 max-w-52 border-b border-r bg-background px-3 py-2 text-left align-top"
                  >
                    <p className="break-words font-medium">{skuFor(item)}</p>
                    <p className="mt-0.5 line-clamp-2 text-[10px] font-normal text-muted-foreground">
                      {metadata.get(item.variantId)?.name}
                    </p>
                    <p className="mt-1 line-clamp-2 text-[10px] font-normal text-muted-foreground">
                      {item.method === "match" ? "Match" : "Create"} ·{" "}
                      {item.productType || "Type not selected"}
                    </p>
                    <div className="mt-1 flex gap-2 text-[10px] font-normal">
                      <button
                        type="button"
                        className="text-primary underline"
                        aria-label={`Edit attributes for ${skuFor(item)}`}
                        onClick={() =>
                          setInspector({
                            variantId: item.variantId,
                            field: null,
                          })
                        }
                      >
                        Item details
                      </button>
                      {changesById.has(item.variantId) && (
                        <button
                          type="button"
                          className="underline disabled:opacity-50"
                          disabled={!canEdit}
                          aria-label={`Undo row changes for ${skuFor(item)}`}
                          onClick={() => {
                            if (!onUndoItem(item.variantId)) return;
                            setBuffers((previous) =>
                              discardBulkGridBuffers(previous, (key) =>
                                key.startsWith(item.variantId + ":"),
                              ),
                            );
                          }}
                        >
                          Undo row
                        </button>
                      )}
                    </div>
                  </th>
                  {columns.map((column) =>
                    renderCell(item, column, offset + rowIndex),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {columns.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">
              No fields match this filter. Your edits are retained.
            </p>
          )}
        </div>
        {detailItem && inspector && (
          <ListingBulkItemInspector
            item={detailItem}
            metadata={metadata}
            schema={schema}
            column={
              inspector.field?.kind === "attribute"
                ? inspector.field.field
                : null
            }
            contentField={
              inspector.field?.kind === "core" ? inspector.field.field : null
            }
            buffers={buffers}
            canEdit={canEdit}
            providerFieldsDisabled={providerFieldsDisabled}
            onBufferChange={buffer}
            onDiscardBuffer={discard}
            onItemField={onItemField}
            onItemAttribute={applyItemAttribute}
            onClose={() => setInspector(null)}
            onPrevious={
              items.findIndex(
                (item) => item.variantId === detailItem.variantId,
              ) > 0
                ? () => moveInspector(-1)
                : undefined
            }
            onNext={
              items.findIndex(
                (item) => item.variantId === detailItem.variantId,
              ) <
              items.length - 1
                ? () => moveInspector(1)
                : undefined
            }
          />
        )}
      </div>
      <div
        className={`${detailItem ? "hidden xl:flex" : "flex"} shrink-0 flex-wrap items-center justify-between gap-2 text-xs`}
      >
        <p>
          Showing {items.length ? offset + 1 : 0}–
          {Math.min(offset + pageSize, items.length)} of {items.length} selected
          items
        </p>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1">
            Rows
            <select
              aria-label="Rows per page"
              className="h-8 rounded-md border bg-background px-2"
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(0);
              }}
            >
              {[25, 50, 100].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous draft rows
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={offset + pageSize >= items.length}
            onClick={() => setPage(currentPage + 1)}
          >
            Next draft rows
          </Button>
        </div>
      </div>
      {model.warnings.length > 0 && (
        <details className="shrink-0 text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            Field guidance ({model.warnings.length})
          </summary>
          {model.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </details>
      )}
    </section>
  );
  function moveInspector(delta: number) {
    if (!inspector) return;
    const index = items.findIndex(
      (item) => item.variantId === inspector.variantId,
    );
    const next = items[index + delta];
    if (next) setInspector({ ...inspector, variantId: next.variantId });
  }
  function bufferLabel(key: string) {
    const column = allColumns.find((column) => key.endsWith(":" + column.key));
    const item = itemById.get(Number(key.split(":", 1)[0]));
    return `${column?.field.label ?? "hidden field"}${item ? ` for ${skuFor(item)}` : " default"}`;
  }
}
function width(column: Column): number {
  if (column.kind === "core") return column.field.width;
  if (column.field.type === "integer" || column.field.type === "number")
    return 120;
  if (
    column.field.type === "boolean" ||
    Array.isArray(column.field.schema.enum)
  )
    return 160;
  return 190;
}
