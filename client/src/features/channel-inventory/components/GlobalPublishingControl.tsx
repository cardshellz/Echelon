import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Power } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

import { changeGlobalPublishing, describeError } from "../api";
import { formatRelativeTime } from "../format";
import { PUBLISHING_STATUS_QUERY_KEY, useCommandKey, usePublishingStatus } from "../hooks";
import { Callout, StatePill } from "./primitives";

const SWEEP_INTERVAL_OPTIONS_MINUTES = [5, 10, 15, 30, 60] as const;

/**
 * The one global publishing switch, shared by every channel. It is never
 * scoped to the channel on screen. Changing it is a sensitive publication
 * command (activate permission, required reason), so it opens a dialog rather
 * than flipping in place. Pausing publishing does not publish zero.
 */
export function GlobalPublishingControl({ canActivate, now }: { canActivate: boolean; now: () => Date }) {
  const status = usePublishingStatus();
  const [open, setOpen] = useState(false);
  const global = status.data?.global ?? null;

  if (status.isLoading) {
    return <StatePill tone="neutral">Reading publishing switch…</StatePill>;
  }
  if (status.error || !global) {
    return (
      <StatePill tone="blocked" title={status.error ? describeError(status.error).message : undefined}>
        Publishing switch unknown
      </StatePill>
    );
  }
  const lastSweep = global.lastSweepAt ? formatRelativeTime(global.lastSweepAt, now()) : "never";
  const summary = global.globalEnabled
    ? `Publishing on · every ${global.sweepIntervalMinutes} min · last run ${lastSweep}`
    : "Publishing off for every channel";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-haspopup="dialog"
        title={canActivate ? "Open the global publishing switch" : "View the global publishing switch"}
      >
        <StatePill tone={global.globalEnabled ? "live" : "off"}>
          <Power className="h-3 w-3" aria-hidden="true" />
          {summary}
        </StatePill>
      </button>
      {open && (
        <GlobalPublishingDialog
          open={open}
          onOpenChange={setOpen}
          canActivate={canActivate}
          globalEnabled={global.globalEnabled}
          sweepIntervalMinutes={global.sweepIntervalMinutes}
          revision={global.revision}
          changedBy={global.changedBy}
          changeReason={global.changeReason}
          summary={status.data?.summary ?? null}
        />
      )}
    </>
  );
}

function GlobalPublishingDialog(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  canActivate: boolean;
  globalEnabled: boolean;
  sweepIntervalMinutes: number;
  revision: string;
  changedBy: string;
  changeReason: string;
  summary: { pushed: number; dryRun: number; errors: number; skipped: number } | null;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const command = useCommandKey();
  const [enabled, setEnabled] = useState(props.globalEnabled);
  const [interval, setInterval] = useState(props.sweepIntervalMinutes);
  const [reason, setReason] = useState("");
  const changed = enabled !== props.globalEnabled || interval !== props.sweepIntervalMinutes;
  const trimmedReason = reason.trim();

  const change = useMutation({
    mutationFn: () => {
      const payload = {
        ...(enabled !== props.globalEnabled ? { globalEnabled: enabled } : {}),
        ...(interval !== props.sweepIntervalMinutes ? { sweepIntervalMinutes: interval } : {}),
        expectedRevision: props.revision,
        changeReason: trimmedReason,
      };
      return changeGlobalPublishing({ ...payload, idempotencyKey: command.keyFor(JSON.stringify(payload)) });
    },
    onSuccess: async (result) => {
      command.clear();
      await queryClient.invalidateQueries({ queryKey: PUBLISHING_STATUS_QUERY_KEY });
      toast({
        title: result.globalEnabled ? "Publishing is on" : "Publishing is off",
        description: `Applies to every channel. Control revision ${result.revision}.`,
      });
      props.onOpenChange(false);
    },
    onError: (error) => {
      const described = describeError(error);
      toast({ title: described.title, description: described.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={props.open} onOpenChange={(next) => { if (!change.isPending) props.onOpenChange(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Global publishing switch</DialogTitle>
          <DialogDescription>
            One switch for every channel and destination. Turning it off stops new quantity
            updates; it does not set marketplace stock to zero.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-md border p-3">
            <Label htmlFor="global-publishing-enabled" className="text-sm font-medium">
              Send quantity updates
            </Label>
            <Switch
              id="global-publishing-enabled"
              checked={enabled}
              disabled={!props.canActivate || change.isPending}
              onCheckedChange={setEnabled}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="global-publishing-interval" className="text-sm">Check for changes every</Label>
            <Select
              value={String(interval)}
              disabled={!props.canActivate || change.isPending}
              onValueChange={(value) => setInterval(Number(value))}
            >
              <SelectTrigger id="global-publishing-interval" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SWEEP_INTERVAL_OPTIONS_MINUTES.map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>{minutes} min</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {props.summary && (
            <p className="text-xs text-muted-foreground">
              Last 24 hours: {props.summary.pushed} sent · {props.summary.dryRun} calculated only
              {props.summary.errors > 0 ? ` · ${props.summary.errors} errors` : ""}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Revision {props.revision} · last changed by {props.changedBy}: {props.changeReason}
          </p>
          {props.canActivate ? (
            <div className="space-y-2">
              <Label htmlFor="global-publishing-reason">Reason (required for this publishing command)</Label>
              <Textarea
                id="global-publishing-reason"
                rows={2}
                maxLength={1000}
                value={reason}
                disabled={change.isPending}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          ) : (
            <Callout>Changing the global switch needs the inventory activation permission.</Callout>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={change.isPending} onClick={() => props.onOpenChange(false)}>
            Close
          </Button>
          {props.canActivate && (
            <Button
              type="button"
              disabled={!changed || trimmedReason.length === 0 || change.isPending}
              onClick={() => change.mutate()}
            >
              {change.isPending ? "Applying…" : "Apply"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
