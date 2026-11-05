import type { SupplierHeaderSource, SupplierHeaderShare } from "@shared/procurement/supplier-header-costs";
import { readIntegerCents } from "@shared/money-read";
import { CostEvidenceError } from "../../inventory/infrastructure/cost-evidence-values";

/** The bill line stays unchanged. Its explicitly allocated header share is
 * accepted by the same shipment-charge writer as a regular freight review. */
export function reviewedHeaderFreightAmounts(source: SupplierHeaderSource, shares: readonly SupplierHeaderShare[]) {
  if (source.target.kind !== "invoice") return [];
  const amounts = new Map<number, { chargeId: number; shipmentId: number; mills: bigint }>();
  for (const line of source.lines.filter(row => row.kind === "shipment_charge")) {
    if (line.freightCostId === null || line.inboundShipmentId === null)
      throw new CostEvidenceError("SUPPLIER_HEADER_SHIPMENT_MISSING", "Restore this invoice line's original shipment charge.");
    const current = amounts.get(line.freightCostId) ?? { chargeId: line.freightCostId, shipmentId: line.inboundShipmentId, mills: BigInt(0) };
    if (current.shipmentId !== line.inboundShipmentId)
      throw new CostEvidenceError("SUPPLIER_HEADER_SHIPMENT_MISMATCH", "A charge cannot belong to two shipments.");
    current.mills += BigInt(line.basisMills) + shares.filter(row => row.lineId === line.id)
      .reduce((sum, row) => sum + BigInt(row.amountMills), BigInt(0));
    amounts.set(line.freightCostId, current);
  }
  return [...amounts.values()].sort((a, b) => a.chargeId - b.chargeId).map(row => {
    if (row.mills < BigInt(0) || row.mills % BigInt(100) !== BigInt(0))
      throw new CostEvidenceError("SUPPLIER_HEADER_FREIGHT_AMOUNT_REQUIRED", "The header cannot make an accepted shipment charge negative or fractional cents.");
    return { chargeId: row.chargeId, shipmentId: row.shipmentId, invoiceCents: readIntegerCents(row.mills / BigInt(100), "accepted shipment charge") };
  });
}
