import { useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Loader2, RefreshCw, ArrowRight, AlertCircle, ChevronLeft, ChevronRight } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface SyncLogEntry {
  id: number;
  channelId: number | null;
  channelName: string | null;
  action: string;
  sku: string | null;
  productVariantId: number | null;
  previousValue: string | null;
  newValue: string | null;
  status: string;
  errorMessage: string | null;
  source: string;
  createdAt: string;
}

interface SyncLogSummary {
  pushed: number;
  dryRun: number;
  errors: number;
  skipped: number;
}

interface Channel {
  id: number;
  name: string;
  provider: string;
  syncEnabled: boolean;
  syncMode: string;
}

const STATUS_BADGES: Record<
  string,
  { variant: "default" | "secondary" | "destructive" | "outline"; className: string; label: string }
> = {
  pushed: { variant: "default", className: "bg-green-600 hover:bg-green-700", label: "Pushed" },
  dry_run: { variant: "secondary", className: "bg-yellow-500/20 text-yellow-600 border-yellow-500/30", label: "Dry Run" },
  error: { variant: "destructive", className: "", label: "Error" },
  skipped: { variant: "outline", className: "text-muted-foreground", label: "Skipped" },
};

const ACTION_LABELS: Record<string, string> = {
  inventory_push: "Inventory Push",
  pricing_push: "Pricing Push",
  listing_create: "Listing Create",
  listing_update: "Listing Update",
};

const SOURCE_LABELS: Record<string, string> = {
  event: "Event",
  sweep: "Sweep",
  manual: "Manual",
};

export default function SyncLogPage() {
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(0);
  const pageSize = 50;

  // Build query params
  const buildParams = useCallback(() => {
    const params = new URLSearchParams();
    params.set("limit", String(pageSize));
    params.set("offset", String(page * pageSize));
    if (channelFilter !== "all") params.set("channelId", channelFilter);
    if (statusFilter !== "all") params.set("status", statusFilter);
    return params.toString();
  }, [channelFilter, statusFilter, page]);

  // Fetch sync log
  const {
    data: logData,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["/api/sync/log", channelFilter, statusFilter, page],
    queryFn: () => apiRequest("GET", `/api/sync/log?${buildParams()}`).then((r) => r.json()),
    refetchInterval: 30000, // Auto-refresh every 30s
  });

  // Fetch summary
  const { data: summary } = useQuery<SyncLogSummary>({
    queryKey: ["/api/sync/log/summary"],
    queryFn: () => apiRequest("GET", "/api/sync/log/summary").then((r) => r.json()),
    refetchInterval: 30000,
  });

  // Fetch sync status (for channel list + dry-run banner)
  const { data: syncStatus } = useQuery({
    queryKey: ["/api/sync/status"],
    queryFn: () => apiRequest("GET", "/api/sync/status").then((r) => r.json()),
    refetchInterval: 30000,
  });

  const entries: SyncLogEntry[] = logData?.entries || [];
  const total: number = logData?.total || 0;
  const totalPages = Math.ceil(total / pageSize);
  const channels: Channel[] = syncStatus?.channels || [];

  // Check if any channel is in dry-run mode
  const dryRunChannels = channels.filter((c) => c.syncEnabled && c.syncMode === "dry_run");

  // Reset page on filter change
  useEffect(() => {
    setPage(0);
  }, [channelFilter, statusFilter]);

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Sync Activity Log</h1>
          <p className="text-sm text-muted-foreground">
            All inventory sync operations across channels
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
          <RefreshCw size={14} />
          Refresh
        </Button>
      </div>

      {/* Dry-run banner */}
      {dryRunChannels.length > 0 && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3 flex items-center gap-2">
          <span className="text-lg">🟡</span>
          <span className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
            DRY RUN — {dryRunChannels.map((c) => c.name).join(", ")}{" "}
            {dryRunChannels.length === 1 ? "is" : "are"} in dry-run mode. Changes logged but not pushed.
          </span>
        </div>
      )}

      {/* Summary bar */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-green-600">{summary.pushed}</div>
              <div className="text-xs text-muted-foreground">Pushed (24h)</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-yellow-600">{summary.dryRun}</div>
              <div className="text-xs text-muted-foreground">Dry Run (24h)</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-red-600">{summary.errors}</div>
              <div className="text-xs text-muted-foreground">Errors (24h)</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-muted-foreground">{summary.skipped}</div>
              <div className="text-xs text-muted-foreground">Skipped (24h)</div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <Select value={channelFilter} onValueChange={setChannelFilter}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="All Channels" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Channels</SelectItem>
            {channels.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="All Statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="pushed">Pushed</SelectItem>
            <SelectItem value="dry_run">Dry Run</SelectItem>
            <SelectItem value="error">Error</SelectItem>
            <SelectItem value="skipped">Skipped</SelectItem>
          </SelectContent>
        </Select>

        <div className="text-sm text-muted-foreground ml-auto">
          {total} total entries
        </div>
      </div>

      {/* Log table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center p-12">
              <Loader2 className="animate-spin h-6 w-6 text-muted-foreground" />
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-12 text-muted-foreground">
              <AlertCircle size={40} className="mb-3 opacity-30" />
              <p>No sync log entries found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[160px]">Time</TableHead>
                    <TableHead className="w-[120px]">Channel</TableHead>
                    <TableHead className="w-[100px]">SKU</TableHead>
                    <TableHead className="w-[120px]">Action</TableHead>
                    <TableHead className="w-[160px]">Change</TableHead>
                    <TableHead className="w-[90px]">Status</TableHead>
                    <TableHead className="w-[70px]">Source</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => {
                    const statusBadge = STATUS_BADGES[entry.status] || {
                      variant: "outline" as const,
                      className: "",
                      label: entry.status,
                    };

                    return (
                      <TableRow key={entry.id}>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {formatDistanceToNow(new Date(entry.createdAt), { addSuffix: true })}
                          <br />
                          <span className="text-[10px] opacity-60">
                            {new Date(entry.createdAt).toLocaleString()}
                          </span>
                        </TableCell>
                        <TableCell className="text-sm font-medium">
                          {entry.channelName || "—"}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {entry.sku || "—"}
                        </TableCell>
                        <TableCell className="text-xs">
                          {ACTION_LABELS[entry.action] || entry.action}
                        </TableCell>
                        <TableCell className="text-xs">
                          {entry.previousValue || entry.newValue ? (
                            <span className="flex items-center gap-1">
                              <span className="text-muted-foreground">
                                {entry.previousValue ?? "—"}
                              </span>
                              <ArrowRight size={12} className="text-muted-foreground/50" />
                              <span className="font-medium">
                                {entry.newValue ?? "—"}
                              </span>
                            </span>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={statusBadge.variant}
                            className={statusBadge.className}
                          >
                            {statusBadge.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">
                          <Badge variant="outline" className="text-[10px]">
                            {SOURCE_LABELS[entry.source] || entry.source}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                          {entry.errorMessage || ""}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <div className="text-sm text-muted-foreground">
            Page {page + 1} of {totalPages}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              <ChevronLeft size={14} />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
            >
              Next
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
