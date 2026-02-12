import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { History, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

interface ActivityItem {
  id: number;
  transactionType: string;
  variantQtyDelta: number;
  variantQtyBefore: number | null;
  variantQtyAfter: number | null;
  sourceState: string | null;
  targetState: string | null;
  notes: string | null;
  userId: string | null;
  createdAt: string;
  sku: string | null;
  variantName: string | null;
  fromLocationCode: string | null;
  toLocationCode: string | null;
  orderId: number | null;
  referenceType: string | null;
  referenceId: string | null;
}

interface BinHistorySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locationId: number | null;
  locationCode: string;
}

const TYPE_COLORS: Record<string, string> = {
  receipt: "bg-green-100 text-green-800",
  pick: "bg-blue-100 text-blue-800",
  adjustment: "bg-yellow-100 text-yellow-800",
  transfer: "bg-purple-100 text-purple-800",
  ship: "bg-indigo-100 text-indigo-800",
  return: "bg-orange-100 text-orange-800",
  replenish: "bg-teal-100 text-teal-800",
  reserve: "bg-cyan-100 text-cyan-800",
  unreserve: "bg-gray-100 text-gray-800",
  csv_upload: "bg-emerald-100 text-emerald-800",
  break: "bg-pink-100 text-pink-800",
  assemble: "bg-rose-100 text-rose-800",
};

export default function BinHistorySheet({ open, onOpenChange, locationId, locationCode }: BinHistorySheetProps) {
  const [typeFilter, setTypeFilter] = useState("all");

  const { data: items, isLoading } = useQuery<ActivityItem[]>({
    queryKey: ["/api/operations/activity", locationId],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (locationId) params.set("locationId", locationId.toString());
      params.set("limit", "50");
      const res = await fetch(`/api/operations/activity?${params}`);
      if (!res.ok) throw new Error("Failed to fetch activity");
      return res.json();
    },
    enabled: open && !!locationId,
    staleTime: 10_000,
  });

  const filtered = items?.filter((item) => typeFilter === "all" || item.transactionType === typeFilter) ?? [];

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return `${diffD}d ago`;
    return d.toLocaleDateString();
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            Bin History — {locationCode}
          </SheetTitle>
        </SheetHeader>

        <div className="mt-4 space-y-3">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[160px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="transfer">Transfers</SelectItem>
              <SelectItem value="adjustment">Adjustments</SelectItem>
              <SelectItem value="receipt">Receipts</SelectItem>
              <SelectItem value="pick">Picks</SelectItem>
              <SelectItem value="replenish">Replenishments</SelectItem>
              <SelectItem value="ship">Shipments</SelectItem>
            </SelectContent>
          </Select>

          {isLoading ? (
            <div className="text-sm text-muted-foreground py-8 text-center">Loading...</div>
          ) : filtered.length === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center">
              No activity for this bin
            </div>
          ) : (
            <div className="divide-y border rounded-lg">
              {filtered.map((item) => (
                <div key={item.id} className="p-3 flex items-start gap-3 text-sm">
                  <Badge
                    variant="outline"
                    className={`text-[10px] shrink-0 mt-0.5 ${TYPE_COLORS[item.transactionType] || "bg-muted"}`}
                  >
                    {item.transactionType}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {item.sku && <span className="font-mono text-xs">{item.sku}</span>}
                      {item.fromLocationCode && (
                        <>
                          <span className="font-mono text-xs text-muted-foreground">{item.fromLocationCode}</span>
                          {item.toLocationCode && (
                            <>
                              <ArrowRight className="h-3 w-3 text-muted-foreground" />
                              <span className="font-mono text-xs text-muted-foreground">{item.toLocationCode}</span>
                            </>
                          )}
                        </>
                      )}
                      {!item.fromLocationCode && item.toLocationCode && (
                        <span className="font-mono text-xs text-muted-foreground">{item.toLocationCode}</span>
                      )}
                    </div>
                    {item.notes && (
                      <div className="text-xs text-muted-foreground truncate">{item.notes}</div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`font-mono text-sm font-medium ${item.variantQtyDelta > 0 ? "text-green-600" : item.variantQtyDelta < 0 ? "text-red-600" : ""}`}>
                      {item.variantQtyDelta > 0 ? "+" : ""}{item.variantQtyDelta}
                    </div>
                    <div className="text-[10px] text-muted-foreground">{formatTime(item.createdAt)}</div>
                    {item.userId && (
                      <div className="text-[10px] text-muted-foreground">{item.userId}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
