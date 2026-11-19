import { sql } from "drizzle-orm";
import type { CostEvidenceTransaction } from "../inventory/infrastructure/cost-evidence.repository";
import { costInteger, CostEvidenceError } from "../inventory/infrastructure/cost-evidence-values";
import { readIntegerMills } from "@shared/money-read";
import { readInvoiceTaxEvidence } from "./purchase-tax-evidence.repository";
import { purchaseTaxEvidenceSchema } from "@shared/procurement/purchase-tax";

/** The original billed charge retains its configured tax type. Header tax has
 * its own source and is never folded into the original line's tax amount. */
export async function attachSupplierInvoiceTaxEvidence(tx: CostEvidenceTransaction, rows: Record<string, unknown>[]) {
  const ids = rows.filter(row => row.id != null).map(row => costInteger(row.id, "supplier invoice line", 1));
  const taxes = await readInvoiceTaxEvidence(tx, ids);
  const chargeIds = [...new Set(rows.filter(row => row.freight_cost_id != null).map(row => costInteger(row.freight_cost_id, "supplier tax charge", 1)))];
  const charges = chargeIds.length ? (await tx.execute(sql`SELECT cost.id,cost.tax_type_id,kind.treatment
    FROM procurement.inbound_freight_costs cost JOIN procurement.purchase_tax_types kind ON kind.id=cost.tax_type_id
    WHERE cost.id=ANY(${sql.param(chargeIds)}::int[]) ORDER BY cost.id LIMIT 10001`)).rows : [];
  if (charges.length > 10000) throw new CostEvidenceError("SUPPLIER_TAX_LIMIT", "The complete supplier charge tax read exceeds 10000 sources.");
  const byCharge = new Map(charges.map(row => [costInteger(row.id, "original tax charge", 1), row]));
  return rows.map(row => {
    const charge = row.freight_cost_id == null ? null : byCharge.get(Number(row.freight_cost_id));
    const entries = taxes.get(Number(row.id)) ?? (charge ? [purchaseTaxEvidenceSchema.parse({ taxTypeId: charge.tax_type_id, treatment: charge.treatment,
      amountMills: readIntegerMills(BigInt(costInteger(row.line_total_cents, "original tax bill line")) * BigInt(100), "original billed tax"), source: `shipment_charge:${row.freight_cost_id}` })] : []);
    return entries.length ? { ...row, tax_cost_evidence: entries } : row;
  });
}
