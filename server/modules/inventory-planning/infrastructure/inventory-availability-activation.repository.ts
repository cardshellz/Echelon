import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  inventoryActivationCommandResultSchema,
  inventoryActivationDryRunSchema,
  inventoryActivationStatusSchema,
  type InventoryActivationCommandResult,
  type InventoryActivationDryRun,
  type InventoryActivationStatus,
} from "@shared/types/inventory-availability-phase4";
import { supplySnapshotSchema } from "@shared/types/inventory-availability-planner";
import { canonicalJson } from "@shared/utils/canonical-json";

import { pool } from "../../../db";
import type {
  AbortInventoryActivationCommand,
  InventoryAvailabilityActivationStore,
  PrepareInventoryActivationCommand,
} from "../application/inventory-availability-activation.service";

type ClientPool = Pick<Pool, "connect">;
const CUTOVER_LOCK_NAMESPACE = 918_413;
const CUTOVER_LOCK_KEY = 1;
const MAX_PROVIDER_READBACK_AGE_MS = 15 * 60 * 1000;

type PublicationIntent = {
  publicationTargetId: number;
  publicationTargetRevision: string;
  productVariantId: number;
  desiredQuantity: string;
  channelId: number;
  channelConnectionId: number;
  providerKey: string;
  providerScopeType: "account" | "location";
  externalScopeId: string;
  externalInventoryItemId: string;
  externalSku: string | null;
};

export class InventoryAvailabilityActivationRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InventoryAvailabilityActivationRepositoryError";
  }
}

