import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { channelDefinitionReviewSchema, channelDefinitionReceiptSchema, channelDefinitionProgressSchema,
  type ChannelDefinitionReview as Review, type ApplyChannelDefinition,
} from "@shared/types/inventory-channel-definition";
import { Button } from "@/components/ui/button";
import { requestJson, jsonInit, ChannelInventoryApiError } from "../api";
import { isDefinitiveDraftRejection } from "../draft-session";
import { useDraftNavigationBlock } from "../DraftNavigation";
import { invalidateChannelInventory } from "../hooks";
import { formatUnits, formatPercent, pluralize } from "../format";
import type { Channel, View } from "../model";
import { Callout, EvidenceNote, SectionCard } from "./primitives";

const endpoint = "/api/inventory-planning/admin/channel-definitions";
const PAGE_SIZE = 25;

/** One channel-wide review, never a product-only sample or a target Resume. */
export function ChannelDefinitionReview({ view, channel, canActivate }: {
  view: View; channel: Channel; canActivate: boolean;
}) {
  const client = useQueryClient();
  const [review, setReview] = useState<Review | null>(null);
  const [reviewFingerprint, setReviewFingerprint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"review" | "apply" | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [page, setPage] = useState(0);
  const command = useRef<ApplyChannelDefinition | null>(null);
  const inFlight = useRef(false);
  const targetIds = new Set(view.publicationTargets.filter(target => target.channelId === channel.id).map(target => target.id));
  const policyHeads = view.policyHeads.filter(head => head.channelId === channel.id);
  const sourceHeads = view.sourceBindingHeads.filter(head => targetIds.has(head.publicationTargetId));
  const mappingHeads = view.variantMappingHeads.filter(head => targetIds.has(head.publicationTargetId));
  const pending = policyHeads.some(head => head.draftPolicy) || sourceHeads.some(head => head.draftBinding) || mappingHeads.some(head => head.draftMapping);
  const fingerprint = JSON.stringify({ authority: view.runtimeAuthorityRevision, policyHeads, sourceHeads, mappingHeads,
    targets: view.publicationTargets.filter(target => target.channelId === channel.id) });
  const stale = review !== null && fingerprint !== reviewFingerprint;
  useDraftNavigationBlock(false, busy === "apply" || uncertain);
  const progress = useQuery({ queryKey: [endpoint, channel.id, "progress"],
    queryFn: ({ signal }) => requestJson(`${endpoint}/${channel.id}/progress`, channelDefinitionProgressSchema.nullable(), { signal }),
    enabled: view.runtimeAuthority === "canonical", retry: false,
    refetchInterval: query => query.state.data?.publications.some(row => ["desired", "queued", "leased", "published", "acknowledged", "retryable", "drifted"].includes(row.state)) ? 5000 : false,
  });
  const runReview = async () => {
    if (inFlight.current || uncertain) return;
    inFlight.current = true; setBusy("review"); setError(null); setReview(null);
    try {
      const result = await requestJson(`${endpoint}/review`, channelDefinitionReviewSchema, jsonInit("POST", { channelId: channel.id }));
      setReview(result); setReviewFingerprint(fingerprint); setPage(0); command.current = null;
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Review could not be loaded."); }
    finally { inFlight.current = false; setBusy(null); }
  };
  const apply = async () => {
    if (inFlight.current || !canActivate || !review || (!uncertain && (!review.ready || stale))) return;
    command.current ??= { channelId: channel.id, expectedReviewHash: review.reviewHash, idempotencyKey: crypto.randomUUID() };
    inFlight.current = true; setBusy("apply"); setError(null);
    try { await requestJson(`${endpoint}/apply`, channelDefinitionReceiptSchema, jsonInit("POST", command.current)); }
    catch (failure) {
      const rejected = isDefinitiveDraftRejection(failure instanceof ChannelInventoryApiError ? failure.status : null);
      setUncertain(!rejected);
      if (rejected) { command.current = null; setReview(null); }
      setError(rejected && failure instanceof Error ? failure.message : "Apply outcome is unknown. Retry the same Apply to recover its recorded result; do not submit a new change.");
      inFlight.current = false; setBusy(null); return;
    }
    // Confirmation is durable even if the subsequent display refresh fails.
    command.current = null; setUncertain(false); setReview(null);
    try { await Promise.all([invalidateChannelInventory(client), client.invalidateQueries({ queryKey: [endpoint,channel.id] })]); }
    catch { setError("Settings were applied, but the latest display could not be refreshed. Reload this workspace."); }
    finally { inFlight.current = false; setBusy(null); }
  };
  return <SectionCard title="Review and apply saved changes" description={`Applies all saved supply, selling-rule and item-mapping changes for ${channel.name}, across its destinations.`}>
    {view.runtimeAuthority !== "canonical" ? <EvidenceNote>Saved changes are prepared for the first inventory cutover. Routine Apply becomes available after that reviewed migration; this page cannot activate it.</EvidenceNote>
      : <>
        <Button variant="outline" disabled={!pending || busy !== null || uncertain} onClick={() => void runReview()}>
          {busy === "review" ? "Reviewing all affected SKUs…" : "Review saved channel changes"}
        </Button>
        {!pending && <p className="text-sm text-muted-foreground">No pending changes on this channel.</p>}
      </>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {review && <div className="space-y-4 rounded-md border p-4" aria-label="Channel changes review">
      <p className="font-medium">{pluralize(review.changes.length, "saved change")} · {pluralize(review.affectedProductIds.length, "affected product")}</p>
      <div className="max-h-80 space-y-3 overflow-y-auto">
        {review.changes.map(change => <div className="rounded border p-3 text-sm" key={`${change.selection.kind}:${change.selection.key}`}>
          <h4 className="font-medium">{change.label}</h4>
          <dl className="mt-2 grid gap-2 sm:grid-cols-2">
            <div><dt className="text-xs text-muted-foreground">Current</dt><dd>{describeDefinition(change.before, view)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Saved change</dt><dd>{describeDefinition(change.after, view)}</dd></div>
          </dl>
        </div>)}
      </div>
      {stale && <Callout tone="warning">Saved settings changed. Review again before applying.</Callout>}
      {review.blockers.length > 0 && <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-destructive">
        {review.blockers.map(message => <li key={message}>{message}</li>)}
      </ul>}
      <details open><summary className="cursor-pointer text-sm font-medium">Live destination quantities ({review.quantities.length})</summary>
        <p className="my-2 text-xs text-muted-foreground">Current settings → saved changes, using the same current inventory snapshot. These are calculated quantities, not provider confirmation. Other channels sharing the stock pool are checked too.</p>
        <ul className="space-y-2">{review.quantities.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE).map(row => <li key={`${row.targetId}:${row.variantId}`} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm">
          <span className="min-w-0 break-all">{row.sku ?? `SKU #${row.variantId}`} <span className="text-muted-foreground">· {row.channelName} · destination #{row.targetId}</span></span>
          <span className="font-medium tabular-nums">{row.current === null ? "Unknown" : formatUnits(row.current)} → {formatUnits(row.proposed)}</span>
        </li>)}</ul>
        {review.quantities.length > PAGE_SIZE && <div className="mt-2 flex items-center gap-3 text-sm">
          <Button variant="outline" size="sm" disabled={page===0} onClick={() => setPage(page-1)}>Previous</Button>
          <span>Page {page+1} of {Math.ceil(review.quantities.length/PAGE_SIZE)}</span>
          <Button variant="outline" size="sm" disabled={(page+1)*PAGE_SIZE>=review.quantities.length} onClick={() => setPage(page+1)}>Next</Button>
        </div>}
      </details>
      <EvidenceNote>Apply changes settings, not physical stock. Updates for live Echelon destinations are queued automatically. Stopped destinations stay stopped; externally managed destinations stay externally managed.</EvidenceNote>
      {canActivate ? <Button disabled={busy!==null || (!uncertain && (!review.ready || stale))} onClick={() => void apply()}>
        {busy === "apply" ? "Applying…" : uncertain ? "Retry same Apply" : "Apply reviewed channel changes"}
      </Button> : <p className="text-sm">Your role can review but needs inventory activation permission to apply.</p>}
    </div>}
    {progress.isError ? <p role="alert" className="text-sm text-destructive">Delivery progress is unavailable. <button className="underline" onClick={() => void progress.refetch()}>Retry</button></p>
      : progress.data && <div role="status" className="rounded border p-3 text-sm">
        <p className="font-medium">Channel settings applied</p><p className="text-xs text-muted-foreground">{progress.data.receipt.appliedAt} · {progress.data.receipt.appliedBy}</p>
        <p>{progress.data.publications.length} delivery records · {progress.data.publications.filter(row => row.state === "verified").length} verified by provider readback.</p>
        {progress.data.publications.some(row => ["dead_letter","drifted","retryable"].includes(row.state)) && <p className="text-destructive">Some updates need attention. Open Quantities for recorded delivery details.</p>}
      </div>}
  </SectionCard>;
}

function describeDefinition(value: Record<string, unknown> | null, view: View): string {
  if (!value) return "Not configured";
  if (value.inherit_all === true) return "Use inherited settings and warehouses";
  const parts: string[] = [];
  const nodes = value.source_fulfillment_node_ids ?? value.nodes;
  if (Array.isArray(nodes)) parts.push(`Warehouses: ${nodes.map(id => view.fulfillmentNodes.find(node => node.id===id)?.name ?? `#${id}`).join(", ")}`);
  if (value.eligible != null) parts.push(value.eligible ? "Sell on channel" : "Show zero");
  if (typeof value.share_bps === "number") parts.push(`Offer ${formatPercent(value.share_bps)}`);
  if (value.holdback_sellable_units != null) parts.push(`Keep back ${value.holdback_sellable_units} SKU units`);
  if (value.max_publish_mode != null) parts.push(value.max_publish_mode === "unlimited" ? "No maximum" : `Maximum ${value.max_publish_sellable_units} SKU units`);
  if (value.min_publish_sellable_units != null) parts.push(`Show zero below ${value.min_publish_sellable_units}`);
  if (value.allocation_semantics != null) parts.push(value.allocation_semantics === "exposure" ? "Shared stock pool" : "Partitioned shares");
  if (value.external_inventory_item_id != null) parts.push(`Marketplace item ${value.external_inventory_item_id}${value.external_sku ? ` · ${value.external_sku}` : ""}`);
  return parts.join(" · ") || "Inherit broader settings";
}
