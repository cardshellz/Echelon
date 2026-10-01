import { useId, useMemo, useState } from "react";
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
import { SchemaFields } from "./SchemaFields";
import {
  buildSchemaFieldModel,
  type SchemaFieldNode,
} from "./schema-field-model";
import {
  bulkEditPatchSchema,
  bulkFixedPriceCents,
  commonBulkContext,
  previewBulkEdit,
  updateBulkAttribute,
  type BulkAttributeChange,
  type BulkEditPatch,
} from "./bulk-edit-model";

type OverrideField =
  | "brand"
  | "title"
  | "description"
  | "images"
  | "priceOverrideCents";
type EditMode = "unchanged" | "override" | "inherit";
const OVERRIDES: readonly {
  field: OverrideField;
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
  mode,
  value,
  onMode,
  onValue,
}: {
  definition: (typeof OVERRIDES)[number];
  mode: EditMode;
  value: string;
  onMode(mode: EditMode): void;
  onValue(value: string): void;
}) {
  const prefix = useId();
  const { field, label, maximum, multiline } = definition;
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={`${prefix}-mode`}>{label} action</Label>
      <select
        id={`${prefix}-mode`}
        className={SELECT_CLASS}
        value={mode}
        onChange={(event) => onMode(event.target.value as EditMode)}
      >
        <option value="unchanged">Leave unchanged</option>
        <option value="override">Set for selected drafts</option>
        <option value="inherit">Inherit catalog/rules</option>
      </select>
      {mode === "override" && (
        <div className="space-y-1.5">
          <Label htmlFor={`${prefix}-value`}>
            Shared {label.toLowerCase()}
          </Label>
          {multiline ? (
            <Textarea
              id={`${prefix}-value`}
              rows={3}
              maxLength={maximum}
              value={value}
              onChange={(event) => onValue(event.target.value)}
            />
          ) : (
            <Input
              id={`${prefix}-value`}
              maxLength={maximum}
              inputMode={field === "priceOverrideCents" ? "decimal" : undefined}
              value={value}
              onChange={(event) => onValue(event.target.value)}
            />
          )}
          {field === "images" && (
            <p className="text-xs text-muted-foreground">
              One URL per line, up to 20. This replaces the selected items'
              image overrides.
            </p>
          )}
        </div>
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
  onApply(patch: BulkEditPatch): void;
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
  const [method, setMethod] = useState<
    "unchanged" | ListingDraftItem["method"]
  >("unchanged");
  const [changeType, setChangeType] = useState(false);
  const [productType, setProductType] = useState("");
  const [modes, setModes] = useState<Partial<Record<OverrideField, EditMode>>>(
    {},
  );
  const [values, setValues] = useState<Partial<Record<OverrideField, string>>>(
    {},
  );
  const [changeAttributes, setChangeAttributes] = useState(false);
  const [attributeValues, setAttributeValues] = useState<
    Record<string, unknown>
  >({});
  const [attributeChanges, setAttributeChanges] = useState<
    BulkAttributeChange[]
  >([]);
  const [error, setError] = useState("");
  const [attributeError, setAttributeError] = useState("");
  const contextPatch = {
    ...(method !== "unchanged" ? { method } : {}),
    ...(changeType && productType ? { productType } : {}),
  };
  const context = commonBulkContext(items, contextPatch);
  const taxonomy = useQuery({
    queryKey: [base, "taxonomy"],
    enabled: changeType,
    queryFn: () =>
      publicationRequest("GET", `${base}/taxonomy`, listingTaxonomySchema),
  });
  const requirements = useQuery({
    queryKey: [base, "requirements", context?.productType, context?.method],
    enabled: changeAttributes && context !== null,
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
    visit(
      buildSchemaFieldModel(requirements.data.schema, attributeValues).root,
    );
    return titles;
  }, [requirements.data, attributeValues]);
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
    setAttributeValues({});
    setAttributeChanges([]);
    setError("");
    setAttributeError("");
  }
  const prepared = useMemo(() => {
    try {
      const patch: BulkEditPatch = {
        ...(method !== "unchanged" ? { method } : {}),
        ...(changeType ? { productType } : {}),
      };
      if (changeType && !productType)
        throw new Error(
          "Choose a Walmart product type to apply to the selected drafts.",
        );
      for (const { field, label } of OVERRIDES) {
        const mode = modes[field] ?? "unchanged";
        if (mode === "unchanged") continue;
        if (mode === "inherit") {
          patch[field] = null;
          continue;
        }
        const value = values[field] ?? "";
        if (!value.trim())
          throw new Error(
            `Enter ${label.toLowerCase()}, or choose Inherit catalog/rules.`,
          );
        if (field === "priceOverrideCents")
          patch.priceOverrideCents = bulkFixedPriceCents(value);
        else if (field === "images")
          patch.images = value
            .split(/\r?\n/)
            .map((url) => url.trim())
            .filter(Boolean);
        else patch[field] = value;
      }
      if (changeAttributes && attributeChanges.length)
        patch.attributeChanges = attributeChanges;
      const parsed = bulkEditPatchSchema.parse(patch);
      return {
        patch: parsed,
        preview: previewBulkEdit(items, parsed),
        error: "",
      };
    } catch (failure) {
      return { patch: null, preview: null, error: errorMessage(failure) };
    }
  }, [
    items,
    method,
    changeType,
    productType,
    modes,
    values,
    changeAttributes,
    attributeChanges,
  ]);
  function apply() {
    if (!canEdit || !prepared.patch || !prepared.preview?.changedCount) return;
    try {
      onApply(prepared.patch);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  const attributesBusy =
    changeAttributes &&
    Boolean(attributeChanges.length) &&
    (requirements.isFetching || Boolean(requirements.error));
  function previewFieldLabel(field: string): string {
    if (FIELD_LABELS[field]) return FIELD_LABELS[field];
    const paths = prepared.patch?.attributeChanges
      ?.filter((change) => `attributes.${change.path.join(".")}` === field)
      .map((change) => attributeLabel(change.path));
    return paths?.length
      ? [...new Set(paths)].join(", ")
      : attributeLabel(field.replace(/^attributes\./, "").split("."));
  }
  const renderOverride = (definition: (typeof OVERRIDES)[number]) => (
    <OverrideControl
      key={definition.field}
      definition={definition}
      mode={modes[definition.field] ?? "unchanged"}
      value={values[definition.field] ?? ""}
      onMode={(mode) =>
        setModes((previous) => ({ ...previous, [definition.field]: mode }))
      }
      onValue={(value) =>
        setValues((previous) => ({ ...previous, [definition.field]: value }))
      }
    />
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex max-h-[90dvh] max-w-3xl flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-4 py-4 sm:px-6">
          <DialogTitle className="pr-6">
            Bulk edit {items.length} draft{" "}
            {items.length === 1 ? "item" : "items"}
          </DialogTitle>
          <DialogDescription>
            Choose only the fields to change. Applying updates your local draft;
            Save draft and Review remain separate steps. Product identifiers and
            SKUs stay individual.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6">
          <fieldset disabled={!canEdit} className="min-w-0 space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor={`${prefix}-method`}>Bulk listing method</Label>
              <select
                id={`${prefix}-method`}
                className={SELECT_CLASS}
                value={method}
                onChange={(event) => {
                  setMethod(event.target.value as typeof method);
                  resetAttributes();
                }}
              >
                <option value="unchanged">Leave unchanged</option>
                <option value="create">Create product on Walmart</option>
                <option value="match">
                  Match existing Walmart catalog product
                </option>
              </select>
            </div>
            <div className="space-y-3">
              <label className="flex items-start gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={changeType}
                  onChange={(event) => {
                    setChangeType(event.target.checked);
                    resetAttributes();
                  }}
                />
                Change product type for selected drafts
              </label>
              {changeType ? (
                <ListingProductTypePicker
                  label="Shared Walmart product type"
                  value={productType}
                  taxonomy={taxonomy.data}
                  loading={taxonomy.isFetching}
                  error={
                    taxonomy.error ? errorMessage(taxonomy.error) : undefined
                  }
                  disabled={!canEdit}
                  onRetry={() => void taxonomy.refetch()}
                  onSelect={(value) => {
                    if (value !== productType) {
                      setProductType(value);
                      resetAttributes();
                    }
                  }}
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Product types: leave unchanged.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Changing an item's method or product type clears its existing
                provider attributes. Items already using that method and type
                keep their attributes.
              </p>
            </div>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              {OVERRIDES.filter(
                ({ field }) =>
                  field === "brand" || field === "priceOverrideCents",
              ).map(renderOverride)}
            </div>
            <section className="space-y-3 rounded-md border p-3">
              <label className="flex items-start gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={changeAttributes}
                  disabled={!canEdit || !context}
                  onChange={(event) =>
                    setChangeAttributes(event.target.checked)
                  }
                />
                Change shared provider attributes
              </label>
              {!context && (
                <p className="text-sm text-muted-foreground">
                  The selected drafts need a common listing method and product
                  type before shared attributes can be edited. Choose them
                  above, or edit these items individually.
                </p>
              )}
              {context && (
                <p className="text-xs text-muted-foreground">
                  {context.method === "create"
                    ? "Create product"
                    : "Catalog match"}
                  {context.productType ? ` · ${context.productType}` : ""}.
                  Untouched fields stay unchanged. Shared values merge into each
                  item's attributes; changing an array replaces that array.
                </p>
              )}
              {changeAttributes && context && (
                <>
                  <p className="text-xs text-muted-foreground">
                    These controls start empty. Fill a field to change it on all
                    selected drafts. Clearing a field you edited removes that
                    value from all selected drafts.
                  </p>
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
                  {requirements.data && !requirements.error && (
                    <SchemaFields
                      mode="patch"
                      key={JSON.stringify(context)}
                      schema={requirements.data.schema}
                      value={attributeValues}
                      onChange={setAttributeValues}
                      onFieldChange={(path, value) => {
                        try {
                          setAttributeChanges(
                            updateBulkAttribute(attributeChanges, path, value),
                          );
                          setAttributeError("");
                        } catch (failure) {
                          setAttributeError(errorMessage(failure));
                        }
                      }}
                      disabled={!canEdit || requirements.isFetching}
                    />
                  )}
                  {(attributeChanges.length > 0 || Boolean(attributeError)) && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={resetAttributes}
                    >
                      Leave all provider attributes unchanged
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
                {prepared.patch && Object.keys(prepared.patch).length === 0 ? (
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
                      {item.fields.length
                        ? item.fields.map(previewFieldLabel).join(", ")
                        : "No changes"}
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
          {changeAttributes && attributeError && (
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
              (changeAttributes && Boolean(attributeError))
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
