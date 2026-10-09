import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
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
  MinusCircle,
  PlusCircle,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { EbayStoreCategoryCombobox } from "@/components/dropship/EbayStoreCategoryCombobox";
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
  buildVariantSelectionReplacement,
  buildQueryUrl,
  createDropshipIdempotencyKey,
  fetchJson,
  formatStatus,
  isStaleListingPreviewError,
  isStepUpRequiredError,
  describeListingQueueResult,
  listLaunchReadyStoreConnections,
  postJson,
  putJson,
  queryErrorCode,
  queryErrorMessage,
  type DropshipCatalogResponse,
  type DropshipCatalogListingTier,
  type DropshipCatalogRow,
  type DropshipEbayStoreCategoryAssignmentResponse,
  type DropshipEbayStoreCategoryResponse,
  type DropshipListingPreviewResponse,
  type DropshipListingPreviewResult,
  type DropshipListingPushResponse,
  type DropshipOnboardingState,
  type DropshipSelectionRulesReplaceResponse,
  type DropshipSelectionRulesResponse,
  type DropshipSettingsResponse,
  type DropshipVendorSelectionAction,
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
import { EbayListingSetupPanel } from "./EbayListingSetupPanel";
import { EbayListingPolicyOverridePanel } from "./EbayListingPolicyOverridePanel";
import { EbayStoreCategoryAuthorizationRecovery } from "./EbayStoreCategoryAuthorizationRecovery";
import { DropshipListingPreview, type ListingPriceSaveCallbacks } from "./DropshipListingPreview";
import { DropshipPricingRulesPanel } from "./DropshipPricingRulesPanel";
import { DropshipContentTemplatesPanel } from "./DropshipContentTemplatesPanel";
import { DropshipEbayCategoryRulesPanel } from "./DropshipEbayCategoryRulesPanel";
import { CatalogStepRail } from "./catalog/CatalogStepRail";
import { CatalogActionBar, type CatalogNextStepAction } from "./catalog/CatalogActionBar";
import { UnsavedChangesProvider, useLeaveGuard, useUnsavedDrafts } from "./catalog/UnsavedChangesGuard";
import { ListingSettingsDraftsProvider } from "./listing-settings/ListingSettingsDraftsProvider";
import { ListingSettingsActionBar, ListingSettingsStep, countEbayStores } from "./listing-settings/ListingSettingsStep";
import { OlderListingSettings } from "./listing-settings/OlderListingSettings";
import { countOlderSettingsDrafts } from "@/lib/dropship-listing-settings-drafts";
import { ebayListingSetupQueryOptions } from "@/lib/dropship-ebay-listing-query-sync";
import { listingSettingsQueryKey, listingSettingsSummaryQueryOptions } from "@/lib/dropship-listing-settings";
import {
  CATALOG_STEPS,
  CATALOG_STEP_LABELS,
  catalogBrowserStorage,
  catalogStepFromLocation,
  catalogStepPath,
  catalogStoreOptions,
  chooseCatalogStore,
  chooseStepTick,
  describeCatalogActionBar,
  describeListingSettingsRail,
  isCatalogLocation,
  readRememberedCatalogStore,
  rememberCatalogStore,
  type CatalogStep,
} from "@/lib/dropship-catalog-steps";
export { formatListingPreviewIssue as formatIssue } from "@/lib/dropship-listing-preview";

type PendingSelectionAction = string | null;
type PendingListingAction = "preview" | "send-code" | "verify-code" | "passkey-proof" | "push" | null;
/** A failed preview, verification or push, and the fix when the account caused it. */
interface ListingActionError {
  message: string;
  notice: ListingAccessNotice | null;
}
const ONBOARDING_QUERY_KEY = ["/api/dropship/onboarding/state"] as const;
type CatalogFilters = {
  search: string;
  selectedOnly: string;
  category: string;
  productLineIds: string;
  productId: string;
};

