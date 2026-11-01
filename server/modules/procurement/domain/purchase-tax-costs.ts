import { readIntegerCents } from "@shared/money-read";
import { readIntegerMills } from "@shared/money-read";
import Decimal from "decimal.js";
import { purchaseTaxCostsSchema } from "@shared/procurement/purchase-tax-costs";
import { resolvePurchaseCostSource } from "./purchase-cost-source";
import { purchaseTaxAmounts, purchaseTaxEvidence, PurchaseTaxError } from "./purchase-tax";

export interface PurchaseTaxShippingCosts {
  lines: readonly { purchaseOrderLineId?: number | null; allocatedCents: number; lineId: number }[];
  recoverableByShipmentLine: ReadonlyMap<number, number>;
  complete: boolean;
}
type SupplierSource = Parameters<typeof resolvePurchaseCostSource>[0];

/** Pure display projection of the existing cost owner's selected extended
 * amounts. It neither selects a different price policy nor posts any money. */
export function projectPurchaseTaxCosts(records: readonly Record<string, unknown>[], sources: readonly SupplierSource[], shipping: PurchaseTaxShippingCosts) {
  const selected = sources.map(source => ({ source, proposals: resolvePurchaseCostSource(source) }));
  const taxed = records.some(row => row.tax_type_id != null || row.header_tax_type_id != null)
    || selected.some(row => row.source.purchaseOrderLine.tax_cost_evidence !== undefined || row.source.approvedInvoices.some(invoice => invoice.tax_cost_evidence !== undefined))
    || shipping.recoverableByShipmentLine.size > 0;
  if (!taxed) return undefined;
  const productIds = records.filter(row => row.line_type === "product").map(row => readIntegerCents(row.id, "product line"));
  if (!productIds.length) throw new PurchaseTaxError("Tax needs a product line and a verified allocation basis before it can be included in inventory.", "PURCHASE_TAX_ALLOCATION_REQUIRED");
  const sourceIds = sources.map(source => readIntegerCents(source.purchaseOrderLine.id, "source line"));
  if (new Set(sourceIds).size !== sourceIds.length || sourceIds.length !== productIds.length || sourceIds.some(id => !productIds.includes(id)))
    throw new PurchaseTaxError("Some supplier cost sources are missing or duplicated. Refresh before using the inventory total.", "PURCHASE_TAX_SOURCE_INVALID");
  if (new Set(shipping.lines.map(line => line.lineId)).size !== shipping.lines.length
    || shipping.lines.some(line => line.purchaseOrderLineId == null || !productIds.includes(line.purchaseOrderLineId)))
    throw new PurchaseTaxError("A shipment charge is missing its unique purchase line link.", "PURCHASE_TAX_SOURCE_INVALID");
  const exactCents = (mills: bigint) => mills % BigInt(100) !== BigInt(0) ? null : readIntegerCents(mills / BigInt(100), "tax-adjusted cost", true);
  let recoverableSupplier = BigInt(0), recoverableShipment = BigInt(0), reason: string | null = null;
  const hasUnallocatedOtherCharges = records.some(row => (row.line_type !== "product" && row.line_type !== "tax" && readIntegerCents(row.line_total_cents ?? 0, "PO charge", true) !== 0)
    || readIntegerCents(row.header_discount_cents ?? 0, "header discount", true) !== 0 || readIntegerCents(row.header_shipping_cents ?? 0, "header freight", true) !== 0);
  const lines = selected.map(({ source, proposals }) => {
    const lineId = readIntegerCents(source.purchaseOrderLine.id, "lineId"), basis = proposals[0]?.basePieces;
    const known = proposals.length === 2 && proposals.every(row => row.currency === "USD" && row.totalMills !== null
      && ["estimated", "confirmed"].includes(row.evidence) && row.basePieces === basis);
    const supplierInventoryCents = known ? exactCents(proposals.reduce((sum, row) => sum + BigInt(row.totalMills!), BigInt(0))) : null;
    if (supplierInventoryCents === null) reason ??= proposals.some(row => row.issue?.code === "PURCHASE_TAX_TYPE_REQUIRED")
      ? "Choose the supplier tax type before using its inventory cost."
      : "Confirm the supplier quantities, tax type and billed amounts to calculate inventory cost.";
    if (basis !== readIntegerCents(source.purchaseOrderLine.order_qty, "ordered pieces")) reason ??= "The selected invoice costs cover a different quantity from the PO. Receipt-specific cost allocation is needed before showing the complete PO inventory total.";
    const taxEvidence = source.approvedInvoices.length ? source.approvedInvoices.flatMap(invoice => purchaseTaxEvidence(invoice.tax_cost_evidence))
      : purchaseTaxEvidence(source.purchaseOrderLine.tax_cost_evidence);
    recoverableSupplier += BigInt(purchaseTaxAmounts(taxEvidence).recoverableMills);
    let shipment = BigInt(0);
    for (const share of shipping.lines.filter(row => row.purchaseOrderLineId === lineId)) {
      const excluded = shipping.recoverableByShipmentLine.get(share.lineId) ?? 0;
      shipment += BigInt(share.allocatedCents) - BigInt(excluded); recoverableShipment += BigInt(excluded);
    }
    const shipmentInventoryCents = readIntegerCents(shipment, "inventory shipment share", true);
    return { purchaseOrderLineId: lineId, pieces: basis ?? readIntegerCents(source.purchaseOrderLine.order_qty, "ordered pieces"), supplierInventoryCents,
      shipmentInventoryCents, inventoryLandedCents: supplierInventoryCents === null || !shipping.complete ? null : readIntegerCents(BigInt(supplierInventoryCents) + shipment, "inventory line total", true) };
  });
  if (hasUnallocatedOtherCharges) reason = [reason, "Other PO charges still need their inventory cost allocation."].filter(Boolean).join(" ");
  const supplierInventoryCents = reason !== null ? null : readIntegerCents(lines.reduce((sum, row) => sum + BigInt(row.supplierInventoryCents!), BigInt(0)), "selected supplier total", true);
  const shipmentInventoryCents = shipping.complete ? readIntegerCents(lines.reduce((sum, row) => sum + BigInt(row.shipmentInventoryCents), BigInt(0)), "selected shipment total", true) : null;
  if (!shipping.complete) reason ??= "Complete the shipment charge allocation before using its inventory cost.";
  const recoverableSupplierTaxCents = exactCents(recoverableSupplier);
  if (recoverableSupplierTaxCents === null) throw new PurchaseTaxError("The supplier tax total is not in exact cents.", "PURCHASE_TAX_AMOUNT_MISMATCH");
  return purchaseTaxCostsSchema.parse({ supplierInventoryCents, shipmentInventoryCents,
    inventoryLandedCents: supplierInventoryCents === null || shipmentInventoryCents === null ? null : readIntegerCents(BigInt(supplierInventoryCents) + BigInt(shipmentInventoryCents), "landed inventory total", true),
    recoverableSupplierTaxCents,
    recoverableShipmentTaxCents: readIntegerCents(recoverableShipment, "recoverable shipment tax", true), reason, lines });
}

