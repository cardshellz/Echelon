import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "wouter";
import {
  cancelQuarantineAcceptanceSchema, prepareQuarantineAcceptanceSchema,
  receivingQuarantineAcceptanceOptionsSchema, receivingQuarantineIntakeSchema,
  returnQuarantineCustodySchema,
  type ReceivingQuarantineAcceptanceOption, type ReceivingQuarantineObservation,
} from "@shared/procurement/receiving-quarantine";
import { InventoryLocationCombobox } from "@/components/inventory/InventoryLocationCombobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { WarehouseLocationLike } from "@/lib/warehouse-locations";

export interface QuarantineReceiptLine {
  id: number;
  sku: string | null;
  productName: string | null;
  unitVersion?: string;
  unitsPerVariantSnapshot?: number | null;
  damagedQty: number;
}
export interface QuarantineFormCommand { observationId: number | null; path: string; body: unknown }
interface FormProps {
  receiptId: number;
  locations: readonly WarehouseLocationLike[];
  disabled: boolean;
  onSubmit(command: QuarantineFormCommand): void;
  onCancel(): void;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block space-y-1 text-sm"><span className="font-medium">{label}</span>{children}</label>;
}
const count = (value: string) => value.trim() === "" ? Number.NaN : Number(value);
const selectClass = "h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm";

export function QuarantineIntakeForm({ receiptId, lines, allowKnownLine, locations, disabled, onSubmit, onCancel }: FormProps & {
  lines: readonly QuarantineReceiptLine[]; allowKnownLine: boolean;
}) {
  const [kind, setKind] = useState<"receipt_line" | "unidentified">("unidentified");
  const [lineId, setLineId] = useState("");
  const [condition, setCondition] = useState("unexpected");
  const [locationId, setLocationId] = useState<number | null>(null);
  const [acceptedQty, setAcceptedQty] = useState("");
  const [heldQty, setHeldQty] = useState("");
  const [unitLabel, setUnitLabel] = useState("");
  const [description, setDescription] = useState("");
  const [sku, setSku] = useState("");
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = lines.find((line) => line.id === Number(lineId));

  function submit(event: FormEvent) {
    event.preventDefault();
    const common = { condition, holdingLocationId: locationId, reason, evidenceReference: reference };
    const parsed = receivingQuarantineIntakeSchema.safeParse(kind === "receipt_line" ? {
      ...common, kind, receivingLineId: Number(lineId), expectedUnitVersion: selected?.unitVersion,
      acceptedQty: count(acceptedQty), heldQty: count(heldQty), countsReviewed: reviewed,
    } : { ...common, kind, quantity: count(heldQty), unitLabel, description, observedSku: sku.trim() || null });
    if (!parsed.success) { setError("Complete the quantity, unit, location, reason and evidence fields. Confirm both counts when recording a receipt line."); return; }
    setError(null);
    onSubmit({ observationId: null, path: `/api/receiving/${receiptId}/quarantine`, body: parsed.data });
  }

  return <form onSubmit={submit} className="space-y-3 rounded border p-3" aria-label="Record quarantine">
    <fieldset disabled={disabled} className="space-y-3 min-w-0">
      <Field label="Goods being held"><select aria-label="Goods being held" className={selectClass} value={kind} onChange={(event) => { setKind(event.target.value as typeof kind); setReviewed(false); }}>
        <option value="unidentified">Unexpected or unidentified goods</option>
        {allowKnownLine && <option value="receipt_line">Goods on this receipt line</option>}
      </select></Field>
      {kind === "receipt_line" ? <>
        <Field label="Receipt line"><select aria-label="Receipt line" className={selectClass} value={lineId} onChange={(event) => { setLineId(event.target.value); setAcceptedQty(""); setHeldQty(""); setReviewed(false); }}>
          <option value="">Select the observed line</option>
          {lines.map((line) => <option key={line.id} value={line.id}>{line.sku || `Line ${line.id}`} — {line.productName}</option>)}
        </select></Field>
        {selected && <p className="text-sm">Recorded receive unit: {selected.unitsPerVariantSnapshot ?? "unconfirmed"} pieces per unit. Existing damaged count: {selected.damagedQty}. Recount the accepted and held goods separately.</p>}
        <Field label="Accepted receive units"><Input inputMode="numeric" value={acceptedQty} onChange={(event) => setAcceptedQty(event.target.value)} placeholder="Enter the actual accepted count" /></Field>
        <Field label="Held receive units"><Input inputMode="numeric" value={heldQty} onChange={(event) => setHeldQty(event.target.value)} placeholder="Enter the separate held count" /></Field>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />I recounted both groups in the recorded receive unit. Accepted goods exclude these held goods.</label>
      </> : <>
        <Field label="Goods description"><Input value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} /></Field>
        <Field label="Observed SKU or barcode (optional)"><Input value={sku} maxLength={200} onChange={(event) => setSku(event.target.value)} /></Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Observed held quantity"><Input inputMode="numeric" value={heldQty} onChange={(event) => setHeldQty(event.target.value)} /></Field>
          <Field label="Observed unit"><Input value={unitLabel} maxLength={80} placeholder="For example, sealed cartons" onChange={(event) => setUnitLabel(event.target.value)} /></Field>
        </div>
        <p className="text-xs text-muted-foreground">Record the unit you observed. Product identity, contents and cost can be reviewed later.</p>
      </>}
      <Field label="Condition"><select aria-label="Condition" className={selectClass} value={condition} onChange={(event) => setCondition(event.target.value)}><option value="unexpected">Unexpected</option><option value="damaged">Damaged</option><option value="other">Other</option></select></Field>
      <div className="space-y-1"><p className="text-sm font-medium">Holding location</p><InventoryLocationCombobox locations={locations} value={locationId} onValueChange={setLocationId} disabled={disabled} ariaLabel="Quarantine holding location" /></div>
      <Field label="Reason for holding"><Textarea value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} /></Field>
      <Field label="Observation evidence reference"><Input value={reference} maxLength={200} placeholder="Inspection record, photo reference or delivery note" onChange={(event) => setReference(event.target.value)} /></Field>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2"><Button type="submit">Record held goods</Button><Button type="button" variant="outline" onClick={onCancel}>Cancel</Button></div>
    </fieldset>
  </form>;
}

