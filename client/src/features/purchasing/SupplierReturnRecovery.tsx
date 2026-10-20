import React from "react";
import { Button } from "@/components/ui/button";
import type { SupplierReturnCommands } from "./use-supplier-return-commands";
import { SupplierReturnValue } from "./SupplierReturnValue";
export function SupplierReturnRecovery({ commands }: { commands: SupplierReturnCommands }) {
  if (commands.storageError) return <section role="alert" className="rounded border border-destructive p-3 space-y-2"><p>{commands.storageError}</p><Button variant="outline" onClick={commands.refresh}>Retry return recovery storage</Button></section>;
  const saved = commands.recovery?.body;
  if (!saved) return commands.error ? <p role="alert" className="text-destructive">{commands.error}</p> : null;
  return <section aria-label="Saved supplier return request" className="rounded border border-amber-400 bg-amber-50 dark:bg-amber-950 p-4 space-y-3 text-sm">
    <p className="font-semibold">{saved.command === "record" ? "Confirm the saved physical return before recording another return" : "Confirm the saved credit difference review before another return action"}</p>
    {saved.command === "record" ? <><p>Supplier #{saved.payload.vendorId}; collection {saved.payload.evidenceReference}; dated {saved.payload.returnCalendarDate}.</p>
      <ul className="list-disc pl-5">{saved.reviewed.lines.map(line => <li key={line.inventoryLotId}>{line.lotNumber} at {line.locationCode}: {line.quantity.toLocaleString()} recorded units / {line.basePieces.toLocaleString()} pieces</li>)}</ul>
      <SupplierReturnValue value={saved.reviewed.totals} label="Reviewed return value" /></> : <><p>Return #{saved.reviewed.returnId}, matched quantity #{saved.entitlementId}; evidence {saved.payload.evidenceReference}.</p><SupplierReturnValue value={saved.reviewed.currentCosts} label="Reviewed matched return value" /><p>This review attributes existing supplier credit or records follow-up evidence. It does not remove inventory, record a refund or write off a difference.</p></>}
    <p>Reason: {saved.payload.reason}</p><p>Recovery verifies this same request. It does not create a replacement return or supplier credit.</p>
    {commands.error && <p role="alert" className="text-destructive">{commands.error}</p>}
    {!commands.recoverAllowed && <p>The original operator needs current purchasing approval permission to recover this request.</p>}
    <Button disabled={!commands.recoverAllowed || commands.pending} onClick={commands.recover}>{commands.pending ? "Confirming return outcome…" : "Recover saved return request"}</Button>
  </section>;
}
