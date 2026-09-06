import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { InboundShipmentLine } from "@shared/schema";

const VERSION_FIELDS = [
  "id", "inboundShipmentId", "purchaseOrderId", "purchaseOrderLineId", "productVariantId", "sku",
  "qtyShipped", "weightKg", "lengthCm", "widthCm", "heightCm", "totalWeightKg", "totalVolumeCbm",
  "chargeableWeightKg", "grossVolumeCbm", "cartonCount", "palletCount", "allocatedCostCents",
  "landedUnitCostCents", "notes", "createdAt", "updatedAt",
] as const satisfies readonly (keyof InboundShipmentLine)[];

// Hash raw storage values before enrichment changes SKU or allocation displays.
export function shipmentLineVersion(line: InboundShipmentLine): string {
  const values = Object.fromEntries(VERSION_FIELDS.map((field) => {
    const value = line[field];
    return [field, value instanceof Date ? value.toISOString() : value ?? null];
  }));
  return createHash("sha256").update(canonicalJson(values)).digest("hex");
}

export function versionShipmentLine<T extends InboundShipmentLine>(line: T) {
  return { ...line, version: shipmentLineVersion(line) };
}
