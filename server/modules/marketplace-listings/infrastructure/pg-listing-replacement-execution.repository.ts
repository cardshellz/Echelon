import { randomUUID } from "crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import { pool as defaultPool } from "../../../db";
import type {
  ClaimedListingReplacementStep,
  ListingReplacementStepSuccess,
  MarketplaceListingReplacementExecutionRepository,
  TerminalListingReplacementOperation,
} from "../application/execution-ports";
import type { CanonicalJsonValue } from "../domain/canonical-hash";
import { MarketplaceListingReplacementError } from "../domain/errors";
import type {
  ListingActor,
  ListingOwnerRef,
} from "../domain/listing-replacement-plan";

interface OperationRow extends QueryResultRow {
  id: string | number;
  scope_id: string | number;
  source_publication_id: string | number;
  target_publication_id: string | number;
  status: string;
  current_phase: string;
  state_version: number;
  attempt_count: number;
  attempt_limit: number;
  lease_token: string | null;
  lease_expires_at: Date | string | null;
  requested_by_type: string;
  requested_by_id: string;
  correlation_id: string | null;
  desired_state_hash: string;
  recovery_context: Record<string, CanonicalJsonValue> | null;
  owner_kind: string;
  provider: string;
  marketplace_id: string;
  product_id: number;
  channel_id: number | null;
  store_connection_id: number | null;
  source_generation: number;
  source_desired_state_hash: string;
  source_provider_publication_key: string | null;
  source_external_listing_id: string | null;
  target_generation: number;
  target_provider_publication_key: string | null;
  target_external_listing_id: string | null;
}

interface StepRow extends QueryResultRow {
  id: string | number;
  operation_id: string | number;
  sequence: number;
  step_key: string;
  phase: string;
  execution_path: string;
  status: string;
  idempotency_key: string;
  request_hash: string;
  state_version: number;
  attempt_count: number;
  attempt_limit: number;
}

interface MemberRow extends QueryResultRow {
  product_variant_id: number;
  sku_snapshot: string;
  disposition: string;
  reason_code: string | null;
  external_variant_id: string | null;
  external_offer_id: string | null;
  external_inventory_item_id: string | null;
}

interface VersionRow extends QueryResultRow {
  state_version: number;
  attempt_count: number;
  lease_token?: string;
  lease_expires_at?: Date | string;
}

interface SequenceRow extends QueryResultRow {
  next_sequence: string | number;
}

export interface MarketplaceListingLeaseTokenFactory {
  create(): string;
}

export class PgMarketplaceListingReplacementExecutionRepository implements MarketplaceListingReplacementExecutionRepository {
  constructor(
    private readonly dbPool: Pool = defaultPool,
    private readonly leaseTokens: MarketplaceListingLeaseTokenFactory = {
      create: randomUUID,
    },
  ) {}

  async claimNextStep(input: {
    readonly operationId: number;
    readonly expectedOwner: ListingOwnerRef;
    readonly actor: ListingActor;
    readonly leaseToken: string | null;
    readonly now: Date;
    readonly leaseDurationMs: number;
  }): Promise<
    ClaimedListingReplacementStep | TerminalListingReplacementOperation
  > {
    validateClaimInput(input);
    return this.inTransaction(async (client) => {
      const original = await lockOperation(client, input.operationId);
      assertExpectedOwner(original, input.expectedOwner);
      if (["completed", "failed", "cancelled"].includes(original.status)) {
        return {
          kind: "terminal",
          status:
            original.status as TerminalListingReplacementOperation["status"],
        };
      }
      if (original.status === "manual_recovery_required") {
        throw executionError(
          "MARKETPLACE_LISTING_REPLACEMENT_MANUAL_RECOVERY_REQUIRED",
          "Replacement execution requires an explicit recovery decision.",
          { operationId: input.operationId },
        );
      }
      const lease = decideLease(original, input, this.leaseTokens);
      const operation = await acquireOrRenewLease(
        client,
        original,
        input,
        lease,
      );
      await insertOperationEvent(
        client,
        operation,
        original.status,
        input.actor,
        lease.isNew ? { leaseAcquired: true } : { leaseRenewed: true },
      );
      await recoverExpiredRunningStep(
        client,
        operation,
        input.actor,
        lease.isNew && original.status !== "planned",
      );
      const pending = await lockNextStep(client, operation);
      if (!pending)
        throw executionError(
          "MARKETPLACE_LISTING_REPLACEMENT_NEXT_STEP_NOT_FOUND",
          "No executable step exists for the active replacement phase.",
          { operationId: input.operationId, phase: operation.current_phase },
        );
      const running = await startStep(client, pending, input.now);
      await insertStepEvent(
        client,
        operation.id,
        running,
        pending.status,
        input.actor,
        { leaseToken: lease.token },
      );
      const targetMembers = await loadPublicationMembers(
        client,
        operation.target_publication_id,
      );
      const sourceMembers = await loadPublicationMembers(
        client,
        operation.source_publication_id,
      );
      const claim = mapClaim(
        operation,
        running,
        sourceMembers,
        targetMembers,
        input.actor,
      );
      return claim;
    });
  }

