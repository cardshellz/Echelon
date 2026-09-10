import React, { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { openingAssessmentSchema, openingSavedSchema, openingSourceSchema, saveOpeningRequestSchema } from "@shared/types/inventory-cutover-opening";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CutoverHttpError, postInventoryPlanningCommand } from "./inventory-cutover-http";
import { createOpeningWorksheet, OPENING_DOCUMENT_LIMIT_BYTES, parseOpeningDocument, prepareOpeningSave,
  type OpeningAssessment, type OpeningSource, type OpeningVerification } from "./inventory-cutover-opening-document";
import { evidencePage } from "./inventory-cutover-preflight-panel";

type Props = { actorId: string | null; canActivate: boolean; onStateChanged(): void };
const SOURCE_URL = "/api/inventory-planning/admin/cutover-opening/source";
const rejectedCodes = new Set(["CUTOVER_OPENING_EVIDENCE_CHANGED", "CUTOVER_OPENING_AUTHORITY_CHANGED",
  "CUTOVER_OPENING_CONFIGURATION_CHANGED", "CUTOVER_OPENING_BLOCKED", "CUTOVER_OPENING_REPLAY_CONFLICT",
  "CUTOVER_OPENING_IDEMPOTENCY_CONFLICT", "CUTOVER_OPENING_ALREADY_VERIFIED"]);

export async function fetchOpeningSource(signal?: AbortSignal): Promise<OpeningSource> {
  const response = await fetch(SOURCE_URL, { method: "GET", credentials: "include", cache: "no-store", signal });
  if (!response.ok) throw new Error(`Opening source capture failed (HTTP ${response.status}). No new verified source is available.`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error("Opening source response is not valid JSON."); }
  const parsed = openingSourceSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Opening source response failed validation. No partial source is being shown.");
  return parsed.data;
}

/** Parent keys this component by authenticated actor. Neither capture nor import
 * attests that a database quantity was independently counted. Save is audit-only. */
