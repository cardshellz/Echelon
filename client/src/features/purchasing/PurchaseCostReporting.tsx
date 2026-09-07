import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { costReportDeliveryListSchema, retryCostReportSchema, type CostReportDeliveryList } from "@shared/procurement/cost-report-delivery";
import { useAuth } from "@/lib/auth";
import { createFinancialCommandIntentStore, financialCommandFetchJson, FinancialCommandRequestError, financialCommandRetryDelay, shouldRetryFinancialCommand } from "@/lib/financial-command";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Delivery = CostReportDeliveryList["deliveries"][number];
const states: Record<Delivery["state"],string> = {queued:"Queued",processing:"Awaiting acknowledgement",retry_required:"Retry scheduled",dead_letter:"Needs attention",acknowledged:"Retained by Archon"};
const retryResult = z.object({deliveryId:z.string().uuid(),state:z.literal("queued"),replayed:z.boolean()}).strict();
function RetryReport({purchaseOrderId,delivery,onSaved}: {purchaseOrderId:number;delivery:Delivery;onSaved:() => void}) {
  const [reason,setReason] = useState("");
  const [pending,setPending] = useState<{key:string;body:z.infer<typeof retryCostReportSchema>} | null>(null);
  const [validation,setValidation] = useState<string | null>(null);
  const store = useRef(createFinancialCommandIntentStore(() => crypto.randomUUID()));
  const mutation = useMutation<z.infer<typeof retryResult>, Error, NonNullable<typeof pending>>({
    mutationFn: async (intent: NonNullable<typeof pending>) => {
      const raw = await financialCommandFetchJson<unknown>(`/api/purchase-orders/${purchaseOrderId}/cost-reporting/${delivery.id}/retry`,{method:"POST",credentials:"include",headers:{"Content-Type":"application/json","Idempotency-Key":intent.key},body:JSON.stringify(intent.body)});
      const parsed = retryResult.safeParse(raw);
      if (!parsed.success || parsed.data.deliveryId !== delivery.id) throw new FinancialCommandRequestError("The retry may have been queued. Retry the saved request to verify it safely.",{status:200,retryable:true,ambiguous:true,code:"COST_REPORT_RETRY_RESPONSE_INVALID"});
      return parsed.data;
    },retry:shouldRetryFinancialCommand,retryDelay:financialCommandRetryDelay,
    onSuccess:(_result,intent) => {store.current.complete(intent.key);setPending(null);onSaved();},
    onError:(error,intent) => {store.current.fail(intent.key,error);if (!(error instanceof FinancialCommandRequestError && error.ambiguous)) setPending(null);},
  });
  function submit(event:FormEvent) {
    event.preventDefault(); if (mutation.isPending) return;
    if (pending) {mutation.mutate(pending);return;}
    const parsed = retryCostReportSchema.safeParse({reason,expectedAttemptCount:delivery.attemptCount});
    if (!parsed.success) {setValidation("Enter a reason of at least three characters.");return;}
    const intent = {key:store.current.acquire({deliveryId:delivery.id,body:parsed.data}),body:parsed.data};
    setPending(intent);setValidation(null);mutation.mutate(intent);
  }
  return <form onSubmit={submit} className="mt-3 space-y-2">
    <Label htmlFor={`retry-report-${delivery.id}`}>Reason for retry</Label>
    <Textarea id={`retry-report-${delivery.id}`} value={reason} onChange={(event) => setReason(event.target.value)} disabled={mutation.isPending || pending !== null} maxLength={1000} />
    {(validation || mutation.error) && <p role="alert" className="text-sm text-destructive">{validation ?? mutation.error?.message}</p>}
    {mutation.isSuccess && <p role="status">Retry queued. Delivery uses the same retained report.</p>}
    <Button type="submit" size="sm" disabled={mutation.isPending || mutation.isSuccess}>{mutation.isPending ? "Saving retry…" : pending ? "Verify saved retry" : "Retry report"}</Button>
  </form>;
}