  async completeStep(input: {
    readonly claim: ClaimedListingReplacementStep;
    readonly result: ListingReplacementStepSuccess;
    readonly completedAt: Date;
  }): Promise<void> {
    await this.inTransaction(async (client) => {
      const operation = await lockClaim(client, input.claim, input.completedAt);
      const step = await completeClaimedStep(
        client,
        input.claim,
        input.result.evidence,
        input.completedAt,
      );
      await insertStepEvent(
        client,
        operation.id,
        step,
        "running",
        input.claim.executor,
        input.result.evidence,
      );
      if (input.claim.stepKey === "publish.create_target") {
        await stageTargetPublication(
          client,
          operation,
          input.result,
          input.completedAt,
        );
      }
      const nextPhase = nextForwardPhase(input.claim.stepKey);
      if (nextPhase) {
        const advanced = await updateOperation(client, operation, {
          status: "running",
          phase: nextPhase,
          completedAt: null,
          errorCode: null,
          errorMessage: null,
          recoveryContext: null,
          clearLease: false,
          at: input.completedAt,
        });
        await insertOperationEvent(
          client,
          advanced,
          operation.status,
          input.claim.executor,
          { completedStepKey: input.claim.stepKey },
        );
      }
    });
  }
  async activateTargetAndCompleteOperation(input: {
    readonly claim: ClaimedListingReplacementStep;
    readonly result: ListingReplacementStepSuccess;
    readonly completedAt: Date;
  }): Promise<void> {
    if (input.claim.stepKey !== "switch_mapping.activate_target")
      throw invalidTransition(input.claim);
    await this.inTransaction(async (client) => {
      const operation = await lockClaim(client, input.claim, input.completedAt);
      const step = await completeClaimedStep(
        client,
        input.claim,
        input.result.evidence,
        input.completedAt,
      );
      await insertStepEvent(
        client,
        operation.id,
        step,
        "running",
        input.claim.executor,
        input.result.evidence,
      );
      await requireSingleUpdate(
        client,
        `UPDATE marketplace.listing_publications SET status = 'active', verified_at = COALESCE(verified_at, $2), updated_at = $2 WHERE id = $1 AND status = 'staged'`,
        [toId(operation.target_publication_id), input.completedAt],
        "target publication activation",
      );
      await requireSingleUpdate(
        client,
        `UPDATE marketplace.listing_publications SET status = 'superseded', retired_at = $2, updated_at = $2 WHERE id = $1 AND status = 'active'`,
        [toId(operation.source_publication_id), input.completedAt],
        "source publication supersession",
      );
      const completed = await updateOperation(client, operation, {
        status: "completed",
        phase: "complete",
        completedAt: input.completedAt,
        errorCode: null,
        errorMessage: null,
        recoveryContext: null,
        clearLease: true,
        at: input.completedAt,
      });
      await insertOperationEvent(
        client,
        completed,
        operation.status,
        input.claim.executor,
        { targetActivated: true, sourceSuperseded: true },
      );
    });
  }
  async failPreflight(input: {
    readonly claim: ClaimedListingReplacementStep;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly evidence: Readonly<Record<string, CanonicalJsonValue>>;
    readonly failedAt: Date;
  }): Promise<void> {
    if (input.claim.stepKey !== "preflight.validate_plan")
      throw invalidTransition(input.claim);
    validateFailure(input.errorCode, input.errorMessage, input.failedAt);
    await this.inTransaction(async (client) => {
      const operation = await lockClaim(client, input.claim, input.failedAt);
      const step = await failClaimedStep(
        client,
        input.claim,
        input.errorCode,
        input.errorMessage,
        input.evidence,
        input.failedAt,
      );
      await insertStepEvent(
        client,
        operation.id,
        step,
        "running",
        input.claim.executor,
        input.evidence,
      );
      await requireSingleUpdate(
        client,
        `UPDATE marketplace.listing_publications SET status = 'failed', updated_at = $2 WHERE id = $1 AND status = 'planned'`,
        [toId(operation.target_publication_id), input.failedAt],
        "preflight target failure",
      );
      const failed = await updateOperation(client, operation, {
        status: "failed",
        phase: "preflight",
        completedAt: input.failedAt,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        recoveryContext: null,
        clearLease: true,
        at: input.failedAt,
      });
      await insertOperationEvent(
        client,
        failed,
        operation.status,
        input.claim.executor,
        input.evidence,
      );
    });
  }
  async beginCompensation(input: {
    readonly claim: ClaimedListingReplacementStep;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly evidence: Readonly<Record<string, CanonicalJsonValue>>;
    readonly failedAt: Date;
  }): Promise<void> {
    if (
      input.claim.stepKey.startsWith("compensate.") ||
      input.claim.stepKey === "preflight.validate_plan"
    )
      throw invalidTransition(input.claim);
    validateFailure(input.errorCode, input.errorMessage, input.failedAt);
    await this.inTransaction(async (client) => {
      const operation = await lockClaim(client, input.claim, input.failedAt);
      const step = await failClaimedStep(
        client,
        input.claim,
        input.errorCode,
        input.errorMessage,
        input.evidence,
        input.failedAt,
      );
      await insertStepEvent(
        client,
        operation.id,
        step,
        "running",
        input.claim.executor,
        input.evidence,
      );
      const compensating = await updateOperation(client, operation, {
        status: "compensating",
        phase: "compensate",
        completedAt: null,
        errorCode: null,
        errorMessage: null,
        recoveryContext: {
          originalErrorCode: input.errorCode,
          originalErrorMessage: input.errorMessage,
          failedStepKey: input.claim.stepKey,
          evidence: input.evidence,
        },
        clearLease: false,
        at: input.failedAt,
      });
      await insertOperationEvent(
        client,
        compensating,
        operation.status,
        input.claim.executor,
        { compensationStarted: true, failedStepKey: input.claim.stepKey },
      );
    });
  }
  async completeCompensationAndFailOperation(input: {
    readonly claim: ClaimedListingReplacementStep;
    readonly result: ListingReplacementStepSuccess;
    readonly completedAt: Date;
  }): Promise<void> {
    if (input.claim.stepKey !== "compensate.ensure_source_live")
      throw invalidTransition(input.claim);
    await this.inTransaction(async (client) => {
      const operation = await lockClaim(
        client,
        input.claim,
        input.completedAt,
        "compensating",
        "compensate",
      );
      const step = await completeClaimedStep(
        client,
        input.claim,
        input.result.evidence,
        input.completedAt,
      );
      await insertStepEvent(
        client,
        operation.id,
        step,
        "running",
        input.claim.executor,
        input.result.evidence,
      );
      await requireSingleUpdate(
        client,
        `UPDATE marketplace.listing_publications SET status = 'failed', updated_at = $2 WHERE id = $1 AND status IN ('planned', 'staged')`,
        [toId(operation.target_publication_id), input.completedAt],
        "compensated target failure",
      );
      const failed = await updateOperation(client, operation, {
        status: "failed",
        phase: "compensate",
        completedAt: input.completedAt,
        errorCode: "MARKETPLACE_LISTING_REPLACEMENT_COMPENSATED",
        errorMessage:
          "Replacement failed and the source listing was restored safely.",
        recoveryContext: operation.recovery_context,
        clearLease: true,
        at: input.completedAt,
      });
      await insertOperationEvent(
        client,
        failed,
        operation.status,
        input.claim.executor,
        { compensationCompleted: true },
      );
    });
  }
  async requireManualRecovery(input: {
    readonly claim: ClaimedListingReplacementStep;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly evidence: Readonly<Record<string, CanonicalJsonValue>>;
    readonly failedAt: Date;
  }): Promise<void> {
    if (!input.claim.stepKey.startsWith("compensate."))
      throw invalidTransition(input.claim);
    validateFailure(input.errorCode, input.errorMessage, input.failedAt);
    await this.inTransaction(async (client) => {
      const operation = await lockClaim(
        client,
        input.claim,
        input.failedAt,
        "compensating",
        "compensate",
      );
      const step = await failClaimedStep(
        client,
        input.claim,
        input.errorCode,
        input.errorMessage,
        input.evidence,
        input.failedAt,
      );
      await insertStepEvent(
        client,
        operation.id,
        step,
        "running",
        input.claim.executor,
        input.evidence,
      );
      const manual = await updateOperation(client, operation, {
        status: "manual_recovery_required",
        phase: "compensate",
        completedAt: input.failedAt,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        recoveryContext: {
          failedCompensationStepKey: input.claim.stepKey,
          evidence: input.evidence,
        },
        clearLease: true,
        at: input.failedAt,
      });
      await insertOperationEvent(
        client,
        manual,
        operation.status,
        input.claim.executor,
        { manualRecoveryRequired: true, failedStepKey: input.claim.stepKey },
      );
    });
  }

