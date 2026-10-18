import { useState } from "react";
import { invalidatePurchaseCosts } from "@/lib/invalidate-purchase-costs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatShipmentExceptionAmount, type ShipmentCostException } from "@shared/procurement/shipment-cost-exception";
import {
  reconciliationContextSchema,
  reconciliationDestinations,
  reconciliationPreview,
  type ReconciliationDestination,
  type ReconciliationRequest,
} from "@shared/procurement/cost-reconciliation";
import { apiRequest } from "@/lib/queryClient";
import { FinancialCommandRequestError } from "@/lib/financial-command";
import { createShipmentReconciliationClient } from "@/lib/shipment-cost-reconciliation";
import { shipmentCostWorkflowError } from "@/lib/shipment-cost-workflow";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ShipmentCostPostingDetails, ShipmentCostPostingHistory } from "./ShipmentCostPostingDetails";

export function ShipmentCostExceptionReview({ lineId, review }: { lineId: number; review: ShipmentCostException }) {
  const [open, setOpen] = useState(false);
  const posted = review.reconciliation?.status === "posted";
  const amount = formatShipmentExceptionAmount(
    review.reconciliation?.postedMills ?? review.amountMills,
    review.currency,
  );
  return (
    <div className="space-y-2 text-sm">
      <Badge variant={posted ? "outline" : "destructive"} className={posted ? "border-green-600/40 text-green-800 dark:text-green-300" : undefined}>
        {posted ? "Costs posted" : "Cost reconciliation needed"}
      </Badge>
      <p>
        {posted
          ? `${amount} is posted to ${reconciliationDestinations[review.reconciliation!.destination!].toLowerCase()}.`
          : review.kind === "missing_receipt_history"
            ? "This shipment charge is saved, but its inventory cost has not been assigned. Review the missing history and choose where the cost belongs."
            : `${formatShipmentExceptionAmount(review.amountMills, review.currency)} needs a destination for stock with incomplete history. Known stock and sold-order costs were updated.`}
      </p>
      {posted && (
        <p className="text-xs text-muted-foreground">
          No further cost approval is needed. The approval and original stock history are saved below.
        </p>
      )}
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {posted ? "View posting and approval" : "Reconcile costs"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-2xl max-h-[90dvh] flex flex-col overflow-hidden">
          {open && <ShipmentReconciliation lineId={lineId} onClose={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ShipmentReconciliation({ lineId, onClose }: { lineId: number; onClose: () => void }) {
  const path = `/api/shipment-lines/${lineId}/cost-reconciliation`;
  const queryClient = useQueryClient();
  const context = useQuery({
    queryKey: [path],
    staleTime: 0,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const response = await apiRequest("GET", path);
      const parsed = reconciliationContextSchema.parse(await response.json());
      if (parsed.lineId !== lineId) throw new Error("This review belongs to a different shipment line.");
      return parsed;
    },
  });
  const [reason, setReason] = useState("");
  const [destination, setDestination] = useState<ReconciliationDestination | null>(null);
  const [client] = useState(() => createShipmentReconciliationClient(() => crypto.randomUUID()));
  const [attempt, setAttempt] = useState<ReconciliationRequest | null>(null);
  const [changingDestination, setChangingDestination] = useState(false);
  const save = useMutation({
    mutationFn: (request: ReconciliationRequest) => client.reconcile(lineId, request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey[0];
          return (
            typeof key === "string" &&
            (key === path ||
              key === "/api/cogs/historical-adjustments" ||
              key.startsWith("/api/purchase-orders/") ||
              key.startsWith("/api/inbound-shipments/"))
          );
        },
      });
      setChangingDestination(false);
      setDestination(null);
      setReason("");
    },
    onSettled: () => invalidatePurchaseCosts(queryClient),
  });
  const data = context.data;
  const ambiguous = save.isError && save.error instanceof FinancialCommandRequestError && save.error.ambiguous;
  const locked = save.isPending || ambiguous;
  const preview = data && destination ? reconciliationPreview(data, destination) : null;
  const money = (mills: number) => formatShipmentExceptionAmount(mills, "USD");
  const sameDestination = data?.state.status === "posted" && data.state.destination === destination;
  const viewingPosting = data?.state.status === "posted" && !changingDestination && !ambiguous && !context.isError;
  const submit = () => {
    if (ambiguous && attempt) {
      save.mutate(attempt);
      return;
    }
    if (!data || !destination) return;
    const request = { sourceVersion: data.sourceVersion, destination, reason: reason.trim() };
    setAttempt(request);
    save.mutate(request);
  };
  const reload = () => {
    save.reset();
    setAttempt(null);
    void context.refetch();
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>{viewingPosting ? "Shipment costs posted" : changingDestination ? "Change cost destination" : "Reconcile shipment costs"}</DialogTitle>
        <DialogDescription>
          {viewingPosting ? "The saved posting and administrator approval for this shipment line."
            : "Review the recorded history and approve where the unresolved cost belongs."}
        </DialogDescription>
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto space-y-4 pr-1 text-sm">
        {context.isPending && <p role="status">Loading receipt, stock history and saved postings…</p>}
        {context.isError && <p role="alert">The history could not be loaded. Reload before approving.</p>}
        {data && !context.isError && (
          <>
            <strong className="block break-all">{data.sku ?? `Shipment line ${lineId}`}</strong>
            {viewingPosting ? <ShipmentCostPostingDetails data={data} /> : <>
            {data.sourceEvidence === "estimated" && (
              <p className="text-amber-700 dark:text-amber-400">
                This shipment charge is still estimated. Approval uses the saved estimate; confirming the final charge
                will update its cost posting.
              </p>
            )}
            {data.blockedReason && (
              <p role="alert" className="text-amber-700 dark:text-amber-400">
                {data.blockedReason}
              </p>
            )}
            <div className="rounded-md bg-muted/50 p-3 space-y-2 text-xs">
              {data.records.map((record) => (
                <p key={record.lotId}>
                  <strong>{record.lotNumber}</strong> · {record.originalQuantity.toLocaleString()} recorded received;{" "}
                  {record.onHandQuantity.toLocaleString()} on hand.
                  {record.quantityWithoutHistory !== null && (
                    <> {record.quantityWithoutHistory.toLocaleString()} lot units have no recorded movement.</>
                  )}
                  {record.receiptId !== null && (
                    <>
                      {" "}
                      Receipt #{record.receiptId}
                      {record.receiptLineId !== null && <> / line #{record.receiptLineId}</>}.
                    </>
                  )}
                  <span className="block mt-1">{record.explanation}</span>
                </p>
              ))}
            </div>
            <fieldset disabled={locked || !data.canApprove || !!data.blockedReason} className="space-y-2">
              <legend className="font-semibold mb-2">Where does this historical cost belong?</legend>
              {(["historical_cogs", "inventory_variance"] as const).map((value) => (
                <label key={value} className="flex gap-3 rounded-md border p-3 cursor-pointer">
                  <input
                    type="radio"
                    name={`destination-${lineId}`}
                    value={value}
                    checked={destination === value}
                    onChange={() => setDestination(value)}
                  />
                  <span>
                    <strong>{reconciliationDestinations[value]}</strong>
                    <span className="block text-xs text-muted-foreground">
                      {value === "historical_cogs"
                        ? "You have evidence the goods were sold. Records do not identify the individual orders."
                        : "Record an inventory expense adjustment when the missing movements cannot be attributed to sales."}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            {preview ? (
              <table className="w-full text-xs sm:text-sm" aria-label="Cost reconciliation before and after">
                <thead>
                  <tr className="border-b">
                    <th className="py-2 text-left">Cost destination</th>
                    <th className="p-2 text-right">Before</th>
                    <th className="py-2 text-right">After approval</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b">
                    <th className="py-2 text-left font-normal">Shipment charge</th>
                    <td className="p-2 text-right">{money(data.sourceAmountMills)}</td>
                    <td className="py-2 text-right">{money(data.sourceAmountMills)}</td>
                  </tr>
                  <tr className="border-b">
                    <th className="py-2 text-left font-normal">Assigned to tracked stock / sold orders</th>
                    <td className="p-2 text-right">{money(preview.assignedMills)}</td>
                    <td className="py-2 text-right">{money(preview.assignedMills)}</td>
                  </tr>
                  {(["historical_cogs", "inventory_variance", "unassignedMills"] as const).map((key) => (
                    <tr key={key} className="border-b">
                      <th className="py-2 text-left font-normal">
                        {key === "unassignedMills" ? "Unassigned cost" : reconciliationDestinations[key]}
                      </th>
                      <td className="p-2 text-right">{money(preview.before[key])}</td>
                      <td className="py-2 text-right font-semibold">{money(preview.after[key])}</td>
                    </tr>
                  ))}
                  <tr>
                    <th className="py-2 text-left font-normal">Stock quantity change</th>
                    <td className="p-2 text-right">—</td>
                    <td className="py-2 text-right">0</td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <p>Choose a destination to see the exact before and after.</p>
            )}
            <p className="text-xs text-muted-foreground">
              Approval posts the cost adjustment with your identity and reason. It preserves the shipment charge,
              receipts and stock counts. Future cost revisions adjust this posting; restored history reverses it before
              assigning those costs again.
            </p>
            <div className="space-y-2">
              <Label htmlFor={`reconciliation-reason-${lineId}`}>Reason / supporting reference</Label>
              <Textarea
                id={`reconciliation-reason-${lineId}`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={locked || !data.canApprove}
                maxLength={2000}
                rows={2}
                placeholder="What did you check, and why does the cost belong here?"
              />
            </div>
            {sameDestination && <p role="status">These costs are already reconciled to this destination.</p>}
            <ShipmentCostPostingHistory data={data} />
            </>}
          </>
        )}
        {save.isError && (
          <p role="alert" className="text-destructive">
            {ambiguous
              ? "The approval response was lost. Retry this same approval, or close and reopen to check the saved posting."
              : save.error instanceof FinancialCommandRequestError
                ? save.error.message
                : shipmentCostWorkflowError(save.error)}
          </p>
        )}
      </div>
      <div className="shrink-0 border-t pt-3 flex flex-wrap justify-end gap-2">
        {!viewingPosting && <Button variant="outline" onClick={onClose} disabled={save.isPending}>Close review</Button>}
        {(context.isError || (save.isError && !ambiguous) || (!viewingPosting && data?.blockedReason)
          || (viewingPosting && !data?.history.some(posting => posting.destination === data.state.destination))) && (
          <Button variant="outline" disabled={locked} onClick={reload}>
            Reload review
          </Button>
        )}
        {viewingPosting && data?.canApprove && !data.blockedReason && <Button variant="outline" onClick={() => {
          setChangingDestination(true);
          setDestination(null);
          setReason("");
          save.reset();
        }}>Change cost destination</Button>}
        {viewingPosting && <Button onClick={onClose}>Done</Button>}
        {changingDestination && !locked && <Button variant="outline" onClick={() => setChangingDestination(false)}>Cancel change</Button>}
        {!context.isError && !viewingPosting && data?.canApprove && (
          <Button
            className="min-h-[44px] bg-green-700 hover:bg-green-800 text-white"
            onClick={submit}
            disabled={
              save.isPending ||
              context.isFetching ||
              (!ambiguous && (!!data.blockedReason || !destination || sameDestination || reason.trim().length < 10))
            }
          >
            {save.isPending ? "Posting adjustment…" : ambiguous ? "Retry approval" : "Approve & post costs"}
          </Button>
        )}
      </div>
    </>
  );
}
