import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { canonicalJson } from "@shared/utils/canonical-json";

import { pool } from "../../../db";

export type ClaimedInventoryPublication = {
  outboxId: string;
  activationRunId: string;
  publicationPhase: "conservative" | "full";
  publicationTargetId: number;
  publicationTargetRevision: string;
  productVariantId: number;
  desiredRevision: string;
  desiredQuantity: string;
  channelId: number;
  channelConnectionId: number;
  providerKey: string;
  providerScopeType: "account" | "location";
  externalScopeId: string;
  externalInventoryItemId: string;
  externalSku: string | null;
  leaseToken: string;
  attemptNumber: number;
  attemptStartedAt: Date;
};

export type PublicationAttemptFailure = {
  errorClass: string;
  errorMessage: string;
  retryable: boolean;
};

type ClientPool = Pick<Pool, "connect">;

export class InventoryPublicationOutboxRepositoryError extends Error {
  constructor(readonly code: string, message: string, readonly context: Record<string, unknown> = {}) {
    super(message);
    this.name = "InventoryPublicationOutboxRepositoryError";
  }
}

export class PostgresInventoryPublicationOutboxRepository {
  constructor(private readonly connectionPool: ClientPool = pool) {}

  async claimDue(input: {
    batchSize: number;
    leaseSeconds: number;
    leaseToken: string;
    now: Date;
  }): Promise<ClaimedInventoryPublication[]> {
    return inTransaction(this.connectionPool, async (client) => {
      await lockPublicationRuns(client, input.now);
      await recoverExpiredLeases(client, input.now);
      const rows = (await client.query<Record<string, unknown>>(
        `WITH candidates AS (
           SELECT outbox.id
           FROM inventory.inventory_publication_outbox AS outbox
           JOIN inventory.availability_activation_runs AS run
             ON run.id = outbox.activation_run_id
           WHERE outbox.state = 'queued' AND outbox.available_at <= $1
             AND (
               (outbox.publication_phase = 'conservative' AND run.state = 'publishing')
               OR
               (outbox.publication_phase = 'full' AND run.state = 'active')
             )
           ORDER BY outbox.available_at, outbox.id
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE inventory.inventory_publication_outbox outbox
         SET state = 'leased', lease_token = $3,
             lease_expires_at = $1::timestamptz + make_interval(secs => $4),
             attempt_count = outbox.attempt_count + 1
         FROM candidates
         WHERE outbox.id = candidates.id
         RETURNING outbox.*`,
        [input.now.toISOString(), input.batchSize, input.leaseToken, input.leaseSeconds],
      )).rows;
      return rows.map((row) => parseClaim(row, input.now));
    });
  }

