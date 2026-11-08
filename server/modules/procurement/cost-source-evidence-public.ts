import { sql } from "drizzle-orm";
import { costInteger, type CostEvidenceTransaction } from "../inventory/infrastructure/cost-evidence.repository";

export interface ReceivingLineCostProvenance {
  receivingLineId: number;
  cost_source_kind: string | null;
  cost_source_evidence: Record<string, any> | null;
  has_reversal: boolean;
}

export interface LatestLandedCostRevisionRow {
  sourceRevisionId: number;
  inbound_shipment_line_id: number;
  contract: unknown;
}

export interface LatestSupplierCostRevisionRow {
  sourceRevisionId: number;
  component: string;
  fingerprint: string;
}

/**
 * Public transaction-aware procurement reader for receiving line cost provenance
 * (`procurement.receiving_lines` and `procurement.receipt_reversals`).
 * Keeps concrete procurement schema queries inside the procurement module.
 */
export async function readReceivingLineCostProvenance(
  tx: CostEvidenceTransaction,
  receivingLineIds: readonly number[],
): Promise<Map<number, ReceivingLineCostProvenance>> {
  const uniqueIds = [...new Set(receivingLineIds.map((id) => costInteger(id, "receivingLineId", 1)))].sort((a, b) => a - b);
  if (uniqueIds.length === 0) return new Map();

  const rows = (
    await tx.execute(sql`
      SELECT
        line.id AS receiving_line_id,
        line.cost_source_kind,
        line.cost_source_evidence,
        EXISTS(
          SELECT 1
          FROM procurement.receipt_reversals reversal
          WHERE reversal.receiving_line_id = line.id
        ) AS has_reversal
      FROM procurement.receiving_lines line
      WHERE line.id IN (
        SELECT value::integer
        FROM jsonb_array_elements_text(${JSON.stringify(uniqueIds)}::jsonb)
      )
      ORDER BY line.id
    `)
  ).rows;

  const map = new Map<number, ReceivingLineCostProvenance>();
  for (const row of rows) {
    const receivingLineId = costInteger(row.receiving_line_id, "receivingLineId", 1);
    map.set(receivingLineId, {
      receivingLineId,
      cost_source_kind: row.cost_source_kind == null ? null : String(row.cost_source_kind),
      cost_source_evidence: (row.cost_source_evidence as Record<string, any> | null) ?? null,
      has_reversal: Boolean(row.has_reversal),
    });
  }
  return map;
}

/**
 * Public transaction-aware procurement reader for the latest landed cost source
 * revisions (`procurement.cost_source_revisions`) for inbound shipment lines.
 */
export async function readLatestLandedCostRevisions(
  tx: CostEvidenceTransaction,
  inboundShipmentLineIds: readonly number[],
): Promise<LatestLandedCostRevisionRow[]> {
  const uniqueIds = [...new Set(inboundShipmentLineIds.map((id) => costInteger(id, "shipment line", 1)))];
  if (uniqueIds.length === 0) return [];

  const rows = (
    await tx.execute(sql`
      SELECT
        revision.id AS source_revision_id,
        revision.inbound_shipment_line_id,
        revision.contract
      FROM procurement.cost_source_revisions revision
      WHERE revision.component = 'landed'
        AND revision.inbound_shipment_line_id = ANY(${sql.param(uniqueIds)}::int[])
        AND NOT EXISTS(
          SELECT 1
          FROM procurement.cost_source_revisions newer
          WHERE newer.inbound_shipment_line_id = revision.inbound_shipment_line_id
            AND newer.component = 'landed'
            AND newer.revision > revision.revision
        )
    `)
  ).rows;

  return rows.map((row) => ({
    sourceRevisionId: costInteger(row.source_revision_id, "sourceRevisionId", 1),
    inbound_shipment_line_id: costInteger(row.inbound_shipment_line_id, "inboundShipmentLineId", 1),
    contract: row.contract,
  }));
}

/**
 * Public transaction-aware procurement reader for the latest supplier (`product` /
 * `packaging`) cost source revisions for a purchase order line.
 */
export async function readLatestSupplierCostRevisions(
  tx: CostEvidenceTransaction,
  purchaseOrderLineId: number,
): Promise<LatestSupplierCostRevisionRow[]> {
  const lineId = costInteger(purchaseOrderLineId, "purchaseOrderLineId", 1);
  const rows = (
    await tx.execute(sql`
      SELECT
        revision.id AS source_revision_id,
        revision.component,
        revision.fingerprint
      FROM procurement.cost_source_revisions revision
      WHERE revision.purchase_order_line_id = ${lineId}
        AND revision.inbound_shipment_line_id IS NULL
        AND revision.component IN ('product', 'packaging')
        AND NOT EXISTS(
          SELECT 1
          FROM procurement.cost_source_revisions newer
          WHERE newer.purchase_order_line_id = revision.purchase_order_line_id
            AND newer.inbound_shipment_line_id IS NULL
            AND newer.component = revision.component
            AND newer.revision > revision.revision
        )
    `)
  ).rows;

  return rows.map((row) => ({
    sourceRevisionId: costInteger(row.source_revision_id, "sourceRevisionId", 1),
    component: String(row.component),
    fingerprint: String(row.fingerprint),
  }));
}
