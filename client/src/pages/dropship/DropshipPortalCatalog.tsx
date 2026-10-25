import { ListingIntentChanges } from "@/features/channel-listing-publication/ListingIntentChanges";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AlertCircle, Boxes } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  describeListingPushOutcome,
  LISTING_PUSH_POLL_INTERVAL_MS,
  listingPushJobUrl,
  listingPushPollingContinues,
  listingPushPollingGaveUp,
  parseDropshipListingPushJob,
} from "@/lib/dropship-listing-push-status";
import {
  fetchJson,
  listLaunchReadyStoreConnections,
  queryErrorMessage,
  type DropshipEbayStoreCategoryResponse,
  type DropshipOnboardingState,
  type DropshipSettingsResponse,
} from "@/lib/dropship-ops-surface";
import { dropshipPortalPath, useDropshipAuth } from "@/lib/dropship-auth";
import { describeListingAccess, listingAccessLink } from "@/lib/dropship-listing-access";
import { DropshipPortalShell } from "./DropshipPortalShell";
import { CatalogStepRail } from "./catalog/CatalogStepRail";
import { CatalogActionBar, type CatalogNextStepAction } from "./catalog/CatalogActionBar";
import { ChooseStep } from "./catalog/ChooseStep";
import { ListingAccessNoticeView } from "./catalog/ListingAccessNoticeView";
import { PublishStep, type SavedCheck, type ShownPublishRun } from "./catalog/PublishStep";
import { UnsavedChangesProvider, useLeaveGuard, useUnsavedDraft, useUnsavedDrafts } from "./catalog/UnsavedChangesGuard";
import { ListingSettingsDraftsProvider } from "./listing-settings/ListingSettingsDraftsProvider";
import {
  ListingSettingsActionBar,
  ListingSettingsStep,
  countEbayStores,
  type ListingSettingsStepSaveCallbacks,
} from "./listing-settings/ListingSettingsStep";
import { LISTING_SETTINGS_GUARD_ID_PREFIX } from "@/lib/dropship-listing-settings-drafts";
import { scopeWithoutPrefix } from "@/lib/dropship-unsaved-changes";
import { ebayListingSetupQueryOptions } from "@/lib/dropship-ebay-listing-query-sync";
import { listingSettingsQueryKey, listingSettingsSummaryQueryOptions } from "@/lib/dropship-listing-settings";
import {
  CATALOG_STEPS,
  CATALOG_STEP_LABELS,
  catalogBrowserStorage,
  catalogStepFromLocation,
  catalogStepPath,
  catalogStoreOptions,
  catalogStoreOwnName,
  chooseCatalogStore,
  chooseStepTick,
  describeCatalogActionBar,
  describeListingSettingsRail,
  isCatalogLocation,
  readRememberedCatalogStore,
  rememberCatalogStore,
  type CatalogStep,
} from "@/lib/dropship-catalog-steps";
import { CHOOSE_GUARD_ID, EMPTY_CHOOSE_CHANGES, chooseChangesEmpty, reduceChooseChanges } from "@/lib/dropship-catalog-choose";
import { isOlderCatalogServerError } from "@/lib/dropship-catalog-publish";
import { SELECTED_LIST_QUERY_KEY, SELECTION_SUMMARY_QUERY_KEY, selectionSummaryQueryOptions } from "@/lib/dropship-catalog-publish-requests";
import { PUBLISH_WORDS } from "@/lib/dropship-catalog-publish-words";
export { formatListingPreviewIssue as formatIssue } from "@/lib/dropship-listing-preview";
// Moved to step 1's words (step 1 stage 1); re-exported for the page's existing callers and tests.
export { describeCatalogListingTier } from "@/lib/dropship-catalog-choose-words";
// Moved to its own file (step 1 plan S2-5 PR A) so step 3 shares it; re-exported for the page's tests.
export { ListingAccessNoticeView } from "./catalog/ListingAccessNoticeView";

const ONBOARDING_QUERY_KEY = ["/api/dropship/onboarding/state"] as const;

/** The Catalog page, with one guard against leaving Listing settings with changes that aren't saved. */
export default function DropshipPortalCatalog() {
  return (
    <UnsavedChangesProvider>
      <DropshipPortalCatalogPage />
    </UnsavedChangesProvider>
  );
}

