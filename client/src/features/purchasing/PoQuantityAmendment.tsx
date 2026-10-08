import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  poQuantityAmendmentContextSchema, poQuantityAmendmentPreviewSchema, poQuantityAmendmentResultSchema,
  poQuantityPreviewRequestSchema, poQuantityApprovalRequestSchema,
  type PoQuantityAmendmentContext, type PoQuantityAmendmentPreview, type PoQuantityAmendmentResult,
  type PoQuantityApprovalRequest, type PoQuantityPreviewRequest,
} from "@shared/procurement/po-quantity-amendment";
import { useAuth } from "@/lib/auth";
import { exactMoneyAsInput } from "@/lib/exact-money-input";
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
function pendingIntent(key: string): ApprovalIntent | null {
  const raw = sessionStorage.getItem(key);
  if (raw === null) return null;
  // Invalid recovery data blocks new commands rather than silently discarding a
  // possibly committed request and issuing a different idempotency key.
  return savedIntentSchema.parse(JSON.parse(raw));
}
function Impact({ preview }: { preview: PoQuantityAmendmentPreview }) {
  return <div className="space-y-3">
    {preview.lines.map(({ before, after, priceTreatment }) => <div key={before.id} className="rounded border p-3 text-sm space-y-1">
      <p className="font-semibold break-words">Line {before.lineNumber} · {before.name}</p>
      <p>Ordered: {before.orderQty.toLocaleString()} → <strong>{after.orderQty.toLocaleString()} pieces</strong></p>
      <p>Received: {after.receivedQty.toLocaleString()} · Invoiced: {after.invoicedQty.toLocaleString()}</p>
      <p>{priceTreatment === "keep_product_total" ? "Keep product amount" : "Keep recorded quoted rate"}</p>
      <p>Product amount: {exactMoneyAsInput(before.totalProductCostCents, 2)} → {exactMoneyAsInput(after.totalProductCostCents, 2)} {preview.currency}</p>
      <p>Unit cost: {exactMoneyAsInput(before.unitCostMills, 4)} → {exactMoneyAsInput(after.unitCostMills, 4)} {preview.currency}</p>
    </div>)}
    <p className="font-semibold">PO total: {exactMoneyAsInput(preview.beforeTotalCents, 2)} → {exactMoneyAsInput(preview.afterTotalCents, 2)} {preview.currency}</p>
    <p className="text-sm">Receiving status: {preview.beforeStatus} → {preview.afterStatus}</p>
    <ul className="list-disc space-y-1 pl-5 text-sm text-amber-800 dark:text-amber-300">{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
    {preview.invoiceMatches.length > 0 && <div className="rounded border p-3 text-sm">
      <p className="font-semibold">Invoice match after correction</p>
      {preview.invoiceMatches.map((match) => <p key={match.invoiceLineId}>Invoice #{match.invoiceId}, line #{match.invoiceLineId}: {match.before.replaceAll("_", " ")} → <strong>{match.after.replaceAll("_", " ")}</strong></p>)}
    </div>}
    <p className="text-sm whitespace-pre-wrap break-words">Reason: {preview.reason}</p>
  </div>;
}
function Editor({ context: loadedContext, storageKey, setBusy, onSaved, onReload }: {
  context: PoQuantityAmendmentContext; storageKey: string; setBusy: (busy: boolean) => void; onSaved: () => void; onReload: () => void;
}) {
  const [context] = useState(loadedContext);
  const recovery = useRef<{ intent: ApprovalIntent | null; error: string | null } | null>(null);
  if (!recovery.current) {
    try { recovery.current = { intent: pendingIntent(storageKey), error: null }; }
    catch { recovery.current = { intent: null, error: "Saved approval data could not be read. Reload this page or contact an administrator before issuing another correction." }; }
  }
  const [unresolved, setUnresolved] = useState<ApprovalIntent | null>(recovery.current.intent);
  const activeApproval = useRef<ApprovalIntent | null>(recovery.current.intent);
  const [drafts, setDrafts] = useState<Record<number, { quantity: string; treatment: string }>>(() => Object.fromEntries(context.lines.map((line) => [line.id, { quantity: String(line.orderQty), treatment: "" }])));
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
    onSuccess: (result) => { sessionStorage.removeItem(storageKey); activeApproval.current = null; setUnresolved(null); setSaved(result); setBusy(false); onSaved(); },
    onError: (error, intent) => {
      // Middleware may deny a replay before the command ledger is read. Such a
      // denial cannot prove that an earlier attempt did not commit.
      const ambiguous = error instanceof FinancialCommandRequestError && (error.ambiguous
        || ([401, 403].includes(error.status ?? 0) && !error.code)
        || ["FINANCIAL_COMMAND_CONTRACT_CHANGED", "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED"].includes(error.code ?? ""));
      if (!ambiguous) sessionStorage.removeItem(storageKey);
      activeApproval.current = ambiguous ? intent : null;
      setUnresolved(ambiguous ? intent : null); setBusy(false);
      if (error instanceof FinancialCommandRequestError && [403, 409].includes(error.status ?? 0)) setStale(true);
    },
  });
  const locked = previewMutation.isPending || approveMutation.isPending || unresolved !== null || saved !== null || stale || recovery.current.error !== null;
  const blocked = !context.canApprove ? "A current Administrator with purchasing approval permission must approve this correction." : context.blockedReason;
  function preview() {
    if (locked || blocked) return;
    try {
      const changes = context.lines.filter((line) => !line.blockedReason && drafts[line.id].quantity !== String(line.orderQty)).map((line) => {
        const draft = drafts[line.id];
        if (!/^\d+$/.test(draft.quantity)) throw new Error(`Line ${line.lineNumber}: enter a positive whole piece quantity.`);
        return { lineId: line.id, quantityPieces: Number(draft.quantity), priceTreatment: draft.treatment };
      });
      const parsed = poQuantityPreviewRequestSchema.safeParse({ sourceVersion: context.sourceVersion, changes, reason });
      if (!parsed.success) throw new Error("Change at least one quantity, choose its price treatment and enter a reason of at least 10 characters.");
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
  return <div className="space-y-4">
    {blocked && <p role="alert" className="text-sm text-destructive">{blocked}</p>}
    {recovery.current.error && <p role="alert" className="text-sm text-destructive">{recovery.current.error}</p>}
    {!impact && !blocked && <fieldset disabled={locked} className="space-y-3">
      {context.lines.filter((line) => line.orderQty > 0).map((line) => <div className="rounded border p-3 space-y-2" key={line.id}>
        <p className="text-sm font-semibold break-words">Line {line.lineNumber} · {line.name}</p>
        <p className="text-xs text-muted-foreground">Ordered {line.orderQty.toLocaleString()} · Received {line.receivedQty.toLocaleString()} · Invoiced {line.invoicedQty.toLocaleString()} pieces</p>
        {line.blockedReason ? <p className="text-sm text-muted-foreground">{line.blockedReason}</p> : <div className="grid gap-3 sm:grid-cols-2">
          <div><Label htmlFor={`correct-quantity-${line.id}`}>Corrected quantity (pieces)</Label><Input id={`correct-quantity-${line.id}`} inputMode="numeric" value={drafts[line.id].quantity} onChange={(event) => setDrafts((values) => ({ ...values, [line.id]: { ...values[line.id], quantity: event.target.value } }))} /></div>
          <div><Label htmlFor={`correct-price-${line.id}`}>Price treatment</Label><Select value={drafts[line.id].treatment} disabled={locked} onValueChange={(treatment) => setDrafts((values) => ({ ...values, [line.id]: { ...values[line.id], treatment } }))}><SelectTrigger id={`correct-price-${line.id}`}><SelectValue placeholder="Choose for changed quantity" /></SelectTrigger><SelectContent><SelectItem value="keep_product_total">Keep product amount</SelectItem><SelectItem value="keep_quoted_rate">Keep recorded quoted rate</SelectItem></SelectContent></Select></div>
        </div>}
      </div>)}
      <div><Label htmlFor="quantity-correction-reason">Correction reason / supplier reference</Label><Textarea id="quantity-correction-reason" value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} /></div>
    </fieldset>}
    {impact && <Impact preview={impact} />}
    {review && !unresolved && !saved && <div className="flex items-start gap-2"><Checkbox id="quantity-approval-confirm" checked={confirmed} disabled={locked} onCheckedChange={(checked) => setConfirmed(checked === true)} /><Label htmlFor="quantity-approval-confirm">I reviewed the corrected quantities, price treatment and remaining invoice issues.</Label></div>}
    {(validationError || previewMutation.error || approveMutation.error) && <p role="alert" className="text-sm text-destructive">{validationError ?? approveMutation.error?.message ?? previewMutation.error?.message}</p>}
    {saved && <p role="status" className="rounded bg-green-50 p-3 font-semibold text-green-800">Quantity correction approved and saved as revision {saved.revisionNumber}.</p>}
    <div className="flex flex-wrap gap-2">
      {!impact && !blocked && <Button disabled={locked} onClick={preview}>{previewMutation.isPending ? "Reviewing…" : "Review correction"}</Button>}
      {review && !unresolved && !saved && <><Button variant="outline" disabled={locked} onClick={() => { setReview(null); setConfirmed(false); approveMutation.reset(); }}>Edit correction</Button><Button className="bg-green-700 hover:bg-green-800 text-white" disabled={!confirmed || locked || !!blocked} onClick={approve}>Approve &amp; apply correction</Button></>}
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
    <Button variant="outline" className="flex-1 sm:flex-none min-h-[44px]" onClick={() => setOpen(true)}>Correct quantities</Button>
    <Dialog open={open} onOpenChange={(value) => { if (!busy) { setOpen(value); if (!value) setEditorKey((key) => key + 1); } }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl" onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }} onInteractOutside={(event) => { if (busy) event.preventDefault(); }}>
        <DialogHeader><DialogTitle>Correct PO quantities</DialogTitle><DialogDescription>Review the commercial correction, then approve it with current administrator permissions. Each correction records a reason and a new PO revision.</DialogDescription></DialogHeader>
        {context.isPending && <p>Loading current PO evidence…</p>}
        {context.error && <p role="alert" className="text-sm text-destructive">Could not load correction evidence. {context.error.message}</p>}
        {context.data && <Editor key={editorKey} context={context.data} storageKey={storageKey} setBusy={setBusy} onSaved={refresh} onReload={() => { setOpen(false); setEditorKey((key) => key + 1); refresh(); }} />}
      </DialogContent>
    </Dialog>
  </>;
}
