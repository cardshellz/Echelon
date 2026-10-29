import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Send } from "lucide-react";
import { inventoryStockSendRequestSchema, STOCK_SEND_MAX_SELECTED_VARIANTS, type InventoryStockSendRequest, type InventoryStockSendReceipt } from "@shared/types/inventory-stock-send";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { reviewStockSend, sendStock, stockSendContext, stockSendProgress, StockSendRequestError } from "../stock-send-api";
import { stockSendState } from "../stock-send-presentation";
import { formatUnits, formatAbsoluteTime } from "../format";

interface Props { productId: number; channelId?: number; publicationTargetId?: number; disabled?: boolean }

export function InventoryStockSendButton(props: Props) {
  const { user, hasPermission } = useAuth();
  const [open, setOpen] = useState(false);
  if (!hasPermission("inventory_planning", "view")) return null;
  const canSend = hasPermission("inventory_planning", "activate");
  return <>
    <Button type="button" variant="outline" size="sm" disabled={props.disabled || !canSend} onClick={() => setOpen(true)}
      title={canSend ? "Send selected SKU quantities to a Shopify location" : "Inventory activation permission is required"}>
      <Send className="mr-2 h-4 w-4" /> Send inventory
    </Button>
    {open && <StockSendDialog key={`${user?.id}:${props.productId}:${props.channelId}:${props.publicationTargetId}`}
      {...props} actor={user?.id ?? ""} onClose={() => setOpen(false)} />}
  </>;
}

function savedRequest(key: string, productId: number, targetId?: number): { command: InventoryStockSendRequest | null; error: string | null } {
  try {
    const text = sessionStorage.getItem(key);
    const command = text === null ? null : inventoryStockSendRequestSchema.parse(JSON.parse(text));
    if (command && (command.productId !== productId || targetId !== undefined && command.publicationTargetId !== targetId))
      throw new Error("Saved stock-send scope does not match this view.");
    return { command, error: null };
  } catch {
    // Never silently discard the identity of an update that may have committed.
    return { command: null, error: "The saved stock-send request cannot be read. Its outcome must be checked before starting another send." };
  }
}

