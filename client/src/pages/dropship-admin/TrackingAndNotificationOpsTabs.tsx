import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Bell,
  CheckCircle2,
  FileSearch,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  Truck,
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
  buildAdminNotificationEventsUrl,
  buildAdminNotificationRetryInput,
  buildAdminTrackingPushesUrl,
  buildAdminTrackingPushRetryInput,
  createDropshipIdempotencyKey,
  fetchJson,
  formatDateTime,
  formatStatus,
  notificationRetryEligibility,
  postJson,
  queryErrorMessage,
  trackingPushRetryEligibility,
  type DropshipAdminNotificationOpsListItem,
  type DropshipAdminNotificationOpsListResponse,
  type DropshipAdminNotificationRetryResponse,
  type DropshipAdminTrackingPushListItem,
  type DropshipAdminTrackingPushListResponse,
  type DropshipAdminTrackingPushRetryResponse,
  type DropshipNotificationOpsChannel,
  type DropshipNotificationOpsStatus,
  type DropshipTrackingPushStatus,
} from "@/lib/dropship-ops-surface";
import {
  CatalogMetric,
  EmptyState,
  trackingPushStatusTone,
  type DropshipOpsSearchSignal,
  type StoreConnectionPlatformFilter,
} from "./dropship-admin-shared";

type TrackingPushStatusFilter = DropshipTrackingPushStatus | "default" | "all";

type NotificationOpsStatusFilter =
  DropshipNotificationOpsStatus | "default" | "all";

type NotificationOpsChannelFilter = DropshipNotificationOpsChannel | "all";

type NotificationOpsCriticalFilter = "all" | "critical" | "noncritical";

const trackingPushStatusFilters: TrackingPushStatusFilter[] = [
  "default",
  "all",
  "failed",
  "processing",
  "queued",
  "succeeded",
];

const notificationOpsStatusFilters: NotificationOpsStatusFilter[] = [
  "default",
  "all",
  "failed",
  "pending",
  "delivered",
];

const notificationOpsChannelFilters: NotificationOpsChannelFilter[] = [
  "all",
  "email",
  "in_app",
];

const notificationOpsCriticalFilters: NotificationOpsCriticalFilter[] = [
  "all",
  "critical",
  "noncritical",
];

