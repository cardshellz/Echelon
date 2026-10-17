import { CheckCircle2 } from "lucide-react";
import { reconciliationDestinations, type ReconciliationContext } from "@shared/procurement/cost-reconciliation";
import { formatShipmentExceptionAmount } from "@shared/procurement/shipment-cost-exception";

export function ShipmentCostPostingHistory({ data }: { data: ReconciliationContext }) {
  return data.history.length > 0 ? (
    <details className="text-xs">
      <summary className="cursor-pointer">
        Posted adjustments ({data.history.length}{data.history.length === 50 ? " most recent" : ""})
      </summary>
      <ol className="mt-2 space-y-2">
        {data.history.map(posting => (
          <li key={posting.id} className="border-t pt-2">
            <strong>{reconciliationDestinations[posting.destination]}</strong> ·{" "}
            {formatShipmentExceptionAmount(posting.beforeMills, data.currency)} →{" "}
            {formatShipmentExceptionAmount(posting.afterMills, data.currency)} · approved by {posting.actorName} ·{" "}
            posted {new Date(posting.recordedAt).toLocaleString()}
            <p>{posting.reason}</p>
          </li>
        ))}
      </ol>
    </details>
  ) : null;
}

/** A saved posting is a receipt, not another approval form. Posting timestamps
 * may follow the original approval when a later charge revision changes costs. */
export function ShipmentCostPostingDetails({ data }: { data: ReconciliationContext }) {
  const money = (mills: number) => formatShipmentExceptionAmount(mills, data.currency);
  const latest = data.history.find(posting => posting.destination === data.state.destination);
  return (
    <div className="space-y-4 text-sm">
      <div role="status" className="rounded-md border border-green-600/40 bg-green-50 p-4 dark:bg-green-950/30">
        <div className="flex items-center gap-2 font-semibold text-green-800 dark:text-green-300">
          <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
          Costs already posted
        </div>
        <p className="mt-1">No further cost approval is needed for this line.</p>
      </div>
      <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-3 rounded-md border p-4">
        <dt>Posted amount</dt><dd className="text-right font-semibold">{money(data.state.postedMills)}</dd>
        <dt>Cost destination</dt><dd className="text-right">{data.state.destination && reconciliationDestinations[data.state.destination]}</dd>
        <dt>Unassigned cost</dt><dd className="text-right">{money(data.state.unassignedMills)}</dd>
      </dl>
      {latest ? (
        <section aria-label="Approval details" className="space-y-2 rounded-md border p-4">
          <h3 className="font-semibold">Approval details</h3>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
            <dt>Approved by</dt><dd className="break-words">{latest.actorName}</dd>
            <dt>Latest posting</dt><dd>{new Date(latest.recordedAt).toLocaleString()}</dd>
            <dt>Posting reference</dt><dd>#{latest.id}</dd>
          </dl>
          <p className="font-medium">Saved reason / supporting reference</p>
          <p className="whitespace-pre-wrap break-words">{latest.reason}</p>
        </section>
      ) : <p role="alert">The costs are posted, but the approval details are unavailable. Reload to retrieve them.</p>}
      {data.sourceEvidence === "estimated" && (
        <p className="text-muted-foreground">
          This posting uses the saved estimated shipment charge. Supplier confirmation is separate from cost approval.
          A later cost update applies any difference to the approved destination.
        </p>
      )}
      <ShipmentCostPostingHistory data={data} />
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Original inventory history</summary>
        <p className="mt-2">The historical gaps remain in the audit. Their costs have been assigned by the approval above.</p>
        {data.records.map(record => (
          <p key={record.lotId} className="mt-2">
            <strong>{record.lotNumber}</strong> · {record.originalQuantity.toLocaleString()} recorded received;{" "}
            {record.onHandQuantity.toLocaleString()} on hand.
            {record.receiptId !== null && <> Receipt #{record.receiptId}{record.receiptLineId !== null && <> / line #{record.receiptLineId}</>}.</>}
          </p>
        ))}
        {data.issues.map(issue => <p key={`${issue.code}:${issue.message}`} className="mt-2">{issue.message}</p>)}
      </details>
    </div>
  );
}