  private async inTransaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.dbPool.connect();
    let released = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '2s'");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        client.release(true);
        released = true;
        throw executionError(
          "MARKETPLACE_LISTING_REPLACEMENT_ROLLBACK_FAILED",
          "Replacement transaction and rollback both failed.",
          {},
          error,
          rollbackError,
        );
      }
      throw classifyExecutionError(error);
    } finally {
      if (!released) client.release();
    }
  }
}

async function lockOperation(
  client: PoolClient,
  operationId: number,
): Promise<OperationRow> {
  await lockOperationScope(client, operationId);
  const result = await client.query<OperationRow>(
    `SELECT o.*, s.owner_kind, s.provider, s.marketplace_id, s.product_id, cls.channel_id, dls.store_connection_id, source.generation AS source_generation, source.desired_state_hash AS source_desired_state_hash, source.provider_publication_key AS source_provider_publication_key, source.external_listing_id AS source_external_listing_id, target.generation AS target_generation, target.provider_publication_key AS target_provider_publication_key, target.external_listing_id AS target_external_listing_id FROM marketplace.listing_replacement_operations o JOIN marketplace.listing_scopes s ON s.id = o.scope_id LEFT JOIN marketplace.channel_listing_scopes cls ON cls.scope_id = s.id LEFT JOIN marketplace.dropship_listing_scopes dls ON dls.scope_id = s.id JOIN marketplace.listing_publications source ON source.id = o.source_publication_id AND source.scope_id = o.scope_id JOIN marketplace.listing_publications target ON target.id = o.target_publication_id AND target.scope_id = o.scope_id WHERE o.id = $1 FOR UPDATE OF o`,
    [operationId],
  );
  const row = result.rows[0];
  if (!row)
    throw executionError(
      "MARKETPLACE_LISTING_REPLACEMENT_OPERATION_NOT_FOUND",
      "Replacement operation was not found.",
      { operationId },
    );
  return row;
}

