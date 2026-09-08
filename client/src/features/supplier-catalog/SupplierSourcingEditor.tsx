import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { supplierSourcingRecordSchema, supplierSourcingUpdateSchema, type SupplierSourcingRecord } from "@shared/procurement/supplier-sourcing";
import { dollarsToMills } from "@shared/utils/money";
import { rfqMoneyAsInput } from "@/lib/rfq-quote-form";
import { apiRequest } from "@/lib/queryClient";
import { financialCommandFetchJson, FinancialCommandRequestError, shouldRetryFinancialCommand, financialCommandRetryDelay } from "@/lib/financial-command";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

function SourcingHistory({ id }: { id: number }) {
  const [before, setBefore] = useState<number | null>(null);
  const query = useQuery({ queryKey: ["supplier-sourcing-history", id, before], queryFn: async () => z.object({ records: z.array(supplierSourcingRecordSchema), nextBeforeRevision: z.number().int().positive().nullable() }).parse(await (await apiRequest("GET", `/api/vendor-products/${id}/sourcing/history${before === null ? "" : `?beforeRevision=${before}`}`)).json()) });
  if (query.isPending) return <p>Loading sourcing history...</p>;
  if (query.error) return <p role="alert">Could not load history. <Button variant="link" onClick={() => query.refetch()}>Retry</Button></p>;
  return <div className="space-y-2 text-xs">{query.data?.records.map((record) => <div key={record.revision} className="rounded border p-2"><p className="font-medium">Revision {record.revision} - {record.reason}</p><p>{record.recordedBy} - {record.recordedAt && new Date(record.recordedAt).toLocaleString()}</p><p>Priority {record.policy.priority} - {record.policy.eligibleForProposals ? "Eligible" : "Paused"}</p>{record.policy.priceList && <><p>{record.policy.priceList.quoteReference} - {record.policy.priceList.currency} - {record.policy.priceList.validFrom} through {record.policy.priceList.validUntil}</p>{record.policy.priceList.tiers.map((tier) => <p key={tier.minimumQuantity}>{tier.minimumQuantity.toLocaleString()}+ {record.policy.priceList!.purchaseUom ?? "pieces"}: {rfqMoneyAsInput(tier.unitCostMills, 4)} per unit</p>)}</>}</div>)}{query.data?.records.length === 0 && <p>No sourcing revisions yet.</p>}<div className="flex gap-2">{before !== null && <Button size="sm" variant="outline" onClick={() => setBefore(null)}>Latest</Button>}{query.data?.nextBeforeRevision && <Button size="sm" variant="outline" onClick={() => setBefore(query.data!.nextBeforeRevision)}>Older revisions</Button>}</div></div>;
}
function SourcingForm({ record, defaultCurrency, onSaved }: { record: SupplierSourcingRecord; defaultCurrency: string; onSaved: () => void }) {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("purchasing", "edit");
  const [priority, setPriority] = useState(String(record.policy.priority));
  const [eligible, setEligible] = useState(record.policy.eligibleForProposals);
  const list = record.policy.priceList;
  const [hasPrices, setHasPrices] = useState(list !== null);
  const [currency, setCurrency] = useState(list?.currency ?? defaultCurrency);
  const [basis, setBasis] = useState<"per_piece" | "per_purchase_uom">(list?.basis ?? "per_piece");
  const [unit, setUnit] = useState(list?.purchaseUom ?? "case");
  const [pieces, setPieces] = useState(String(list?.piecesPerPurchaseUom ?? 1));
  const [reference, setReference] = useState(list?.quoteReference ?? "");
  const [quoteDate, setQuoteDate] = useState(list?.quotedAt.slice(0,10) ?? "");
  const [validFrom, setValidFrom] = useState(list?.validFrom ?? "");
  const [validUntil, setValidUntil] = useState(list?.validUntil ?? "");
  const [tiers, setTiers] = useState(() => list?.tiers.map((tier) => ({ minimum: String(tier.minimumQuantity), price: rfqMoneyAsInput(tier.unitCostMills,4) })) ?? [{ minimum: "1", price: "" }]);
  const [reason, setReason] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);
  const intent = useRef<{ json: string; body: unknown } | null>(null);
  const mutation = useMutation({
    mutationFn: async (body: unknown) => {
      const raw = await financialCommandFetchJson<unknown>(`/api/vendor-products/${record.vendorProductId}/sourcing`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = supplierSourcingRecordSchema.safeParse(raw);
      if (!result.success) throw new FinancialCommandRequestError("The save may have completed. Retry the same request to retrieve its saved revision.", { status: 200, retryable: true, ambiguous: true });
      return result.data;
    }, retry: shouldRetryFinancialCommand, retryDelay: financialCommandRetryDelay,
    onSuccess: () => { setAmbiguous(false); onSaved(); },
    onError: (error: Error) => { setAmbiguous(error instanceof FinancialCommandRequestError && error.ambiguous); },
  });
  const locked = !canEdit || mutation.isPending || ambiguous;
  const prefix = `sourcing-${record.vendorProductId}`;
  const integer = (value: string) => /^\d+$/.test(value) ? Number(value) : Number.NaN;
  function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      const body = { expectedRevision: record.revision, reason, policy: { version: 1, priority: integer(priority), eligibleForProposals: eligible,
        priceList: hasPrices ? { currency: currency.trim().toUpperCase(), basis, purchaseUom: basis === "per_purchase_uom" ? unit : null,
          piecesPerPurchaseUom: basis === "per_purchase_uom" ? integer(pieces) : null, quoteReference: reference,
          quotedAt: `${quoteDate}T00:00:00.000Z`, validFrom, validUntil,
          tiers: tiers.map((tier) => ({ minimumQuantity: integer(tier.minimum), unitCostMills: tier.price.trim() ? dollarsToMills(tier.price) : Number.NaN })) } : null } };
      const json = JSON.stringify(body);
      if (!intent.current || intent.current.json !== json) intent.current = { json, body: supplierSourcingUpdateSchema.parse({ ...body, idempotencyKey: crypto.randomUUID() }) };
      setValidation(null); mutation.mutate(intent.current.body);
    } catch (error) { setValidation(error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") : error instanceof Error ? error.message : "Review the sourcing fields"); }
  }
  return <form onSubmit={submit} className="space-y-4">
    <p className="text-xs text-muted-foreground">Revision {record.revision}. Preferred suppliers rank first, then lower priority numbers, matching receive configuration, lead time and supplier identity. Prices are not compared between suppliers.</p>
    <fieldset disabled={locked} className="space-y-3">
      <div className="flex flex-wrap gap-4"><div><Label htmlFor={`${prefix}-priority`}>Sourcing priority</Label><Input id={`${prefix}-priority`} inputMode="numeric" value={priority} onChange={(event) => setPriority(event.target.value)} /></div><label className="flex items-center gap-2 text-sm"><Checkbox checked={eligible} onCheckedChange={(checked) => setEligible(checked === true)} disabled={locked} />Eligible for purchase proposals</label></div>
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={hasPrices} onCheckedChange={(checked) => setHasPrices(checked === true)} disabled={locked} />Use a quoted quantity price list</label>
      {hasPrices && <div className="space-y-3 rounded border p-3">
        <p className="text-xs text-muted-foreground">Threshold quantities use the quoted unit below. The engine prices the required quantity; it never adds stock solely to reach a cheaper tier. Product prices exclude freight and separate packaging.</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><Label htmlFor={`${prefix}-currency`}>Quote currency</Label><Input id={`${prefix}-currency`} value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value)} /></div>
          <div><Label htmlFor={`${prefix}-basis`}>Price and threshold unit</Label><select id={`${prefix}-basis`} className="h-10 w-full rounded border bg-background px-2" value={basis} onChange={(event) => setBasis(event.target.value as typeof basis)}><option value="per_piece">Base pieces</option><option value="per_purchase_uom">Purchase unit (case, pallet, etc.)</option></select></div>
          {basis === "per_purchase_uom" && <><div><Label htmlFor={`${prefix}-uom`}>Purchase unit name</Label><Input id={`${prefix}-uom`} value={unit} onChange={(event) => setUnit(event.target.value)} /></div><div><Label htmlFor={`${prefix}-pieces`}>Pieces per purchase unit</Label><Input id={`${prefix}-pieces`} inputMode="numeric" value={pieces} onChange={(event) => setPieces(event.target.value)} /></div></>}
          <div><Label htmlFor={`${prefix}-reference`}>Quote reference</Label><Input id={`${prefix}-reference`} value={reference} onChange={(event) => setReference(event.target.value)} /></div>
          <div><Label htmlFor={`${prefix}-quote-date`}>Quote date</Label><Input id={`${prefix}-quote-date`} type="date" value={quoteDate} onChange={(event) => setQuoteDate(event.target.value)} /></div>
          <div><Label htmlFor={`${prefix}-valid-from`}>Valid from</Label><Input id={`${prefix}-valid-from`} type="date" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} /></div>
          <div><Label htmlFor={`${prefix}-valid-until`}>Valid through</Label><Input id={`${prefix}-valid-until`} type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} /></div>
        </div>
        {tiers.map((tier,index) => <div key={index} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2"><div><Label htmlFor={`${prefix}-threshold-${index}`}>From quantity {index + 1}</Label><Input id={`${prefix}-threshold-${index}`} inputMode="numeric" value={tier.minimum} onChange={(event) => setTiers((current) => current.map((entry,i) => i === index ? { ...entry, minimum: event.target.value } : entry))} /></div><div><Label htmlFor={`${prefix}-price-${index}`}>Price per unit ({currency})</Label><Input id={`${prefix}-price-${index}`} inputMode="decimal" value={tier.price} onChange={(event) => setTiers((current) => current.map((entry,i) => i === index ? { ...entry, price: event.target.value } : entry))} /></div><Button type="button" variant="outline" aria-label={`Remove price tier ${index + 1}`} disabled={tiers.length <= 1} onClick={() => setTiers((current) => current.filter((_,i) => i !== index))}>Remove</Button></div>)}
        <Button type="button" variant="outline" size="sm" disabled={tiers.length >= 50} onClick={() => setTiers((current) => [...current,{ minimum: "", price: "" }])}>Add price tier</Button>
      </div>}
      <div><Label htmlFor={`${prefix}-reason`}>Reason for change</Label><Textarea id={`${prefix}-reason`} value={reason} onChange={(event) => setReason(event.target.value)} /></div>
    </fieldset>
    {(validation || mutation.error) && <p role="alert" className="text-sm text-destructive">{validation ?? mutation.error?.message}</p>}
    {canEdit && <div className="flex flex-wrap gap-2"><Button type="submit" disabled={locked}>{mutation.isPending ? "Saving..." : "Save sourcing revision"}</Button>{ambiguous && <Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => intent.current && mutation.mutate(intent.current.body)}>Retry saved request</Button>}{mutation.error && !ambiguous && <Button type="button" variant="outline" onClick={onSaved}>Reload current revision</Button>}</div>}
  </form>;
}
export function SupplierSourcingEditor({ vendorProductId, label, currency = "USD" }: { vendorProductId: number; label: string; currency?: string }) {
  const [open,setOpen] = useState(false);
  const [history,setHistory] = useState(false);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["supplier-sourcing", vendorProductId], enabled: open, queryFn: async () => supplierSourcingRecordSchema.parse(await (await apiRequest("GET", `/api/vendor-products/${vendorProductId}/sourcing`)).json()) });
  const refresh = () => { queryClient.invalidateQueries({ queryKey: ["supplier-sourcing",vendorProductId] }); queryClient.invalidateQueries({ queryKey: ["supplier-sourcing-history",vendorProductId] }); queryClient.invalidateQueries({ predicate: (entry) => typeof entry.queryKey[0] === "string" && (entry.queryKey[0].includes("reorder") || entry.queryKey[0].includes("recommendation")) }); };
  return <><Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} aria-label={`Sourcing settings for ${label}`}>Sourcing</Button><Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Sourcing - {label}</DialogTitle><DialogDescription>Supplier priority and reusable quantity pricing. Every saved revision is retained.</DialogDescription></DialogHeader>{query.isPending ? <p>Loading sourcing settings...</p> : query.error || !query.data ? <p role="alert">Could not load sourcing settings. <Button variant="link" onClick={() => query.refetch()}>Retry</Button></p> : <SourcingForm key={query.data.revision} record={query.data} defaultCurrency={currency} onSaved={refresh} />}<Button type="button" variant="link" onClick={() => setHistory(!history)}>{history ? "Hide sourcing history" : "View sourcing history"}</Button>{history && <SourcingHistory id={vendorProductId} />}</DialogContent></Dialog></>;
}
