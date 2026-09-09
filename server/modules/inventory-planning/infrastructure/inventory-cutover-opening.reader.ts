import type { PoolClient } from "pg";
import { openingAssessmentSchema, openingSavedSchema, openingSaveRequestSchema, openingVerificationSchema,
  type OpeningAssessment, type OpeningSaved, type OpeningVerification } from "@shared/types/inventory-cutover-opening";
import { InventoryCutoverOpeningError } from "../application/inventory-cutover-opening.service";
import { evaluateCutoverOpening } from "../domain/inventory-cutover-opening";
import { reconstructionHash } from "../domain/inventory-cutover-reconstruction";

export interface StoredCutoverOpening {
  saved: OpeningSaved;
  verification: OpeningVerification;
  assessment: OpeningAssessment;
  requestHash: string;
}

const columns = `id::text, authority_revision::text, configuration_run_id::text, source_evidence_hash,
  verification_hash, historical_exception_hash, request_hash, result_hash, evidence_payload,
  verification_payload, assessment_payload, request_payload, result_payload, actor, reason, idempotency_key,
  verified_at, occurred_at`;

/** No capture, mutation, transaction ownership or fallback to an older record. */
export async function loadLatestCutoverOpening(client: Pick<PoolClient, "query">): Promise<StoredCutoverOpening | null> {
  const rows = (await client.query(`SELECT ${columns}
    FROM inventory.availability_cutover_opening_snapshots ORDER BY id DESC LIMIT 1`)).rows;
  return rows.length === 0 ? null : validateStoredCutoverOpening(rows[0]);
}

export async function loadCutoverOpeningReplay(client: Pick<PoolClient, "query">, key: string): Promise<StoredCutoverOpening | null> {
  const rows = (await client.query(`SELECT ${columns}
    FROM inventory.availability_cutover_opening_snapshots WHERE idempotency_key=$1`, [key])).rows;
  if (rows.length > 1) throw corrupt();
  return rows.length === 0 ? null : validateStoredCutoverOpening(rows[0]);
}

/** Validate the full immutable audit, not only the receipt shown to the client. */
export function validateStoredCutoverOpening(row: Record<string, unknown>): StoredCutoverOpening {
  try {
    const saved = openingSavedSchema.parse(row.result_payload);
    const verification = openingVerificationSchema.parse(row.verification_payload);
    const assessment = openingAssessmentSchema.parse(row.assessment_payload);
    const request = openingSaveRequestSchema.parse(row.request_payload);
    // The evaluator validates unknown source evidence at its boundary and
    // rebuilds the complete assessment. Do not retain an extra parsed census.
    const rebuilt = evaluateCutoverOpening(row.evidence_payload, verification);
    if (!assessment.ready || !assessment.plan.ready || saved.alreadyApplied
      || row.id !== saved.id || row.authority_revision !== saved.authorityRevision
      || row.authority_revision !== verification.expectedAuthorityRevision
      || row.configuration_run_id !== verification.expectedConfigurationRunId
      || row.source_evidence_hash !== saved.sourceEvidenceHash
      || row.source_evidence_hash !== verification.expectedEvidenceHash
      || row.source_evidence_hash !== rebuilt.sourceEvidenceHash
      || row.verification_hash !== saved.verificationHash || row.verification_hash !== assessment.verificationHash
      || row.historical_exception_hash !== saved.historicalExceptionHash
      || row.historical_exception_hash !== assessment.historicalExceptionHash
      || saved.historicalExceptionCount !== assessment.historicalExceptions.length
      || saved.actor !== row.actor || saved.reason !== row.reason || request.reason !== row.reason
      || request.idempotencyKey !== row.idempotency_key
      || saved.verifiedAt !== verification.verifiedAt
      || new Date(row.verified_at as string | Date).getTime() !== Date.parse(verification.verifiedAt)
      || !Number.isFinite(new Date(row.occurred_at as string | Date).getTime())
      || Date.parse(verification.verifiedAt) > new Date(row.occurred_at as string | Date).getTime()
      || reconstructionHash(request.verification) !== reconstructionHash(verification)
      || reconstructionHash({ contractVersion: "inventory_cutover_opening_save_v1", actor: saved.actor, ...request }) !== row.request_hash
      || reconstructionHash(saved) !== row.result_hash
      || reconstructionHash(rebuilt) !== reconstructionHash(assessment)) throw corrupt();
    return { saved, verification, assessment, requestHash: row.request_hash as string };
  } catch (error) {
    if (error instanceof InventoryCutoverOpeningError) throw error;
    throw corrupt(error);
  }
}

function corrupt(cause?: unknown): InventoryCutoverOpeningError {
  return new InventoryCutoverOpeningError("CUTOVER_OPENING_RECEIPT_INVALID",
    "The immutable opening verification failed integrity validation.", 500, {}, { cause });
}
