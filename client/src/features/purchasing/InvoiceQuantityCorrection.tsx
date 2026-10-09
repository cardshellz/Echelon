import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { invoiceQuantityContextSchema, invoiceQuantityPreviewSchema, invoiceQuantityApprovalRequestSchema, invoiceQuantityResultSchema,
  type InvoiceQuantityContext, type InvoiceQuantityPreview, type InvoiceQuantityApprovalRequest, type InvoiceQuantityResult } from "@shared/procurement/invoice-quantity-correction";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { exactMoneyAsInput } from "@/lib/exact-money-input";
import { financialCommandFetchJson, FinancialCommandRequestError, shouldRetryFinancialCommand, financialCommandRetryDelay } from "@/lib/financial-command";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

const intentSchema = z.object({ key: z.string().uuid(), body: invoiceQuantityApprovalRequestSchema, preview: invoiceQuantityPreviewSchema }).strict();
type Intent = z.infer<typeof intentSchema>;
const matchNames: Record<InvoiceQuantityPreview["beforeMatch"], string> = {
  matched: "Matched", qty_discrepancy: "Quantity mismatch", price_discrepancy: "Price mismatch", over_billed: "More invoiced than received", pending: "Pending", po_line_missing: "PO line missing",
};
function amount(cents: number, currency: string) {
  const formatted = exactMoneyAsInput(cents, 2).replace(/\B(?=(\d{3})+\.)/g, ",");
  return currency === "USD" ? `$${formatted}` : `${formatted} ${currency}`;
}
export function InvoiceQuantityImpact({ preview, currency }: { preview: InvoiceQuantityPreview; currency: string }) {
  const sameMoney = amount(preview.invoiceLineAmountCents, currency);
  const perPiece = (value: string) => currency === "USD" ? `$${value}` : `${value} ${currency}`;
  const rows: [string, string, string][] = [
    ["Invoice quantity", preview.beforeQuantity.toLocaleString("en-US"), preview.afterQuantity.toLocaleString("en-US")],
    ["This line's amount", sameMoney, sameMoney],
    ["Bill per piece", perPiece(preview.beforeAmountPerPiece), perPiece(preview.afterAmountPerPiece)],
    ["Match result", matchNames[preview.beforeMatch], matchNames[preview.afterMatch]],
  ];
  return <div className="space-y-2">
    <p className="rounded bg-muted p-2 text-sm">PO ordered: <strong>{preview.orderedQuantity.toLocaleString("en-US")}</strong> pieces · Received: <strong>{preview.receivedQuantity.toLocaleString("en-US")}</strong> pieces</p>
    <table className="w-full table-fixed text-sm" aria-label="Quantity correction impact">
      <thead><tr className="border-b"><th className="w-[40%] py-2 text-left">What changes</th><th className="w-[30%] pl-2 text-right">Current</th><th className="w-[30%] pl-2 text-right">After correction</th></tr></thead>
      <tbody>{rows.map(([name, before, after]) => <tr key={name} className="border-b"><th scope="row" className="py-2 pr-2 text-left font-normal break-words">{name}</th><td className="pl-2 text-right break-words">{before}</td><td className={`pl-2 text-right break-words ${before !== after ? `font-semibold ${name === "Match result" && preview.afterMatch !== "matched" ? "text-amber-800 dark:text-amber-300" : "text-green-800 dark:text-green-300"}` : ""}`}>{after}</td></tr>)}</tbody>
    </table>
    <p className="text-xs text-muted-foreground">Bill per piece is this line's amount divided by its quantity. Unit price on invoice: {exactMoneyAsInput(preview.recordedUnitCostMills, 4)} {currency} (unchanged).</p>
    <dl className="grid grid-cols-3 gap-2 rounded bg-muted p-2 text-xs">
      <div><dt>Invoice total</dt><dd className="font-semibold">{amount(preview.invoiceAmountCents, currency)}</dd></div>
      <div><dt>Paid</dt><dd className="font-semibold">{amount(preview.paidAmountCents, currency)}</dd></div>
      <div><dt>Balance</dt><dd className="font-semibold">{amount(preview.balanceCents, currency)}</dd></div>
    </dl>
    <p className="text-xs text-muted-foreground">Amounts, payments, receipts, stock and inventory costs stay unchanged.</p>
    {preview.otherInvoicedQuantity > 0 && <p className="text-sm">Other invoice lines already cover {preview.otherInvoicedQuantity.toLocaleString("en-US")} pieces.</p>}
    {preview.remainingIssues.length > 0 && <p className="text-sm text-amber-800 dark:text-amber-300">After this change, {preview.remainingIssues.length} invoice line(s) on this PO still need review.</p>}
    {preview.warnings.map((warning) => <p key={warning} className="text-sm text-amber-800 dark:text-amber-300">{warning}</p>)}
  </div>;
}
function QuantityEditor({ loaded, storageKey, onSaved, setBusy, onReload, onClose }: {
  loaded: InvoiceQuantityContext; storageKey: string; onSaved: () => void; setBusy: (value: boolean) => void; onReload: () => void; onClose: () => void;
}) {
  const [context] = useState(loaded); // Freeze the evidence being reviewed until an explicit reload.
  const root = `/api/vendor-invoice-lines/${context.invoiceLineId}/quantity-correction`;
  const recovery = useRef<{ intent: Intent | null; error: string | null } | null>(null);
  if (recovery.current === null) {
    try {
      const raw = sessionStorage.getItem(storageKey);
      const intent = raw === null ? null : intentSchema.parse(JSON.parse(raw));
      if (intent && (intent.preview.invoiceLineId !== context.invoiceLineId || intent.preview.invoiceId !== context.invoiceId
        || intent.preview.sourceVersion !== intent.body.sourceVersion || intent.preview.afterQuantity !== intent.body.quantityPieces)) throw new Error("Saved confirmation does not match its preview");
      recovery.current = { intent, error: null };
    } catch { recovery.current = { intent: null, error: "A saved confirmation could not be read. Contact an administrator before submitting another correction." }; }
  }
  const [unresolved, setUnresolved] = useState<Intent | null>(recovery.current.intent);
  const active = useRef<Intent | null>(recovery.current.intent);
  const [quantity, setQuantity] = useState(String(context.suggestedQuantity ?? context.current.beforeQuantity));
  const [reason, setReason] = useState(context.suggestedQuantity === null ? "" : "Correct the invoice quantity to match the PO and received count.");
  const [review, setReview] = useState<InvoiceQuantityPreview | null>(context.suggested);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [saved, setSaved] = useState<InvoiceQuantityResult | null>(null);
  const preview = useMutation({
    mutationFn: async (pieces: number) => {
      const result = invoiceQuantityPreviewSchema.parse(await financialCommandFetchJson(`${root}/preview`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceVersion: context.sourceVersion, quantityPieces: pieces }) }));
      if (result.invoiceLineId !== context.invoiceLineId || result.sourceVersion !== context.sourceVersion || result.afterQuantity !== pieces) throw new Error("The preview does not match this invoice correction. Reload the invoice.");
      return result;
    },
    onMutate: () => setBusy(true), onSuccess: (result) => { setReview(result); setConfirmed(false); },
    onError: (failure) => { if (failure instanceof FinancialCommandRequestError && failure.code === "INVOICE_QUANTITY_STALE") setStale(true); },
    onSettled: () => setBusy(false),
  });
  const approve = useMutation<InvoiceQuantityResult, Error, Intent>({
    mutationFn: async (intent) => {
      const raw = await financialCommandFetchJson(root, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "Idempotency-Key": intent.key }, body: JSON.stringify(intent.body) });
      const result = invoiceQuantityResultSchema.safeParse(raw);
      if (!result.success || result.data.invoiceLineId !== context.invoiceLineId || result.data.preview.sourceVersion !== intent.body.sourceVersion || result.data.preview.afterQuantity !== intent.body.quantityPieces) throw new FinancialCommandRequestError("The correction may have completed. Retry the saved confirmation to verify it.", { status: 200, code: "INVOICE_QUANTITY_RESPONSE_INVALID", retryable: true, ambiguous: true });
      return result.data;
    },
    retry: shouldRetryFinancialCommand, retryDelay: financialCommandRetryDelay,
    onMutate: () => setBusy(true),
    onSuccess: (result) => {
      setSaved(result); setUnresolved(null); active.current = null; setBusy(false);
      try { sessionStorage.removeItem(storageKey); } catch { setError("Correction saved. The browser could not clear its retry receipt; reopening will safely verify the same confirmation."); }
      onSaved();
    },
    onError: (failure, intent) => {
      const ambiguous = failure instanceof FinancialCommandRequestError && (failure.ambiguous || failure.retryable || (failure.status ?? 0) >= 500 || [401, 403].includes(failure.status ?? 0)
        || ["FINANCIAL_COMMAND_CONTRACT_CHANGED", "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED"].includes(failure.code ?? ""));
      if (!ambiguous) { try { sessionStorage.removeItem(storageKey); } catch { setError("The browser could not clear the rejected confirmation. Reload before making another correction."); } }
      active.current = ambiguous ? intent : null; setUnresolved(ambiguous ? intent : null); setBusy(false);
      if (failure instanceof FinancialCommandRequestError && [403, 409].includes(failure.status ?? 0)) setStale(true);
    },
  });
  const blocked = !context.canApprove ? "An Administrator with purchasing approval permission must confirm this correction." : context.blockedReason;
  const locked = preview.isPending || approve.isPending || unresolved !== null || saved !== null || stale || recovery.current.error !== null;
  const impact = saved?.preview ?? unresolved?.preview ?? review ?? context.current;
  function updatePreview() {
    if (locked || blocked) return;
    if (!/^[1-9]\d*$/.test(quantity)) { setError("Enter a positive whole number of pieces."); return; }
    setError(null); preview.mutate(Number(quantity));
  }
  function confirm() {
    if (!review || !confirmed || locked || blocked || active.current || review.afterQuantity === review.beforeQuantity) return;
    try {
      const body = invoiceQuantityApprovalRequestSchema.parse({ sourceVersion: context.sourceVersion, quantityPieces: review.afterQuantity, reason, approvalConfirmed: true });
      const intent: Intent = { key: crypto.randomUUID(), body, preview: review };
      sessionStorage.setItem(storageKey, JSON.stringify(intent)); active.current = intent; setUnresolved(intent); setError(null); approve.mutate(intent);
    } catch { setError("Include a reason of at least 10 characters. Session storage must be available for safe confirmation retries."); }
  }
  return <div className="flex min-h-0 flex-col">
    <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
    {(blocked || recovery.current.error) && <p role="alert" className="text-sm text-destructive">{blocked ?? recovery.current.error}</p>}
    {!saved && !unresolved && <fieldset disabled={locked || !!blocked} className="space-y-3">
      <div><Label htmlFor={`invoice-quantity-${context.invoiceLineId}`}>Correct invoice quantity (pieces)</Label><Input id={`invoice-quantity-${context.invoiceLineId}`} inputMode="numeric" value={quantity} onChange={(event) => { setQuantity(event.target.value); setReview(null); setConfirmed(false); setError(null); }} /><p className="mt-1 text-xs text-muted-foreground">{context.suggestionReason}</p></div>
      {!review && <Button variant="outline" type="button" disabled={locked || !!blocked} onClick={updatePreview}>{preview.isPending ? "Checking changes…" : "Update preview"}</Button>}
    </fieldset>}
    <InvoiceQuantityImpact preview={impact} currency={context.currency} />
    {!saved && !unresolved && <>
      <div><Label htmlFor={`invoice-quantity-reason-${context.invoiceLineId}`}>Why are you changing it?</Label><Textarea id={`invoice-quantity-reason-${context.invoiceLineId}`} value={reason} rows={2} maxLength={2000} disabled={locked || !!blocked} onChange={(event) => { setReason(event.target.value); setConfirmed(false); }} /></div>
      <div className="flex items-start gap-2"><Checkbox id={`invoice-quantity-confirm-${context.invoiceLineId}`} checked={confirmed} disabled={locked || !!blocked || !review || review.beforeQuantity === review.afterQuantity} onCheckedChange={(checked) => setConfirmed(checked === true)} /><Label htmlFor={`invoice-quantity-confirm-${context.invoiceLineId}`}>I checked the supplier invoice and reviewed these changes.</Label></div>
    </>}
    {(error || preview.error || approve.error) && <p role="alert" className="text-sm text-destructive">{error ?? approve.error?.message ?? preview.error?.message}</p>}
    {saved && <p role="status" className="rounded border border-green-300 bg-green-50 p-3 font-semibold text-green-900">Invoice quantity confirmed and saved. {matchNames[saved.preview.afterMatch]}.</p>}
    </div>
    <div className="mt-4 shrink-0 border-t pt-3">
      <div className="flex gap-2">
        <Button variant="outline" aria-label="Close quantity correction" className="min-h-[44px]" disabled={preview.isPending || approve.isPending} onClick={onClose}>Close</Button>
        {!saved && !unresolved && <Button className="min-h-[44px] flex-1 bg-green-700 text-white hover:bg-green-800" disabled={locked || !!blocked || !review || !confirmed || review.beforeQuantity === review.afterQuantity} onClick={confirm}>{approve.isPending ? "Saving correction…" : "Confirm quantity"}</Button>}
        {unresolved && <Button className="min-h-[44px] flex-1" disabled={approve.isPending} onClick={() => approve.mutate(unresolved)}>{approve.isPending ? "Verifying confirmation…" : "Retry saved confirmation"}</Button>}
      </div>
      {stale && !unresolved && <Button className="mt-2 w-full" variant="outline" onClick={onReload}>Reload invoice and review again</Button>}
    </div>
  </div>;
}
export function InvoiceQuantityCorrection({ lineId, lineNumber, needsCorrection, onSaved }: { lineId: number; lineNumber: number; needsCorrection: boolean; onSaved: () => void }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const storageKey = `invoice-quantity-correction:${user?.id}:${lineId}`;
  const [pendingReceipt, setPendingReceipt] = useState(() => { try { return sessionStorage.getItem(storageKey) !== null; } catch { return false; } });
  const context = useQuery({ queryKey: [`/api/vendor-invoice-lines/${lineId}/quantity-correction`], enabled: open,
    queryFn: async () => invoiceQuantityContextSchema.parse(await financialCommandFetchJson(`/api/vendor-invoice-lines/${lineId}/quantity-correction`, { credentials: "include" })) });
  function reload() { setOpen(false); onSaved(); void context.refetch(); }
  // A committed correction can clear the mismatch before the browser receives
  // its response. Keep its saved command accessible for verification after reload.
  if (!needsCorrection && !pendingReceipt && !open) return null;
  return <>
    <Button size="sm" variant="outline" className="mt-2 min-h-[36px] whitespace-normal text-xs" onClick={() => setOpen(true)} aria-label={`${needsCorrection ? "Fix quantity" : "Verify quantity confirmation"} for line ${lineNumber}`}>{needsCorrection ? "Fix quantity" : "Verify quantity confirmation"}</Button>
    <Dialog open={open} onOpenChange={(value) => { if (!busy) setOpen(value); }}><DialogContent className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-2xl" onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }} onInteractOutside={(event) => { if (busy) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>Correct invoice quantity · Line {context.data?.lineNumber ?? lineNumber}</DialogTitle><DialogDescription>{context.data && <span className="mb-1 block line-clamp-2 font-medium">{context.data.name}</span>}Check the supplier's quantity. Review the current and proposed values before confirming.</DialogDescription></DialogHeader>
      {context.isLoading && <p>Loading the invoice and PO quantities…</p>}
      {context.error && <p role="alert">{context.error.message}</p>}
      {context.data && <QuantityEditor key={`${lineId}:${open}`} loaded={context.data} storageKey={storageKey} onSaved={() => {
        setPendingReceipt(false);
        const poRoot = `/api/purchase-orders/${context.data.purchaseOrderId}`;
        // Matching is recomputed across the PO, including its other invoices.
        // Refresh cached exceptions/history as well as the invoice being viewed.
        void queryClient.invalidateQueries({ predicate: ({ queryKey }) => {
          const url = queryKey[0];
          return typeof url === "string" && (url.startsWith("/api/vendor-invoices")
            || url === poRoot || url.startsWith(`${poRoot}/`) || url === "/api/purchase-orders"
            || url.startsWith("/api/purchase-orders?") || url.startsWith("/api/procurement/health")
            || url === `/api/vendor-invoice-lines/${lineId}/quantity-correction`);
        } });
        toast({ title: "Invoice quantity corrected", description: "The billed amount, payments and stock are unchanged." }); onSaved();
      }} setBusy={setBusy} onReload={reload} onClose={() => setOpen(false)} />}
      {!context.data && <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Close</Button>}
    </DialogContent></Dialog>
  </>;
}
