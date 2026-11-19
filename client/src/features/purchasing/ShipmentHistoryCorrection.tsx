import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { financialCommandFetchJson, FinancialCommandRequestError } from "@/lib/financial-command";
import { invalidatePurchaseCosts } from "@/lib/invalidate-purchase-costs";
import {
  shipmentHistoryContextSchema, shipmentHistoryInputSchema, shipmentHistoryPreviewSchema, shipmentHistoryPostingSchema,
  type ShipmentHistoryPosting, type ShipmentHistoryPreview, type ShipmentHistoryReview,
} from "@shared/procurement/shipment-history-correction";
import { formatPaymentAmount } from "@/lib/ap-payment-command";

const statusLabels: Record<string, string> = { draft: "Draft", booked: "Booked", in_transit: "In transit", at_port: "At port", customs_clearance: "Customs clearance", delivered: "Delivered", costing: "Cost review", closed: "Closed", cancelled: "Cancelled" };
const label = (status: string) => statusLabels[status] ?? status;
const count = (value: number | null) => value === null ? "Unverified" : value.toLocaleString();

function ChangeSummary({ review }: { review: ShipmentHistoryReview }) {
  const rows = [
    ["Shipment status", label(review.before.status), label(review.after.status)],
    ["Departure date", review.before.departedOn ?? "Not recorded", review.after.departedOn],
    ["Delivery date", review.before.deliveredOn ?? "Not recorded", review.after.deliveredOn ?? "Not confirmed"],
    ["Counted as planned", count(review.plannedPiecesBefore), count(review.plannedPiecesAfter)],
    ["Counted as shipped", count(review.shippedPiecesBefore), count(review.shippedPiecesAfter)],
    ...review.charges.map(charge => [`Shipment charges (${charge.currency})`, formatPaymentAmount(charge.cents), formatPaymentAmount(charge.cents)]),
  ];
  return <div className="space-y-2"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="py-2">What changes</th><th>Before</th><th>After approval</th></tr></thead>
    <tbody>{rows.map(([name, before, after]) => <tr key={name} className="border-b"><th className="py-2 text-left font-normal">{name}</th><td>{before}</td><td className="font-medium">{after}</td></tr>)}</tbody></table>
    <p className="text-sm">The recorded manifest moves from planned to shipped when departure is confirmed. Piece counts, receipts, PO status, invoices, inventory quantities and posted costs stay unchanged.</p>
  </div>;
}

function Approval({ posting }: { posting: ShipmentHistoryPosting }) {
  return <section className="space-y-3 rounded border border-green-600 p-3" aria-label="Approved shipment history correction">
    <p className="font-medium">History correction saved · #{posting.id}</p>
    <p className="text-sm">Approved by {posting.actorName} · {new Date(posting.approvedAt).toLocaleString()}</p>
    <p className="text-sm">{posting.reason}</p>
    <ChangeSummary review={posting.review} />
  </section>;
}

