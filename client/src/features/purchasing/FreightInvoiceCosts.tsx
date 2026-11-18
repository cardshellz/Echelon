import { useRef, useState } from "react";
import { Link } from "wouter";
import { z } from "zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { freightInvoiceContextSchema, freightInvoicePreviewSchema, freightInvoiceResultSchema,
  freightInvoiceApprovalRequestSchema, freightInvoiceApprovalHistorySchema, type FreightInvoicePreview } from "@shared/procurement/freight-invoice-costs";
import { canonicalJson } from "@shared/utils/canonical-json";
import { financialCommandFetchJson, financialCommandNeedsRecovery, FinancialCommandRequestError,
  shouldRetryFinancialCommand, financialCommandRetryDelay } from "@/lib/financial-command";
import { invalidatePurchaseCosts } from "@/lib/invalidate-purchase-costs";
import { exactMoneyAsInput } from "@/lib/exact-money-input";
import { useAuth } from "@/lib/auth";
import { useProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { createFreightInvoiceIntentStore, type FreightInvoiceIntent } from "./freight-invoice-cost-intent";

type Context = z.infer<typeof freightInvoiceContextSchema>;
const money = (value: number | null, scale: 2 | 4 = 2) => value === null ? "Not yet verified" : `$${exactMoneyAsInput(value, scale)}`;
function Changes({ preview, approved = false }: { preview: FreightInvoicePreview; approved?: boolean }) {
  const navigation = useProcurementNavigation();
  return <section aria-label="Shipment cost changes" className="space-y-3">
    <div className="overflow-x-auto"><table className="w-full text-sm">
      <thead><tr className="border-b"><th className="py-2 text-left">Charge</th><th className="px-3 text-right">Before</th><th className="text-right">After</th></tr></thead>
      <tbody>{preview.charges.map(row => <tr className="border-b" key={row.chargeId}>
        <td className="py-2">{row.label}<span className="block text-xs text-muted-foreground">Original estimate {money(row.estimatedCents)}</span></td>
        <td className="px-3 text-right tabular-nums">{money(row.actualCents ?? row.estimatedCents)}</td><td className="text-right font-semibold tabular-nums">{money(row.invoiceCents)}</td>
      </tr>)}</tbody>
    </table></div>
    <p className="text-sm">Invoice {money(preview.invoiceAmountCents)} · Paid {money(preview.paidAmountCents)} · Balance {money(preview.balanceCents)}</p>
    <p className="text-sm">Invoice status: {preview.invoiceStatus.before.replaceAll("_", " ")} → {preview.invoiceStatus.after.replaceAll("_", " ")}</p>
    <details><summary className="cursor-pointer text-sm font-medium">Shipment and PO cost shares</summary>
      <ul className="mt-2 space-y-2 text-sm">{preview.allocations.map(row => <li key={`${row.chargeId}:${row.shipmentLineId}`}>
        {row.purchaseOrderId !== null && <Link href={navigation.childHref(`/purchase-orders/${row.purchaseOrderId}?tab=lines&poScope=${row.purchaseOrderId}&shipmentLine=${row.shipmentLineId}`)} className="text-blue-600 underline">{row.purchaseOrderNumber ?? `PO #${row.purchaseOrderId}`}</Link>}
        <span> · {row.label}: {money(row.amountCents.before)} → <strong>{money(row.amountCents.after)}</strong></span>
      </li>)}</ul>
    </details>
    <details><summary className="cursor-pointer text-sm font-medium">Stock and order cost changes</summary>
      <div className="mt-2 space-y-2 text-sm">
        {preview.inventoryValues.filter(row => row.beforeMills !== row.afterMills || row.reviewReason).map(row => <p key={row.lotId}>
          {row.lotNumber} · value of {row.onHandUnits.toLocaleString()} units on hand: {money(row.beforeMills, 4)} → <strong>{money(row.afterMills, 4)}</strong>{row.reviewReason && <span className="block text-amber-700">{row.reviewReason}</span>}
        </p>)}
        {preview.impact.orderCosts.filter(row => row.totalMills.before !== row.totalMills.after).map(row => <p key={row.costId}>Order #{row.orderId} cost basis: {money(row.totalMills.before, 4)} → <strong>{money(row.totalMills.after, 4)}</strong></p>)}
        {preview.impact.historicalCosts.filter(row => row.totalMills.before !== row.totalMills.after).map((row, index) => <p key={index}>Previously approved {row.destination === "historical_cogs" ? "cost of goods sold" : "inventory adjustment"}: {money(row.totalMills.before, 4)} → <strong>{money(row.totalMills.after, 4)}</strong></p>)}
        <p className="text-muted-foreground">Stock quantities and payments stay unchanged. Updating order cost basis does not establish a sale or create a new expense.</p>
      </div>
    </details>
    {preview.shipmentStates.map(row => <p className="text-sm" key={row.shipmentId}>
      <Link className="text-blue-600 underline" href={navigation.childHref(`/shipments/${row.shipmentId}?tab=allocation`)}>{row.shipmentNumber}</Link>
      {row.state === "pending_finalization" ? (approved ? ": Shares updated. Finish shipment costing to update inventory." : ": Approval updates the shares. Finish shipment costing to update inventory.")
        : row.state === "review_required" ? (approved ? ": The cost update recorded remaining items for review below." : ": These costs can be saved, with the remaining items shown below for review.")
        : approved ? ": These charges updated linked inventory and order costs." : ": After approval, these charges update linked inventory and order costs."}
    </p>)}
    {preview.issues.length > 0 && <div role="status" className="rounded border border-amber-300 p-3 text-sm"><strong>Items still needing attention</strong>
      <ul className="list-disc pl-4">{preview.issues.map((row, index) => <li key={index}>{row.message}</li>)}</ul></div>}
  </section>;
}
function Review({ invoiceId, userId, context, contextError, reload, busy }: {
  invoiceId: number; userId: string; context: Context | null; contextError: string | null;
  reload: () => void; busy: (value: boolean) => void;
}) {
  const client = useQueryClient(), navigation = useProcurementNavigation();
  const [store] = useState(() => createFreightInvoiceIntentStore(userId, invoiceId, () => sessionStorage));
  const [recovery] = useState(() => { try { return { intent: store.read(), error: null }; } catch (error) { return { intent: null, error: error instanceof Error ? error.message : "Saved approval is unavailable." }; } });
  const [pending, setPending] = useState<FreightInvoiceIntent | null>(recovery.intent), active = useRef(recovery.intent);
  const [review, setReview] = useState<FreightInvoicePreview | null>(null), [saved, setSaved] = useState<z.infer<typeof freightInvoiceResultSchema> | null>(null);
  const [reason, setReason] = useState(""), [confirmed, setConfirmed] = useState(false), [stale, setStale] = useState(false), [error, setError] = useState<string | null>(recovery.error);
  const endpoint = `/api/vendor-invoices/${invoiceId}/shipment-cost-review`;
  const preview = useMutation({
    mutationFn: async () => freightInvoicePreviewSchema.parse(await financialCommandFetchJson(`${endpoint}/preview`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceVersion: context?.sourceVersion }),
    })),
    onMutate: () => { busy(true); setError(null); setReview(null); setConfirmed(false); },
    onSuccess: value => setReview(value),
    onError: (failure: Error) => { setError(failure.message); if (failure instanceof FinancialCommandRequestError && failure.code === "FREIGHT_INVOICE_STALE") setStale(true); },
    onSettled: () => busy(false),
  });
  const approval = useMutation<z.infer<typeof freightInvoiceResultSchema>, Error, FreightInvoiceIntent>({
    mutationFn: async intent => {
      const result = freightInvoiceResultSchema.safeParse(await financialCommandFetchJson(`${endpoint}/approve`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": intent.key }, body: JSON.stringify(intent.body.request),
      }));
      if (!result.success || canonicalJson(result.data.preview) !== canonicalJson(intent.body.preview))
        throw new FinancialCommandRequestError("Approval may have saved. Retry the saved approval to verify its result.", { status: 200, ambiguous: true, retryable: true, code: "FREIGHT_INVOICE_RESULT_UNVERIFIED" });
      return result.data;
    },
    retry: shouldRetryFinancialCommand, retryDelay: financialCommandRetryDelay,
    onMutate: () => { busy(true); setError(null); },
    onSuccess: (result, intent) => {
      setSaved(result); setPending(null); active.current = null; setStale(false);
      try { store.complete(intent.key); }
      catch (failure) { setError(failure instanceof Error ? failure.message : "Costs saved; browser recovery remains."); }
    },
    onError: failure => {
      setError(failure.message);
      if (!financialCommandNeedsRecovery(failure)) {
        try { if (active.current) store.complete(active.current.key); active.current = null; setPending(null); setStale(true); }
        catch { setError("Approval was rejected, but its browser recovery could not be cleared. Reopen and verify that saved approval."); }
      }
    },
    onSettled: () => { busy(false); void invalidatePurchaseCosts(client); },
  });
  const locked = preview.isPending || approval.isPending || pending !== null || saved !== null || stale || recovery.error !== null;
  const shown = saved?.preview ?? pending?.body.preview ?? review;
  function approve() {
    if (!review || active.current || !context?.canApprove || !confirmed) return;
    try {
      const request = freightInvoiceApprovalRequestSchema.parse({ sourceVersion: review.sourceVersion, previewVersion: review.previewVersion, reason, approvalConfirmed: true });
      const intent = store.acquire({ request, preview: review }, () => crypto.randomUUID());
      active.current = intent; setPending(intent); approval.mutate(intent);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Enter a reason and confirm the reviewed changes."); }
  }
  return <div className="space-y-4">
    {(error || contextError) && <p role="alert" className="text-sm text-red-700">{error || contextError}</p>}
    {!context && !contextError && !pending && <p>Loading saved invoice and shipment costs…</p>}
    {context?.blockedReason && !pending && <p role="status" className="rounded bg-amber-50 p-3 text-sm">{context.blockedReason}</p>}
    {context && !context.blockedReason && !context.requiresChange && !pending && !saved && <div className="rounded border border-green-300 p-3 text-sm">
      <strong>Invoice amounts already match the saved shipment charges.</strong>
      {context.originalApproval.approvedAt && <p>Invoice approved by {context.originalApproval.actorName ?? context.originalApproval.actorId} · {new Date(context.originalApproval.approvedAt).toLocaleString()}</p>}
      <p>Use the shipment cost review for any remaining inventory work; another approval of the same charge amounts is not needed.</p>
    </div>}
    {context && !shown && context.charges.map(row => <p className="text-sm" key={row.chargeId}>{row.label}: saved {money(row.actualCents ?? row.estimatedCents)} · Invoice <strong>{money(row.invoiceCents)}</strong></p>)}
    {shown && <><h3 className="font-semibold">{saved ? "Approved cost update" : pending ? "Saved approval awaiting confirmation" : "What changes"}</h3><Changes preview={shown} approved={saved !== null} /></>}
    {context?.requiresChange && !context.blockedReason && !shown && !stale && <Button onClick={() => preview.mutate()} disabled={locked}>Review changes</Button>}
    {review && !pending && !saved && !stale && <div className="space-y-3 border-t pt-3">
      <label className="block text-sm">Reason / supplier reference<Textarea className="mt-1" value={reason} onChange={event => setReason(event.target.value)} disabled={locked} /></label>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={locked} />I checked the supplier invoice and reviewed these changes.</label>
      <Button onClick={approve} disabled={locked || !confirmed || reason.trim().length < 10 || !context?.canApprove}>Approve &amp; update costs</Button>
    </div>}
    {pending && !saved && <Button onClick={() => approval.mutate(pending)} disabled={approval.isPending}>Retry saved approval</Button>}
    {(stale || contextError) && !pending && !saved && <Button variant="outline" onClick={reload}>Reload current costs</Button>}
    {context && <div className="flex flex-wrap gap-3 text-sm">{context.shipments.map(row => <Link key={row.id} className="text-blue-600 underline" href={navigation.childHref(`/shipments/${row.id}?tab=allocation`)}>Review {row.number}</Link>)}</div>}
    {context?.history.map((entry, index) => <details className="border-t pt-3 text-sm" key={index}><summary className="cursor-pointer">Approved by {entry.actorName} · {new Date(entry.approvedAt).toLocaleString()}</summary>
      <p className="my-2">{entry.reason}</p><Changes preview={entry.preview} approved /></details>)}
  </div>;
}
export function FreightInvoiceCosts({ invoiceId, label = "Shipment costs" }: { invoiceId: number; label?: string }) {
  const { user } = useAuth(), [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [generation, setGeneration] = useState(0);
  const endpoint = `/api/vendor-invoices/${invoiceId}/shipment-cost-review`;
  const context = useQuery({ queryKey: [endpoint, user?.id], enabled: open && !!user?.id,
    queryFn: async () => freightInvoiceContextSchema.parse(await financialCommandFetchJson(endpoint, { method: "GET" })) });
  const contextError = context.isError ? (context.error instanceof Error ? context.error.message : "Current cost review is unavailable.") : null;
  const reload = async () => { await context.refetch(); setGeneration(value => value + 1); };
  return <>
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}>{label}</Button>
    <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next); }}><DialogContent className="flex max-h-[92dvh] w-[calc(100%-1rem)] max-w-3xl flex-col overflow-hidden">
      <DialogHeader><DialogTitle>Use invoice amounts for shipment costs</DialogTitle><DialogDescription>Review the billed charges and their effect on stock and order costs. One administrator approval saves this update.</DialogDescription></DialogHeader>
      <div className="min-h-0 overflow-y-auto pr-1">{open && user?.id && <Review key={`${user.id}:${invoiceId}:${generation}`} invoiceId={invoiceId} userId={user.id} context={context.data ?? null} contextError={contextError} reload={() => { void reload(); }} busy={setBusy} />}</div>
      <div className="border-t pt-3"><Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Close</Button></div>
    </DialogContent></Dialog>
  </>;
}

export function FreightInvoiceApprovalHistory({ purchaseOrderId }: { purchaseOrderId: number }) {
  const endpoint = `/api/purchase-orders/${purchaseOrderId}/freight-invoice-cost-approvals`;
  const history = useQuery({ queryKey: [endpoint], queryFn: async () => freightInvoiceApprovalHistorySchema.parse(await financialCommandFetchJson(endpoint, { method: "GET" })) });
  if (history.isError) return <p role="alert" className="text-sm">Freight approval history could not be loaded. <Button variant="link" onClick={() => { void history.refetch(); }}>Retry history</Button></p>;
  if (!history.data?.length) return null;
  return <section aria-label="Approved freight invoice costs" className="space-y-3 rounded border p-3">
    <h3 className="font-semibold">Approved freight invoice costs</h3>
    {history.data.map((entry, index) => <details key={index}><summary className="cursor-pointer text-sm">{entry.preview.invoiceNumber} · {entry.actorName} · {new Date(entry.approvedAt).toLocaleString()}</summary>
      <p className="my-2 text-sm">{entry.reason}</p><Changes preview={entry.preview} approved /></details>)}
  </section>;
}