  async recordVerified(
    claim: ClaimedInventoryPublication,
    input: { observedQuantity: number; providerResponse: unknown; completedAt: Date },
  ): Promise<"verified" | "drifted" | null> {
    return inTransaction(this.connectionPool, async (client) => {
      await lockActivationRun(client, claim.activationRunId);
      const current = await lockClaim(client, claim);
      if (!current) return null;
      const requestHash = publicationRequestHash(claim);
      const responseHash = hash(input.providerResponse);
      await client.query(
        `INSERT INTO inventory.inventory_publication_attempts (
           outbox_id, attempt_number, outcome, provider_request_key,
           request_hash, response_hash, started_at, completed_at
         ) VALUES ($1, $2, 'acknowledged', $3, $4, $5, $6, $7)`,
        [claim.outboxId, claim.attemptNumber, providerRequestKey(claim), requestHash,
          responseHash, claim.attemptStartedAt.toISOString(), input.completedAt.toISOString()],
      );
      await client.query(
        `UPDATE inventory.inventory_publication_outbox
         SET state = 'acknowledged', lease_token = NULL, lease_expires_at = NULL,
             acknowledged_at = $3, last_error_class = NULL, last_error_message = NULL
         WHERE id = $1 AND lease_token = $2 AND state = 'leased'`,
        [claim.outboxId, claim.leaseToken, input.completedAt.toISOString()],
      );
      const matches = BigInt(input.observedQuantity) === BigInt(claim.desiredQuantity);
      const readbackEvidence = {
        publicationTargetId: claim.publicationTargetId,
        publicationTargetRevision: claim.publicationTargetRevision,
        productVariantId: claim.productVariantId,
        destinationKind: "channel_connection",
        channelConnectionId: claim.channelConnectionId,
        dropshipStoreConnectionId: null,
        providerScopeType: claim.providerScopeType,
        externalScopeId: claim.externalScopeId,
        externalInventoryItemId: claim.externalInventoryItemId,
        desiredQuantity: claim.desiredQuantity,
        observedQuantity: input.observedQuantity,
        observedAt: input.completedAt.toISOString(),
      };
      await client.query(
        `INSERT INTO inventory.inventory_publication_readbacks (
           publication_target_id, product_variant_id, outbox_id, observed_quantity,
           matches_desired, evidence_hash, external_inventory_item_id_snapshot,
           destination_kind_snapshot, channel_connection_id_snapshot,
           dropship_store_connection_id_snapshot, provider_scope_type_snapshot,
           external_scope_id_snapshot, publication_target_revision_snapshot,
           observed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'channel_connection', $8,
           NULL, $9, $10, $11, $12)`,
        [claim.publicationTargetId, claim.productVariantId, claim.outboxId,
          input.observedQuantity, matches, hash(readbackEvidence), claim.externalInventoryItemId,
          claim.channelConnectionId, claim.providerScopeType, claim.externalScopeId,
          claim.publicationTargetRevision, input.completedAt.toISOString()],
      );
      await client.query(
        `UPDATE inventory.inventory_publication_outbox
         SET state = $2, verified_at = CASE WHEN $2 = 'verified' THEN $3::timestamptz ELSE NULL END
         WHERE id = $1 AND state = 'acknowledged'`,
        [claim.outboxId, matches ? "verified" : "drifted", input.completedAt.toISOString()],
      );
      await client.query(
        `UPDATE inventory.availability_activation_runs
         SET provider_write_attempted = true
         WHERE id = $1 AND provider_write_attempted = false`,
        [claim.activationRunId],
      );
      const stopRequested = !await publicationCanProceed(client, claim);
      if (!matches) {
        if (stopRequested) {
          await client.query(
            `UPDATE inventory.inventory_publication_outbox
             SET state = 'cancelled',
                 last_error_class = 'ACTIVATION_ABORTED_DURING_PROVIDER_WRITE',
                 last_error_message = $2
             WHERE id = $1 AND state = 'drifted'`,
            [claim.outboxId,
              `Observed ${input.observedQuantity}; desired ${claim.desiredQuantity} after activation stopped.`],
          );
          await finalizeDeadLetteredRunIfQuiescent(client, claim.activationRunId, input.completedAt);
          return "drifted";
        }
        await client.query(
          `UPDATE inventory.inventory_publication_outbox
           SET state = 'queued', available_at = $2,
               last_error_class = 'PROVIDER_READBACK_MISMATCH',
               last_error_message = $3
           WHERE id = $1 AND state = 'drifted'`,
          [claim.outboxId, input.completedAt.toISOString(),
            `Observed ${input.observedQuantity}; desired ${claim.desiredQuantity}`],
        );
        return "drifted";
      }
      const failed = await finalizeDeadLetteredRunIfQuiescent(
        client,
        claim.activationRunId,
        input.completedAt,
      );
      if (!failed && claim.publicationPhase === "conservative") {
        await advancePublicationVerified(client, claim.activationRunId, input.completedAt);
      }
      return "verified";
    });
  }

  async recordFailure(
    claim: ClaimedInventoryPublication,
    input: PublicationAttemptFailure & { completedAt: Date },
  ): Promise<boolean> {
    return inTransaction(this.connectionPool, async (client) => {
      await lockActivationRun(client, claim.activationRunId);
      const current = await lockClaim(client, claim);
      if (!current) return false;
      const cancelled = !await publicationCanProceed(client, claim);
      const retryable = !cancelled && input.retryable && claim.attemptNumber < 10;
      const outcome = cancelled ? "cancelled" : retryable ? "retryable" : "dead_letter";
      await client.query(
        `INSERT INTO inventory.inventory_publication_attempts (
           outbox_id, attempt_number, outcome, provider_request_key,
           request_hash, response_hash, error_class, error_message,
           started_at, completed_at
         ) VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9)`,
        [claim.outboxId, claim.attemptNumber, outcome, providerRequestKey(claim),
          publicationRequestHash(claim), input.errorClass.slice(0, 60),
          input.errorMessage.slice(0, 2000), claim.attemptStartedAt.toISOString(),
          input.completedAt.toISOString()],
      );
      await client.query(
        `UPDATE inventory.inventory_publication_outbox
         SET state = $3, lease_token = NULL, lease_expires_at = NULL,
             last_error_class = $4, last_error_message = $5,
             available_at = $6
         WHERE id = $1 AND lease_token = $2 AND state = 'leased'`,
        [claim.outboxId, claim.leaseToken, outcome, input.errorClass.slice(0, 60),
          input.errorMessage.slice(0, 2000), retryAt(input.completedAt, claim.attemptNumber).toISOString()],
      );
      if (retryable) {
        await client.query(
          `UPDATE inventory.inventory_publication_outbox SET state = 'queued'
           WHERE id = $1 AND state = 'retryable'`,
          [claim.outboxId],
        );
      }
      await finalizeDeadLetteredRunIfQuiescent(client, claim.activationRunId, input.completedAt);
      return true;
    });
  }
}

