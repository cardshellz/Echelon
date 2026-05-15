import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle,
  ClipboardCheck,
  ClipboardList,
  Layers,
  PackagePlus,
  RefreshCcw,
  Scissors,
  ShieldAlert,
  ExternalLink,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  PickReplenHealthFilter,
  PickReplenHealthItem,
  PickReplenHealthResponse,
} from "./types";

interface PickReplenHealthSectionProps {
  warehouseId: number | null;
  searchQuery?: string;
}

type CleanupMode = "stale_no_demand" | "duplicates" | "queue_replen" | "queue_missing_replen" | "inline_execution";

type CleanupRequest = {
  mode: CleanupMode;
  taskId: number | null;
  variantId?: number | null;
  locationId?: number | null;
  warehouseId?: number | null;
};

type CleanupResult = {
  executedInline?: number;
  failedInline?: number;
  executedInlineTaskIds?: number[];
  failedInlineTaskIds?: number[];
  cancelledStaleNoDemand: number;
  cancelledStaleBacklog?: number;
  cancelledDuplicates: number;
  queuedReplen?: number;
  queuedTaskIds?: number[];
  skippedPickBins?: number;
};

const TYPE_CONFIG: Record<Exclude<PickReplenHealthFilter, "all">, {
  label: string;
  badge: string;
  icon: typeof AlertTriangle;
}> = {
  stuck_replen: {
    label: "Stuck Replen",
    badge: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
    icon: AlertTriangle,
  },
  replen_backlog: {
    label: "Replen Backlog",
    badge: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
    icon: PackagePlus,
  },
  stale_replen_no_demand: {
    label: "Stale Replen",
    badge: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-400",
    icon: RefreshCcw,
  },
  duplicate_replen: {
    label: "Duplicate Replen",
    badge: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    icon: Layers,
  },
  short_pick_unresolved: {
    label: "Short Pick",
    badge: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    icon: Scissors,
  },
  open_allocation_exception: {
    label: "Allocation Exception",
    badge: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    icon: ShieldAlert,
  },
  allocation_review_needed: {
    label: "Allocation Review",
    badge: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    icon: ShieldAlert,
  },
  cycle_count_review: {
    label: "Cycle Count",
    badge: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    icon: ClipboardCheck,
  },
  exception_order_no_blocker: {
    label: "Exception Order",
    badge: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-400",
    icon: RefreshCcw,
  },
  pick_bin_needs_replen: {
    label: "Needs Replen",
    badge: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
    icon: PackagePlus,
  },
  inventory_at_invalid_location: {
    label: "Invalid Inventory",
    badge: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    icon: ShieldAlert,
  },
  invalid_pick_assignment: {
    label: "Invalid Pick Face",
    badge: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    icon: ShieldAlert,
  },
};

const FILTERS: Array<{ value: PickReplenHealthFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "stuck_replen", label: "Stuck" },
  { value: "replen_backlog", label: "Backlog" },
  { value: "stale_replen_no_demand", label: "Stale" },
  { value: "duplicate_replen", label: "Duplicates" },
  { value: "short_pick_unresolved", label: "Short Picks" },
  { value: "open_allocation_exception", label: "Exceptions" },
  { value: "allocation_review_needed", label: "Reviews" },
  { value: "cycle_count_review", label: "Counts" },
  { value: "exception_order_no_blocker", label: "Order Status" },
  { value: "pick_bin_needs_replen", label: "Pick Bins" },
  { value: "inventory_at_invalid_location", label: "Bad Stock" },
  { value: "invalid_pick_assignment", label: "Bad Slots" },
];

const ACTION_LABELS: Record<string, string> = {
  resolve_blocker: "Resolve blocker",
  auto_execute_replen: "Auto-execute replen",
  complete_inline_replen: "Auto-execute replen",
  execute_or_cancel: "Execute or cancel",
  cancel_no_demand: "Cancel no-demand",
  cancel_duplicate: "Cancel duplicate",
  create_replen_or_exception: "Create task/exception",
  review_short_pick: "Review short pick",
  resolve_exception: "Resolve exception",
  review_exception: "Review exception",
  approve_or_resolve_count: "Approve count",
  finish_count: "Finish count",
  review_order_status: "Review status",
  queue_replen: "Queue replen",
  fix_location_or_transfer_stock: "Fix location",
  fix_pick_assignment: "Fix assignment",
};

