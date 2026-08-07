import type { Pool, PoolClient, QueryResultRow } from "pg";
import { pool as defaultPool } from "../../../db";

import {
  listingReplacementOperationSchema,
  type CreateOrReplayListingReplacementResult,
  type ListingReplacementOperation,
} from "../application/dtos";
import type {
  ListingReplacementReplayLookup,
  MarketplaceListingReplacementRepository,
} from "../application/ports";
import { MarketplaceListingReplacementError } from "../domain/errors";
import type {
  ListingOwnerRef,
  ListingReplacementPlan,
} from "../domain/listing-replacement-plan";

interface ScopeRow extends QueryResultRow {
  id: string | number;
  owner_kind: string;
  provider: string;
  marketplace_id: string;
  product_id: number;
  channel_id: number | null;
  store_connection_id: number | null;
}

interface PublicationRow extends QueryResultRow {
  id: string | number;
  generation: number;
  status: string;
  desired_state_hash: string;
  provider_publication_key: string | null;
  external_listing_id: string | null;
}

interface GenerationRow extends QueryResultRow {
  max_generation: string | number;
}

interface IdRow extends QueryResultRow {
  id: string | number;
}

interface StepRow extends QueryResultRow {
  id: string | number;
  execution_path: string;
  sequence: number;
  step_key: string;
  phase: string;
  state_version: number;
}

interface OperationRow extends QueryResultRow {
  id: string | number;
  scope_id: string | number;
  source_publication_id: string | number;
  target_publication_id: string | number;
  idempotency_key: string;
  request_hash: string;
  desired_state_hash: string;
  status: string;
  current_phase: string;
  state_version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PostgresErrorShape {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

interface PostgresErrorMetadata {
  readonly code: string | null;
  readonly constraint: string | null;
}

type RollbackResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      error: unknown;
    }>;

const ACTIVE_OPERATION_CONSTRAINT =
  "listing_replacement_operations_active_scope_uidx";
const SCOPE_GENERATION_CONSTRAINT = "listing_publications_scope_generation_uq";

export class PgMarketplaceListingReplacementRepository implements MarketplaceListingReplacementRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async findReplay(
    lookup: ListingReplacementReplayLookup,
  ): Promise<ListingReplacementOperation | null> {
    try {
      const result = await this.dbPool.query<OperationRow>(
        operationReplayLookupSql(lookup.owner),
        operationReplayLookupParams(lookup),
      );
      if (result.rows.length > 1) {
        throw new MarketplaceListingReplacementError(
          "MARKETPLACE_LISTING_REPLACEMENT_DATABASE_CONTRACT_ERROR",
          "Owner-scoped idempotency lookup returned more than one operation.",
          { ownerKind: lookup.owner.kind },
        );
      }
      const existing = result.rows[0];
      if (!existing) return null;
      assertMatchingRequestHash(existing, lookup.requestHash, {
        ownerKind: lookup.owner.kind,
        productId: lookup.owner.productId,
      });
      return mapOperation(existing);
    } catch (error) {
      throw classifyReplayLookupError(error, lookup);
    }
  }

  async createOrReplayPlan(
    plan: ListingReplacementPlan,
  ): Promise<CreateOrReplayListingReplacementResult> {
    let client: PoolClient;
    try {
      client = await this.dbPool.connect();
    } catch (error) {
      throw classifyPersistenceError(error, plan);
    }
    let destroyClient = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '2s'");

      const scope = await lockAndLoadScope(client, plan.scopeId);
      assertScopeMatchesOwner(scope, plan.owner);

      const existing = await loadOperationForIdempotencyKey(
        client,
        plan.scopeId,
        plan.idempotencyKey,
      );
      if (existing) {
        assertMatchingRequestHash(existing, plan.requestHash, {
          scopeId: plan.scopeId,
        });
        const mapped = mapOperation(existing);
        await client.query("COMMIT");
        return { kind: "replay", operation: mapped };
      }

      const active = await loadActiveOperationForScope(client, plan.scopeId);
      if (active) {
        assertActiveOperationMatchesPlan(active, plan);
        const mapped = mapOperation(active);
        await client.query("COMMIT");
        return { kind: "replay", operation: mapped };
      }

      const source = await lockAndLoadSourcePublication(
        client,
        plan.scopeId,
        plan.sourcePublication.publicationId,
      );
      assertSourceMatchesPlan(source, plan);
      await assertNextGeneration(client, plan);

      const targetPublicationId = await insertTargetPublication(client, plan);
      await insertTargetMembers(client, plan, targetPublicationId);
      const operation = await insertOperation(
        client,
        plan,
        targetPublicationId,
      );
      const steps = await insertSteps(client, operation.id, plan);
      await insertInitialEvents(client, operation.id, plan, steps);

      const mapped = mapOperation(operation);
      await client.query("COMMIT");
      return { kind: "created", operation: mapped };
    } catch (error) {
      const persistenceError = classifyPersistenceError(error, plan);
      const rollbackResult = await rollbackTransaction(client);
      if (!rollbackResult.ok) {
        destroyClient = true;
        throw rollbackFailureError(
          persistenceError,
          rollbackResult.error,
          plan,
        );
      }
      throw persistenceError;
    } finally {
      if (destroyClient) {
        client.release(true);
      } else {
        client.release();
      }
    }
  }
}