export class PostgresInventoryAvailabilityActivationRepository
implements InventoryAvailabilityActivationStore {
  constructor(private readonly connectionPool: ClientPool = pool) {}

  async getStatus(activationRunId: string): Promise<InventoryActivationStatus> {
    const client = await this.connectionPool.connect();
    try {
      const status = await loadActivationStatus(client, { kind: "id", activationRunId });
      if (!status) {
        throw invalidEvidence("ACTIVATION_RUN_NOT_FOUND", "The prepared activation run was not found.");
      }
      return status;
    } finally {
      client.release();
    }
  }

  async getOpenStatus(): Promise<InventoryActivationStatus | null> {
    const client = await this.connectionPool.connect();
    try {
      return await loadActivationStatus(client, { kind: "open" });
    } finally {
      client.release();
    }
  }

  async prepare(command: PrepareInventoryActivationCommand): Promise<InventoryActivationCommandResult> {
    return inSerializable(this.connectionPool, async (client) => {
      await lockCutover(client);
      const replay = await loadCommandReplay(client, command.idempotencyKey, command.requestHash);
      if (replay) return replay;

      const dryRun = await loadReadyDryRun(
        client,
        command.sourceDryRunId,
        command.expectedDryRunResultHash,
      );
      await assertDryRunSelectionsCurrent(client, dryRun);
      const intents = await publicationIntents(client, dryRun, "conservative", command.occurredAt);
      const publicationRequired = intents.length > 0;
      const state = publicationRequired ? "publishing" as const : "publication_verified" as const;
      const evidenceHash = configurationDigest(dryRun);

      const inserted = (await client.query<{ id: string }>(
        `INSERT INTO inventory.availability_activation_runs (
           mode, scope, state, source_dry_run_id, request_hash, result_hash,
           expected_catalog_input_hash, expected_catalog_result_hash,
           captured_catalog_input_hash, captured_catalog_result_hash,
           evidence_payload, blocker_codes, idempotency_key, reason, requested_by,
           runtime_authority_changed, provider_write_attempted, outbox_enqueued,
           provider_publication_required, started_at, completed_at, prepared_at,
           publication_verified_at
         ) VALUES (
           'activation', 'full_catalog', $1, $2, $3, NULL,
           $4, $5, $4, $5, $6::jsonb, '[]'::jsonb, $7, $8, $9,
           false, false, $10, $11, $12, NULL, $12,
           CASE WHEN $11 THEN NULL ELSE $12::timestamptz END
         ) RETURNING id`,
        [
          state,
          dryRun.activationRunId,
          command.requestHash,
          dryRun.catalogInputHash,
          dryRun.catalogResultHash,
          JSON.stringify({
            contractVersion: "inventory_availability_activation_v1",
            sourceDryRunId: dryRun.activationRunId,
            sourceDryRunResultHash: dryRun.resultHash,
            configurationDigest: evidenceHash,
            summary: dryRun.summary,
          }),
          command.idempotencyKey,
          command.reason,
          command.actor,
          publicationRequired,
          publicationRequired,
          command.occurredAt.toISOString(),
        ],
      )).rows[0];
      if (!inserted) throw invalidEvidence("ACTIVATION_RUN_INSERT_FAILED", "Activation run was not created.");

      await client.query(
        `INSERT INTO inventory.availability_activation_freezes (
           activation_run_id, source_dry_run_id, evidence_hash, acquired_by, acquired_at
         ) VALUES ($1, $2, $3, $4, $5)`,
        [inserted.id, dryRun.activationRunId, evidenceHash, command.actor, command.occurredAt.toISOString()],
      );
      for (const intent of intents) {
        await enqueuePublication(client, inserted.id, "conservative", intent, command.occurredAt);
      }

      const result = inventoryActivationCommandResultSchema.parse({
        activationRunId: inserted.id,
        commandType: "prepare",
        state,
        sourceDryRunId: dryRun.activationRunId,
        revalidationDryRunId: null,
        conservativePublicationRows: intents.length,
        fullPublicationRows: 0,
        runtimeAuthority: "legacy",
        alreadyApplied: false,
      });
      const resultHash = hash(resultWithoutReplay(result));
      await client.query(
        `UPDATE inventory.availability_activation_runs SET result_hash = $2 WHERE id = $1`,
        [inserted.id, resultHash],
      );
      await appendEvent(client, {
        runId: inserted.id,
        fromState: null,
        toState: state,
        actor: command.actor,
        reason: command.reason,
        evidenceHash: resultHash,
        evidence: resultWithoutReplay(result),
        occurredAt: command.occurredAt,
      });
      await insertCommandReceipt(client, {
        runId: inserted.id,
        commandType: "prepare",
        idempotencyKey: command.idempotencyKey,
        requestHash: command.requestHash,
        resultHash,
        request: command,
        result: resultWithoutReplay(result),
        actor: command.actor,
        reason: command.reason,
        occurredAt: command.occurredAt,
      });
      return result;
    });
  }

  async abort(command: AbortInventoryActivationCommand): Promise<InventoryActivationCommandResult> {
    return inSerializable(this.connectionPool, async (client) => {
      await lockCutover(client);
      const replay = await loadCommandReplay(client, command.idempotencyKey, command.requestHash);
      if (replay) return replay;
      const run = (await client.query<Record<string, unknown>>(
        `SELECT * FROM inventory.availability_activation_runs WHERE id = $1 FOR UPDATE`,
        [command.activationRunId],
      )).rows[0];
      if (!run || String(run.mode) !== "activation") {
        throw invalidEvidence("ACTIVATION_RUN_NOT_FOUND", "The prepared activation run was not found.");
      }
      const state = String(run.state);
      if (state !== "publishing" && state !== "publication_verified") {
        throw invalidEvidence(
          "ACTIVATION_RUN_NOT_ABORTABLE",
          "Only a prepared activation that has not switched runtime authority can be aborted.",
          { activationRunId: command.activationRunId, state },
        );
      }
      const authority = (await client.query<{ authority: string }>(
        `SELECT authority FROM inventory.availability_runtime_authority
         WHERE singleton_key = true FOR UPDATE`,
      )).rows[0];
      if (!authority || authority.authority !== "legacy") {
        throw invalidEvidence(
          "ACTIVATION_RUNTIME_AUTHORITY_CHANGED",
          "The activation cannot be aborted after runtime authority changes.",
        );
      }
      const leasedCount = count((await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM inventory.inventory_publication_outbox
         WHERE activation_run_id = $1 AND state = 'leased'`,
        [command.activationRunId],
      )).rows[0]?.count ?? "0", "leasedPublicationCount");
      if (leasedCount > 0) {
        throw invalidEvidence(
          "ACTIVATION_PROVIDER_WRITE_IN_FLIGHT",
          "Wait for in-flight provider writes to finish before aborting this preparation.",
          { activationRunId: command.activationRunId, leasedCount },
        );
      }
      await client.query(
        `UPDATE inventory.inventory_publication_outbox
         SET state = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
             last_error_class = 'ACTIVATION_ABORTED', last_error_message = $2
         WHERE activation_run_id = $1
           AND state IN ('desired', 'queued', 'retryable', 'drifted')`,
        [command.activationRunId, command.reason],
      );
      await client.query(
        `UPDATE inventory.availability_activation_runs
         SET state = 'failed', failed_at = $2, completed_at = $2
         WHERE id = $1`,
        [command.activationRunId, command.occurredAt.toISOString()],
      );
      const freezeReleased = await client.query(
        `UPDATE inventory.availability_activation_freezes
         SET released_by = $2, released_at = $3, release_reason = $4
         WHERE activation_run_id = $1 AND released_at IS NULL`,
        [command.activationRunId, command.actor, command.occurredAt.toISOString(), command.reason],
      );
      if (freezeReleased.rowCount !== 1) {
        throw invalidEvidence("ACTIVATION_FREEZE_MISSING", "The activation configuration freeze is missing.");
      }
      const conservativeCount = Number((await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM inventory.inventory_publication_outbox
         WHERE activation_run_id = $1 AND publication_phase = 'conservative'`,
        [command.activationRunId],
      )).rows[0]?.count ?? "0");
      const result = inventoryActivationCommandResultSchema.parse({
        activationRunId: command.activationRunId,
        commandType: "abort",
        state: "failed",
        sourceDryRunId: String(run.source_dry_run_id),
        revalidationDryRunId: null,
        conservativePublicationRows: conservativeCount,
        fullPublicationRows: 0,
        runtimeAuthority: "legacy",
        alreadyApplied: false,
      });
      const resultHash = hash(resultWithoutReplay(result));
      await client.query(
        `UPDATE inventory.availability_activation_runs SET result_hash = $2 WHERE id = $1`,
        [command.activationRunId, resultHash],
      );
      await appendEvent(client, {
        runId: command.activationRunId,
        fromState: state,
        toState: "failed",
        actor: command.actor,
        reason: command.reason,
        evidenceHash: resultHash,
        evidence: resultWithoutReplay(result),
        occurredAt: command.occurredAt,
      });
      await insertCommandReceipt(client, {
        runId: command.activationRunId,
        commandType: "abort",
        idempotencyKey: command.idempotencyKey,
        requestHash: command.requestHash,
        resultHash,
        request: command,
        result: resultWithoutReplay(result),
        actor: command.actor,
        reason: command.reason,
        occurredAt: command.occurredAt,
      });
      return result;
    });
  }
}

