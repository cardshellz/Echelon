import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { publicationReconciliationDestinationSchema, publicationReconciliationRequestSchema,
  publicationReconciliationResultSchema, type PublicationReconciliationReview,
  type PublicationReconciliationResult } from "@shared/types/inventory-publication-reconciliation";
import type { PublicationReconciliationCommand, QuantityPublicationReconciliationStore } from "../application/quantity-publication-reconciliation.service";
import { InventoryCutoverCommitError } from "../application/inventory-cutover-commit.service";
import { reviewPublicationReconciliation } from "../domain/quantity-publication-reconciliation";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";
import { QUANTITY_PUBLICATION_LOCK_NAMESPACE } from "./quantity-publication-admission.repository";
import { inInventoryCutoverTransaction, lockInventoryCutoverCommandInsideTransaction } from "./inventory-cutover-commit.repository";
import { acquireInventoryCutoverFenceInsideTransaction } from "./inventory-cutover-admission-fence.repository";

const MAX_ATTEMPTS = 1000;
const MAX_PUBLICATIONS = 100000;

/** Recovery changes only obsolete request authority. It never asserts remote
 * termination, acknowledges a quantity, releases suppression, or switches ATP.
 */
export class PostgresQuantityPublicationReconciliationRepository implements QuantityPublicationReconciliationStore {
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = defaultPool) {}

  review(activationRunId: string, occurredAt: Date): Promise<PublicationReconciliationReview> {
    return inInventoryCutoverTransaction(this.connectionPool, "read_only_review", client => captureReview(client, activationRunId, occurredAt));
  }

  reconcile(command: PublicationReconciliationCommand): Promise<PublicationReconciliationResult> {
    const { actor, requestHash, occurredAt, ...input } = command;
    const request = publicationReconciliationRequestSchema.parse(input);
    if (requestHash !== inventoryCutoverEvidenceHash({ contractVersion: "publication_current_state_reconciliation_v1", actor, ...request })) {
      throw conflict("PUBLICATION_RECONCILIATION_HASH_INVALID", "The reconciliation command hash is invalid.");
    }
    return inInventoryCutoverTransaction(this.connectionPool, "admitted_commit", async client => {
      await lockInventoryCutoverCommandInsideTransaction(client, `publication-reconciliation:${command.idempotencyKey}`);
      const prior = (await client.query<{ request_hash: string; result_hash: string; result_payload: unknown }>(
        `SELECT request_hash,result_hash,result_payload FROM inventory.quantity_publication_reconciliations WHERE idempotency_key=$1`,
        [command.idempotencyKey])).rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash) throw conflict("PUBLICATION_RECONCILIATION_REPLAY_CONFLICT", "This key belongs to a different recovery command or actor.");
        const result = publicationReconciliationResultSchema.parse(prior.result_payload);
        if (result.replay || result.activationRunId !== command.activationRunId || result.reviewHash !== command.expectedReviewHash
          || inventoryCutoverEvidenceHash(result) !== prior.result_hash) {
          throw new InventoryCutoverCommitError("PUBLICATION_RECONCILIATION_RECEIPT_INVALID", "The immutable reconciliation receipt failed integrity validation.", 500);
        }
        return { ...result, replay: true };
      }
      // Identical lock order to cutover: command -> inventory/authority fence ->
      // publication gate. TRY-only publication acquisition never waits on HTTP.
      await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "legacy", expectedConfigurationRunId: command.activationRunId });
      const review = await captureReview(client, command.activationRunId, occurredAt);
      if (!review.ready || review.reviewHash !== command.expectedReviewHash) {
        throw conflict("PUBLICATION_RECONCILIATION_REVIEW_CHANGED", "The historical attempts or prepared destination evidence changed; review again.");
      }
      const resultId = (await client.query<{ id: string }>(`SELECT nextval('inventory.quantity_publication_reconciliations_id_seq')::text AS id`)).rows[0].id;
      const result = publicationReconciliationResultSchema.parse({ reconciliationId: resultId, activationRunId: command.activationRunId,
        reviewHash: review.reviewHash, supersededAttemptIds: review.attempts.map(attempt => attempt.attemptId), historicalOutcome: "unknown",
        requiredNextStep: "publish_and_verify_current_quantities", providerWriteAttempted: false, runtimeAuthorityChanged: false, replay: false });
      await client.query(`INSERT INTO inventory.quantity_publication_reconciliations
        (id,activation_run_id,gate_epoch,idempotency_key,actor,reason,request_hash,review_hash,review_payload,result_hash,result_payload,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12)`,
        [resultId,command.activationRunId,review.gateEpoch,command.idempotencyKey,actor,command.reason,requestHash,review.reviewHash,
          JSON.stringify(review),inventoryCutoverEvidenceHash(result),JSON.stringify(result),occurredAt.toISOString()]);
      // Preserve the complete original row in PostgreSQL, without JSON number
      // round-tripping bigint identities through JavaScript.
      const retained = await client.query(`INSERT INTO inventory.quantity_publication_reconciliation_attempts
        (reconciliation_id,attempt_id,before_record)
        SELECT $1,attempt.id,to_jsonb(attempt) FROM inventory.quantity_publication_attempts attempt
        WHERE attempt.id=ANY($2::bigint[]) ORDER BY attempt.id`, [resultId,result.supersededAttemptIds]);
      if (retained.rowCount !== result.supersededAttemptIds.length) throw conflict("PUBLICATION_RECONCILIATION_ATTEMPTS_CHANGED", "The complete reviewed attempt set could not be retained.");
      const superseded = await client.query(`UPDATE inventory.quantity_publication_attempts SET state='superseded_unknown'
        WHERE id=ANY($1::bigint[]) AND owner_kind='legacy' AND state IN ('running','uncertain')`, [result.supersededAttemptIds]);
      if (superseded.rowCount !== result.supersededAttemptIds.length) throw conflict("PUBLICATION_RECONCILIATION_ATTEMPTS_CHANGED", "An attempt changed before its audited handoff.");
      await client.query(`INSERT INTO inventory.availability_activation_events
        (activation_run_id,from_state,to_state,actor,reason,evidence_hash,evidence_payload,occurred_at)
        VALUES($1,'publishing','publishing',$2,$3,$4,$5::jsonb,$6)`,
        [command.activationRunId,actor,command.reason,review.reviewHash,JSON.stringify(result),occurredAt.toISOString()]);
      return result;
    });
  }
}