const ALL_FILTER_VALUE = "all";
const SELECTED_CATALOG_PAGE_LIMIT = 200;
type SelectedCatalogPageLoader = (page: number, limit: number) => Promise<DropshipCatalogResponse>;
const defaultCatalogFilters: CatalogFilters = {
  search: "",
  selectedOnly: "false",
  category: ALL_FILTER_VALUE,
  productLineIds: ALL_FILTER_VALUE,
  productId: ALL_FILTER_VALUE,
};

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
  const [search, setSearch] = useState("");
  const [selectedOnly, setSelectedOnly] = useState("false");
  const [categoryFilter, setCategoryFilter] = useState(ALL_FILTER_VALUE);
  const [productLineIdsFilter, setProductLineIdsFilter] = useState(ALL_FILTER_VALUE);
  const [productIdFilter, setProductIdFilter] = useState(ALL_FILTER_VALUE);
  const [applied, setApplied] = useState<CatalogFilters>(defaultCatalogFilters);
  const [pendingSelectionAction, setPendingSelectionAction] = useState<PendingSelectionAction>(null);
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
  const [error, setError] = useState("");
  // Failures of the listing card's own actions (preview, verification, push)
  // show inside that card, next to the buttons that caused them.
  const [listingError, setListingError] = useState<ListingActionError | null>(null);
  const [pendingStoreCategoryVariantIds, setPendingStoreCategoryVariantIds] = useState<Set<number>>(
    () => new Set(),
  );
  // "Older settings" on Listing settings starts closed and stays as the vendor left it across steps and stores (A1).
  const [olderOpen, setOlderOpen] = useState(false);
  // Every leave-guard draft other than the new step's own belongs to an older panel.
  const olderUnsaved = countOlderSettingsDrafts(useUnsavedDrafts()) > 0;
  const catalogUrl = useMemo(() => buildQueryUrl("/api/dropship/catalog", {
    search: applied.search,
    category: applied.category === ALL_FILTER_VALUE ? undefined : applied.category,
    productLineIds: applied.productLineIds === ALL_FILTER_VALUE ? undefined : applied.productLineIds,
    productId: applied.productId === ALL_FILTER_VALUE ? undefined : applied.productId,
    selectedOnly: applied.selectedOnly,
    page: 1,
    limit: 50,
  }), [applied]);
  const catalogQuery = useQuery<DropshipCatalogResponse>({
    queryKey: [catalogUrl],
    queryFn: () => fetchJson<DropshipCatalogResponse>(catalogUrl),
  });
  const selectionRulesQuery = useQuery<DropshipSelectionRulesResponse>({
    queryKey: ["/api/dropship/catalog/selection-rules"],
    queryFn: () => fetchJson<DropshipSelectionRulesResponse>("/api/dropship/catalog/selection-rules"),
  });
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
  const visibleRows = catalogQuery.data?.rows ?? [];
  const visibleSelectableRows = visibleRows.filter(canSelectRow);
  const visibleSelectedRows = visibleRows.filter((row) => row.selectionDecision.selected);
  const selectedCatalogRows = selectedCatalogQuery.data ?? [];
  const catalogFacets = catalogQuery.data?.facets ?? {
    categories: [],
    productLines: [],
    products: [],
  };
  const hasActiveFilters = applied.search !== ""
    || applied.selectedOnly !== "false"
    || applied.category !== ALL_FILTER_VALUE
    || applied.productLineIds !== ALL_FILTER_VALUE
    || applied.productId !== ALL_FILTER_VALUE
    || search.trim() !== ""
    || selectedOnly !== "false"
    || categoryFilter !== ALL_FILTER_VALUE
    || productLineIdsFilter !== ALL_FILTER_VALUE
    || productIdFilter !== ALL_FILTER_VALUE;
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
  // The live eBay setup check runs on Listing settings only, in EbayListingSetupPanel. This never
  // fetches: it reads that panel's newest answer from the shared cache, for what only eBay can tell.
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

  async function replaceSelection(action: DropshipVendorSelectionAction, rows: readonly DropshipCatalogRow[], actionKey: string) {
    if (!selectionRulesQuery.data) {
      setError("Selection rules are still loading.");
      return;
    }
    if (rows.length === 0) {
      return;
    }
    setPendingSelectionAction(actionKey);
    setError("");
    setMessage("");
    try {
      await putJson<DropshipSelectionRulesReplaceResponse>("/api/dropship/catalog/selection-rules", {
        idempotencyKey: createDropshipIdempotencyKey(`catalog-${action}`),
        rules: buildVariantSelectionReplacement({
          existingRules: selectionRulesQuery.data.rules,
          rows,
          action,
        }),
      });
      await Promise.all([
        catalogQuery.refetch(),
        selectedCatalogQuery.refetch(),
        selectionRulesQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: [...ONBOARDING_QUERY_KEY] }),
      ]);
      setMessage(action === "include" ? "Catalog selection added." : "Catalog selection removed.");
      invalidateListingPreview();
      refreshListingSettings();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Catalog selection update failed.");
    } finally {
      setPendingSelectionAction(null);
    }
  }

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

  const priceSaveCallbacks: ListingPriceSaveCallbacks = {
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
    onSaved: () => refreshListingPreview(previewContextKey),
  };
  // The new step keeps the pending-save counter (D10) but never posts a preview after a save:
  // it marks step 3's preview stale instead, and step 3 checks again when the vendor gets there (D9).
  const listingSettingsSaveCallbacks: ListingPriceSaveCallbacks = { ...priceSaveCallbacks, onSaved: async () => undefined };

  async function pushListings() {
    // Blocked accounts never reach verification, so no code is emailed for a
    // push the server would refuse. The card already says what to do.
    if (pushAccessNotice) return;
    if (pendingPriceSavesRef.current > 0) {
      setListingError({ message: "Wait for your listing price to finish saving, then queue again.", notice: null });
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
        catalogQuery.refetch(),
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

  async function updateEbayStoreCategoryAssignment(
    productVariantId: number,
    storeCategoryIds: string[],
  ) {
    setPendingStoreCategoryVariantIds((current) => new Set(current).add(productVariantId));
    setError("");
    setMessage("");
    try {
      const result = await putJson<DropshipEbayStoreCategoryAssignmentResponse>(
        `/api/dropship/ebay/store-category-assignments/${productVariantId}`,
        {
          storeConnectionId: selectedStoreConnectionIdNumber,
          storeCategoryIds,
          idempotencyKey: createDropshipIdempotencyKey("ebay-store-category"),
        },
      );
      queryClient.setQueryData<DropshipEbayStoreCategoryResponse>(
        ebayStoreCategoryQueryKey,
        (current) => current ? {
          ...current,
          assignments: [
            ...current.assignments.filter(
              (assignment) => assignment.productVariantId !== productVariantId,
            ),
            ...(result.assignment ? [result.assignment] : []),
          ].sort((left, right) => left.productVariantId - right.productVariantId),
        } : current,
      );
      invalidateListingPreview();
      refreshListingSettings();
      setMessage(storeCategoryIds.length > 0
        ? "eBay Store category assignment saved."
        : "Optional eBay Store category assignment cleared.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "eBay Store category update failed.");
    } finally {
      setPendingStoreCategoryVariantIds((current) => {
        const next = new Set(current);
        next.delete(productVariantId);
        return next;
      });
    }
  }

  function applyCatalogFilters() {
    setApplied({
      search: search.trim(),
      selectedOnly,
      category: categoryFilter,
      productLineIds: productLineIdsFilter,
      productId: productIdFilter,
    });
    invalidateListingPreview();
  }

  function resetCatalogFilters() {
    setSearch("");
    setSelectedOnly("false");
    setCategoryFilter(ALL_FILTER_VALUE);
    setProductLineIdsFilter(ALL_FILTER_VALUE);
    setProductIdFilter(ALL_FILTER_VALUE);
    setApplied(defaultCatalogFilters);
    invalidateListingPreview();
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
    ? { label: actionBar.next.label, href: stepHref(actionBar.next.step), disabled: actionBar.next.disabled }
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
          storeOptions={storeOptions}
          selectedStoreConnectionId={storeReady ? selectedStoreConnectionIdNumber : null}
          onStoreChange={(storeConnectionId) => leaveGuard(() => chooseStore(storeConnectionId))}
        />

        {error && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {message && (
          <Alert className="mt-5 border-emerald-200 bg-emerald-50 text-emerald-900">
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
        {selectionRulesQuery.error && (
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
        {catalogQuery.error && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {queryErrorMessage(catalogQuery.error, "Unable to load dropship catalog.")}
            </AlertDescription>
          </Alert>
        )}

        {activeStep === "choose" && (
          <>
            <CatalogStepIntro step="choose" detail="Selection applies to all your stores." />
            <CatalogFilterPanel
              category={categoryFilter}
              categoryOptions={catalogFacets.categories}
              disabled={catalogQuery.isFetching}
              hasActiveFilters={hasActiveFilters}
              productId={productIdFilter}
              productLineIds={productLineIdsFilter}
              productLineOptions={catalogFacets.productLines}
              productOptions={catalogFacets.products}
              search={search}
              selectedOnly={selectedOnly}
              onApply={applyCatalogFilters}
              onCategoryChange={setCategoryFilter}
              onProductChange={setProductIdFilter}
              onProductLineChange={setProductLineIdsFilter}
              onReset={resetCatalogFilters}
              onSearchChange={setSearch}
              onSelectedOnlyChange={setSelectedOnly}
            />

            <section className="mt-5 overflow-hidden rounded-md border border-zinc-200 bg-white">
              <div className="flex flex-col gap-3 border-b border-zinc-200 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Available catalog</h2>
                  <p className="mt-1 text-sm text-zinc-500">
                    Choose the variants you want to sell. Catalog selection does not require verification.
                  </p>
                </div>
                <Badge variant="outline" className="w-fit border-violet-200 bg-violet-50 text-violet-800">
                  {selectedCatalogQuery.isLoading ? "Loading selection" : `${selectedCatalogRows.length} selected`}
                </Badge>
              </div>
              {catalogQuery.isLoading ? (
                <div className="space-y-2 p-4">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : catalogQuery.error ? (
                <Empty className="p-8">
                  <EmptyMedia variant="icon"><AlertCircle /></EmptyMedia>
                  <EmptyHeader>
                    <EmptyTitle>Catalog unavailable</EmptyTitle>
                    <EmptyDescription>The catalog API request failed.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : catalogQuery.data?.rows.length ? (
                <CatalogTable
                  bulkSelectionDisabled={selectionRulesQuery.isLoading || pendingSelectionAction !== null}
                  pendingSelectionAction={pendingSelectionAction}
                  rows={catalogQuery.data.rows}
                  selectableRowCount={visibleSelectableRows.length}
                  selectedRowCount={visibleSelectedRows.length}
                  total={catalogQuery.data.total}
                  onBulkDeselect={() => replaceSelection("exclude", visibleSelectedRows, "bulk:exclude")}
                  onBulkSelect={() => replaceSelection("include", visibleSelectableRows, "bulk:include")}
                  onDeselectRow={(row) => replaceSelection("exclude", [row], `variant:${row.productVariantId}:exclude`)}
                  onSelectRow={(row) => replaceSelection("include", [row], `variant:${row.productVariantId}:include`)}
                />
              ) : (
                <Empty className="p-8">
                  <EmptyMedia variant="icon"><Boxes /></EmptyMedia>
                  <EmptyHeader>
                    <EmptyTitle>No catalog rows</EmptyTitle>
                    <EmptyDescription>No exposed catalog rows match the current filters.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </section>
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
            {/* Today's step 2 panels under "Older settings" (A1): still mounted while closed, so their
                reads, drafts and leave guard work as before. The lines inside keep their indentation,
                so their text stays as it was (plan D2); only the setup panel takes one prop (L2). */}
            <OlderListingSettings collapsible={storeReady} open={olderOpen} onOpenChange={setOlderOpen} unsaved={olderUnsaved}>
            <CatalogStepIntro step="setup" detail={storeReady ? `These settings apply to ${selectedStoreName}.` : null} />
            {/* Only once the stores have loaded, so a slow load never tells the vendor to connect a store they have. */}
            {settingsQuery.data && !storeReady && (
              <ListingAccessNoticeView tone="notice" notice={{
                message: "Connect your eBay store and finish its setup to set how your listings look.",
                resolution: "finish_store_setup",
                link: listingAccessLink("finish_store_setup"),
              }} />
            )}
            {selectedStoreConnection?.platform === "ebay" && (
              <>
                {/* Keys unique among these siblings: a shared key would leave the
                    previous store's panel mounted after a store switch. */}
                <EbayListingSetupPanel
                  key={`listing-setup-${selectedStoreConnectionIdNumber}`}
                  storeConnectionId={selectedStoreConnectionIdNumber}
                  storeName={selectedStoreName}
                  onConfigurationChange={() => {
                    invalidateListingPreview();
                    refreshListingSettings();
                  }}
                  suggestionsCountAsUnsaved={olderOpen}
                />
                <EbayListingPolicyOverridePanel
                  key={`policy-override-${selectedStoreConnectionIdNumber}`}
                  storeConnectionId={selectedStoreConnectionIdNumber}
                  storeName={selectedStoreName}
                  rows={selectedCatalogRows}
                  onConfigurationChange={() => {
                    invalidateListingPreview();
                    refreshListingSettings();
                  }}
                />
                <DropshipEbayCategoryRulesPanel
                  storeConnectionId={selectedStoreConnectionIdNumber}
                  storeName={selectedStoreName}
                  renderAuthorizationRecovery={(error) => (
                    <EbayStoreCategoryAuthorizationRecovery
                      error={error}
                      storeConnectionId={selectedStoreConnectionIdNumber}
                      storeName={selectedStoreName}
                    />
                  )}
                  {...priceSaveCallbacks}
                />
                <EbayStoreCategoryAssignmentPanel
                  authorizationRecovery={(
                    <EbayStoreCategoryAuthorizationRecovery
                      error={ebayStoreCategoryQuery.error}
                      storeConnectionId={selectedStoreConnectionIdNumber}
                      storeName={selectedStoreName}
                    />
                  )}
                  data={ebayStoreCategoryQuery.data ?? null}
                  error={ebayStoreCategoryQuery.error}
                  isLoading={ebayStoreCategoryQuery.isLoading}
                  pendingProductVariantIds={pendingStoreCategoryVariantIds}
                  rows={selectedCatalogRows}
                  onAssignmentChange={updateEbayStoreCategoryAssignment}
                />
              </>
            )}

            {selectedStoreConnectionIdNumber > 0 && <DropshipPricingRulesPanel storeConnectionId={selectedStoreConnectionIdNumber}
              storeName={selectedStoreName} onConfigurationChange={() => { invalidateListingPreview(true); refreshListingSettings(); }}
              priceSaveCallbacks={priceSaveCallbacks} />}
            {selectedStoreConnectionIdNumber > 0 && <DropshipContentTemplatesPanel storeConnectionId={selectedStoreConnectionIdNumber}
              storeName={selectedStoreName} {...priceSaveCallbacks} />}
            </OlderListingSettings>
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
              priceSaveCallbacks={priceSaveCallbacks}
              listingPushResult={listingPushResult}
              selectedStoreName={selectedStoreName}
              pendingListingAction={pendingListingAction}
              selectedRows={selectedCatalogRows}
              verificationCode={verificationCode}
              onPreview={previewListings}
              onPush={pushListings}
              onVerificationCodeChange={setVerificationCode}
            />
          </>
        )}

        {activeStep === "setup" && storeReady
          ? <ListingSettingsActionBar next={nextAction} saving={pendingPriceSaves > 0} />
          : <CatalogActionBar summary={actionBar.summary} next={nextAction} />}
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

function CatalogFilterPanel({
  category,
  categoryOptions,
  disabled,
  hasActiveFilters,
  onApply,
  onCategoryChange,
  onProductChange,
  onProductLineChange,
  onReset,
  onSearchChange,
  onSelectedOnlyChange,
  productId,
  productLineIds,
  productLineOptions,
  productOptions,
  search,
  selectedOnly,
}: {
  category: string;
  categoryOptions: DropshipCatalogResponse["facets"]["categories"];
  disabled: boolean;
  hasActiveFilters: boolean;
  onApply: () => void;
  onCategoryChange: (value: string) => void;
  onProductChange: (value: string) => void;
  onProductLineChange: (value: string) => void;
  onReset: () => void;
  onSearchChange: (value: string) => void;
  onSelectedOnlyChange: (value: string) => void;
  productId: string;
  productLineIds: string;
  productLineOptions: DropshipCatalogResponse["facets"]["productLines"];
  productOptions: DropshipCatalogResponse["facets"]["products"];
  search: string;
  selectedOnly: string;
}) {
  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Catalog filters</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Narrow the table without changing what is selected.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            variant="outline"
            className="h-10"
            disabled={disabled || !hasActiveFilters}
            onClick={onReset}
          >
            Reset
          </Button>
          <Button
            type="button"
            className="h-10 bg-[#C060E0] hover:bg-[#a94bc9]"
            disabled={disabled}
            onClick={onApply}
          >
            Apply filters
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <div className="xl:col-span-2">
          <Label>Search</Label>
          <div className="relative mt-2">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <Input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  onApply();
                }
              }}
              className="pl-9"
              placeholder="Product, variant, or SKU"
            />
          </div>
        </div>

        <FilterSelect
          label="Selection"
          value={selectedOnly}
          onValueChange={onSelectedOnlyChange}
          options={[
            { value: "false", label: "All exposed" },
            { value: "true", label: "Selected only" },
          ]}
        />
        <FilterSelect
          label="Category"
          value={category}
          onValueChange={onCategoryChange}
          options={[
            { value: ALL_FILTER_VALUE, label: "All categories" },
            ...categoryOptions.map((option) => ({
              value: option.category,
              label: `${formatStatus(option.label)} (${option.rowCount})`,
            })),
          ]}
        />
        <FilterSelect
          label="Product line"
          value={productLineIds}
          onValueChange={onProductLineChange}
          options={[
            { value: ALL_FILTER_VALUE, label: "All product lines" },
            ...productLineOptions.map((option) => ({
              value: option.productLineIds.join(","),
              label: `${option.label} (${option.rowCount})`,
            })),
          ]}
        />
        <div className="xl:col-span-2">
          <FilterSelect
            label="Product"
            value={productId}
            onValueChange={onProductChange}
            options={[
              { value: ALL_FILTER_VALUE, label: "All products" },
              ...productOptions.map((option) => ({
                value: String(option.productId),
                label: `${option.label}${option.sku ? ` (${option.sku})` : ""}`,
              })),
            ]}
          />
        </div>
      </div>
    </section>
  );
}

function FilterSelect({
  label,
  onValueChange,
  options,
  value,
}: {
  label: string;
  onValueChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  value: string;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger className="mt-2 h-10">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const EBAY_STORE_CATEGORY_RECONNECT_ERROR_CODES = new Set([
  "DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED",
]);

export function shouldOfferEbayStoreReconnect(error: unknown): boolean {
  const code = queryErrorCode(error);
  return code !== null && EBAY_STORE_CATEGORY_RECONNECT_ERROR_CODES.has(code);
}

export function EbayStoreCategoryAssignmentPanel({
  authorizationRecovery,
  data,
  error,
  isLoading,
  onAssignmentChange,
  pendingProductVariantIds,
  rows,
}: {
  authorizationRecovery?: ReactNode;
  data: DropshipEbayStoreCategoryResponse | null;
  error: unknown;
  isLoading: boolean;
  onAssignmentChange: (productVariantId: number, storeCategoryIds: string[]) => void;
  pendingProductVariantIds: ReadonlySet<number>;
  rows: DropshipCatalogRow[];
}) {
  const pageSize = 25;
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);
  const assignmentByVariantId = new Map(
    (data?.assignments ?? []).map((assignment) => [assignment.productVariantId, assignment]),
  );
  const errorCode = queryErrorCode(error);
  const permissionRequired = errorCode === "DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED";
  const reconnectAvailable = shouldOfferEbayStoreReconnect(error);

  return (
    <section className="mt-5 overflow-hidden rounded-md border border-zinc-200 bg-white">
      <div className="border-b border-zinc-200 p-4">
        <h2 className="text-lg font-semibold">Your eBay Store organization (optional)</h2>
        <p className="mt-1 text-sm text-zinc-500">
          The required eBay category comes from your eBay categories above. Use these searchable fields only if you want a listing organized inside one or two custom categories in your own eBay Store.
        </p>
        <p className="mt-1 text-xs text-zinc-500">
          Leaving both fields blank does not block preview or push. Category changes save immediately and are shown again in listing preview.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : error ? (
        <div className="m-4 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="font-medium">
            {permissionRequired
              ? "eBay Store-category authorization needs attention."
              : "Custom Store categories are unavailable."}
          </div>
          <div className="mt-1">
            {permissionRequired
              ? "The eBay authorization has expired or been revoked. Reauthorize the connected store to load its custom Store categories."
              : queryErrorMessage(error, "The connected eBay account did not return its Store categories.")}
          </div>
          <div className="mt-1 text-xs">You can still preview and push listings without this optional organization.</div>
          {reconnectAvailable && authorizationRecovery}
        </div>
      ) : rows.length === 0 ? (
        <div className="p-4 text-sm text-zinc-500">
          Choose items in step 1, Choose what to sell, before assigning your eBay Store categories.
        </div>
      ) : (data?.categories.length ?? 0) === 0 ? (
        <div className="p-4 text-sm text-zinc-500">
          No custom leaf categories were returned by this eBay Store. Listings will use eBay&apos;s default Store organization.
        </div>
      ) : (
        <div>
          <div className="max-h-96 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Selected item</TableHead>
                  <TableHead>Primary Store category</TableHead>
                  <TableHead>Secondary Store category</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((row) => {
                const assignment = assignmentByVariantId.get(row.productVariantId);
                const selectedIds = assignment?.storeCategoryIds ?? [];
                const primaryId = selectedIds[0] ?? null;
                const secondaryId = selectedIds[1] ?? null;
                const pending = pendingProductVariantIds.has(row.productVariantId);
                const categoryPathById = new Map(
                  data?.categories.map((category) => [category.categoryId, category.path]) ?? [],
                );
                const staleAssignment = selectedIds.some((categoryId, index) => (
                  categoryPathById.get(categoryId) !== assignment?.storeCategoryNames[index]
                ));
                return (
                  <TableRow key={row.productVariantId}>
                    <TableCell>
                      <div className="font-medium">{row.productName}</div>
                      <div className="font-mono text-xs text-zinc-500">
                        {row.variantSku || `Variant ${row.productVariantId}`}
                      </div>
                    </TableCell>
                    <TableCell>
                      <EbayStoreCategoryCombobox
                        ariaLabel={`Primary eBay Store category for ${row.variantSku || row.variantName}`}
                        categories={data?.categories ?? []}
                        disabled={pending}
                        placeholder="Use eBay default"
                        value={primaryId}
                        onValueChange={(categoryId) => {
                          const nextIds = categoryId === null
                            ? selectedIds.slice(1, 2)
                            : [categoryId, ...selectedIds.filter((value) => value !== categoryId).slice(0, 1)];
                          onAssignmentChange(row.productVariantId, nextIds);
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      <EbayStoreCategoryCombobox
                        ariaLabel={`Secondary eBay Store category for ${row.variantSku || row.variantName}`}
                        categories={(data?.categories ?? []).filter((category) => category.categoryId !== primaryId)}
                        disabled={pending || primaryId === null}
                        placeholder={primaryId === null ? "Select primary first" : "No secondary category"}
                        value={secondaryId}
                        onValueChange={(categoryId) => {
                          if (primaryId === null) return;
                          const nextIds = categoryId === null
                            ? selectedIds.slice(0, 1)
                            : [primaryId, categoryId];
                          onAssignmentChange(row.productVariantId, nextIds);
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      {pending ? (
                        <Badge variant="outline">Saving</Badge>
                      ) : staleAssignment ? (
                        <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-900">
                          Category changed on eBay
                        </Badge>
                      ) : selectedIds.length > 0 ? (
                        <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-800">
                          Assigned
                        </Badge>
                      ) : (
                        <Badge variant="outline">eBay default</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
                })}
              </TableBody>
            </Table>
          </div>
          {pageCount > 1 && (
            <div className="flex items-center justify-between gap-3 border-t border-zinc-200 px-4 py-3 text-sm text-zinc-600">
              <span>
                Showing {(page - 1) * pageSize + 1}-{Math.min(page * pageSize, rows.length)} of {rows.length} selected items
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page === 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page === pageCount}
                  onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ListingPreviewPanel({
  accessNotice,
  emailCodeSent,
  listingPreview,
  listingPreviewStale,
  priceSavePending,
  priceSaveCallbacks,
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
  priceSaveCallbacks: ListingPriceSaveCallbacks;
  listingPushResult: DropshipListingPushResponse | null;
  /** The store's name as the vendor knows it, for the push outcome. */
  selectedStoreName: string;
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
        {priceSavePending ? "Saving your listing price and refreshing the preview…" : "This preview is out of date. Preview again to see current details."}
      </div>}
      {listingPreview && <DropshipListingPreview key={listingPreview.storeConnectionId} preview={listingPreview}
        stale={listingPreviewStale} priceSaveCallbacks={priceSaveCallbacks} />}

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

function ListingQueueResultNotice({ response, storeName }: { response: DropshipListingPushResponse; storeName: string }) {
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
function ListingPushOutcomeNotice({ jobId, queuedMessage, storeName }: { jobId: number; queuedMessage: string; storeName: string }) {
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

function CatalogTable({
  bulkSelectionDisabled,
  onBulkDeselect,
  onBulkSelect,
  onDeselectRow,
  onSelectRow,
  pendingSelectionAction,
  rows,
  selectableRowCount,
  selectedRowCount,
  total,
}: {
  bulkSelectionDisabled: boolean;
  onBulkDeselect: () => void;
  onBulkSelect: () => void;
  onDeselectRow: (row: DropshipCatalogRow) => void;
  onSelectRow: (row: DropshipCatalogRow) => void;
  pendingSelectionAction: PendingSelectionAction;
  rows: DropshipCatalogRow[];
  selectableRowCount: number;
  selectedRowCount: number;
  total: number;
}) {
  return (
    <>
      <div className="flex flex-col gap-3 border-b border-zinc-200 px-4 py-3 text-sm text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
        <span>{total} row{total === 1 ? "" : "s"}</span>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-2"
            disabled={bulkSelectionDisabled || selectableRowCount === 0}
            onClick={onBulkSelect}
          >
            <PlusCircle className="h-4 w-4" />
            Select visible
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-2"
            disabled={bulkSelectionDisabled || selectedRowCount === 0}
            onClick={onBulkDeselect}
          >
            <MinusCircle className="h-4 w-4" />
            Remove visible
          </Button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Variant</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Quantity</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.productVariantId}>
                <TableCell>
                  <div className="font-medium">{row.productName}</div>
                  <div className="text-xs text-zinc-500">{row.productSku || "No product SKU"}</div>
                </TableCell>
                <TableCell>
                  <div className="font-medium">{row.variantName}</div>
                  <div className="text-xs text-zinc-500">{row.variantSku || `Variant ${row.productVariantId}`}</div>
                </TableCell>
                <TableCell>
                  <div>{row.category ? formatStatus(row.category) : "Uncategorized"}</div>
                  {row.productLineNames.length > 0 && (
                    <div className="text-xs text-zinc-500">{row.productLineNames.join(", ")}</div>
                  )}
                </TableCell>
                <TableCell className="font-mono">{row.selectionDecision.marketplaceQuantity}</TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={row.selectionDecision.selected
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-zinc-200 bg-zinc-50 text-zinc-600"}
                  >
                    {row.selectionDecision.selected ? "Selected" : formatStatus(row.selectionDecision.reason)}
                  </Badge>
                  {row.selectionDecision.selected && row.listingTier && !row.listingTier.eligible && (
                    <Badge
                      variant="outline"
                      className="ml-1 border-amber-200 bg-amber-50 text-amber-900"
                      data-testid={`catalog-tier-off-sale-${row.productVariantId}`}
                      title={describeCatalogListingTier(row.listingTier)}
                    >
                      {row.listingTier.tier === "case" ? "Case tier not active" : "Pack tier not active"}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {row.selectionDecision.selected ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 gap-2"
                      disabled={pendingSelectionAction !== null}
                      onClick={() => onDeselectRow(row)}
                    >
                      <MinusCircle className="h-4 w-4" />
                      Remove
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 gap-2"
                      disabled={pendingSelectionAction !== null || !canSelectRow(row)}
                      onClick={() => onSelectRow(row)}
                    >
                      <PlusCircle className="h-4 w-4" />
                      Select
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
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

/**
 * Why a selected SKU's tier is not active, in the vendor's words: what the
 * tier needs and what to change, from the server's reason. The amount is the
 * published one, the same the wallet shows.
 */
export function describeCatalogListingTier(tier: DropshipCatalogListingTier): string {
  const name = tier.tier === "case" ? "Case tier" : "Pack tier";
  const amount = formatCatalogDollars(tier.policyMinimumCents);
  if (tier.reason === "autopay_off") {
    return `The ${name} is not active: autopay is off, so your wallet has no reserve. Turn on autopay with a reserve of at least ${amount} in Wallet.`;
  }
  if (tier.reason === "reserve_below_tier") {
    return `The ${name} is not active: it needs a reserve of ${amount}. Raise your reserve in Wallet.`;
  }
  return `The ${name} is not active: your balance needs to reach ${amount}. You need ${formatCatalogDollars(tier.balanceShortfallCents)} more.`;
}

/** Whole dollars when there are no cents ($500), else both cent digits ($10.50, never $10.5). Display only. */
function formatCatalogDollars(centsValue: number): string {
  const fractionDigits = centsValue % 100 === 0 ? 0 : 2;
  return `$${(centsValue / 100).toLocaleString("en-US", { minimumFractionDigits: fractionDigits, maximumFractionDigits: 2 })}`;
}

function canSelectRow(row: DropshipCatalogRow): boolean {
  return !row.selectionDecision.selected && row.selectionDecision.reason !== "not_exposed_by_admin";
}
