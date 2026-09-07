import { rfqQuantityReviewMessage } from "@shared/procurement/rfq-quantity-review";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { z } from "zod";
import {
  rfqConversionResultSchema, rfqQuoteRevisionSchema, rfqWorkflowDetailSchema,
  type RfqWorkflowDetail,
} from "@shared/procurement/rfq-workflow";
import { formatMills } from "@shared/utils/money";
import { useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/queryClient";
import { createFinancialCommandIntentStore, financialCommandFetchJson, financialCommandRetryDelay, FinancialCommandRequestError, shouldRetryFinancialCommand } from "@/lib/financial-command";
import { rfqMoneyAsInput, rfqQuoteFormFromEvidence, rfqQuoteFromForm, type RfqQuoteForm } from "@/lib/rfq-quote-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type CommandIntent = { url: string; body: unknown; key: string; response: "quote" | "conversion" };

function useRfqCommand(onSuccess: (value: unknown) => void) {
  const store = useRef(createFinancialCommandIntentStore(() => crypto.randomUUID()));
  const [unresolved, setUnresolved] = useState<CommandIntent | null>(null);
  const mutation = useMutation<unknown, Error, CommandIntent>({
    mutationFn: async (intent: CommandIntent) => {
      const result = await financialCommandFetchJson<unknown>(intent.url, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "Idempotency-Key": intent.key }, body: JSON.stringify(intent.body) });
      const parsed = (intent.response === "quote" ? rfqWorkflowDetailSchema : rfqConversionResultSchema).safeParse(result);
      if (!parsed.success) throw new FinancialCommandRequestError("The operation may have completed, but its response was incomplete. Retry safely with the same request.", { status: 200, retryable: true, ambiguous: true, code: "RFQ_RESPONSE_INVALID" });
      return parsed.data;
    },
    retry: shouldRetryFinancialCommand,
    retryDelay: financialCommandRetryDelay,
    onSuccess: (value, intent) => { store.current.complete(intent.key); setUnresolved(null); onSuccess(value); },
    onError: (error, intent) => {
      store.current.fail(intent.key, error);
      setUnresolved(error instanceof FinancialCommandRequestError && error.ambiguous ? intent : null);
    },
  });
  return {
    ...mutation, unresolved,
    submit(url: string, body: unknown, response: CommandIntent["response"]) {
      const key = store.current.acquire({ url, body });
      mutation.mutate({ url, body, key, response });
    },
    retryUnresolved() { if (unresolved) mutation.mutate(unresolved); },
  };
}

