import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Boxes,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileSearch,
  RefreshCw,
  RotateCcw,
  Search,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  buildAdminListingPushJobRetryInput,
  buildAdminListingPushJobsUrl,
  createDropshipIdempotencyKey,
  describeListingPushRetryRefusal,
  fetchJson,
  formatDateTime,
  formatStatus,
  listingPushJobRetryEligibility,
  postJson,
  queryErrorMessage,
  type DropshipAdminListingPushJobListItem,
  type DropshipAdminListingPushJobListResponse,
  type DropshipAdminListingPushJobRetryResponse,
  type DropshipListingPushJobStatus,
} from "@/lib/dropship-ops-surface";
import {
  LISTING_END_OPS_DEFAULT_LIMIT,
  LISTING_END_OPS_DEFAULT_STATE,
  LISTING_END_REQUEST_STATES,
  LISTING_END_STAFF_REASON_MAX_LENGTH,
  type ListingEndOpsRow,
  type ListingEndRequestState,
  type ListingEndStaffAction,
} from "@shared/dropship/listing-end-ops";
import {
  buildListingEndResolveRequest,
  buildListingEndRetryRequest,
  canActOnListingEnd,
  checkListingEndResolveDraft,
  describeListingEndOpsError,
  describeListingEndResolveProblem,
  fetchListingEnds,
  isTransientListingEndOpsError,
  LISTING_END_OPS_QUERY_KEY,
  LISTING_END_OPS_SECTION_WORDS,
  LISTING_END_OPS_WORDS,
  listingEndOpsPager,
  newListingEndStaffKey,
  sendListingEndAction,
  type ListingEndOpsActionRequest,
  type ListingEndOpsFetch,
  type ListingEndResolveDraft,
} from "@/lib/dropship-listing-end-ops";
import {
  CatalogMetric,
  EmptyState,
  type DropshipOpsSearchSignal,
  type StoreConnectionPlatformFilter,
} from "./dropship-admin-shared";

type ListingPushStatusFilter = DropshipListingPushJobStatus | "default" | "all";

const listingPushStatusFilters: ListingPushStatusFilter[] = [
  "default",
  "all",
  "failed",
  "processing",
  "queued",
  "completed",
  "cancelled",
];

