import {
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  FileSearch,
  PlayCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  Store,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  buildAdminDogfoodLaunchStatusUrl,
  buildAdminDogfoodReadinessUrl,
  buildAdminOmsChannelConfigUrl,
  buildAdminOmsChannelDefaultSourceInput,
  buildAdminOmsChannelDefaultSourceUrl,
  buildAdminWorkerSweepInput,
  buildAdminWorkerSweepRunUrl,
  createDropshipIdempotencyKey,
  fetchJson,
  formatCents,
  formatDateTime,
  formatStatus,
  postJson,
  queryErrorMessage,
  type DropshipAdminOmsChannelConfigResponse,
  type DropshipAdminOmsChannelConfigureResponse,
  type DropshipAdminWorkerSweepName,
  type DropshipAdminWorkerSweepResponse,
  type DropshipDogfoodLaunchCandidate,
  type DropshipDogfoodLaunchGate,
  type DropshipDogfoodLaunchRunbookStep,
  type DropshipDogfoodLaunchStatusResponse,
  type DropshipDogfoodReadinessItem,
  type DropshipDogfoodReadinessResponse,
  type DropshipDogfoodReadinessStatus,
  type DropshipDogfoodSmokeCandidate,
  type DropshipDogfoodSmokeResponse,
  type DropshipDogfoodSmokeStage,
  type DropshipSystemReadinessCheck,
} from "@/lib/dropship-ops-surface";
import {
  adminWorkerSweepOptions,
  CatalogMetric,
  dogfoodReadinessStatusFilters,
  dogfoodReadinessStatusTone,
  dropshipOmsSourceLabel,
  EmptyState,
  OmsChannelConfigPanel,
  readinessSummaryCount,
  systemReadinessCheckTone,
  systemReadinessTone,
  workerSweepMessageForResponse,
  type DogfoodReadinessStatusFilter,
  type DropshipOpsSearchableTab,
  type DropshipOpsSearchSignal,
  type StoreConnectionPlatformFilter,
} from "./dropship-admin-shared";

