import type { ListingOperation } from "@shared/types/channel-listing-publication";
import { money } from "./model";

const itemLabels: Record<ListingOperation["items"][number]["state"], string> = {
  queued: "Queued",
  processing: "Processing",
  accepted: "Accepted · verification pending",
  verified: "Item verified",
  needs_attention: "Needs attention",
  needs_reconciliation: "Outcome needs verification",
  superseded: "Recreated in a newer submission",
};
export function ListingActivityDetails({
  operation,
}: {
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
            <dl className="grid grid-cols-2 gap-3 text-sm @4xl/activity:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)]">
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
            </dl>
            {item.mediaVerification && <p className="text-sm text-muted-foreground">{item.mediaVerification.message}</p>}
            {item.error && (
              <p className={`text-sm [overflow-wrap:anywhere] ${item.stockState === "queued" ? "text-muted-foreground" : "text-destructive"}`}>
                {item.error}
              </p>
            )}
          </li>
        ))}
      </ul>
      {operation.items.some((item) => item.state === "verified") && (
        <div className="space-y-2 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            Stock updates follow this channel's selected listings. Manage inventory rules in{" "}
            <a href="/channels/inventory" className="underline">Channel Inventory</a>.
          </p>
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
