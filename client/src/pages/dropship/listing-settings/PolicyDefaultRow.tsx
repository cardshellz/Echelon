import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ListingSettingsPolicyKind } from "@shared/dropship/listing-settings";
import { Button } from "@/components/ui/button";
import { SM_MIN_WIDTH_PX, useMinWidth } from "@/hooks/use-min-width";
import { listingSetupShippingCheckNotice } from "@/lib/dropship-ebay-listing-setup";
import { refreshEbayListingConfiguration, synchronizeSavedEbayListingSetup } from "@/lib/dropship-ebay-listing-query-sync";
import type { ConnectionBanner, ListingSettingsRight } from "@/lib/dropship-listing-settings-access";
import {
  LISTING_SETTINGS_SAVE_WORDS,
  STORE_DEFAULT_LABELS,
  isDraftDirty,
  isDraftLocked,
  sameDraftValue,
  type ListingSettingsDraft,
  type SavePhase,
} from "@/lib/dropship-listing-settings-drafts";
import {
  EBAY_SELLER_HUB_POLICIES_URL,
  STORE_DEFAULT_EDITOR_WORDS,
  noPolicyOnEbayWords,
  planFromSignature,
  planStoreDefaultPolicySave,
  policyEditorBase,
  policyEditorChoices,
  runStoreSetupSave,
  savedPolicyProblem,
  savedPolicyProblemWords,
  savedShippingPolicyWorks,
  sendStoreSetupRequest,
  setupReadEbay,
  shippingSetupReferenceWords,
  suggestedStorePolicyId,
  type PolicyEditorChoice,
  type StoreSetupSaveCallbacks,
  type StoreSetupSavePlan,
} from "@/lib/dropship-listing-settings-store-requests";
import { WORKS_WITH_CARD_SHELLZ_SHIPPING, rightReasonLine, shippingPolicyNeeds, storeDefaultPolicyValue } from "@/lib/dropship-listing-settings-words";
import { queryErrorMessage, type DropshipEbayListingSetupResponse } from "@/lib/dropship-ops-surface";
import { cn } from "@/lib/utils";
import { EditorSurface } from "./EditorSurface";
import { useListingSettingsDrafts } from "./ListingSettingsDraftsProvider";
import { StoreDefaultRow } from "./StoreDefaultRow";

// ---------------------------------------------------------------------------
// Shared by the W2 and W10 rows (PolicyDefaultRow, ShelfDefaultRow, ShipFromRepairNote)
// ---------------------------------------------------------------------------

/** The live eBay setup read, shared with the old panel and the rail (`ebayListingSetupQueryOptions`). */
export interface ListingSetupRead {
  data?: DropshipEbayListingSetupResponse;
  error?: unknown;
  isFetching: boolean;
  /** React Query's refetch; `throwOnError` makes a failed or cancelled read reject. */
  refetch: (options?: { throwOnError?: boolean }) => Promise<{ data?: DropshipEbayListingSetupResponse; error?: unknown }>;
}

/** A read failed when its latest attempt failed (React Query keeps the older answer beside the error). */
export function readFailed(error: unknown): boolean {
  return error !== undefined && error !== null;
}

/** The setup answer the editors trust: the latest read's, never an older answer a failed refetch left behind. */
export function liveSetup(setup: Pick<ListingSetupRead, "data" | "error">): DropshipEbayListingSetupResponse | null {
  return setup.data !== undefined && !readFailed(setup.error) ? setup.data : null;
}

/** The line under a row that can't be changed, unless the value already says the same. */
export function reasonLineFor(right: ListingSettingsRight, value: string): string | null {
  if (right.editable) return null;
  const line = rightReasonLine(right.reason);
  if (line === null) return null;
  const bare = (text: string) => text.trim().replace(/[.…]+$/, "");
  return bare(line) === bare(value) ? null : line;
}

/** Failed saves an editor may take the latest saved value under: the vendor's changes stay on top. */
const REBASE_PHASES: ReadonlySet<SavePhase> = new Set(["editing", "refused", "rate_limited", "unreachable"]);

