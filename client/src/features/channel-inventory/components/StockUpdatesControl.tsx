import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { EnableInventoryPublicationTargetRequest } from "@shared/types/inventory-publication-target-enable";
import { Link } from "wouter";
import { Pause, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";

import { ChannelInventoryApiError, describeError, enableDestination, stopDestination } from "../api";
import { pluralize } from "../format";
import { invalidateChannelInventory, useCommandKey, usePublishingStatus } from "../hooks";
import { PUBLISHER_LABELS, describeDestination, summarizePendingChanges, type Channel, type Target, type View } from "../model";
import { describeStockUpdates } from "../publishing-presentation";
import { Callout, KeyValue, StatePill } from "./primitives";
import { GlobalPublishingControl } from "./GlobalPublishingControl";

type Command = "stop";
type SettingsTab = "supply" | "rules" | "quantities";
const now = () => new Date();

/** A per-account switch. Checks and audited commands open only when requested. */
export function StockUpdatesControl({ view, channel, target, canActivate, detailsOpen, onDetailsOpenChange, onOpenTab }: {
  view: View; channel: Channel; target: Target; canActivate: boolean;
  detailsOpen: boolean;
  onDetailsOpenChange(open: boolean): void;
  onOpenTab(tab: SettingsTab): void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const status = usePublishingStatus();
  const identity = describeDestination(target, view);
  // The switch reflects this account's saved permission; the status also reports global pauses and read failures.
  const globalOn = status.error ? null : status.data?.global.globalEnabled ?? null;
  const publishing = describeStockUpdates(target, view.runtimeAuthority, globalOn);
  const pending = summarizePendingChanges(view, channel.id, target.id);
  const [dialog, setDialog] = useState<Command | null>(null);
  const stopKey = useCommandKey();
  const enableRequest = useRef<EnableInventoryPublicationTargetRequest | null>(null);
  const [enableError, setEnableError] = useState<string | null>(null);
  const managedHere = target.publicationAuthority === "echelon";
  const canEnable = managedHere && target.state !== "live" && view.runtimeAuthority === "canonical";

  const openCommand = (command: Command) => {
    onDetailsOpenChange(false);
    setDialog(command);
  };
  const fail = (error: unknown) => {
    const described = describeError(error);
    toast({ title: "Stock update action could not be completed", description: described.message, variant: "destructive" });
  };
  const refresh = () => invalidateChannelInventory(queryClient);

  const enable = useMutation({
    mutationFn: () => {
      // Keep the exact request on a network/5xx error, even if a background
      // refresh observes the committed revision before the operator retries.
      if (!enableRequest.current || enableRequest.current.publicationTargetId !== target.id) {
        enableRequest.current = { publicationTargetId: target.id, expectedRevision: target.revision,
          idempotencyKey: crypto.randomUUID() };
      }
      return enableDestination(enableRequest.current);
    },
    onSuccess: async result => {
      enableRequest.current = null; setEnableError(null); onDetailsOpenChange(false); await refresh();
      toast({ title: "Stock updates turned on for " + identity.title,
        description: globalOn === false ? "The all-channel control is still paused. Turn it on when you want updates sent."
          : result.publicationRows > 0 ? pluralize(result.publicationRows, "stock update") + " queued. View Stock preview for delivery status."
          : "Updates will be sent when listings are included for this account." });
    },
    onError: (error: unknown) => {
      if (error instanceof ChannelInventoryApiError && error.status < 500) enableRequest.current = null;
      setEnableError(describeError(error).message); onDetailsOpenChange(true);
    },
  });
  const stop = useMutation({
    mutationFn: () => stopDestination({
      publicationTargetId: target.id, expectedRevision: target.revision,
      idempotencyKey: stopKey.keyFor(JSON.stringify({ target: target.id, revision: target.revision })),
    }),
    onSuccess: async () => {
      stopKey.clear(); setDialog(null); await refresh();
      toast({ title: `Stock updates paused for ${identity.title}`,
        description: "Queued updates were cancelled. Stock already shown in the marketplace was not changed." });
    },
    onError: fail,
  });
  const busy = stop.isPending || enable.isPending;
  const enableOutcomeUnknown = enableError !== null && enableRequest.current?.publicationTargetId === target.id;

  const switchId = `stock-updates-${target.id}`;
  return <>
    <div className="space-y-2 border-t px-3 py-2">
      {managedHere && <div className="flex items-center justify-between gap-4">
        <label htmlFor={switchId} className="text-xs font-medium">Automatic stock updates</label>
        <Switch id={switchId} aria-label={`Automatic stock updates for ${identity.title}, ${identity.scope}`}
          aria-describedby={`${switchId}-status`}
          checked={target.state === "live"} disabled={!canActivate || busy || enableOutcomeUnknown}
          onCheckedChange={enabled => {
            if (!enabled) openCommand("stop");
            else if (canEnable) enable.mutate();
            else onDetailsOpenChange(true);
          }} />
      </div>}
      <div className="flex items-center justify-between gap-3">
        <span id={`${switchId}-status`}><StatePill tone={publishing.tone}>{publishing.label}</StatePill></span>
        <Button type="button" variant="link" size="sm" className="h-auto min-h-0 p-0 text-xs"
          aria-label={`Stock update details for ${identity.title}, ${identity.scope}`} onClick={() => onDetailsOpenChange(true)}>Details</Button>
      </div>
    </div>
    <Dialog open={detailsOpen && dialog === null} onOpenChange={onDetailsOpenChange}>
      <DialogContent className="max-h-[85dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Automatic stock updates · {identity.title}</DialogTitle>
          <DialogDescription>Send calculated stock quantities to {channel.name}.</DialogDescription>
        </DialogHeader>
        <p className="text-sm leading-relaxed">{publishing.explanation}</p>

        {enableError && <Callout tone="danger" title={enableOutcomeUnknown ? "Stock update change not confirmed" : "Stock updates could not be turned on"}>{enableError}</Callout>}
        {managedHere && view.runtimeAuthority !== "canonical" && <Callout title="Channel Inventory setup is needed">
          Complete <Link className="underline" href="/inventory/cutover">Inventory setup</Link> before using automatic stock updates here.
        </Callout>}
        {target.hold && <p className="rounded-md border border-orange-200 bg-orange-50 p-3 text-sm text-orange-900 dark:border-orange-800 dark:bg-orange-950/30 dark:text-orange-100">
          <span className="font-medium">Stock hold:</span> {target.hold.reason}
        </p>}
        {managedHere && globalOn === false && target.state !== "live" && (
          <p className="text-sm text-muted-foreground">The all-channel control is also off. Turning on this account does not turn it on.</p>
        )}
        {managedHere && globalOn === null && target.state !== "live" && (
          <p className="text-sm text-muted-foreground">The all-channel stock-update status is not available.</p>
        )}

        {managedHere && <div className="space-y-3">
          {(canEnable || enableOutcomeUnknown) && <div className="space-y-2">
            <Button type="button" disabled={!canActivate || busy} onClick={() => enable.mutate()}>
              <Play className="mr-1 h-4 w-4" aria-hidden="true" /> {enable.isPending ? "Turning on…" : enableOutcomeUnknown ? "Retry turning on" : "Turn on stock updates"}
            </Button>
            {pending.total > 0 && <p className="text-xs text-muted-foreground">First-time setup uses your saved warehouses and channel default. Other pending changes stay saved until applied.</p>}
          </div>}
          {target.state === "live" && <Button type="button" variant="outline" disabled={!canActivate || busy || enableOutcomeUnknown} onClick={() => openCommand("stop")}>
            <Pause className="mr-1 h-4 w-4" aria-hidden="true" /> Pause stock updates
          </Button>}
          {!canActivate && <p className="text-xs text-muted-foreground">Your role can view this setup. Starting or pausing stock updates requires inventory activation permission.</p>}
          {globalOn === false && <GlobalPublishingControl canActivate={canActivate} now={now} triggerLabel="All-channel controls" />}
          {status.error && <Button type="button" variant="outline" size="sm" disabled={status.isFetching} onClick={() => void status.refetch()}>
            Reload all-channel status
          </Button>}
        </div>}


        <nav aria-label="Stock setup" className="flex flex-wrap gap-2 border-t pt-4">
          <Button type="button" size="sm" variant="outline" onClick={() => { onDetailsOpenChange(false); onOpenTab("supply"); }}>Edit warehouses</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => { onDetailsOpenChange(false); onOpenTab("rules"); }}>Edit stock rules</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => { onDetailsOpenChange(false); onOpenTab("quantities"); }}>View stock preview</Button>
        </nav>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Details for support</summary>
          <dl className="mt-4 grid gap-4 sm:grid-cols-2">
            <KeyValue label="Stock managed by">{PUBLISHER_LABELS[target.publicationAuthority].label}</KeyValue>
            <KeyValue label="Account location">{identity.scope}</KeyValue>
            <KeyValue label="All-channel control">{globalOn === null ? "Unknown" : globalOn ? "On" : "Off"}</KeyValue>
            <KeyValue label="Settings in use">{view.runtimeAuthority === "canonical" ? "Channel Inventory" : "Previous Channel Allocation settings"}</KeyValue>
            <KeyValue label="Account record">#{target.id} · revision {target.revision}</KeyValue>
          </dl>

        </details>

      </DialogContent>
    </Dialog>

    <AlertDialog open={dialog === "stop"} onOpenChange={open => { if (!open && !stop.isPending) setDialog(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Pause stock updates for {identity.title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>Stop future updates and cancel queued updates for this account.</p>
              <p>Stock already shown in the marketplace stays available to buy. Pausing does not set it to zero.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={stop.isPending}>Cancel</AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={stop.isPending} onClick={() => stop.mutate()}>
            {stop.isPending ? "Pausing…" : "Pause stock updates"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
