import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChannelExposurePolicyHead, ChannelExposurePolicyScope } from "@shared/types/inventory-channel-exposure";
import type { ApplyChannelRule, ChannelRuleReview } from "@shared/types/inventory-channel-rule";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

import { ChannelInventoryApiError, describeError } from "../api";
import { isDefinitiveDraftRejection } from "../draft-session";
import { useDraftNavigationBlock } from "../DraftNavigation";
import { formatAbsoluteTime, formatUnits, pluralize } from "../format";
import { invalidateChannelInventory } from "../hooks";
import { describeDestination, type Channel, type View } from "../model";
import {
  RULE_ENDPOINT, applyChannelRule, buildApplyRuleCommand, fetchChannelRuleProgress, reviewChannelRule, ruleSelectionFor,
  splitRuleQuantities, summarizeRuleDelivery,
} from "../rule-apply";
import { Callout, EvidenceNote } from "./primitives";

/**
 * Shows exactly what applying this one saved rule changes, then applies only
 * it. Other saved changes on the channel are not included, and a problem that
 * already exists elsewhere is shown as a warning rather than blocking.
 */
export function RuleApplyPanel({ view, channel, scope, head, canActivate, unsavedEdits }: {
  view: View;
  channel: Channel;
  scope: ChannelExposurePolicyScope;
  head: ChannelExposurePolicyHead | null;
  canActivate: boolean;
  /** The form differs from the saved draft: only the saved draft can be applied. */
  unsavedEdits: boolean;
}) {
  const client = useQueryClient();
  const { toast } = useToast();
  const canonical = view.runtimeAuthority === "canonical";
  const selection = canonical ? ruleSelectionFor(scope, head) : null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [showUnchanged, setShowUnchanged] = useState(false);
  // The exact command stays fixed until its outcome is known (lost response → same retry).
  const command = useRef<ApplyChannelRule | null>(null);
  const inFlight = useRef(false);
  useDraftNavigationBlock(false, busy || uncertain);

  const review = useQuery({
    queryKey: [RULE_ENDPOINT, "review", selection],
    queryFn: ({ signal }) => reviewChannelRule(selection!, signal),
    enabled: selection !== null && !uncertain,
    retry: false,
  });
  const progress = useQuery({
    queryKey: [RULE_ENDPOINT, "progress", head?.scopeKey ?? null],
    queryFn: ({ signal }) => fetchChannelRuleProgress(head!.scopeKey, signal),
    enabled: canonical && head !== null && scope.scopeType !== "channel",
    retry: false,
    refetchInterval: query => query.state.data && summarizeRuleDelivery(query.state.data).inFlight ? 5000 : false,
  });

  const apply = async (reviewed: ChannelRuleReview | null) => {
    if (inFlight.current || !canActivate) return;
    if (!uncertain && (!reviewed || !reviewed.ready || unsavedEdits)) return;
    if (!command.current) {
      if (!reviewed) return;
      command.current = buildApplyRuleCommand(reviewed, crypto.randomUUID());
    }
    inFlight.current = true; setBusy(true); setError(null);
    try {
      await applyChannelRule(command.current);
    } catch (failure) {
      const rejected = isDefinitiveDraftRejection(failure instanceof ChannelInventoryApiError ? failure.status : null);
      setUncertain(!rejected);
      if (rejected) command.current = null;
      setError(rejected ? describeError(failure).message
        : "The apply outcome is unknown. Retry the same apply to recover its recorded result before changing this rule.");
      inFlight.current = false; setBusy(false);
      if (rejected) void review.refetch();
      return;
    }
    // Confirmed. A later display refresh failure must not make it look uncertain.
    command.current = null; setUncertain(false);
    const moved = reviewed ? splitRuleQuantities(reviewed).changed.length : 0;
    toast({ title: "Rule applied", description: moved > 0
      ? `${pluralize(moved, "marketplace quantity", "marketplace quantities")} queued to change on ${channel.name} and other channels.`
      : "No marketplace quantity changes right now. The rule applies as stock changes." });
    // The view refresh retires the draft selection (and with it the review query);
    // refetching the review here would only ask about a draft that no longer exists.
    try { await Promise.all([invalidateChannelInventory(client), client.invalidateQueries({ queryKey: [RULE_ENDPOINT, "progress"] })]); }
    catch { setError("The rule was applied, but the latest view could not be loaded. Reload this workspace."); }
    finally { inFlight.current = false; setBusy(false); }
  };

  if (!canonical || (selection === null && !uncertain && !error && !progress.data)) return null;
  const current = review.data ?? null;
  return (
    <section aria-label="Apply this rule" className="space-y-3 rounded-md border p-3">
      {(selection !== null || uncertain) && <>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">What applying this rule changes</p>
          {review.isFetching && <span className="text-xs text-muted-foreground">Checking this product…</span>}
        </div>
        {review.isError && !uncertain && <p role="alert" className="text-sm text-destructive">
          {describeError(review.error).message} <button type="button" className="underline" onClick={() => void review.refetch()}>Check again</button>
        </p>}
        {current && !uncertain && <RuleImpact review={current} view={view} showUnchanged={showUnchanged} onToggleUnchanged={() => setShowUnchanged(value => !value)} />}
        {current && !uncertain && current.blockers.length > 0 && <Callout tone="danger" title="This rule can't be applied yet">
          <ul className="list-disc space-y-1 pl-5">{current.blockers.map(message => <li key={message}>{message}</li>)}</ul>
        </Callout>}
        {current && !uncertain && current.skippedDestinations.length > 0 && <Callout tone="warning" title="Not updating until the listing is fixed">
          <ul className="list-disc space-y-1 pl-5">{current.skippedDestinations.map(message => <li key={message}>{message}</li>)}</ul>
        </Callout>}
        {current && !uncertain && current.warnings.length > 0 && <details className="text-sm">
          <summary className="cursor-pointer">{pluralize(current.warnings.length, "existing problem")} not caused by this rule</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">{current.warnings.map(message => <li key={message}>{message}</li>)}</ul>
        </details>}
        {unsavedEdits && !uncertain && <Callout tone="warning">This shows the saved draft. Save your edits first, then check and apply them.</Callout>}
        <EvidenceNote>Only this rule is applied. Other saved changes on {channel.name} stay saved.</EvidenceNote>
        {canActivate
          ? <Button type="button" disabled={busy || (!uncertain && (!current || !current.ready || review.isFetching || unsavedEdits))}
            onClick={() => void apply(current)}>
            {busy ? "Applying…" : uncertain ? "Retry same apply" : "Apply this rule"}
          </Button>
          : <p className="text-sm">Applying a rule needs inventory activation permission.</p>}
      </>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {progress.data && <RuleDelivery progress={progress.data} />}
    </section>
  );
}

function RuleImpact({ review, view, showUnchanged, onToggleUnchanged }: {
  review: ChannelRuleReview; view: View; showUnchanged: boolean; onToggleUnchanged(): void;
}) {
  const { changed, unchanged } = splitRuleQuantities(review);
  const rows = showUnchanged ? [...changed, ...unchanged] : changed;
  return (
    <div className="space-y-2">
      {changed.length === 0 && <p className="text-sm text-muted-foreground">No marketplace quantity changes right now. The rule applies as stock changes.</p>}
      {rows.length > 0 && <ul className="space-y-2" aria-label="Quantity changes">{rows.map(row => (
        <li key={`${row.targetId}:${row.variantId}`} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm">
          <span className="min-w-0 break-all">{row.sku ?? `SKU #${row.variantId}`} <span className="text-muted-foreground">· {row.channelName} · {destinationLabel(row.targetId, view)}</span></span>
          <span className="font-medium tabular-nums">{row.current === null ? "Unknown" : formatUnits(row.current)} → {formatUnits(row.proposed)}</span>
        </li>
      ))}</ul>}
      {unchanged.length > 0 && <button type="button" className="text-xs underline" onClick={onToggleUnchanged}>
        {showUnchanged ? "Hide" : "Show"} {pluralize(unchanged.length, "unchanged quantity", "unchanged quantities")}
      </button>}
    </div>
  );
}

function RuleDelivery({ progress }: { progress: NonNullable<Awaited<ReturnType<typeof fetchChannelRuleProgress>>> }) {
  const delivery = summarizeRuleDelivery(progress);
  return (
    <div role="status" className="rounded border p-3 text-sm">
      <p className="font-medium">Last applied {formatAbsoluteTime(progress.receipt.appliedAt)} · {progress.receipt.appliedBy}</p>
      <p>{pluralize(delivery.total, "stock update")} · {delivery.confirmed} confirmed by a marketplace stock check.</p>
      {delivery.needsAttention && <p className="text-destructive">Some updates need attention. Open Stock preview for update history.</p>}
    </div>
  );
}

function destinationLabel(targetId: number, view: View): string {
  const target = view.publicationTargets.find(item => item.id === targetId);
  return target ? describeDestination(target, view).title : "Account details unavailable";
}
