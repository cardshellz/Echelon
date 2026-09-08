import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { z } from "zod";
import {
  formatPipelineMills,
  purchasePipelineSchema,
  supplierProgressCommandSchema,
  supplierProgressHistorySchema,
  supplierProgressSchema,
  type PurchasePipeline,
  type PurchasePipelineRow,
  type SupplierProgressCommand,
} from "@shared/procurement/purchase-pipeline";
import { useAuth } from "@/lib/auth";
import { purchaseWorkspaceInspectHref } from "@/lib/purchase-workspace-selection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Factory,
  PackageCheck,
  RefreshCw,
  Search,
  Ship,
  Truck,
  CircleHelp,
  ClipboardCheck,
  AlertTriangle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  filterPipelinePurchases,
  formatPipelineCurrency,
  formatPipelinePieces,
  groupPipelinePurchases,
  summarizePipelineCosts,
  type PipelineMoneySummary,
  type PipelinePurchaseGroup,
} from "./purchase-pipeline-presentation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

const stages = [
  {
    key: "supplier_unconfirmed",
    label: "Awaiting update",
    icon: CircleHelp,
    color: "text-slate-500",
    accent: "border-t-slate-400",
  },
  {
    key: "in_production",
    label: "In production",
    icon: Factory,
    color: "text-violet-600 dark:text-violet-400",
    accent: "border-t-violet-500",
  },
  {
    key: "ready_to_ship",
    label: "Ready to ship",
    icon: PackageCheck,
    color: "text-indigo-600 dark:text-indigo-400",
    accent: "border-t-indigo-500",
  },
  {
    key: "in_transit",
    label: "In transit",
    icon: Ship,
    color: "text-blue-600 dark:text-blue-400",
    accent: "border-t-blue-500",
  },
  {
    key: "port_customs",
    label: "Port / customs",
    icon: Truck,
    color: "text-cyan-700 dark:text-cyan-400",
    accent: "border-t-cyan-500",
  },
  {
    key: "awaiting_receipt",
    label: "Awaiting receipt",
    icon: ClipboardCheck,
    color: "text-emerald-700 dark:text-emerald-400",
    accent: "border-t-emerald-500",
  },
  {
    key: "review",
    label: "Quantity review",
    icon: AlertTriangle,
    color: "text-amber-700 dark:text-amber-400",
    accent: "border-t-amber-500",
  },
] as const;
const labels = Object.fromEntries(
  stages.map((stage) => [stage.key, stage.label]),
) as Record<PurchasePipelineRow["stage"], string>;
const PURCHASES_PER_PAGE = 8;

function calendarDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function snapshotLabel(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(value));
}

async function load(url: string): Promise<unknown> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error("Purchase evidence could not be loaded.");
  return response.json();
}