export type QuarantineResolutionSelection = { observation: ReceivingQuarantineObservation; kind: "prepare-acceptance" | "return" | "cancel-acceptance"; acceptanceId?: number };

export function QuarantineResolutionForm({ receiptId, selection, locations, disabled, onSubmit, onCancel }: FormProps & { selection: QuarantineResolutionSelection }) {
  const { observation, kind } = selection;
  const [quantity, setQuantity] = useState("");
  const [acceptedQty, setAcceptedQty] = useState("");
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [locationId, setLocationId] = useState<number | null>(null);
  const [options, setOptions] = useState<ReceivingQuarantineAcceptanceOption[]>([]);
  const [target, setTarget] = useState("");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<number | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const chosen = options.find((option) => String(option.receivingLineId) === target);

  async function loadOptions(nextCursor: number | null) {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoadingOptions(true); setError(null);
    if (nextCursor === null) { setOptions([]); setTarget(""); setCursor(null); setReviewed(false); }
    try {
      const params = new URLSearchParams({ q: query });
      if (nextCursor !== null) params.set("cursor", String(nextCursor));
      const response = await fetch(`/api/receiving/${receiptId}/quarantine/acceptance-options?${params}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Could not load receipt source options (HTTP ${response.status}).`);
      const parsed = receivingQuarantineAcceptanceOptionsSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("Receipt source options were incomplete. Reload them before accepting goods.");
      if (controller.signal.aborted) return;
      setOptions((current) => nextCursor === null ? parsed.data.items : [...current, ...parsed.data.items.filter((item) => !current.some((prior) => prior.receivingLineId === item.receivingLineId))]);
      setCursor(parsed.data.nextCursor);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load receipt source options."); }
    finally { if (!controller.signal.aborted) setLoadingOptions(false); }
  }
  useEffect(() => {
    if (kind === "prepare-acceptance") void loadOptions(null);
    return () => request.current?.abort();
  }, [kind, receiptId]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const base = { expectedVersion: observation.version, reason };
    const parsed = kind === "return" ? returnQuarantineCustodySchema.safeParse({ ...base, observationQty: count(quantity), evidenceReference: reference })
      : kind === "cancel-acceptance" ? cancelQuarantineAcceptanceSchema.safeParse({ ...base, acceptanceId: selection.acceptanceId })
        : prepareQuarantineAcceptanceSchema.safeParse({ ...base, observationQty: count(quantity),
          targetSourceReceivingLineId: chosen?.receivingLineId, expectedTargetUnitVersion: chosen?.unitVersion,
          targetReceivingOrderId: chosen?.targetReceivingOrderId, productVariantId: chosen?.productVariantId,
          expectedUnitsPerVariant: chosen?.unitsPerVariant, acceptedVariantQty: count(acceptedQty),
          purchaseOrderLineId: chosen?.purchaseOrderLineId, inboundShipmentLineId: chosen?.inboundShipmentLineId,
          putawayLocationId: locationId, countConversionReviewed: reviewed });
    if (!parsed.success) { setError("Complete the resolution details and explicitly confirm the quantity and unit mapping when preparing acceptance."); return; }
    setError(null);
    onSubmit({ observationId: observation.id, path: `/api/receiving/quarantine/${observation.id}/${kind}`, body: parsed.data });
  }

  const title = kind === "prepare-acceptance" ? "Prepare receipt acceptance" : kind === "return" ? "Record physical return" : "Cancel pending acceptance";
  return <form onSubmit={submit} className="space-y-3 rounded border p-3" aria-label={title}>
    <h4 className="font-medium">{title}: {observation.description}</h4>
    <fieldset disabled={disabled} className="space-y-3 min-w-0">
      {kind !== "cancel-acceptance" && <Field label={`Observed quantity to ${kind === "return" ? "return" : "accept"} (${observation.unitLabel})`}><Input inputMode="numeric" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></Field>}
      {kind === "prepare-acceptance" && <>
        <div className="flex gap-2"><Input aria-label="Search receipt sources" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search receipt or SKU" /><Button type="button" variant="outline" disabled={loadingOptions} onClick={() => void loadOptions(null)}>Search</Button></div>
        <Field label="Reviewed receipt source"><select aria-label="Reviewed receipt source" className={selectClass} disabled={loadingOptions} value={target} onChange={(event) => { setTarget(event.target.value); setReviewed(false); setLocationId(null); }}>
          <option value="">Select the source and receive unit</option>
          {options.map((option) => <option key={option.receivingLineId} value={option.receivingLineId}>{option.receiptNumber} — {option.sku || option.productName} — {option.unitsPerVariant} pieces/unit (line {option.receivingLineId})</option>)}
        </select></Field>
        {loadingOptions && <p role="status" className="text-sm">Loading receipt sources…</p>}
        {cursor !== null && <Button type="button" variant="outline" disabled={loadingOptions} onClick={() => void loadOptions(cursor)}>Load more receipt sources</Button>}
        <p className="text-xs text-muted-foreground">If the goods have no correct source here, <Link href="/receiving" className="underline">open receiving</Link>, add them to the correct normal receipt and review its source and unit. Then search again.</p>
        {chosen && <p className="text-sm">Selected receive unit: {chosen.unitsPerVariant} pieces. {chosen.targetReceivingOrderId === null ? "Acceptance will be prepared against this receipt source." : `Acceptance will be prepared on ${chosen.receiptNumber}.`}</p>}
        <Field label="Accepted quantity in the selected receive unit"><Input inputMode="numeric" value={acceptedQty} onChange={(event) => setAcceptedQty(event.target.value)} /></Field>
        <div className="space-y-1"><p className="text-sm font-medium">Accepted goods putaway location</p><InventoryLocationCombobox locations={locations} value={locationId} onValueChange={setLocationId} disabled={disabled} ariaLabel="Accepted goods putaway location" /></div>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />I verified the observed quantity, product, source and exact mapping to the selected receive unit.</label>
        <p className="text-sm">These goods stay held and unavailable for sale until the normal receipt is finalized successfully.</p>
      </>}
      {kind === "return" && <><Field label="Physical return evidence reference"><Input value={reference} maxLength={200} onChange={(event) => setReference(event.target.value)} /></Field><p className="text-sm">Record goods that physically left custody. Supplier credit or payment recovery must be handled separately.</p></>}
      {kind === "cancel-acceptance" && <p className="text-sm">Cancel the pending receipt allocation. The goods remain physically held in quarantine.</p>}
      <Field label="Resolution reason"><Textarea value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} /></Field>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2"><Button type="submit" disabled={loadingOptions}>{title}</Button><Button type="button" variant="outline" onClick={onCancel}>Cancel</Button></div>
    </fieldset>
  </form>;
}
