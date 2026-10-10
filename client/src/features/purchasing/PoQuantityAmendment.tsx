import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  poQuantityAmendmentContextSchema, poQuantityAmendmentPreviewSchema, poQuantityAmendmentResultSchema,
  poQuantityPreviewRequestSchema, poQuantityApprovalRequestSchema,
  type PoQuantityAmendmentContext, type PoQuantityAmendmentPreview, type PoQuantityAmendmentResult,
  type PoQuantityApprovalRequest, type PoQuantityPreviewRequest,
  poLineAmountCents, type PoQuantityChange,
} from "@shared/procurement/po-quantity-amendment";
import { normalizePoLinePricing } from "@shared/utils/po-line-pricing";
import { useAuth } from "@/lib/auth";
import { exactMoneyAsInput, parseExactMoneyInput } from "@/lib/exact-money-input";
import { FinancialCommandRequestError, financialCommandFetchJson, financialCommandRetryDelay, shouldRetryFinancialCommand } from "@/lib/financial-command";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const savedIntentSchema = z.object({
  key: z.string().uuid(), body: poQuantityApprovalRequestSchema, preview: poQuantityAmendmentPreviewSchema,
}).strict();
type ApprovalIntent = z.infer<typeof savedIntentSchema>;
type LineView = PoQuantityAmendmentContext["lines"][number];
type LineDraft = { quantity: string; basis: "per_piece" | "extended_total" | "per_purchase_uom"; price: string; packaging: string; discount: string; tax: string; charge: string; touched: boolean };
function lineDraft(line: LineView): LineDraft {
  const pricing = line.pricing;
  return { quantity: String(line.orderQty), basis: pricing?.basis ?? "per_piece",
    price: exactMoneyAsInput(pricing?.basis === "extended_total" ? pricing.quotedTotalCents : pricing?.basis === "per_purchase_uom" ? pricing.quotedCostMillsPerUom : line.unitCostMills, pricing?.basis === "extended_total" ? 2 : 4),
    packaging: exactMoneyAsInput(line.packagingCostCents ?? 0, 2), discount: exactMoneyAsInput(line.discountCents ?? 0, 2), tax: exactMoneyAsInput(line.taxCents ?? 0, 2),
    charge: exactMoneyAsInput(line.lineTotalCents, 2), touched: false };
}
function lineChange(line: LineView, draft: LineDraft): PoQuantityChange {
  if (line.lineType !== "product") return { lineId: line.id, quantityPieces: line.orderQty, priceTreatment: "edit_charge", chargeTotalCents: parseExactMoneyInput(draft.charge, 2, true) };
  if (!/^[1-9]\d*$/.test(draft.quantity)) throw new Error(`Line ${line.lineNumber}: enter a positive whole-piece quantity.`);
  const quantityPieces = Number(draft.quantity);
  let pricing;
  if (draft.basis === "per_purchase_uom") {
    if (line.pricing?.basis !== "per_purchase_uom" || quantityPieces % line.pricing.piecesPerUom !== 0) throw new Error(`Line ${line.lineNumber}: quantity must be a whole number of ${line.pricing?.basis === "per_purchase_uom" ? line.pricing.purchaseUom : "purchase units"}.`);
    pricing = { ...line.pricing, uomQuantity: quantityPieces / line.pricing.piecesPerUom, quotedCostMillsPerUom: parseExactMoneyInput(draft.price, 4) };
  } else if (draft.basis === "extended_total") pricing = { basis: "extended_total" as const, quantityPieces, quotedTotalCents: parseExactMoneyInput(draft.price, 2) };
  else pricing = { basis: "per_piece" as const, quantityPieces, unitCostMills: parseExactMoneyInput(draft.price, 4) };
  return { lineId: line.id, quantityPieces, priceTreatment: "edit_line", pricing,
    packagingCostCents: parseExactMoneyInput(draft.packaging, 2), discountCents: parseExactMoneyInput(draft.discount, 2), taxCents: parseExactMoneyInput(draft.tax, 2) };
}
function draftTotal(line: LineView, draft: LineDraft): number {
  const change = lineChange(line, draft);
  if (change.priceTreatment === "edit_charge") return change.chargeTotalCents!;
  return poLineAmountCents(normalizePoLinePricing(change.pricing!).totalProductCostCents, change.packagingCostCents!, change.discountCents!, change.taxCents!);
}
function hasChangedLine(line: LineView, change: PoQuantityChange): boolean {
  if (change.priceTreatment === "edit_charge") return change.chargeTotalCents !== line.lineTotalCents;
  const price = normalizePoLinePricing(change.pricing!);
  return change.quantityPieces !== line.orderQty || price.unitCostMills !== line.unitCostMills
    || price.totalProductCostCents !== line.totalProductCostCents || change.packagingCostCents !== line.packagingCostCents
    || change.discountCents !== line.discountCents || change.taxCents !== line.taxCents
    || poLineAmountCents(price.totalProductCostCents, change.packagingCostCents!, change.discountCents!, change.taxCents!) !== line.lineTotalCents;
}
function newTotalLabel(line: LineView, draft: LineDraft, currency: string): string {
  try { return `${exactMoneyAsInput(draftTotal(line, draft), 2)} ${currency}`; }
  catch { return "Check the quantity and amounts"; }
}
function pendingIntent(key: string): ApprovalIntent | null {
  const raw = sessionStorage.getItem(key);
  if (raw === null) return null;
  // Invalid recovery data blocks new commands rather than silently discarding a
  // possibly committed request and issuing a different idempotency key.
  return savedIntentSchema.parse(JSON.parse(raw));
}
function Impact({ preview }: { preview: PoQuantityAmendmentPreview }) {
  return <div className="space-y-3">
    {preview.lines.map(({ before, after }) => <div key={before.id} className="rounded border p-3 text-sm space-y-1">
      <p className="font-semibold break-words">Line {before.lineNumber} · {before.name}</p>
      <table className="w-full table-fixed" aria-label={`Changes for line ${before.lineNumber}`}>
        <thead><tr className="border-b"><th className="w-[40%] py-1 text-left">What changes</th><th className="w-[30%] text-right">Current</th><th className="w-[30%] text-right">After editing</th></tr></thead>
        <tbody>{([
          ["Quantity", String(before.orderQty.toLocaleString()), String(after.orderQty.toLocaleString())],
          ["Product price per piece", exactMoneyAsInput(before.unitCostMills, 4), exactMoneyAsInput(after.unitCostMills, 4)],
          ["Product total", exactMoneyAsInput(before.totalProductCostCents, 2), exactMoneyAsInput(after.totalProductCostCents, 2)],
          ...(before.packagingCostCents !== undefined && after.packagingCostCents !== undefined ? [["Packaging", exactMoneyAsInput(before.packagingCostCents, 2), exactMoneyAsInput(after.packagingCostCents, 2)]] : []),
          ...(before.discountCents !== undefined && after.discountCents !== undefined ? [["Discount", exactMoneyAsInput(before.discountCents, 2), exactMoneyAsInput(after.discountCents, 2)]] : []),
          ...(before.taxCents !== undefined && after.taxCents !== undefined ? [["Tax", exactMoneyAsInput(before.taxCents, 2), exactMoneyAsInput(after.taxCents, 2)]] : []),
          ["Line total", exactMoneyAsInput(before.lineTotalCents, 2), exactMoneyAsInput(after.lineTotalCents, 2)],
        ]).filter(([name]) => before.lineType === undefined || before.lineType === "product" || ["Quantity", "Line total"].includes(name)).map(([name, oldValue, newValue]) => <tr key={name} className="border-b"><th scope="row" className="py-1 text-left font-normal break-words">{name}</th><td className="text-right break-words">{oldValue}</td><td className={`text-right break-words ${oldValue !== newValue ? "font-semibold text-green-800 dark:text-green-300" : ""}`}>{newValue}</td></tr>)}</tbody>
      </table>
      {before.lineType === "product" && <p className="text-xs text-muted-foreground">Received: {after.receivedQty.toLocaleString()} · Invoiced: {after.invoicedQty.toLocaleString()} pieces</p>}
    </div>)}
    <p className="font-semibold">PO total: {exactMoneyAsInput(preview.beforeTotalCents, 2)} → {exactMoneyAsInput(preview.afterTotalCents, 2)} {preview.currency}</p>
    <p className="text-sm">Receiving status: {preview.beforeStatus} → {preview.afterStatus}</p>
    <p className="text-sm text-muted-foreground">Saving edits the PO. Invoices, payments and received stock stay unchanged.</p>
    {preview.warnings.filter(warning => warning.startsWith("Line ")).map(warning => <p key={warning} className="text-sm text-amber-800 dark:text-amber-300">{warning}</p>)}
    <details className="rounded border p-3 text-sm"><summary className="cursor-pointer">Invoice and inventory details</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5">{preview.warnings.filter(warning => !warning.startsWith("Line ")).map(warning => <li key={warning}>{warning}</li>)}</ul>
      {preview.invoiceMatches.filter(match => match.before !== match.after || match.after !== "matched").map(match => <p key={match.invoiceLineId} className="mt-2">Invoice #{match.invoiceId}, line #{match.invoiceLineId}: {match.before.replaceAll("_", " ")} → <strong>{match.after.replaceAll("_", " ")}</strong></p>)}
    </details>
    <p className="text-sm whitespace-pre-wrap break-words">Reason: {preview.reason}</p>
  </div>;
}
function Editor({ context: loadedContext, storageKey, setBusy, onSaved, onReload }: {
  context: PoQuantityAmendmentContext; storageKey: string; setBusy: (busy: boolean) => void; onSaved: () => void; onReload: () => void;
}) {
  const [context] = useState(loadedContext);
  const recovery = useRef<{ intent: ApprovalIntent | null; error: string | null } | null>(null);
  if (!recovery.current) {
    try {
      const intent = pendingIntent(storageKey);
      if (intent && (intent.preview.purchaseOrderId !== context.purchaseOrderId || intent.preview.sourceVersion !== intent.body.sourceVersion)) throw new Error("Saved approval scope differs from this PO");
      recovery.current = { intent, error: null };
    }
    catch { recovery.current = { intent: null, error: "Saved approval data could not be read. Reload this page or contact an administrator before issuing another correction." }; }
  }
  const [unresolved, setUnresolved] = useState<ApprovalIntent | null>(recovery.current.intent);
  const activeApproval = useRef<ApprovalIntent | null>(recovery.current.intent);
  const [drafts, setDrafts] = useState<Record<number, LineDraft>>(() => Object.fromEntries(context.lines.map((line) => [line.id, lineDraft(line)])));
  const [reason, setReason] = useState("");
  const [review, setReview] = useState<{ request: PoQuantityPreviewRequest; preview: PoQuantityAmendmentPreview } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saved, setSaved] = useState<PoQuantityAmendmentResult | null>(null);
  const [stale, setStale] = useState(false);
  const root = `/api/purchase-orders/${context.purchaseOrderId}/quantity-amendment`;
  const previewMutation = useMutation({
    mutationFn: async (request: PoQuantityPreviewRequest) => {
      const raw = await financialCommandFetchJson<unknown>(`${root}/preview`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
      const result = poQuantityAmendmentPreviewSchema.parse(raw);
      if (result.purchaseOrderId !== context.purchaseOrderId || result.sourceVersion !== request.sourceVersion) throw new Error("The preview does not match this correction. Reload the PO.");
      return { request, preview: result };
    },
    onMutate: () => setBusy(true),
    onSuccess: (result) => { setReview(result); setConfirmed(false); },
    onError: (error) => { if (error instanceof FinancialCommandRequestError && error.code === "PO_AMENDMENT_STALE") setStale(true); },
    onSettled: () => setBusy(false),
  });
  const approveMutation = useMutation<PoQuantityAmendmentResult, Error, ApprovalIntent>({
    mutationFn: async (intent) => {
      const raw = await financialCommandFetchJson<unknown>(root, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "Idempotency-Key": intent.key }, body: JSON.stringify(intent.body) });
      const parsed = poQuantityAmendmentResultSchema.safeParse(raw);
      if (!parsed.success || parsed.data.purchaseOrderId !== context.purchaseOrderId || parsed.data.preview.sourceVersion !== intent.body.sourceVersion) throw new FinancialCommandRequestError("The correction may have completed. Retry the saved approval to confirm its result.", { status: 200, code: "PO_AMENDMENT_RESPONSE_INVALID", retryable: true, ambiguous: true });
      return parsed.data;
    },
    retry: shouldRetryFinancialCommand, retryDelay: financialCommandRetryDelay,
    onMutate: () => setBusy(true),
    onSuccess: (result) => {
      activeApproval.current = null; setUnresolved(null); setSaved(result); setBusy(false);
      try { sessionStorage.removeItem(storageKey); } catch { setValidationError("PO saved. The browser could not clear its retry receipt; reopening will safely verify the same approval."); }
      onSaved();
    },
    onError: (error, intent) => {
      // Middleware may deny a replay before the command ledger is read. Such a
      // denial cannot prove that an earlier attempt did not commit.
      const ambiguous = error instanceof FinancialCommandRequestError && (error.ambiguous
        || error.retryable || (error.status ?? 0) >= 500 || [401, 403].includes(error.status ?? 0)
        || ["FINANCIAL_COMMAND_CONTRACT_CHANGED", "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED"].includes(error.code ?? ""));
      if (!ambiguous) { try { sessionStorage.removeItem(storageKey); } catch { setValidationError("The browser could not clear the rejected approval. Reload before editing again."); } }
      activeApproval.current = ambiguous ? intent : null;
      setUnresolved(ambiguous ? intent : null); setBusy(false);
      if (error instanceof FinancialCommandRequestError && [403, 409].includes(error.status ?? 0)) setStale(true);
    },
  });
  const locked = previewMutation.isPending || approveMutation.isPending || unresolved !== null || saved !== null || stale || recovery.current.error !== null;
  const missingDetails = context.lines.some(line => line.lineType === undefined || line.pricing === undefined || line.packagingCostCents === undefined || line.discountCents === undefined || line.taxCents === undefined);
  const blocked = !context.canApprove ? "A current Administrator with purchasing approval permission must approve this edit." : context.blockedReason ?? (missingDetails ? "Current line pricing could not be loaded. Reload the PO before editing." : null);
  function updateDraft(id: number, patch: Partial<LineDraft>) {
    setDrafts(values => ({ ...values, [id]: { ...values[id], ...patch, touched: true } }));
    setConfirmed(false); setValidationError(null);
  }
  function preview() {
    if (locked || blocked) return;
    try {
      const changes = context.lines.filter(line => !line.blockedReason && drafts[line.id].touched).flatMap(line => {
        const change = lineChange(line, drafts[line.id]);
        return hasChangedLine(line, change) ? [change] : [];
      });
      const parsed = poQuantityPreviewRequestSchema.safeParse({ sourceVersion: context.sourceVersion, changes, reason });
      if (!parsed.success) throw new Error("Edit at least one line and enter a reason of at least 10 characters.");
      setValidationError(null); previewMutation.mutate(parsed.data);
    } catch (error) { setValidationError(error instanceof Error ? error.message : "Review the correction fields."); }
  }
  function approve() {
    if (!review || !confirmed || locked || blocked || activeApproval.current) return;
    const body: PoQuantityApprovalRequest = { ...review.request, approvalConfirmed: true };
    const intent: ApprovalIntent = { key: crypto.randomUUID(), body, preview: review.preview };
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(intent));
      activeApproval.current = intent;
      setUnresolved(intent); approveMutation.mutate(intent);
    } catch { setValidationError("The browser could not save the approval for safe retry. Enable session storage and try again."); }
  }
  const impact = saved?.preview ?? unresolved?.preview ?? review?.preview;
  return <div className="flex min-h-0 flex-col"><div className="min-h-0 space-y-4 overflow-y-auto pr-1">
    {blocked && <p role="alert" className="text-sm text-destructive">{blocked}</p>}
    {recovery.current.error && <p role="alert" className="text-sm text-destructive">{recovery.current.error}</p>}
    {!impact && !blocked && <fieldset disabled={locked} className="space-y-3">
      <p className="text-xs text-muted-foreground">Product prices exclude the packaging amount entered separately below.</p>
      {context.lines.map((line) => <div className="rounded border p-3 space-y-2" key={line.id}>
        <p className="text-sm font-semibold break-words">Line {line.lineNumber} · {line.name}</p>
        {line.lineType === "product" && <p className="text-xs text-muted-foreground">Received {line.receivedQty.toLocaleString()} · Invoiced {line.invoicedQty.toLocaleString()} pieces</p>}
        {line.blockedReason ? <p className="text-sm text-muted-foreground">{line.blockedReason}</p> : line.lineType !== "product" ? <div><Label htmlFor={`charge-${line.id}`}>Charge / credit total ({context.currency})</Label><Input id={`charge-${line.id}`} inputMode="decimal" value={drafts[line.id].charge} onChange={event => updateDraft(line.id, { charge: event.target.value })} /><p className="mt-1 text-xs text-muted-foreground">Use a negative amount for a credit or discount.</p></div> : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div><Label htmlFor={`correct-quantity-${line.id}`}>Quantity (pieces)</Label><Input id={`correct-quantity-${line.id}`} inputMode="numeric" value={drafts[line.id].quantity} onChange={event => updateDraft(line.id, { quantity: event.target.value })} /></div>
          <div><Label htmlFor={`price-basis-${line.id}`}>Price entered as</Label><Select value={drafts[line.id].basis} disabled={locked} onValueChange={basis => updateDraft(line.id, { basis: basis as LineDraft["basis"], price: basis === "extended_total" ? exactMoneyAsInput(line.totalProductCostCents, 2) : basis === "per_purchase_uom" && line.pricing?.basis === "per_purchase_uom" ? exactMoneyAsInput(line.pricing.quotedCostMillsPerUom, 4) : exactMoneyAsInput(line.unitCostMills, 4) })}><SelectTrigger id={`price-basis-${line.id}`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="per_piece">Price per piece</SelectItem><SelectItem value="extended_total">Product total</SelectItem>{line.pricing?.basis === "per_purchase_uom" && <SelectItem value="per_purchase_uom">Price per {line.pricing.purchaseUom}</SelectItem>}</SelectContent></Select></div>
          <div><Label htmlFor={`correct-price-${line.id}`}>{drafts[line.id].basis === "extended_total" ? "Product total" : drafts[line.id].basis === "per_purchase_uom" && line.pricing?.basis === "per_purchase_uom" ? `Price per ${line.pricing.purchaseUom}` : "Product price per piece"} ({context.currency})</Label><Input id={`correct-price-${line.id}`} inputMode="decimal" value={drafts[line.id].price} onChange={event => updateDraft(line.id, { price: event.target.value })} /></div>
          <div><Label htmlFor={`packaging-${line.id}`}>Packaging total ({context.currency})</Label><Input id={`packaging-${line.id}`} inputMode="decimal" value={drafts[line.id].packaging} onChange={event => updateDraft(line.id, { packaging: event.target.value })} /></div>
          <div><Label htmlFor={`discount-${line.id}`}>Discount ({context.currency})</Label><Input id={`discount-${line.id}`} inputMode="decimal" value={drafts[line.id].discount} onChange={event => updateDraft(line.id, { discount: event.target.value })} /></div>
          <div><Label htmlFor={`tax-${line.id}`}>Tax ({context.currency})</Label><Input id={`tax-${line.id}`} inputMode="decimal" value={drafts[line.id].tax} onChange={event => updateDraft(line.id, { tax: event.target.value })} /></div>
        </div>}
        {!line.blockedReason && <p className="text-sm">Line total: <span>{exactMoneyAsInput(line.lineTotalCents, 2)} {context.currency}</span> → <strong>{newTotalLabel(line, drafts[line.id], context.currency)}</strong></p>}
        {line.componentTotalCents !== undefined && line.componentTotalCents !== line.lineTotalCents && <p className="text-sm text-amber-800 dark:text-amber-300">The saved line total does not equal its product, packaging, discount and tax amounts. Check this line against the supplier document before editing.</p>}
      </div>)}
      <div><Label htmlFor="quantity-correction-reason">Reason for editing / supplier reference</Label><Textarea id="quantity-correction-reason" value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} /></div>
    </fieldset>}
    {impact && <Impact preview={impact} />}
    {review && !unresolved && !saved && <div className="flex items-start gap-2"><Checkbox id="quantity-approval-confirm" checked={confirmed} disabled={locked} onCheckedChange={(checked) => setConfirmed(checked === true)} /><Label htmlFor="quantity-approval-confirm">I reviewed these changes and the new PO total.</Label></div>}
    {(validationError || previewMutation.error || approveMutation.error) && <p role="alert" className="text-sm text-destructive">{validationError ?? approveMutation.error?.message ?? previewMutation.error?.message}</p>}
    {saved && <p role="status" className="rounded bg-green-50 p-3 font-semibold text-green-800">PO edit approved and saved as revision {saved.revisionNumber}.</p>}
    </div><div className="mt-4 flex shrink-0 flex-wrap gap-2 border-t pt-3">
      {!impact && !blocked && <Button className="min-h-[44px]" disabled={locked} onClick={preview}>{previewMutation.isPending ? "Reviewing…" : "Review changes"}</Button>}
      {review && !unresolved && !saved && <><Button variant="outline" className="min-h-[44px]" disabled={locked} onClick={() => { setReview(null); setConfirmed(false); approveMutation.reset(); }}>Keep editing</Button><Button className="min-h-[44px] bg-green-700 hover:bg-green-800 text-white" disabled={!confirmed || locked || !!blocked} onClick={approve}>Approve &amp; save PO</Button></>}
      {unresolved && <Button disabled={approveMutation.isPending} onClick={() => approveMutation.mutate(unresolved)}>{approveMutation.isPending ? "Confirming…" : "Retry saved approval"}</Button>}
      {stale && !unresolved && <Button variant="outline" onClick={onReload}>Discard review and reload PO</Button>}
    </div>
  </div>;
}
export function PoQuantityAmendment({ purchaseOrderId, status }: { purchaseOrderId: number; status: string }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const storageKey = `po-quantity-amendment:${user?.id}:${purchaseOrderId}`;
  const root = `/api/purchase-orders/${purchaseOrderId}/quantity-amendment`;
  const context = useQuery({ queryKey: [root, editorKey], enabled: open, staleTime: 0, refetchOnWindowFocus: false,
    queryFn: async () => poQuantityAmendmentContextSchema.parse(await financialCommandFetchJson(root, { credentials: "include" })) });
  const refresh = () => {
    void Promise.all(["", "/history", "/revisions", "/exceptions", "/invoices", "/receive-options", "/quantity-amendment"].map((suffix) => queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${purchaseOrderId}${suffix}`] })));
    void queryClient.invalidateQueries({ queryKey: ["/api/vendor-invoices"] });
    // Detail keys use the invoice ID in their first string segment.
    void queryClient.invalidateQueries({ predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/vendor-invoices/") });
  };
  const editable = ["approved", "sent", "acknowledged", "partially_received", "received"].includes(status);
  let hasRecovery: boolean;
  try { hasRecovery = sessionStorage.getItem(storageKey) !== null; }
  catch { hasRecovery = true; }
  // A terminal PO still exposes recovery for its saved command. New corrections
  // remain blocked by the server; a completed command can be replayed exactly.
  if (!editable && !hasRecovery && !open) return null;
  return <>
    <Button variant="outline" className="flex-1 sm:flex-none min-h-[44px]" onClick={() => setOpen(true)}>Edit PO</Button>
    <Dialog open={open} onOpenChange={(value) => { if (!busy) { setOpen(value); if (!value) setEditorKey((key) => key + 1); } }}>
      <DialogContent className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-4xl" onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }} onInteractOutside={(event) => { if (busy) event.preventDefault(); }}>
        <DialogHeader><DialogTitle>Edit purchase order</DialogTitle><DialogDescription>Edit quantities and prices, review the new total, then save with administrator approval.</DialogDescription></DialogHeader>
        {context.isPending && <p>Loading current PO evidence…</p>}
        {context.error && <p role="alert" className="text-sm text-destructive">Could not load correction evidence. {context.error.message}</p>}
        {context.data && <Editor key={editorKey} context={context.data} storageKey={storageKey} setBusy={setBusy} onSaved={refresh} onReload={() => { setOpen(false); setEditorKey((key) => key + 1); refresh(); }} />}
      </DialogContent>
    </Dialog>
  </>;
}
