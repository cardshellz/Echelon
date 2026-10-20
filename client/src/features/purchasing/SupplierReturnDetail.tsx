import { SupplierReturnCreditReview } from "./SupplierReturnCreditReview";
import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import { supplierReturnDetailSchema } from "@shared/procurement/supplier-return";
import { formatPaymentCalendarDate } from "@shared/procurement/ap-payment-contract";
import { procurementChildHref } from "@/lib/procurement-navigation";
import { Button } from "@/components/ui/button";
import { SupplierCreditLink } from "./SupplierCreditLink";
import { formatPaymentAmount } from "@/lib/ap-payment-command";
import { SupplierReturnValue } from "./SupplierReturnValue";
import { formatWorkspaceDate, formatWorkspaceMills } from "./purchase-workspace-format";
import type { SupplierReturnCommands } from "./use-supplier-return-commands";
export const returnCreditLabels = { unmatched: "Awaiting supplier credit", partially_matched: "Partially matched to supplier credit", matched: "Matched to supplier credit", review_required: "Credit matching requires review" } as const;
export function SupplierReturnDetail({ returnId, commands }: { returnId: number; commands: SupplierReturnCommands }) {
  const [path, navigate] = useLocation(); const search = useSearch();
  const params = new URLSearchParams(search);
  const reviewValues = params.getAll("reviewEntitlementId");
  const reviewId = reviewValues.length === 1 && /^[1-9]\d*$/.test(reviewValues[0]) && Number.isSafeInteger(Number(reviewValues[0])) ? Number(reviewValues[0]) : null;
  const reviewHref = (id: number | null) => { const next = new URLSearchParams(search); if (id === null) next.delete("reviewEntitlementId"); else next.set("reviewEntitlementId", String(id)); return `${path}${next.size ? `?${next}` : ""}`; };
  const query = useQuery({ queryKey: [`/api/supplier-returns/${returnId}`, commands.userId], staleTime: 0, retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/supplier-returns/${returnId}`, { credentials: "include", signal });
      if (!response.ok) throw new Error("The recorded supplier return could not be loaded.");
      const detail = supplierReturnDetailSchema.parse(await response.json());
      if (detail.id !== returnId) throw new Error("The response belongs to another return.");
      return detail;
    },
  });
  if (query.isPending) return <p role="status">Loading recorded supplier return…</p>;
  if (query.isError) return <div role="alert"><p>The recorded return is unavailable. Its inventory outcome must be verified before recording any replacement.</p><Button variant="outline" onClick={() => void query.refetch()}>Retry supplier return</Button></div>;
  const detail = query.data;
  const href = (destination: string) => procurementChildHref(path, search, destination);
  return <article className="space-y-5">
    {params.has("reviewEntitlementId") && reviewId === null && <p role="alert">Invalid credit difference review identifier.</p>}
    {reviewId !== null && <SupplierReturnCreditReview key={`${commands.userId}:${reviewId}`} entitlementId={reviewId} returnId={returnId} commands={commands} onClose={() => navigate(reviewHref(null))} />}
    <header className="space-y-2"><h1 className="text-2xl font-semibold">Supplier return #{detail.id}</h1><p>{detail.vendorName} · Collected {formatPaymentCalendarDate({ paymentCalendarDate: detail.returnCalendarDate, paymentDateSource: "recorded_calendar_date" })}</p><p>Collection evidence: <strong>{detail.evidenceReference}</strong></p>{detail.supplierReference && <p>Supplier reference: {detail.supplierReference}</p>}<p>{detail.reason}</p><p className="text-sm text-muted-foreground">Recorded by {detail.recordedBy} at {formatWorkspaceDate(detail.recordedAt)}. Original receipt quantities remain in history.</p></header>
    <p className="rounded border p-3 text-sm">Physical inventory removal is recorded. Supplier credit, invoice settlement and any refund remain separate.</p>
    {detail.lines.map(line => {
      const physical = detail.inventoryReceipt.lines.find(row => row.returnLineId === line.id)!;
      const origin = line.source.sourceProof.origin;
      return <section key={line.id} aria-label={`Returned lot ${line.source.lotNumber}`} className="rounded border p-4 space-y-4">
        <h2 className="text-lg font-semibold">{line.source.sku ?? "SKU not recorded"} · {line.source.lotNumber}</h2>
        <p>{line.source.quantity.toLocaleString()} recorded units / {line.source.basePieces.toLocaleString()} pieces removed from {line.source.locationCode}</p>
        <nav className="flex flex-wrap gap-4 text-sm" aria-label={`Return line ${line.id} sources`}><Link className="text-primary underline" href={href(`/purchase-orders/${origin.purchaseOrderId}?tab=receipts`)}>Purchase #{origin.purchaseOrderId}</Link><Link className="text-primary underline" href={href(`/receiving?open=${origin.receivingOrderId}`)}>Receipt #{origin.receivingOrderId}</Link></nav>
        <SupplierReturnValue value={line.source.costs} label="Value when returned" /><SupplierReturnValue value={line.currentCosts} label="Current returned value" />
        {line.source.costProvisional && <p className="text-sm">The original returned value included provisional costs. Later changes remain below.</p>}
        <section aria-label={`Return line ${line.id} credit matching`} className="rounded bg-muted/30 p-3 space-y-2"><h3 className="font-medium">{returnCreditLabels[line.creditState]}</h3>{line.creditIssues.map(issue => <p role="alert" key={issue.code} className="text-sm">{issue.message}</p>)}
          {(line.sourceInvoices ?? []).map(invoice => <p key={`${invoice.sourceInvoiceId}:${invoice.invoiceLineId}`}><SupplierCreditLink create sourceInvoiceId={invoice.sourceInvoiceId} supplierReturnLineId={line.id}>Record supplier credit from {invoice.invoiceNumber} / line #{invoice.invoiceLineId}</SupplierCreditLink></p>)}
          {(!line.sourceInvoices || line.sourceInvoices.length === 0) && <p className="text-sm">An approved invoice line that owns this return has not been verified. Review the original supplier invoice before recording its credit.</p>}
          {[...new Set((line.creditLinks ?? []).map(credit => credit.entitlementId))].map(id => <p key={id}><Link className="text-primary underline" href={reviewHref(id)}>Review credit difference #{id}</Link></p>)}
          {(line.creditLinks ?? []).map(credit => <p key={credit.creditLineId} className="text-sm"><Link className="text-primary underline" href={href(`/supplier-credits/${credit.creditId}`)}>{credit.supplierReference}</Link> · {credit.status} · {formatPaymentAmount(credit.amountCents)} · {credit.component} · {credit.quantity} recorded units</p>)}
        </section>
        <details><summary className="cursor-pointer min-h-10 py-2 font-medium">Stock and value history</summary><div className="space-y-3 text-sm"><p>Inventory transaction #{physical.inventoryTransactionId}; return allocation #{physical.returnAllocationId}; cost quantity allocation #{physical.costQuantityAllocationId}.</p>
          {line.source.sourceProof.transfers.map(transfer => <p key={transfer.contributionId}>Verified transfer: lot #{transfer.sourceLotId} to lot #{transfer.outputLotId}; contribution #{transfer.contributionId}.</p>)}
          {line.costEntries.map(entry => <article key={entry.id} className="border rounded p-3"><p className="font-medium">{entry.component} · {formatWorkspaceMills(entry.previousMills, "USD")} → {formatWorkspaceMills(entry.nextMills, "USD")}</p><p>{entry.reason}</p><p className="text-muted-foreground">{entry.recordedBy} · {formatWorkspaceDate(entry.recordedAt)} · Entry #{entry.id}</p></article>)}
        </div></details>
      </section>;
    })}
  </article>;
}