/** Whether the draft should take a newer saved value read since it opened ("Here's what's saved now…"). */
export function shouldRebase(draft: ListingSettingsDraft | null, latest: Readonly<Record<string, unknown>> | null): boolean {
  if (draft === null || !draft.open || latest === null || !REBASE_PHASES.has(draft.phase)) return false;
  return !sameDraftValue(draft.base, latest);
}

function errorWords(error: unknown): string {
  return queryErrorMessage(error, LISTING_SETTINGS_SAVE_WORDS.uncertain);
}

/**
 * Runs W2 and W10 saves for a row through the step's one draft: the request
 * key comes from the draft (same request, same key), the answer goes to the
 * shared setup read, and the page's save counter brackets it. A confirmed
 * save closes the editor, so "Saved" shows on the row (R:538).
 */
export function useStoreSetupSave(options: {
  setup: ListingSetupRead;
  saveCallbacks: StoreSetupSaveCallbacks;
  onSaved: () => void;
  onBlocked?: (banner: ConnectionBanner | null) => void;
}) {
  const queryClient = useQueryClient();
  const { startSave, settle, close } = useListingSettingsDrafts();
  const [problem, setProblem] = useState<string | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Builds a plan, or shows why it can't be built (no revision: the reload words). */
  const prepare = useCallback((build: () => StoreSetupSavePlan): StoreSetupSavePlan | null => {
    try {
      setProblem(null);
      return build();
    } catch (error) {
      setProblem(errorWords(error));
      return null;
    }
  }, []);

  const run = useCallback(async (plan: StoreSetupSavePlan): Promise<void> => {
    setProblem(null);
    try {
      const result = await runStoreSetupSave({
        plan,
        callbacks: latest.current.saveCallbacks,
        startSave,
        settle,
        send: sendStoreSetupRequest,
        synchronize: (saved) => synchronizeSavedEbayListingSetup(queryClient, saved),
        refresh: () => refreshEbayListingConfiguration(queryClient, plan.storeConnectionId),
        onSaved: () => latest.current.onSaved(),
        onBlocked: (banner) => {
          latest.current.onBlocked?.(banner);
          // When the code names no single cause, the reads decide the banner; the setup read is this row's.
          void latest.current.setup.refetch();
        },
      });
      if (!mounted.current) return;
      if (result.status === "not_started" && result.reason === "callbacks_refused") setProblem(errorWords(result.error));
      // Rows redraw from the server's answer; the closed draft keeps "Saved" for 3 seconds.
      if (result.status === "settled" && result.settlement.kind !== "failure") close();
    } catch (error) {
      if (mounted.current) setProblem(errorWords(error));
    }
  }, [queryClient, startSave, settle, close]);

  const clearProblem = useCallback(() => setProblem(null), []);
  /** Words for a problem found before anything was sent (the ship-from repair's own setup read). */
  const showProblem = useCallback((words: string) => setProblem(words), []);
  return { run, prepare, problem, clearProblem, showProblem };
}

/**
 * What the last save attempt left to say (R:538-545): a failure and its way
 * forward, the words after "Load latest", or a problem found before sending.
 */
export function StoreSetupSaveNotice({
  draft,
  problem,
  onLoadLatest,
  loadingLatest = false,
}: {
  draft: ListingSettingsDraft | null;
  problem: string | null;
  onLoadLatest?: () => void;
  loadingLatest?: boolean;
}) {
  const lines: ReactNode[] = [];
  if (problem) lines.push(<p key="problem" role="alert" className={ALERT_CLASS}>{problem}</p>);
  if (draft?.message) {
    switch (draft.phase) {
      case "editing":
        lines.push(<p key="message" role="status" className={NOTE_CLASS}>{draft.message}</p>);
        break;
      case "conflict":
        lines.push(
          <div key="message" role="alert" className={ALERT_CLASS}>
            <p>{draft.message}</p>
            {onLoadLatest && (
              <Button type="button" variant="outline" size="sm" className="mt-2" disabled={loadingLatest} onClick={onLoadLatest}>
                {loadingLatest ? STORE_DEFAULT_EDITOR_WORDS.checkingEbay : LISTING_SETTINGS_SAVE_WORDS.loadLatest}
              </Button>
            )}
          </div>,
        );
        break;
      case "reload_required":
        lines.push(
          <div key="message" role="alert" className={ALERT_CLASS}>
            <p>{draft.message}</p>
            <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => window.location.reload()}>
              {LISTING_SETTINGS_SAVE_WORDS.reload}
            </Button>
          </div>,
        );
        break;
      case "uncertain":
      case "unreachable":
      case "refused":
      case "rate_limited":
      case "blocked":
        lines.push(<p key="message" role="alert" className={ALERT_CLASS}>{draft.message}</p>);
        break;
      default:
        break;
    }
  }
  if (lines.length === 0) return null;
  return <div className="space-y-2" data-testid="store-setup-save-notice">{lines}</div>;
}

