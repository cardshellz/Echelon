import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import type { ReceivingEntryRecovery } from "@/lib/receiving-entry-command";

export function ReceivingEntryRecoveryNotice({ saved, storageError, error, pending, allowed, onRetry, onRead }: {
  saved: ReceivingEntryRecovery | null; storageError: string | null; error: string | null;
  pending: boolean; allowed: boolean; onRetry(saved: ReceivingEntryRecovery): void; onRead(): void;
}) {
  if (!saved && !storageError && !error) return null;
  return <section role="alert" aria-label="Receiving entry recovery" className="space-y-2 rounded-md border border-amber-500/50 p-3 text-sm break-words">
    {saved && <>
      <p className="font-medium">Receiving entry needs confirmation</p>
      {saved.body.action === "create"
        ? <p>Create a {(saved.body.payload.sourceType ?? "blind").replaceAll("_", " ")} receipt{saved.body.payload.poNumber ? ` for ${saved.body.payload.poNumber}` : ""}.</p>
        : <p>Add {saved.body.payload.expectedQty ?? 0} receive units of {saved.body.payload.sku ?? saved.body.payload.productName ?? "the selected product"} to <Link className="underline" href={`/receiving?open=${saved.body.targetId}`}>receipt #{saved.body.targetId}</Link>.</p>}
      <p>The outcome is not yet confirmed. Retrying uses the saved request and cannot create another copy of this entry.</p>
      <Button type="button" variant="outline" className="h-auto min-h-10 whitespace-normal" disabled={pending || !allowed} onClick={() => onRetry(saved)}>{pending ? "Confirming receiving entry…" : "Retry saved receiving entry"}</Button>
      {!allowed && <p>Inventory adjustment permission is required to confirm this request.</p>}
    </>}
    {storageError && <><p>{storageError}</p><Button type="button" variant="outline" disabled={pending} onClick={onRead}>Retry receiving recovery read</Button></>}
    {error && <p className="text-destructive">{error}</p>}
  </section>;
}
