import type { CostIssue } from "@shared/procurement/cost-source-contracts";
import { currentShipmentCostSourceIssue, shipmentCostSourceReadRequirement } from "./domain/current-shipment-cost-source";
import { readCurrentShipmentSourceFingerprintBatch, readShipmentCostExceptions, type ShipmentExceptionReader } from "./shipment-cost-exception.repository";

/** All consumers compare live economic inputs in their existing read snapshot.
 * Reuse each shipment fingerprint batch for the reconciliation read as well. */
export async function readShipmentCostPostingEvidence(tx: ShipmentExceptionReader, lines: readonly {
  lineId: number;
  shipmentId: number;
  contract: unknown;
}[]) {
  const shipmentIds = [...new Set(lines.filter(line => shipmentCostSourceReadRequirement(line).needsCurrentFingerprint).map(line => line.shipmentId))];
  const current = shipmentIds.length ? await readCurrentShipmentSourceFingerprintBatch(tx, shipmentIds) : new Map<number, Map<number, string>>();
  const sourceIssues = new Map<number, CostIssue | null>(lines.map(line => [line.lineId, currentShipmentCostSourceIssue({
    ...line, currentFingerprint: current.get(line.shipmentId)?.get(line.lineId),
  })]));
  // Accepted/reconciled exceptions still perform their own lazy current-source
  // comparison. A saved issue cannot authorize skipping that freshness check.
  const exceptions = await readShipmentCostExceptions(tx, lines.map(line => line.lineId), current);
  return { sourceIssues, exceptions };
}
