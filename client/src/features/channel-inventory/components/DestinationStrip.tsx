import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { describeDestination, describePublishing, type Target, type View } from "../model";
import { StatePill } from "./primitives";

/**
 * The channel's destinations (exact external accounts/locations that receive
 * quantities). One chip per destination; selecting one scopes the Supply,
 * Quantities and Publishing tabs. With a single destination the chip is a
 * label, not a picker.
 */
export function DestinationStrip({ view, targets, selectedId, onSelect, canEdit, onAdd }: {
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
        const publishing = describePublishing(target);
        const selected = target.id === selectedId;
        return (
          <button
            key={target.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(target.id)}
            className={cn(
              "flex min-w-[14rem] max-w-full flex-1 flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors sm:flex-none",
              "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected ? "border-primary bg-accent shadow-xs" : "border-border",
            )}
          >
            <span className="flex items-center justify-between gap-3">
              <span className="truncate text-sm font-medium">{identity.title}</span>
              <StatePill tone={publishing.tone}>{publishing.label}</StatePill>
            </span>
            <span className="truncate text-xs text-muted-foreground">{identity.scope}</span>
          </button>
        );
      })}
      {canEdit && (
        <Button type="button" variant="outline" className="h-auto min-h-[3.25rem] border-dashed" onClick={onAdd}>
          <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
          Add destination
        </Button>
      )}
    </div>
  );
}
