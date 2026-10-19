import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShipmentQuantityControl } from "@/components/purchasing/ShipmentQuantityControl";
import { packingListQuantityDraft, type PackingListRow } from "@/lib/shipment-packing-list";
import { shipmentQuantityPreview, type ShipmentQuantityDraft } from "@/lib/shipment-unit-entry";
import { shipmentUnitSelectionSchema, type ShipmentUnits } from "@shared/procurement/shipment-unit-selection";

export function PackingListPreview({ rows, errors, unitOptions, onChange, onQuantityChange }: {
  rows: PackingListRow[];
  errors: Array<{ row: number; error: string }>;
  unitOptions: ReadonlyArray<{ row: number; units: ShipmentUnits }>;
  onChange: (index: number, field: string, value: string) => void;
  onQuantityChange: (index: number, draft: ShipmentQuantityDraft, units: ShipmentUnits | null) => void;
}) {
  const errorsByRow = new Map(errors.map((failure) => [failure.row, failure.error]));
  return <div role="region" aria-label="Packing list rows" tabIndex={0} className="max-h-[55dvh] min-w-0 overflow-y-auto space-y-3">
    {rows.map((row, index) => {
      const units = unitOptions.find((option) => option.row === index + 1)?.units ?? null;
      const draft = packingListQuantityDraft(row);
      const preview = shipmentQuantityPreview(draft, units);
      const invalidUnit = row.unitSelection !== undefined && !shipmentUnitSelectionSchema.safeParse(row.unitSelection).success;
      const mismatch = row.unitSelection !== undefined && preview.pieces !== null && row.qtyShipped !== preview.pieces;
      const field = (name: string, label: string) => <div key={name} className="space-y-1">
        <Label htmlFor={`packing-${index}-${name}`}>{label}</Label>
        <Input id={`packing-${index}-${name}`} aria-label={`Data row ${index + 1} ${label}`}
          value={String(row[name] ?? "")} onChange={(event) => onChange(index, name, event.target.value)} />
      </div>;
      const basis = row.dimensionBasis === "piece" || row.dimensionBasis === "carton" ? row.dimensionBasis : row.cartonCount != null ? "carton" : "piece";
      return <div key={index} className="rounded border p-3 space-y-3">
        <p className="font-medium text-sm">Data row {index + 1}</p>
        {errorsByRow.has(index + 1) && <p role="alert" className="text-xs text-destructive">{errorsByRow.get(index + 1)}</p>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{field("sku", "SKU")}
          {row.purchaseOrderLineId !== undefined && field("purchaseOrderLineId", "Purchase order line ID")}
          {row.productVariantId !== undefined && field("productVariantId", "Product variant ID")}
        </div>
        {invalidUnit && <p role="alert" className="text-sm text-destructive">The CSV receive-unit evidence is incomplete or invalid. Select the configured receive unit and enter its count before importing.</p>}
        <ShipmentQuantityControl id={`packing-row-${index + 1}`} value={draft} units={units}
          quantityLabel={`Data row ${index + 1} Pieces shipped`} onChange={(quantity) => onQuantityChange(index, quantity, units)} />
        {mismatch && <p role="alert" className="text-sm text-destructive">CSV pieces ({String(row.qtyShipped)}) disagree with the receive-unit total ({preview.pieces}). Review and enter the intended quantity before importing.</p>}
        <fieldset className="rounded border p-3 space-y-2"><legend className="px-1 text-sm">Physical packing</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {field("cartonCount", "Shipping cartons")}
            <div className="space-y-1"><Label htmlFor={`packing-${index}-basis`}>Dimensions measured per</Label>
              <select id={`packing-${index}-basis`} aria-label={`Data row ${index + 1} Dimensions measured per`} className="h-10 w-full rounded border bg-background px-2"
                value={String(row.dimensionBasis ?? "")} onChange={(event) => onChange(index, "dimensionBasis", event.target.value)}>
                <option value="">Not supplied (existing {basis} basis)</option><option value="piece">Piece</option><option value="carton">Shipping carton</option>
              </select>
            </div>
            {field("weightKg", `Weight per ${basis === "carton" ? "shipping carton" : "piece"} (kg)`)}
            {field("lengthCm", "Length (cm)")}{field("widthCm", "Width (cm)")}{field("heightCm", "Height (cm)")}
          </div>
          <p className="text-xs text-muted-foreground">Measurements are per {basis}. Shipping cartons are a physical count, separate from configured receive units.</p>
        </fieldset>
        {row.notes !== undefined && field("notes", "Notes")}
      </div>;
    })}
  </div>;
}
