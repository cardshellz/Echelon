import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { InventoryPublicationTargetResumeReview } from "@shared/types/inventory-publication-target-resume";
import { Link } from "wouter";

import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

import { describeError, resumeDestination, reviewResume, setReadinessInclusion, stopDestination } from "../api";
import { formatAbsoluteTime, pluralize } from "../format";
import { invalidateChannelInventory, useCommandKey, usePublishingStatus } from "../hooks";
import {
  PUBLISHER_LABELS,
  describeDestination,
  describePublishing,
  summarizePendingChanges,
  type Channel,
  type Target,
  type View,
} from "../model";
import { Callout, EvidenceNote, KeyValue, PendingPill, ReasonDialog, SectionCard, StatePill } from "./primitives";
import { NoDestinationYet } from "./SupplyTab";

type Command = "include" | "exclude" | "stop" | "review" | "resume";

/** Whether Echelon is allowed to send quantities to the selected destination, and what is pending. */
export function PublishingTab({ view, channel, target, canEdit, canActivate, onAddDestination }: {
  view: View;
  channel: Channel;
  target: Target | null;
  canEdit: boolean;
  canActivate: boolean;
  onAddDestination(): void;
}) {
  if (!target) return <NoDestinationYet canEdit={canEdit} onAdd={onAddDestination} />;
  return <DestinationPublishing key={`${target.id}:${target.revision}`} view={view} channel={channel} target={target} canActivate={canActivate} />;
}

