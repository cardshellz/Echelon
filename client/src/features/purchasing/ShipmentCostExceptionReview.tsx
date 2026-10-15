import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { shipmentExceptionContextSchema, formatShipmentExceptionAmount,
  type ShipmentCostException, type ShipmentExceptionRequest } from "@shared/procurement/shipment-cost-exception";
import { apiRequest } from "@/lib/queryClient";
import { FinancialCommandRequestError } from "@/lib/financial-command";
import { createShipmentExceptionClient } from "@/lib/shipment-cost-exception";
import { shipmentCostWorkflowError } from "@/lib/shipment-cost-workflow";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function ShipmentCostExceptionReview({ lineId, review }: { lineId: number; review: ShipmentCostException }) {
  const [open, setOpen] = useState(false);
  const accepted = review.state === "accepted";
  const amount = formatShipmentExceptionAmount(review.amountMills, review.currency);
  return <div className="space-y-2 text-sm">
    <Badge variant="outline">{accepted ? "Historical difference accepted" : "Inventory history exception"}</Badge>
    <p>{review.kind === "missing_receipt_history"
      ? `The shipment charge is saved. Missing receipt history prevents applying ${amount} to inventory and sold orders.`
      : `Known stock and sold-order costs were updated. ${amount} remains separate because some historical stock movements are missing.`}</p>
    {review.kind === "unexplained_quantity" && <ul className="space-y-1 text-xs">
      {review.issues.map(issue => issue.unresolvedQuantity && <li key={issue.unresolvedQuantity.allocationId}>
        {issue.unresolvedQuantity.lotNumber}: {issue.unresolvedQuantity.quantity.toLocaleString()} lot units without a recorded movement · {formatShipmentExceptionAmount(issue.unresolvedQuantity.amountMills, review.currency)}
      </li>)}
    </ul>}
    {accepted && review.decision && <p className="text-xs text-muted-foreground">
      Accepted by {review.decision.actorName ?? review.decision.actorId} · {new Date(review.decision.recordedAt).toLocaleString()}. {review.decision.reason}
    </p>}
    {!accepted && <p className="text-xs text-muted-foreground">An administrator can accept this documented difference after review. Updating costs again will not repair the missing history.</p>}
    <Button size="sm" variant="outline" onClick={() => setOpen(true)}>{accepted ? "Review decision" : "Review exception"}</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-2xl max-h-[90dvh] flex flex-col overflow-hidden">
        <DialogHeader><DialogTitle>Review inventory exception</DialogTitle>
          <DialogDescription>Shipment charges are saved. Review the historical difference and its impact before approving.</DialogDescription></DialogHeader>
        {open && <ShipmentExceptionDecision lineId={lineId} onClose={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  </div>;
}

function ShipmentExceptionDecision({ lineId, onClose }: { lineId: number; onClose: () => void }) {
  const path = `/api/shipment-lines/${lineId}/cost-exception`;
  const queryClient = useQueryClient();
  const context = useQuery({ queryKey: [path], staleTime: 0, refetchOnWindowFocus: false, queryFn: async () => {
    const response = await apiRequest("GET", path);
    const parsed = shipmentExceptionContextSchema.parse(await response.json());
    if (parsed.lineId !== lineId) throw new Error("This review belongs to a different shipment line.");
    return parsed;
  } });
  const [reason, setReason] = useState("");
  const [client] = useState(() => createShipmentExceptionClient(() => crypto.randomUUID()));
  const [attempt, setAttempt] = useState<ShipmentExceptionRequest | null>(null);
  const save = useMutation({ mutationFn: (request: ShipmentExceptionRequest) => client.decide(lineId, request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ predicate: query => {
        const key = query.queryKey[0];
        return typeof key === "string" && (key === path || key.startsWith("/api/purchase-orders/") || key.startsWith("/api/inbound-shipments/"));
      } });
      onClose();
    },
  });
  const data = context.data, review = data?.review;
  const ambiguous = save.isError && save.error instanceof FinancialCommandRequestError && save.error.ambiguous;
  const locked = save.isPending || ambiguous;
  const accepted = review?.state === "accepted";
  const action = accepted ? "reopen" : "accept";
  const submit = () => {
    if (ambiguous && attempt) { save.mutate(attempt); return; }
    if (!data || !review) return;
    const request = { sourceVersion: data.sourceVersion, action, reason: reason.trim() } as const;
    setAttempt(request); save.mutate(request);
  };
  const reload = () => { save.reset(); setAttempt(null); void context.refetch(); };
  return <>
    <div className="min-h-0 overflow-y-auto space-y-4 pr-1 text-sm">
      {context.isPending && <p role="status">Loading the current cost evidence…</p>}
      {context.isError && <p role="alert">The review could not be loaded. Reload before approving.</p>}
      {data && <>
        <strong className="block break-all">{data.sku ?? `Shipment line ${lineId}`}</strong>
        {data.blockedReason && <p role="alert" className="text-amber-700 dark:text-amber-400">{data.blockedReason}</p>}
        {review && <>
          <p>{accepted ? "Reopen this exception for another review. The earlier approval stays in the audit history."
            : "Accept the documented historical difference. Its amount stays visible and separate until supporting records can be corrected."}</p>
          <div className="rounded-md bg-muted/50 p-3 text-xs space-y-1">
            {review.kind === "missing_receipt_history" ? <p>Receipt history is missing. This line's charge could not be applied to inventory or sold orders.</p>
              : review.issues.map(issue => issue.unresolvedQuantity && <p key={issue.unresolvedQuantity.allocationId}>
                <strong>{issue.unresolvedQuantity.lotNumber}</strong>: {issue.unresolvedQuantity.quantity.toLocaleString()} lot units have no recorded stock movement; {formatShipmentExceptionAmount(issue.unresolvedQuantity.amountMills, review.currency)} is kept separate.
              </p>)}
          </div>
          <table className="w-full text-xs sm:text-sm" aria-label="Exception before and after">
            <thead><tr className="border-b"><th className="py-2 text-left">What changes</th><th className="p-2 text-right">Before</th><th className="py-2 text-right">After approval</th></tr></thead>
            <tbody>
              <tr className="border-b"><th className="py-2 text-left font-normal">Review status</th><td className="p-2 text-right">{accepted ? "Accepted" : "Needs review"}</td><td className="py-2 text-right font-semibold">{accepted ? "Needs review" : "Historical difference accepted"}</td></tr>
              <tr className="border-b"><th className="py-2 text-left font-normal">Shipment charge for this line</th><td className="p-2 text-right">{formatShipmentExceptionAmount(review.allocatedMills, review.currency)}</td><td className="py-2 text-right">{formatShipmentExceptionAmount(review.allocatedMills, review.currency)}</td></tr>
              <tr className="border-b"><th className="py-2 text-left font-normal">Unassigned inventory cost</th><td className="p-2 text-right">{formatShipmentExceptionAmount(review.amountMills, review.currency)}</td><td className="py-2 text-right">{formatShipmentExceptionAmount(review.amountMills, review.currency)}</td></tr>
              <tr><th className="py-2 text-left font-normal">Stock counts and order costs</th><td className="p-2 text-right">Current records</td><td className="py-2 text-right">Unchanged</td></tr>
            </tbody>
          </table>
          <details className="text-xs"><summary className="cursor-pointer">Affected records</summary>
            <ul className="mt-2 space-y-1">{review.issues.map(issue => <li key={`${issue.code}:${issue.message}`}>{issue.message}</li>)}</ul>
            <p className="mt-2">Last cost application updated {review.lotsUpdated} stock lots and {review.cogsRowsUpdated} sold-order cost records.</p>
          </details>
          <div className="space-y-2"><Label htmlFor={`exception-reason-${lineId}`}>Reason / supporting reference</Label>
            <Textarea id={`exception-reason-${lineId}`} value={reason} onChange={event => setReason(event.target.value)} disabled={locked || !data.canApprove}
              maxLength={2000} rows={2} placeholder="Explain the historical difference and what you checked." />
            <p className="text-xs text-muted-foreground">Your identity, reason and reviewed values are saved. Changed cost evidence requires a new review.</p>
          </div>
        </>}
        {data.history.length > 0 && <details className="text-xs">
          <summary className="cursor-pointer">Decision history ({data.history.length}{data.history.length === 20 ? " most recent" : ""})</summary>
          <ol className="mt-2 space-y-2">{data.history.map(decision => <li key={decision.id} className="border-t pt-2">
            <strong>{decision.action === "accept" ? "Accepted" : "Reopened"}</strong> · {formatShipmentExceptionAmount(decision.amountMills, decision.currency)} · {decision.actorName ?? decision.actorId} · {new Date(decision.recordedAt).toLocaleString()}
            <p>{decision.reason}</p>
          </li>)}</ol>
        </details>}
      </>}
      {save.isError && <p role="alert" className="text-destructive">{ambiguous
        ? "The approval response was lost. Retry this same approval, or close and reopen to check the saved decision."
        : save.error instanceof FinancialCommandRequestError ? save.error.message : shipmentCostWorkflowError(save.error)}</p>}
    </div>
    <div className="shrink-0 border-t pt-3 flex flex-wrap justify-end gap-2">
      <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
      {(context.isError || save.isError && !ambiguous || data?.blockedReason) && <Button variant="outline" disabled={locked} onClick={reload}>Reload review</Button>}
      {review && data?.canApprove && <Button className="min-h-[44px] bg-green-700 hover:bg-green-800 text-white" onClick={submit}
        disabled={save.isPending || context.isFetching || (!ambiguous && (!!data.blockedReason || reason.trim().length < 10))}>
        {save.isPending ? "Saving decision…" : ambiguous ? "Retry approval" : accepted ? "Reopen exception" : "Accept historical difference"}
      </Button>}
    </div>
  </>;
}
