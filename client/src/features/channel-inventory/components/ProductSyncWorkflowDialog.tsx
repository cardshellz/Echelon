import { LegacyDeliveryNotice } from "./LegacyInventorySendNotice";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { productSyncStartSchema, type ProductSyncStart, type ProductSyncWorkflow } from "@shared/types/inventory-product-sync-workflow";
import type { InventoryProductSyncReview } from "@shared/types/inventory-product-sync";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { reviewProductSync, startProductSyncWorkflow, readProductSyncWorkflow, ProductSyncRequestError } from "../product-sync-api";
import { productSyncState } from "../product-sync-presentation";
import { formatUnits } from "../format";
import { invalidateChannelInventory } from "../hooks";

export function productSyncWorkflowFinished(value: ProductSyncWorkflow): boolean {
  if (value.state === "blocked" || value.state === "failed") return true;
  return value.delivery !== null && value.delivery.rows.every(row => {
    const expected = value.delivery!.receipt.rows.find(item => item.outboxId === row.outboxId)!;
    return productSyncState(row, expected.quantity).terminal;
  });
}
function savedRequest(key: string, productId: number): { command: ProductSyncStart | null; error: string | null } {
  try {
    const raw = sessionStorage.getItem(key);
    const command = raw === null ? null : productSyncStartSchema.parse(JSON.parse(raw));
    if (command && command.productId !== productId) throw new Error("Saved scope differs.");
    return { command, error: null };
  } catch { return { command: null, error: "The saved sync could not be read. Check its status in Channel Inventory before starting another request." }; }
}

