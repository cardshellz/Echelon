import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { shipmentMeasurementContextSchema, shipmentMeasurementPreviewSchema, shipmentMeasurementReviewRequestSchema,
  type ShipmentMeasurementPreview, type ShipmentMeasurementReviewRequest, type ShipmentMeasurements } from "@shared/procurement/shipment-measurement-correction";
import { createShipmentCostUpdateClient, shipmentCostWorkflowError } from "@/lib/shipment-cost-workflow";
import { financialCommandFetchJson, FinancialCommandRequestError } from "@/lib/financial-command";
import { invalidatePurchaseCosts } from "@/lib/invalidate-purchase-costs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatIntegerCents } from "@shared/utils/format-integer-cents";
import { formatMills } from "@shared/utils/money";
import { reconciliationDestinations } from "@shared/procurement/cost-reconciliation";

const formatCents = (value: number) => formatIntegerCents(value, "USD");

const fields = [ ["cartonCount", "Shipping cartons"], ["weightKg", "Weight (kg)"], ["lengthCm", "Length (cm)"],
  ["widthCm", "Width (cm)"], ["heightCm", "Height (cm)"] ] as const;
const display = (value: string | number | null) => value === null ? "Not recorded" : String(value);
const amount = (value: number | null) => value === null ? "Not posted" : formatCents(value);
const mills = (value: number | null) => value === null ? "Not recorded" : value < 0 ? `-${formatMills(-value)}` : formatMills(value);

