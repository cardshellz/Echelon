import React, { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { financialCommandFetchJson } from "@/lib/financial-command";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { InvoiceLineCostReview } from "./InvoiceLineCostReview";

const invoiceSchema = z.object({ id: z.number().int().positive().safe(), status: z.string(), currency: z.string().regex(/^[A-Z]{3}$/),
  lines: z.array(z.object({ id: z.number().int().positive().safe(), lineNumber: z.number().int().positive().safe(), sku: z.string().nullable(),
    lineTotalCents: z.number().int().safe(), costReviewVersion: z.string().regex(/^[a-f0-9]{64}$/), costComponentEvidence: z.unknown() }).passthrough()),
}).passthrough();

/** Reuse the invoice editor in place. The row and its version are loaded from
 * the owning invoice, never reconstructed from a PO's quoted amounts. */
export function InvoiceCostReviewAction({ invoiceId, lineId, onSaved, label = "Confirm invoice", open: controlledOpen, onOpenChange, hideTrigger = false }: {
  invoiceId: number; lineId: number; onSaved: () => void; label?: string;
  open?: boolean; onOpenChange?: (open: boolean) => void; hideTrigger?: boolean;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const [ready, setReady] = useState(false);
  const query = useQuery({ queryKey: ["invoice-cost-task", invoiceId, lineId], enabled: open, staleTime: 0, refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const invoice = invoiceSchema.parse(await financialCommandFetchJson(`/api/vendor-invoices/${invoiceId}`, { credentials: "include", signal }));
      const matches = invoice.lines.filter(line => line.id === lineId);
      if (invoice.id !== invoiceId || matches.length !== 1) throw new Error("The invoice line could not be verified. Reload the cost review.");
      return { invoice, line: matches[0] };
    },
  });
  useEffect(() => { if (open && query.isSuccess && !query.isFetching) setReady(true); }, [open, query.isSuccess, query.isFetching]);
  function changeOpen(value: boolean) { if (!value) setReady(false); setInternalOpen(value); onOpenChange?.(value); }
  return <>
    {!hideTrigger && <Button size="sm" variant="outline" onClick={() => changeOpen(true)}>{label}</Button>}
    {open && ready && query.data && !query.isError ? <InvoiceLineCostReview key={`${invoiceId}:${lineId}`} line={query.data.line} currency={query.data.invoice.currency}
      invoiceStatus={query.data.invoice.status} invoiceId={invoiceId} onSaved={onSaved} open={open} onOpenChange={changeOpen} hideTrigger />
      : <Dialog open={open} onOpenChange={changeOpen}><DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>Confirm supplier amounts</DialogTitle></DialogHeader>
        {query.isError ? <><p role="alert">{query.error.message}</p><Button variant="outline" onClick={() => void query.refetch()}>Reload invoice</Button></> : <p role="status">Loading the saved supplier invoice…</p>}
        <Button variant="outline" onClick={() => changeOpen(false)}>Close review</Button>
      </DialogContent></Dialog>}
  </>;
}
