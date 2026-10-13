import { Fragment, useId, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Pencil,
} from "lucide-react";
import type {
  ChannelCatalogRow,
  ChannelCatalogStockItem,
} from "@shared/types/channel-catalog";
import type { ListingLifecycleView } from "@shared/types/channel-listing-lifecycle";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ListingFeedRow } from "./feed-model";
import { listingPrice, listingStatus, listingTitle } from "./feed-presentation";
import { money } from "./model";
import { ListingFeedDetails } from "./ListingFeedDetails";
import type { ListingLifecycleSelection } from "./ListingLifecycleActions";

export function ChannelListingFeedRow({
  row,
  canEdit,
  locked,
  selected,
  selectable,
  onSelect,
  onEdit,
  onEditExisting,
  onRecreate,
  onRemove,
  onMatch,
  onActivity,
  lifecycle,
  lifecycleReady = false,
  onLifecycle,
  onCheckLifecycle,
  stock,
  stockLoading,
  stockError,
}: {
  row: ListingFeedRow;
  canEdit: boolean;
  locked: boolean;
  selected: boolean;
  selectable: boolean;
  onSelect(checked: boolean): void;
  onEdit(variantId: number): void;
  onEditExisting(sku: string): void;
  onRecreate(operationId: string, sku: string): void;
  onRemove(variantId: number): void;
  onMatch(item: ChannelCatalogRow): void;
  onActivity(): void;
  lifecycle?: ListingLifecycleView;
  lifecycleReady?: boolean;
  onLifecycle?(selection: ListingLifecycleSelection): void;
  onCheckLifecycle?(): void;
  stock?: ChannelCatalogStockItem;
  stockLoading: boolean;
  stockError?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const { draft, remote, operation } = row;
  const title = listingTitle(row, lifecycle);
  const status = listingStatus(row, lifecycle);
  const price = listingPrice(row);
  const identity =
    row.sku ?? `variant ${draft?.variantId ?? operation?.item.variantId}`;
  const existingListing = remote
    ? remote.lifecycleStatus.toUpperCase() === "ACTIVE"
    : operation && ["accepted", "verified"].includes(operation.item.state);
  const canEditExisting =
    !draft && !lifecycle && !row.missingOnWalmart && existingListing && row.sku && canEdit;
  const canRecreate =
    !draft &&
    !lifecycle &&
    row.sku &&
    canEdit &&
    operation &&
    ["accepted", "verified"].includes(operation.item.state);
  const canMatch =
    remote &&
    !lifecycle &&
    !row.missingOnWalmart &&
    canEdit &&
    !row.issue &&
    ["matched", "unmatched"].includes(remote.mappingStatus);
  const canStop =
    !draft &&
    row.sku &&
    canEdit &&
    onLifecycle &&
    lifecycle?.action !== "remove";
  const canCheckStop = canEdit && lifecycle && lifecycle.state !== "retired";
  const hasMenu = !!(
    operation ||
    (draft && canEdit) ||
    canMatch ||
    canStop ||
    canCheckStop
  );
  const stockLabel = stockError || row.missingOnWalmart
    ? "—"
    : stock?.quantity != null
      ? stock.quantity.toLocaleString()
      : stockLoading
        ? "Checking…"
        : "—";
  return (
    <Fragment>
      <tr
        data-listing-sku={row.sku ?? undefined}
        data-state={selected ? "selected" : undefined}
        className={`grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 border-t p-3 first:border-t-0 @4xl/feed:table-row @4xl/feed:p-0 ${expanded || selected ? "bg-muted/40" : "hover:bg-muted/20"}`}
      >
        {canEdit && (
          <td className="col-start-1 row-start-1 block @4xl/feed:table-cell @4xl/feed:w-10 @4xl/feed:px-3 @4xl/feed:py-3">
            <Checkbox
              aria-label={`Select ${identity}`}
              checked={selected}
              disabled={locked || !selectable}
              onCheckedChange={(value) => onSelect(value === true)}
            />
          </td>
        )}
        <td
          className={`${canEdit ? "col-start-2" : "col-span-2 col-start-1"} row-start-1 block min-w-0 @4xl/feed:table-cell @4xl/feed:px-2 @4xl/feed:py-3`}
        >
          <p
            className="line-clamp-2 font-medium leading-5 [overflow-wrap:anywhere]"
            title={title}
          >
            {title}
          </p>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
            {row.sku ?? "SKU unavailable"}
          </p>
        </td>
        <td className="col-start-2 row-start-2 block @4xl/feed:table-cell @4xl/feed:px-3 @4xl/feed:py-3">
          <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.tone === "good" ? "bg-green-600" : status.tone === "attention" ? "bg-destructive" : "bg-muted-foreground"}`}
            />
            {status.label}
          </span>
          {(row.issue ||
            (draft?.images === null && !!row.catalog?.imageIssues?.length)) && (
            <span className="block text-[11px] text-destructive">
              Review details
            </span>
          )}
        </td>
        <td className="col-start-2 row-start-3 block text-xs tabular-nums @4xl/feed:table-cell @4xl/feed:px-3 @4xl/feed:py-3 @4xl/feed:text-right @4xl/feed:text-sm">
          <span className="mr-1 text-muted-foreground @4xl/feed:hidden">
            Price
          </span>
          <span className="font-medium">
            {price.cents === null ? "—" : money(price.cents)}
          </span>
          {price.source !== "Walmart" && (
            <span className="ml-1 text-[11px] text-muted-foreground @4xl/feed:ml-0 @4xl/feed:block">
              {price.source}
            </span>
          )}
        </td>
        <td className="col-start-3 row-start-3 block text-right text-xs tabular-nums @4xl/feed:table-cell @4xl/feed:px-3 @4xl/feed:py-3 @4xl/feed:text-sm">
          <span className="mr-1 text-muted-foreground @4xl/feed:hidden">
            Walmart stock
          </span>
          <span
            aria-label={`Walmart stock for ${identity}`}
            className="font-medium"
          >
            {stockLabel}
          </span>
          {(stock?.error || stockError) && (
            <span className="ml-1 text-[11px] text-muted-foreground @4xl/feed:ml-0 @4xl/feed:block">
              Unavailable
            </span>
          )}
        </td>
        <td className="col-start-3 row-span-2 row-start-1 block self-start @4xl/feed:table-cell @4xl/feed:align-middle @4xl/feed:px-2 @4xl/feed:py-2">
          <div className="flex justify-end gap-0.5">
            {(draft || canEditExisting) && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                disabled={locked}
                aria-label={
                  draft
                    ? `${canEdit ? "Edit" : "View"} ${identity}`
                    : `Edit listing ${identity}`
                }
                title={draft ? "Edit details" : "Edit listing"}
                onClick={() =>
                  draft ? onEdit(draft.variantId) : onEditExisting(row.sku!)
                }
              >
                <Pencil className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-expanded={expanded}
              aria-controls={detailsId}
              aria-label={`${expanded ? "Hide" : "Show"} details for ${identity}`}
              title="Listing details"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </Button>
            {hasMenu && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    disabled={locked}
                    aria-label={`More actions for ${identity}`}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {operation && (
                    <DropdownMenuItem onSelect={onActivity}>
                      View activity
                    </DropdownMenuItem>
                  )}
                  {canRecreate && (
                    <DropdownMenuItem
                      onSelect={() => onRecreate(operation!.id, row.sku!)}
                    >
                      Recreate on Walmart
                    </DropdownMenuItem>
                  )}
                  {canMatch && (
                    <DropdownMenuItem onSelect={() => onMatch(remote)}>
                      Choose variant
                    </DropdownMenuItem>
                  )}
                  {draft && canEdit && (
                    <DropdownMenuItem
                      onSelect={() => onRemove(draft.variantId)}
                    >
                      Remove from draft
                    </DropdownMenuItem>
                  )}
                  {canCheckStop && (
                    <DropdownMenuItem
                      disabled={!lifecycleReady}
                      onSelect={onCheckLifecycle}
                    >
                      Check unpublish status
                    </DropdownMenuItem>
                  )}
                  {canStop && (
                    <>
                      {(operation || canMatch || canCheckStop) && (
                        <DropdownMenuSeparator />
                      )}
                      {!lifecycle && (
                        <DropdownMenuItem
                          disabled={!lifecycleReady}
                          onSelect={() =>
                            onLifecycle({
                              sku: row.sku!,
                              title,
                              action: "unpublish",
                            })
                          }
                        >
                          Unpublish from Walmart
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        disabled={!lifecycleReady}
                        className="text-destructive focus:text-destructive"
                        onSelect={() =>
                          onLifecycle({
                            sku: row.sku!,
                            title,
                            action: "remove",
                          })
                        }
                      >
                        Remove from Echelon
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="block border-t bg-muted/20 @4xl/feed:table-row">
          <td
            colSpan={canEdit ? 6 : 5}
            className="block min-w-0 p-4 @4xl/feed:table-cell"
          >
            <div
              id={detailsId}
              role="region"
              aria-label={`Details for ${identity}`}
            >
              <ListingFeedDetails
                row={row}
                lifecycle={lifecycle}
                stock={stock}
                stockError={stockError}
              />
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
