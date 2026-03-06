import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
  Eye,
  EyeOff,
  Settings2,
  Lock,
} from "lucide-react";
import { cn } from "@/lib/utils";

// --- Types ---

interface Channel {
  id: number;
  name: string;
  provider: string;
  status: string;
  allocationPct: number | null;
  allocationFixedQty: number | null;
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
  overrideQty: number | null;
  effectiveAtp: number;
  status: string;
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

// --- Channel allocation dialog ---

function ChannelAllocationDialog({ channel }: { channel: Channel }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"none" | "pct" | "fixed">(
    channel.allocationFixedQty != null ? "fixed" : channel.allocationPct != null ? "pct" : "none"
  );
  const [pct, setPct] = useState(channel.allocationPct ?? 100);
  const [fixedQty, setFixedQty] = useState(String(channel.allocationFixedQty ?? ""));

  useEffect(() => {
    if (open) {
      setMode(channel.allocationFixedQty != null ? "fixed" : channel.allocationPct != null ? "pct" : "none");
      setPct(channel.allocationPct ?? 100);
      setFixedQty(String(channel.allocationFixedQty ?? ""));
    }
  }, [open, channel]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: any = {};
      if (mode === "pct") {
        body.allocationPct = pct;
        body.allocationFixedQty = null;
      } else if (mode === "fixed") {
        body.allocationPct = null;
        body.allocationFixedQty = fixedQty === "" ? null : parseInt(fixedQty, 10);
      } else {
        body.allocationPct = null;
        body.allocationFixedQty = null;
      }
      const res = await fetch(`/api/channels/${channel.id}/allocation`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.text()) || res.statusText);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channel-allocation/grid"] });
      setOpen(false);
      toast({ title: `${channel.name} allocation updated` });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-6 px-2">
          <Settings2 className="h-3 w-3" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{channel.name} — Allocation</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <p className="text-sm text-muted-foreground">
            Control how much of your total inventory pool this channel can see.
          </p>

          {/* Mode selector */}
          <div className="grid grid-cols-3 gap-2">
            <Button
              variant={mode === "none" ? "default" : "outline"}
              size="sm"
              onClick={() => setMode("none")}
            >
              No Limit
            </Button>
            <Button
              variant={mode === "pct" ? "default" : "outline"}
              size="sm"
              onClick={() => setMode("pct")}
            >
              Percentage
            </Button>
            <Button
              variant={mode === "fixed" ? "default" : "outline"}
              size="sm"
              onClick={() => setMode("fixed")}
            >
              Fixed Qty
            </Button>
          </div>

          {mode === "pct" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Allocation</Label>
                <span className="text-2xl font-bold">{pct}%</span>
              </div>
              <Slider
                value={[pct]}
                onValueChange={([v]) => setPct(v)}
                min={0}
                max={100}
                step={5}
              />
              <p className="text-xs text-muted-foreground">
                This channel will see up to {pct}% of each product's available inventory.
              </p>
            </div>
          )}

          {mode === "fixed" && (
            <div className="space-y-2">
              <Label>Fixed quantity (base units)</Label>
              <Input
                type="number"
                min={0}
                placeholder="e.g. 500"
                value={fixedQty}
                onChange={(e) => setFixedQty(e.target.value)}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Cap each product's availability at this many base units for this channel.
              </p>
            </div>
          )}

          {mode === "none" && (
            <p className="text-sm text-muted-foreground bg-muted/50 rounded-md p-3">
              No allocation limit — this channel sees the full inventory pool.
            </p>
          )}

          <Button
            className="w-full"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Save Allocation
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
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

  // Variant override
  const [useOverride, setUseOverride] = useState(false);
  const [overrideQty, setOverrideQty] = useState("");

  // Variant floor/cap
  const [floor, setFloor] = useState("");
  const [cap, setCap] = useState("");

  // Product-level
  const [isListed, setIsListed] = useState(true);
  const [productFloor, setProductFloor] = useState("");
  const [productCap, setProductCap] = useState("");

