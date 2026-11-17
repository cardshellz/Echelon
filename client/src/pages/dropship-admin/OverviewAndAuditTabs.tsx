import type * as React from "react";
import type { ReactNode } from "react";
import {
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
  countByKey,
  formatDateTime,
  formatStatus,
  riskSeverityTone,
  type DropshipAdminOpsOverview,
  type DropshipAuditEventRecord,
  type DropshipOpsCount,
  type DropshipOpsRiskBucket,
} from "@/lib/dropship-ops-surface";
import { EmptyState, type AuditSeverityFilter } from "./dropship-admin-shared";

function OverviewTab({ overview }: { overview: DropshipAdminOpsOverview }) {
  return (
    <>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <MetricTile
          icon={<Store className="h-4 w-4" />}
          label="Store connections needing attention"
          value={String(
            riskCount(overview.riskBuckets, "store_connections_attention"),
          )}
        />
        <MetricTile
          icon={<Wallet className="h-4 w-4" />}
          label="Payment holds"
          value={String(riskCount(overview.riskBuckets, "payment_holds"))}
        />
        <MetricTile
          icon={<Truck className="h-4 w-4" />}
          label="Tracking push failures"
          value={String(
            riskCount(overview.riskBuckets, "tracking_push_failures"),
          )}
        />
        <MetricTile
          icon={<Bell className="h-4 w-4" />}
          label="Notification failures"
          value={String(
            riskCount(overview.riskBuckets, "notification_delivery_failures"),
          )}
        />
        <MetricTile
          icon={<RotateCcw className="h-4 w-4" />}
          label="Cancellation failures"
          value={String(
            riskCount(
              overview.riskBuckets,
              "marketplace_cancellation_failures",
            ),
          )}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_0.9fr]">
        <section className="rounded-md border bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Risk buckets</h2>
              <p className="text-sm text-muted-foreground">
                Launch-critical blockers and exceptions
              </p>
            </div>
            <Badge variant="outline">
              {overview.riskBuckets.reduce(
                (sum, bucket) => sum + bucket.count,
                0,
              )}{" "}
              open
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
            <p className="text-sm text-muted-foreground">
              Current state by dropship subsystem
            </p>
          </div>
          <div className="mt-4 grid gap-3">
            <StatusCountGroup
              title="Vendors"
              counts={overview.vendorStatusCounts}
              icon={<ShieldAlert className="h-4 w-4" />}
            />
            <StatusCountGroup
              title="Store connections"
              counts={overview.storeConnectionStatusCounts}
              icon={<Store className="h-4 w-4" />}
            />
            <StatusCountGroup
              title="Order intake"
              counts={overview.orderIntakeStatusCounts}
              icon={<ClipboardList className="h-4 w-4" />}
            />
            <StatusCountGroup
              title="Marketplace cancellations"
              counts={overview.orderCancellationStatusCounts}
              icon={<RotateCcw className="h-4 w-4" />}
            />
            <StatusCountGroup
              title="Listing push jobs"
              counts={overview.listingPushJobStatusCounts}
              icon={<RefreshCw className="h-4 w-4" />}
            />
            <StatusCountGroup
              title="Tracking pushes"
              counts={overview.trackingPushStatusCounts}
              icon={<Truck className="h-4 w-4" />}
            />
            <StatusCountGroup
              title="Returns"
              counts={overview.rmaStatusCounts}
              icon={<RotateCcw className="h-4 w-4" />}
            />
            <StatusCountGroup
              title="Notifications"
              counts={overview.notificationStatusCounts}
              icon={<Bell className="h-4 w-4" />}
            />
          </div>
        </section>
      </div>

      <section className="rounded-md border bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Recent audit events</h2>
            <p className="text-sm text-muted-foreground">
              Latest dropship operational trail
            </p>
          </div>
          <History className="h-5 w-5 text-muted-foreground" />
        </div>
        <AuditEventsTable
          events={overview.recentAuditEvents}
          isLoading={false}
          total={overview.recentAuditEvents.length}
          compact
        />
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
          <p className="mt-1 text-sm text-muted-foreground">
            {formatStatus(bucket.severity)} severity
          </p>
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
    return (
      <EmptyState
        title="No audit events"
        description="No matching dropship audit events were found."
      />
    );
  }

  return (
    <div className="mt-4 rounded-md border">
      <div className="flex items-center justify-between border-b px-3 py-2 text-sm text-muted-foreground">
        <span>
          {total} event{total === 1 ? "" : "s"}
        </span>
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
                <div className="font-medium">
                  {formatStatus(event.eventType)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {event.actorType}
                  {event.actorId ? `: ${event.actorId}` : ""}
                </div>
              </TableCell>
              <TableCell>
                <div className="font-medium">
                  {event.vendorBusinessName || event.vendorEmail || "System"}
                </div>
                {event.storeDisplayName && (
                  <div className="text-xs text-muted-foreground">
                    {event.storeDisplayName}
                  </div>
                )}
              </TableCell>
              {!compact && (
                <TableCell>
                  <div className="font-medium">
                    {formatStatus(event.entityType)}
                  </div>
                  <div className="max-w-[220px] truncate text-xs text-muted-foreground">
                    {event.entityId || "None"}
                  </div>
                </TableCell>
              )}
              <TableCell>
                <Badge
                  variant="outline"
                  className={riskSeverityTone(event.severity)}
                >
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

function riskCount(buckets: DropshipOpsRiskBucket[], key: string): number {
  return countByKey(
    buckets.map((bucket) => ({ key: bucket.key, count: bucket.count })),
    key,
  );
}

function AuditEventsTab({
  auditSearch,
  auditSeverity,
  events,
  isLoading,
  onApply,
  onSearchChange,
  onSeverityChange,
  total,
}: {
  auditSearch: string;
  auditSeverity: AuditSeverityFilter;
  events: DropshipAuditEventRecord[];
  isLoading: boolean;
  onApply: () => void;
  onSearchChange: (value: string) => void;
  onSeverityChange: (value: AuditSeverityFilter) => void;
  total: number;
}) {
  return (
    <>
      <div className="rounded-md border bg-card p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="min-w-0 flex-1">
            <label
              className="text-sm font-medium"
              htmlFor="dropship-audit-search"
            >
              Search
            </label>
            <div className="mt-2 flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="dropship-audit-search"
                  value={auditSearch}
                  onChange={(event) => onSearchChange(event.target.value)}
                  className="pl-9"
                  placeholder="Event type, entity, or actor"
                />
              </div>
            </div>
          </div>
          <div className="w-full lg:w-48">
            <label className="text-sm font-medium">Severity</label>
            <Select
              value={auditSeverity}
              onValueChange={(value) =>
                onSeverityChange(value as AuditSeverityFilter)
              }
            >
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
          <Button
            className="h-10 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
            onClick={onApply}
          >
            <FileSearch className="h-4 w-4" />
            Apply
          </Button>
        </div>
      </div>

      <AuditEventsTable
        events={events}
        isLoading={isLoading}
        total={total}
      />
    </>
  );
}

export {
  OverviewTab,
  MetricTile,
  RiskBucketCard,
  StatusCountGroup,
  AuditEventsTable,
  riskCount,
  AuditEventsTab,
};
