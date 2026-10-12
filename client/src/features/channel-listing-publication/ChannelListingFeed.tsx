import { useMemo, useState } from "react";
import {
  Link2,
  Loader2,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import type {
  ListingCatalogItem,
  ListingDraftItem,
  ListingOperation,
} from "@shared/types/channel-listing-publication";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { buildListingFeedRows, type ListingFeedRow } from "./feed-model";
import { MAX_DRAFT_ITEMS } from "./model";
import { catalogMapping, useChannelCatalog } from "./useChannelCatalog";
import { ChannelListingFeedRow } from "./ChannelListingFeedRow";
import { ChannelListingMatchDialog } from "./ChannelListingMatchDialog";
import {
  ListingLifecycleDialog,
  useListingLifecycle,
} from "./ListingLifecycleActions";
import {
  BulkListingLifecycleDialog,
  type BulkLifecycleSelection,
} from "./BulkListingLifecycleDialog";
import { lifecycleTargets } from "./feed-presentation";
import { useListingStock } from "./useListingStock";

const DISPLAY_INCREMENT = 50;
// The mapping API accepts at most 100 exact identities in one reviewed action.
const MAX_LISTING_SELECTION = 100;

export interface ChannelListingFeedProps {
  channelId: number;
  providerName: string;
  canEdit: boolean;
  draftItems: ListingDraftItem[];
  metadata: ReadonlyMap<number, ListingCatalogItem>;
  operations: ListingOperation[];
  busy: boolean;
  dirty: boolean;
  reviewBlocked?: boolean;
  selectedDraftIds: ReadonlySet<number>;
  onDraftSelectionChange(ids: ReadonlySet<number>): void;
  onBulkEdit(): void;
  onAdd(): void;
  onEdit(variantId: number): void;
  onEditExisting(sku: string): void;
  onRemove(variantId: number): void;
  onSave(): void;
  onReview(): void;
  onActivity(): void;
  onMappingsChanged?: () => Promise<void>;
  catalogError?: string;
}

export function ChannelListingFeed(props: ChannelListingFeedProps) {
  const { providerName, canEdit, draftItems, metadata, operations } = props;
  const catalog = useChannelCatalog(props);
  const [displayLimit, setDisplayLimit] = useState(DISPLAY_INCREMENT);
  const [bulkSelection, setBulkSelection] =
    useState<BulkLifecycleSelection | null>(null);
  const allRows = useMemo(
    () =>
      buildListingFeedRows({
        draftItems,
        metadata,
        operations,
        catalogItems: catalog.feed.data?.items ?? [],
        sku: catalog.sku,
      }),
    [draftItems, metadata, operations, catalog.feed.data, catalog.sku],
  );
  const lifecycle = useListingLifecycle(
    props.channelId,
    allRows.flatMap((row) => (row.sku ? [row.sku] : [])),
    providerName === "Walmart",
    catalog.sku,
  );
  const representedSkus = new Set(allRows.map((row) => row.sku));
  const retainedRows: ListingFeedRow[] = lifecycle.retained
    .filter((item) => !representedSkus.has(item.sku))
    .map((item) => ({
      key: `sku:${item.sku}`,
      sku: item.sku,
      draft: null,
      catalog: null,
      remote: null,
      operation: null,
      issue: null,
    }));
  const combinedRows = [...allRows, ...retainedRows];
  const removed = (sku: string | null) =>
    sku !== null &&
    lifecycle.bySku.get(sku)?.action === "remove" &&
    lifecycle.bySku.get(sku)?.state === "retired";
  const rows = lifecycle.showRemoved
    ? combinedRows
    : combinedRows.filter((row) => !removed(row.sku));
  const visibleRows = rows.slice(0, displayLimit);
  const stock = useListingStock(
    props.channelId,
    catalog.feed.data?.connectionId,
    visibleRows.flatMap((row) =>
      row.sku && (row.remote || row.operation) ? [row.sku] : [],
    ),
    providerName === "Walmart",
  );
  // Bulk linking operates only on visible, unambiguous exact matches. It never
  // adds items to the publication draft or submits a listing operation.
  const matches = visibleRows.filter(
    (row) =>
      !row.draft &&
      !lifecycle.bySku.has(row.sku ?? "") &&
      !row.issue &&
      row.remote?.mappingStatus === "matched" &&
      row.remote.variant !== null,
  );
  const chosen = matches.filter(
    (row) => row.sku !== null && catalog.selected.has(row.sku),
  );
  const linkLocked = catalog.locked || catalog.feed.isFetching;
  const visibleDraftIds = visibleRows.flatMap((row) =>
    row.draft ? [row.draft.variantId] : [],
  );
  const selectedDrafts = draftItems.filter((item) =>
    props.selectedDraftIds.has(item.variantId),
  );
  const visibleSelectedDrafts = visibleDraftIds.filter((id) =>
    props.selectedDraftIds.has(id),
  );
  const selectableListings = linkLocked
    ? []
    : visibleRows
        .filter((row) => !row.draft && row.sku && !removed(row.sku))
        .slice(0, MAX_LISTING_SELECTION);
  const selectedListings = selectableListings.filter((row) =>
    catalog.selected.has(row.sku!),
  );
  const selectedVisibleCount =
    visibleSelectedDrafts.length + selectedListings.length;
  const selectableCount = visibleDraftIds.length + selectableListings.length;
  const hiddenSelectedCount =
    selectedDrafts.length - visibleSelectedDrafts.length;
  const unpublish = lifecycleTargets(
    selectedListings,
    lifecycle.bySku,
    "unpublish",
  );
  const remove = lifecycleTargets(selectedListings, lifecycle.bySku, "remove");
  const selectedCount = selectedDrafts.length + selectedListings.length;
  function openBulk(action: "unpublish" | "remove") {
    const items = action === "unpublish" ? unpublish : remove;
    if (!lifecycle.ready || !lifecycle.account || props.dirty || !items.length)
      return;
    setBulkSelection({
      account: { ...lifecycle.account },
      items,
      skipped: selectedCount - items.length,
    });
  }
  function selectDraft(id: number, checked: boolean) {
    if (catalog.locked) return;
    const next = new Set(props.selectedDraftIds);
    if (checked) next.add(id);
    else next.delete(id);
    props.onDraftSelectionChange(next);
  }
  function selectVisible(checked: boolean) {
    if (catalog.locked) return;
    const drafts = new Set(props.selectedDraftIds);
    for (const id of visibleDraftIds) {
      if (checked) drafts.add(id);
      else drafts.delete(id);
    }
    props.onDraftSelectionChange(drafts);
    if (!linkLocked)
      catalog.setSelected((previous) => {
        const next = new Set(previous);
        for (const row of selectableListings) {
          if (row.sku === null) continue;
          if (checked && next.size < MAX_LISTING_SELECTION) next.add(row.sku);
          else if (!checked) next.delete(row.sku);
        }
        return next;
      });
  }
  const resetDisplay = () => setDisplayLimit(DISPLAY_INCREMENT);
  const choose = (sku: string | null, checked: boolean) => {
    if (sku === null || linkLocked) return;
    catalog.setSelected((previous) => {
      const next = new Set(previous);
      if (checked && next.size < MAX_LISTING_SELECTION) next.add(sku);
      else if (!checked) next.delete(sku);
      return next;
    });
  };
  return (
    <Card className="@container/feed min-w-0">
      {bulkSelection && (
        <BulkListingLifecycleDialog
          channelId={props.channelId}
          selection={bulkSelection}
          onClose={(succeeded) => {
            setBulkSelection(null);
            catalog.setSelected(
              (previous) =>
                new Set(
                  [...previous].filter((sku) => !succeeded.includes(sku)),
                ),
            );
          }}
        />
      )}
      <ListingLifecycleDialog
        selection={lifecycle.selection}
        pending={lifecycle.pending}
        error={lifecycle.error}
        onClose={lifecycle.close}
        onConfirm={lifecycle.confirm}
      />
      <CardHeader className="p-3 sm:p-4 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            Listing Feed
          </CardTitle>
          {canEdit && (
            <Button
              disabled={catalog.locked || draftItems.length >= MAX_DRAFT_ITEMS}
              onClick={props.onAdd}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add products
            </Button>
          )}
        </div>
        {canEdit && draftItems.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 p-3"
            aria-label="Draft bulk actions"
          >
            <p className="min-w-0 flex-1 text-sm">
              <span className="font-medium">
                {selectedDrafts.length} draft items selected
              </span>
              {hiddenSelectedCount > 0 && (
                <span> · {hiddenSelectedCount} outside this view</span>
              )}
            </p>
            {selectedDrafts.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                disabled={catalog.locked}
                onClick={() => props.onDraftSelectionChange(new Set())}
              >
                Clear draft selection
              </Button>
            )}
            <Button
              disabled={catalog.locked || selectedDrafts.length === 0}
              onClick={props.onBulkEdit}
            >
              <Pencil className="mr-2 h-4 w-4" />
              Bulk edit selected ({selectedDrafts.length})
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3 p-3 pt-0 sm:p-4 sm:pt-0">
        <div className="flex flex-wrap items-center gap-2">
          <form
            className="flex min-w-0 flex-1 basis-40 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              catalog.searchFor(catalog.search);
              resetDisplay();
            }}
          >
            <Input
              aria-label="Search exact SKU"
              placeholder="Search exact SKU"
              maxLength={100}
              disabled={catalog.locked}
              value={catalog.search}
              onChange={(event) => catalog.setSearch(event.target.value)}
            />
            <Button
              type="submit"
              variant="outline"
              aria-label="Search listings"
              disabled={catalog.locked}
            >
              <Search className="h-4 w-4" />
            </Button>
          </form>
          {catalog.sku && (
            <Button
              variant="ghost"
              disabled={catalog.locked}
              onClick={() => {
                catalog.searchFor("");
                resetDisplay();
              }}
            >
              Clear search
            </Button>
          )}
          <Button
            variant="outline"
            className="h-9 w-9 shrink-0 px-0 sm:w-auto sm:px-3"
            aria-label="Refresh listings"
            disabled={linkLocked}
            onClick={() => {
              catalog.refresh();
              if (stock.data || stock.error) void stock.refetch();
            }}
          >
            <RefreshCw
              className={`h-4 w-4 ${catalog.feed.isFetching ? "animate-spin" : ""}`}
            />
            <span className="hidden sm:inline">Refresh listings</span>
          </Button>
          {canEdit && chosen.length > 0 && (
            <Button
              disabled={!chosen.length || linkLocked}
              onClick={() =>
                catalog.linkMappings(
                  chosen.map((row) =>
                    catalogMapping(row.remote!, row.remote!.variant!.id),
                  ),
                )
              }
            >
              {catalog.link.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Link2 className="mr-2 h-4 w-4" />
              )}
              Link selected ({chosen.length})
            </Button>
          )}
        </div>
        {canEdit && selectedListings.length > 0 && (
          <div
            aria-label="Selected listing actions"
            className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2 text-sm"
          >
            <span className="mr-auto">
              {selectedListings.length} listings selected
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => catalog.setSelected(new Set())}
            >
              Clear listing selection
            </Button>
            {providerName === "Walmart" && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    linkLocked ||
                    !lifecycle.ready ||
                    props.dirty ||
                    !unpublish.length
                  }
                  onClick={() => openBulk("unpublish")}
                >
                  Unpublish selected ({unpublish.length})
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    linkLocked ||
                    !lifecycle.ready ||
                    props.dirty ||
                    !remove.length
                  }
                  onClick={() => openBulk("remove")}
                >
                  Remove selected ({remove.length})
                </Button>
              </>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span>{draftItems.length} draft items</span>
          {catalog.feed.data && (
            <>
              <span>
                {catalog.feed.data.items.length} account listings on this page
              </span>
            </>
          )}
          {props.dirty && (
            <span className="font-medium text-foreground">
              Unsaved draft changes
            </span>
          )}
          {providerName === "Walmart" && (
            <label className="ml-auto flex items-center gap-2 text-xs">
              <Checkbox
                checked={lifecycle.showRemoved}
                onCheckedChange={(value) =>
                  lifecycle.setShowRemoved(value === true)
                }
              />
              Show removed listings
            </label>
          )}
        </div>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            Selection and stock details
          </summary>
          <p className="pt-2">
            Drafts and recent submissions stay in the feed across account pages.
            Select drafts to edit several items together. The header selects
            actionable rows in this view; draft selections stay selected across
            searches and pages. Saving keeps the full draft; review and
            publishing use only the selected draft items. Manage stock in{" "}
            <a className="underline" href="/channels/inventory">
              Channel Inventory
            </a>
            . Stock shows Walmart's reported selling units at the connected
            fulfillment center. Unknown quantities are shown as a dash. Select
            up to 100 account listings at a time.
          </p>
        </details>
        {props.catalogError && (
          <p role="alert" className="text-sm text-destructive">
            {props.catalogError}
          </p>
        )}
        {catalog.feed.error && (
          <p role="alert" className="text-sm text-destructive">
            Account listings could not be loaded: {catalog.feed.error.message}
          </p>
        )}
        {catalog.link.error && (
          <p role="alert" className="text-sm text-destructive">
            {catalog.link.error.message}
          </p>
        )}
        {catalog.refreshError && (
          <p role="alert" className="text-sm text-destructive">
            {catalog.refreshError}
          </p>
        )}
        {catalog.message && (
          <p role="status" className="text-sm">
            {catalog.message}
          </p>
        )}
        {catalog.feed.isLoading && (
          <p role="status" className="flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading account listings…
          </p>
        )}
        {rows.length > 0 && (
          <>
            <div className="overflow-hidden rounded-md border">
              <table
                aria-label="Channel listings"
                className="block w-full text-left text-sm @4xl/feed:table @4xl/feed:table-fixed"
              >
                <thead className="block bg-muted/30 text-xs text-muted-foreground @4xl/feed:table-header-group">
                  <tr className="flex items-center px-3 py-2 @4xl/feed:table-row @4xl/feed:p-0">
                    {canEdit && (
                      <th className="w-8 @4xl/feed:w-10 @4xl/feed:px-3 @4xl/feed:py-2">
                        <Checkbox
                          aria-label="Select all actionable rows on this page"
                          disabled={selectableCount === 0 || catalog.locked}
                          checked={
                            selectableCount > 0 &&
                            selectedVisibleCount === selectableCount
                              ? true
                              : selectedVisibleCount > 0
                                ? "indeterminate"
                                : false
                          }
                          onCheckedChange={(checked) =>
                            selectVisible(checked === true)
                          }
                        />
                      </th>
                    )}
                    <th scope="col" className="px-2 font-medium @4xl/feed:py-2">
                      Product
                    </th>
                    <th
                      scope="col"
                      className="hidden w-32 px-3 py-2 font-medium @4xl/feed:table-cell"
                    >
                      Status
                    </th>
                    <th
                      scope="col"
                      className="hidden w-28 px-3 py-2 text-right font-medium @4xl/feed:table-cell"
                    >
                      Price
                    </th>
                    <th
                      scope="col"
                      className="hidden w-28 px-3 py-2 text-right font-medium @4xl/feed:table-cell"
                    >
                      Walmart stock
                    </th>
                    <th
                      scope="col"
                      className="hidden w-28 px-3 py-2 text-right font-medium @4xl/feed:table-cell"
                    >
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="block @4xl/feed:table-row-group">
                  {visibleRows.map((row) => (
                    <ChannelListingFeedRow
                      key={row.key}
                      row={row}
                      canEdit={canEdit}
                      locked={
                        (row.draft ? catalog.locked : linkLocked) ||
                        lifecycle.pending ||
                        lifecycle.checking
                      }
                      selected={
                        row.draft
                          ? props.selectedDraftIds.has(row.draft.variantId)
                          : row.sku !== null && catalog.selected.has(row.sku)
                      }
                      selectable={
                        Boolean(row.draft) || selectableListings.includes(row)
                      }
                      onSelect={(checked) =>
                        row.draft
                          ? selectDraft(row.draft.variantId, checked)
                          : choose(row.sku, checked)
                      }
                      onEdit={props.onEdit}
                      onEditExisting={props.onEditExisting}
                      onRemove={props.onRemove}
                      onMatch={catalog.chooseVariant}
                      onActivity={props.onActivity}
                      lifecycle={
                        row.sku ? lifecycle.bySku.get(row.sku) : undefined
                      }
                      lifecycleReady={lifecycle.ready && !props.dirty}
                      onLifecycle={
                        providerName === "Walmart" ? lifecycle.open : undefined
                      }
                      onCheckLifecycle={() => {
                        if (row.sku) lifecycle.check(row.sku);
                      }}
                      stock={row.sku ? stock.bySku.get(row.sku) : undefined}
                      stockLoading={
                        stock.isFetching &&
                        !!row.sku &&
                        !!(row.remote || row.operation)
                      }
                      stockError={stock.error?.message}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Showing {visibleRows.length} of {rows.length} rows on this page
              </p>
              {visibleRows.length < rows.length && (
                <Button
                  variant="outline"
                  disabled={catalog.locked}
                  onClick={() =>
                    setDisplayLimit((limit) => limit + DISPLAY_INCREMENT)
                  }
                >
                  Show more listings
                </Button>
              )}
            </div>
          </>
        )}
        {lifecycle.hasMoreHistory && (
          <Button
            variant="outline"
            disabled={lifecycle.loadingHistory}
            onClick={lifecycle.loadMoreHistory}
          >
            Load more saved listings
          </Button>
        )}
        {lifecycle.readError && (
          <p role="alert" className="text-sm text-destructive">
            Listing actions could not load: {lifecycle.readError}
          </p>
        )}
        {rows.length === 0 && catalog.feed.isSuccess && !catalog.feed.error && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {catalog.sku
              ? "No listings match this exact SKU."
              : "No listings in this feed yet. Add products to prepare your first draft."}
          </p>
        )}
        {catalog.feed.data &&
          (catalog.cursors.length > 1 || catalog.feed.data.nextCursor) && (
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="outline"
                disabled={catalog.cursors.length === 1 || linkLocked}
                onClick={() => {
                  catalog.changePage(catalog.cursors.slice(0, -1));
                  resetDisplay();
                }}
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Account page {catalog.cursors.length}
              </span>
              <Button
                variant="outline"
                disabled={!catalog.feed.data.nextCursor || linkLocked}
                onClick={() => {
                  catalog.changePage([
                    ...catalog.cursors,
                    catalog.feed.data!.nextCursor,
                  ]);
                  resetDisplay();
                }}
              >
                Next
              </Button>
            </div>
          )}
        {canEdit && draftItems.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
            <Button
              variant="outline"
              disabled={catalog.locked || !props.dirty}
              onClick={props.onSave}
            >
              Save draft
            </Button>
            <Button
              disabled={
                catalog.locked ||
                selectedDrafts.length === 0 ||
                props.reviewBlocked
              }
              onClick={props.onReview}
            >
              Review selected ({selectedDrafts.length})
            </Button>
          </div>
        )}
      </CardContent>
      <ChannelListingMatchDialog catalog={catalog} canEdit={canEdit} />
    </Card>
  );
}
