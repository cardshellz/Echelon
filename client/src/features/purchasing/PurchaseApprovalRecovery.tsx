import React from "react";
import { Button } from "@/components/ui/button";
import type { PurchaseApprovalRecovery as Recovery } from "@/lib/purchase-approval-command";

export function PurchaseApprovalRecovery({ recovery, error, pending, allowed, onRecover, onRefresh }: {
  recovery: Recovery | null; error: string | null; pending: boolean; allowed: boolean;
  onRecover: (recovery: Recovery) => void; onRefresh: () => void;
}) {
  return <>
    {error && <div role="alert" className="rounded-md border border-destructive p-3 text-sm">
      <p>{error}</p><Button type="button" variant="outline" onClick={onRefresh}>Retry approval recovery read</Button>
    </div>}
    {recovery && <div role="alert" className="space-y-2 rounded-md border border-amber-500 p-3 text-sm">
      <p className="font-medium">Purchase approval needs confirmation</p>
      <p>The saved request contains your previously reviewed terms for purchase #{recovery.body.purchaseOrderId}. Recover that request before approving another purchase.</p>
      {!allowed && <p>Approval permission is required to recover this saved request.</p>}
      <Button type="button" variant="outline" disabled={pending || !allowed} onClick={() => onRecover(recovery)}>{pending ? "Recovering approval..." : "Recover purchase approval"}</Button>
    </div>}
  </>;
}