function TrackingPushOpsTab({
  searchSignal,
}: {
  searchSignal: DropshipOpsSearchSignal | null;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<TrackingPushStatusFilter>("default");
  const [platform, setPlatform] =
    useState<StoreConnectionPlatformFilter>("all");
  const [appliedFilters, setAppliedFilters] = useState({
    search: "",
    status: "default" as TrackingPushStatusFilter,
    platform: "all" as StoreConnectionPlatformFilter,
  });
  const [retryReason, setRetryReason] = useState("");
  const [pendingRetryPushId, setPendingRetryPushId] = useState<number | null>(
    null,
  );
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const trackingPushesUrl = useMemo(
    () =>
      buildAdminTrackingPushesUrl({
        search: appliedFilters.search,
        status: appliedFilters.status,
        platform: appliedFilters.platform,
      }),
    [appliedFilters],
  );

  const trackingPushesQuery = useQuery<DropshipAdminTrackingPushListResponse>({
    queryKey: [trackingPushesUrl],
    queryFn: () =>
      fetchJson<DropshipAdminTrackingPushListResponse>(trackingPushesUrl),
  });

  const pushes = trackingPushesQuery.data?.items ?? [];
  const trackingPushRetryNow = useMemo(
    () => new Date(),
    [trackingPushesQuery.dataUpdatedAt],
  );
  const recoverablePushCount = pushes.filter(
    (push) => trackingPushRetryEligibility(push, trackingPushRetryNow).canRetry,
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

  function applyTrackingPushFilters() {
    setAppliedFilters({ search, status, platform });
  }

  async function retryTrackingPush(push: DropshipAdminTrackingPushListItem) {
    setPendingRetryPushId(push.pushId);
    setError("");
    setMessage("");
    try {
      const input = buildAdminTrackingPushRetryInput({
        idempotencyKey: createDropshipIdempotencyKey(
          `admin-tracking-retry-${push.pushId}`,
        ),
        reason: retryReason,
      });
      const response = await postJson<DropshipAdminTrackingPushRetryResponse>(
        `/api/dropship/admin/tracking-pushes/${push.pushId}/retry`,
        input,
      );
      setMessage(
        `Tracking push ${response.pushId} retry returned ${formatStatus(response.status)}.`,
      );
      setRetryReason("");
      await Promise.all([
        trackingPushesQuery.refetch(),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/ops/overview"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/audit-events"],
        }),
      ]);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Dropship tracking push retry failed.",
      );
    } finally {
      setPendingRetryPushId(null);
    }
  }

  return (
    <div className="space-y-5">
      {(trackingPushesQuery.error || error) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error ||
              queryErrorMessage(
                trackingPushesQuery.error,
                "Unable to load dropship tracking pushes.",
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
            <h2 className="text-lg font-semibold">Tracking push operations</h2>
            <p className="text-sm text-muted-foreground">
              Review marketplace tracking notifications, fulfillment ids, failed
              pushes, and retry context.
            </p>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row">
            <div className="relative min-w-0 lg:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="Order, tracking, carrier, vendor, or error"
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
                setStatus(value as TrackingPushStatusFilter)
              }
            >
              <SelectTrigger className="lg:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {trackingPushStatusFilters.map((option) => (
                  <SelectItem key={option} value={option}>
                    {trackingPushStatusLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
              onClick={applyTrackingPushFilters}
            >
              <FileSearch className="h-4 w-4" />
              Apply
            </Button>
          </div>
        </div>
        <div className="mt-4 max-w-3xl">
          <label
            className="text-sm font-medium"
            htmlFor="dropship-tracking-retry-reason"
          >
            Retry reason
          </label>
          <Input
            id="dropship-tracking-retry-reason"
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
          icon={<Truck className="h-4 w-4" />}
          label="Matching pushes"
          value={String(trackingPushesQuery.data?.total ?? 0)}
        />
        <CatalogMetric
          icon={<AlertCircle className="h-4 w-4" />}
          label="Visible recoverable"
          value={String(recoverablePushCount)}
        />
        <CatalogMetric
          icon={<RefreshCw className="h-4 w-4" />}
          label="Visible attempts"
          value={String(
            pushes.reduce((sum, push) => sum + push.attemptCount, 0),
          )}
        />
        <CatalogMetric
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Visible succeeded"
          value={String(
            pushes.filter((push) => push.status === "succeeded").length,
          )}
        />
      </section>

      <TrackingPushesTable
        isLoading={
          trackingPushesQuery.isLoading || trackingPushesQuery.isFetching
        }
        onRetry={retryTrackingPush}
        pendingRetryPushId={pendingRetryPushId}
        pushes={pushes}
        retryEligibilityNow={trackingPushRetryNow}
        summary={trackingPushesQuery.data?.summary ?? []}
        total={trackingPushesQuery.data?.total ?? 0}
      />
    </div>
  );
}

function NotificationOpsTab() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<NotificationOpsStatusFilter>("default");
  const [channel, setChannel] = useState<NotificationOpsChannelFilter>("all");
  const [critical, setCritical] =
    useState<NotificationOpsCriticalFilter>("all");
  const [appliedFilters, setAppliedFilters] = useState({
    search: "",
    status: "default" as NotificationOpsStatusFilter,
    channel: "all" as NotificationOpsChannelFilter,
    critical: "all" as NotificationOpsCriticalFilter,
  });
  const [retryReason, setRetryReason] = useState("");
  const [pendingRetryEventId, setPendingRetryEventId] = useState<number | null>(
    null,
  );
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const notificationEventsUrl = useMemo(
    () =>
      buildAdminNotificationEventsUrl({
        search: appliedFilters.search,
        status: appliedFilters.status,
        channel: appliedFilters.channel,
        critical: appliedFilters.critical,
      }),
    [appliedFilters],
  );

  const notificationEventsQuery =
    useQuery<DropshipAdminNotificationOpsListResponse>({
      queryKey: [notificationEventsUrl],
      queryFn: () =>
        fetchJson<DropshipAdminNotificationOpsListResponse>(
          notificationEventsUrl,
        ),
    });

  const events = notificationEventsQuery.data?.items ?? [];
  const recoverableEventCount = events.filter(
    (event) => notificationRetryEligibility(event).canRetry,
  ).length;

  function applyNotificationFilters() {
    setAppliedFilters({ search, status, channel, critical });
  }

  async function retryNotificationEvent(
    event: DropshipAdminNotificationOpsListItem,
  ) {
    setPendingRetryEventId(event.notificationEventId);
    setError("");
    setMessage("");
    try {
      const input = buildAdminNotificationRetryInput({
        idempotencyKey: createDropshipIdempotencyKey(
          `admin-notification-retry-${event.notificationEventId}`,
        ),
        reason: retryReason,
      });
      const response = await postJson<DropshipAdminNotificationRetryResponse>(
        `/api/dropship/admin/notifications/${event.notificationEventId}/retry`,
        input,
      );
      setMessage(
        `Notification ${response.notificationEventId} retry returned ${formatStatus(response.status)}.`,
      );
      setRetryReason("");
      await Promise.all([
        notificationEventsQuery.refetch(),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/ops/overview"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/audit-events"],
        }),
      ]);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Dropship notification retry failed.",
      );
    } finally {
      setPendingRetryEventId(null);
    }
  }

  return (
    <div className="space-y-5">
      {(notificationEventsQuery.error || error) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error ||
              queryErrorMessage(
                notificationEventsQuery.error,
                "Unable to load dropship notification events.",
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
            <h2 className="text-lg font-semibold">Notification operations</h2>
            <p className="text-sm text-muted-foreground">
              Review vendor notification delivery, unread critical notices, and
              failed message events.
            </p>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row">
            <div className="relative min-w-0 lg:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="Event, title, vendor, email, or hash"
              />
            </div>
            <Select
              value={channel}
              onValueChange={(value) =>
                setChannel(value as NotificationOpsChannelFilter)
              }
            >
              <SelectTrigger className="lg:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {notificationOpsChannelFilters.map((option) => (
                  <SelectItem key={option} value={option}>
                    {notificationOpsChannelLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={critical}
              onValueChange={(value) =>
                setCritical(value as NotificationOpsCriticalFilter)
              }
            >
              <SelectTrigger className="lg:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {notificationOpsCriticalFilters.map((option) => (
                  <SelectItem key={option} value={option}>
                    {notificationOpsCriticalLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={status}
              onValueChange={(value) =>
                setStatus(value as NotificationOpsStatusFilter)
              }
            >
              <SelectTrigger className="lg:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {notificationOpsStatusFilters.map((option) => (
                  <SelectItem key={option} value={option}>
                    {notificationOpsStatusLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
              onClick={applyNotificationFilters}
            >
              <FileSearch className="h-4 w-4" />
              Apply
            </Button>
          </div>
        </div>
        <div className="mt-4">
          <label
            htmlFor="dropship-notification-retry-reason"
            className="text-sm font-medium"
          >
            Retry audit note
          </label>
          <Input
            id="dropship-notification-retry-reason"
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
          icon={<Bell className="h-4 w-4" />}
          label="Matching events"
          value={String(notificationEventsQuery.data?.total ?? 0)}
        />
        <CatalogMetric
          icon={<AlertCircle className="h-4 w-4" />}
          label="Visible recoverable"
          value={String(recoverableEventCount)}
        />
        <CatalogMetric
          icon={<RefreshCw className="h-4 w-4" />}
          label="Visible pending"
          value={String(
            events.filter((event) => event.status === "pending").length,
          )}
        />
        <CatalogMetric
          icon={<ShieldAlert className="h-4 w-4" />}
          label="Critical visible"
          value={String(events.filter((event) => event.critical).length)}
        />
      </section>

      <NotificationEventsTable
        channelSummary={notificationEventsQuery.data?.channelSummary ?? []}
        events={events}
        isLoading={
          notificationEventsQuery.isLoading ||
          notificationEventsQuery.isFetching
        }
        onRetry={retryNotificationEvent}
        pendingRetryEventId={pendingRetryEventId}
        summary={notificationEventsQuery.data?.summary ?? []}
        total={notificationEventsQuery.data?.total ?? 0}
      />
    </div>
  );
}

function TrackingPushesTable({
  isLoading,
  onRetry,
  pendingRetryPushId,
  pushes,
  retryEligibilityNow,
  summary,
  total,
}: {
  isLoading: boolean;
  onRetry: (push: DropshipAdminTrackingPushListItem) => void;
  pendingRetryPushId: number | null;
  pushes: DropshipAdminTrackingPushListItem[];
  retryEligibilityNow: Date;
  summary: DropshipAdminTrackingPushListResponse["summary"];
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

  if (pushes.length === 0) {
    return (
      <EmptyState
        title="No tracking pushes"
        description="No dropship tracking pushes match the current filters."
      />
    );
  }

  return (
    <section className="rounded-md border bg-card">
      <div className="flex flex-col gap-3 border-b px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Tracking pushes</h2>
          <p className="text-sm text-muted-foreground">
            {total} matching push{total === 1 ? "" : "es"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {summary.map((entry) => (
            <Badge
              key={entry.status}
              variant="outline"
              className={trackingPushStatusTone(entry.status)}
            >
              {formatStatus(entry.status)} {entry.count}
            </Badge>
          ))}
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[110px]">Push</TableHead>
            <TableHead>Order</TableHead>
            <TableHead>Vendor/store</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Tracking</TableHead>
            <TableHead>Latest issue</TableHead>
            <TableHead className="w-[145px]">Updated</TableHead>
            <TableHead className="w-[120px] text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pushes.map((push) => {
            const retryEligibility = trackingPushRetryEligibility(
              push,
              retryEligibilityNow,
            );
            const retryLabel =
              retryEligibility.reason === "stale_processing"
                ? "Recover"
                : "Retry";
            return (
              <TableRow key={push.pushId}>
                <TableCell>
                  <div className="font-mono text-sm">#{push.pushId}</div>
                  <div className="text-xs text-muted-foreground">
                    Try {push.attemptCount}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="font-medium">
                    {push.externalOrderNumber || push.externalOrderId}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {[
                      `OMS ${push.omsOrderId}`,
                      push.wmsShipmentId
                        ? `Shipment ${push.wmsShipmentId}`
                        : null,
                      `Intake ${push.intakeId}`,
                    ]
                      .filter(Boolean)
                      .join(" / ")}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="font-medium">
                    {push.vendor.businessName ||
                      push.vendor.email ||
                      `Vendor ${push.vendor.vendorId}`}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {[
                      push.storeConnection.externalDisplayName,
                      push.storeConnection.shopDomain,
                      formatStatus(push.platform),
                    ]
                      .filter(Boolean)
                      .join(" / ")}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={trackingPushStatusTone(push.status)}
                  >
                    {formatStatus(push.status)}
                  </Badge>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {push.completedAt
                      ? `Completed ${formatDateTime(push.completedAt)}`
                      : `Shipped ${formatDateTime(push.shippedAt)}`}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="font-medium">{push.carrier}</div>
                  <div className="max-w-[220px] truncate text-xs text-muted-foreground">
                    {push.trackingNumber}
                  </div>
                  {push.externalFulfillmentId && (
                    <div className="max-w-[220px] truncate text-xs text-muted-foreground">
                      Fulfillment {push.externalFulfillmentId}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  {push.lastErrorCode || push.lastErrorMessage ? (
                    <>
                      <div className="font-medium">
                        {push.lastErrorCode || "Tracking push failed"}
                      </div>
                      <div className="max-w-[320px] truncate text-xs text-muted-foreground">
                        {push.lastErrorMessage || "No error message recorded"}
                      </div>
                    </>
                  ) : (
                    <div className="text-sm text-muted-foreground">None</div>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatDateTime(push.updatedAt)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="gap-2"
                    disabled={
                      !retryEligibility.canRetry || pendingRetryPushId !== null
                    }
                    onClick={() => onRetry(push)}
                  >
                    <RotateCcw
                      className={
                        pendingRetryPushId === push.pushId
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

function NotificationEventsTable({
  channelSummary,
  events,
  isLoading,
  onRetry,
  pendingRetryEventId,
  summary,
  total,
}: {
  channelSummary: DropshipAdminNotificationOpsListResponse["channelSummary"];
  events: DropshipAdminNotificationOpsListItem[];
  isLoading: boolean;
  onRetry: (event: DropshipAdminNotificationOpsListItem) => void;
  pendingRetryEventId: number | null;
  summary: DropshipAdminNotificationOpsListResponse["summary"];
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

  if (events.length === 0) {
    return (
      <EmptyState
        title="No notification events"
        description="No dropship notification events match the current filters."
      />
    );
  }

  return (
    <section className="rounded-md border bg-card">
      <div className="flex flex-col gap-3 border-b px-4 py-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Notification events</h2>
          <p className="text-sm text-muted-foreground">
            {total} matching event{total === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {summary.map((entry) => (
            <Badge
              key={entry.status}
              variant="outline"
              className={notificationOpsStatusTone(entry.status)}
            >
              {formatStatus(entry.status)} {entry.count}
            </Badge>
          ))}
          {channelSummary.map((entry) => (
            <Badge
              key={entry.channel}
              variant="outline"
              className="border-zinc-200 bg-zinc-50 text-zinc-700"
            >
              {formatStatus(entry.channel)} {entry.count}
            </Badge>
          ))}
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[115px]">Event</TableHead>
            <TableHead>Vendor</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Channel</TableHead>
            <TableHead>Message</TableHead>
            <TableHead>Delivery</TableHead>
            <TableHead className="w-[145px]">Created</TableHead>
            <TableHead className="w-[120px] text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event) => {
            const retryEligibility = notificationRetryEligibility(event);
            return (
              <TableRow key={event.notificationEventId}>
                <TableCell>
                  <div className="font-mono text-sm">
                    #{event.notificationEventId}
                  </div>
                  <div className="max-w-[180px] truncate text-xs text-muted-foreground">
                    {formatStatus(event.eventType)}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="font-medium">
                    {event.vendor.businessName ||
                      event.vendor.email ||
                      `Vendor ${event.vendor.vendorId}`}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {[event.vendor.email, event.vendor.memberId]
                      .filter(Boolean)
                      .join(" / ") || formatStatus(event.vendor.status)}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={notificationOpsStatusTone(event.status)}
                  >
                    {formatStatus(event.status)}
                  </Badge>
                  {event.critical && (
                    <Badge
                      variant="outline"
                      className="ml-2 border-rose-200 bg-rose-50 text-rose-800"
                    >
                      Critical
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="font-medium">
                    {formatStatus(event.channel)}
                  </div>
                  <div className="max-w-[220px] truncate text-xs text-muted-foreground">
                    {event.requestHash ||
                      event.idempotencyKey ||
                      "No request hash"}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="max-w-[360px] truncate font-medium">
                    {event.title}
                  </div>
                  <div className="max-w-[360px] truncate text-xs text-muted-foreground">
                    {event.message || "No message body"}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="text-sm">
                    {event.deliveredAt
                      ? `Delivered ${formatDateTime(event.deliveredAt)}`
                      : "Not delivered"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {event.readAt
                      ? `Read ${formatDateTime(event.readAt)}`
                      : "Unread or not tracked"}
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatDateTime(event.createdAt)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="gap-2"
                    disabled={
                      !retryEligibility.canRetry || pendingRetryEventId !== null
                    }
                    onClick={() => onRetry(event)}
                  >
                    <RotateCcw
                      className={
                        pendingRetryEventId === event.notificationEventId
                          ? "h-4 w-4 animate-spin"
                          : "h-4 w-4"
                      }
                    />
                    Retry
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

function trackingPushStatusLabel(status: TrackingPushStatusFilter): string {
  if (status === "default") return "Needs attention";
  if (status === "all") return "All statuses";
  return formatStatus(status);
}

function notificationOpsStatusLabel(
  status: NotificationOpsStatusFilter,
): string {
  if (status === "default") return "Needs attention";
  if (status === "all") return "All statuses";
  return formatStatus(status);
}

function notificationOpsChannelLabel(
  channel: NotificationOpsChannelFilter,
): string {
  if (channel === "all") return "All channels";
  return formatStatus(channel);
}

function notificationOpsCriticalLabel(
  critical: NotificationOpsCriticalFilter,
): string {
  if (critical === "critical") return "Critical only";
  if (critical === "noncritical") return "Non-critical only";
  return "All criticality";
}

function notificationOpsStatusTone(
  status: DropshipNotificationOpsStatus,
): string {
  if (status === "delivered") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (status === "pending") {
    return "border-amber-200 bg-amber-50 text-amber-900";
  }
  if (status === "failed") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}

export {
  trackingPushStatusFilters,
  notificationOpsStatusFilters,
  notificationOpsChannelFilters,
  notificationOpsCriticalFilters,
  TrackingPushOpsTab,
  NotificationOpsTab,
  TrackingPushesTable,
  NotificationEventsTable,
  trackingPushStatusLabel,
  notificationOpsStatusLabel,
  notificationOpsChannelLabel,
  notificationOpsCriticalLabel,
  notificationOpsStatusTone,
  type TrackingPushStatusFilter,
  type NotificationOpsStatusFilter,
  type NotificationOpsChannelFilter,
  type NotificationOpsCriticalFilter,
};