async function lockAndLoadScope(
  client: PoolClient,
  scopeId: number,
): Promise<ScopeRow> {
  const result = await client.query<ScopeRow>(
    `SELECT
       s.id,
       s.owner_kind,
       s.provider,
       s.marketplace_id,
       s.product_id,
       cls.channel_id,
       dls.store_connection_id
     FROM marketplace.listing_scopes AS s
     LEFT JOIN marketplace.channel_listing_scopes AS cls ON cls.scope_id = s.id
     LEFT JOIN marketplace.dropship_listing_scopes AS dls ON dls.scope_id = s.id
     WHERE s.id = $1
     FOR UPDATE OF s`,
    [scopeId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_SCOPE_NOT_FOUND",
      "Marketplace listing replacement scope was not found.",
      { scopeId },
    );
  }
  return row;
}

function assertScopeMatchesOwner(
  scope: ScopeRow,
  owner: ListingOwnerRef,
): void {
  const commonMismatch =
    scope.owner_kind !== owner.kind ||
    scope.provider !== owner.provider ||
    scope.marketplace_id !== owner.marketplaceId ||
    scope.product_id !== owner.productId;
  const ownerMismatch =
    owner.kind === "channel"
      ? scope.channel_id !== owner.channelId ||
        scope.store_connection_id !== null
      : scope.store_connection_id !== owner.storeConnectionId ||
        scope.channel_id !== null;
  if (commonMismatch || ownerMismatch) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_SCOPE_OWNER_MISMATCH",
      "Marketplace listing replacement scope does not belong to the requested owner.",
      { scopeId: toSafeInteger(scope.id, "scope.id"), ownerKind: owner.kind },
    );
  }
}