async function lockOperationScope(
  client: PoolClient,
  operationId: number,
): Promise<void> {
  await client.query(
    `SELECT s.id
     FROM marketplace.listing_replacement_operations o
     JOIN marketplace.listing_scopes s ON s.id = o.scope_id
     WHERE o.id = $1
     FOR UPDATE OF s`,
    [operationId],
  );
}

function decideLease(
  row: OperationRow,
  input: { leaseToken: string | null; now: Date },
  factory: MarketplaceListingLeaseTokenFactory,
): { token: string; isNew: boolean } {
  if (row.status === "planned")
    return { token: validateUuid(factory.create()), isNew: true };
  if (!["running", "compensating"].includes(row.status))
    throw executionError(
      "MARKETPLACE_LISTING_REPLACEMENT_OPERATION_NOT_EXECUTABLE",
      "Replacement operation is not executable in its current state.",
      { status: row.status },
    );
  const expiresAt = requiredDate(row.lease_expires_at, "lease_expires_at");
  if (
    row.lease_token === input.leaseToken &&
    input.leaseToken !== null &&
    expiresAt.getTime() > input.now.getTime()
  )
    return { token: input.leaseToken, isNew: false };
  if (expiresAt.getTime() <= input.now.getTime())
    return { token: validateUuid(factory.create()), isNew: true };
  throw executionError(
    "MARKETPLACE_LISTING_REPLACEMENT_LEASE_CONFLICT",
    "Replacement operation is already leased by another executor.",
    { leaseExpiresAt: expiresAt.toISOString() },
  );
}

async function acquireOrRenewLease(
  client: PoolClient,
  row: OperationRow,
  input: { now: Date; leaseDurationMs: number },
  lease: { token: string; isNew: boolean },
): Promise<OperationRow> {
  const expiresAt = new Date(input.now.getTime() + input.leaseDurationMs);
  const nextStatus = row.status === "planned" ? "running" : row.status;
  const result = await client.query<OperationRow>(
    `UPDATE marketplace.listing_replacement_operations SET status = $2, state_version = state_version + 1, attempt_count = attempt_count + $3, lease_token = $4, lease_expires_at = $5, started_at = COALESCE(started_at, $6), updated_at = $6 WHERE id = $1 AND state_version = $7 RETURNING *`,
    [
      toId(row.id),
      nextStatus,
      lease.isNew ? 1 : 0,
      lease.token,
      expiresAt,
      input.now,
      row.state_version,
    ],
  );
  const updated = result.rows[0];
  if (!updated)
    throw executionError(
      "MARKETPLACE_LISTING_REPLACEMENT_CONCURRENT_UPDATE",
      "Replacement operation changed while acquiring its lease.",
      { operationId: toId(row.id) },
    );
  return { ...row, ...updated };
}

async function recoverExpiredRunningStep(
  client: PoolClient,
  operation: OperationRow,
  actor: ListingActor,
  mayRecover: boolean,
): Promise<void> {
  const result = await client.query<StepRow>(
    `SELECT * FROM marketplace.listing_replacement_steps WHERE operation_id = $1 AND status = 'running' FOR UPDATE`,
    [toId(operation.id)],
  );
  if (result.rows.length === 0) return;
  if (!mayRecover || result.rows.length !== 1)
    throw executionError(
      "MARKETPLACE_LISTING_REPLACEMENT_STEP_BUSY",
      "Replacement operation already has a running step.",
      { operationId: toId(operation.id) },
    );
  const step = result.rows[0];
  const failed = await client.query<StepRow>(
    `UPDATE marketplace.listing_replacement_steps SET status = 'failed', state_version = state_version + 1, error_code = 'MARKETPLACE_LISTING_REPLACEMENT_LEASE_EXPIRED', error_message = 'The previous executor lease expired before step completion.', completed_at = transaction_timestamp(), updated_at = transaction_timestamp() WHERE id = $1 AND state_version = $2 RETURNING *`,
    [toId(step.id), step.state_version],
  );
  await insertStepEvent(
    client,
    operation.id,
    failed.rows[0],
    "running",
    actor,
    { recoveredExpiredLease: true },
  );
}

async function lockNextStep(
  client: PoolClient,
  operation: OperationRow,
): Promise<StepRow | null> {
  const path = operation.status === "compensating" ? "compensation" : "forward";
  const phase =
    operation.status === "compensating"
      ? "compensate"
      : operation.current_phase;
  const result = await client.query<StepRow>(
    `SELECT * FROM marketplace.listing_replacement_steps WHERE operation_id = $1 AND execution_path = $2 AND phase = $3 AND status IN ('pending', 'failed') ORDER BY sequence ASC LIMIT 1 FOR UPDATE`,
    [toId(operation.id), path, phase],
  );
  return result.rows[0] ?? null;
}

