import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  AlertCircle,
  ArrowRight,
  Boxes,
  CheckCircle2,
  Fingerprint,
  Mail,
  MinusCircle,
  PlusCircle,
  RefreshCw,
  Search,
  Send,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  buildListingPushRequest,
  buildVariantSelectionReplacement,
  buildQueryUrl,
  createDropshipIdempotencyKey,
  fetchJson,
  formatStatus,
  formatCents,
  listingPreviewPushableCount,
  listLaunchReadyStoreConnections,
  postJson,
  putJson,
  queryErrorCode,
  queryErrorMessage,
  type DropshipCatalogResponse,
  type DropshipCatalogRow,
  type DropshipEbayStoreCategoryAssignmentResponse,
  type DropshipEbayStoreCategoryResponse,
  type DropshipListingPreviewResponse,
  type DropshipListingPreviewResult,
  type DropshipListingPushResponse,
  type DropshipSelectionRulesReplaceResponse,
  type DropshipSelectionRulesResponse,
  type DropshipSettingsResponse,
  type DropshipVendorSelectionAction,
} from "@/lib/dropship-ops-surface";
import { dropshipPortalPath, isDropshipSensitiveProofActive, useDropshipAuth } from "@/lib/dropship-auth";
import { DropshipPortalShell } from "./DropshipPortalShell";

type PendingSelectionAction = string | null;
type PendingListingAction = "preview" | "send-code" | "verify-code" | "passkey-proof" | "push" | null;
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

