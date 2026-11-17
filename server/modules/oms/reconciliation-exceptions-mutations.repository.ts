import type { PoolClient } from "pg";
import { sql } from "drizzle-orm";

export async function touchExactHistoricalContentsReconciliationExceptionInTx(
  client: PoolClient,
  exceptionId: string | number,
  summary: string,
): Promise<void> {
  await client.query(
    `UPDATE wms.reconciliation_exceptions
     SET last_seen_at = transaction_timestamp(),
         occurrence_count = occurrence_count + 1,
         summary = $2,
         updated_at = transaction_timestamp()
     WHERE id = $1::bigint`,
    [exceptionId, summary],
  );
}

export async function reopenRefreshedHistoricalContentsReconciliationExceptionInTx(
  client: PoolClient,
  exceptionId: string | number,
  refreshedDetailsJson: string,
  summary: string,
): Promise<void> {
  await client.query(
    `UPDATE wms.reconciliation_exceptions
     SET classification = 'manual_review',
         status = 'open',
         severity = 'review',
         last_seen_at = transaction_timestamp(),
         occurrence_count = occurrence_count + 1,
         details = $2::jsonb,
         summary = $3,
         resolved_at = NULL,
         resolved_by = NULL,
         resolution = NULL,
         updated_at = transaction_timestamp()
     WHERE id = $1::bigint`,
    [exceptionId, refreshedDetailsJson, summary],
  );
}

export async function insertHistoricalContentsReconciliationExceptionInTx(
  client: PoolClient,
  input: {
    rule: string;
    wmsOrderId: number | null;
    wmsShipmentId: number | null;
    externalOrderRef: string | null;
    externalShipmentRef: string;
    idempotencyKey: string;
    summary: string;
    detailsJson: string;
  },
): Promise<{ rows: Array<{ id?: unknown }> }> {
  return client.query(
    `INSERT INTO wms.reconciliation_exceptions (
       source, classification, rule, status, severity,
       wms_order_id, wms_shipment_id,
       external_system, external_order_ref, external_shipment_ref,
       idempotency_key, summary, details
     ) VALUES (
       'historical_shipstation_contents_system_recovery',
       'manual_review', $1, 'open', 'review',
       $2, $3, 'shipstation', $4, $5, $6, $7, $8::jsonb
     )
     RETURNING id::text AS id`,
    [
      input.rule,
      input.wmsOrderId,
      input.wmsShipmentId,
      input.externalOrderRef,
      input.externalShipmentRef,
      input.idempotencyKey,
      input.summary,
      input.detailsJson,
    ],
  );
}

export async function resolveWmsConfirmedHistoricalContentsReconciliationExceptionInTx(
  client: PoolClient,
  input: {
    exceptionId: string;
    patchDetailsJson: string;
    resolvedBy: string;
    resolution: string;
  },
): Promise<void> {
  await client.query(
    `UPDATE wms.reconciliation_exceptions
     SET classification = 'safe_auto_repair',
         status = 'resolved',
         severity = 'info',
         details = details || $2::jsonb,
         resolved_at = transaction_timestamp(),
         resolved_by = $3,
         resolution = $4,
         updated_at = transaction_timestamp()
     WHERE id = $1::bigint`,
    [input.exceptionId, input.patchDetailsJson, input.resolvedBy, input.resolution],
  );
}

export async function acknowledgeHistoricalContentsReconciliationExceptionDecisionInTx(
  client: PoolClient,
  input: {
    exceptionId: string;
    classification: string;
    severity: string;
    decisionDetailsJson: string;
    auditEvidenceJson: string;
    decisionHash: string;
    rule: string;
  },
): Promise<{ rows: Array<{ id?: unknown; status?: string }> }> {
  return client.query(
    `UPDATE wms.reconciliation_exceptions
     SET classification = $2,
         status = 'acknowledged',
         severity = $3,
         details = details
           || $4::jsonb
           || jsonb_build_object(
                'decisionRecordedAt', transaction_timestamp(),
                'decisionHistory',
                COALESCE(details->'decisionHistory', '[]'::jsonb)
                  || jsonb_build_array(
                       $5::jsonb || jsonb_build_object(
                         'decisionHash', $6::text,
                         'recordedAt', transaction_timestamp()
                       )
                     )
              ),
         resolved_by = NULL,
         resolution = NULL,
         updated_at = transaction_timestamp()
     WHERE id = $1::bigint
       AND rule = $7
       AND status IN ('open', 'acknowledged')
     RETURNING id::text AS id, status`,
    [
      input.exceptionId,
      input.classification,
      input.severity,
      input.decisionDetailsJson,
      input.auditEvidenceJson,
      input.decisionHash,
      input.rule,
    ],
  );
}

export async function upsertLabelCommercialReconciliationExceptionInOms(
  executor: { execute: (...args: any[]) => any },
  input: {
    rule: string;
    externalOrderRef: string | null;
    externalShipmentRef: string;
    externalOrderKey: string | null;
    idempotencyKey: string;
    summary: string;
    detailsJson: string;
  },
): Promise<void> {
  await executor.execute(sql`
    INSERT INTO wms.reconciliation_exceptions (
      source,
      classification,
      rule,
      status,
      severity,
      external_system,
      external_order_ref,
      external_shipment_ref,
      external_order_key,
      idempotency_key,
      summary,
      details
    )
    SELECT
      'shipstation_label_commercial_fulfillment',
      'manual_review',
      ${input.rule},
      'open',
      'review',
      'shipstation',
      ${input.externalOrderRef},
      ${input.externalShipmentRef},
      ${input.externalOrderKey},
      ${input.idempotencyKey},
      ${input.summary},
      ${input.detailsJson}::jsonb
    WHERE NOT EXISTS (
      SELECT 1
      FROM wms.reconciliation_exceptions AS existing
      WHERE existing.idempotency_key = ${input.idempotencyKey}
        AND existing.status IN ('resolved', 'ignored')
    )
    ON CONFLICT (idempotency_key)
      WHERE status IN ('open', 'acknowledged')
    DO UPDATE SET
      last_seen_at = NOW(),
      updated_at = NOW(),
      occurrence_count = wms.reconciliation_exceptions.occurrence_count + 1,
      summary = EXCLUDED.summary,
      details = wms.reconciliation_exceptions.details || EXCLUDED.details
  `);
}
