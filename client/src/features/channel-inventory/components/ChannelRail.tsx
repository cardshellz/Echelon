import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { providerLabel, type ChannelRailEntry } from "../model";
import { ToneDot } from "./primitives";

/** Left-hand list of sales channels; a Select on narrow screens. */

export function ProviderGlyph({ provider, className }: { provider: string; className?: string }) {
  const label = providerLabel(provider);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold uppercase text-muted-foreground",
        className,
      )}
    >
      {label.slice(0, 2)}
    </span>
  );
}

function destinationSummary(entry: ChannelRailEntry): string {
  const count = entry.targets.length;
  if (count === 0) return "No destinations";
  return `${count} destination${count === 1 ? "" : "s"}`;
}

export function ChannelRail({ entries, selectedId, onSelect }: {
  entries: readonly ChannelRailEntry[];
  selectedId: number | null;
  onSelect(channelId: number): void;
}) {
  return (
    <nav aria-label="Sales channels" className="space-y-1">
      {entries.map((entry) => {
        const selected = entry.channel.id === selectedId;
        return (
          <button
            key={entry.channel.id}
            type="button"
            aria-current={selected ? "page" : undefined}
            onClick={() => onSelect(entry.channel.id)}
            className={cn(
              "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors",
              "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected ? "border-primary/60 bg-accent" : "border-transparent",
            )}
          >
            <ProviderGlyph provider={entry.channel.provider} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{entry.channel.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {providerLabel(entry.channel.provider)} · {destinationSummary(entry)}
              </span>
            </span>
            <span className="flex items-center gap-1" aria-label={railStatusLabel(entry)} title={railStatusLabel(entry)}>
              {entry.liveCount > 0 && <ToneDot tone="live" />}
              {entry.previewCount > 0 && <ToneDot tone="preview" />}
              {entry.externalCount > 0 && <ToneDot tone="external" />}
              {entry.offCount > 0 && <ToneDot tone="off" />}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function railStatusLabel(entry: ChannelRailEntry): string {
  const parts: string[] = [];
  if (entry.liveCount > 0) parts.push(`${entry.liveCount} publishing`);
  if (entry.previewCount > 0) parts.push(`${entry.previewCount} calculating only`);
  if (entry.externalCount > 0) parts.push(`${entry.externalCount} externally managed`);
  if (entry.offCount > 0) parts.push(`${entry.offCount} not publishing`);
  return parts.length === 0 ? "No destinations" : parts.join(", ");
}

export function ChannelSelect({ entries, selectedId, onSelect }: {
  entries: readonly ChannelRailEntry[];
  selectedId: number | null;
  onSelect(channelId: number): void;
}) {
  return (
    <Select value={selectedId === null ? "" : String(selectedId)} onValueChange={(value) => onSelect(Number(value))}>
      <SelectTrigger aria-label="Sales channel" className="w-full">
        <SelectValue placeholder="Choose a sales channel" />
      </SelectTrigger>
      <SelectContent>
        {entries.map((entry) => (
          <SelectItem key={entry.channel.id} value={String(entry.channel.id)}>
            {entry.channel.name} · {providerLabel(entry.channel.provider)} · {destinationSummary(entry)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
