import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  PackageX,
  RefreshCw,
  Clock,
  ArrowLeftRight,
  Edit,
  ArrowRight,
  ListChecks,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  ActionFilter,
  ActionQueueCounts,
  ActionQueueItem,
  ActionQueueResponse,
} from "./types";

interface ActionQueueSectionProps {
  warehouseId: number | null;
  activeFilter: ActionFilter;
  canEdit: boolean;
  onTransferFrom: (fromLocationId: number, fromLocationCode: string, variantId?: number, sku?: string) => void;
  onTransferTo: (toLocationId: number, toLocationCode: string, variantId?: number, sku?: string) => void;
  onAdjust: (locationId: number, locationCode: string, variantId: number, sku: string, currentQty: number) => void;
  onCountsLoaded: (counts: ActionQueueCounts) => void;
}

const TYPE_CONFIG: Record<string, { label: string; badge: string; icon: typeof AlertTriangle }> = {
  negative_inventory: { label: "Negative Inv", badge: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400", icon: AlertTriangle },
  empty_pick_face: { label: "Empty Pick", badge: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400", icon: PackageX },
  pending_replen: { label: "Low Stock", badge: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400", icon: RefreshCw },
  unassigned: { label: "Unassigned", badge: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400", icon: PackageX },
  stale_bin: { label: "Stale", badge: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400", icon: Clock },
};

const PRIORITY_COLORS: Record<number, string> = {
  1: "text-red-600",
  2: "text-red-500",
  3: "text-amber-500",
  4: "text-muted-foreground",
};

const ACTION_LABELS: Record<string, { label: string; icon: typeof Edit }> = {
  adjust: { label: "Fix", icon: Edit },
  replenish: { label: "Replen", icon: ArrowRight },
  move: { label: "Move", icon: ArrowLeftRight },
};

const FILTER_LABELS: Record<string, string> = {
  negative_inventory: "Negative Inventory",
  empty_pick_face: "Empty Pick Faces",
  pending_replen: "Pending Replen",
  stale_bin: "Stale Bins",
  unassigned: "Unassigned",
};

export default function ActionQueueSection({
  warehouseId,
  activeFilter,
  canEdit,
  onTransferFrom,
  onTransferTo,
  onAdjust,
  onCountsLoaded,
}: ActionQueueSectionProps) {
  const [page, setPage] = useState(1);
  const pageSize = 50;

  // Reset page when filter changes
  useEffect(() => { setPage(1); }, [activeFilter]);

  const { data, isLoading } = useQuery<ActionQueueResponse>({
    queryKey: ["/api/operations/action-queue", warehouseId, activeFilter, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (warehouseId) params.set("warehouseId", warehouseId.toString());
      params.set("filter", activeFilter);
      params.set("page", page.toString());
      params.set("pageSize", pageSize.toString());
      params.set("sortField", "priority");
      params.set("sortDir", "asc");
      const res = await fetch(`/api/operations/action-queue?${params}`);
      if (!res.ok) throw new Error("Failed to fetch action queue");
      return res.json();
    },
    staleTime: 30_000,
  });

  // Push counts to parent for KPI cards
  useEffect(() => {
    if (data?.counts) onCountsLoaded(data.counts);
  }, [data?.counts]);

  const totalPages = data ? Math.ceil(data.total / pageSize) : 0;

  const handleAction = (item: ActionQueueItem) => {
    switch (item.type) {
      case "negative_inventory":
        onAdjust(item.locationId, item.locationCode, item.variantId!, item.sku!, item.qty!);
        break;
      case "empty_pick_face":
        onTransferTo(item.locationId, item.locationCode);
        break;
      case "pending_replen":
        onTransferTo(item.locationId, item.locationCode, item.variantId!, item.sku!);
        break;
      case "unassigned":
        onTransferFrom(item.locationId, item.locationCode, item.variantId!, item.sku!);
        break;
      case "stale_bin":
        onTransferFrom(item.locationId, item.locationCode);
        break;
    }
  };

  return (
    <div className="rounded-lg border bg-card">
      {/* Header */}
      <div className="p-4 border-b flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold text-base">Action Queue</h3>
          {activeFilter !== "all" && (
            <Badge variant="secondary" className="text-xs">
              {FILTER_LABELS[activeFilter] || activeFilter}
            </Badge>
          )}
        </div>
        <span className="text-sm text-muted-foreground">
          {data?.total?.toLocaleString() ?? "—"} items
        </span>
      </div>

      {/* Desktop table */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[32px]"></TableHead>
              <TableHead className="w-[100px]">Type</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Details</TableHead>
              <TableHead className="text-right w-[80px]">Qty</TableHead>
              {canEdit && <TableHead className="w-[90px]"></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={canEdit ? 7 : 6} className="text-center py-8 text-muted-foreground">
                  Loading...
                </TableCell>
              </TableRow>
            ) : !data?.items.length ? (
              <TableRow>
                <TableCell colSpan={canEdit ? 7 : 6} className="text-center py-8 text-muted-foreground">
                  {activeFilter === "all" ? "No actionable items — all clear!" : "No items for this filter"}
                </TableCell>
              </TableRow>
            ) : (
              data.items.map((item) => {
                const cfg = TYPE_CONFIG[item.type];
                const act = ACTION_LABELS[item.action];
                const PriorityIcon = cfg?.icon || AlertTriangle;
                const ActionIcon = act?.icon || ArrowLeftRight;
                return (
                  <TableRow key={item.id}>
                    <TableCell className="px-2">
                      <PriorityIcon className={`h-4 w-4 ${PRIORITY_COLORS[item.priority] || "text-muted-foreground"}`} />
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`text-[10px] ${cfg?.badge || ""}`}>
                        {cfg?.label || item.type}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm font-medium">
                      {item.locationCode}
                    </TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {item.sku || "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground truncate max-w-[200px]">
                      {item.detail || item.name || "—"}
                    </TableCell>
                    <TableCell className={`text-right font-mono text-sm ${
                      item.qty != null && item.qty < 0 ? "text-red-600 font-bold" : ""
                    }`}>
                      {item.qty != null ? item.qty.toLocaleString() : "—"}
                    </TableCell>
                    {canEdit && (
                      <TableCell className="px-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => handleAction(item)}
                        >
                          <ActionIcon className="h-3 w-3 mr-1" />
                          {act?.label || "Act"}
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Mobile card layout */}
      <div className="md:hidden p-3 space-y-2">
        {isLoading ? (
          <div className="text-center py-8 text-muted-foreground">Loading...</div>
        ) : !data?.items.length ? (
          <div className="text-center py-8 text-muted-foreground">
            {activeFilter === "all" ? "No actionable items — all clear!" : "No items for this filter"}
          </div>
        ) : (
          data.items.map((item) => {
            const cfg = TYPE_CONFIG[item.type];
            const act = ACTION_LABELS[item.action];
            const PriorityIcon = cfg?.icon || AlertTriangle;
            const ActionIcon = act?.icon || ArrowLeftRight;
            return (
              <div key={item.id} className="rounded-md border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <PriorityIcon className={`h-4 w-4 shrink-0 ${PRIORITY_COLORS[item.priority] || ""}`} />
                    <div>
                      <div className="font-mono font-medium text-sm">{item.locationCode}</div>
                      <div className="flex gap-1.5 mt-0.5">
                        <Badge variant="outline" className={`text-[10px] ${cfg?.badge || ""}`}>
                          {cfg?.label || item.type}
                        </Badge>
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`font-mono font-bold ${item.qty != null && item.qty < 0 ? "text-red-600" : ""}`}>
                      {item.qty != null ? item.qty.toLocaleString() : "—"}
                    </div>
                  </div>
                </div>
                {(item.sku || item.detail || item.name) && (
                  <div className="mt-1.5 text-xs text-muted-foreground">
                    {item.sku && <span className="font-mono">{item.sku}</span>}
                    {item.sku && (item.detail || item.name) && <span className="mx-1">·</span>}
                    {item.detail || item.name}
                  </div>
                )}
                {canEdit && (
                  <div className="mt-2 pt-2 border-t">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs w-full"
                      onClick={() => handleAction(item)}
                    >
                      <ActionIcon className="h-3 w-3 mr-1" />
                      {item.type === "negative_inventory" ? "Fix" :
                       item.type === "empty_pick_face" ? "Replenish" :
                       item.type === "pending_replen" ? "Replenish" :
                       item.type === "unassigned" ? "Put Away" : "Move"}
                    </Button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Pagination */}
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
