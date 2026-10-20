import React from "react";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { formatPaymentAmount, sumPaymentCents } from "@/lib/ap-payment-command";
import type { SupplierCreditCommands } from "./use-supplier-credit-commands";

export function SupplierCreditRecovery({ commands }: { commands: SupplierCreditCommands }) {
  if (commands.storageError) return <section role="alert" className="rounded border border-destructive p-3 space-y-2">
    <p>{commands.storageError}
    </p>
    <Button variant="outline" onClick={commands.refresh}>Retry credit recovery storage</Button>
  </section>;
  const intent = commands.recovery?.body;
  if (!intent) return commands.error ? <p role="alert" className="text-destructive">{commands.error}
  </p> : null;
  return <section aria-label="Saved supplier credit request" className="rounded border border-amber-400 bg-amber-50 p-3 text-sm space-y-2 dark:bg-amber-950">
    <p className="font-medium">Confirm the saved supplier credit outcome before another credit action</p>
    {intent.command === "create" ? <p>Create credit {intent.payload.supplierReference} for {formatPaymentAmount(sumPaymentCents(intent.payload.lines.map(line => line.amountCents)))} against invoice #{intent.payload.sourceInvoiceId}, dated {intent.payload.creditCalendarDate}.</p>
      : <p>{intent.command === "reverse" ? `Reverse application #${intent.applicationId} of` : intent.command === "apply" ? "Apply" : intent.command === "approve" ? "Approve" : "Void"} <Link className="underline" href={`/supplier-credits/${intent.creditId}`}>supplier credit #{intent.creditId}
      </Link>.</p>}
    {intent.command === "apply" && <ul>{intent.payload.allocations.map(row => <li key={row.vendorInvoiceId}>Invoice #{row.vendorInvoiceId}: {formatPaymentAmount(row.appliedAmountCents)}
    </li>)}
    </ul>}
    <p>Reason: {intent.payload.reason}
    </p>
    <p>This request does not transfer or record cash.</p>
    {commands.error && <p role="alert" className="text-destructive">{commands.error}
    </p>}
    {!commands.recoverAllowed && <p>Sign in with the original operator's current purchasing permission to recover this request.</p>}
    <Button disabled={!commands.recoverAllowed || commands.pending} onClick={commands.recover}>{commands.pending ? "Confirming credit outcome…" : "Recover saved credit request"}
    </Button>
  </section>;
}