function formatAge(hours: number | null) {
  if (hours == null) return "-";
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function rowSubject(item: PickReplenHealthItem) {
  if (item.orderNumber) return item.orderNumber;
  if (item.taskId) return `Task #${item.taskId}`;
  if (item.exceptionId) return `Exception #${item.exceptionId}`;
  if (item.cycleCountId) return `Count #${item.cycleCountId}`;
  return "-";
}

function issueHref(item: PickReplenHealthItem) {
  if (item.taskId) return `/replenishment?taskId=${item.taskId}&status=all`;
  if (item.cycleCountId) return `/cycle-counts?countId=${item.cycleCountId}`;
  if (
    item.type === "open_allocation_exception" ||
    item.type === "allocation_review_needed" ||
    item.type === "short_pick_unresolved"
  ) {
    const params = new URLSearchParams({ view: "exceptions" });
    if (item.orderId) params.set("orderId", item.orderId.toString());
    if (item.orderItemId) params.set("itemId", item.orderItemId.toString());
    if (item.exceptionId) params.set("exceptionId", item.exceptionId.toString());
    return `/picking?${params}`;
  }
  if (item.orderId) return `/orders?orderId=${item.orderId}`;
  return null;
}

function cleanupModeForAction(action: string): CleanupMode | null {
  if (action === "cancel_no_demand") return "stale_no_demand";
  if (action === "cancel_duplicate") return "duplicates";
  if (action === "queue_replen") return "queue_replen";
  if (action === "auto_execute_replen" || action === "complete_inline_replen") return "inline_execution";
  return null;
}

function IssueLink({
  item,
  children,
}: {
  item: PickReplenHealthItem;
  children: ReactNode;
}) {
  const href = issueHref(item);
  if (!href) return <>{children}</>;
  return (
    <Link href={href}>
      <span className="inline-flex items-center gap-1 text-blue-700 hover:underline dark:text-blue-400">
        {children}
        <ExternalLink className="h-3 w-3" />
      </span>
    </Link>
  );
}

function HealthAction({
  item,
  isCleaning,
  onCleanup,
}: {
  item: PickReplenHealthItem;
  isCleaning: boolean;
  onCleanup: (request: CleanupRequest) => void;
}) {
  const label = ACTION_LABELS[item.action] || item.action;
  const cleanupMode = cleanupModeForAction(item.action);
  if (!cleanupMode) return <IssueLink item={item}>{label}</IssueLink>;

  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto p-0 text-xs font-medium text-blue-700 dark:text-blue-400"
      disabled={isCleaning}
      onClick={() => onCleanup({
        mode: cleanupMode,
        taskId: item.taskId,
        variantId: item.variantId,
        locationId: item.locationId,
      })}
    >
      {isCleaning ? "Working..." : label}
    </Button>
  );
}

