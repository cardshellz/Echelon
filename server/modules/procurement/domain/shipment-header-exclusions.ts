import { supplierHeaderAmounts } from "./supplier-header-costs";
import { allocateCentsFromNumericBasis } from "./shipment-allocation-basis";
import { readIntegerCents } from "@shared/money-read";
import { CostEvidenceError, costInteger } from "../../inventory/infrastructure/cost-evidence-values";

/** A gross freight allocation can include recoverable header tax or another
 * explicitly excluded amount. Distribute those exact cents over that charge's
 * gross shares, retaining both the supplier amount and its inventory exclusion. */
export function shipmentHeaderExclusions(invoices: readonly Record<string, unknown>[], allocations: readonly Record<string, unknown>[],
  chargeTaxes: ReadonlyMap<number, { treatment: string }> = new Map()) {
  const totals = new Map<number, { tax: bigint; other: bigint }>();
  const replacedTaxChargeIds = new Set<number>();
  for (const line of invoices) {
    if (line.freight_cost_id == null || line.header_cost_evidence == null || !["approved", "paid", "partially_paid"].includes(String(line.status))) continue;
    const charge = costInteger(line.freight_cost_id, "header shipment charge", 1);
    const header = supplierHeaderAmounts(line.header_cost_evidence), total = totals.get(charge) ?? { tax: BigInt(0), other: BigInt(0) };
    const originalTax = chargeTaxes.get(charge);
    if (originalTax) {
      replacedTaxChargeIds.add(charge);
      if (originalTax.treatment === "recoverable") total.tax += BigInt(costInteger(line.line_total_cents, "original billed tax charge")) * BigInt(100);
    }
    total.tax += header.taxes.filter(tax => tax.treatment === "recoverable").reduce((sum, tax) => sum + BigInt(tax.amountMills), BigInt(0));
    total.other += BigInt(header.excludedMills); totals.set(charge, total);
  }
  const taxByLine = new Map<number, number>(), otherByLine = new Map<number, number>();
  for (const [charge, total] of totals) {
    const rows = allocations.filter(row => Number(row.shipment_cost_id) === charge);
    for (const [amount, destination] of [[total.tax, taxByLine], [total.other, otherByLine]] as const) {
      if (amount === BigInt(0) || !rows.length) continue;
      const sign = amount < BigInt(0) ? BigInt(-1) : BigInt(1);
      if (amount % BigInt(100) !== BigInt(0)) throw new CostEvidenceError("SUPPLIER_HEADER_CENTS_REQUIRED", "Shipment header shares must retain exact cents.");
      const basis = rows.map(row => ({ lineId: costInteger(row.inbound_shipment_line_id, "shipment line", 1), basis: costInteger(row.allocated_cents, "gross charge share") }));
      if (basis.every(row => row.basis === 0)) throw new CostEvidenceError("SUPPLIER_HEADER_ALLOCATION_REQUIRED", "A nonzero header exclusion needs a nonzero gross shipment charge.");
      for (const share of allocateCentsFromNumericBasis(readIntegerCents(amount * sign / BigInt(100), "header exclusion"), basis))
        destination.set(share.lineId, readIntegerCents(BigInt(destination.get(share.lineId) ?? 0) + BigInt(share.allocatedCents) * sign, "allocated header exclusion", true));
    }
  }
  return { taxByLine, otherByLine, replacedTaxChargeIds };
}
