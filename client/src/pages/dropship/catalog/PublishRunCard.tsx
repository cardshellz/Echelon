import { useEffect, useRef } from "react";
import type { ListingPushRunDetail, ListingPushRunProblem } from "@shared/dropship/listing-push-runs";
import { Button } from "@/components/ui/button";
import { describeRun, describeRunProblem, runSnapshotDiff, runSnapshotDiffWords, type RunPhase } from "@/lib/dropship-catalog-publish";
import { PUBLISH_WORDS } from "@/lib/dropship-catalog-publish-words";

/**
 * One publish run on step 3 (step 1 plan S2-5, PR A, §4.10): its progress
 * ("Publishing to marz_cards: 1,200 of 10,000 done"), Stop publishing, and
 * when it ends what happened and the sizes that didn't publish, 50 at a time.
 * Presentational: PublishStep reads and polls the run and sends Stop.
 */
export interface PublishRunCardProps {
  /** The run's newest answer; null until the first read. */
  detail: ListingPushRunDetail | null;
  /** The run could not be read (the page keeps trying). */
  unread: boolean;
  storeName: string;
  /**
   * The store's own name, or null when it has none yet (catalogStoreOwnName): an eBay account refusal's step names
   * the store's "Reconnect <name>" button by it, or the button itself (PR 1b).
   */
  storeOwnName: string | null;
  /** The count on the button the vendor pressed, for "{n} … were left out"; null when this page did not start it. */
  expectedCount: number | null;
  /** Problem sizes read with "Show more", after the first page the detail carries. */
  moreProblems: readonly ListingPushRunProblem[];
  /** The size id to read the next problems after; null when every one is shown. */
  nextProblemsCursor: number | null;
  loadingMoreProblems: boolean;
  /** "Show more" failed; it stays to try again (review round 2 DUX12). */
  moreProblemsFailed?: boolean;
  onLoadMoreProblems: () => void;
  stopping: boolean;
  stopFailed: boolean;
  onStop: () => void;
  /** Hides a finished run's card (review round 2 DUX1); absent while the run goes on. */
  onHide?: () => void;
  /** Move focus to the card's title when it first shows (the run this page just started; review round 2 DUX10). */
  focusOnShow?: boolean;
}

/** "10:42 AM" in the viewer's own time: when a paused run goes on. */
function formatWaitingTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

const PHASE_TONES: Record<RunPhase, string> = {
  publishing: "border-sky-200 bg-sky-50 text-sky-900",
  stopping: "border-amber-300 bg-amber-50 text-amber-900",
  stopped: "border-zinc-300 bg-zinc-50 text-zinc-900",
  providerDown: "border-rose-200 bg-rose-50 text-rose-900",
  finished: "border-emerald-200 bg-emerald-50 text-emerald-900",
  finishedPartial: "border-amber-300 bg-amber-50 text-amber-900",
  finishedNothing: "border-rose-200 bg-rose-50 text-rose-900",
};

export function PublishRunCard(props: PublishRunCardProps) {
  const { detail } = props;
  const titleRef = useRef<HTMLParagraphElement | null>(null);
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!props.focusOnShow || focusedRef.current || !detail) return;
    focusedRef.current = true;
    titleRef.current?.focus();
  }, [props.focusOnShow, detail]);
  if (!detail) {
    return (
      <div role="status" data-testid="publish-run-card" className={`mt-4 rounded-md border p-4 text-sm ${PHASE_TONES.publishing}`}>
        <p>{props.unread ? PUBLISH_WORDS.runUnread : PUBLISH_WORDS.starting}</p>
      </div>
    );
  }
  const view = describeRun(detail.run, detail.counts, props.storeName, { drafts: detail.drafts, waitingUntil: detail.waitingUntil });
  const left = runSnapshotDiff(props.expectedCount, detail.run.targetCount);
  const problems = [...detail.problems.items, ...props.moreProblems];
  return (
    <div data-testid="publish-run-card" data-run-id={detail.run.runId} data-phase={view.phase}
      className={`mt-4 rounded-md border p-4 text-sm ${PHASE_TONES[view.phase]}`}>
      {/* The live region says the phase once, not the counts that change on every poll (review round 2 DUX10). */}
      <p role="status" aria-live="polite" className="sr-only" data-testid="publish-run-announcement">{view.announcement}</p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <p ref={titleRef} tabIndex={-1} className="font-medium outline-none" data-testid="publish-run-title">{view.title}</p>
          {view.countsLine && <p data-testid="publish-run-counts">{view.countsLine}</p>}
          {view.waitingUntil && <p data-testid="publish-run-waiting">{PUBLISH_WORDS.runWaiting(formatWaitingTime(view.waitingUntil))}</p>}
          {view.draftsLine && <p data-testid="publish-run-drafts">{view.draftsLine}</p>}
          {left > 0 && <p data-testid="publish-run-left-out">{runSnapshotDiffWords(detail.run.scope, left)}</p>}
          {props.unread && <p className="text-xs">{PUBLISH_WORDS.runUnread}</p>}
          {props.stopFailed && <p role="alert" className="text-xs text-red-800">{PUBLISH_WORDS.stopFailed}</p>}
        </div>
        {view.canStop && (
          <Button type="button" variant="outline" className="h-11 shrink-0 bg-white" disabled={props.stopping} onClick={props.onStop}>
            {PUBLISH_WORDS.runStop}
          </Button>
        )}
        {!view.polling && props.onHide && (
          <Button type="button" variant="outline" className="h-11 shrink-0 bg-white sm:h-9" onClick={props.onHide} data-testid="publish-run-hide">
            {PUBLISH_WORDS.runHide}
          </Button>
        )}
      </div>
      {view.problemsTitle && problems.length > 0 && (
        <div className="mt-3" data-testid="publish-run-problems">
          <h3 className="text-sm font-semibold">{view.problemsTitle}</h3>
          <ul className="mt-2 space-y-1">
            {problems.map((problem) => {
              const row = describeRunProblem(problem, props.storeOwnName);
              return (
                <li key={row.productVariantId} data-testid={`publish-run-problem-${row.productVariantId}`}>
                  <span className="font-medium">{row.name}</span>: {row.reason}
                  {row.nextStep && <span className="block text-xs" data-testid={`publish-run-problem-step-${row.productVariantId}`}>{row.nextStep}</span>}
                </li>
              );
            })}
          </ul>
          {props.moreProblemsFailed && (
            <p role="alert" className="mt-2 text-xs text-red-800" data-testid="publish-run-more-failed">{PUBLISH_WORDS.moreProblemsFailed}</p>
          )}
          {props.nextProblemsCursor !== null && (
            <Button type="button" variant="outline" size="sm" className="mt-2 h-11 bg-white sm:h-9" disabled={props.loadingMoreProblems}
              onClick={props.onLoadMoreProblems}>
              {props.loadingMoreProblems ? PUBLISH_WORDS.loadingMore : PUBLISH_WORDS.moreProblems}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
