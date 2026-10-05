import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { describeDestination, type Channel, type Target, type View } from "../model";
import { StockUpdatesControl } from "./StockUpdatesControl";

/**
 * The channel's destinations (exact external accounts/locations that receive
 * quantities). Selecting a card scopes Warehouses and Stock preview. The
 * account switch is a sibling of the selector, never nested inside a button.
 */
export function DestinationStrip({ view, channel, targets, selectedId, onSelect, canEdit, canActivate, onAdd, stockDetailsTargetId, onStockDetailsChange, onOpenTab }: {
  channel: Channel;
  canActivate: boolean;
  stockDetailsTargetId: number | null;
  onStockDetailsChange(targetId: number | null): void;
  onOpenTab(tab: "supply" | "rules" | "quantities"): void;
  view: View;
  targets: readonly Target[];
  selectedId: number | null;
  onSelect(targetId: number): void;
  canEdit: boolean;
  onAdd(): void;
}) {
  return (
    <div className="flex flex-wrap items-stretch gap-2" role="group" aria-label="Destinations">
      {targets.map((target) => {
        const identity = describeDestination(target, view);
        const selected = target.id === selectedId;
        return (
          <div key={target.id} className={cn(
            "w-full min-w-0 max-w-full overflow-hidden rounded-md border sm:w-auto sm:min-w-[16rem] sm:max-w-sm",
            selected ? "border-primary bg-accent shadow-xs" : "border-border",
          )}>
            <button type="button" aria-pressed={selected} onClick={() => onSelect(target.id)}
              className="flex w-full min-w-0 flex-col gap-1 px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <span className="w-full truncate text-sm font-medium">{identity.title}</span>
              <span className="w-full truncate text-xs text-muted-foreground">{identity.scope}</span>
            </button>
            <StockUpdatesControl key={`${target.id}:${target.revision}`} view={view} channel={channel} target={target}
              canActivate={canActivate} detailsOpen={stockDetailsTargetId === target.id}
              onDetailsOpenChange={open => onStockDetailsChange(open ? target.id : null)} onOpenTab={onOpenTab} />
          </div>
        );
      })}
      {canEdit && (
        <Button type="button" variant="outline" className="h-auto min-h-[3.25rem] w-full self-start border-dashed sm:w-auto" onClick={onAdd}>
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
          Set up destinations
        </Button>
      )}
    </div>
  );
}