function DestinationPublishing({ view, channel, target, canActivate }: {
  view: View;
  channel: Channel;
  target: Target;
  canActivate: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const status = usePublishingStatus();
  const identity = describeDestination(target, view);
  const publishing = describePublishing(target);
  const pending = summarizePendingChanges(view, channel.id, target.id);
  const [dialog, setDialog] = useState<Command | null>(null);
  const [review, setReview] = useState<InventoryPublicationTargetResumeReview | null>(null);
  const [reviewReason, setReviewReason] = useState<string>("");
  const includeKey = useCommandKey();
  const stopKey = useCommandKey();
  const reviewKey = useCommandKey();
  const resumeKey = useCommandKey();
  const canResume = target.state === "preview" && target.publicationAuthority === "echelon" && view.runtimeAuthority === "canonical";

  const fail = (error: unknown) => {
    const described = describeError(error);
    toast({ title: described.title, description: described.message, variant: "destructive" });
  };
  const refresh = () => invalidateChannelInventory(queryClient);

  const inclusion = useMutation({
    mutationFn: (input: { state: "disabled" | "preview"; reason: string }) => setReadinessInclusion({
      publicationTargetId: target.id,
      expectedRevision: target.revision,
      state: input.state,
      changeReason: input.reason,
      idempotencyKey: includeKey.keyFor(JSON.stringify({ target: target.id, revision: target.revision, ...input })),
    }),
    onSuccess: async (result) => {
      includeKey.clear();
      setDialog(null);
      await refresh();
      toast({
        title: result.state === "preview" ? "Included in readiness review" : "Removed from readiness review",
        description: "Quantities are calculated only. Nothing was sent to the provider.",
      });
    },
    onError: fail,
  });

  const stop = useMutation({
    mutationFn: (reason: string) => stopDestination({
      publicationTargetId: target.id,
      expectedRevision: target.revision,
      changeReason: reason,
      idempotencyKey: stopKey.keyFor(JSON.stringify({ target: target.id, revision: target.revision, reason })),
    }),
    onSuccess: async () => {
      stopKey.clear();
      setDialog(null);
      await refresh();
      toast({
        title: `Publishing stopped for ${identity.title}`,
        description: "Pending updates were superseded. Stock the marketplace already shows was not changed.",
      });
    },
    onError: fail,
  });

  const reviewMutation = useMutation({
    mutationFn: (reason: string) => reviewResume({
      publicationTargetId: target.id,
      expectedRevision: target.revision,
      reason,
      idempotencyKey: reviewKey.keyFor(JSON.stringify({ target: target.id, revision: target.revision, reason })),
    }),
    onSuccess: (result, reason) => {
      reviewKey.clear();
      resumeKey.clear();
      setReview(result);
      setReviewReason(reason);
      setDialog(null);
      toast({
        title: result.state === "ready" ? "Ready to resume" : "Not ready to resume",
        description: result.state === "ready"
          ? `Reviewed ${pluralize(result.products.length, "product")} against fresh provider readbacks.`
          : `${pluralize(result.blockers.length, "blocker")} must be resolved first.`,
        variant: result.state === "ready" ? "default" : "destructive",
      });
    },
    onError: fail,
  });

  const resume = useMutation({
    mutationFn: (reason: string) => {
      if (!review || review.state !== "ready") throw new Error("Run a readiness check that comes back ready first.");
      return resumeDestination({
        publicationTargetId: target.id,
        expectedRevision: target.revision,
        resumeReviewId: review.resumeReviewId,
        expectedEvidenceHash: review.evidenceHash,
        reason,
        idempotencyKey: resumeKey.keyFor(JSON.stringify({ target: target.id, review: review.resumeReviewId, reason })),
      });
    },
    onSuccess: async (result) => {
      resumeKey.clear();
      setReview(null);
      setDialog(null);
      await refresh();
      toast({
        title: `Publishing resumed for ${identity.title}`,
        description: `${pluralize(result.publicationRows, "absolute quantity")} queued for delivery from current availability.`,
      });
    },
    onError: fail,
  });

  const busy = inclusion.isPending || stop.isPending || reviewMutation.isPending || resume.isPending;
  const globalOn = status.data?.global.globalEnabled ?? null;

  return (
    <div className="space-y-4">
      <SectionCard
        title={identity.title}
        description={publishing.explanation}
        actions={<StatePill tone={publishing.tone}>{publishing.label}</StatePill>}
      >
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KeyValue label="Publisher">{PUBLISHER_LABELS[target.publicationAuthority].label}</KeyValue>
          <KeyValue label="Exact scope">{identity.scope}</KeyValue>
          <KeyValue label="Global switch">
            {globalOn === null ? "unknown" : globalOn ? "On for every channel" : "Off for every channel"}
          </KeyValue>
          <KeyValue label="Live allocator">
            {view.runtimeAuthority === "canonical" ? "Channel Inventory (canonical)" : "Legacy Channel Allocation rules"}
          </KeyValue>
        </dl>
        {target.publicationAuthority !== "echelon" && (
          <Callout title={PUBLISHER_LABELS[target.publicationAuthority].label}>
            {PUBLISHER_LABELS[target.publicationAuthority].description} Choosing supply warehouses or
            saving rules here does not transfer publishing ownership to Echelon.
          </Callout>
        )}
        {view.runtimeAuthority !== "canonical" && target.publicationAuthority === "echelon" && (
          <Callout title="Legacy allocator is live">
            Channel quantities are still published from legacy Channel Allocation rules. Everything
            saved here is prepared for the reviewed cutover and does not publish until then.
          </Callout>
        )}
      </SectionCard>

      <SectionCard
        title="Saved changes waiting for activation"
        description="Routine saves are recorded immediately with who, when, and what changed. The live authority keeps using the active configuration until an activation seals these drafts."
      >
        {pending.total === 0 ? (
          <p className="text-sm text-muted-foreground">Everything saved for this destination is already active.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {pending.supply && <li><PendingPill>Supply</PendingPill></li>}
            {pending.channelDefault && <li><PendingPill>Channel default</PendingPill></li>}
            {pending.exceptionCount > 0 && <li><PendingPill>{pluralize(pending.exceptionCount, "exception")}</PendingPill></li>}
            {pending.identityCount > 0 && <li><PendingPill>{pluralize(pending.identityCount, "SKU identity", "SKU identities")}</PendingPill></li>}
          </ul>
        )}
        <EvidenceNote>
          First activation is the reviewed cutover on{" "}
          <Link href="/inventory/cutover" className="underline underline-offset-2">Inventory Cutover</Link>.
          A routine "apply saved changes" step after cutover is not available yet; resuming a stopped
          destination re-uses its active configuration and does not apply pending drafts.
        </EvidenceNote>
      </SectionCard>

      {target.publicationAuthority === "echelon" && (
        <SectionCard
          title="Publishing controls"
          description="These commands change whether Echelon may send quantities. Each one is recorded with a required reason."
        >
          {!canActivate && <Callout>Publishing controls need the inventory activation permission.</Callout>}
          <div className="flex flex-wrap gap-2">
            {target.state === "disabled" && (
              <Button type="button" disabled={!canActivate || busy} onClick={() => setDialog("include")}>
                Include in readiness review
              </Button>
            )}
            {target.state === "preview" && (
              <Button type="button" variant="outline" disabled={!canActivate || busy} onClick={() => setDialog("exclude")}>
                Remove from readiness review
              </Button>
            )}
            {canResume && (
              <Button type="button" variant="outline" disabled={!canActivate || busy} onClick={() => setDialog("review")}>
                Check readiness to resume
              </Button>
            )}
            {canResume && review?.state === "ready" && (
              <Button type="button" disabled={!canActivate || busy} onClick={() => setDialog("resume")}>
                Resume publishing
              </Button>
            )}
            {target.state === "live" && (
              <Button type="button" variant="destructive" disabled={!canActivate || busy} onClick={() => setDialog("stop")}>
                Stop publishing
              </Button>
            )}
          </div>
          {target.state === "disabled" && (
            <EvidenceNote>Readiness review calculates and records quantities for this destination without sending them. It is the step before first activation or a resume.</EvidenceNote>
          )}
          {target.state === "live" && (
            <EvidenceNote>Stopping prevents future updates and supersedes queued ones. It does not set the marketplace quantity to zero.</EvidenceNote>
          )}
          {review && <ResumeReviewSummary review={review} />}
        </SectionCard>
      )}

      {dialog === "include" && (
        <ReasonDialog
          open
          onOpenChange={(open) => { if (!open) setDialog(null); }}
          title="Include in readiness review"
          description={<p>{identity.title} will calculate and record quantities for review. Nothing is sent to the provider, and live publishing is unchanged.</p>}
          confirmLabel="Include"
          pending={inclusion.isPending}
          onConfirm={(reason) => inclusion.mutate({ state: "preview", reason })}
        />
      )}
      {dialog === "exclude" && (
        <ReasonDialog
          open
          onOpenChange={(open) => { if (!open) setDialog(null); }}
          title="Remove from readiness review"
          description={<p>{identity.title} stops calculating readiness quantities. Nothing is sent to the provider.</p>}
          confirmLabel="Remove"
          pending={inclusion.isPending}
          onConfirm={(reason) => inclusion.mutate({ state: "disabled", reason })}
        />
      )}
      {dialog === "stop" && (
        <ReasonDialog
          open
          onOpenChange={(open) => { if (!open) setDialog(null); }}
          title={`Stop publishing to ${identity.title}`}
          description={(
            <>
              <p>Future quantity updates stop and queued ones are superseded.</p>
              <p>Customers can still buy whatever quantity the marketplace currently shows; stopping does not publish zero.</p>
            </>
          )}
          confirmLabel="Stop publishing"
          destructive
          pending={stop.isPending}
          onConfirm={(reason) => stop.mutate(reason)}
        />
      )}
      {dialog === "review" && (
        <ReasonDialog
          open
          onOpenChange={(open) => { if (!open) setDialog(null); }}
          title="Check readiness to resume"
          description={(
            <>
              <p>Captures fresh provider readbacks and checks the active supply, rules, and SKU identities for {identity.title}.</p>
              <p>Uses the active configuration only; saved drafts are not applied by a resume.</p>
            </>
          )}
          confirmLabel="Run readiness check"
          pending={reviewMutation.isPending}
          onConfirm={(reason) => reviewMutation.mutate(reason)}
        />
      )}
      {dialog === "resume" && review && (
        <ReasonDialog
          open
          onOpenChange={(open) => { if (!open) setDialog(null); }}
          title={`Resume publishing to ${identity.title}`}
          description={(
            <>
              <p>Queues one full set of absolute quantities from current availability, bound to readiness check #{review.resumeReviewId}.</p>
              <p>Reason used for the readiness check: “{reviewReason}”.</p>
            </>
          )}
          confirmLabel="Resume publishing"
          pending={resume.isPending}
          onConfirm={(reason) => resume.mutate(reason)}
        />
      )}
    </div>
  );
}

function ResumeReviewSummary({ review }: { review: InventoryPublicationTargetResumeReview }) {
  const readbacks = review.products.reduce((total, product) => total + product.readbacks.length, 0);
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatePill tone={review.state === "ready" ? "live" : "blocked"}>
          {review.state === "ready" ? "Ready to resume" : "Blocked"}
        </StatePill>
        <span className="text-xs text-muted-foreground">
          Readiness check #{review.resumeReviewId} · captured {formatAbsoluteTime(review.capturedAt)} · destination revision {review.publicationTargetRevision}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {pluralize(review.products.length, "product")} reviewed · {pluralize(review.identityCensus.length, "SKU identity", "SKU identities")} · {pluralize(readbacks, "provider readback")}
      </p>
      {review.blockers.length > 0 && (
        <ul className="list-disc space-y-1 pl-4">
          {review.blockers.map((blocker) => (
            <li key={`${blocker.code}:${JSON.stringify(blocker.context)}`}>
              <span className="font-mono text-xs">{blocker.code}</span> — {blocker.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