async function loadOperationForIdempotencyKey(
  client: PoolClient,
  scopeId: number,
  idempotencyKey: string,
): Promise<OperationRow | null> {
  const result = await client.query<OperationRow>(
    `${operationSelectSql()}
     WHERE scope_id = $1 AND idempotency_key = $2
     FOR UPDATE`,
    [scopeId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function loadActiveOperationForScope(
  client: PoolClient,
  scopeId: number,
): Promise<OperationRow | null> {
  const result = await client.query<OperationRow>(
    operationSelectSql() +
      " WHERE scope_id = $1 AND status IN ('planned', 'running', 'compensating', 'manual_recovery_required') FOR UPDATE",
    [scopeId],
  );
  if (result.rows.length > 1) {
    throw databaseContractError(
      "Listing replacement scope returned more than one active operation.",
    );
  }
  return result.rows[0] ?? null;
}

function assertActiveOperationMatchesPlan(
  active: OperationRow,
  plan: ListingReplacementPlan,
): void {
  if (
    toSafeInteger(
      active.source_publication_id,
      "operation.source_publication_id",
    ) === plan.sourcePublication.publicationId &&
    active.desired_state_hash === plan.desiredStateHash
  )
    return;
  throw new MarketplaceListingReplacementError(
    "MARKETPLACE_LISTING_REPLACEMENT_ALREADY_ACTIVE",
    "Another replacement operation with different selected variants is already active for this listing scope.",
    {
      scopeId: plan.scopeId,
      operationId: toSafeInteger(active.id, "operation.id"),
    },
  );
}

function assertMatchingRequestHash(
  existing: OperationRow,
  requestHash: string,
  context: Readonly<Record<string, unknown>>,
): void {
  if (existing.request_hash !== requestHash) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_IDEMPOTENCY_CONFLICT",
      "Listing replacement idempotency key was already used for a different request.",
      {
        operationId: toSafeInteger(existing.id, "operation.id"),
        ...context,
      },
    );
  }
}

async function lockAndLoadSourcePublication(
  client: PoolClient,
  scopeId: number,
  publicationId: number,
): Promise<PublicationRow> {
  const result = await client.query<PublicationRow>(
    `SELECT
       id,
       generation,
       status,
       desired_state_hash,
       provider_publication_key,
       external_listing_id
     FROM marketplace.listing_publications
     WHERE id = $1 AND scope_id = $2
     FOR UPDATE`,
    [publicationId, scopeId],
  );
  const row = result.rows[0];
  if (!row) {
    throw stalePlanningContext(
      scopeId,
      "The active source publication no longer exists.",
    );
  }
  return row;
}

function assertSourceMatchesPlan(
  source: PublicationRow,
  plan: ListingReplacementPlan,
): void {
  const expected = plan.sourcePublication;
  const mismatch =
    source.status !== "active" ||
    source.generation !== expected.generation ||
    source.desired_state_hash !== expected.desiredStateHash ||
    source.provider_publication_key !== expected.providerPublicationKey ||
    source.external_listing_id !== expected.externalListingId;
  if (mismatch) {
    throw stalePlanningContext(
      plan.scopeId,
      "The active source publication changed after the replacement plan was prepared.",
    );
  }
}

async function assertNextGeneration(
  client: PoolClient,
  plan: ListingReplacementPlan,
): Promise<void> {
  const result = await client.query<GenerationRow>(
    `SELECT COALESCE(MAX(generation), 0) AS max_generation
     FROM marketplace.listing_publications
     WHERE scope_id = $1`,
    [plan.scopeId],
  );
  const maxGeneration = toSafeInteger(
    result.rows[0]?.max_generation ?? 0,
    "publication.max_generation",
  );
  if (plan.targetGeneration !== maxGeneration + 1) {
    throw stalePlanningContext(
      plan.scopeId,
      "A newer publication generation was created after the replacement plan was prepared.",
    );
  }
}

async function insertTargetPublication(
  client: PoolClient,
  plan: ListingReplacementPlan,
): Promise<number> {
  const result = await client.query<IdRow>(
    `INSERT INTO marketplace.listing_publications (
       scope_id,
       product_id,
       generation,
       supersedes_publication_id,
       status,
       desired_state_hash,
       metadata,
       created_by_type,
       created_by_id
     ) VALUES ($1, $2, $3, $4, 'planned', $5, $6::jsonb, $7, $8)
     RETURNING id`,
    [
      plan.scopeId,
      plan.owner.productId,
      plan.targetGeneration,
      plan.sourcePublication.publicationId,
      plan.desiredStateHash,
      JSON.stringify({ planVersion: plan.planVersion }),
      plan.requestedBy.type,
      plan.requestedBy.id,
    ],
  );
  return toSafeInteger(
    requiredRow(result.rows[0], "Target publication insert returned no row.")
      .id,
    "target.id",
  );
}

async function insertTargetMembers(
  client: PoolClient,
  plan: ListingReplacementPlan,
  targetPublicationId: number,
): Promise<void> {
  const result = await client.query<IdRow>(
    `INSERT INTO marketplace.listing_publication_members (
       publication_id,
       scope_id,
       product_id,
       product_variant_id,
       sku_snapshot,
       disposition,
       reason_code
     )
     SELECT
       $1,
       $2,
       $3,
       member.product_variant_id,
       member.sku_snapshot,
       member.disposition,
       member.reason_code
     FROM jsonb_to_recordset($4::jsonb) AS member(
       product_variant_id INTEGER,
       sku_snapshot VARCHAR(100),
       disposition VARCHAR(20),
       reason_code VARCHAR(100)
     )
     RETURNING id`,
    [
      targetPublicationId,
      plan.scopeId,
      plan.owner.productId,
      JSON.stringify(
        plan.targetMembers.map((member) => ({
          product_variant_id: member.productVariantId,
          sku_snapshot: member.skuSnapshot,
          disposition: member.disposition,
          reason_code: member.reasonCode,
        })),
      ),
    ],
  );
  if (result.rowCount !== plan.targetMembers.length) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_MEMBER_WRITE_INCOMPLETE",
      "Target publication members were not persisted completely.",
      {
        expected: plan.targetMembers.length,
        actual: result.rowCount,
      },
    );
  }
}