function DogfoodReadinessTab({
  onOpenSmokeOpsSearch,
}: {
  onOpenSmokeOpsSearch: (input: Omit<DropshipOpsSearchSignal, "nonce">) => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<DogfoodReadinessStatusFilter>("all");
  const [platform, setPlatform] =
    useState<StoreConnectionPlatformFilter>("all");
  const [omsMessage, setOmsMessage] = useState("");
  const [omsError, setOmsError] = useState("");
  const [isSavingOmsChannel, setIsSavingOmsChannel] = useState(false);
  const [workerBatchSize, setWorkerBatchSize] = useState("10");
  const [workerReason, setWorkerReason] = useState("Dogfood manual sweep");
  const [pendingWorkerSweep, setPendingWorkerSweep] =
    useState<DropshipAdminWorkerSweepName | null>(null);
  const [workerSweepMessage, setWorkerSweepMessage] = useState("");
  const [workerSweepError, setWorkerSweepError] = useState("");
  const [appliedFilters, setAppliedFilters] = useState({
    search: "",
    status: "all" as DogfoodReadinessStatusFilter,
    platform: "all" as StoreConnectionPlatformFilter,
  });

  const readinessUrl = useMemo(
    () =>
      buildAdminDogfoodReadinessUrl({
        search: appliedFilters.search,
        status: appliedFilters.status,
        platform: appliedFilters.platform,
      }),
    [appliedFilters],
  );
  const launchStatusUrl = useMemo(
    () =>
      buildAdminDogfoodLaunchStatusUrl({
        search: appliedFilters.search,
        platform: appliedFilters.platform,
      }),
    [appliedFilters],
  );

  const readinessQuery = useQuery<DropshipDogfoodReadinessResponse>({
    queryKey: [readinessUrl],
    queryFn: () => fetchJson<DropshipDogfoodReadinessResponse>(readinessUrl),
  });
  const launchStatusQuery = useQuery<DropshipDogfoodLaunchStatusResponse>({
    queryKey: [launchStatusUrl],
    queryFn: () =>
      fetchJson<DropshipDogfoodLaunchStatusResponse>(launchStatusUrl),
  });
  const omsChannelConfigUrl = buildAdminOmsChannelConfigUrl();
  const omsChannelConfigQuery = useQuery<DropshipAdminOmsChannelConfigResponse>(
    {
      queryKey: [omsChannelConfigUrl],
      queryFn: () =>
        fetchJson<DropshipAdminOmsChannelConfigResponse>(omsChannelConfigUrl),
    },
  );

  const items = readinessQuery.data?.items ?? [];
  const summary = readinessQuery.data?.summary ?? [];
  const launchStatus = launchStatusQuery.data ?? null;
  const systemChecks =
    readinessQuery.data?.systemChecks ??
    launchStatus?.readiness.systemChecks ??
    [];
  const launchGate =
    launchStatus?.launchGate ?? readinessQuery.data?.launchGate ?? null;
  const omsConfig = omsChannelConfigQuery.data?.config ?? null;

  function applyReadinessFilters() {
    setAppliedFilters({ search, status, platform });
  }

  async function ensureOmsSource() {
    setIsSavingOmsChannel(true);
    setOmsError("");
    setOmsMessage("");
    try {
      const input = buildAdminOmsChannelDefaultSourceInput({
        idempotencyKey: createDropshipIdempotencyKey("admin-oms-source"),
      });
      const response = await postJson<DropshipAdminOmsChannelConfigureResponse>(
        buildAdminOmsChannelDefaultSourceUrl(),
        input,
      );
      setOmsMessage(
        `Internal dropship channel initialized as ${dropshipOmsSourceLabel(response.selectedChannel)}.`,
      );
      await Promise.all([
        omsChannelConfigQuery.refetch(),
        readinessQuery.refetch(),
        launchStatusQuery.refetch(),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/ops/overview"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/audit-events"],
        }),
      ]);
    } catch (caught) {
      setOmsError(
        caught instanceof Error
          ? caught.message
          : "Internal dropship channel setup failed.",
      );
    } finally {
      setIsSavingOmsChannel(false);
    }
  }

  async function runWorkerSweep(worker: DropshipAdminWorkerSweepName) {
    setPendingWorkerSweep(worker);
    setWorkerSweepError("");
    setWorkerSweepMessage("");
    try {
      const input = buildAdminWorkerSweepInput({
        idempotencyKey: createDropshipIdempotencyKey(
          `admin-worker-sweep-${worker}`,
        ),
        batchSize: workerBatchSize,
        reason: workerReason,
      });
      const response = await postJson<DropshipAdminWorkerSweepResponse>(
        buildAdminWorkerSweepRunUrl(worker),
        input,
      );
      setWorkerSweepMessage(workerSweepMessageForResponse(response));
      await Promise.all([
        readinessQuery.refetch(),
        launchStatusQuery.refetch(),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/ops/overview"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/audit-events"],
        }),
      ]);
    } catch (caught) {
      setWorkerSweepError(
        caught instanceof Error
          ? caught.message
          : "Dropship worker sweep failed.",
      );
    } finally {
      setPendingWorkerSweep(null);
    }
  }

  return (
    <div className="space-y-5">
      {(readinessQuery.error ||
        launchStatusQuery.error ||
        omsChannelConfigQuery.error ||
        omsError ||
        workerSweepError) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {omsError ||
              workerSweepError ||
              queryErrorMessage(
                readinessQuery.error ??
                  launchStatusQuery.error ??
                  omsChannelConfigQuery.error,
                "Unable to load dropship dogfood readiness.",
              )}
          </AlertDescription>
        </Alert>
      )}
      {omsMessage && (
        <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{omsMessage}</AlertDescription>
        </Alert>
      )}
      {workerSweepMessage && (
        <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{workerSweepMessage}</AlertDescription>
        </Alert>
      )}

      <OmsChannelConfigPanel
        config={omsConfig}
        isLoading={
          omsChannelConfigQuery.isLoading || omsChannelConfigQuery.isFetching
        }
        isSaving={isSavingOmsChannel}
        onEnsureDefaultSource={ensureOmsSource}
      />

      <SystemReadinessPanel
        checks={systemChecks}
        isLoading={readinessQuery.isLoading || readinessQuery.isFetching}
      />

      <WorkerSweepPanel
        batchSize={workerBatchSize}
        pendingWorker={pendingWorkerSweep}
        reason={workerReason}
        onBatchSizeChange={setWorkerBatchSize}
        onReasonChange={setWorkerReason}
        onRunSweep={runWorkerSweep}
      />

      <DogfoodLaunchGatePanel
        gate={launchGate}
        isLoading={launchStatusQuery.isLoading || launchStatusQuery.isFetching}
        launchCandidates={launchStatus?.launchCandidates ?? []}
        message={launchStatus?.message}
        runbookSteps={launchStatus?.runbookSteps}
        status={launchStatus?.status}
      />

      <DogfoodSmokePanel
        smoke={launchStatus?.smoke ?? null}
        isLoading={launchStatusQuery.isLoading || launchStatusQuery.isFetching}
        onOpenSmokeOpsSearch={onOpenSmokeOpsSearch}
      />

      <section className="rounded-md border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Launch checklist</h2>
            <p className="text-sm text-muted-foreground">
              Every vendor and store against the internal launch checklist.
              These rows are the detail behind the verdict above: a blocker
              here is the thing to fix.
            </p>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row">
            <div className="relative min-w-0 lg:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="Vendor, member, store, or domain"
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
                setStatus(value as DogfoodReadinessStatusFilter)
              }
            >
              <SelectTrigger className="lg:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {dogfoodReadinessStatusFilters.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option === "all" ? "All statuses" : formatStatus(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
              onClick={applyReadinessFilters}
            >
              <FileSearch className="h-4 w-4" />
              Apply
            </Button>
          </div>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" data-testid="launch-checklist-counts">
        <CatalogMetric
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Ready"
          value={String(readinessSummaryCount(summary, "ready"))}
        />
        <CatalogMetric
          icon={<AlertCircle className="h-4 w-4" />}
          label="Blocked"
          value={String(readinessSummaryCount(summary, "blocked"))}
        />
        <CatalogMetric
          icon={<ShieldAlert className="h-4 w-4" />}
          label="Warnings"
          value={String(readinessSummaryCount(summary, "warning"))}
        />
        <CatalogMetric
          icon={<Store className="h-4 w-4" />}
          label="Matching rows"
          value={String(readinessQuery.data?.total ?? 0)}
        />
      </section>

      <DogfoodReadinessTable
        isLoading={readinessQuery.isLoading || readinessQuery.isFetching}
        items={items}
        total={readinessQuery.data?.total ?? 0}
      />
    </div>
  );
}

