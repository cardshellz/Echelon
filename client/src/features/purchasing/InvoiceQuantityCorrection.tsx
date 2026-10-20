import { useEffect, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { INVOICE_CORRECTION_QUERY_PARAM } from "@/lib/procurement-navigation";
import { useProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { invoiceQuantityContextSchema, invoiceQuantityPreviewSchema, invoiceQuantityApprovalRequestSchema, invoiceQuantityResultSchema,
  type InvoiceQuantityContext, type InvoiceQuantityPreview, type InvoiceQuantityApprovalRequest, type InvoiceQuantityResult } from "@shared/procurement/invoice-quantity-correction";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { invoiceLineDraft } from "./invoice-line-editor";
import { exactMoneyAsInput } from "@/lib/exact-money-input";
import { financialCommandFetchJson, FinancialCommandRequestError, shouldRetryFinancialCommand, financialCommandRetryDelay } from "@/lib/financial-command";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  const afterLineAmount = preview.afterLineAmountCents ?? preview.invoiceLineAmountCents;
  const afterInvoiceAmount = preview.afterInvoiceAmountCents ?? preview.invoiceAmountCents;
  const afterBalance = preview.afterBalanceCents ?? preview.balanceCents;
  const moneyChanged = afterLineAmount !== preview.invoiceLineAmountCents || (preview.afterUnitCostMills ?? preview.recordedUnitCostMills) !== preview.recordedUnitCostMills;
  const perPiece = (value: string) => currency === "USD" ? `$${value}` : `${value} ${currency}`;
  const rows: [string, string, string][] = [
    ["Invoice quantity", preview.beforeQuantity.toLocaleString("en-US"), preview.afterQuantity.toLocaleString("en-US")],
    ["Unit price", `${exactMoneyAsInput(preview.recordedUnitCostMills, 4)} ${currency}`, `${exactMoneyAsInput(preview.afterUnitCostMills ?? preview.recordedUnitCostMills, 4)} ${currency}`],
    ["Invoice line amount", amount(preview.invoiceLineAmountCents, currency), amount(afterLineAmount, currency)],
    ["Line amount per piece", perPiece(preview.beforeAmountPerPiece), perPiece(preview.afterAmountPerPiece)],
    ["Invoice total", amount(preview.invoiceAmountCents, currency), amount(afterInvoiceAmount, currency)],
    ["Cash paid", amount(preview.paidAmountCents, currency), amount(preview.paidAmountCents, currency)],
    ["Balance", amount(preview.balanceCents, currency), amount(afterBalance, currency)],
    ["Match result", matchNames[preview.beforeMatch], matchNames[preview.afterMatch]],
  ];
  if (preview.beforeAllocatedToPoCents != null && preview.afterAllocatedToPoCents != null) {
    rows.push(["Allocated to this PO", amount(preview.beforeAllocatedToPoCents, currency), amount(preview.afterAllocatedToPoCents, currency)]);
  }
  return <div className="space-y-2">
    <p className="rounded bg-muted p-2 text-sm">PO ordered: <strong>{preview.orderedQuantity.toLocaleString("en-US")}</strong> pieces · Received: <strong>{preview.receivedQuantity.toLocaleString("en-US")}</strong> pieces</p>
    <table className="w-full table-fixed text-sm" aria-label="Invoice changes">
      <thead><tr className="border-b"><th className="w-[40%] py-2 text-left">What changes</th><th className="w-[30%] pl-2 text-right">Current</th><th className="w-[30%] pl-2 text-right">After correction</th></tr></thead>
      <tbody>{rows.filter(([name, before, after]) => before !== after || name === "Match result").map(([name, before, after]) => <tr key={name} className="border-b"><th scope="row" className="py-2 pr-2 text-left font-normal break-words">{name}</th><td className="pl-2 text-right break-words">{before}</td><td className={`pl-2 text-right break-words ${before !== after ? `font-semibold ${(name === "Match result" && preview.afterMatch !== "matched") || (name === "Balance" && afterBalance > 0) ? "text-amber-800 dark:text-amber-300" : "text-green-800 dark:text-green-300"}` : ""}`}>{after}</td></tr>)}</tbody>
    </table>
    <div role="group" aria-label="Invoice after changes" className="grid grid-cols-3 gap-2 rounded bg-muted p-2 text-sm">
      <p>Total <strong className="block">{amount(afterInvoiceAmount, currency)}</strong></p>
      <p>Paid <strong className="block">{amount(preview.paidAmountCents, currency)}</strong></p>
      <p>Balance <strong className="block">{amount(afterBalance, currency)}</strong></p>
    </div>
    <p className="text-xs text-muted-foreground">Billed amount per piece after saving: {perPiece(preview.afterAmountPerPiece)}. This is the complete line amount divided by quantity.</p>
    <p className="text-xs text-muted-foreground">{moneyChanged ? "Invoice totals and balance are recalculated. Payments, PO lines, received stock and inventory costs stay unchanged." : "Payments, PO lines, received stock and inventory costs stay unchanged."}</p>
    {preview.closedPurchaseOrder && <p className="text-sm">The PO stays closed.</p>}
    {preview.otherInvoicedQuantity > 0 && <p className="text-sm">Other invoice lines already cover {preview.otherInvoicedQuantity.toLocaleString("en-US")} pieces.</p>}
    {preview.remainingIssues.length > 0 && <p className="text-sm text-amber-800 dark:text-amber-300">After this change, {preview.remainingIssues.length} invoice line(s) on this PO still need review.</p>}
    {preview.warnings.length > 0 && <details className="rounded border p-2 text-sm"><summary className="cursor-pointer">Cost and inventory details</summary><ul className="mt-2 list-disc space-y-1 pl-5">{preview.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details>}
  </div>;
}
function QuantityEditor({ loaded, storageKey, onSaved, setBusy, onReload, onClose, onEditPo }: {
  loaded: InvoiceQuantityContext; storageKey: string; onSaved: () => void; setBusy: (value: boolean) => void; onReload: () => void; onClose: () => void; onEditPo?: () => void;
}) {
  const [context] = useState(loaded); // Freeze the evidence being reviewed until an explicit reload.
  const root = `/api/vendor-invoice-lines/${context.invoiceLineId}/quantity-correction`;
  const recovery = useRef<{ intent: Intent | null; error: string | null } | null>(null);
  if (recovery.current === null) {
    try {
      const raw = sessionStorage.getItem(storageKey);
      const intent = raw === null ? null : intentSchema.parse(JSON.parse(raw));
      if (intent && (intent.preview.invoiceLineId !== context.invoiceLineId || intent.preview.invoiceId !== context.invoiceId
        || intent.preview.sourceVersion !== intent.body.sourceVersion || intent.preview.afterQuantity !== intent.body.quantityPieces
        || (intent.body.lineTotalCents !== undefined && (intent.preview.afterLineAmountCents !== intent.body.lineTotalCents || intent.preview.afterUnitCostMills !== intent.body.unitCostMills)))) throw new Error("Saved confirmation does not match its preview");
      recovery.current = { intent, error: null };
    } catch { recovery.current = { intent: null, error: "A saved confirmation could not be read. Contact an administrator before submitting another correction." }; }
  }
  const [unresolved, setUnresolved] = useState<Intent | null>(recovery.current.intent);
  const active = useRef<Intent | null>(recovery.current.intent);
  const [quantity, setQuantity] = useState(String(context.suggestedQuantity ?? context.current.beforeQuantity));
  const [unitPrice, setUnitPrice] = useState(exactMoneyAsInput(context.current.recordedUnitCostMills, 4));
  const [lineAmount, setLineAmount] = useState(exactMoneyAsInput(context.current.invoiceLineAmountCents, 2));
  const supportsEconomics = context.current.afterLineAmountCents !== undefined && context.current.afterInvoiceAmountCents !== undefined && context.current.afterBalanceCents !== undefined;
  const confirmationLabel = context.closedPurchaseOrder ? "I approve these invoice changes on the closed PO." : "I reviewed these invoice changes.";
  const [reason, setReason] = useState(context.suggestedQuantity === null ? "" : "Correct the invoice line using the supplier quantity and amount.");
  const [review, setReview] = useState<InvoiceQuantityPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [saved, setSaved] = useState<InvoiceQuantityResult | null>(null);
  const preview = useMutation({
    mutationFn: async (request: Omit<InvoiceQuantityApprovalRequest, "reason" | "approvalConfirmed">) => {
      const result = invoiceQuantityPreviewSchema.parse(await financialCommandFetchJson(`${root}/preview`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }));
      if (result.invoiceLineId !== context.invoiceLineId || result.sourceVersion !== context.sourceVersion || result.afterQuantity !== request.quantityPieces || result.afterLineAmountCents !== request.lineTotalCents || result.afterUnitCostMills !== request.unitCostMills) throw new Error("The preview does not match this invoice correction. Reload the invoice.");
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
      if (!result.success || result.data.invoiceLineId !== context.invoiceLineId || result.data.preview.sourceVersion !== intent.body.sourceVersion || result.data.preview.afterQuantity !== intent.body.quantityPieces || (intent.body.lineTotalCents !== undefined && (result.data.preview.afterLineAmountCents !== intent.body.lineTotalCents || result.data.preview.afterUnitCostMills !== intent.body.unitCostMills))) throw new FinancialCommandRequestError("The correction may have completed. Retry the saved confirmation to verify it.", { status: 200, code: "INVOICE_QUANTITY_RESPONSE_INVALID", retryable: true, ambiguous: true });
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
  const blocked = !context.canApprove ? "An Administrator with purchasing approval permission must confirm this correction." : context.blockedReason ?? (!supportsEconomics ? "Current financial evidence is unavailable. Reload the invoice before editing." : null);
  const locked = preview.isPending || approve.isPending || unresolved !== null || saved !== null || stale || recovery.current.error !== null;
  const impact = saved?.preview ?? unresolved?.preview ?? review;
  const draft = invoiceLineDraft({ quantity, unitPrice, lineAmount }, context.current);
  const reviewedChange = !!review && (review.afterQuantity !== review.beforeQuantity
    || (review.afterLineAmountCents ?? review.invoiceLineAmountCents) !== review.invoiceLineAmountCents
    || (review.afterUnitCostMills ?? review.recordedUnitCostMills) !== review.recordedUnitCostMills);
  const validReason = reason.trim().length >= 10 && reason.trim().length <= 2000;
  const canSave = !locked && !blocked && reviewedChange && validReason && confirmed;
  const guidance = blocked ?? recovery.current.error ?? (stale ? "Reload the invoice and review its latest values."
    : preview.isPending ? "Reviewing your changes…"
    : !draft.valid ? draft.message
    : !draft.changed ? "No changes to save. Edit the quantity, unit price or line amount above."
    : !review ? "Review your changes before saving."
    : !validReason ? "Enter a reason of at least 10 characters."
    : !confirmed ? "Confirm the reviewed changes below to enable Save." : null);
  function updatePreview() {
    if (locked || blocked) return;
    if (!draft.valid) { setError(draft.message); return; }
    if (!draft.changed) return;
    setError(null);
    preview.mutate({ sourceVersion: context.sourceVersion, quantityPieces: draft.quantityPieces, unitCostMills: draft.unitCostMills,
      lineTotalCents: draft.lineTotalCents, ...(context.closedPurchaseOrder ? { closedPurchaseOrderConfirmed: true as const } : {}) });
  }
  function confirm() {
    if (!review || !canSave || active.current) return;
    try {
      const body = invoiceQuantityApprovalRequestSchema.parse({ sourceVersion: context.sourceVersion, quantityPieces: review.afterQuantity, unitCostMills: review.afterUnitCostMills, lineTotalCents: review.afterLineAmountCents,
        ...(context.closedPurchaseOrder ? { closedPurchaseOrderConfirmed: true } : {}), reason, approvalConfirmed: true });
      const intent: Intent = { key: crypto.randomUUID(), body, preview: review };
      sessionStorage.setItem(storageKey, JSON.stringify(intent)); active.current = intent; setUnresolved(intent); setError(null); approve.mutate(intent);
    } catch { setError("Include a reason of at least 10 characters. Session storage must be available for safe confirmation retries."); }
  }
  return <div className="flex min-h-0 flex-col">
    <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
    {(blocked || recovery.current.error) && <p role="alert" className="text-sm text-destructive">{blocked ?? recovery.current.error}</p>}
    {!impact && onEditPo && <div className="flex flex-wrap items-center justify-between gap-2 rounded border bg-muted/50 p-3">
      <p className="text-sm">Edit ordered quantities and prices on the PO.</p><Button variant="outline" className="min-h-[44px]" disabled={locked} onClick={onEditPo}>Edit PO</Button>
    </div>}
    {!impact && <fieldset disabled={locked || !!blocked} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div><Label htmlFor={`invoice-quantity-${context.invoiceLineId}`}>Invoice quantity (pieces)</Label><Input id={`invoice-quantity-${context.invoiceLineId}`} inputMode="numeric" value={quantity} onChange={event => { setQuantity(event.target.value); setReview(null); setConfirmed(false); setError(null); }} /></div>
        <div><Label htmlFor={`invoice-unit-price-${context.invoiceLineId}`}>Unit price ({context.currency})</Label><Input id={`invoice-unit-price-${context.invoiceLineId}`} inputMode="decimal" value={unitPrice} onChange={event => { setUnitPrice(event.target.value); setReview(null); setConfirmed(false); setError(null); }} /></div>
        <div><Label htmlFor={`invoice-line-amount-${context.invoiceLineId}`}>Invoice line amount ({context.currency})</Label><Input id={`invoice-line-amount-${context.invoiceLineId}`} inputMode="decimal" value={lineAmount} onChange={event => { setLineAmount(event.target.value); setReview(null); setConfirmed(false); setError(null); }} /></div>
      </div>
      <p className="text-xs text-muted-foreground">{context.suggestionReason} Check the complete billed line amount against the supplier invoice.</p>
      {context.poUnitCostMills !== undefined && <p className="text-xs text-muted-foreground">PO unit price: {exactMoneyAsInput(context.poUnitCostMills, 4)} {context.currency}{context.poLineAmountCents !== undefined && ` · PO line amount: ${exactMoneyAsInput(context.poLineAmountCents, 2)} ${context.currency}`}</p>}
    </fieldset>}
    {impact ? <InvoiceQuantityImpact preview={impact} currency={context.currency} />
      : <p className="rounded bg-muted p-2 text-sm">PO ordered: <strong>{context.current.orderedQuantity.toLocaleString("en-US")}</strong> pieces · Received: <strong>{context.current.receivedQuantity.toLocaleString("en-US")}</strong> pieces</p>}
    {saved && <p role="status" className="rounded border border-green-300 bg-green-50 p-3 font-semibold text-green-900">Invoice correction approved and saved. {matchNames[saved.preview.afterMatch]}.</p>}
    </div>
    <div className="mt-4 shrink-0 space-y-3 border-t pt-3">
      {(error || preview.error || approve.error) && <p role="alert" className="text-sm text-destructive">{error ?? approve.error?.message ?? preview.error?.message}</p>}
      {!saved && !unresolved && <>
        <div><Label htmlFor={`invoice-quantity-reason-${context.invoiceLineId}`}>Why are you changing it?</Label><Input id={`invoice-quantity-reason-${context.invoiceLineId}`} value={reason} maxLength={2000} disabled={locked || !!blocked} onChange={(event) => { setReason(event.target.value); setConfirmed(false); }} /></div>
        {guidance && <p id={`invoice-save-guidance-${context.invoiceLineId}`} role="status" className="text-sm text-muted-foreground">{guidance}</p>}
        {review && <div className="flex items-start gap-2"><Checkbox id={`invoice-quantity-confirm-${context.invoiceLineId}`} checked={confirmed} disabled={locked || !!blocked || !reviewedChange || !validReason} onCheckedChange={(checked) => setConfirmed(checked === true)} /><Label htmlFor={`invoice-quantity-confirm-${context.invoiceLineId}`}>{confirmationLabel}</Label></div>}
      </>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" aria-label="Close invoice editor" className="min-h-[44px]" disabled={preview.isPending || approve.isPending} onClick={onClose}>Close</Button>
        {!saved && !unresolved && <>
          {review && <Button variant="outline" className="min-h-[44px]" disabled={locked || !!blocked} onClick={() => { setReview(null); setConfirmed(false); setError(null); preview.reset(); }}>Keep editing</Button>}
          {!review && <Button className="min-h-[44px]" disabled={locked || !!blocked || !draft.valid || !draft.changed} onClick={updatePreview}>{preview.isPending ? "Reviewing…" : "Review changes"}</Button>}
          <Button className="min-h-[44px] flex-1 bg-green-700 text-white hover:bg-green-800" aria-describedby={guidance ? `invoice-save-guidance-${context.invoiceLineId}` : undefined} disabled={!canSave} onClick={confirm}>{approve.isPending ? "Saving correction…" : "Approve & save invoice"}</Button>
        </>}
        {unresolved && <Button className="min-h-[44px] flex-1" disabled={approve.isPending} onClick={() => approve.mutate(unresolved)}>{approve.isPending ? "Verifying confirmation…" : "Retry saved confirmation"}</Button>}
      </div>
      {stale && !unresolved && <Button className="mt-2 w-full" variant="outline" onClick={onReload}>Reload invoice and review again</Button>}
    </div>
  </div>;
}
export function InvoiceQuantityCorrection({ lineId, lineNumber, needsCorrection, onSaved, allowMatched = false }: { lineId: number; lineNumber: number; needsCorrection: boolean; allowMatched?: boolean; onSaved: () => void }) {
  const { user } = useAuth();
  const [path, navigate] = useLocation();
  const search = useSearch();
  const requests = new URLSearchParams(search).getAll(INVOICE_CORRECTION_QUERY_PARAM);
  const requestedCorrection = requests.length === 1 && requests[0] === String(lineId);
  const procurementNavigation = useProcurementNavigation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(requestedCorrection), [busy, setBusy] = useState(false);
  const [editorEpoch, setEditorEpoch] = useState(0);
  useEffect(() => { if (requestedCorrection) setOpen(true); }, [requestedCorrection]);
  function changeOpen(value: boolean) {
    if (busy) return;
    setOpen(value);
    if (!value) {
      setEditorEpoch(epoch => epoch + 1);
      if (requestedCorrection) { const params = new URLSearchParams(search); params.delete(INVOICE_CORRECTION_QUERY_PARAM); navigate(`${path}${params.size ? `?${params.toString()}` : ""}`, { replace: true }); }
    }
  }
  const storageKey = `invoice-quantity-correction:${user?.id}:${lineId}`;
  const [pendingReceipt, setPendingReceipt] = useState(() => { try { return sessionStorage.getItem(storageKey) !== null; } catch { return false; } });
  const context = useQuery({ queryKey: [`/api/vendor-invoice-lines/${lineId}/quantity-correction`, editorEpoch], enabled: open,
    queryFn: async () => {
      const loaded = invoiceQuantityContextSchema.parse(await financialCommandFetchJson(`/api/vendor-invoice-lines/${lineId}/quantity-correction`, { credentials: "include" }));
      if (loaded.invoiceLineId !== lineId) throw new Error("The loaded correction does not match this invoice line. Reload the invoice.");
      return loaded;
    } });
  const editPoHref = context.data ? procurementNavigation.childHref(`/purchase-orders/${context.data.purchaseOrderId}`, { editPo: true }) : null;
  function reload() { changeOpen(false); onSaved(); }
  // A committed correction can clear the mismatch before the browser receives
  // its response. Keep its saved command accessible for verification after reload.
  if (!needsCorrection && !allowMatched && !pendingReceipt && !open) return null;
  return <>
    <Button size="sm" variant="outline" className="mt-2 min-h-[36px] whitespace-normal text-xs" onClick={() => setOpen(true)} aria-label={`${pendingReceipt && !needsCorrection ? "Verify invoice correction" : "Edit invoice line"} for line ${lineNumber}`}>{pendingReceipt && !needsCorrection ? "Verify invoice correction" : "Edit invoice line"}</Button>
    <Dialog open={open} onOpenChange={changeOpen}><DialogContent className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-2xl" onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }} onInteractOutside={(event) => { if (busy) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>Edit invoice line · Line {context.data?.lineNumber ?? lineNumber}</DialogTitle><DialogDescription>{context.data && <span className="mb-1 block line-clamp-2 font-medium">{context.data.name}</span>}Edit the quantity, unit price and amount. Review changes before saving.</DialogDescription></DialogHeader>
      {context.isLoading && <p>Loading the invoice and PO quantities…</p>}
      {context.error && <p role="alert">{context.error.message}</p>}
      {context.data && <QuantityEditor key={`${lineId}:${editorEpoch}`} loaded={context.data} storageKey={storageKey} onSaved={() => {
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
        toast({ title: "Invoice correction saved", description: "Invoice matching and balance were checked. Payments and stock stay unchanged." }); onSaved();
      }} setBusy={setBusy} onReload={reload} onClose={() => changeOpen(false)} onEditPo={editPoHref ? () => navigate(editPoHref) : undefined} />}
      {!context.data && <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Close</Button>}
    </DialogContent></Dialog>
  </>;
}