async function startStep(
  client: PoolClient,
  step: StepRow,
  now: Date,
): Promise<StepRow> {
  if (step.attempt_count >= step.attempt_limit)
    throw executionError(
      "MARKETPLACE_LISTING_REPLACEMENT_STEP_ATTEMPT_LIMIT",
      "Replacement step exhausted its attempt limit.",
      { stepId: toId(step.id), stepKey: step.step_key },
    );
  const result = await client.query<StepRow>(
    `UPDATE marketplace.listing_replacement_steps SET status = 'running', state_version = state_version + 1, attempt_count = attempt_count + 1, result_evidence = NULL, error_code = NULL, error_message = NULL, started_at = $3, completed_at = NULL, updated_at = $3 WHERE id = $1 AND state_version = $2 RETURNING *`,
    [toId(step.id), step.state_version, now],
  );
  const row = result.rows[0];
  if (!row)
    throw executionError(
      "MARKETPLACE_LISTING_REPLACEMENT_CONCURRENT_UPDATE",
      "Replacement step changed while it was being claimed.",
      { stepId: toId(step.id) },
    );
  return row;
}

async function loadPublicationMembers(
  client: PoolClient,
  publicationIdValue: string | number,
): Promise<MemberRow[]> {
  const result = await client.query<MemberRow>(
    `SELECT product_variant_id, sku_snapshot, disposition, reason_code, external_variant_id, external_offer_id, external_inventory_item_id FROM marketplace.listing_publication_members WHERE publication_id = $1 ORDER BY product_variant_id ASC`,
    [toId(publicationIdValue)],
  );
  if (result.rows.length === 0)
    throw executionError(
      "MARKETPLACE_LISTING_REPLACEMENT_TARGET_MEMBERS_MISSING",
      "Replacement publication contains no members.",
    );
  return result.rows;
}

async function insertOperationEvent(
  client: PoolClient,
  operation: OperationRow,
  fromStatus: string,
  actor: ListingActor,
  evidence: Record<string, CanonicalJsonValue>,
): Promise<void> {
  const sequence = await nextEventSequence(client, toId(operation.id));
  await client.query(
    `INSERT INTO marketplace.listing_replacement_events (operation_id, sequence, event_type, phase, actor_type, actor_id, from_status, to_status, attempt, subject_state_version, evidence) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
    [
      toId(operation.id),
      sequence,
      `operation.${operation.status}`,
      operation.current_phase,
      actor.type,
      actor.id,
      fromStatus,
      operation.status,
      operation.attempt_count,
      operation.state_version,
      JSON.stringify(evidence),
    ],
  );
}

async function insertStepEvent(
  client: PoolClient,
  operationIdValue: string | number,
  step: StepRow,
  fromStatus: string,
  actor: ListingActor,
  evidence: Record<string, CanonicalJsonValue>,
): Promise<void> {
  const operationId = toId(operationIdValue);
  const sequence = await nextEventSequence(client, operationId);
  await client.query(
    `INSERT INTO marketplace.listing_replacement_events (operation_id, sequence, event_type, phase, step_id, actor_type, actor_id, from_status, to_status, attempt, subject_state_version, evidence) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
    [
      operationId,
      sequence,
      `step.${step.status}`,
      step.phase,
      toId(step.id),
      actor.type,
      actor.id,
      fromStatus,
      step.status,
      step.attempt_count,
      step.state_version,
      JSON.stringify(evidence),
    ],
  );
}

async function nextEventSequence(
  client: PoolClient,
  operationId: number,
): Promise<number> {
  const result = await client.query<SequenceRow>(
    `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM marketplace.listing_replacement_events WHERE operation_id = $1`,
    [operationId],
  );
  return toId(result.rows[0]?.next_sequence ?? 0);
}

function mapClaim(
  operation: OperationRow,
  step: StepRow,
  sourceMembers: MemberRow[],
  targetMembers: MemberRow[],
  executor: ListingActor,
): ClaimedListingReplacementStep {
  const owner = mapOwner(operation);
  const sourceExternalListingId = operation.source_external_listing_id;
  if (!sourceExternalListingId)
    throw executionError(
      "MARKETPLACE_LISTING_REPLACEMENT_SOURCE_EXTERNAL_ID_MISSING",
      "Replacement source has no external listing ID.",
    );
  return {
    executor,
    operation: {
      operationId: toId(operation.id),
      operationStateVersion: operation.state_version,
      owner,
      sourcePublication: {
        publicationId: toId(operation.source_publication_id),
        generation: operation.source_generation,
        status: "active",
        desiredStateHash: operation.source_desired_state_hash,
        providerPublicationKey: operation.source_provider_publication_key,
        externalListingId: sourceExternalListingId,
      },
      targetPublicationId: toId(operation.target_publication_id),
      targetGeneration: operation.target_generation,
      targetProviderPublicationKey: operation.target_provider_publication_key,
      targetExternalListingId: operation.target_external_listing_id,
      desiredStateHash: operation.desired_state_hash,
      sourceMembers: sourceMembers.map(mapExecutionMember),
      targetMembers: targetMembers.map(mapExecutionMember),
      actor: {
        type: operation.requested_by_type as ListingActor["type"],
        id: operation.requested_by_id,
      },
      correlationId: operation.correlation_id,
    },
    stepId: toId(step.id),
    stepStateVersion: step.state_version,
    stepKey: step.step_key as ClaimedListingReplacementStep["stepKey"],
    idempotencyKey: step.idempotency_key,
    requestHash: step.request_hash,
    attempt: step.attempt_count,
    leaseToken: requiredText(operation.lease_token, "lease_token"),
    leaseExpiresAt: requiredDate(
      operation.lease_expires_at,
      "lease_expires_at",
    ),
  };
}