function SupplierProgressDialog({
  row,
  snapshotTime,
  onClose,
  canEdit,
}: {
  row: PurchasePipelineRow;
  snapshotTime: string;
  onClose: () => void;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const [started, setStarted] = useState(
    String(row.progress.report?.startedPieces ?? ""),
  );
  const [completed, setCompleted] = useState(
    String(row.progress.report?.completedPieces ?? ""),
  );
  const [asOf, setAsOf] = useState(
    new Date(row.progress.report?.asOf ?? snapshotTime)
      .toISOString()
      .slice(0, 16),
  );
  const [reference, setReference] = useState(
    row.progress.report?.reference ?? "",
  );
  const [notes, setNotes] = useState(row.progress.report?.notes ?? "");
  const [validation, setValidation] = useState<string | null>(null);
  const pendingCommand = useRef<SupplierProgressCommand | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const history = useQuery({
    queryKey: ["supplier-progress", row.purchaseOrderLineId],
    queryFn: async () =>
      supplierProgressHistorySchema.parse(
        await load(
          `/api/purchasing/pipeline/lines/${row.purchaseOrderLineId}/progress`,
        ),
      ),
  });
  const save = useMutation({
    mutationFn: async (command: SupplierProgressCommand) => {
      const response = await fetch(
        `/api/purchasing/pipeline/lines/${row.purchaseOrderLineId}/progress`,
        {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
        },
      );
      const body: unknown = await response.json();
      if (!response.ok) {
        // A classified 4xx is a known rejection. Unknown server/network outcomes
        // keep the exact intent locked for a safe same-key retry.
        if (response.status >= 400 && response.status < 500)
          pendingCommand.current = null;
        if (
          typeof body === "object" &&
          body !== null &&
          "code" in body &&
          body.code === "SUPPLIER_PROGRESS_CHANGED"
        )
          setConflicted(true);
        throw new Error(
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof body.error === "string"
            ? body.error
            : "Supplier progress could not be saved.",
        );
      }
      return supplierProgressSchema.extend({ reused: z.boolean() }).parse(body);
    },
    onSuccess: () => {
      pendingCommand.current = null;
      setUncertain(false);
      queryClient.invalidateQueries({ queryKey: ["purchase-pipeline"] });
      queryClient.invalidateQueries({
        queryKey: ["supplier-progress", row.purchaseOrderLineId],
      });
      onClose();
    },
    onError: () => setUncertain(pendingCommand.current !== null),
  });
  const submit = () => {
    const timestamp = new Date(`${asOf}:00.000Z`);
    const command = {
      expectedRevision: row.progress.revision,
      idempotencyKey: crypto.randomUUID(),
      report: {
        startedPieces: /^\d+$/.test(started) ? Number(started) : Number.NaN,
        completedPieces: /^\d+$/.test(completed)
          ? Number(completed)
          : Number.NaN,
        asOf: Number.isFinite(timestamp.getTime())
          ? timestamp.toISOString()
          : "",
        reference,
        notes,
      },
    };
    const parsed = supplierProgressCommandSchema.safeParse(command);
    if (
      !parsed.success ||
      parsed.data.report.startedPieces > row.orderedPieces - row.cancelledPieces
    ) {
      setValidation(
        parsed.success
          ? "Started pieces exceed the net ordered quantity."
          : parsed.error.issues.map((issue) => issue.message).join(" "),
      );
      return;
    }
    setValidation(null);
    pendingCommand.current = parsed.data;
    save.mutate(parsed.data);
  };
  const locked = save.isPending || uncertain || !canEdit;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending && !uncertain) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            Supplier progress · {row.sku ?? row.purchaseOrderLineId}
          </DialogTitle>
          <DialogDescription>
            Record cumulative base pieces from supplier evidence. Completed is
            part of started. This does not receive inventory or approve payment.
            Revision {row.progress.revision}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            Started pieces
            <Input
              aria-label="Started pieces"
              inputMode="numeric"
              value={started}
              onChange={(event) => setStarted(event.target.value)}
              disabled={locked}
            />
          </label>
          <label className="text-sm">
            Completed pieces
            <Input
              aria-label="Completed pieces"
              inputMode="numeric"
              value={completed}
              onChange={(event) => setCompleted(event.target.value)}
              disabled={locked}
            />
          </label>
          <label className="text-sm sm:col-span-2">
            Supplier report as of (UTC)
            <Input
              aria-label="Supplier report as of (UTC)"
              type="datetime-local"
              value={asOf}
              onChange={(event) => setAsOf(event.target.value)}
              disabled={locked}
            />
          </label>
          <label className="text-sm sm:col-span-2">
            Evidence reference
            <Input
              aria-label="Evidence reference"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              disabled={locked}
              placeholder="Email date, production report or supplier reference"
            />
          </label>
          <label className="text-sm sm:col-span-2">
            Notes / correction reason
            <textarea
              aria-label="Notes / correction reason"
              className="mt-1 w-full rounded border bg-background p-2"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              disabled={locked}
            />
          </label>
        </div>
        {(validation || save.error) && (
          <p role="alert" className="text-sm text-destructive">
            {validation ?? save.error?.message}
          </p>
        )}
        {conflicted && (
          <Button
            variant="outline"
            onClick={() => {
              queryClient.invalidateQueries({
                queryKey: ["purchase-pipeline"],
              });
              onClose();
            }}
          >
            Reload current report
          </Button>
        )}
        {canEdit &&
          (uncertain ? (
            <div className="space-y-2">
              <p className="text-sm">
                The result is uncertain. Retry the saved request before changing
                the report.
              </p>
              <Button
                disabled={save.isPending}
                onClick={() =>
                  pendingCommand.current && save.mutate(pendingCommand.current)
                }
              >
                Retry saved progress
              </Button>
            </div>
          ) : (
            <Button disabled={save.isPending} onClick={submit}>
              {save.isPending ? "Saving…" : "Save supplier progress"}
            </Button>
          ))}
        <details className="text-sm">
          <summary className="cursor-pointer">Preserved report history</summary>
          {history.isPending && <p>Loading history…</p>}
          {history.error && (
            <p role="alert">
              History could not be loaded.{" "}
              <Button variant="link" onClick={() => history.refetch()}>
                Retry
              </Button>
            </p>
          )}
          {history.data?.changes.map((change) => (
            <div key={change.revision} className="mt-2 border-t pt-2 text-xs">
              <p>
                Revision {change.revision} · {change.after.reference}
              </p>
              <p>
                {change.after.startedPieces} started /{" "}
                {change.after.completedPieces} completed · as of{" "}
                {change.after.asOf}
              </p>
              <p>
                {change.recordedBy} · {change.recordedAt}
              </p>
              {change.after.notes && <p>{change.after.notes}</p>}
            </div>
          ))}
          {history.data?.changes.length === 0 && (
            <p>No report has been recorded.</p>
          )}
        </details>
      </DialogContent>
    </Dialog>
  );
}