export function InventoryCutoverOpeningPanel(props: Props) {
  const [verification, setVerification] = useState<OpeningVerification | null>(null);
  const [assessment, setAssessment] = useState<OpeningAssessment | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState("");
  const [inputError, setInputError] = useState<Error | null>(null);
  const [importing, setImporting] = useState(false);
  const [saved, setSaved] = useState<z.infer<typeof openingSavedSchema> | null>(null);
  const attempt = useRef<z.infer<typeof saveOpeningRequestSchema> | null>(null);
  const enabled = props.canActivate && props.actorId !== null;
  const source = useQuery({ queryKey: [SOURCE_URL, props.actorId], enabled: false, retry: false, gcTime: 0,
    refetchOnMount: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
    queryFn: ({ signal }) => { if (!enabled) throw new Error("An authorized operator is required."); return fetchOpeningSource(signal); } });
  const usable = enabled && !source.isError && !source.isFetching && source.data?.runtimeAuthority === "legacy";
  const preview = useMutation({ mutationFn: async () => {
    if (!usable || !source.data || !verification || !confirmed) throw new Error("Capture source records and independently verify the complete document first.");
    setAssessment(null);
    return postInventoryPlanningCommand("cutover-opening", "preview", verification, openingAssessmentSchema);
  }, onSuccess: result => setAssessment(result), onError: () => setAssessment(null) });
  const save = useMutation({ mutationFn: async () => {
    if (!enabled) throw new Error("An authorized operator is required.");
    if (!attempt.current) {
      if (!usable || !source.data || !verification || !confirmed || preview.isPending) throw new Error("Review the independently verified opening document first.");
      attempt.current = prepareOpeningSave(verification, source.data, assessment, reason, `opening:${crypto.randomUUID()}`);
    }
    return postInventoryPlanningCommand("cutover-opening", "verify", attempt.current, openingSavedSchema);
  }, onSuccess: result => { attempt.current = null; setSaved(result); setAssessment(null); props.onStateChanged(); },
  onError: error => {
    if (error instanceof CutoverHttpError && error.status === 409 && error.code && rejectedCodes.has(error.code)) {
      attempt.current = null; setAssessment(null);
    }
  } });
  const busy = source.isFetching || preview.isPending || save.isPending || importing;
  const retained = attempt.current !== null;
  const displayedSaved = saved ?? source.data?.latestVerification;
  const error = inputError ?? save.error ?? preview.error ?? source.error;
  async function importFile(file: File | undefined) {
    if (!file || !usable || !source.data || busy || retained) return;
    setVerification(null); setAssessment(null); setConfirmed(false); setSaved(null); setInputError(null);
    if (file.size > OPENING_DOCUMENT_LIMIT_BYTES) { setInputError(new Error("The verification file exceeds 10MB. No partial document was imported.")); return; }
    setImporting(true);
    try { setVerification(parseOpeningDocument(await file.text(), source.data)); }
    catch (error) { setInputError(error instanceof Error ? error : new Error("The verification document could not be read.")); }
    finally { setImporting(false); }
  }
  function downloadWorksheet() {
    if (!usable || !source.data || busy || retained) return;
    const blob = new Blob([createOpeningWorksheet(source.data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `inventory-opening-${source.data.evidenceHash.slice(0, 12)}.json`;
    try { link.click(); } finally { URL.revokeObjectURL(url); }
  }
  if (!enabled) return null;
  return <Card aria-label="Verified current inventory opening">
    <CardHeader><CardTitle>Verify current inventory and open orders</CardTitle>
      <p className="text-sm text-muted-foreground">Establish a reviewed starting point from independently verified stock, lot costs and current order commitments.
        Older unresolved history stays recorded separately. Saving here does not correct stock, change authority or publish quantities.</p>
    </CardHeader>
    <CardContent className="space-y-4">
      <Button variant="outline" disabled={busy || retained} onClick={() => {
        setVerification(null); setAssessment(null); setConfirmed(false); setSaved(null); setInputError(null); void source.refetch();
      }}>{source.isFetching ? "Capturing recorded data…" : "Capture current recorded data"}</Button>
      {error && <p role="alert" className="text-sm text-destructive">{error.message}{source.isError && source.data ? " Previous source records below may be stale; they cannot authorize a new save." : ""}</p>}
      {source.data && <>
        <p className="text-sm">Recorded snapshot: {source.data.capturedAt} · {source.data.evidence.levels.length} stock positions · {source.data.evidence.lots.length} lots.
          These are database records, not proof of a physical count.</p>
        {source.data.runtimeAuthority !== "legacy" && <p role="note">Inventory authority has already changed. Opening verification is unavailable.</p>}
        <OpeningRecordedEvidence source={source.data} />
        <Button variant="outline" disabled={!usable || busy || retained} onClick={downloadWorksheet}>Download blank verification worksheet</Button>
        <p className="text-sm">Complete the worksheet's verification section using retained independent evidence. Every quantity is deliberately blank, including zero quantities.
          Include each stock position, lot and current order owner; record exact lot allocations for reserved or picked units. Recorded reference values and labels are not imported as verification.</p>
        <p className="text-sm">The stock-position reservation counter must match the current record, even when it includes a promise against an empty bin. Do not change that counter to zero in the worksheet.
          An order owner's reserved and picked quantities describe physical holds only. For a proven unpicked promise with no physical hold, independently verify both owner quantities as zero with no lot allocations,
          while keeping the full remaining order demand. The server must prove the complete empty-bin promise before proposing a handoff; unknown or mixed cases remain blocked.</p>
        <Label htmlFor="opening-verification-file">Import completed verification JSON</Label>
        <Input id="opening-verification-file" type="file" accept=".json,application/json" disabled={!usable || busy || retained}
          onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; void importFile(file); }} />
      </>}
      {verification && <section className="space-y-3 rounded border p-3">
        <p className="text-sm">Imported {verification.levels.length} positions, {verification.lots.length} lots and {verification.owners.length} order lines.</p>
        <p className="text-sm break-all">Evidence reference: {verification.verificationReference} · verified {verification.verifiedAt}</p>
        {source.data && <OpeningVerifiedEvidence source={source.data} verification={verification} />}
        <Label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy || retained}
          onChange={event => { setConfirmed(event.target.checked); setAssessment(null); }} />
          I independently verified these quantities, order commitments and lot/cost allocations against the referenced evidence. I am not treating the recorded database values as a physical count.</Label>
        <Button variant="outline" disabled={!usable || busy || retained || !confirmed} onClick={() => preview.mutate()}>
          {preview.isPending ? "Checking complete verification…" : "Preview verified opening"}</Button>
      </section>}
      {assessment && <section className="space-y-3" aria-label="Opening verification assessment">
        <p className="text-sm">{assessment.ready ? "Verification is consistent and can be saved for later cutover review." : `${assessment.blockers.length} finding(s) prevent saving this verification.`}
          {" "}{assessment.historicalExceptions.length} historical finding(s) remain recorded separately; they are not declared resolved.</p>
        {source.data && <OpeningPromiseHandoffEvidence source={source.data} assessment={assessment} />}
        <OpeningFindings title="Current verification blockers" rows={assessment.blockers} />
        <OpeningFindings title="Preserved historical exceptions" rows={assessment.historicalExceptions} />
      </section>}
      {verification && <>
        <Label htmlFor="opening-verification-reason">Reason for saving this verification</Label>
        <Input id="opening-verification-reason" value={reason} maxLength={1000} disabled={busy || retained} onChange={event => setReason(event.target.value)} />
        <Button disabled={!usable || busy || retained || !confirmed || !assessment?.ready || !reason.trim()} onClick={() => save.mutate()}>
          {save.isPending ? "Saving verification…" : "Save verified opening — no activation"}</Button>
      </>}
      {retained && !save.isPending && <div className="space-y-2"><p className="text-sm">The save outcome is uncertain. Retry sends the exact same document, reason and key; it does not create a different approval.</p>
        <Button variant="outline" onClick={() => save.mutate()}>Retry the same verification save</Button></div>}
      {displayedSaved && <p role="status" className="text-sm">Verification {displayedSaved.id} is saved as immutable evidence.
        Stock and inventory authority are unchanged. Preparation and final activation still require separate review.
        {source.data && (displayedSaved.sourceEvidenceHash !== source.data.evidenceHash || displayedSaved.authorityRevision !== source.data.authorityRevision)
          && " This saved verification belongs to an earlier source or authority revision; it is not verification of the current records."}</p>}
    </CardContent>
  </Card>;
}

