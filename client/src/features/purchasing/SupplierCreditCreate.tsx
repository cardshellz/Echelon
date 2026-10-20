import React, { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supplierCreditCreateInputSchema, supplierCreditOptionsSchema, supplierCreditDetailSchema, type SupplierCreditOptions } from "@shared/procurement/supplier-credit";
import { format } from "date-fns";
import { invoiceWorkListQuery } from "./ap-work-list-query";
import { WorkListPagination } from "./WorkListPagination";
import { formatPaymentAmount, parsePaymentAmount, sumPaymentCents } from "@/lib/ap-payment-command";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { SupplierCreditCommands } from "./use-supplier-credit-commands";

type LineDraft = { amount: string; disposition: string; quantity: string; reference: string };
const emptyLine = (): LineDraft => ({ amount: "", disposition: "", quantity: "", reference: "" });
type CreditSourceLine = SupplierCreditOptions["lines"][number];
function acceptedReturnChoices(line: CreditSourceLine) {
  return (line.acceptedReturns ?? []).flatMap(source => source.components.flatMap(component => [
    ...(source.quantityAvailable > 0 ? [{ key: `accepted:${source.supplierReturnLineId}:new:${component}`, source, component, entitlement: null }] : []),
    ...source.entitlements.map(entitlement => ({ key: `accepted:${source.supplierReturnLineId}:${entitlement.id}:${component}`, source, component, entitlement })),
  ]));
}
const selectClass = "w-full rounded border bg-background p-2 text-sm";
export function SupplierCreditCreate({ commands, initialInvoiceId, returnDispositionId, supplierReturnLineId = null, replacesCreditId, onCancel }: {
  commands: SupplierCreditCommands; initialInvoiceId: number | null; returnDispositionId: number | null; supplierReturnLineId?: number | null; replacesCreditId: number | null; onCancel: () => void;
}) {
  const [invoiceId, setInvoiceId] = useState(initialInvoiceId);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [reviewed, setReviewed] = useState<SupplierCreditOptions | null>(null);
  const [drafts, setDrafts] = useState<Record<string, LineDraft>>({});
  const [reference, setReference] = useState("");
  const [calendarDate, setCalendarDate] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const invoices = useQuery({ ...invoiceWorkListQuery({ status: "approved,partially_paid,paid", search, offset, limit: 20 }), enabled: invoiceId === null });
  const options = useQuery({
    queryKey: [`/api/vendor-invoices/${invoiceId}/supplier-credit-options`, commands.userId], enabled: invoiceId !== null, staleTime: 0,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/vendor-invoices/${invoiceId}/supplier-credit-options`, { credentials: "include", signal });
      if (!response.ok) throw new Error("Current credit source choices could not be loaded.");
      const data = supplierCreditOptionsSchema.parse(await response.json());
      if (data.sourceInvoiceId !== invoiceId) throw new Error("Credit source choices belong to another invoice.");
      return data;
    },
  });
  useEffect(() => { if (!reviewed && options.data) setReviewed(options.data); }, [options.data, reviewed]);
  useEffect(() => { setReference(""); setReason(""); setDrafts({}); setReviewed(null); setError(null); }, [commands.userId]);
  const replacement = useQuery({
    queryKey: [`/api/supplier-credits/${replacesCreditId}`, commands.userId], enabled: replacesCreditId !== null,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/supplier-credits/${replacesCreditId}`, { credentials: "include", signal });
      if (!response.ok) throw new Error("The original voided credit could not be verified.");
      const data = supplierCreditDetailSchema.parse(await response.json());
      if (data.id !== replacesCreditId) throw new Error("Replacement source belongs to another credit.");
      return data;
    }
  });
  const replacementBlocked = replacesCreditId !== null && (replacement.isFetching || replacement.isError || !replacement.data?.capabilities.replace.allowed);
  useEffect(() => { if (replacement.data) setReference(replacement.data.supplierReference); }, [replacement.data, commands.userId]);
  const sourceChanged = reviewed !== null && options.data?.sourceVersion !== reviewed.sourceVersion;
  const disabled = replacementBlocked || commands.blocked || !commands.canCreate || options.isFetching || options.isError || sourceChanged || !reviewed?.canCreate.allowed;
  const update = (id: string, values: Partial<LineDraft>) => setDrafts(current => ({ ...current, [id]: { ...(current[id] ?? emptyLine()), ...values } }));
  async function reloadSource() {
    const result = await options.refetch();
    if (result.data && !result.error) { setReviewed(result.data); setError(null); }
  }
  async function submit() {
    if (disabled || !reviewed) return;
    try {
      const lines = Object.entries(drafts).filter(([, draft]) => draft.amount.trim()).map(([key, draft]) => {
        const line = reviewed.lines.find(item => item.invoiceLineId === Number(key.split(":")[0]));
        if (!line) throw new Error("A selected source line is no longer available. Reload the credit source.");
        const amountCents = parsePaymentAmount(draft.amount);
        if (amountCents <= 0 || amountCents > line.availableAmountCents) throw new Error(`${line.label}: enter a positive amount within its available credit value.`);
        const accepted = acceptedReturnChoices(line).find(item => item.key === draft.disposition);
        if (accepted) {
          const quantity = accepted.entitlement?.quantity ?? Number(draft.quantity);
          if (!/^[1-9]\d*$/.test(draft.quantity) || !Number.isSafeInteger(quantity) || quantity !== Number(draft.quantity)
            || (!accepted.entitlement && quantity > accepted.source.quantityAvailable)) throw new Error(`${line.label}: enter a whole quantity within the verified accepted-stock return.`);
          return { invoiceLineId: line.invoiceLineId, amountCents, disposition: { kind: "accepted_stock_return" as const,
            supplierReturnLineId: accepted.source.supplierReturnLineId, quantity, evidenceReference: draft.reference.trim(), component: accepted.component,
            ...(accepted.entitlement ? { entitlementId: accepted.entitlement.id } : {}) } };
        }
        const returned = line.returnDispositions.find(item => `return:${item.returnDispositionId}` === draft.disposition);
        if (returned) {
          if (!/^[1-9]\d*$/.test(draft.quantity) || !Number.isSafeInteger(Number(draft.quantity)) || Number(draft.quantity) > returned.quantityAvailable) throw new Error(`${line.label}: enter a valid returned quantity within the available physical return.`);
          return { invoiceLineId: line.invoiceLineId, amountCents, disposition: { kind: "quarantine_return" as const, returnDispositionId: returned.returnDispositionId, quantity: Number(draft.quantity), evidenceReference: draft.reference.trim() } };
        }
        const component = line.components.find(value => `price:${value}` === draft.disposition);
        if (!component) throw new Error(`${line.label}: choose a supported credit reason and cost component.`);
        return { invoiceLineId: line.invoiceLineId, amountCents, disposition: { kind: "price_reduction" as const, component } };
      });
      if (supplierReturnLineId !== null && !lines.some(line => line.disposition.kind === "accepted_stock_return" && line.disposition.supplierReturnLineId === supplierReturnLineId)) throw new Error("Select the verified accepted-stock return that opened this credit workflow.");
      const newReturnQuantities = new Map<number, number>();
      for (const line of lines) if (line.disposition.kind === "accepted_stock_return" && line.disposition.entitlementId === undefined) {
        const prior = newReturnQuantities.get(line.disposition.supplierReturnLineId);
        if (prior !== undefined && prior !== line.disposition.quantity) throw new Error("Cost components for the same new accepted-stock return must use the same physical quantity on this document.");
        newReturnQuantities.set(line.disposition.supplierReturnLineId, line.disposition.quantity);
      }
      for (const line of reviewed.lines) {
        if (sumPaymentCents(lines.filter(item => item.invoiceLineId === line.invoiceLineId).map(item => item.amountCents)) > line.availableAmountCents) throw new Error(`${line.label}: combined credit treatments exceed the available source amount.`);
      }
      const payload = supplierCreditCreateInputSchema.parse({
        sourceInvoiceId: reviewed.sourceInvoiceId, expectedSourceVersion: reviewed.sourceVersion,
        ...(replacesCreditId !== null ? { replacesCreditId } : {}), supplierReference: reference, creditCalendarDate: calendarDate, reason, lines
      });
      setError(null); await commands.execute({ command: "create", payload });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Review the credit fields."); }
  }
  let total: number | null = null;
  try { total = sumPaymentCents(Object.values(drafts).filter(line => line.amount.trim()).map(line => parsePaymentAmount(line.amount))); } catch { /* Invalid drafts stay visible for correction. */ }
  return <section aria-label="Create supplier credit" className="rounded border p-4 space-y-4">
    <div>
      <h2 className="text-lg font-semibold">Record supplier credit document</h2>
      <p className="text-sm text-muted-foreground">Choose its original approved invoice and the exact source lines. The draft does not reduce an invoice balance or record a cash refund.</p>
    </div>
    {replacesCreditId !== null && <div className="rounded border p-3 text-sm">
      <p>Replacing voided supplier credit #{replacesCreditId}. The original document stays in history and its supplier reference is retained.</p>{replacementBlocked && <p role="alert">{replacement.data?.capabilities.replace.reason ?? "The original credit must be verified before its replacement can be saved."}
      </p>}<Button variant="outline" onClick={() => void replacement.refetch()}>Reload replacement source</Button>
    </div>}
    {returnDispositionId !== null && <p className="rounded border p-2 text-sm">Physical return #{returnDispositionId}: choose the supplier invoice that owns those goods. Only verified return choices can be used below.</p>}
    {supplierReturnLineId !== null && <p className="rounded border p-2 text-sm">Accepted-stock return line #{supplierReturnLineId}: select a verified original invoice and the explicit returned-stock treatment. This credit will not remove inventory again or reprice retained goods.</p>}
    {!commands.canCreate && <p role="alert">Purchasing edit permission is required to record a credit draft.</p>}
    {invoiceId === null ? <div className="space-y-3">
      <Input aria-label="Search original supplier invoice" placeholder="Search invoice number or supplier" value={search} onChange={event => { setSearch(event.target.value); setOffset(0); }} disabled={commands.blocked} />
      {invoices.isPending ? <p role="status">Loading supplier invoices…</p> : invoices.isError ? <div role="alert">Supplier invoices are unavailable. <Button onClick={() => void invoices.refetch()}>Retry supplier invoices</Button>
      </div> : <>
        <div className="max-h-64 overflow-y-auto space-y-2">{invoices.data?.items.map(invoice => <Button key={invoice.id} variant="outline" className="w-full justify-start h-auto whitespace-normal text-left" disabled={commands.blocked} onClick={() => { setInvoiceId(invoice.id); setReviewed(null); setDrafts({}); }}>
          <span>{invoice.invoiceNumber} · {invoice.vendorName} · Original invoice {formatPaymentAmount(invoice.invoicedAmountCents)}
          </span>
        </Button>)}{invoices.data?.items.length === 0 && <p>No approved invoices match this search.</p>}
        </div>
        <WorkListPagination page={invoices.data} busy={invoices.isFetching || commands.blocked} onOffset={setOffset} label="source invoices" />
      </>}
    </div> : <>
      <Button variant="ghost" disabled={commands.blocked} onClick={() => { setInvoiceId(null); setReviewed(null); setDrafts({}); }}>Choose another source invoice</Button>
      {options.isPending ? <p role="status">Loading credit source choices…</p> : options.isError || !reviewed ? <div role="alert">Credit source choices are unavailable. <Button onClick={() => void reloadSource()}>Retry credit source</Button>
      </div> : <>
        <p className="font-medium">{reviewed.invoiceNumber} · {reviewed.vendorName} · {reviewed.currency}
        </p>
        {(!reviewed.canCreate.allowed || sourceChanged) && <p role="alert">{sourceChanged ? "The source changed after review. Reload the source choices and review the amounts before creating the credit." : reviewed.canCreate.reason}
        </p>}
        <Button variant="outline" disabled={commands.blocked || options.isFetching} onClick={() => void reloadSource()}>Reload credit source</Button>
        <fieldset disabled={disabled} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="credit-reference">Supplier credit reference</Label>
              <Input id="credit-reference" disabled={replacesCreditId !== null} value={reference} maxLength={100} onChange={event => setReference(event.target.value)} />
            </div>
            <div>
              <Label htmlFor="credit-calendar-date">Credit document date</Label>
              <Input id="credit-calendar-date" type="date" value={calendarDate} onChange={event => setCalendarDate(event.target.value)} />
            </div>
          </div>
          {reviewed.lines.flatMap(line => [String(line.invoiceLineId), ...Object.keys(drafts).filter(key => key.startsWith(`${line.invoiceLineId}:`))].map(key => {
            const draft = drafts[key] ?? emptyLine();
            const returned = line.returnDispositions.find(item => `return:${item.returnDispositionId}` === draft.disposition);
            const acceptedChoices = acceptedReturnChoices(line);
            const accepted = acceptedChoices.find(item => item.key === draft.disposition);
            return <div key={key} className="rounded border p-3 space-y-2">
              <p className="font-medium">{line.label}
              </p>
              <p className="text-sm text-muted-foreground">Original {formatPaymentAmount(line.lineAmountCents)} · Already credited {formatPaymentAmount(line.creditedAmountCents)} · Available {formatPaymentAmount(line.availableAmountCents)}
              </p>
              {line.issues.map(issue => <p key={issue.code} role="alert" className="text-sm text-amber-700">{issue.message}
              </p>)}
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <Label htmlFor={`credit-amount-${key}`}>Credit amount for {line.label}
                  </Label>
                  <Input id={`credit-amount-${key}`} inputMode="decimal" value={draft.amount} onChange={event => update(key, { amount: event.target.value })} disabled={line.availableAmountCents <= 0} placeholder="0.00" />
                </div>
                <div>
                  <Label htmlFor={`credit-disposition-${key}`}>Credit reason and cost treatment</Label>
                  <select id={`credit-disposition-${key}`} className={selectClass} value={draft.disposition} onChange={event => { const option = line.returnDispositions.find(item => `return:${item.returnDispositionId}` === event.target.value); const accepted = acceptedChoices.find(item => item.key === event.target.value); update(key, { disposition: event.target.value, quantity: accepted?.entitlement ? String(accepted.entitlement.quantity) : "", reference: accepted?.source.evidenceReference ?? option?.evidenceReference ?? "" }); }}>
                    <option value="">Choose verified source treatment</option>{line.components.map(component => <option key={component} value={`price:${component}`}>Price reduction · {component}
                    </option>)}{line.returnDispositions.map(item => <option key={item.returnDispositionId} value={`return:${item.returnDispositionId}`}>Physical return #{item.returnDispositionId} · {item.label}
                    </option>)}{acceptedChoices.map(item => <option key={item.key} value={item.key}>Accepted-stock return #{item.source.supplierReturnId} / line #{item.source.supplierReturnLineId} · {item.component === "unassigned" ? "Component requires review" : item.component} · {item.entitlement ? `Existing matched quantity #${item.entitlement.id}` : "New returned quantity"}</option>)}
                  </select>
                </div>
              </div>
              {accepted && <div className="space-y-2 text-sm">
                <p>{accepted.entitlement ? "This additional credit uses an existing matched physical quantity; the stock return is not repeated." : "Match part or all of the recorded physical return. Components on this document share the same selected returned quantity. This does not change retained inventory or record cash."}</p>
                <div className="grid gap-2 sm:grid-cols-2"><div><Label htmlFor={`credit-accepted-qty-${key}`}>Accepted-stock returned quantity ({accepted.source.unitsPerVariant} pieces per recorded unit; available {accepted.entitlement?.quantity ?? accepted.source.quantityAvailable})</Label><Input id={`credit-accepted-qty-${key}`} inputMode="numeric" value={draft.quantity} disabled={accepted.entitlement !== null} onChange={event => update(key, { quantity: event.target.value })} /></div>
                <div><Label htmlFor={`credit-accepted-ref-${key}`}>Accepted-stock collection evidence</Label><Input id={`credit-accepted-ref-${key}`} value={draft.reference} maxLength={1000} onChange={event => update(key, { reference: event.target.value })} /></div></div>
                {accepted.component === "unassigned" && <p className="text-amber-800 dark:text-amber-200">The supplier document does not identify a cost component. Its value disposition remains in review.</p>}
              </div>}
              {returned && <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <Label htmlFor={`credit-return-qty-${key}`}>Returned quantity ({returned.unitLabel}; available {returned.quantityAvailable})</Label>
                  <Input id={`credit-return-qty-${key}`} inputMode="numeric" value={draft.quantity} onChange={event => update(key, { quantity: event.target.value })} />
                </div>
                <div>
                  <Label htmlFor={`credit-return-ref-${key}`}>Physical return evidence reference</Label>
                  <Input id={`credit-return-ref-${key}`} value={draft.reference} onChange={event => update(key, { reference: event.target.value })} maxLength={200} />
                </div>
              </div>}
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setDrafts(current => {
                  let serial = 1; while (current[`${line.invoiceLineId}:${serial}`]) serial++;
                  return { ...current, [`${line.invoiceLineId}:${serial}`]: emptyLine() };
                })}>Add another treatment for {line.label}
                </Button>{key.includes(":") && <Button type="button" variant="ghost" size="sm" onClick={() => setDrafts(current => { const next = { ...current }; delete next[key]; return next; })}>Remove this treatment</Button>}
              </div>
            </div>;
          }))}
          <div>
            <Label htmlFor="credit-reason">Credit reason / document evidence</Label>
            <Textarea id="credit-reason" value={reason} maxLength={2000} onChange={event => setReason(event.target.value)} />
          </div>
        </fieldset>
      </>}
    </>}
    {error && <p role="alert" className="text-destructive text-sm">{error}
    </p>}
    <p className="font-medium">Credit document total: {total === null ? "Review amounts" : formatPaymentAmount(total)}
    </p>
    <div className="flex flex-wrap gap-2">
      <Button disabled={disabled || total === null || total <= 0 || !reference.trim() || reason.trim().length < 3} onClick={() => void submit()}>{commands.pending ? "Saving credit…" : "Create credit draft"}
      </Button>
      <Button variant="outline" onClick={onCancel}>Cancel draft</Button>
    </div>
  </section>;
}