function StockSendDialog({ productId, channelId, publicationTargetId, actor, onClose }: Props & { actor: string; onClose(): void }) {
  const queryClient = useQueryClient();
  const storageKey = `inventory-stock-send:v1:${actor}:${productId}:${channelId ?? "all"}:${publicationTargetId ?? "all"}`;
  const [saved] = useState(() => savedRequest(storageKey, productId, publicationTargetId));
  const [pending, setPending] = useState<InventoryStockSendRequest | null>(saved.command);
  const [receipt, setReceipt] = useState<InventoryStockSendReceipt | null>(null);
  const [targetId, setTargetId] = useState<number | null>(publicationTargetId ?? saved.command?.publicationTargetId ?? null);
  const [selected, setSelected] = useState<number[]>(saved.command?.productVariantIds ?? []);
  const [error, setError] = useState<string | null>(saved.error);
  const [storageBlocked, setStorageBlocked] = useState(saved.error !== null);
  const inFlight = useRef(false);
  const context = useQuery({ queryKey: ["inventory-stock-send-context", productId, channelId],
    queryFn: () => stockSendContext(productId, channelId), retry: false });
  const effectiveTargetId = targetId ?? (context.data?.targets.length === 1 ? context.data.targets[0].id : null);
  const target = context.data?.targets.find(item => item.id === effectiveTargetId);
  const ids = [...selected].sort((left, right) => left - right);
  const selection = { productId, publicationTargetId: effectiveTargetId!, productVariantIds: ids };
  const review = useQuery({ queryKey: ["inventory-stock-send-review", selection],
    queryFn: () => reviewStockSend(selection), enabled: pending === null && !storageBlocked && effectiveTargetId !== null && ids.length > 0,
    staleTime: 0, retry: false });
  const progress = useQuery({ queryKey: ["inventory-stock-send-progress", pending?.idempotencyKey],
    queryFn: () => stockSendProgress(pending!.idempotencyKey), enabled: pending !== null, retry: false,
    refetchInterval: query => query.state.data?.rows.every(row => {
      const expected = query.state.data!.receipt.rows.find(expected => expected.productVariantId === row.productVariantId);
      return expected !== undefined && stockSendState(row, expected.quantity).terminal;
    }) ? false : 2000,
  });
  const send = useMutation({ mutationFn: sendStock,
    onSuccess: async (result, command) => {
      // A committed receipt wins over a delayed refusal from another view that
      // retried this same key. Refresh failures cannot undo that confirmation.
      queryClient.setQueryData(["inventory-stock-send-receipt", command.idempotencyKey], result.receipt);
      setReceipt(result.receipt); setError(null);
      try {
        const current = sessionStorage.getItem(storageKey);
        if (current === null || inventoryStockSendRequestSchema.parse(JSON.parse(current)).idempotencyKey === command.idempotencyKey)
          sessionStorage.setItem(storageKey, JSON.stringify(command));
      } catch { setError("The update is recorded, but this browser could not retain its retry details. Keep this delivery status open until it is confirmed."); }
      try { await queryClient.invalidateQueries({ queryKey: ["inventory-stock-send-progress", result.receipt.idempotencyKey] }); }
      catch { setError("The update is recorded, but delivery status could not be refreshed. Reload its saved status."); }
    },
    onError: (failure, command) => {
      const confirmed = queryClient.getQueryData<InventoryStockSendReceipt>(["inventory-stock-send-receipt", command.idempotencyKey]);
      if (confirmed) { setReceipt(confirmed); setError(null); return; }
      if (failure instanceof StockSendRequestError && failure.definitiveRejected) {
        try { sessionStorage.removeItem(storageKey); setPending(null); }
        catch { setStorageBlocked(true); }
        setError(failure.message);
        void queryClient.invalidateQueries({ queryKey: ["inventory-stock-send-review"] });
        void context.refetch();
      } else setError("The result is not confirmed. Retry this same send; its selected SKUs and location are saved.");
    },
    onSettled: () => { inFlight.current = false; },
  });
  const recorded = progress.data?.receipt ?? receipt;
  const allTerminal = progress.data !== undefined && progress.data.rows.every(row => {
    const expected = progress.data!.receipt.rows.find(expected => expected.productVariantId === row.productVariantId);
    return expected !== undefined && stockSendState(row, expected.quantity).terminal;
  });
  const allVerified = progress.data !== undefined && progress.data.rows.length === progress.data.receipt.rows.length
    && progress.data.rows.every(row => stockSendState(row,
      progress.data!.receipt.rows.find(expected => expected.productVariantId === row.productVariantId)!.quantity).verified);
  const submit = () => {
    if (inFlight.current || send.isPending || storageBlocked) return;
    if (pending) { inFlight.current = true; send.mutate(pending); return; }
    if (!review.data?.ready || review.isFetching) return;
    const command = inventoryStockSendRequestSchema.parse({ ...selection, expectedReviewHash: review.data.reviewHash, idempotencyKey: crypto.randomUUID() });
    try { sessionStorage.setItem(storageKey, JSON.stringify(command)); }
    catch { setError("This browser could not save the retry identity. Stock was not sent. Allow session storage and try again."); return; }
    inFlight.current = true; setPending(command); setError(null); send.mutate(command);
  };
  const startAnother = () => {
    try { sessionStorage.removeItem(storageKey); }
    catch { setError("The saved stock-send request could not be cleared. Reload before starting another update."); return; }
    setPending(null); setReceipt(null); setError(null); setSelected([]);
    void context.refetch();
  };
  const blockers = [...new Set([...(context.data?.blockers ?? []), ...(target?.blockers ?? []), ...(review.data?.blockers ?? [])])];
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Send inventory to Shopify</DialogTitle>
        <DialogDescription>{context.data?.productName ?? "Choose the stock to send"}. Quantities follow your active stock rules.</DialogDescription>
      </DialogHeader>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {recorded ? <section aria-label="Stock delivery status" className="space-y-3">
        <p className="font-medium" role="status">{allVerified ? "Inventory verified at Shopify" : "Stock update recorded"}</p>
        <p className="text-sm text-muted-foreground">{recorded.channelName} · Shopify location {recorded.location} · {formatAbsoluteTime(recorded.requestedAt)}</p>
        {recorded.rows.map(row => {
          const current = progress.data?.rows.find(item => item.outboxId === row.outboxId);
          const status = current ? stockSendState(current, row.quantity) : null;
          return <div key={row.productVariantId} className="rounded border p-3 text-sm">
            <div className="flex flex-wrap justify-between gap-2"><span className="font-mono">{row.sku ?? `SKU #${row.productVariantId}`}</span>
              <span>{formatUnits(row.quantity)} → Shopify</span></div>
            <p className={status?.verified ? "mt-1 text-green-700" : "mt-1 text-muted-foreground"}>{status?.label ?? "Loading delivery status…"}</p>
            {current?.observedAt && current.observedQuantity !== null && <p className="text-xs text-muted-foreground">Shopify showed {formatUnits(current.observedQuantity)} · {formatAbsoluteTime(current.observedAt)}</p>}
            {current?.errorMessage && <p className="mt-1 text-destructive">{current.errorMessage}</p>}
          </div>;
        })}
        {progress.error && <p role="alert" className="text-sm text-destructive">Delivery status is unavailable. Sending again is not needed to reload its status.</p>}
        <Button type="button" variant="outline" size="sm" disabled={progress.isFetching} onClick={() => void progress.refetch()}>Refresh delivery status</Button>
      </section> : pending ? <section className="space-y-3" aria-label="Saved stock send">
        <p>Checking the saved stock update…</p>
        <p className="text-sm text-muted-foreground">The original selection is kept while its result is confirmed.</p>
        {progress.error && !send.isPending && <p className="text-sm text-muted-foreground">No completed response is available yet. Retry the same send to recover it.</p>}
      </section> : <section className="space-y-4">
        {context.isLoading && <p role="status">Loading linked stock destinations…</p>}
        {context.error && <p role="alert" className="text-sm text-destructive">{context.error.message} <button type="button" className="underline" onClick={() => void context.refetch()}>Try again</button></p>}
        {context.data && <>
          <div className="space-y-2"><Label htmlFor="stock-send-location">Shopify location</Label>
            <Select value={effectiveTargetId === null ? "" : String(effectiveTargetId)} disabled={publicationTargetId !== undefined}
              onValueChange={value => { setTargetId(Number(value)); setError(null); }}>
              <SelectTrigger id="stock-send-location"><SelectValue placeholder="Select a Shopify location" /></SelectTrigger>
              <SelectContent>{context.data.targets.map(item => <SelectItem key={item.id} value={String(item.id)}>{item.label}</SelectItem>)}</SelectContent>
            </Select>
            {context.data.targets.length === 0 && <p className="text-sm">Set up a Shopify destination in <a className="underline" href="/channels/inventory">Channel Inventory</a> first.</p>}
          </div>
          <fieldset className="space-y-2"><legend className="text-sm font-medium">Variants to send</legend>
            {context.data.variants.map(variant => <label key={variant.id} className="flex cursor-pointer items-center gap-3 rounded border p-3 text-sm">
              <Checkbox aria-label={`Send ${variant.sku ?? variant.name}`} checked={selected.includes(variant.id)}
                disabled={!variant.eligible || (!selected.includes(variant.id) && selected.length >= STOCK_SEND_MAX_SELECTED_VARIANTS)}
                onCheckedChange={checked => { setSelected(current => checked === true ? [...current, variant.id] : current.filter(id => id !== variant.id)); setError(null); }} />
              <span className="min-w-0"><span className="block break-all font-mono">{variant.sku ?? variant.name}</span>
                <span className="block text-xs text-muted-foreground">{variant.name}{variant.eligible ? "" : " · Not eligible for stock updates"}</span></span>
            </label>)}
          </fieldset>
          {ids.length === 0 && <p className="text-sm text-muted-foreground">Select the variant or variants whose stock you want to send.</p>}
          {review.isFetching && <p role="status">Calculating quantities…</p>}
          {review.error && <p role="alert" className="text-sm text-destructive">{review.error.message}</p>}
          {blockers.length > 0 && <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-destructive">{blockers.map(message => <li key={message}>{message}</li>)}</ul>}
          {review.data?.ready && !review.isFetching && <div className="rounded border bg-muted/30 p-3 text-sm" aria-label="Inventory to send">
            <p className="mb-2 font-medium">Inventory to send</p>
            {review.data.rows.map(row => <div key={row.productVariantId} className="flex flex-wrap justify-between gap-2 py-1">
              <span className="font-mono">{row.sku ?? `SKU #${row.productVariantId}`}</span><span>{formatUnits(row.quantity)} units of this SKU</span>
            </div>)}
          </div>}
          <p className="text-xs text-muted-foreground">This sends calculated availability to the selected Shopify location. Warehouse stock is not moved or deducted.</p>
        </>}
      </section>}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>Close</Button>
        {recorded ? <Button type="button" disabled={!allTerminal} onClick={startAnother}>Send another update</Button>
          : <Button type="button" disabled={storageBlocked || send.isPending || (!pending && (!review.data?.ready || review.isFetching || blockers.length > 0))} onClick={submit}>
            {send.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{send.isPending ? "Sending…" : pending ? "Retry same send" : "Send selected inventory"}
          </Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
