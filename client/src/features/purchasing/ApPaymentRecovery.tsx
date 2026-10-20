import React from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { formatPaymentAmount } from "@/lib/ap-payment-command";
import type { ApPaymentCommands } from "./use-ap-payment-commands";

export function ApPaymentRecovery({ commands }: { commands: ApPaymentCommands }) {
  const command = commands.recovery?.body;
  if (commands.storageError) return <div role="alert" className="rounded border border-destructive p-3 text-sm space-y-2"><p>{commands.storageError}</p><Button variant="outline" size="sm" onClick={commands.refresh}>Retry payment recovery storage</Button></div>;
  if (!command) return commands.error ? <p role="alert" className="text-sm text-destructive">{commands.error}</p> : null;
  return <section aria-label="Saved payment request" className="rounded border border-amber-400 bg-amber-50 p-3 text-sm space-y-2 dark:bg-amber-950">
    <p className="font-medium">Confirm the saved payment outcome before another payment action</p>
    {command.operation === "record_payment" ? <><p>Record a completed payment of {formatPaymentAmount(command.payload.totalAmountCents)} to supplier #{command.payload.vendorId}, dated {command.payload.paymentDate}.</p><p>This is the original cash-payment request. Recovery reuses its exact key and amount.</p>{command.originInvoiceId && <Link className="underline" href={`/ap-invoices/${command.originInvoiceId}`}>Open original invoice #{command.originInvoiceId}</Link>}</>
      : command.operation === "apply_payment" ? <><p>Apply existing payment #{command.paymentId} to {command.payload.allocations.map(row => `invoice #${row.vendorInvoiceId}: ${formatPaymentAmount(row.appliedAmountCents)}`).join("; ")}.</p><p>No additional cash payment is recorded.</p><p>Reason: {command.payload.reason}</p></>
      : <><p>Void payment #{command.paymentId}.</p><p>Reason: {command.payload.reason}</p></>}
    {commands.error && <p role="alert" className="text-destructive">{commands.error}</p>}
    {!commands.canApprove && <p>Payment approval permission is required to recover this request. It remains saved for this operator.</p>}
    <Button size="sm" disabled={!commands.canApprove || commands.pending} onClick={commands.recover}>{commands.pending ? "Confirming payment outcome…" : "Recover saved payment request"}</Button>
  </section>;
}
