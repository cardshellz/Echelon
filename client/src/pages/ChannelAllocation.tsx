import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { useDebounce } from "@/hooks/use-debounce";
import {
  RefreshCw,
  Loader2,
  Search,
  ChevronLeft,
  ChevronRight,
  Layers,
  Radio,
  Ban,
  ShieldCheck,
  ArrowUpDown,
  Eye,
  EyeOff,
} from "lucide-react";
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

// --- Cell edit popover ---

function CellEditPopover({
  channelId,
  channelName,
  row,
  cellData,
}: {
  channelId: number;
  channelName: string;
  row: AllocationRow;
  cellData: ChannelCellData;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [floor, setFloor] = useState("");
  const [cap, setCap] = useState("");
  const [productFloor, setProductFloor] = useState("");
  const [productCap, setProductCap] = useState("");
  const [isListed, setIsListed] = useState(true);

  // Reset form on open
  useEffect(() => {
    if (open) {
      setFloor(cellData.variantFloor != null ? String(cellData.variantFloor) : "");
      setCap(cellData.variantCap != null ? String(cellData.variantCap) : "");
      setProductFloor(cellData.productFloor != null ? String(cellData.productFloor) : "");
      setProductCap(cellData.productCap != null ? String(cellData.productCap) : "");
      setIsListed(cellData.isListed !== 0);
    }
  }, [open, cellData]);

  // Save variant-level reservation (floor + cap)
  const saveVariantMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/channel-reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          channelId,
          productVariantId: row.productVariantId,
          minStockBase: floor === "" ? 0 : parseInt(floor, 10),
          maxStockBase: cap === "" ? null : parseInt(cap, 10),
          reserveBaseQty: 0,
        }),
      });
      if (!res.ok) throw new Error((await res.text()) || res.statusText);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channel-allocation/grid"] });
      toast({ title: "Variant overrides saved" });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  // Save product-level allocation (floor + cap + isListed)
  const saveProductMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/channel-product-allocation", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          channelId,
          productId: row.productId,
          minAtpBase: productFloor === "" ? null : parseInt(productFloor, 10),
          maxAtpBase: productCap === "" ? null : parseInt(productCap, 10),
          isListed: isListed ? 1 : 0,
        }),
      });
      if (!res.ok) throw new Error((await res.text()) || res.statusText);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channel-allocation/grid"] });
      toast({ title: "Product rules saved" });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  // Enable feed
  const enableFeedMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/channel-feeds/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ channelId, productVariantId: row.productVariantId }),
      });
      if (!res.ok) throw new Error((await res.text()) || res.statusText);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channel-allocation/grid"] });
      toast({ title: "Feed enabled" });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const display = getCellDisplay(cellData);
  const saving = saveVariantMutation.isPending || saveProductMutation.isPending;

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
      <PopoverContent className="w-80 p-0" align="start">
        {/* Header */}
        <div className="px-4 py-3 border-b bg-muted/30">
          <p className="text-sm font-medium">{row.sku}</p>
          <p className="text-xs text-muted-foreground">
            {row.productName} — {channelName}
          </p>
          <div className="flex items-center gap-3 mt-1 text-xs">
            <span>ATP: <strong>{cellData.effectiveAtp.toLocaleString()}</strong></span>
            <span>Pool: <strong>{row.atpBase.toLocaleString()}</strong> base units</span>
          </div>
        </div>

        <div className="p-4 space-y-4">
          {/* Feed status */}
          {!cellData.hasFeed && (
            <div className="bg-muted/50 rounded-md p-3">
              <p className="text-xs text-muted-foreground mb-2">
                No feed — inventory not syncing to this channel.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => enableFeedMutation.mutate()}
                disabled={enableFeedMutation.isPending}
              >
                {enableFeedMutation.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-2" />
                ) : (
                  <Radio className="h-3 w-3 mr-2" />
                )}
                Enable Feed
              </Button>
            </div>
          )}

          {/* Product-level controls */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Product Rules
              </span>
              <Badge variant="outline" className="text-[10px]">All variants</Badge>
            </div>

            <div className="flex items-center justify-between mb-3">
              <Label htmlFor={`listed-${channelId}-${row.productId}`} className="text-sm">
                {isListed ? (
                  <span className="flex items-center gap-1.5 text-green-600">
                    <Eye className="h-3.5 w-3.5" /> Listed
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-red-500">
                    <EyeOff className="h-3.5 w-3.5" /> Blocked
                  </span>
                )}
              </Label>
              <Switch
                id={`listed-${channelId}-${row.productId}`}
                checked={isListed}
                onCheckedChange={setIsListed}
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-muted-foreground">Floor (base units)</label>
                <Input
                  type="number"
                  min={0}
                  placeholder="None"
                  value={productFloor}
                  onChange={(e) => setProductFloor(e.target.value)}
                  autoComplete="off"
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Cap (base units)</label>
                <Input
                  type="number"
                  min={0}
                  placeholder="None"
                  value={productCap}
                  onChange={(e) => setProductCap(e.target.value)}
                  autoComplete="off"
                  className="h-8 text-sm"
                />
              </div>
            </div>
            <Button
              className="w-full mt-2"
              size="sm"
              variant="outline"
              onClick={() => saveProductMutation.mutate()}
              disabled={saving}
            >
              {saveProductMutation.isPending && <Loader2 className="h-3 w-3 animate-spin mr-2" />}
              Save Product Rules
            </Button>
          </div>

          <Separator />

          {/* Variant-level overrides */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Variant Overrides
              </span>
              <Badge variant="secondary" className="text-[10px]">{row.variantName}</Badge>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-muted-foreground">Floor (base units)</label>
                <Input
                  type="number"
                  min={0}
                  placeholder="None"
                  value={floor}
                  onChange={(e) => setFloor(e.target.value)}
                  autoComplete="off"
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Cap (base units)</label>
                <Input
                  type="number"
                  min={0}
                  placeholder="None"
                  value={cap}
                  onChange={(e) => setCap(e.target.value)}
                  autoComplete="off"
                  className="h-8 text-sm"
                />
              </div>
            </div>
            <Button
              className="w-full mt-2"
              size="sm"
              onClick={() => saveVariantMutation.mutate()}
              disabled={saving}
            >
              {saveVariantMutation.isPending && <Loader2 className="h-3 w-3 animate-spin mr-2" />}
              Save Variant Overrides
            </Button>
          </div>

          {/* Sync info */}
          {cellData.hasFeed && cellData.lastSyncedAt && (
            <p className="text-[11px] text-muted-foreground text-center">
              Last synced: {new Date(cellData.lastSyncedAt).toLocaleString()}
              {cellData.lastSyncedQty != null && ` (qty: ${cellData.lastSyncedQty})`}
            </p>
          )}
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
        <span className="flex items-center justify-center gap-1.5">
          <Ban className="h-3 w-3" />
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
        <span className="flex items-center justify-center gap-1.5 text-muted-foreground/50">
          <span>{cellData.effectiveAtp.toLocaleString()}</span>
          <Badge variant="outline" className="text-[10px] px-1 py-0 leading-tight opacity-60">
            NO FEED
          </Badge>
        </span>
      ),
      colorClass: "text-muted-foreground/50",
    };
  }

  // Floor hit (effectiveAtp is 0 due to floor)
  const hasFloor = cellData.variantFloor != null || cellData.productFloor != null;
  if (cellData.effectiveAtp === 0 && hasFloor) {
    return {
      content: (
        <span className="flex items-center justify-center gap-1.5">
          <span>0</span>
          <Badge variant="destructive" className="text-[10px] px-1 py-0 leading-tight">
            FLOOR
          </Badge>
        </span>
      ),
      colorClass: "text-red-500",
    };
  }

  // Build annotation badges
  const badges: React.ReactNode[] = [];
  if (cellData.variantCap != null) {
    badges.push(
      <Badge key="cap" variant="secondary" className="text-[10px] px-1 py-0 leading-tight">
        cap:{cellData.variantCap}
      </Badge>
    );
  } else if (cellData.productCap != null) {
    badges.push(
      <Badge key="cap" variant="outline" className="text-[10px] px-1 py-0 leading-tight">
        cap:{cellData.productCap}
      </Badge>
    );
  }
  if (cellData.variantFloor != null && cellData.variantFloor > 0) {
    badges.push(
      <Badge key="floor" variant="secondary" className="text-[10px] px-1 py-0 leading-tight">
        floor:{cellData.variantFloor}
      </Badge>
    );
  } else if (cellData.productFloor != null && cellData.productFloor > 0) {
    badges.push(
      <Badge key="floor" variant="outline" className="text-[10px] px-1 py-0 leading-tight">
        floor:{cellData.productFloor}
      </Badge>
    );
  }

  // Determine sync freshness color
  let syncColor = "text-foreground";
  if (cellData.lastSyncedAt) {
    const syncAge = Date.now() - new Date(cellData.lastSyncedAt).getTime();
    if (syncAge <= 5 * 60 * 1000) {
      syncColor = "text-green-600 dark:text-green-400";
    } else if (syncAge <= 60 * 60 * 1000) {
      syncColor = "text-foreground";
    } else {
      syncColor = "text-amber-600 dark:text-amber-400";
    }
  }

  return {
    content: (
      <span className="flex items-center justify-center gap-1.5">
        <span className="font-medium tabular-nums">{cellData.effectiveAtp.toLocaleString()}</span>
        {badges}
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
      if (!res.ok) throw new Error((await res.text()) || res.statusText);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channel-allocation/grid"] });
      toast({ title: "Sync triggered for all channels" });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const channels = data?.channels ?? [];
  const rows = data?.rows ?? [];
  const totalCount = data?.totalCount ?? 0;
  const totalPages = Math.ceil(totalCount / pageSize);

  // Compute stats per channel
  const channelStats = channels.map((ch) => {
    let fed = 0, blocked = 0, withRules = 0;
    for (const row of rows) {
      const cell = row.channels[String(ch.id)];
      if (!cell) continue;
      if (cell.hasFeed) fed++;
      if (cell.isListed === 0) blocked++;
      if (cell.variantFloor != null || cell.variantCap != null || cell.productFloor != null || cell.productCap != null) withRules++;
    }
    return { channelId: ch.id, fed, blocked, withRules };
  });
  const statsMap = new Map(channelStats.map((s) => [s.channelId, s]));

  return (
    <div className="space-y-4 p-2 md:p-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
            Channel Allocation
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Control inventory visibility per channel. Click any cell to set floors, caps, and listing rules.
          </p>
        </div>
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

      {/* Channel summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Total Variants</p>
            <p className="text-2xl font-bold">{totalCount.toLocaleString()}</p>
          </CardContent>
        </Card>
        {channels.map((ch) => {
          const s = statsMap.get(ch.id);
          return (
            <Card key={ch.id}>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">{ch.name}</p>
                <p className="text-2xl font-bold">{s?.fed ?? 0} <span className="text-sm font-normal text-muted-foreground">synced</span></p>
                <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                  {(s?.blocked ?? 0) > 0 && (
                    <span className="text-red-500">{s!.blocked} blocked</span>
                  )}
                  {(s?.withRules ?? 0) > 0 && (
                    <span>{s!.withRules} with rules</span>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded bg-green-500/20 border border-green-500/40" />
          Synced &lt;5m
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded bg-amber-500/20 border border-amber-500/40" />
          Stale &gt;1h
        </span>
        <span className="flex items-center gap-1">
          <Ban className="h-3 w-3 text-red-500" /> Blocked
        </span>
        <span className="flex items-center gap-1">
          <Badge variant="secondary" className="text-[9px] px-1 py-0">cap:N</Badge> Cap set
        </span>
        <span className="flex items-center gap-1">
          <Badge variant="secondary" className="text-[9px] px-1 py-0">floor:N</Badge> Floor set
        </span>
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
                    <TableHead className="sticky left-0 bg-card z-10 min-w-[140px]">
                      SKU
                    </TableHead>
                    <TableHead className="min-w-[180px]">Product</TableHead>
                    <TableHead className="min-w-[120px]">Variant</TableHead>
                    <TableHead className="text-right min-w-[80px]">ATP</TableHead>
                    {channels.map((ch) => (
                      <TableHead
                        key={ch.id}
                        className="text-center min-w-[150px]"
                      >
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-default">
                                {ch.name}
                                <span className="block text-[10px] font-normal text-muted-foreground">
                                  {ch.provider}
                                </span>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{statsMap.get(ch.id)?.fed ?? 0} feeds active</p>
                              <p>{statsMap.get(ch.id)?.blocked ?? 0} blocked</p>
                              <p>{statsMap.get(ch.id)?.withRules ?? 0} with rules</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.productVariantId}>
                      <TableCell className="sticky left-0 bg-card z-10 font-mono text-xs">
                        {row.sku}
                      </TableCell>
                      <TableCell className="text-sm truncate max-w-[200px]">
                        {row.productName}
                      </TableCell>
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
                            <TableCell key={ch.id} className="text-center text-muted-foreground">
                              &mdash;
                            </TableCell>
                          );
                        }
                        return (
                          <TableCell key={ch.id} className="text-center p-0">
                            <CellEditPopover
                              channelId={ch.id}
                              channelName={ch.name}
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
                {((page - 1) * pageSize + 1).toLocaleString()}-
                {Math.min(page * pageSize, totalCount).toLocaleString()} of{" "}
                {totalCount.toLocaleString()}
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
