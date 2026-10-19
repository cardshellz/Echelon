import React, { useEffect, useState } from "react";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { paymentBalanceSchema, paymentCalendarDateSchema, paymentDateSourceSchema, formatPaymentCalendarDate, paymentApplicationInputSchema } from "@shared/procurement/ap-payment-contract";
import { formatPaymentAmount, paymentAllocationInputs, sumPaymentCents } from "@/lib/ap-payment-command";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { invoiceWorkListQuery } from "./ap-work-list-query";
import { WorkListPagination } from "./WorkListPagination";
import { ApPaymentRecovery } from "./ApPaymentRecovery";
import type { ApPaymentCommands } from "./use-ap-payment-commands";

const id = z.number().int().positive();
const paymentDetailSchema = z.object({
  id, vendorId: id, paymentNumber: z.string(), vendorName: z.string().nullable(), status: z.string(), currency: z.string(), totalAmountCents: z.number().int().nonnegative().safe(),
  paymentCalendarDate: paymentCalendarDateSchema.nullable(), paymentDateSource: paymentDateSourceSchema, paymentBalance: paymentBalanceSchema,
  allocations: z.array(z.object({ id, vendorInvoiceId: id, appliedAmountCents: z.number().int().nonnegative().safe(), invoiceNumber: z.string().nullable(), notes: z.string().nullable().optional() }).passthrough()).max(10_000),
}).passthrough();
export function PaymentBalanceSummary({ value }: { value: unknown }) {
  const parsed = paymentBalanceSchema.safeParse(value);
  if (!parsed.success) return <span className="text-xs text-amber-700">Payment balance unavailable</span>;
  const balance = parsed.data;
  if (balance.state === "review_required") return <span className="text-xs text-amber-700">Review required: {balance.issue?.message}</span>;
  if (balance.state === "voided") return <span className="text-xs text-muted-foreground">Voided · no available balance</span>;
  return <div className="text-xs whitespace-nowrap"><p>Applied {formatPaymentAmount(balance.appliedAmountCents)}</p><p className={balance.state === "available" ? "font-medium text-blue-700" : "text-muted-foreground"}>Unapplied {formatPaymentAmount(balance.unappliedAmountCents)}</p></div>;
}
export function ApPaymentApplications({ paymentId, onClose, commands }: { paymentId: number; onClose: () => void; commands: ApPaymentCommands }) {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [labels, setLabels] = useState<Record<number, string>>({});
  const [reason, setReason] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  useEffect(() => {
    if (commands.confirmed?.operation === "apply_payment" && commands.confirmed.paymentId === paymentId) { setAmounts({}); setLabels({}); setReason(""); setValidationError(null); }
  }, [commands.confirmed, paymentId]);
  useEffect(() => { setAmounts({}); setLabels({}); setReason(""); setValidationError(null); }, [commands.userId]);
  const detail = useQuery({
    queryKey: [`/api/ap-payments/${paymentId}`], staleTime: 0,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/ap-payments/${paymentId}`, { credentials: "include", signal });
      if (!response.ok) throw new Error("The payment and its application history could not be loaded.");
      const payment = paymentDetailSchema.parse(await response.json());
      if (payment.id !== paymentId) throw new Error("The response does not match the selected payment.");
      return payment;
    },
  });
  const payment = detail.data;
  const canApply = payment?.status === "completed" && payment.paymentBalance.state === "available" && commands.canApprove;
  const invoices = useQuery({ ...invoiceWorkListQuery({ status: "approved,partially_paid", vendorId: payment ? String(payment.vendorId) : undefined, search, offset, limit: 20 }), enabled: Boolean(payment && canApply), staleTime: 0 });
  let selectedTotal: number | null = null;
  try { selectedTotal = sumPaymentCents(paymentAllocationInputs(amounts).map(row => row.appliedAmountCents)); } catch { /* Invalid drafts are retained for correction; submit reports the precise error. */ }
  const locked = commands.blocked || detail.isFetching || invoices.isFetching || invoices.isError;
  async function apply() {
    try {
      if (!payment || !canApply || locked) throw new Error("Refresh the payment and eligible invoices before applying funds.");
      const payload = paymentApplicationInputSchema.parse({ expectedVersion: payment.paymentBalance.version, reason, allocations: paymentAllocationInputs(amounts) });
      if (sumPaymentCents(payload.allocations.map(row => row.appliedAmountCents)) > payment.paymentBalance.unappliedAmountCents!) throw new Error("Selected invoice amounts exceed this payment's unapplied balance.");
      setValidationError(null);
      await commands.execute({ operation: "apply_payment", paymentId, vendorId: payment.vendorId, paymentTotalAmountCents: payment.totalAmountCents, reviewedUnappliedAmountCents: payment.paymentBalance.unappliedAmountCents!, payload });
    } catch (error) { setValidationError(error instanceof Error ? error.message : "The application could not be submitted."); }
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
    <DialogHeader><DialogTitle>Payment {payment?.paymentNumber ?? `#${paymentId}`}</DialogTitle><DialogDescription>Review recorded applications and use any unapplied balance. Applying this payment does not record another cash payment.</DialogDescription></DialogHeader>
    <ApPaymentRecovery commands={commands} />
    {detail.isPending ? <p role="status">Loading payment history…</p> : detail.isError || !payment ? <div role="alert"><p>Unable to load the payment and its application history.</p><Button variant="outline" onClick={() => void detail.refetch()}>Retry payment history</Button></div> : <div className="space-y-5">
      <div><p className="font-medium">{payment.vendorName ?? `Supplier #${payment.vendorId}`}</p><p className="text-sm text-muted-foreground">{formatPaymentCalendarDate(payment)} · {payment.status} · {payment.currency}</p></div>
      <div className="grid grid-cols-1 gap-2 rounded border p-3 sm:grid-cols-3"><div><p className="text-xs text-muted-foreground">Recorded payment</p><p>{formatPaymentAmount(payment.totalAmountCents)}</p></div><div><p className="text-xs text-muted-foreground">Applied to invoices</p><p>{formatPaymentAmount(payment.paymentBalance.appliedAmountCents)}</p></div><div><p className="text-xs text-muted-foreground">Available to apply</p><p>{formatPaymentAmount(payment.paymentBalance.unappliedAmountCents)}</p></div></div>
      {payment.paymentBalance.issue && <p role="alert" className="text-sm text-amber-700">{payment.paymentBalance.issue.message} No funds can be applied until the recorded evidence is resolved.</p>}
      <section aria-label="Payment application history" className="space-y-2"><h3 className="font-medium">Application history</h3>
        {payment.status === "voided" && <p className="text-sm text-muted-foreground">This payment is voided. Its retained applications no longer settle the invoices.</p>}
        {payment.allocations.length === 0 ? <p className="text-sm text-muted-foreground">No invoice applications recorded.</p> : <ul className="max-h-48 space-y-2 overflow-y-auto">{payment.allocations.map(row => <li key={row.id} className="rounded border p-2 text-sm"><div className="flex flex-wrap justify-between gap-2"><Link className="underline" href={`/ap-invoices/${row.vendorInvoiceId}`}>{row.invoiceNumber ?? `Invoice #${row.vendorInvoiceId}`}</Link><span>{formatPaymentAmount(row.appliedAmountCents)}</span></div><p className="text-xs text-muted-foreground">Application #{row.id}{row.notes ? ` · ${row.notes}` : ""}</p></li>)}</ul>}
      </section>
      {canApply && <section aria-label="Apply existing payment" className="space-y-3 border-t pt-4"><h3 className="font-medium">Apply existing payment</h3><p className="text-sm text-muted-foreground">Choose current approved invoices for this supplier. A later application to the same invoice is recorded separately.</p>
        <Input aria-label="Search invoices for existing payment" placeholder="Search supplier invoices…" value={search} onChange={event => { setSearch(event.target.value); setOffset(0); }} disabled={commands.blocked} />
        {invoices.isError ? <div role="alert">Unable to load eligible invoices. <Button variant="link" onClick={() => void invoices.refetch()}>Retry eligible invoices</Button></div> : invoices.isPending ? <p role="status">Loading eligible invoices…</p> : invoices.data?.items.length === 0 ? <p>No approved open invoices match this supplier and search.</p> : <div className="max-h-64 divide-y overflow-y-auto rounded border">{invoices.data?.items.map(invoice => <div className="flex flex-wrap items-center gap-2 p-3" key={invoice.id}><div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{invoice.invoiceNumber}</p><p className="text-xs text-muted-foreground">Open balance: {formatPaymentAmount(invoice.balanceCents)} · {invoice.currency}</p></div><Input aria-label={`Apply existing payment to ${invoice.invoiceNumber}`} className="h-9 w-28" inputMode="decimal" placeholder="0.00" value={amounts[invoice.id] ?? ""} disabled={commands.blocked || invoice.balanceCents <= 0 || invoice.currency !== payment.currency || invoice.vendorId !== payment.vendorId} onChange={event => { setAmounts(current => ({ ...current, [invoice.id]: event.target.value })); setLabels(current => ({ ...current, [invoice.id]: invoice.invoiceNumber })); }} /></div>)}</div>}
        {!invoices.isError && <WorkListPagination page={invoices.data} busy={invoices.isFetching || commands.blocked} onOffset={setOffset} label="eligible invoices" />}
        {Object.entries(amounts).some(([,value]) => value.trim() !== "") && <div className="rounded border p-2 text-sm"><p>Selected across all pages</p>{Object.entries(amounts).filter(([,value]) => value.trim() !== "").map(([invoiceId, value]) => <div key={invoiceId} className="flex flex-wrap items-center justify-between gap-2"><span>{labels[Number(invoiceId)] ?? `Invoice #${invoiceId}`}: {value}</span><Button size="sm" variant="ghost" disabled={commands.blocked} onClick={() => setAmounts(current => { const next = { ...current }; delete next[Number(invoiceId)]; return next; })}>Remove {labels[Number(invoiceId)] ?? `invoice #${invoiceId}`}</Button></div>)}</div>}
        <p className="text-sm">Selected: {selectedTotal === null ? "Review amounts" : formatPaymentAmount(selectedTotal)} of {formatPaymentAmount(payment.paymentBalance.unappliedAmountCents)} available</p>
        <div><Label htmlFor="payment-application-reason">Application reason</Label><Textarea id="payment-application-reason" value={reason} onChange={event => setReason(event.target.value)} disabled={commands.blocked} /></div>
        {validationError && <p role="alert" className="text-sm text-destructive">{validationError}</p>}
        <div className="flex flex-wrap gap-2"><Button disabled={locked || !reason.trim() || selectedTotal === null || selectedTotal <= 0 || selectedTotal > payment.paymentBalance.unappliedAmountCents!} onClick={() => void apply()}>Apply existing payment</Button><Button variant="outline" disabled={commands.pending} onClick={() => void detail.refetch()}>Refresh payment balance</Button></div>
      </section>}
      {!commands.canApprove && <p className="text-sm text-muted-foreground">Payment approval permission is required to apply funds.</p>}
    </div>}
    <div className="flex justify-end"><Button variant="outline" onClick={onClose}>Close payment</Button></div>
  </DialogContent></Dialog>;
}
