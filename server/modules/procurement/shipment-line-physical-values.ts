import { ShipmentTrackingError } from "./shipment-tracking.service";
import { computeShipmentPhysicalTotals, summarizeShipmentPhysicalValues, validateMaterializedShipmentPhysicalTotals,
  ShipmentPhysicalValuesError, type ShipmentPhysicalSource } from "@shared/procurement/shipment-physical-values";

/** Preserve the existing command/HTTP error contract at this boundary. */
function physicalBoundary<T>(work: () => T): T {
  try { return work(); }
  catch (error) {
    if (error instanceof ShipmentPhysicalValuesError) throw new ShipmentTrackingError(error.message, error.statusCode, error.details);
    throw error;
  }
}

export const computeShipmentLinePhysicalTotals = (line: ShipmentPhysicalSource) => physicalBoundary(() => computeShipmentPhysicalTotals(line));
export const summarizeShipmentPhysicalTotals = (lines: readonly ShipmentPhysicalSource[]) => physicalBoundary(() => summarizeShipmentPhysicalValues(lines));

export function validateShipmentPhysicalTotals(lines: Array<{
  id?: number; qtyShipped: number; cartonCount: number | null; totalWeightKg: string | null; totalVolumeCbm: string | null; chargeableWeightKg?: string | null;
} & ShipmentPhysicalSource>) {
  return physicalBoundary(() => validateMaterializedShipmentPhysicalTotals(lines));
}