function OpeningRecordedEvidence({ source }: { source: OpeningSource }) {
  const labels = new Map(source.labels.map(row => [`${row.kind}:${row.id}`, row.label]));
  const label = (kind: string, id: string | number | null) => id === null ? "Unknown" : labels.get(`${kind}:${id}`) ?? `${kind} ${id} (label unavailable)`;
  return <details><summary className="cursor-pointer text-sm">Inspect recorded SKU, bin and order references</summary>
    <OpeningRows rows={source.evidence.levels} render={rows => <table className="w-full text-sm"><thead><tr><th>SKU</th><th>Warehouse / bin</th><th>Recorded units</th><th>Recorded reservation counter / picked / packed</th></tr></thead><tbody>
      {rows.map(row => <tr key={row.id}><td>{label("variant", row.productVariantId)}</td><td>{label("warehouse", row.warehouseId)} / {label("location", row.warehouseLocationId)}<br />Level {row.id}</td>
        <td>{row.variantQty}</td><td>{row.reservedQty} / {row.pickedQty} / {row.packedQty}</td></tr>)}</tbody></table>} />
    <OpeningRows rows={source.evidence.items} render={rows => <table className="w-full text-sm"><thead><tr><th>Order / line</th><th>SKU</th><th>Ordered / picked / fulfilled</th></tr></thead><tbody>
      {rows.map(row => <tr key={row.id}><td>{label("order", row.orderId)} / line {row.id}</td><td>{row.sku}</td><td>{row.quantity} / {row.pickedQuantity} / {row.fulfilledQuantity}</td></tr>)}</tbody></table>} />
  </details>;
}