function mapExecutionMember(member: MemberRow) {
  return {
    productVariantId: member.product_variant_id,
    skuSnapshot: member.sku_snapshot,
    disposition: member.disposition as "included" | "excluded",
    reasonCode: member.reason_code,
    externalVariantId: member.external_variant_id,
    externalOfferId: member.external_offer_id,
    externalInventoryItemId: member.external_inventory_item_id,
  };
}
function mapOwner(row: OperationRow): ListingOwnerRef {
  if (
    row.owner_kind === "channel" &&
    row.channel_id &&
    row.store_connection_id === null
  )
    return {
      kind: "channel",
      channelId: row.channel_id,
      productId: row.product_id,
      provider: row.provider,
      marketplaceId: row.marketplace_id,
    };
  if (
    row.owner_kind === "dropship" &&
    row.store_connection_id &&
    row.channel_id === null
  )
    return {
      kind: "dropship",
      storeConnectionId: row.store_connection_id,
      productId: row.product_id,
      provider: row.provider,
      marketplaceId: row.marketplace_id,
    };
  throw executionError(
    "MARKETPLACE_LISTING_REPLACEMENT_OWNER_CONTRACT_INVALID",
    "Replacement operation owner binding is invalid.",
    { ownerKind: row.owner_kind },
  );
}

function assertExpectedOwner(
  operation: OperationRow,
  expected: ListingOwnerRef,
): void {
  const actual = mapOwner(operation);
  const same =
    actual.kind === expected.kind &&
    actual.provider === expected.provider &&
    actual.marketplaceId === expected.marketplaceId &&
    actual.productId === expected.productId &&
    (actual.kind === "channel"
      ? expected.kind === "channel" && actual.channelId === expected.channelId
      : expected.kind === "dropship" &&
        actual.storeConnectionId === expected.storeConnectionId);
  if (!same) {
    throw executionError(
      "MARKETPLACE_LISTING_REPLACEMENT_OWNER_BINDING_MISMATCH",
      "Replacement operation is bound to a different marketplace owner.",
      { operationId: toId(operation.id) },
    );
  }
}
function validateClaimInput(input: {
  operationId: number;
  expectedOwner: ListingOwnerRef;
  actor: ListingActor;
  now: Date;
  leaseDurationMs: number;
}): void {
  if (
    !Number.isSafeInteger(input.operationId) ||
    input.operationId <= 0 ||
    !input.actor?.id?.trim() ||
    !input.expectedOwner ||
    !(input.now instanceof Date) ||
    !Number.isFinite(input.now.getTime()) ||
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs < 1_000 ||
    input.leaseDurationMs > 300_000 ||
    !["user", "service", "system"].includes(input.actor.type) ||
    input.actor.id !== input.actor.id.trim() ||
    input.actor.id.length > 255
  )
    throw executionError(
      "MARKETPLACE_LISTING_REPLACEMENT_EXECUTION_INPUT_INVALID",
      "Replacement step claim input is invalid.",
    );
}
function validateUuid(value: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw executionError(
      "MARKETPLACE_LISTING_REPLACEMENT_LEASE_TOKEN_INVALID",
      "Lease token factory returned an invalid UUID.",
    );
  return value;
}
function toId(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw executionError(
      "MARKETPLACE_LISTING_REPLACEMENT_DATABASE_CONTRACT_ERROR",
      "Database returned an invalid positive identifier.",
      { value },
    );
  return parsed;
}
function requiredDate(value: Date | string | null, field: string): Date {
  const parsed =
    value instanceof Date
      ? value
      : value
        ? new Date(value)
        : new Date(Number.NaN);
  if (!Number.isFinite(parsed.getTime()))
    throw executionError(
      "MARKETPLACE_LISTING_REPLACEMENT_DATABASE_CONTRACT_ERROR",
      "Database returned an invalid timestamp.",
      { field },
    );
  return parsed;
}
function requiredText(value: string | null, field: string): string {
  if (!value?.trim())
    throw executionError(
      "MARKETPLACE_LISTING_REPLACEMENT_DATABASE_CONTRACT_ERROR",
      "Database returned missing text.",
      { field },
    );
  return value;
}
function executionError(
  code: string,
  message: string,
  context: Record<string, unknown> = {},
  cause?: unknown,
  rollbackCause?: unknown,
): MarketplaceListingReplacementError {
  return new MarketplaceListingReplacementError(
    code,
    message,
    { ...context, ...(rollbackCause ? { rollbackFailed: true } : {}) },
    cause === undefined ? undefined : { cause },
  );
}
function classifyExecutionError(
  error: unknown,
): MarketplaceListingReplacementError {
  return error instanceof MarketplaceListingReplacementError
    ? error
    : executionError(
        "MARKETPLACE_LISTING_REPLACEMENT_DATABASE_ERROR",
        "Replacement execution database operation failed.",
        {},
        error,
      );
}