export function ShipmentMeasurementImpact({ preview }: { preview: ShipmentMeasurementPreview }) {
  const changedLines = preview.lines.filter(line => JSON.stringify(line.before) !== JSON.stringify(line.after));
  const historicalChanges = preview.impact.historicalCosts.filter(row => row.totalMills.before !== row.totalMills.after);
  return <div className="space-y-4 text-sm">
    <p>Shipment charges: <strong>{formatCents(preview.chargeCents)}</strong>. Shipment stays <strong>{preview.status.replace(/_/g, " ")}</strong>. Shipped pieces, receipts and stock counts stay unchanged.</p>
    {changedLines.map(line => <div key={line.lineId} className="rounded-md border p-3">
      <p className="mb-2 font-medium">{line.sku ?? `Line ${line.lineId}`} <span className="font-normal text-muted-foreground">· PO #{line.purchaseOrderId}</span></p>
      <table className="w-full text-left text-xs" aria-label={`Measurement changes for ${line.sku ?? line.lineId}`}>
        <thead><tr><th>Measurement</th><th>Before</th><th>After</th></tr></thead>
        <tbody>
          {line.before.dimensionBasis !== line.after.dimensionBasis && <tr><td>Measured per</td><td>{display(line.before.dimensionBasis)}</td><td>{display(line.after.dimensionBasis)}</td></tr>}
          {fields.filter(([field]) => line.before[field] !== line.after[field]).map(([field, label]) => <tr key={field}><td>{label}</td><td>{display(line.before[field])}</td><td>{display(line.after[field])}</td></tr>)}
          {([ ["totalWeightKg", "Total weight (kg)"], ["totalVolumeCbm", "Total volume (CBM)"], ["chargeableWeightKg", "Chargeable weight (kg)"] ] as const)
            .filter(([field]) => line.physicalTotals.before[field] !== line.physicalTotals.after[field]).map(([field, label]) => <tr key={field}><td>{label}</td><td>{line.physicalTotals.before[field]}</td><td>{line.physicalTotals.after[field]}</td></tr>)}
        </tbody>
      </table>
    </div>)}
    <div role="region" aria-label="Shipment cost shares before and after">
      <div className="space-y-2 sm:hidden">{preview.lines.map(line => <div key={line.lineId} data-testid={`mobile-cost-share-${line.lineId}`} className="rounded-md border p-3">
        <p className="font-medium">{line.sku ?? `Line ${line.lineId}`}</p><p className="mb-2 text-xs text-muted-foreground">PO #{line.purchaseOrderId}</p>
        <table className="w-full text-left text-xs"><thead><tr><th>Cost</th><th className="text-right">Before</th><th className="text-right">After</th></tr></thead>
          <tbody><tr><td className="py-1">Shipment charges</td><td className="text-right tabular-nums">{amount(line.allocatedCents.before)}</td><td className="text-right tabular-nums">{amount(line.allocatedCents.after)}</td></tr>
            <tr><td>Total landed cost</td><td className="text-right tabular-nums">{amount(line.landedTotalCents.before)}</td><td className="text-right tabular-nums">{amount(line.landedTotalCents.after)}</td></tr></tbody>
        </table>
      </div>)}</div>
      <table className="hidden w-full text-left text-xs sm:table">
        <thead><tr><th>Product</th><th>Charge share before</th><th>After</th><th>Landed total before</th><th>After</th></tr></thead>
        <tbody>{preview.lines.map(line => <tr className="border-t" key={line.lineId}><td className="py-2">{line.sku ?? `Line ${line.lineId}`}<div className="text-muted-foreground">PO #{line.purchaseOrderId}</div></td>
          <td>{amount(line.allocatedCents.before)}</td><td>{amount(line.allocatedCents.after)}</td><td>{amount(line.landedTotalCents.before)}</td><td>{amount(line.landedTotalCents.after)}</td></tr>)}</tbody>
      </table>
    </div>
    {historicalChanges.length > 0 && <section aria-label="Approved historical cost changes" className="space-y-2 rounded-md border p-3">
      <p className="font-medium">Previously approved costs</p>
      <p className="text-xs text-muted-foreground">These changes use the recorded approval and cost destination.</p>
      <div className="overflow-x-auto"><table className="w-full text-left text-xs">
        <thead><tr><th>Cost destination</th><th className="text-right">Before</th><th className="text-right">After</th></tr></thead>
        <tbody>{historicalChanges.map((row, index) => <tr key={index} className="border-t">
          <td className="py-2">{reconciliationDestinations[row.destination]}<div className="text-muted-foreground">{preview.lines.find(line => line.lineId === row.shipmentLineId)?.sku ?? `Shipment line #${row.shipmentLineId}`}</div></td>
          <td className="pl-2 text-right tabular-nums">{mills(row.totalMills.before)}</td><td className="pl-2 text-right tabular-nums">{mills(row.totalMills.after)}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}
    <details><summary className="cursor-pointer">Stock and sold-order cost changes</summary>
      <div className="mt-2 space-y-2">
        {preview.impact.lots.map(lot => <p key={lot.lotId}>{lot.lotNumber}: {lot.onHandUnits.toLocaleString()} units on hand. Cost per inventory unit: {mills(lot.unitCostMills.before)} → {mills(lot.unitCostMills.after)}.</p>)}
        {preview.impact.orderCosts.filter(row => row.totalMills.before !== row.totalMills.after).map(row => <p key={row.costId}>Order #{row.orderId}, cost row #{row.costId}: {mills(row.totalMills.before)} → {mills(row.totalMills.after)}.</p>)}
        {!preview.impact.lots.length && <p>No linked stock or order costs were updated. Any missing receipt history remains in the existing cost review.</p>}
        {preview.impact.historicalCosts.filter(row => row.totalMills.before === row.totalMills.after).map((row, index) => <p key={index}>{reconciliationDestinations[row.destination]}: {mills(row.totalMills.before)} → {mills(row.totalMills.after)}.</p>)}
        {preview.impact.applications.flatMap(application => (application.returnedCosts ?? []).map(row => <p key={`${row.returnAllocationId}-${row.component}`}>Supplier return #{row.returnId}, line #{row.returnLineId}: {mills(row.beforeMills)} → {mills(row.afterMills)}.</p>))}
        {preview.impact.applications.flatMap((application, index) => application.issues.map(issue => <p className="text-amber-700" key={`${index}-${issue.code}`}>{issue.message}</p>))}
      </div>
    </details>
  </div>;
}

export function ShipmentMeasurementCorrection({ shipmentId, buttonLabel = "Measurements and approvals", open: controlledOpen, onOpenChange, hideTrigger = false }:
  { shipmentId: number; buttonLabel?: string; open?: boolean; onOpenChange?: (open: boolean) => void; hideTrigger?: boolean }) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  function setOpen(value: boolean) { setInternalOpen(value); onOpenChange?.(value); }
  const [draft, setDraft] = useState<ShipmentMeasurementReviewRequest | null>(null);
  const [preview, setPreview] = useState<ShipmentMeasurementPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const [client] = useState(() => createShipmentCostUpdateClient(() => crypto.randomUUID()));
  const queryClient = useQueryClient();
  const endpoint = `/api/inbound-shipments/${shipmentId}/measurements`;
  const context = useQuery({ queryKey: [endpoint], enabled: open,
    queryFn: async () => shipmentMeasurementContextSchema.parse(await financialCommandFetchJson(endpoint, { method: "GET", credentials: "include" })),
  });
  useEffect(() => {
    if (context.data && !context.isFetching && !context.isError && !draft) setDraft({ sourceVersion: context.data.sourceVersion, reason: "",
      lines: context.data.lines.map(line => ({ lineId: line.lineId, measurements: { ...line.measurements,
        dimensionBasis: line.measurements.dimensionBasis ?? (line.measurements.cartonCount === null ? "piece" : "carton") } })) });
  }, [context.data, context.isFetching, context.isError, draft]);
  const review = useMutation({ mutationFn: async (request: ShipmentMeasurementReviewRequest) => shipmentMeasurementPreviewSchema.parse(
    await financialCommandFetchJson(`${endpoint}/preview`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) })),
    onSuccess: value => { setPreview(value); setConfirmed(false); },
  });
  const save = useMutation({ mutationFn: () => {
    if (!draft || !preview || !confirmed) throw new Error("Review the measurements before approving.");
    return client.update(shipmentId, { ...draft, previewVersion: preview.previewVersion, evidenceConfirmed: true });
  }, onSettled: async () => { await invalidatePurchaseCosts(queryClient); await queryClient.invalidateQueries({ queryKey: [endpoint] }); } });
  const uncertain = save.error instanceof FinancialCommandRequestError && save.error.ambiguous;
  useEffect(() => {
    if (open && !uncertain) { setDraft(null); setPreview(null); setConfirmed(false); setValidation(null); save.reset(); review.reset(); }
    // Start a fresh review only when the modal opens. An uncertain approval
    // retains its reviewed request until the exact command is recovered.
  }, [open]);
  function change(lineId: number, field: keyof ShipmentMeasurements, value: string) {
    setDraft(current => current && ({ ...current, lines: current.lines.map(line => line.lineId === lineId ? { ...line,
      measurements: { ...line.measurements, [field]: field === "cartonCount" ? value === "" ? null : Number(value) : value === "" ? null : value } } : line) }));
    setPreview(null); setValidation(null); review.reset();
  }
  function requestReview() {
    const parsed = shipmentMeasurementReviewRequestSchema.safeParse(draft);
    if (!parsed.success) { setValidation(parsed.error.issues.map(issue => issue.message).join(" ")); return; }
    setValidation(null); review.mutate(parsed.data);
  }
  return <>
    {!hideTrigger && <Button variant="outline" className="min-h-[44px]" onClick={() => setOpen(true)}>{buttonLabel}</Button>}
    <Dialog open={open} onOpenChange={value => { if (!save.isPending && !review.isPending) setOpen(value); }}>
      <DialogContent className="flex max-h-[95dvh] w-[calc(100vw-1rem)] flex-col overflow-hidden p-4 sm:max-w-4xl sm:p-6">
        <DialogHeader className="text-left"><DialogTitle>{save.isSuccess ? "Measurements and costs saved" : "Correct shipment measurements"}</DialogTitle>
          <DialogDescription>Update the saved box measurements, review the cost changes, then save with one administrator approval.</DialogDescription></DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {context.isPending && <p role="status">Loading saved measurements…</p>}
          {context.isError && <p role="alert">{shipmentCostWorkflowError(context.error)}</p>}
          {context.data && <>
            <p className="text-sm">{context.data.shipmentNumber}. Measurements are per shipping carton or per piece, independent of the receiving pack.</p>
            {context.data.blockedReason && <p role="alert">{context.data.blockedReason}</p>}
            {!context.data.canApprove && <p>A current Administrator with purchasing approval permission must approve this correction.</p>}
            {save.isSuccess ? <p role="status">Saved with your approval. {save.data.status === "review_required" ? "Measurements and charge shares are updated. Remaining stock-history issues are shown in Cost review." : "Stock and sold-order costs were updated through the existing cost flow."}</p>
              : preview ? <ShipmentMeasurementImpact preview={preview} /> : draft && <>
                <div className="space-y-3">{context.data.lines.map(source => {
                  const line = draft.lines.find(row => row.lineId === source.lineId)!;
                  return <fieldset key={line.lineId} className="rounded-md border p-3" disabled={!context.data.canApprove || !!context.data.blockedReason || review.isPending || context.isError || context.isFetching}>
                    <legend className="px-1 text-sm font-medium">{source.sku ?? `Line ${line.lineId}`} · PO #{source.purchaseOrderId} · {source.shippedPieces.toLocaleString()} pieces</legend>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                      <Label className="space-y-1 text-xs">Measured per<select aria-label={`Measured per ${source.sku}`} className="h-10 w-full rounded-md border bg-background px-2" value={line.measurements.dimensionBasis ?? "carton"} onChange={event => change(line.lineId, "dimensionBasis", event.target.value)}>
                        <option value="carton">Shipping carton</option><option value="piece">Piece</option></select></Label>
                      {fields.map(([field, label]) => <Label className="space-y-1 text-xs" key={field}>{label}<Input aria-label={`${label} ${source.sku}`} inputMode={field === "cartonCount" ? "numeric" : "decimal"}
                        value={line.measurements[field] ?? ""} onChange={event => change(line.lineId, field, event.target.value)} /></Label>)}
                    </div>
                  </fieldset>;
                })}</div>
                <Label className="block space-y-1">Reason / packing document reference<Textarea value={draft.reason} onChange={event => setDraft({ ...draft, reason: event.target.value })} /></Label>
              </>}
            {preview && !save.isSuccess && <Label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={save.isPending || uncertain} onChange={event => setConfirmed(event.target.checked)} />I checked these measurements against the packing document and reviewed the cost changes.</Label>}
            {context.data.approvals.length > 0 && <details open={save.isSuccess}><summary className="cursor-pointer text-sm">Saved approvals ({context.data.approvals.length})</summary>
              {context.data.approvals.map(approval => <details className="mt-2 rounded-md border p-3 text-sm" key={approval.id}>
                <summary className="cursor-pointer">{approval.actorName} · {new Date(approval.approvedAt).toLocaleString()}</summary>
                <p className="my-2">{approval.preview.reason}</p><ShipmentMeasurementImpact preview={approval.preview} />
              </details>)}
            </details>}
          </>}
          {(validation || review.isError || save.isError) && <p role="alert" className="text-sm text-destructive">{validation ?? shipmentCostWorkflowError(save.error ?? review.error)}</p>}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t pt-3">
          <Button variant="outline" disabled={save.isPending || review.isPending} onClick={() => setOpen(false)}>Close review</Button>
          {!uncertain && (save.isError || review.isError || context.isError) && <Button variant="outline" disabled={save.isPending || review.isPending}
            onClick={() => { setDraft(null); setPreview(null); setConfirmed(false); setValidation(null); save.reset(); review.reset(); void context.refetch(); }}>Reload measurements</Button>}
          {!save.isSuccess && context.data?.canApprove && !context.data.blockedReason && (preview ? <>
            <Button variant="outline" disabled={save.isPending || uncertain} onClick={() => { setPreview(null); save.reset(); }}>Edit measurements</Button>
            <Button disabled={!confirmed || save.isPending || context.isError} onClick={() => save.mutate()}>{save.isPending ? "Saving measurements and costs…" : uncertain ? "Retry saved approval" : "Approve and update costs"}</Button>
          </> : <Button disabled={!draft || review.isPending || context.isFetching || context.isError} onClick={requestReview}>{review.isPending ? "Calculating cost changes…" : "Review changes"}</Button>)}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
