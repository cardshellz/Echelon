import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { z } from "zod";
import { formatPipelineMills, purchasePipelineSchema, supplierProgressCommandSchema, supplierProgressHistorySchema, supplierProgressSchema, type PurchasePipeline, type PurchasePipelineRow, type SupplierProgressCommand } from "@shared/procurement/purchase-pipeline";
import { useAuth } from "@/lib/auth";
import { purchaseWorkspaceInspectHref } from "@/lib/purchase-workspace-selection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

const labels: Record<PurchasePipelineRow["stage"], string> = {
  supplier_unconfirmed: "Supplier · production unconfirmed", in_production: "Reported in production", ready_to_ship: "Reported ready to ship",
  in_transit: "In transit", port_customs: "Port / customs", awaiting_receipt: "Delivered · awaiting receipt", review: "Quantity review",
};
async function load(url: string): Promise<unknown> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error("Purchase evidence could not be loaded.");
  return response.json();
}

function SupplierProgressDialog({ row, snapshotTime, onClose, canEdit }: { row: PurchasePipelineRow; snapshotTime: string; onClose: () => void; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const [started, setStarted] = useState(String(row.progress.report?.startedPieces ?? ""));
  const [completed, setCompleted] = useState(String(row.progress.report?.completedPieces ?? ""));
  const [asOf, setAsOf] = useState(new Date(row.progress.report?.asOf ?? snapshotTime).toISOString().slice(0, 16));
  const [reference, setReference] = useState(row.progress.report?.reference ?? "");
  const [notes, setNotes] = useState(row.progress.report?.notes ?? "");
  const [validation, setValidation] = useState<string | null>(null);
  const pendingCommand = useRef<SupplierProgressCommand | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const history = useQuery({ queryKey: ["supplier-progress", row.purchaseOrderLineId], queryFn: async () => supplierProgressHistorySchema.parse(await load(`/api/purchasing/pipeline/lines/${row.purchaseOrderLineId}/progress`)) });
  const save = useMutation({
    mutationFn: async (command: SupplierProgressCommand) => {
      const response = await fetch(`/api/purchasing/pipeline/lines/${row.purchaseOrderLineId}/progress`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
      const body: unknown = await response.json();
      if (!response.ok) {
        // A classified 4xx is a known rejection. Unknown server/network outcomes
        // keep the exact intent locked for a safe same-key retry.
        if (response.status >= 400 && response.status < 500) pendingCommand.current = null;
        if (typeof body === "object" && body !== null && "code" in body && body.code === "SUPPLIER_PROGRESS_CHANGED") setConflicted(true);
        throw new Error(typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : "Supplier progress could not be saved.");
      }
      return supplierProgressSchema.extend({ reused: z.boolean() }).parse(body);
    },
    onSuccess: () => { pendingCommand.current = null; setUncertain(false); queryClient.invalidateQueries({ queryKey: ["purchase-pipeline"] }); queryClient.invalidateQueries({ queryKey: ["supplier-progress", row.purchaseOrderLineId] }); onClose(); },
    onError: () => setUncertain(pendingCommand.current !== null),
  });
  const submit = () => {
    const timestamp = new Date(`${asOf}:00.000Z`);
    const command = { expectedRevision: row.progress.revision, idempotencyKey: crypto.randomUUID(), report: { startedPieces: /^\d+$/.test(started) ? Number(started) : Number.NaN, completedPieces: /^\d+$/.test(completed) ? Number(completed) : Number.NaN,
      asOf: Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : "", reference, notes } };
    const parsed = supplierProgressCommandSchema.safeParse(command);
    if (!parsed.success || parsed.data.report.startedPieces > row.orderedPieces - row.cancelledPieces) { setValidation(parsed.success ? "Started pieces exceed the net ordered quantity." : parsed.error.issues.map((issue) => issue.message).join(" ")); return; }
    setValidation(null); pendingCommand.current = parsed.data; save.mutate(parsed.data);
  };
  const locked = save.isPending || uncertain || !canEdit;
  return <Dialog open onOpenChange={(open) => { if (!open && !save.isPending && !uncertain) onClose(); }}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl"><DialogHeader>
    <DialogTitle>Supplier progress · {row.sku ?? row.purchaseOrderLineId}</DialogTitle>
    <DialogDescription>Record cumulative base pieces from supplier evidence. Completed is part of started. This does not receive inventory or approve payment. Revision {row.progress.revision}.</DialogDescription>
  </DialogHeader>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm">Started pieces<Input aria-label="Started pieces" inputMode="numeric" value={started} onChange={(event) => setStarted(event.target.value)} disabled={locked} /></label>
      <label className="text-sm">Completed pieces<Input aria-label="Completed pieces" inputMode="numeric" value={completed} onChange={(event) => setCompleted(event.target.value)} disabled={locked} /></label>
      <label className="text-sm sm:col-span-2">Supplier report as of (UTC)<Input aria-label="Supplier report as of (UTC)" type="datetime-local" value={asOf} onChange={(event) => setAsOf(event.target.value)} disabled={locked} /></label>
      <label className="text-sm sm:col-span-2">Evidence reference<Input aria-label="Evidence reference" value={reference} onChange={(event) => setReference(event.target.value)} disabled={locked} placeholder="Email date, production report or supplier reference" /></label>
      <label className="text-sm sm:col-span-2">Notes / correction reason<textarea aria-label="Notes / correction reason" className="mt-1 w-full rounded border bg-background p-2" value={notes} onChange={(event) => setNotes(event.target.value)} disabled={locked} /></label>
    </div>
    {(validation || save.error) && <p role="alert" className="text-sm text-destructive">{validation ?? save.error?.message}</p>}
    {conflicted && <Button variant="outline" onClick={() => { queryClient.invalidateQueries({ queryKey: ["purchase-pipeline"] }); onClose(); }}>Reload current report</Button>}
    {canEdit && (uncertain ? <div className="space-y-2"><p className="text-sm">The result is uncertain. Retry the saved request before changing the report.</p><Button disabled={save.isPending} onClick={() => pendingCommand.current && save.mutate(pendingCommand.current)}>Retry saved progress</Button></div> : <Button disabled={save.isPending} onClick={submit}>{save.isPending ? "Saving…" : "Save supplier progress"}</Button>)}
    <details className="text-sm"><summary className="cursor-pointer">Preserved report history</summary>
      {history.isPending && <p>Loading history…</p>}{history.error && <p role="alert">History could not be loaded. <Button variant="link" onClick={() => history.refetch()}>Retry</Button></p>}
      {history.data?.changes.map((change) => <div key={change.revision} className="mt-2 border-t pt-2 text-xs"><p>Revision {change.revision} · {change.after.reference}</p><p>{change.after.startedPieces} started / {change.after.completedPieces} completed · as of {change.after.asOf}</p><p>{change.recordedBy} · {change.recordedAt}</p>{change.after.notes && <p>{change.after.notes}</p>}</div>)}
      {history.data?.changes.length === 0 && <p>No report has been recorded.</p>}
    </details>
  </DialogContent></Dialog>;
}

export function PurchasePipelineView({ data, horizonDays, onHorizonChange, canEdit }: { data: PurchasePipeline; horizonDays: 30 | 90; onHorizonChange: (days: 30 | 90) => void; canEdit: boolean }) {
  const [bucket, setBucket] = useState("all");
  const [selected, setSelected] = useState<PurchasePipelineRow | null>(null);
  const visible = data.rows.filter((row) => bucket === "all" || row.arrivalBucket === bucket);
  return <section aria-labelledby="purchase-pipeline-title" data-testid="purchase-pipeline" className="min-w-0 space-y-4 rounded-lg border bg-card p-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="purchase-pipeline-title" className="text-lg font-semibold">Purchases before warehouse receipt</h2><p className="text-xs text-muted-foreground">Snapshot {data.asOf}. Quantities are base pieces; physical receipts are excluded.</p></div>
      <label className="text-sm">Arrival horizon<select aria-label="Arrival horizon" className="ml-2 rounded border bg-background p-2" value={horizonDays} onChange={(event) => onHorizonChange(event.target.value === "30" ? 30 : 90)}><option value="30">30 days</option><option value="90">90 days</option></select></label>
    </div>
    <p className="text-xs text-muted-foreground">Values combine known product, packaging and allocated freight components. Confirmed means latest recorded source evidence; estimates remain separate. Unknown components, taxes and unallocated fees are not silently treated as zero. Currency totals stay separate. Supplier progress is an operator report as of its stated date.</p>
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{data.totals.map((total) => <div key={`${total.currency}:${total.stage}`} className="rounded border p-3 text-sm"><p className="font-medium">{labels[total.stage]} · {total.currency ?? "currency unknown"}</p><p>{total.knownPieces.toLocaleString()} pieces{total.quantityReviewRows ? ` · ${total.quantityReviewRows} rows with unknown quantity` : ""}</p><p>Confirmed: {formatPipelineMills(total.confirmedMills, total.currency)}</p><p>Estimated: {formatPipelineMills(total.estimatedMills, total.currency)}</p>{total.unknownComponentCount > 0 && <p className="text-amber-700 dark:text-amber-300">{total.unknownComponentCount} component values need evidence</p>}</div>)}</div>
    <div className="flex flex-wrap items-center gap-2" aria-label="Arrival filters">{[["all", "All remaining"], ["within_horizon", `Within ${horizonDays} days`], ["overdue", "Overdue"], ["later", "Later"], ["unknown", "Unknown ETA"], ["arrived", "Delivered"]].map(([value, label]) => <Button key={value} size="sm" variant={bucket === value ? "default" : "outline"} aria-pressed={bucket === value} onClick={() => setBucket(value)}>{label} ({data.rows.filter((row) => value === "all" || row.arrivalBucket === value).length})</Button>)}</div>
    {data.issues.length > 0 && <details className="rounded border border-amber-300 p-3 text-xs"><summary className="cursor-pointer">{data.issues.length} source review notices</summary>{data.issues.map((issue) => <p key={issue} className="mt-2">{issue}</p>)}</details>}
    <div className="space-y-2">{visible.map((row) => <article key={row.key} data-pipeline-row={row.key} className="grid min-w-0 gap-3 rounded border p-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-1"><p className="break-words text-sm font-semibold">{row.sku ?? "Product line"} · {row.productName}</p><p className="text-sm">{row.quantityPieces === null ? "Quantity needs review" : `${row.quantityPieces.toLocaleString()} pieces`} · {labels[row.stage]}</p>
        <p className="text-xs text-muted-foreground">{row.vendorName} · <Link className="underline" href={`/purchase-orders/${row.purchaseOrderId}?tab=lifecycle`}>{row.poNumber}</Link>{row.shipmentId !== null && <> · <Link className="underline" href={purchaseWorkspaceInspectHref(`/purchase-orders/${row.purchaseOrderId}`, "", { kind: "shipment", id: row.shipmentId })}>{row.shipmentNumber}</Link></>}</p>
        <p className="text-xs">{row.arrivalDate ? `${row.arrivalBucket === "overdue" ? "Overdue · " : ""}${row.arrivalDate.slice(0, 10)} · ${row.arrivalSource?.replaceAll("_", " ")}` : "Arrival date unknown"}{row.arrivalDestination === "shipment_destination" && " · shipment destination; warehouse arrival not confirmed"}</p>
        {row.progress.report && <p className="text-xs text-muted-foreground">Supplier reported {row.progress.report.asOf.slice(0, 10)} · {row.progress.report.reference} · {Math.max(0, Math.floor((new Date(data.asOf).getTime() - new Date(row.progress.report.asOf).getTime()) / 86_400_000))} days ago</p>}
        <Button size="sm" variant="outline" onClick={() => setSelected(row)}>{canEdit ? "Record supplier progress" : "Supplier report history"}</Button>
      </div>
      <div className="min-w-0 space-y-1 text-xs">{row.costs.map((cost) => <p key={cost.component} className="break-words"><span className="capitalize">{cost.component === "landed" ? "Freight / landed" : cost.component}</span>: {cost.amountMills === null ? "Unknown / review" : formatPipelineMills(cost.amountMills, row.currency)} · {cost.evidence.replaceAll("_", " ")}{cost.sourceRevisionId !== null && <> · <Link className="underline" href={purchaseWorkspaceInspectHref(`/purchase-orders/${row.purchaseOrderId}`, "", { kind: "purchase", id: row.purchaseOrderId })}>Source #{cost.sourceRevisionId}</Link></>}{cost.recordedAt && ` · recorded ${cost.recordedAt.slice(0, 10)}`}</p>)}
        {row.issues.length > 0 && <ul className="list-disc space-y-1 pl-4 text-amber-700 dark:text-amber-300">{row.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
      </div>
    </article>)}</div>
    {visible.length === 0 && <p className="text-sm text-muted-foreground">No remaining purchase quantities match this view.</p>}
    {selected && <SupplierProgressDialog key={selected.purchaseOrderLineId} row={selected} snapshotTime={data.asOf} canEdit={canEdit} onClose={() => setSelected(null)} />}
  </section>;
}

export function PurchasePipeline() {
  const [horizonDays, setHorizonDays] = useState<30 | 90>(90);
  const { hasPermission } = useAuth();
  const query = useQuery({ queryKey: ["purchase-pipeline", horizonDays], queryFn: async () => purchasePipelineSchema.parse(await load(`/api/purchasing/pipeline?horizonDays=${horizonDays}`)) });
  if (!query.data) return <section className="rounded border p-4" aria-label="Purchase pipeline"><h2 className="font-semibold">Purchases before warehouse receipt</h2>{query.isPending ? <p role="status" className="text-sm">Loading purchase pipeline…</p> : <p role="alert" className="text-sm">Pipeline evidence could not be loaded. <Button variant="link" onClick={() => query.refetch()}>Retry pipeline</Button></p>}</section>;
  return <><div className="flex justify-end"><Button size="sm" variant="ghost" disabled={query.isFetching} onClick={() => query.refetch()}>Refresh pipeline</Button></div>{query.error && <p role="alert" className="text-sm text-destructive">Refresh failed. The prior snapshot remains displayed with its original time.</p>}<PurchasePipelineView data={query.data} horizonDays={horizonDays} onHorizonChange={setHorizonDays} canEdit={hasPermission("purchasing", "edit")} /></>;
}