export default function PickReplenHealthSection({
  warehouseId,
  searchQuery,
}: PickReplenHealthSectionProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeFilter, setActiveFilter] = useState<PickReplenHealthFilter>("all");
  const [page, setPage] = useState(1);
  const pageSize = 50;

  useEffect(() => { setPage(1); }, [activeFilter, searchQuery]);

  const { data, isLoading } = useQuery<PickReplenHealthResponse>({
    queryKey: ["/api/operations/pick-replen-health", warehouseId, activeFilter, searchQuery, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (warehouseId) params.set("warehouseId", warehouseId.toString());
      params.set("filter", activeFilter);
      if (searchQuery) params.set("search", searchQuery);
      params.set("page", page.toString());
      params.set("pageSize", pageSize.toString());
      const res = await fetch(`/api/operations/pick-replen-health?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch pick/replen health");
      return res.json();
    },
    staleTime: 30_000,
  });

  const cleanupMutation = useMutation({
    mutationFn: async (request: CleanupRequest) => {
      const res = await apiRequest("POST", "/api/operations/pick-replen-health/cleanup", {
        mode: request.mode,
        taskId: request.taskId,
        variantId: request.variantId,
        locationId: request.locationId,
        warehouseId: request.warehouseId ?? warehouseId,
      });
      return res.json() as Promise<CleanupResult>;
    },
    onSuccess: (result) => {
      const executed = result.executedInline ?? 0;
      const failed = result.failedInline ?? 0;
      const cleaned = result.cancelledStaleNoDemand + (result.cancelledStaleBacklog ?? 0) + result.cancelledDuplicates;
      const queued = result.queuedReplen ?? 0;
      const skipped = result.skippedPickBins ?? 0;
      toast({
        title: executed > 0 ? "Replen executed" : queued > 0 ? "Replen queued" : "Replen cleanup complete",
        description: executed > 0
          ? `Executed ${executed} inline replen task${executed === 1 ? "" : "s"}${failed > 0 ? `; ${failed} failed` : ""}`
          : queued > 0
          ? `Queued ${queued} replen task${queued === 1 ? "" : "s"}${skipped > 0 ? `; ${skipped} bin${skipped === 1 ? "" : "s"} need review` : ""}`
          : cleaned > 0
            ? `Cleaned ${cleaned} replen task${cleaned === 1 ? "" : "s"}`
            : "No safe cleanup was available",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/pick-replen-health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/action-queue"] });
      queryClient.invalidateQueries({ queryKey: ["/api/operations/location-health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/replen/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/levels"] });
    },
    onError: (error: any) => {
      toast({
        title: "Replen cleanup failed",
        description: error?.message || "Unable to clean replen health issue",
        variant: "destructive",
      });
    },
  });

  const totalOpen = useMemo(
    () => data ? Object.values(data.counts).reduce((sum, count) => sum + count, 0) : 0,
    [data],
  );
  const totalPages = data ? Math.ceil(data.total / pageSize) : 0;

  return (
    <div className="rounded-lg border bg-card">
      <div className="p-4 border-b flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold text-base">Pick/Replen Health</h3>
          <Badge variant={totalOpen > 0 ? "destructive" : "secondary"} className="text-xs">
            {totalOpen.toLocaleString()}
          </Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          {(data?.counts?.pick_bin_needs_replen ?? 0) > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={cleanupMutation.isPending}
              onClick={() => cleanupMutation.mutate({
                mode: "queue_missing_replen",
                taskId: null,
                warehouseId,
              })}
            >
              <PackagePlus className="mr-1 h-3 w-3" />
              Queue Missing
            </Button>
          )}
          {FILTERS.map((filter) => {
            const count = filter.value === "all"
              ? totalOpen
              : data?.counts?.[filter.value] ?? 0;
            return (
              <Button
                key={filter.value}
                type="button"
                variant={activeFilter === filter.value ? "default" : "outline"}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setActiveFilter(filter.value)}
              >
                {filter.label}
                <span className="ml-1 font-mono">{count}</span>
              </Button>
            );
          })}
        </div>
      </div>

      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[32px]"></TableHead>
              <TableHead className="w-[150px]">Type</TableHead>
              <TableHead className="w-[120px]">Subject</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Detail</TableHead>
              <TableHead className="text-right w-[70px]">Age</TableHead>
              <TableHead className="w-[140px]">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                  Loading...
                </TableCell>
              </TableRow>
            ) : !data?.items.length ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                  No pick/replen items need attention
                </TableCell>
              </TableRow>
            ) : (
              data.items.map((item) => {
                const cfg = TYPE_CONFIG[item.type];
                const Icon = cfg.icon;
                return (
                  <TableRow key={item.id}>
                    <TableCell className="px-2">
                      <Icon className={item.priority <= 1 ? "h-4 w-4 text-red-600" : "h-4 w-4 text-muted-foreground"} />
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`text-[10px] ${cfg.badge}`}>
                        {cfg.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      <IssueLink item={item}>{rowSubject(item)}</IssueLink>
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {item.sourceLocationCode ? `${item.sourceLocationCode} -> ` : ""}
                      {item.locationCode || "-"}
                    </TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {item.sku || "-"}
                    </TableCell>
                    <TableCell className="text-sm">{item.status || "-"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground truncate max-w-[260px]">
                      {item.detail || item.name || "-"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">{formatAge(item.ageHours)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <HealthAction
                        item={item}
                        isCleaning={cleanupMutation.isPending}
                        onCleanup={(request) => cleanupMutation.mutate(request)}
                      />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <div className="md:hidden p-3 space-y-2">
        {isLoading ? (
          <div className="text-center py-8 text-muted-foreground">Loading...</div>
        ) : !data?.items.length ? (
          <div className="text-center py-8 text-muted-foreground">
            No pick/replen items need attention
          </div>
        ) : (
          data.items.map((item) => {
            const cfg = TYPE_CONFIG[item.type];
            const Icon = cfg.icon;
            return (
              <div key={item.id} className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Icon className={item.priority <= 1 ? "h-4 w-4 text-red-600" : "h-4 w-4 text-muted-foreground"} />
                    <div>
                      <div className="font-mono text-sm font-medium">
                        <IssueLink item={item}>{rowSubject(item)}</IssueLink>
                      </div>
                      <Badge variant="outline" className={`mt-1 text-[10px] ${cfg.badge}`}>
                        {cfg.label}
                      </Badge>
                    </div>
                  </div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {formatAge(item.ageHours)}
                  </div>
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  <div className="font-mono">
                    {item.sourceLocationCode ? `${item.sourceLocationCode} -> ` : ""}
                    {item.locationCode || "-"}
                    {item.sku ? ` - ${item.sku}` : ""}
                  </div>
                  <div className="mt-1">{item.detail || item.status || "-"}</div>
                </div>
                <div className="mt-2 pt-2 border-t text-xs font-medium">
                  <HealthAction
                    item={item}
                    isCleaning={cleanupMutation.isPending}
                    onCleanup={(request) => cleanupMutation.mutate(request)}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>

      {totalPages > 1 && (
        <div className="p-3 border-t flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
