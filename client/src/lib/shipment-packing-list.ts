import { SHIPMENT_LINE_IMPORT_LIMIT } from "@shared/procurement/shipment-line-command";
import { shipmentUnitSelectionSchema, type ShipmentUnits } from "@shared/procurement/shipment-unit-selection";
import { toBasePieces } from "@shared/procurement/unit-quantity";
import { shipmentQuantityPreview, type ShipmentQuantityDraft } from "./shipment-unit-entry";

export const PACKING_LIST_FIELDS = [
  { field: "sku", label: "SKU" }, { field: "qtyShipped", label: "Pieces shipped" },
  { field: "receiveVariantId", label: "Receive variant ID" }, { field: "receiveUnitQuantity", label: "Receive unit count" },
  { field: "receiveUnitsPerVariant", label: "Pieces per receive unit" },
  { field: "cartonCount", label: "Shipping cartons" }, { field: "dimensionBasis", label: "Dimensions measured per (piece/carton)" },
  { field: "weightKg", label: "Weight (kg)" }, { field: "lengthCm", label: "Length (cm)" },
  { field: "widthCm", label: "Width (cm)" }, { field: "heightCm", label: "Height (cm)" },
  { field: "purchaseOrderLineId", label: "Purchase order line ID" }, { field: "productVariantId", label: "Product variant ID" },
  { field: "notes", label: "Notes" },
] as const;
export type PackingListRow = Record<string, unknown>;
const integerFields = new Set(["qtyShipped","cartonCount","purchaseOrderLineId","productVariantId","receiveVariantId","receiveUnitQuantity","receiveUnitsPerVariant"]);
const unitFields: Record<string, string> = { receiveVariantId: "productVariantId", receiveUnitQuantity: "quantity", receiveUnitsPerVariant: "unitsPerVariant" };
function valueForCell(field: string, raw: string): unknown {
  return integerFields.has(field) && /^\d+$/.test(raw) ? Number(raw) : raw;
}
export function updatePackingListCell(row: PackingListRow, field: string, input: string): PackingListRow {
  if (!PACKING_LIST_FIELDS.some((entry) => entry.field === field)) throw new Error("Unsupported packing list field");
  const value = input.trim();
  const next = { ...row };
  if (value === "" && field !== "qtyShipped") delete next[field];
  else next[field] = valueForCell(field, value);
  return next;
}
export function autoMapPackingList(headers: string[]): Record<string, string> {
  const normalize = (value: string) => value.toLowerCase().replace(/[\s_-]/g, "");
  return Object.fromEntries(PACKING_LIST_FIELDS.flatMap(({ field }) => {
    const header = headers.find((candidate) => normalize(candidate) === normalize(field));
    return header ? [[field, header]] : [];
  }));
}
export function mapPackingListRows(rows: PackingListRow[], mapping: Record<string, string>): PackingListRow[] {
  if (rows.length < 1 || rows.length > SHIPMENT_LINE_IMPORT_LIMIT) throw new Error(`Import between 1 and ${SHIPMENT_LINE_IMPORT_LIMIT} data rows at a time.`);
  return rows.map((row) => {
    const mapped: PackingListRow = {};
    const unitSelection: Record<string, unknown> = {};
    for (const { field } of PACKING_LIST_FIELDS) {
      const header = mapping[field];
      if (!header || header === "__skip__" || row[header] === undefined) continue;
      const raw = String(row[header] ?? "").trim();
      if (!raw && field !== "qtyShipped") continue;
      if (field in unitFields) unitSelection[unitFields[field]] = valueForCell(field, raw);
      else mapped[field] = valueForCell(field, raw);
    }
    if (Object.keys(unitSelection).length) {
      mapped.unitSelection = unitSelection;
      const parsed = shipmentUnitSelectionSchema.safeParse(unitSelection);
      if (mapped.qtyShipped === undefined && parsed.success) mapped.qtyShipped = toBasePieces(parsed.data.quantity, parsed.data.unitsPerVariant);
    }
    return mapped;
  });
}
/** Only source identity is sent to the bounded, purchasing-scoped read endpoint. */
export function packingListUnitOptionRows(rows: readonly PackingListRow[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const identity: Record<string, unknown> = {};
    for (const field of ["purchaseOrderLineId", "productVariantId", "sku"]) {
      if (row[field] !== undefined) identity[field] = row[field];
    }
    if (row.unitSelection && typeof row.unitSelection === "object" && !Array.isArray(row.unitSelection)) {
      const selected = (row.unitSelection as Record<string, unknown>).productVariantId;
      if (selected !== undefined) identity.selectedVariantId = selected;
    }
    return identity;
  });
}
export function packingListQuantityDraft(row: PackingListRow): ShipmentQuantityDraft {
  const selection = row.unitSelection;
  if (selection && typeof selection === "object") {
    const unit = selection as Record<string, unknown>;
    if (typeof unit.productVariantId === "number" && typeof unit.unitsPerVariant === "number") {
      return { variantId: unit.productVariantId, unitsPerVariant: unit.unitsPerVariant, quantity: String(unit.quantity ?? "") };
    }
  }
  return { variantId: null, unitsPerVariant: 1, quantity: String(row.qtyShipped ?? "") };
}
export function updatePackingListQuantity(row: PackingListRow, draft: ShipmentQuantityDraft, units: ShipmentUnits | null): PackingListRow {
  const next = { ...row };
  const preview = shipmentQuantityPreview(draft, units);
  next.qtyShipped = preview.pieces ?? "";
  if (draft.variantId === null) delete next.unitSelection;
  else {
    next.unitSelection = { productVariantId: draft.variantId, unitsPerVariant: draft.unitsPerVariant,
      quantity: /^\d+$/.test(draft.quantity.trim()) ? Number(draft.quantity.trim()) : draft.quantity };
    // A chosen receive SKU is explicit source identity and remains visible in the preview.
    const selected = units?.variants.find((variant) => variant.id === draft.variantId);
    if (selected?.sku) next.sku = selected.sku;
    if (next.productVariantId !== undefined) next.productVariantId = draft.variantId;
  }
  return next;
}
