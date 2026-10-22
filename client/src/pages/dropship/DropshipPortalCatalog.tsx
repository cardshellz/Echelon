import { ListingIntentChanges } from "@/features/channel-listing-publication/ListingIntentChanges";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import {
  AlertCircle,
  ArrowRight,
  Boxes,
  CheckCircle2,
  ExternalLink,
  Fingerprint,
  Mail,
  Search,
  Send,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  describeListingPushOutcome,
  LISTING_PUSH_POLL_INTERVAL_MS,
  listingPushJobUrl,
  listingPushPollingContinues,
  listingPushPollingGaveUp,
  parseDropshipListingPushJob,
} from "@/lib/dropship-listing-push-status";
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  buildListingPreviewRequest,
  buildListingQueueRequest,
  buildQueryUrl,
  createDropshipIdempotencyKey,
  fetchJson,
  isStaleListingPreviewError,
  isStepUpRequiredError,
  describeListingQueueResult,
  listLaunchReadyStoreConnections,
  postJson,
  queryErrorMessage,
  type DropshipCatalogResponse,
  type DropshipCatalogRow,
  type DropshipEbayStoreCategoryResponse,
  type DropshipListingPreviewResponse,
  type DropshipListingPreviewResult,
  type DropshipListingPushResponse,
  type DropshipOnboardingState,
  type DropshipSettingsResponse,
} from "@/lib/dropship-ops-surface";
import { dropshipPortalPath, isDropshipSensitiveProofActive, useDropshipAuth } from "@/lib/dropship-auth";
import {
  describeListingAccess,
  listingAccessLink,
  listingAccessNoticeFromError,
  type ListingAccessLink,
  type ListingAccessNotice,
} from "@/lib/dropship-listing-access";
import { DropshipPortalShell } from "./DropshipPortalShell";
import { DropshipListingPreview } from "./DropshipListingPreview";
import { CatalogStepRail } from "./catalog/CatalogStepRail";
import { CatalogActionBar, type CatalogNextStepAction } from "./catalog/CatalogActionBar";
import { ChooseStep } from "./catalog/ChooseStep";
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
import { CHOOSE_GUARD_ID, EMPTY_CHOOSE_CHANGES, reduceChooseChanges } from "@/lib/dropship-catalog-choose";
import {
  CHOOSE_CATALOG_QUERY_KEY,
  checkChoosePending,
  freshSelectionRulesReader,
  selectionRulesQueryOptions,
  type ChoosePendingSave,
} from "@/lib/dropship-catalog-choose-requests";
import { CHOOSE_WORDS } from "@/lib/dropship-catalog-choose-words";
export { formatListingPreviewIssue as formatIssue } from "@/lib/dropship-listing-preview";
// Moved to step 1's words (step 1 stage 1); re-exported for the page's existing callers and tests.
export { describeCatalogListingTier } from "@/lib/dropship-catalog-choose-words";

type PendingListingAction = "preview" | "send-code" | "verify-code" | "passkey-proof" | "push" | null;
/** A failed preview, verification or push, and the fix when the account caused it. */
interface ListingActionError {
  message: string;
  notice: ListingAccessNotice | null;
}
const ONBOARDING_QUERY_KEY = ["/api/dropship/onboarding/state"] as const;
const SELECTED_CATALOG_PAGE_LIMIT = 200;
type SelectedCatalogPageLoader = (page: number, limit: number) => Promise<DropshipCatalogResponse>;

