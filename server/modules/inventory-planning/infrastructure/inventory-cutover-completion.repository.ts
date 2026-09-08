import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { finishInventoryCutoverRequestSchema, finishInventoryCutoverResultSchema, inventoryCutoverVerificationSchema,
  type FinishInventoryCutoverResult, type InventoryCutoverVerification } from "@shared/types/inventory-cutover-completion";
import { InventoryCutoverCommitError } from "../application/inventory-cutover-commit.service";
import type { FinishInventoryCutoverCommand, InventoryCutoverCompletionStore } from "../application/inventory-cutover-completion.service";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";
import { committedInventoryPublicationManifestSchema, validateInventoryCutoverFullPublicationProof } from "../domain/inventory-cutover-full-publication-proof";
import { validateCutoverDrainReadbacks } from "../domain/inventory-cutover-drain-readback-proof";
import { inInventoryCutoverTransaction, lockInventoryCutoverCommandInsideTransaction } from "./inventory-cutover-commit.repository";
import { acquireInventoryCutoverFenceInsideTransaction } from "./inventory-cutover-admission-fence.repository";
import { captureQuantityPublicationDrainInsideTransaction, releaseQuantityPublicationSuppressionInsideTransaction } from "./quantity-publication-admission.repository";

const MAX_READBACK_AGE_MS = 15 * 60 * 1000;
const MAX_PUBLICATION_ROWS = 100_000;
type ReceiptRow = { activation_run_id: string; command_type: string; request_hash: string; result_hash: string; result_payload: unknown };

/** Finishing releases configuration only after exact latest-full-publication proof.
 * It does not publish to providers, restore legacy authority, or change stock.
 */