function DropshipPortalCatalogPage() {
  const [intentJob, setIntentJob] = useState<{ storeConnectionId: number; jobId: number } | null>(null);
  const queryClient = useQueryClient();
  const leaveGuard = useLeaveGuard();
  const { principal, refetch: refetchAuth } = useDropshipAuth();
  // The store the vendor chose on this visit. Until they choose, the remembered
  // store (or the first eBay store) applies; see chooseCatalogStore.
  const [chosenStoreConnectionId, setChosenStoreConnectionId] = useState<number | null>(null);
  const [location, navigate] = useLocation();
  // A bare /catalog (or an unknown step) shows Choose while the effect below corrects the address.
  const step = catalogStepFromLocation(location);
  const activeStep: CatalogStep = step ?? "choose";
  const [pendingPriceSaves, setPendingPriceSaves] = useState(0);
  const pendingPriceSavesRef = useRef(0);
  // Moves on every Listing settings save: step 3's Check from before it is out of date (PR 10 D9: a save never checks again).
  const [settingsVersion, setSettingsVersion] = useState(0);
  // Step 3's Check and the run it shows live here, so leaving step 3 and coming back keeps them (step 1 plan S2-5 §4.10).
  const [savedCheck, setSavedCheck] = useState<SavedCheck | null>(null);
  const [shownRun, setShownRun] = useState<ShownPublishRun | null>(null);
  // A verification or a publish is being sent on step 3: step 2's saves wait for it, as they waited for a push.
  const publishBusyRef = useRef(false);
  const [publishBusy, setPublishBusyState] = useState(false);
  const setPublishBusy = useCallback((busy: boolean) => {
    publishBusyRef.current = busy;
    setPublishBusyState(busy);
  }, []);
  const guardDrafts = useUnsavedDrafts();
  // The ways onto Listing settings leave the step's own draft out of their question: the page keeps
  // that draft on the other steps, so going back to finish it drops nothing (browser Back to step 1, then Next).
  const toSetupScope = scopeWithoutPrefix(guardDrafts, LISTING_SETTINGS_GUARD_ID_PREFIX);
  // Step 1's unsaved changes live at page level (step 1 stage 1), so a store switch keeps them and a browser Back the
  // guard does not catch never drops them. They are for every store, so the store picker neither asks about them nor
  // drops them, and the rail's way back to step 1 drops nothing; Next from step 1 still asks (toSetupScope holds them).
  const [chooseChanges, dispatchChooseChanges] = useReducer(reduceChooseChanges, EMPTY_CHOOSE_CHANGES);
  const discardChooseChanges = useCallback(() => dispatchChooseChanges({ type: "undo" }), []);
  // While step 1's save runs, the leave question asks the vendor to wait: leaving can't stop it (review MC6).
  const [chooseSaving, setChooseSaving] = useState(false);
  const chooseChangeCount = chooseChanges.add.size + chooseChanges.remove.size;
  useUnsavedDraft(CHOOSE_GUARD_ID, CATALOG_STEP_LABELS.choose, !chooseChangesEmpty(chooseChanges),
    { changes: chooseChangeCount, discard: discardChooseChanges, saving: chooseSaving });
  const toStoreScope = scopeWithoutPrefix(guardDrafts, CHOOSE_GUARD_ID);
  const toChooseScope = scopeWithoutPrefix(guardDrafts, CHOOSE_GUARD_ID);
  const settingsQuery = useQuery<DropshipSettingsResponse>({
    queryKey: ["/api/dropship/settings"],
    queryFn: () => fetchJson<DropshipSettingsResponse>("/api/dropship/settings"),
  });
  // The query the portal shell also runs, so it comes from the cache, and the
  // Onboarding page replaces it the moment the vendor activates.
  const onboardingQuery = useQuery<DropshipOnboardingState>({
    queryKey: [...ONBOARDING_QUERY_KEY],
    queryFn: () => fetchJson<DropshipOnboardingState>(ONBOARDING_QUERY_KEY[0]),
  });
  // vendor.entitlementStatus is the column the server's listing check reads.
  const listingAccount = onboardingQuery.data
    ? { status: onboardingQuery.data.vendor.status, entitlementStatus: onboardingQuery.data.vendor.entitlementStatus }
    : null;
  const previewAccessNotice = describeListingAccess(listingAccount, "preview");
  const pushAccessNotice = describeListingAccess(listingAccount, "push");
  const launchReadyStoreConnections = useMemo(
    () => listLaunchReadyStoreConnections(settingsQuery.data?.settings.storeConnections ?? []),
    [settingsQuery.data?.settings.storeConnections],
  );
  const storeOptions = useMemo(
    () => catalogStoreOptions(settingsQuery.data?.settings.storeConnections ?? []),
    [settingsQuery.data?.settings.storeConnections],
  );
  const memberId = principal?.memberId ?? null;
  const rememberedStoreConnectionId = useMemo(
    () => readRememberedCatalogStore(catalogBrowserStorage(), memberId),
    [memberId],
  );
  // Only an eBay store can be chosen (launch is eBay-only); 0 means none is ready.
  const selectedStoreConnectionIdNumber = chooseCatalogStore(storeOptions, chosenStoreConnectionId ?? rememberedStoreConnectionId) ?? 0;
  // The selection summary (step 1 plan S2-5 §4.8, §4.10): step 1's count, the rail and Next (stage 1's "N selected"),
  // and step 3's two publish buttons, split for the chosen store. Read again after each save (afterSelectionSaved).
  // Read once the stores are known (or could not be), so the first read already names the store step 3 needs.
  const selectionSummaryQuery = useQuery({
    ...selectionSummaryQueryOptions(selectedStoreConnectionIdNumber > 0 ? selectedStoreConnectionIdNumber : null),
    enabled: settingsQuery.data !== undefined || settingsQuery.isError,
  });
  const selectedStoreConnection = launchReadyStoreConnections.find(
    (connection) => connection.storeConnectionId === selectedStoreConnectionIdNumber,
  ) ?? null;
  const selectedStoreName = selectedStoreConnection?.externalDisplayName
    || selectedStoreConnection?.shopDomain
    || "connected eBay store";
  // The push outcome words (the intent-changes job notice and step 3's run card) name a Settings button; without the
  // store's own name they name the button, not a placeholder (PR 1b).
  const selectedStoreOwnName = catalogStoreOwnName(selectedStoreConnection);
  const ebayStoreCategoryQueryKey = [
    "/api/dropship/ebay/store-categories",
    selectedStoreConnectionIdNumber,
  ] as const;
  const ebayStoreCategoryQuery = useQuery<DropshipEbayStoreCategoryResponse>({
    queryKey: ebayStoreCategoryQueryKey,
    queryFn: () => fetchJson<DropshipEbayStoreCategoryResponse>(
      `/api/dropship/ebay/store-categories/${selectedStoreConnectionIdNumber}`,
    ),
    // Only the Listing settings step shows them; other steps never ask eBay for them.
    enabled: selectedStoreConnection?.platform === "ebay" && activeStep === "setup",
    staleTime: 60_000,
  });
  // The rail's line under Listing settings comes from saved settings, read on every step without asking eBay.
  const listingSettingsSummaryQuery = useQuery(listingSettingsSummaryQueryOptions(selectedStoreConnectionIdNumber));
  // The live eBay setup check runs on Listing settings only, in the step's own setup read
  // (ListingSettingsStep). This never fetches: it reads the step's newest answer from the shared
  // cache, for what only eBay can tell.
  const liveListingSetupQuery = useQuery({ ...ebayListingSetupQueryOptions(selectedStoreConnectionIdNumber), enabled: false });

  useEffect(() => {
    if (step !== null || !isCatalogLocation(location)) return;
    navigate(`${dropshipPortalPath(catalogStepPath("choose"))}${window.location.search}`, { replace: true });
  }, [location, navigate, step]);

  /**
   * The saved selection moved (step 1's save, another tab's, a run that ended, a publish refused for a moved
   * selection): the count (the rail tick, PLAN-B v4.1 V25), step 3's selected list and onboarding are read again, and
   * the rail's Listing settings line is marked stale. Step 3's Check goes once the count shows a new revision.
   */
  async function afterSelectionSaved() {
    // Deliberate fire-and-forget (review round 2 DUX4): the count's read retries on the run poll's schedule (up to
    // about 7 minutes while the site updates), and step 1's save waits for this function, so awaiting it kept a save
    // that went through on "Saving…". invalidateQueries never rejects; the count shows when it lands, or its own
    // failure with Try again.
    void queryClient.invalidateQueries({ queryKey: [...SELECTION_SUMMARY_QUERY_KEY] });
    await Promise.allSettled([
      queryClient.invalidateQueries({ queryKey: [...ONBOARDING_QUERY_KEY] }),
      queryClient.invalidateQueries({ queryKey: [...SELECTED_LIST_QUERY_KEY] }),
    ]);
    refreshListingSettings();
  }
  // Step 3 calls it from its effects, so it keeps one identity and always runs this render's afterSelectionSaved.
  const afterSelectionSavedRef = useRef(afterSelectionSaved);
  afterSelectionSavedRef.current = afterSelectionSaved;
  const selectionStale = useCallback(() => {
    // Deliberate fire-and-forget: every read is allSettled inside, and a failed one shows its own Try again.
    void afterSelectionSavedRef.current();
  }, []);

  const chooseSavingChange = useCallback((saving: boolean) => setChooseSaving(saving), []);

  /** A saved change moves the summary the rail reads, so read it again. */
  function refreshListingSettings() {
    if (selectedStoreConnectionIdNumber <= 0) return;
    // Never rejects (throwOnError is off); a failed read shows "Couldn't check" in the rail.
    void queryClient.invalidateQueries({ queryKey: listingSettingsQueryKey(selectedStoreConnectionIdNumber) });
  }

  // The step's saves share one pending-save counter with step 3 (PR 10 D10). A save never checks listings again:
  // it marks step 3's Check out of date, and the vendor checks again there (PR 10 D9).
  const listingSettingsSaveCallbacks: ListingSettingsStepSaveCallbacks = {
    disabled: publishBusy,
    onSaveStarted: () => {
      if (publishBusyRef.current) {
        throw new Error(PUBLISH_WORDS.waitForPublishStart);
      }
      pendingPriceSavesRef.current += 1;
      setPendingPriceSaves(pendingPriceSavesRef.current);
      setSettingsVersion((version) => version + 1);
    },
    onSaveSettled: () => {
      pendingPriceSavesRef.current = Math.max(0, pendingPriceSavesRef.current - 1);
      setPendingPriceSaves(pendingPriceSavesRef.current);
      refreshListingSettings();
    },
  };

  const onCheckChange = useCallback((check: SavedCheck | null) => setSavedCheck(check), []);
  const onShownRunChange = useCallback((run: ShownPublishRun | null) => setShownRun(run), []);
  const onAccountChanged = useCallback(() => {
    // The account changed after this page loaded (paused, lapsed, store disconnected). Reload it so the card's notice
    // and buttons match. Never rejects (throwOnError is off).
    void queryClient.invalidateQueries({ queryKey: [...ONBOARDING_QUERY_KEY] });
  }, [queryClient]);
  const onProofRefused = useCallback(() => { void refetchAuth(); }, [refetchAuth]);

  function chooseStore(storeConnectionId: number) {
    setChosenStoreConnectionId(storeConnectionId);
    rememberCatalogStore(catalogBrowserStorage(), memberId, storeConnectionId);
    // A Check is one store's; the run shown is matched by store, so another store shows its own.
    setSavedCheck(null);
  }

  const storeReady = selectedStoreConnection !== null;
  // Counted from every store the vendor has, so a second store that needs a sign-in still counts (C28).
  const ebayStoreCount = countEbayStores(settingsQuery.data?.settings.storeConnections ?? []);
  const setupRail = describeListingSettingsRail({
    storesLoaded: settingsQuery.data !== undefined,
    storeChosen: storeReady,
    // A failed read wins over older data, so the rail never vouches for a view it could not refresh.
    summary: listingSettingsSummaryQuery.isError ? { status: "failed" }
      : listingSettingsSummaryQuery.data ? { status: "ready", rail: listingSettingsSummaryQuery.data.rail }
      : { status: "loading" },
    // A failed live read cannot vouch either; the problems the last good
    // answer named still show.
    liveSetup: liveListingSetupQuery.isError
      ? {
        missingFields: liveListingSetupQuery.data?.missingFields ?? [],
        checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } },
      }
      : liveListingSetupQuery.data ?? null,
  });
  // The selection summary's count (step 1 plan S2-5 §4.10, stage 1 dependency): one counter for step 1, the rail and Next.
  const selectedCount = selectionSummaryQuery.data?.selectedTotal ?? null;
  // An older catalog server's 503 for this newer page is "updating" too (review round 1 CLI-2).
  const countSiteUpdating = selectionSummaryQuery.isFetching && selectionSummaryQuery.failureCount > 0
    && isOlderCatalogServerError(selectionSummaryQuery.failureReason);
  // Any other passing failure while the count is read again (or waits for the network): neutral words, not a blank
  // count for up to 7 minutes (verify VC5).
  const countRetrying = !countSiteUpdating && selectionSummaryQuery.data === undefined
    && ((selectionSummaryQuery.isFetching && selectionSummaryQuery.failureCount > 0) || selectionSummaryQuery.isPaused);
  const actionBar = describeCatalogActionBar({
    step: activeStep,
    selectedCount,
    storeName: storeReady ? selectedStoreName : null,
  });
  const stepHref = (target: CatalogStep) => dropshipPortalPath(catalogStepPath(target));
  const nextAction: CatalogNextStepAction | null = actionBar.next
    ? {
      label: actionBar.next.label,
      href: stepHref(actionBar.next.step),
      disabled: actionBar.next.disabled,
      ...(actionBar.next.step === "setup" ? { scope: toSetupScope } : {}),
    }
    : null;

  const page = (
    <DropshipPortalShell>
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Boxes className="h-6 w-6 text-[#C060E0]" />
            Catalog
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Choose what to sell, review your listing settings, then publish it to your eBay store.
          </p>
        </div>

        <CatalogStepRail
          current={activeStep}
          hrefFor={stepHref}
          ticks={{ choose: chooseStepTick(selectionSummaryQuery.data?.selectedTotal), setup: setupRail.tick, publish: null }}
          details={{
            choose: selectedCount === null ? "Loading selection" : `${selectedCount} selected`,
            setup: setupRail.line,
          }}
          actions={setupRail.retry
            ? { setup: { label: "Try again", onClick: () => {
              void listingSettingsSummaryQuery.refetch();
              // The live check is read again only where it was read before (Listing settings).
              if (liveListingSetupQuery.data || liveListingSetupQuery.isError) void liveListingSetupQuery.refetch();
            } } }
            : {}}
          leaveScopes={{ setup: toSetupScope, choose: toChooseScope }}
          storeOptions={storeOptions}
          selectedStoreConnectionId={storeReady ? selectedStoreConnectionIdNumber : null}
          onStoreChange={(storeConnectionId) => leaveGuard(() => chooseStore(storeConnectionId), toStoreScope)}
          // Another store drops the Listing settings draft, so a save in flight would never show its answer: the store waits for it.
          storeDisabled={pendingPriceSaves > 0}
        />

        {storeReady && <div className="mt-4">
          <ListingIntentChanges scope={{ kind: "dropship", storeConnectionId: selectedStoreConnectionIdNumber }}
            canEdit={pushAccessNotice === null}
            onReview={row => {
              const link = row.last_error_resolution ? listingAccessLink(row.last_error_resolution) : null;
              if (link) {
                if (link.external) window.open(link.href, "_blank", "noopener,noreferrer");
                else leaveGuard(() => navigate(dropshipPortalPath(link.href)));
              } else leaveGuard(() => navigate(stepHref("setup")));
            }}
            onOpenWork={(_row,action) => {
              if (action.owner === "dropship_listing_push" && action.operationId && /^[1-9][0-9]*$/.test(action.operationId)) {
                const jobId = Number(action.operationId);
                if (Number.isSafeInteger(jobId)) { setIntentJob({storeConnectionId:selectedStoreConnectionIdNumber,jobId}); return true; }
              }
              if (action.owner === "stock_publication" || action.owner === "listing_mapping") {
                leaveGuard(() => navigate(stepHref("setup"))); return true;
              }
              return false;
            }}
            onOpenOperation={row => {
              if (row.receipt?.owner !== "dropship_listing_push" || !/^[1-9][0-9]*$/.test(row.receipt.operationId)) return;
              const jobId = Number(row.receipt.operationId);
              if (Number.isSafeInteger(jobId)) setIntentJob({ storeConnectionId: selectedStoreConnectionIdNumber, jobId });
            }} />
          {intentJob?.storeConnectionId === selectedStoreConnectionIdNumber && <ListingPushOutcomeNotice
            key={intentJob.jobId} jobId={intentJob.jobId} storeName={selectedStoreOwnName}
            queuedMessage="The saved listing workflow is loading. Provider completion is not yet confirmed." />}
        </div>}

        {/* Step 3 says it in its own card, with Try again. Off step 3 (review round 2 DUX11): "site updating" while
            the count is read again after an answer from an older dyno, and once the reads give up, the count's own
            words with Try again (never the retry's "will try again" as final words). */}
        {activeStep !== "publish" && countSiteUpdating && (
          <p role="status" className="mt-5 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900" data-testid="catalog-count-updating">
            {PUBLISH_WORDS.siteUpdating}
          </p>
        )}
        {activeStep !== "publish" && countRetrying && (
          <p role="status" className="mt-5 rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900" data-testid="catalog-count-retrying">
            {PUBLISH_WORDS.countRetrying}
          </p>
        )}
        {activeStep !== "publish" && selectionSummaryQuery.isError && selectionSummaryQuery.data === undefined && !selectionSummaryQuery.isFetching && (
          <Alert variant="destructive" className="mt-5" data-testid="catalog-count-failed">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="flex flex-wrap items-center gap-3">
              <span>{PUBLISH_WORDS.countFailed}</span>
              <Button type="button" variant="outline" size="sm" className="h-11 sm:h-9" onClick={() => { void selectionSummaryQuery.refetch(); }}>
                {PUBLISH_WORDS.tryAgain}
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {settingsQuery.error && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {queryErrorMessage(settingsQuery.error, "Unable to load store connections.")}
            </AlertDescription>
          </Alert>
        )}

        {activeStep === "choose" && (
          <>
            <CatalogStepIntro step="choose" detail="Selection applies to all your stores." />
            <ChooseStep
              selection={selectionSummaryQuery.data ?? null}
              changes={chooseChanges}
              onChanges={dispatchChooseChanges}
              next={nextAction}
              summary={actionBar.summary}
              onSaved={afterSelectionSaved}
              onSavingChange={chooseSavingChange}
            />
          </>
        )}

        {activeStep === "setup" && (
          <>
            {storeReady && (
              <ListingSettingsStep
                key={`listing-settings-${selectedStoreConnectionIdNumber}`}
                storeConnectionId={selectedStoreConnectionIdNumber}
                storeName={selectedStoreName}
                ebayStoreCount={ebayStoreCount}
                account={listingAccount}
                summary={listingSettingsSummaryQuery}
                shelves={ebayStoreCategoryQuery}
                saveCallbacks={listingSettingsSaveCallbacks}
                onSettingsSaved={() => { setSettingsVersion((version) => version + 1); refreshListingSettings(); }}
                goToStep={(target) => leaveGuard(() => navigate(stepHref(target)))}
              />
            )}
            {/* With no launch-ready eBay store the step can't mount: step 2 says what to do instead (PR 12 D4).
                Only once the stores have loaded, so a slow load never tells the vendor to connect a store they have. */}
            {!storeReady && (
              <>
                <CatalogStepIntro step="setup" detail={null} />
                {settingsQuery.data && (
                  <ListingAccessNoticeView tone="notice" notice={{
                    message: "Connect your eBay store and finish its setup to set how your listings look.",
                    resolution: "finish_store_setup",
                    link: listingAccessLink("finish_store_setup"),
                  }} />
                )}
              </>
            )}
          </>
        )}

        {activeStep === "publish" && (
          <>
            <CatalogStepIntro step="publish" detail={storeReady ? PUBLISH_WORDS.stepIntro(selectedStoreName) : null} />
            <PublishStep
              storeReady={storeReady}
              storeConnectionId={selectedStoreConnectionIdNumber}
              storeName={selectedStoreName}
              storeOwnName={selectedStoreOwnName}
              summary={selectionSummaryQuery}
              previewAccessNotice={previewAccessNotice}
              pushAccessNotice={pushAccessNotice}
              priceSavePending={pendingPriceSaves > 0}
              settingsVersion={settingsVersion}
              savedCheck={savedCheck}
              onCheckChange={onCheckChange}
              shownRun={shownRun}
              onShownRunChange={onShownRunChange}
              onBusyChange={setPublishBusy}
              onAccountChanged={onAccountChanged}
              onSelectionStale={selectionStale}
              onProofRefused={onProofRefused}
            />
          </>
        )}

        {/* Step 1 draws its own bar, with its unsaved changes and Save (ChooseStep). */}
        {activeStep === "setup" && storeReady
          ? <ListingSettingsActionBar next={nextAction} saving={pendingPriceSaves > 0} />
          : activeStep === "choose" ? null : <CatalogActionBar summary={actionBar.summary} next={nextAction} />}
      </div>
    </DropshipPortalShell>
  );
  // The Listing settings step's one draft lives at page level, so moving between steps keeps it
  // (plan 4.1). Not keyed by store: a key would remount every step on a store switch; the
  // provider drops its draft itself when the store changes, after the store picker asked.
  return <ListingSettingsDraftsProvider storeConnectionId={selectedStoreConnectionIdNumber}>{page}</ListingSettingsDraftsProvider>;
}