async function captureReview(client: PoolClient, runId: string, occurredAt: Date): Promise<PublicationReconciliationReview> {
  // This proves no locally admitted provider operation still owns its session
  // lock. It deliberately does NOT claim a remote timed-out request was cancelled.
  const acquired = (await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock($1,0) AS acquired", [QUANTITY_PUBLICATION_LOCK_NAMESPACE])).rows[0]?.acquired;
  if (!acquired) throw conflict("QUANTITY_PUBLICATION_DRAIN_BUSY", "A provider quantity owner is still running; retry after it stops.");
  const context = (await client.query<{ state: string; epoch: string; authority: string; provider_write_attempted: boolean; frozen: boolean }>(
    `SELECT run.state,gate.epoch::text,authority.authority,run.provider_write_attempted,
      EXISTS(SELECT 1 FROM inventory.availability_activation_freezes frozen_window WHERE frozen_window.activation_run_id=run.id AND frozen_window.released_at IS NULL) AS frozen
     FROM inventory.availability_activation_runs run
     JOIN inventory.quantity_publication_gate gate ON gate.activation_run_id=run.id AND gate.singleton=true
     CROSS JOIN inventory.availability_runtime_authority authority
     WHERE run.id=$1 AND run.mode='activation' AND authority.singleton_key=true`, [runId])).rows[0];
  if (!context || context.state !== "publishing" || context.authority !== "legacy" || !context.frozen || context.provider_write_attempted) {
    throw conflict("PUBLICATION_RECONCILIATION_PREPARATION_REQUIRED", "Recovery requires a suppressed, unstarted legacy-authority cutover preparation.");
  }
  const publications = (await client.query<Record<string, unknown>>(`SELECT outbox.id::text,outbox.state,outbox.desired_revision::text,
    outbox.desired_quantity::text,outbox.product_variant_id,outbox.publication_target_id,outbox.publication_target_revision_snapshot::text,
    outbox.destination_kind_snapshot,outbox.channel_id_snapshot,outbox.channel_connection_id_snapshot,outbox.dropship_store_connection_id_snapshot,
    outbox.provider_key_snapshot,outbox.provider_scope_type_snapshot,outbox.external_scope_id_snapshot,
    outbox.external_inventory_item_id_snapshot,outbox.external_sku_snapshot,
    target.state AS target_state,target.publication_authority,target.revision::text AS target_revision,
    target.destination_kind,target.channel_id,target.channel_connection_id,target.dropship_store_connection_id,target.provider_scope_type,target.external_scope_id
    FROM inventory.inventory_publication_outbox outbox JOIN inventory.inventory_publication_targets target ON target.id=outbox.publication_target_id
    WHERE outbox.activation_run_id=$1 AND outbox.publication_phase='conservative' ORDER BY outbox.id LIMIT $2`, [runId,MAX_PUBLICATIONS+1])).rows;
  if (publications.length === 0 || publications.length > MAX_PUBLICATIONS) throw conflict("PUBLICATION_RECONCILIATION_MANIFEST_INVALID", "Recovery requires the bounded complete prepared publication manifest.");
  const destinations = new Map<number, ReturnType<typeof publicationReconciliationDestinationSchema.parse>>();
  for (const row of publications) {
    if (row.state !== "queued" || row.target_state !== "preview" || row.publication_authority !== "echelon"
      || row.target_revision !== row.publication_target_revision_snapshot
      || row.destination_kind !== row.destination_kind_snapshot || row.channel_id !== row.channel_id_snapshot
      || row.channel_connection_id !== row.channel_connection_id_snapshot
      || row.dropship_store_connection_id !== row.dropship_store_connection_id_snapshot
      || row.provider_scope_type !== row.provider_scope_type_snapshot || row.external_scope_id !== row.external_scope_id_snapshot) {
      throw conflict("PUBLICATION_RECONCILIATION_MANIFEST_CHANGED", "Publication already started or its reviewed destination changed.");
    }
    // Walmart's asynchronous item setup is intentionally outside this recovery.
    if (row.provider_key_snapshot !== "shopify" && row.provider_key_snapshot !== "ebay") continue;
    const destination = publicationReconciliationDestinationSchema.parse({ publicationTargetId: row.publication_target_id,
      targetRevision: row.target_revision, destinationKind: row.destination_kind,
      connectionId: row.channel_connection_id ?? row.dropship_store_connection_id,
      providerKey: row.provider_key_snapshot, providerScopeType: row.provider_scope_type, externalScopeId: row.external_scope_id });
    destinations.set(destination.publicationTargetId,destination);
  }
  if (destinations.size === 0) throw conflict("PUBLICATION_RECONCILIATION_DESTINATIONS_UNSUPPORTED", "The prepared run has no Shopify or eBay quantity destinations supported by this recovery.");
  const rows = (await client.query<{ id: string; owner_kind: string; state: string; gate_epoch: string; started_at: Date;
    scope: unknown; affected_scopes: unknown; evidence_record: string }>(
    `SELECT id::text,owner_kind,state,gate_epoch::text,started_at,scope,affected_scopes,to_jsonb(attempt)::text AS evidence_record
     FROM inventory.quantity_publication_attempts attempt WHERE state IN ('running','uncertain') ORDER BY attempt.id LIMIT $1`, [MAX_ATTEMPTS+1])).rows;
  if (rows.length > MAX_ATTEMPTS) throw conflict("PUBLICATION_RECONCILIATION_CENSUS_LIMIT", "The complete attempt census exceeds the safe bound; no partial recovery is permitted.");
  return reviewPublicationReconciliation({ activationRunId: runId, gateEpoch: context.epoch, destinations: [...destinations.values()],
    attempts: rows.map(row => ({ id: row.id, owner: row.owner_kind, state: row.state, gateEpoch: row.gate_epoch,
      startedAt: row.started_at.toISOString(), scope: row.scope, affectedScopes: row.affected_scopes,
      evidenceHash: inventoryCutoverEvidenceHash(row.evidence_record) })),
    publicationRows: publications.length, publicationManifestHash: inventoryCutoverEvidenceHash(publications) }, occurredAt);
}

function conflict(code: string, message: string): InventoryCutoverCommitError { return new InventoryCutoverCommitError(code,message); }
