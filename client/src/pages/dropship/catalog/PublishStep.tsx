import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { AlertCircle, ArrowRight, CheckCircle2, Fingerprint, Mail, Search, Send } from "lucide-react";
import { LISTING_PUSH_RUN_ERROR_CODES, type ListingPushRunDetail, type ListingPushRunProblem, type ListingPushRunScope } from "@shared/dropship/listing-push-runs";
import { DROPSHIP_CATALOG_READ_ERROR_CODES, type DropshipCatalogSelectionSummary } from "@shared/dropship/vendor-catalog-reads";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dropshipPortalPath, isDropshipSensitiveProofActive, useDropshipAuth } from "@/lib/dropship-auth";
import {
  CHECK_RETRY_PAUSE_MS,
  RUN_POLL_SLOW_MS,
  checkContextKey,
  describePublishChoices,
  hiddenRunExpired,
  hiddenRunIdFromStorageKey,
  hiddenRunStorageKey,
  isRunFinished,
  isTransientPublishError,
  mergeSelectedPages,
  pressedCount,
  publishRequestFingerprint,
  runPollDelayMs,
  runReadCanRecover,
  shouldShowFoundRun,
  type CheckDetailRow,
  type CheckResult,
  type PublishChoices,
  type SelectedListRow,
} from "@/lib/dropship-catalog-publish";
import {
  createPublishRun,
  latestRunQueryOptions,
  readCheckRowDetail,
  postCheckPreview,
  postPublishRun,
  publishRunBody,
  readRunProblemsPage,
  readSelectedIds,
  runDetailQueryKey,
  runDetailQueryOptions,
  runListingCheck,
  selectedListQueryOptions,
  stopPublishRun,
} from "@/lib/dropship-catalog-publish-requests";
import { PUBLISH_WORDS } from "@/lib/dropship-catalog-publish-words";
import { listingAccessLink, listingAccessNoticeFromError, type ListingAccessNotice } from "@/lib/dropship-listing-access";
import { createDropshipIdempotencyKey, DropshipApiError, isDropshipSiteUpdatingError } from "@/lib/dropship-ops-surface";
import { DropshipListingPreview } from "../DropshipListingPreview";
import { ListingAccessNoticeView } from "./ListingAccessNoticeView";
import { PublishRunCard } from "./PublishRunCard";

/**
 * Catalog step 3, "Publish" (step 1 plan S2-5, PR A, §4.10): the optional
 * chunked Check, "Publish {n} new" and "Publish all {n}" from the selection
 * summary, the run's card with Stop, and the server-paged "Selected items".
 * Publishing is one run the server snapshots from the selection: the page
 * sends a scope and the revision it counted from, never ids, so there is no
 * 500 limit here. The page keeps what must outlive this step (the Check's
 * result and the run being shown); this step owns its requests.
 */

/** The run step 3 shows on a store: one this page started, or a processing one found when the step opened. */
export interface ShownPublishRun {
  storeConnectionId: number;
  runId: number;
  /** The count on the button pressed (for "… were left out"); null for a run this page found. */
  expectedCount: number | null;
}

/** A finished Check, with the page's Listing settings version when it started: a save since makes it out of date. */
export interface SavedCheck {
  result: CheckResult;
  settingsVersion: number;
}

export interface PublishStepProps {
  storeReady: boolean;
  /** The chosen eBay store; 0 when none is ready. */
  storeConnectionId: number;
  storeName: string;
  /** The store's own name, or null when it has none yet (catalogStoreOwnName), for the run card's refusal steps (PR 1b). */
  storeOwnName: string | null;
  /** The selection summary the page reads for step 1's count too (one query, `selectionSummaryQueryOptions`). */
  summary: UseQueryResult<DropshipCatalogSelectionSummary>;
  /** Why this account can't check (preview) or publish (push), when it can't. */
  previewAccessNotice: ListingAccessNotice | null;
  pushAccessNotice: ListingAccessNotice | null;
  /** A Listing settings save is running (step 2's counter, shared as before; PR 10 D10). */
  priceSavePending: boolean;
  /** Moves on every Listing settings save; a Check made before it is out of date. */
  settingsVersion: number;
  savedCheck: SavedCheck | null;
  onCheckChange: (check: SavedCheck | null) => void;
  shownRun: ShownPublishRun | null;
  /** null drops the card (a run that is gone, or one the vendor hid). */
  onShownRunChange: (run: ShownPublishRun | null) => void;
  /** A verification or a publish is being sent: step 2's saves wait for it (as they waited for a push). */
  onBusyChange: (busy: boolean) => void;
  /** A refusal said the account changed: the page reads onboarding again, so its notice and buttons match. */
  onAccountChanged: () => void;
  /** Selection reads to refresh: a publish was refused for a moved selection, or a run ended. */
  onSelectionStale: () => void;
  /** The account's sign-in, read again when a verification was refused. */
  onProofRefused: () => void;
}

type PendingAction = "send-code" | "verify-code" | "passkey-proof" | "publish" | null;

