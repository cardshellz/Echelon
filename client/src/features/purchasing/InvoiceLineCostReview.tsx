import { useRef, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  invoiceCostComponentEvidenceSchema, invoiceCostReviewResultSchema,
  type InvoiceCostReview, type InvoiceCostReviewResult,
} from "@shared/procurement/invoice-cost-review";
import { costFingerprintSchema } from "@shared/procurement/cost-source-contracts";
import { useAuth } from "@/lib/auth";
import { exactMoneyAsInput } from "@/lib/exact-money-input";
import { invoiceCostReviewAmounts, invoiceCostReviewForm, invoiceCostReviewFromForm, type InvoiceCostReviewForm } from "@/lib/invoice-cost-review-form";
import { createFinancialCommandIntentStore, financialCommandFetchJson, financialCommandRetryDelay, FinancialCommandRequestError, shouldRetryFinancialCommand } from "@/lib/financial-command";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type ReviewLine = {
  id: number;
  lineNumber: number;
  sku: string | null;
  lineTotalCents: number;
  costReviewVersion?: string;
  costComponentEvidence?: unknown;
};
type ReviewIntent = { key: string; body: InvoiceCostReview };

function ReviewResult({ result }: { result: InvoiceCostReviewResult }) {
  const application = result.application;
  const issues = application?.costApplications.flatMap((item) => item.issues) ?? [];
  const needsReview = application?.costApplications.some((item) => item.status === "review_required") ?? false;
  return <div role="status" className="space-y-2 rounded border bg-muted/30 p-3 text-sm">
    <p className="font-medium">Cost evidence saved. The invoice line total is unchanged.</p>
    {application === null ? <p>No purchase order line is linked to this invoice line.</p> : <p>{application.lotsUpdated} inventory lots and {application.cogsRowsUpdated} COGS rows updated by the cost owner.</p>}
    {needsReview && <p className="font-medium text-amber-700 dark:text-amber-300">Further cost review is required before all linked costs can be applied.</p>}
    {issues.length > 0 && <ul className="list-disc space-y-1 pl-4">{issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul>}
  </div>;
}

function ReviewEditor({ line, currency, blockedReason, onSaved, onDiscard, onClose, setBusy }: {
  line: ReviewLine; currency: string; blockedReason: string | null;
  onSaved: () => void; onDiscard: () => void; onClose: () => void; setBusy: (value: boolean) => void;
}) {
  // The editor receives a frozen row snapshot. Refetches cannot silently replace
  // the version or amounts on which an in-progress review was based.
  const [form, setForm] = useState<InvoiceCostReviewForm>(() => invoiceCostReviewForm(line.costComponentEvidence));
  const [validationError, setValidationError] = useState<string | null>(null);
  const [unresolved, setUnresolved] = useState<ReviewIntent | null>(null);
  const [saved, setSaved] = useState<InvoiceCostReviewResult | null>(null);
  const store = useRef(createFinancialCommandIntentStore(() => crypto.randomUUID()));
  const mutation = useMutation<InvoiceCostReviewResult, Error, ReviewIntent>({
    mutationFn: async (intent) => {
      const response = await financialCommandFetchJson<unknown>(`/api/vendor-invoice-lines/${line.id}/cost-components`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json", "Idempotency-Key": intent.key },
        body: JSON.stringify(intent.body),
      });
      const parsed = invoiceCostReviewResultSchema.safeParse(response);
      if (!parsed.success || parsed.data.id !== line.id) {
        throw new FinancialCommandRequestError("The review may have completed, but its response was incomplete. Retry the saved request safely.", {
          status: 200, retryable: true, ambiguous: true, code: "INVOICE_COST_REVIEW_RESPONSE_INVALID",
        });
      }
      return parsed.data;
    },
    retry: shouldRetryFinancialCommand,
    retryDelay: financialCommandRetryDelay,
    onSuccess: (result, intent) => {
      store.current.complete(intent.key); setUnresolved(null); setSaved(result); setBusy(false); onSaved();
    },
    onError: (error, intent) => {
      store.current.fail(intent.key, error);
      const ambiguous = error instanceof FinancialCommandRequestError && error.ambiguous;
      setUnresolved(ambiguous ? intent : null); setBusy(ambiguous);
    },
  });
  const locked = mutation.isPending || unresolved !== null || saved !== null || blockedReason !== null;
  const stale = mutation.error instanceof FinancialCommandRequestError && mutation.error.code === "INVOICE_COST_REVIEW_STALE";
  const known = invoiceCostComponentEvidenceSchema.safeParse(line.costComponentEvidence).success;
  const prefix = `invoice-cost-${line.id}`;
  const validTotal = Number.isSafeInteger(line.lineTotalCents);
  let componentTotal: bigint | null = null;
  try {
    const amounts = invoiceCostReviewAmounts(form);
    componentTotal = BigInt(amounts.productMills) + BigInt(amounts.packagingMills) + BigInt(amounts.adjustmentMills);
  } catch { /* Incomplete fields are represented as unknown, never zero. */ }
  const balanced = componentTotal !== null && validTotal && componentTotal === BigInt(line.lineTotalCents) * BigInt(100);
  function field(name: keyof InvoiceCostReviewForm, value: string) {
    setForm((current) => ({ ...current, [name]: value })); setValidationError(null);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (locked || stale) return;
    try {
      const body = invoiceCostReviewFromForm(form, line.costReviewVersion ?? "", line.lineTotalCents);
      const key = store.current.acquire({ lineId: line.id, body });
      setValidationError(null); setBusy(true); mutation.mutate({ key, body });
    } catch (error) { setValidationError(error instanceof Error ? error.message : "Review the cost fields."); }
  }
  return <form onSubmit={submit} className="space-y-4">
    <div className="grid gap-2 rounded border bg-muted/30 p-3 sm:grid-cols-2">
      <div><p className="text-xs text-muted-foreground">Recorded invoice line total</p><p className="font-mono font-semibold">{validTotal ? exactMoneyAsInput(line.lineTotalCents, 2) : "Unavailable"} {currency}</p></div>
      <div><p className="text-xs text-muted-foreground">Reviewed component total</p><p className="font-mono font-semibold">{componentTotal === null ? "Incomplete" : `${exactMoneyAsInput(componentTotal, 4)} ${currency}`}</p></div>
    </div>
    {!known && !saved && <p className="text-sm text-amber-700 dark:text-amber-300">Component amounts are unknown. Enter the supplier evidence, including explicit zero amounts where applicable.</p>}
    {blockedReason && <p className="text-sm text-muted-foreground">{blockedReason}</p>}
    <fieldset disabled={locked || stale} className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2"><Label htmlFor={`${prefix}-treatment`}>Packaging treatment</Label><Select value={form.packagingTreatment} onValueChange={(value) => field("packagingTreatment", value)} disabled={locked || stale}><SelectTrigger id={`${prefix}-treatment`}><SelectValue placeholder="Select from supplier evidence" /></SelectTrigger><SelectContent><SelectItem value="separate">Separate amount confirmed</SelectItem><SelectItem value="included_in_product">Included in product amount</SelectItem></SelectContent></Select></div>
      <div><Label htmlFor={`${prefix}-product`}>Extended product cost ({currency})</Label><Input id={`${prefix}-product`} inputMode="decimal" value={form.product} onChange={(event) => field("product", event.target.value)} /></div>
      <div><Label htmlFor={`${prefix}-packaging`}>Extended packaging cost ({currency})</Label><Input id={`${prefix}-packaging`} inputMode="decimal" value={form.packaging} onChange={(event) => field("packaging", event.target.value)} /></div>
      <div className="sm:col-span-2"><Label htmlFor={`${prefix}-adjustment`}>Other adjustments / credits ({currency})</Label><Input id={`${prefix}-adjustment`} inputMode="decimal" value={form.adjustment} onChange={(event) => field("adjustment", event.target.value)} /><p className="mt-1 text-xs text-muted-foreground">Enter credits as negative amounts. Adjustments are preserved and may require further cost review.</p></div>
      {!blockedReason && <div className="sm:col-span-2"><Label htmlFor={`${prefix}-reason`}>Review reason / supplier reference</Label><Textarea id={`${prefix}-reason`} maxLength={2000} value={form.reason} onChange={(event) => field("reason", event.target.value)} /></div>}
    </fieldset>
    {componentTotal !== null && !balanced && <p className="text-sm text-amber-700 dark:text-amber-300">The component total must equal the recorded invoice line total exactly.</p>}
    {(validationError || mutation.error) && <p role="alert" className="text-sm text-destructive">{validationError ?? mutation.error?.message}</p>}
    {saved && <ReviewResult result={saved} />}
    <div className="flex flex-wrap gap-2">
      {!blockedReason && !saved && <Button type="submit" disabled={locked || stale}>{mutation.isPending ? "Saving review…" : "Save cost review"}</Button>}
      {stale && <Button type="button" variant="outline" onClick={onDiscard}>Discard review and reload invoice</Button>}
      {unresolved && <Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => { setBusy(true); mutation.mutate(unresolved); }}>Retry saved request</Button>}
      <Button type="button" variant="outline" disabled={mutation.isPending || unresolved !== null} onClick={onClose}>Close review</Button>
    </div>
  </form>;
}

