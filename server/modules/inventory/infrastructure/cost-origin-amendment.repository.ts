import { sql } from "drizzle-orm";
import {
  costInteger,
  lockInventoryCostGraph,
  type CostEvidenceTransaction,
} from "./cost-evidence.repository";

export interface CostOriginAmendment {
  amendmentId: number;
  inventoryLotId: number;
  unitsPerVariantSnapshot: number;
  purchaseStartBasePiece: number;
  shipmentStartBasePiece: number | null;
}

/** Append an approved interpretation; never rewrite the original receipt origin.
 * The database also verifies ownership and requires the completed approval audit. */
export async function recordCostOriginAmendment(
  tx: CostEvidenceTransaction,
  input: CostOriginAmendment,
): Promise<void> {
  for (const field of [
    "amendmentId",
    "inventoryLotId",
    "unitsPerVariantSnapshot",
  ] as const)
    costInteger(input[field], field, 1);
  costInteger(input.purchaseStartBasePiece, "purchaseStartBasePiece");
  if (input.shipmentStartBasePiece !== null)
    costInteger(input.shipmentStartBasePiece, "shipmentStartBasePiece");
  await lockInventoryCostGraph(tx);
  await tx.execute(sql`INSERT INTO inventory.lot_cost_origin_amendments
    (amendment_id,inventory_lot_id,units_per_variant_snapshot,purchase_start_base_piece,shipment_start_base_piece)
    VALUES(${input.amendmentId},${input.inventoryLotId},${input.unitsPerVariantSnapshot},
      ${input.purchaseStartBasePiece},${input.shipmentStartBasePiece})`);
}