/** A failure of this step's own actions, with the fix when the account caused it. */
interface PublishError {
  message: string;
  notice: ListingAccessNotice | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * Finished runs this viewer hid (review round 2 DUX1). Browser storage is a convenience: it may be missing or throw.
 * A hide older than the week a finished run is shown again is removed as it is read, so the stored hides stay few
 * (verify VC15).
 */
function readHiddenRunIds(nowMs: number): Set<number> {
  const hidden = new Set<number>();
  try {
    if (typeof window === "undefined") return hidden;
    const expired: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      const runId = hiddenRunIdFromStorageKey(key);
      if (runId === null || key === null) continue;
      if (hiddenRunExpired(window.localStorage.getItem(key), nowMs)) expired.push(key);
      else hidden.add(runId);
    }
    for (const key of expired) window.localStorage.removeItem(key);
  } catch {
    // Deliberate: no storage (a private window, blocked site data) only means a hidden card can show again.
  }
  return hidden;
}

function rememberHiddenRun(runId: number, nowMs: number): void {
  try {
    window.localStorage.setItem(hiddenRunStorageKey(runId), String(nowMs));
  } catch {
    // Deliberate: the card is hidden for this visit either way; storage only keeps it hidden after a reload.
  }
}

/** Sends `task` once more after a pause when its first answer was "try again" (review round 2 DUX7: the id read, Stop). */
async function withOneRetry<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (signal?.aborted || !isTransientPublishError(error)) throw error;
    await sleep(CHECK_RETRY_PAUSE_MS);
    if (signal?.aborted) throw error;
    return task();
  }
}

