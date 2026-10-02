import { useCallback, useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  listingRequirementsSchema,
  listingTaxonomySchema,
  type ListingCatalogItem,
  type ListingDraftItem,
} from "@shared/types/channel-listing-publication";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { publicationRequest } from "./api";
import { errorMessage, labelForKey, money } from "./model";
import { ListingProductTypePicker } from "./ListingProductTypePicker";
import { ListingBulkItemTable } from "./ListingBulkItemTable";
import {
  buildSchemaFieldModel,
  type SchemaFieldNode,
} from "./schema-field-model";
import { commonBulkContext, type BulkEditPatch } from "./bulk-edit-model";
import {
  buildBulkFieldPatch,
  projectBulkField,
  setBulkFieldEdit,
  undoBulkFieldEdit,
  type BulkFieldEdits,
  type BulkContentField,
} from "./bulk-field-state";
import {
  previewBulkEditBatch,
  resetBulkAttributeEdits,
  setBulkItemAttribute,
  setBulkSharedAttribute,
  undoBulkItemAttribute,
  undoBulkSharedAttribute,
  type BulkEditCommand,
} from "./bulk-edit-batch";

const OVERRIDES: readonly {
  field: BulkContentField;
  label: string;
  maximum: number;
  multiline?: boolean;
}[] = [
  { field: "brand", label: "Brand", maximum: 200 },
  { field: "title", label: "Walmart title", maximum: 500 },
  {
    field: "description",
    label: "Description",
    maximum: 30_000,
    multiline: true,
  },
  { field: "images", label: "Image URLs", maximum: 40_020, multiline: true },
  {
    field: "priceOverrideCents",
    label: "Fixed Walmart price (USD)",
    maximum: 17,
  },
];
const SELECT_CLASS =
  "min-h-10 w-full rounded-md border bg-background px-3 py-2 text-sm";
const FIELD_LABELS: Record<string, string> = {
  method: "Listing method",
  productType: "Product type",
  priceOverrideCents: "Fixed price",
  title: "Walmart title",
  description: "Description",
  brand: "Brand",
  images: "Images",
  attributes: "Provider attributes",
};

function OverrideControl({
  definition,
  value,
  placeholder,
  hint,
  changed,
  onInherit,
  onUndo,
  onValue,
}: {
  definition: (typeof OVERRIDES)[number];
  value: string;
  placeholder: string;
  hint: string;
  changed: boolean;
  onInherit(): void;
  onUndo(): void;
  onValue(value: string): void;
}) {
  const prefix = useId();
  const { field, label, maximum, multiline } = definition;
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor={`${prefix}-value`}>{label}</Label>
        <div className="flex flex-wrap gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={
              field === "priceOverrideCents"
                ? "Use pricing rules"
                : `Use catalog ${label.toLowerCase()}`
            }
            onClick={onInherit}
          >
            {field === "priceOverrideCents"
              ? "Use pricing rules"
              : "Use catalog"}
          </Button>
          {changed && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Undo ${label.toLowerCase()} change`}
              onClick={onUndo}
            >
              Undo change
            </Button>
          )}
        </div>
      </div>
      {multiline ? (
        <Textarea
          id={`${prefix}-value`}
          rows={3}
          maxLength={maximum}
          value={value}
          placeholder={placeholder}
          aria-describedby={`${prefix}-hint`}
          onChange={(event) => onValue(event.target.value)}
        />
      ) : (
        <Input
          id={`${prefix}-value`}
          maxLength={maximum}
          inputMode={field === "priceOverrideCents" ? "decimal" : undefined}
          value={value}
          placeholder={placeholder}
          aria-describedby={`${prefix}-hint`}
          onChange={(event) => onValue(event.target.value)}
        />
      )}
      <p id={`${prefix}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
      {field === "images" && (
        <p className="text-xs text-muted-foreground">
          One URL per line, up to 20. This replaces the selected items' image
          overrides.
        </p>
      )}
    </div>
  );
}

export interface ListingBulkEditorProps {
  base: string;
  /** Selected snapshots are fixed at opening; the parent applies against its current draft. */
  items: readonly ListingDraftItem[];
  metadata: ReadonlyMap<number, ListingCatalogItem>;
  canEdit: boolean;
  onClose(): void;
  onApply(command: BulkEditCommand): void;
}

