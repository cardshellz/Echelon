import React from "react";
import { Link } from "wouter";
import { rfqConversionResultSchema } from "@shared/procurement/rfq-workflow";
import { Button } from "@/components/ui/button";
import type { RfqCommands } from "./use-rfq-commands";

export function RfqCommandRecovery({ commands, showPending = true }: { commands: RfqCommands; showPending?: boolean }) {
  const saved = showPending ? commands.recovery : null;
  const storageError = showPending ? commands.storageError : null;
  const confirmed = showPending ? commands.confirmed : null;
  if (!saved && !storageError && !confirmed && !commands.error) return null;
  const conversion = confirmed?.intent.operation === "convert"
    ? rfqConversionResultSchema.safeParse(confirmed.result) : null;
  return <section aria-label={showPending ? "RFQ request recovery" : "RFQ command result"} className="space-y-2 rounded-md border p-3 text-sm">
    {storageError && <div role="alert"><p>{storageError}</p><Button variant="outline" onClick={commands.refresh}>Check saved RFQ request</Button></div>}
    {saved && <>
      <p role="status">An RFQ request needs recovery. The original action and reviewed values are saved.</p>
      <p>RFQ #{saved.body.rfqId} · {saved.body.operation === "capture_quote" ? `Quote for line #${saved.body.lineId}` : saved.body.operation === "convert" ? "Create draft purchase order" : "Release unconverted request"}</p>
      <div className="flex flex-wrap gap-2">
        <Link className="inline-flex min-h-[44px] items-center underline" href={`/procurement/rfqs?rfqId=${saved.body.rfqId}`}>Open original RFQ #{saved.body.rfqId}</Link>
        <Button variant="outline" disabled={!commands.recoverAllowed || commands.pending} onClick={commands.recover}>{commands.pending ? "Recovering…" : "Recover saved RFQ request"}</Button>
      </div>
      {!commands.canEdit && <p>Purchasing edit permission is required to recover this request.</p>}
    </>}
    {commands.error && <p role="alert" className="text-destructive">{commands.error.message}</p>}
    {confirmed && <p role="status">{conversion?.success ? <>Draft created: <Link className="font-semibold underline" href={`/purchase-orders/${conversion.data.purchaseOrderId}`}>{conversion.data.poNumber}</Link></> : confirmed.intent.operation === "release" ? "Unconverted request reservations released. Linked purchase orders remain unchanged." : "Quote revision saved. The preserved receipt confirms the original request."}</p>}
  </section>;
}
