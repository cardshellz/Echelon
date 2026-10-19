import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import type { ReceiptReversalRecovery } from "@/lib/receipt-reversal-command";

export function ReceiptReversalRecoveryNotice({ saved, storageError, error, pending, allowed, onRetry, onRead }: {
  saved: ReceiptReversalRecovery | null; storageError: string | null; error: string | null;
  pending: boolean; allowed: boolean; onRetry(saved: ReceiptReversalRecovery): void; onRead(): void;
}) {
  if (!saved && !storageError && !error) return null;
  return <section role="alert" aria-label="Receipt reversal recovery" className="space-y-2 rounded-md border border-amber-500/50 p-3 text-sm break-words">
    {saved && <>
      <p className="font-medium">Receipt reversal needs confirmation</p>
      <p>{saved.body.action === "line" ? `Reverse ${saved.body.payload.qty} units on line #${saved.body.targetId}` : "Reverse all remaining quantities"} on <Link className="underline" href={`/receiving?open=${saved.body.receivingOrderId}`}>receipt #{saved.body.receivingOrderId}</Link>.</p>
      <p>Reason: {saved.body.payload.reason}</p>
      {saved.body.payload.allowNegative && <p>Negative inventory override was selected.</p>}
      <p>The outcome is not yet confirmed. Retrying uses the saved request and does not create another reversal.</p>
      <Button type="button" variant="outline" className="h-auto min-h-10 whitespace-normal" disabled={pending || !allowed} onClick={() => onRetry(saved)}>{pending ? "Confirming reversal…" : "Retry saved receipt reversal"}</Button>
      {!allowed && <p>Purchasing approval permission is required to confirm this request.</p>}
    </>}
    {storageError && <><p>{storageError}</p><Button type="button" variant="outline" disabled={pending} onClick={onRead}>Retry reversal recovery read</Button></>}
    {error && <p className="text-destructive">{error}</p>}
  </section>;
}
