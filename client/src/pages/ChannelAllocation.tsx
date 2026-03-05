import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent } from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { useDebounce } from "@/hooks/use-debounce";
import { RefreshCw, Loader2, Search, ChevronLeft, ChevronRight, Layers, Radio } from "lucide-react";
import { cn } from "@/lib/utils";

// --- Types ---

interface Channel {
  id: number;
  name: string;
  provider: string;
  status: string;
}

interface ChannelCellData {
  hasFeed: boolean;
  lastSyncedQty: number;
  lastSyncedAt: string | null;
  productFloor: number | null;
  productCap: number | null;
  isListed: number;
  variantFloor: number | null;
  variantCap: number | null;
  effectiveAtp: number;
}

interface AllocationRow {
  productVariantId: number;
  productId: number;
  sku: string;
  productName: string;
  variantName: string;
  unitsPerVariant: number;
  atpBase: number;
  atpUnits: number;
  channels: Record<string, ChannelCellData>;
}

interface AllocationGrid {
  channels: Channel[];
  rows: AllocationRow[];
  totalCount: number;
  page: number;
  limit: number;
}

// --- Inline helper: cell edit popover ---

function CellEditPopover({
  channelId,
  row,
  cellData,
}: {
  channelId: number;
  row: AllocationRow;
  cellData: ChannelCellData;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [floor, setFloor] = useState<string>(
    cellData.variantFloor != null ? String(cellData.variantFloor) : ""
  );
  const [cap, setCap] = useState<string>(
    cellData.variantCap != null ? String(cellData.variantCap) : ""
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/channel-reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          channelId,
          productVariantId: row.productVariantId,
          minStockBase: floor === "" ? null : parseInt(floor, 10),
          maxStockBase: cap === "" ? null : parseInt(cap, 10),
        }),
      });
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(text);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channel-allocation/grid"] });
      setOpen(false);
      toast({ title: "Allocation updated" });
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
    },
  });

  const enableFeedMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/channel-feeds/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          channelId,
          productVariantId: row.productVariantId,
        }),
      });
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(text);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channel-allocation/grid"] });
      toast({ title: "Sync enabled for this variant" });
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
    },
  });

  const display = getCellDisplay(cellData);

  return (
    <Popover open={open} onOpenChange={(o) => {
      setOpen(o);
      if (o) {
        setFloor(cellData.variantFloor != null ? String(cellData.variantFloor) : "");
        setCap(cellData.variantCap != null ? String(cellData.variantCap) : "");
      }
    }}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "w-full text-left px-2 py-1.5 rounded hover:bg-muted/50 transition-colors text-sm",
            display.colorClass
          )}
        >
          {display.content}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-4" align="start">
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium">{row.sku}</p>
            <p className="text-xs text-muted-foreground">
              ATP: {cellData.effectiveAtp.toLocaleString()} units
            </p>
          </div>

          {!cellData.hasFeed && (
            <div className="border-b pb-3">
              <p className="text-xs text-muted-foreground mb-2">
                Not synced to this channel yet.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => enableFeedMutation.mutate()}
                disabled={enableFeedMutation.isPending}
              >
                {enableFeedMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Radio className="h-4 w-4 mr-2" />
                )}
                Enable Sync
              </Button>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">Variant Floor</label>
            <Input
              type="number"
              min={0}
              placeholder="No floor"
              value={floor}
              onChange={(e) => setFloor(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground">Max Cap</label>
            <Input
              type="number"
              min={0}
              placeholder="No cap"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              autoComplete="off"
            />
          </div>
          <Button
            className="w-full"
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : null}
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// --- Display logic for channel cells ---

function getCellDisplay(cellData: ChannelCellData): {
  content: React.ReactNode;
  colorClass: string;
} {
  // Hard-blocked (isListed = 0)
  if (cellData.isListed === 0) {
    return {
      content: (
        <span className="flex items-center gap-1.5">
          <span>0</span>
          <Badge variant="outline" className="text-[10px] px-1 py-0 leading-tight border-red-300 text-red-500">
            BLOCKED
          </Badge>
        </span>
      ),
      colorClass: "text-red-500",
    };
  }

  // No feed — show ATP in muted style
  if (!cellData.hasFeed) {
    return {
      content: (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span>{cellData.effectiveAtp.toLocaleString()}</span>
          <Badge variant="outline" className="text-[10px] px-1 py-0 leading-tight">
            NO FEED
          </Badge>
        </span>
      ),
      colorClass: "text-muted-foreground",
    };
  }

  // Floor hit (effectiveAtp is 0 due to floor)
  const hasFloor = cellData.variantFloor != null || cellData.productFloor != null;
  if (cellData.effectiveAtp === 0 && hasFloor) {
    return {
      content: (
        <span className="flex items-center gap-1.5">
          <span>0</span>
          <Badge variant="destructive" className="text-[10px] px-1 py-0 leading-tight">
            FLOOR
          </Badge>
        </span>
      ),
      colorClass: "text-red-500",
    };
  }

  // Determine sync freshness color
  let syncColor = "text-foreground";
  if (cellData.lastSyncedAt) {
    const syncAge = Date.now() - new Date(cellData.lastSyncedAt).getTime();
    const fiveMinutes = 5 * 60 * 1000;
    if (syncAge <= fiveMinutes) {
      syncColor = "text-green-600 dark:text-green-400";
    } else {
      syncColor = "text-amber-600 dark:text-amber-400";
    }
  }

  const capText =
    cellData.variantCap != null
      ? `(cap: ${cellData.variantCap})`
      : cellData.productCap != null
        ? `(cap: ${cellData.productCap})`
        : null;

  return {
    content: (
      <span className="flex items-center gap-1.5">
        <span>{cellData.effectiveAtp.toLocaleString()}</span>
        {capText && (
          <span className="text-xs text-muted-foreground">{capText}</span>
        )}
      </span>
    ),
    colorClass: syncColor,
  };
}

// --- Main component ---

export default function ChannelAllocation() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 100;
  const debouncedSearch = useDebounce(search, 300);

  // Reset page when search changes
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch]);

  const { data, isLoading } = useQuery<AllocationGrid>({
    queryKey: ["/api/channel-allocation/grid", debouncedSearch, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      params.set("page", String(page));
      params.set("limit", String(pageSize));
      const res = await fetch(`/api/channel-allocation/grid?${params}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch allocation grid");
      return res.json();
    },
  });

  const syncAllMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/channel-sync/all", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        throw new Error(text);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channel-allocation/grid"] });
      toast({ title: "Sync triggered for all channels" });
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
    },
  });

  const channels = data?.channels ?? [];
  const rows = data?.rows ?? [];
  const totalCount = data?.totalCount ?? 0;
  const totalPages = Math.ceil(totalCount / pageSize);

  return (
    <div className="space-y-4 p-2 md:p-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
          Channel Allocation
        </h1>
        <div className="flex items-center gap-3">
          <div className="relative flex-1 md:w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search SKU or product..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-10"
              autoComplete="off"
            />
          </div>
          <Button
            variant="outline"
            onClick={() => syncAllMutation.mutate()}
            disabled={syncAllMutation.isPending}
          >
            {syncAllMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Sync All
          </Button>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Variants with Stock</p>
            <p className="text-2xl font-bold">{totalCount.toLocaleString()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Active Channels</p>
            <p className="text-2xl font-bold">{channels.length}</p>
          </CardContent>
        </Card>
        <Card className="hidden md:block">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Showing</p>
            <p className="text-2xl font-bold">
              {rows.length} <span className="text-sm font-normal text-muted-foreground">of {totalCount}</span>
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Grid */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : rows.length === 0 ? (
            <div className="text-center py-16">
              <Layers className="h-12 w-12 mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground">
                {search.trim()
                  ? "No variants match your search."
                  : "No variants with inventory found."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky left-0 bg-card z-10 min-w-[120px]">
                      SKU
                    </TableHead>
                    <TableHead className="min-w-[160px]">Product</TableHead>
                    <TableHead className="min-w-[100px]">Variant</TableHead>
                    <TableHead className="text-right min-w-[80px]">ATP</TableHead>
                    {channels.map((ch) => (
                      <TableHead
                        key={ch.id}
                        className="text-center min-w-[140px]"
                      >
                        {ch.name}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.productVariantId}>
                      <TableCell className="sticky left-0 bg-card z-10 font-mono text-sm">
                        {row.sku}
                      </TableCell>
                      <TableCell className="text-sm">{row.productName}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {row.variantName}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {row.atpBase.toLocaleString()}
                      </TableCell>
                      {channels.map((ch) => {
                        const cellData = row.channels[String(ch.id)];
                        if (!cellData) {
                          return (
                            <TableCell
                              key={ch.id}
                              className="text-center text-muted-foreground"
                            >
                              &mdash;
                            </TableCell>
                          );
                        }
                        return (
                          <TableCell key={ch.id} className="text-center p-0">
                            <CellEditPopover
                              channelId={ch.id}
                              row={row}
                              cellData={cellData}
                            />
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <span className="text-sm text-muted-foreground">
                {((page - 1) * pageSize + 1).toLocaleString()}-{Math.min(page * pageSize, totalCount).toLocaleString()} of {totalCount.toLocaleString()}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground px-2">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
