import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import {
  inventoryProductSyncRequestSchema, type InventoryProductSyncRequest, type InventoryProductSyncReceipt,
  type InventoryProductSyncProgress, type InventoryProductSyncReview,
} from "@shared/types/inventory-product-sync";
import { inventoryStockSendRequestSchema } from "@shared/types/inventory-stock-send";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { productSyncProgress, ProductSyncRequestError, reviewProductSync, syncProductInventory } from "../product-sync-api";
import { productSyncState } from "../product-sync-presentation";
import { stockSendProgress } from "../stock-send-api";
import { stockSendState } from "../stock-send-presentation";
import { ENDPOINTS } from "../api";
import { invalidateChannelInventory } from "../hooks";
import { formatAbsoluteTime, formatUnits } from "../format";

interface Props { productId: number; disabled?: boolean }

export function InventoryProductSyncButton(props: Props) {
  const { user, hasPermission } = useAuth();
  const [open, setOpen] = useState(false);
  if (!hasPermission("inventory_planning", "view")) return null;
  const canSync = hasPermission("inventory_planning", "activate");
  return <>
    <Button type="button" variant="outline" size="sm" disabled={props.disabled || !canSync} onClick={() => setOpen(true)}
      title={canSync ? "Recalculate this product through ATP and sync its eligible channel inventory" : "Inventory activation permission is required"}>
      <RefreshCw className="mr-2 h-4 w-4" /> Sync inventory
    </Button>
    {open && <ProductSyncDialog key={`${user?.id}:${props.productId}`} productId={props.productId}
      actor={user?.id ?? ""} onClose={() => setOpen(false)} />}
  </>;
}

function readSavedRequest(key: string, productId: number): { command: InventoryProductSyncRequest | null; error: string | null } {
  try {
    const text = sessionStorage.getItem(key);
    const command = text === null ? null : inventoryProductSyncRequestSchema.parse(JSON.parse(text));
    if (command && command.productId !== productId) throw new Error("Saved product scope differs.");
    return { command, error: null };
  } catch {
    return { command: null, error: "The saved inventory sync cannot be read. Its outcome must be checked before starting another sync." };
  }
}

function progressFinished(progress: InventoryProductSyncProgress): boolean {
  return progress.rows.every(row => {
    const expected = progress.receipt.rows.find(candidate => candidate.outboxId === row.outboxId);
    return expected !== undefined && productSyncState(row, expected.quantity).terminal;
  });
}