export default function DropshipPortalCatalog() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const {
    principal,
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
  const [pendingListingAction, setPendingListingAction] = useState<PendingListingAction>(null);
  const [selectedStoreConnectionId, setSelectedStoreConnectionId] = useState("");
  const [listingPreview, setListingPreview] = useState<DropshipListingPreviewResult | null>(null);
  const [listingPushResult, setListingPushResult] = useState<DropshipListingPushResponse | null>(null);
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [verificationCode, setVerificationCode] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [retailPriceByVariantId, setRetailPriceByVariantId] = useState<Record<string, string>>({});
  const [pendingStoreCategoryVariantIds, setPendingStoreCategoryVariantIds] = useState<Set<number>>(
    () => new Set(),
  );
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
  const selectedStoreConnectionIdNumber = Number(selectedStoreConnectionId);
  const selectedStoreConnection = launchReadyStoreConnections.find(
    (connection) => connection.storeConnectionId === selectedStoreConnectionIdNumber,
  ) ?? null;
  const ebayStoreCategoryQueryKey = [
    "/api/dropship/ebay/store-categories",
    selectedStoreConnectionIdNumber,
  ] as const;
  const ebayStoreCategoryQuery = useQuery<DropshipEbayStoreCategoryResponse>({
    queryKey: ebayStoreCategoryQueryKey,
    queryFn: () => fetchJson<DropshipEbayStoreCategoryResponse>(
      `/api/dropship/ebay/store-categories/${selectedStoreConnectionIdNumber}`,
    ),
    enabled: selectedStoreConnection?.platform === "ebay",
    staleTime: 60_000,
  });
  const activeBulkPushProof = useMemo(() => {
    return isDropshipSensitiveProofActive({
      principal,
      action: "bulk_listing_push",
      proof: sensitiveProofs.bulk_listing_push,
    });
  }, [principal, sensitiveProofs.bulk_listing_push]);
  const pushablePreviewCount = listingPreviewPushableCount(listingPreview);

  useEffect(() => {
    if (selectedStoreConnectionId || launchReadyStoreConnections.length === 0) {
      return;
    }
    setSelectedStoreConnectionId(String(launchReadyStoreConnections[0].storeConnectionId));
  }, [launchReadyStoreConnections, selectedStoreConnectionId]);

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
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/onboarding/state"] }),
      ]);
      setMessage(action === "include" ? "Catalog selection added." : "Catalog selection removed.");
      setListingPreview(null);
      setListingPushResult(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Catalog selection update failed.");
    } finally {
      setPendingSelectionAction(null);
    }
  }

  async function previewListings() {
    setPendingListingAction("preview");
    setError("");
    setMessage("");
    setListingPreview(null);
    setListingPushResult(null);
    try {
      const request = buildListingPreviewRequest({
        storeConnectionId: selectedStoreConnectionIdNumber,
        rows: selectedCatalogRows,
        retailPriceByVariantId,
      });
      if (request.productVariantIds.length === 0) {
        setError("Select at least one catalog item before previewing listings.");
        return;
      }
      const response = await postJson<DropshipListingPreviewResponse>("/api/dropship/listings/preview", request);
      setListingPreview(response.preview);
      setMessage("Listing preview generated.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Listing preview failed.");
    } finally {
      setPendingListingAction(null);
    }
  }

  async function pushListings() {
    if (!listingPreview) {
      setError("Generate a listing preview before queueing a push.");
      return;
    }

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
          setError("Enter the 6-digit verification code before queueing a listing push.");
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
      const request = buildListingPushRequest({
        storeConnectionId: selectedStoreConnectionIdNumber,
        preview: listingPreview,
        idempotencyKey: createDropshipIdempotencyKey("listing-push"),
        retailPriceByVariantId,
      });
      if (request.productVariantIds.length === 0) {
        setError("No preview rows are ready to push.");
        return;
      }
      const response = await postJson<DropshipListingPushResponse>("/api/dropship/listing-push-jobs", request);
      setListingPushResult(response);
      setEmailCodeSent(false);
      setVerificationCode("");
      setMessage(`Listing push job ${response.job.jobId} queued with ${response.items.length} item(s).`);
      await Promise.all([
        catalogQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/settings"] }),
      ]);
    });
  }

  async function runListingAction(action: PendingListingAction, task: () => Promise<void>): Promise<boolean> {
    setPendingListingAction(action);
    setError("");
    setMessage("");
    try {
      await task();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Listing request failed.");
      return false;
    } finally {
      setPendingListingAction(null);
    }
  }

  function updateRetailPrice(productVariantId: number, value: string) {
    setRetailPriceByVariantId((current) => ({
      ...current,
      [String(productVariantId)]: value,
    }));
    setListingPreview(null);
    setListingPushResult(null);
    setMessage("");
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
      setListingPreview(null);
      setListingPushResult(null);
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
    setListingPreview(null);
    setListingPushResult(null);
  }

  function resetCatalogFilters() {
    setSearch("");
    setSelectedOnly("false");
    setCategoryFilter(ALL_FILTER_VALUE);
    setProductLineIdsFilter(ALL_FILTER_VALUE);
    setProductIdFilter(ALL_FILTER_VALUE);
    setApplied(defaultCatalogFilters);
    setListingPreview(null);
    setListingPushResult(null);
  }

  return (
    <DropshipPortalShell>
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <Boxes className="h-6 w-6 text-[#C060E0]" />
              Catalog
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              Browse available items, choose what to sell, then preview and push those listings to your store.
            </p>
          </div>
        </div>

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
              retailPriceByVariantId={retailPriceByVariantId}
              pendingSelectionAction={pendingSelectionAction}
              rows={catalogQuery.data.rows}
              selectableRowCount={visibleSelectableRows.length}
              selectedRowCount={visibleSelectedRows.length}
              total={catalogQuery.data.total}
              onBulkDeselect={() => replaceSelection("exclude", visibleSelectedRows, "bulk:exclude")}
              onBulkSelect={() => replaceSelection("include", visibleSelectableRows, "bulk:include")}
              onDeselectRow={(row) => replaceSelection("exclude", [row], `variant:${row.productVariantId}:exclude`)}
              onRetailPriceChange={updateRetailPrice}
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

        {selectedStoreConnection?.platform === "ebay" && (
          <EbayStoreCategoryAssignmentPanel
            data={ebayStoreCategoryQuery.data ?? null}
            error={ebayStoreCategoryQuery.error}
            isLoading={ebayStoreCategoryQuery.isLoading}
            onReconnect={() => setLocation(dropshipPortalPath("/settings"))}
            pendingProductVariantIds={pendingStoreCategoryVariantIds}
            rows={selectedCatalogRows}
            onAssignmentChange={updateEbayStoreCategoryAssignment}
          />
        )}

        <ListingPreviewPanel
          launchReadyStoreConnections={launchReadyStoreConnections}
          emailCodeSent={emailCodeSent}
          listingPreview={listingPreview}
          listingPushResult={listingPushResult}
          pendingListingAction={pendingListingAction}
          pushablePreviewCount={pushablePreviewCount}
          selectedRows={selectedCatalogRows}
          selectedStoreConnectionId={selectedStoreConnectionId}
          verificationCode={verificationCode}
          onPreview={previewListings}
          onPush={pushListings}
          onSelectedStoreConnectionIdChange={(value) => {
            setSelectedStoreConnectionId(value);
            setListingPreview(null);
            setListingPushResult(null);
          }}
          onVerificationCodeChange={setVerificationCode}
        />
      </div>
    </DropshipPortalShell>
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
  "DROPSHIP_EBAY_STORE_CONNECTION_BLOCKED",
]);

export function shouldOfferEbayStoreReconnect(error: unknown): boolean {
  const code = queryErrorCode(error);
  return code !== null && EBAY_STORE_CATEGORY_RECONNECT_ERROR_CODES.has(code);
}

