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
  listingRequirementsSchema,
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
import {
  buildSchemaFieldModel,
  type SchemaFieldNode,
} from "./schema-field-model";
import { commonBulkContext } from "./bulk-edit-model";
import { buildBulkFieldPatch, projectBulkField } from "./bulk-field-state";
import {
  previewBulkEditBatch,
  resetBulkAttributeEdits,
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
  const [attributeResetRevision, setAttributeResetRevision] = useState(0);
  const [savedRevision, setSavedRevision] = useState(0);
  const [showCategory, setShowCategory] = useState(false);
  const [showChanges, setShowChanges] = useState(false);
  const context = commonBulkContext(items, command.shared);
  const taxonomy = useQuery({
    queryKey: [base, "taxonomy"],
    enabled: active,
    queryFn: () =>
      publicationRequest("GET", `${base}/taxonomy`, listingTaxonomySchema),
  });
  const requirements = useQuery({
    queryKey: [base, "requirements", context?.productType, context?.method],
    enabled: active && context !== null,
    queryFn: () =>
      publicationRequest(
        "GET",
        `${base}/requirements?${new URLSearchParams({ productType: context!.productType, method: context!.method })}`,
        listingRequirementsSchema,
      ),
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
  const hasEdits =
    Object.keys(command.shared).length > 0 || command.itemChanges.length > 0;
  useEffect(() => {
    onDirtyChange(hasEdits || Boolean(tableError));
  }, [hasEdits, tableError, onDirtyChange]);
  const tableValidity = useCallback(
    (failure: string | null) => setTableError(failure),
    [],
  );
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
  function pathLabel(path: readonly string[]): string {
    if (path[0] !== "attributes")
      return path
        .map((key) => FIELD_LABELS[key] ?? labelForKey(key))
        .join(" › ");
    const attributes = path.slice(1);
    return attributes
      .map(
        (key, index) =>
          attributeTitles.get(JSON.stringify(attributes.slice(0, index + 1))) ??
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
    let resetsAttributes = false;
    const accepted = edit((previous) => {
      const shared = { ...previous.shared };
      if (value === undefined) delete shared[field];
      else if (field === "method")
        shared.method = value as ListingDraftItem["method"];
      else shared.productType = value;
      const next = { ...previous, shared };
      const nextContext = commonBulkContext(items, shared);
      if (
        context?.method !== nextContext?.method ||
        context?.productType !== nextContext?.productType
      ) {
        resetsAttributes = true;
        return resetBulkAttributeEdits(next);
      }
      return next;
    });
    if (accepted && resetsAttributes)
      setAttributeResetRevision((revision) => revision + 1);
  }
  const attributeEdits = Boolean(
    command.shared.attributeChanges?.length ||
      command.itemChanges.some((item) => item.patch.attributeChanges?.length),
  );
  const schemaUnavailable =
    attributeEdits && (requirements.isFetching || Boolean(requirements.error));
  async function save() {
    if (!canEdit || saving || tableError || prepared.error || schemaUnavailable)
      return;
    setError("");
    setNotice("");
    try {
      await onSave(commandRef.current);
      commandRef.current = EMPTY_COMMAND;
      setCommand(EMPTY_COMMAND);
      setTableError(null);
      setSavedRevision((revision) => revision + 1);
      onDirtyChange(false);
      setNotice("Draft saved. Nothing has been published to Walmart.");
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  const method = projectBulkField(items, metadata, "method");
  const type = projectBulkField(items, metadata, "productType");
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
              Boolean(tableError) ||
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
              disabled={!canEdit || saving || Boolean(tableError)}
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
                disabled={!canEdit || saving || Boolean(tableError)}
                onClick={() => changeContext("method", undefined)}
              >
                Undo method
              </Button>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="font-medium">Category</span>
            <span className="max-w-80 truncate">
              {command.shared.productType ??
                (type.status === "common" && type.value
                  ? type.value
                  : "Choose a shared category")}
            </span>
            <Button
              variant="outline"
              size="sm"
              aria-expanded={showCategory}
              onClick={() => setShowCategory((value) => !value)}
            >
              {showCategory ? "Close category browser" : "Choose category"}
            </Button>
            {command.shared.productType !== undefined && (
              <Button
                variant="ghost"
                size="sm"
                disabled={!canEdit || saving || Boolean(tableError)}
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
              label="Shared Walmart product type"
              value={
                command.shared.productType ??
                (type.status === "common" ? type.value : "")
              }
              taxonomy={taxonomy.data}
              loading={taxonomy.isFetching}
              error={taxonomy.error ? errorMessage(taxonomy.error) : undefined}
              disabled={!canEdit || saving || Boolean(tableError)}
              onRetry={() => void taxonomy.refetch()}
              onSelect={(value) => {
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
            Edit product fields now. Choose a common category and method to load
            Walmart-specific columns.
          </p>
        )}
        {requirements.isFetching && (
          <p role="status" className="text-xs text-muted-foreground">
            Loading Walmart requirements…
          </p>
        )}
        {requirements.error && (
          <p role="alert" className="text-xs text-destructive">
            {errorMessage(requirements.error)}{" "}
            <Button
              variant="link"
              size="sm"
              onClick={() => void requirements.refetch()}
            >
              Retry requirements
            </Button>
          </p>
        )}
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
            schema={context ? requirements.data?.schema : undefined}
            providerFieldsDisabled={
              requirements.isFetching || Boolean(requirements.error)
            }
            sharedPatch={command.shared}
            itemChanges={command.itemChanges}
            attributeResetRevision={attributeResetRevision}
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
                          {pathLabel(change.path)}:{" "}
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
