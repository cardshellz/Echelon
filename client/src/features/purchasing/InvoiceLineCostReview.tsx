import { SupplierCreditLink } from "./SupplierCreditLink";
import React, { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearch } from "wouter";
import { INVOICE_COST_QUERY_PARAM } from "@/lib/procurement-navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invalidatePurchaseCosts } from "@/lib/invalidate-purchase-costs";
import {
  invoiceCostComponentEvidenceSchema, invoiceCostReviewResultSchema,
  type InvoiceCostReview, type InvoiceCostReviewResult,
  invoiceCostImpactPreviewSchema, invoiceCostReviewApplicationSchema, type InvoiceCostImpactPreview,
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
import { reconciliationDestinations } from "@shared/procurement/cost-reconciliation";
import { z } from "zod";

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
    <p className="font-medium">Supplier amounts saved. The invoice total is unchanged.</p>
    {application === null ? <p>No purchase order line is linked to this invoice line.</p> : <p>{application.lotsUpdated} stock records and {application.cogsRowsUpdated} sold-order costs updated.</p>}
    {needsReview && <p className="font-medium text-amber-700 dark:text-amber-300">Further cost review is required before all linked costs can be applied.</p>}
    {issues.length > 0 && <ul className="list-disc space-y-1 pl-4">{issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul>}
  </div>;
}

export function InvoiceCostImpactReview({ preview, currency }: { preview: InvoiceCostImpactPreview; currency: string }) {
  const money = (value: number | null) => value === null ? "Not confirmed" : `${exactMoneyAsInput(value, 4)} ${currency}`;
  const rows: Array<[string, number | null, number | null]> = [
    ["Product amount", preview.before?.productMills ?? null, preview.after.productMills],
    ["Packaging amount", preview.before?.packagingMills ?? null, preview.after.packagingMills],
    ["Other adjustments", preview.before?.adjustmentMills ?? null, preview.after.adjustmentMills],
    ...preview.impact.lots.filter(row => row.unitCostMills.before !== row.unitCostMills.after).map(row => [`${row.lotNumber} · cost per stock unit`, row.unitCostMills.before, row.unitCostMills.after] as [string, number | null, number | null]),
    ...preview.impact.orderCosts.filter(row => row.totalMills.before !== row.totalMills.after).map(row => [`Sold order #${row.orderId}`, row.totalMills.before, row.totalMills.after] as [string, number | null, number | null]),
    ...preview.impact.historicalCosts.filter(row => row.totalMills.before !== row.totalMills.after).map(row => [reconciliationDestinations[row.destination], row.totalMills.before, row.totalMills.after] as [string, number | null, number | null]),
  ];
  return <section aria-label="Supplier cost changes" className="space-y-2 text-sm">
    <h3 className="font-semibold">Review the cost changes</h3>
    <table className="w-full table-fixed"><thead><tr className="border-b"><th className="w-[46%] text-left py-2">What changes</th><th className="text-right p-2">Before</th><th className="text-right py-2">After</th></tr></thead>
      <tbody>{rows.map(([label, before, after], index) => <tr key={`${label}:${index}`} className="border-b"><th className="text-left py-2 pr-2 font-normal break-words">{label}</th><td className="text-right p-2 break-words">{money(before)}</td><td className="text-right py-2 font-medium break-words">{money(after)}</td></tr>)}</tbody></table>
    <p>Invoice total: {exactMoneyAsInput(preview.lineTotalCents, 2)} {currency} → {exactMoneyAsInput(preview.lineTotalCents, 2)} {currency}. Stock quantities do not change.</p>
  </section>;
}

function ReviewEditor({ line, currency, blockedReason, onSaved, onDiscard, onClose, setBusy }: {
  line: ReviewLine; currency: string; blockedReason: string | null;
  onSaved: () => void; onDiscard: () => void; onClose: () => void; setBusy: (value: boolean) => void;
}) {
  // The editor receives a frozen row snapshot. Refetches cannot silently replace
  // the version or amounts on which an in-progress review was based.
  const [form, setForm] = useState<InvoiceCostReviewForm>(() => invoiceCostReviewForm(line.costComponentEvidence));
  const queryClient = useQueryClient();
  const [validationError, setValidationError] = useState<string | null>(null);
  const [unresolved, setUnresolved] = useState<ReviewIntent | null>(null);
  const [saved, setSaved] = useState<InvoiceCostReviewResult | null>(null);
  const [reviewed, setReviewed] = useState<{ body: InvoiceCostReview; preview: InvoiceCostImpactPreview; application: InvoiceCostReviewResult["application"] } | null>(null);
  const preview = useMutation({
    mutationFn: async (body: InvoiceCostReview) => {
      const result = z.object({ preview: invoiceCostImpactPreviewSchema, application: invoiceCostReviewApplicationSchema.nullable() }).strict().parse(
        await financialCommandFetchJson(`/api/vendor-invoice-lines/${line.id}/cost-components/preview`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      if (result.preview.lineId !== line.id || result.preview.lineTotalCents !== line.lineTotalCents
        || result.preview.after.productMills !== body.productMills || result.preview.after.packagingMills !== body.packagingMills
        || result.preview.after.adjustmentMills !== body.adjustmentMills || result.preview.after.packagingTreatment !== body.packagingTreatment)
        throw new Error("The cost preview does not match this invoice. Reload before saving.");
      return result;
    },
    onMutate: () => setBusy(true),
    onSuccess: (result, body) => setReviewed({ body, ...result }),
    onSettled: () => setBusy(false),
  });
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
    // A lost response may follow a committed posting. Keep the frozen edit
    // intent, but refresh every current-status reader even after an error.
    onSettled: () => invalidatePurchaseCosts(queryClient),
  });
  const locked = mutation.isPending || preview.isPending || unresolved !== null || saved !== null || blockedReason !== null;
  const failure = mutation.error ?? preview.error;
  const stale = failure instanceof FinancialCommandRequestError && failure.code === "INVOICE_COST_REVIEW_STALE";
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
      if (!reviewed) {
        const body = invoiceCostReviewFromForm(form, line.costReviewVersion ?? "", line.lineTotalCents);
        setValidationError(null); preview.mutate(body); return;
      }
      const body = { ...reviewed.body, previewVersion: reviewed.preview.previewVersion };
      const key = store.current.acquire({ lineId: line.id, body });
      setValidationError(null); setBusy(true); mutation.mutate({ key, body });
    } catch (error) { setValidationError(error instanceof Error ? error.message : "Review the cost fields."); }
  }
  return <form onSubmit={submit} className="space-y-4">
    {blockedReason && <p className="text-sm text-muted-foreground">{blockedReason}</p>}
    {!reviewed && !saved && <>
    <div className="grid gap-2 rounded border bg-muted/30 p-3 sm:grid-cols-2">
      <div><p className="text-xs text-muted-foreground">Amount on the invoice</p><p className="font-mono font-semibold">{validTotal ? exactMoneyAsInput(line.lineTotalCents, 2) : "Unavailable"} {currency}</p></div>
      <div><p className="text-xs text-muted-foreground">Total entered below</p><p className="font-mono font-semibold">{componentTotal === null ? "Enter the amounts below" : `${exactMoneyAsInput(componentTotal, 4)} ${currency}`}</p></div>
    </div>
    {!known && !saved && <p className="text-sm text-amber-700 dark:text-amber-300">The product and packaging amounts are missing. Check the supplier's invoice. Enter totals for this whole line, using 0 for amounts not charged.</p>}
    <fieldset disabled={locked || stale || reviewed !== null} className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2"><Label htmlFor={`${prefix}-treatment`}>Is packaging included in the product price?</Label><Select value={form.packagingTreatment} onValueChange={(value) => field("packagingTreatment", value)} disabled={locked || stale}><SelectTrigger id={`${prefix}-treatment`}><SelectValue placeholder="Check how the supplier billed packaging" /></SelectTrigger><SelectContent><SelectItem value="separate">No, packaging is charged separately</SelectItem><SelectItem value="included_in_product">Yes, packaging is included</SelectItem></SelectContent></Select></div>
      <div><Label htmlFor={`${prefix}-product`}>Product total ({currency})</Label><Input id={`${prefix}-product`} inputMode="decimal" value={form.product} onChange={(event) => field("product", event.target.value)} /></div>
      <div><Label htmlFor={`${prefix}-packaging`}>Packaging total ({currency})</Label><Input id={`${prefix}-packaging`} inputMode="decimal" value={form.packaging} onChange={(event) => field("packaging", event.target.value)} /></div>
      <div className="sm:col-span-2"><Label htmlFor={`${prefix}-adjustment`}>Other adjustments / credits ({currency})</Label><Input id={`${prefix}-adjustment`} inputMode="decimal" value={form.adjustment} onChange={(event) => field("adjustment", event.target.value)} /><p className="mt-1 text-xs text-muted-foreground">Enter credits as negative amounts. Adjustments are preserved and may require further cost review.</p></div>
      {!blockedReason && <div className="sm:col-span-2"><Label htmlFor={`${prefix}-reason`}>Notes / supplier invoice reference</Label><Textarea id={`${prefix}-reason`} maxLength={2000} value={form.reason} onChange={(event) => field("reason", event.target.value)} /></div>}
    </fieldset>
    {componentTotal !== null && !balanced && <p className="text-sm text-amber-700 dark:text-amber-300">The amounts must add up to this line's invoice amount exactly.</p>}
    </>}
    {reviewed && !saved && <><InvoiceCostImpactReview preview={reviewed.preview} currency={currency} />
      <p className="text-sm">Packaging: {reviewed.body.packagingTreatment === "included_in_product" ? "included in the product amount" : "billed separately"}.<br />Supplier reference: {reviewed.body.reason}</p>
      {reviewed.application?.costApplications.some(item => item.status === "review_required") && <p className="text-sm text-amber-700">These supplier amounts can be saved, but some cost records still need attention. Their saved reasons will remain in Cost review.</p>}</>}
    {(validationError || failure) && <p role="alert" className="text-sm text-destructive">{validationError ?? failure?.message}</p>}
    {saved && <ReviewResult result={saved} />}
    <div className="flex flex-wrap gap-2">
      {!blockedReason && !saved && <Button type="submit" disabled={locked || stale}>{mutation.isPending ? "Applying costs…" : preview.isPending ? "Loading cost changes…" : reviewed ? "Approve and apply costs" : "Review cost changes"}</Button>}
      {reviewed && !saved && <Button type="button" variant="outline" disabled={locked || stale} onClick={() => setReviewed(null)}>Edit amounts</Button>}
      {stale && <Button type="button" variant="outline" onClick={onDiscard}>Discard review and reload invoice</Button>}
      {unresolved && <Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => { setBusy(true); mutation.mutate(unresolved); }}>Retry saved request</Button>}
      <Button type="button" variant="outline" disabled={mutation.isPending || unresolved !== null} onClick={onClose}>Close review</Button>
    </div>
  </form>;
}