  useEffect(() => {
    if (open) {
      setUseOverride(cellData.overrideQty != null);
      setOverrideQty(cellData.overrideQty != null ? String(cellData.overrideQty) : "");
      setFloor(cellData.variantFloor != null ? String(cellData.variantFloor) : "");
      setCap(cellData.variantCap != null ? String(cellData.variantCap) : "");
      setIsListed(cellData.isListed !== 0);
      setProductFloor(cellData.productFloor != null ? String(cellData.productFloor) : "");
      setProductCap(cellData.productCap != null ? String(cellData.productCap) : "");
    }
  }, [open, cellData]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/channel-allocation/grid"] });

  // Save variant reservation (override + floor + cap)
  const saveVariantMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/channel-reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          channelId,
          productVariantId: row.productVariantId,
          reserveBaseQty: 0,
          overrideQty: useOverride ? (overrideQty === "" ? 0 : parseInt(overrideQty, 10)) : null,
          minStockBase: floor === "" ? 0 : parseInt(floor, 10),
          maxStockBase: cap === "" ? null : parseInt(cap, 10),
        }),
      });
      if (!res.ok) throw new Error((await res.text()) || res.statusText);
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      setOpen(false);
      toast({ title: "Variant settings saved" });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  // Save product allocation (isListed + floor + cap)
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
      invalidate();
      setOpen(false);
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
      invalidate();
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
          <p className="text-sm font-medium font-mono">{row.sku}</p>
          <p className="text-xs text-muted-foreground truncate">
            {row.productName} → {channelName}
          </p>
          <div className="flex items-center gap-3 mt-1.5 text-xs">
            <span>Raw ATP: <strong>{row.atpUnits}</strong> units</span>
            <span>Effective: <strong className={cellData.effectiveAtp === 0 ? "text-red-500" : "text-green-600"}>{cellData.effectiveAtp}</strong></span>
          </div>
        </div>

        <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
          {/* Feed status */}
          {!cellData.hasFeed && (
            <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md p-3">
              <p className="text-xs text-amber-800 dark:text-amber-200 mb-2">
                No feed — won't sync to this channel.
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

          {/* === VARIANT OVERRIDE (top priority) === */}
          <div className="border rounded-md p-3 space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold uppercase tracking-wide flex items-center gap-1.5">
                <Lock className="h-3 w-3" /> Hard Override
              </Label>
              <Switch
                checked={useOverride}
                onCheckedChange={setUseOverride}
              />
            </div>
            {useOverride && (
              <>
                <p className="text-xs text-muted-foreground">
                  Push exactly this quantity regardless of ATP. Set to 0 to stop selling this variant on this channel.
                </p>
                <Input
                  type="number"
                  min={0}
                  placeholder="0"
                  value={overrideQty}
                  onChange={(e) => setOverrideQty(e.target.value)}
                  autoComplete="off"
                  className="h-8 text-sm"
                />
              </>
            )}
            {!useOverride && (
              <p className="text-xs text-muted-foreground">
                Uses calculated allocation. Enable to force a specific quantity.
              </p>
            )}
          </div>

          {/* === VARIANT FLOOR / CAP === */}
          {!useOverride && (
            <div>
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 block">
                Variant Guards
              </span>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground">Floor (min to show)</label>
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
                  <label className="text-xs text-muted-foreground">Cap (max to show)</label>
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
            </div>
          )}

          <Button
            className="w-full"
            size="sm"
            onClick={() => saveVariantMutation.mutate()}
            disabled={saving}
          >
            {saveVariantMutation.isPending && <Loader2 className="h-3 w-3 animate-spin mr-2" />}
            Save Variant Settings
          </Button>

          <Separator />

          {/* === PRODUCT RULES (affects all variants) === */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Product Rules
              </span>
              <Badge variant="outline" className="text-[10px]">All variants</Badge>
            </div>

            <div className="flex items-center justify-between mb-3">
              <Label className="text-sm">
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
              <Switch checked={isListed} onCheckedChange={setIsListed} />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-muted-foreground">Floor (base)</label>
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
                <label className="text-xs text-muted-foreground">Cap (base)</label>
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
  // Hard override active
  if (cellData.overrideQty != null) {
    return {
      content: (
        <span className="flex items-center justify-center gap-1.5">
          <Lock className="h-3 w-3" />
          <span className="font-bold tabular-nums">{cellData.overrideQty}</span>
          <Badge variant="secondary" className="text-[10px] px-1 py-0 leading-tight bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300">
            OVERRIDE
          </Badge>
        </span>
      ),
      colorClass: cellData.overrideQty === 0 ? "text-red-500" : "text-blue-600 dark:text-blue-400",
    };
  }

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

  // No feed
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

  // Floor hit
  if (cellData.status === "product_floor" || cellData.status === "variant_floor") {
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
        ≤{cellData.variantCap}
      </Badge>
    );
  }
  if (cellData.variantFloor != null && cellData.variantFloor > 0) {
    badges.push(
      <Badge key="floor" variant="secondary" className="text-[10px] px-1 py-0 leading-tight">
        ≥{cellData.variantFloor}
      </Badge>
    );
  }

  // Sync freshness
  let syncColor = "text-foreground";
  if (cellData.lastSyncedAt) {
    const syncAge = Date.now() - new Date(cellData.lastSyncedAt).getTime();
    if (syncAge <= 5 * 60 * 1000) {
      syncColor = "text-green-600 dark:text-green-400";
    } else if (syncAge > 60 * 60 * 1000) {
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

  return (
    <div className="space-y-4 p-2 md:p-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
            Channel Allocation
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Allocate inventory across channels. Click cells for variant overrides.
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

      {/* Channel allocation cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {channels.map((ch) => {
          const allocLabel = ch.allocationFixedQty != null
            ? `${ch.allocationFixedQty.toLocaleString()} units`
            : ch.allocationPct != null
              ? `${ch.allocationPct}%`
              : "No limit";

          return (
            <Card key={ch.id}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{ch.name}</p>
                    <p className="text-xs text-muted-foreground">{ch.provider}</p>
                  </div>
                  <ChannelAllocationDialog channel={ch} />
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Allocation:</span>
                  <Badge
                    variant={ch.allocationPct != null || ch.allocationFixedQty != null ? "default" : "outline"}
                    className="text-xs"
                  >
                    {allocLabel}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          );
        })}
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
                    <TableHead className="sticky left-0 bg-card z-10 min-w-[140px]">SKU</TableHead>
                    <TableHead className="min-w-[180px]">Product</TableHead>
                    <TableHead className="min-w-[120px]">Variant</TableHead>
                    <TableHead className="text-right min-w-[70px]">ATP</TableHead>
                    {channels.map((ch) => (
                      <TableHead key={ch.id} className="text-center min-w-[130px]">
                        <div>{ch.name}</div>
                        {ch.allocationPct != null && (
                          <span className="text-[10px] font-normal text-muted-foreground">{ch.allocationPct}% alloc</span>
                        )}
                        {ch.allocationFixedQty != null && (
                          <span className="text-[10px] font-normal text-muted-foreground">{ch.allocationFixedQty} units</span>
                        )}
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
                      <TableCell className="text-sm truncate max-w-[200px]">{row.productName}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{row.variantName}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{row.atpBase.toLocaleString()}</TableCell>
                      {channels.map((ch) => {
                        const cellData = row.channels[String(ch.id)];
                        if (!cellData) {
                          return <TableCell key={ch.id} className="text-center text-muted-foreground">&mdash;</TableCell>;
                        }
                        return (
                          <TableCell key={ch.id} className="text-center p-0">
                            <CellEditPopover channelId={ch.id} channelName={ch.name} row={row} cellData={cellData} />
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
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft className="h-4 w-4 mr-1" /> Previous
                </Button>
                <span className="text-sm text-muted-foreground px-2">Page {page} of {totalPages}</span>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                  Next <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><Lock className="h-3 w-3 text-blue-500" /> Override set</span>
        <span className="flex items-center gap-1"><Ban className="h-3 w-3 text-red-500" /> Blocked</span>
        <span className="flex items-center gap-1"><Badge variant="destructive" className="text-[9px] px-1 py-0">FLOOR</Badge> Below minimum</span>
        <span className="flex items-center gap-1 text-green-600">● Synced &lt;5m</span>
        <span className="flex items-center gap-1 text-amber-600">● Stale &gt;1h</span>
      </div>
    </div>
  );
}
