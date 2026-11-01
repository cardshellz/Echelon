import { receiptSegmentCost } from "@shared/procurement/receipt-cost-segments";
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
  const receiptScoped = sources.some(source => source.receiptCosting);
  const taxed = receiptScoped || records.some(row => row.tax_type_id != null || row.header_tax_type_id != null)
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
    const supplierMills = known ? proposals.reduce((sum, row) => sum + BigInt(row.totalMills!), BigInt(0)) : null;
    // Summary cents are display rounding only. Exact selected mills remain in
    // the DTO and the receipt/cost contracts; they are never posted from a rate.
    const supplierInventoryCents = supplierMills === null ? null : source.receiptCosting
      ? readIntegerCents((supplierMills+BigInt(50))/BigInt(100),"display supplier cost") : exactCents(supplierMills);
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
  const exactSupplierMills = selected.every(row=>row.proposals.every(item=>item.totalMills!==null))
    ? selected.reduce((sum,row)=>sum+row.proposals.reduce((value,item)=>value+BigInt(item.totalMills!),BigInt(0)),BigInt(0)) : null;
  const supplierInventoryCents = reason !== null ? null : receiptScoped && exactSupplierMills !== null
    ? readIntegerCents((exactSupplierMills+BigInt(50))/BigInt(100),"display supplier total")
    : readIntegerCents(lines.reduce((sum, row) => sum + BigInt(row.supplierInventoryCents!), BigInt(0)), "selected supplier total", true);
  const shipmentInventoryCents = shipping.complete ? readIntegerCents(lines.reduce((sum, row) => sum + BigInt(row.shipmentInventoryCents), BigInt(0)), "selected shipment total", true) : null;
  if (!shipping.complete) reason ??= "Complete the shipment charge allocation before using its inventory cost.";
  const recoverableSupplierTaxCents = exactCents(recoverableSupplier);
  if (recoverableSupplierTaxCents === null) throw new PurchaseTaxError("The supplier tax total is not in exact cents.", "PURCHASE_TAX_AMOUNT_MISMATCH");
  return purchaseTaxCostsSchema.parse({ supplierInventoryCents, shipmentInventoryCents,
    inventoryLandedCents: supplierInventoryCents === null || shipmentInventoryCents === null ? null : readIntegerCents(BigInt(supplierInventoryCents) + BigInt(shipmentInventoryCents), "landed inventory total", true),
    recoverableSupplierTaxCents,
    ...(receiptScoped ? { supplierInventoryMills: reason !== null ? null : exactSupplierMills===null ? null : readIntegerMills(exactSupplierMills,"selected exact supplier cost") } : {}),
    recoverableShipmentTaxCents: readIntegerCents(recoverableShipment, "recoverable shipment tax", true), reason, lines });
}

/** Current landed display uses the same selected supplier extended amounts as
 * receiving. Allocation's by-value basis remains the pre-tax product quote. */
export function projectTaxedShipmentSupplierCost(source: SupplierSource, pieces: number, shipmentHasTax: boolean, shipmentLineId?: number) {
  if (source.receiptCosting) {
    const selected = resolvePurchaseCostSource(source);
    const receipts = source.receiptCosting.receipts.filter(row=>row.inboundShipmentLineId===shipmentLineId);
    const received = receipts.reduce((sum,row)=>sum+BigInt(row.pieces),BigInt(0));
    if (!Number.isSafeInteger(pieces) || pieces<=0 || shipmentLineId===undefined || received>BigInt(pieces)
      || selected.some(row=>!row.receiptCostSegments)) return {unitCostMills:null,reason:"Review this shipment's receipt coverage before using its supplier cost."};
    let amount = new Decimal(0);
    for (const receipt of receipts) for (const component of selected) amount = amount.plus(receiptSegmentCost(component.receiptCostSegments!,receipt.startBasePiece,receipt.pieces,receipt.receivingLineId).totalMills);
    const remaining = BigInt(pieces)-received;
    if (remaining>BigInt(0)) {
      const quote = resolvePurchaseCostSource({purchaseOrderLine:{...source.purchaseOrderLine,status:"open"},approvedInvoices:[]});
      if(quote.some(row=>row.evidence!=="estimated"||row.currency!=="USD"||row.totalMills===null||row.basePieces===null))
        return {unitCostMills:null,reason:"The unreceived pieces need a supported provisional PO cost."};
      for(const component of quote)amount=amount.plus(new Decimal(component.totalMills!).mul(remaining.toString()).div(component.basePieces!));
    }
    return {unitCostMills:readIntegerMills(amount.div(pieces).toDecimalPlaces(0,Decimal.ROUND_HALF_UP).toFixed(0),"shipment receipt display rate"),reason:null};
  }
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
