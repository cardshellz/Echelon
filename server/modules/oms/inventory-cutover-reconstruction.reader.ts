import type { PoolClient } from "pg";
import type { CutoverReconstructionEvidence } from "@shared/types/inventory-cutover-reconstruction";
import { groupCutoverReceiptEvidence } from "./domain/inventory-cutover-receipt-evidence";

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
  const receiptRows = (await client.query(`SELECT receipt.id::text, receipt.processing_status AS status,
      receipt.error_code AS "errorCode", receipt.attempt_count AS "attemptCount",
      receipt.source_provider AS "sourceProvider", receipt.source_channel_id::text AS "sourceChannelId",
      receipt.source_order_id AS "sourceOrderId", receipt.source_fulfillment_id AS "sourceFulfillmentId",
      receipt.oms_order_id::text AS "omsOrderId", receipt.physical_shipment_id::text AS "physicalShipmentId",
      attempt.attempt_number AS "attemptNumber", attempt.outcome AS "attemptOutcome",
      attempt.error_code AS "attemptErrorCode", attempt.metadata->'sourceEcho' AS "sourceEcho",
      -- Preserve JSONB numbers as database text before pg's JSON decoder can
      -- round bigint identities or provider payload values beyond 2^53.
      jsonb_build_object('receiptJson',to_jsonb(receipt)::text,'latestAttemptJson',to_jsonb(attempt)::text) AS evidence
    FROM oms.channel_fulfillment_receipts receipt
    LEFT JOIN LATERAL (SELECT * FROM oms.channel_fulfillment_receipt_attempts
      WHERE receipt_id=receipt.id ORDER BY attempt_number DESC LIMIT 1) attempt ON true
    WHERE receipt.processing_status IS DISTINCT FROM 'processed'
    ORDER BY receipt.id LIMIT 100001`)).rows;
  if (acceptedOmsDemand.length > 100_000 || receiptRows.length > 100_000) throw new Error("OMS_CUTOVER_CENSUS_LIMIT_EXCEEDED");
  return { acceptedOmsDemand, shipmentReviewEvidence: groupCutoverReceiptEvidence(receiptRows) };
}
