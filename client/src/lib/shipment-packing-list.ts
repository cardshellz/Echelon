import { SHIPMENT_LINE_IMPORT_LIMIT } from "@shared/procurement/shipment-line-command";
export const PACKING_LIST_FIELDS = [
  { field: "sku", label: "SKU" }, { field: "qtyShipped", label: "Pieces shipped" },
  { field: "cartonCount", label: "Cartons" }, { field: "weightKg", label: "Weight (kg)" },
  { field: "lengthCm", label: "Length (cm)" }, { field: "widthCm", label: "Width (cm)" }, { field: "heightCm", label: "Height (cm)" },
  { field: "purchaseOrderLineId", label: "Purchase order line ID" }, { field: "productVariantId", label: "Product variant ID" },
  { field: "notes", label: "Notes" },
] as const;
export type PackingListRow = Record<string, unknown>;
export function updatePackingListCell(row: PackingListRow, field: string, input: string): PackingListRow {
  if (!PACKING_LIST_FIELDS.some((entry) => entry.field === field)) throw new Error("Unsupported packing list field");
  const value = input.trim();
  const next = { ...row };
  if (value === "" && field !== "qtyShipped") {
    // Optional blank cells remove the value, matching the initial CSV adapter.
    delete next[field];
  } else {
    const integer = ["qtyShipped", "cartonCount", "purchaseOrderLineId", "productVariantId"].includes(field);
    next[field] = integer && /^\d+$/.test(value) ? Number(value) : value;
  }
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
  return rows.map((row) => Object.fromEntries(PACKING_LIST_FIELDS.flatMap(({ field }) => {
    const header = mapping[field];
    if (!header || header === "__skip__" || row[header] === undefined) return [];
    const raw = String(row[header] ?? "").trim();
    if (!raw) return field === "qtyShipped" ? [[field, ""]] : [];
    // Invalid values remain visible and reach the owner's per-row validation.
    const integer = ["qtyShipped", "cartonCount", "purchaseOrderLineId", "productVariantId"].includes(field);
    return [[field, integer && /^\d+$/.test(raw) ? Number(raw) : raw]];
  })));
}
