import type { PurchaseTaxChange, PurchaseTaxContext } from "./purchase-tax";

/** Human-readable review of the setting itself, including unused rules and zero
 * amounts. Posting decisions and measured money remain in the cost-owner DTOs. */
export function purchaseTaxSettingsChanges(context: Pick<PurchaseTaxContext, "current" | "types" | "lines" | "invoice">, change: PurchaseTaxChange) {
  const rows: { label: string; before: string; after: string }[] = [];
  const add = (label: string, before: string, after: string) => { if (before !== after) rows.push({ label, before, after }); };
  const treatment = (value: string) => value === "inventory" ? "Inventory cost" : "Recoverable tax";
  const typeName = (id: number | null, unassigned = "Not assigned") => {
    if (id === null) return unassigned;
    const type = context.types.find(type => type.id === id);
    if (!type) throw new Error("The selected tax type is missing from the reviewed settings.");
    return `${type.code} · ${type.name} · ${treatment(type.treatment)}`;
  };
  const before = context.current;
  if (change.kind === "tax_type") {
    const current = before?.kind === "tax_type" ? before : null;
    add("Tax code", current?.code ?? "Not configured", change.code);
    add("Tax name", current?.name ?? "Not configured", change.name);
    add("Tax treatment", current ? treatment(current.treatment) : "Not configured", treatment(change.treatment));
  } else if (change.kind === "purchase_order") {
    const current = before?.kind === "purchase_order" ? before : null;
    add("PO default", typeName(current?.taxTypeId ?? null), typeName(change.taxTypeId));
    for (const line of change.lineTypes) add(context.lines.find(row => row.id === line.lineId)?.label ?? `Line #${line.lineId}`,
      typeName(current?.lineTypes.find(row => row.lineId === line.lineId)?.taxTypeId ?? null, "Use PO default"), typeName(line.taxTypeId, "Use PO default"));
  } else if (change.kind === "shipment_charge") {
    add("Shipment charge tax type", typeName(before?.kind === "shipment_charge" ? before.taxTypeId : null, "Existing recorded treatment"), typeName(change.taxTypeId));
  } else {
    const current = context.invoice?.taxes ?? [], ids = [...new Set([...current, ...change.taxes].map(row => row.taxTypeId))].sort((a, b) => a - b);
    const amount = (mills: number) => { const value = BigInt(mills); return `${value / BigInt(10000)}.${String(value % BigInt(10000) / BigInt(100)).padStart(2, "0")} ${context.invoice?.currency ?? ""}`; };
    for (const id of ids) add(typeName(id), amount(current.find(row => row.taxTypeId === id)?.amountMills ?? 0), amount(change.taxes.find(row => row.taxTypeId === id)?.amountMills ?? 0));
  }
  return rows;
}