type ActivationStatusSelector =
  | { kind: "id"; activationRunId: string }
  | { kind: "open" };

async function loadActivationStatus(
  client: PoolClient,
  selector: ActivationStatusSelector,
): Promise<InventoryActivationStatus | null> {
  const where = selector.kind === "id"
    ? "run.id = $1 AND run.mode = 'activation'"
    : "run.mode = 'activation' AND run.state IN ('publishing', 'publication_verified')";
  const params = selector.kind === "id" ? [selector.activationRunId] : [];
  const orderAndLimit = selector.kind === "open" ? "ORDER BY run.id DESC LIMIT 1" : "";
  const row = (await client.query<Record<string, unknown>>(
    `SELECT run.id, run.state, run.source_dry_run_id,
            run.provider_write_attempted, authority.authority,
            (freeze.activation_run_id IS NOT NULL AND freeze.released_at IS NULL) AS configuration_frozen,
            count(outbox.id)::text AS total,
            count(outbox.id) FILTER (WHERE outbox.state = 'queued')::text AS queued,
            count(outbox.id) FILTER (WHERE outbox.state = 'leased')::text AS leased,
            count(outbox.id) FILTER (WHERE outbox.state = 'verified')::text AS verified,
            count(outbox.id) FILTER (WHERE outbox.state IN ('retryable', 'drifted'))::text AS retryable_or_drifted,
            count(outbox.id) FILTER (WHERE outbox.state = 'dead_letter')::text AS dead_letter,
            count(outbox.id) FILTER (WHERE outbox.state = 'cancelled')::text AS cancelled
     FROM inventory.availability_activation_runs AS run
     CROSS JOIN inventory.availability_runtime_authority AS authority
     LEFT JOIN inventory.availability_activation_freezes AS freeze
       ON freeze.activation_run_id = run.id
     LEFT JOIN inventory.inventory_publication_outbox AS outbox
       ON outbox.activation_run_id = run.id
     WHERE ${where} AND authority.singleton_key = true
     GROUP BY run.id, run.state, run.source_dry_run_id, run.provider_write_attempted,
              authority.authority, freeze.activation_run_id, freeze.released_at
     ${orderAndLimit}`,
    params,
  )).rows[0];
  if (!row) return null;
  return inventoryActivationStatusSchema.parse({
    activationRunId: String(row.id),
    state: String(row.state),
    sourceDryRunId: String(row.source_dry_run_id),
    runtimeAuthority: String(row.authority),
    providerWriteAttempted: Boolean(row.provider_write_attempted),
    configurationFrozen: Boolean(row.configuration_frozen),
    outbox: {
      total: count(row.total, "outbox.total"),
      queued: count(row.queued, "outbox.queued"),
      leased: count(row.leased, "outbox.leased"),
      verified: count(row.verified, "outbox.verified"),
      retryableOrDrifted: count(row.retryable_or_drifted, "outbox.retryableOrDrifted"),
      deadLetter: count(row.dead_letter, "outbox.deadLetter"),
      cancelled: count(row.cancelled, "outbox.cancelled"),
    },
  });
}

async function inSerializable<T>(connectionPool: ClientPool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await connectionPool.connect();
  let began = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    began = true;
    const result = await work(client);
    await client.query("COMMIT");
    began = false;
    return result;
  } catch (error) {
    if (began) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Inventory activation and rollback both failed.");
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

async function lockCutover(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1, $2)", [CUTOVER_LOCK_NAMESPACE, CUTOVER_LOCK_KEY]);
}

