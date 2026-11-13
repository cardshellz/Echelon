import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { copySources, copyStockRules, hasNoStockRules, type CopyStockRulesOutcome } from "../copy-stock-rules";
import { useCommandKey } from "../hooks";
import type { Channel, View } from "../model";
import { SectionCard } from "./primitives";

/**
 * Offered only while a channel has no stock rules: copy another channel's
 * default and exceptions in one step. Renders nothing once the channel has a
 * rule, or when no other channel has rules to copy.
 */
export function CopyStockRulesCard({ view, channel, canChange, onDone }: {
  view: View;
  channel: Channel;
  /** Copying saves and applies, so it needs inventory planning edit and activate. */
  canChange: boolean;
  onDone(outcome: CopyStockRulesOutcome): Promise<void> | void;
}) {
  const sources = copySources(view.channels, view.policyHeads, channel.id);
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const command = useCommandKey();
  if (!canChange || sources.length === 0 || !hasNoStockRules(view.policyHeads, channel.id)) return null;

  const copy = async () => {
    if (sourceId === null || inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try {
      const outcome = await copyStockRules({ sourceChannelId: sourceId, targetChannelId: channel.id,
        idempotencyKey: command.keyFor(`${sourceId}:${channel.id}`) });
      // Only an unknown outcome keeps the key: a retry must replay it, anything else is a new command.
      if (outcome.status !== "unknown") command.clear();
      await onDone(outcome);
    } finally { inFlight.current = false; setBusy(false); }
  };

  return (
    <SectionCard
      title="Copy stock rules from another channel"
      description={`${channel.name} has no stock rules yet. Copy another channel's default and exceptions, then change what differs. They take effect when you copy.`}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`copy-rules-source-${channel.id}`}>Copy stock rules from</Label>
          <Select value={sourceId === null ? "" : String(sourceId)} onValueChange={value => setSourceId(Number(value))} disabled={busy}>
            <SelectTrigger id={`copy-rules-source-${channel.id}`} className="min-h-[44px] w-64"><SelectValue placeholder="Choose a channel" /></SelectTrigger>
            <SelectContent>
              {sources.map(source => <SelectItem key={source.id} value={String(source.id)}>{source.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button type="button" className="min-h-[44px]" disabled={sourceId === null || busy} onClick={() => void copy()}>
          {busy ? "Copying…" : "Copy"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Copies each rule as it is: Stock %, Buffer, Max, Hide when below and how stock is shared. Which warehouses supply {channel.name} is set under Warehouses and is not copied.
      </p>
    </SectionCard>
  );
}