export function ShipmentHistoryCorrection({ shipmentId, buttonLabel = "Review shipment history" }: { shipmentId: number; buttonLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"" | "in_transit" | "delivered">("");
  const [departedOn, setDepartedOn] = useState("");
  const [deliveredOn, setDeliveredOn] = useState("");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<ShipmentHistoryPreview | null>(null);
  const [posting, setPosting] = useState<ShipmentHistoryPosting | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [intent, setIntent] = useState<{ key: string; body: string } | null>(null);
  const queryClient = useQueryClient(), navigation = useProcurementNavigation();
  const root = `/api/inbound-shipments/${shipmentId}/history-correction`;
  const query = useQuery({ queryKey: [root], enabled: open, queryFn: async () => shipmentHistoryContextSchema.parse(
    await financialCommandFetchJson(root, { credentials: "include" })) });
  const context = query.data;
  const input = shipmentHistoryInputSchema.safeParse({ sourceVersion: context?.sourceVersion, status, departedOn,
    deliveredOn: status === "delivered" ? deliveredOn : null, reason, evidenceConfirmed: confirmed });

  async function review() {
    if (!input.success || busy) return;
    setBusy(true); setError(null);
    try { setPreview(shipmentHistoryPreviewSchema.parse(await financialCommandFetchJson(`${root}/preview`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.data),
    }))); } catch (cause) { setError(cause instanceof Error ? cause.message : "The history review could not be loaded."); }
    finally { setBusy(false); }
  }
  async function approve() {
    if (!preview || !input.success || busy) return;
    const command = intent ?? { key: crypto.randomUUID(), body: JSON.stringify({ ...input.data, previewVersion: preview.previewVersion }) };
    setIntent(command); setBusy(true); setError(null);
    try {
      const saved = shipmentHistoryPostingSchema.parse(await financialCommandFetchJson(root, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json", "Idempotency-Key": command.key }, body: command.body,
      }));
      setPosting(saved); setIntent(null); setPreview(null);
      await invalidatePurchaseCosts(queryClient);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The correction was not confirmed. Retry this approval.");
      // An uncertain response may follow a commit. Freeze the reviewed intent
      // and retry its key; never mint a second approval to recover the response.
      if (cause instanceof FinancialCommandRequestError && !cause.ambiguous) {
        setIntent(null); setPreview(null); await query.refetch();
      }
    } finally { setBusy(false); }
  }
  return <>
    <Button variant="outline" onClick={() => setOpen(true)}>{buttonLabel}</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Review shipment history</DialogTitle><DialogDescription>
          Confirm when the recorded shipment left and arrived using the packing list or delivery record. Review the result before administrator approval.
        </DialogDescription></DialogHeader>
        {query.isPending && <p>Loading saved shipment, receipt and cost history…</p>}
        {query.isError && <div role="alert"><p>History could not be verified.</p><Button variant="outline" onClick={() => void query.refetch()}>Retry history</Button></div>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {posting && <Approval posting={posting} />}
        {context && <div className="space-y-4">
          <p className="font-medium">{context.shipmentNumber} · {label(context.current.status)}</p>
          {!posting && context.approvals.map(saved => <Approval key={saved.id} posting={saved} />)}
          <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th>Product / PO</th><th>Manifest pieces</th><th>PO received</th><th>Receipt postings</th></tr></thead><tbody>
            {context.lines.map(line => <tr className="border-b" key={line.id}><td className="py-2">{line.sku}<p className="text-xs text-muted-foreground">{line.poNumber ?? "PO link missing"}</p></td><td>{count(line.pieces)}</td><td>{count(line.receivedPieces)}</td><td>{count(line.postedReceiptPieces)}</td></tr>)}
          </tbody></table></div>
          {context.issues.length > 0 && <section className="space-y-2 rounded border border-amber-500 p-3" aria-label="Unresolved quantity evidence">
            <p className="font-medium">Quantity evidence still needs checking</p>
            {context.issues.map(issue => <p className="text-sm" key={issue}>{issue}</p>)}
            <p className="text-sm">Use the packing list and receiving documents to establish the correct quantities. This approval changes shipment history only.</p>
          </section>}
          <details><summary className="cursor-pointer text-sm">Receipt and status evidence</summary>
            <ul className="space-y-2 py-2 text-sm">{context.receipts.map(receipt => <li key={receipt.lineId}>
              <Link className="underline" href={navigation.childHref(`/receiving?open=${receipt.id}&document=${encodeURIComponent(receipt.number)}`, { currentLabel: context.shipmentNumber })}>{receipt.number}</Link> · line #{receipt.lineId}: {count(receipt.handledUnits)} received units;
              {receipt.piecesPerUnit === null ? " pieces per unit not recorded" : ` ${count(receipt.piecesPerUnit)} pieces per unit`};
              {receipt.shipmentId === shipmentId ? " linked to this shipment" : receipt.shipmentId === null ? " shipment link missing" : ` linked to shipment #${receipt.shipmentId}`}.
            </li>)}</ul>
            <ul className="space-y-1 text-sm">{context.events.map((event, index) => <li key={index}>{new Date(event.recordedAt).toLocaleString()} · {label(event.status)} · {event.notes}</li>)}</ul>
          </details>
          {!posting && !context.blockedReason && context.canApprove && <>
            {preview ? <ChangeSummary review={preview.review} /> : <fieldset className="space-y-3" disabled={busy}>
              <Label htmlFor="history-status">What do the shipping documents confirm?</Label>
              <select id="history-status" className="w-full rounded border bg-background p-2" value={status} onChange={e => setStatus(e.target.value as typeof status)}>
                <option value="" disabled>Choose from the shipping documents</option>
                <option value="delivered">The shipment was delivered</option>
                {["draft", "booked"].includes(context.current.status) && <option value="in_transit">The shipment departed; delivery is not confirmed</option>}
              </select>
              <div className="grid gap-3 sm:grid-cols-2"><div><Label htmlFor="history-departure">Departure date on the document</Label><Input id="history-departure" type="date" value={departedOn} onChange={e => setDepartedOn(e.target.value)} /></div>
                {status === "delivered" && <div><Label htmlFor="history-delivery">Delivery date on the document</Label><Input id="history-delivery" type="date" value={deliveredOn} onChange={e => setDeliveredOn(e.target.value)} /></div>}</div>
              <div><Label htmlFor="history-reason">Document reference and reason</Label><Textarea id="history-reason" value={reason} onChange={e => setReason(e.target.value)} placeholder="Packing list / delivery reference and why the saved history is wrong" /></div>
              <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I checked the manifest piece counts and these dates against the shipping documents.</label>
            </fieldset>}
            <div className="flex flex-wrap justify-end gap-2">
              {preview && !intent && <Button variant="outline" disabled={busy} onClick={() => setPreview(null)}>Edit review</Button>}
              {preview ? <Button disabled={busy} onClick={() => void approve()}>{busy ? "Saving…" : intent ? "Retry same approval" : "Approve history correction"}</Button>
                : <Button disabled={!input.success || busy} onClick={() => void review()}>{busy ? "Loading…" : "Review before and after"}</Button>}
            </div>
          </>}
          {!context.canApprove && <p className="text-sm">An Administrator with purchasing approval permission can correct this history.</p>}
          {context.blockedReason && !posting && context.approvals.length === 0 && <p className="text-sm">{context.blockedReason}</p>}
        </div>}
        <div className="flex justify-end"><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Close review</Button></div>
      </DialogContent>
    </Dialog>
  </>;
}