interface OperationTransition {
  status: string;
  phase: string;
  completedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  recoveryContext: Readonly<Record<string, CanonicalJsonValue>> | null;
  clearLease: boolean;
  at: Date;
}

async function lockClaim(
  client: PoolClient,
  claim: ClaimedListingReplacementStep,
  at: Date,
  expectedStatus = "running",
  expectedPhase = phaseForStep(claim.stepKey),
): Promise<OperationRow> {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
    throw executionError(
      "MARKETPLACE_LISTING_REPLACEMENT_EXECUTION_INPUT_INVALID",
      "Replacement transition timestamp is invalid.",
    );
  }
  const operation = await lockOperation(client, claim.operation.operationId);
  const expiresAt = requiredDate(
    operation.lease_expires_at,
    "lease_expires_at",
  );
  if (
    operation.status !== expectedStatus ||
    operation.current_phase !== expectedPhase ||
    operation.state_version !== claim.operation.operationStateVersion ||
    operation.lease_token !== claim.leaseToken ||
    expiresAt.getTime() <= at.getTime()
  ) {
    throw executionError(
      "MARKETPLACE_LISTING_REPLACEMENT_CLAIM_STALE",
      "Replacement step claim no longer owns the current operation lease and phase.",
      { operationId: claim.operation.operationId, stepId: claim.stepId },
    );
  }
  return operation;
}

async function lockClaimedStep(
  client: PoolClient,
  claim: ClaimedListingReplacementStep,
): Promise<StepRow> {
  const result = await client.query<StepRow>(
    `SELECT * FROM marketplace.listing_replacement_steps WHERE id = $1 AND operation_id = $2 FOR UPDATE`,
    [claim.stepId, claim.operation.operationId],
  );
  const step = result.rows[0];
  if (
    !step ||
    step.step_key !== claim.stepKey ||
    step.status !== "running" ||
    step.state_version !== claim.stepStateVersion
  ) {
    throw executionError(
      "MARKETPLACE_LISTING_REPLACEMENT_STEP_CLAIM_STALE",
      "Replacement step changed after it was claimed.",
      { operationId: claim.operation.operationId, stepId: claim.stepId },
    );
  }
  return step;
}

async function completeClaimedStep(
  client: PoolClient,
  claim: ClaimedListingReplacementStep,
  evidence: Readonly<Record<string, CanonicalJsonValue>>,
  at: Date,
): Promise<StepRow> {
  await lockClaimedStep(client, claim);
  const result = await client.query<StepRow>(
    `UPDATE marketplace.listing_replacement_steps SET status = 'succeeded', state_version = state_version + 1, result_evidence = $3::jsonb, completed_at = $4, updated_at = $4 WHERE id = $1 AND state_version = $2 AND status = 'running' RETURNING *`,
    [claim.stepId, claim.stepStateVersion, JSON.stringify(evidence), at],
  );
  return requireRow(result.rows[0], "step completion");
}

async function failClaimedStep(
  client: PoolClient,
  claim: ClaimedListingReplacementStep,
  errorCode: string,
  errorMessage: string,
  evidence: Readonly<Record<string, CanonicalJsonValue>>,
  at: Date,
): Promise<StepRow> {
  await lockClaimedStep(client, claim);
  const result = await client.query<StepRow>(
    `UPDATE marketplace.listing_replacement_steps SET status = 'failed', state_version = state_version + 1, result_evidence = $3::jsonb, error_code = $4, error_message = $5, completed_at = $6, updated_at = $6 WHERE id = $1 AND state_version = $2 AND status = 'running' RETURNING *`,
    [
      claim.stepId,
      claim.stepStateVersion,
      JSON.stringify(evidence),
      errorCode,
      errorMessage,
      at,
    ],
  );
  return requireRow(result.rows[0], "step failure");
}