async function lockPublicationRuns(client: PoolClient, now: Date): Promise<void> {
  await client.query(
    `SELECT run.id
     FROM inventory.availability_activation_runs AS run
     WHERE EXISTS (
       SELECT 1 FROM inventory.inventory_publication_outbox AS outbox
       WHERE outbox.activation_run_id = run.id
         AND (
           (outbox.state = 'queued' AND outbox.available_at <= $1 AND (
             (outbox.publication_phase = 'conservative' AND run.state = 'publishing')
             OR
             (outbox.publication_phase = 'full' AND run.state = 'active')
           ))
           OR (outbox.state = 'leased' AND outbox.lease_expires_at <= $1
             AND outbox.publication_phase IN ('conservative', 'full'))
         )
     )
     ORDER BY run.id
     FOR UPDATE OF run`,
    [now.toISOString()],
  );
}

async function recoverExpiredLeases(client: PoolClient, now: Date): Promise<void> {
  const expired = (await client.query<Record<string, unknown>>(
    `SELECT outbox.*, run.state AS activation_state
     FROM inventory.inventory_publication_outbox AS outbox
     JOIN inventory.availability_activation_runs AS run ON run.id = outbox.activation_run_id
     WHERE outbox.state = 'leased' AND outbox.lease_expires_at <= $1
       AND outbox.publication_phase IN ('conservative', 'full')
     ORDER BY outbox.id FOR UPDATE OF outbox SKIP LOCKED`,
    [now.toISOString()],
  )).rows;
  for (const row of expired) {
    const claim = parseClaim(row, validDate(row.updated_at, "attemptStartedAt"));
    const cancelled = !await publicationCanProceed(
      client,
      claim,
      String(row.activation_state),
    );
    await client.query(
      `INSERT INTO inventory.inventory_publication_attempts (
         outbox_id, attempt_number, outcome, provider_request_key, request_hash,
         error_class, error_message, started_at, completed_at
       ) VALUES ($1, $2, $3, $4, $5,
                 'LEASE_EXPIRED', 'Worker lease expired before durable completion.', $6, $6)`,
      [claim.outboxId, claim.attemptNumber, cancelled ? "cancelled" : "retryable",
        providerRequestKey(claim), publicationRequestHash(claim), now.toISOString()],
    );
    await client.query(
      `UPDATE inventory.inventory_publication_outbox
       SET state = $2, lease_token = NULL, lease_expires_at = NULL,
           last_error_class = 'LEASE_EXPIRED',
           last_error_message = 'Worker lease expired before durable completion.',
           available_at = $3
       WHERE id = $1 AND state = 'leased'`,
      [claim.outboxId, cancelled ? "cancelled" : "retryable", now.toISOString()],
    );
    if (!cancelled) {
      await client.query(
        `UPDATE inventory.inventory_publication_outbox SET state = 'queued'
         WHERE id = $1 AND state = 'retryable'`,
        [claim.outboxId],
      );
    }
    await finalizeDeadLetteredRunIfQuiescent(client, claim.activationRunId, now);
  }
}

