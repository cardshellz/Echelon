import { costInteger } from "../inventory/infrastructure/cost-evidence-values";
import { ShipmentTrackingError } from "./shipment-tracking.service";

export function rejectShipmentEdit(message: string, code: string, status = 409): never {
  throw new ShipmentTrackingError(message, status, { code });
}

export function sumShipmentCents(values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + BigInt(costInteger(value, "shipment cost", -Number.MAX_SAFE_INTEGER)), BigInt(0));
  return costInteger(total.toString(), "shipment cost total", -Number.MAX_SAFE_INTEGER);
}

export function shipmentEditorBlockedReason(facts: {
  status: string; hasReceipts: boolean; hasPostedCosts: boolean; chargeCurrencies: readonly (string | null)[];
}): string | null {
  if (facts.status === "cancelled") return "This shipment is cancelled. Create a shipment for new goods.";
  if (facts.status === "closed" || facts.hasReceipts || facts.hasPostedCosts) {
    return "This shipment has completed or receiving history. Its physical lines must stay linked to those records. Use Receipt and quantity corrections to correct existing goods and their costs.";
  }
  if (facts.chargeCurrencies.some(currency => currency !== "USD")) {
    return "Shipment cost allocation supports USD charges. Review the missing or unsupported charge currency before changing the shipment's cost shares.";
  }
  return null;
}
