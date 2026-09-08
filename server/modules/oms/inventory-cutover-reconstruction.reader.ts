import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { CutoverReconstructionEvidence } from "@shared/types/inventory-cutover-reconstruction";

export async function readOmsCutoverReconstruction(client: PoolClient): Promise<Pick<CutoverReconstructionEvidence,
  "acceptedOmsDemand" | "shipmentReviewEvidence">> {
  const acceptedOmsDemand = (await client.query(`SELECT line.id::text AS "lineId", line.order_id::text AS "orderId",
    line.product_variant_id AS "productVariantId", line.sku,
    line.authority_fulfillable_quantity::text AS "authorizedQty", line.wms_materialized_quantity::text AS "materializedQty",
    line.authorization_status AS "authorizationStatus"
    FROM oms.oms_order_lines line LEFT JOIN oms.oms_orders parent ON parent.id=line.order_id
    WHERE (parent.id IS NULL OR parent.status NOT IN ('shipped','delivered','cancelled'))
      AND line.requires_shipping IS DISTINCT FROM false
      AND (line.authority_fulfillable_quantity<>0 OR (line.authorization_status='authorized' AND line.quantity>0))
    ORDER BY line.id LIMIT 100001`)).rows;
  const receiptRows = (await client.query(`SELECT id::text, processing_status AS status, to_jsonb(receipt) AS evidence
    FROM oms.channel_fulfillment_receipts receipt
    WHERE processing_status IS DISTINCT FROM 'processed'
    ORDER BY id LIMIT 100001`)).rows;
  if (acceptedOmsDemand.length > 100_000 || receiptRows.length > 100_000) throw new Error("OMS_CUTOVER_CENSUS_LIMIT_EXCEEDED");
  return { acceptedOmsDemand, shipmentReviewEvidence: receiptRows.map((row) => ({ id: row.id, kind: "channel_fulfillment_receipt",
    status: row.status, evidenceHash: createHash("sha256").update(canonicalJson(row.evidence)).digest("hex") })) };
}