async function loadReadyDryRun(client: PoolClient, runId: string, expectedHash: string): Promise<InventoryActivationDryRun> {
  const row = (await client.query<Record<string, unknown>>(
    `SELECT id, mode, scope, state, request_hash, result_hash,
            captured_catalog_input_hash, captured_catalog_result_hash,
            evidence_payload, requested_by, reason, started_at, completed_at,
            runtime_authority_changed, provider_write_attempted, outbox_enqueued
     FROM inventory.availability_activation_runs WHERE id = $1 FOR SHARE`,
    [runId],
  )).rows[0];
  if (!row || String(row.mode) !== "dry_run") {
    throw invalidEvidence("ACTIVATION_DRY_RUN_NOT_FOUND", "The referenced full-catalog dry run was not found.", { runId });
  }
  if (String(row.state) !== "ready_for_publication" || String(row.result_hash) !== expectedHash) {
    throw invalidEvidence(
      "ACTIVATION_DRY_RUN_NOT_READY",
      "The referenced dry run is blocked, stale, or does not match the expected result hash.",
      { runId, state: row.state, expectedHash, actualHash: row.result_hash },
    );
  }
  const evidence = jsonObject(row.evidence_payload, "activationRun.evidencePayload");
  return inventoryActivationDryRunSchema.parse({
    activationRunId: String(row.id),
    mode: row.mode,
    scope: row.scope,
    state: row.state,
    requestHash: String(row.request_hash),
    resultHash: String(row.result_hash),
    catalogInputHash: String(row.captured_catalog_input_hash),
    catalogResultHash: String(row.captured_catalog_result_hash),
    requestedBy: String(row.requested_by),
    reason: String(row.reason),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    summary: evidence.summary,
    products: evidence.products,
    blockers: evidence.blockers,
    runtimeAuthorityChanged: row.runtime_authority_changed,
    providerWriteAttempted: row.provider_write_attempted,
    outboxEnqueued: row.outbox_enqueued,
    alreadyApplied: false,
  });
}

function configurationDigest(dryRun: InventoryActivationDryRun): string {
  return hash(dryRun.products.map((product) => ({
    productId: product.productId,
    model: [product.draftModelId, product.draftModelVersion, product.draftDefinitionHash],
    publications: product.proposedPublications.map((publication) => ({
      target: [publication.publicationTargetId, publication.publicationTargetRevision,
        publication.channelId, publication.destinationKind, publication.channelConnectionId,
        publication.dropshipStoreConnectionId, publication.providerScopeType,
        publication.externalScopeId, publication.publicationAuthority],
      source: [publication.sourceBindingId, publication.sourceBindingVersion,
        publication.sourceBindingDefinitionHash, publication.sourceWarehouseIds],
      mapping: [publication.productVariantId, publication.mappingId, publication.mappingVersion,
        publication.mappingDefinitionHash, publication.externalInventoryItemId, publication.externalSku],
      policies: publication.policySelections,
    })),
  })));
}

async function assertDryRunSelectionsCurrent(client: PoolClient, dryRun: InventoryActivationDryRun): Promise<void> {
  const publications = dryRun.products.flatMap((product) => product.proposedPublications);
  const targetIds = unique(publications.map((row) => row.publicationTargetId));
  const targets = targetIds.length === 0 ? [] : (await client.query<Record<string, unknown>>(
    `SELECT id, destination_kind, channel_id, channel_connection_id,
            dropship_store_connection_id, provider_scope_type, external_scope_id,
            publication_authority, state, revision
     FROM inventory.inventory_publication_targets WHERE id = ANY($1::integer[]) FOR SHARE`,
    [targetIds],
  )).rows;
  const targetById = new Map(targets.map((row) => [Number(row.id), row]));
  for (const publication of publications) {
    const current = targetById.get(publication.publicationTargetId);
    if (!current
      || Number(current.channel_id) !== publication.channelId
      || String(current.destination_kind) !== publication.destinationKind
      || nullableNumber(current.channel_connection_id) !== publication.channelConnectionId
      || nullableNumber(current.dropship_store_connection_id) !== publication.dropshipStoreConnectionId
      || String(current.provider_scope_type) !== publication.providerScopeType
      || String(current.external_scope_id) !== publication.externalScopeId
      || String(current.publication_authority) !== publication.publicationAuthority
      || String(current.revision) !== publication.publicationTargetRevision
      || String(current.state) !== "preview") {
      throw invalidEvidence("ACTIVATION_PUBLICATION_TARGET_CHANGED", "A publication target changed after dry-run capture.", {
        publicationTargetId: publication.publicationTargetId,
      });
    }
  }
  await assertSelectedHeadRows(client, dryRun);
}

