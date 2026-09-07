import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import type { PurchaseRfqOrigin } from "@shared/procurement/purchase-rfq-origin";
import { RfqWorkflowPanel } from "./RfqWorkflowPanel";

export function PurchaseRfqOrigins({ sources }: { sources: PurchaseRfqOrigin[] }) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const groups = new Map<number, PurchaseRfqOrigin[]>();
  for (const source of sources) groups.set(source.rfqId, [...(groups.get(source.rfqId) ?? []), source]);
  if (groups.size === 0) return null;
  const selected = selectedId !== null ? groups.get(selectedId) : undefined;
  return (
    <section className="min-w-0 space-y-3 rounded-lg border p-4" aria-label="RFQ purchase sources">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h3 className="font-semibold">Original RFQs and quotes</h3><p className="text-sm text-muted-foreground">Inspect the source quote while keeping this purchase open.</p></div>
        {selected && <Button size="sm" variant="ghost" onClick={() => setSelectedId(null)}>Close RFQ details</Button>}
      </div>
      <div className="flex flex-wrap gap-2">
        {[...groups].map(([id, rows]) => <Button key={id} size="sm" variant={selectedId === id ? "secondary" : "outline"}
          aria-expanded={selectedId === id} onClick={() => setSelectedId(selectedId === id ? null : id)}>
          {rows[0].rfqNumber} · {rows.length} {rows.length === 1 ? "purchase line" : "purchase lines"}
        </Button>)}
      </div>
      {selected && <div className="min-w-0 space-y-3 border-t pt-3">
        <ul className="space-y-1 text-sm text-muted-foreground">{selected.map((source) => <li key={source.id} className="break-words">
          Quote {source.quoteReference} · revision #{source.quoteRevisionId} · {source.quotedPieces.toLocaleString()} pieces · {source.currency}
        </li>)}</ul>
        <Link href={`/procurement/rfqs?rfqId=${selected[0].rfqId}`} className="inline-block text-sm font-medium text-primary underline underline-offset-4">Open full RFQ</Link>
        <RfqWorkflowPanel rfqId={selected[0].rfqId} />
      </div>}
    </section>
  );
}
