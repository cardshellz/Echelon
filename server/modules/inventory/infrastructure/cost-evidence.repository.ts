import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJson } from "@shared/utils/canonical-json";
import { type CostSourceRevision } from "@shared/procurement/cost-source-contracts";

export interface CostEvidenceTransaction {
  execute(query: unknown): Promise<{ rows: any[] }>;
}

export class CostEvidenceError extends Error {
  readonly statusCode = 409;
  constructor(readonly code: string, message: string, readonly context: Record<string, unknown> = {}) {
    super(message);
    this.name = "CostEvidenceError";
  }
}

export function costFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function costInteger(value: unknown, field: string, minimum = 0): number {
  const parsed = typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new CostEvidenceError("COST_EVIDENCE_INVALID_INTEGER", `${field} is not a supported integer.`, { field });
  }
  return parsed;
}

/** All graph writers take this transaction lock before reading source costs or
 * locking source, catalog, location or lot rows. Cost applications never acquire
 * location rows. This intentionally serializes cost graph
 * mutation until a finer protocol can prove the same graph completeness. */
export async function lockInventoryCostGraph(tx: CostEvidenceTransaction): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('inventory.cost_graph'), hashtext('version_1'))`);
}

export type CostRevisionInput = Omit<CostSourceRevision, "revision" | "fingerprint">;
export type RecordedCostRevision = { id: number; contract: CostSourceRevision };

export interface ReceiptCostOrigin {
  inventoryLotId: number;
  receivingLineId: number;
  purchaseOrderLineId: number;
  inboundShipmentLineId: number | null;
  unitsPerVariantSnapshot: number;
  receivedVariantQty: number;
}

export async function recordReceiptCostOrigin(
  tx: CostEvidenceTransaction,
  input: ReceiptCostOrigin,
  actorId: string,
  now: Date,
): Promise<void> {
  for (const [key, value] of Object.entries(input)) if (value !== null) costInteger(value, key, 1);
  await lockInventoryCostGraph(tx);
  if (!actorId?.trim() || !(now instanceof Date) || !Number.isFinite(now.getTime())) throw new CostEvidenceError("COST_AUDIT_IDENTITY_REQUIRED", "Receipt cost origin requires audit identity.");
  const evidence = await tx.execute(sql`
    SELECT lot.qty_received,lot.product_variant_id,lot.receiving_order_id,lot.po_line_id,
      line.receiving_order_id AS source_receipt_id,line.purchase_order_line_id,line.inbound_shipment_line_id,
      line.product_variant_id AS source_variant_id,line.units_per_variant_snapshot
    FROM inventory.inventory_lots lot JOIN procurement.receiving_lines line ON line.id=${input.receivingLineId}
    WHERE lot.id=${input.inventoryLotId}
  `);
  const row = evidence.rows[0];
  if (!row || costInteger(row.qty_received, "lot.qtyReceived", 1) !== input.receivedVariantQty
    || Number(row.po_line_id) !== input.purchaseOrderLineId || Number(row.purchase_order_line_id) !== input.purchaseOrderLineId
    || Number(row.receiving_order_id) !== Number(row.source_receipt_id) || Number(row.product_variant_id) !== Number(row.source_variant_id)
    || Number(row.units_per_variant_snapshot) !== input.unitsPerVariantSnapshot
    || (row.inbound_shipment_line_id === null ? null : Number(row.inbound_shipment_line_id)) !== input.inboundShipmentLineId) {
    throw new CostEvidenceError("COST_RECEIPT_ORIGIN_CONFLICT", "Lot, receipt, purchase line and frozen unit evidence do not identify the same original receipt.");
  }
  // Freeze the original source interval once. Later transfers are contribution
  // edges, never new purchase quantities. Reversals retain these original facts.
  const offsets = await tx.execute(sql`
    SELECT COALESCE(SUM(received_variant_qty::bigint * units_per_variant_snapshot)
      FILTER (WHERE purchase_order_line_id = ${input.purchaseOrderLineId}),0) AS purchase_start,
      COALESCE(SUM(received_variant_qty::bigint * units_per_variant_snapshot)
      FILTER (WHERE inbound_shipment_line_id = ${input.inboundShipmentLineId}),0) AS shipment_start
    FROM inventory.lot_cost_origins
    WHERE purchase_order_line_id = ${input.purchaseOrderLineId}
       OR inbound_shipment_line_id = ${input.inboundShipmentLineId}
  `);
  const purchaseStart = costInteger(offsets.rows[0]?.purchase_start, "purchaseStart");
  const shipmentStart = input.inboundShipmentLineId === null ? null : costInteger(offsets.rows[0]?.shipment_start, "shipmentStart");
  await tx.execute(sql`
    INSERT INTO inventory.lot_cost_origins
      (inventory_lot_id,receiving_line_id,purchase_order_line_id,inbound_shipment_line_id,units_per_variant_snapshot,
       received_variant_qty,purchase_start_base_piece,shipment_start_base_piece,recorded_by,recorded_at)
    VALUES (${input.inventoryLotId},${input.receivingLineId},${input.purchaseOrderLineId},${input.inboundShipmentLineId},
      ${input.unitsPerVariantSnapshot},${input.receivedVariantQty},${purchaseStart},${shipmentStart},${actorId},${now})
  `);
}

export interface LotCostContribution {
  sourceLotId: number;
  outputLotId: number;
  sourceQty: number;
  outputQty: number;
  outputStartQty?: number;
  operationKind: "transfer" | "conversion" | "assembly" | "build";
  operationKey: string;
}

export async function recordLotCostContribution(
  tx: CostEvidenceTransaction, contribution: LotCostContribution, actorId: string, now: Date,
): Promise<void> {
  for (const key of ["sourceLotId", "outputLotId", "sourceQty", "outputQty"] as const) costInteger(contribution[key], key, 1);
  const outputStartQty = costInteger(contribution.outputStartQty ?? 0, "outputStartQty");
  if (outputStartQty >= contribution.outputQty) throw new CostEvidenceError("COST_OUTPUT_INTERVAL_INVALID", "Cost output interval is outside the operation output.");
  if (contribution.sourceLotId === contribution.outputLotId || !contribution.operationKey.trim() || !actorId.trim() || !Number.isFinite(now.getTime())) {
    throw new CostEvidenceError("COST_LINEAGE_INVALID", "A cost contribution needs distinct lots and an audited operation.");
  }
  if (!["transfer", "conversion", "assembly", "build"].includes(contribution.operationKind)) throw new CostEvidenceError("COST_OPERATION_KIND_INVALID", "Cost operation kind is unsupported.");
  await lockInventoryCostGraph(tx);
  const bounds = await tx.execute(sql`
    SELECT source.qty_received AS source_qty,output.qty_received AS output_qty
    FROM inventory.inventory_lots source JOIN inventory.inventory_lots output ON output.id=${contribution.outputLotId}
    WHERE source.id=${contribution.sourceLotId}
  `);
  const row = bounds.rows[0];
  if (!row || costInteger(row.source_qty, "sourceLot.qtyReceived", 1) < contribution.sourceQty
    || BigInt(costInteger(row.output_qty, "outputLot.qtyReceived", 1)) + BigInt(outputStartQty) > BigInt(contribution.outputQty)) {
    throw new CostEvidenceError("COST_CONTRIBUTION_INTERVAL_INVALID", "The input quantity or output interval exceeds the recorded original lot quantity.");
  }
  const conflict = await tx.execute(sql`
    SELECT id FROM inventory.lot_cost_contributions WHERE output_lot_id=${contribution.outputLotId}
      AND (operation_key<>${contribution.operationKey} OR output_qty<>${contribution.outputQty} OR output_start_qty<>${outputStartQty}) LIMIT 1
  `);
  if (conflict.rows.length > 0) throw new CostEvidenceError("COST_CONTRIBUTION_OUTPUT_CONFLICT", "An output lot already belongs to a different operation interval.");
  const cycle = await tx.execute(sql`
    WITH RECURSIVE descendants(id) AS (
      SELECT output_lot_id FROM inventory.lot_cost_contributions WHERE source_lot_id = ${contribution.outputLotId}
      UNION SELECT edge.output_lot_id FROM inventory.lot_cost_contributions edge JOIN descendants d ON edge.source_lot_id = d.id
    ) SELECT id FROM descendants WHERE id = ${contribution.sourceLotId} LIMIT 1
  `);
  if (cycle.rows.length > 0) throw new CostEvidenceError("COST_LINEAGE_CYCLE", "Cost lineage would form a cycle.");
  await tx.execute(sql`
    INSERT INTO inventory.lot_cost_contributions
      (source_lot_id,output_lot_id,operation_kind,operation_key,source_qty,output_qty,output_start_qty,recorded_by,recorded_at)
    VALUES (${contribution.sourceLotId},${contribution.outputLotId},${contribution.operationKind},${contribution.operationKey},
      ${contribution.sourceQty},${contribution.outputQty},${outputStartQty},${actorId},${now})
  `);
}