export function PublishStep(props: PublishStepProps) {
  const { storeConnectionId, storeReady } = props;
  const queryClient = useQueryClient();
  const { principal, sensitiveProofs, startEmailStepUp, verifyEmailStepUp, verifyPasskeyStepUp } = useDropshipAuth();
  const [pending, setPendingState] = useState<PendingAction>(null);
  const pendingRef = useRef<PendingAction>(null);
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [verificationCode, setVerificationCode] = useState("");
  const [error, setError] = useState<PublishError | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // "Site updating" while a publish press is sent again (an old dyno answered it, §4.9 item 3).
  const [retrying, setRetrying] = useState(false);
  // A press with no sure answer: the next press of the same choice sends the same key (a replay if it was made).
  const unconfirmedRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const [checking, setChecking] = useState<{ done: number; total: number } | null>(null);
  const [checkFailed, setCheckFailed] = useState<{ done: number; total: number } | null>(null);
  const checkAbortRef = useRef<{ controller: AbortController; contextKey: string } | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  // "Show more" rows, kept with the first page's last id they were read after: a first page that moved since (a problem
  // with a lower id arrived) drops them, so no row falls between the two lists (verify VC3).
  const [moreProblems, setMoreProblems] = useState<{ runId: number; afterFirstPage: number | null; items: ListingPushRunProblem[]; cursor: number | null } | null>(null);
  const [loadingMoreProblems, setLoadingMoreProblems] = useState(false);
  const [moreProblemsFailed, setMoreProblemsFailed] = useState(false);
  // The button pressed: only it shows the step-up's state, and the code line names it (review round 2 DUX9).
  const [pressedScope, setPressedScope] = useState<ListingPushRunScope | null>(null);
  const [hiddenRunIds, setHiddenRunIds] = useState<Set<number>>(() => readHiddenRunIds(Date.now()));

  const summary = props.summary.data;
  // The previous store's answer, kept on screen during a switch, never drives this store's buttons.
  const choices = props.summary.isPlaceholderData ? null : describePublishChoices(summary, storeConnectionId);
  const contextKey = choices ? checkContextKey(storeConnectionId, choices.selectionRevisionId) : null;
  const contextKeyRef = useRef(contextKey);
  contextKeyRef.current = contextKey;
  const activeProof = useMemo(() => isDropshipSensitiveProofActive({
    principal, action: "bulk_listing_push", proof: sensitiveProofs.bulk_listing_push,
  }), [principal, sensitiveProofs.bulk_listing_push]);

  function setPending(action: PendingAction) {
    pendingRef.current = action;
    setPendingState(action);
  }
  const { onBusyChange } = props;
  useEffect(() => {
    onBusyChange(pending !== null);
  }, [pending, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  // The Check is for one store and one selection revision (§4.10): when either moves it is stopped and thrown away.
  const { savedCheck, onCheckChange } = props;
  useEffect(() => {
    const running = checkAbortRef.current;
    if (running && running.contextKey !== contextKey) running.controller.abort();
    if (savedCheck && contextKey !== null && savedCheck.result.contextKey !== contextKey) onCheckChange(null);
  }, [contextKey, savedCheck, onCheckChange]);
  useEffect(() => () => checkAbortRef.current?.controller.abort(), []);
  useEffect(() => {
    setCheckFailed(null);
    setError(null);
    setInfo(null);
    setEmailCodeSent(false);
    setVerificationCode("");
  }, [storeConnectionId]);
  const check = savedCheck && savedCheck.result.contextKey === contextKey ? savedCheck : null;

  // A run still going on this store shows its card again when the step opens (§4.10), and so does a finished one that
  // left sizes unpublished, for a week, until the vendor hides it (review round 2 DUX1: the run's email sends them here).
  const latest = useQuery({ ...latestRunQueryOptions(storeConnectionId), enabled: storeReady && storeConnectionId > 0 });
  const { shownRun, onShownRunChange } = props;
  useEffect(() => {
    const found = latest.data;
    if (!found || found.run.storeConnectionId !== storeConnectionId) return;
    if (!shouldShowFoundRun({ found, nowMs: Date.now(), hiddenRunIds })) return;
    // A newer run replaces the card shown (run ids grow with each run): one a press made whose answer was lost, or
    // one another tab started (verify VC1). The run shown, or an older one, never replaces it.
    if (shownRun?.storeConnectionId === storeConnectionId && found.run.runId <= shownRun.runId) return;
    onShownRunChange({ storeConnectionId, runId: found.run.runId, expectedCount: null });
  }, [latest.data, storeConnectionId, shownRun, onShownRunChange, hiddenRunIds]);
  // The store's newest run is read again after a press made one and when a run ends, so a card the vendor hides never
  // brings back an older run the newer one may have fixed (verify VC2).
  const refreshLatest = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: latestRunQueryOptions(storeConnectionId).queryKey });
  }, [queryClient, storeConnectionId]);

  const runId = shownRun && shownRun.storeConnectionId === storeConnectionId ? shownRun.runId : null;
  // When this page started watching the run: the poll is every 3 s for 2 minutes, then every 15 s (RD:573).
  const watchStartRef = useRef<{ runId: number; at: number } | null>(null);
  if (runId !== null && watchStartRef.current?.runId !== runId) watchStartRef.current = { runId, at: Date.now() };
  const detail = useQuery({
    ...runDetailQueryOptions(runId ?? 1),
    enabled: runId !== null,
    refetchInterval: (query) => {
      const data = query.state.data as ListingPushRunDetail | undefined;
      if (data && isRunFinished(data.run)) return false;
      // A read that can never succeed (the run is gone, or the server can't build its answer) is not polled into the
      // log (review round 2 CT7); a passing failure keeps asking, slowly.
      if (query.state.status === "error" && !runReadCanRecover(query.state.error)) return false;
      if (!data) return RUN_POLL_SLOW_MS;
      return runPollDelayMs(Date.now() - (watchStartRef.current?.at ?? Date.now()));
    },
  });
  // A run that is gone (another vendor's id, or deleted) drops its card (§4.12 NOT_FOUND).
  const runGone = detail.isError && detail.error instanceof DropshipApiError && detail.error.code === LISTING_PUSH_RUN_ERROR_CODES.notFound;
  useEffect(() => {
    if (!runGone || runId === null) return;
    // Kept out for this visit, so the store's newest-run read never puts a gone run back.
    setHiddenRunIds((current) => new Set([...current, runId]));
    onShownRunChange(null);
  }, [runGone, runId, onShownRunChange]);
  const runDetail = runId !== null && detail.data?.run.runId === runId ? detail.data : null;
  const runGoing = runDetail !== null && !isRunFinished(runDetail.run);
  // When a run ends, what is live on the store moved: the count and the lists are read again.
  const { onSelectionStale } = props;
  const endedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!runDetail || !isRunFinished(runDetail.run) || endedRef.current === runDetail.run.runId) return;
    endedRef.current = runDetail.run.runId;
    onSelectionStale();
    refreshLatest();
  }, [runDetail, onSelectionStale, refreshLatest]);
  useEffect(() => {
    setStopFailed(false);
    setMoreProblems(null);
    setMoreProblemsFailed(false);
  }, [runId]);

  const selected = useInfiniteQuery({ ...selectedListQueryOptions(), enabled: storeReady });
  const selectedMerged = useMemo(() => (selected.data ? mergeSelectedPages(selected.data.pages) : null), [selected.data]);

  function showError(caught: unknown, fallback: string) {
    const notice = listingAccessNoticeFromError(caught);
    // The account changed after this page loaded (paused, lapsed, store disconnected): onboarding is read again.
    if (notice) props.onAccountChanged();
    setError({ message: caught instanceof Error && caught.message.trim() ? caught.message : fallback, notice });
  }

  async function runAction(action: Exclude<PendingAction, null>, task: () => Promise<void>): Promise<boolean> {
    setPending(action);
    setError(null);
    setInfo(null);
    try {
      await task();
      return true;
    } catch (caught) {
      showError(caught, PUBLISH_WORDS.notSent);
      return false;
    } finally {
      setPending(null);
    }
  }

  /** "Publish {n} new" or "Publish all {n}": the verification first when none is live, then one run create (§4.10). */
  async function publish(scope: ListingPushRunScope) {
    // Blocked accounts never reach verification, so no code is emailed for a publish the server would refuse.
    if (props.pushAccessNotice) return;
    if (pendingRef.current !== null) return;
    if (props.priceSavePending) {
      // Interim (PR 12 PROPOSAL, kept in stage 2): any Listing settings save holds publishing, not only a price.
      setError({ message: PUBLISH_WORDS.waitForSettings, notice: null });
      return;
    }
    const pressed = choices;
    if (!pressed || pressed.block !== null || runGoing) return;
    setPressedScope(scope);

    if (!activeProof) {
      if (principal?.hasPasskey) {
        const verified = await runAction("passkey-proof", async () => {
          await verifyPasskeyStepUp("bulk_listing_push");
        });
        if (!verified) return;
      } else if (!emailCodeSent) {
        await runAction("send-code", async () => {
          await startEmailStepUp("bulk_listing_push");
          setEmailCodeSent(true);
          setVerificationCode("");
          setInfo(PUBLISH_WORDS.codeSent);
        });
        return;
      } else {
        if (verificationCode.length !== 6) {
          setError({ message: PUBLISH_WORDS.codeIncomplete, notice: null });
          return;
        }
        const verified = await runAction("verify-code", async () => {
          await verifyEmailStepUp({ action: "bulk_listing_push", verificationCode });
        });
        if (!verified) return;
        setEmailCodeSent(false);
        setVerificationCode("");
      }
    }

    await runAction("publish", async () => {
      if (props.priceSavePending || contextKeyRef.current !== checkContextKey(storeConnectionId, pressed.selectionRevisionId)) {
        // The store or the count moved while the vendor verified: nothing is sent; they look and press again.
        setError({ message: PUBLISH_WORDS.selectionChanged, notice: null });
        return;
      }
      const request = { storeConnectionId, scope, expectedSelectionRevisionId: pressed.selectionRevisionId };
      const fingerprint = publishRequestFingerprint(request);
      const key = unconfirmedRef.current?.fingerprint === fingerprint
        ? unconfirmedRef.current.key
        : createDropshipIdempotencyKey("listing-push-run");
      setRetrying(false);
      let outcome;
      try {
        outcome = await createPublishRun({
          post: (body) => postPublishRun(body),
          sleep,
          onRetry: (retryError) => setRetrying(isDropshipSiteUpdatingError(retryError)),
        }, publishRunBody({ ...request, idempotencyKey: key }));
      } finally {
        setRetrying(false);
      }
      if (outcome.kind === "created") {
        unconfirmedRef.current = null;
        onShownRunChange({ storeConnectionId, runId: outcome.run.runId, expectedCount: pressedCount(pressed, scope) });
        refreshLatest();
        return;
      }
      if (outcome.kind === "notSent") {
        // A run may exist (a lost answer): the same choice's next press replays this key, and the store's newest run
        // is read again, so a run that was made replaces whatever card is shown (review round 2 DUX7; verify VC1).
        unconfirmedRef.current = { fingerprint, key };
        setError({ message: PUBLISH_WORDS.notConfirmed, notice: null });
        refreshLatest();
        return;
      }
      const { refusal } = outcome;
      if (refusal.kind === "rateLimited") {
        // Too many presses this minute: nothing was made by this answer, but an earlier try of this press may have gone
        // unanswered, so the key stays for its next press (verify VC6).
        unconfirmedRef.current = { fingerprint, key };
        setError({ message: refusal.message, notice: null });
        return;
      }
      unconfirmedRef.current = null;
      if (refusal.kind === "reread") {
        props.onSelectionStale();
        setError({ message: refusal.message, notice: null });
      } else if (refusal.kind === "showRun") {
        setInfo(refusal.message);
        if (refusal.runId !== null) onShownRunChange({ storeConnectionId, runId: refusal.runId, expectedCount: null });
        // The run going on is newer than any card shown: the newest-run read puts it on screen (verify VC1).
        else refreshLatest();
      } else if (refusal.kind === "stepUp") {
        // The server no longer accepts the verification this page believed was current: read it again, so the next
        // press asks for a new one instead of repeating the same refusal.
        props.onProofRefused();
        setError({ message: refusal.message, notice: null });
      } else {
        const notice = listingAccessNoticeFromError(outcome.error);
        if (notice) props.onAccountChanged();
        setError({ message: refusal.message, notice });
      }
    });
  }

  /** "Check listings" (§4.10, D15): the selected ids, then previews of 200 at a time, one after another. */
  async function runCheck() {
    if (checkAbortRef.current || props.previewAccessNotice || !choices || contextKey === null || props.priceSavePending) return;
    const controller = new AbortController();
    const startedKey = contextKey;
    const startedSettings = props.settingsVersion;
    checkAbortRef.current = { controller, contextKey: startedKey };
    setCheckFailed(null);
    setError(null);
    setInfo(null);
    setChecking({ done: 0, total: choices.allCount });
    try {
      let ids: number[];
      try {
        ids = await withOneRetry(() => readSelectedIds(undefined, controller.signal), controller.signal);
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof DropshipApiError && caught.code === DROPSHIP_CATALOG_READ_ERROR_CODES.idsTooMany) {
          setError({ message: PUBLISH_WORDS.runTooLarge, notice: null });
        } else {
          setCheckFailed({ done: 0, total: choices.allCount });
        }
        return;
      }
      if (ids.length === 0) {
        setError({ message: PUBLISH_WORDS.runEmpty, notice: null });
        return;
      }
      const outcome = await runListingCheck({
        preview: (store, chunk, signal) => postCheckPreview(store, chunk, signal),
        stillCurrent: () => contextKeyRef.current === startedKey,
        sleep,
      }, {
        storeConnectionId, ids, contextKey: startedKey, signal: controller.signal,
        onProgress: (done, total) => setChecking({ done, total }),
      });
      if (outcome.kind === "done") {
        onCheckChange({ result: outcome.result, settingsVersion: startedSettings });
      } else if (outcome.kind === "failed") {
        const notice = listingAccessNoticeFromError(outcome.error);
        if (notice) {
          props.onAccountChanged();
          setError({ message: notice.message, notice });
        } else {
          setCheckFailed({ done: outcome.done, total: outcome.total });
        }
      }
      // Aborted (Stop checking, a store switch, a selection change): nothing is said (§4.13 P10).
    } finally {
      if (checkAbortRef.current?.controller === controller) checkAbortRef.current = null;
      setChecking(null);
    }
  }

  function stopCheck() {
    checkAbortRef.current?.controller.abort();
  }

  async function stop() {
    if (runId === null || stopping) return;
    setStopping(true);
    setStopFailed(false);
    try {
      const answer = await withOneRetry(() => stopPublishRun(runId));
      queryClient.setQueryData<ListingPushRunDetail>(runDetailQueryKey(runId), (old) => (old ? { ...old, run: answer.run, counts: answer.counts } : old));
      void queryClient.invalidateQueries({ queryKey: runDetailQueryKey(runId) });
    } catch (caught) {
      // A stop that did not go through changes nothing (the run goes on). Classified (verify VC9): a run that is gone
      // drops its card; a refusal for good (the session or the account) says why, with its fix; only a passing failure
      // asks for another press.
      handleRunActionError(caught, runId, () => setStopFailed(true));
    } finally {
      setStopping(false);
    }
  }

  /** A Stop or Show more that failed: gone (drop the card), refused for good (its words and fix), or passing (`onPassing`). */
  function handleRunActionError(caught: unknown, failedRunId: number, onPassing: () => void) {
    if (caught instanceof DropshipApiError && caught.code === LISTING_PUSH_RUN_ERROR_CODES.notFound) {
      setHiddenRunIds((current) => new Set([...current, failedRunId]));
      onShownRunChange(null);
      return;
    }
    if (isTransientPublishError(caught) || !(caught instanceof DropshipApiError)) {
      onPassing();
      return;
    }
    showError(caught, PUBLISH_WORDS.stopFailed);
  }

  async function loadMoreProblems() {
    if (runId === null || !runDetail || loadingMoreProblems) return;
    const afterFirstPage = firstPageLastId(runDetail);
    const kept = moreProblems?.runId === runId && moreProblems.afterFirstPage === afterFirstPage ? moreProblems : null;
    const cursor = kept ? kept.cursor : runDetail.problems.nextCursor;
    if (cursor === null) return;
    setLoadingMoreProblems(true);
    setMoreProblemsFailed(false);
    try {
      const page = await withOneRetry(() => readRunProblemsPage(runId, cursor));
      setMoreProblems({ runId, afterFirstPage, items: [...(kept?.items ?? []), ...page.problems.items], cursor: page.problems.nextCursor });
    } catch (caught) {
      // The list shown stays and "Show more" stays to try again; the vendor is told it failed (review round 2 DUX12),
      // unless the run is gone or the read is refused for good (verify VC9).
      handleRunActionError(caught, runId, () => setMoreProblemsFailed(true));
    } finally {
      setLoadingMoreProblems(false);
    }
  }

  function hideRun() {
    if (runId === null) return;
    rememberHiddenRun(runId, Date.now());
    setHiddenRunIds((current) => new Set([...current, runId]));
    onShownRunChange(null);
  }

  const shownMore = moreProblems?.runId === runId && runDetail && moreProblems.afterFirstPage === firstPageLastId(runDetail) ? moreProblems : null;
  const firstIds = new Set(runDetail?.problems.items.map((problem) => problem.productVariantId) ?? []);
  const summarySiteUpdating = props.summary.isFetching && props.summary.failureCount > 0 && isDropshipSiteUpdatingError(props.summary.failureReason);
  // Any other passing failure of the count, while it is read again (or waits for the network): neutral words instead
  // of a blank card for up to 7 minutes (verify VC5).
  const summaryRetrying = !summarySiteUpdating && !props.summary.data
    && ((props.summary.isFetching && props.summary.failureCount > 0) || props.summary.isPaused);

  return (
    <PublishPanel
      storeReady={storeReady}
      storeName={props.storeName}
      storeOwnName={props.storeOwnName}
      accessNotice={props.previewAccessNotice ?? props.pushAccessNotice}
      checkBlocked={props.previewAccessNotice !== null}
      publishBlocked={props.pushAccessNotice !== null}
      priceSavePending={props.priceSavePending}
      summary={summary ?? null}
      summaryFailed={props.summary.isError && !summary}
      onRetrySummary={() => { void props.summary.refetch(); }}
      siteUpdating={retrying || summarySiteUpdating}
      countRetrying={summaryRetrying}
      choices={choices}
      error={error}
      info={info}
      pending={pending}
      pressedScope={pressedScope}
      runGoing={runGoing}
      emailCodeSent={emailCodeSent}
      verificationCode={verificationCode}
      onVerificationCodeChange={setVerificationCode}
      onPublish={(scope) => { void publish(scope); }}
      checking={checking}
      checkFailed={checkFailed}
      check={check ? { result: check.result, stale: check.settingsVersion !== props.settingsVersion } : null}
      onCheck={() => { void runCheck(); }}
      onStopCheck={stopCheck}
      run={runId === null ? null : {
        detail: runDetail,
        unread: detail.isError || (detail.failureCount > 0 && detail.isFetching),
        expectedCount: shownRun?.expectedCount ?? null,
        moreProblems: (shownMore?.items ?? []).filter((problem) => !firstIds.has(problem.productVariantId)),
        nextProblemsCursor: shownMore ? shownMore.cursor : runDetail?.problems.nextCursor ?? null,
        loadingMoreProblems,
        moreProblemsFailed,
        onLoadMoreProblems: () => { void loadMoreProblems(); },
        stopping,
        stopFailed,
        onStop: () => { void stop(); },
        onHide: hideRun,
        // The run this page just started takes focus once its card shows: the pressed button went disabled.
        focusOnShow: shownRun?.expectedCount !== null && shownRun?.expectedCount !== undefined,
      }}
      loadCheckDetail={(productVariantId, signal) => readCheckRowDetail(storeConnectionId, productVariantId, signal)}
      selected={selectedMerged ? { rows: selectedMerged.rows, total: selectedMerged.total } : null}
      selectedFailed={selected.isError && !selectedMerged}
      selectedHasMore={selected.hasNextPage}
      selectedLoadingMore={selected.isFetchingNextPage}
      onLoadMoreSelected={() => { void selected.fetchNextPage(); }}
      onRetrySelected={() => { void selected.refetch(); }}
    />
  );
}

