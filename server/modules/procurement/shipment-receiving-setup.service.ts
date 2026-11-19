import type { InboundShipmentLine, PurchaseOrderLine } from "@shared/schema";
import { reviewReceivingConfiguration } from "@shared/procurement/receiving-configuration";
import { shipmentReceivingSetupSchema, MAX_SHIPMENT_RECEIVING_SETUP_LINES, type ShipmentReceivingSetup } from "@shared/procurement/shipment-receiving-setup";
import { readShipmentUnitOptions } from "./shipment-unit-selection.repository";
import { readShipmentReceivingSources } from "./shipment-receiving-setup.repository";

interface ReceivingSetupStorage {
  getInboundShipmentLines(id: number, executor?: any): Promise<InboundShipmentLine[]>;
}

/** The PO default may supply a recorded configuration; catalog presence alone
 * never selects a unit or supplies missing historical conversion evidence. */
export function shipmentReceivingUnitSource(line: Pick<InboundShipmentLine, "productVariantId" | "unitsPerVariantSnapshot">, source: Pick<PurchaseOrderLine, "productId" | "expectedReceiveVariantId" | "productVariantId" | "expectedReceiveUnitsPerVariant"> | undefined) {
  const selectedVariantId = line.productVariantId ?? source?.expectedReceiveVariantId ?? source?.productVariantId ?? null;
  return { productId: source?.productId ?? null, selectedVariantId,
    unitsPerVariantSnapshot: line.unitsPerVariantSnapshot
      ?? (selectedVariantId !== null && selectedVariantId === source?.expectedReceiveVariantId ? source.expectedReceiveUnitsPerVariant : null) };
}

/** Write callers own graph -> shipment locks first. Source and catalog share
 * locks then prevent a booking decision from racing a configuration change. */
export async function readShipmentReceivingSetup(executor: any, storage: ReceivingSetupStorage, shipmentId: number, lock = false): Promise<ShipmentReceivingSetup> {
  const lines = [...await storage.getInboundShipmentLines(shipmentId, executor)].sort((left, right) => left.id - right.id);
  if (lines.length > MAX_SHIPMENT_RECEIVING_SETUP_LINES) throw new Error("Shipment receiving setup exceeds the line review limit");
  const ids = [...new Set(lines.flatMap(line => line.purchaseOrderLineId == null ? [] : [line.purchaseOrderLineId]))].sort((a, b) => a - b);
  const sources = await readShipmentReceivingSources(executor, ids, lock);
  const options = await readShipmentUnitOptions(executor, lines.map(line => ({ key: line.id,
    ...shipmentReceivingUnitSource(line, line.purchaseOrderLineId === null ? undefined : sources.get(line.purchaseOrderLineId)) })), { lock });
  const reviewed = lines.map(line => {
    const source = line.purchaseOrderLineId == null ? undefined : sources.get(line.purchaseOrderLineId);
    const units = options.get(line.id)!;
    const review = reviewReceivingConfiguration({ pieces: line.qtyShipped, variantId: units.selectedVariantId,
      recordedUnits: units.unitsPerVariantSnapshot, activeVariants: units.variants });
    const sourceIssue = !source || source.purchaseOrderId !== line.purchaseOrderId || (source.lineType ?? "product") !== "product"
      ? { code: "SHIPMENT_RECEIVING_SOURCE_REQUIRED", message: "Link this item to its product PO line before booking or shipping." } : null;
    const issue = sourceIssue ?? units.issue ?? review.issue;
    return { lineId: line.id, purchaseOrderId: line.purchaseOrderId ?? null, sku: line.sku ?? source?.sku ?? null,
      name: source?.productName ?? line.sku ?? "Shipment item", pieces: line.qtyShipped, units, count: issue ? null : review.count, issue };
  });
  const issueCount = reviewed.filter(line => line.issue !== null).length;
  return shipmentReceivingSetupSchema.parse({ shipmentId, ready: reviewed.length > 0 && issueCount === 0, issueCount, lines: reviewed });
}
