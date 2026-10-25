import { supplierReturnCostEntrySchema, supplierReturnCostTotalsSchema, type SupplierReturnCostEntry, type SupplierReturnCostTotals } from "@shared/procurement/supplier-return";
import { canonicalJson } from "@shared/utils/canonical-json";

export const supplierReturnCostComponents = ["product", "packaging", "landed"] as const;
export const supplierReturnCostField = { product: "productMills", packaging: "packagingMills", landed: "landedMills" } as const;

/** Retained ledger corruption is an internal failure, not permission to clear a
 * durable physical command as a rejected user request. */
export function verifySupplierReturnCostHistory(
  returnAllocationId: number,
  initialCosts: SupplierReturnCostTotals,
  rawEntries: readonly unknown[],
) {
  const entries = rawEntries.map(row => supplierReturnCostEntrySchema.parse(row)).sort((a, b) => a.id - b.id);
  if (new Set(entries.map(entry => entry.id)).size !== entries.length
    || new Set(entries.map(entry => `${entry.component}:${entry.postingKey}`)).size !== entries.length
    || entries.some(entry => entry.returnAllocationId !== returnAllocationId)) {
    throw new Error("Supplier return cost history has conflicting identities.");
  }
  const latest = new Map<SupplierReturnCostEntry["component"], SupplierReturnCostEntry>();
  const initialCostEntryIds = { product: 0, packaging: 0, landed: 0 };
  for (const entry of entries) {
    const prior = latest.get(entry.component);
    if (prior ? entry.previousMills !== prior.nextMills : entry.previousMills !== 0 || entry.nextMills !== initialCosts[supplierReturnCostField[entry.component]]) {
      throw new Error("Supplier return cost history does not continue its exact prior value.");
    }
    if (!prior) initialCostEntryIds[entry.component] = entry.id;
    latest.set(entry.component, entry);
  }
  if (supplierReturnCostComponents.some(component => !latest.has(component))) {
    throw new Error("Supplier return cost history lacks an initial component.");
  }
  const currentCosts = supplierReturnCostTotalsSchema.parse({
    productMills: latest.get("product")!.nextMills, packagingMills: latest.get("packaging")!.nextMills, landedMills: latest.get("landed")!.nextMills,
    totalMills: Number(supplierReturnCostComponents.reduce((sum, component) => sum + BigInt(latest.get(component)!.nextMills), BigInt(0))),
  });
  return { entries, latest, initialCostEntryIds, currentCosts };
}

export function assertSupplierReturnCostsEqual(left: SupplierReturnCostTotals, right: SupplierReturnCostTotals): void {
  if (canonicalJson(supplierReturnCostTotalsSchema.parse(left)) !== canonicalJson(supplierReturnCostTotalsSchema.parse(right))) {
    throw new Error("Supplier return value ledger disagrees with its exact quantity intervals.");
  }
}