/** The step's name and one line of context, above its panels. */
function CatalogStepIntro({ detail, step }: { step: CatalogStep; detail: string | null }) {
  return (
    <div className="mt-5">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-violet-700">
        Step {CATALOG_STEPS.indexOf(step) + 1} · {CATALOG_STEP_LABELS[step]}
      </h2>
      {detail && <p className="mt-1 text-sm text-zinc-500">{detail}</p>}
    </div>
  );
}

const PUSH_NOTICE_TONES = {
  pending: "border-sky-200 bg-sky-50 text-sky-900",
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  partial: "border-amber-300 bg-amber-50 text-amber-900",
  failed: "border-rose-200 bg-rose-50 text-rose-900",
} as const;

/**
 * Follows the queued job until the worker is done and shows what became of
 * each listing. Polling stops after LISTING_PUSH_MAX_POLLS so a stuck job
 * cannot keep the page asking forever; the vendor is then told where to look.
 */
function ListingPushOutcomeNotice({ jobId, queuedMessage, storeName }: { jobId: number; queuedMessage: string; storeName: string | null }) {
  const url = listingPushJobUrl(jobId);
  const queryKey = [url];
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryKey,
    queryFn: async () => parseDropshipListingPushJob(await fetchJson<unknown>(url)),
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      listingPushPollingContinues(query.state.data, query.state.dataUpdateCount) ? LISTING_PUSH_POLL_INTERVAL_MS : false,
  });
  // The hook's result carries no answer count; the cache state does, and the
  // hook re-renders this notice on every answer, so the read is current.
  const answers = queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0;
  const gaveUp = listingPushPollingGaveUp(statusQuery.data, answers);
  if (!statusQuery.data) {
    return (
      <div role="status" data-testid="listing-queue-result" className={`mt-4 rounded-md border p-4 text-sm ${PUSH_NOTICE_TONES.pending}`}>
        <p>{queuedMessage}</p>
        {statusQuery.isError && <p className="mt-1 text-xs">The result could not be loaded yet. Refresh this page in a minute, or check Notifications.</p>}
      </div>
    );
  }
  const outcome = describeListingPushOutcome(statusQuery.data, storeName);
  return (
    <div role="status" data-testid="listing-queue-result" className={`mt-4 rounded-md border p-4 text-sm ${PUSH_NOTICE_TONES[outcome.tone]}`}>
      <p className="font-medium">{outcome.title}</p>
      {gaveUp && <p className="mt-1 text-xs">Still not finished after a few minutes. Refresh this page later, or check Notifications.</p>}
      <ul className="mt-2 space-y-1" data-testid="listing-push-outcome">
        {outcome.items.map((item) => (
          <li key={item.itemId} data-testid={`listing-push-outcome-${item.itemId}`}>
            <span className="font-medium">{item.name}</span>: {item.line}
            {item.listingUrl && <>{" "}<a className="underline" href={item.listingUrl} target="_blank" rel="noreferrer">{item.listingUrlLabel ?? "View listing"}</a></>}
            {item.nextStep && <span className="block text-xs">{item.nextStep}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
