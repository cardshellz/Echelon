import { useMemo, useState } from "react";
import { Link2, Loader2, Package, Plus, RefreshCw, Search } from "lucide-react";
import type {
  ListingCatalogItem,
  ListingDraftItem,
  ListingOperation,
} from "@shared/types/channel-listing-publication";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { buildListingFeedRows } from "./feed-model";
import { MAX_DRAFT_ITEMS } from "./model";
import { catalogMapping, useChannelCatalog } from "./useChannelCatalog";
import { ChannelListingFeedRow } from "./ChannelListingFeedRow";
import { ChannelListingMatchDialog } from "./ChannelListingMatchDialog";

const DISPLAY_INCREMENT = 50;
// The mapping API accepts at most 100 exact identities in one reviewed action.
const MAX_LINK_SELECTION = 100;

export interface ChannelListingFeedProps {
  channelId: number;
  providerName: string;
  canEdit: boolean;
  draftItems: ListingDraftItem[];
  metadata: ReadonlyMap<number, ListingCatalogItem>;
  operations: ListingOperation[];
  busy: boolean;
  dirty: boolean;
  onAdd(): void;
  onEdit(variantId: number): void;
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
  const rows = useMemo(
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
  const visibleRows = rows.slice(0, displayLimit);
  // Bulk linking operates only on visible, unambiguous exact matches. It never
  // adds items to the publication draft or submits a listing operation.
  const matches = visibleRows.filter(
    (row) =>
      !row.issue &&
      row.remote?.mappingStatus === "matched" &&
      row.remote.variant !== null,
  );
  const chosen = matches.filter(
    (row) => row.sku !== null && catalog.selected.has(row.sku),
  );
  const linkLocked = catalog.locked || catalog.feed.isFetching;
  const resetDisplay = () => setDisplayLimit(DISPLAY_INCREMENT);
  const choose = (sku: string | null, checked: boolean) => {
    if (sku === null || linkLocked) return;
    catalog.setSelected((previous) => {
      const next = new Set(previous);
      if (checked && next.size < MAX_LINK_SELECTION) next.add(sku);
      else if (!checked) next.delete(sku);
      return next;
    });
  };
  return (
    <Card>
      <CardHeader className="px-3 sm:px-6">
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
        <CardDescription>
          Manage your {providerName} listings. Add products, set prices, and
          review the draft before publishing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <form
            className="flex min-w-0 flex-1 basis-56 gap-2"
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
            disabled={linkLocked}
            onClick={catalog.refresh}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${catalog.feed.isFetching ? "animate-spin" : ""}`}
            />
            Refresh listings
          </Button>
          {canEdit && (
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
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span>{draftItems.length} draft items</span>
          {catalog.feed.data && (
            <>
              <span>
                {catalog.feed.data.items.length} account listings on this page
              </span>
              <span>
                {
                  catalog.feed.data.items.filter(
                    (item) => item.mappingStatus === "linked",
                  ).length
                }{" "}
                linked on this account page
              </span>
            </>
          )}
          {props.dirty && (
            <span className="font-medium text-foreground">
              Unsaved draft changes
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Drafts and recent submissions stay in the feed across account pages.
          Search filters the feed; saving and review use the full draft. New
          variants stay unselected. Manage stock in{" "}
          <a className="underline" href="/channels/inventory">
            Channel Inventory
          </a>
          .
        </p>
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
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    {canEdit && (
                      <TableHead className="w-10">
                        <input
                          type="checkbox"
                          aria-label={
                            matches.length > MAX_LINK_SELECTION
                              ? `Select up to ${MAX_LINK_SELECTION} exact matches`
                              : "Select all exact matches"
                          }
                          disabled={!matches.length || linkLocked}
                          checked={
                            matches.length > 0 &&
                            chosen.length ===
                              Math.min(matches.length, MAX_LINK_SELECTION)
                          }
                          onChange={(event) =>
                            catalog.setSelected(
                              new Set(
                                event.target.checked
                                  ? matches
                                      .slice(0, MAX_LINK_SELECTION)
                                      .map((row) => row.sku!)
                                  : [],
                              ),
                            )
                          }
                        />
                      </TableHead>
                    )}
                    <TableHead>Product</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Echelon variant</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleRows.map((row) => (
                    <ChannelListingFeedRow
                      key={row.key}
                      row={row}
                      canEdit={canEdit}
                      locked={linkLocked}
                      selected={
                        row.sku !== null &&
                        catalog.selected.has(row.sku) &&
                        matches.includes(row)
                      }
                      selectable={
                        matches.includes(row) &&
                        (chosen.length < MAX_LINK_SELECTION ||
                          (row.sku !== null && catalog.selected.has(row.sku)))
                      }
                      onSelect={(checked) => choose(row.sku, checked)}
                      onEdit={props.onEdit}
                      onRemove={props.onRemove}
                      onMatch={catalog.chooseVariant}
                      onActivity={props.onActivity}
                    />
                  ))}
                </TableBody>
              </Table>
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
        {rows.length === 0 && catalog.feed.isSuccess && !catalog.feed.error && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {catalog.sku
              ? "No listings match this exact SKU."
              : "No listings in this feed yet. Add products to prepare your first draft."}
          </p>
        )}
        {catalog.feed.data && (
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
        {canEdit && (
          <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
            <Button
              variant="outline"
              disabled={catalog.locked || !props.dirty}
              onClick={props.onSave}
            >
              Save draft
            </Button>
            <Button
              disabled={catalog.locked || draftItems.length === 0}
              onClick={props.onReview}
            >
              Review {draftItems.length} items
            </Button>
          </div>
        )}
      </CardContent>
      <ChannelListingMatchDialog catalog={catalog} canEdit={canEdit} />
    </Card>
  );
}