function OpeningVerifiedEvidence({ source, verification }: { source: OpeningSource; verification: OpeningVerification }) {
  const labels = new Map(source.labels.map(row => [`${row.kind}:${row.id}`, row.label]));
  const label = (kind: string, id: string | number | null) => id === null ? "Unknown" : labels.get(`${kind}:${id}`) ?? `${kind} ${id} (label unavailable)`;
  const levels = new Map(verification.levels.map(level => [level.id, level]));
  const allocations = verification.owners.flatMap(owner => owner.allocations.flatMap(allocation => allocation.lots.map(lot => ({
    orderId: owner.orderId, orderItemId: owner.orderItemId, inventoryLevelId: allocation.inventoryLevelId, ...lot,
  }))));
  return <details><summary className="cursor-pointer text-sm">Review imported stock, order ownership and lot costs</summary>
    <h4 className="mt-2 text-sm font-medium">Verified stock positions</h4>
    <OpeningRows rows={verification.levels} render={rows => <table className="w-full text-sm"><thead><tr><th>SKU / bin</th><th>Units</th><th>Recorded reservation counter / picked / packed</th></tr></thead><tbody>
      {rows.map(row => <tr key={row.id}><td>{label("variant", row.productVariantId)} / {label("warehouse", row.warehouseId)} / {label("location", row.warehouseLocationId)} · level {row.id}</td>
        <td>{row.variantQty}</td><td>{row.reservedQty} / {row.pickedQty} / {row.packedQty}</td></tr>)}</tbody></table>} />
    <h4 className="mt-2 text-sm font-medium">Verified order commitments</h4>
    <OpeningRows rows={verification.owners} render={rows => <table className="w-full text-sm"><thead><tr><th>Order / line</th><th>Remaining demand kept</th><th>Physical reserved / picked</th></tr></thead><tbody>
      {rows.map(row => <tr key={row.orderItemId}><td>{label("order", row.orderId)} / line {row.orderItemId}</td><td>{row.remainingQty}</td><td>{row.reservedQty} / {row.pickedQty}</td></tr>)}</tbody></table>} />
    <h4 className="mt-2 text-sm font-medium">Verified owner allocations</h4>
    <OpeningRows rows={allocations} render={rows => <table className="w-full text-sm"><thead><tr><th>Order / line</th><th>SKU / bin / lot</th><th>Physical reserved / picked</th><th>Original cost records</th></tr></thead><tbody>
      {rows.map((row, index) => { const level = levels.get(row.inventoryLevelId); return <tr key={`${row.orderItemId}:${row.inventoryLevelId}:${row.inventoryLotId}:${index}`}>
        <td>{label("order", row.orderId)} / line {row.orderItemId}</td><td>{level ? `${label("variant", level.productVariantId)} / ${label("location", level.warehouseLocationId)}` : `Unknown level ${row.inventoryLevelId}`} / lot {row.inventoryLotId}</td>
        <td>{row.reservedQty} / {row.pickedQty}</td><td>{row.originalCostIds.length} exact record(s); see worksheet IDs</td></tr>; })}</tbody></table>} />
    <h4 className="mt-2 text-sm font-medium">Verified lot costs (integer mills)</h4>
    <OpeningRows rows={verification.lots} render={rows => <table className="w-full text-sm"><thead><tr><th>SKU / bin / lot</th><th>Units / reserved / picked</th><th>Unit / PO / packaging / landed</th></tr></thead><tbody>
      {rows.map(row => <tr key={row.id}><td>{label("variant", row.productVariantId)} / {label("location", row.warehouseLocationId)} / lot {row.id}</td><td>{row.onHandQty} / {row.reservedQty} / {row.pickedQty}</td>
        <td>{row.unitCostMills} / {row.poUnitCostMills} / {row.packagingUnitCostMills} / {row.landedUnitCostMills}</td></tr>)}</tbody></table>} />
  </details>;
}

