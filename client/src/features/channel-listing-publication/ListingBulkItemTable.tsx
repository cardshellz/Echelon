import { useEffect, useMemo, useState } from "react";
import type {
  ListingCatalogItem,
  ListingDraftItem,
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
import { SchemaFields } from "./SchemaFields";
import { fieldValueAtPath, type FieldSchema } from "./schema-field-model";
import { buildBulkAttributeColumns } from "./bulk-attribute-columns";
import { ListingBulkAttributeCell } from "./ListingBulkAttributeCell";
import type { BulkEditPatch } from "./bulk-edit-model";

const ROWS_PER_PAGE = 25;
type ItemChange = { variantId: number; patch: BulkEditPatch };
interface Props {
  items: readonly ListingDraftItem[];
  metadata: ReadonlyMap<number, ListingCatalogItem>;
  schema: FieldSchema;
  itemChanges: readonly ItemChange[];
  canEdit: boolean;
  onItemAttribute(
    variantId: number,
    path: readonly string[],
    value: unknown,
  ): boolean;
  onSharedAttribute(path: readonly string[], value: unknown): boolean;
  onUndoItemAttribute(variantId: number, path: readonly string[]): void;
  onUndoItem(variantId: number): void;
  onValidityChange(error: string | null): void;
}
type HeaderValue = { value: unknown; pending: boolean };

export function ListingBulkItemTable({
  items,
  metadata,
  schema,
  itemChanges,
  canEdit,
  onItemAttribute,
  onSharedAttribute,
  onUndoItemAttribute,
  onUndoItem,
  onValidityChange,
}: Props) {
  const model = useMemo(
    () =>
      buildBulkAttributeColumns(
        schema,
        items.map((item) => item.attributes),
      ),
    [schema, items],
  );
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string> | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [headerValues, setHeaderValues] = useState<
    ReadonlyMap<string, HeaderValue>
  >(new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [bufferRevisions, setBufferRevisions] = useState<
    ReadonlyMap<string, number>
  >(new Map());
  const selected = selectedKeys ?? new Set(model.defaultColumnKeys);
  const columns = model.columns.filter((column) => selected.has(column.key));
  const hiddenRequired = model.columns.filter(
    (column) => column.required && !selected.has(column.key),
  );
  const choices = model.columns.filter((column) =>
    query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((token) => column.pathLabel.toLowerCase().includes(token)),
  );
  const groups: Array<{ label: string; count: number }> = [];
  for (const column of columns) {
    const previous = groups[groups.length - 1];
    if (previous?.label === column.group) previous.count++;
    else groups.push({ label: column.group, count: 1 });
  }
  const pending = [...headerValues.values()].some((value) => value.pending);
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(items.length / ROWS_PER_PAGE) - 1),
  );
  const offset = currentPage * ROWS_PER_PAGE;
  const rows = items.slice(offset, offset + ROWS_PER_PAGE);
  const detailItem = items.find((item) => item.variantId === detailId);
  const skuFor = (item: ListingDraftItem) =>
    metadata.get(item.variantId)?.sku ?? `Variant ${item.variantId}`;
  useEffect(() => {
    onValidityChange(
      errors.size
        ? "Correct invalid table values before applying the draft changes."
        : pending
          ? "Apply or discard pending column values before applying the draft changes."
          : null,
    );
  }, [errors, pending, onValidityChange]);
  function validity(key: string, error: string | null) {
    setErrors((previous) => {
      if ((previous.get(key) ?? null) === error) return previous;
      const next = new Map(previous);
      if (error) next.set(key, error);
      else next.delete(key);
      return next;
    });
  }
  function toggleColumn(key: string, checked: boolean) {
    setSelectedKeys((previous) => {
      const next = new Set(previous ?? model.defaultColumnKeys);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }
  function discardHeader(key: string) {
    setHeaderValues((previous) => {
      const next = new Map(previous);
      next.delete(key);
      return next;
    });
    validity(`header:${key}`, null);
    setBufferRevisions((previous) =>
      new Map(previous).set(
        `header:${key}`,
        (previous.get(`header:${key}`) ?? 0) + 1,
      ),
    );
  }
  function discardInvalidCell(key: string) {
    validity(key, null);
    setBufferRevisions((previous) =>
      new Map(previous).set(key, (previous.get(key) ?? 0) + 1),
    );
  }
  function discardInvalidValues() {
    const invalidKeys = [...errors.keys()];
    setHeaderValues((previous) => {
      const next = new Map(previous);
      for (const key of invalidKeys)
        if (key.startsWith("header:")) next.delete(key.slice("header:".length));
      return next;
    });
    setBufferRevisions((previous) => {
      const next = new Map(previous);
      for (const key of invalidKeys) next.set(key, (next.get(key) ?? 0) + 1);
      return next;
    });
    setErrors(new Map());
  }
  return (
    <section
      className="min-w-0 space-y-3"
      aria-label="Per-item listing attributes"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">Item attributes</h3>
          <p className="text-xs text-muted-foreground">
            Edit each row directly. Column changes apply to all {items.length}{" "}
            selected items, including other pages.
          </p>
        </div>
        <details className="min-w-0 rounded-md border p-2">
          <summary className="cursor-pointer text-sm font-medium">
            Choose columns ({columns.length})
          </summary>
          <div className="mt-3 space-y-2">
            <Input
              aria-label="Search attribute columns"
              placeholder="Find a column"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="max-h-64 max-w-sm space-y-2 overflow-y-auto">
              {choices.map((column) => (
                <label
                  key={column.key}
                  className="flex items-start gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    disabled={errors.size > 0 || pending}
                    checked={selected.has(column.key)}
                    onChange={(event) =>
                      toggleColumn(column.key, event.target.checked)
                    }
                  />
                  <span className="break-words">
                    {column.pathLabel}
                    {column.required &&
                      (column.requiredForSome
                        ? " (required for some items)"
                        : " (required)")}
                  </span>
                </label>
              ))}
              {choices.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No columns match this search.
                </p>
              )}
            </div>
          </div>
        </details>
      </div>
      {hiddenRequired.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <p>
            {hiddenRequired.length} required{" "}
            {hiddenRequired.length === 1 ? "column is" : "columns are"} hidden.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={errors.size > 0 || pending}
            onClick={() =>
              setSelectedKeys(
                new Set([
                  ...selected,
                  ...hiddenRequired.map((column) => column.key),
                ]),
              )
            }
          >
            Show required columns
          </Button>
        </div>
      )}
      {errors.size > 0 && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            Correct or discard invalid cell values before changing pages, hiding
            columns, or editing other fields.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={discardInvalidValues}
          >
            Discard all invalid cell values
          </Button>
        </div>
      )}
      {pending && (
        <p className="text-sm text-muted-foreground">
          Apply or discard the pending column value before editing rows or
          changing pages.
        </p>
      )}
      {model.warnings.map((warning) => (
        <p key={warning} className="text-xs text-muted-foreground">
          {warning}
        </p>
      ))}
      {model.hasRowDetails && (
        <p className="text-xs text-muted-foreground">
          Lists, nested groups and fields with different requirements are
          available in each row's Details.
        </p>
      )}
      <div className="max-h-[55dvh] max-w-full overflow-auto rounded-md border">
        <table
          className="min-w-full text-sm"
          aria-label="Draft item attributes"
        >
          <thead className="sticky top-0 z-20 bg-background">
            <tr className="border-b bg-muted/40">
              <th
                rowSpan={2}
                className="sticky left-0 z-20 w-32 min-w-32 max-w-32 border-r bg-background p-3 text-left sm:w-48 sm:min-w-48 sm:max-w-56"
              >
                Draft item
              </th>
              {groups.map((group, index) => (
                <th
                  key={`${group.label}-${index}`}
                  colSpan={group.count}
                  className="border-r px-3 py-2 text-left text-xs font-medium"
                >
                  {group.label || "Product attributes"}
                </th>
              ))}
              <th rowSpan={2} className="px-3 text-left">
                Details
              </th>
            </tr>
            <tr className="border-b bg-muted/20">
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className="min-w-56 border-r px-3 py-2 text-left font-medium"
                >
                  {column.label}
                  {column.required && (
                    <span
                      className="ml-1 text-destructive"
                      title={
                        column.requiredForSome
                          ? "Required for some selected items"
                          : "Required"
                      }
                    >
                      *
                    </span>
                  )}
                </th>
              ))}
            </tr>
            <tr className="border-b">
              <th className="sticky left-0 z-20 w-32 min-w-32 max-w-32 border-r bg-background p-3 text-left align-top text-xs font-medium sm:w-48 sm:min-w-48 sm:max-w-56">
                Set a value for all selected items
              </th>
              {columns.map((column) => {
                const header = headerValues.get(column.key);
                return (
                  <td
                    key={column.key}
                    className="min-w-56 space-y-2 border-r p-3 align-top"
                  >
                    <ListingBulkAttributeCell
                      key={bufferRevisions.get(`header:${column.key}`) ?? 0}
                      column={column}
                      value={header?.value}
                      sku="all selected items"
                      disabled={
                        !canEdit ||
                        !column.appliesToAll ||
                        (pending && !header?.pending) ||
                        (errors.size > 0 && !errors.has(`header:${column.key}`))
                      }
                      onChange={(value) =>
                        setHeaderValues((previous) =>
                          new Map(previous).set(column.key, {
                            value,
                            pending: true,
                          }),
                        )
                      }
                      onValidityChange={(error) =>
                        validity(`header:${column.key}`, error)
                      }
                    />
                    {!column.appliesToAll && (
                      <p className="text-xs text-muted-foreground">
                        Applies only to some rows. Edit those items
                        individually.
                      </p>
                    )}
                    <div className="flex flex-wrap gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={
                          !canEdit ||
                          !column.appliesToAll ||
                          !header?.pending ||
                          errors.size > 0
                        }
                        onClick={() => {
                          if (!header || !canEdit) return;
                          if (onSharedAttribute(column.path, header.value))
                            discardHeader(column.key);
                        }}
                      >
                        {header?.pending && header.value === undefined
                          ? `Clear ${column.label} for all`
                          : `Apply ${column.label} to all`}
                      </Button>
                      {(header?.pending ||
                        errors.has(`header:${column.key}`)) && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Discard ${column.pathLabel} column value`}
                          onClick={() => discardHeader(column.key)}
                        >
                          Discard
                        </Button>
                      )}
                    </div>
                  </td>
                );
              })}
              <td />
            </tr>
          </thead>
          <tbody>
            {rows.map((item, rowIndex) => {
              const sku = skuFor(item);
              const changes =
                itemChanges.find(
                  (change) => change.variantId === item.variantId,
                )?.patch.attributeChanges ?? [];
              const required = new Set(
                model.requiredKeysByRow[offset + rowIndex],
              );
              const applicable = new Set(
                model.applicableKeysByRow[offset + rowIndex],
              );
              return (
                <tr key={item.variantId} className="border-b last:border-b-0">
                  <th
                    scope="row"
                    className="sticky left-0 z-10 w-32 min-w-32 max-w-32 border-r bg-background p-3 text-left align-top sm:w-48 sm:min-w-48 sm:max-w-56"
                  >
                    <p className="break-words font-medium">{sku}</p>
                    <p className="mt-1 break-words text-xs font-normal text-muted-foreground">
                      {metadata.get(item.variantId)?.name}
                    </p>
                  </th>
                  {columns.map((column) => {
                    const key = `${item.variantId}:${column.key}`;
                    return (
                      <td
                        key={column.key}
                        className="min-w-56 space-y-1 border-r p-3 align-top"
                      >
                        {applicable.has(column.key) ? (
                          <ListingBulkAttributeCell
                            key={bufferRevisions.get(key) ?? 0}
                            column={column}
                            value={fieldValueAtPath(
                              item.attributes,
                              column.path,
                            )}
                            sku={sku}
                            disabled={
                              !canEdit ||
                              pending ||
                              (errors.size > 0 && !errors.has(key))
                            }
                            required={required.has(column.key)}
                            onChange={(value) =>
                              onItemAttribute(
                                item.variantId,
                                column.path,
                                value,
                              )
                            }
                            onValidityChange={(error) => validity(key, error)}
                          />
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            Not used for this item
                          </p>
                        )}
                        {errors.has(key) && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={`Discard invalid ${column.pathLabel} value for ${sku}`}
                            onClick={() => discardInvalidCell(key)}
                          >
                            Discard invalid value
                          </Button>
                        )}
                        {changes.some(
                          (change) =>
                            JSON.stringify(change.path) === column.key,
                        ) && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={!canEdit || errors.size > 0 || pending}
                            aria-label={`Undo ${column.pathLabel} change for ${sku}`}
                            onClick={() =>
                              onUndoItemAttribute(item.variantId, column.path)
                            }
                          >
                            Undo change
                          </Button>
                        )}
                      </td>
                    );
                  })}
                  <td className="p-3 align-top">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={errors.size > 0 || pending}
                      aria-label={`Edit attributes for ${sku}`}
                      onClick={() => setDetailId(item.variantId)}
                    >
                      Details
                    </Button>
                    {changes.length > 0 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={!canEdit || errors.size > 0 || pending}
                        aria-label={`Undo all attribute changes for ${sku}`}
                        onClick={() => onUndoItem(item.variantId)}
                      >
                        Undo row changes
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <p>
          Showing {items.length ? offset + 1 : 0}–
          {Math.min(offset + ROWS_PER_PAGE, items.length)} of {items.length}{" "}
          selected items
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={errors.size > 0 || pending || currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous draft rows
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              errors.size > 0 ||
              pending ||
              offset + ROWS_PER_PAGE >= items.length
            }
            onClick={() => setPage(currentPage + 1)}
          >
            Next draft rows
          </Button>
        </div>
      </div>
      {detailItem && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setDetailId(null);
          }}
        >
          <DialogContent className="flex max-h-[85dvh] max-w-3xl flex-col overflow-hidden">
            <DialogHeader className="shrink-0">
              <DialogTitle>Attributes for {skuFor(detailItem)}</DialogTitle>
              <DialogDescription>
                Changes apply to this draft item only. Shared column values
                remain the fallback when you undo a row change.
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 overflow-y-auto">
              <SchemaFields
                schema={schema}
                value={detailItem.attributes}
                disabled={!canEdit}
                onChange={() => {
                  /* Exact path changes below preserve unrelated per-item values. */
                }}
                onFieldChange={(path, value) =>
                  onItemAttribute(detailItem.variantId, path, value)
                }
              />
            </div>
            <DialogFooter className="shrink-0">
              <Button type="button" onClick={() => setDetailId(null)}>
                Done
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
