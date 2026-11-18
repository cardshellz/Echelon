import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  CircleDollarSign,
  ClipboardList,
  FileSearch,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Search,
  Truck,
  Wallet,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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
  allDropshipOrderCancellationStatuses,
  buildAdminOrderIntakeUrl,
  buildAdminOrderOpsActionInput,
  createDropshipIdempotencyKey,
  fetchJson,
  formatCents,
  formatDateTime,
  formatStatus,
  orderCancellationRetryEligibility,
  orderIntakeRetryEligibility,
  postJson,
  queryErrorMessage,
  riskSeverityTone,
  type DropshipAdminOrderOpsActionResponse,
  type DropshipAdminOrderOpsCancellationRetryResponse,
  type DropshipAdminOrderOpsIntakeListItem,
  type DropshipAdminOrderOpsListResponse,
  type DropshipAdminOrderOpsProcessResponse,
  type DropshipAdminOrderOpsWmsSyncResponse,
  type DropshipOpsOrderIntakeStatus,
  type DropshipOrderCancellationStatus,
  type DropshipOrderDetail,
  type DropshipOrderDetailResponse,
} from "@/lib/dropship-ops-surface";
import {
  CatalogMetric,
  trackingPushStatusTone,
  type DropshipOpsSearchSignal,
} from "./dropship-admin-shared";

type OrderOpsStatusFilter = DropshipOpsOrderIntakeStatus | "default" | "all";

type OrderOpsCancellationStatusFilter = DropshipOrderCancellationStatus | "all";

type OrderIntakeAdminAction =
  "retry" | "exception" | "process" | "retry-cancellation" | "retry-wms-sync";

const orderOpsStatusFilters: OrderOpsStatusFilter[] = [
  "default",
  "all",
  "payment_hold",
  "retrying",
  "failed",
  "exception",
  "rejected",
  "cancelled",
  "received",
  "processing",
  "accepted",
];

const orderOpsCancellationStatusFilters: OrderOpsCancellationStatusFilter[] = [
  "all",
  ...allDropshipOrderCancellationStatuses,
];