export class PostgresInventoryCutoverCompletionRepository implements InventoryCutoverCompletionStore {
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = defaultPool) {}

  async verify(runId: string, occurredAt: Date): Promise<InventoryCutoverVerification> {
    return inInventoryCutoverTransaction(this.connectionPool, "read_only_review", client =>
      captureInventoryCutoverVerificationInsideTransaction(client, runId, occurredAt));
  }

  async finish(command: FinishInventoryCutoverCommand): Promise<FinishInventoryCutoverResult> {
    const { actor, requestHash, occurredAt, ...rawRequest } = command;
    const request = finishInventoryCutoverRequestSchema.parse(rawRequest);
    z.object({ actor: z.string().trim().min(1).max(100), occurredAt: z.date() }).parse({ actor, occurredAt });
    if (inventoryCutoverEvidenceHash({ contractVersion: "inventory_cutover_finish_v1", actor, ...request }) !== requestHash) {
      throw new InventoryCutoverCommitError("CUTOVER_COMMAND_HASH_INVALID", "The semantic command hash is invalid.", 400);
    }
    return inInventoryCutoverTransaction(this.connectionPool, "admitted_commit", async client => {
      await lockInventoryCutoverCommandInsideTransaction(client, request.idempotencyKey);
      const previous = (await client.query<ReceiptRow>(`SELECT activation_run_id::text,command_type,request_hash,result_hash,result_payload
        FROM inventory.availability_activation_commands WHERE idempotency_key=$1`, [request.idempotencyKey])).rows;
      if (previous.length > 0) {
        if (previous.length !== 1 || previous[0].command_type !== "finish" || previous[0].request_hash !== requestHash
          || previous[0].activation_run_id !== request.activationRunId) {
          throw new InventoryCutoverCommitError("CUTOVER_IDEMPOTENCY_CONFLICT", "The command key belongs to different evidence or actor.");
        }
        return { ...parseCompletionReceipt(previous[0]), alreadyApplied: true };
      }
      const authority = await acquireInventoryCutoverFenceInsideTransaction(client, {
        expectedAuthority: "canonical", expectedConfigurationRunId: request.activationRunId,
      });
      const verification = await captureInventoryCutoverVerificationInsideTransaction(client, request.activationRunId, occurredAt);
      if (!verification.ready) throw new InventoryCutoverCommitError("CUTOVER_FULL_PUBLICATION_NOT_VERIFIED",
        "Resolve publication findings before releasing the configuration freeze.", 409, { blockers: verification.blockers });
      if (verification.verificationHash !== request.expectedVerificationHash || verification.authorityRevision !== authority.authorityRevision) {
        throw new InventoryCutoverCommitError("CUTOVER_VERIFICATION_CHANGED", "Publication evidence changed. Review the latest complete result before finishing.");
      }
      // Suppression release retains current-state catch-up obligations. It never
      // replays the old conservative quantities or reports them as restored.
      await releaseQuantityPublicationSuppressionInsideTransaction(client, {
        activationRunId: request.activationRunId, outcome: "completed", actor, now: occurredAt,
      });
      const released = await client.query(`UPDATE inventory.availability_activation_freezes
        SET released_by=$2,released_at=$3,release_reason=$4 WHERE activation_run_id=$1 AND released_at IS NULL`,
      [request.activationRunId, actor, occurredAt.toISOString(), request.reason]);
      if (released.rowCount !== 1) throw new InventoryCutoverCommitError("CUTOVER_CONFIGURATION_FREEZE_CHANGED", "The reviewed freeze could not be released exactly once.");
      const result = finishInventoryCutoverResultSchema.parse({ activationRunId: request.activationRunId,
        runtimeAuthority: "canonical", authorityRevision: authority.authorityRevision,
        verificationHash: verification.verificationHash, verifiedPublicationRows: verification.verifiedPublicationRows,
        completedAt: occurredAt.toISOString(), configurationFreezeReleased: true, alreadyApplied: false });
      const resultHash = inventoryCutoverEvidenceHash(result);
      await client.query(`INSERT INTO inventory.availability_activation_commands
        (activation_run_id,command_type,idempotency_key,request_hash,result_hash,request_payload,result_payload,actor,reason,occurred_at)
        VALUES ($1,'finish',$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)`,
      [request.activationRunId,request.idempotencyKey,requestHash,resultHash,JSON.stringify({ ...request,actor }),JSON.stringify(result),actor,request.reason,occurredAt.toISOString()]);
      await client.query(`INSERT INTO inventory.availability_activation_events
        (activation_run_id,from_state,to_state,actor,reason,evidence_hash,evidence_payload,occurred_at)
        VALUES ($1,'active','active',$2,$3,$4,$5::jsonb,$6)`,
      [request.activationRunId,actor,request.reason,verification.verificationHash,JSON.stringify({ commandType: "finish", verification, result }),occurredAt.toISOString()]);
      const completed = await client.query(`UPDATE inventory.availability_activation_runs SET completed_at=$2,result_hash=$3
        WHERE id=$1 AND state='active' AND runtime_authority_changed=true`, [request.activationRunId,occurredAt.toISOString(),resultHash]);
      if (completed.rowCount !== 1) throw new InventoryCutoverCommitError("CUTOVER_ACTIVATION_STATE_CHANGED", "The active run changed during completion.");
      return result;
    });
  }
}