async function assertSelectedHeadRows(client: PoolClient, dryRun: InventoryActivationDryRun): Promise<void> {
  const modelRefs = dryRun.products.map((product) => ({
    key: String(product.productId), id: product.draftModelId, hash: product.draftDefinitionHash,
  }));
  await assertHeadSelection(client, {
    refs: modelRefs,
    query: `SELECT head.product_id::text AS key, model.id, model.definition_hash
            FROM inventory.transformation_model_heads head
            JOIN inventory.transformation_model_versions model
              ON model.id = COALESCE(head.draft_model_id, head.active_model_id)
            WHERE head.product_id = ANY($1::integer[])`,
    ids: modelRefs.map((ref) => Number(ref.key)),
    code: "ACTIVATION_TRANSFORMATION_MODEL_CHANGED",
  });

  const publications = dryRun.products.flatMap((product) => product.proposedPublications);
  const sourceRefs = dedupeRefs(publications.map((row) => ({
    key: String(row.publicationTargetId), id: row.sourceBindingId, hash: row.sourceBindingDefinitionHash,
  })));
  await assertHeadSelection(client, {
    refs: sourceRefs,
    query: `SELECT head.publication_target_id::text AS key, binding.id, binding.definition_hash
            FROM inventory.publication_source_binding_heads head
            JOIN inventory.publication_source_binding_versions binding
              ON binding.id = COALESCE(head.draft_binding_id, head.active_binding_id)
            WHERE head.publication_target_id = ANY($1::integer[])`,
    ids: sourceRefs.map((ref) => Number(ref.key)),
    code: "ACTIVATION_SOURCE_BINDING_CHANGED",
  });
  const mappingRefs = dedupeRefs(publications.map((row) => ({
    key: `${row.publicationTargetId}:${row.productVariantId}`,
    id: row.mappingId,
    hash: row.mappingDefinitionHash,
  })));
  const mappingTargetIds = unique(mappingRefs.map((ref) => Number(ref.key.split(":")[0])));
  const mappingRows = mappingTargetIds.length === 0 ? [] : (await client.query<Record<string, unknown>>(
    `SELECT head.publication_target_id::text || ':' || head.product_variant_id::text AS key,
            mapping.id, mapping.definition_hash
     FROM inventory.publication_variant_mapping_heads head
     JOIN inventory.publication_variant_mapping_versions mapping
       ON mapping.id = COALESCE(head.draft_mapping_id, head.active_mapping_id)
     WHERE head.publication_target_id = ANY($1::integer[])`,
    [mappingTargetIds],
  )).rows;
  assertRefs(mappingRefs, mappingRows, "ACTIVATION_VARIANT_MAPPING_CHANGED");

  const policyRefs = dedupeRefs(publications.flatMap((row) => row.policySelections.map((policy) => ({
    key: policy.scopeKey, id: policy.policyId, hash: policy.definitionHash,
  }))));
  const policyRows = policyRefs.length === 0 ? [] : (await client.query<Record<string, unknown>>(
    `SELECT head.scope_key AS key, policy.id, policy.definition_hash
     FROM inventory.channel_exposure_policy_heads head
     JOIN inventory.channel_exposure_policy_versions policy
       ON policy.id = COALESCE(head.draft_policy_id, head.active_policy_id)
     WHERE head.scope_key = ANY($1::varchar[])`,
    [policyRefs.map((ref) => ref.key)],
  )).rows;
  assertRefs(policyRefs, policyRows, "ACTIVATION_CHANNEL_POLICY_CHANGED");

  const snapshots = await selectedSnapshots(client, dryRun);
  const graphModelRefs = dedupeRefs(snapshots.flatMap((snapshot) =>
    snapshot.transformationModels.map((model) => ({
      key: String(model.productId), id: model.modelId, hash: model.definitionHash,
    }))));
  await assertHeadSelection(client, {
    refs: graphModelRefs,
    query: `SELECT head.product_id::text AS key, model.id, model.definition_hash
            FROM inventory.transformation_model_heads head
            JOIN inventory.transformation_model_versions model
              ON model.id = COALESCE(head.draft_model_id, head.active_model_id)
            WHERE head.product_id = ANY($1::integer[])`,
    ids: graphModelRefs.map((ref) => Number(ref.key)),
    code: "ACTIVATION_TRANSFORMATION_GRAPH_CHANGED",
  });
  const locationRefs = dedupeRefs(snapshots.flatMap((snapshot) => snapshot.locations
    .filter((location) => location.promisePolicy !== null)
    .map((location) => ({
      key: String(location.id),
      id: location.promisePolicy!.policyId,
      hash: location.promisePolicy!.definitionHash,
    }))));
  await assertHeadSelection(client, {
    refs: locationRefs,
    query: `SELECT head.warehouse_location_id::text AS key, policy.id, policy.definition_hash
            FROM inventory.location_promise_policy_heads head
            JOIN inventory.location_promise_policy_versions policy
              ON policy.id = COALESCE(head.draft_policy_id, head.active_policy_id)
            WHERE head.warehouse_location_id = ANY($1::integer[])`,
    ids: locationRefs.map((ref) => Number(ref.key)),
    code: "ACTIVATION_LOCATION_POLICY_CHANGED",
  });
  const safetyRefs = dedupeRefs(snapshots.flatMap((snapshot) => snapshot.safetyPolicies.map((policy) => ({
    key: policy.scopeKey, id: policy.policyId, hash: policy.definitionHash,
  }))));
  const safetyRows = safetyRefs.length === 0 ? [] : (await client.query<Record<string, unknown>>(
    `SELECT head.scope_key AS key, policy.id, policy.definition_hash
     FROM inventory.promise_safety_policy_heads head
     JOIN inventory.promise_safety_policy_versions policy
       ON policy.id = COALESCE(head.draft_policy_id, head.active_policy_id)
     WHERE head.scope_key = ANY($1::varchar[])`,
    [safetyRefs.map((ref) => ref.key)],
  )).rows;
  assertRefs(safetyRefs, safetyRows, "ACTIVATION_SAFETY_POLICY_CHANGED");
}