export function EbayStoreCategoryAssignmentPanel({
  data,
  error,
  isLoading,
  onAssignmentChange,
  onReconnect,
  pendingProductVariantIds,
  rows,
}: {
  data: DropshipEbayStoreCategoryResponse | null;
  error: unknown;
  isLoading: boolean;
  onAssignmentChange: (productVariantId: number, storeCategoryIds: string[]) => void;
  onReconnect: () => void;
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
          Card Shellz supplies the required eBay marketplace category. Use these searchable fields only if you want a listing organized inside one or two custom categories in your own eBay Store.
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
              ? "eBay rejected this connection's authorization for custom Store categories. Refreshing the authorization will request that optional access."
              : queryErrorMessage(error, "The connected eBay account did not return its Store categories.")}
          </div>
          <div className="mt-1 text-xs">You can still preview and push listings without this optional organization.</div>
          {reconnectAvailable && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3 gap-2 border-amber-400 bg-white text-amber-950 hover:bg-amber-100"
              onClick={onReconnect}
            >
              <RefreshCw className="h-4 w-4" />
              {permissionRequired ? "Refresh eBay authorization" : "Reconnect eBay store"}
            </Button>
          )}
        </div>
      ) : rows.length === 0 ? (
        <div className="p-4 text-sm text-zinc-500">
          Select catalog items above before assigning your eBay Store categories.
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
  emailCodeSent,
  launchReadyStoreConnections,
  listingPreview,
  listingPushResult,
  onPreview,
  onPush,
  onSelectedStoreConnectionIdChange,
  onVerificationCodeChange,
  pendingListingAction,
  pushablePreviewCount,
  selectedRows,
  selectedStoreConnectionId,
  verificationCode,
}: {
  emailCodeSent: boolean;
  launchReadyStoreConnections: DropshipSettingsResponse["settings"]["storeConnections"];
  listingPreview: DropshipListingPreviewResult | null;
  listingPushResult: DropshipListingPushResponse | null;
  onPreview: () => void;
  onPush: () => void;
  onSelectedStoreConnectionIdChange: (value: string) => void;
  onVerificationCodeChange: (value: string) => void;
  pendingListingAction: PendingListingAction;
  pushablePreviewCount: number;
  selectedRows: DropshipCatalogRow[];
  selectedStoreConnectionId: string;
  verificationCode: string;
}) {
  const selectedRowCount = selectedRows.length;
  const previewDisabled = launchReadyStoreConnections.length === 0
    || !selectedStoreConnectionId
    || selectedRowCount === 0
    || pendingListingAction !== null;
  const pushDisabled = !listingPreview
    || pushablePreviewCount === 0
    || pendingListingAction !== null
    || (emailCodeSent && verificationCode.length !== 6);

  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Listing preview and push</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Review everything you selected, then preview marketplace requirements before pushing to your store.
          </p>
          <p className="mt-1 text-xs font-medium text-violet-700">
            Preview does not require verification. MFA is requested only when you queue ready listings.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Select
            value={selectedStoreConnectionId}
            onValueChange={onSelectedStoreConnectionIdChange}
            disabled={launchReadyStoreConnections.length === 0}
          >
            <SelectTrigger className="h-10 sm:w-64">
              <SelectValue placeholder="Select launch-ready store" />
            </SelectTrigger>
            <SelectContent>
              {launchReadyStoreConnections.map((connection) => (
                <SelectItem key={connection.storeConnectionId} value={String(connection.storeConnectionId)}>
                  {connection.externalDisplayName || connection.shopDomain || `${formatStatus(connection.platform)} store name pending`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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

      <div className="mt-4 grid gap-3 md:grid-cols-4">
        <PreviewMetric label="Selected for listing" value={String(selectedRowCount)} />
        <PreviewMetric label="Ready" value={String(listingPreview?.summary.ready ?? 0)} />
        <PreviewMetric label="Warnings" value={String(listingPreview?.summary.warning ?? 0)} />
        <PreviewMetric label="Blocked" value={String(listingPreview?.summary.blocked ?? 0)} />
      </div>

      {launchReadyStoreConnections.length === 0 && (
        <div className="mt-4 rounded-md border border-dashed border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          A launch-ready store connection is required before listing preview or push.
        </div>
      )}

      {!listingPreview && selectedRows.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-md border border-zinc-200">
          <div className="border-b border-zinc-200 bg-zinc-50 px-4 py-3">
            <h3 className="text-sm font-semibold">Selected items</h3>
            <p className="mt-1 text-xs text-zinc-500">These items will be evaluated when you preview the listing push.</p>
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
          Select items from the available catalog above. They will appear here before you preview or push them.
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

      {listingPreview && (
        <div className="mt-4 overflow-hidden rounded-md border border-zinc-200">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Listing</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Price</TableHead>
                {listingPreview.platform === "ebay" && (
                  <TableHead>Marketplace category</TableHead>
                )}
                <TableHead>Status</TableHead>
                <TableHead>Blockers / Warnings</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {listingPreview.rows.map((row) => (
                <TableRow key={row.productVariantId}>
                  <TableCell>
                    <div className="font-medium">{row.title}</div>
                    <div className="text-xs text-zinc-500">{row.sku || `Variant ${row.productVariantId}`}</div>
                  </TableCell>
                  <TableCell>{formatStatus(row.listingMode || row.platform)}</TableCell>
                  <TableCell className="font-mono">{row.marketplaceQuantity}</TableCell>
                  <TableCell>{row.priceCents === null ? "Missing" : formatCents(row.priceCents)}</TableCell>
                  {listingPreview.platform === "ebay" && (
                    <TableCell>
                      {row.marketplaceCategoryId ? (
                        <div>
                          <div className="font-medium">{row.marketplaceCategoryName || "eBay category"}</div>
                          <div className="font-mono text-xs text-zinc-500">{row.marketplaceCategoryId}</div>
                          <div className="mt-1 text-xs text-zinc-500">
                            {row.storeCategoryNames.length > 0
                              ? `Your Store: ${row.storeCategoryNames.join(", ")}`
                              : "Your Store: eBay default"}
                          </div>
                        </div>
                      ) : (
                        <span className="text-sm text-red-700">Not mapped</span>
                      )}
                    </TableCell>
                  )}
                  <TableCell>
                    <Badge variant="outline" className={previewStatusTone(row.previewStatus)}>
                      {formatStatus(row.previewStatus)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <PreviewIssues blockers={row.blockers} warnings={row.warnings} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {listingPushResult && (
        <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          Push job {listingPushResult.job.jobId} is {formatStatus(listingPushResult.job.status)} with {listingPushResult.items.length} item(s).
        </div>
      )}
    </section>
  );
}

function CatalogTable({
  bulkSelectionDisabled,
  onBulkDeselect,
  onBulkSelect,
  onDeselectRow,
  onRetailPriceChange,
  onSelectRow,
  pendingSelectionAction,
  retailPriceByVariantId,
  rows,
  selectableRowCount,
  selectedRowCount,
  total,
}: {
  bulkSelectionDisabled: boolean;
  onBulkDeselect: () => void;
  onBulkSelect: () => void;
  onDeselectRow: (row: DropshipCatalogRow) => void;
  onRetailPriceChange: (productVariantId: number, value: string) => void;
  onSelectRow: (row: DropshipCatalogRow) => void;
  pendingSelectionAction: PendingSelectionAction;
  retailPriceByVariantId: Readonly<Record<string, string>>;
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
              <TableHead>Retail price</TableHead>
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
                  <Input
                    value={retailPriceByVariantId[String(row.productVariantId)] ?? ""}
                    onChange={(event) => onRetailPriceChange(row.productVariantId, event.target.value)}
                    className="h-9 min-w-28"
                    inputMode="decimal"
                    placeholder="Default"
                    disabled={!row.selectionDecision.selected}
                  />
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={row.selectionDecision.selected
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-zinc-200 bg-zinc-50 text-zinc-600"}
                  >
                    {row.selectionDecision.selected ? "Selected" : formatStatus(row.selectionDecision.reason)}
                  </Badge>
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

function PreviewMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-200 p-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

function PreviewIssues({ blockers, warnings }: { blockers: string[]; warnings: string[] }) {
  const issues = [
    ...blockers.map((issue) => ({ issue, tone: "border-rose-200 bg-rose-50 text-rose-800" })),
    ...warnings.map((issue) => ({ issue, tone: "border-amber-200 bg-amber-50 text-amber-900" })),
  ];

  if (issues.length === 0) {
    return <span className="text-sm text-zinc-500">None</span>;
  }

  return (
    <div className="flex max-w-xl flex-wrap gap-1.5">
      {issues.map((item) => (
        <Badge key={item.issue} variant="outline" className={item.tone}>
          {formatIssue(item.issue)}
        </Badge>
      ))}
    </div>
  );
}

function formatIssue(value: string): string {
  return value.split(":").map((part) => formatStatus(part)).join(": ");
}

function previewStatusTone(status: DropshipListingPreviewResult["rows"][number]["previewStatus"]): string {
  if (status === "ready") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "warning") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-rose-200 bg-rose-50 text-rose-800";
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

function canSelectRow(row: DropshipCatalogRow): boolean {
  return !row.selectionDecision.selected && row.selectionDecision.reason !== "not_exposed_by_admin";
}
