import type { ListingOperation } from "@shared/types/channel-listing-publication";
import { ListingStockMembership } from "./ListingStockMembership";
import { money } from "./model";

const itemLabels: Record<ListingOperation["items"][number]["state"], string> = {
  queued: "Queued",
  processing: "Processing",
  accepted: "Accepted · verification pending",
  verified: "Item verified",
  needs_attention: "Needs attention",
  needs_reconciliation: "Outcome needs verification",
};
// These are submission-time states, not current inventory membership or quantities.
const stockLabels: Record<ListingOperation["items"][number]["stockState"], string> = {
  waiting_for_item: "Waiting for item verification",
  setup_required: "Review stock publishing",
  ready: "Review stock publishing",
};

export function ListingActivityDetails({
  channelId,
  connectionId,
  operation,
}: {
  channelId: number;
  connectionId: number;
  operation: ListingOperation;
}) {
  return (
    <div className="min-w-0 space-y-4">
      {operation.error && (
        <div>
          <p className="text-xs font-medium">Submission message</p>
          <p className="mt-1 text-sm text-destructive [overflow-wrap:anywhere]">
            {operation.error}
          </p>
        </div>
      )}
      <ul aria-label="Submitted item results" className="divide-y">
        {operation.items.map((item) => (
          <li key={item.variantId} className="space-y-2 py-3 first:pt-0">
            <dl className="grid grid-cols-2 gap-3 text-sm @4xl/activity:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)_minmax(0,2fr)]">
              <div className="col-span-2 min-w-0 @4xl/activity:col-span-1">
                <dt className="text-xs text-muted-foreground">SKU</dt>
                <dd className="mt-1 break-all font-mono text-xs">{item.sku}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Submitted price</dt>
                <dd className="mt-1 tabular-nums">{money(item.priceCents)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Listing</dt>
                <dd className="mt-1">{itemLabels[item.state]}</dd>
              </div>
              <div className="col-span-2 @4xl/activity:col-span-1">
                <dt className="text-xs text-muted-foreground">Stock at submission</dt>
                <dd className="mt-1">{stockLabels[item.stockState]}</dd>
              </div>
            </dl>
            {item.error && (
              <p className="text-sm text-destructive [overflow-wrap:anywhere]">
                {item.error}
              </p>
            )}
          </li>
        ))}
      </ul>
      {operation.items.some((item) => item.state === "verified") && (
        <div className="space-y-2 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            Review current stock publishing for verified items. Manage inventory rules in{" "}
            <a href="/channels/inventory" className="underline">Channel Inventory</a>.
          </p>
          <ListingStockMembership
            channelId={channelId}
            connectionId={connectionId}
            items={operation.items}
          />
        </div>
      )}
      <dl className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
        <div className="flex flex-wrap gap-x-2">
          <dt>Operation</dt>
          <dd className="min-w-0 break-all font-mono">{operation.id}</dd>
        </div>
        {operation.submissionId && (
          <div className="flex flex-wrap gap-x-2">
            <dt>Walmart feed</dt>
            <dd className="min-w-0 break-all font-mono">{operation.submissionId}</dd>
          </div>
        )}
        <div className="flex flex-wrap gap-x-2">
          <dt>Last updated</dt>
          <dd><time dateTime={operation.updatedAt}>{new Date(operation.updatedAt).toLocaleString()}</time></dd>
        </div>
      </dl>
    </div>
  );
}