export function ListingBulkEditor({
  base,
  items,
  metadata,
  canEdit,
  onClose,
  onApply,
}: ListingBulkEditorProps) {
  const prefix = useId();
  const [method, setMethod] = useState<ListingDraftItem["method"]>();
  const [productType, setProductType] = useState<string>();
  const [fieldEdits, setFieldEdits] = useState<BulkFieldEdits>({});
  const [attributeCommand, setAttributeCommand] = useState<BulkEditCommand>({
    shared: {},
    itemChanges: [],
  });
  const [error, setError] = useState("");
  const [attributeError, setAttributeError] = useState("");
  const [tableError, setTableError] = useState<string | null>(null);
  const [attributeBufferRevision, setAttributeBufferRevision] = useState(0);
  const handleTableValidity = useCallback((failure: string | null) => {
    setTableError(failure);
    if (!failure) setAttributeError("");
  }, []);
  const methodState = projectBulkField(items, metadata, "method");
  const typeState = projectBulkField(items, metadata, "productType");
  const contextPatch = {
    ...(method !== undefined ? { method } : {}),
    ...(productType !== undefined ? { productType } : {}),
  };
  const context = commonBulkContext(items, contextPatch);
  const taxonomy = useQuery({
    queryKey: [base, "taxonomy"],
    queryFn: () =>
      publicationRequest("GET", `${base}/taxonomy`, listingTaxonomySchema),
  });
  const requirements = useQuery({
    queryKey: [base, "requirements", context?.productType, context?.method],
    enabled: context !== null,
    queryFn: () =>
      publicationRequest(
        "GET",
        `${base}/requirements?${new URLSearchParams({ productType: context!.productType, method: context!.method })}`,
        listingRequirementsSchema,
      ),
  });
  const attributeTitles = useMemo(() => {
    const titles = new Map<string, string>();
    if (!requirements.data) return titles;
    const visit = (node: SchemaFieldNode) => {
      if (typeof node.schema.title === "string" && node.schema.title.trim())
        titles.set(JSON.stringify(node.path), node.schema.title);
      node.children.forEach(visit);
    };
    visit(buildSchemaFieldModel(requirements.data.schema, {}).root);
    return titles;
  }, [requirements.data]);
  function attributeLabel(path: readonly string[]): string {
    return path
      .map((key, index) => {
        const fallback = labelForKey(key);
        return (
          attributeTitles.get(JSON.stringify(path.slice(0, index + 1))) ??
          fallback.charAt(0).toUpperCase() + fallback.slice(1)
        );
      })
      .join(" › ");
  }
  function resetAttributes() {
    setAttributeCommand((previous) => resetBulkAttributeEdits(previous));
    setError("");
    setAttributeError("");
    setTableError(null);
    setAttributeBufferRevision((previous) => previous + 1);
  }
  function changeContext(
    nextMethod: ListingDraftItem["method"] | undefined,
    nextType: string | undefined,
  ) {
    const next = commonBulkContext(items, {
      ...(nextMethod !== undefined ? { method: nextMethod } : {}),
      ...(nextType !== undefined ? { productType: nextType } : {}),
    });
    if (
      context?.method !== next?.method ||
      context?.productType !== next?.productType
    )
      resetAttributes();
    setMethod(nextMethod);
    setProductType(nextType);
  }
  // An invalid unfinished price/content buffer must not make already-edited row
  // attributes disappear. Project the table independently of those buffers.
  const tableItems = useMemo(() => {
    try {
      return previewBulkEditBatch(items, {
        shared: { ...attributeCommand.shared, ...contextPatch },
        itemChanges: attributeCommand.itemChanges,
      }).effectiveItems;
    } catch {
      // The complete preview below reports the same validation error and blocks Apply.
      return items;
    }
  }, [items, method, productType, attributeCommand]);
  const prepared = useMemo(() => {
    try {
      const patch: BulkEditPatch = {
        ...attributeCommand.shared,
        ...contextPatch,
        ...buildBulkFieldPatch(fieldEdits),
      };
      const command = {
        shared: patch,
        itemChanges: attributeCommand.itemChanges,
      };
      const result = previewBulkEditBatch(items, command);
      return {
        patch,
        command,
        preview: result.preview,
        effectiveItems: result.effectiveItems,
        error: "",
      };
    } catch (failure) {
      return {
        patch: null,
        command: null,
        preview: null,
        effectiveItems: items,
        error: errorMessage(failure),
      };
    }
  }, [items, method, productType, fieldEdits, attributeCommand]);
  function apply() {
    if (
      !canEdit ||
      !prepared.command ||
      !prepared.preview?.changedCount ||
      tableError ||
      attributeError
    )
      return;
    try {
      onApply(prepared.command);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  const attributesBusy =
    Boolean(
      attributeCommand.shared.attributeChanges?.length ||
        attributeCommand.itemChanges.length,
    ) &&
    (requirements.isFetching || Boolean(requirements.error));
  function editAttributes(
    edit: (command: BulkEditCommand) => BulkEditCommand,
  ): boolean {
    if (!canEdit) return false;
    try {
      setAttributeCommand(edit(attributeCommand));
      setAttributeError("");
      return true;
    } catch (failure) {
      setAttributeError(errorMessage(failure));
      return false;
    }
  }
  function valueLabel(value: unknown, path: readonly string[]): string {
    if (value === undefined) return "Not set";
    if (value === null)
      return path[0] === "attributes" ? "null" : "Use catalog/pricing";
    if (path[0] === "priceOverrideCents" && typeof value === "number")
      return money(value);
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  function previewFieldLabel(field: string): string {
    if (FIELD_LABELS[field]) return FIELD_LABELS[field];
    const paths = prepared.patch?.attributeChanges
      ?.filter((change) => `attributes.${change.path.join(".")}` === field)
      .map((change) => attributeLabel(change.path));
    return paths?.length
      ? [...new Set(paths)].join(", ")
      : attributeLabel(field.replace(/^attributes\./, "").split("."));
  }
  const renderOverride = (definition: (typeof OVERRIDES)[number]) => {
    const edit = fieldEdits[definition.field];
    const changed = Object.prototype.hasOwnProperty.call(
      fieldEdits,
      definition.field,
    );
    const projection = projectBulkField(items, metadata, definition.field, {
      inherit: changed && edit === null,
    });
    const value = typeof edit === "string" ? edit : projection.value;
    const inheritedLabel =
      definition.field === "priceOverrideCents" ? "pricing" : "catalog";
    const hint = changed
      ? edit === null || (typeof edit === "string" && !edit.trim())
        ? `Each selected item will use its own ${inheritedLabel} value.`
        : `This edit applies to all ${items.length} selected items.`
      : projection.status === "mixed"
        ? "Multiple values. Each item keeps its value until you edit this field."
        : projection.status === "unavailable"
          ? "Some source values are unavailable. Existing per-item settings stay unchanged until you edit."
          : projection.source === "mixed"
            ? "The displayed value is shared, but its sources differ. Untouched settings stay unchanged."
            : `Current ${projection.source === "custom" ? "override" : inheritedLabel} value. Untouched settings stay unchanged.`;
    return (
      <OverrideControl
        key={definition.field}
        definition={definition}
        value={value}
        placeholder={
          projection.status === "mixed"
            ? "Multiple values — unchanged"
            : projection.status === "unavailable"
              ? "Source value unavailable"
              : "No value"
        }
        hint={hint}
        changed={changed}
        onInherit={() =>
          setFieldEdits((previous) =>
            setBulkFieldEdit(previous, definition.field, null),
          )
        }
        onUndo={() =>
          setFieldEdits((previous) =>
            undoBulkFieldEdit(previous, definition.field),
          )
        }
        onValue={(value) =>
          setFieldEdits((previous) =>
            setBulkFieldEdit(previous, definition.field, value),
          )
        }
      />
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex max-h-[92dvh] max-w-[min(96vw,90rem)] flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-4 py-4 sm:px-6">
          <DialogTitle className="pr-6">
            Bulk edit {items.length} draft{" "}
            {items.length === 1 ? "item" : "items"}
          </DialogTitle>
          <DialogDescription>
            Edit common settings above the table, or change individual rows.
            Applying updates your local draft; Save draft and Review remain
            separate steps. Product identifiers and SKUs stay individual.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6">
          <fieldset disabled={!canEdit} className="min-w-0 space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor={`${prefix}-method`}>Bulk listing method</Label>
              <select
                id={`${prefix}-method`}
                className={SELECT_CLASS}
                value={
                  method ??
                  (methodState.status === "common" ? methodState.value : "")
                }
                onChange={(event) => {
                  const value = event.target
                    .value as ListingDraftItem["method"];
                  changeContext(
                    methodState.status === "common" &&
                      methodState.value === value
                      ? undefined
                      : value,
                    productType,
                  );
                }}
              >
                {methodState.status !== "common" && (
                  <option value="" disabled>
                    Multiple methods — keep individual values
                  </option>
                )}
                <option value="create">Create product on Walmart</option>
                <option value="match">
                  Match existing Walmart catalog product
                </option>
              </select>
              {method !== undefined && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Undo listing method change"
                  onClick={() => changeContext(undefined, productType)}
                >
                  Undo change
                </Button>
              )}
            </div>
            <div className="space-y-3">
              <ListingProductTypePicker
                label="Shared Walmart product type"
                value={
                  productType ??
                  (typeState.status === "common" ? typeState.value : "")
                }
                taxonomy={taxonomy.data}
                loading={taxonomy.isFetching}
                error={
                  taxonomy.error ? errorMessage(taxonomy.error) : undefined
                }
                disabled={!canEdit}
                onRetry={() => void taxonomy.refetch()}
                onSelect={(value) => {
                  changeContext(
                    method,
                    typeState.status === "common" && typeState.value === value
                      ? undefined
                      : value,
                  );
                }}
              />
              {typeState.status === "mixed" && productType === undefined && (
                <p className="text-xs text-muted-foreground">
                  Multiple product types. Each item keeps its current type until
                  you choose one.
                </p>
              )}
              {productType !== undefined && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Undo product type change"
                  onClick={() => changeContext(method, undefined)}
                >
                  Undo change
                </Button>
              )}
              <p className="text-xs text-muted-foreground">
                Changing an item's method or product type clears its existing
                provider attributes. Items already using that method and type
                keep their attributes. Changing the shared method or type also
                clears attribute edits made in this dialog.
              </p>
            </div>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              {OVERRIDES.filter(
                ({ field }) =>
                  field === "brand" || field === "priceOverrideCents",
              ).map(renderOverride)}
            </div>
            <section className="space-y-3 rounded-md border p-3">
              {!context && (
                <p className="text-sm text-muted-foreground">
                  The selected drafts need a common listing method and product
                  type before the attribute table can be shown. Choose them
                  above, or edit these items individually.
                </p>
              )}
              {context && (
                <p className="text-xs text-muted-foreground">
                  {context.method === "create"
                    ? "Create product"
                    : "Catalog match"}
                  {context.productType ? ` · ${context.productType}` : ""}.
                  Untouched fields stay unchanged. Use column actions for shared
                  values or edit each item independently.
                </p>
              )}
              {context && (
                <>
                  {requirements.isFetching && (
                    <p role="status" className="text-sm text-muted-foreground">
                      Loading shared listing requirements…
                    </p>
                  )}
                  {requirements.error && (
                    <div className="space-y-2">
                      <p role="alert" className="text-sm text-destructive">
                        {errorMessage(requirements.error)}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!canEdit || requirements.isFetching}
                        onClick={() => void requirements.refetch()}
                      >
                        Retry shared requirements
                      </Button>
                    </div>
                  )}
                  {requirements.data && (
                    <ListingBulkItemTable
                      key={`${JSON.stringify(context)}:${attributeBufferRevision}`}
                      schema={requirements.data.schema}
                      items={tableItems}
                      metadata={metadata}
                      itemChanges={attributeCommand.itemChanges}
                      canEdit={
                        canEdit &&
                        !requirements.isFetching &&
                        !requirements.error
                      }
                      onItemAttribute={(variantId, path, value) =>
                        editAttributes((command) =>
                          setBulkItemAttribute(command, variantId, path, value),
                        )
                      }
                      onSharedAttribute={(path, value) =>
                        editAttributes((command) =>
                          setBulkSharedAttribute(command, path, value),
                        )
                      }
                      onUndoItemAttribute={(variantId, path) =>
                        editAttributes((command) =>
                          undoBulkItemAttribute(command, variantId, path),
                        )
                      }
                      onUndoItem={(variantId) =>
                        editAttributes((command) => ({
                          ...command,
                          itemChanges: command.itemChanges.filter(
                            (change) => change.variantId !== variantId,
                          ),
                        }))
                      }
                      onValidityChange={handleTableValidity}
                    />
                  )}
                  {(attributeCommand.shared.attributeChanges?.length ||
                    attributeCommand.itemChanges.length > 0 ||
                    Boolean(attributeError)) && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={resetAttributes}
                    >
                      Undo all attribute changes
                    </Button>
                  )}
                </>
              )}
            </section>
            <details className="space-y-3 rounded-md border p-3">
              <summary className="cursor-pointer text-sm font-medium">
                Optional content overrides
              </summary>
              <p className="text-xs text-muted-foreground">
                Titles, descriptions and images keep each item's current values
                unless explicitly changed here.
              </p>
              <div className="space-y-4">
                {OVERRIDES.filter(
                  ({ field }) =>
                    field !== "brand" && field !== "priceOverrideCents",
                ).map(renderOverride)}
              </div>
            </details>
          </fieldset>
          <section
            aria-label="Bulk edit preview"
            className="min-w-0 space-y-3 rounded-md border p-3"
          >
            <h3 className="font-medium">Preview changes</h3>
            {prepared.error && (
              <p role="alert" className="break-words text-sm text-destructive">
                {prepared.error}
              </p>
            )}
            {prepared.preview && (
              <>
                {prepared.command &&
                Object.keys(prepared.command.shared).length === 0 &&
                prepared.command.itemChanges.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Choose a field to change. Every selected draft keeps its
                    current values until you apply an explicit change.
                  </p>
                ) : (
                  <p className="text-sm">
                    {prepared.preview.changedCount} of {items.length} selected{" "}
                    {items.length === 1 ? "draft" : "drafts"} will change.{" "}
                    {prepared.preview.resetCount > 0 ? (
                      <>
                        Existing provider attributes will be cleared on{" "}
                        {prepared.preview.resetCount}{" "}
                        {prepared.preview.resetCount === 1 ? "item" : "items"}.
                      </>
                    ) : (
                      "Other existing attributes are preserved."
                    )}
                  </p>
                )}
                {prepared.patch && (
                  <ul className="space-y-1 text-sm">
                    {Object.entries(prepared.patch)
                      .filter(([key]) => key !== "attributeChanges")
                      .map(([key, value]) => (
                        <li key={key} className="break-words">
                          <strong>{FIELD_LABELS[key]}:</strong>{" "}
                          {value === null
                            ? "Inherit catalog/rules"
                            : key === "priceOverrideCents"
                              ? money(value as number)
                              : Array.isArray(value)
                                ? value.join(", ")
                                : String(value)}
                        </li>
                      ))}
                    {prepared.patch.attributeChanges?.map((change) => (
                      <li
                        key={JSON.stringify(change.path)}
                        className="break-words"
                      >
                        <strong>{attributeLabel(change.path)}:</strong>{" "}
                        {change.action === "remove"
                          ? "Remove this value"
                          : change.value !== null &&
                              typeof change.value === "object"
                            ? JSON.stringify(change.value)
                            : String(change.value)}
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={!canEdit || Boolean(tableError)}
                          aria-label={`Undo shared ${attributeLabel(change.path)} change`}
                          onClick={() =>
                            editAttributes((command) =>
                              undoBulkSharedAttribute(command, change.path),
                            )
                          }
                        >
                          Undo change
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                <ul
                  className="max-h-48 space-y-2 overflow-y-auto text-sm"
                  aria-label="Selected draft changes"
                >
                  {prepared.preview.items.map((item) => (
                    <li key={item.variantId} className="break-words">
                      <strong>
                        {metadata.get(item.variantId)?.sku ??
                          `Variant ${item.variantId}`}
                        :
                      </strong>{" "}
                      {item.changes.length ? (
                        <ul className="mt-1 space-y-1">
                          {item.changes.map((change) => (
                            <li
                              key={JSON.stringify(change.path)}
                              className="break-words"
                            >
                              {change.path[0] === "attributes"
                                ? attributeLabel(change.path.slice(1))
                                : previewFieldLabel(change.path.join("."))}
                              : {valueLabel(change.before, change.path)} →{" "}
                              {valueLabel(change.after, change.path)}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        "No changes"
                      )}
                      {item.attributesReset &&
                        " · existing provider attributes cleared"}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
          {error && (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          )}
          {tableError && (
            <p role="alert" className="break-words text-sm text-destructive">
              {tableError}
            </p>
          )}
          {attributeError && (
            <p role="alert" className="break-words text-sm text-destructive">
              {attributeError}
            </p>
          )}
        </div>
        <DialogFooter className="shrink-0 border-t bg-background px-4 py-3 sm:px-6">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={
              !canEdit ||
              !prepared.preview?.changedCount ||
              attributesBusy ||
              Boolean(attributeError) ||
              Boolean(tableError)
            }
            onClick={apply}
          >
            Apply to {items.length} draft{" "}
            {items.length === 1 ? "item" : "items"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
