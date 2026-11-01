import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { purchaseTaxChangeSchema, purchaseTaxContextSchema, purchaseTaxApprovalRequestSchema, purchaseTaxPreviewSchema, purchaseTaxResultSchema,
  purchaseTaxTreatmentLabel, purchaseTaxApprovalHistorySchema, type PurchaseTaxContext, type PurchaseTaxTarget, type PurchaseTaxChange, type PurchaseTaxPreview } from "@shared/procurement/purchase-tax";
import { canonicalJson } from "@shared/utils/canonical-json";
import { readIntegerMills } from "@shared/money-read";
import { exactMoneyAsInput, parseExactMoneyInput } from "@/lib/exact-money-input";
import { financialCommandFetchJson, FinancialCommandRequestError, financialCommandNeedsRecovery, shouldRetryFinancialCommand, financialCommandRetryDelay } from "@/lib/financial-command";
import { invalidatePurchaseCosts } from "@/lib/invalidate-purchase-costs";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { costDestinationRows } from "./cost-destination-presentation";

const intentSchema = z.object({ key: z.string().uuid(), body: purchaseTaxApprovalRequestSchema, preview: purchaseTaxPreviewSchema }).strict();
type Intent = z.infer<typeof intentSchema>;
const money = (value: number | null, currency = "USD") => {
  if (value === null) return "Not verified";
  const amount = exactMoneyAsInput(value, 4).replace(/(\.\d{2})00$/, "$1");
  return currency === "USD" ? `$${amount}` : `${amount} ${currency}`;
};
const sourceLabel = (kind: string) => kind === "purchase_order" ? "PO estimate" : kind === "invoice" ? "Supplier invoice" : "Shipment";