export function InvoiceLineCostReview({ line, currency, invoiceStatus, invoiceId, onSaved, open, onOpenChange, hideTrigger = false }: {
  line: ReviewLine; currency: string; invoiceStatus: string; invoiceId: number; onSaved: () => void;
  open?: boolean; onOpenChange?: (value: boolean) => void; hideTrigger?: boolean;
}) {
  const { hasPermission } = useAuth();
  const [snapshot, setSnapshot] = useState<ReviewLine | null>(null);
  const [busy, setBusy] = useState(false);
  const search = useSearch();
  const openedFromLink = useRef<string | null>(null);
  useEffect(() => { if (open && snapshot === null) setSnapshot({ ...line }); }, [open, line, snapshot]);
  function close() { setSnapshot(null); onOpenChange?.(false); }
  useEffect(() => {
    const values = new URLSearchParams(search).getAll(INVOICE_COST_QUERY_PARAM);
    // Only the actual invoice row can open the linked editor. Duplicate,
    // malformed and foreign line identifiers never select a different row.
    if (values.length === 1 && values[0] === String(line.id) && openedFromLink.current !== search) {
      openedFromLink.current = search;
      setSnapshot({ ...line });
    }
  }, [search, line]);
  const known = invoiceCostComponentEvidenceSchema.safeParse(line.costComponentEvidence).success;
  const blockedReason = !hasPermission("purchasing", "approve") ? "Purchasing approval permission is required to save cost evidence."
    : invoiceStatus === "voided" ? "Voided invoice cost evidence is read only."
      : currency !== "USD" ? "This currency requires cost review outside the current USD application owner."
        : !Number.isSafeInteger(line.lineTotalCents) || !costFingerprintSchema.safeParse(line.costReviewVersion).success ? "Current invoice evidence is unavailable. Reload the invoice before reviewing costs." : null;
  return <>
    {!hideTrigger && <Button size="sm" variant="outline" className="h-auto whitespace-normal py-1 text-xs" onClick={() => setSnapshot({ ...line })} aria-label={`Review costs for ${line.sku || `line ${line.lineNumber}`}`}>
      {known ? "View cost breakdown" : "Review cost breakdown"}
    </Button>}
    <Dialog open={snapshot !== null} onOpenChange={(open) => { if (!open && !busy) close(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl" onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }} onInteractOutside={(event) => { if (busy) event.preventDefault(); }}>
        <DialogHeader><DialogTitle>Invoice cost breakdown · {snapshot?.sku || `Line ${snapshot?.lineNumber}`}</DialogTitle><DialogDescription>Split this line's invoice amount into product, packaging and any adjustments. These totals are used to review inventory costs.</DialogDescription></DialogHeader>
        <p className="text-sm">Supplier credit documents are recorded separately from this original invoice breakdown. <SupplierCreditLink sourceInvoiceId={invoiceId} /></p>
        {snapshot && <ReviewEditor line={snapshot} currency={currency} blockedReason={blockedReason} onSaved={onSaved} setBusy={setBusy} onClose={close} onDiscard={() => { close(); onSaved(); }} />}
      </DialogContent>
    </Dialog>
  </>;
}