function SystemReadinessPanel({
  checks,
  isLoading,
}: {
  checks: DropshipSystemReadinessCheck[];
  isLoading: boolean;
}) {
  if (isLoading && checks.length === 0) {
    return (
      <section className="rounded-md border bg-card p-4">
        <Skeleton className="h-6 w-56" />
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-24 w-full" />
          ))}
        </div>
      </section>
    );
  }

  if (checks.length === 0) {
    return null;
  }

  const blockedCount = checks.filter(
    (check) => check.status === "blocked",
  ).length;
  const warningCount = checks.filter(
    (check) => check.status === "warning",
  ).length;
  const notApplicableCount = checks.filter(
    (check) => check.status === "not_applicable",
  ).length;

  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">System prerequisites</h2>
          <p className="text-sm text-muted-foreground">
            {blockedCount} blocked / {warningCount} warning /{" "}
            {notApplicableCount} not applicable
          </p>
        </div>
        <Badge
          variant="outline"
          className={systemReadinessTone(blockedCount, warningCount)}
        >
          {blockedCount > 0
            ? "Blocked"
            : warningCount > 0
              ? "Warning"
              : "Ready"}
        </Badge>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {checks.map((check) => (
          <div key={check.key} className="rounded-md border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium">{check.label}</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {check.message}
                </div>
              </div>
              <Badge
                variant="outline"
                className={systemReadinessCheckTone(check.status)}
              >
                {formatStatus(check.status)}
              </Badge>
            </div>
            {check.requiredEnv.length > 0 &&
              check.status !== "ready" &&
              check.status !== "not_applicable" && (
                <div className="mt-2 text-xs text-muted-foreground">
                  Env: {check.requiredEnv.join(", ")}
                </div>
              )}
          </div>
        ))}
      </div>
    </section>
  );
}