/** Render only the server's exact complete-position proposals. A zero-looking
 * bin in the captured source is never enough for the browser to infer a release. */
export function OpeningPromiseHandoffEvidence({ source, assessment }: { source: OpeningSource; assessment: OpeningAssessment }) {
  const releases = assessment.plan.legacyPromiseReleases;
  if (releases.length === 0) return null;
  const labels = new Map(source.labels.map(row => [`${row.kind}:${row.id}`, row.label]));
  const label = (kind: string, id: number) => labels.get(`${kind}:${id}`) ?? `${kind} ${id} (label unavailable)`;
  const plannedLines = new Map(assessment.plan.orders.flatMap(order => order.lines.map(line => [`${order.orderId}:${line.orderItemId}`, line] as const)));
  const rows = releases.flatMap(release => release.owners.map(owner => ({ release, owner,
    line: plannedLines.get(`${owner.orderId}:${owner.orderItemId}`) })));
  return <section className="space-y-2 rounded border p-3" aria-label="Proven empty-bin promise handoffs">
    <h4 className="font-medium text-sm">Proven empty-bin promises to re-plan</h4>
    <p className="text-sm">{releases.length} complete empty-bin position(s), for {rows.length} order line(s).
      No physical stock is released by this handoff. The full remaining customer demand is kept, including any shortage.</p>
    <p className="text-sm">Preview and verification save change no counters. Only a separately reviewed final activation may remove these exact nonphysical reservation counters
      through the inventory owner and re-plan demand atomically. Physical reservations, picked stock and build holds are not cleared by this handoff.</p>
    {!assessment.ready && <p className="text-sm" role="note">Other findings still block this opening. Showing these proposals does not authorize saving or activation.</p>}
    <OpeningRows rows={rows} render={page => <table className="w-full text-sm"><thead><tr>
      <th>Order / line</th><th>SKU / warehouse / bin</th><th>Recorded promise units</th><th>Remaining demand kept</th>
    </tr></thead><tbody>{page.map(({ release, owner, line }) => <tr key={`${release.inventoryLevelId}:${owner.orderId}:${owner.orderItemId}`}>
      <td>{label("order", owner.orderId)} / line {owner.orderItemId}</td>
      <td>{label("variant", release.productVariantId)} / {label("warehouse", release.warehouseId)} / {label("location", release.warehouseLocationId)} · level {release.inventoryLevelId}</td>
      <td>{owner.reservedQty}</td><td>{line?.requestedQty ?? "Not proven in the returned plan"}</td>
    </tr>)}</tbody></table>} />
  </section>;
}

function OpeningFindings({ title, rows }: { title: string; rows: Array<{ code: string; subject: string; message: string }> }) {
  if (rows.length === 0) return null;
  return <details><summary className="cursor-pointer text-sm">{title}: {rows.length}</summary>
    <OpeningRows rows={rows} render={page => <ul className="space-y-2 text-sm">{page.map((row, index) => <li className="rounded border p-2" key={`${row.subject}:${row.code}:${index}`}>
      {row.message}<p className="text-xs text-muted-foreground">{row.subject} · {row.code}</p></li>)}</ul>} />
  </details>;
}

function OpeningRows<T>({ rows, render }: { rows: readonly T[]; render(rows: readonly T[]): React.ReactNode }) {
  const [page, setPage] = useState(0);
  const visible = evidencePage(rows, page);
  return <div className="space-y-2 overflow-x-auto">{render(visible.rows)}
    {visible.totalPages > 1 && <div className="flex items-center gap-2 text-xs">
      <Button variant="outline" size="sm" disabled={visible.page === 0} onClick={() => setPage(visible.page - 1)}>Previous</Button>
      Page {visible.page + 1} of {visible.totalPages} · {rows.length} total
      <Button variant="outline" size="sm" disabled={visible.page + 1 === visible.totalPages} onClick={() => setPage(visible.page + 1)}>Next</Button>
    </div>}
  </div>;
}
