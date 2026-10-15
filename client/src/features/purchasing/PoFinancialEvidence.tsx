import { useQuery } from "@tanstack/react-query";
import { poFinancialEvidenceSchema } from "@shared/procurement/po-financial-evidence";
import { formatIntegerCents } from "@shared/utils/format-integer-cents";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "wouter";

export function usePoFinancialEvidence(purchaseOrderId: number | null) {
  return useQuery({
    // Share the PO key prefix so existing financial commands refresh this read.
    queryKey: [`/api/purchase-orders/${purchaseOrderId}`, "financial-evidence"],
    enabled: purchaseOrderId !== null,
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/purchase-orders/${purchaseOrderId}/financial-evidence`);
      const evidence = poFinancialEvidenceSchema.parse(await response.json());
      if (evidence.purchaseOrderId !== purchaseOrderId) throw new Error("Financial evidence belongs to another purchase order.");
      return evidence;
    },
  });
}

export function PoFinancialEvidence({ query, onViewInvoices, invoiceHref }: {
  query: ReturnType<typeof usePoFinancialEvidence>;
  onViewInvoices: () => void;
  invoiceHref: (invoiceId: number) => string;
}) {
  const evidence = query.data;
  const amount = (cents: number | null, currency: string) => cents === null ? "Unknown" : formatIntegerCents(cents, currency);
  return <Card role="region" aria-label="Purchase order financial evidence">
    <CardHeader className="pb-3"><CardTitle className="text-base">This purchase order's finances</CardTitle></CardHeader>
    <CardContent className="space-y-3 text-sm">
      {(query.isPending || query.isFetching) && <p role="status">{query.data ? "Refreshing purchase order financial evidence…" : "Loading purchase order financial evidence…"}</p>}
      {query.isError && !query.isFetching && <div role="alert" className="space-y-2">
        <p>Purchase order financial evidence could not be loaded. Its invoiced, paid and outstanding amounts are unavailable.</p>
        <Button variant="outline" onClick={() => void query.refetch()}>Reload financial evidence</Button>
      </div>}
      {query.isSuccess && !query.isFetching && evidence && <>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div><dt className="text-muted-foreground">Invoiced to this PO</dt><dd className="mt-1 font-mono font-medium">{amount(evidence.invoicedAmountCents, evidence.currency)}</dd></div>
          <div><dt className="text-muted-foreground">Paid for this PO</dt><dd className="mt-1 font-mono font-medium">{amount(evidence.paidAmountCents, evidence.currency)}</dd></div>
          <div><dt className="text-muted-foreground">Outstanding for this PO</dt><dd className="mt-1 font-mono font-medium">{amount(evidence.outstandingAmountCents, evidence.currency)}</dd></div>
        </dl>
        {evidence.invoiceCount === 0 && <p className="text-muted-foreground">No active linked invoices recorded.</p>}
        {evidence.state === "review_required" && <div className="space-y-2 rounded-md border border-amber-400/60 p-3">
          <p className="font-medium">Financial attribution needs review</p>
          <p>Unknown means the recorded evidence cannot establish this PO's share. Review the linked invoices before relying on its payment or balance totals.</p>
          <ul className="list-disc space-y-1 pl-5">{evidence.reviewReasons.map((reason, index) => <li key={`${reason.invoiceId}:${reason.code}:${index}`}>
            {reason.message}
            {reason.invoiceId !== null && <Link href={invoiceHref(reason.invoiceId)} className="ml-2 text-primary underline">Open invoice {reason.invoiceId}</Link>}
          </li>)}</ul>
          <Button variant="outline" onClick={onViewInvoices}>Review linked invoices</Button>
        </div>}
        {evidence.state === "complete" && evidence.invoiceCount > 0 && <p className="text-muted-foreground">Amounts supported by the recorded invoice lines and settlement evidence. Individual payments remain recorded against entire invoices.</p>}
      </>}
    </CardContent>
  </Card>;
}
