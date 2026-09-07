import { recordPurchaseCostRevisions } from "./purchase-cost-application.service";
import { recordShipmentCostRevisions } from "./shipment-cost-application.service";
import { sql } from "drizzle-orm";
import {
  CostEvidenceError, costInteger,
  type CostEvidenceTransaction, type RecordedCostRevision,
} from "../inventory/infrastructure/cost-evidence.repository";

export interface ReceiptCostEvidenceInput {
  receivingLineId: number;
  purchaseOrderLineId: number;
  purchaseOrderId: number;
  inboundShipmentId: number | null;
  inboundShipmentLineId: number | null;
  unitsPerVariantSnapshot: number;
  costSourceKind: string | null;
}

export interface ReceiptCostEvidenceResult {
  unitCostMills: number;
  packagingCostMills: number;
  landedCostMills: number;
  costProvisional: 0 | 1;
  productUnitCostMills: number;
  revisions: RecordedCostRevision[];
}

/** Receiving uses the same versioned source resolver as AP and shipment costs.
 * It records quote/actual evidence without posting an AP command in the physical
 * transaction. An unresolved currency or credit is never guessed into USD. */
export async function resolveReceiptCostEvidence(
  tx: CostEvidenceTransaction, input: ReceiptCostEvidenceInput, actorId: string, now: Date,
): Promise<ReceiptCostEvidenceResult> {
  const units = costInteger(input.unitsPerVariantSnapshot, "unitsPerVariantSnapshot", 1);
  const result = await tx.execute(sql`
    SELECT line.id,line.line_type,line.order_qty,line.total_product_cost_cents,line.packaging_cost_cents,po.currency
    FROM procurement.purchase_order_lines line JOIN procurement.purchase_orders po ON po.id=line.purchase_order_id
    WHERE line.id=${input.purchaseOrderLineId} AND po.id=${input.purchaseOrderId}
  `);
  const line = result.rows[0];
  if (!line || line.line_type !== "product" || input.costSourceKind !== "purchase_order_line") {
    throw new CostEvidenceError("RECEIPT_COST_SOURCE_MISMATCH", "The receipt does not explicitly identify this product purchase line.", { receivingLineId: input.receivingLineId });
  }
  const quotedQty = costInteger(line.order_qty, "purchaseOrderLine.orderQty", 1);
  const revisions = await recordPurchaseCostRevisions(tx, input.purchaseOrderLineId, actorId, now);
  const productSource = revisions.find((revision) => revision.contract.component === "product")?.contract;
  const packagingSource = revisions.find((revision) => revision.contract.component === "packaging")?.contract;
  const actual = productSource?.evidence === "confirmed" && packagingSource?.evidence === "confirmed"
    && productSource.currency === "USD" && packagingSource.currency === "USD"
    && productSource.totalMills !== null && packagingSource.totalMills !== null && productSource.basePieces !== null;
  const qty = actual ? productSource!.basePieces! : quotedQty;
  const productTotal = actual ? productSource!.totalMills! : line.currency === "USD"
    ? costInteger((BigInt(costInteger(line.total_product_cost_cents, "productCents")) * BigInt(100)).toString(), "productMills") : 0;
  const packagingTotal = actual ? packagingSource!.totalMills! : line.currency === "USD"
    ? costInteger((BigInt(costInteger(line.packaging_cost_cents, "packagingCents")) * BigInt(100)).toString(), "packagingMills") : 0;
  let landedMills = 0;
  let freightPending = input.inboundShipmentId !== null;
  if (input.inboundShipmentId !== null && input.inboundShipmentLineId !== null) {
    const shipmentSources = await recordShipmentCostRevisions(tx, input.inboundShipmentId, actorId, now, { inboundShipmentLineId: input.inboundShipmentLineId });
    const shipmentSource = shipmentSources.revisions.find((revision) => revision.contract.scope.kind === "shipment_line"
      && revision.contract.scope.inboundShipmentLineId === input.inboundShipmentLineId);
    if (!shipmentSource || shipmentSource.contract.scope.purchaseOrderLineId !== input.purchaseOrderLineId) {
      throw new CostEvidenceError("RECEIPT_SHIPMENT_COST_SOURCE_MISMATCH", "The receipt shipment cost source identifies another purchase line.");
    }
    revisions.push(shipmentSource);
    const source = shipmentSource.contract;
    if (["estimated", "confirmed"].includes(source.evidence) && source.currency === "USD" && source.totalMills !== null
      && source.totalMills >= 0 && source.basePieces !== null) landedMills = scaledCostMills(source.totalMills, units, source.basePieces);
    freightPending = source.evidence !== "confirmed";
  }
  const productMills = scaledCostMills(productTotal, units, qty);
  const packagingMills = scaledCostMills(packagingTotal, units, qty);
  return {
    unitCostMills: costInteger((BigInt(productMills) + BigInt(packagingMills) + BigInt(landedMills)).toString(), "receipt.unitCostMills"),
    packagingCostMills: packagingMills, landedCostMills: landedMills,
    costProvisional: !actual || freightPending ? 1 : 0,
    productUnitCostMills: scaledCostMills(productTotal, 1, qty), revisions,
  };
}

export function scaledCostMills(totalMills: number, quantity: number, denominator: number): number {
  costInteger(totalMills, "totalMills"); costInteger(quantity, "quantity"); costInteger(denominator, "denominator", 1);
  const numerator = BigInt(totalMills) * BigInt(quantity);
  return costInteger(((numerator * BigInt(2) + BigInt(denominator)) / (BigInt(denominator) * BigInt(2))).toString(), "scaledCostMills");
}