async function insertOperation(
  client: PoolClient,
  plan: ListingReplacementPlan,
  targetPublicationId: number,
): Promise<OperationRow> {
  const result = await client.query<OperationRow>(
    `INSERT INTO marketplace.listing_replacement_operations (
       scope_id,
       source_publication_id,
       target_publication_id,
       idempotency_key,
       request_hash,
       desired_state_hash,
       status,
       current_phase,
       requested_by_type,
       requested_by_id,
       correlation_id
     ) VALUES ($1, $2, $3, $4, $5, $6, 'planned', 'preflight', $7, $8, $9)
     RETURNING
       id,
       scope_id,
       source_publication_id,
       target_publication_id,
       idempotency_key,
       request_hash,
       desired_state_hash,
       status,
       current_phase,
       state_version,
       created_at,
       updated_at`,
    [
      plan.scopeId,
      plan.sourcePublication.publicationId,
      targetPublicationId,
      plan.idempotencyKey,
      plan.requestHash,
      plan.desiredStateHash,
      plan.requestedBy.type,
      plan.requestedBy.id,
      plan.correlationId,
    ],
  );
  return requiredRow(
    result.rows[0],
    "Replacement operation insert returned no row.",
  );
}

async function insertSteps(
  client: PoolClient,
  operationIdValue: string | number,
  plan: ListingReplacementPlan,
): Promise<readonly PersistedReplacementStep[]> {
  const operationId = toSafeInteger(operationIdValue, "operation.id");
  const result = await client.query<StepRow>(
    `INSERT INTO marketplace.listing_replacement_steps (
       operation_id,
       execution_path,
       sequence,
       step_key,
       phase,
       status,
       idempotency_key,
       request_hash,
       attempt_limit,
       request_payload
     )
     SELECT
       $1,
       step.execution_path,
       step.sequence,
       step.step_key,
       step.phase,
       'pending',
       step.idempotency_key,
       step.request_hash,
       step.attempt_limit,
       step.request_payload
     FROM jsonb_to_recordset($2::jsonb) AS step(
       execution_path VARCHAR(20),
       sequence INTEGER,
       step_key VARCHAR(100),
       phase VARCHAR(30),
       idempotency_key VARCHAR(200),
       request_hash VARCHAR(64),
       attempt_limit INTEGER,
       request_payload JSONB
     )
     RETURNING id, execution_path, sequence, step_key, phase, state_version`,
    [
      operationId,
      JSON.stringify(
        plan.steps.map((step) => ({
          execution_path: step.executionPath,
          sequence: step.sequence,
          step_key: step.stepKey,
          phase: step.phase,
          idempotency_key: step.idempotencyKey,
          request_hash: step.requestHash,
          attempt_limit: step.attemptLimit,
          request_payload: step.requestPayload,
        })),
      ),
    ],
  );
  if (result.rowCount !== plan.steps.length) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_STEP_WRITE_INCOMPLETE",
      "Replacement operation steps were not persisted completely.",
      { expected: plan.steps.length, actual: result.rowCount },
    );
  }

  const rowByPathAndSequence = new Map<string, StepRow>();
  for (const row of result.rows) {
    const key = stepIdentityKey(row.execution_path, row.sequence);
    if (rowByPathAndSequence.has(key)) {
      throw databaseContractError(
        "Replacement step insert returned duplicate execution path and sequence values.",
      );
    }
    rowByPathAndSequence.set(key, row);
  }

  return plan.steps.map((step) => {
    const row = rowByPathAndSequence.get(
      stepIdentityKey(step.executionPath, step.sequence),
    );
    if (
      !row ||
      row.step_key !== step.stepKey ||
      row.phase !== step.phase ||
      row.state_version !== 1
    ) {
      throw databaseContractError(
        "Replacement step insert returned data that does not match the deterministic plan.",
      );
    }
    return {
      id: toSafeInteger(row.id, "step.id"),
      sequence: step.sequence,
      executionPath: step.executionPath,
      stepKey: step.stepKey,
      phase: step.phase,
      requestHash: step.requestHash,
    };
  });
}

interface PersistedReplacementStep {
  readonly id: number;
  readonly sequence: number;
  readonly executionPath: string;
  readonly stepKey: string;
  readonly phase: string;
  readonly requestHash: string;
}

