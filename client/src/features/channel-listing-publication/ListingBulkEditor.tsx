import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Loader2 } from "lucide-react";
import {
  listingTaxonomySchema,
  type ListingCatalogItem,
  type ListingDraftItem,
} from "@shared/types/channel-listing-publication";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { publicationRequest } from "./api";
import { errorMessage, labelForKey, money } from "./model";
import { ListingProductTypePicker } from "./ListingProductTypePicker";
import { ListingBulkItemTable } from "./ListingBulkItemTable";
import { useBulkRowRequirements } from "./use-bulk-row-requirements";
import {
  buildSchemaFieldModel,
  type SchemaFieldNode,
} from "./schema-field-model";
import { commonBulkContext } from "./bulk-edit-model";
import { buildBulkFieldPatch, projectBulkField } from "./bulk-field-state";
import {
  previewBulkEditBatch,
  setBulkSharedContext,
  setBulkItemAttribute,
  setBulkSharedAttribute,
  undoBulkItemAttribute,
  setBulkItemField,
  undoBulkItemField,
  setBulkSharedField,
  type BulkEditCommand,
} from "./bulk-edit-batch";

const EMPTY_COMMAND: BulkEditCommand = { shared: {}, itemChanges: [] };
const FIELD_LABELS: Record<string, string> = {
  method: "Listing method",
  productType: "Product type",
  priceOverrideCents: "Fixed price",
  title: "Title",
  description: "Description",
  brand: "Brand",
  images: "Images",
  identifier: "Product identifier",
};
export interface ListingBulkEditorProps {
  base: string;
  items: readonly ListingDraftItem[];
  metadata: ReadonlyMap<number, ListingCatalogItem>;
  canEdit: boolean;
  saving: boolean;
  hasDraftChanges: boolean;
  active: boolean;
  onClose(): void;
  onSave(command: BulkEditCommand): Promise<void>;
  onDirtyChange(dirty: boolean): void;
}

/** Full-page draft workbench. Only the workspace owner persists the complete
 * local command; this component never writes to the marketplace. */