function CostSummary({
  costs,
  compact = false,
}: {
  costs: PipelineMoneySummary[];
  compact?: boolean;
}) {
  if (costs.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No remaining purchase costs
      </p>
    );
  return (
    <div className="space-y-1.5">
      {costs.map((cost) => {
        const known = cost.confirmedComponents + cost.estimatedComponents > 0;
        return (
          <div key={cost.currency ?? "unknown"}>
            <p
              className={
                compact
                  ? "break-all text-sm font-semibold tabular-nums"
                  : "break-all text-xl font-semibold tracking-tight tabular-nums"
              }
            >
              {known
                ? formatPipelineCurrency(cost.knownMills, cost.currency)
                : "Cost not available"}
              {cost.currency && (
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  {cost.currency}
                </span>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {cost.missingComponents > 0
                ? "Incomplete cost"
                : "Known components"}
              {cost.estimatedComponents > 0
                ? " · includes estimates"
                : known
                  ? " · recorded"
                  : " · needs review"}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function PurchaseArrival({ rows }: { rows: PurchasePipelineRow[] }) {
  const scheduled = rows.filter(
    (row) => row.arrivalDate !== null && row.arrivalBucket !== "arrived",
  );
  const next = [...scheduled].sort((a, b) =>
    a.arrivalDate!.localeCompare(b.arrivalDate!),
  )[0];
  const delivered = rows.some((row) => row.arrivalBucket === "arrived");
  const missing = rows.some((row) => row.arrivalBucket === "unknown");
  return (
    <div className="space-y-1 text-sm">
      {next ? (
        <>
          <p
            className={`font-medium ${next.arrivalBucket === "overdue" ? "text-amber-700 dark:text-amber-400" : ""}`}
          >
            {calendarDate(next.arrivalDate!)}
            {next.arrivalBucket === "overdue" && " · past due"}
          </p>
          <p className="text-xs text-muted-foreground">
            {next.arrivalDestination === "warehouse"
              ? "Expected at warehouse"
              : next.arrivalDestination === "shipment_destination"
                ? "Shipment destination ETA"
                : "Expected arrival"}
          </p>
        </>
      ) : (
        <p className="font-medium">
          {delivered
            ? missing
              ? "Part delivered · dates missing"
              : "Delivered · receipt pending"
            : "ETA needs confirmation"}
        </p>
      )}
      {missing && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Remaining arrival dates need confirmation
        </p>
      )}
      {delivered && next && (
        <p className="text-xs text-muted-foreground">
          Part delivered · receipt pending
        </p>
      )}
    </div>
  );
}

function PipelineLineDetails({
  row,
  snapshotTime,
  canEdit,
  onProgress,
}: {
  row: PurchasePipelineRow;
  snapshotTime: string;
  canEdit: boolean;
  onProgress: () => void;
}) {
  return (
    <article
      data-pipeline-row={row.key}
      className="grid min-w-0 gap-4 rounded-md border bg-background p-4 lg:grid-cols-2"
    >
      <div className="min-w-0 space-y-2">
        <p className="break-words text-sm font-semibold">
          {row.sku ?? "Product line"} · {row.productName}
        </p>
        <p className="text-sm">
          {row.quantityPieces === null
            ? "Quantity needs review"
            : `${row.quantityPieces.toLocaleString()} pieces`}{" "}
          · {labels[row.stage]}
        </p>
        <p className="text-xs text-muted-foreground">
          {row.vendorName} ·{" "}
          <Link
            className="text-primary underline"
            href={`/purchase-orders/${row.purchaseOrderId}?tab=lifecycle`}
          >
            {row.poNumber}
          </Link>
          {row.shipmentId !== null && (
            <>
              {" "}
              ·{" "}
              <Link
                className="text-primary underline"
                href={purchaseWorkspaceInspectHref(
                  `/purchase-orders/${row.purchaseOrderId}`,
                  "",
                  { kind: "shipment", id: row.shipmentId },
                )}
              >
                {row.shipmentNumber}
              </Link>
            </>
          )}
        </p>
        <p className="text-xs">
          {row.arrivalDate
            ? `${row.arrivalBucket === "overdue" ? "Past due · " : ""}${calendarDate(row.arrivalDate)} · ${row.arrivalSource?.replaceAll("_", " ")}`
            : "Arrival date not recorded"}
          {row.arrivalDestination === "shipment_destination" &&
            " · shipment destination; warehouse arrival not confirmed"}
        </p>
        {row.progress.report && (
          <p className="text-xs text-muted-foreground">
            Supplier reported {calendarDate(row.progress.report.asOf)} ·{" "}
            {row.progress.report.reference} ·{" "}
            {Math.max(
              0,
              Math.floor(
                (Date.parse(snapshotTime) -
                  Date.parse(row.progress.report.asOf)) /
                  86_400_000,
              ),
            )}{" "}
            days ago
          </p>
        )}
        <Button size="sm" variant="outline" onClick={onProgress}>
          {canEdit ? "Record supplier progress" : "Supplier report history"}
        </Button>
      </div>
      <div className="min-w-0 space-y-2 text-xs">
        {row.costs.map((cost) => (
          <div key={cost.component}>
            <p className="font-medium">
              <span className="capitalize">
                {cost.component === "landed"
                  ? "Freight / landed"
                  : cost.component}
              </span>
              :{" "}
              {cost.amountMills === null
                ? "Not recorded"
                : formatPipelineMills(cost.amountMills, row.currency)}
            </p>
            <p className="text-muted-foreground">
              {cost.evidence === "unknown"
                ? "Awaiting cost evidence"
                : cost.evidence.replaceAll("_", " ")}
              {cost.sourceRevisionId !== null && (
                <>
                  {" "}
                  ·{" "}
                  <Link
                    className="text-primary underline"
                    href={purchaseWorkspaceInspectHref(
                      `/purchase-orders/${row.purchaseOrderId}`,
                      "",
                      { kind: "purchase", id: row.purchaseOrderId },
                    )}
                  >
                    Source #{cost.sourceRevisionId}
                  </Link>
                </>
              )}
              {cost.recordedAt &&
                ` · recorded ${calendarDate(cost.recordedAt)}`}
            </p>
          </div>
        ))}
        {row.issues.length > 0 && (
          <details className="pt-1">
            <summary className="cursor-pointer font-medium text-amber-700 dark:text-amber-400">
              Review notes ({row.issues.length})
            </summary>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-muted-foreground">
              {row.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </article>
  );
}

function PipelinePurchase({
  purchase,
  expanded,
  onToggle,
  data,
  canEdit,
  onProgress,
}: {
  purchase: PipelinePurchaseGroup;
  expanded: boolean;
  onToggle: () => void;
  data: PurchasePipeline;
  canEdit: boolean;
  onProgress: (row: PurchasePipelineRow) => void;
}) {
  const detailId = `pipeline-purchase-${purchase.id}-details`;
  const shipments = new Set(
    purchase.rows.flatMap((row) =>
      row.shipmentId === null ? [] : [row.shipmentId],
    ),
  );
  const quantityLabel = purchase.rows.every(
    (row) => row.quantityPieces === null,
  )
    ? "Quantity needs review"
    : purchase.unknownQuantity
      ? `${formatPipelinePieces(purchase.knownPieces)} known pieces · additional quantity needs review`
      : `${formatPipelinePieces(purchase.knownPieces)} pieces outstanding`;
  return (
    <article
      data-purchase-order={purchase.id}
      className="border-t first:border-t-0"
    >
      <div className="grid min-w-0 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-center">
        <div className="min-w-0 space-y-1">
          <Link
            href={`/purchase-orders/${purchase.id}?tab=lifecycle`}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
          >
            {purchase.poNumber}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
          <p className="break-words text-sm font-medium">
            {purchase.vendorName}
          </p>
          <p className="text-xs text-muted-foreground">
            {purchase.lineCount}{" "}
            {purchase.lineCount === 1 ? "product line" : "product lines"}
            {shipments.size > 0 &&
              ` · ${shipments.size} ${shipments.size === 1 ? "shipment" : "shipments"}`}
          </p>
        </div>
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1">
            {purchase.stages.map((stage) => (
              <Badge
                key={stage}
                variant="secondary"
                className="text-[11px] font-medium"
              >
                {labels[stage]}
              </Badge>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{quantityLabel}</p>
        </div>
        <PurchaseArrival rows={purchase.rows} />
        <CostSummary costs={purchase.costs} compact />
        <Button
          variant="ghost"
          size="sm"
          className="justify-self-start lg:justify-self-end"
          aria-label={`${expanded ? "Hide" : "Show"} details for ${purchase.poNumber}`}
          aria-controls={detailId}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? "Hide" : "Details"}
          {expanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </Button>
      </div>
      {expanded && (
        <div id={detailId} className="space-y-3 border-t bg-muted/30 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              All outstanding quantities for this purchase. Split shipments
              remain together.
            </p>
            <Link
              className="text-sm font-medium text-primary hover:underline"
              href={`/purchase-orders/${purchase.id}?tab=lifecycle`}
            >
              Open purchase lifecycle →
            </Link>
          </div>
          {purchase.rows.map((row) => (
            <PipelineLineDetails
              key={row.key}
              row={row}
              snapshotTime={data.asOf}
              canEdit={canEdit}
              onProgress={() => onProgress(row)}
            />
          ))}
        </div>
      )}
    </article>
  );
}

export function PurchasePipelineView({
  data,
  horizonDays,
  onHorizonChange,
  canEdit,
  onRefresh,
  isRefreshing = false,
}: {
  data: PurchasePipeline;
  horizonDays: 30 | 90;
  onHorizonChange: (days: 30 | 90) => void;
  canEdit: boolean;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}) {
  const [bucket, setBucket] = useState<
    "all" | PurchasePipelineRow["arrivalBucket"]
  >("all");
  const [stageFilter, setStageFilter] = useState<
    "all" | PurchasePipelineRow["stage"]
  >("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [selected, setSelected] = useState<PurchasePipelineRow | null>(null);
  const purchases = useMemo(
    () => groupPipelinePurchases(data.rows),
    [data.rows],
  );
  const costs = useMemo(() => summarizePipelineCosts(data.rows), [data.rows]);
  const filtered = useMemo(
    () =>
      filterPipelinePurchases(purchases, {
        bucket,
        stage: stageFilter,
        search,
      }),
    [purchases, bucket, stageFilter, search],
  );
  const pageCount = Math.max(
    1,
    Math.ceil(filtered.length / PURCHASES_PER_PAGE),
  );
  const pageIndex = Math.min(page, pageCount - 1);
  const visible = filtered.slice(
    pageIndex * PURCHASES_PER_PAGE,
    (pageIndex + 1) * PURCHASES_PER_PAGE,
  );
  const incompleteOrders = purchases.filter((purchase) =>
    purchase.costs.some((cost) => cost.missingComponents > 0),
  ).length;
  const filters: Array<{
    value: "all" | PurchasePipelineRow["arrivalBucket"];
    label: string;
  }> = [
    { value: "all", label: "All purchases" },
    { value: "within_horizon", label: `Next ${horizonDays} days` },
    { value: "overdue", label: "Overdue" },
    { value: "unknown", label: "No ETA" },
    { value: "later", label: "Later" },
    { value: "arrived", label: "Delivered" },
  ];
  return (
    <section
      aria-labelledby="purchase-pipeline-title"
      data-testid="purchase-pipeline"
      className="min-w-0 space-y-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="purchase-pipeline-title"
            className="text-lg font-semibold tracking-tight"
          >
            Open purchases
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {purchases.length} purchase{" "}
            {purchases.length === 1 ? "order" : "orders"} with quantities still
            to receive · all warehouses
          </p>
        </div>
        <div className="flex items-center gap-2">
          <time dateTime={data.asOf} className="text-xs text-muted-foreground">
            Updated {snapshotLabel(data.asOf)}
          </time>
          {onRefresh && (
            <Button
              size="icon"
              variant="outline"
              aria-label="Refresh pipeline"
              disabled={isRefreshing}
              onClick={onRefresh}
            >
              <RefreshCw
                className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
              />
            </Button>
          )}
        </div>
      </div>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_290px]">
        <div
          className="grid grid-cols-2 gap-2 sm:grid-cols-4"
          aria-label="Purchase stages"
        >
          {stages.map((stage) => {
            const count = purchases.filter((purchase) =>
              purchase.stages.includes(stage.key),
            ).length;
            const Icon = stage.icon;
            return (
              <button
                key={stage.key}
                type="button"
                aria-label={`Filter purchases: ${stage.label}`}
                aria-describedby={`pipeline-stage-${stage.key}-count`}
                aria-pressed={stageFilter === stage.key}
                onClick={() => {
                  setStageFilter(stageFilter === stage.key ? "all" : stage.key);
                  setPage(0);
                }}
                className={`rounded-lg border border-t-2 bg-card p-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${stage.accent} ${stageFilter === stage.key ? "ring-2 ring-primary" : ""}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    id={`pipeline-stage-${stage.key}-count`}
                    className="text-lg font-semibold tabular-nums"
                  >
                    {count}
                    <span className="sr-only"> purchases</span>
                  </span>
                  <Icon
                    className={`h-4 w-4 ${stage.color}`}
                    aria-hidden="true"
                  />
                </div>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {stage.label}
                </span>
              </button>
            );
          })}
          <div className="flex items-center rounded-lg border border-dashed p-3 text-xs leading-relaxed text-muted-foreground">
            An order can span several stages. Production uses the latest
            supplier update.
          </div>
        </div>
        <div className="space-y-2 rounded-lg border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground">
            Known costs before receipt
          </p>
          <CostSummary costs={costs} />
          {incompleteOrders > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {incompleteOrders}{" "}
              {incompleteOrders === 1 ? "purchase needs" : "purchases need"}{" "}
              cost review. Full value is not yet available.
            </p>
          )}
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium">
              Cost breakdown
            </summary>
            <div className="mt-2 space-y-2">
              {costs.map((cost) => (
                <p key={cost.currency ?? "unknown"} className="break-words">
                  {cost.currency ?? "Currency unknown"}:{" "}
                  {cost.confirmedComponents > 0
                    ? `recorded ${formatPipelineCurrency(cost.confirmedMills, cost.currency)}`
                    : "no recorded components"}
                  ;{" "}
                  {cost.estimatedComponents > 0
                    ? `estimated ${formatPipelineCurrency(cost.estimatedMills, cost.currency)}`
                    : "no estimated components"}
                  .
                </p>
              ))}
              <p>
                Only known product, packaging and allocated freight costs for
                outstanding quantities are included. Missing costs, taxes and
                unallocated fees are excluded. Currencies stay separate.
              </p>
            </div>
          </details>
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="space-y-3 border-b p-3 sm:p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="relative min-w-0 flex-1 sm:max-w-sm">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                aria-label="Search purchases"
                placeholder="Search PO, supplier, SKU or shipment"
                className="pl-9"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(0);
                }}
              />
            </div>
            <label className="whitespace-nowrap text-xs text-muted-foreground">
              Arrival horizon
              <select
                aria-label="Arrival horizon"
                className="ml-2 rounded-md border bg-background p-2 text-sm text-foreground"
                value={horizonDays}
                onChange={(event) => {
                  onHorizonChange(event.target.value === "30" ? 30 : 90);
                  setPage(0);
                }}
              >
                <option value="30">30 days</option>
                <option value="90">90 days</option>
              </select>
            </label>
          </div>
          <div
            className="flex flex-wrap items-center gap-1.5"
            aria-label="Arrival filters"
          >
            {filters.map((filter) => (
              <Button
                key={filter.value}
                size="sm"
                variant={bucket === filter.value ? "default" : "ghost"}
                aria-pressed={bucket === filter.value}
                onClick={() => {
                  setBucket(filter.value);
                  setPage(0);
                }}
              >
                {filter.label} (
                {
                  filterPipelinePurchases(purchases, {
                    bucket: filter.value,
                    stage: stageFilter,
                    search,
                  }).length
                }
                )
              </Button>
            ))}
            {stageFilter !== "all" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setStageFilter("all");
                  setPage(0);
                }}
              >
                Clear stage filter
              </Button>
            )}
          </div>
        </div>
        <div
          className="hidden gap-4 border-b bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground lg:grid lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
          aria-hidden="true"
        >
          <span>Purchase / supplier</span>
          <span>Progress / quantity</span>
          <span>Next expected arrival</span>
          <span>Outstanding cost</span>
          <span className="w-20" />
        </div>
        <div>
          {visible.map((purchase) => (
            <PipelinePurchase
              key={purchase.id}
              purchase={purchase}
              expanded={expanded.has(purchase.id)}
              onToggle={() =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(purchase.id)) next.delete(purchase.id);
                  else next.add(purchase.id);
                  return next;
                })
              }
              data={data}
              canEdit={canEdit}
              onProgress={setSelected}
            />
          ))}
        </div>
        {visible.length === 0 && (
          <div className="space-y-1 p-8 text-center">
            <p className="text-sm font-medium">
              {purchases.length === 0
                ? "No purchases awaiting receipt"
                : "No purchases match these filters"}
            </p>
            <p className="text-xs text-muted-foreground">
              {purchases.length === 0
                ? "Drafts and RFQs are available in the buying review above."
                : "Try another supplier, arrival window or stage."}
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
          <p className="text-xs text-muted-foreground">
            {filtered.length === 0
              ? "0 purchases"
              : `${pageIndex * PURCHASES_PER_PAGE + 1}–${Math.min((pageIndex + 1) * PURCHASES_PER_PAGE, filtered.length)} of ${filtered.length} purchases`}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              aria-label="Previous page"
              disabled={pageIndex === 0}
              onClick={() => setPage(pageIndex - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-label="Next page"
              disabled={pageIndex + 1 >= pageCount}
              onClick={() => setPage(pageIndex + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </div>
      {data.issues.length > 0 && (
        <details className="rounded-md border border-amber-200 bg-amber-50/40 p-3 text-xs dark:bg-amber-950/20">
          <summary className="cursor-pointer font-medium text-amber-800 dark:text-amber-300">
            Additional records need review ({data.issues.length})
          </summary>
          {data.issues.map((issue) => (
            <p key={issue} className="mt-2 text-muted-foreground">
              {issue}
            </p>
          ))}
        </details>
      )}
      {selected && (
        <SupplierProgressDialog
          key={selected.purchaseOrderLineId}
          row={selected}
          snapshotTime={data.asOf}
          canEdit={canEdit}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

export function PurchasePipeline() {
  const [horizonDays, setHorizonDays] = useState<30 | 90>(90);
  const { hasPermission } = useAuth();
  const query = useQuery({
    queryKey: ["purchase-pipeline", horizonDays],
    queryFn: async () =>
      purchasePipelineSchema.parse(
        await load(`/api/purchasing/pipeline?horizonDays=${horizonDays}`),
      ),
  });
  if (!query.data)
    return (
      <section
        className="rounded-lg border bg-card p-5"
        aria-label="Purchase pipeline"
      >
        <h2 className="text-lg font-semibold">Open purchases</h2>
        {query.isPending ? (
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            Loading open purchases…
          </p>
        ) : (
          <div role="alert" className="mt-2 text-sm">
            <p>Purchase records could not be loaded.</p>
            <Button
              className="mt-3"
              variant="outline"
              onClick={() => query.refetch()}
            >
              Retry pipeline
            </Button>
          </div>
        )}
      </section>
    );
  return (
    <>
      {query.error && (
        <p
          role="alert"
          className="rounded-md border border-amber-200 p-3 text-sm text-amber-800 dark:text-amber-300"
        >
          Refresh failed. The prior snapshot remains displayed with its original
          time.
        </p>
      )}
      <PurchasePipelineView
        data={query.data}
        horizonDays={horizonDays}
        onHorizonChange={setHorizonDays}
        canEdit={hasPermission("purchasing", "edit")}
        onRefresh={() => void query.refetch()}
        isRefreshing={query.isFetching}
      />
    </>
  );
}