function ProductSyncDialog({ productId, actor, onClose }: { productId: number; actor: string; onClose(): void }) {
  const queryClient = useQueryClient();
  const storageKey = `inventory-product-sync:v1:${actor}:${productId}`;
  const [saved] = useState(() => readSavedRequest(storageKey, productId));
  const [pending, setPending] = useState<InventoryProductSyncRequest | null>(saved.command);
  const [receipt, setReceipt] = useState<InventoryProductSyncReceipt | null>(null);
  const [error, setError] = useState<string | null>(saved.error);
  const [storageBlocked, setStorageBlocked] = useState(saved.error !== null);
  const inFlight = useRef(false);
  const review = useQuery({ queryKey: ["inventory-product-sync-review", productId], queryFn: () => reviewProductSync(productId),
    enabled: pending === null && !storageBlocked, staleTime: 0, retry: false });
  const progress = useQuery({ queryKey: ["inventory-product-sync-progress", pending?.idempotencyKey, actor],
    queryFn: () => productSyncProgress(pending!, actor), enabled: pending !== null, retry: false,
    refetchInterval: query => query.state.data && progressFinished(query.state.data) ? false : 2000 });
  const sync = useMutation({ mutationFn: (command: InventoryProductSyncRequest) => syncProductInventory(command, actor),
    onSuccess: async (result, command) => {
      queryClient.setQueryData(["inventory-product-sync-receipt", command.idempotencyKey], result.receipt);
      setReceipt(result.receipt); setError(null);
      try {
        const current = sessionStorage.getItem(storageKey);
        if (current === null || inventoryProductSyncRequestSchema.parse(JSON.parse(current)).idempotencyKey === command.idempotencyKey)
          sessionStorage.setItem(storageKey, JSON.stringify(command));
      }
      catch { setError("The sync is recorded, but this browser could not retain its retry details. Keep its delivery status open until it is confirmed."); }
      try {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["inventory-product-sync-progress", command.idempotencyKey] }),
          invalidateChannelInventory(queryClient),
          queryClient.invalidateQueries({ queryKey: [ENDPOINTS.publicationStatus] }),
        ]);
      } catch { setError("The sync is recorded, but its updated status could not be loaded. Refresh delivery status."); }
    },
    onError: (failure, command) => {
      // A confirmed receipt outranks a later refusal from another view replaying
      // the same key. Uncertain responses always retain their original request.
      const confirmed = queryClient.getQueryData<InventoryProductSyncReceipt>(["inventory-product-sync-receipt", command.idempotencyKey]);
      if (confirmed) { setReceipt(confirmed); setError(null); return; }
      if (failure instanceof ProductSyncRequestError && failure.definitiveRejected) {
        try {
          clearOwnedRequest(storageKey, command.idempotencyKey);
          setPending(null);
        }
        catch { setStorageBlocked(true); }
        setError(failure.message);
        void queryClient.invalidateQueries({ queryKey: ["inventory-product-sync-review", productId] });
      } else setError("The result is not confirmed. Retry this same sync; its product and request identity are saved.");
    },
    onSettled: () => { inFlight.current = false; },
  });
  const recorded = progress.data?.receipt ?? receipt;
  const allTerminal = progress.data !== undefined && progressFinished(progress.data);
  const allVerified = progress.data !== undefined && progress.data.rows.every(row => {
    const expected = progress.data!.receipt.rows.find(candidate => candidate.outboxId === row.outboxId);
    return expected !== undefined && productSyncState(row, expected.quantity).verified;
  });
  const submit = () => {
    if (inFlight.current || sync.isPending || storageBlocked) return;
    if (pending) { inFlight.current = true; sync.mutate(pending); return; }
    if (!review.data?.ready || review.isFetching || review.isError) return;
    const command = inventoryProductSyncRequestSchema.parse({ productId, expectedReviewHash: review.data.reviewHash, idempotencyKey: crypto.randomUUID() });
    try {
      if (sessionStorage.getItem(storageKey) !== null) {
        setStorageBlocked(true); setError("Another inventory sync is saved for this product. Close and reopen this dialog to recover its status."); return;
      }
      sessionStorage.setItem(storageKey, JSON.stringify(command));
    }
    catch { setError("This browser could not save the retry identity. Inventory was not synced. Allow session storage and try again."); return; }
    inFlight.current = true; setPending(command); setError(null); sync.mutate(command);
  };
  const startAnother = () => {
    if (inFlight.current || sync.isPending || !allTerminal) return;
    try { clearOwnedRequest(storageKey, pending?.idempotencyKey ?? recorded!.idempotencyKey); }
    catch { setError("The saved request could not be cleared. Reload before starting another sync."); return; }
    setPending(null); setReceipt(null); setError(null);
    void queryClient.invalidateQueries({ queryKey: ["inventory-product-sync-review", productId] });
  };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="flex max-h-[90dvh] max-w-3xl flex-col overflow-hidden">
      <DialogHeader className="shrink-0">
        <DialogTitle>Sync inventory through ATP</DialogTitle>
        <DialogDescription>{recorded?.productName ?? review.data?.productName ?? "This product"}. Recalculate this product’s variants and sync all eligible connected destinations using your active ATP rules.</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <LegacyDeliveryNotice productId={productId} actor={actor} />
      {recorded ? <section aria-label="Inventory delivery status" className="space-y-3">
        <p role="status" className="font-medium">{allVerified ? "Queued quantities verified at channels" : "Inventory sync recorded"}</p>
        <p className="text-sm text-muted-foreground">Requested {formatAbsoluteTime(recorded.requestedAt)}. Each destination confirms its own delivery.</p>
        <TargetIssues targets={recorded.targets} />
        {recorded.blockedRows?.map(row => <div key={`${row.publicationTargetId}:${row.productVariantId}`} className="rounded border p-3 text-sm">
          <p className="font-medium">{row.channelName} · {row.externalScopeId}</p>
          <p className="break-all font-mono">{row.sku ?? `SKU #${row.productVariantId}`} · Not queued</p>
          <IssueList messages={row.blockers} />
        </div>)}
        {recorded.rows.map(row => {
          const current = progress.data?.rows.find(candidate => candidate.outboxId === row.outboxId);
          const status = current ? productSyncState(current, row.quantity) : null;
          return <div key={row.outboxId} className="rounded border p-3 text-sm">
            <p className="font-medium">{row.channelName} · {row.externalScopeId}</p>
            <div className="mt-1 flex flex-wrap justify-between gap-2"><span className="break-all font-mono">{row.sku ?? `SKU #${row.productVariantId}`}</span><span>{formatUnits(row.quantity)} units</span></div>
            {(row.warnings?.length ?? 0) > 0 && <Warnings messages={row.warnings!} />}
            <p className={status?.verified ? "mt-1 text-green-700" : "mt-1 text-muted-foreground"}>{status?.label ?? "Loading delivery status…"}</p>
            {current?.observedAt && current.observedQuantity !== null && <p className="text-xs text-muted-foreground">Channel showed {formatUnits(current.observedQuantity)} · {formatAbsoluteTime(current.observedAt)}</p>}
            {(current?.errorCode || current?.errorMessage) && <p className="mt-1 break-words text-destructive">{[current.errorCode, current.errorMessage].filter(Boolean).join(": ")}</p>}
          </div>;
        })}
        {progress.error && <p role="alert" className="text-sm text-destructive">Delivery status is unavailable. No channel delivery can be confirmed from this response.</p>}
        <Button type="button" variant="outline" size="sm" disabled={progress.isFetching} onClick={() => void progress.refetch()}>Refresh delivery status</Button>
      </section> : pending ? <section className="space-y-2" aria-label="Saved inventory sync">
        <p>Checking the saved inventory sync…</p>
        <p className="text-sm text-muted-foreground">The original request is kept while its outcome is confirmed.</p>
        {progress.error && !sync.isPending && <p className="text-sm text-muted-foreground">No confirmed response is available yet. Retry the same sync to recover it.</p>}
      </section> : <section className="space-y-3" aria-label="Inventory sync review">
        {review.isFetching && <p role="status">Calculating ATP quantities and checking destinations…</p>}
        {review.error && <p role="alert" className="text-sm text-destructive">{review.error.message}</p>}
        {!review.isFetching && !review.isError && review.data && <>
          {review.data.sku && <p className="break-all font-mono text-sm">{review.data.sku}</p>}
          <p className="text-sm">Only this product is included. Eligible destinations are synced; blocked or excluded destinations remain unchanged.</p>
          {review.data.blockers.length > 0 && <IssueList messages={review.data.blockers} />}
          <TargetIssues targets={review.data.targets} />
          {review.data.targets.map(target => <div key={target.publicationTargetId} className="rounded border p-3 text-sm">
            <p className="font-medium">{target.channelName} · {target.externalScopeId}</p>
            <p className="text-xs text-muted-foreground">{target.providerKey} · {target.status === "ready" ? "Eligible quantities" : target.status === "blocked" ? "Needs attention" : "Not included"}</p>
            {review.data!.rows.filter(row => row.publicationTargetId === target.publicationTargetId).map(row => <div key={row.productVariantId} className="mt-2 border-t pt-2">
              <div className="flex flex-wrap justify-between gap-2"><span className="break-all font-mono">{row.sku ?? `SKU #${row.productVariantId}`}</span>
                <span>{row.status === "ready" && row.quantity !== null ? `${formatUnits(row.quantity)} units` : "Not queued"}</span></div>
              {row.blockers.length > 0 && <IssueList messages={row.blockers} />}
              {(row.warnings?.length ?? 0) > 0 && <Warnings messages={row.warnings!} />}
            </div>)}
          </div>)}
          {review.data.targets.length === 0 && <p className="text-sm">No inventory destinations are configured for this product. Review <a className="underline" href="/channels/inventory">Channel Inventory</a>.</p>}
          <p className="text-xs text-muted-foreground">ATP applies warehouse availability, reservations, stock rules, holds and publication controls. Warehouse stock is not moved or deducted.</p>
        </>}
        <Button type="button" variant="outline" size="sm" disabled={review.isFetching || storageBlocked} onClick={() => void review.refetch()}>Refresh review</Button>
      </section>}
      </div>
      <DialogFooter className="shrink-0">
        <Button type="button" variant="outline" onClick={onClose}>Close</Button>
        {recorded ? <Button type="button" disabled={!allTerminal || sync.isPending} onClick={startAnother}>Sync again</Button>
          : <Button type="button" disabled={storageBlocked || sync.isPending || (!pending && (!review.data?.ready || review.isFetching || review.isError))} onClick={submit}>
            {sync.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{sync.isPending ? "Syncing…" : pending ? "Retry same sync" : "Sync eligible inventory"}
          </Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function IssueList({ messages }: { messages: readonly string[] }) {
  return <ul role="alert" className="mt-1 list-disc space-y-1 break-words pl-5 text-sm text-destructive">{messages.map((message, index) => <li key={`${index}:${message}`}>{message}</li>)}</ul>;
}

function Warnings({ messages }: { messages: readonly string[] }) {
  return <ul className="mt-1 list-disc space-y-1 break-words pl-5 text-sm text-amber-700 dark:text-amber-300">{messages.map((message, index) => <li key={`${index}:${message}`}>{message}</li>)}</ul>;
}

function clearOwnedRequest(key: string, idempotencyKey: string): void {
  const current = sessionStorage.getItem(key);
  if (current !== null && inventoryProductSyncRequestSchema.parse(JSON.parse(current)).idempotencyKey !== idempotencyKey)
    throw new Error("Another inventory request owns the saved recovery key.");
  sessionStorage.removeItem(key);
}

function TargetIssues({ targets }: { targets: InventoryProductSyncReview["targets"] }) {
  const issues = targets.filter(target => target.status !== "ready" || target.blockers.length > 0);
  if (issues.length === 0) return null;
  return <aside className="rounded border p-3 text-sm" aria-label="Destinations needing attention">
    <p className="font-medium">Some destinations or SKUs are not included</p>
    {issues.map(target => <div key={target.publicationTargetId} className="mt-2">
      <p>{target.channelName} · {target.externalScopeId} · {target.status === "skipped" ? "Not included" : "Needs attention"}</p>
      <IssueList messages={target.blockers} />
    </div>)}
  </aside>;
}

function LegacyDeliveryNotice({ productId, actor }: { productId: number; actor: string }) {
  const [saved] = useState(() => {
    const keys = new Set<string>();
    let unreadable = false;
    try {
      const prefix = `inventory-stock-send:v1:${actor}:${productId}:`;
      for (let index = 0; index < sessionStorage.length; index++) {
        const key = sessionStorage.key(index);
        if (!key?.startsWith(prefix)) continue;
        try {
          const command = inventoryStockSendRequestSchema.parse(JSON.parse(sessionStorage.getItem(key)!));
          if (command.productId !== productId) throw new Error("Legacy scope differs.");
          keys.add(command.idempotencyKey);
        } catch { unreadable = true; }
      }
    } catch { unreadable = true; }
    return { keys: [...keys], unreadable };
  });
  const [expanded, setExpanded] = useState(false);
  if (saved.keys.length === 0 && !saved.unreadable) return null;
  return <aside className="rounded border p-3 text-sm" aria-label="Previous inventory send">
    <p>A previous Shopify inventory request is saved in this browser. Its outcome may still be pending. This ATP sync does not retry that request.</p>
    {saved.unreadable && <p className="mt-1 text-destructive">Some saved request details could not be read. Check their history in <a href="/channels/inventory" className="underline">Channel Inventory</a>.</p>}
    {saved.keys.length > 0 && <Button type="button" variant="link" className="h-auto px-0" onClick={() => setExpanded(value => !value)}>{expanded ? "Hide previous delivery status" : "View previous delivery status"}</Button>}
    {expanded && saved.keys.map(key => <LegacyDelivery key={key} commandKey={key} productId={productId} actor={actor} />)}
  </aside>;
}

function LegacyDelivery({ commandKey, productId, actor }: { commandKey: string; productId: number; actor: string }) {
  const query = useQuery({ queryKey: ["inventory-stock-send-legacy-progress", commandKey, actor], queryFn: async () => {
    const result = await stockSendProgress(commandKey);
    if (result.receipt.productId !== productId || result.receipt.requestedBy !== actor) throw new Error("Previous inventory send scope could not be confirmed.");
    return result;
  }, retry: false });
  return <div className="mt-2 border-t pt-2">
    {query.isFetching && <p>Checking previous delivery…</p>}
    {query.error && <p role="alert">Previous delivery status could not be confirmed. Check Channel Inventory history before retrying it.</p>}
    {query.data && <><p>{query.data.receipt.channelName} · {query.data.receipt.location}</p>
      {query.data.rows.map(row => {
        const expected = query.data!.receipt.rows.find(candidate => candidate.outboxId === row.outboxId)!;
        return <p key={row.outboxId}>{expected.sku ?? `SKU #${row.productVariantId}`} · {stockSendState(row, expected.quantity).label}</p>;
      })}</>}
    <Button type="button" variant="link" className="h-auto px-0" disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh previous status</Button>
  </div>;
}
