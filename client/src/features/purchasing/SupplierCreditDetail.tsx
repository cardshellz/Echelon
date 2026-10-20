import { noInventoryEffectLabel } from "./cost-inventory-effect-presentation";
import { supplierCreditCostLabel, supplierCreditCostSummary } from "@/features/purchasing/supplier-credit-presentation";
import { SupplierCreditLink } from "./SupplierCreditLink";
import React, { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { supplierCreditDetailSchema, supplierCreditApplyInputSchema, type SupplierCreditDetail as Credit } from "@shared/procurement/supplier-credit";
import { formatPaymentCalendarDate } from "@shared/procurement/ap-payment-contract";
import { formatPaymentAmount, paymentAllocationInputs, sumPaymentCents } from "@/lib/ap-payment-command";
import { useProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { invoiceWorkListQuery } from "./ap-work-list-query";
import { WorkListPagination } from "./WorkListPagination";
import { SupplierCreditRecovery } from "./SupplierCreditRecovery";
import type { SupplierCreditCommands } from "./use-supplier-credit-commands";

type ReviewAction = { command: "approve" | "void" | "reconcile_costs"; expectedVersion: string } | { command: "reverse"; expectedVersion: string; applicationId: number };
const actionLabel = { approve: "Approve credit", void: "Void credit", reverse: "Reverse credit application", reconcile_costs: "Recheck cost disposition" };
export function SupplierCreditDetail({ creditId, commands }: { creditId: number; commands: SupplierCreditCommands }) {
  const navigation = useProcurementNavigation();
  const [action, setAction] = useState<ReviewAction | null>(null);
  const [actionReason, setActionReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const creditQuery = useQuery({
    queryKey: [`/api/supplier-credits/${creditId}`, commands.userId], staleTime: 0,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/supplier-credits/${creditId}`, { credentials: "include", signal });
      if (!response.ok) throw new Error("Supplier credit could not be loaded.");
      const detail = supplierCreditDetailSchema.parse(await response.json());
      if (detail.id !== creditId) throw new Error("Supplier credit response belongs to a different document.");
      return detail;
    },
  });
  useEffect(() => { setAction(null); setActionReason(""); setError(null); }, [commands.userId, creditId]);
  useEffect(() => {
    if (commands.confirmed?.creditId === creditId) { setAction(null); setActionReason(""); setError(null); }
  }, [commands.confirmed, creditId]);
  const credit = creditQuery.data;
  const blocked = commands.blocked || creditQuery.isFetching || creditQuery.isError;
  const actionCapability = !credit || !action ? null : action.command === "reverse" ? credit.applications.find(row => row.id === action.applicationId)?.canReverse : credit.capabilities[action.command === "reconcile_costs" ? "reconcileCosts" : action.command];
  const staleAction = action !== null && action.expectedVersion !== credit?.version;
  async function submitReview() {
    if (!credit || !action || blocked || !commands.canApprove || !actionCapability?.allowed || staleAction) return;
    try {
      setError(null);
      const payload = { expectedVersion: action.expectedVersion, reason: actionReason };
      if (action.command === "reverse") await commands.execute({ command: "reverse", creditId, applicationId: action.applicationId, payload });
      else await commands.execute({ command: action.command, creditId, payload });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Credit review failed."); }
  }
  function review(next: ReviewAction) { setAction(next); setActionReason(""); setError(null); }
  if (creditQuery.isPending) return <p role="status">Loading supplier credit…</p>;
  if (creditQuery.isError || !credit) return <section role="alert" className="space-y-2">
    <p>Supplier credit and its financial history are unavailable.</p>
    <Button onClick={() => void creditQuery.refetch()}>Retry supplier credit</Button>
  </section>;
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold">Supplier credit {credit.supplierReference}
        </h1>
        <p>{credit.vendorName} · {formatPaymentCalendarDate({ paymentCalendarDate: credit.creditCalendarDate, paymentDateSource: "recorded_calendar_date" })} · {credit.status}
        </p>
        <Link className="text-primary underline" href={navigation.childHref(`/ap-invoices/${credit.sourceInvoiceId}`)}>Original invoice {credit.sourceInvoiceNumber}
        </Link>
      </div>
      <Button variant="outline" disabled={commands.pending} onClick={() => void creditQuery.refetch()}>Refresh credit</Button>
    </div>
    <p className="text-sm text-muted-foreground">This credit does not change the original invoice amount or record a cash refund. Approval, invoice applications and cost posting are shown separately.</p>
    <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 rounded border p-4">
      <div>
        <dt>Credit document</dt>
        <dd className="font-mono font-semibold">{formatPaymentAmount(credit.totalAmountCents)}
        </dd>
      </div>
      <div>
        <dt>Applied to invoices</dt>
        <dd className="font-mono">{formatPaymentAmount(credit.appliedAmountCents)}
        </dd>
      </div>
      <div>
        <dt>Available credit</dt>
        <dd className="font-mono">{formatPaymentAmount(credit.unappliedAmountCents)}
        </dd>
      </div>
    </dl>
    {credit.status === "draft" && <p className="text-sm">Approval is required before this document is available to apply to invoices.</p>}
    <p>Reason: {credit.reason}
    </p>
    {credit.replacesCreditId !== null && <Link className="text-primary underline" href={navigation.childHref(`/supplier-credits/${credit.replacesCreditId}`)}>Replaces credit #{credit.replacesCreditId}
    </Link>}
    {credit.replacedByCreditId !== null && <Link className="text-primary underline" href={navigation.childHref(`/supplier-credits/${credit.replacedByCreditId}`)}>Replacement credit #{credit.replacedByCreditId}
    </Link>}
    {credit.status === "voided" && commands.canCreate && <div>{credit.capabilities.replace.allowed && !commands.blocked ? <SupplierCreditLink sourceInvoiceId={credit.sourceInvoiceId} replacesCreditId={credit.id} create>Replace voided credit</SupplierCreditLink> : <p>{credit.capabilities.replace.reason}
    </p>}
    </div>}
    {credit.balanceIssues.map(issue => <p key={issue.code} role="alert">{issue.message}
    </p>)}
    <section aria-label="Supplier credit cost disposition" className="rounded border p-4 space-y-3">
      <h2 className="font-semibold">Inventory and sold-goods cost disposition: {supplierCreditCostSummary(credit)}
      </h2>
      {(credit.costStatus === "pending" || credit.costStatus === "review_required") && <p className="text-sm">Financial credit approval does not prove inventory or COGS posting. Resolve the recorded cost issues before treating costs as complete.</p>}
      {credit.costIssues.map(issue => <p key={`${issue.code}:${issue.message}`} role="alert" className="text-amber-700">{issue.message}
      </p>)}
      {credit.status === "approved" && commands.canApprove && credit.capabilities.reconcileCosts && <div className="space-y-1">
        <Button variant="outline" disabled={blocked || !credit.capabilities.reconcileCosts.allowed}
          onClick={() => review({ command: "reconcile_costs", expectedVersion: credit.version })}>Recheck cost disposition</Button>
        {!credit.capabilities.reconcileCosts.allowed && <p className="text-sm">{credit.capabilities.reconcileCosts.reason}</p>}
      </div>}
      {credit.lines.map(line => <div key={line.id} className="border-t pt-2 text-sm space-y-1">
        <p className="font-medium">{line.label}: {formatPaymentAmount(line.amountCents)}
        </p>
        <p>{line.disposition.kind === "price_reduction" ? `Price reduction · ${line.disposition.component}` : `Physical return #${line.disposition.returnDispositionId} · ${line.disposition.quantity} source units · ${line.disposition.evidenceReference}`}
        </p>
        <p>Cost result: {line.inventoryEffect ? noInventoryEffectLabel : supplierCreditCostLabel(line.costState)}
        </p>{line.costIssues.map(issue => <p key={`${issue.code}:${issue.message}`} role="alert">{issue.message}
        </p>)}
      </div>)}
    </section>
    {commands.canApprove && <div className="flex flex-wrap gap-3">{credit.status === "draft" && <div>
      <Button disabled={blocked || !credit.capabilities.approve.allowed} onClick={() => review({ command: "approve", expectedVersion: credit.version })}>Approve credit</Button>{!credit.capabilities.approve.allowed && <p className="text-sm">{credit.capabilities.approve.reason}
      </p>}
    </div>}{credit.status !== "voided" && <div>
      <Button variant="outline" disabled={blocked || !credit.capabilities.void.allowed} onClick={() => review({ command: "void", expectedVersion: credit.version })}>Void credit</Button>{!credit.capabilities.void.allowed && <p className="text-sm">{credit.capabilities.void.reason}
      </p>}
    </div>}
    </div>}
    {credit.status === "approved" && <CreditApplication credit={credit} commands={commands} sourceBusy={creditQuery.isFetching} />}
    <section aria-label="Supplier credit application history" className="rounded border p-4 space-y-3">
      <h2 className="font-semibold">Invoice application history</h2>{credit.applications.length === 0 ? <p>No invoice applications recorded.</p> : credit.applications.map(row => <div key={row.id} className="border-t pt-3 space-y-2">
        <div className="flex flex-wrap justify-between gap-2">
          <Link className="underline text-primary" href={navigation.childHref(`/ap-invoices/${row.vendorInvoiceId}`)}>{row.invoiceNumber}
          </Link>
          <span>{formatPaymentAmount(row.appliedAmountCents)} · {row.reversal ? "Reversed" : "Applied"}
          </span>
        </div>
        <p className="text-sm">Application #{row.id} · {row.actorId} · {new Date(row.recordedAt).toLocaleString()} · {row.reason}
        </p>{row.reversal ? <p className="text-sm">Reversal #{row.reversal.id} · {row.reversal.actorId} · {new Date(row.reversal.recordedAt).toLocaleString()} · {row.reversal.reason}
        </p> : commands.canApprove && <>
          <Button variant="outline" size="sm" disabled={blocked || !row.canReverse.allowed} onClick={() => review({ command: "reverse", applicationId: row.id, expectedVersion: credit.version })}>Reverse application #{row.id}
          </Button>{!row.canReverse.allowed && <p className="text-sm">{row.canReverse.reason}
          </p>}
        </>}
      </div>)}
    </section>
    <section aria-label="Supplier credit document history" className="text-sm space-y-1">
      <p>Created by {credit.createdBy} at {new Date(credit.createdAt).toLocaleString()}
      </p>{credit.approvedAt && <p>Approved by {credit.approvedBy} at {new Date(credit.approvedAt).toLocaleString()}
      </p>}{credit.voidedAt && <p>Voided by {credit.voidedBy} at {new Date(credit.voidedAt).toLocaleString()} · {credit.voidReason}
      </p>}
    </section>
    {!commands.canApprove && <p className="text-sm">Purchasing approval permission is required to approve, apply, reverse or void a credit.</p>}
    <Dialog open={action !== null} onOpenChange={open => { if (!open) setAction(null); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{action ? actionLabel[action.command] : "Review credit"}
          </DialogTitle>
          <DialogDescription>{action?.command === "reconcile_costs" ? "Recheck the current invoice and return evidence using this approved credit. This does not change the credit amount, invoice applications, cash or physical stock. The saved result may still require review." : action?.command === "reverse" ? "This restores the applied credit balance and the invoice amount due; the original application remains in history." : action?.command === "void" ? "Reverse all active invoice applications first. Voiding retains this credit document and its cost reversal evidence." : "Approve this recorded supplier document and its explicit cost disposition. Applying it to an invoice is a separate action."}
          </DialogDescription>
        </DialogHeader>
        <SupplierCreditRecovery commands={commands} />{staleAction && <p role="alert">The credit changed after this review opened. Close and reopen the action after refreshing.</p>}<Label htmlFor="credit-action-reason">Reason for this credit action</Label>
        <Textarea id="credit-action-reason" value={actionReason} maxLength={2000} disabled={commands.blocked} onChange={event => setActionReason(event.target.value)} />{error && <p role="alert" className="text-destructive">{error}
        </p>}<div className="flex flex-wrap gap-2">
          <Button disabled={blocked || !commands.canApprove || !actionCapability?.allowed || staleAction || actionReason.trim().length < 3} onClick={() => void submitReview()}>{action ? actionLabel[action.command] : "Confirm"}
          </Button>
          <Button variant="outline" onClick={() => setAction(null)}>Cancel review</Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}

function CreditApplication({ credit, commands, sourceBusy }: { credit: Credit; commands: SupplierCreditCommands; sourceBusy: boolean }) {
  const [search, setSearch] = useState(""); const [offset, setOffset] = useState(0);
  const [amounts, setAmounts] = useState<Record<number, string>>({}); const [labels, setLabels] = useState<Record<number, string>>({});
  const [reason, setReason] = useState(""); const [reviewedVersion, setReviewedVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const invoices = useQuery({ ...invoiceWorkListQuery({ status: "approved,partially_paid", vendorId: String(credit.vendorId), search, offset, limit: 20 }), enabled: credit.capabilities.apply.allowed && commands.canApprove });
  const resetDraft = useCallback(() => { setAmounts({}); setLabels({}); setReason(""); setReviewedVersion(null); setError(null); }, []);
  useEffect(resetDraft, [commands.userId, credit.id, resetDraft]);
  useEffect(() => {
    // Cost-only recovery does not consume an unrelated invoice-application draft.
    if (commands.confirmed?.creditId === credit.id && commands.confirmed.command !== "reconcile_costs") resetDraft();
  }, [commands.confirmed, credit.id, resetDraft]);
  const stale = reviewedVersion !== null && reviewedVersion !== credit.version;
  const disabled = commands.blocked || !commands.canApprove || !credit.capabilities.apply.allowed || sourceBusy || invoices.isFetching || invoices.isError || stale;
  let total: number | null = null; try { total = sumPaymentCents(paymentAllocationInputs(amounts).map(row => row.appliedAmountCents)); } catch { /* Keep invalid draft values for correction. */ }
  async function submit() {
    if (disabled) return;
    try {
      const payload = supplierCreditApplyInputSchema.parse({ expectedVersion: reviewedVersion ?? credit.version, reason, allocations: paymentAllocationInputs(amounts) });
      if (credit.unappliedAmountCents === null || sumPaymentCents(payload.allocations.map(row => row.appliedAmountCents)) > credit.unappliedAmountCents) throw new Error("Applications exceed the available credit.");
      setError(null); await commands.execute({ command: "apply", creditId: credit.id, payload });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Credit application failed."); }
  }
  return <section aria-label="Apply supplier credit" className="rounded border p-4 space-y-3">
    <h2 className="font-semibold">Apply existing supplier credit</h2>
    <p className="text-sm">Apply to current approved invoices from this supplier. Cash paid and original invoice amounts stay separate.</p>{!credit.capabilities.apply.allowed && <p>{credit.capabilities.apply.reason}
    </p>}
    {credit.capabilities.apply.allowed && commands.canApprove && <>
      {stale && <div role="alert">The credit changed after amounts were entered. Review its current balance. <Button variant="outline" disabled={commands.blocked || sourceBusy} onClick={() => setReviewedVersion(credit.version)}>Use reviewed current credit balance</Button>
      </div>}
      <Input aria-label="Search invoices for supplier credit" placeholder="Search supplier invoices" value={search} disabled={commands.blocked} onChange={event => { setSearch(event.target.value); setOffset(0); }} />
      {invoices.isPending ? <p role="status">Loading eligible credit invoices…</p> : invoices.isError ? <div role="alert">Eligible invoices are unavailable. <Button onClick={() => void invoices.refetch()}>Retry credit invoices</Button>
      </div> : <div className="max-h-64 overflow-y-auto divide-y rounded border">{invoices.data?.items.map(invoice => <div key={invoice.id} className="flex flex-wrap items-center gap-2 p-3">
        <div className="min-w-0 flex-1">
          <p>{invoice.invoiceNumber}
          </p>
          <p className="text-xs text-muted-foreground">Remaining payable {formatPaymentAmount(invoice.balanceCents)}
          </p>
        </div>
        <Input className="w-28" aria-label={`Apply credit to ${invoice.invoiceNumber}`} inputMode="decimal" placeholder="0.00" value={amounts[invoice.id] ?? ""} disabled={commands.blocked || invoice.currency !== credit.currency || invoice.vendorId !== credit.vendorId || invoice.balanceCents <= 0} onChange={event => { setReviewedVersion(current => current ?? credit.version); setAmounts(current => ({ ...current, [invoice.id]: event.target.value })); setLabels(current => ({ ...current, [invoice.id]: invoice.invoiceNumber })); }} />
      </div>)}{invoices.data?.items.length === 0 && <p className="p-3">No eligible invoices match this supplier and search.</p>}
      </div>}
      {!invoices.isError && <WorkListPagination page={invoices.data} busy={invoices.isFetching || commands.blocked} onOffset={setOffset} label="credit invoices" />}
      {Object.entries(amounts).filter(([, value]) => value.trim()).map(([id, value]) => <p key={id} className="text-sm">{labels[Number(id)] ?? `Invoice #${id}`}: {value} <Button variant="ghost" size="sm" disabled={commands.blocked} onClick={() => setAmounts(current => { const next = { ...current }; delete next[Number(id)]; return next; })}>Remove {labels[Number(id)] ?? id}
      </Button>
      </p>)}
      <p>Selected {total === null ? "Review amounts" : formatPaymentAmount(total)} of {formatPaymentAmount(credit.unappliedAmountCents)} remaining credit</p>
      <Label htmlFor="credit-application-reason">Credit application reason</Label>
      <Textarea id="credit-application-reason" value={reason} disabled={commands.blocked} onChange={event => setReason(event.target.value)} />{error && <p role="alert" className="text-destructive">{error}
      </p>}<Button disabled={disabled || total === null || total <= 0 || credit.unappliedAmountCents === null || total > credit.unappliedAmountCents || reason.trim().length < 3} onClick={() => void submit()}>Apply supplier credit</Button>
    </>}
  </section>;
}