function WorkerSweepPanel({
  batchSize,
  pendingWorker,
  reason,
  onBatchSizeChange,
  onReasonChange,
  onRunSweep,
}: {
  batchSize: string;
  pendingWorker: DropshipAdminWorkerSweepName | null;
  reason: string;
  onBatchSizeChange: Dispatch<SetStateAction<string>>;
  onReasonChange: Dispatch<SetStateAction<string>>;
  onRunSweep: (worker: DropshipAdminWorkerSweepName) => void;
}) {
  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Manual worker sweeps</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Run the same dropship worker paths used by schedulers without
            waiting for the next interval.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-[120px_minmax(220px,1fr)] xl:w-[520px]">
          <label className="space-y-1">
            <span className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
              Batch
            </span>
            <Input
              inputMode="numeric"
              value={batchSize}
              onChange={(event) => onBatchSizeChange(event.target.value)}
              placeholder="10"
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
              Reason
            </span>
            <Input
              value={reason}
              onChange={(event) => onReasonChange(event.target.value)}
              placeholder="Dogfood manual sweep"
            />
          </label>
        </div>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        {adminWorkerSweepOptions.map((option) => {
          const isPending = pendingWorker === option.worker;
          return (
            <div
              key={option.worker}
              className="flex min-h-36 flex-col justify-between rounded-md border p-3"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="font-medium">{option.label}</div>
                  <Badge
                    variant="outline"
                    className="border-zinc-200 bg-zinc-50 text-zinc-700"
                  >
                    {option.worker}
                  </Badge>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {option.description}
                </p>
              </div>
              <Button
                className="mt-4 gap-2"
                disabled={pendingWorker !== null}
                variant="outline"
                onClick={() => onRunSweep(option.worker)}
              >
                {isPending ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <PlayCircle className="h-4 w-4" />
                )}
                {isPending ? "Running" : "Run sweep"}
              </Button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DogfoodLaunchGatePanel({
  gate,
  isLoading,
  launchCandidates,
  message,
  runbookSteps,
  status,
}: {
  gate: DropshipDogfoodLaunchGate | null;
  isLoading: boolean;
  launchCandidates?: DropshipDogfoodLaunchCandidate[];
  message?: string;
  runbookSteps?: DropshipDogfoodLaunchRunbookStep[];
  status?: DropshipDogfoodReadinessStatus;
}) {
  if (isLoading && !gate) {
    return (
      <section className="rounded-md border bg-card p-4">
        <Skeleton className="h-6 w-48" />
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-20 w-full" />
          ))}
        </div>
      </section>
    );
  }

  if (!gate) {
    return null;
  }

  const displayStatus = status ?? gate.status;
  const displayMessage = message ?? gate.message;
  const steps = runbookSteps ?? gate.runbookSteps;
  const candidates = launchCandidates ?? [];

  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">Can we run live orders?</h2>
            <Badge
              variant="outline"
              className={dogfoodReadinessStatusTone(displayStatus)}
            >
              {formatStatus(displayStatus)}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{displayMessage}</p>
          {/*
            The verdict only. Every blocker behind it is a row of the launch
            checklist below and a card in system prerequisites above, and
            printing them here as well made one problem look like three.
          */}
          <p className="mt-1 text-sm text-muted-foreground">
            This is a summary of the two panels below it: system prerequisites
            for the environment, and the launch checklist for each vendor and
            store. Fix a blocker there, not here.
          </p>
        </div>
      </div>
      {candidates.length > 0 && (
        <div className="mt-4 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-normal text-muted-foreground">
              Ready dogfood candidates
            </h3>
            <Badge
              variant="outline"
              className="border-emerald-200 bg-emerald-50 text-emerald-800"
            >
              {candidates.length} ready
            </Badge>
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-2">
            {candidates.slice(0, 4).map((candidate) => (
              <DogfoodLaunchCandidateCard
                key={`${candidate.vendor.vendorId}:${candidate.storeConnection.storeConnectionId}`}
                candidate={candidate}
              />
            ))}
          </div>
        </div>
      )}
      {steps.length > 0 && (
        <div className="mt-4 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold uppercase tracking-normal text-muted-foreground">
              Launch runbook
            </h3>
            <Badge
              variant="outline"
              className="border-zinc-200 bg-zinc-50 text-zinc-700"
            >
              {steps.length} step{steps.length === 1 ? "" : "s"}
            </Badge>
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-2">
            {steps.map((step, index) => (
              <LaunchRunbookStepCard key={step.key} step={step} index={index} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function DogfoodLaunchCandidateCard({
  candidate,
}: {
  candidate: DropshipDogfoodLaunchCandidate;
}) {
  const storeName =
    candidate.storeConnection.externalDisplayName ||
    candidate.storeConnection.shopDomain ||
    `${formatStatus(candidate.storeConnection.platform)} store ${candidate.storeConnection.storeConnectionId}`;
  const references = [
    candidate.smokeReferences.latestListingId
      ? `Listing ${candidate.smokeReferences.latestListingId}`
      : null,
    candidate.smokeReferences.latestIntakeId
      ? `Intake ${candidate.smokeReferences.latestIntakeId}`
      : null,
    candidate.smokeReferences.latestOmsOrderId
      ? `OMS ${candidate.smokeReferences.latestOmsOrderId}`
      : null,
    candidate.smokeReferences.latestWmsShipmentId
      ? `Shipment ${candidate.smokeReferences.latestWmsShipmentId}`
      : null,
    candidate.smokeReferences.latestTrackingPushId
      ? `Tracking ${candidate.smokeReferences.latestTrackingPushId}`
      : null,
  ].filter((reference): reference is string => Boolean(reference));

  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium">
            {candidate.vendor.businessName ||
              candidate.vendor.email ||
              `Vendor ${candidate.vendor.vendorId}`}
          </div>
          <div className="mt-1 truncate text-xs text-muted-foreground">
            {storeName}
          </div>
        </div>
        <Badge
          variant="outline"
          className="shrink-0 border-emerald-200 bg-emerald-50 text-emerald-800"
        >
          Ready
        </Badge>
      </div>
      <div className="mt-2 text-xs text-muted-foreground">
        Latest smoke{" "}
        {candidate.lastSmokeActivityAt
          ? formatDateTime(candidate.lastSmokeActivityAt)
          : "missing"}
      </div>
      {references.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {references.map((reference) => (
            <Badge
              key={reference}
              variant="outline"
              className="border-zinc-200 bg-zinc-50 text-zinc-700"
            >
              {reference}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function LaunchRunbookStepCard({
  step,
  index,
}: {
  step: DropshipDogfoodLaunchRunbookStep;
  index: number;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className="border-zinc-200 bg-zinc-50 text-zinc-700"
            >
              {index + 1}
            </Badge>
            <div className="font-medium">{step.label}</div>
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            {step.message}
          </div>
        </div>
        <Badge
          variant="outline"
          className={dogfoodReadinessStatusTone(step.status)}
        >
          {formatStatus(step.status)}
        </Badge>
      </div>
      <div className="mt-3 rounded-md bg-muted/50 px-3 py-2 text-sm">
        {step.action}
      </div>
      {step.evidence.length > 0 && (
        <div className="mt-3 space-y-1">
          {step.evidence.slice(0, 3).map((entry, entryIndex) => (
            <div
              key={`${step.key}:evidence:${entryIndex}`}
              className="truncate text-xs text-muted-foreground"
            >
              {entry}
            </div>
          ))}
          {step.evidence.length > 3 && (
            <div className="text-xs text-muted-foreground">
              +{step.evidence.length - 3} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LaunchGateMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold">{value}</div>
    </div>
  );
}

function DogfoodSmokePanel({
  smoke,
  isLoading,
  onOpenSmokeOpsSearch,
}: {
  smoke: DropshipDogfoodSmokeResponse | null;
  isLoading: boolean;
  onOpenSmokeOpsSearch: (input: Omit<DropshipOpsSearchSignal, "nonce">) => void;
}) {
  if (isLoading && !smoke) {
    return (
      <section className="rounded-md border bg-card p-4">
        <Skeleton className="h-6 w-56" />
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <Skeleton className="h-36 w-full" />
          <Skeleton className="h-36 w-full" />
        </div>
      </section>
    );
  }

  if (!smoke) return null;

  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Has a real order run end to end?</h2>
          {/*
            A different question from the checklist: that one asks whether a
            vendor is configured to trade, this one asks whether an order has
            actually gone out. Red here does not block the checklist, and red
            there does not explain this.
          */}
          <p className="mt-1 text-sm text-muted-foreground">
            Evidence of a listing pushed, an order taken in, a shipment made
            and tracking sent back. Separate from the launch checklist: a
            vendor can be fully configured and still have no order yet.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{smoke.message}</p>
        </div>
        <div className="grid w-full gap-2 sm:grid-cols-3 lg:w-auto lg:min-w-[420px]">
          <LaunchGateMetric label="Ready" value={smoke.readyCandidateCount} />
          <LaunchGateMetric
            label="Incomplete"
            value={smoke.warningCandidateCount}
          />
          <LaunchGateMetric
            label="Blocked"
            value={smoke.blockedCandidateCount}
          />
        </div>
      </div>
      {smoke.candidates.length === 0 ? (
        <div className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          No store connections match the current smoke filters.
        </div>
      ) : (
        <div className="mt-4 grid gap-3 xl:grid-cols-2">
          {smoke.candidates.map((candidate) => (
            <DogfoodSmokeCandidateCard
              key={`${candidate.vendor.vendorId}:${candidate.storeConnection.storeConnectionId}`}
              candidate={candidate}
              onOpenSmokeOpsSearch={onOpenSmokeOpsSearch}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DogfoodSmokeCandidateCard({
  candidate,
  onOpenSmokeOpsSearch,
}: {
  candidate: DropshipDogfoodSmokeCandidate;
  onOpenSmokeOpsSearch: (input: Omit<DropshipOpsSearchSignal, "nonce">) => void;
}) {
  const storeName =
    candidate.storeConnection.externalDisplayName ||
    candidate.storeConnection.shopDomain ||
    `${formatStatus(candidate.storeConnection.platform)} store ${candidate.storeConnection.storeConnectionId}`;
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">
            {candidate.vendor.businessName ||
              candidate.vendor.email ||
              `Vendor ${candidate.vendor.vendorId}`}
          </div>
          <div className="mt-1 truncate text-sm text-muted-foreground">
            {storeName} /{" "}
            {candidate.lastActivityAt
              ? formatDateTime(candidate.lastActivityAt)
              : "No activity"}
          </div>
        </div>
        <Badge
          variant="outline"
          className={dogfoodReadinessStatusTone(candidate.status)}
        >
          {formatStatus(candidate.status)}
        </Badge>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {candidate.stages.map((stage) => (
          <DogfoodSmokeStageCard
            key={stage.key}
            candidate={candidate}
            stage={stage}
            onOpenSmokeOpsSearch={onOpenSmokeOpsSearch}
          />
        ))}
      </div>
    </div>
  );
}

function DogfoodSmokeStageCard({
  candidate,
  stage,
  onOpenSmokeOpsSearch,
}: {
  candidate: DropshipDogfoodSmokeCandidate;
  stage: DropshipDogfoodSmokeStage;
  onOpenSmokeOpsSearch: (input: Omit<DropshipOpsSearchSignal, "nonce">) => void;
}) {
  const action = buildSmokeStageAction(candidate, stage);
  return (
    <div className="rounded-md border px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{stage.label}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {stage.message}
          </div>
        </div>
        <Badge
          variant="outline"
          className={dogfoodReadinessStatusTone(stage.status)}
        >
          {formatStatus(stage.status)}
        </Badge>
      </div>
      {stage.evidence.length > 0 && (
        <div className="mt-2 space-y-1">
          {stage.evidence.slice(0, 2).map((entry, index) => (
            <div
              key={`${stage.key}:${index}`}
              className="truncate text-xs text-muted-foreground"
            >
              {entry}
            </div>
          ))}
        </div>
      )}
      {action && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3 h-8 gap-2"
          onClick={() => onOpenSmokeOpsSearch(action)}
        >
          <FileSearch className="h-3.5 w-3.5" />
          {actionLabelForTab(action.tab)}
        </Button>
      )}
    </div>
  );
}

function buildSmokeStageAction(
  candidate: DropshipDogfoodSmokeCandidate,
  stage: DropshipDogfoodSmokeStage,
): Omit<DropshipOpsSearchSignal, "nonce"> | null {
  const platform =
    candidate.storeConnection.platform === "ebay" ||
    candidate.storeConnection.platform === "shopify"
      ? candidate.storeConnection.platform
      : "all";
  if (stage.key === "listing") {
    return {
      tab: "listing-pushes",
      platform,
      search: smokeSearchValue([
        candidate.references.latestListingJobId,
        candidate.references.latestListingId,
        candidate.storeConnection.externalDisplayName,
        candidate.storeConnection.shopDomain,
        candidate.vendor.email,
      ]),
    };
  }
  if (stage.key === "order_intake" || stage.key === "fulfillment") {
    return {
      tab: "order-intake",
      search: smokeSearchValue([
        candidate.references.latestIntakeId,
        candidate.references.latestOmsOrderId,
        candidate.storeConnection.externalDisplayName,
        candidate.storeConnection.shopDomain,
        candidate.vendor.email,
      ]),
    };
  }
  if (stage.key === "tracking") {
    return {
      tab: "tracking-pushes",
      platform,
      search: smokeSearchValue([
        candidate.references.latestTrackingPushId,
        candidate.references.latestWmsShipmentId,
        candidate.references.latestOmsOrderId,
        candidate.storeConnection.externalDisplayName,
        candidate.storeConnection.shopDomain,
        candidate.vendor.email,
      ]),
    };
  }
  return null;
}

function smokeSearchValue(
  values: Array<string | number | null | undefined>,
): string {
  const value = values.find((entry) => {
    if (typeof entry === "number")
      return Number.isSafeInteger(entry) && entry > 0;
    return Boolean(entry?.trim());
  });
  return typeof value === "number" ? String(value) : (value?.trim() ?? "");
}

function actionLabelForTab(tab: DropshipOpsSearchableTab): string {
  if (tab === "listing-pushes") return "Open listings";
  if (tab === "tracking-pushes") return "Open tracking";
  return "Open intake";
}

function DogfoodReadinessTable({
  isLoading,
  items,
  total,
}: {
  isLoading: boolean;
  items: DropshipDogfoodReadinessItem[];
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

  if (items.length === 0) {
    return (
      <EmptyState
        title="No readiness rows"
        description="No dropship vendor/store rows match the current filters."
      />
    );
  }

  return (
    <section className="rounded-md border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <p className="text-sm text-muted-foreground">
          {total} matching row{total === 1 ? "" : "s"}
        </p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Vendor/store</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Blocking checks</TableHead>
            <TableHead>Catalog</TableHead>
            <TableHead>Shipping</TableHead>
            <TableHead>Wallet</TableHead>
            <TableHead className="w-[145px]">Store updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const blockingChecks = item.checks.filter(
              (check) => check.status === "blocked",
            );
            const warningChecks = item.checks.filter(
              (check) => check.status === "warning",
            );
            return (
              <TableRow
                key={`${item.vendor.vendorId}:${item.storeConnection.storeConnectionId ?? "none"}`}
              >
                <TableCell>
                  <div className="font-medium">
                    {item.vendor.businessName ||
                      item.vendor.email ||
                      `Vendor ${item.vendor.vendorId}`}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {[
                      item.storeConnection.externalDisplayName,
                      item.storeConnection.shopDomain,
                      item.storeConnection.platform
                        ? formatStatus(item.storeConnection.platform)
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" / ") || item.vendor.memberId}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={dogfoodReadinessStatusTone(item.readinessStatus)}
                  >
                    {formatStatus(item.readinessStatus)}
                  </Badge>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {item.blockerCount} blocker
                    {item.blockerCount === 1 ? "" : "s"} / {item.warningCount}{" "}
                    warning{item.warningCount === 1 ? "" : "s"}
                  </div>
                </TableCell>
                <TableCell>
                  {blockingChecks.length > 0 ? (
                    <div className="space-y-1">
                      {blockingChecks.slice(0, 3).map((check) => (
                        <div
                          key={check.key}
                          className="max-w-[360px] truncate text-sm"
                        >
                          <span className="font-medium">{check.label}:</span>{" "}
                          <span className="text-muted-foreground">
                            {check.message}
                          </span>
                        </div>
                      ))}
                      {blockingChecks.length > 3 && (
                        <div className="text-xs text-muted-foreground">
                          +{blockingChecks.length - 3} more blocker(s)
                        </div>
                      )}
                    </div>
                  ) : warningChecks.length > 0 ? (
                    <div className="space-y-1">
                      {warningChecks.slice(0, 2).map((check) => (
                        <div
                          key={check.key}
                          className="max-w-[360px] truncate text-sm text-muted-foreground"
                        >
                          {check.label}: {check.message}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      All required checks ready
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="text-sm">
                    Admin include:{" "}
                    <span className="font-mono">
                      {item.metrics.adminCatalogIncludeRuleCount}
                    </span>
                  </div>
                  <div className="text-sm">
                    {/* Stage 3/5 (step 1 plan S2-5): PROPOSED (V17). One-time picks: the vendor's chosen sizes, "—" from an older server. */}
                    Items chosen:{" "}
                    <span className="font-mono">
                      {item.metrics.vendorSelectedItemCount ?? "—"}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Warehouse {item.metrics.defaultWarehouseId ?? "missing"} /
                    Listing config{" "}
                    {item.metrics.listingConfigActive ? "active" : "not ready"}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="text-sm">
                    Package data:{" "}
                    <span className="font-mono">
                      {item.metrics.selectedPackageProfileCount}
                    </span>
                    {" / "}
                    <span
                      className={
                        item.metrics.selectedVariantMissingPackageProfileCount >
                        0
                          ? "font-mono text-rose-700"
                          : "font-mono"
                      }
                    >
                      {item.metrics.selectedVariantMissingPackageProfileCount}
                    </span>
                    {" missing"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Boxes {item.metrics.activeShippingBoxCount} / Zones{" "}
                    {item.metrics.activeShippingZoneRuleCount} / Rate rows{" "}
                    {item.metrics.activeShippingRateRowCount}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Markup {item.metrics.activeShippingMarkupPolicyCount} /
                    Insurance {item.metrics.activeShippingInsurancePolicyCount}
                    {" / "}
                    Returns {item.metrics.activeReturnPolicyCount}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    OMS{" "}
                    {item.metrics.dropshipOmsChannelCount === 1
                      ? item.metrics.dropshipOmsChannelId
                      : `${item.metrics.dropshipOmsChannelCount} marked`}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="text-sm">
                    {formatCents(item.metrics.walletAvailableBalanceCents)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {item.metrics.activeFundingMethodCount} funding method
                    {item.metrics.activeFundingMethodCount === 1 ? "" : "s"} /{" "}
                    {item.metrics.activeStripeFundingMethodCount} Stripe-ready /{" "}
                    {item.metrics.activeUsdcBaseFundingMethodCount} USDC-ready
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Auto reload {item.metrics.autoReloadEnabled ? "on" : "off"}{" "}
                    / funding{" "}
                    {item.metrics.autoReloadFundingMethodReady
                      ? "ready"
                      : "not ready"}
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatDateTime(item.storeConnection.updatedAt)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

export {
  DogfoodReadinessTab,
  SystemReadinessPanel,
  WorkerSweepPanel,
  DogfoodLaunchGatePanel,
  DogfoodLaunchCandidateCard,
  LaunchRunbookStepCard,
  LaunchGateMetric,
  DogfoodSmokePanel,
  DogfoodSmokeCandidateCard,
  DogfoodSmokeStageCard,
  buildSmokeStageAction,
  smokeSearchValue,
  actionLabelForTab,
  DogfoodReadinessTable,
};
export default DogfoodReadinessTab;