function ListingPushOpsTab({
  searchSignal,
}: {
  searchSignal: DropshipOpsSearchSignal | null;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ListingPushStatusFilter>("default");
  const [platform, setPlatform] =
    useState<StoreConnectionPlatformFilter>("all");
  const [appliedFilters, setAppliedFilters] = useState({
    search: "",
    status: "default" as ListingPushStatusFilter,
    platform: "all" as StoreConnectionPlatformFilter,
  });
  const [retryReason, setRetryReason] = useState("");
  const [pendingRetryJobId, setPendingRetryJobId] = useState<number | null>(
    null,
  );
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const listingPushJobsUrl = useMemo(
    () =>
      buildAdminListingPushJobsUrl({
        search: appliedFilters.search,
        status: appliedFilters.status,
        platform: appliedFilters.platform,
      }),
    [appliedFilters],
  );

  const listingPushJobsQuery =
    useQuery<DropshipAdminListingPushJobListResponse>({
      queryKey: [listingPushJobsUrl],
      queryFn: () =>
        fetchJson<DropshipAdminListingPushJobListResponse>(listingPushJobsUrl),
    });

  const jobs = listingPushJobsQuery.data?.items ?? [];
  const listingPushRetryNow = useMemo(
    () => new Date(),
    [listingPushJobsQuery.dataUpdatedAt],
  );
  const recoverableJobCount = jobs.filter(
    (job) => listingPushJobRetryEligibility(job, listingPushRetryNow).canRetry,
  ).length;

  useEffect(() => {
    if (!searchSignal) return;
    setSearch(searchSignal.search);
    setPlatform(searchSignal.platform ?? "all");
    setStatus("all");
    setAppliedFilters({
      search: searchSignal.search,
      status: "all",
      platform: searchSignal.platform ?? "all",
    });
  }, [searchSignal]);

  function applyListingPushFilters() {
    setAppliedFilters({ search, status, platform });
  }

  function showListingPushStatus(status: DropshipListingPushJobStatus) {
    setStatus(status);
    setAppliedFilters((current) => ({ ...current, status }));
  }

  async function retryListingPushJob(job: DropshipAdminListingPushJobListItem) {
    setPendingRetryJobId(job.jobId);
    setError("");
    setMessage("");
    try {
      const input = buildAdminListingPushJobRetryInput({
        idempotencyKey: createDropshipIdempotencyKey(
          `admin-listing-job-retry-${job.jobId}`,
        ),
        reason: retryReason,
      });
      const response = await postJson<DropshipAdminListingPushJobRetryResponse>(
        `/api/dropship/admin/listing-push-jobs/${job.jobId}/retry`,
        input,
      );
      const itemLabel = response.requeuedItemCount === 1 ? "item" : "items";
      setMessage(
        `Listing push job ${response.jobId} moved from ${formatStatus(response.previousStatus)} ` +
          `to ${formatStatus(response.status)} with ${response.requeuedItemCount} ${itemLabel} requeued.`,
      );
      setRetryReason("");
      await Promise.all([
        listingPushJobsQuery.refetch(),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/ops/overview"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/dogfood-readiness"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/audit-events"],
        }),
      ]);
    } catch (caught) {
      setError(
        describeListingPushRetryRefusal(caught, job.jobId) ??
          (caught instanceof Error
            ? caught.message
            : "Dropship listing push job retry failed."),
      );
    } finally {
      setPendingRetryJobId(null);
    }
  }

  return (
    <div className="space-y-5">
      {(listingPushJobsQuery.error || error) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error ||
              queryErrorMessage(
                listingPushJobsQuery.error,
                "Unable to load dropship listing push jobs.",
              )}
          </AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <section className="rounded-md border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Listing push operations</h2>
            <p className="text-sm text-muted-foreground">
              Review bulk listing push jobs, marketplace failures, blocked
              items, and vendor store context.
            </p>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row">
            <div className="relative min-w-0 lg:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="Job, vendor, store, error, or hash"
              />
            </div>
            <Select
              value={platform}
              onValueChange={(value) =>
                setPlatform(value as StoreConnectionPlatformFilter)
              }
            >
              <SelectTrigger className="lg:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All platforms</SelectItem>
                <SelectItem value="ebay">eBay</SelectItem>
                <SelectItem value="shopify">Shopify</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={status}
              onValueChange={(value) =>
                setStatus(value as ListingPushStatusFilter)
              }
            >
              <SelectTrigger className="lg:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {listingPushStatusFilters.map((option) => (
                  <SelectItem key={option} value={option}>
                    {listingPushStatusLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
              onClick={applyListingPushFilters}
            >
              <FileSearch className="h-4 w-4" />
              Apply
            </Button>
          </div>
        </div>
        <div className="mt-4 max-w-3xl">
          <label
            className="text-sm font-medium"
            htmlFor="dropship-listing-job-retry-reason"
          >
            Retry reason
          </label>
          <Input
            id="dropship-listing-job-retry-reason"
            value={retryReason}
            onChange={(event) => setRetryReason(event.target.value)}
            placeholder="Optional retry audit note"
            className="mt-2"
            maxLength={1000}
          />
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <CatalogMetric
          icon={<RefreshCw className="h-4 w-4" />}
          label="Matching jobs"
          value={String(listingPushJobsQuery.data?.total ?? 0)}
        />
        <CatalogMetric
          icon={<AlertCircle className="h-4 w-4" />}
          label="Visible recoverable"
          value={String(recoverableJobCount)}
        />
        <CatalogMetric
          icon={<Boxes className="h-4 w-4" />}
          label="Visible blocked items"
          value={String(
            jobs.reduce((sum, job) => sum + job.itemSummary.blocked, 0),
          )}
        />
        <CatalogMetric
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Visible completed items"
          value={String(
            jobs.reduce((sum, job) => sum + job.itemSummary.completed, 0),
          )}
        />
      </section>

      <ListingPushJobsTable
        isLoading={
          listingPushJobsQuery.isLoading || listingPushJobsQuery.isFetching
        }
        jobs={jobs}
        onRetry={retryListingPushJob}
        onSelectStatus={showListingPushStatus}
        pendingRetryJobId={pendingRetryJobId}
        retryEligibilityNow={listingPushRetryNow}
        summary={listingPushJobsQuery.data?.summary ?? []}
        total={listingPushJobsQuery.data?.total ?? 0}
      />

      <ListingEndOpsSection />
    </div>
  );
}