function QuoteHistory({ rfqId, lineId }: { rfqId: number; lineId: number }) {
  const [beforeRevision, setBeforeRevision] = useState<number | null>(null);
  const history = useQuery({
    queryKey: ["rfq-quote-history", rfqId, lineId, beforeRevision],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/purchasing/rfqs/${rfqId}/lines/${lineId}/quotes${beforeRevision === null ? "" : `?beforeRevision=${beforeRevision}`}`);
      return z.object({ revisions: z.array(rfqQuoteRevisionSchema), nextBeforeRevision: z.number().int().positive().nullable() }).parse(await response.json());
    },
  });
  if (history.isPending) return <p className="text-sm text-muted-foreground">Loading quote history…</p>;
  if (history.error) return <p role="alert" className="text-sm text-destructive">Could not load quote history. <Button variant="link" onClick={() => history.refetch()}>Retry</Button></p>;
  return <div className="space-y-2 rounded border p-3">
    <p className="text-sm font-medium">Preserved quote revisions</p>
    {history.data?.revisions.map((revision) => <div key={revision.id} className="border-t pt-2 text-xs">
      <p>Revision {revision.revision} · {revision.quote.quoteReference} · {revision.quotedPieces.toLocaleString()} pieces · {rfqMoneyAsInput(revision.quotedUnitCostMills, 4)}/piece {revision.currency}</p>
      <p>Packaging: {revision.quote.packagingTreatment.replaceAll("_", " ")}{revision.quote.packagingCostCents === null ? "" : ` · ${rfqMoneyAsInput(revision.quote.packagingCostCents, 2)} ${revision.currency}`}</p>
      <p className="text-muted-foreground">{revision.quote.reason} · {revision.createdBy} · {new Date(revision.createdAt).toLocaleString()}</p>
    </div>)}
    {history.data?.revisions.length === 0 && <p className="text-xs text-muted-foreground">No versioned quote has been captured. Existing legacy price fields remain visible above.</p>}
    <div className="flex gap-2">
      {beforeRevision !== null && <Button size="sm" variant="outline" onClick={() => setBeforeRevision(null)}>Latest revisions</Button>}
      {history.data?.nextBeforeRevision !== null && history.data?.nextBeforeRevision !== undefined && <Button size="sm" variant="outline" onClick={() => setBeforeRevision(history.data!.nextBeforeRevision)}>Older revisions</Button>}
    </div>
  </div>;
}

function QuoteEditor({ workflow, line, onClose, onSaved }: { workflow: RfqWorkflowDetail; line: RfqWorkflowDetail["lines"][number]; onClose: () => void; onSaved: () => void }) {
  // Capture the version actually reviewed. A later query refresh must not
  // silently rebase the operator's in-progress economics onto newer evidence.
  const [expectedVersion] = useState(workflow.version);
  const [form, setForm] = useState<RfqQuoteForm>(() => rfqQuoteFormFromEvidence(line.latestQuote?.quote ?? null, line.requestedPieces, new Date().toISOString().slice(0, 10)));
  const [validationError, setValidationError] = useState<string | null>(null);
  const command = useRfqCommand(() => onSaved());
  const locked = command.isPending || command.unresolved !== null;
  const field = (name: keyof RfqQuoteForm, value: string) => setForm((current) => ({ ...current, [name]: value }));
  const prefix = `rfq-${workflow.id}-line-${line.id}`;
  function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      const quote = rfqQuoteFromForm(form);
      setValidationError(null);
      command.submit(`/api/purchasing/rfqs/${workflow.id}/lines/${line.id}/quotes`, { expectedVersion, quote }, "quote");
    } catch (error) { setValidationError(error instanceof Error ? error.message : "Review the quote fields."); }
  }
  return <form onSubmit={submit} className="space-y-3 rounded border bg-background p-3">
    <div><p className="font-medium">Capture quote · {line.sku}</p><p className="text-xs text-muted-foreground">This records supplier evidence. Previous revisions remain available.</p></div>
    <fieldset disabled={locked} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div><Label htmlFor={`${prefix}-basis`}>Quoted price basis</Label><Select value={form.basis} onValueChange={(value) => field("basis", value)} disabled={locked}><SelectTrigger id={`${prefix}-basis`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="per_piece">Per piece</SelectItem><SelectItem value="per_purchase_uom">Per purchase unit</SelectItem><SelectItem value="extended_total">Extended product total</SelectItem></SelectContent></Select></div>
      <div><Label htmlFor={`${prefix}-quantity`}>{form.basis === "per_purchase_uom" ? "Purchase units quoted" : "Pieces quoted"}</Label><Input id={`${prefix}-quantity`} inputMode="numeric" value={form.quantity} onChange={(event) => field("quantity", event.target.value)} /></div>
      {form.basis === "per_purchase_uom" && <><div><Label htmlFor={`${prefix}-uom`}>Purchase unit name</Label><Input id={`${prefix}-uom`} placeholder="Case" value={form.purchaseUom} onChange={(event) => field("purchaseUom", event.target.value)} /></div><div><Label htmlFor={`${prefix}-pieces`}>Pieces per purchase unit</Label><Input id={`${prefix}-pieces`} inputMode="numeric" value={form.piecesPerUom} onChange={(event) => field("piecesPerUom", event.target.value)} /></div></>}
      <div><Label htmlFor={`${prefix}-amount`}>{form.basis === "extended_total" ? "Product total" : "Price per quoted unit"} ({workflow.currency})</Label><Input id={`${prefix}-amount`} inputMode="decimal" value={form.amount} onChange={(event) => field("amount", event.target.value)} /></div>
      <div><Label htmlFor={`${prefix}-packaging`}>Packaging treatment</Label><Select value={form.packagingTreatment} onValueChange={(value) => field("packagingTreatment", value)} disabled={locked}><SelectTrigger id={`${prefix}-packaging`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="unknown">Needs clarification</SelectItem><SelectItem value="separate">Separate amount confirmed</SelectItem><SelectItem value="included_in_product">Included in product quote</SelectItem></SelectContent></Select></div>
      {form.packagingTreatment === "separate" && <div><Label htmlFor={`${prefix}-packaging-amount`}>Total packaging ({workflow.currency})</Label><Input id={`${prefix}-packaging-amount`} inputMode="decimal" placeholder="Enter 0 when no packaging charge" value={form.packagingAmount} onChange={(event) => field("packagingAmount", event.target.value)} /></div>}
      <div><Label htmlFor={`${prefix}-reference`}>Supplier quote reference</Label><Input id={`${prefix}-reference`} value={form.quoteReference} onChange={(event) => field("quoteReference", event.target.value)} /></div>
      <div><Label htmlFor={`${prefix}-date`}>Quote date</Label><Input id={`${prefix}-date`} type="date" value={form.quoteDate} onChange={(event) => field("quoteDate", event.target.value)} /></div>
      <div><Label htmlFor={`${prefix}-valid`}>Valid until (if supplied)</Label><Input id={`${prefix}-valid`} type="date" value={form.quoteValidUntil} onChange={(event) => field("quoteValidUntil", event.target.value)} /></div>
      <div><Label htmlFor={`${prefix}-lead`}>Quoted lead time (days, if supplied)</Label><Input id={`${prefix}-lead`} inputMode="numeric" value={form.leadTimeDays} onChange={(event) => field("leadTimeDays", event.target.value)} /></div>
      <div className="sm:col-span-2"><Label htmlFor={`${prefix}-reason`}>Quote note / reason for revision</Label><Textarea id={`${prefix}-reason`} value={form.reason} onChange={(event) => field("reason", event.target.value)} /></div>
    </fieldset>
    {form.packagingTreatment !== "separate" && <p className="text-xs text-amber-700 dark:text-amber-300">The quote can be preserved now. Product and packaging treatment must be resolved before creating the purchase order.</p>}
    {(validationError || command.error) && <p role="alert" className="text-sm text-destructive">{validationError ?? command.error?.message}</p>}
    {command.error instanceof FinancialCommandRequestError && command.error.code === "RFQ_VERSION_CONFLICT" && <Button type="button" size="sm" variant="outline" onClick={onSaved}>Discard draft and load latest quote</Button>}
    <div className="flex flex-wrap gap-2"><Button type="submit" size="sm" disabled={locked}>{command.isPending ? "Saving…" : "Save quote revision"}</Button><Button type="button" size="sm" variant="outline" onClick={onClose} disabled={locked}>Cancel</Button>{command.unresolved && <Button type="button" size="sm" variant="outline" onClick={command.retryUnresolved} disabled={command.isPending}>Retry saved request</Button>}</div>
  </form>;
}

export function RfqWorkflowPanel({ rfqId }: { rfqId: number }) {
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("purchasing", "edit");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [historyId, setHistoryId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selectionVersion, setSelectionVersion] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [createdPo, setCreatedPo] = useState<{ id: number; number: string } | null>(null);
  const queryKey = ["rfq-workflow", rfqId];
  const workflowQuery = useQuery({ queryKey, queryFn: async () => rfqWorkflowDetailSchema.parse(await (await apiRequest("GET", `/api/purchasing/rfqs/${rfqId}`)).json()) });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey });
    queryClient.invalidateQueries({ predicate: (query) => typeof query.queryKey[0] === "string" && (query.queryKey[0].startsWith("/api/purchasing/rfqs") || query.queryKey[0] === "/api/purchasing/rfq-queue" || query.queryKey[0] === "/api/purchase-orders") });
    queryClient.invalidateQueries({ queryKey: ["rfq-quote-history", rfqId] });
  };
  const conversion = useRfqCommand((value) => {
    const result = rfqConversionResultSchema.parse(value);
    setCreatedPo({ id: result.purchaseOrderId, number: result.poNumber });
    setSelected(new Set());
    setOverrideReason("");
    refresh();
  });
  if (workflowQuery.isPending) return <p className="mt-3 text-sm text-muted-foreground">Loading quote workflow…</p>;
  if (workflowQuery.error || !workflowQuery.data) return <div className="mt-3 text-sm" role="alert">Could not load the quote workflow. <Button variant="link" onClick={() => workflowQuery.refetch()}>Retry</Button></div>;
  const workflow = workflowQuery.data;
  const locked = conversion.isPending || conversion.unresolved !== null;
  const selectionChanged = selected.size > 0 && selectionVersion !== workflow.version;
  const selectedLines = workflow.lines.filter((line) => selected.has(line.id));
  const quantitiesDiffer = selectedLines.some((line) => line.latestQuote?.quotedPieces !== line.requestedPieces);
  const requiresQuantityReason = quantitiesDiffer || selectedLines.some((line) => line.quantityReview.requiresReason);
  const editingLine = workflow.lines.find((line) => line.id === editingId);
  return <section className="mt-4 space-y-3" aria-label="Quote capture and purchase-order handoff">
    <div><h3 className="text-sm font-semibold">{workflow.rfqNumber} · Supplier quotes → draft purchase order</h3><p className="text-xs text-muted-foreground">Capture the final quote, review selected lines, and open the linked draft purchase.</p></div>
    <Button size="sm" variant="outline" disabled={locked || workflowQuery.isFetching} onClick={() => workflowQuery.refetch()}>Refresh quotes</Button>
    {workflow.currency !== "USD" && <p className="text-xs text-amber-700 dark:text-amber-300">Quote currency: {workflow.currency}. Purchase orders currently require USD; currency review is required before conversion.</p>}
    {createdPo && <p className="rounded border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">Draft created: <Link className="font-semibold underline" href={`/purchase-orders/${createdPo.id}`}>{createdPo.number}</Link></p>}
    <div className="space-y-2">{workflow.lines.map((line) => {
      const quote = line.latestQuote;
      const expired = quote?.quote.quoteValidUntil != null && quote.quote.quoteValidUntil < new Date().toISOString().slice(0, 10);
      const eligible = line.quantityReview.canConvert && !expired && line.status === "quoted" && line.purchaseOrder === null && quote?.quote.packagingTreatment === "separate" && workflow.currency === "USD";
      return <div key={line.id} className="rounded border bg-background p-3">
        <div className="flex flex-wrap items-start gap-2">
          {canEdit && <Checkbox aria-label={`Select ${line.sku} for draft purchase order`} disabled={!eligible || locked || editingId !== null || selectionChanged} checked={selected.has(line.id)} onCheckedChange={(checked) => { if (selected.size === 0) setSelectionVersion(workflow.version); setOverrideReason(""); setSelected((current) => { const next = new Set(current); if (checked === true) next.add(line.id); else next.delete(line.id); return next; }); }} />}
          <div className="min-w-0 flex-1"><p className="text-sm font-semibold">{line.sku} <span className="font-normal text-muted-foreground">{line.productName}</span></p>
            {quote ? <p className="mt-1 text-xs">Revision {quote.revision} · {quote.quote.quoteReference} · {quote.quotedPieces.toLocaleString()} pieces · {rfqMoneyAsInput(quote.quotedUnitCostMills, 4)}/piece {quote.currency}{quote.quote.quoteValidUntil ? ` · valid until ${quote.quote.quoteValidUntil}` : ""}</p> : <p className="mt-1 text-xs text-muted-foreground">No versioned quote captured.</p>}
            {quote && <p className="mt-1 text-xs">Quoted product total: {rfqMoneyAsInput(quote.productTotalMills, 4)} {quote.currency} · Packaging: {quote.quote.packagingCostCents === null ? "unresolved" : `${rfqMoneyAsInput(quote.quote.packagingCostCents, 2)} ${quote.currency}`}{quote.pricingRemainderMills !== 0 ? " · Per-piece display is rounded; the quoted total is preserved." : ""}</p>}
            {!line.purchaseOrder && <div className="mt-2 space-y-1 text-xs" aria-label={`Supplier order rules for ${line.sku}`}>
              {line.quantityReview.currentRules && <p>Current supplier rules: MOQ {line.quantityReview.currentRules.minimumOrderPieces?.toLocaleString() ?? "not stated"} · Order multiple {line.quantityReview.currentRules.orderMultiplePieces.toLocaleString()} pieces.</p>}
              {line.quantityReview.issues.includes("supplier_rules_changed") && line.quantityReview.recommendationRules && <p className="text-muted-foreground">At recommendation: MOQ {line.quantityReview.recommendationRules.minimumOrderPieces?.toLocaleString() ?? "not stated"} · Order multiple {line.quantityReview.recommendationRules.orderMultiplePieces.toLocaleString()} pieces.</p>}
              {line.quantityReview.issues.map((issue) => <p key={issue} className="text-amber-700 dark:text-amber-300">{rfqQuantityReviewMessage(issue, line.quantityReview)}</p>)}
            </div>}
            {expired && <Badge variant="outline" className="mt-1">Quote expired · capture current evidence</Badge>}
            {quote && quote.quote.packagingTreatment !== "separate" && <Badge variant="outline" className="mt-1">Packaging review required</Badge>}
            {line.purchaseOrder && <p className="mt-1 text-xs">Purchase: <Link className="font-semibold underline" href={`/purchase-orders/${line.purchaseOrder.purchaseOrderId}`}>{line.purchaseOrder.poNumber}</Link> · {line.purchaseOrder.status}</p>}
          </div>
          {canEdit && ["draft", "sent", "quoted"].includes(line.status) && !line.purchaseOrder && <Button size="sm" variant="outline" disabled={locked || editingId !== null} onClick={() => setEditingId(line.id)}>{quote ? "Revise quote" : "Capture quote"}</Button>}
          <Button size="sm" variant="ghost" onClick={() => setHistoryId(historyId === line.id ? null : line.id)}>Quote history</Button>
        </div>
        {historyId === line.id && <div className="mt-2"><QuoteHistory rfqId={rfqId} lineId={line.id} /></div>}
      </div>;
    })}</div>
    {editingLine && <QuoteEditor key={editingLine.id} workflow={workflow} line={editingLine} onClose={() => setEditingId(null)} onSaved={() => { setEditingId(null); setSelected(new Set()); refresh(); }} />}
    {canEdit && <div className="space-y-2 rounded border p-3">
      {selectionChanged && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">The quote request changed after selection. <Button variant="link" onClick={() => { setSelected(new Set()); setSelectionVersion(null); setOverrideReason(""); }}>Clear selection and review current quotes</Button></p>}
      {requiresQuantityReason && <div><Label htmlFor={`rfq-${rfqId}-override`}>Reason for accepting the quoted quantity</Label><Textarea id={`rfq-${rfqId}-override`} disabled={locked} value={overrideReason} onChange={(event) => setOverrideReason(event.target.value)} /><p className="mt-1 text-xs text-muted-foreground">Quoted quantities are preserved. This review reason is saved with the draft purchase.</p></div>}
      <Button size="sm" disabled={locked || selectionChanged || editingId !== null || selectedLines.length === 0 || (requiresQuantityReason && !overrideReason.trim())} onClick={() => conversion.submit(`/api/purchasing/rfqs/${rfqId}/convert`, { expectedVersion: workflow.version, lines: selectedLines.map((line) => ({ rfqLineId: line.id, quoteRevisionId: line.latestQuote!.id })), quantityOverrideReason: requiresQuantityReason ? overrideReason.trim() : null }, "conversion")}>{conversion.isPending ? "Creating draft…" : `Create draft PO (${selectedLines.length} selected)`}</Button>
      {conversion.error && <p className="text-sm text-destructive" role="alert">{conversion.error.message}</p>}
      {conversion.unresolved && <Button size="sm" variant="outline" disabled={conversion.isPending} onClick={conversion.retryUnresolved}>Retry saved request</Button>}
    </div>}
  </section>;
}
