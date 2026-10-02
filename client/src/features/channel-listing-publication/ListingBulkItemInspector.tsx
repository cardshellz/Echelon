import { useMemo } from "react";
import type {
  ListingCatalogItem,
  ListingDraftItem,
} from "@shared/types/channel-listing-publication";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SchemaFields } from "./SchemaFields";
import {
  buildSchemaFieldModel,
  fieldValueAtPath,
  type FieldSchema,
  type SchemaFieldNode,
} from "./schema-field-model";
import type { BulkAttributeColumn } from "./bulk-attribute-columns";
import { ListingBulkAttributeCell } from "./ListingBulkAttributeCell";
import { canonicalDraftValue } from "./draft-item-snapshot";
import { ListingBulkContentCell } from "./ListingBulkContentCell";
import {
  BULK_GRID_CORE_COLUMNS,
  bulkGridBufferKey,
  bulkGridAttributePath,
  bulkGridPathsOverlap,
  type BulkGridBuffer,
  type BulkGridColumn,
  type BulkGridField,
} from "./bulk-grid-state";
import { errorMessage } from "./model";

interface Props {
  item: ListingDraftItem;
  metadata: ReadonlyMap<number, ListingCatalogItem>;
  schema?: FieldSchema;
  column: BulkAttributeColumn | null;
  contentField: BulkGridColumn | null;
  buffers: ReadonlyMap<string, BulkGridBuffer>;
  canEdit: boolean;
  providerFieldsDisabled?: boolean;
  onBufferChange(key: string, value: BulkGridBuffer): void;
  onDiscardBuffer(key: string): void;
  onItemField(id: number, field: BulkGridField, value: unknown): boolean;
  onItemAttribute(
    id: number,
    path: readonly string[],
    value: unknown,
    editedPath?: readonly string[],
  ): boolean;
  onClose(): void;
  onPrevious?: () => void;
  onNext?: () => void;
}
function findField(
  node: SchemaFieldNode,
  path: readonly string[],
): SchemaFieldNode | undefined {
  if (
    node.path.length === path.length &&
    node.path.every((part, index) => part === path[index])
  )
    return node;
  for (const child of node.children) {
    const found = findField(child, path);
    if (found) return found;
  }
  return undefined;
}