const listingEndOpsFetch: ListingEndOpsFetch = (url, init) => fetch(url, init);

/**
 * PR C (PLAN-C v4.1 §10, DC33): the eBay listings Card Shellz could not end, after the push jobs. Retry sets a failed
 * end pending again (the worker's claim re-checks everything; the server refuses while an inventory request on the SKU
 * is open); Mark resolved records "Ended on eBay" or "Left on sale" with a required reason. Requests, answers and
 * words come from client/src/lib/dropship-listing-end-ops.ts, which reads every answer through readDropshipAnswer.
 */
function ListingEndOpsSection() {
  const queryClient = useQueryClient();
  const words = LISTING_END_OPS_WORDS;
  const sectionWords = LISTING_END_OPS_SECTION_WORDS;
  const [state, setState] = useState<ListingEndRequestState>(LISTING_END_OPS_DEFAULT_STATE);
  const [page, setPage] = useState(1);
  const [resolving, setResolving] = useState<{ endRequestId: number; draft: ListingEndResolveDraft } | null>(null);
  const [pendingEndRequestId, setPendingEndRequestId] = useState<number | null>(null);
  // One key per press, kept while its failure is transient, so pressing again replays the same action.
  const [pressKeys, setPressKeys] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const listQuery = useQuery({
    queryKey: [...LISTING_END_OPS_QUERY_KEY, state, page],
    queryFn: ({ signal }) =>
      fetchListingEnds(listingEndOpsFetch, { state, page, limit: LISTING_END_OPS_DEFAULT_LIMIT }, signal),
  });
  const rows = listQuery.data?.items ?? [];
  const pager = listingEndOpsPager({
    page,
    limit: LISTING_END_OPS_DEFAULT_LIMIT,
    answer: listQuery.data ? { total: listQuery.data.total, settled: !listQuery.isFetching } : null,
  });
  // Review TST-1: Retry and Mark resolved move the row out of the filtered state and refetch the same page, so an action
  // can empty the last page; once that answer settles, step back to the last page that has rows.
  useEffect(() => {
    if (pager.stepBackTo !== null) setPage(pager.stepBackTo);
  }, [pager.stepBackTo]);

  async function runAction(
    row: ListingEndOpsRow,
    action: ListingEndStaffAction,
    build: (idempotencyKey: string) => ListingEndOpsActionRequest,
    done: string,
  ) {
    const slot = `${row.endRequestId}:${action}`;
    const idempotencyKey = pressKeys[slot] ?? newListingEndStaffKey(action, row.endRequestId);
    setPendingEndRequestId(row.endRequestId);
    setError("");
    setMessage("");
    try {
      await sendListingEndAction(listingEndOpsFetch, build(idempotencyKey));
      setPressKeys(({ [slot]: _done, ...rest }) => rest);
      setResolving(null);
      setMessage(done);
      await queryClient.invalidateQueries({ queryKey: LISTING_END_OPS_QUERY_KEY });
    } catch (caught) {
      const keep = isTransientListingEndOpsError(caught);
      setPressKeys(({ [slot]: _old, ...rest }) => (keep ? { ...rest, [slot]: idempotencyKey } : rest));
      setError(describeListingEndOpsError(caught));
    } finally {
      setPendingEndRequestId(null);
    }
  }

  function retry(row: ListingEndOpsRow) {
    void runAction(row, "retry", (idempotencyKey) =>
      buildListingEndRetryRequest({ endRequestId: row.endRequestId, idempotencyKey }), sectionWords.retried);
  }

  function submitResolve(row: ListingEndOpsRow, draft: ListingEndResolveDraft) {
    const checked = checkListingEndResolveDraft(draft);
    if (!checked.ok) {
      setMessage("");
      setError(describeListingEndResolveProblem(checked.problem));
      return;
    }
    const action: ListingEndStaffAction = checked.outcome === "ended_on_ebay" ? "resolve_ended" : "resolve_left";
    void runAction(row, action, (idempotencyKey) =>
      buildListingEndResolveRequest({ endRequestId: row.endRequestId, idempotencyKey, outcome: checked.outcome,
        reason: checked.reason }), sectionWords.resolved);
  }

  function updateDraft(change: Partial<ListingEndResolveDraft>) {
    setResolving((current) => (current ? { ...current, draft: { ...current.draft, ...change } } : current));
  }

  return (
    <section className="rounded-md border bg-card" data-testid="listing-end-ops">
      <div className="flex flex-col gap-3 border-b px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{words.staffSection}</h2>
          <p className="text-sm text-muted-foreground">{sectionWords.intro}</p>
        </div>
        <Select
          value={state}
          onValueChange={(value) => {
            setState(value as ListingEndRequestState);
            setPage(1);
            setResolving(null);
          }}
        >
          <SelectTrigger className="lg:w-48" aria-label={sectionWords.stateFilter}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LISTING_END_REQUEST_STATES.map((option) => (
              <SelectItem key={option} value={option}>
                {formatStatus(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {(error || listQuery.error) && (
        <Alert variant="destructive" className="m-4 w-auto">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error || describeListingEndOpsError(listQuery.error)}</AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert className="m-4 w-auto border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      {listQuery.isLoading || pager.stepBackTo !== null ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title={words.staffSection} description={sectionWords.empty} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[150px]">{sectionWords.columns.listing}</TableHead>
              <TableHead>{sectionWords.columns.vendorStore}</TableHead>
              <TableHead>{sectionWords.columns.size}</TableHead>
              <TableHead>{sectionWords.columns.state}</TableHead>
              <TableHead>{sectionWords.columns.problem}</TableHead>
              <TableHead className="w-[90px]">{sectionWords.columns.tries}</TableHead>
              <TableHead className="w-[145px]">{sectionWords.columns.decided}</TableHead>
              <TableHead className="w-[200px] text-right">{sectionWords.columns.action}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const open = resolving?.endRequestId === row.endRequestId ? resolving : null;
              const pending = pendingEndRequestId === row.endRequestId;
              const reasonId = `dropship-listing-end-reason-${row.endRequestId}`;
              return [
                <TableRow key={row.endRequestId}>
                  <TableCell>
                    <div className="font-mono text-sm">#{row.endRequestId}</div>
                    <div className="text-xs text-muted-foreground">
                      {[row.listing.externalListingId, row.listing.externalOfferId].filter(Boolean).join(" / ") ||
                        `Listing ${row.listing.listingId}`}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">
                      {row.vendor.businessName || row.vendor.email || `Vendor ${row.vendor.vendorId}`}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {row.store.displayName || `Store ${row.store.storeConnectionId}`}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="font-mono text-sm">{row.sku ?? `#${row.productVariantId}`}</div>
                    <div className="text-xs text-muted-foreground">{formatStatus(row.reason)}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{formatStatus(row.state)}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="font-mono text-xs">{row.code ?? row.context.lastCode ?? ""}</div>
                    <div className="text-sm">{row.message}</div>
                    {row.context.attemptIds.length > 0 && (
                      <div className="text-xs text-muted-foreground">#{row.context.attemptIds.join(", #")}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {row.attemptCount} / {row.withdraw.callCount}
                  </TableCell>
                  <TableCell className="text-sm">{formatDateTime(row.decidedAt)}</TableCell>
                  <TableCell className="text-right">
                    {canActOnListingEnd(row) && (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" disabled={pending} onClick={() => retry(row)}>
                          <RotateCcw className="h-4 w-4" />
                          {words.staffRetry}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => setResolving({ endRequestId: row.endRequestId, draft: { outcome: null, reason: "" } })}
                        >
                          <CheckCircle2 className="h-4 w-4" />
                          {words.staffResolve}
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>,
                open && (
                  <TableRow key={`${row.endRequestId}-resolve`}>
                    <TableCell colSpan={8}>
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                        <div className="flex gap-2" role="group" aria-label={words.staffResolve}>
                          <Button
                            size="sm"
                            variant={open.draft.outcome === "ended_on_ebay" ? "default" : "outline"}
                            aria-pressed={open.draft.outcome === "ended_on_ebay"}
                            onClick={() => updateDraft({ outcome: "ended_on_ebay" })}
                          >
                            {words.staffResolveEnded}
                          </Button>
                          <Button
                            size="sm"
                            variant={open.draft.outcome === "left_on_sale" ? "default" : "outline"}
                            aria-pressed={open.draft.outcome === "left_on_sale"}
                            onClick={() => updateDraft({ outcome: "left_on_sale" })}
                          >
                            {words.staffResolveLeft}
                          </Button>
                        </div>
                        <div className="min-w-0 flex-1">
                          <label className="text-sm font-medium" htmlFor={reasonId}>
                            {words.staffResolveReason}
                          </label>
                          <Textarea
                            id={reasonId}
                            required
                            value={open.draft.reason}
                            maxLength={LISTING_END_STAFF_REASON_MAX_LENGTH}
                            onChange={(event) => updateDraft({ reason: event.target.value })}
                            className="mt-2"
                          />
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" disabled={pending} onClick={() => submitResolve(row, open.draft)}>
                            {words.staffResolve}
                          </Button>
                          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setResolving(null)}>
                            {sectionWords.cancel}
                          </Button>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                ),
              ];
            })}
          </TableBody>
        </Table>
      )}

      {pager.show && (
        <div className="flex items-center justify-end gap-2 border-t px-4 py-3 text-sm">
          <Button size="sm" variant="outline" disabled={!pager.canGoBack} onClick={() => setPage((current) => Math.max(1, current - 1))}>
            <ChevronLeft className="h-4 w-4" />
            {sectionWords.previous}
          </Button>
          <span>{pager.label}</span>
          <Button size="sm" variant="outline" disabled={!pager.canGoForward} onClick={() => setPage((current) => current + 1)}>
            {sectionWords.next}
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </section>
  );
}

function ListingPushJobsTable({
  isLoading,
  jobs,
  onRetry,
  onSelectStatus,
  pendingRetryJobId,
  retryEligibilityNow,
  summary,
  total,
}: {
  isLoading: boolean;
  jobs: DropshipAdminListingPushJobListItem[];
  onRetry: (job: DropshipAdminListingPushJobListItem) => void;
  /** A status badge is a filter: clicking "Completed 3" shows those three jobs. */
  onSelectStatus: (status: DropshipListingPushJobStatus) => void;
  pendingRetryJobId: number | null;
  retryEligibilityNow: Date;
  summary: DropshipAdminListingPushJobListResponse["summary"];
  total: number;
}) {
  if (isLoading) {
    return (
      <div className="mt-4 space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (jobs.length === 0) {
    return (
      <EmptyState
        title="No listing push jobs"
        description="No dropship listing push jobs match the current filters."
      />
    );
  }

  return (
    <section className="rounded-md border bg-card">
      <div className="flex flex-col gap-3 border-b px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Listing push jobs</h2>
          <p className="text-sm text-muted-foreground">
            {total} matching job{total === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {summary.map((entry) => (
            <button
              key={entry.status}
              type="button"
              className="rounded-full"
              aria-label={`Show ${formatStatus(entry.status).toLowerCase()} jobs`}
              onClick={() => onSelectStatus(entry.status)}
            >
              <Badge
                variant="outline"
                className={listingPushStatusTone(entry.status)}
              >
                {formatStatus(entry.status)} {entry.count}
              </Badge>
            </button>
          ))}
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[110px]">Job</TableHead>
            <TableHead>Vendor/store</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Items</TableHead>
            <TableHead>Latest issue</TableHead>
            <TableHead className="w-[145px]">Updated</TableHead>
            <TableHead className="w-[120px] text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => {
            const retryEligibility = listingPushJobRetryEligibility(
              job,
              retryEligibilityNow,
            );
            const retryLabel =
              retryEligibility.reason === "stale_processing"
                ? "Recover"
                : "Retry";
            return (
              <TableRow key={job.jobId}>
                <TableCell>
                  <div className="font-mono text-sm">#{job.jobId}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatStatus(job.jobType)}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="font-medium">
                    {job.vendor.businessName ||
                      job.vendor.email ||
                      `Vendor ${job.vendor.vendorId}`}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {[
                      job.storeConnection.externalDisplayName,
                      job.storeConnection.shopDomain,
                      formatStatus(job.platform),
                    ]
                      .filter(Boolean)
                      .join(" / ")}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={listingPushStatusTone(job.status)}
                  >
                    {formatStatus(job.status)}
                  </Badge>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {job.completedAt
                      ? `Completed ${formatDateTime(job.completedAt)}`
                      : `Created ${formatDateTime(job.createdAt)}`}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="font-medium">
                    {job.itemSummary.total} total
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {[
                      job.itemSummary.completed
                        ? `${job.itemSummary.completed} done`
                        : null,
                      job.itemSummary.failed
                        ? `${job.itemSummary.failed} failed`
                        : null,
                      job.itemSummary.blocked
                        ? `${job.itemSummary.blocked} blocked`
                        : null,
                      job.itemSummary.processing
                        ? `${job.itemSummary.processing} processing`
                        : null,
                      job.itemSummary.queued
                        ? `${job.itemSummary.queued} queued`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" / ") || "No item counts"}
                  </div>
                </TableCell>
                <TableCell>
                  {job.latestItemError ? (
                    <>
                      <div className="font-medium">
                        {job.latestItemError.errorCode ||
                          formatStatus(job.latestItemError.status)}
                      </div>
                      <div className="max-w-[360px] truncate text-xs text-muted-foreground">
                        {job.latestItemError.errorMessage ||
                          `Variant ${job.latestItemError.productVariantId}`}
                      </div>
                    </>
                  ) : job.errorMessage ? (
                    <div className="max-w-[360px] truncate text-sm text-muted-foreground">
                      {job.errorMessage}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">None</div>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatDateTime(job.updatedAt)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="gap-2"
                    disabled={
                      !retryEligibility.canRetry || pendingRetryJobId !== null
                    }
                    onClick={() => onRetry(job)}
                  >
                    <RotateCcw
                      className={
                        pendingRetryJobId === job.jobId
                          ? "h-4 w-4 animate-spin"
                          : "h-4 w-4"
                      }
                    />
                    {retryLabel}
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

function listingPushStatusLabel(status: ListingPushStatusFilter): string {
  if (status === "default") return "Needs attention";
  if (status === "all") return "All statuses";
  return formatStatus(status);
}

function listingPushStatusTone(status: DropshipListingPushJobStatus): string {
  if (status === "completed") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (status === "queued" || status === "processing") {
    return "border-amber-200 bg-amber-50 text-amber-900";
  }
  if (status === "failed") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}

export {
  listingPushStatusFilters,
  ListingPushOpsTab,
  ListingEndOpsSection,
  ListingPushJobsTable,
  listingPushStatusLabel,
  listingPushStatusTone,
  type ListingPushStatusFilter,
};
export default ListingPushOpsTab;