async function assertHeadSelection(client: PoolClient, input: {
  refs: Array<{ key: string; id: number | null; hash: string | null }>;
  query: string;
  ids: number[];
  code: string;
}): Promise<void> {
  const refs = dedupeRefs(input.refs);
  const rows = input.ids.length === 0 ? [] : (await client.query<Record<string, unknown>>(input.query, [input.ids])).rows;
  assertRefs(refs, rows, input.code);
}

function assertRefs(
  refs: Array<{ key: string; id: number | null; hash: string | null }>,
  rows: Record<string, unknown>[],
  code: string,
): void {
  const current = new Map(rows.map((row) => [String(row.key), row]));
  for (const ref of refs) {
    const row = current.get(ref.key);
    if (!row || ref.id === null || ref.hash === null
      || Number(row.id) !== ref.id || String(row.definition_hash) !== ref.hash) {
      throw invalidEvidence(code, "A selected inventory availability definition changed after dry-run capture.", {
        key: ref.key, expectedId: ref.id, actualId: row?.id ?? null,
      });
    }
  }
}

async function publicationIntents(
  client: PoolClient,
  dryRun: InventoryActivationDryRun,
  phase: "conservative" | "full",
  occurredAt: Date,
): Promise<PublicationIntent[]> {
  const publishRows = dryRun.products.flatMap((product) => product.proposedPublications)
    .filter((row) => row.disposition === "publish")
    .sort((left, right) => left.publicationTargetId - right.publicationTargetId
      || left.productVariantId - right.productVariantId);
  if (publishRows.length === 0) return [];
  const targetIds = unique(publishRows.map((row) => row.publicationTargetId));
  const variantIds = unique(publishRows.map((row) => row.productVariantId));
  const readbacks = (await client.query<Record<string, unknown>>(
    `SELECT DISTINCT ON (readback.publication_target_id, readback.product_variant_id)
            readback.publication_target_id, readback.product_variant_id,
            readback.observed_quantity,
            readback.observed_at,
            COALESCE(readback.destination_kind_snapshot,
              CASE WHEN COALESCE(readback.channel_connection_id_snapshot,
                publication.channel_connection_id_snapshot) IS NOT NULL
                THEN 'channel_connection'
              END) AS destination_kind_snapshot,
            readback.channel_connection_id_snapshot,
            readback.provider_scope_type_snapshot,
            readback.external_scope_id_snapshot,
            readback.publication_target_revision_snapshot,
            COALESCE(readback.external_inventory_item_id_snapshot,
                     publication.external_inventory_item_id_snapshot) AS external_inventory_item_id_snapshot
     FROM inventory.inventory_publication_readbacks readback
     LEFT JOIN inventory.inventory_publication_outbox publication ON publication.id = readback.outbox_id
     WHERE readback.publication_target_id = ANY($1::integer[])
       AND readback.product_variant_id = ANY($2::integer[])
     ORDER BY readback.publication_target_id, readback.product_variant_id,
              readback.observed_at DESC, readback.id DESC`,
    [targetIds, variantIds],
  )).rows;
  const readbackByKey = new Map(readbacks.map((row) => [
    `${row.publication_target_id}:${row.product_variant_id}`, row,
  ]));
  return publishRows.map((row) => {
    if (row.destinationKind !== "channel_connection" || row.channelConnectionId === null) {
      throw invalidEvidence(
        "ACTIVATION_DROPSHIP_PUBLICATION_UNSUPPORTED",
        "Dropship publication cannot enter activation until its outbox adapter and readback are installed.",
        { publicationTargetId: row.publicationTargetId },
      );
    }
    if (!row.externalInventoryItemId) {
      throw invalidEvidence("ACTIVATION_PUBLICATION_IDENTITY_MISSING", "A publish row has no provider inventory identity.");
    }
    let desired = BigInt(row.desiredUnits);
    if (phase === "conservative") {
      const readback = readbackByKey.get(`${row.publicationTargetId}:${row.productVariantId}`);
      if (!readback
        || String(readback.external_inventory_item_id_snapshot ?? "") !== row.externalInventoryItemId
        || String(readback.destination_kind_snapshot ?? "") !== row.destinationKind
        || Number(readback.channel_connection_id_snapshot) !== row.channelConnectionId
        || String(readback.provider_scope_type_snapshot ?? "") !== row.providerScopeType
        || String(readback.external_scope_id_snapshot ?? "") !== row.externalScopeId
        || String(readback.publication_target_revision_snapshot ?? "") !== row.publicationTargetRevision) {
        throw invalidEvidence(
          "ACTIVATION_PROVIDER_READBACK_STALE",
          "Conservative publication requires a current readback for the exact selected provider identity.",
          { publicationTargetId: row.publicationTargetId, productVariantId: row.productVariantId },
        );
      }
      const observedAt = new Date(String(readback.observed_at));
      if (Number.isNaN(observedAt.getTime())
        || observedAt.getTime() > occurredAt.getTime()
        || occurredAt.getTime() - observedAt.getTime() > MAX_PROVIDER_READBACK_AGE_MS) {
        throw invalidEvidence(
          "ACTIVATION_PROVIDER_READBACK_STALE",
          "Conservative publication requires a fresh readback for the exact selected provider identity.",
          { publicationTargetId: row.publicationTargetId, productVariantId: row.productVariantId,
            observedAt: readback.observed_at ?? null,
            maxAgeMilliseconds: MAX_PROVIDER_READBACK_AGE_MS },
        );
      }
      const observed = BigInt(String(readback.observed_quantity));
      if (observed < desired) desired = observed;
    }
    if (desired > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw invalidEvidence(
        "ACTIVATION_PROVIDER_QUANTITY_OUT_OF_RANGE",
        "The provider quantity exceeds the supported safe-integer range.",
        { publicationTargetId: row.publicationTargetId, productVariantId: row.productVariantId,
          desiredQuantity: desired.toString() },
      );
    }
    return {
      publicationTargetId: row.publicationTargetId,
      publicationTargetRevision: row.publicationTargetRevision,
      productVariantId: row.productVariantId,
      desiredQuantity: desired.toString(),
      channelId: row.channelId,
      channelConnectionId: row.channelConnectionId,
      providerKey: row.channelProvider,
      providerScopeType: row.providerScopeType,
      externalScopeId: row.externalScopeId,
      externalInventoryItemId: row.externalInventoryItemId,
      externalSku: row.externalSku,
    };
  });
}

