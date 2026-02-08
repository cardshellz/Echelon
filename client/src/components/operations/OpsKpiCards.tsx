import {
  MapPin,
  PackageX,
  AlertTriangle,
  RefreshCw,
  ArrowLeftRight,
  Edit,
  Clock,
  Box,
} from "lucide-react";

interface LocationHealth {
  totalLocations: number;
  emptyLocations: number;
  pickLocations: number;
  emptyPickLocations: number;
  bulkLocations: number;
  negativeInventoryCount: number;
  pendingReplenTasks: number;
  recentTransferCount: number;
  recentAdjustmentCount: number;
  staleInventoryCount: number;
}

interface OpsKpiCardsProps {
  data: LocationHealth | undefined;
  isLoading: boolean;
}

export default function OpsKpiCards({ data, isLoading }: OpsKpiCardsProps) {
  const cards = [
    {
      label: "Locations",
      value: data ? `${data.totalLocations - data.emptyLocations} / ${data.totalLocations}` : "—",
      sub: "occupied / total",
      icon: MapPin,
      color: "text-blue-600",
    },
    {
      label: "Empty Pick Faces",
      value: data?.emptyPickLocations ?? "—",
      sub: `of ${data?.pickLocations ?? "—"} pick locations`,
      icon: PackageX,
      color: data && data.emptyPickLocations > 0 ? "text-red-600" : "text-green-600",
      alert: data && data.emptyPickLocations > 0,
    },
    {
      label: "Pending Replen",
      value: data?.pendingReplenTasks ?? "—",
      sub: "tasks queued",
      icon: RefreshCw,
      color: data && data.pendingReplenTasks > 0 ? "text-amber-600" : "text-muted-foreground",
    },
    {
      label: "Negative Inventory",
      value: data?.negativeInventoryCount ?? "—",
      sub: "records to investigate",
      icon: AlertTriangle,
      color: data && data.negativeInventoryCount > 0 ? "text-red-600" : "text-green-600",
      alert: data && data.negativeInventoryCount > 0,
    },
    {
      label: "Transfers (24h)",
      value: data?.recentTransferCount ?? "—",
      sub: "movements today",
      icon: ArrowLeftRight,
      color: "text-purple-600",
    },
    {
      label: "Adjustments (24h)",
      value: data?.recentAdjustmentCount ?? "—",
      sub: "qty changes today",
      icon: Edit,
      color: "text-indigo-600",
    },
    {
      label: "Stale Bins",
      value: data?.staleInventoryCount ?? "—",
      sub: "no movement 90+ days",
      icon: Clock,
      color: data && data.staleInventoryCount > 0 ? "text-amber-600" : "text-muted-foreground",
    },
    {
      label: "Bulk Locations",
      value: data?.bulkLocations ?? "—",
      sub: "reserve storage",
      icon: Box,
      color: "text-muted-foreground",
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((card) => (
        <div
          key={card.label}
          className={`bg-muted/30 p-3 rounded-lg border ${card.alert ? "border-red-300 bg-red-50/50 dark:bg-red-950/20" : ""}`}
        >
          {isLoading ? (
            <div className="animate-pulse space-y-2">
              <div className="h-3 w-20 bg-muted rounded" />
              <div className="h-6 w-12 bg-muted rounded" />
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1.5 mb-1">
                <card.icon className={`h-3.5 w-3.5 ${card.color}`} />
                <span className="text-xs text-muted-foreground font-medium">{card.label}</span>
              </div>
              <div className="font-mono text-lg font-bold">
                {typeof card.value === "number" ? card.value.toLocaleString() : card.value}
              </div>
              <div className="text-xs text-muted-foreground">{card.sub}</div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