export async function fetchAllSelectedCatalogRows(
  loadPage: SelectedCatalogPageLoader = (page, limit) => fetchJson<DropshipCatalogResponse>(
    buildQueryUrl("/api/dropship/catalog", {
      selectedOnly: true,
      page,
      limit,
    }),
  ),
): Promise<DropshipCatalogRow[]> {
  const firstPage = await loadPage(1, SELECTED_CATALOG_PAGE_LIMIT);
  const pageCount = Math.max(1, Math.ceil(firstPage.total / firstPage.limit));
  const rowsByVariantId = new Map<number, DropshipCatalogRow>();

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    // Bound request fan-out for large catalogs while retaining deterministic page order.
    const page = pageNumber === 1
      ? firstPage
      : await loadPage(pageNumber, SELECTED_CATALOG_PAGE_LIMIT);
    for (const row of page.rows) {
      rowsByVariantId.set(row.productVariantId, row);
    }
  }

  return Array.from(rowsByVariantId.values());
}

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
  const {
    principal,
    refetch: refetchAuth,
    sensitiveProofs,
    startEmailStepUp,
    verifyEmailStepUp,
    verifyPasskeyStepUp,
  } = useDropshipAuth();
  const [pendingListingAction, setPendingListingActionState] = useState<PendingListingAction>(null);
  const pendingListingActionRef = useRef<PendingListingAction>(null);
  // The store the vendor chose on this visit. Until they choose, the remembered
  // store (or the first eBay store) applies; see chooseCatalogStore.
  const [chosenStoreConnectionId, setChosenStoreConnectionId] = useState<number | null>(null);
  const [location, navigate] = useLocation();
  // A bare /catalog (or an unknown step) shows Choose while the effect below corrects the address.
  const step = catalogStepFromLocation(location);
  const activeStep: CatalogStep = step ?? "choose";
  const [listingPreview, setListingPreview] = useState<DropshipListingPreviewResult | null>(null);
  const [listingPreviewStale, setListingPreviewStale] = useState(false);
  const [pendingPriceSaves, setPendingPriceSaves] = useState(0);
  const pendingPriceSavesRef = useRef(0);
  const previewRequestVersion = useRef(0);
  const [listingPushResult, setListingPushResult] = useState<DropshipListingPushResponse | null>(null);
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [verificationCode, setVerificationCode] = useState("");
  const [message, setMessage] = useState("");
  // Failures of the listing card's own actions (preview, verification, push)
  // show inside that card, next to the buttons that caused them.
  const [listingError, setListingError] = useState<ListingActionError | null>(null);
  const guardDrafts = useUnsavedDrafts();
  // The ways onto Listing settings leave the step's own draft out of their question: the page keeps
  // that draft on the other steps, so going back to finish it drops nothing (browser Back to step 1, then Next).
  const toSetupScope = scopeWithoutPrefix(guardDrafts, LISTING_SETTINGS_GUARD_ID_PREFIX);
  // Step 1's unsaved changes live at page level (step 1 stage 1), so a store switch keeps them and a browser Back the
  // guard does not catch never drops them. They are for every store, so the store picker neither asks about them nor
  // drops them, and the rail's way back to step 1 drops nothing; Next from step 1 still asks (toSetupScope holds them).
  const [chooseChanges, dispatchChooseChanges] = useReducer(reduceChooseChanges, EMPTY_CHOOSE_CHANGES);
  const discardChooseChanges = useCallback(() => dispatchChooseChanges({ type: "undo" }), []);
  // A step 1 save sent with no sure answer, held beside the changes so leaving step 1 never drops it (review MC1).
  const choosePendingRef = useRef<ChoosePendingSave | null>(null);
  // While step 1's save runs, the leave question asks the vendor to wait: leaving can't stop it (review MC6).
  const [chooseSaving, setChooseSaving] = useState(false);
  // What the check below found, shown in step 1's bar (or above the step the vendor is on).
  const [chooseNotice, setChooseNotice] = useState<string | null>(null);
  useUnsavedDraft(CHOOSE_GUARD_ID, CATALOG_STEP_LABELS.choose, chooseChanges.marks.length > 0,
    { changes: chooseChanges.marks.length, discard: discardChooseChanges, saving: chooseSaving });
  const toStoreScope = scopeWithoutPrefix(guardDrafts, CHOOSE_GUARD_ID);
  const toChooseScope = scopeWithoutPrefix(guardDrafts, CHOOSE_GUARD_ID);
  const selectionRulesQuery = useQuery(selectionRulesQueryOptions());
  const selectedCatalogQuery = useQuery<DropshipCatalogRow[]>({
    queryKey: ["/api/dropship/catalog", "selected"],
    queryFn: () => fetchAllSelectedCatalogRows(),
  });
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
  const selectedCatalogRows = selectedCatalogQuery.data ?? [];
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
  const selectedStoreConnectionId = selectedStoreConnectionIdNumber > 0 ? String(selectedStoreConnectionIdNumber) : "";
  // Store/selection identity and a monotonic request version reject late preview responses.
  const previewContextKey = `${selectedStoreConnectionId}:${selectedCatalogRows.map((row) => row.productVariantId).sort((a, b) => a - b).join(",")}`;
  const currentPreviewContext = useRef(previewContextKey);
  currentPreviewContext.current = previewContextKey;
  const selectedStoreConnection = launchReadyStoreConnections.find(
    (connection) => connection.storeConnectionId === selectedStoreConnectionIdNumber,
  ) ?? null;
  const selectedStoreName = selectedStoreConnection?.externalDisplayName
    || selectedStoreConnection?.shopDomain
    || "connected eBay store";
  // The push outcome words name a Settings button; without the store's own name they name the button, not a placeholder.
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
  const activeBulkPushProof = useMemo(() => {
    return isDropshipSensitiveProofActive({
      principal,
      action: "bulk_listing_push",
      proof: sensitiveProofs.bulk_listing_push,
    });
  }, [principal, sensitiveProofs.bulk_listing_push]);

  useEffect(() => {
    if (step !== null || !isCatalogLocation(location)) return;
    navigate(`${dropshipPortalPath(catalogStepPath("choose"))}${window.location.search}`, { replace: true });
  }, [location, navigate, step]);

  useEffect(() => {
    invalidateListingPreview();
  }, [previewContextKey]);

  function setPendingListingAction(action: PendingListingAction | ((current: PendingListingAction) => PendingListingAction)) {
    const next = typeof action === "function" ? action(pendingListingActionRef.current) : action;
    pendingListingActionRef.current = next;
    setPendingListingActionState(next);
  }

  /**
   * After step 1's save went through: the saved count, the rules (the rail tick) and onboarding are read again, and
   * step 3's preview and the rail's Listing settings line are marked stale. Step 1 reloads its own list.
   */
  async function afterSelectionSaved() {
    await Promise.allSettled([
      selectedCatalogQuery.refetch(),
      selectionRulesQuery.refetch(),
      queryClient.invalidateQueries({ queryKey: [...ONBOARDING_QUERY_KEY] }),
    ]);
    invalidateListingPreview();
    refreshListingSettings();
  }

  /**
   * Step 1's changes are all gone (Undo, "Discard and leave", or a reload that showed them saved) while a save that may
   * have gone through is held: read the rules before forgetting it (review MC1). If it went through, or the rules moved
   * some other way since it was built (verify V2), everything is read again and the vendor is told; if the rules can't
   * be read, they are told to reload. Unchanged rules: it never went through, nothing to say.
   */
  useEffect(() => {
    if (chooseChanges.marks.length > 0) {
      setChooseNotice(null);
      return;
    }
    const pending = choosePendingRef.current;
    choosePendingRef.current = null;
    if (!pending?.mayHaveCommitted) return;
    // Deliberate fire-and-forget: checkChoosePending never rejects (a failed read is its "unreadable" answer), the
    // reads after it are allSettled, and its outcome is shown as a notice.
    void (async () => {
      const found = await checkChoosePending(freshSelectionRulesReader(queryClient), pending);
      if (found === "wentThrough" || found === "moved") {
        // Step 1's lists were read under the old rules: a list not on screen is dropped (read afresh when shown), the
        // one on screen is read again.
        queryClient.removeQueries({ queryKey: [...CHOOSE_CATALOG_QUERY_KEY], type: "inactive" });
        await Promise.allSettled([queryClient.invalidateQueries({ queryKey: [...CHOOSE_CATALOG_QUERY_KEY] }), afterSelectionSaved()]);
        setChooseNotice(found === "wentThrough" ? CHOOSE_WORDS.undoneButSaved : CHOOSE_WORDS.pendingMoved);
      } else if (found === "unreadable") {
        setChooseNotice(CHOOSE_WORDS.undoneUnknown);
      }
    })();
    // Runs when the count of changes moves; the closures it uses are this render's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chooseChanges.marks.length]);

  const chooseSavingChange = useCallback((saving: boolean) => {
    setChooseSaving(saving);
    if (saving) setChooseNotice(null);
  }, []);

  /** A saved change moves the summary the rail reads, so read it again. */
  function refreshListingSettings() {
    if (selectedStoreConnectionIdNumber <= 0) return;
    // Never rejects (throwOnError is off); a failed read shows "Couldn't check" in the rail.
    void queryClient.invalidateQueries({ queryKey: listingSettingsQueryKey(selectedStoreConnectionIdNumber) });
  }

  function invalidateListingPreview(keepVisible = false) {
    previewRequestVersion.current += 1;
    setPendingListingAction((current) => current === "preview" ? null : current);
    setListingPreviewStale(true);
    if (!keepVisible) setListingPreview(null);
    setListingPushResult(null);
    setEmailCodeSent(false);
    setVerificationCode("");
  }

  async function refreshListingPreview(expectedContext = previewContextKey) {
    if (currentPreviewContext.current !== expectedContext) {
      throw new Error("The store or catalog selection changed. Generate a preview for your current selection.");
    }
    const requestVersion = ++previewRequestVersion.current;
    setPendingListingAction("preview");
    setListingError(null);
    setMessage("");
    setListingPreviewStale(true);
    setListingPushResult(null);
    try {
      const request = buildListingPreviewRequest({
        storeConnectionId: selectedStoreConnectionIdNumber,
        rows: selectedCatalogRows,
      });
      if (request.productVariantIds.length === 0) {
        throw new Error("Select at least one catalog item before previewing listings.");
      }
      const response = await postJson<DropshipListingPreviewResponse>("/api/dropship/listings/preview", request);
      if (currentPreviewContext.current !== expectedContext || previewRequestVersion.current !== requestVersion) {
        throw new Error("Listing settings changed during the refresh. Generate a fresh preview.");
      }
      if (response.preview.storeConnectionId !== request.storeConnectionId) {
        throw new Error("The preview returned a different store. Please refresh the preview.");
      }
      setListingPreview(response.preview);
      setListingPreviewStale(false);
      setMessage("Listing preview generated.");
    } finally {
      if (previewRequestVersion.current === requestVersion) setPendingListingAction(null);
    }
  }

  async function previewListings() {
    // The card explains the block and disables the button; this only stops a stray click.
    if (pendingPriceSavesRef.current > 0 || previewAccessNotice) return;
    try {
      await refreshListingPreview();
    } catch (caught) {
      showListingError(caught, "Listing preview failed.");
    }
  }

  // The step's saves share one pending-save counter with step 3 (PR 10 D10). A save never posts a preview:
  // it marks step 3's preview stale, and step 3 checks again when the vendor gets there (PR 10 D9).
  const listingSettingsSaveCallbacks: ListingSettingsStepSaveCallbacks = {
    disabled: pendingListingAction !== null && pendingListingAction !== "preview",
    onSaveStarted: () => {
      if (pendingListingActionRef.current !== null && pendingListingActionRef.current !== "preview") {
        throw new Error("Wait for the current listing action to finish before saving listing changes.");
      }
      pendingPriceSavesRef.current += 1;
      setPendingPriceSaves(pendingPriceSavesRef.current);
      invalidateListingPreview(true);
    },
    onSaveSettled: () => {
      pendingPriceSavesRef.current = Math.max(0, pendingPriceSavesRef.current - 1);
      setPendingPriceSaves(pendingPriceSavesRef.current);
      refreshListingSettings();
    },
  };

  async function pushListings() {
    // Blocked accounts never reach verification, so no code is emailed for a
    // push the server would refuse. The card already says what to do.
    if (pushAccessNotice) return;
    if (pendingPriceSavesRef.current > 0) {
      // Interim (PR 12 PROPOSAL): any Listing settings save holds the queue, not only a price.
      setListingError({ message: "Wait for your listing settings to finish saving, then queue again.", notice: null });
      return;
    }
    if (selectedCatalogRows.length === 0) {
      setListingError({ message: "Select at least one catalog item before queueing listings.", notice: null });
      return;
    }
    const expectedContext = previewContextKey;

    if (!activeBulkPushProof) {
      if (principal?.hasPasskey) {
        const verified = await runListingAction("passkey-proof", async () => {
          await verifyPasskeyStepUp("bulk_listing_push");
        });
        if (!verified) return;
      } else if (!emailCodeSent) {
        await runListingAction("send-code", async () => {
          await startEmailStepUp("bulk_listing_push");
          setEmailCodeSent(true);
          setVerificationCode("");
          setMessage("Verification code sent.");
        });
        return;
      } else {
        if (verificationCode.length !== 6) {
          setListingError({ message: "Enter the 6-digit verification code before queueing a listing push.", notice: null });
          return;
        }
        const verified = await runListingAction("verify-code", async () => {
          await verifyEmailStepUp({
            action: "bulk_listing_push",
            verificationCode,
          });
        });
        if (!verified) return;
        setEmailCodeSent(false);
        setVerificationCode("");
      }
    }

    await runListingAction("push", async () => {
      if (currentPreviewContext.current !== expectedContext || pendingPriceSavesRef.current > 0) {
        throw new Error("Your store or selection changed while you were verifying. Choose Queue ready listings again.");
      }
      // One step: the server previews the selected items itself and queues the
      // ready ones, so no earlier preview is needed or echoed.
      const request = buildListingQueueRequest({
        storeConnectionId: selectedStoreConnectionIdNumber,
        rows: selectedCatalogRows,
        idempotencyKey: createDropshipIdempotencyKey("listing-push"),
      });
      const response = await queueListingsOnce(request);
      // The returned preview is exactly what was queued: show it as current and
      // drop any preview response still in flight. The card's notice says what
      // was queued, so the page banner stays quiet.
      previewRequestVersion.current += 1;
      setListingPreview(response.preview);
      setListingPreviewStale(false);
      setListingPushResult(response);
      setEmailCodeSent(false);
      setVerificationCode("");
      await Promise.all([
        // Marks step 1's list stale; it reads again when step 1 shows.
        queryClient.invalidateQueries({ queryKey: [...CHOOSE_CATALOG_QUERY_KEY] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/settings"] }),
      ]);
    });
  }

  /**
   * The server refuses a push if a description, price or rule changed between
   * its own preview and the moment the job row is written. That refusal writes
   * nothing, so the same request (same key) is sent once more; a second refusal
   * is shown to the vendor.
   */
  async function queueListingsOnce(request: ReturnType<typeof buildListingQueueRequest>): Promise<DropshipListingPushResponse> {
    try {
      return await postJson<DropshipListingPushResponse>("/api/dropship/listing-push-jobs", request);
    } catch (caught) {
      if (!isStaleListingPreviewError(caught)) throw caught;
      return postJson<DropshipListingPushResponse>("/api/dropship/listing-push-jobs", request);
    }
  }

  async function runListingAction(action: PendingListingAction, task: () => Promise<void>): Promise<boolean> {
    setPendingListingAction(action);
    setListingError(null);
    setMessage("");
    try {
      await task();
      return true;
    } catch (caught) {
      if (isStaleListingPreviewError(caught)) {
        invalidateListingPreview(true);
      }
      showListingError(caught, "Listing request failed.");
      return false;
    } finally {
      setPendingListingAction(null);
    }
  }

  function showListingError(caught: unknown, fallback: string) {
    if (isStepUpRequiredError(caught)) {
      // The server no longer accepts the verification this page believed was
      // current. Reload it so the next click asks for a new one instead of
      // repeating the same refusal.
      void refetchAuth();
      setListingError({
        message: "Your verification expired before the push was queued. Choose Queue ready listings again to verify.",
        notice: null,
      });
      return;
    }
    const notice = listingAccessNoticeFromError(caught);
    // The account changed after this page loaded (paused, lapsed, store
    // disconnected). Reload it so the card's notice and buttons match.
    if (notice) void queryClient.invalidateQueries({ queryKey: [...ONBOARDING_QUERY_KEY] });
    setListingError({ message: caught instanceof Error ? caught.message : fallback, notice });
  }

  function chooseStore(storeConnectionId: number) {
    setChosenStoreConnectionId(storeConnectionId);
    rememberCatalogStore(catalogBrowserStorage(), memberId, storeConnectionId);
    setListingError(null);
    invalidateListingPreview();
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
  const selectedCount = selectedCatalogQuery.isLoading ? null : selectedCatalogRows.length;
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
          ticks={{ choose: chooseStepTick(selectionRulesQuery.data?.rules), setup: setupRail.tick, publish: null }}
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

        {message && (
          <Alert className="mt-5 border-emerald-200 bg-emerald-50 text-emerald-900">
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
        {chooseNotice && activeStep !== "choose" && (
          <Alert className="mt-5" data-testid="catalog-choose-notice">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{chooseNotice}</AlertDescription>
          </Alert>
        )}
        {/* Step 1 shows its own card for this read (ChooseStep), and a failed re-read keeps its rules on screen, so the
            page says it only off step 1 and only with nothing to show: one cause, one message (verify V4). */}
        {activeStep !== "choose" && selectionRulesQuery.isError && selectionRulesQuery.data === undefined && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {queryErrorMessage(selectionRulesQuery.error, "Unable to load catalog selection rules.")}
            </AlertDescription>
          </Alert>
        )}
        {selectedCatalogQuery.error && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {queryErrorMessage(selectedCatalogQuery.error, "Unable to load your selected catalog items.")}
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
              selectedCount={selectedCount}
              changes={chooseChanges}
              onChanges={dispatchChooseChanges}
              pendingRef={choosePendingRef}
              notice={chooseNotice}
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
                onSettingsSaved={() => { invalidateListingPreview(true); refreshListingSettings(); }}
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
            <CatalogStepIntro step="publish" detail={storeReady ? `Preview and queue your selected listings to ${selectedStoreName}.` : null} />
            <ListingPreviewPanel
              accessNotice={previewAccessNotice ?? pushAccessNotice}
              previewBlocked={previewAccessNotice !== null}
              pushBlocked={pushAccessNotice !== null}
              listingError={listingError}
              storeReady={storeReady}
              emailCodeSent={emailCodeSent}
              listingPreview={listingPreview}
              listingPreviewStale={listingPreviewStale}
              priceSavePending={pendingPriceSaves > 0}
              listingPushResult={listingPushResult}
              selectedStoreName={selectedStoreOwnName}
              pendingListingAction={pendingListingAction}
              selectedRows={selectedCatalogRows}
              verificationCode={verificationCode}
              onPreview={previewListings}
              onPush={pushListings}
              onVerificationCodeChange={setVerificationCode}
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

function ListingPreviewPanel({
  accessNotice,
  emailCodeSent,
  listingPreview,
  listingPreviewStale,
  priceSavePending,
  listingPushResult,
  selectedStoreName,
  onPreview,
  onPush,
  onVerificationCodeChange,
  pendingListingAction,
  previewBlocked,
  pushBlocked,
  selectedRows,
  storeReady,
  verificationCode,
  listingError,
}: {
  /** Why this account cannot preview or push, when it cannot. */
  accessNotice: ListingAccessNotice | null;
  emailCodeSent: boolean;
  listingPreview: DropshipListingPreviewResult | null;
  listingPreviewStale: boolean;
  priceSavePending: boolean;
  listingPushResult: DropshipListingPushResponse | null;
  /** The store's own name for the push outcome, or null when it has none yet (catalogStoreOwnName). */
  selectedStoreName: string | null;
  onPreview: () => void;
  onPush: () => void;
  onVerificationCodeChange: (value: string) => void;
  pendingListingAction: PendingListingAction;
  previewBlocked: boolean;
  pushBlocked: boolean;
  selectedRows: DropshipCatalogRow[];
  /** An eBay store is chosen in the rail. */
  storeReady: boolean;
  verificationCode: string;
  listingError: ListingActionError | null;
}) {
  const selectedRowCount = selectedRows.length;
  const previewDisabled = !storeReady
    || selectedRowCount === 0
    || priceSavePending
    || pendingListingAction !== null
    || previewBlocked;
  // Queueing needs no preview: the server previews the selection itself.
  const pushDisabled = !storeReady
    || selectedRowCount === 0
    || priceSavePending
    || pendingListingAction !== null
    || (emailCodeSent && verificationCode.length !== 6)
    || pushBlocked;

  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Listing preview and push</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Queue ready listings sends every selected item that is ready to your store. Preview first if you want to
            check content, product costs and shipping estimates.
          </p>
          <p className="mt-1 text-xs font-medium text-violet-700">
            Preview does not require verification. MFA is requested only when you queue ready listings.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            variant="outline"
            className="h-10 gap-2"
            disabled={previewDisabled}
            onClick={onPreview}
          >
            <Search className="h-4 w-4" />
            {pendingListingAction === "preview" ? "Previewing" : "Preview selected"}
          </Button>
          <Button
            type="button"
            className="h-10 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
            disabled={pushDisabled}
            onClick={onPush}
          >
            {pushButtonIcon(pendingListingAction, emailCodeSent)}
            {pushButtonLabel(pendingListingAction, emailCodeSent)}
          </Button>
        </div>
      </div>

      {accessNotice && <ListingAccessNoticeView notice={accessNotice} tone="notice" />}
      {listingError && (listingError.notice
        // Once the reloaded account explains the same block, the refusal is not repeated.
        ? listingError.notice.resolution !== accessNotice?.resolution
          && <ListingAccessNoticeView notice={listingError.notice} tone="error" />
        : (
          <Alert variant="destructive" className="mt-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{listingError.message}</AlertDescription>
          </Alert>
        ))}

      <div className="mt-4 grid gap-3 md:grid-cols-4">
        <PreviewMetric label="Selected for listing" value={String(selectedRowCount)} />
        <PreviewMetric label="Ready" value={String(listingPreview?.summary.ready ?? 0)} />
        <PreviewMetric label="Warnings" value={String(listingPreview?.summary.warning ?? 0)} />
        <PreviewMetric label="Blocked" value={String(listingPreview?.summary.blocked ?? 0)} />
      </div>

      {!storeReady && (
        <ListingAccessNoticeView tone="notice" notice={{
          message: "Connect your eBay store and finish its setup before previewing or pushing listings.",
          resolution: "finish_store_setup",
          link: listingAccessLink("finish_store_setup"),
        }} />
      )}

      {!listingPreview && selectedRows.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-md border border-zinc-200">
          <div className="border-b border-zinc-200 bg-zinc-50 px-4 py-3">
            <h3 className="text-sm font-semibold">Selected items</h3>
            <p className="mt-1 text-xs text-zinc-500">These items are checked when you preview or queue them.</p>
          </div>
          <div className="max-h-72 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Variant</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Quantity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {selectedRows.map((row) => (
                  <TableRow key={row.productVariantId}>
                    <TableCell className="font-medium">{row.productName}</TableCell>
                    <TableCell>{row.variantName}</TableCell>
                    <TableCell className="font-mono text-xs">{row.variantSku || `Variant ${row.productVariantId}`}</TableCell>
                    <TableCell className="font-mono">{row.selectionDecision.marketplaceQuantity}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {!listingPreview && selectedRows.length === 0 && (
        <div className="mt-4 rounded-md border border-dashed border-zinc-300 bg-zinc-50 p-4 text-sm text-zinc-600">
          Choose items in step 1, Choose what to sell. They will appear here before you preview or push them.
        </div>
      )}

      {emailCodeSent && (
        <div className="mt-4 max-w-sm space-y-2 rounded-md border border-violet-200 bg-violet-50 p-4">
          <Label>Verification code to push listings</Label>
          <p className="text-xs text-zinc-600">Enter the 6-digit code sent to your email, then verify and queue the push.</p>
          <InputOTP
            maxLength={6}
            value={verificationCode}
            onChange={onVerificationCodeChange}
            containerClassName="justify-between"
          >
            <InputOTPGroup>
              {Array.from({ length: 6 }).map((_, index) => (
                <InputOTPSlot key={index} index={index} className="h-10 w-10 text-sm" />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </div>
      )}

      {listingPreview && listingPreviewStale && <div role="status" className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        {/* Interim (PR 12 PROPOSAL): a Listing settings save no longer refreshes the preview (PR 12 D6). */}
        {priceSavePending ? "Saving your listing settings…" : "This preview is out of date. Preview again to see current details."}
      </div>}
      {listingPreview && <DropshipListingPreview key={listingPreview.storeConnectionId} preview={listingPreview} stale={listingPreviewStale} />}

      {listingPushResult && <ListingQueueResultNotice key={listingPushResult.job.jobId} response={listingPushResult} storeName={selectedStoreName} />}
    </section>
  );
}

const PUSH_NOTICE_TONES = {
  pending: "border-sky-200 bg-sky-50 text-sky-900",
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  partial: "border-amber-300 bg-amber-50 text-amber-900",
  failed: "border-rose-200 bg-rose-50 text-rose-900",
} as const;

function ListingQueueResultNotice({ response, storeName }: { response: DropshipListingPushResponse; storeName: string | null }) {
  const result = describeListingQueueResult(response);
  if (result.outcome !== "queued") {
    return (
      <div role="status" data-testid="listing-queue-result" className={`mt-4 rounded-md border p-4 text-sm ${PUSH_NOTICE_TONES.partial}`}>
        {result.message}
      </div>
    );
  }
  return <ListingPushOutcomeNotice jobId={response.job.jobId} queuedMessage={result.message} storeName={storeName} />;
}

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

/**
 * What the account needs before listings can be previewed or pushed, with the
 * one link that fixes it. `notice` reads as guidance; `error` follows a request
 * the server refused.
 */
export function ListingAccessNoticeView({
  notice,
  tone,
  portalHref = dropshipPortalPath,
}: {
  notice: ListingAccessNotice;
  tone: "notice" | "error";
  /** Resolves a portal route to its URL; injected in tests, which have no window. */
  portalHref?: (path: string) => string;
}) {
  const palette = tone === "error"
    ? "border-red-200 bg-red-50 text-red-900"
    : "border-amber-300 bg-amber-50 text-amber-900";
  return (
    <div role={tone === "error" ? "alert" : "status"} data-testid="listing-access-notice"
      className={`mt-4 rounded-md border p-4 text-sm ${palette}`}>
      <p>{notice.message}</p>
      {notice.link && <ListingAccessLinkButton link={notice.link} portalHref={portalHref} />}
    </div>
  );
}

function ListingAccessLinkButton({ link, portalHref }: { link: ListingAccessLink; portalHref: (path: string) => string }) {
  if (!link.external) {
    return (
      <Button asChild size="sm" variant="outline" className="mt-3 h-9 gap-2 bg-white">
        <Link href={portalHref(link.href)}>
          {link.label}
          <ArrowRight className="h-4 w-4" />
        </Link>
      </Button>
    );
  }
  // A mail link opens the mail client; only a web page gets a new tab.
  const opensPage = !link.href.startsWith("mailto:");
  return (
    <Button asChild size="sm" variant="outline" className="mt-3 h-9 gap-2 bg-white">
      <a href={link.href} {...(opensPage ? { target: "_blank", rel: "noreferrer" } : {})}>
        {link.label}
        {opensPage && <ExternalLink className="h-4 w-4" />}
      </a>
    </Button>
  );
}

function PreviewMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-200 p-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

function pushButtonLabel(pendingListingAction: PendingListingAction, emailCodeSent: boolean): string {
  if (pendingListingAction === "send-code") return "Sending code";
  if (pendingListingAction === "verify-code") return "Verifying code";
  if (pendingListingAction === "passkey-proof") return "Waiting for passkey";
  if (pendingListingAction === "push") return "Queueing push";
  if (emailCodeSent) return "Verify and queue push";
  return "Queue ready listings";
}

function pushButtonIcon(pendingListingAction: PendingListingAction, emailCodeSent: boolean) {
  if (pendingListingAction === "passkey-proof") return <Fingerprint className="h-4 w-4" />;
  if (pendingListingAction === "send-code" || (emailCodeSent && pendingListingAction !== "push")) return <Mail className="h-4 w-4" />;
  if (pendingListingAction === "push") return <Send className="h-4 w-4" />;
  return <ArrowRight className="h-4 w-4" />;
}
