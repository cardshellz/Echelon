import { sql } from "drizzle-orm";
import type { CostEvidenceTransaction } from "../inventory/infrastructure/cost-evidence.repository";
import { costInteger, CostEvidenceError } from "../inventory/infrastructure/cost-evidence-values";
import { readIntegerCents } from "@shared/money-read";
import { readShipmentRecoverableTaxAllocations, readShipmentTaxEvidence } from "./purchase-tax-evidence.repository";
import { attachSupplierHeaderInvoiceEvidence } from "./supplier-header-invoice-evidence";
import { shipmentHeaderExclusions } from "./domain/shipment-header-exclusions";

export async function readShipmentCostExclusions(tx: CostEvidenceTransaction, shipmentId: number,
  costs: readonly { taxTypeId?: number | null }[], proposedAllocations?: readonly Record<string, unknown>[]) {
  const taxByLine = proposedAllocations ? new Map<number, number>() : await readShipmentRecoverableTaxAllocations(tx, shipmentId, costs);
  if (proposedAllocations && costs.some(cost => cost.taxTypeId != null)) {
    const types = await readShipmentTaxEvidence(tx, [shipmentId]);
    for (const row of proposedAllocations) {
      if (types.get(costInteger(row.shipment_cost_id, "shipment charge", 1))?.treatment !== "recoverable") continue;
      const lineId = costInteger(row.inbound_shipment_line_id, "shipment line", 1);
      taxByLine.set(lineId, readIntegerCents(BigInt(taxByLine.get(lineId) ?? 0) + BigInt(costInteger(row.allocated_cents, "recoverable share")), "recoverable allocation"));
    }
  }
  const rows = (await tx.execute(sql`SELECT line.id,line.vendor_invoice_id,line.freight_cost_id,line.line_total_cents,invoice.status
    FROM procurement.vendor_invoice_lines line JOIN procurement.vendor_invoices invoice ON invoice.id=line.vendor_invoice_id
    JOIN procurement.inbound_freight_costs charge ON charge.id=line.freight_cost_id
    WHERE charge.inbound_shipment_id=${shipmentId} ORDER BY line.id LIMIT 10001`)).rows;
  if (rows.length > 10000) throw new CostEvidenceError("SUPPLIER_HEADER_LIMIT", "Shipment header sources exceed the complete review limit.");
  const invoices = await attachSupplierHeaderInvoiceEvidence(tx, rows);
  const allocations = proposedAllocations ?? (await tx.execute(sql`SELECT allocation.* FROM procurement.inbound_freight_allocations allocation
    JOIN procurement.inbound_freight_costs charge ON charge.id=allocation.shipment_cost_id
    WHERE charge.inbound_shipment_id=${shipmentId} ORDER BY allocation.id LIMIT 10001`)).rows;
  if (allocations.length > 10000) throw new CostEvidenceError("SUPPLIER_HEADER_LIMIT", "Shipment header allocations exceed the complete review limit.");
  const chargeTaxes = costs.some(cost => cost.taxTypeId != null) ? await readShipmentTaxEvidence(tx, [shipmentId]) : new Map();
  const header = shipmentHeaderExclusions(invoices, allocations, chargeTaxes);
  for (const row of allocations) if (header.replacedTaxChargeIds.has(Number(row.shipment_cost_id)) && chargeTaxes.get(Number(row.shipment_cost_id))?.treatment === "recoverable") {
    const id = costInteger(row.inbound_shipment_line_id, "shipment line", 1);
    taxByLine.set(id, readIntegerCents(BigInt(taxByLine.get(id) ?? 0) - BigInt(costInteger(row.allocated_cents, "gross recoverable share")), "reclassified recoverable tax", true));
  }
  for (const [id, cents] of header.taxByLine) taxByLine.set(id, readIntegerCents(BigInt(taxByLine.get(id) ?? 0) + BigInt(cents), "recoverable tax allocation"));
  return { taxByLine, otherByLine: header.otherByLine };
}