export async function captureInventoryCutoverVerificationInsideTransaction(client: PoolClient, runId: string, occurredAt: Date): Promise<InventoryCutoverVerification> {
  const receipt = (await client.query<{ authority_revision: string; authority: string; active_run_id: string | null; state: string;
    publication_manifest: unknown; publication_manifest_hash: string; configuration_frozen: boolean }>(
    `SELECT authority.revision::text AS authority_revision,authority.authority,authority.activation_run_id::text AS active_run_id,
       run.state,receipt.publication_manifest,receipt.publication_manifest_hash,
       EXISTS(SELECT 1 FROM inventory.availability_activation_freezes configured_freeze
         WHERE configured_freeze.activation_run_id=run.id AND configured_freeze.released_at IS NULL) AS configuration_frozen
     FROM inventory.availability_cutover_commits receipt JOIN inventory.availability_activation_runs run ON run.id=receipt.activation_run_id
     CROSS JOIN inventory.availability_runtime_authority authority WHERE run.id=$1 AND authority.singleton_key=true`, [runId],
  )).rows[0];
  if (!receipt || receipt.authority !== "canonical" || receipt.active_run_id !== runId || receipt.state !== "active") {
    throw new InventoryCutoverCommitError("CUTOVER_COMMITTED_RUN_UNAVAILABLE", "An active canonical cutover receipt is required for full verification.");
  }
  const manifest = committedInventoryPublicationManifestSchema.parse(receipt.publication_manifest);
  if (inventoryCutoverEvidenceHash(manifest) !== receipt.publication_manifest_hash) {
    throw new InventoryCutoverCommitError("CUTOVER_COMMIT_PUBLICATION_MANIFEST_INVALID", "The immutable publication manifest failed its integrity check.", 500);
  }
  const completedRows = (await client.query<ReceiptRow>(`SELECT activation_run_id::text,command_type,request_hash,result_hash,result_payload
    FROM inventory.availability_activation_commands WHERE activation_run_id=$1 AND command_type='finish'`, [runId])).rows;
  if (completedRows.length > 0) {
    if (completedRows.length !== 1 || receipt.configuration_frozen) throw new InventoryCutoverCommitError("CUTOVER_COMPLETION_STATE_INVALID", "Completion evidence conflicts with the configuration freeze.", 500);
    const completed = parseCompletionReceipt(completedRows[0]);
    return inventoryCutoverVerificationSchema.parse({ contractVersion: "inventory_cutover_verification_v1", activationRunId: runId,
      authorityRevision: completed.authorityRevision, capturedAt: completed.completedAt, verificationHash: completed.verificationHash,
      ready: false, configurationFreezeOpen: false, completedAt: completed.completedAt,
      expectedPublicationRows: manifest.length, verifiedPublicationRows: completed.verifiedPublicationRows,
      publicationRows: [], blockers: [], providerWriteAttempted: false, operationalWriteAttempted: false });
  }
  const evidence = await loadLatestFullPublicationEvidence(client, runId);
  const validation = validateInventoryCutoverFullPublicationProof({ manifest, evidence, occurredAt, maxReadbackAgeMs: MAX_READBACK_AGE_MS });
  const drain = await captureQuantityPublicationDrainInsideTransaction(client, runId);
  validation.blockers.push(...validateCutoverDrainReadbacks(drain, runId, evidence));
  if (!receipt.configuration_frozen) validation.blockers.push({ code: "CUTOVER_CONFIGURATION_FREEZE_MISSING", subject: "activation",
    message: "Completion requires the run's configuration freeze and an immutable finish receipt." });
  const verificationHash = inventoryCutoverEvidenceHash({ runId, authorityRevision: receipt.authority_revision, manifest, evidence, drain, blockers: validation.blockers });
  return inventoryCutoverVerificationSchema.parse({ contractVersion: "inventory_cutover_verification_v1", activationRunId: runId,
    authorityRevision: receipt.authority_revision, capturedAt: occurredAt.toISOString(), verificationHash,
    ready: receipt.configuration_frozen && validation.blockers.length === 0, configurationFreezeOpen: receipt.configuration_frozen,
    completedAt: null, expectedPublicationRows: manifest.length, ...validation, providerWriteAttempted: false, operationalWriteAttempted: false });
}

function parseCompletionReceipt(row: ReceiptRow): FinishInventoryCutoverResult {
  const result = finishInventoryCutoverResultSchema.parse(row.result_payload);
  if (row.command_type !== "finish" || result.activationRunId !== row.activation_run_id || result.alreadyApplied
    || inventoryCutoverEvidenceHash(result) !== row.result_hash) throw new InventoryCutoverCommitError("CUTOVER_COMPLETION_RECEIPT_INVALID", "The immutable completion receipt failed validation.", 500);
  return result;
}

