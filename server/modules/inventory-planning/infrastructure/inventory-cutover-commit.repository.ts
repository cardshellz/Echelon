import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { commitInventoryCutoverRequestSchema, inventoryCutoverCommitResultSchema,
  type InventoryCutoverCommitResult, type InventoryCutoverReview } from "@shared/types/inventory-cutover-commit";
import { canonicalJson } from "@shared/utils/canonical-json";
import { InventoryCutoverCommitError, type InventoryCutoverCommitCommand, type InventoryCutoverCommitStore } from "../application/inventory-cutover-commit.service";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";
import { acquireInventoryCutoverFenceInsideTransaction } from "./inventory-cutover-admission-fence.repository";
import { captureInventoryCutoverReviewInsideTransaction } from "./inventory-cutover-review.repository";
import { promoteInventoryCutoverDefinitionsInsideTransaction } from "./inventory-cutover-definitions.repository";
import { PostgresInventoryCutoverReconstructionRepository } from "./inventory-cutover-reconstruction.repository";
import { createTransactionScopedInventoryPublicationService } from "./inventory-availability-runtime-publication.repository";
import { committedInventoryPublicationManifestSchema } from "../domain/inventory-cutover-full-publication-proof";

/** One explicit operator command; constructing this owner never activates anything. */
export class PostgresInventoryCutoverCommitRepository implements InventoryCutoverCommitStore {
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = defaultPool) {}

  async preview(activationRunId: string, occurredAt: Date): Promise<InventoryCutoverReview> {
    return inInventoryCutoverTransaction(this.connectionPool, "read_only_review", (client) =>
      captureInventoryCutoverReviewInsideTransaction(client, activationRunId, occurredAt));
  }

  async commit(command: InventoryCutoverCommitCommand): Promise<InventoryCutoverCommitResult> {
    const { actor, requestHash, occurredAt, ...input } = command;
    const request = commitInventoryCutoverRequestSchema.parse(input);
    if (requestHash !== inventoryCutoverEvidenceHash({ contractVersion: "inventory_cutover_commit_v1", actor, ...request })) {
      throw new InventoryCutoverCommitError("CUTOVER_COMMAND_HASH_INVALID", "The semantic command hash is invalid.", 400);
    }
    return inInventoryCutoverTransaction(this.connectionPool, "admitted_commit", async (client) => {
      await lockInventoryCutoverCommandInsideTransaction(client, command.idempotencyKey);
      const replay = await loadReplay(client, command);
      if (replay) return replay;
      const fence = await acquireInventoryCutoverFenceInsideTransaction(client, {
        expectedAuthority: "legacy", expectedConfigurationRunId: command.activationRunId,
      });
      if (fence.authorityRevision !== command.expectedAuthorityRevision) {
        throw new InventoryCutoverCommitError("CUTOVER_AUTHORITY_REVISION_CHANGED", "Runtime authority changed after review.");
      }
      const review = await captureInventoryCutoverReviewInsideTransaction(client, command.activationRunId, occurredAt);
      if (!review.ready) throw new InventoryCutoverCommitError("CUTOVER_REVIEW_BLOCKED", "Resolve the cutover findings before switching authority.", 409, { blockers: review.blockers });
      if (review.reviewHash !== command.expectedReviewHash) {
        throw new InventoryCutoverCommitError("CUTOVER_REVIEW_CHANGED", "Demand, supply, configuration or provider evidence changed; review the fresh result.");
      }
      await promoteInventoryCutoverDefinitionsInsideTransaction(client, review.manifest, { actor, reason: command.reason, occurredAt });
      const nextRevision = (BigInt(fence.authorityRevision) + BigInt(1)).toString();
      const reconstruction = await new PostgresInventoryCutoverReconstructionRepository().persistReviewed(client, {
        expectedEvidenceHash: review.reconstructionHash, activationRunId: command.activationRunId,
        runtimeAuthorityRevision: nextRevision, actor, reason: command.reason, occurredAt: occurredAt.toISOString(),
      }, review.freshClaimImpactHash);
      // The manifest is a complete target census, including externally managed
      // 3PL/manual destinations. Only Echelon-owned targets change publication
      // state; observing a destination never grants us publication authority.
      const controlledTargetIds = (await client.query<{ id: number }>(
        `SELECT id FROM inventory.inventory_publication_targets
         WHERE id = ANY($1::integer[]) AND publication_authority = 'echelon' ORDER BY id`,
        [review.manifest.publicationTargetIds],
      )).rows.map(row => row.id);
      const activatedTargets = await client.query(
        `UPDATE inventory.inventory_publication_targets
         SET state = 'live', revision = revision + 1, activated_by = $2, activated_at = $3
         WHERE id = ANY($1::integer[]) AND state = 'preview'`,
        [controlledTargetIds, actor, occurredAt.toISOString()],
      );
      if (activatedTargets.rowCount !== controlledTargetIds.length) {
        throw new InventoryCutoverCommitError("CUTOVER_TARGET_SET_CHANGED", "Not every reviewed target could be activated atomically.");
      }
      const started = await client.query(
        `UPDATE inventory.availability_activation_runs SET state = 'activating'
         WHERE id = $1 AND state = 'publication_verified'`, [command.activationRunId],
      );
      if (started.rowCount !== 1) throw new InventoryCutoverCommitError("CUTOVER_ACTIVATION_STATE_CHANGED", "The prepared run is no longer publication verified.");
      const switched = await client.query(
        `UPDATE inventory.availability_runtime_authority SET authority = 'canonical', activation_run_id = $1,
           revision = revision + 1, changed_by = $2, change_reason = $3
         WHERE singleton_key = true AND authority = 'legacy' AND revision = $4`,
        [command.activationRunId, actor, command.reason, fence.authorityRevision],
      );
      if (switched.rowCount !== 1) throw new InventoryCutoverCommitError("CUTOVER_AUTHORITY_REVISION_CHANGED", "Runtime authority changed during cutover.");
      const activated = await client.query(
        `UPDATE inventory.availability_activation_runs
         SET state = 'active', runtime_authority_changed = true, activated_at = $2
        WHERE id = $1 AND state = 'activating'`, [command.activationRunId, occurredAt.toISOString()],
      );
      if (activated.rowCount !== 1) throw new InventoryCutoverCommitError("CUTOVER_ACTIVATION_STATE_CHANGED", "The activating run changed during cutover.");
      const publisher = createTransactionScopedInventoryPublicationService(client);
      const actual: InventoryCutoverReview["publicationRows"] = [];
      for (const productId of review.manifest.productIds) {
        const routed = await publisher.publishProduct({ productId, dryRun: false, triggeredBy: "full_catalog_cutover" }, async () => {
          throw new InventoryCutoverCommitError("CUTOVER_LEGACY_PUBLICATION_FORBIDDEN", "Final cutover cannot call a legacy publisher.", 500);
        });
        if (routed.authority !== "canonical") throw new InventoryCutoverCommitError("CUTOVER_LEGACY_PUBLICATION_FORBIDDEN", "Publication did not use the new authority.", 500);
        for (const row of routed.publication.rows) {
          if (row.blockerCodes.length > 0) throw new InventoryCutoverCommitError("CUTOVER_PUBLICATION_BLOCKED", "The final live planner returned publication blockers.", 409, { blockerCodes: row.blockerCodes });
          actual.push({ publicationTargetId: row.publicationTargetId, productVariantId: row.productVariantId, desiredQuantity: row.desiredQuantity });
        }
      }
      actual.sort((a, b) => a.publicationTargetId - b.publicationTargetId || a.productVariantId - b.productVariantId);
      if (canonicalJson(actual) !== canonicalJson(review.publicationRows)) {
        throw new InventoryCutoverCommitError("CUTOVER_FINAL_PUBLICATION_CHANGED", "The final planner differs from the reviewed post-reconstruction quantities.");
      }
      const publications = (await client.query<Record<string, unknown>>(
        `SELECT id::text, publication_target_id, product_variant_id, desired_revision::text, desired_quantity::text,
                publication_target_revision_snapshot::text
         FROM inventory.inventory_publication_outbox WHERE activation_run_id = $1 AND publication_phase = 'full'
         ORDER BY publication_target_id, product_variant_id, id`, [command.activationRunId],
      )).rows;
      if (publications.length !== actual.length) throw new InventoryCutoverCommitError("CUTOVER_FULL_OUTBOX_INCOMPLETE", "The full publication manifest was not persisted exactly once.", 500);
      const publicationManifest = committedInventoryPublicationManifestSchema.parse(publications);
      if (canonicalJson(publicationManifest.map(row => ({ publicationTargetId: row.publication_target_id,
        productVariantId: row.product_variant_id, desiredQuantity: row.desired_quantity }))) !== canonicalJson(actual)) {
        throw new InventoryCutoverCommitError("CUTOVER_FULL_OUTBOX_IDENTITY_CHANGED", "The persisted publication pairs differ from the final live planner.", 500);
      }
      const result = inventoryCutoverCommitResultSchema.parse({
        activationRunId: command.activationRunId, runtimeAuthority: "canonical", authorityRevision: nextRevision,
        reviewHash: review.reviewHash, selectionManifestHash: review.selectionManifestHash,
        reconstructionHash: review.reconstructionHash, fullPublicationRows: publications.length,
        publicationVerification: "pending", alreadyApplied: false,
      });
      await client.query(
        `INSERT INTO inventory.availability_cutover_commits
         (activation_run_id, authority_revision, review_hash, selection_manifest_hash, reconstruction_hash,
          selection_manifest, reconstruction_receipt, publication_manifest, idempotency_key, request_hash,
          result_hash, result_payload, actor, reason, occurred_at, publication_manifest_hash)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb,$13,$14,$15,$16)`,
        [command.activationRunId, nextRevision, review.reviewHash, review.selectionManifestHash, review.reconstructionHash,
          JSON.stringify(review.manifest), JSON.stringify(reconstruction), JSON.stringify(publications), command.idempotencyKey,
          requestHash, inventoryCutoverEvidenceHash(result), JSON.stringify(result), actor, command.reason, occurredAt.toISOString(), inventoryCutoverEvidenceHash(publicationManifest)],
      );
      await client.query(
        `INSERT INTO inventory.availability_activation_events
         (activation_run_id, from_state, to_state, actor, reason, evidence_hash, evidence_payload, occurred_at)
         VALUES ($1,'publication_verified','active',$2,$3,$4,$5::jsonb,$6)`,
        [command.activationRunId, actor, command.reason, review.reviewHash, JSON.stringify(result), occurredAt.toISOString()],
      );
      return result;
    });
  }
}

