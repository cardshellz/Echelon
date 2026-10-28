import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { StockLinkControlResult, StockLinkSupportedStatus } from "@shared/types/stock-link";

import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";

import { ChannelInventoryApiError, checkStockLinksAgain, continueStockLinking, describeError, setStockLinkSwitch } from "../api";
import { stockLinkStatusQueryKey, useStockLinkStatus } from "../hooks";
import type { DestinationIdentity } from "../model";
import {
  STOCK_LINK_RELOAD_CODES, STOCK_LINK_WORDS, buildStockLinkCheckAgainRequest, buildStockLinkContinueRequest,
  buildStockLinkSwitchRequest, describeStockLink, describeStockLinkControlError, stockLinkStatusApplies, stockLinkSwitchAction,
  type StockLinkPresentation,
} from "../stock-link-presentation";
import { Callout } from "./primitives";

/**
 * Automatic stock linking for one destination (PLAN-CH2 v4.1 §9): the switch row under the stock-update switch, the
 * status and actions in the details dialog, and the turn-off confirm. Shown only when the server's status says
 * `supported`; a 404, a network error or an unparseable answer hides everything without a toast.
 */
export function useStockLinkControls(identity: DestinationIdentity) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const applies = stockLinkStatusApplies(identity);
  const status = useStockLinkStatus(identity.id, applies);
  const [confirmOff, setConfirmOff] = useState(false);
  const presentation: StockLinkPresentation = applies
    ? describeStockLink(status.data, status.isError)
    : { kind: "hidden" };
  const supported: StockLinkSupportedStatus | null = status.data?.supported ? status.data : null;
  // A confirm whose destination stopped being supported (the server's own answer) would send nothing: close it (TST-1).
  useEffect(() => { if (!supported) setConfirmOff(false); }, [supported]);

  // Every control answers with the destination's full status after its change, so the answer replaces the cache.
  const settle = (result: StockLinkControlResult) => queryClient.setQueryData(stockLinkStatusQueryKey(identity.id), result);
  const fail = (error: unknown) => {
    if (error instanceof ChannelInventoryApiError && STOCK_LINK_RELOAD_CODES.has(error.code)) {
      void queryClient.invalidateQueries({ queryKey: stockLinkStatusQueryKey(identity.id) });
    }
    const described = describeStockLinkControlError(error, describeError);
    toast({ title: described.title, description: described.message, variant: "destructive" });
  };
  const switchLinking = useMutation({
    mutationFn: ({ current, enabled }: { current: StockLinkSupportedStatus; enabled: boolean }) =>
      setStockLinkSwitch(buildStockLinkSwitchRequest(current, enabled)),
    onSuccess: (result, { enabled }) => {
      settle(result); setConfirmOff(false);
      toast({ title: enabled ? STOCK_LINK_WORDS.turnedOn(identity.title) : STOCK_LINK_WORDS.turnedOff(identity.title) });
    },
    onError: fail,
  });
  const continueLinking = useMutation({
    mutationFn: (current: StockLinkSupportedStatus) => continueStockLinking(buildStockLinkContinueRequest(current)),
    onSuccess: settle,
    onError: fail,
  });
  const checkAgain = useMutation({
    mutationFn: (current: StockLinkSupportedStatus) => checkStockLinksAgain(buildStockLinkCheckAgainRequest(current)),
    onSuccess: result => { settle(result); toast({ title: STOCK_LINK_WORDS.checking(identity.title) }); },
    onError: fail,
  });
  const busy = switchLinking.isPending || continueLinking.isPending || checkAgain.isPending;

  return {
    presentation, busy,
    // Same render as the change above, before its effect runs: never show a confirm that cannot send.
    confirmOff: confirmOff && supported !== null,
    toggle: (checked: boolean) => {
      if (!supported) return;
      if (stockLinkSwitchAction(checked) === "confirm_off") setConfirmOff(true);
      else switchLinking.mutate({ current: supported, enabled: true });
    },
    cancelOff: () => { if (!switchLinking.isPending) setConfirmOff(false); },
    confirmTurnOff: () => { if (supported) switchLinking.mutate({ current: supported, enabled: false }); },
    continueLinking: () => { if (supported) continueLinking.mutate(supported); },
    checkAgain: () => { if (supported) checkAgain.mutate(supported); },
    retry: () => { void status.refetch(); },
    retrying: status.isFetching,
  };
}

