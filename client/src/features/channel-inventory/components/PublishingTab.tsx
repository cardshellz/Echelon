import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { InventoryPublicationTargetResumeReview } from "@shared/types/inventory-publication-target-resume";
import { Link } from "wouter";
import { ArrowRight, Pause, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

import { describeError, resumeDestination, reviewResume, setReadinessInclusion, stopDestination } from "../api";
import { formatAbsoluteTime, pluralize } from "../format";
import { invalidateChannelInventory, useCommandKey, usePublishingStatus } from "../hooks";
import { PUBLISHER_LABELS, describeDestination, summarizePendingChanges, type Channel, type Target, type View } from "../model";
import { describeResumeIssue, describeStockUpdates } from "../publishing-presentation";
import { Callout, KeyValue, ReasonDialog, SectionCard, StatePill } from "./primitives";
import { NoDestinationYet } from "./SupplyTab";
import { ChannelDefinitionReview } from "./ChannelDefinitionReview";
import { GlobalPublishingControl } from "./GlobalPublishingControl";

type Command = "include" | "exclude" | "stop" | "review" | "resume";
type SettingsTab = "supply" | "rules" | "quantities";
const now = () => new Date();

/** Controls existing commands; first-time activation must never be disguised as Resume. */
export function PublishingTab({ view, channel, target, canEdit, canActivate, onAddDestination, onOpenTab }: {
  view: View; channel: Channel; target: Target | null; canEdit: boolean; canActivate: boolean;
  onAddDestination(): void;
  onOpenTab(tab: SettingsTab): void;
}) {
  return <div className="space-y-4">
    {target ? <DestinationPublishing key={`${target.id}:${target.revision}`} view={view} channel={channel}
      target={target} canActivate={canActivate} onOpenTab={onOpenTab} />
      : <NoDestinationYet canEdit={canEdit} onAdd={onAddDestination} />}
    <ChannelDefinitionReview key={channel.id} view={view} channel={channel} canActivate={canActivate} />
  </div>;
}

function DestinationPublishing({ view, channel, target, canActivate, onOpenTab }: {
  view: View; channel: Channel; target: Target; canActivate: boolean;
  onOpenTab(tab: SettingsTab): void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const status = usePublishingStatus();
  const identity = describeDestination(target, view);
  // A failed refresh invalidates the displayed switch state, even if cached data exists.
  const globalOn = status.error ? null : status.data?.global.globalEnabled ?? null;
  const publishing = describeStockUpdates(target, view.runtimeAuthority, globalOn);
  const pending = summarizePendingChanges(view, channel.id, target.id);
  const [dialog, setDialog] = useState<Command | null>(null);
  const [review, setReview] = useState<InventoryPublicationTargetResumeReview | null>(null);
  const includeKey = useCommandKey();
  const stopKey = useCommandKey();
  const reviewKey = useCommandKey();
  const resumeKey = useCommandKey();
  const managedHere = target.publicationAuthority === "echelon";
  const canResume = target.state === "preview" && managedHere
    && view.runtimeAuthority === "canonical" && target.hasPriorLiveStop === true;
  const cannotResume = managedHere && target.state !== "live" && target.hasPriorLiveStop === false;
  const canPrepare = target.state === "disabled"
    && (view.runtimeAuthority !== "canonical" || target.hasPriorLiveStop === true);

  const fail = (error: unknown) => {
    const described = describeError(error);
    toast({ title: "Stock update action could not be completed", description: described.message, variant: "destructive" });
  };
  const refresh = () => invalidateChannelInventory(queryClient);

  const inclusion = useMutation({
    mutationFn: (input: { state: "disabled" | "preview"; reason: string }) => setReadinessInclusion({
      publicationTargetId: target.id, expectedRevision: target.revision, state: input.state, changeReason: input.reason,
      idempotencyKey: includeKey.keyFor(JSON.stringify({ target: target.id, revision: target.revision, ...input })),
    }),
    onSuccess: async result => {
      includeKey.clear(); setDialog(null); await refresh();
      toast({ title: result.state === "preview" ? "Account included in stock setup" : "Account removed from stock setup",
        description: "No stock quantities were sent to the marketplace." });
    },
    onError: fail,
  });
  const stop = useMutation({
    mutationFn: (reason: string) => stopDestination({
      publicationTargetId: target.id, expectedRevision: target.revision, changeReason: reason,
      idempotencyKey: stopKey.keyFor(JSON.stringify({ target: target.id, revision: target.revision, reason })),
    }),
    onSuccess: async () => {
      stopKey.clear(); setDialog(null); await refresh();
      toast({ title: `Stock updates paused for ${identity.title}`,
        description: "Queued updates were cancelled. Stock already shown in the marketplace was not changed." });
    },
    onError: fail,
  });
  const reviewMutation = useMutation({
    mutationFn: (reason: string) => reviewResume({
      publicationTargetId: target.id, expectedRevision: target.revision, reason,
      idempotencyKey: reviewKey.keyFor(JSON.stringify({ target: target.id, revision: target.revision, reason })),
    }),
    onSuccess: result => {
      reviewKey.clear(); resumeKey.clear(); setReview(result); setDialog(null);
    },
    onError: fail,
  });
  const resume = useMutation({
    mutationFn: (reason: string) => {
      if (!review || review.state !== "ready") throw new Error("Check this account before resuming stock updates.");
      return resumeDestination({
        publicationTargetId: target.id, expectedRevision: target.revision, resumeReviewId: review.resumeReviewId,
        expectedEvidenceHash: review.evidenceHash, reason,
        idempotencyKey: resumeKey.keyFor(JSON.stringify({ target: target.id, review: review.resumeReviewId, reason })),
      });
    },
    onSuccess: async result => {
      resumeKey.clear(); setReview(null); setDialog(null); await refresh();
      toast({ title: `Stock updates resumed for ${identity.title}`,
        description: `${pluralize(result.publicationRows, "stock update")} queued. Check Stock preview for delivery results.` });
    },
    onError: fail,
  });
  const busy = inclusion.isPending || stop.isPending || reviewMutation.isPending || resume.isPending;

  return <SectionCard title={`Stock updates for ${identity.title}`}
    description={`Controls the stock quantities sent to ${channel.name}. Product details are managed in the listing feed.`}
    actions={<StatePill tone={publishing.tone}>{publishing.label}</StatePill>}>
    <p className="text-sm leading-relaxed">{publishing.explanation}</p>

    {managedHere && view.runtimeAuthority === "canonical" && cannotResume && (
      <Callout title="Starting stock updates is unavailable">
        This account has no previous pause recorded, so it cannot use Resume.
        Echelon does not yet support starting a new account from this screen. You can save settings and preview quantities here.
      </Callout>
    )}
    {managedHere && view.runtimeAuthority !== "canonical" && <p className="text-sm">
      First-time setup is handled in <Link href="/inventory/cutover" className="font-medium text-primary underline underline-offset-2">Inventory setup</Link>.
      {" "}Saving or previewing here does not switch the system over.
    </p>}
    {managedHere && view.runtimeAuthority === "canonical" && target.state !== "live" && target.hasPriorLiveStop === undefined && (
      <Callout title="Account setup history is unavailable"
        action={<Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>Reload account status</Button>}>
        Echelon cannot confirm whether this account can resume stock updates. Reload to check again.
      </Callout>
    )}
    {target.hold && <p className="rounded-md border border-orange-200 bg-orange-50 p-3 text-sm text-orange-900 dark:border-orange-800 dark:bg-orange-950/30 dark:text-orange-100">
      <span className="font-medium">Stock hold:</span> {target.hold.reason}
    </p>}
    {managedHere && globalOn === false && target.state !== "live" && (
      <p className="text-sm text-muted-foreground">The all-channel control is also off. Previewing or resuming this account does not turn it on.</p>
    )}
    {managedHere && globalOn === null && target.state !== "live" && (
      <p className="text-sm text-muted-foreground">The all-channel stock-update status is not available.</p>
    )}

    {managedHere && <div className="space-y-3">
      {canPrepare && <div className="space-y-2">
        <Button type="button" disabled={!canActivate || busy} onClick={() => setDialog("include")}>
          Prepare account <ArrowRight className="ml-1 h-4 w-4" aria-hidden="true" />
        </Button>
        <p className="text-xs text-muted-foreground">Include this account in setup checks. This does not send stock updates.</p>
      </div>}
      {canResume && <div className="space-y-2">
        {pending.total > 0 && <p className="text-sm">Review saved changes below to use them. Resuming uses the settings already applied.</p>}
        <div className="flex flex-wrap gap-2">
          {review?.state !== "ready" && <Button type="button" disabled={!canActivate || busy} onClick={() => setDialog("review")}>
            {review ? "Check account again" : "Check before resuming"}
          </Button>}
          {review?.state === "ready" && <Button type="button" disabled={!canActivate || busy} onClick={() => setDialog("resume")}>
            <Play className="mr-1 h-4 w-4" aria-hidden="true" /> Resume stock updates
          </Button>}
        </div>
        <p className="text-xs text-muted-foreground">Checks listing links and applied stock rules against recorded marketplace stock checks.</p>
      </div>}
      {target.state === "live" && <Button type="button" variant="outline" disabled={!canActivate || busy} onClick={() => setDialog("stop")}>
        <Pause className="mr-1 h-4 w-4" aria-hidden="true" /> Pause stock updates
      </Button>}
      {!canActivate && <p className="text-xs text-muted-foreground">Your role can view this setup. Starting or pausing stock updates requires inventory activation permission.</p>}
      {globalOn === false && <GlobalPublishingControl canActivate={canActivate} now={now} triggerLabel="All-channel controls" />}
      {status.error && <Button type="button" variant="outline" size="sm" disabled={status.isFetching} onClick={() => void status.refetch()}>
        Reload all-channel status
      </Button>}
    </div>}
    {review && <ResumeReviewSummary review={review} />}

    <nav aria-label="Stock setup" className="flex flex-wrap gap-2 border-t pt-4">
      <Button type="button" size="sm" variant="outline" onClick={() => onOpenTab("supply")}>Edit warehouses</Button>
      <Button type="button" size="sm" variant="outline" onClick={() => onOpenTab("rules")}>Edit stock rules</Button>
      <Button type="button" size="sm" variant="outline" onClick={() => onOpenTab("quantities")}>View stock preview</Button>
    </nav>
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground">Details for support</summary>
      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
        <KeyValue label="Stock managed by">{PUBLISHER_LABELS[target.publicationAuthority].label}</KeyValue>
        <KeyValue label="Account location">{identity.scope}</KeyValue>
        <KeyValue label="All-channel control">{globalOn === null ? "Unknown" : globalOn ? "On" : "Off"}</KeyValue>
        <KeyValue label="Settings in use">{view.runtimeAuthority === "canonical" ? "Channel Inventory" : "Previous Channel Allocation settings"}</KeyValue>
        <KeyValue label="Account record">#{target.id} · revision {target.revision}</KeyValue>
      </dl>
      {managedHere && target.state === "preview" && <Button type="button" className="mt-4" variant="outline" size="sm"
        disabled={!canActivate || busy} onClick={() => setDialog("exclude")}>Remove from stock setup</Button>}
    </details>

    {dialog === "include" && <ReasonDialog open onOpenChange={open => { if (!open) setDialog(null); }}
      title="Prepare account" description={<p>Include {identity.title} in the checks before stock updates start or resume. This does not turn on automatic stock updates.</p>}
      confirmLabel="Prepare account" pending={inclusion.isPending} onConfirm={reason => inclusion.mutate({ state: "preview", reason })} />}
    {dialog === "exclude" && <ReasonDialog open onOpenChange={open => { if (!open) setDialog(null); }}
      title="Remove from stock setup" description={<p>Exclude {identity.title} from setup checks. You can still preview quantities. Marketplace stock stays unchanged.</p>}
      confirmLabel="Remove from setup" pending={inclusion.isPending} onConfirm={reason => inclusion.mutate({ state: "disabled", reason })} />}
    {dialog === "stop" && <ReasonDialog open onOpenChange={open => { if (!open) setDialog(null); }}
      title={`Pause stock updates for ${identity.title}`} description={<>
        <p>Stop future updates and cancel queued updates for this account.</p>
        <p>Stock already shown in the marketplace stays available to buy. Pausing does not set it to zero.</p>
      </>} confirmLabel="Pause stock updates" destructive pending={stop.isPending} onConfirm={reason => stop.mutate(reason)} />}
    {dialog === "review" && <ReasonDialog open onOpenChange={open => { if (!open) setDialog(null); }}
      title="Check before resuming" description={<>
        <p>Check warehouses, stock rules and listing links for {identity.title} using recorded marketplace stock checks.</p>
        <p>This uses applied settings. Saved changes are reviewed separately below.</p>
      </>} confirmLabel="Check account" pending={reviewMutation.isPending} onConfirm={reason => reviewMutation.mutate(reason)} />}
    {dialog === "resume" && review && <ReasonDialog open onOpenChange={open => { if (!open) setDialog(null); }}
      title={`Resume stock updates for ${identity.title}`} description={<>
        <p>Restart this paused account using its checked settings. Echelon will queue fresh stock quantities.</p>
        {globalOn !== true && <p>The all-channel control must also be on for updates to be sent.</p>}
      </>} confirmLabel="Resume stock updates" pending={resume.isPending} onConfirm={reason => resume.mutate(reason)} />}
  </SectionCard>;
}

function ResumeReviewSummary({ review }: { review: InventoryPublicationTargetResumeReview }) {
  return <div className="space-y-3 rounded-md border p-4 text-sm" aria-label="Stock update check">
    <p className="font-medium">{review.state === "ready" ? "Account checked — ready to resume" : "Stock updates cannot resume yet"}</p>
    <p className="text-xs text-muted-foreground">Checked {formatAbsoluteTime(review.capturedAt)} · {pluralize(review.products.length, "product")}</p>
    {review.blockers.length > 0 && <ul className="list-disc space-y-2 pl-5">
      {[...new Set(review.blockers.map(blocker => describeResumeIssue(blocker.code)))].map(message => <li key={message}>{message}</li>)}
    </ul>}
    <details>
      <summary className="cursor-pointer text-muted-foreground">Check details</summary>
      <p className="my-2 text-xs text-muted-foreground">Check #{review.resumeReviewId} · account revision {review.publicationTargetRevision}</p>
      <ul className="list-disc space-y-2 pl-5">{review.blockers.map((blocker, index) => <li key={`${blocker.code}:${index}`}>
        <p>{blocker.message}</p><code className="break-all text-xs text-muted-foreground">{blocker.code}</code>
      </li>)}</ul>
    </details>
  </div>;
}