export function InvoiceLineCostReview({ line, currency, invoiceStatus, onSaved }: {
  line: ReviewLine; currency: string; invoiceStatus: string; onSaved: () => void;
}) {
  const { hasPermission } = useAuth();
  const [snapshot, setSnapshot] = useState<ReviewLine | null>(null);
  const [busy, setBusy] = useState(false);
  const known = invoiceCostComponentEvidenceSchema.safeParse(line.costComponentEvidence).success;
  const blockedReason = !hasPermission("purchasing", "approve") ? "Purchasing approval permission is required to save cost evidence."
    : invoiceStatus === "voided" ? "Voided invoice cost evidence is read only."
      : currency !== "USD" ? "This currency requires cost review outside the current USD application owner."
        : !Number.isSafeInteger(line.lineTotalCents) || !costFingerprintSchema.safeParse(line.costReviewVersion).success ? "Current invoice evidence is unavailable. Reload the invoice before reviewing costs." : null;
  return <>
    <Button size="sm" variant="outline" className="h-auto whitespace-normal py-1 text-xs" onClick={() => setSnapshot({ ...line })} aria-label={`Review costs for ${line.sku || `line ${line.lineNumber}`}`}>
      {known ? "View cost evidence" : "Review cost components"}
    </Button>
    <Dialog open={snapshot !== null} onOpenChange={(open) => { if (!open && !busy) setSnapshot(null); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl" onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }} onInteractOutside={(event) => { if (busy) event.preventDefault(); }}>
        <DialogHeader><DialogTitle>Invoice cost review · {snapshot?.sku || `Line ${snapshot?.lineNumber}`}</DialogTitle><DialogDescription>Record product and packaging evidence for this invoice line. Saving preserves the document amount and checks linked inventory costs.</DialogDescription></DialogHeader>
        {snapshot && <ReviewEditor line={snapshot} currency={currency} blockedReason={blockedReason} onSaved={onSaved} setBusy={setBusy} onClose={() => setSnapshot(null)} onDiscard={() => { setSnapshot(null); onSaved(); }} />}
      </DialogContent>
    </Dialog>
  </>;
}
