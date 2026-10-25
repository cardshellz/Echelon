import { SupplierCreditLink } from "@/features/purchasing/SupplierCreditLink";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { type ReceivingQuarantineView } from "@shared/procurement/receiving-quarantine";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { filterActionableWarehouseLocations, type WarehouseLocationLike } from "@/lib/warehouse-locations";
import {
  createReceivingCustodyStore, acquireReceivingCustodyAttempt, executeReceivingCustodyAttempt,
  readReceivingQuarantine, ReceivingCustodyRequestError, type ReceivingCustodyAttempt,
} from "@/lib/receiving-quarantine-client";
import {
  QuarantineIntakeForm, QuarantineResolutionForm,
  type QuarantineFormCommand, type QuarantineReceiptLine, type QuarantineResolutionSelection,
} from "./ReceivingQuarantineForms";

interface Props {
  receipt: { id: number; status: string; warehouseId: number | null; lines?: QuarantineReceiptLine[] };
  locations: readonly WarehouseLocationLike[];
  disabled: boolean;
  onCommandPendingChange(blocked: boolean): void;
  onAcceptAllCapabilityChange(capability: { allowed: boolean; reason: string | null }): void;
  onReceiptChanged(): Promise<void>;
}

export function ReceivingQuarantinePanel({ receipt, locations, disabled, onCommandPendingChange, onAcceptAllCapabilityChange, onReceiptChanged }: Props) {
  const { user } = useAuth();
  const store = useMemo(() => user?.id ? createReceivingCustodyStore(receipt.id, user.id) : null, [receipt.id, user?.id]);
  const activeStore = useRef(store);
  activeStore.current = store;
  const [view, setView] = useState<ReceivingQuarantineView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<ReceivingCustodyAttempt | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [definitelyRejected, setDefinitelyRejected] = useState(false);
  const [showIntake, setShowIntake] = useState(false);
  const [resolution, setResolution] = useState<QuarantineResolutionSelection | null>(null);
  const alive = useRef(true);
  const commandRunning = useRef(false);
  const scope = receipt.id;

  useEffect(() => {
    alive.current = true;
    try {
      setStorageError(null); setCommandError(null); setDefinitelyRejected(false); setSuccess(null); setRunning(false);
      if (!store) throw new Error("Sign in before recovering quarantine custody.");
      const saved = store.read();
      setAttempt(saved);
      if (saved) setCommandError("A previous quarantine command needs confirmation. Retry the saved command before recording another change.");
    } catch (cause) {
      setAttempt(null);
      setStorageError(cause instanceof Error ? cause.message : "The saved quarantine command could not be read safely.");
    }
    return () => { alive.current = false; };
  }, [scope, store]);

  useEffect(() => {
    const blocked = running || attempt !== null || storageError !== null;
    onCommandPendingChange(blocked);
    return () => onCommandPendingChange(false);
  }, [running, attempt, storageError, onCommandPendingChange]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setLoadError(null);
    onAcceptAllCapabilityChange({ allowed: false, reason: "Loading quarantine custody before accepting all quantities." });
    void readReceivingQuarantine(scope, controller.signal).then((current) => {
      if (controller.signal.aborted) return;
      setView(current); onAcceptAllCapabilityChange(current.canAcceptAll);
    }).catch((cause) => {
      if (controller.signal.aborted) return;
      const message = cause instanceof Error ? cause.message : "Could not load quarantine custody.";
      setLoadError(message); onAcceptAllCapabilityChange({ allowed: false, reason: message });
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [scope, store, receipt.status, receipt.warehouseId, receipt.lines, onAcceptAllCapabilityChange]);

  const putawayLocations = receipt.warehouseId === null ? [] : filterActionableWarehouseLocations([...locations], { warehouseId: receipt.warehouseId });
  // External availability slots cannot identify where physically held goods are.
  const holdingLocations = putawayLocations.filter((location) => location.locationType !== "3pl_virtual");
  const locked = !store || disabled || loading || loadError !== null || running || attempt !== null || storageError !== null;

  async function refreshSources(): Promise<void> {
    const capturedStore = store;
    const current = await readReceivingQuarantine(scope);
    if (!alive.current || activeStore.current !== capturedStore) return;
    await onReceiptChanged();
    if (!alive.current || activeStore.current !== capturedStore) return;
    setView(current); setLoadError(null); onAcceptAllCapabilityChange(current.canAcceptAll);
  }

  async function run(command: ReceivingCustodyAttempt) {
    if (commandRunning.current || !store || activeStore.current !== store) return;
    const capturedStore = store;
    commandRunning.current = true; setRunning(true); setCommandError(null); setSuccess(null);
    setDefinitelyRejected(false);
    let commandConfirmed = false;
    try {
      // Persist before sending: a navigation or lost response must retain the
      // same immutable intent and key, including after this panel unmounts.
      setAttempt(command);
      const result = await executeReceivingCustodyAttempt(store, command);
      commandConfirmed = true;
      if (!alive.current || activeStore.current !== capturedStore) return;
      setAttempt(null); setShowIntake(false); setResolution(null);
      await refreshSources();
      if (!alive.current || activeStore.current !== capturedStore) return;
      setAttempt(store.read());
      setSuccess(command.body.command === "prepare-acceptance"
        ? `Pending acceptance prepared on ${result.acceptance?.receiptNumber}. Goods stay unavailable until that receipt is finalized.`
        : command.body.command === "cancel-acceptance" ? "Pending acceptance cancelled. The goods remain held in quarantine."
          : command.body.command === "return" ? "Physical return recorded. This does not record a supplier credit or payment recovery."
            : "Held goods recorded in quarantine and unavailable for sale.");
    } catch (cause) {
      if (!alive.current || activeStore.current !== capturedStore) return;
      const message = cause instanceof Error ? cause.message : "The quarantine outcome could not be confirmed.";
      setCommandError(message);
      if (commandConfirmed) setLoadError("The quarantine command was confirmed, but the latest receipt could not be loaded. Reload custody before another change.");
      setDefinitelyRejected(!commandConfirmed && cause instanceof ReceivingCustodyRequestError && !cause.outcomeUnknown);
    } finally {
      commandRunning.current = false;
      if (alive.current && activeStore.current === capturedStore) setRunning(false);
    }
  }

  function submit(command: QuarantineFormCommand) {
    if (locked) return;
    try { if (!store) return; void run(acquireReceivingCustodyAttempt(store, scope, command.observationId, command.path, command.body)); }
    catch (cause) { setCommandError(cause instanceof Error ? cause.message : "Could not prepare the quarantine command."); }
  }

  async function reloadRejected() {
    if (!definitelyRejected || commandRunning.current || !store) return;
    const capturedStore = store;
    setRunning(true); commandRunning.current = true;
    try {
      await refreshSources();
      if (!alive.current || activeStore.current !== capturedStore) return;
      setAttempt(store.read()); setDefinitelyRejected(false); setCommandError(null); setResolution(null); setShowIntake(false);
    } catch (cause) { if (alive.current && activeStore.current === capturedStore) setCommandError(cause instanceof Error ? cause.message : "Could not verify the latest receipt and custody."); }
    finally { commandRunning.current = false; if (alive.current && activeStore.current === capturedStore) setRunning(false); }
  }

  return <Card data-testid="receiving-quarantine-panel">
    <CardHeader className="pb-3"><CardTitle className="text-base">Quarantine custody</CardTitle>
      <p className="text-sm text-muted-foreground">Damaged or unexpected goods are held separately and unavailable for sale until an explicit resolution and receipt acceptance.</p>
    </CardHeader>
    <CardContent className="space-y-4">
      {loading && <p role="status" className="text-sm">Loading quarantine custody…</p>}
      {loadError && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{loadError}</p><Button type="button" variant="outline" onClick={() => {
        const capturedStore = store;
        setLoading(true);
        void refreshSources().catch(cause => { if (alive.current && activeStore.current === capturedStore) setLoadError(cause instanceof Error ? cause.message : "Receipt readback failed."); })
          .finally(() => { if (alive.current && activeStore.current === capturedStore) setLoading(false); });
      }}>Reload quarantine custody</Button></div>}
      {storageError && <p role="alert" className="text-sm text-destructive">{storageError}</p>}
      {commandError && <div role="alert" className="space-y-2 rounded border border-destructive/40 p-3 text-sm"><p>{commandError}</p>
        {attempt && <div className="flex flex-wrap gap-2">{!definitelyRejected && <Button type="button" variant="outline" disabled={running || !store} onClick={() => void run(attempt)}>Retry saved quarantine command</Button>}
          {definitelyRejected && <Button type="button" variant="outline" disabled={running || disabled} onClick={() => void reloadRejected()}>Load latest receipt and review rejected command</Button>}</div>}
      </div>}
      {success && <p role="status" className="text-sm font-medium">{success}</p>}
      {running && <p role="status" className="text-sm">Saving quarantine command and verifying receipt…</p>}
      {view && <>
        <div className="space-y-1"><Button type="button" variant="outline" disabled={locked || !view.canRecord.allowed || showIntake || resolution !== null} onClick={() => { setShowIntake(true); setSuccess(null); }}>Record quarantine</Button>
          {!view.canRecord.allowed && <p className="text-sm text-muted-foreground">{view.canRecord.reason}</p>}
        </div>
        {showIntake && <QuarantineIntakeForm receiptId={scope} lines={receipt.lines ?? []} allowKnownLine={!["closed", "cancelled"].includes(receipt.status)} locations={holdingLocations} disabled={locked} onSubmit={submit} onCancel={() => setShowIntake(false)} />}
        {view.observations.length === 0 && <p className="text-sm text-muted-foreground">No quarantine custody recorded for this receipt.</p>}
        {view.observations.map((observation) => <section key={observation.id} aria-label={`Quarantine observation ${observation.id}`} className="space-y-3 rounded border p-3">
          <div className="flex flex-wrap items-start justify-between gap-2"><h4 className="font-medium">{observation.description}</h4><Badge variant="outline">{observation.physicalHeldQty} {observation.unitLabel} held</Badge></div>
          <p className="text-sm">{observation.observedSku ? `${observation.observedSku} · ` : ""}{observation.condition} · {observation.holdingLocationLabel}</p>
          {observation.receivingOrderId !== scope && <p className="text-sm">Recorded on receipt #{observation.receivingOrderId}. <Link className="underline" href={`/receiving?open=${observation.receivingOrderId}`}>Resolve custody on receipt #{observation.receivingOrderId}</Link></p>}
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm sm:grid-cols-4">
            <div><dt className="text-muted-foreground">Needs resolution</dt><dd>{observation.unallocatedQty}</dd></div>
            <div><dt className="text-muted-foreground">Awaiting receipt</dt><dd>{observation.awaitingReceiptQty}</dd></div>
            <div><dt className="text-muted-foreground">Received</dt><dd>{observation.receivedQty}</dd></div>
            <div><dt className="text-muted-foreground">Returned</dt><dd>{observation.returnedQty}</dd></div>
          </dl>
          <p className="break-words text-xs text-muted-foreground">{observation.reason} · Evidence: {observation.evidenceReference}</p>
          {observation.receivingOrderId === scope && <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={locked || !observation.canPrepareAcceptance.allowed || showIntake || resolution !== null} onClick={() => setResolution({ observation, kind: "prepare-acceptance" })}>Prepare acceptance</Button>
            <Button type="button" size="sm" variant="outline" disabled={locked || !observation.canReturn.allowed || showIntake || resolution !== null} onClick={() => setResolution({ observation, kind: "return" })}>Record physical return</Button>
          </div>}
          {!observation.canPrepareAcceptance.allowed && observation.canPrepareAcceptance.reason && <p className="text-xs text-muted-foreground">Acceptance: {observation.canPrepareAcceptance.reason}</p>}
          {!observation.canReturn.allowed && observation.canReturn.reason && <p className="text-xs text-muted-foreground">Return: {observation.canReturn.reason}</p>}
          {observation.acceptances.map((acceptance) => <div key={acceptance.id} className="space-y-1 border-t pt-2 text-sm">
            <p><Link className="underline" href={`/receiving?open=${acceptance.receivingOrderId}`}>{acceptance.receiptNumber}</Link>: {acceptance.observationQty} {observation.unitLabel} mapped to {acceptance.acceptedVariantQty} receive units · {acceptance.status.replaceAll("_", " ")}</p>
            {acceptance.status === "awaiting_receipt" && <><p className="text-xs text-muted-foreground">Still held and unavailable until this receipt is finalized.</p>{observation.receivingOrderId === scope && <Button type="button" size="sm" variant="outline" disabled={locked || !acceptance.canCancel.allowed || showIntake || resolution !== null} onClick={() => setResolution({ observation, kind: "cancel-acceptance", acceptanceId: acceptance.id })}>Cancel pending acceptance</Button>}{!acceptance.canCancel.allowed && <p className="text-xs text-muted-foreground">{acceptance.canCancel.reason}</p>}</>}
          </div>)}
          {resolution?.observation.id === observation.id && observation.receivingOrderId === scope && <QuarantineResolutionForm key={`${observation.id}:${resolution.kind}:${resolution.acceptanceId ?? ""}`} receiptId={scope} selection={resolution} locations={putawayLocations} disabled={locked} onSubmit={submit} onCancel={() => setResolution(null)} />}
          {observation.dispositions.filter(item => item.kind === "return").map(item => <div key={`credit-${item.id}`} className="text-sm"><SupplierCreditLink returnDispositionId={item.id} create>Review supplier credit for return #{item.id}</SupplierCreditLink><p className="text-xs text-muted-foreground">Physical return is recorded. Select its original invoice and supplier credit document to review financial settlement separately.</p></div>)}
          <details className="text-xs"><summary className="cursor-pointer">Custody history</summary><ol className="mt-2 space-y-1">
            <li>Observed {observation.observedQty} {observation.unitLabel} by {observation.actorId} at {observation.recordedAt}</li>
            {observation.dispositions.map((item) => <li key={item.id} className="break-words">{item.kind.replaceAll("_", " ")} · {item.observationQty} {observation.unitLabel} · {item.actorId} · {item.recordedAt} · {item.reason}{item.evidenceReference ? ` · ${item.evidenceReference}` : ""}</li>)}
          </ol></details>
        </section>)}
      </>}
    </CardContent>
  </Card>;
}
