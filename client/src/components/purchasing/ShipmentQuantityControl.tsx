import React from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { ReceiveUnitSelect } from "@/components/purchasing/ReceiveUnitSelect";
import { selectShipmentQuantityUnit, shipmentQuantityPreview, type ShipmentQuantityDraft } from "@/lib/shipment-unit-entry";
import type { ShipmentUnits } from "@shared/procurement/shipment-unit-selection";

export function ShipmentQuantityControl({ id, value, units, disabled, maximumPieces, quantityLabel, onChange }: {
  id: string;
  value: ShipmentQuantityDraft;
  units: ShipmentUnits | null;
  disabled?: boolean;
  maximumPieces?: number;
  quantityLabel?: string;
  onChange: (value: ShipmentQuantityDraft) => void;
}) {
  const preview = shipmentQuantityPreview(value, units, maximumPieces);
  const selected = units?.variants.find((variant) => variant.id === value.variantId);
  const pieceVariant = units?.variants.filter((variant) => variant.unitsPerVariant === 1).sort((a, b) => a.id - b.id)[0];
  const options = (units?.variants ?? []).filter((variant) => variant.unitsPerVariant !== 1 || variant.id === pieceVariant?.id)
    .map((variant) => variant.id === pieceVariant?.id ? { ...variant, name: "Pieces" } : variant);
  return <div className="min-w-0 space-y-3" aria-label={`Quantity entry ${id}`}>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div className="min-w-0 space-y-1">
        <Label htmlFor={`${id}-unit`}>Count in</Label>
        <ReceiveUnitSelect id={`${id}-unit`} label={`Count unit ${id}`} value={value.variantId}
          options={options} disabled={disabled} piecesOption={!pieceVariant}
          emptyLabel={pieceVariant ? "Base pieces (unit not recorded)" : "Base pieces (no configured piece unit)"}
          onChange={(variantId) => onChange(selectShipmentQuantityUnit(value, variantId, units))} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-quantity`}>{selected && selected.unitsPerVariant !== 1 ? "Number of receive units" : quantityLabel ?? "Pieces shipped"}</Label>
        <Input id={`${id}-quantity`} inputMode="numeric" autoComplete="off"
          value={value.quantity} disabled={disabled} onChange={(event) => onChange({ ...value, quantity: event.target.value })} />
      </div>
    </div>
    <div aria-live="polite" className="rounded border bg-muted/20 p-3 text-sm">
      {preview.pieces !== null
        ? <p className="font-medium">{value.variantId === null ? "" : `${value.quantity} × ${value.unitsPerVariant.toLocaleString("en-US")} pieces = `}{preview.pieces.toLocaleString("en-US")} pieces shipped</p>
        : <p role="alert" className="text-destructive">{preview.error}</p>}
      {maximumPieces !== undefined && <p className="text-xs text-muted-foreground">{maximumPieces.toLocaleString("en-US")} pieces available</p>}
    </div>
    {units?.issue && <p className="text-xs text-amber-800 dark:text-amber-200">{units.issue.message}</p>}
    {!units && <p className="text-xs text-muted-foreground">Configured receive units could not be verified. This quantity is recorded in pieces.</p>}
    <p className="text-xs text-muted-foreground">Selecting a unit preserves the piece total when conversion is exact. A blank count requires a new explicit quantity. Shipping cartons and dimensions stay unchanged.</p>
  </div>;
}
