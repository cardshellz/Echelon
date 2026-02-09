import {
  MapPin,
  AlertTriangle,
  ArrowLeftRight,
  Edit,
  Clock,
  PackageCheck,
  ArrowDown,
  Timer,
} from "lucide-react";
import type { ActionFilter, ActionQueueCounts } from "./types";

interface LocationHealth {
  totalLocations: number;
  emptyLocations: number;
  pickLocations: number;
  emptyPickLocations: number;
  reserveLocations: number;
  negativeInventoryCount: number;
  pendingReplenTasks: number;
  recentTransferCount: number;
  recentAdjustmentCount: number;
  staleInventoryCount: number;
}

interface OpsKpiCardsProps {
  healthData: LocationHealth | undefined;
  queueCounts: ActionQueueCounts | undefined;
  isLoading: boolean;
  activeFilter: ActionFilter;
  onFilterChange: (filter: ActionFilter) => void;
}

const ACTIONABLE_CARDS: {
  key: Exclude<ActionFilter, "all">;
  label: string;
  sub: string;
  icon: typeof AlertTriangle;
  alertColor: string;
  normalColor: string;
}[] = [
  { key: "negative_inventory", label: "Negative Inv", sub: "need adjustment", icon: AlertTriangle, alertColor: "text-red-600", normalColor: "text-green-600" },
  { key: "aging_receiving", label: "Aging Receiving", sub: "in receiving > 24h", icon: PackageCheck, alertColor: "text-red-600", normalColor: "text-green-600" },
  { key: "pallet_drop", label: "Pallet Drop", sub: "reserve → floor needed", icon: ArrowDown, alertColor: "text-amber-600", normalColor: "text-green-600" },
  { key: "stuck_replen", label: "Stuck Replen", sub: "pending > 4 hours", icon: Timer, alertColor: "text-amber-600", normalColor: "text-green-600" },
  { key: "stale_bin", label: "Stale Bins", sub: "90+ days no movement", icon: Clock, alertColor: "text-amber-600", normalColor: "text-muted-foreground" },
];

export default function OpsKpiCards({
  healthData,
  queueCounts,
  isLoading,
  activeFilter,
  onFilterChange,
}: OpsKpiCardsProps) {
  const handleClick = (key: Exclude<ActionFilter, "all">) => {
    onFilterChange(activeFilter === key ? "all" : key);
  };

  return (
    <div className="space-y-3">
      {/* Actionable cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {ACTIONABLE_CARDS.map((card) => {
          const count = queueCounts?.[card.key] ?? 0;
          const isActive = activeFilter === card.key;
          const hasAlert = count > 0;
          const color = hasAlert ? card.alertColor : card.normalColor;

          return (
            <button
              key={card.key}
              type="button"
              onClick={() => handleClick(card.key)}
              className={`text-left bg-muted/30 p-3 rounded-lg border transition-all
                cursor-pointer hover:bg-muted/50
                ${isActive ? "ring-2 ring-primary border-primary" : ""}
                ${hasAlert && !isActive ? "border-red-300 bg-red-50/50 dark:bg-red-950/20 dark:border-red-800/40" : ""}
              `}
            >
              {isLoading && !queueCounts ? (
                <div className="animate-pulse space-y-2">
                  <div className="h-3 w-20 bg-muted rounded" />
                  <div className="h-6 w-12 bg-muted rounded" />
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 mb-1">
                    <card.icon className={`h-3.5 w-3.5 ${color}`} />
                    <span className="text-xs text-muted-foreground font-medium">{card.label}</span>
                  </div>
                  <div className="font-mono text-lg font-bold">
                    {count.toLocaleString()}
                  </div>
                  <div className="text-xs text-muted-foreground">{card.sub}</div>
                </>
              )}
            </button>
          );
        })}
      </div>

      {/* Summary stats line */}
      {healthData && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground px-1">
          <span className="flex items-center gap-1">
            <MapPin className="h-3 w-3" />
            {healthData.totalLocations - healthData.emptyLocations}/{healthData.totalLocations} locations occupied
          </span>
          <span className="flex items-center gap-1">
            <ArrowLeftRight className="h-3 w-3" />
            {healthData.recentTransferCount} transfers today
          </span>
          <span className="flex items-center gap-1">
            <Edit className="h-3 w-3" />
            {healthData.recentAdjustmentCount} adjustments today
          </span>
        </div>
      )}
    </div>
  );
}
