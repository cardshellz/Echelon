import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Bell,
  ClipboardList,
  FileSearch,
  History,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  Store,
  Truck,
  Wallet,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  countByKey,
  fetchJson,
  formatDateTime,
  formatStatus,
  riskSeverityTone,
  type DropshipAdminOpsOverview,
  type DropshipAdminOpsOverviewResponse,
  type DropshipAuditEventRecord,
  type DropshipAuditEventSearchResponse,
  type DropshipOpsCount,
  type DropshipOpsRiskBucket,
  type DropshipSeverity,
} from "@/lib/dropship-ops-surface";

type AuditSeverityFilter = DropshipSeverity | "all";

export default function Dropship() {
  const [auditSearch, setAuditSearch] = useState("");
  const [auditSeverity, setAuditSeverity] = useState<AuditSeverityFilter>("all");
  const [appliedAuditFilters, setAppliedAuditFilters] = useState({
    search: "",
    severity: "all" as AuditSeverityFilter,
  });

  const auditUrl = useMemo(() => {
    const params = new URLSearchParams({ page: "1", limit: "25" });
    if (appliedAuditFilters.search.trim()) params.set("search", appliedAuditFilters.search.trim());
    if (appliedAuditFilters.severity !== "all") params.set("severity", appliedAuditFilters.severity);
    return `/api/dropship/admin/audit-events?${params.toString()}`;
  }, [appliedAuditFilters]);

  const overviewQuery = useQuery<DropshipAdminOpsOverviewResponse>({
    queryKey: ["/api/dropship/admin/ops/overview"],
    queryFn: () => fetchJson<DropshipAdminOpsOverviewResponse>("/api/dropship/admin/ops/overview"),
  });
  const auditQuery = useQuery<DropshipAuditEventSearchResponse>({
    queryKey: [auditUrl],
    queryFn: () => fetchJson<DropshipAuditEventSearchResponse>(auditUrl),
  });

  const overview = overviewQuery.data?.overview;

  function applyAuditFilters() {
    setAppliedAuditFilters({
      search: auditSearch,
      severity: auditSeverity,
    });
  }

  function refreshAll() {
    void overviewQuery.refetch();
    void auditQuery.refetch();
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b bg-card px-4 py-5 md:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-normal" data-testid="text-page-title">
              <ShieldAlert className="h-6 w-6 text-[#C060E0]" />
              Dropship Ops
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Monitor .ops setup blockers, store health, order intake exceptions, listing pushes, tracking pushes, returns, notifications, and audit history.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {overview && (
              <Badge variant="outline" className="h-9 px-3">
                Updated {formatDateTime(overview.generatedAt)}
              </Badge>
            )}
            <Button
              variant="outline"
              className="h-9 gap-2"
              disabled={overviewQuery.isFetching || auditQuery.isFetching}
              onClick={refreshAll}
            >
              <RefreshCw className={overviewQuery.isFetching || auditQuery.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              Refresh
            </Button>
          </div>
        </div>

        {(overviewQuery.error || auditQuery.error) && (
          <Alert variant="destructive" className="mt-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {errorMessage(overviewQuery.error ?? auditQuery.error)}
            </AlertDescription>
          </Alert>
        )}
      </div>

      <div className="flex-1 overflow-auto p-4 md:p-6">
        <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mb-5 h-auto w-full justify-start rounded-none border-b bg-transparent p-0">
            <TabsTrigger
              value="overview"
              className="rounded-none border-b-2 border-transparent px-4 py-2 data-[state=active]:border-[#C060E0] data-[state=active]:bg-transparent"
            >
              Overview
            </TabsTrigger>
            <TabsTrigger
              value="audit"
              className="rounded-none border-b-2 border-transparent px-4 py-2 data-[state=active]:border-[#C060E0] data-[state=active]:bg-transparent"
            >
              Audit events
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="m-0 space-y-5">
            {overviewQuery.isLoading ? (
              <OverviewSkeleton />
            ) : overview ? (
              <OverviewTab overview={overview} />
            ) : (
              <EmptyState title="No ops data" description="The dropship ops overview did not return any data." />
            )}
          </TabsContent>

          <TabsContent value="audit" className="m-0 space-y-4">
            <div className="rounded-md border bg-card p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                <div className="min-w-0 flex-1">
                  <label className="text-sm font-medium" htmlFor="dropship-audit-search">
                    Search
                  </label>
                  <div className="mt-2 flex items-center gap-2">
                    <div className="relative min-w-0 flex-1">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="dropship-audit-search"
                        value={auditSearch}
                        onChange={(event) => setAuditSearch(event.target.value)}
                        className="pl-9"
                        placeholder="Event type, entity, or actor"
                      />
                    </div>
                  </div>
                </div>
                <div className="w-full lg:w-48">
                  <label className="text-sm font-medium">Severity</label>
                  <Select value={auditSeverity} onValueChange={(value) => setAuditSeverity(value as AuditSeverityFilter)}>
                    <SelectTrigger className="mt-2">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All severities</SelectItem>
                      <SelectItem value="info">Info</SelectItem>
                      <SelectItem value="warning">Warning</SelectItem>
                      <SelectItem value="error">Error</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button className="h-10 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]" onClick={applyAuditFilters}>
                  <FileSearch className="h-4 w-4" />
                  Apply
                </Button>
              </div>
            </div>

            <AuditEventsTable
              events={auditQuery.data?.items ?? []}
              isLoading={auditQuery.isLoading || auditQuery.isFetching}
              total={auditQuery.data?.total ?? 0}
            />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function OverviewTab({ overview }: { overview: DropshipAdminOpsOverview }) {
  return (
    <>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          icon={<Store className="h-4 w-4" />}
          label="Store connections needing attention"
          value={String(riskCount(overview.riskBuckets, "store_connections_attention"))}
        />
        <MetricTile
          icon={<Wallet className="h-4 w-4" />}
          label="Payment holds"
          value={String(riskCount(overview.riskBuckets, "payment_holds"))}
        />
        <MetricTile
          icon={<Truck className="h-4 w-4" />}
          label="Tracking push failures"
          value={String(riskCount(overview.riskBuckets, "tracking_push_failures"))}
        />
        <MetricTile
          icon={<Bell className="h-4 w-4" />}
          label="Notification failures"
          value={String(riskCount(overview.riskBuckets, "notification_delivery_failures"))}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_0.9fr]">
        <section className="rounded-md border bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Risk buckets</h2>
              <p className="text-sm text-muted-foreground">Launch-critical blockers and exceptions</p>
            </div>
            <Badge variant="outline">
              {overview.riskBuckets.reduce((sum, bucket) => sum + bucket.count, 0)} open
            </Badge>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {overview.riskBuckets.map((bucket) => (
              <RiskBucketCard key={bucket.key} bucket={bucket} />
            ))}
          </div>
        </section>

        <section className="rounded-md border bg-card p-4">
          <div>
            <h2 className="text-lg font-semibold">Status counts</h2>
            <p className="text-sm text-muted-foreground">Current state by dropship subsystem</p>
          </div>
          <div className="mt-4 grid gap-3">
            <StatusCountGroup title="Vendors" counts={overview.vendorStatusCounts} icon={<ShieldAlert className="h-4 w-4" />} />
            <StatusCountGroup title="Store connections" counts={overview.storeConnectionStatusCounts} icon={<Store className="h-4 w-4" />} />
            <StatusCountGroup title="Order intake" counts={overview.orderIntakeStatusCounts} icon={<ClipboardList className="h-4 w-4" />} />
            <StatusCountGroup title="Listing push jobs" counts={overview.listingPushJobStatusCounts} icon={<RefreshCw className="h-4 w-4" />} />
            <StatusCountGroup title="Tracking pushes" counts={overview.trackingPushStatusCounts} icon={<Truck className="h-4 w-4" />} />
            <StatusCountGroup title="Returns" counts={overview.rmaStatusCounts} icon={<RotateCcw className="h-4 w-4" />} />
            <StatusCountGroup title="Notifications" counts={overview.notificationStatusCounts} icon={<Bell className="h-4 w-4" />} />
          </div>
        </section>
      </div>

      <section className="rounded-md border bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Recent audit events</h2>
            <p className="text-sm text-muted-foreground">Latest dropship operational trail</p>
          </div>
          <History className="h-5 w-5 text-muted-foreground" />
        </div>
        <AuditEventsTable events={overview.recentAuditEvents} isLoading={false} total={overview.recentAuditEvents.length} compact />
      </section>
    </>
  );
}

function MetricTile({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-md border bg-card p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-3 text-2xl font-bold">{value}</div>
    </div>
  );
}

function RiskBucketCard({ bucket }: { bucket: DropshipOpsRiskBucket }) {
  return (
    <div className="rounded-md border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">{bucket.label}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{formatStatus(bucket.severity)} severity</p>
        </div>
        <Badge variant="outline" className={riskSeverityTone(bucket.severity)}>
          {bucket.count}
        </Badge>
      </div>
    </div>
  );
}

function StatusCountGroup({
  counts,
  icon,
  title,
}: {
  counts: DropshipOpsCount[];
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
      </div>
      {counts.length === 0 ? (
        <div className="text-sm text-muted-foreground">No rows</div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {counts.map((count) => (
            <Badge key={count.key} variant="outline" className="gap-2">
              {formatStatus(count.key)}
              <span className="font-mono">{count.count}</span>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function AuditEventsTable({
  compact = false,
  events,
  isLoading,
  total,
}: {
  compact?: boolean;
  events: DropshipAuditEventRecord[];
  isLoading: boolean;
  total: number;
}) {
  if (isLoading) {
    return (
      <div className="mt-4 space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (events.length === 0) {
    return <EmptyState title="No audit events" description="No matching dropship audit events were found." />;
  }

  return (
    <div className="mt-4 rounded-md border">
      <div className="flex items-center justify-between border-b px-3 py-2 text-sm text-muted-foreground">
        <span>{total} event{total === 1 ? "" : "s"}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[145px]">Time</TableHead>
            <TableHead>Event</TableHead>
            <TableHead>Vendor</TableHead>
            {!compact && <TableHead>Entity</TableHead>}
            <TableHead>Severity</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event) => (
            <TableRow key={event.auditEventId}>
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                {formatDateTime(event.createdAt)}
              </TableCell>
              <TableCell>
                <div className="font-medium">{formatStatus(event.eventType)}</div>
                <div className="text-xs text-muted-foreground">{event.actorType}{event.actorId ? `: ${event.actorId}` : ""}</div>
              </TableCell>
              <TableCell>
                <div className="font-medium">{event.vendorBusinessName || event.vendorEmail || "System"}</div>
                {event.storeDisplayName && <div className="text-xs text-muted-foreground">{event.storeDisplayName}</div>}
              </TableCell>
              {!compact && (
                <TableCell>
                  <div className="font-medium">{formatStatus(event.entityType)}</div>
                  <div className="max-w-[220px] truncate text-xs text-muted-foreground">{event.entityId || "None"}</div>
                </TableCell>
              )}
              <TableCell>
                <Badge variant="outline" className={riskSeverityTone(event.severity)}>
                  {formatStatus(event.severity)}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function EmptyState({ description, title }: { description: string; title: string }) {
  return (
    <Empty className="mt-4 rounded-md border border-dashed">
      <EmptyMedia variant="icon">
        <FileSearch />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 w-full" />
        ))}
      </div>
      <div className="grid gap-5 xl:grid-cols-[1fr_0.9fr]">
        <Skeleton className="h-96 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    </div>
  );
}

function riskCount(buckets: DropshipOpsRiskBucket[], key: string): number {
  return countByKey(
    buckets.map((bucket) => ({ key: bucket.key, count: bucket.count })),
    key,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Dropship ops request failed.";
}
