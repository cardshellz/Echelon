import type { ChannelPublicationStatus } from "@shared/types/inventory-channel-publication-status";
import { Button } from "@/components/ui/button";
import { describeError } from "../api";
import { formatAbsoluteTime, formatUnits } from "../format";
import { usePublicationStatus } from "../hooks";
import type { Target, View } from "../model";
import { Callout, EvidenceNote, StatePill } from "./primitives";

type StatusRow = ChannelPublicationStatus["rows"][number];
const DELIVERY_LABEL: Record<NonNullable<StatusRow["desired"]>["state"], string> = {
  desired: "Waiting to queue", queued: "Queued", leased: "Sending", acknowledged: "Accepted, not verified",
  verified: "Verified at last check", drifted: "Readback differed", retryable: "Retry pending",
  dead_letter: "Delivery failed", superseded: "Replaced", cancelled: "Cancelled",
};

export function PublicationStatus({ target, productId, view }: { target: Target; productId: number; view: View }) {
  const query = usePublicationStatus(target.id, productId);
  const data = query.error ? undefined : query.data;
  const variants = view.selectedProduct?.id === productId ? view.selectedProduct.variants : [];
  return <section className="space-y-3 border-t pt-5" aria-label="Recorded delivery status">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="font-semibold">Recorded delivery status</h3>
        <p className="max-w-3xl text-sm text-muted-foreground">What Echelon requested, what the provider accepted, and what was last read back. These are separate from the proposed quantities above.</p>
      </div>
      <Button type="button" variant="outline" size="sm" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>
        {query.isFetching ? "Loading records…" : "Reload delivery records"}
      </Button>
    </div>
    {query.isLoading && <p role="status" className="text-sm text-muted-foreground">Loading recorded delivery status…</p>}
    {query.error && <Callout tone="danger" title="Delivery status unavailable">{describeError(query.error).message} Unknown is not zero.</Callout>}
    {data && <>
      {data.runtimeAuthority === "legacy" && <Callout title="Canonical publishing is not active">
        The existing allocator still controls live quantities. These records do not establish what that allocator has sent.
      </Callout>}
      {target.publicationAuthority !== "echelon" && <Callout>
        Publishing is controlled {target.publicationAuthority === "external_provider" ? "by the external provider" : "manually"}. This view does not take ownership or send quantities.
      </Callout>}
      {data.rows.length === 0 && <Callout>No sellable, tracked SKUs for this product.</Callout>}
      <div className="space-y-3">{data.rows.map(row => {
        const variant = variants.find(item => item.id === row.productVariantId);
        const sku = variant?.sku ?? `SKU #${row.productVariantId}`;
        return <article key={row.productVariantId} className="rounded-lg border p-4" aria-label={`${sku} delivery status`}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <span className="break-all font-medium">{sku}</span>
            {row.desired && <StatePill tone={row.desired.state === "dead_letter" || row.desired.state === "drifted" ? "blocked" : "neutral"}>
              {DELIVERY_LABEL[row.desired.state]}
            </StatePill>}
          </div>
          {!row.activeInventoryItemId ? <p className="text-sm text-muted-foreground">No active provider identity. A saved draft identity is not active delivery evidence.</p> : <>
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Quantity label="Last requested" quantity={row.desired?.quantity} at={row.desired?.createdAt} empty="No request recorded" />
              <Quantity label="Last accepted" quantity={row.acknowledged?.quantity} at={row.acknowledged?.acknowledgedAt} empty="No acceptance recorded" />
              <Quantity label="Last readback" quantity={row.observed?.quantity} at={row.observed?.observedAt} empty="No observation recorded" />
            </dl>
            {row.acknowledged && row.acknowledged.outboxId !== row.desired?.outboxId && <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">Acceptance belongs to an earlier request, not the latest quantity.</p>}
            {row.observed && (row.observed.outboxId !== row.desired?.outboxId || row.observed.targetRevision !== data.targetRevision) && <p className="mt-3 text-xs text-muted-foreground">This observation does not verify the latest request and current settings.</p>}
          </>}
        </article>;
      })}</div>
      <EvidenceNote>Recorded evidence only, with each event's timestamp. Reloading reads Echelon's records; it does not contact a provider. An old readback is not a live stock check.</EvidenceNote>
    </>}
  </section>;
}

function Quantity({ label, quantity, at, empty }: { label: string; quantity?: string; at?: string; empty: string }) {
  return <div><dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="mt-1 text-xl font-semibold tabular-nums">{quantity === undefined ? "Unknown" : formatUnits(quantity)}</dd>
    <p className="mt-1 text-xs text-muted-foreground">{at ? formatAbsoluteTime(at) : empty}</p>
  </div>;
}
