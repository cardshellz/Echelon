import type { InboundShipment, InboundShipmentLine } from "@shared/schema";
import { canonicalJson } from "@shared/utils/canonical-json";
import { shipmentLineVersion } from "./shipment-line-version";

/** Capture immediately after the source read, before any asynchronous receipt
 * preparation. Sort a copy: row ordering alone is not a source change.
 */
export function shipmentReceiptSourceVersion(
  shipment: Pick<InboundShipment, "id" | "status" | "warehouseId" | "updatedAt">,
  lines: readonly InboundShipmentLine[],
): string {
  return canonicalJson({
    id: shipment.id,
    status: shipment.status,
    warehouseId: shipment.warehouseId ?? null,
    updatedAt: shipment.updatedAt ?? null,
    lines: [...lines].sort((a, b) => a.id - b.id).map((line) => ({ id: line.id, version: shipmentLineVersion(line) })),
  });
}