export function PurchaseCostReporting({purchaseOrderId}: {purchaseOrderId:number}) {
  const {hasPermission} = useAuth();
  const query = useQuery({queryKey:[`/api/purchase-orders/${purchaseOrderId}/cost-reporting`],queryFn:async ({signal}) => {
    const response = await fetch(`/api/purchase-orders/${purchaseOrderId}/cost-reporting`,{credentials:"include",signal});
    if (!response.ok) throw new Error(`Reporting status could not be loaded (HTTP ${response.status}).`);
    const result = costReportDeliveryListSchema.parse(await response.json());
    if (result.purchaseOrderId !== purchaseOrderId) throw new Error("Reporting status belongs to a different purchase.");
    return result;
  },refetchInterval:30_000});
  const data = query.data;
  return <section aria-label="Archon cost reporting" className="space-y-3 rounded-lg border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Archon cost reporting</h3><Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>Refresh reporting</Button></div>
    <p className="text-sm text-muted-foreground">Applied purchase cost changes and their COGS adjustment totals are delivered as retained reporting evidence. Accounting posting remains in Archon.</p>
    {query.isLoading && <p role="status">Loading delivery status…</p>}
    {query.error && <p role="alert">{query.error instanceof Error ? query.error.message : "Reporting status is unavailable."}{data && " Previously loaded records are shown."}</p>}
    {data && <>
      {data.configuration !== "enabled" && <p className="rounded border bg-muted/30 p-3 text-sm">{data.configuration === "invalid" ? "Reporting configuration needs attention." : data.configuration === "disabled" ? "Report delivery is disabled." : "An Archon reporting destination has not been configured."} Retained source events remain available for delivery after setup.</p>}
      {data.unqueuedEventCount > 0 && <p className="text-sm">{data.unqueuedEventCount} retained cost {data.unqueuedEventCount === 1 ? "event awaits" : "events await"} delivery preparation.</p>}
      {data.deliveries.length === 0 && <p className="text-sm text-muted-foreground">No cost report deliveries have been prepared for this purchase.</p>}
      {data.deliveries.map((delivery) => <details key={delivery.id} className="rounded border p-3">
        <summary className="cursor-pointer text-sm font-medium">Event {delivery.sourceEventId} · {states[delivery.state]} · {delivery.attemptCount} {delivery.attemptCount === 1 ? "attempt" : "attempts"}</summary>
        <dl className="mt-3 grid gap-2 break-all text-xs sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Delivery</dt><dd>{delivery.id}</dd></div><div><dt className="text-muted-foreground">Destination</dt><dd>{delivery.destinationId}</dd></div>
          <div><dt className="text-muted-foreground">Cost application</dt><dd>{delivery.applicationId}</dd></div><div><dt className="text-muted-foreground">Last updated</dt><dd>{new Date(delivery.updatedAt).toLocaleString()}</dd></div>
          {delivery.nextAttemptAt && <div><dt className="text-muted-foreground">Next automatic attempt</dt><dd>{new Date(delivery.nextAttemptAt).toLocaleString()}</dd></div>}
          {delivery.acknowledgement && <><div><dt className="text-muted-foreground">Archon receipt</dt><dd>{delivery.acknowledgement.receiptId}</dd></div><div><dt className="text-muted-foreground">Retained at</dt><dd>{new Date(delivery.acknowledgement.acceptedAt).toLocaleString()}</dd></div><div className="sm:col-span-2"><dt className="text-muted-foreground">Verified report hash</dt><dd>{delivery.acknowledgement.reportHash}</dd></div></>}
        </dl>
        {delivery.lastErrorMessage && <p className="mt-3 text-sm text-amber-800 dark:text-amber-300">{delivery.lastErrorMessage}</p>}
        {data.configuration === "enabled" && hasPermission("purchasing","approve") && (delivery.state === "retry_required" || delivery.state === "dead_letter") && !["COST_REPORT_SOURCE_INVALID","COST_REPORT_SOURCE_CONFLICT","COST_REPORT_TOO_LARGE"].includes(delivery.lastErrorCode ?? "") && <RetryReport purchaseOrderId={purchaseOrderId} delivery={delivery} onSaved={() => void query.refetch()} />}
      </details>)}
      {data.truncated && <p className="text-sm">Showing the latest 500 deliveries for this purchase.</p>}
    </>}
  </section>;
}
