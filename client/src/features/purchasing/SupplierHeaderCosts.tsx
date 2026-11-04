import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supplierHeaderContextSchema, supplierHeaderPreviewSchema, supplierHeaderApprovalInputSchema, supplierHeaderResultSchema,
  MAX_SUPPLIER_HEADER_ENTRIES, supplierHeaderEligibleLines, type SupplierHeaderTarget, type SupplierHeaderContext, type SupplierHeaderPreview } from "@shared/procurement/supplier-header-costs";
import { canonicalJson } from "@shared/utils/canonical-json";
import { exactMoneyAsInput } from "@/lib/exact-money-input";
import { supplierHeaderEntryForm, supplierHeaderEntriesFromForm, type SupplierHeaderEntryForm } from "@/lib/supplier-header-cost-form";
import { financialCommandFetchJson, FinancialCommandRequestError, financialCommandNeedsRecovery, shouldRetryFinancialCommand, financialCommandRetryDelay } from "@/lib/financial-command";
import { invalidatePurchaseCosts } from "@/lib/invalidate-purchase-costs";
import { useAuth } from "@/lib/auth";
import { createSupplierHeaderIntentStore, type SupplierHeaderIntent } from "./supplier-header-cost-intent";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

const endpoint = "/api/purchasing/supplier-header-costs";
const selectClass = "w-full rounded border bg-background p-2 text-sm";
const money = (amount: number | bigint | null) => {
  if (amount === null) return "Not verified";
  const exact = BigInt(amount);
  return `${exact < BigInt(0) ? "-$" : "$"}${exactMoneyAsInput(exact < BigInt(0) ? -exact : exact, 4)}`;
};
const destinations = { product: "Goods cost", packaging: "Separate packaging", landed: "Shipment cost", excluded: "Outside inventory", tax: "Tax" };
export function SupplierHeaderChanges({ preview, source }: { preview: SupplierHeaderPreview; source?: SupplierHeaderContext["source"] }) {
  const keys = [...new Set([...preview.before, ...preview.after].map(row => `${row.lineId}:${row.key}`))];
  return <section className="space-y-3 text-sm" aria-label="Header cost changes">
    <div className="overflow-x-auto"><table className="w-full"><thead><tr className="border-b"><th className="py-2 text-left">Amount and destination</th><th className="px-2 text-right">Before</th><th className="text-right">After</th></tr></thead>
      <tbody>{keys.map(key => { const before = preview.before.find(row => `${row.lineId}:${row.key}` === key), after = preview.after.find(row => `${row.lineId}:${row.key}` === key), row = after ?? before!;
        return <tr key={key} className="border-b"><th className="py-2 text-left font-normal">{source?.lines.find(line => line.id === row.lineId)?.name ?? `Line #${row.lineId}`} · {row.label}
          <span className="block text-xs text-muted-foreground">{before ? destinations[before.destination] : "Not assigned"} → {after ? destinations[after.destination] : "Removed"}{after?.taxTreatment === "recoverable" ? " · recoverable tax" : ""}</span></th>
          <td className="px-2 text-right tabular-nums">{money(before?.amountMills ?? 0)}</td><td className="text-right font-semibold tabular-nums">{money(after?.amountMills ?? 0)}</td></tr>; })}</tbody></table></div>
    <details><summary className="cursor-pointer font-medium">Stock and sold-item cost changes</summary><div className="space-y-2 py-2">
      {preview.inventoryValues.map(row => <p key={row.lotId}>{row.lotNumber} · {row.onHandUnits.toLocaleString()} units on hand: {money(row.onHandValueMills.before)} → <strong>{money(row.onHandValueMills.after)}</strong>{row.valueReviewReason && <span className="block text-amber-700">{row.valueReviewReason}</span>}</p>)}
      {preview.impact.orderCosts.map(row => <p key={row.costId}>Order #{row.orderId} cost basis: {money(row.totalMills.before)} → <strong>{money(row.totalMills.after)}</strong></p>)}
      {preview.impact.historicalCosts.map((row, index) => <p key={index}>Previously approved {row.destination === "historical_cogs" ? "cost of goods sold" : "inventory adjustment"}: {money(row.totalMills.before)} → <strong>{money(row.totalMills.after)}</strong></p>)}
    </div></details>
    <p>Original supplier bill, payments, stock quantities and prior approvals stay unchanged. These allocations classify the existing amount.</p>
    {preview.issues.length > 0 && <div role="status" className="rounded border border-amber-300 p-3"><strong>Remaining cost work</strong><ul className="list-disc pl-4">{preview.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul></div>}
  </section>;
}
function Editor({ context, userId, setBusy }: { context: SupplierHeaderContext; userId: string; setBusy: (value: boolean) => void }) {
  const client = useQueryClient(), target = context.source.target;
  const [store] = useState(() => createSupplierHeaderIntentStore(userId, target, () => sessionStorage));
  const [recovery] = useState(() => { try { return { pending: store.read(), error: null }; } catch (error) { return { pending: null, error: error instanceof Error ? error.message : "Approval recovery is unavailable." }; } });
  const [pending, setPending] = useState(recovery.pending), active = useRef(recovery.pending);
  const [rows, setRows] = useState(() => context.proposed.map(supplierHeaderEntryForm));
  const [reason, setReason] = useState(""), [confirmed, setConfirmed] = useState(false), [error, setError] = useState<string | null>(recovery.error);
  const [review, setReview] = useState<SupplierHeaderPreview | null>(null), [saved, setSaved] = useState<SupplierHeaderPreview | null>(null), [stale, setStale] = useState(false);
  const preview = useMutation({ mutationFn: async () => supplierHeaderPreviewSchema.parse(await financialCommandFetchJson(`${endpoint}/preview`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target, sourceVersion: context.sourceVersion, entries: supplierHeaderEntriesFromForm(rows), reason }),
  })), onMutate: () => { setBusy(true); setError(null); }, onSuccess: value => { setReview(value); setConfirmed(false); },
    onError: (failure: Error) => setError(failure.message), onSettled: () => setBusy(false) });
  const approval = useMutation({ mutationFn: async (intent: SupplierHeaderIntent) => {
    const result = supplierHeaderResultSchema.safeParse(await financialCommandFetchJson(`${endpoint}/approve`, { method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": intent.key }, body: JSON.stringify(intent.body.request) }));
    if (!result.success || canonicalJson(result.data.preview) !== canonicalJson(intent.body.preview))
      throw new FinancialCommandRequestError("Approval may have saved. Retry the saved approval to verify its result.", { status: 200, ambiguous: true, retryable: true, code: "SUPPLIER_HEADER_RESULT_UNVERIFIED" });
    return result.data;
  }, retry: shouldRetryFinancialCommand, retryDelay: financialCommandRetryDelay,
    onMutate: () => { setBusy(true); setError(null); }, onSuccess: (result, intent) => {
      setSaved(result.preview); setPending(null); active.current = null;
      try { store.complete(intent.key); } catch (failure) { setError(failure instanceof Error ? failure.message : "Browser recovery remains."); }
    }, onError: (failure: Error) => { setError(failure.message);
      if (!financialCommandNeedsRecovery(failure)) { try { if (active.current) store.complete(active.current.key); active.current = null; setPending(null); setStale(true); }
        catch { setError("Approval was rejected, but browser recovery remains. Reopen to verify the same approval."); } }
    }, onSettled: () => { setBusy(false); void invalidatePurchaseCosts(client); } });
  const locked = preview.isPending || approval.isPending || pending !== null || saved !== null || stale || recovery.error !== null;
  function change(index: number, value: Partial<SupplierHeaderEntryForm>) { setRows(current => current.map((row, i) => i === index ? { ...row, ...value, ...(value.destination && value.destination !== row.destination ? { shares: [] } : {}) } : row)); setReview(null); }
  function approve() { if (!review || active.current || !context.canApprove || !confirmed) return;
    try { const request = supplierHeaderApprovalInputSchema.parse({ target, sourceVersion: context.sourceVersion, entries: supplierHeaderEntriesFromForm(rows), reason, previewVersion: review.previewVersion, approvalConfirmed: true });
      const intent = store.acquire({ request, preview: review }, () => crypto.randomUUID()); active.current = intent; setPending(intent); approval.mutate(intent);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Review the complete amounts before approving."); } }
  const shown = saved ?? pending?.body.preview ?? review;
  return <div className="space-y-4">
    <p className="text-sm">Original amount outside line items: <strong>{money(context.source.expectedMills)}</strong>. Proposed shares are defaults for your review; change them to match the supplier document.</p>
    {(error || context.blockedReason) && <p role="alert" className="rounded border border-amber-300 p-3 text-sm">{error ?? context.blockedReason}</p>}
    {context.currentMatchesSource && <p role="status" className="rounded border border-green-300 p-3 text-sm">These header amounts are already allocated.{context.approvals[0] && <> Approved by {context.approvals[0].actorName} · {new Date(context.approvals[0].approvedAt).toLocaleString()}.</>}</p>}
    {context.current && !context.currentMatchesSource && <p className="text-sm">The document changed since its prior allocation. Review the current proposed amounts below; the original approval remains in history.</p>}
    {context.proposedIssue && <p className="text-sm">{context.proposedIssue}</p>}
    <fieldset disabled={locked || !context.canApprove} className="space-y-3">
      {rows.map((row, index) => <section className="rounded border p-3 space-y-2" key={row.key} aria-label={`Header entry ${index + 1}`}>
        <div className="grid grid-cols-2 gap-2"><label className="text-sm">Description<Input value={row.label} onChange={event => change(index, { label: event.target.value })} /></label>
          <label className="text-sm">Amount (USD)<Input value={row.amount} inputMode="decimal" readOnly={target.kind === "purchase_order"} onChange={event => change(index, { amount: event.target.value })} /></label></div>
        <div className="grid gap-2 sm:grid-cols-3"><label className="text-sm">Type<select className={selectClass} value={row.category} disabled={target.kind === "purchase_order"} onChange={event => { const category = event.target.value as SupplierHeaderEntryForm["category"]; change(index, { category, destination: category === "tax" ? "tax" : "product", taxTypeId: null }); }}>
          <option value="discount">Discount</option><option value="supplier_freight">Supplier freight</option><option value="other">Other charge</option><option value="tax">Tax</option></select></label>
          {row.category === "tax" ? <label className="text-sm">Tax type<select className={selectClass} value={row.taxTypeId ?? ""} onChange={event => change(index, { taxTypeId: event.target.value ? Number(event.target.value) : null })}><option value="">Choose saved tax type</option>{context.source.types.map(type => <option key={type.id} value={type.id}>{type.name} · {type.treatment === "inventory" ? "Inventory cost" : "Recoverable"}</option>)}</select></label>
            : <label className="text-sm">Where it belongs<select className={selectClass} value={row.destination} onChange={event => change(index, { destination: event.target.value as SupplierHeaderEntryForm["destination"] })}>{Object.entries(destinations).filter(([key]) => key !== "tax").map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>}
          <label className="text-sm">Split between lines<select className={selectClass} value={row.method} onChange={event => change(index, { method: event.target.value as "manual" | "by_value", shares: (review?.after ?? context.proposedShares).filter(share => share.key === row.key).map(share => ({ lineId: share.lineId, amount: exactMoneyAsInput(BigInt(share.amountMills) / BigInt(100), 2) })) })}><option value="by_value">By goods / charge value</option><option value="manual">Enter exact shares</option></select></label></div>
        {row.method === "manual" && <div className="space-y-2">{supplierHeaderEligibleLines(context.source, row).map(line => <label key={line.id} className="flex items-center justify-between gap-2 text-sm">{line.name}<Input className="w-28" inputMode="decimal" value={row.shares.find(share => share.lineId === line.id)?.amount ?? "0.00"} onChange={event => change(index, { shares: [...row.shares.filter(share => share.lineId !== line.id), { lineId: line.id, amount: event.target.value }] })} /></label>)}</div>}
        {target.kind === "invoice" && <Button variant="ghost" size="sm" onClick={() => { setRows(current => current.filter((_, i) => i !== index)); setReview(null); }}>Remove entry</Button>}
      </section>)}
      {target.kind === "invoice" && <Button variant="outline" size="sm" disabled={rows.length >= MAX_SUPPLIER_HEADER_ENTRIES} onClick={() => { setRows(current => [...current, { key: `header_${crypto.randomUUID().replaceAll("-", "")}`, label: "Supplier adjustment", amount: "0.00", category: "other", destination: "product", taxTypeId: null, method: "by_value", shares: [] }]); setReview(null); }}>Add header amount</Button>}
      <label className="block text-sm">Reason / supplier reference<Textarea value={reason} onChange={event => { setReason(event.target.value); setReview(null); }} /></label>
    </fieldset>
    {shown && <><h3 className="font-semibold">{saved ? "Approved and saved" : "Before and after"}</h3><SupplierHeaderChanges preview={shown} source={context.source} /></>}
    {!saved && !pending && !stale && <Button onClick={() => preview.mutate()} disabled={locked || !context.canApprove || reason.trim().length < 10}>Review changes</Button>}
    {review && !saved && !pending && !stale && <div className="space-y-3"><label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I checked the original supplier document and these exact changes.</label><Button onClick={approve} disabled={locked || !confirmed || !context.canApprove}>Approve &amp; apply costs</Button></div>}
    {pending && !saved && <Button onClick={() => approval.mutate(pending)} disabled={approval.isPending}>Retry saved approval</Button>}
    {stale && <p role="status">Close and reopen to review the current source. The rejected approval was not applied.</p>}
    {context.approvals.map(row => <details key={row.reviewId} className="border-t pt-3 text-sm"><summary>Approved by {row.actorName} · {new Date(row.approvedAt).toLocaleString()}</summary><p className="py-2">{row.reason}</p><SupplierHeaderChanges preview={row.preview} source={context.source} /></details>)}
  </div>;
}
export function SupplierHeaderCosts({ target }: { target: SupplierHeaderTarget }) {
  const { user } = useAuth(), [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const context = useQuery({ queryKey: [endpoint, target.kind, target.id, user?.id], enabled: open && !!user?.id,
    queryFn: async () => supplierHeaderContextSchema.parse(await financialCommandFetchJson(`${endpoint}?kind=${target.kind}&id=${target.id}`, { method: "GET" })) });
  return <><Button variant="outline" size="sm" onClick={() => setOpen(true)}>Discounts &amp; header charges</Button>
    <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next); }}><DialogContent className="flex max-h-[92dvh] w-[calc(100%-1rem)] max-w-3xl flex-col overflow-hidden">
      <DialogHeader><DialogTitle>Supplier discounts and header charges</DialogTitle><DialogDescription>Allocate the original supplier amounts and review their cost impact before administrator approval.</DialogDescription></DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto py-2">{open && context.data && user?.id ? <Editor key={`${target.kind}:${target.id}:${context.data.sourceVersion}`} context={context.data} userId={user.id} setBusy={setBusy} /> : <p role={context.isError ? "alert" : "status"}>{context.isError ? context.error.message : "Loading saved amounts…"}</p>}</div>
      <div className="border-t pt-3"><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Close review</Button></div>
    </DialogContent></Dialog>
  </>;
}