async function advancePublicationVerified(client: PoolClient, activationRunId: string, now: Date): Promise<void> {
  const remaining = Number((await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM inventory.inventory_publication_outbox
     WHERE activation_run_id = $1 AND publication_phase = 'conservative'
       AND state <> 'verified'`,
    [activationRunId],
  )).rows[0]?.count ?? "0");
  if (remaining > 0) return;
  const updated = (await client.query<{ result_hash: string; reason: string }>(
    `UPDATE inventory.availability_activation_runs
     SET state = 'publication_verified', publication_verified_at = $2
     WHERE id = $1 AND state = 'publishing'
     RETURNING result_hash, reason`,
    [activationRunId, now.toISOString()],
  )).rows[0];
  if (!updated) return;
  const evidence = { activationRunId, state: "publication_verified", verifiedAt: now.toISOString() };
  await client.query(
    `INSERT INTO inventory.availability_activation_events (
       activation_run_id, from_state, to_state, actor, reason,
       evidence_hash, evidence_payload, occurred_at
     ) VALUES ($1, 'publishing', 'publication_verified',
               'inventory-publication-worker', $2, $3, $4::jsonb, $5)`,
    [activationRunId, updated.reason, hash(evidence), JSON.stringify(evidence), now.toISOString()],
  );
}

async function lockClaim(client: PoolClient, claim: ClaimedInventoryPublication): Promise<Record<string, unknown> | null> {
  const row = (await client.query<Record<string, unknown>>(
    `SELECT * FROM inventory.inventory_publication_outbox
     WHERE id = $1 AND state = 'leased' AND lease_token = $2 FOR UPDATE`,
    [claim.outboxId, claim.leaseToken],
  )).rows[0];
  return row ?? null;
}

async function lockActivationRun(client: PoolClient, activationRunId: string): Promise<void> {
  await client.query(
    `SELECT id FROM inventory.availability_activation_runs WHERE id = $1 FOR UPDATE`,
    [activationRunId],
  );
}

async function activationRunState(client: PoolClient, activationRunId: string): Promise<string | null> {
  const row = (await client.query<{ state: string }>(
    `SELECT state FROM inventory.availability_activation_runs WHERE id = $1 FOR SHARE`,
    [activationRunId],
  )).rows[0];
  return row?.state ?? null;
}

async function activationHasDeadLetter(client: PoolClient, activationRunId: string): Promise<boolean> {
  const row = (await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM inventory.inventory_publication_outbox
       WHERE activation_run_id = $1 AND state = 'dead_letter'
     ) AS exists`,
    [activationRunId],
  )).rows[0];
  return row?.exists === true;
}

async function publicationCanProceed(
  client: PoolClient,
  claim: Pick<ClaimedInventoryPublication, "activationRunId" | "publicationPhase">,
  knownRunState?: string,
): Promise<boolean> {
  const runState = knownRunState ?? await activationRunState(client, claim.activationRunId);
  // Conservative rows are one coordinated pre-cutover batch: any permanent
  // failure stops that activation. Full rows are independent desired-state
  // updates after irreversible cutover, so an older dead letter must not block
  // a newer runtime publication for a different target or revision.
  if (claim.publicationPhase === "full") return runState === "active";
  return runState === "publishing"
    && !await activationHasDeadLetter(client, claim.activationRunId);
}

async function finalizeDeadLetteredRunIfQuiescent(
  client: PoolClient,
  activationRunId: string,
  occurredAt: Date,
): Promise<boolean> {
  const run = (await client.query<{ state: string; reason: string }>(
    `SELECT state, reason FROM inventory.availability_activation_runs WHERE id = $1 FOR UPDATE`,
    [activationRunId],
  )).rows[0];
  if (!run || run.state !== "publishing") return false;
  const counts = (await client.query<{ leased: string; dead_letter: string }>(
    `SELECT count(*) FILTER (WHERE state = 'leased')::text AS leased,
            count(*) FILTER (WHERE state = 'dead_letter')::text AS dead_letter
     FROM inventory.inventory_publication_outbox WHERE activation_run_id = $1`,
    [activationRunId],
  )).rows[0];
  if (Number(counts?.dead_letter ?? "0") === 0 || Number(counts?.leased ?? "0") > 0) return false;
  const failure = (await client.query<{ id: string; last_error_class: string | null }>(
    `SELECT id, last_error_class FROM inventory.inventory_publication_outbox
     WHERE activation_run_id = $1 AND state = 'dead_letter' ORDER BY id LIMIT 1`,
    [activationRunId],
  )).rows[0];
  if (!failure) return false;
  await client.query(
    `UPDATE inventory.inventory_publication_outbox
     SET state = 'cancelled', last_error_class = 'ACTIVATION_FAILED',
         last_error_message = 'A publication in the activation run reached dead letter.'
     WHERE activation_run_id = $1
       AND state IN ('desired', 'queued', 'retryable', 'drifted')`,
    [activationRunId],
  );
  await client.query(
    `UPDATE inventory.availability_activation_runs
     SET state = 'failed', failed_at = $2, completed_at = $2
     WHERE id = $1 AND state = 'publishing'`,
    [activationRunId, occurredAt.toISOString()],
  );
  await client.query(
    `UPDATE inventory.availability_activation_freezes
     SET released_by = 'inventory-publication-worker', released_at = $2,
         release_reason = 'Provider publication reached dead letter before authority cutover.'
     WHERE activation_run_id = $1 AND released_at IS NULL`,
    [activationRunId, occurredAt.toISOString()],
  );
  const evidence = {
    activationRunId,
    failedOutboxId: failure.id,
    errorClass: failure.last_error_class ?? "PROVIDER_PUBLICATION_FAILED",
    failedAt: occurredAt.toISOString(),
  };
  await client.query(
    `INSERT INTO inventory.availability_activation_events (
       activation_run_id, from_state, to_state, actor, reason,
       evidence_hash, evidence_payload, occurred_at
     ) VALUES ($1, 'publishing', 'failed', 'inventory-publication-worker', $2, $3, $4::jsonb, $5)`,
    [activationRunId, run.reason, hash(evidence), JSON.stringify(evidence), occurredAt.toISOString()],
  );
  return true;
}