export interface PublishPanelProps {
  storeReady: boolean;
  storeName: string;
  /** The store's own name or null (catalogStoreOwnName), for the run card's refusal steps. */
  storeOwnName: string | null;
  accessNotice: ListingAccessNotice | null;
  checkBlocked: boolean;
  publishBlocked: boolean;
  priceSavePending: boolean;
  summary: DropshipCatalogSelectionSummary | null;
  summaryFailed: boolean;
  onRetrySummary: () => void;
  /** An answer from code older than this page is being retried (§4.9 item 3). */
  siteUpdating: boolean;
  /** The count failed for another passing reason and is read again (verify VC5). */
  countRetrying?: boolean;
  /** This store's choices; null while its count loads. */
  choices: PublishChoices | null;
  error: PublishError | null;
  info: string | null;
  pending: PendingAction;
  /** The publish button last pressed; only it shows the step-up's state (review round 2 DUX9). */
  pressedScope?: ListingPushRunScope | null;
  /** A run is going on this store: a second press would be refused, so the buttons wait. */
  runGoing: boolean;
  emailCodeSent: boolean;
  verificationCode: string;
  onVerificationCodeChange: (value: string) => void;
  onPublish: (scope: ListingPushRunScope) => void;
  checking: { done: number; total: number } | null;
  checkFailed: { done: number; total: number } | null;
  check: { result: CheckResult; stale: boolean } | null;
  onCheck: () => void;
  onStopCheck: () => void;
  run: Omit<Parameters<typeof PublishRunCard>[0], "storeName" | "storeOwnName"> | null;
  selected: { rows: SelectedListRow[]; total: number } | null;
  selectedFailed: boolean;
  selectedHasMore: boolean;
  selectedLoadingMore: boolean;
  onLoadMoreSelected: () => void;
  onRetrySelected: () => void;
  /** Reads one checked size's full preview when its sheet opens (review round 2 DUX2). */
  loadCheckDetail?: (productVariantId: number, signal: AbortSignal) => Promise<CheckDetailRow | null>;
  /** Resolves a portal route to its URL (`dropshipPortalPath` reads the browser's host); injected in tests, which have no window. */
  portalHref?: (path: string) => string;
}