/** [Cancel] [Save], or [Check again] after a save nobody could confirm (R:541). */
export function StoreSetupEditorFooter({
  draft,
  canSave,
  onCancel,
  onSave,
  onCheckAgain,
  checkAgainDisabled = false,
}: {
  draft: ListingSettingsDraft | null;
  canSave: boolean;
  onCancel: () => void;
  onSave: () => void;
  onCheckAgain: () => void;
  checkAgainDisabled?: boolean;
}) {
  const locked = isDraftLocked(draft);
  const uncertain = draft?.phase === "uncertain";
  return (
    <>
      <Button type="button" variant="outline" disabled={locked} onClick={onCancel}>
        {LISTING_SETTINGS_SAVE_WORDS.cancel}
      </Button>
      {uncertain ? (
        <Button type="button" className={SAVE_CLASS} disabled={checkAgainDisabled} onClick={onCheckAgain}>
          {LISTING_SETTINGS_SAVE_WORDS.checkAgain}
        </Button>
      ) : (
        <Button type="button" className={SAVE_CLASS} disabled={!canSave} onClick={onSave}>
          {draft?.phase === "saving" ? LISTING_SETTINGS_SAVE_WORDS.saving : LISTING_SETTINGS_SAVE_WORDS.save}
        </Button>
      )}
    </>
  );
}

/** "Saved", or "Saved. We couldn't load the latest view." [Reload] (which reads again, R:543), on a closed row. */
export function SavedRowStatus({
  draft,
  flashVisible,
  onReload,
  reloading,
}: {
  draft: ListingSettingsDraft | null;
  flashVisible: boolean;
  onReload: () => void;
  reloading: boolean;
}) {
  if (draft === null) return null;
  if (draft.phase === "saved_view_stale") {
    return (
      <span className="flex flex-wrap items-center gap-2 text-amber-900">
        <span>{LISTING_SETTINGS_SAVE_WORDS.savedViewStale}</span>
        <Button type="button" variant="outline" size="sm" disabled={reloading} onClick={onReload}>
          {LISTING_SETTINGS_SAVE_WORDS.reload}
        </Button>
      </span>
    );
  }
  if (draft.phase === "saved" && flashVisible) return <span className="text-emerald-800">{LISTING_SETTINGS_SAVE_WORDS.saved}</span>;
  return null;
}

/** [Open eBay Seller Hub ↗] and [Check eBay again] (R:196). */
export function EbayChoiceButtons({ checking, onCheckAgain, disabled = false }: { checking: boolean; onCheckAgain: () => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button asChild variant="outline" size="sm">
        <a href={EBAY_SELLER_HUB_POLICIES_URL} target="_blank" rel="noopener noreferrer">
          {STORE_DEFAULT_EDITOR_WORDS.openSellerHub}
        </a>
      </Button>
      <Button type="button" variant="outline" size="sm" disabled={checking || disabled} onClick={onCheckAgain}>
        {checking ? STORE_DEFAULT_EDITOR_WORDS.checkingEbay : STORE_DEFAULT_EDITOR_WORDS.checkEbayAgain}
      </Button>
    </div>
  );
}

const ALERT_CLASS = "rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900";
const NOTE_CLASS = "rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950";
const SAVE_CLASS = "bg-[#C060E0] hover:bg-[#a94bc9]";

