import type { ChannelPublicationStatus } from "@shared/types/inventory-channel-publication-status";
import { Button } from "@/components/ui/button";
import { describeError } from "../api";
import { formatAbsoluteTime, formatUnits } from "../format";
import { usePublicationStatus } from "../hooks";
import { describeDestination, providerLabel, type Target, type View } from "../model";
import { Callout, StatePill } from "./primitives";

type StatusRow = ChannelPublicationStatus["rows"][number];
const DELIVERY_LABEL: Record<NonNullable<StatusRow["desired"]>["state"], string> = {
  desired: "Waiting to queue", queued: "Queued", leased: "Sending", acknowledged: "Accepted; stock check pending",
  verified: "Matched at last check", drifted: "Stock check differed", retryable: "Retry pending",
  dead_letter: "Delivery failed", superseded: "Replaced", cancelled: "Cancelled",
};

export function PublicationStatus({ target, productId, view }: { target: Target; productId: number; view: View }) {
  const query = usePublicationStatus(target.id, productId);
  const data = query.error ? undefined : query.data;
  const variants = view.selectedProduct?.id === productId ? view.selectedProduct.variants : [];
  const skuNames = new Map(variants.map((variant) => [variant.id, variant.sku ?? `SKU #${variant.id}`]));
  const channelName = view.channels.find((channel) => channel.id === target.channelId)?.name
    ?? providerLabel(describeDestination(target, view).provider);
  const recordedRows = data?.rows.filter(hasRecordedUpdate) ?? [];
  const emptyRows = data?.rows.filter((row) => !hasRecordedUpdate(row)) ?? [];
  return <section className="space-y-3 border-t pt-5" aria-label="Stock update history">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="font-semibold">Stock update history</h3>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          Recorded requests and stock checks at {channelName}, with their dates. These are separate from the calculation above.
        </p>
      </div>
      <Button type="button" variant="outline" size="sm" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>
        {query.isFetching ? "Loading history…" : "Refresh history"}
      </Button>
    </div>
    {query.isLoading && <p role="status" className="text-sm text-muted-foreground">Loading stock update history…</p>}
    {query.error && <Callout tone="danger" title="Stock update history unavailable">
      <p>Records could not be loaded. No marketplace quantity can be confirmed from this view.</p>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer font-medium">Technical details</summary>
        <p className="mt-2 break-words">{describeError(query.error).message}</p>
      </details>
    </Callout>}
    {data && <>
      {data.runtimeAuthority === "legacy" && <p className="text-sm text-muted-foreground">
        The existing inventory setup still controls stock. Updates from that setup are not included in this history.
      </p>}
      {data.rows.length === 0 && <p className="rounded-md border bg-muted/20 p-4 text-sm text-muted-foreground">No stock update records for this product.</p>}
      <div className="space-y-3">{recordedRows.map(row => {
        const sku = skuNames.get(row.productVariantId) ?? `SKU #${row.productVariantId}`;
        return <article key={row.productVariantId} className="rounded-lg border p-4" aria-label={`${sku} delivery status`}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span className="break-all font-medium">{sku}</span>
            {row.desired && <StatePill tone={row.desired.state === "dead_letter" || row.desired.state === "drifted" ? "blocked" : "neutral"}>
              {DELIVERY_LABEL[row.desired.state]}
            </StatePill>}
          </div>
          {!row.activeInventoryItemId && <p className="mb-3 text-sm text-muted-foreground">The listing link is not active.</p>}
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Quantity label="Last requested" quantity={row.desired?.quantity} at={row.desired?.createdAt} empty="No request recorded" />
            <Quantity label={`Accepted by ${channelName}`} quantity={row.acknowledged?.quantity} at={row.acknowledged?.acknowledgedAt} empty="No acceptance recorded" />
            <Quantity label={`Last checked at ${channelName}`} quantity={row.observed?.quantity} at={row.observed?.observedAt} empty="No stock check recorded" />
          </dl>
          {row.acknowledged && row.desired && row.acknowledged.outboxId !== row.desired.outboxId && <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">The accepted quantity belongs to an earlier request, not the latest update.</p>}
          {row.observed && !row.desired && <p className="mt-3 text-xs text-muted-foreground">No request is recorded to compare with this stock check.</p>}
          {row.observed && ((row.desired && row.observed.outboxId !== row.desired.outboxId) || row.observed.targetRevision !== data.targetRevision) && <p className="mt-3 text-xs text-muted-foreground">The last stock check does not confirm the latest request with the current settings.</p>}
          {row.observed && row.desired && row.observed.outboxId === row.desired.outboxId
            && row.observed.targetRevision === data.targetRevision && row.observed.matchesDesired === false
            && <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">The last stock check did not match the requested quantity.</p>}
        </article>;
      })}</div>
      {emptyRows.length > 0 && <div className="rounded-md border bg-muted/20 p-4" aria-label="SKUs without stock update records">
        <p className="text-sm font-medium">No stock updates recorded</p>
        <ul className="mt-3 divide-y text-sm">
          {emptyRows.map((row) => <li key={row.productVariantId} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
            <span className="break-all font-medium">{skuNames.get(row.productVariantId) ?? `SKU #${row.productVariantId}`}</span>
            <span className="text-xs text-muted-foreground">{row.activeInventoryItemId ? "No request or stock check recorded yet." : "Listing link is not active."}</span>
          </li>)}
        </ul>
      </div>}
      <p className="text-xs leading-relaxed text-muted-foreground">Refresh reloads Echelon's saved history; it does not check {channelName} again. Stock may have changed since the recorded check.</p>
    </>}
  </section>;
}

function hasRecordedUpdate(row: StatusRow): boolean {
  return row.desired !== null || row.acknowledged !== null || row.observed !== null;
}

function Quantity({ label, quantity, at, empty }: { label: string; quantity?: string; at?: string; empty: string }) {
  return <div><dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="mt-1 text-xl font-semibold tabular-nums">{quantity === undefined ? "Unknown" : formatUnits(quantity)}</dd>
    <p className="mt-1 text-xs text-muted-foreground">{at ? formatAbsoluteTime(at) : empty}</p>
  </div>;
}
