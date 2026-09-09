import type { PoolClient } from "pg";
import type { CutoverReconstructionEvidence } from "@shared/types/inventory-cutover-reconstruction";
import { CUTOVER_RECEIPT_EVIDENCE_FORMAT, groupCutoverReceiptEvidence } from "./domain/inventory-cutover-receipt-evidence";

const MAX_CENSUS_ROWS = 100_000;

export class OmsCutoverCensusLimitError extends Error {
  readonly code = "OMS_CUTOVER_CENSUS_LIMIT_EXCEEDED";
  constructor() {
    super("OMS cutover evidence exceeds the complete bounded census; no partial result is returned.");
    this.name = "OmsCutoverCensusLimitError";
  }
}

async function readReceiptEvidence(client: PoolClient): Promise<Record<string, unknown>[]> {
  // One SQL statement keeps receipts and attempts in one statement snapshot even
  // when the final commit uses READ COMMITTED under its admission barrier.
  // Independent keyset pages could combine states from different snapshots.
  const rows = (await client.query<Record<string, unknown>>(`SELECT receipt.id::text, receipt.processing_status AS status,
        receipt.error_code AS "errorCode", receipt.attempt_count AS "attemptCount",
        receipt.source_provider AS "sourceProvider", receipt.source_channel_id::text AS "sourceChannelId",
        receipt.source_order_id AS "sourceOrderId", receipt.source_fulfillment_id AS "sourceFulfillmentId",
        receipt.oms_order_id::text AS "omsOrderId", receipt.physical_shipment_id::text AS "physicalShipmentId",
        attempt.attempt_number AS "attemptNumber", attempt.outcome AS "attemptOutcome",
        attempt.error_code AS "attemptErrorCode",
        -- Only the JSON boolean true qualifies; malformed values remain in the
        -- complete digest, but cannot transport an unbounded metadata subtree.
        (attempt.metadata->'sourceEcho' = 'true'::jsonb) AS "sourceEcho",
        -- Hash the entire receipt AND latest attempt, including unknown/future
        -- columns and exact JSONB numerics, before pg decodes or transfers them.
        -- Never substitute provider hashes or only the classification columns.
        jsonb_build_object('format',$1::text,'databaseRowHash',
          encode(sha256(convert_to(jsonb_build_object('receipt',to_jsonb(receipt),
            'latestAttempt',to_jsonb(attempt))::text,'UTF8')),'hex')) AS evidence
      FROM oms.channel_fulfillment_receipts receipt
      LEFT JOIN LATERAL (SELECT * FROM oms.channel_fulfillment_receipt_attempts
        WHERE receipt_id=receipt.id ORDER BY attempt_number DESC LIMIT 1) attempt ON true
      WHERE receipt.processing_status IS DISTINCT FROM 'processed'
      ORDER BY receipt.id LIMIT $2`, [CUTOVER_RECEIPT_EVIDENCE_FORMAT, MAX_CENSUS_ROWS + 1])).rows;
  if (rows.length > MAX_CENSUS_ROWS) throw new OmsCutoverCensusLimitError();
  return rows;
}

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
  if (acceptedOmsDemand.length > MAX_CENSUS_ROWS) throw new OmsCutoverCensusLimitError();
  const receiptRows = await readReceiptEvidence(client);
  return { acceptedOmsDemand, shipmentReviewEvidence: groupCutoverReceiptEvidence(receiptRows) };
}
