import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { purchaseOrderWorkListPageSchema } from "@shared/procurement/purchase-order-work-list";
import type { ShipmentEditorRequest } from "@shared/procurement/shipment-editor";
import { shipmentLinePackingSchema } from "@shared/procurement/shipment-line-command";
import { parseShipmentCreateSources } from "@shared/procurement/shipment-create-source";
import { ShipmentQuantityControl } from "@/components/purchasing/ShipmentQuantityControl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { financialCommandFetchJson } from "@/lib/financial-command";
import { parseShipmentUnits, shipmentQuantityDraft, shipmentQuantityPayload, type ShipmentQuantityDraft } from "@/lib/shipment-unit-entry";
import { WorkListPagination } from "./WorkListPagination";

export type AddedShipmentLine = { input: ShipmentEditorRequest["additions"][number]; label: string; poNumber: string };

export function ShipmentLineAdditions({ lines, existingPoLineIds, disabled, onChange, onDraftChange, draftAllowed = false }: {
  lines: AddedShipmentLine[]; existingPoLineIds: number[]; disabled: boolean; onChange: (lines: AddedShipmentLine[]) => void;
  onDraftChange: (pending: boolean) => void;
  draftAllowed?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  useEffect(() => { onDraftChange(adding); return () => onDraftChange(false); }, [adding, onDraftChange]);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [po, setPo] = useState<{ id: number; poNumber: string } | null>(null);
  const [lineId, setLineId] = useState<number | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const emptyPacking = { cartonCount: "", dimensionBasis: "", weightKg: "", lengthCm: "", widthCm: "", heightCm: "", notes: "" };
  const [packing, setPacking] = useState(emptyPacking);
  const [quantity, setQuantity] = useState<ShipmentQuantityDraft>({ variantId: null, unitsPerVariant: 1, quantity: "" });
  const [error, setError] = useState<string | null>(null);
  const listUrl = `/api/purchase-orders/work-list?${new URLSearchParams({ purpose: "shipment-lines", search, limit: "20", offset: String(offset) })}`;
  const list = useQuery({ queryKey: [listUrl], enabled: adding, staleTime: 0,
    queryFn: async () => purchaseOrderWorkListPageSchema.parse(await financialCommandFetchJson(listUrl, { credentials: "include" })) });
  const linesUrl = `/api/purchase-orders/${po?.id}/shippable-lines`;
  const shippable = useQuery({ queryKey: [linesUrl], enabled: adding && po !== null, staleTime: 0,
    queryFn: async () => {
      if (!po) throw new Error("Choose a purchase order before loading its lines.");
      return parseShipmentCreateSources(await financialCommandFetchJson(linesUrl, { credentials: "include" }), po.id);
    } });
  const selected = shippable.data?.lines.find(line => line.id === lineId);
  const units = parseShipmentUnits(selected?.shipmentUnits);

  function add() {
    try {
      if (!po || !selected) throw new Error("Choose a purchase order and line.");
      const payload = shipmentQuantityPayload(quantity, units, selected.remainingQty);
      if (!payload.unitSelection && !draftAllowed) throw new Error("Choose a configured counting unit so its pieces per unit can be verified.");
      const packingValues = shipmentLinePackingSchema.parse(Object.fromEntries(Object.entries(packing).filter(([, value]) => value !== "")
        .map(([field, value]) => [field, field === "cartonCount" ? /^\d+$/.test(value) ? Number(value) : NaN : value])));
      const next = { input: { clientKey: editingKey ?? crypto.randomUUID(), purchaseOrderId: po.id, purchaseOrderLineId: selected.id,
        quantityPieces: payload.qtyShipped, ...(payload.unitSelection ? { unitSelection: payload.unitSelection } : {}), ...(Object.keys(packingValues).length ? { packing: packingValues } : {}) },
        label: selected.productName ?? selected.sku ?? `Line ${selected.id}`, poNumber: po.poNumber };
      onChange(editingKey ? lines.map(line => line.input.clientKey === editingKey ? next : line) : [...lines, next]);
      setAdding(false); setEditingKey(null); setLineId(null); setPacking(emptyPacking); setError(null);
    } catch (cause) { setError(cause instanceof z.ZodError ? cause.issues.map(issue => issue.message).join(" ") : cause instanceof Error ? cause.message : "Review the new shipment line."); }
  }
  return <section aria-label="New shipment lines" className="space-y-3">
    {lines.map(line => <div key={line.input.clientKey} className="flex flex-wrap items-center gap-3 rounded border border-green-600 p-2 text-sm">
      <span className="font-medium">Added · {line.poNumber} · {line.label}</span>
      <span>{line.input.quantityPieces.toLocaleString()} pieces</span>
      <Button variant="outline" size="sm" disabled={disabled || adding} onClick={() => {
        setEditingKey(line.input.clientKey); setPo({ id: line.input.purchaseOrderId, poNumber: line.poNumber }); setLineId(line.input.purchaseOrderLineId);
        const selection = line.input.unitSelection;
        setQuantity(selection ? { variantId: selection.productVariantId, unitsPerVariant: selection.unitsPerVariant, quantity: String(selection.quantity) }
          : shipmentQuantityDraft(line.input.quantityPieces, null));
        setPacking({ ...emptyPacking, ...Object.fromEntries(Object.entries(line.input.packing ?? {}).map(([field, value]) => [field, value == null ? "" : String(value)])) }); setAdding(true);
      }}>Edit new line</Button>
      <Button variant="outline" size="sm" disabled={disabled || adding} onClick={() => onChange(lines.filter(row => row.input.clientKey !== line.input.clientKey))}>Remove new line</Button>
    </div>)}
    {!adding && <Button variant="outline" disabled={disabled} onClick={() => setAdding(true)}>Add PO line</Button>}
    {adding && <fieldset disabled={disabled} className="space-y-3 rounded border p-3">
      <Label htmlFor="shipment-po-search">Find purchase order</Label>
      <Input id="shipment-po-search" value={search} onChange={event => { setSearch(event.target.value); setOffset(0); }} placeholder="PO number" />
      {list.isPending && <p>Loading purchase orders…</p>}
      {list.error && <p role="alert">Purchase orders could not be loaded. <Button variant="outline" onClick={() => void list.refetch()}>Retry purchase orders</Button></p>}
      <Label htmlFor="shipment-add-po">Purchase order</Label>
      <select id="shipment-add-po" className="w-full rounded border bg-background p-2" value={po?.id ?? ""} onChange={event => {
        setPo(list.data?.items.find(row => row.id === Number(event.target.value)) ?? null); setLineId(null);
      }}><option value="">Choose a PO</option>
        {po && !list.data?.items.some(row => row.id === po.id) && <option value={po.id}>{po.poNumber}</option>}
        {list.data?.items.map(row => <option key={row.id} value={row.id}>{row.poNumber}</option>)}
      </select>
      <WorkListPagination page={list.data} busy={list.isFetching} onOffset={setOffset} label="purchase orders" />
      {po && <><Label htmlFor="shipment-add-line">PO line</Label>
        <select id="shipment-add-line" className="w-full rounded border bg-background p-2" value={lineId ?? ""} onChange={event => {
          const row = shippable.data?.lines.find(value => value.id === Number(event.target.value));
          setLineId(row?.id ?? null); setQuantity(shipmentQuantityDraft(row?.remainingQty ?? 0, parseShipmentUnits(row?.shipmentUnits)));
        }}><option value="">Choose a line</option>{shippable.data?.lines.filter(row => row.remainingQty > 0 && !existingPoLineIds.includes(row.id) && !lines.some(added => added.input.purchaseOrderLineId === row.id && added.input.clientKey !== editingKey)).map(row =>
          <option key={row.id} value={row.id}>{row.sku ?? row.productName ?? `Line ${row.id}`} · {row.remainingQty.toLocaleString()} pieces available</option>)}</select>
        {shippable.isPending && <p>Loading remaining quantities…</p>}
        {shippable.error && <p role="alert">Remaining quantities could not be loaded. <Button variant="outline" onClick={() => void shippable.refetch()}>Retry lines</Button></p>}
        {shippable.data?.reviewRequiredLines.map(row => <p key={row.id} className="text-sm text-amber-800">Line {row.id}: {row.error}</p>)}
        <p className="text-xs text-muted-foreground">Lines already on this shipment can be edited in the table above.</p>
      </>}
      {selected && <ShipmentQuantityControl id="new-shipment-line" value={quantity} units={units} draftAllowed={draftAllowed} productName={selected.productName ?? selected.sku ?? "Product"} maximumPieces={selected.remainingQty} onChange={setQuantity} />}
      {selected && <details><summary className="cursor-pointer text-sm">Shipping cartons, measurements and notes</summary>
        <p className="my-2 text-xs text-muted-foreground">Enter packing measurements when allocating charges by weight or volume.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <div><Label htmlFor="new-shipping-cartons">Shipping cartons</Label><Input id="new-shipping-cartons" inputMode="numeric" value={packing.cartonCount} onChange={event => setPacking(value => ({ ...value, cartonCount: event.target.value }))} /></div>
          <div><Label htmlFor="new-measurement-basis">Measurements per</Label><select id="new-measurement-basis" className="w-full rounded border bg-background p-2" value={packing.dimensionBasis} onChange={event => setPacking(value => ({ ...value, dimensionBasis: event.target.value }))}><option value="">Choose a basis</option><option value="carton">Shipping carton</option><option value="piece">Piece</option></select></div>
          {([['weightKg', 'Weight (kg)'], ['lengthCm', 'Length (cm)'], ['widthCm', 'Width (cm)'], ['heightCm', 'Height (cm)']] as const).map(([field, label]) => <div key={field}><Label htmlFor={`new-${field}`}>{label}</Label><Input id={`new-${field}`} inputMode="decimal" value={packing[field]} onChange={event => setPacking(value => ({ ...value, [field]: event.target.value }))} /></div>)}
          <div className="sm:col-span-3"><Label htmlFor="new-shipment-notes">Line notes</Label><Input id="new-shipment-notes" maxLength={10000} value={packing.notes} onChange={event => setPacking(value => ({ ...value, notes: event.target.value }))} /></div>
        </div>
      </details>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <div className="flex gap-2"><Button disabled={!selected} onClick={add}>{editingKey ? "Update new line" : "Add to this edit"}</Button><Button variant="outline" onClick={() => { setAdding(false); setEditingKey(null); }}>Cancel new line</Button></div>
    </fieldset>}
  </section>;
}
