import { useState, useMemo } from "react";
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
import { RefreshCw, Loader2, Search } from "lucide-react";
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

  // Determine cell display
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
          <p className="text-sm font-medium">{row.sku}</p>
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
  // No feed or unlisted
  if (!cellData.hasFeed || cellData.isListed === 0) {
    return {
      content: <span className="text-muted-foreground">&mdash;</span>,
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

  const { data, isLoading } = useQuery<AllocationGrid>({
    queryKey: ["/api/channel-allocation/grid"],
    queryFn: async () => {
      const res = await fetch("/api/channel-allocation/grid", {
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

  const filteredRows = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter(
      (r) =>
        r.sku.toLowerCase().includes(q) ||
        r.productName.toLowerCase().includes(q)
    );
  }, [rows, search]);

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

      {/* Grid */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="text-center py-16">
              <p className="text-muted-foreground">
                {search.trim()
                  ? "No variants match your search."
                  : "No allocation data available."}
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
                  {filteredRows.map((row) => (
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
        </CardContent>
      </Card>
    </div>
  );
}