async function loadLatestFullPublicationEvidence(client: PoolClient, runId: string): Promise<unknown[]> {
  const rows = (await client.query<Record<string, unknown>>(`SELECT
      publication.id::text,publication.publication_target_id,publication.product_variant_id,publication.state,
      publication.publication_phase,publication.desired_revision::text,publication.desired_quantity::text,publication.acknowledged_at,
      target.state AS target_state,mapping.lifecycle_status AS mapping_lifecycle,
      target.destination_kind AS current_destination,target.channel_connection_id AS current_connection,
      target.dropship_store_connection_id AS current_dropship,target.provider_scope_type AS current_scope_type,
      target.external_scope_id AS current_scope,target.revision::text AS current_revision,mapping.external_inventory_item_id AS current_item,
      publication.destination_kind_snapshot AS outbox_destination,publication.channel_connection_id_snapshot AS outbox_connection,
      publication.dropship_store_connection_id_snapshot AS outbox_dropship,publication.provider_scope_type_snapshot AS outbox_scope_type,
      publication.external_scope_id_snapshot AS outbox_scope,publication.publication_target_revision_snapshot::text AS outbox_revision,
      publication.external_inventory_item_id_snapshot AS outbox_item,
      readback.observed_at,readback.observed_quantity::text,readback.destination_kind_snapshot,
      readback.channel_connection_id_snapshot,readback.dropship_store_connection_id_snapshot,readback.provider_scope_type_snapshot,
      readback.external_scope_id_snapshot,readback.publication_target_revision_snapshot::text,readback.external_inventory_item_id_snapshot
    FROM (SELECT DISTINCT ON (publication_target_id,product_variant_id) * FROM inventory.inventory_publication_outbox
      WHERE activation_run_id=$1 AND publication_phase='full' ORDER BY publication_target_id,product_variant_id,desired_revision DESC) publication
    JOIN inventory.inventory_publication_targets target ON target.id=publication.publication_target_id
    LEFT JOIN inventory.publication_variant_mapping_heads mapping_head ON mapping_head.publication_target_id=target.id
      AND mapping_head.product_variant_id=publication.product_variant_id
    LEFT JOIN inventory.publication_variant_mapping_versions mapping ON mapping.id=mapping_head.active_mapping_id
    LEFT JOIN LATERAL (SELECT * FROM inventory.inventory_publication_readbacks r
      WHERE r.publication_target_id=publication.publication_target_id AND r.product_variant_id=publication.product_variant_id
      ORDER BY r.observed_at DESC,r.id DESC LIMIT 1) readback ON true
    ORDER BY publication.publication_target_id,publication.product_variant_id LIMIT $2`, [runId,MAX_PUBLICATION_ROWS+1])).rows;
  if (rows.length > MAX_PUBLICATION_ROWS) throw new InventoryCutoverCommitError("CUTOVER_FULL_PUBLICATION_CENSUS_LIMIT", "The complete publication census exceeds its supported bound.", 422);
  return rows.map(row => ({ publicationId: row.id, publicationTargetId: row.publication_target_id, productVariantId: row.product_variant_id,
    state: row.state, conservativeQuantity: row.desired_quantity, acknowledgedAt: row.acknowledged_at,
    observedQuantity: row.observed_quantity, observedAt: row.observed_at,
    desiredRevision: row.desired_revision, phase: row.publication_phase, targetState: row.target_state, mappingLifecycle: row.mapping_lifecycle,
    expectedIdentity: { externalInventoryItemId: row.current_item, publicationTargetRevision: row.current_revision,
      destinationKind: row.current_destination, channelConnectionId: row.current_connection, dropshipStoreConnectionId: row.current_dropship,
      providerScopeType: row.current_scope_type, externalScopeId: row.current_scope },
    outboxIdentity: { externalInventoryItemId: row.outbox_item, publicationTargetRevision: row.outbox_revision,
      destinationKind: row.outbox_destination, channelConnectionId: row.outbox_connection, dropshipStoreConnectionId: row.outbox_dropship,
      providerScopeType: row.outbox_scope_type, externalScopeId: row.outbox_scope },
    observedIdentity: row.observed_at === null ? null : { externalInventoryItemId: row.external_inventory_item_id_snapshot,
      publicationTargetRevision: row.publication_target_revision_snapshot, destinationKind: row.destination_kind_snapshot,
      channelConnectionId: row.channel_connection_id_snapshot, dropshipStoreConnectionId: row.dropship_store_connection_id_snapshot,
      providerScopeType: row.provider_scope_type_snapshot, externalScopeId: row.external_scope_id_snapshot },
  }));
}