/** The first problem page's last size id: "Show more" read after it. */
function firstPageLastId(detail: ListingPushRunDetail): number | null {
  return detail.problems.items.at(-1)?.productVariantId ?? null;
}

/** Step 3's card, from what PublishStep read; no requests of its own. */
export function PublishPanel(props: PublishPanelProps) {
  const { choices } = props;
  const portalHref = props.portalHref ?? dropshipPortalPath;
  const busy = props.pending !== null;
  const publishOff = !props.storeReady || choices === null || choices.block !== null || props.publishBlocked
    || props.priceSavePending || busy || props.runGoing || props.checking !== null
    || (props.emailCodeSent && props.verificationCode.length !== 6);
  const checkOff = !props.storeReady || choices === null || choices.block !== null || props.checkBlocked
    || props.priceSavePending || props.checking !== null;
  // The step-up's state shows on the button pressed only (review round 2 DUX9); "Publish all" has no count until read.
  const pressed = props.pressedScope ?? (choices?.newCount != null ? "not_live" : "all");
  const pendingFor = (scope: ListingPushRunScope): PendingAction => (props.pending !== null && pressed === scope ? props.pending : null);
  const newLabel = choices?.newCount != null ? PUBLISH_WORDS.publishNew(choices.newCount) : null;
  const allLabel = choices ? PUBLISH_WORDS.publishAll(choices.allCount) : PUBLISH_WORDS.publishAllUncounted;
  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-4" data-testid="publish-step">
      <div>
        <h2 className="text-lg font-semibold">{PUBLISH_WORDS.heading}</h2>
        <p className="mt-1 text-sm text-zinc-500">{PUBLISH_WORDS.publishLine}</p>
        <p className="mt-1 text-xs font-medium text-violet-700">{PUBLISH_WORDS.verifyLine}</p>
      </div>

      {props.accessNotice && <ListingAccessNoticeView notice={props.accessNotice} tone="notice" portalHref={portalHref} />}
      {props.error && (props.error.notice
        // Once the reloaded account explains the same block, the refusal is not repeated.
        ? props.error.notice.resolution !== props.accessNotice?.resolution
          && <ListingAccessNoticeView notice={props.error.notice} tone="error" portalHref={portalHref} />
        : (
          <Alert variant="destructive" className="mt-4" data-testid="publish-error">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{props.error.message}</AlertDescription>
          </Alert>
        ))}
      {props.info && (
        <div role="status" className="mt-4 flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900" data-testid="publish-info">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{props.info}</span>
        </div>
      )}
      {props.siteUpdating && (
        <p role="status" className="mt-4 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900" data-testid="publish-site-updating">
          {PUBLISH_WORDS.siteUpdating}
        </p>
      )}
      {props.countRetrying && !props.siteUpdating && (
        <p role="status" className="mt-4 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900" data-testid="publish-count-retrying">
          {PUBLISH_WORDS.countRetrying}
        </p>
      )}

      {!props.storeReady && (
        <ListingAccessNoticeView tone="notice" portalHref={portalHref} notice={{
          message: PUBLISH_WORDS.storeNotReady,
          resolution: "finish_store_setup",
          link: listingAccessLink("finish_store_setup"),
        }} />
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-3" data-testid="publish-counts">
        <Metric label={PUBLISH_WORDS.selectedMetric} value={props.summary ? props.summary.selectedTotal : null} />
        <Metric label={PUBLISH_WORDS.liveMetric} value={choices ? choices.live : null} />
        <Metric label={PUBLISH_WORDS.newMetric} value={choices ? choices.allCount - choices.live : null} />
      </div>
      {props.summaryFailed && (
        <div role="alert" className="mt-3 flex flex-wrap items-center gap-3 text-sm text-red-800" data-testid="publish-count-failed">
          <span>{PUBLISH_WORDS.countFailed}</span>
          <Button type="button" variant="outline" size="sm" className="h-11 sm:h-9" onClick={props.onRetrySummary}>{PUBLISH_WORDS.tryAgain}</Button>
        </div>
      )}
      {choices?.block === "tooLarge" && <p className="mt-3 text-sm text-amber-900" data-testid="publish-too-large">{PUBLISH_WORDS.runTooLarge}</p>}
      {choices?.block === "empty" && (
        <div className="mt-4 rounded-md border border-dashed border-zinc-300 bg-zinc-50 p-4 text-sm text-zinc-600" data-testid="publish-empty">
          {PUBLISH_WORDS.runEmpty}
        </div>
      )}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start">
        {choices?.newCount != null && (
          <Button type="button" className="h-11 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" disabled={publishOff}
            onClick={() => props.onPublish("not_live")} data-testid="publish-new">
            {publishIcon(pendingFor("not_live"), props.emailCodeSent && pressed === "not_live")}
            {publishLabel(pendingFor("not_live"), newLabel ?? "")}
          </Button>
        )}
        <Button type="button" variant={choices?.newCount != null ? "outline" : "default"}
          className={choices?.newCount != null ? "h-11 gap-2" : "h-11 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"}
          disabled={publishOff} onClick={() => props.onPublish("all")} data-testid="publish-all">
          {choices?.newCount == null && publishIcon(pendingFor("all"), props.emailCodeSent && pressed === "all")}
          {publishLabel(pendingFor("all"), allLabel)}
        </Button>
        <Button type="button" variant="outline" className="h-11 gap-2" disabled={checkOff} onClick={props.onCheck} data-testid="publish-check">
          <Search className="h-4 w-4" />
          {PUBLISH_WORDS.checkButton}
        </Button>
      </div>
      {choices !== null && choices.live > 0 && choices.block === null && (
        <p className="mt-2 text-xs text-zinc-500" data-testid="publish-all-hint">{PUBLISH_WORDS.publishAllHint(choices.live)}</p>
      )}
      <p className="mt-1 text-xs text-zinc-500">{PUBLISH_WORDS.checkHint}</p>

      {props.emailCodeSent && (
        <div className="mt-4 max-w-sm space-y-2 rounded-md border border-violet-200 bg-violet-50 p-4">
          <Label>{PUBLISH_WORDS.codeLabel}</Label>
          <p className="text-xs text-zinc-600">{PUBLISH_WORDS.codeLineFor(pressed === "not_live" && newLabel ? newLabel : allLabel)}</p>
          <InputOTP maxLength={6} value={props.verificationCode} onChange={props.onVerificationCodeChange} containerClassName="justify-between">
            <InputOTPGroup>
              {Array.from({ length: 6 }).map((_, index) => (
                <InputOTPSlot key={index} index={index} className="h-10 w-10 text-sm" />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </div>
      )}

      {props.run && <PublishRunCard {...props.run} storeName={props.storeName} storeOwnName={props.storeOwnName} />}

      {props.checking && (
        <div role="status" className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900" data-testid="publish-checking">
          <span>{PUBLISH_WORDS.checking(props.checking.done, props.checking.total)}</span>
          <progress className="h-2 w-40" aria-label={PUBLISH_WORDS.checkProgressLabel} max={Math.max(1, props.checking.total)} value={props.checking.done} />
          <Button type="button" variant="outline" size="sm" className="h-11 bg-white sm:h-9" onClick={props.onStopCheck}>{PUBLISH_WORDS.stopCheck}</Button>
        </div>
      )}
      {props.checkFailed && !props.checking && (
        <p role="alert" className="mt-4 text-sm text-red-800" data-testid="publish-check-failed">
          {PUBLISH_WORDS.checkFailed(props.checkFailed.done, props.checkFailed.total)}
        </p>
      )}
      {props.check && (
        <>
          <p className="mt-4 text-sm font-medium" data-testid="publish-check-summary">
            {PUBLISH_WORDS.checkSummary(props.check.result.summary.total, props.check.result.summary.ready,
              props.check.result.summary.warnings, props.check.result.summary.blocked)}
          </p>
          {props.check.stale && (
            <div role="status" className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              {props.priceSavePending ? PUBLISH_WORDS.settingsSaving : PUBLISH_WORDS.checkStale}
            </div>
          )}
          <DropshipListingPreview key={props.check.result.contextKey} preview={props.check.result.preview} stale={props.check.stale} portalHref={portalHref}
            loadRowDetail={props.loadCheckDetail} />
        </>
      )}

      {!props.check && props.storeReady && choices?.block !== "empty" && (
        <SelectedItems selected={props.selected} failed={props.selectedFailed} hasMore={props.selectedHasMore}
          loadingMore={props.selectedLoadingMore} onLoadMore={props.onLoadMoreSelected} onRetry={props.onRetrySelected} />
      )}
    </section>
  );
}

function SelectedItems({ selected, failed, hasMore, loadingMore, onLoadMore, onRetry }: {
  selected: { rows: SelectedListRow[]; total: number } | null;
  failed: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
}) {
  if (failed) {
    return (
      <div role="alert" className="mt-4 flex flex-wrap items-center gap-3 text-sm text-red-800" data-testid="publish-selected-failed">
        <span>{PUBLISH_WORDS.listFailed}</span>
        <Button type="button" variant="outline" size="sm" className="h-11 sm:h-9" onClick={onRetry}>{PUBLISH_WORDS.tryAgain}</Button>
      </div>
    );
  }
  if (!selected || selected.rows.length === 0) return null;
  return (
    <div className="mt-4 overflow-hidden rounded-md border border-zinc-200" data-testid="publish-selected">
      <div className="border-b border-zinc-200 bg-zinc-50 px-4 py-3">
        <h3 className="text-sm font-semibold">{PUBLISH_WORDS.selectedHeading}</h3>
        <p className="mt-1 text-xs text-zinc-500">{PUBLISH_WORDS.selectedLine}</p>
        <p className="mt-1 text-xs text-zinc-500" data-testid="publish-selected-shown">{PUBLISH_WORDS.selectedShown(selected.rows.length, selected.total)}</p>
      </div>
      <div className="max-h-72 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{PUBLISH_WORDS.columns.product}</TableHead>
              <TableHead>{PUBLISH_WORDS.columns.variant}</TableHead>
              <TableHead>{PUBLISH_WORDS.columns.sku}</TableHead>
              <TableHead>{PUBLISH_WORDS.columns.quantity}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {selected.rows.map((row) => (
              <TableRow key={row.productVariantId}>
                <TableCell className="font-medium">{row.productName}</TableCell>
                <TableCell>{row.variantName}</TableCell>
                <TableCell className="font-mono text-xs">{row.variantSku || PUBLISH_WORDS.sizeFallback(row.productVariantId)}</TableCell>
                <TableCell className="font-mono">{row.selectionDecision.marketplaceQuantity}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {hasMore && (
        <div className="flex justify-center border-t border-zinc-200 px-4 py-3">
          <Button type="button" variant="outline" className="h-11 sm:h-9" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? PUBLISH_WORDS.loadingMore : PUBLISH_WORDS.loadMore}
          </Button>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-md border border-zinc-200 p-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value === null ? "—" : value.toLocaleString("en-US")}</div>
    </div>
  );
}

function publishLabel(pending: PendingAction, idle: string): string {
  if (pending === "send-code") return PUBLISH_WORDS.sendingCode;
  if (pending === "verify-code") return PUBLISH_WORDS.verifyingCode;
  if (pending === "passkey-proof") return PUBLISH_WORDS.waitingForPasskey;
  if (pending === "publish") return PUBLISH_WORDS.starting;
  return idle;
}

function publishIcon(pending: PendingAction, emailCodeSent: boolean) {
  if (pending === "passkey-proof") return <Fingerprint className="h-4 w-4" />;
  if (pending === "send-code" || (emailCodeSent && pending !== "publish")) return <Mail className="h-4 w-4" />;
  if (pending === "publish") return <Send className="h-4 w-4" />;
  return <ArrowRight className="h-4 w-4" />;
}