/** This is a docked part of the workbench, not a second editing dialog. */
export function ListingBulkItemInspector({
  item,
  metadata,
  schema,
  column,
  contentField,
  buffers,
  canEdit,
  providerFieldsDisabled = false,
  onBufferChange,
  onDiscardBuffer,
  onItemField,
  onItemAttribute,
  onClose,
  onPrevious,
  onNext,
}: Props) {
  const sku = metadata.get(item.variantId)?.sku ?? `Variant ${item.variantId}`;
  const rowModel = useMemo(
    () => (schema ? buildSchemaFieldModel(schema, item.attributes) : null),
    [schema, item.attributes],
  );
  const node =
    column && rowModel ? findField(rowModel.root, column.path) : undefined;
  const attributeKey = column
    ? bulkGridBufferKey(item.variantId, "attribute:" + column.key)
    : null;
  const attributeBuffer = attributeKey ? buffers.get(attributeKey) : undefined;
  const selectedValue = column
    ? fieldValueAtPath(item.attributes, column.path)
    : undefined;
  const selectedSchema = node?.schema;
  const editorSchema = useMemo<FieldSchema>(
    () => ({
      type: "object",
      properties: { value: { ...selectedSchema, title: column?.label } },
    }),
    [selectedSchema, column?.label],
  );
  const editorValue = useMemo<FieldSchema>(
    () => (selectedValue === undefined ? {} : { value: selectedValue }),
    [selectedValue],
  );
  const contentColumns = contentField
    ? [contentField]
    : column
      ? []
      : BULK_GRID_CORE_COLUMNS;
  const relevantErrors = [...buffers].filter(([key, buffer]) => {
    const path = bulkGridAttributePath(key, item.variantId);
    return (
      Boolean(buffer.error) &&
      path !== null &&
      (!column || bulkGridPathsOverlap(path, column.path))
    );
  });
  function changeAttribute(
    path: readonly string[],
    value: unknown,
    editedPath?: readonly string[],
  ): boolean {
    if (!canEdit || providerFieldsDisabled) return false;
    // The table acknowledges writes and retains rejected attempts and errors.
    return onItemAttribute(item.variantId, path, value, editedPath);
  }
  function renderNumericField(
    field: SchemaFieldNode,
    update: (value: number | undefined) => boolean,
    accessibility: { id: string; describedBy?: string },
  ) {
    const path = column ? [...column.path, ...field.path.slice(1)] : field.path;
    const key = bulkGridBufferKey(
      item.variantId,
      "attribute:" + JSON.stringify(path),
    );
    const numericColumn: BulkAttributeColumn = {
      key: JSON.stringify(path),
      path,
      label: field.label,
      pathLabel: field.label,
      group: "",
      type: field.type === "integer" ? "integer" : "number",
      kind: "scalar",
      complexReason: null,
      schema: field.schema,
      required: field.required,
      requiredForSome: false,
      appliesToAll: false,
      help: [],
    };
    const ancestorError = [...buffers].some(([candidate, value]) => {
      const candidatePath = bulkGridAttributePath(candidate, item.variantId);
      return (
        candidate !== key &&
        value.error &&
        candidatePath !== null &&
        candidatePath.length < path.length &&
        bulkGridPathsOverlap(candidatePath, path)
      );
    });
    return (
      <ListingBulkAttributeCell
        inputId={accessibility.id}
        describedBy={accessibility.describedBy}
        column={numericColumn}
        value={field.value}
        sku={sku}
        buffer={buffers.get(key)}
        disabled={!canEdit || providerFieldsDisabled || Boolean(ancestorError)}
        required={field.required}
        onChange={(value) =>
          (value === undefined || typeof value === "number") && update(value)
        }
        onBufferChange={(value) =>
          onBufferChange(key, {
            ...value,
            controlSignature: canonicalDraftValue([
              numericColumn.type,
              numericColumn.schema.enum,
            ]),
          })
        }
      />
    );
  }
  function editJson(raw: string) {
    if (!column || !attributeKey || !canEdit || providerFieldsDisabled) return;
    let error: string | null = null;
    try {
      const next: unknown = raw.trim() ? JSON.parse(raw) : undefined;
      if (!onItemAttribute(item.variantId, column.path, next))
        throw new Error("This value could not be applied.");
    } catch (cause) {
      error = errorMessage(cause);
    }
    onBufferChange(attributeKey, { raw, error });
  }
  return (
    <aside
      aria-label="Item details"
      className="flex min-h-0 w-full flex-1 flex-col rounded-md border bg-background xl:w-[390px] xl:flex-none"
    >
      <div className="flex shrink-0 items-start justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-semibold">{sku}</h3>
          <p className="text-xs text-muted-foreground">
            {contentField?.label ?? column?.pathLabel ?? "Item details"}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Close details
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {relevantErrors.length > 0 && (
          <div className="space-y-2 rounded-md border border-destructive/30 p-2">
            {relevantErrors.map(([key, buffer]) => (
              <div key={key}>
                <p role="alert" className="text-xs text-destructive">
                  {buffer.error}
                </p>
                <p className="max-h-20 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
                  {buffer.raw || "(clear value)"}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onDiscardBuffer(key)}
                >
                  Discard invalid value
                </Button>
              </div>
            ))}
          </div>
        )}
        {column?.help.map((help) => (
          <p
            key={JSON.stringify(help.path)}
            className="text-xs text-muted-foreground"
          >
            <strong>{help.label}: </strong>
            {help.description}
          </p>
        ))}
        {contentColumns.map((field) => {
          const key = bulkGridBufferKey(item.variantId, "core:" + field.key);
          return (
            <section key={field.key} className="space-y-1">
              <h4 className="text-sm font-medium">{field.label}</h4>
              {field.key === "images" && (
                <p className="text-xs text-muted-foreground">
                  One image URL per line.
                </p>
              )}
              <ListingBulkContentCell
                item={item}
                metadata={metadata}
                field={field.key}
                label={field.label}
                sku={sku}
                buffer={buffers.get(key)}
                disabled={!canEdit}
                expanded
                onBufferChange={(value) => onBufferChange(key, value)}
                onDiscardBuffer={() => onDiscardBuffer(key)}
                onChange={(value) =>
                  onItemField(item.variantId, field.key, value)
                }
              />
            </section>
          );
        })}
        {column ? (
          <>
            {!node ? (
              <p className="text-sm text-muted-foreground">
                This field is not used for this item's current details. Existing
                edits are retained; undo or change the relevant item details to
                use it.
              </p>
            ) : (
              <SchemaFields
                key={`${item.variantId}:${column.key}`}
                schema={editorSchema}
                value={editorValue}
                disabled={
                  !canEdit ||
                  providerFieldsDisabled ||
                  Boolean(attributeBuffer?.error)
                }
                onChange={() => {
                  /* Exact paths below preserve other fields. */
                }}
                onFieldChange={(path, value, editedPath) =>
                  changeAttribute(
                    [...column.path, ...path.slice(1)],
                    value,
                    editedPath
                      ? [...column.path, ...editedPath.slice(1)]
                      : undefined,
                  )
                }
                renderNumericField={renderNumericField}
              />
            )}
            <details
              open={
                Boolean(attributeBuffer?.error) ||
                column.complexReason === "unsupported" ||
                column.complexReason === "conditional"
              }
            >
              <summary className="cursor-pointer text-xs font-medium">
                Advanced field value (JSON)
              </summary>
              <p className="my-2 text-xs text-muted-foreground">
                Use this for a value the form cannot display. Final listing
                review checks provider requirements.
              </p>
              <Textarea
                aria-label={`Advanced ${column.pathLabel} for ${sku}`}
                disabled={!canEdit || providerFieldsDisabled || !node}
                className="min-h-36 font-mono text-xs"
                value={
                  attributeBuffer?.raw ??
                  (selectedValue === undefined
                    ? ""
                    : JSON.stringify(selectedValue, null, 2))
                }
                onChange={(event) => editJson(event.target.value)}
                aria-invalid={Boolean(attributeBuffer?.error)}
              />
              {attributeBuffer?.error && (
                <>
                  <p role="alert" className="mt-1 text-xs text-destructive">
                    {attributeBuffer.error}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      attributeKey && onDiscardBuffer(attributeKey)
                    }
                  >
                    Discard invalid value
                  </Button>
                </>
              )}
            </details>
          </>
        ) : !contentField && schema ? (
          <section className="space-y-2">
            <h4 className="text-sm font-medium">Product attributes</h4>
            <SchemaFields
              key={item.variantId}
              schema={schema}
              value={item.attributes}
              disabled={!canEdit || providerFieldsDisabled}
              onChange={() => {
                /* Exact paths below preserve other fields. */
              }}
              onFieldChange={changeAttribute}
              renderNumericField={renderNumericField}
            />
          </section>
        ) : null}
      </div>
      <div className="flex shrink-0 justify-between border-t p-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!onPrevious}
          onClick={onPrevious}
        >
          Previous item
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!onNext}
          onClick={onNext}
        >
          Next item
        </Button>
      </div>
    </aside>
  );
}