async function stageTargetPublication(
  client: PoolClient,
  operation: OperationRow,
  result: ListingReplacementStepSuccess,
  at: Date,
): Promise<void> {
  const externalListingId = result.externalListingId?.trim();
  if (!externalListingId) {
    throw executionError(
      "MARKETPLACE_LISTING_REPLACEMENT_PROVIDER_IDENTITY_INVALID",
      "Target publication creation returned no external listing ID.",
    );
  }
  const included = await client.query<{ product_variant_id: number }>(
    `SELECT product_variant_id FROM marketplace.listing_publication_members WHERE publication_id = $1 AND disposition = 'included' ORDER BY product_variant_id`,
    [toId(operation.target_publication_id)],
  );
  const identities = result.memberIdentities ?? [];
  const expected = included.rows.map((row) => row.product_variant_id);
  const actual = identities.map((identity) => identity.productVariantId);
  if (
    new Set(actual).size !== actual.length ||
    expected.length !== actual.length ||
    expected.some((id) => !actual.includes(id))
  ) {
    throw executionError(
      "MARKETPLACE_LISTING_REPLACEMENT_MEMBER_IDENTITIES_INVALID",
      "Provider member identities must cover every included target variant exactly once.",
      { expectedProductVariantIds: expected, actualProductVariantIds: actual },
    );
  }
  await requireSingleUpdate(
    client,
    `UPDATE marketplace.listing_publications SET status = 'staged', provider_publication_key = $2, external_listing_id = $3, external_url = $4, published_at = $5, updated_at = $5 WHERE id = $1 AND status = 'planned'`,
    [
      toId(operation.target_publication_id),
      result.providerPublicationKey?.trim() || null,
      externalListingId,
      result.externalUrl?.trim() || null,
      at,
    ],
    "target publication staging",
  );
  for (const identity of identities) {
    await requireSingleUpdate(
      client,
      `UPDATE marketplace.listing_publication_members SET external_variant_id = $3, external_offer_id = $4, external_inventory_item_id = $5 WHERE publication_id = $1 AND product_variant_id = $2 AND disposition = 'included'`,
      [
        toId(operation.target_publication_id),
        identity.productVariantId,
        nullableText(identity.externalVariantId),
        nullableText(identity.externalOfferId),
        nullableText(identity.externalInventoryItemId),
      ],
      "target member identity persistence",
    );
  }
}

async function updateOperation(
  client: PoolClient,
  operation: OperationRow,
  transition: OperationTransition,
): Promise<OperationRow> {
  const result = await client.query<OperationRow>(
    `UPDATE marketplace.listing_replacement_operations
     SET status = $3, current_phase = $4, state_version = state_version + 1,
         lease_token = CASE WHEN $5 THEN NULL ELSE lease_token END,
         lease_expires_at = CASE WHEN $5 THEN NULL ELSE lease_expires_at END,
         error_code = $6, error_message = $7, recovery_context = $8::jsonb,
         completed_at = $9, updated_at = $10
     WHERE id = $1 AND state_version = $2 RETURNING *`,
    [
      toId(operation.id),
      operation.state_version,
      transition.status,
      transition.phase,
      transition.clearLease,
      transition.errorCode,
      transition.errorMessage,
      transition.recoveryContext === null
        ? null
        : JSON.stringify(transition.recoveryContext),
      transition.completedAt,
      transition.at,
    ],
  );
  return {
    ...operation,
    ...requireRow(result.rows[0], "operation transition"),
  };
}

async function requireSingleUpdate(
  client: PoolClient,
  sql: string,
  values: readonly unknown[],
  action: string,
): Promise<void> {
  const result = await client.query(sql, values as unknown[]);
  if (result.rowCount !== 1) {
    throw executionError(
      "MARKETPLACE_LISTING_REPLACEMENT_CONCURRENT_UPDATE",
      `Replacement ${action} did not update the expected row.`,
    );
  }
}

function requireRow<T>(row: T | undefined, action: string): T {
  if (!row) {
    throw executionError(
      "MARKETPLACE_LISTING_REPLACEMENT_CONCURRENT_UPDATE",
      `Replacement ${action} did not return the expected row.`,
    );
  }
  return row;
}

function nextForwardPhase(
  stepKey: ClaimedListingReplacementStep["stepKey"],
): string | null {
  switch (stepKey) {
    case "preflight.validate_plan":
      return "cutover";
    case "cutover.quiesce_source":
      return "publish";
    case "publish.create_target":
      return "verify";
    case "verify.target_publication":
      return "switch_mapping";
    case "compensate.ensure_target_not_sellable":
      return null;
    case "compensate.ensure_source_live":
      return null;
    case "switch_mapping.activate_target":
      return null;
  }
}

function phaseForStep(
  stepKey: ClaimedListingReplacementStep["stepKey"],
): string {
  if (stepKey.startsWith("compensate.")) return "compensate";
  return stepKey.split(".")[0];
}

function validateFailure(
  errorCode: string,
  errorMessage: string,
  at: Date,
): void {
  if (
    !errorCode.trim() ||
    errorCode.length > 100 ||
    !errorMessage.trim() ||
    errorMessage.length > 2_000 ||
    !(at instanceof Date) ||
    !Number.isFinite(at.getTime())
  ) {
    throw executionError(
      "MARKETPLACE_LISTING_REPLACEMENT_EXECUTION_INPUT_INVALID",
      "Replacement failure details are invalid.",
    );
  }
}

function invalidTransition(
  claim: ClaimedListingReplacementStep,
): MarketplaceListingReplacementError {
  return executionError(
    "MARKETPLACE_LISTING_REPLACEMENT_TRANSITION_INVALID",
    "Replacement step cannot use this repository transition.",
    { stepKey: claim.stepKey },
  );
}

function nullableText(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}