function OrderIntakeOpsTab({
  searchSignal,
}: {
  searchSignal: DropshipOpsSearchSignal | null;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<OrderOpsStatusFilter>("default");
  const [cancellationStatus, setCancellationStatus] =
    useState<OrderOpsCancellationStatusFilter>("all");
  const [appliedFilters, setAppliedFilters] = useState({
    search: "",
    status: "default" as OrderOpsStatusFilter,
    cancellationStatus: "all" as OrderOpsCancellationStatusFilter,
  });
  const [actionReason, setActionReason] = useState("");
  const [pendingAction, setPendingAction] = useState<{
    intakeId: number;
    action: OrderIntakeAdminAction;
  } | null>(null);
  const [selectedIntakeId, setSelectedIntakeId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const orderIntakeUrl = useMemo(
    () =>
      buildAdminOrderIntakeUrl({
        search: appliedFilters.search,
        status: appliedFilters.status,
        cancellationStatus: appliedFilters.cancellationStatus,
      }),
    [appliedFilters],
  );

  const orderIntakeQuery = useQuery<DropshipAdminOrderOpsListResponse>({
    queryKey: [orderIntakeUrl],
    queryFn: () => fetchJson<DropshipAdminOrderOpsListResponse>(orderIntakeUrl),
  });
  const orderDetailQuery = useQuery<DropshipOrderDetailResponse>({
    queryKey: ["dropship-admin-order-detail", selectedIntakeId],
    queryFn: () => {
      if (selectedIntakeId === null)
        throw new Error("Missing selected intake.");
      return fetchJson<DropshipOrderDetailResponse>(
        `/api/dropship/admin/order-intake/${selectedIntakeId}`,
      );
    },
    enabled: selectedIntakeId !== null,
  });
  const orderIntakes = orderIntakeQuery.data?.items ?? [];
  const orderRetryEligibilityNow = useMemo(
    () => new Date(),
    [orderIntakeQuery.dataUpdatedAt],
  );

  useEffect(() => {
    if (!searchSignal) return;
    setSearch(searchSignal.search);
    setStatus("all");
    setCancellationStatus("all");
    setAppliedFilters({
      search: searchSignal.search,
      status: "all",
      cancellationStatus: "all",
    });
  }, [searchSignal]);

  function applyOrderFilters() {
    setAppliedFilters({ search, status, cancellationStatus });
  }

  async function runOrderAction(
    intake: DropshipAdminOrderOpsIntakeListItem,
    action: OrderIntakeAdminAction,
  ) {
    setPendingAction({ intakeId: intake.intakeId, action });
    setError("");
    setMessage("");
    try {
      const input = buildAdminOrderOpsActionInput({
        idempotencyKey: createDropshipIdempotencyKey(
          `admin-order-${action}-${intake.intakeId}`,
        ),
        reason: actionReason,
        requireReason: action === "exception",
      });
      const response = await postJson<
        | DropshipAdminOrderOpsActionResponse
        | DropshipAdminOrderOpsCancellationRetryResponse
        | DropshipAdminOrderOpsProcessResponse
        | DropshipAdminOrderOpsWmsSyncResponse
      >(`/api/dropship/admin/order-intake/${intake.intakeId}/${action}`, input);
      setMessage(orderActionMessage(response, action));
      setActionReason("");
      await Promise.all([
        orderIntakeQuery.refetch(),
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
        caught instanceof Error
          ? caught.message
          : "Dropship order intake action failed.",
      );
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="space-y-5">
      {(orderIntakeQuery.error || error) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error ||
              queryErrorMessage(
                orderIntakeQuery.error,
                "Unable to load dropship order intake exceptions.",
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
            <h2 className="text-lg font-semibold">Order intake exceptions</h2>
            <p className="text-sm text-muted-foreground">
              Review marketplace intake rows, retry recoverable failures, and
              mark unresolved rows as ops exceptions.
            </p>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap">
            <div className="relative min-w-0 lg:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="Order, vendor, store, or customer"
              />
            </div>
            <Select
              value={status}
              onValueChange={(value) =>
                setStatus(value as OrderOpsStatusFilter)
              }
            >
              <SelectTrigger className="lg:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {orderOpsStatusFilters.map((option) => (
                  <SelectItem key={option} value={option}>
                    {orderOpsStatusLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={cancellationStatus}
              onValueChange={(value) =>
                setCancellationStatus(value as OrderOpsCancellationStatusFilter)
              }
            >
              <SelectTrigger className="lg:w-60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {orderOpsCancellationStatusFilters.map((option) => (
                  <SelectItem key={option} value={option}>
                    {orderOpsCancellationStatusLabel(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
              onClick={applyOrderFilters}
            >
              <FileSearch className="h-4 w-4" />
              Apply
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_0.45fr]">
          <div>
            <label
              className="text-sm font-medium"
              htmlFor="dropship-order-ops-reason"
            >
              Action reason
            </label>
            <Input
              id="dropship-order-ops-reason"
              className="mt-2"
              value={actionReason}
              onChange={(event) => setActionReason(event.target.value)}
              placeholder="Required for exception; optional for retry"
              maxLength={1000}
            />
          </div>
          <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            Actions are idempotent and audited. Process runs quote, wallet,
            reservation, and OMS creation now; retry queues failed rows;
            exception marks manual resolution.
          </div>
        </div>
      </section>

      <OrderIntakeSummary
        cancellationSummary={orderIntakeQuery.data?.cancellationSummary ?? []}
        summary={orderIntakeQuery.data?.summary ?? []}
        total={orderIntakeQuery.data?.total ?? 0}
      />

      <OrderIntakeOpsTable
        isLoading={orderIntakeQuery.isLoading || orderIntakeQuery.isFetching}
        items={orderIntakes}
        selectedIntakeId={selectedIntakeId}
        pendingAction={pendingAction}
        retryEligibilityNow={orderRetryEligibilityNow}
        total={orderIntakeQuery.data?.total ?? 0}
        onSelectDetail={(intake) => setSelectedIntakeId(intake.intakeId)}
        onRunAction={runOrderAction}
      />
      <OrderIntakeDetailPanel
        error={orderDetailQuery.error}
        isLoading={orderDetailQuery.isLoading || orderDetailQuery.isFetching}
        onClose={() => setSelectedIntakeId(null)}
        order={orderDetailQuery.data?.order ?? null}
        selectedIntakeId={selectedIntakeId}
      />
    </div>
  );
}

function OrderIntakeSummary({
  cancellationSummary,
  summary,
  total,
}: {
  cancellationSummary: DropshipAdminOrderOpsListResponse["cancellationSummary"];
  summary: DropshipAdminOrderOpsListResponse["summary"];
  total: number;
}) {
  return (
    <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
      <CatalogMetric
        icon={<ClipboardList className="h-4 w-4" />}
        label="Matching intakes"
        value={String(total)}
      />
      <CatalogMetric
        icon={<Wallet className="h-4 w-4" />}
        label="Payment holds"
        value={String(orderStatusCount(summary, "payment_hold"))}
      />
      <CatalogMetric
        icon={<RefreshCw className="h-4 w-4" />}
        label="Retrying"
        value={String(orderStatusCount(summary, "retrying"))}
      />
      <CatalogMetric
        icon={<AlertCircle className="h-4 w-4" />}
        label="Failed or exception"
        value={String(
          orderStatusCount(summary, "failed") +
            orderStatusCount(summary, "exception"),
        )}
      />
      <CatalogMetric
        icon={<RotateCcw className="h-4 w-4" />}
        label="Cancel failures"
        value={String(
          orderCancellationStatusCount(
            cancellationSummary,
            "marketplace_cancellation_failed",
          ),
        )}
      />
    </section>
  );
}

function OrderIntakeOpsTable({
  isLoading,
  items,
  onSelectDetail,
  onRunAction,
  pendingAction,
  retryEligibilityNow,
  selectedIntakeId,
  total,
}: {
  isLoading: boolean;
  items: DropshipAdminOrderOpsIntakeListItem[];
  onSelectDetail: (intake: DropshipAdminOrderOpsIntakeListItem) => void;
  onRunAction: (
    intake: DropshipAdminOrderOpsIntakeListItem,
    action: OrderIntakeAdminAction,
  ) => void;
  pendingAction: { intakeId: number; action: OrderIntakeAdminAction } | null;
  retryEligibilityNow: Date;
  selectedIntakeId: number | null;
  total: number;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <Empty className="rounded-md border border-dashed p-8">
        <EmptyMedia variant="icon">
          <ClipboardList />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>No order intake rows</EmptyTitle>
          <EmptyDescription>
            No dropship order intake rows match the current filters.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <section className="rounded-md border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3 text-sm text-muted-foreground">
        <span>
          {total} intake row{total === 1 ? "" : "s"}
        </span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Order</TableHead>
            <TableHead>Vendor / store</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Ship to</TableHead>
            <TableHead>Latest audit</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead className="w-[360px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((intake) => {
            const retryEligibility = orderIntakeRetryEligibility(
              intake,
              retryEligibilityNow,
            );
            const cancellationRetryEligibility =
              orderCancellationRetryEligibility(intake);
            const retryLabel =
              retryEligibility.reason === "stale_processing"
                ? "Recover"
                : "Retry";
            const canRetryWmsSync = orderIntakeCanRetryWmsSync(intake);
            return (
              <TableRow key={intake.intakeId}>
                <TableCell>
                  <div className="font-medium">
                    {intake.externalOrderNumber || intake.externalOrderId}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatStatus(intake.platform)} intake {intake.intakeId}
                  </div>
                  {intake.omsOrderId && (
                    <div className="text-xs text-muted-foreground">
                      OMS {intake.omsOrderId}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="font-medium">
                    {intake.vendor.businessName ||
                      intake.vendor.email ||
                      `Vendor ${intake.vendor.vendorId}`}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {intake.storeConnection.externalDisplayName ||
                      intake.storeConnection.shopDomain ||
                      formatStatus(intake.storeConnection.platform)}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={orderIntakeStatusTone(intake.status)}
                  >
                    {formatStatus(intake.status)}
                  </Badge>
                  {intake.rejectionReason && (
                    <div className="mt-1 max-w-[220px] truncate text-xs text-muted-foreground">
                      {intake.rejectionReason}
                    </div>
                  )}
                  {intake.paymentHoldExpiresAt && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      Hold expires {formatDateTime(intake.paymentHoldExpiresAt)}
                    </div>
                  )}
                  {intake.cancellationStatus && (
                    <div className="mt-1 max-w-[220px] truncate text-xs text-muted-foreground">
                      Cancel {formatStatus(intake.cancellationStatus)}
                    </div>
                  )}
                </TableCell>
                <TableCell>{orderShipToLabel(intake)}</TableCell>
                <TableCell>
                  {intake.latestAuditEvent ? (
                    <>
                      <div className="font-medium">
                        {formatStatus(intake.latestAuditEvent.eventType)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatDateTime(intake.latestAuditEvent.createdAt)}
                      </div>
                    </>
                  ) : (
                    <span className="text-sm text-muted-foreground">None</span>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                  {formatDateTime(intake.updatedAt)}
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                    <Button
                      type="button"
                      variant={
                        selectedIntakeId === intake.intakeId
                          ? "default"
                          : "outline"
                      }
                      size="sm"
                      className={
                        selectedIntakeId === intake.intakeId
                          ? "h-8 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
                          : "h-8 gap-2"
                      }
                      disabled={pendingAction !== null}
                      onClick={() => onSelectDetail(intake)}
                    >
                      <FileSearch className="h-4 w-4" />
                      Detail
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 gap-2"
                      disabled={
                        pendingAction !== null ||
                        !orderIntakeCanProcessNow(intake.status)
                      }
                      onClick={() => onRunAction(intake, "process")}
                    >
                      <PlayCircle
                        className={
                          pendingAction?.intakeId === intake.intakeId &&
                          pendingAction.action === "process"
                            ? "h-4 w-4 animate-spin"
                            : "h-4 w-4"
                        }
                      />
                      Process
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 gap-2"
                      disabled={
                        pendingAction !== null || !retryEligibility.canRetry
                      }
                      onClick={() => onRunAction(intake, "retry")}
                    >
                      <RefreshCw
                        className={
                          pendingAction?.intakeId === intake.intakeId &&
                          pendingAction.action === "retry"
                            ? "h-4 w-4 animate-spin"
                            : "h-4 w-4"
                        }
                      />
                      {retryLabel}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 gap-2"
                      disabled={
                        pendingAction !== null ||
                        !cancellationRetryEligibility.canRetry
                      }
                      onClick={() => onRunAction(intake, "retry-cancellation")}
                    >
                      <RotateCcw
                        className={
                          pendingAction?.intakeId === intake.intakeId &&
                          pendingAction.action === "retry-cancellation"
                            ? "h-4 w-4 animate-spin"
                            : "h-4 w-4"
                        }
                      />
                      Retry cancel
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 gap-2"
                      disabled={pendingAction !== null || !canRetryWmsSync}
                      onClick={() => onRunAction(intake, "retry-wms-sync")}
                    >
                      <Truck
                        className={
                          pendingAction?.intakeId === intake.intakeId &&
                          pendingAction.action === "retry-wms-sync"
                            ? "h-4 w-4 animate-spin"
                            : "h-4 w-4"
                        }
                      />
                      Sync WMS
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 gap-2"
                      disabled={pendingAction !== null}
                      onClick={() => onRunAction(intake, "exception")}
                    >
                      <AlertCircle className="h-4 w-4" />
                      Exception
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

function OrderIntakeDetailPanel({
  error,
  isLoading,
  onClose,
  order,
  selectedIntakeId,
}: {
  error: unknown;
  isLoading: boolean;
  onClose: () => void;
  order: DropshipOrderDetail | null;
  selectedIntakeId: number | null;
}) {
  if (selectedIntakeId === null) return null;

  if (isLoading) {
    return (
      <section className="rounded-md border bg-card p-4">
        <Skeleton className="h-7 w-64" />
        <div className="mt-4 grid gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-20 w-full" />
          ))}
        </div>
        <Skeleton className="mt-4 h-40 w-full" />
      </section>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          {queryErrorMessage(error, "Unable to load dropship order detail.")}
        </AlertDescription>
      </Alert>
    );
  }

  if (!order) return null;

  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-3 border-b pb-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">
              {order.externalOrderNumber || order.externalOrderId}
            </h2>
            <Badge
              variant="outline"
              className={orderIntakeStatusTone(
                order.status as DropshipOpsOrderIntakeStatus,
              )}
            >
              {formatStatus(order.status)}
            </Badge>
            {order.cancellationStatus && (
              <Badge
                variant="outline"
                className="border-amber-200 bg-amber-50 text-amber-900"
              >
                {formatStatus(order.cancellationStatus)}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatStatus(order.platform)} intake {order.intakeId} /{" "}
            {order.vendor.businessName ||
              order.vendor.email ||
              `Vendor ${order.vendor.vendorId}`}{" "}
            /{" "}
            {order.storeConnection.externalDisplayName ||
              order.storeConnection.shopDomain ||
              `Store ${order.storeConnection.storeConnectionId}`}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <CatalogMetric
          icon={<ClipboardList className="h-4 w-4" />}
          label="Lines / units"
          value={`${order.lineCount} / ${order.totalQuantity}`}
        />
        <CatalogMetric
          icon={<CircleDollarSign className="h-4 w-4" />}
          label="Grand total"
          value={formatOptionalCents(order.totals?.grandTotalCents)}
        />
        <CatalogMetric
          icon={<Truck className="h-4 w-4" />}
          label="Tracking pushes"
          value={String(order.trackingPushes.length)}
        />
        <CatalogMetric
          icon={<Wallet className="h-4 w-4" />}
          label="Wallet debit"
          value={formatOptionalCents(order.walletLedgerEntry?.amountCents)}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-md border">
          <div className="border-b px-4 py-3">
            <h3 className="font-semibold">Order lines</h3>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Line</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {order.lines.map((line) => (
                <TableRow
                  key={`${line.lineIndex}:${line.externalLineItemId ?? line.sku ?? "line"}`}
                >
                  <TableCell>
                    <div className="font-medium">
                      {line.title || `Line ${line.lineIndex + 1}`}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {line.productVariantId
                        ? `Variant ${line.productVariantId}`
                        : "Variant not linked"}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="font-mono text-sm">
                      {line.sku || "None"}
                    </div>
                    <div className="max-w-[180px] truncate text-xs text-muted-foreground">
                      {line.externalListingId ||
                        line.externalOfferId ||
                        line.externalLineItemId ||
                        "No marketplace line id"}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {line.quantity}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatOptionalCents(line.unitRetailPriceCents)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatOptionalCents(line.lineRetailTotalCents)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="space-y-4">
          <div className="rounded-md border p-4">
            <h3 className="font-semibold">Money and quote</h3>
            <div className="mt-3 grid gap-2 text-sm">
              <DetailMoneyRow
                label="Retail subtotal"
                value={order.totals?.retailSubtotalCents}
              />
              <DetailMoneyRow
                label="Marketplace shipping"
                value={order.totals?.shippingPaidCents}
              />
              <DetailMoneyRow
                label="Wholesale subtotal"
                value={order.economicsSnapshot?.wholesaleSubtotalCents}
              />
              <DetailMoneyRow
                label="Shipping charged"
                value={
                  order.economicsSnapshot?.shippingCents ??
                  order.shippingQuoteSnapshot?.totalShippingCents
                }
              />
              <DetailMoneyRow
                label="Insurance pool"
                value={
                  order.economicsSnapshot?.insurancePoolCents ??
                  order.shippingQuoteSnapshot?.insurancePoolCents
                }
              />
              <DetailMoneyRow
                label="Fees"
                value={order.economicsSnapshot?.feesCents}
              />
              <DetailMoneyRow
                label="Total debit"
                value={
                  order.economicsSnapshot?.totalDebitCents ??
                  order.walletLedgerEntry?.amountCents
                }
              />
            </div>
            <div className="mt-3 text-xs text-muted-foreground">
              {order.shippingQuoteSnapshot
                ? `Quote ${order.shippingQuoteSnapshot.quoteSnapshotId} / warehouse ${order.shippingQuoteSnapshot.warehouseId} / ${order.shippingQuoteSnapshot.packageCount} package(s)`
                : "No shipping quote snapshot"}
            </div>
          </div>

          <div className="rounded-md border p-4">
            <h3 className="font-semibold">State</h3>
            <div className="mt-3 grid gap-2 text-sm text-muted-foreground">
              <div>
                OMS order:{" "}
                <span className="font-mono text-foreground">
                  {order.omsOrderId ?? "None"}
                </span>
              </div>
              <div>
                Received:{" "}
                <span className="text-foreground">
                  {formatDateTime(order.receivedAt)}
                </span>
              </div>
              <div>
                Accepted:{" "}
                <span className="text-foreground">
                  {formatDateTime(order.acceptedAt)}
                </span>
              </div>
              <div>
                Payment hold:{" "}
                <span className="text-foreground">
                  {formatDateTime(order.paymentHoldExpiresAt)}
                </span>
              </div>
              {order.rejectionReason && (
                <div className="text-rose-700">
                  Rejection: {order.rejectionReason}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <div className="rounded-md border">
          <div className="border-b px-4 py-3">
            <h3 className="font-semibold">Tracking pushes</h3>
          </div>
          {order.trackingPushes.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No tracking pushes recorded.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tracking</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Shipment</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.trackingPushes.map((push) => (
                  <TableRow key={push.pushId}>
                    <TableCell>
                      <div className="font-mono text-sm">
                        {push.trackingNumber}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {push.carrier} / {formatStatus(push.platform)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={trackingPushStatusTone(push.status)}
                      >
                        {formatStatus(push.status)}
                      </Badge>
                      {push.lastErrorMessage && (
                        <div className="mt-1 max-w-[220px] truncate text-xs text-muted-foreground">
                          {push.lastErrorMessage}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="font-mono text-sm">
                        {push.wmsShipmentId ?? "None"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {push.externalFulfillmentId ||
                          "No marketplace fulfillment"}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(push.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        <div className="rounded-md border">
          <div className="border-b px-4 py-3">
            <h3 className="font-semibold">Audit trail</h3>
          </div>
          {order.auditEvents.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No audit events recorded.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Payload</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.auditEvents.slice(0, 8).map((event, index) => (
                  <TableRow
                    key={`${event.eventType}:${event.createdAt}:${index}`}
                  >
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={riskSeverityTone(event.severity)}
                      >
                        {formatStatus(event.eventType)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">
                        {formatStatus(event.actorType)}
                      </div>
                      <div className="max-w-[160px] truncate text-xs text-muted-foreground">
                        {event.actorId || "System"}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[260px] truncate text-xs text-muted-foreground">
                      {compactJsonPayload(event.payload)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(event.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </section>
  );
}

function DetailMoneyRow({
  label,
  value,
}: {
  label: string;
  value: number | null | undefined;
}) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{formatOptionalCents(value)}</span>
    </div>
  );
}

function formatOptionalCents(value: number | null | undefined): string {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? formatCents(value)
    : "None";
}

function compactJsonPayload(payload: Record<string, unknown>): string {
  const text = JSON.stringify(payload);
  if (!text || text === "{}") return "{}";
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function orderOpsStatusLabel(status: OrderOpsStatusFilter): string {
  if (status === "default") return "Needs attention";
  if (status === "all") return "All statuses";
  return formatStatus(status);
}

function orderOpsCancellationStatusLabel(
  status: OrderOpsCancellationStatusFilter,
): string {
  if (status === "all") return "All cancellation states";
  return formatStatus(status);
}

function orderActionMessage(
  response:
    | DropshipAdminOrderOpsActionResponse
    | DropshipAdminOrderOpsCancellationRetryResponse
    | DropshipAdminOrderOpsProcessResponse
    | DropshipAdminOrderOpsWmsSyncResponse,
  action: OrderIntakeAdminAction,
): string {
  if (action === "retry-wms-sync" && "retryQueued" in response) {
    if (response.outcome === "synced") {
      const wmsOrderLabel = response.wmsOrderId
        ? ` WMS order ${response.wmsOrderId}`
        : " WMS";
      return `Order intake ${response.intakeId} synced to${wmsOrderLabel}.`;
    }
    const suffix = response.failureMessage
      ? `: ${response.failureMessage}`
      : ".";
    return `Order intake ${response.intakeId} WMS sync retry queued${suffix}`;
  }
  if (action === "process" && "failureCode" in response) {
    const suffix = response.failureCode
      ? ` (${formatStatus(response.failureCode)})`
      : "";
    return `Order intake ${response.intakeId} processing returned ${formatStatus(response.outcome)}${suffix}.`;
  }
  if (action === "retry-cancellation" && "cancellationStatus" in response) {
    return `Order intake ${response.intakeId} marketplace cancellation moved from ${formatStatus(response.previousCancellationStatus || "none")} to ${formatStatus(response.cancellationStatus || "none")}.`;
  }
  if ("previousStatus" in response) {
    return `Order intake ${response.intakeId} moved from ${formatStatus(response.previousStatus)} to ${formatStatus(response.status)}.`;
  }
  return `Order intake ${response.intakeId} action completed.`;
}

function orderIntakeCanProcessNow(
  status: DropshipOpsOrderIntakeStatus,
): boolean {
  return (
    status === "received" || status === "retrying" || status === "payment_hold"
  );
}

function orderIntakeCanRetryWmsSync(
  intake: DropshipAdminOrderOpsIntakeListItem,
): boolean {
  return intake.status === "accepted" && intake.omsOrderId !== null;
}

function orderStatusCount(
  summary: DropshipAdminOrderOpsListResponse["summary"],
  status: DropshipOpsOrderIntakeStatus,
): number {
  return summary.find((entry) => entry.status === status)?.count ?? 0;
}

function orderCancellationStatusCount(
  summary: DropshipAdminOrderOpsListResponse["cancellationSummary"],
  status: DropshipOrderCancellationStatus,
): number {
  return (
    summary.find((entry) => entry.cancellationStatus === status)?.count ?? 0
  );
}

function orderShipToLabel(intake: DropshipAdminOrderOpsIntakeListItem): string {
  const shipTo = intake.shipTo;
  if (!shipTo) return "None";
  const locality = [shipTo.city, shipTo.region, shipTo.postalCode]
    .filter(Boolean)
    .join(", ");
  return locality || shipTo.country || shipTo.name || "Available";
}

function orderIntakeStatusTone(status: DropshipOpsOrderIntakeStatus): string {
  if (status === "accepted" || status === "processing") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (
    status === "payment_hold" ||
    status === "retrying" ||
    status === "received"
  ) {
    return "border-amber-200 bg-amber-50 text-amber-900";
  }
  if (
    status === "failed" ||
    status === "exception" ||
    status === "rejected" ||
    status === "cancelled"
  ) {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}

export {
  orderOpsStatusFilters,
  orderOpsCancellationStatusFilters,
  OrderIntakeOpsTab,
  OrderIntakeSummary,
  OrderIntakeOpsTable,
  OrderIntakeDetailPanel,
  DetailMoneyRow,
  formatOptionalCents,
  compactJsonPayload,
  orderOpsStatusLabel,
  orderOpsCancellationStatusLabel,
  orderActionMessage,
  orderIntakeCanProcessNow,
  orderIntakeCanRetryWmsSync,
  orderStatusCount,
  orderCancellationStatusCount,
  orderShipToLabel,
  orderIntakeStatusTone,
  type OrderOpsStatusFilter,
  type OrderOpsCancellationStatusFilter,
  type OrderIntakeAdminAction,
};
export default OrderIntakeOpsTab;