export function ProductSyncWorkflowDialog({ productId, actor, onClose }: { productId: number; actor: string; onClose(): void }) {
  const client = useQueryClient();
  const storageKey = `inventory-product-sync:v2:${actor}:${productId}`;
  const [saved] = useState(() => savedRequest(storageKey, productId));
  const [command, setCommand] = useState(saved.command);
  const [error, setError] = useState(saved.error);
  const [storageBlocked, setStorageBlocked] = useState(saved.error !== null);
  const sending = useRef(false);
  const review = useQuery({ queryKey: ["inventory-product-sync-review", productId], queryFn: () => reviewProductSync(productId),
    enabled: command === null && !storageBlocked, retry: false, staleTime: 0 });
  const statusKey = ["product-sync-workflow", actor, command?.idempotencyKey];
  const status = useQuery({ queryKey: statusKey, queryFn: () => readProductSyncWorkflow(command!, actor),
    enabled: command !== null, retry: false,
    refetchInterval: query => query.state.data && productSyncWorkflowFinished(query.state.data) ? false : 2000 });
  const mutation = useMutation({ mutationFn: (input: ProductSyncStart) => startProductSyncWorkflow(input, actor),
    onSuccess: (result, input) => {
      client.setQueryData(["product-sync-workflow", actor, input.idempotencyKey], result);
      setError(null);
    },
    onError: (failure, input) => {
      // A known accepted command wins over a later refusal from a duplicate view.
      if (client.getQueryData(["product-sync-workflow", actor, input.idempotencyKey])) return;
      if (failure instanceof ProductSyncRequestError && failure.definitiveRejected) {
        try { clearSaved(input); setCommand(null); }
        catch { setStorageBlocked(true); }
        setError(failure.message);
      } else setError("The response was interrupted. Retry the same sync to recover its status.");
    },
    onSettled: () => { sending.current = false; },
  });
  const clearSaved = (input: ProductSyncStart) => {
    const raw = sessionStorage.getItem(storageKey);
    if (raw !== null && productSyncStartSchema.parse(JSON.parse(raw)).idempotencyKey !== input.idempotencyKey)
      throw new Error("Another request owns the saved identity.");
    sessionStorage.removeItem(storageKey);
  };
  const submit = () => {
    if (sending.current || storageBlocked) return;
    if (command) { sending.current = true; mutation.mutate(command); return; }
    if (!review.data || review.isFetching || review.isError || review.data.blockers.length) return;
    const next = productSyncStartSchema.parse({ productId, idempotencyKey: crypto.randomUUID() });
    try {
      if (sessionStorage.getItem(storageKey) !== null) throw new Error("A request is already saved.");
      sessionStorage.setItem(storageKey, JSON.stringify(next));
    } catch { setStorageBlocked(true); setError("This browser could not save the sync identity. Close and reopen to recover any saved request."); return; }
    sending.current = true; setCommand(next); setError(null); mutation.mutate(next);
  };
  const value = status.data;
  const currentReview = value?.review ?? (!command && !review.isFetching && !review.isError ? review.data : undefined);
  const finished = value !== undefined && productSyncWorkflowFinished(value);
  const verified = !status.isError && value?.delivery !== null && value?.delivery !== undefined && value.delivery.rows.every(row => {
    const expected = value.delivery!.receipt.rows.find(item => item.outboxId === row.outboxId)!;
    return productSyncState(row, expected.quantity).verified;
  });
  const partial = value?.delivery?.receipt.blockedRows?.length || value?.review.targets.some(target => target.status === "blocked");
  const another = async () => {
    if (!command || !finished || mutation.isPending || status.isError) return;
    try { clearSaved(command); }
    catch { setError("The saved request could not be cleared. Reload before starting another sync."); return; }
    setCommand(null); setError(null);
    try { await Promise.all([client.invalidateQueries({ queryKey: ["inventory-product-sync-review", productId] }), invalidateChannelInventory(client)]); }
    catch { setError("The latest inventory review could not be refreshed. Close and reopen before syncing again."); }
  };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="flex max-h-[90dvh] max-w-2xl flex-col overflow-hidden">
      <DialogHeader><DialogTitle>Sync inventory through ATP</DialogTitle>
        <DialogDescription>{currentReview?.productName ?? "This product"}. Check existing inventory links and sync eligible channels using your ATP rules.</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        <LegacyDeliveryNotice productId={productId} actor={actor} />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {command ? <p role="status" className="font-medium">{verified
          ? partial ? "Eligible inventory verified; some destinations need attention" : "Inventory verified at channels"
          : value?.message ?? "Confirming the saved sync request…"}</p>
          : <p className="text-sm">Only this product is included. Draft Shopify items can receive inventory without publishing the product.</p>}
        {!command && review.isFetching && <p role="status">Calculating ATP and checking destinations…</p>}
        {!command && review.error && <p role="alert">{review.error.message}</p>}
        {command && status.error && <p role="alert" className="text-sm">Current status is unavailable. The original request is retained.</p>}
        {currentReview && <ProductSyncDestinations review={currentReview} workflow={value} />}
        {!command && <Button variant="outline" size="sm" disabled={review.isFetching || storageBlocked}
          onClick={() => void review.refetch()}>Refresh review</Button>}
        {command && <p className="text-xs text-muted-foreground">This recorded sync continues if you close this dialog. Channel delivery is shown separately from queuing.</p>}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Close</Button>
        {value?.state === "failed" ? <Button disabled={mutation.isPending} onClick={submit}>Retry same sync</Button>
          : finished ? <Button disabled={mutation.isPending || status.isError} onClick={() => void another()}>Sync again</Button>
          : value ? <Button variant="outline" disabled={status.isFetching} onClick={() => void status.refetch()}>Refresh status</Button>
          : <Button disabled={storageBlocked || mutation.isPending || (!command && (!review.data || review.isFetching || review.isError
            || review.data.blockers.length > 0 || review.data.rows.length === 0))} onClick={submit}>
            {mutation.isPending ? "Starting sync…" : command ? "Retry same sync" : "Sync eligible inventory"}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

const reasons: Readonly<Record<string, string>> = {
  PUBLICATION_TARGET_VARIANT_MAPPING_MISSING: "The existing channel inventory link needs an ATP check.",
  INVENTORY_MAPPING_MISSING: "The existing channel inventory link needs an ATP check.",
  STOCK_LINK_NOT_ON_SALE: "The channel item is not eligible for inventory linking.",
  STOCK_LINK_NOT_LISTED: "No matching channel item was found.",
  STOCK_LINK_SKU_DUPLICATE: "More than one channel item matches this SKU. Review the matching items.",
  STOCK_LINK_SELECTION_BLOCKED: "The channel's listing rules currently exclude this item.",
};
function ProductSyncDestinations({ review, workflow }: { review: InventoryProductSyncReview; workflow?: ProductSyncWorkflow }) {
  const skipped = review.targets.filter(target => target.status === "skipped");
  const settled = workflow && ["queued", "blocked", "failed"].includes(workflow.state);
  return <>
    {review.blockers.map(message => <p role="alert" key={message} className="text-sm text-destructive">{message}</p>)}
    {review.targets.filter(target => target.status !== "skipped").map(target => <section key={target.publicationTargetId} className="rounded border p-3 text-sm">
      <p className="font-medium">{target.channelName}</p>
      {review.rows.filter(row => row.publicationTargetId === target.publicationTargetId).map(row => {
        const receiptRow = workflow?.delivery?.receipt.rows.find(item => item.publicationTargetId === row.publicationTargetId && item.productVariantId === row.productVariantId);
        const progress = workflow?.delivery?.rows.find(item => item.outboxId === receiptRow?.outboxId);
        const missing = row.blockers.includes("PUBLICATION_TARGET_VARIANT_MAPPING_MISSING");
        const codes = row.blockers.filter(message => !message.startsWith("Last saved stock-link check:"));
        const messages = missing && !settled ? ["Existing inventory link will be checked during sync."]
          : [...new Set(codes.map(code => reasons[code.split(":", 1)[0]] ?? (/^[A-Z_]+$/.test(code) ? "Inventory needs attention. See details below." : code)))];
        return <div key={row.productVariantId} className="mt-2 border-t pt-2">
          <div className="flex flex-wrap justify-between gap-2"><span className="break-all font-mono">{row.sku ?? `SKU #${row.productVariantId}`}</span>
            <span>{receiptRow ? `${formatUnits(receiptRow.quantity)} units` : row.quantity !== null ? `${formatUnits(row.quantity)} units` : "Check required"}</span></div>
          {progress && receiptRow ? <p className="mt-1">{productSyncState(progress, receiptRow.quantity).label}</p>
            : messages.map(message => <p key={message} className="mt-1 text-muted-foreground">{message}</p>)}
          {progress?.errorMessage && <p role="alert" className="text-destructive">{progress.errorMessage}</p>}
          {settled && row.blockers.length > 0 && <details className="mt-1 text-xs text-muted-foreground"><summary>Technical details</summary>{row.blockers.join(" · ")}</details>}
        </div>;
      })}
    </section>)}
    {skipped.length > 0 && <details className="text-sm text-muted-foreground"><summary>{skipped.length} destinations not included by current settings</summary>
      {skipped.map(target => <p className="mt-1" key={target.publicationTargetId}>{target.channelName}: {target.blockers.map(code => reasons[code] ?? code).join(" ")}</p>)}</details>}
  </>;
}