// ---------------------------------------------------------------------------
// PolicyDefaultRow
// ---------------------------------------------------------------------------

export interface PolicyDefaultRowProps {
  kind: ListingSettingsPolicyKind;
  /** The live eBay setup read (the step's, shared key). */
  setup: ListingSetupRead;
  /** The summary's saved policy id: it decides "Not set" while the setup read loads or fails. */
  savedPolicyId: string | null;
  /** `rights.shipping` for Shipping, `rights.policies` for Return and Payment (plan 4.3). */
  right: ListingSettingsRight;
  /** After a confirmed save: the step marks the preview stale and reads the listing settings again. */
  onSaved: () => void;
  /** The page's pending-save counter. */
  saveCallbacks: StoreSetupSaveCallbacks;
  /** A save the server blocked: the banner it names (null when the reads decide). */
  onBlocked?: (banner: ConnectionBanner | null) => void;
  /** The phone layout; by default below 640 px. */
  compact?: boolean;
}

/**
 * A Shipping, Return or Payment policy store default (R:124, R:190-199,
 * R:508-512) and its editor: eBay's policies as a radio list, each shipping
 * policy with whether it works with Card Shellz shipping. Saves exactly that
 * policy through W2 (`buildStoreDefaultPolicySave`).
 */
export function PolicyDefaultRow({ kind, setup, savedPolicyId, right, onSaved, saveCallbacks, onBlocked, compact }: PolicyDefaultRowProps) {
  const label = STORE_DEFAULT_LABELS[kind];
  const drafts = useListingSettingsDrafts();
  const { edit, rebase } = drafts;
  const wide = useMinWidth(SM_MIN_WIDTH_PX);
  const changeRef = useRef<HTMLButtonElement>(null);
  const draft = drafts.draft?.editor === kind ? drafts.draft : null;
  const save = useStoreSetupSave({ setup, saveCallbacks, onSaved, onBlocked });
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [reloadingView, setReloadingView] = useState(false);

  const live = liveSetup(setup);
  const value = storeDefaultPolicyValue({ kind, savedPolicyId, setup: { data: setup.data, error: setup.error } });
  const problem = live ? savedPolicyProblem(live, kind) : null;
  const works = kind === "shipping" && live !== null && problem === null && savedShippingPolicyWorks(live);
  const suggestion = live ? suggestedStorePolicyId(live, kind) : null;
  const latestBase = live ? policyEditorBase(live, kind) : null;

  // C18: the lone usable policy is picked for the vendor inside the open editor only, as a change.
  useEffect(() => {
    if (draft === null || !draft.open || draft.phase !== "editing" || draft.changes !== 0) return;
    if (suggestion === null || draft.value.policyId === suggestion) return;
    edit({ policyId: suggestion });
  }, [draft, suggestion, edit]);

  // A newer saved value read while the editor is open (another window, Check eBay again).
  const latestPolicyId = latestBase?.policyId;
  useEffect(() => {
    const latestValue = latestPolicyId === undefined ? null : { policyId: latestPolicyId };
    if (shouldRebase(draft, latestValue) && latestValue) rebase(latestValue);
  }, [draft, latestPolicyId, rebase]);

  const openEditor = () => {
    if (!right.editable || live === null) return;
    drafts.open(kind, label, policyEditorBase(live, kind));
  };

  const choices = live && setupReadEbay(live) ? policyEditorChoices(live, kind) : null;
  const picked = typeof draft?.value.policyId === "string" ? draft.value.policyId : null;
  const pickedChoice = choices?.find((choice) => choice.id === picked) ?? null;
  const canSave = draft !== null && draft.open && isDraftDirty(draft) && !isDraftLocked(draft)
    && right.editable && live !== null && !setup.isFetching && saveCallbacks.disabled !== true
    && pickedChoice !== null && pickedChoice.choosable;

  const onSave = () => {
    if (!canSave || live === null || picked === null) return;
    const plan = save.prepare(() => planStoreDefaultPolicySave(live, kind, picked));
    if (plan) void save.run(plan);
  };
  const onCheckAgain = () => {
    const attempt = draft?.attempt;
    if (draft?.phase !== "uncertain" || !attempt) return;
    const plan = save.prepare(() => planFromSignature(attempt.signature));
    if (plan) void save.run(plan);
  };
  const onLoadLatest = async () => {
    setLoadingLatest(true);
    try {
      const result = await setup.refetch();
      if (result.data !== undefined && !readFailed(result.error)) rebase(policyEditorBase(result.data, kind));
    } finally {
      setLoadingLatest(false);
    }
  };
  const onReloadView = async () => {
    setReloadingView(true);
    try {
      const result = await setup.refetch();
      if (result.data !== undefined && !readFailed(result.error)) drafts.discard();
    } finally {
      setReloadingView(false);
    }
  };
  const onCancel = () => {
    save.clearProblem();
    drafts.discard();
  };

  const status = draft && (draft.phase === "saved" || draft.phase === "saved_view_stale")
    ? <SavedRowStatus draft={draft} flashVisible={drafts.savedFlashVisible} onReload={() => void onReloadView()} reloading={reloadingView} />
    : works ? WORKS_WITH_CARD_SHELLZ_SHIPPING : null;
  const shippingNotice = !right.editable && right.reason === "shipping_setup" && setup.data
    ? listingSetupShippingCheckNotice(setup.data)
    : null;

  return (
    <StoreDefaultRow
      field={kind}
      value={value}
      status={status}
      editable={right.editable && live !== null}
      reason={reasonLineFor(right, value)}
      notSaved={isDraftDirty(draft)}
      onChange={openEditor}
      compact={compact ?? !wide}
      changeRef={changeRef}
    >
      {problem && (
        <div className={cn("mt-2", ALERT_CLASS)} data-testid={`store-default-problem-${kind}`}>
          <p>{savedPolicyProblemWords(kind, problem)}</p>
          {right.editable && live !== null && !draft?.open && (
            <Button type="button" variant="outline" size="sm" className="mt-2" onClick={openEditor}>
              {STORE_DEFAULT_EDITOR_WORDS.chooseAnother}
            </Button>
          )}
        </div>
      )}
      {shippingNotice && (
        <details className="mt-1 text-xs text-zinc-600">
          <summary className="cursor-pointer">{STORE_DEFAULT_EDITOR_WORDS.details}</summary>
          <p className="mt-1">{shippingSetupReferenceWords(shippingNotice.reference)}</p>
        </details>
      )}
      <EditorSurface
        open={draft?.open === true}
        title={label}
        notSaved={isDraftDirty(draft)}
        onClose={drafts.requestClose}
        returnFocusTo={changeRef}
        footer={(
          <StoreSetupEditorFooter
            draft={draft}
            canSave={canSave}
            onCancel={onCancel}
            onSave={onSave}
            onCheckAgain={onCheckAgain}
            checkAgainDisabled={saveCallbacks.disabled === true}
          />
        )}
      >
        <PolicyEditorBody
          kind={kind}
          live={live}
          choices={choices}
          draft={draft}
          suggestion={suggestion}
          right={right}
          checking={setup.isFetching}
          onPick={(policyId) => edit({ policyId })}
          onCheckEbayAgain={() => void setup.refetch()}
        />
        <StoreSetupSaveNotice draft={draft} problem={save.problem} onLoadLatest={() => void onLoadLatest()} loadingLatest={loadingLatest} />
      </EditorSurface>
    </StoreDefaultRow>
  );
}

