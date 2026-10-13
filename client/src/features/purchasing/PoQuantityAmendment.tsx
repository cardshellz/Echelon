import { useProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { CompactPoLineTable } from "@/features/po-edit/CompactPoLineTable";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PoAmendmentLineTable, type PoAmendmentLineDraft } from "./PoAmendmentLineTable";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { PO_EDITOR_QUERY_PARAM } from "@/lib/procurement-navigation";
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
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

const savedIntentSchema = z.object({
  key: z.string().uuid(), body: poQuantityApprovalRequestSchema, preview: poQuantityAmendmentPreviewSchema,
}).strict();
type ApprovalIntent = z.infer<typeof savedIntentSchema>;
type LineView = PoQuantityAmendmentContext["lines"][number];
type LineDraft = PoAmendmentLineDraft;
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
  const rows = preview.lines.flatMap(({ before, after }) => {
    const fields: [string, string, string][] = [
      ["Quantity", before.orderQty.toLocaleString(), after.orderQty.toLocaleString()],
      ["Product price per piece", exactMoneyAsInput(before.unitCostMills, 4), exactMoneyAsInput(after.unitCostMills, 4)],
      ["Product total", exactMoneyAsInput(before.totalProductCostCents, 2), exactMoneyAsInput(after.totalProductCostCents, 2)],
      ["Line total", exactMoneyAsInput(before.lineTotalCents, 2), exactMoneyAsInput(after.lineTotalCents, 2)],
    ];
    for (const [name, field] of [["Packaging", "packagingCostCents"], ["Discount", "discountCents"], ["Tax", "taxCents"]] as const) {
      if (before[field] !== undefined && after[field] !== undefined) fields.push([name, exactMoneyAsInput(before[field], 2), exactMoneyAsInput(after[field], 2)]);
    }
    return fields.filter(([name, oldValue, newValue]) => oldValue !== newValue && (before.lineType === undefined || before.lineType === "product" || ["Quantity", "Line total"].includes(name)))
      .map(([name, oldValue, newValue]) => ({ lineId: before.id, lineNumber: before.lineNumber, product: before.name, name, oldValue, newValue }));
  });
  const fieldCounts = new Map<number, number>();
  for (const row of rows) fieldCounts.set(row.lineId, (fieldCounts.get(row.lineId) ?? 0) + 1);
  return <div className="space-y-3">
    <p className="text-sm font-semibold">Review {preview.lines.length} changed line{preview.lines.length === 1 ? "" : "s"}</p>
    <CompactPoLineTable aria-label="PO change summary" className="min-w-[520px]"><TableHeader><TableRow className="bg-slate-50"><TableHead>Line</TableHead><TableHead>What changes</TableHead><TableHead className="text-right">Current</TableHead><TableHead className="text-right">After editing</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map((row, index) => <TableRow key={`${row.lineId}:${row.name}`}>
        {(index === 0 || rows[index - 1].lineId !== row.lineId) && <TableCell rowSpan={fieldCounts.get(row.lineId)} className="max-w-[240px] py-2 align-top"><span className="line-clamp-2" title={row.product}>{row.lineNumber} · {row.product}</span></TableCell>}
        <TableCell className="py-2">{row.name}</TableCell><TableCell className="py-2 text-right font-mono">{row.oldValue}</TableCell><TableCell className="py-2 text-right font-mono font-semibold text-green-800 dark:text-green-300">{row.newValue}</TableCell>
      </TableRow>)}</TableBody>
    </CompactPoLineTable>
    <p className="font-semibold">PO total: {exactMoneyAsInput(preview.beforeTotalCents, 2)} → {exactMoneyAsInput(preview.afterTotalCents, 2)} {preview.currency}</p>
    {preview.beforeStatus !== preview.afterStatus && <p className="text-sm">Receiving status: {preview.beforeStatus} → {preview.afterStatus}</p>}
    <p className="text-sm text-muted-foreground">Saving edits the PO. Invoices, payments and received stock stay unchanged.</p>
    {preview.warnings.filter(warning => warning.startsWith("Line ")).map(warning => <p key={warning} className="text-sm text-amber-800 dark:text-amber-300">{warning}</p>)}
    <details className="rounded border p-3 text-sm"><summary className="cursor-pointer">Invoice and inventory details</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5">{preview.warnings.filter(warning => !warning.startsWith("Line ")).map(warning => <li key={warning}>{warning}</li>)}</ul>
      {preview.invoiceMatches.filter(match => match.before !== match.after || match.after !== "matched").map(match => <p key={match.invoiceLineId} className="mt-2">Invoice #{match.invoiceId}, line #{match.invoiceLineId}: {match.before.replaceAll("_", " ")} → <strong>{match.after.replaceAll("_", " ")}</strong></p>)}
    </details>
  </div>;
}

function Editor({ context: loadedContext, storageKey, setBusy, onSaved, onReload }: {
  context: PoQuantityAmendmentContext; storageKey: string; setBusy: (busy: boolean) => void; onSaved: () => void; onReload: () => void;
}) {
  const [context] = useState(loadedContext);
  const navigation = useProcurementNavigation();
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
    if (locked || blocked) return;
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
      const parsed = poQuantityPreviewRequestSchema.safeParse({ sourceVersion: context.sourceVersion, changes, reason, ...(context.closedPurchaseOrder ? { closedPurchaseOrderConfirmed: true } : {}) });
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
    {context.closedPurchaseOrder && !blocked && <p className="rounded bg-muted p-2 text-sm">Editing a closed PO. Saving keeps it closed and does not change receipts, invoices or payments.</p>}
    {(context.invoiceIssues?.length ?? 0) > 0 && <details open={context.invoiceIssues!.length === 1} className="rounded border border-amber-300 bg-amber-50/50 p-3 text-sm">
      <summary className="cursor-pointer font-semibold">Invoice issues ({context.invoiceIssues!.length})</summary>
      {context.invoiceIssues!.map(issue => <div key={issue.invoiceLineId} className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-amber-200 pt-2">
        <div><p className="font-medium">{issue.invoiceNumber} · Line {issue.lineNumber} · {issue.name}</p>
          <p>Invoice {issue.invoiceQuantity.toLocaleString()} pieces · PO {issue.orderedQuantity?.toLocaleString() ?? "not linked"} · Received {issue.receivedQuantity?.toLocaleString() ?? "not linked"}</p>
          <p>Invoice line {exactMoneyAsInput(issue.invoiceLineAmountCents, 2)} {issue.currency} · PO line {issue.poLineAmountCents === null ? "not linked" : `${exactMoneyAsInput(issue.poLineAmountCents, 2)} ${context.currency}`}</p>
        </div><Button asChild variant="outline" className="min-h-[44px]"><Link href={navigation.childHref(`/ap-invoices/${issue.invoiceId}`, { invoiceLineCorrectionId: issue.invoiceLineId })}>Correct invoice</Link></Button>
      </div>)}
    </details>}
    {recovery.current.error && <p role="alert" className="text-sm text-destructive">{recovery.current.error}</p>}
    {!impact && !blocked && <fieldset disabled={locked} className="space-y-3">
      <p className="text-xs text-muted-foreground">Enter product price and packaging separately.</p>
      <PoAmendmentLineTable disabled={locked} lines={context.lines} drafts={drafts} currency={context.currency} onChange={updateDraft} totalLabel={newTotalLabel} />
    </fieldset>}
    {impact && <Impact preview={impact} />}
    {saved && <p role="status" className="rounded bg-green-50 p-3 font-semibold text-green-800">PO edit approved and saved as revision {saved.revisionNumber}.</p>}
    </div><div className="mt-4 shrink-0 space-y-3 border-t pt-3">
      {(validationError || previewMutation.error || approveMutation.error) && <p role="alert" className="text-sm text-destructive">{validationError ?? approveMutation.error?.message ?? previewMutation.error?.message}</p>}
      {!impact && !blocked && <div><Label htmlFor="quantity-correction-reason">Reason for editing / supplier reference</Label><Input id="quantity-correction-reason" value={reason} maxLength={2000} disabled={locked} onChange={(event) => setReason(event.target.value)} /></div>}
      {review && !unresolved && !saved && <div className="flex items-start gap-2"><Checkbox id="quantity-approval-confirm" checked={confirmed} disabled={locked} onCheckedChange={(checked) => setConfirmed(checked === true)} /><Label htmlFor="quantity-approval-confirm">{context.closedPurchaseOrder ? "I approve these changes to the closed PO and its total." : "I reviewed these changes and the new PO total."}</Label></div>}
      <div className="flex flex-wrap gap-2">
      {!impact && !blocked && <Button className="min-h-[44px]" disabled={locked} onClick={preview}>{previewMutation.isPending ? "Reviewing…" : "Review changes"}</Button>}
      {review && !unresolved && !saved && <><Button variant="outline" className="min-h-[44px]" disabled={locked} onClick={() => { setReview(null); setConfirmed(false); approveMutation.reset(); }}>Keep editing</Button><Button className="min-h-[44px] bg-green-700 hover:bg-green-800 text-white" disabled={!confirmed || locked || !!blocked} onClick={approve}>Approve &amp; save PO</Button></>}
      {unresolved && <Button disabled={approveMutation.isPending} onClick={() => approveMutation.mutate(unresolved)}>{approveMutation.isPending ? "Confirming…" : "Retry saved approval"}</Button>}
      {stale && !unresolved && <Button variant="outline" onClick={onReload}>Discard review and reload PO</Button>}
      </div>
    </div>
  </div>;
}
export function PoQuantityAmendment({ purchaseOrderId, status }: { purchaseOrderId: number; status: string }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [path, navigate] = useLocation();
  const search = useSearch();
  const editRequests = new URLSearchParams(search).getAll(PO_EDITOR_QUERY_PARAM);
  const requestedEdit = path === `/purchase-orders/${purchaseOrderId}` && editRequests.length === 1 && editRequests[0] === "1";
  const [open, setOpen] = useState(requestedEdit);
  const [busy, setBusy] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  useEffect(() => { if (requestedEdit) setOpen(true); }, [requestedEdit]);
  function changeOpen(value: boolean) {
    if (busy) return;
    setOpen(value);
    if (!value) {
      setEditorKey(key => key + 1);
      if (requestedEdit) {
        const params = new URLSearchParams(search);
        params.delete(PO_EDITOR_QUERY_PARAM);
        // Consume only this UI request, preserving the invoice's back journey.
        navigate(`${path}${params.size ? `?${params.toString()}` : ""}`, { replace: true });
      }
    }
  }
  const storageKey = `po-quantity-amendment:${user?.id}:${purchaseOrderId}`;
  const root = `/api/purchase-orders/${purchaseOrderId}/quantity-amendment`;
  const context = useQuery({ queryKey: [root, editorKey], enabled: open, staleTime: 0, refetchOnWindowFocus: false,
    queryFn: async () => {
      const loaded = poQuantityAmendmentContextSchema.parse(await financialCommandFetchJson(root, { credentials: "include" }));
      if (loaded.purchaseOrderId !== purchaseOrderId) throw new Error("The loaded editor does not match this PO. Reload the purchase order.");
      return loaded;
    } });
  const refresh = () => {
    void Promise.all(["", "/history", "/revisions", "/exceptions", "/invoices", "/receive-options", "/quantity-amendment"].map((suffix) => queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${purchaseOrderId}${suffix}`] })));
    void queryClient.invalidateQueries({ queryKey: ["/api/vendor-invoices"] });
    // Detail keys use the invoice ID in their first string segment.
    void queryClient.invalidateQueries({ predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/vendor-invoices/") });
  };
  const editable = ["approved", "sent", "acknowledged", "partially_received", "received", "closed"].includes(status);
  let hasRecovery: boolean;
  try { hasRecovery = sessionStorage.getItem(storageKey) !== null; }
  catch { hasRecovery = true; }
  // Closed POs expose the audited commercial editor. Cancelled purchases only
  // expose recovery; the server still decides whether a new edit is allowed.
  if (!editable && !hasRecovery && !open) return null;
  return <>
    <Button variant="outline" className="flex-1 sm:flex-none min-h-[44px]" onClick={() => setOpen(true)}>Edit PO</Button>
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="flex max-h-[90dvh] flex-col overflow-hidden w-[calc(100vw-2rem)] sm:max-w-6xl" onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }} onInteractOutside={(event) => { if (busy) event.preventDefault(); }}>
        <DialogHeader><DialogTitle>Edit purchase order</DialogTitle><DialogDescription>Edit quantities and prices, review the new total, then save with administrator approval.</DialogDescription></DialogHeader>
        {context.isPending && <p>Loading current PO evidence…</p>}
        {context.error && <p role="alert" className="text-sm text-destructive">Could not load correction evidence. {context.error.message}</p>}
        {context.data && <Editor key={editorKey} context={context.data} storageKey={storageKey} setBusy={setBusy} onSaved={refresh} onReload={() => { changeOpen(false); refresh(); }} />}
      </DialogContent>
    </Dialog>
  </>;
}
