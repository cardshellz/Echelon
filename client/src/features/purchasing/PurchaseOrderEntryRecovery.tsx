import React from "react";
import { Button } from "@/components/ui/button";
import type { PurchaseOrderEntryRecovery as Recovery } from "@/lib/purchase-order-entry-command";

export function PurchaseOrderEntryRecoveryNotice({ recovery, storageError, error, pending, allowed, onRecover, onRead }: {
  recovery: Recovery | null; storageError: string | null; error: string | null; pending: boolean; allowed: boolean;
  onRecover: (saved: Recovery) => void; onRead: () => void;
}) {
  if (!recovery && !storageError && !error) return null;
  const action = recovery?.body.action;
  const description = action === "create" ? "Create a purchase order" : action === "duplicate"
    ? `Duplicate purchase #${recovery?.body.targetId}` : action === "save-draft"
      ? `Save draft purchase #${recovery?.body.targetId}` : `Prepare purchase #${recovery?.body.targetId} for supplier review`;
  return <div role="alert" aria-label="Purchase order recovery" className="space-y-2 rounded-md border border-amber-500 p-3 text-sm">
    <p className="font-medium">{recovery ? "Purchase order request needs confirmation" : "Purchase order recovery needs attention"}</p>
    {recovery && <><p>{description}. The saved request retains your original terms.</p>
      <p>Recover this request before another save or supplier preparation. Recovery reuses the original request and cannot create another copy.</p>
      {!allowed && <p>The original action's purchasing permission is required to recover this request.</p>}
      <Button type="button" variant="outline" disabled={pending || !allowed} onClick={() => onRecover(recovery)}>
        {pending ? "Recovering purchase request..." : "Recover saved purchase request"}
      </Button></>}
    {storageError && <><p>{storageError}</p><Button type="button" variant="outline" disabled={pending} onClick={onRead}>Retry purchase recovery read</Button></>}
    {error && <p>{error}</p>}
  </div>;
}