function PolicyEditorBody({
  kind,
  live,
  choices,
  draft,
  suggestion,
  right,
  checking,
  onPick,
  onCheckEbayAgain,
}: {
  kind: ListingSettingsPolicyKind;
  live: DropshipEbayListingSetupResponse | null;
  choices: PolicyEditorChoice[] | null;
  draft: ListingSettingsDraft | null;
  suggestion: string | null;
  right: ListingSettingsRight;
  checking: boolean;
  onPick: (policyId: string) => void;
  onCheckEbayAgain: () => void;
}) {
  const groupName = useId();
  const locked = isDraftLocked(draft);
  const needs = kind === "shipping" && live ? shippingPolicyNeeds(live.fulfillmentCapability) : null;

  if (choices === null) {
    // The editor stays open with the vendor's pick; eBay's list can't be shown until it's read again.
    const line = right.editable ? STORE_DEFAULT_EDITOR_WORDS.checkingEbay : rightReasonLine(right.reason);
    return (
      <div className="space-y-3">
        {line && <p className="text-sm text-zinc-600">{line}</p>}
        <EbayChoiceButtons checking={checking} onCheckAgain={onCheckEbayAgain} />
      </div>
    );
  }

  if (choices.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-zinc-700">{noPolicyOnEbayWords(kind)}</p>
        <EbayChoiceButtons checking={checking} onCheckAgain={onCheckEbayAgain} />
      </div>
    );
  }

  const noneFits = kind === "shipping" && !choices.some((choice) => choice.choosable);
  const base = draft?.base.policyId ?? null;
  const picked = typeof draft?.value.policyId === "string" ? draft.value.policyId : null;
  return (
    <div className="space-y-3">
      {noneFits && (
        <div className="space-y-2 text-sm text-zinc-700" data-testid="shipping-policy-none-fits">
          <p className="font-medium text-zinc-900">{STORE_DEFAULT_EDITOR_WORDS.noneFits}</p>
          {needs && <ShippingNeeds needs={needs} />}
        </div>
      )}
      <fieldset disabled={locked} className="space-y-2">
        <legend className="sr-only">{STORE_DEFAULT_LABELS[kind]}</legend>
        {draft?.marked.includes("policyId") && (
          <p className="text-xs font-medium text-amber-900">{STORE_DEFAULT_EDITOR_WORDS.changedElsewhereToo}</p>
        )}
        {choices.map((choice) => {
          const checked = picked === choice.id;
          const suggested = checked && choice.id === suggestion && base !== suggestion;
          return (
            <label
              key={choice.id}
              className={cn(
                "flex min-h-11 items-start gap-3 rounded-md border border-zinc-200 bg-white p-3 text-sm",
                choice.choosable ? "cursor-pointer" : "cursor-not-allowed bg-zinc-50",
                checked && "border-[#C060E0]",
              )}
            >
              <input
                type="radio"
                name={groupName}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[#C060E0]"
                checked={checked}
                disabled={!choice.choosable}
                onChange={() => onPick(choice.id)}
              />
              <span className="min-w-0">
                <span className="block break-words font-medium text-zinc-900">{choice.name}</span>
                {choice.fit && (
                  <span className={cn("block text-xs", choice.fit.fit === "works" ? "text-emerald-800" : choice.fit.fit === "cant_use" ? "text-rose-800" : "text-zinc-600")}>
                    {choice.fit.line}
                  </span>
                )}
                {suggested && <span className="block text-xs font-medium text-amber-800">{STORE_DEFAULT_EDITOR_WORDS.suggested}</span>}
              </span>
            </label>
          );
        })}
      </fieldset>
      {needs && !noneFits && (
        <details className="text-sm text-zinc-700">
          <summary className="cursor-pointer font-medium text-zinc-900">{needs.title} ›</summary>
          <div className="mt-2"><ShippingNeeds needs={needs} /></div>
        </details>
      )}
      {!noneFits && <p className="text-sm text-zinc-600">{STORE_DEFAULT_EDITOR_WORDS.sellerHubPrompt}</p>}
      <EbayChoiceButtons checking={checking} onCheckAgain={onCheckEbayAgain} disabled={locked} />
    </div>
  );
}

function ShippingNeeds({ needs }: { needs: NonNullable<ReturnType<typeof shippingPolicyNeeds>> }) {
  return (
    <div className="space-y-1 text-sm text-zinc-700">
      <p>{needs.intro}</p>
      <ul className="list-disc space-y-0.5 pl-5">
        {needs.needs.map((need) => <li key={need}>{need}</li>)}
      </ul>
      <p>{needs.closing}</p>
    </div>
  );
}