function parseClaim(row: Record<string, unknown>, attemptStartedAt: Date): ClaimedInventoryPublication {
  const phase = String(row.publication_phase);
  const scope = String(row.provider_scope_type_snapshot);
  if (!row.activation_run_id || !["conservative", "full"].includes(phase)
    || !["account", "location"].includes(scope)) {
    throw new InventoryPublicationOutboxRepositoryError(
      "INVALID_PUBLICATION_CLAIM",
      "A cutover outbox row is missing its immutable activation identity.",
      { outboxId: row.id },
    );
  }
  return {
    outboxId: String(row.id),
    activationRunId: String(row.activation_run_id),
    publicationPhase: phase as "conservative" | "full",
    publicationTargetId: positiveInteger(row.publication_target_id, "publicationTargetId"),
    publicationTargetRevision: positiveBigint(
      row.publication_target_revision_snapshot,
      "publicationTargetRevision",
    ),
    productVariantId: positiveInteger(row.product_variant_id, "productVariantId"),
    desiredRevision: String(row.desired_revision),
    desiredQuantity: String(row.desired_quantity),
    channelId: positiveInteger(row.channel_id_snapshot, "channelId"),
    channelConnectionId: positiveInteger(row.channel_connection_id_snapshot, "channelConnectionId"),
    providerKey: String(row.provider_key_snapshot),
    providerScopeType: scope as "account" | "location",
    externalScopeId: String(row.external_scope_id_snapshot),
    externalInventoryItemId: String(row.external_inventory_item_id_snapshot),
    externalSku: row.external_sku_snapshot == null ? null : String(row.external_sku_snapshot),
    leaseToken: String(row.lease_token),
    attemptNumber: positiveInteger(row.attempt_count, "attemptNumber"),
    attemptStartedAt,
  };
}

async function inTransaction<T>(poolValue: ClientPool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await poolValue.connect();
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    const result = await work(client);
    await client.query("COMMIT");
    began = false;
    return result;
  } catch (error) {
    if (began) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InventoryPublicationOutboxRepositoryError("INVALID_PUBLICATION_CLAIM", `${field} must be positive.`);
  }
  return parsed;
}

function positiveBigint(value: unknown, field: string): string {
  const parsed = String(value ?? "");
  if (!/^[1-9]\d*$/.test(parsed)) {
    throw new InventoryPublicationOutboxRepositoryError("INVALID_PUBLICATION_CLAIM", `${field} must be positive.`);
  }
  return parsed;
}

function validDate(value: unknown, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(String(value ?? ""));
  if (Number.isNaN(parsed.getTime())) {
    throw new InventoryPublicationOutboxRepositoryError("INVALID_PUBLICATION_CLAIM", `${field} is invalid.`);
  }
  return parsed;
}

function providerRequestKey(claim: ClaimedInventoryPublication): string {
  return `inventory:${claim.activationRunId}:${claim.publicationPhase}:${claim.publicationTargetId}`
    + `:${claim.productVariantId}:${claim.desiredRevision}:${claim.attemptNumber}`;
}

function publicationRequestHash(claim: ClaimedInventoryPublication): string {
  return hash({
    publicationTargetId: claim.publicationTargetId,
    publicationTargetRevision: claim.publicationTargetRevision,
    productVariantId: claim.productVariantId,
    desiredRevision: claim.desiredRevision,
    desiredQuantity: claim.desiredQuantity,
    channelId: claim.channelId,
    channelConnectionId: claim.channelConnectionId,
    providerKey: claim.providerKey,
    providerScopeType: claim.providerScopeType,
    externalScopeId: claim.externalScopeId,
    externalInventoryItemId: claim.externalInventoryItemId,
    externalSku: claim.externalSku,
  });
}

function retryAt(now: Date, attemptNumber: number): Date {
  const delaySeconds = Math.min(3600, 15 * (2 ** Math.min(attemptNumber - 1, 8)));
  return new Date(now.getTime() + delaySeconds * 1000);
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