async function insertInitialEvents(
  client: PoolClient,
  operationIdValue: string | number,
  plan: ListingReplacementPlan,
  steps: readonly PersistedReplacementStep[],
): Promise<void> {
  const operationId = toSafeInteger(operationIdValue, "operation.id");
  await client.query(
    `INSERT INTO marketplace.listing_replacement_events (
       operation_id,
       sequence,
       event_type,
       phase,
       actor_type,
       actor_id,
       from_status,
       to_status,
       attempt,
       subject_state_version,
       evidence
     ) VALUES (
       $1, 1, 'operation.planned', 'preflight', $2, $3,
       NULL, 'planned', 0, 1, $4::jsonb
     )`,
    [
      operationId,
      plan.requestedBy.type,
      plan.requestedBy.id,
      JSON.stringify({
        planVersion: plan.planVersion,
        targetGeneration: plan.targetGeneration,
        requestedAt: plan.requestedAt.toISOString(),
      }),
    ],
  );

  let eventSequence = 2;
  for (const step of steps) {
    await client.query(
      `INSERT INTO marketplace.listing_replacement_events (
         operation_id,
         sequence,
         event_type,
         phase,
         step_id,
         actor_type,
         actor_id,
         from_status,
         to_status,
         attempt,
         subject_state_version,
         evidence
       ) VALUES (
         $1, $2, 'step.pending', $3, $4, $5, $6,
         NULL, 'pending', 0, 1, $7::jsonb
       )`,
      [
        operationId,
        eventSequence,
        step.phase,
        step.id,
        plan.requestedBy.type,
        plan.requestedBy.id,
        JSON.stringify({
          executionPath: step.executionPath,
          requestHash: step.requestHash,
          sequence: step.sequence,
          stepKey: step.stepKey,
        }),
      ],
    );
    eventSequence += 1;
  }
}

function stepIdentityKey(executionPath: string, sequence: number): string {
  return `${executionPath}:${sequence}`;
}

function databaseContractError(
  message: string,
): MarketplaceListingReplacementError {
  return new MarketplaceListingReplacementError(
    "MARKETPLACE_LISTING_REPLACEMENT_DATABASE_CONTRACT_ERROR",
    message,
  );
}

function operationSelectSql(): string {
  return `SELECT
    id,
    scope_id,
    source_publication_id,
    target_publication_id,
    idempotency_key,
    request_hash,
    desired_state_hash,
    status,
    current_phase,
    state_version,
    created_at,
    updated_at
  FROM marketplace.listing_replacement_operations`;
}

function operationReplayLookupSql(owner: ListingOwnerRef): string {
  const binding =
    owner.kind === "channel"
      ? `JOIN marketplace.channel_listing_scopes AS binding
         ON binding.scope_id = scope.id
        AND binding.product_id = scope.product_id
        AND binding.marketplace_id = scope.marketplace_id`
      : `JOIN marketplace.dropship_listing_scopes AS binding
         ON binding.scope_id = scope.id
        AND binding.product_id = scope.product_id
        AND binding.marketplace_id = scope.marketplace_id`;
  const ownerPredicate =
    owner.kind === "channel"
      ? "binding.channel_id = $4"
      : "binding.store_connection_id = $4";
  const ownerKind = owner.kind === "channel" ? "channel" : "dropship";
  return `${operationSelectSql()}
    WHERE scope_id = (
      SELECT scope.id
      FROM marketplace.listing_scopes AS scope
      ${binding}
      WHERE scope.owner_kind = '${ownerKind}'
        AND scope.provider = $1
        AND scope.marketplace_id = $2
        AND scope.product_id = $3
        AND ${ownerPredicate}
    )
      AND idempotency_key = $5`;
}

function operationReplayLookupParams(
  lookup: ListingReplacementReplayLookup,
): unknown[] {
  const ownerId =
    lookup.owner.kind === "channel"
      ? lookup.owner.channelId
      : lookup.owner.storeConnectionId;
  return [
    lookup.owner.provider,
    lookup.owner.marketplaceId,
    lookup.owner.productId,
    ownerId,
    lookup.idempotencyKey,
  ];
}

function mapOperation(row: OperationRow): ListingReplacementOperation {
  return listingReplacementOperationSchema.parse({
    operationId: toSafeInteger(row.id, "operation.id"),
    scopeId: toSafeInteger(row.scope_id, "operation.scope_id"),
    sourcePublicationId: toSafeInteger(
      row.source_publication_id,
      "operation.source_publication_id",
    ),
    targetPublicationId: toSafeInteger(
      row.target_publication_id,
      "operation.target_publication_id",
    ),
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    desiredStateHash: row.desired_state_hash,
    status: row.status,
    currentPhase: row.current_phase,
    stateVersion: row.state_version,
    createdAt: toDate(row.created_at, "operation.created_at"),
    updatedAt: toDate(row.updated_at, "operation.updated_at"),
  });
}