/** Current landed display uses the same selected supplier extended amounts as
 * receiving. Allocation's by-value basis remains the pre-tax product quote. */
export function projectTaxedShipmentSupplierCost(source: SupplierSource, pieces: number, shipmentHasTax: boolean) {
  const selectedTax = source.purchaseOrderLine.tax_cost_evidence !== undefined || source.approvedInvoices.some(row => row.tax_cost_evidence !== undefined);
  if (!selectedTax && !shipmentHasTax) return undefined;
  const proposals = resolvePurchaseCostSource(source), base = proposals[0]?.basePieces;
  if (source.approvedInvoices.length > 1 || !Number.isSafeInteger(pieces) || pieces <= 0 || base == null || base < pieces
    || proposals.length !== 2 || proposals.some(row => row.totalMills === null || row.basePieces !== base || row.currency !== "USD" || !["estimated", "confirmed"].includes(row.evidence))) {
    return { unitCostMills: null, reason: "The supplier quantity, tax or billed amounts still need their receipt-specific cost review." };
  }
  const total = proposals.reduce((sum, row) => sum + BigInt(row.totalMills!), BigInt(0));
  return { unitCostMills: readIntegerMills(new Decimal(total.toString()).div(base).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0), "selected supplier cost per piece"), reason: null };
}
