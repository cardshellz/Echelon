import type { ChannelCatalogStockItem } from "@shared/types/channel-catalog";
import type { ListingLifecycleView } from "@shared/types/channel-listing-lifecycle";
import type { ListingOperationItem } from "@shared/types/channel-listing-publication";
import type { ListingFeedRow } from "./feed-model";
import { money, priceSourceLabel } from "./model";
import { listingTitle } from "./feed-presentation";

const submissionLabels: Record<ListingOperationItem["state"], string> = {
  queued: "Queued",
  processing: "Processing",
  accepted: "Accepted · verification pending",
  verified: "Item verified",
  needs_attention: "Needs attention",
  needs_reconciliation: "Outcome needs verification",
  superseded: "Recreated in a newer submission",
};
const mappingLabels = {
  linked: "Linked",
  matched: "Exact SKU match · not linked",
  unmatched: "Needs match",
  conflict: "Conflict",
  unavailable: "Unavailable",
};

export function ListingFeedDetails({
  row,
  lifecycle,
  stock,
  stockError,
}: {
  row: ListingFeedRow;
  lifecycle?: ListingLifecycleView;
  stock?: ChannelCatalogStockItem;
  stockError?: string;
}) {
  const { draft, catalog, remote, operation } = row;
  return (
    <div className="space-y-3 text-xs [overflow-wrap:anywhere]">
      <p className="text-sm font-medium">{listingTitle(row, lifecycle)}</p>
      {row.missingOnWalmart && <p className="text-destructive">Walmart could not find this SKU. Listing and stock updates are stopped. Your Echelon product and inventory settings are retained. Use Recreate on Walmart to submit it again.</p>}
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3 [&_dt]:text-muted-foreground [&_dd]:mt-1">
        <div>
          <dt>Echelon variant</dt>
          <dd>
            {catalog?.variantName ??
              remote?.variant?.name ??
              "Catalog details unavailable"}
          </dd>
          {catalog && <dd>{catalog.unitLabel}</dd>}
          {remote && <dd>{mappingLabels[remote.mappingStatus]}</dd>}
        </div>
        <div>
          <dt>Walmart status</dt>
          <dd>
            {row.missingOnWalmart ? "Missing on Walmart" : remote
              ? `${remote.publishedStatus} · ${remote.lifecycleStatus}`
              : "Not reported in this account page"}
          </dd>
        </div>
        <div>
          <dt>{stockError ? "Last successful stock read" : "Walmart stock"}</dt>
          <dd>
            {!row.missingOnWalmart && stock?.quantity != null
              ? `${stock.quantity.toLocaleString()} selling units at the connected fulfillment center`
              : "Quantity unavailable"}
          </dd>
          {stock && (
            <dd>Checked {new Date(stock.checkedAt).toLocaleString()}</dd>
          )}
        </div>
        {remote && (
          <div>
            <dt>Walmart price</dt>
            <dd>{money(remote.priceCents ?? null)}</dd>
          </div>
        )}
        {draft && (
          <>
            <div>
              <dt>Product type</dt>
              <dd>
                {draft.productType || "Choose product type"} ·{" "}
                {draft.method === "match" ? "Catalog match" : "Create product"}
              </dd>
            </div>
            <div>
              <dt>Draft price</dt>
              <dd>
                {money(draft.priceOverrideCents ?? catalog?.priceCents ?? null)}{" "}
                ·{" "}
                {draft.priceOverrideCents !== null
                  ? "Fixed item price"
                  : priceSourceLabel(catalog?.priceSource)}
              </dd>
            </div>
          </>
        )}
        {operation && (
          <>
            <div>
              <dt>Latest submission</dt>
              <dd>{submissionLabels[operation.item.state]}</dd>
            </div>
            <div>
              <dt>Submitted price</dt>
              <dd>{money(operation.item.priceCents)}</dd>
            </div>
          </>
        )}
      </dl>
      {lifecycle?.message && <p>{lifecycle.message}</p>}
      {operation?.item.error && (
        <p className={operation.item.stockState === "queued" ? "text-muted-foreground" : "text-destructive"}>{operation.item.error}</p>
      )}
      {operation?.item.stockErrorCode === "STOCK_RECREATION_OUTCOME_UNCERTAIN" && (
        <a href="/inventory/cutover" className="block w-fit underline">Review stalled stock requests</a>
      )}
      {row.issue && <p className="text-destructive">{row.issue}</p>}
      {remote?.priceError && <p className="text-destructive">{remote.priceError}</p>}
      {remote?.message && remote.message !== row.issue && (
        <p>{remote.message}</p>
      )}
      {draft?.images === null && !!catalog?.imageIssues?.length && (
        <p className="text-destructive">
          A catalog photo needs attention. Edit this draft to review it.
        </p>
      )}
      {(stock?.error || stockError) && (
        <p role="alert" className="text-destructive">
          {stock?.error ?? stockError}
        </p>
      )}
      <a href="/channels/inventory" className="inline-block underline">
        Manage inventory rules
      </a>
    </div>
  );
}