function stalePlanningContext(
  scopeId: number,
  message: string,
): MarketplaceListingReplacementError {
  return new MarketplaceListingReplacementError(
    "MARKETPLACE_LISTING_REPLACEMENT_PLANNING_CONTEXT_STALE",
    message,
    { scopeId },
  );
}

function classifyReplayLookupError(
  error: unknown,
  lookup: ListingReplacementReplayLookup,
): MarketplaceListingReplacementError {
  if (error instanceof MarketplaceListingReplacementError) return error;
  const { code, constraint } = postgresErrorMetadata(error);
  return new MarketplaceListingReplacementError(
    "MARKETPLACE_LISTING_REPLACEMENT_DATABASE_ERROR",
    "Marketplace listing replacement replay lookup failed.",
    {
      ownerKind: lookup.owner.kind,
      productId: lookup.owner.productId,
      postgresCode: code,
      constraint,
    },
    { cause: error },
  );
}

function classifyPersistenceError(
  error: unknown,
  plan: ListingReplacementPlan,
): MarketplaceListingReplacementError {
  if (error instanceof MarketplaceListingReplacementError) return error;
  const { code, constraint } = postgresErrorMetadata(error);
  if (code === "55P03") {
    return new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_CONCURRENT_UPDATE",
      "Marketplace listing replacement scope is being updated by another request.",
      { scopeId: plan.scopeId },
      { cause: error },
    );
  }
  if (code === "23505" && constraint === ACTIVE_OPERATION_CONSTRAINT) {
    return new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_ALREADY_ACTIVE",
      "Another replacement operation is already active for this listing scope.",
      { scopeId: plan.scopeId },
      { cause: error },
    );
  }
  if (code === "23505" && constraint === SCOPE_GENERATION_CONSTRAINT) {
    return stalePlanningContext(
      plan.scopeId,
      "A newer publication generation won the concurrent replacement request.",
    );
  }
  return new MarketplaceListingReplacementError(
    "MARKETPLACE_LISTING_REPLACEMENT_DATABASE_ERROR",
    "Marketplace listing replacement plan could not be persisted.",
    { scopeId: plan.scopeId, postgresCode: code, constraint },
    { cause: error },
  );
}

function postgresErrorMetadata(error: unknown): PostgresErrorMetadata {
  if (typeof error !== "object" || error === null) {
    return { code: null, constraint: null };
  }
  const postgresError = error as PostgresErrorShape;
  return {
    code: typeof postgresError.code === "string" ? postgresError.code : null,
    constraint:
      typeof postgresError.constraint === "string"
        ? postgresError.constraint
        : null,
  };
}

function rollbackFailureError(
  persistenceError: MarketplaceListingReplacementError,
  rollbackError: unknown,
  plan: ListingReplacementPlan,
): MarketplaceListingReplacementError {
  const rollbackMetadata = postgresErrorMetadata(rollbackError);
  return new MarketplaceListingReplacementError(
    "MARKETPLACE_LISTING_REPLACEMENT_ROLLBACK_FAILED",
    "Marketplace listing replacement plan failed and its transaction could not be rolled back safely.",
    {
      scopeId: plan.scopeId,
      persistenceErrorCode: persistenceError.code,
      rollbackPostgresCode: rollbackMetadata.code,
      rollbackConstraint: rollbackMetadata.constraint,
    },
    {
      cause: new AggregateError(
        [persistenceError, rollbackError],
        "Marketplace listing replacement persistence and rollback both failed.",
      ),
    },
  );
}

function requiredRow<Row>(row: Row | undefined, message: string): Row {
  if (row !== undefined) return row;
  throw new MarketplaceListingReplacementError(
    "MARKETPLACE_LISTING_REPLACEMENT_DATABASE_CONTRACT_ERROR",
    message,
  );
}

function toSafeInteger(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_DATABASE_VALUE_INVALID",
      "Marketplace listing replacement database returned an invalid identifier.",
      { field },
    );
  }
  return parsed;
}

function toDate(value: Date | string, field: string): Date {
  const parsed =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_DATABASE_VALUE_INVALID",
      "Marketplace listing replacement database returned an invalid timestamp.",
      { field },
    );
  }
  return parsed;
}

async function rollbackTransaction(
  client: PoolClient,
): Promise<RollbackResult> {
  try {
    await client.query("ROLLBACK");
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}