async function loadReplay(client: PoolClient, command: InventoryCutoverCommitCommand): Promise<InventoryCutoverCommitResult | null> {
  const rows = (await client.query<{ activation_run_id: string; request_hash: string; result_hash: string; result_payload: unknown }>(
    `SELECT activation_run_id::text, request_hash, result_hash, result_payload
     FROM inventory.availability_cutover_commits WHERE idempotency_key = $1`, [command.idempotencyKey],
  )).rows;
  if (rows.length === 0) return null;
  const receipt = rows[0];
  if (rows.length !== 1 || receipt.activation_run_id !== command.activationRunId || receipt.request_hash !== command.requestHash) {
    throw new InventoryCutoverCommitError("CUTOVER_IDEMPOTENCY_CONFLICT", "The command key belongs to different cutover evidence or actor.");
  }
  const result = inventoryCutoverCommitResultSchema.parse(receipt.result_payload);
  if (result.alreadyApplied || inventoryCutoverEvidenceHash(result) !== receipt.result_hash) {
    throw new InventoryCutoverCommitError("CUTOVER_RECEIPT_HASH_INVALID", "The immutable cutover receipt failed integrity validation.", 500);
  }
  return { ...result, alreadyApplied: true };
}

/** Serialize identical retries before reading receipts or acquiring authority.
 * The first command may release the configuration freeze; a waiting retry must
 * see its receipt instead of trying to reacquire that now-released freeze.
 * A hash collision can only add serialization, never grant mutation authority.
 */
export async function lockInventoryCutoverCommandInsideTransaction(client: PoolClient, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`inventory_cutover_command:${key}`]);
}

export async function inInventoryCutoverTransaction<T>(pool: Pick<Pool, "connect">, mode: "read_only_review" | "admitted_commit", work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let began = false;
  let discard = false;
  try {
    await client.query(mode === "read_only_review"
      ? "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
      : "BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED");
    began = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    const result = await work(client);
    await client.query("COMMIT");
    began = false;
    return result;
  } catch (error) {
    if (began) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) {
        discard = true;
        throw new AggregateError([error, rollbackError], "Cutover and rollback both failed; the connection is discarded.");
      }
    }
    throw error;
  } finally { client.release(discard); }
}