export function ListingBulkEditor({
  base,
  items,
  metadata,
  canEdit,
  saving,
  hasDraftChanges,
  active,
  onClose,
  onSave,
  onDirtyChange,
}: ListingBulkEditorProps) {
  const prefix = useId();
  const [command, setCommand] = useState<BulkEditCommand>(EMPTY_COMMAND);
  const commandRef = useRef(command);
  commandRef.current = command;
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tableError, setTableError] = useState<string | null>(null);
  // Pending defaults use field-local Apply/Discard controls, not error alerts.
  const [hasPendingDefaults, setHasPendingDefaults] = useState(false);
  const tableBlocked = Boolean(tableError) || hasPendingDefaults;
  const [savedRevision, setSavedRevision] = useState(0);
  const [showCategory, setShowCategory] = useState(false);
  const [categoryVariantId, setCategoryVariantId] = useState<number | null>(
    null,
  );
  const [showChanges, setShowChanges] = useState(false);
  const taxonomy = useQuery({
    queryKey: [base, "taxonomy"],
    enabled: active,
    queryFn: () =>
      publicationRequest("GET", `${base}/taxonomy`, listingTaxonomySchema),
  });
  const prepared = useMemo(() => {
    try {
      return { ...previewBulkEditBatch(items, command), error: "" };
    } catch (failure) {
      return {
        effectiveItems: items,
        preview: null,
        error: errorMessage(failure),
      };
    }
  }, [items, command]);
  const context = commonBulkContext(prepared.effectiveItems);
  const requirements = useBulkRowRequirements(
    base,
    prepared.effectiveItems,
    active,
  );
  const categoryItem =
    categoryVariantId === null
      ? undefined
      : prepared.effectiveItems.find(
          (item) => item.variantId === categoryVariantId,
        );
  const hasEdits =
    Object.keys(command.shared).length > 0 || command.itemChanges.length > 0;
  useEffect(() => {
    onDirtyChange(hasEdits || tableBlocked);
  }, [hasEdits, tableBlocked, onDirtyChange]);
  const tableValidity = useCallback(
    (failure: string | null, pendingDefaults: boolean) => {
      setTableError(failure);
      setHasPendingDefaults(pendingDefaults);
    },
    [],
  );
  const attributeTitles = useMemo(() => {
    const allTitles = new Map<number, Map<string, string>>();
    for (const item of prepared.effectiveItems) {
      const schema = requirements.byVariant.get(item.variantId)?.schema;
      if (!schema) continue;
      const titles = new Map<string, string>();
      const visit = (node: SchemaFieldNode) => {
        if (typeof node.schema.title === "string" && node.schema.title.trim())
          titles.set(JSON.stringify(node.path), node.schema.title);
        node.children.forEach(visit);
      };
      visit(buildSchemaFieldModel(schema, item.attributes).root);
      allTitles.set(item.variantId, titles);
    }
    return allTitles;
  }, [requirements.byVariant, prepared.effectiveItems]);
  function pathLabel(path: readonly string[], variantId: number): string {
    if (path[0] !== "attributes")
      return path
        .map((key) => FIELD_LABELS[key] ?? labelForKey(key))
        .join(" › ");
    const attributes = path.slice(1);
    return attributes
      .map(
        (key, index) =>
          attributeTitles
            .get(variantId)
            ?.get(JSON.stringify(attributes.slice(0, index + 1))) ??
          labelForKey(key),
      )
      .join(" › ");
  }
  function valueLabel(value: unknown, path: readonly string[]): string {
    if (value === undefined) return "Not set";
    if (value === null)
      return path[0] === "attributes" ? "null" : "Use catalog / pricing";
    if (path[0] === "priceOverrideCents" && typeof value === "number")
      return money(value);
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  function edit(
    update: (current: BulkEditCommand) => BulkEditCommand,
  ): boolean {
    if (!canEdit || saving) return false;
    try {
      const next = update(commandRef.current);
      previewBulkEditBatch(items, next);
      commandRef.current = next;
      setCommand(next);
      setError("");
      setNotice("");
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    }
  }
  function changeContext(
    field: "method" | "productType",
    value: string | undefined,
  ) {
    edit((previous) => setBulkSharedContext(items, previous, field, value));
  }
  const schemaUnavailable = prepared.effectiveItems.some(
    (item) =>
      (Boolean(command.shared.attributeChanges?.length) ||
        command.itemChanges.some(
          (change) =>
            change.variantId === item.variantId &&
            Boolean(change.patch.attributeChanges?.length),
        )) &&
      requirements.byVariant.get(item.variantId)?.status !== "ready",
  );
  async function save() {
    if (!canEdit || saving || tableBlocked || prepared.error || schemaUnavailable)
      return;
    setError("");
    setNotice("");
    try {
      await onSave(commandRef.current);
      commandRef.current = EMPTY_COMMAND;
      setCommand(EMPTY_COMMAND);
      setTableError(null);
      setHasPendingDefaults(false);
      setSavedRevision((revision) => revision + 1);
      onDirtyChange(false);
      setNotice("Draft saved. Nothing has been published to Walmart.");
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  const method = projectBulkField(items, metadata, "method");
  const type = projectBulkField(items, metadata, "productType");
  const effectiveType = projectBulkField(
    prepared.effectiveItems,
    metadata,
    "productType",
  );
  const missingCategoryCount = prepared.effectiveItems.filter(
    (item) => item.method === "create" && !item.productType,
  ).length;
  return (
    <section
      aria-label="Bulk listing workspace"
      className="flex h-full min-h-0 w-full flex-col bg-background"
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-3 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Back to listing feed"
            disabled={saving}
            onClick={onClose}
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-lg font-semibold">Edit Walmart listings</h1>
            <p className="text-xs text-muted-foreground">
              {items.length} selected draft{" "}
              {items.length === 1 ? "item" : "items"} · Changes stay in draft
              until reviewed and published.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            aria-expanded={showChanges}
            onClick={() => setShowChanges((value) => !value)}
          >
            Changes ({prepared.preview?.changedCount ?? 0})
          </Button>
          <Button
            type="button"
            disabled={
              !canEdit ||
              saving ||
              (!prepared.preview?.changedCount && !hasDraftChanges) ||
              tableBlocked ||
              Boolean(prepared.error) ||
              schemaUnavailable
            }
            onClick={() => void save()}
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {saving ? "Saving draft…" : "Save draft"}
          </Button>
        </div>
      </header>
      <div className="shrink-0 space-y-2 border-b px-3 py-2 sm:px-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <Label htmlFor={`${prefix}-method`}>Method</Label>
            <select
              id={`${prefix}-method`}
              aria-label="Bulk listing method"
              className="h-9 max-w-64 rounded-md border bg-background px-2 text-sm"
              disabled={!canEdit || saving || tableBlocked}
              value={
                command.shared.method ??
                (method.status === "common" ? method.value : "")
              }
              onChange={(event) =>
                changeContext(
                  "method",
                  event.target.value === method.value
                    ? undefined
                    : event.target.value,
                )
              }
            >
              {method.status !== "common" && (
                <option value="" disabled>
                  Multiple methods
                </option>
              )}
              <option value="create">Create product</option>
              <option value="match">Match Walmart catalog</option>
            </select>
            {command.shared.method !== undefined && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!canEdit || saving || tableBlocked}
                onClick={() => changeContext("method", undefined)}
              >
                Undo method
              </Button>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="font-medium">Category</span>
            <span className="max-w-80 truncate">
              {effectiveType.status === "common" && effectiveType.value
                ? effectiveType.value
                : missingCategoryCount
                  ? `${missingCategoryCount} ${missingCategoryCount === 1 ? "item needs" : "items need"} a category`
                  : "Mixed product types"}
            </span>
            <Button
              variant="outline"
              size="sm"
              aria-expanded={showCategory}
              onClick={() => {
                setCategoryVariantId(null);
                setShowCategory((value) => !value);
              }}
            >
              {showCategory ? "Close category browser" : "Choose category"}
            </Button>
            {command.shared.productType !== undefined && (
              <Button
                variant="ghost"
                size="sm"
                disabled={!canEdit || saving || tableBlocked}
                onClick={() => changeContext("productType", undefined)}
              >
                Undo category
              </Button>
            )}
          </div>
        </div>
        {showCategory && (
          <div className="max-h-[40dvh] overflow-auto">
            <ListingProductTypePicker
              label={
                categoryItem
                  ? `Product type for ${metadata.get(categoryItem.variantId)?.sku ?? `Variant ${categoryItem.variantId}`}`
                  : "Shared Walmart product type"
              }
              value={
                categoryItem?.productType ??
                command.shared.productType ??
                (type.status === "common" ? type.value : "")
              }
              taxonomy={taxonomy.data}
              loading={taxonomy.isFetching}
              error={taxonomy.error ? errorMessage(taxonomy.error) : undefined}
              disabled={!canEdit || saving || tableBlocked}
              onRetry={() => void taxonomy.refetch()}
              onSelect={(value) => {
                if (categoryItem) {
                  if (
                    value !== categoryItem.productType &&
                    command.shared.attributeChanges?.length
                  ) {
                    setError(
                      "Save the current draft before changing one item's category. This preserves the attribute values already applied to all selected items.",
                    );
                    return;
                  }
                  if (value !== categoryItem.productType)
                    edit((current) =>
                      setBulkItemField(
                        current,
                        categoryItem.variantId,
                        "productType",
                        value,
                      ),
                    );
                } else
                  changeContext(
                    "productType",
                    value === type.value ? undefined : value,
                  );
                setShowCategory(false);
              }}
            />
          </div>
        )}
        {prepared.preview && prepared.preview.resetCount > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Category or method changes clear prior provider attributes on{" "}
            {prepared.preview.resetCount} items. Other fields and identifiers
            are preserved.
          </p>
        )}
        {!context && (
          <p className="text-xs text-muted-foreground">
            Each item's category determines its attributes. Choose a category
            for any untyped items, or set one shared category above.
          </p>
        )}
        {requirements.loadingCount > 0 && (
          <p role="status" className="text-xs text-muted-foreground">
            Loading Walmart requirements…
          </p>
        )}
        {requirements.errors.map((failure) => (
          <p
            key={failure.key}
            role="alert"
            className="text-xs text-destructive"
          >
            {failure.label}: {failure.message}{" "}
            <Button variant="link" size="sm" onClick={failure.retry}>
              Retry requirements
            </Button>
          </p>
        ))}
        {(error || prepared.error || tableError) && (
          <p role="alert" className="text-sm text-destructive">
            {error || prepared.error || tableError}
          </p>
        )}
        {notice && (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ListingBulkItemTable
            key={savedRevision}
            items={prepared.effectiveItems}
            originalItems={items}
            metadata={metadata}
            requirementsByVariant={requirements.byVariant}
            sharedAttributesAllowed={
              commonBulkContext(prepared.effectiveItems) !== null &&
              prepared.effectiveItems.every(
                (item) =>
                  requirements.byVariant.get(item.variantId)?.status ===
                  "ready",
              )
            }
            onChooseCategory={(id) => {
              setCategoryVariantId(id);
              setShowCategory(true);
            }}
            sharedPatch={command.shared}
            itemChanges={command.itemChanges}
            canEdit={canEdit && !saving}
            onItemAttribute={(id, path, value) =>
              edit((current) => setBulkItemAttribute(current, id, path, value))
            }
            onSharedAttribute={(path, value, replace) =>
              edit((current) =>
                setBulkSharedAttribute(
                  current,
                  path,
                  value,
                  replace ? "replace-all" : "preserve-overrides",
                ),
              )
            }
            onUndoItemAttribute={(id, path) =>
              edit((current) => undoBulkItemAttribute(current, id, path))
            }
            onUndoItem={(id) =>
              edit((current) => ({
                ...current,
                itemChanges: current.itemChanges.filter(
                  (item) => item.variantId !== id,
                ),
              }))
            }
            onItemField={(id, field, value) =>
              edit((current) => setBulkItemField(current, id, field, value))
            }
            onUndoItemField={(id, field) =>
              edit((current) => undoBulkItemField(current, id, field))
            }
            onSharedField={(field, value, replace) =>
              edit((current) =>
                setBulkSharedField(
                  current,
                  field,
                  buildBulkFieldPatch({ [field]: value })[field],
                  replace ? "replace-all" : "preserve-overrides",
                ),
              )
            }
            onValidityChange={tableValidity}
          />
        </div>
        {showChanges && (
          <aside
            aria-label="Bulk edit preview"
            className="max-h-[35dvh] shrink-0 overflow-auto border-t p-4 lg:max-h-none lg:w-80 lg:border-l lg:border-t-0"
          >
            <h2 className="font-semibold">Changes to save</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {prepared.preview?.changedCount ?? 0} of {items.length} items
              changed. Saved in one draft update.
            </p>
            <ul
              className="mt-3 space-y-3 text-sm"
              aria-label="Selected draft changes"
            >
              {prepared.preview?.items
                .filter((item) => item.changes.length)
                .map((item) => (
                  <li key={item.variantId}>
                    <strong>
                      {metadata.get(item.variantId)?.sku ??
                        `Variant ${item.variantId}`}
                    </strong>
                    <ul className="mt-1 space-y-1">
                      {item.changes.map((change) => (
                        <li
                          key={JSON.stringify(change.path)}
                          className="break-words"
                        >
                          {pathLabel(change.path, item.variantId)}:{" "}
                          {valueLabel(change.before, change.path)} →{" "}
                          {valueLabel(change.after, change.path)}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
            </ul>
            {!prepared.preview?.changedCount && (
              <p className="mt-3 text-sm text-muted-foreground">
                No workbench changes yet.
              </p>
            )}
          </aside>
        )}
      </div>
    </section>
  );
}