function TaxImpact({ preview }: { preview: PurchaseTaxPreview }) {
  const destinations = costDestinationRows(preview.impact);
  return <div className="space-y-4 text-sm">
    {preview.change.kind === "tax_type" && <p className="rounded bg-muted p-3"><strong>{preview.change.name}</strong>: {purchaseTaxTreatmentLabel(preview.change.treatment)}</p>}
    {preview.settings.length > 0 && <table aria-label="Tax setting changes" className="w-full table-fixed"><thead><tr><th className="w-[34%] text-left py-2">Setting</th><th className="text-right">Before</th><th className="text-right">After</th></tr></thead>
      <tbody>{preview.settings.map(row => <tr key={row.label} className="border-t"><td className="py-2 break-words">{row.label}</td><td className="text-right break-words">{row.before}</td><td className="text-right break-words font-medium">{row.after}</td></tr>)}</tbody></table>}
    <section><h3 className="font-semibold">Inventory and linked order costs</h3>
      {destinations.length ? <table aria-label="Tax inventory cost changes" className="w-full table-fixed"><thead><tr><th className="w-[44%] py-2 text-left">What changes</th><th className="text-right">Before</th><th className="text-right">After</th></tr></thead><tbody>{destinations.map(([label, before, after], index) => <tr className="border-t" key={`${label}:${index}`}><td className="py-2 break-words">{label}</td><td className="text-right break-words">{money(before)}</td><td className="text-right break-words font-medium">{money(after)}</td></tr>)}</tbody></table>
        : <p className="text-muted-foreground">The recorded inventory and order cost amounts do not change.</p>}
    </section>
    {preview.after.map(after => {
      const before = preview.before.find(row => row.kind === after.kind && row.id === after.id && row.currency === after.currency);
      const amountFields = ["taxMills", "inventoryMills", "recoverableMills", "unclassifiedMills"] as const;
      if (amountFields.every(field => after[field] === 0 && (before?.[field] ?? 0) === 0)) return null;
      return <section key={`${after.kind}:${after.id}:${after.currency}`} className="rounded border p-3"><h3 className="font-semibold">{sourceLabel(after.kind)} · {after.reference}</h3>
        <table aria-label={`Tax changes ${after.reference}`} className="w-full table-fixed"><thead><tr><th className="w-[40%] text-left py-2">Tax amount</th><th className="text-right">Before</th><th className="text-right">After</th></tr></thead>
          <tbody>{([ ["On the document", "taxMills"], ["Included in inventory", "inventoryMills"], ["Recoverable tax", "recoverableMills"], ["Needs a tax type", "unclassifiedMills"] ] as const)
            .filter(([, field]) => (before?.[field] ?? 0) !== 0 || after[field] !== 0).map(([label, field]) => <tr className="border-t" key={field}><td className="py-2">{label}</td><td className="text-right break-words">{money(before?.[field] ?? 0, after.currency)}</td><td className="text-right break-words font-medium">{money(after[field], after.currency)}</td></tr>)}</tbody></table>
        {after.kind === "purchase_order" && <p className="text-xs text-muted-foreground">This is the PO estimate. A supplier invoice owns the actual tax for its billed goods.</p>}
      </section>;
    })}
    {preview.warnings.length > 0 && <div className="rounded border border-amber-300 p-3"><strong>Costs still needing attention</strong><ul className="mt-2 list-disc pl-4">{preview.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></div>}
    {preview.impact.applications.some(row => row.status === "pending_finalization") && <p className="rounded bg-muted p-3">This tax setting will be used for receiving and shipment finalization. Costs for goods not yet received will apply when they are received.</p>}
    <p className="text-xs text-muted-foreground">Supplier bills, payments, received pieces and stock counts stay unchanged. Recoverable tax is recorded separately; this does not file a tax refund claim. Order rows show their existing cost basis.</p>
  </div>;
}

function TaxEditor({ loaded, storageKey, setBusy, close, reload }: { loaded: PurchaseTaxContext; storageKey: string; setBusy: (busy: boolean) => void; close: () => void; reload: () => void }) {
  const [context] = useState(loaded), queryClient = useQueryClient();
  const recovery = useRef<{ intent: Intent | null; error: string | null } | null>(null);
  if (recovery.current === null) {
    try {
      const raw = sessionStorage.getItem(storageKey), intent = raw === null ? null : intentSchema.parse(JSON.parse(raw));
      if (intent && (intent.body.change.kind !== context.target.kind || intent.body.change.id !== context.target.id
        || canonicalJson(intent.body.change) !== canonicalJson(intent.preview.change) || intent.body.previewVersion !== intent.preview.previewVersion
        || intent.body.sourceVersion !== intent.preview.sourceVersion)) throw new Error("Saved approval scope is invalid");
      recovery.current = { intent, error: null };
    } catch { recovery.current = { intent: null, error: "The browser's saved approval cannot be read. An administrator must verify its outcome before another approval is created." }; }
  }
  const [pending, setPending] = useState(recovery.current.intent), active = useRef(recovery.current.intent);
  const [review, setReview] = useState<PurchaseTaxPreview | null>(null), [saved, setSaved] = useState<z.infer<typeof purchaseTaxResultSchema> | null>(null);
  const [error, setError] = useState<string | null>(null), [stale, setStale] = useState(false), [reason, setReason] = useState(""), [confirmed, setConfirmed] = useState(false);
  const current = context.current;
  const [code, setCode] = useState(current?.kind === "tax_type" ? current.code : ""), [name, setName] = useState(current?.kind === "tax_type" ? current.name : "");
  const [treatment, setTreatment] = useState(current?.kind === "tax_type" ? current.treatment : "");
  const [typeId, setTypeId] = useState(current && "taxTypeId" in current && current.taxTypeId !== null ? String(current.taxTypeId) : "");
  const [lineTypes, setLineTypes] = useState(current?.kind === "purchase_order" ? current.lineTypes : []);
  const [taxes, setTaxes] = useState(context.invoice?.taxes.map(tax => ({ typeId: String(tax.taxTypeId), amount: exactMoneyAsInput(tax.amountMills, 4) })) ?? []);
  const [product, setProduct] = useState(context.invoice?.components ? exactMoneyAsInput(context.invoice.components.productMills, 4) : "");
  const [packaging, setPackaging] = useState(context.invoice?.components ? exactMoneyAsInput(context.invoice.components.packagingMills, 4) : "");
  const [packagingTreatment, setPackagingTreatment] = useState(context.invoice?.components?.packagingTreatment ?? "");
  const [productOverridden, setProductOverridden] = useState(false);
  function draft(): PurchaseTaxChange {
    const target = context.target;
    if (target.kind === "tax_type") return purchaseTaxChangeSchema.parse({ ...target, code, name, treatment });
    if (target.kind === "purchase_order") return purchaseTaxChangeSchema.parse({ ...target, taxTypeId: typeId ? Number(typeId) : null, lineTypes });
    if (target.kind === "shipment_charge") return purchaseTaxChangeSchema.parse({ ...target, taxTypeId: typeId ? Number(typeId) : null });
    const entries = taxes.map(tax => ({ taxTypeId: Number(tax.typeId), amountMills: parseExactMoneyInput(tax.amount, 4) }));
    const adjustmentMills = entries.reduce((sum, tax) => sum + BigInt(tax.amountMills), BigInt(0));
    return purchaseTaxChangeSchema.parse({ ...target, taxes: entries, components: { contractVersion: 1, source: "operator_review", packagingTreatment,
      productMills: parseExactMoneyInput(product, 4), packagingMills: parseExactMoneyInput(packaging, 4), adjustmentMills: readIntegerMills(adjustmentMills, "invoice tax") } });
  }
  function changeTaxes(next: typeof taxes) {
    setTaxes(next);
    if (productOverridden || context.invoice?.components == null) return;
    try {
      const total = next.reduce((sum, tax) => sum + BigInt(parseExactMoneyInput(tax.amount, 4)), BigInt(0));
      const remainder = BigInt(context.invoice.totalCents) * BigInt(100) - BigInt(parseExactMoneyInput(packaging, 4)) - total;
      if (remainder >= BigInt(0)) setProduct(exactMoneyAsInput(remainder, 4));
    } catch { /* Incomplete form input is validated before preview. */ }
  }
  const preview = useMutation<PurchaseTaxPreview, Error>({ mutationFn: async () => {
    let change: PurchaseTaxChange;
    try { change = draft(); }
    catch (error) {
      if (error instanceof z.ZodError) throw new Error(error.issues.find(issue => issue.path[0] === "code")?.message
        ?? "Choose a tax type and check the product, packaging and tax amounts.");
      throw error;
    }
    const request = { sourceVersion: context.sourceVersion, change };
    const result = purchaseTaxPreviewSchema.parse(await financialCommandFetchJson("/api/purchasing/tax-changes/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }));
    if (result.sourceVersion !== request.sourceVersion || canonicalJson(result.change) !== canonicalJson(request.change)) throw new Error("The tax preview does not match this change. Reload it.");
    return result;
  }, onMutate: () => setBusy(true), onSuccess: result => { setReview(result); setConfirmed(false); setError(null); },
  onError: failure => { if (failure instanceof FinancialCommandRequestError && failure.code === "PURCHASE_TAX_STALE") setStale(true); }, onSettled: () => setBusy(false) });
  const approval = useMutation<z.infer<typeof purchaseTaxResultSchema>, Error, Intent>({ mutationFn: async (intent: Intent) => {
    const parsed = purchaseTaxResultSchema.safeParse(await financialCommandFetchJson("/api/purchasing/tax-changes", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": intent.key }, body: JSON.stringify(intent.body) }));
    if (!parsed.success || canonicalJson(parsed.data.preview) !== canonicalJson(intent.preview)) throw new FinancialCommandRequestError("The change may have saved. Retry this approval to verify it.", { status: 200, code: "PURCHASE_TAX_RECEIPT_INVALID", ambiguous: true, retryable: true });
    return parsed.data;
  }, retry: shouldRetryFinancialCommand, retryDelay: financialCommandRetryDelay, onMutate: () => setBusy(true),
  onSuccess: result => { setSaved(result); setPending(null); active.current = null; try { sessionStorage.removeItem(storageKey); } catch { setError("Saved. Reopening will safely verify this same approval if the browser retains it."); } },
  onError: failure => {
    const uncertain = financialCommandNeedsRecovery(failure);
    if (!uncertain) { try { sessionStorage.removeItem(storageKey); } catch { setError("Reload before changing this approval."); } setPending(null); active.current = null; setStale(true); }
  }, onSettled: () => { setBusy(false); void invalidatePurchaseCosts(queryClient); } });
  const locked = preview.isPending || approval.isPending || pending !== null || saved !== null || stale || recovery.current.error !== null;
  const impact = saved?.preview ?? pending?.preview ?? review;
  function approve() {
    if (!review || active.current || !confirmed || !context.canApprove) return;
    try {
      const body = purchaseTaxApprovalRequestSchema.parse({ sourceVersion: review.sourceVersion, previewVersion: review.previewVersion, change: review.change, reason, approvalConfirmed: true });
      const intent = { key: crypto.randomUUID(), body, preview: review };
      sessionStorage.setItem(storageKey, JSON.stringify(intent)); active.current = intent; setPending(intent); approval.mutate(intent);
    } catch (failure) { setError(failure instanceof Error ? "Enter a reason of at least 10 characters and allow session storage for safe retries." : "Approval could not be prepared."); }
  }
  const typeOptions = <><option value="">{context.target.kind === "shipment_charge" ? "Choose a tax type" : "Use the PO default / not assigned"}</option>{context.types.map(type => <option value={type.id} key={type.id}>{type.code} · {type.name} · {purchaseTaxTreatmentLabel(type.treatment)}</option>)}</>;
  return <div className="flex min-h-0 flex-col gap-3">
    <div className="min-h-0 overflow-y-auto space-y-3 pr-1">
      {!context.canApprove && <p role="alert">An Administrator with purchasing approval permission must approve tax changes.</p>}
      {recovery.current.error && <p role="alert">{recovery.current.error}</p>}
      {!impact && <fieldset disabled={locked || !context.canApprove} className="space-y-3">
        {context.target.kind === "tax_type" ? <>
          <div><Label htmlFor="purchase-tax-code">Tax code</Label><Input id="purchase-tax-code" aria-describedby="purchase-tax-code-help" maxLength={40} value={code} onChange={event => setCode(event.target.value.toUpperCase())} /><p id="purchase-tax-code-help" className="mt-1 text-xs text-muted-foreground">Start with a letter. Use letters, numbers or underscores, such as IMPORT_VAT.</p></div>
          <div><Label htmlFor="purchase-tax-name">Tax name</Label><Input id="purchase-tax-name" maxLength={100} value={name} onChange={event => setName(event.target.value)} /></div>
          <div><Label htmlFor="purchase-tax-treatment">How this tax is recorded</Label><select id="purchase-tax-treatment" className="w-full rounded border bg-background p-2" value={treatment} onChange={event => setTreatment(event.target.value)}><option value="">Choose a treatment</option><option value="inventory">Include in inventory cost</option><option value="recoverable">Record separately as recoverable tax</option></select></div>
          <p className="text-sm text-muted-foreground">Changing a saved treatment reviews every linked purchase, invoice and shipment. Existing costs are updated through the same costing flow.</p>
        </> : context.target.kind === "invoice_line" ? <>
          <p>Billed line amount: <strong>{context.invoice ? `${exactMoneyAsInput(context.invoice.totalCents, 2)} ${context.invoice.currency}` : "Not verified"}</strong>. Product, packaging and tax must equal this amount.</p>
          <div className="grid gap-3 sm:grid-cols-2"><div><Label htmlFor="tax-product">Product total</Label><Input id="tax-product" inputMode="decimal" value={product} onChange={event => { setProductOverridden(true); setProduct(event.target.value); }} /></div>
            <div><Label htmlFor="tax-packaging">Packaging total</Label><Input id="tax-packaging" inputMode="decimal" value={packaging} onChange={event => setPackaging(event.target.value)} /></div></div>
          <div><Label htmlFor="tax-packaging-treatment">Is packaging included in the product amount?</Label><select id="tax-packaging-treatment" className="w-full rounded border bg-background p-2" value={packagingTreatment} onChange={event => setPackagingTreatment(event.target.value)}><option value="">Check the invoice</option><option value="included_in_product">Yes, included</option><option value="separate">No, billed separately</option></select></div>
          {taxes.map((tax, index) => <div className="grid grid-cols-[1fr_120px_auto] items-end gap-2" key={index}><div><Label htmlFor={`tax-kind-${index}`}>Tax type</Label><select id={`tax-kind-${index}`} value={tax.typeId} onChange={event => changeTaxes(taxes.map((row, at) => at === index ? { ...row, typeId: event.target.value } : row))} className="w-full rounded border bg-background p-2"><option value="">Choose type</option>{context.types.map(type => <option key={type.id} value={type.id}>{type.code} · {type.name}</option>)}</select></div>
            <div><Label htmlFor={`tax-amount-${index}`}>Tax amount</Label><Input id={`tax-amount-${index}`} inputMode="decimal" value={tax.amount} onChange={event => changeTaxes(taxes.map((row, at) => at === index ? { ...row, amount: event.target.value } : row))} /></div>
            <Button variant="outline" aria-label={`Remove tax ${index + 1}`} onClick={() => changeTaxes(taxes.filter((_, at) => at !== index))}>×</Button></div>)}
          <Button variant="outline" onClick={() => changeTaxes([...taxes, { typeId: "", amount: "" }])}>Add tax</Button>
          <p className="text-xs text-muted-foreground">The proposed product total subtracts entered tax from the bill. Check it against the supplier invoice; you can override it.</p>
        </> : <>
          <div><Label htmlFor="purchase-tax-type">{context.target.kind === "purchase_order" ? "Default tax type for this PO" : "Tax type for this shipment charge"}</Label><select id="purchase-tax-type" value={typeId} onChange={event => setTypeId(event.target.value)} className="w-full rounded border bg-background p-2">{typeOptions}</select></div>
          {context.target.kind === "purchase_order" && context.lines.filter(line => line.taxMills !== 0 || line.taxTypeId !== null).map(line => <div key={line.id}><Label htmlFor={`line-tax-${line.id}`}>{line.label} · {money(line.taxMills)}</Label><select id={`line-tax-${line.id}`} value={lineTypes.find(row => row.lineId === line.id)?.taxTypeId ?? ""} className="w-full rounded border bg-background p-2" onChange={event => setLineTypes(rows => rows.map(row => row.lineId === line.id ? { ...row, taxTypeId: event.target.value ? Number(event.target.value) : null } : row))}>{typeOptions}</select></div>)}
          <p className="text-xs text-muted-foreground">Receiving inherits this treatment automatically. Supplier invoices own their actual billed tax amounts.</p>
          {context.target.kind === "purchase_order" && <p className="text-xs text-muted-foreground">The default applies to the PO header tax and line taxes without an override. A line override applies to that line's own tax amount.</p>}
        </>}
        {context.types.length === 0 && context.target.kind !== "tax_type" && <p role="alert">Add tax types in Settings → Procurement first.</p>}
      </fieldset>}
      {impact && <TaxImpact preview={impact} />}
      {saved && <p role="status" className="rounded border border-green-300 p-3 font-semibold">Tax change approved and saved. Approval record #{saved.auditEventId}.{saved.preview.warnings.length ? " Some cost items still need attention above." : saved.preview.impact.applications.some(row => row.status === "pending_finalization") ? " Ready for receiving and shipment finalization." : costDestinationRows(saved.preview.impact).length === 0 ? " Tax settings are ready for purchasing and receiving." : " Costs from this tax change are posted."}</p>}
      {context.approvals.length > 0 && <details><summary className="cursor-pointer text-sm">Latest saved approvals ({context.approvals.length})</summary><div className="mt-2 space-y-3"><TaxApprovalDetails approvals={context.approvals} /></div></details>}
    </div>
    <div className="shrink-0 border-t pt-3 space-y-3">
      {(error || preview.error || approval.error) && <p role="alert" className="text-sm text-destructive">{error ?? approval.error?.message ?? preview.error?.message}</p>}
      {!saved && !pending && <><div><Label htmlFor="tax-change-reason">Reason / supporting reference</Label><Input id="tax-change-reason" value={reason} maxLength={2000} disabled={locked || !context.canApprove} onChange={event => { setReason(event.target.value); setConfirmed(false); }} /></div>
        {review && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={locked || !context.canApprove} onChange={event => setConfirmed(event.target.checked)} />I reviewed the tax treatment and the cost changes.</label>}</>}
      <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={close} disabled={preview.isPending || approval.isPending}>Close</Button>
        {!saved && !pending && !review && <Button disabled={locked || !context.canApprove} onClick={() => preview.mutate()}>Review changes</Button>}
        {review && !saved && !pending && <><Button variant="outline" disabled={locked} onClick={() => { setReview(null); preview.reset(); setConfirmed(false); }}>Keep editing</Button><Button className="flex-1" disabled={locked || !context.canApprove || !confirmed || reason.trim().length < 10} onClick={approve}>Approve & update costs</Button></>}
        {pending && <Button className="flex-1" disabled={approval.isPending || !context.canApprove} onClick={() => approval.mutate(pending)}>Retry saved approval</Button>}
        {stale && !pending && <Button onClick={reload}>Reload and review again</Button>}
      </div>
    </div>
  </div>;
}

function TaxApprovalDetails({ approvals }: { approvals: z.infer<typeof purchaseTaxApprovalHistorySchema>[] }) {
  return <>{approvals.map(approval => <details key={approval.auditEventId} className="rounded border p-3 text-sm"><summary className="cursor-pointer"><strong>Approval #{approval.auditEventId} · {approval.actorName}</strong> · {new Date(approval.approvedAt).toLocaleString()}</summary>
    <p className="my-3">{approval.reason}</p><p className="my-3 text-xs text-muted-foreground">Saved before and after at approval. Current quantities and costs may have changed since then.</p><TaxImpact preview={approval.preview} /></details>)}</>;
}

export function PurchaseTaxApprovalHistory({ purchaseOrderId }: { purchaseOrderId: number }) {
  const url = `/api/purchase-orders/${purchaseOrderId}/tax-approvals`;
  const history = useQuery({ queryKey: [url], queryFn: async () => z.array(purchaseTaxApprovalHistorySchema).parse(await financialCommandFetchJson(url, { method: "GET" })) });
  return <section className="space-y-3" aria-label="Approved tax changes"><h3 className="font-semibold">Recent approved tax changes</h3><p className="text-xs text-muted-foreground">Showing the latest 20 approvals with their saved reviewer, reason and cost changes.</p>
    {history.isPending && <p>Loading tax approvals…</p>}{history.error && <p role="alert">Tax approvals could not be loaded. <Button variant="link" onClick={() => void history.refetch()}>Retry</Button></p>}
    {history.data && <TaxApprovalDetails approvals={history.data} />}{history.data?.length === 0 && <p className="text-sm text-muted-foreground">No tax changes approved for this PO.</p>}
  </section>;
}

export function PurchaseTaxReview({ target, label = "Review tax treatment" }: { target: PurchaseTaxTarget; label?: string }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [epoch, setEpoch] = useState(0);
  const [requestId, setRequestId] = useState<string | null>(null);
  const { user } = useAuth();
  const url = `/api/purchasing/tax-review/${target.kind}/${target.id ?? "new"}`;
  // Each opening gets a fresh, actor-bound before image. A refetch after save
  // must not remount the editor and erase its confirmed approval receipt.
  const context = useQuery({ queryKey: [url, user?.id, requestId, epoch], enabled: open && requestId !== null && !!user?.id,
    refetchOnWindowFocus: false, refetchOnReconnect: false, queryFn: async () => {
    const result = purchaseTaxContextSchema.parse(await financialCommandFetchJson(url, { method: "GET" }));
    if (canonicalJson(result.target) !== canonicalJson(target)) throw new Error("The tax review does not match this document.");
    return result;
  } });
  const changeOpen = (value: boolean) => { if (busy) return; if (value) setRequestId(crypto.randomUUID()); setOpen(value); if (!value) setEpoch(value => value + 1); };
  return <><Button variant="outline" size="sm" onClick={() => changeOpen(true)}>{label}</Button>
    <Dialog open={open} onOpenChange={changeOpen}><DialogContent className="flex max-h-[92dvh] flex-col overflow-hidden sm:max-w-2xl" onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onInteractOutside={event => { if (busy) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>{target.kind === "tax_type" ? target.id === null ? "Add tax type" : "Change tax type" : "Tax treatment"}</DialogTitle><DialogDescription>Review what belongs in inventory and what is recorded separately, then approve one cost update.</DialogDescription></DialogHeader>
      {context.isPending && <p>Loading the tax settings and linked costs…</p>}
      {context.error && <p role="alert">{context.error.message}</p>}
      {context.data && <TaxEditor key={epoch} loaded={context.data} storageKey={`purchase-tax:${user?.id}:${target.kind}:${target.id ?? "new"}`} setBusy={setBusy} close={() => changeOpen(false)} reload={() => { setEpoch(value => value + 1); }} />}
    </DialogContent></Dialog>
  </>;
}
