import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { apInvoiceTransitionPreviewSchema, apInvoiceTransitionReceiptSchema, type ApInvoiceTransitionAction,
  type ApInvoiceTransitionInput, type ApInvoiceTransitionPreview } from "@shared/procurement/ap-invoice-transition";
import { exactMoneyAsInput } from "@/lib/exact-money-input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { createFinancialCommandIntentStore, financialCommandFetchJson, FinancialCommandRequestError,
  shouldRetryFinancialCommand, financialCommandRetryDelay } from "@/lib/financial-command";

const labels: Record<ApInvoiceTransitionAction, string> = { approve: "Approve invoice", dispute: "Dispute invoice", void: "Void invoice" };
const state = (value: string) => value.replaceAll("_", " ");
const money = (amount: number | null, digits: 2 | 4, currency: string) => amount === null ? "Not yet verified" : `${exactMoneyAsInput(amount, digits)} ${currency}`;

export function InvoiceTransitionImpact({ preview }: { preview: ApInvoiceTransitionPreview }) {
  const rows: Array<[string, string, string]> = [
    ["Invoice status", state(preview.before.status), state(preview.after.status)],
    ["Invoice amount", money(preview.before.amountCents, 2, preview.before.currency), money(preview.after.amountCents, 2, preview.after.currency)],
    ["Paid", money(preview.before.paidCents, 2, preview.before.currency), money(preview.after.paidCents, 2, preview.after.currency)],
    ["Balance", money(preview.before.balanceCents, 2, preview.before.currency), money(preview.after.balanceCents, 2, preview.after.currency)],
    ...preview.inventoryValues.map(row => [`${row.lotNumber} · value of ${row.onHandUnits.toLocaleString()} stock units`, money(row.beforeMills, 4, "USD"), money(row.afterMills, 4, "USD")] as [string, string, string]),
    ...preview.impact.orderCosts.filter(row => row.totalMills.before !== row.totalMills.after).map(row => [`Order #${row.orderId} · cost basis`, money(row.totalMills.before, 4, "USD"), money(row.totalMills.after, 4, "USD")] as [string, string, string]),
    ...preview.impact.historicalCosts.filter(row => row.totalMills.before !== row.totalMills.after).map(row => [row.destination === "historical_cogs" ? "Previously approved cost of sold goods" : "Previously approved inventory expense", money(row.totalMills.before, 4, "USD"), money(row.totalMills.after, 4, "USD")] as [string, string, string]),
  ];
  return <div className="space-y-3 text-sm">
    <table className="w-full table-fixed"><thead><tr className="border-b"><th className="w-[45%] text-left py-2">What changes</th><th className="text-right p-2">Before</th><th className="text-right py-2">After</th></tr></thead>
      <tbody>{rows.map(([label, before, after], index) => <tr className="border-b" key={index}><th className="text-left py-2 pr-2 font-normal break-words">{label}</th><td className="text-right p-2 break-words">{before}</td><td className="text-right py-2 break-words font-medium">{after}</td></tr>)}</tbody></table>
    <p>Invoice line amounts, payments, stock counts, receipts and shipments stay unchanged. Review the approval, purchase balances and stock cost changes shown here.</p>
    {preview.purchaseOrders.length > 0 && <details><summary className="cursor-pointer font-medium">Purchase order shares ({preview.purchaseOrders.length})</summary>
      <table className="w-full table-fixed mt-2"><thead><tr className="border-b"><th className="w-[45%] text-left py-2">Purchase order</th><th className="text-right p-2">Before</th><th className="text-right py-2">After</th></tr></thead>
        <tbody>{preview.purchaseOrders.flatMap(row => [
          [`PO #${row.purchaseOrderId} · invoice share`, money(row.before.evidence.invoicedAmountCents, 2, row.before.evidence.currency), money(row.after.evidence.invoicedAmountCents, 2, row.after.evidence.currency)],
          [`PO #${row.purchaseOrderId} · amount due`, money(row.before.evidence.outstandingAmountCents, 2, row.before.evidence.currency), money(row.after.evidence.outstandingAmountCents, 2, row.after.evidence.currency)],
          [`PO #${row.purchaseOrderId} · financial status`, state(row.before.state), state(row.after.state)],
        ]).map(([label, before, after], index) => <tr className="border-b" key={index}><th className="text-left font-normal break-words py-2 pr-2">{label}</th><td className="text-right p-2 break-words">{before}</td><td className="text-right py-2 break-words">{after}</td></tr>)}</tbody></table>
      {preview.purchaseOrders.flatMap(row => row.after.evidence.reviewReasons.map(reason => <p key={`${row.purchaseOrderId}:${reason.code}:${reason.invoiceId}`}>PO #{row.purchaseOrderId}: {reason.message}</p>))}
    </details>}
    {preview.before.approvedAt && <p>Original approval: {preview.before.approvedBy} · {new Date(preview.before.approvedAt).toLocaleString()}. This approval is retained.</p>}
    {preview.inventoryValues.filter(row => row.reviewReason).map(row => <p className="text-amber-700" key={row.lotId}>{row.lotNumber}: {row.reviewReason}</p>)}
    {preview.costReviews.filter(row => row.state === "review_required").map(row => <div className="rounded border p-2" key={row.purchaseOrderLineId}>
      <p className="font-medium">Purchase line #{row.purchaseOrderLineId} still needs cost review</p>
      {row.issues.length ? row.issues.map((issue, index) => <p key={index}>{issue.message}</p>) : <p>The recorded supplier amounts do not yet establish a complete inventory cost.</p>}
    </div>)}
  </div>;
}

type Intent = { key: string; body: ApInvoiceTransitionInput };
export function InvoiceTransitionReview({ invoiceId, action, onClose, onSaved }: {
  invoiceId: number; action: ApInvoiceTransitionAction; onClose: () => void; onSaved: () => void;
}) {
  const [reason, setReason] = useState(action === "approve" ? "Supplier invoice checked and approved." : "");
  const [preview, setPreview] = useState<ApInvoiceTransitionPreview | null>(null);
  const [unresolved, setUnresolved] = useState<Intent | null>(null);
  const [saved, setSaved] = useState<z.infer<typeof apInvoiceTransitionReceiptSchema> | null>(null);
  const store = useRef(createFinancialCommandIntentStore(() => crypto.randomUUID()));
  const endpoint = `/api/vendor-invoices/${invoiceId}/${action}`;
  const review = useMutation<ApInvoiceTransitionPreview, Error, void>({ mutationFn: async () => {
    const result = apInvoiceTransitionPreviewSchema.parse(await financialCommandFetchJson(`${endpoint}/preview`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) }));
    if (result.invoiceId !== invoiceId || result.action !== action || result.reason !== reason.trim()) throw new Error("The review does not match this invoice action. Reload and try again.");
    return result;
  }, onSuccess: setPreview });
  const save = useMutation<z.infer<typeof apInvoiceTransitionReceiptSchema>, Error, Intent>({ mutationFn: async (intent: Intent) => {
    const result = await financialCommandFetchJson<unknown>(endpoint, { method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": intent.key }, body: JSON.stringify(intent.body) });
    const receipt = z.object({ transitionReview: apInvoiceTransitionReceiptSchema }).safeParse(result);
    if (!receipt.success || receipt.data.transitionReview.preview.invoiceId !== invoiceId || receipt.data.transitionReview.preview.action !== action
      || receipt.data.transitionReview.preview.previewVersion !== intent.body.previewVersion) throw new FinancialCommandRequestError(
      "The action may have saved, but its confirmation was incomplete. Retry the saved request safely.", { status: 200, retryable: true, ambiguous: true, code: "AP_INVOICE_TRANSITION_RESPONSE_INVALID" });
    return receipt.data.transitionReview;
  }, retry: shouldRetryFinancialCommand, retryDelay: financialCommandRetryDelay,
  onSuccess: (result, intent) => { store.current.complete(intent.key); setUnresolved(null); setSaved(result); },
  onError: (error, intent) => { store.current.fail(intent.key, error); setUnresolved(error instanceof FinancialCommandRequestError && error.ambiguous ? intent : null); },
  onSettled: onSaved });
  const error = save.error ?? review.error;
  const stale = error instanceof FinancialCommandRequestError && error.code === "AP_INVOICE_TRANSITION_STALE";
  const locked = review.isPending || save.isPending || unresolved !== null;
  function approve() {
    if (!preview || locked || stale) return;
    const body = { reason: preview.reason, previewVersion: preview.previewVersion };
    const intent = { key: store.current.acquire({ endpoint, body }), body };
    save.mutate(intent);
  }
  return <Dialog open onOpenChange={open => { if (!open && !locked) onClose(); }}><DialogContent className="max-w-2xl max-h-[92dvh] flex flex-col">
    <DialogHeader><DialogTitle>{labels[action]}</DialogTitle><DialogDescription>Review the invoice status and stock cost changes before saving.</DialogDescription></DialogHeader>
    <div className="min-h-0 overflow-y-auto space-y-4 pr-1">
      {!preview && <><Label htmlFor="invoice-transition-reason">Reason / supplier reference</Label><Textarea id="invoice-transition-reason" value={reason} maxLength={2000} disabled={locked} onChange={event => setReason(event.target.value)} /></>}
      {preview && <InvoiceTransitionImpact preview={saved?.preview ?? preview} />}
      {preview && <p className="text-sm">Reason: {preview.reason}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
      {saved && <p role="status" className="rounded border border-green-600 p-3 text-sm">Saved by {saved.actorName} · {new Date(saved.approvedAt).toLocaleString()}. The reviewed changes and approval details are retained in history.</p>}
    </div>
    <div className="flex flex-wrap justify-end gap-2 border-t pt-3">
      <Button variant="outline" disabled={locked} onClick={onClose}>Close review</Button>
      {!saved && !preview && <Button disabled={locked || !reason.trim()} onClick={() => review.mutate()}>{review.isPending ? "Loading changes…" : "Review changes"}</Button>}
      {!saved && preview && !unresolved && <><Button variant="outline" disabled={locked} onClick={() => { setPreview(null); save.reset(); }}>Review again</Button><Button disabled={locked || stale} onClick={approve}>{save.isPending ? "Saving…" : labels[action]}</Button></>}
      {unresolved && <Button disabled={save.isPending} onClick={() => save.mutate(unresolved)}>Retry saved request</Button>}
    </div>
  </DialogContent></Dialog>;
}

export function InvoiceTransitionHistory({ invoiceId }: { invoiceId: number }) {
  const history = useQuery({ queryKey: [`/api/vendor-invoices/${invoiceId}/transition-history`], queryFn: async () =>
    z.array(apInvoiceTransitionReceiptSchema).parse(await financialCommandFetchJson(`/api/vendor-invoices/${invoiceId}/transition-history`, { method: "GET" })) });
  if (history.isError) return <p role="alert" className="text-sm text-destructive">Invoice approval history is unavailable. <button className="underline" onClick={() => void history.refetch()}>Retry</button></p>;
  if (!history.data?.length) return null;
  return <section aria-label="Invoice approval history" className="rounded border p-3 space-y-2"><h2 className="font-semibold">Invoice approval history</h2>
    {history.data.map((receipt, index) => <details key={`${receipt.approvedAt}:${index}`} className="text-sm"><summary className="cursor-pointer">{labels[receipt.preview.action]} · {receipt.actorName} · {new Date(receipt.approvedAt).toLocaleString()}</summary>
      <p className="my-2">{receipt.preview.reason}</p><InvoiceTransitionImpact preview={receipt.preview} /></details>)}
  </section>;
}