async function enqueuePublication(
  client: PoolClient,
  runId: string,
  phase: "conservative" | "full",
  intent: PublicationIntent,
  occurredAt: Date,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1, $2)", [intent.publicationTargetId, intent.productVariantId]);
  const latest = (await client.query<{ revision: string | null }>(
    `SELECT max(desired_revision)::text AS revision
     FROM inventory.inventory_publication_outbox
     WHERE publication_target_id = $1 AND product_variant_id = $2`,
    [intent.publicationTargetId, intent.productVariantId],
  )).rows[0]?.revision;
  const revision = (latest ? BigInt(latest) : BigInt(0)) + BigInt(1);
  const idempotencyKey = `availability:${runId}:${phase}:${intent.publicationTargetId}:${intent.productVariantId}`;
  const payloadHash = hash({ ...intent, phase, revision: revision.toString() });
  const inserted = (await client.query<{ id: string }>(
    `INSERT INTO inventory.inventory_publication_outbox (
       activation_run_id, publication_target_id, product_variant_id,
       desired_revision, desired_quantity, channel_connection_id_snapshot,
       external_scope_id_snapshot, external_inventory_item_id_snapshot,
       publication_phase, channel_id_snapshot, provider_key_snapshot,
       provider_scope_type_snapshot, external_sku_snapshot,
       publication_target_revision_snapshot,
       state, idempotency_key, payload_hash, available_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11, $12, $13, $14, 'desired', $15, $16, $17
     )
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      runId, intent.publicationTargetId, intent.productVariantId,
      revision.toString(), intent.desiredQuantity, intent.channelConnectionId,
      intent.externalScopeId, intent.externalInventoryItemId,
      phase, intent.channelId, intent.providerKey, intent.providerScopeType,
      intent.externalSku, intent.publicationTargetRevision,
      idempotencyKey, payloadHash, occurredAt.toISOString(),
    ],
  )).rows[0];
  if (!inserted) {
    const existing = (await client.query<Record<string, unknown>>(
      `SELECT activation_run_id, publication_phase, payload_hash
       FROM inventory.inventory_publication_outbox WHERE idempotency_key = $1 FOR SHARE`,
      [idempotencyKey],
    )).rows[0];
    if (!existing || String(existing.activation_run_id) !== runId
      || String(existing.publication_phase) !== phase || String(existing.payload_hash) !== payloadHash) {
      throw invalidEvidence("ACTIVATION_OUTBOX_IDEMPOTENCY_CONFLICT", "Publication idempotency evidence conflicts.");
    }
    return;
  }
  await client.query(
    `UPDATE inventory.inventory_publication_outbox SET state = 'queued' WHERE id = $1`,
    [inserted.id],
  );
}

async function selectedSnapshots(client: PoolClient, dryRun: InventoryActivationDryRun) {
  const shadowRunIds = uniqueStrings(dryRun.products.flatMap((product) =>
    product.shadowRunId ? [product.shadowRunId] : []));
  const shadowRows = shadowRunIds.length === 0 ? [] : (await client.query<Record<string, unknown>>(
    `SELECT id, snapshot_payload FROM inventory.planner_shadow_runs
     WHERE id = ANY($1::bigint[]) FOR SHARE`,
    [shadowRunIds],
  )).rows;
  if (shadowRows.length !== shadowRunIds.length) {
    throw invalidEvidence("ACTIVATION_SHADOW_EVIDENCE_MISSING", "One or more selected shadow snapshots are missing.");
  }
  return shadowRows.map((row) =>
    supplySnapshotSchema.parse(jsonObject(row.snapshot_payload, "shadow.snapshotPayload")));
}

async function loadCommandReplay(
  client: PoolClient,
  idempotencyKey: string,
  requestHash: string,
): Promise<InventoryActivationCommandResult | null> {
  const row = (await client.query<Record<string, unknown>>(
    `SELECT request_hash, result_payload FROM inventory.availability_activation_commands
     WHERE idempotency_key = $1 FOR SHARE`,
    [idempotencyKey],
  )).rows[0];
  if (!row) return null;
  if (String(row.request_hash) !== requestHash) {
    throw invalidEvidence("ACTIVATION_IDEMPOTENCY_KEY_REUSED", "The idempotency key belongs to a different activation command.");
  }
  return inventoryActivationCommandResultSchema.parse({
    ...jsonObject(row.result_payload, "activationCommand.resultPayload"),
    alreadyApplied: true,
  });
}

async function insertCommandReceipt(client: PoolClient, input: {
  runId: string;
  commandType: "prepare" | "abort";
  idempotencyKey: string;
  requestHash: string;
  resultHash: string;
  request: unknown;
  result: unknown;
  actor: string;
  reason: string;
  occurredAt: Date;
}): Promise<void> {
  await client.query(
    `INSERT INTO inventory.availability_activation_commands (
       activation_run_id, command_type, idempotency_key, request_hash, result_hash,
       request_payload, result_payload, actor, reason, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
    [input.runId, input.commandType, input.idempotencyKey, input.requestHash, input.resultHash,
      JSON.stringify(input.request), JSON.stringify(input.result), input.actor, input.reason,
      input.occurredAt.toISOString()],
  );
}

async function appendEvent(client: PoolClient, input: {
  runId: string;
  fromState: string | null;
  toState: string;
  actor: string;
  reason: string;
  evidenceHash: string;
  evidence: unknown;
  occurredAt: Date;
}): Promise<void> {
  await client.query(
    `INSERT INTO inventory.availability_activation_events (
       activation_run_id, from_state, to_state, actor, reason,
       evidence_hash, evidence_payload, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [input.runId, input.fromState, input.toState, input.actor, input.reason,
      input.evidenceHash, JSON.stringify(input.evidence), input.occurredAt.toISOString()],
  );
}

function dedupeRefs<T extends { key: string; id: number | null; hash: string | null }>(refs: T[]): T[] {
  const values = new Map<string, T>();
  for (const ref of refs) {
    const existing = values.get(ref.key);
    if (existing && (existing.id !== ref.id || existing.hash !== ref.hash)) {
      throw invalidEvidence("ACTIVATION_SELECTION_AMBIGUOUS", "Dry-run evidence contains conflicting selected definitions.", { key: ref.key });
    }
    values.set(ref.key, ref);
  }
  return [...values.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function unique(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function count(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw invalidEvidence("ACTIVATION_DATABASE_EVIDENCE_INVALID", `${field} must be nonnegative.`);
  }
  return parsed;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => BigInt(left) < BigInt(right) ? -1 : 1);
}

function resultWithoutReplay(result: InventoryActivationCommandResult): Omit<InventoryActivationCommandResult, "alreadyApplied"> {
  const { alreadyApplied: _alreadyApplied, ...evidence } = result;
  return evidence;
}

function jsonObject(value: unknown, field: string): Record<string, any> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, any>;
    } catch {
      // Classified below.
    }
  }
  throw invalidEvidence("ACTIVATION_DATABASE_EVIDENCE_INVALID", `${field} must be a JSON object.`);
}

function iso(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw invalidEvidence("ACTIVATION_DATABASE_EVIDENCE_INVALID", "Activation timestamp is invalid.");
  return parsed.toISOString();
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function invalidEvidence(code: string, message: string, context: Record<string, unknown> = {}): InventoryAvailabilityActivationRepositoryError {
  return new InventoryAvailabilityActivationRepositoryError(code, message, context);
}