export type StockLinkController = ReturnType<typeof useStockLinkControls>;

/** The second switch row of a destination card. Renders nothing unless the destination is supported. */
export function StockLinkSwitchRow({ presentation, identity, canActivate, busy, onToggle }: {
  presentation: StockLinkPresentation; identity: DestinationIdentity; canActivate: boolean; busy: boolean;
  onToggle(checked: boolean): void;
}) {
  if (presentation.kind !== "shown") return null;
  const switchId = `stock-link-${identity.id}`;
  return <div className="flex items-center justify-between gap-4">
    <label htmlFor={switchId} className="text-xs font-medium">{STOCK_LINK_WORDS.switchLabel}</label>
    <Switch id={switchId} aria-label={`${STOCK_LINK_WORDS.switchLabel} for ${identity.title}, ${identity.scope}`}
      checked={presentation.switchOn} disabled={!canActivate || busy} onCheckedChange={onToggle} />
  </div>;
}

/** The details-dialog section: status line, callouts, Continue / Check again, and the no-permission note. */
export function StockLinkDetails({ presentation, canActivate, busy, retrying, onContinue, onCheckAgain, onRetry }: {
  presentation: StockLinkPresentation; canActivate: boolean; busy: boolean; retrying: boolean;
  onContinue(): void; onCheckAgain(): void; onRetry(): void;
}) {
  if (presentation.kind === "hidden") return null;
  if (presentation.kind === "unavailable") {
    return <section aria-label={STOCK_LINK_WORDS.switchLabel} className="space-y-2 border-t pt-4">
      <p className="text-sm text-muted-foreground">{presentation.text}</p>
      <Button type="button" variant="outline" size="sm" disabled={retrying} onClick={onRetry}>{STOCK_LINK_WORDS.reloadStatus}</Button>
    </section>;
  }
  return <section aria-label={STOCK_LINK_WORDS.switchLabel} className="space-y-3 border-t pt-4">
    <div className="space-y-1">
      <h3 className="text-sm font-medium">{STOCK_LINK_WORDS.heading(presentation.switchOn)}</h3>
      <p className="text-sm text-muted-foreground">{presentation.statusLine}</p>
    </div>
    {presentation.callouts.map(callout => <Callout key={callout.text} tone={callout.tone}>{callout.text}</Callout>)}
    <div className="flex flex-wrap gap-2">
      {presentation.showContinue && <Button type="button" size="sm" disabled={!canActivate || busy} onClick={onContinue}>
        {STOCK_LINK_WORDS.continueButton}
      </Button>}
      {presentation.showCheckAgain && <Button type="button" size="sm" variant="outline" disabled={!canActivate || busy} onClick={onCheckAgain}>
        {STOCK_LINK_WORDS.checkAgainButton}
      </Button>}
    </div>
    {!canActivate && <p className="text-xs text-muted-foreground">{STOCK_LINK_WORDS.noPermission}</p>}
  </section>;
}

export function StockLinkTurnOffDialog({ open, store, busy, onCancel, onConfirm }: {
  open: boolean; store: string; busy: boolean; onCancel(): void; onConfirm(): void;
}) {
  return <AlertDialog open={open} onOpenChange={next => { if (!next) onCancel(); }}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{STOCK_LINK_WORDS.turnOffTitle(store)}</AlertDialogTitle>
        <AlertDialogDescription>{STOCK_LINK_WORDS.turnOffBody}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
        <Button type="button" variant="destructive" disabled={busy} onClick={onConfirm}>{STOCK_LINK_WORDS.turnOffConfirm}</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
