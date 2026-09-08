import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { InventoryAvailabilityTransactionQueryClient as Client } from "../application/inventory-availability-transaction-query.port";
import type { QuantityPublicationAdmission, QuantityPublicationCatchup, QuantityPublicationCatchupStore, QuantityPublicationOutboxClaim } from "../application/quantity-publication-admission.port";
import { QuantityPublicationAdmissionError, quantityPublicationScopeSchema, quantityPublicationRecoverySchema,
  type QuantityPublicationScope, type QuantityPublicationDrainProof, type QuantityPublicationRecovery } from "../domain/quantity-publication-admission";

// Separate namespace from authority, inventory-admission, and target/variant locks.
export const QUANTITY_PUBLICATION_LOCK_NAMESPACE = 918419;
const session = new AsyncLocalStorage<{ scope: QuantityPublicationScope; externalSku: string | null; memberKeys: ReadonlySet<string> }>();
const hash = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const key = (scope: QuantityPublicationScope): string => hash({ ...scope, productId: null, productVariantId: null });
const fail = (code: string, message: string, context: Record<string, unknown> = {}): never => {
  throw new QuantityPublicationAdmissionError(code, message, context);
};
function id(value: string): string {
  if (!/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > BigInt("9223372036854775807")) fail("PUBLICATION_ID_INVALID", "Expected a positive database identifier.");
  return value;
}
function now(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail("PUBLICATION_CLOCK_INVALID", "Invalid publication clock.");
  return value.toISOString();
}
function actor(value: string): string {
  const result = value.trim();
  if (!result || result.length > 200) fail("PUBLICATION_ACTOR_INVALID", "A bounded audit actor is required.");
  return result;
}

async function tryExclusive(client: Client): Promise<void> {
  if (!(await client.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_xact_lock($1,0) AS acquired", [QUANTITY_PUBLICATION_LOCK_NAMESPACE],
  )).rows[0]?.acquired) fail("QUANTITY_PUBLICATION_DRAIN_BUSY", "A provider quantity owner is still running; retry the command.");
}

/** Parent must own its authority/admission fence FIRST. This lock never waits in reverse order. */
export async function suppressQuantityPublicationInsideTransaction(client: Client,
  input: { activationRunId: string; actor: string; now: Date }): Promise<QuantityPublicationDrainProof> {
  const runId = id(input.activationRunId); actor(input.actor);
  await tryExclusive(client);
  const gate = (await client.query<{ activation_run_id: string | null }>(
    "SELECT activation_run_id::text FROM inventory.quantity_publication_gate WHERE singleton FOR UPDATE",
  )).rows[0];
  if (!gate) fail("PUBLICATION_GATE_MISSING", "Quantity publication admission migration is missing.");
  if (gate.activation_run_id !== null && gate.activation_run_id !== runId) {
    fail("PUBLICATION_GATE_RUN_CONFLICT", "Another activation owns publication suppression.");
  }
  if (gate.activation_run_id === null) await client.query(
    `UPDATE inventory.quantity_publication_gate SET activation_run_id=$1, epoch=epoch+1, suppressed_at=$2 WHERE singleton`,
    [runId, now(input.now)],
  );
  // Uncertain attempts are returned, not thrown: suppression must survive their investigation.
  return captureQuantityPublicationDrainInsideTransaction(client, runId);
}

export async function captureQuantityPublicationDrainInsideTransaction(client: Client,
  activationRunId: string): Promise<QuantityPublicationDrainProof> {
  const runId = id(activationRunId);
  await tryExclusive(client);
  const gate = (await client.query<{ epoch: string; activation_run_id: string | null }>(
    "SELECT epoch::text, activation_run_id::text FROM inventory.quantity_publication_gate WHERE singleton",
  )).rows[0];
  if (!gate) fail("PUBLICATION_GATE_MISSING", "Quantity publication admission migration is missing.");
  const unresolved = (await client.query<{ id: string; owner_kind: "legacy" | "outbox"; state: "running" | "uncertain"; scope: unknown; outbox_id: string | null }>(
    `SELECT id::text,owner_kind,state,scope,outbox_id::text FROM inventory.quantity_publication_attempts
     WHERE state IN ('running','uncertain') ORDER BY id LIMIT 1001`,
  )).rows;
  if (unresolved.length > 1000) fail("PUBLICATION_DRAIN_EVIDENCE_LIMIT", "Resolve the outstanding publication attempt backlog before capture.");
  const latest = (await client.query<{ id: string; outbox_id: string | null; gate_epoch: string; owner_kind: "legacy" | "outbox"; scope: unknown;
    completed_at: Date | null; resolution_basis: "owner_completion" | "operator_attestation" | null }>(
    `SELECT DISTINCT ON (member.scope_key) a.id::text,a.outbox_id::text,a.gate_epoch::text,a.owner_kind,
       a.affected_scopes->(member.ordinality::int-1) AS scope,a.completed_at,a.resolution_basis
     FROM inventory.quantity_publication_attempts a
     CROSS JOIN LATERAL unnest(a.affected_scope_keys) WITH ORDINALITY AS member(scope_key,ordinality)
     ORDER BY member.scope_key,a.id DESC LIMIT 10001`,
  )).rows;
  if (latest.length > 10000) fail("PUBLICATION_DRAIN_EVIDENCE_LIMIT", "Publication drain scope exceeds the supported evidence bound.");
  const counts = (await client.query<{ latest: string; pending: string }>(
    `SELECT COALESCE((SELECT MAX(id) FROM inventory.quantity_publication_attempts),0)::text AS latest,
      (SELECT COUNT(*) FROM inventory.quantity_publication_catchup WHERE completed_revision<revision)::text AS pending`,
  )).rows[0];
  return { contractVersion: 1, activationRunId: runId, gateEpoch: gate.epoch,
    suppressed: gate.activation_run_id === runId, latestAttemptId: counts.latest,
    unresolvedAttempts: unresolved.map(row => ({ attemptId: row.id, owner: row.owner_kind,
      state: row.state, scope: quantityPublicationScopeSchema.parse(row.scope), outboxId: row.outbox_id })),
    latestAttemptsByScope: latest.map(row => ({ attemptId: row.id, outboxId: row.outbox_id, gateEpoch: row.gate_epoch, owner: row.owner_kind,
      scope: quantityPublicationScopeSchema.parse(row.scope), completedAt: row.completed_at?.toISOString() ?? null,
      resolutionBasis: row.resolution_basis })), pendingCatchupCount: Number(counts.pending) };
}

/** Includes conservative destinations even when no ordinary event was suppressed. No provider I/O. */
export async function releaseQuantityPublicationSuppressionInsideTransaction(client: Client,
  input: { activationRunId: string; outcome: "aborted" | "completed"; actor: string; now: Date }): Promise<void> {
  const runId = id(input.activationRunId); actor(input.actor);
  await tryExclusive(client);
  const gate = (await client.query<{ activation_run_id: string | null }>(
    "SELECT activation_run_id::text FROM inventory.quantity_publication_gate WHERE singleton FOR UPDATE",
  )).rows[0];
  if (gate?.activation_run_id !== runId) fail("PUBLICATION_GATE_RUN_CONFLICT", "This run does not own publication suppression.");
  const scopes = (await client.query<Record<string, unknown>>(
    `SELECT DISTINCT destination_kind_snapshot,channel_connection_id_snapshot,dropship_store_connection_id_snapshot,
       provider_key_snapshot,provider_scope_type_snapshot,external_scope_id_snapshot,
       external_inventory_item_id_snapshot,product_variant_id
     FROM inventory.inventory_publication_outbox WHERE activation_run_id=$1 AND publication_phase='conservative'`, [runId],
  )).rows;
  for (const row of scopes) await retainCatchup(client, quantityPublicationScopeSchema.parse({
    destinationKind: row.destination_kind_snapshot,
    connectionId: row.channel_connection_id_snapshot ?? row.dropship_store_connection_id_snapshot,
    providerKey: row.provider_key_snapshot, providerScopeType: row.provider_scope_type_snapshot,
    externalScopeId: row.external_scope_id_snapshot, externalInventoryItemId: row.external_inventory_item_id_snapshot,
    productId: null, productVariantId: row.product_variant_id,
  }), runId, `activation_${input.outcome}`, input.now);
  await client.query(`UPDATE inventory.quantity_publication_catchup SET next_attempt_at=$1
    WHERE completed_revision<revision`, [now(input.now)]);
  await client.query(`UPDATE inventory.quantity_publication_gate SET activation_run_id=NULL,suppressed_at=NULL,epoch=epoch+1 WHERE singleton`);
}

async function retainCatchup(client: Client, scope: QuantityPublicationScope,
  runId: string | null, reason: string, timestamp: Date): Promise<void> {
  return retainCatchupScopes(client, [scope], runId, reason, timestamp);
}

async function retainCatchupScopes(client: Client, scopes: readonly QuantityPublicationScope[],
  runId: string | null, reason: string, timestamp: Date): Promise<void> {
  // One atomic statement retains every known group member even when no caller
  // transaction exists (capacity/scope-lock rejection precedes provider I/O).
  await client.query(`INSERT INTO inventory.quantity_publication_catchup
    (scope_key,scope,last_activation_run_id,reason,next_attempt_at,updated_at,attempt_boundary_id)
    SELECT incoming.scope_key,incoming.scope,$2,$3,$4,$4,(SELECT COALESCE(MAX(id),0) FROM inventory.quantity_publication_attempts)
    FROM jsonb_to_recordset($1::jsonb) AS incoming(scope_key text,scope jsonb)
    ON CONFLICT (scope_key) DO UPDATE SET
    scope=EXCLUDED.scope,revision=quantity_publication_catchup.revision+1,
    last_activation_run_id=COALESCE(EXCLUDED.last_activation_run_id,quantity_publication_catchup.last_activation_run_id),
    reason=EXCLUDED.reason,next_attempt_at=EXCLUDED.next_attempt_at,updated_at=EXCLUDED.updated_at,
    attempt_boundary_id=EXCLUDED.attempt_boundary_id`,
  [JSON.stringify(scopes.map(scope => ({ scope_key: key(scope), scope }))), runId, reason, now(timestamp)]);
}

/** One connection per top-level provider owner, with explicit bounded admission and reentrant identity validation. */
export class PostgresQuantityPublicationAdmission implements QuantityPublicationAdmission, QuantityPublicationCatchupStore {
  private active = 0;
  constructor(private readonly pool: Pick<Pool, "connect">,
    private readonly clock: () => Date = () => new Date(), private readonly tokenFactory: () => string = randomUUID,
    private readonly maximumConcurrentOwners = 4) {
    if (!Number.isSafeInteger(maximumConcurrentOwners) || maximumConcurrentOwners < 1 || maximumConcurrentOwners > 100) {
      throw new Error("Invalid provider admission concurrency limit.");
    }
  }

  run<T>(raw: QuantityPublicationScope, work: () => Promise<T>): Promise<T> {
    const scope = quantityPublicationScopeSchema.parse(raw);
    const parent = session.getStore();
    if (parent) {
      const sameDestination = scope.destinationKind === parent.scope.destinationKind && scope.connectionId === parent.scope.connectionId
        && scope.providerKey === parent.scope.providerKey && scope.providerScopeType === parent.scope.providerScopeType
        && scope.externalScopeId === parent.scope.externalScopeId;
      if (!sameDestination || (scope.externalInventoryItemId !== parent.scope.externalInventoryItemId
        && scope.externalInventoryItemId !== parent.externalSku && !parent.memberKeys.has(key(scope)))) {
        fail("PUBLICATION_NESTED_SCOPE_MISMATCH", "A nested provider call is outside its admitted exact destination/item.");
      }
      return work();
    }
    return this.execute(scope, null, work);
  }

  runOutbox<T>(claim: QuantityPublicationOutboxClaim, work: () => Promise<T>): Promise<T> {
    if (session.getStore()) fail("PUBLICATION_OUTBOX_NESTING_INVALID", "An outbox owner cannot inherit a legacy provider capability.");
    const scope = quantityPublicationScopeSchema.parse({ destinationKind: claim.destinationKind,
      connectionId: claim.channelConnectionId ?? claim.dropshipStoreConnectionId,
      providerKey: claim.providerKey, providerScopeType: claim.providerScopeType, externalScopeId: claim.externalScopeId,
      externalInventoryItemId: claim.externalInventoryItemId, productId: null, productVariantId: claim.productVariantId });
    return this.execute(scope, claim, work);
  }

  runListing<T>(raw: QuantityPublicationScope,
    resolveCurrentPlan: () => Promise<{ outboxId: string; quantity: number }>,
    work: (canonicalQuantity: number | null) => Promise<T>): Promise<T> {
    const scope = quantityPublicationScopeSchema.parse(raw);
    if (session.getStore()) return this.run(scope, () => work(null));
    let quantity: number | null = null;
    return this.execute(scope, null, () => work(quantity), async () => {
      const plan = await resolveCurrentPlan(); quantity = plan.quantity; return [{ ...plan, scope }];
    });
  }

  runListingGroup<T>(raw: QuantityPublicationScope, rawMembers: readonly QuantityPublicationScope[],
    resolveCurrentPlan: (scope: QuantityPublicationScope) => Promise<{ outboxId: string; quantity: number }>,
    work: (canonicalQuantities: ReadonlyMap<string, number> | null) => Promise<T>): Promise<T> {
    const scope = quantityPublicationScopeSchema.parse(raw);
    const members = rawMembers.map(member => quantityPublicationScopeSchema.parse(member));
    if (members.length < 1 || members.length > 250 || new Set(members.map(key)).size !== members.length
      || members.some(member => member.destinationKind !== scope.destinationKind || member.connectionId !== scope.connectionId
        || member.providerKey !== scope.providerKey || member.providerScopeType !== scope.providerScopeType
        || member.externalScopeId !== scope.externalScopeId)) {
      fail("PUBLICATION_GROUP_SCOPE_INVALID", "A listing group requires bounded exact distinct members from one destination.");
    }
    if (session.getStore()) fail("PUBLICATION_GROUP_NESTING_INVALID", "A listing group cannot expand another provider capability.");
    let quantities: Map<string, number> | null = null;
    return this.execute(scope, null, () => work(quantities), async () => {
      const plans = [];
      quantities = new Map();
      for (const member of members) {
        const plan = await resolveCurrentPlan(member);
        quantities.set(member.externalInventoryItemId, plan.quantity); plans.push({ ...plan, scope: member });
      }
      return plans;
    }, members);
  }

  runQuantityReducingLifecycle<T>(raw: QuantityPublicationScope, work: () => Promise<T>, rawMembers: readonly QuantityPublicationScope[] = []): Promise<T> {
    const scope = quantityPublicationScopeSchema.parse(raw);
    const members = rawMembers.map(member => quantityPublicationScopeSchema.parse(member));
    if (members.length > 250 || new Set(members.map(key)).size !== members.length || members.some(member =>
      member.destinationKind !== scope.destinationKind || member.connectionId !== scope.connectionId
      || member.providerKey !== scope.providerKey || member.providerScopeType !== scope.providerScopeType || member.externalScopeId !== scope.externalScopeId)) {
      fail("PUBLICATION_GROUP_SCOPE_INVALID", "A reducing lifecycle requires exact distinct members from one destination.");
    }
    if (members.length && session.getStore()) fail("PUBLICATION_GROUP_NESTING_INVALID", "A reducing group cannot expand a provider capability.");
    if (session.getStore()) return this.run(scope, work);
    return this.execute(scope, null, work, async () => [], members);
  }

  private async execute<T>(scope: QuantityPublicationScope, claim: QuantityPublicationOutboxClaim | null,
    work: () => Promise<T>, resolveCurrentPlan?: () => Promise<Array<{ outboxId: string; quantity: number; scope: QuantityPublicationScope }>>,
    memberScopes: readonly QuantityPublicationScope[] = []): Promise<T> {
    // Catch-up restores quantity, not stale group metadata. Known members each get
    // their own resolvable obligation; the attempt still owns the entire group.
    const retainWork = async (connection: Client, runId: string | null, reason: string): Promise<void> => {
      await retainCatchupScopes(connection, memberScopes.length ? memberScopes : [scope], runId, reason, this.clock());
    };
    if (this.active >= this.maximumConcurrentOwners) {
      const backlogClient = await this.pool.connect();
      try { await retainWork(backlogClient, null, "admission_capacity_busy"); }
      finally { backlogClient.release(); }
      fail("PUBLICATION_ADMISSION_CAPACITY_BUSY", "Provider admission capacity is occupied; durable catch-up was retained.");
    }
    this.active += 1;
    let client: PoolClient | undefined; let locked = false; const lockedScopeKeys: string[] = []; let inTransaction = false;
    let discard: Error | undefined; let attemptId: string | null = null;
    try {
      const ownerToken = this.tokenFactory();
      client = await this.pool.connect();
      // TRY prevents pool owners from waiting indefinitely behind a cutover transaction.
      locked = (await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock_shared($1,0) AS acquired", [QUANTITY_PUBLICATION_LOCK_NAMESPACE],
      )).rows[0]?.acquired === true;
      if (!locked) {
        await retainWork(client, null, "publication_gate_busy");
        fail("QUANTITY_PUBLICATION_DRAIN_BUSY", "The publication gate is changing; durable catch-up was retained.");
      }
      for (const scopeKey of [...new Set([key(scope), ...memberScopes.map(key)])].sort()) {
        const acquired = (await client.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1,918420)) AS acquired", [scopeKey],
        )).rows[0]?.acquired === true;
        if (!acquired) {
          await retainWork(client, null, "publication_scope_busy");
          fail("PUBLICATION_SCOPE_BUSY", "Another exact-scope publisher is running; durable catch-up was retained.");
        }
        lockedScopeKeys.push(scopeKey);
      }
      await client.query("BEGIN"); inTransaction = true;
      const gate = (await client.query<{ epoch: string; activation_run_id: string | null }>(
        "SELECT epoch::text,activation_run_id::text FROM inventory.quantity_publication_gate WHERE singleton FOR SHARE",
      )).rows[0];
      if (!gate) fail("PUBLICATION_GATE_MISSING", "Quantity publication admission migration is missing.");
      if (claim) await this.validateOutbox(client, claim, gate.activation_run_id);
      if (!claim && gate.activation_run_id !== null) {
        await retainWork(client, gate.activation_run_id, "suppressed_quantity_write");
        await client.query("COMMIT"); inTransaction = false;
        fail("QUANTITY_PUBLICATION_SUPPRESSED", "Quantity publication is suppressed; current-state catch-up was retained.",
          { activationRunId: gate.activation_run_id, scope });
      }
      let planned: Array<{ outboxId: string; quantity: number; scope: QuantityPublicationScope }> = [];
      if (!claim) {
        const authority = (await client.query<{ authority: string }>(
          "SELECT authority FROM inventory.availability_runtime_authority WHERE singleton_key=true",
        )).rows[0];
        if (!authority) fail("PUBLICATION_AUTHORITY_MISSING", "Runtime publication authority is missing.");
        if (authority.authority === "canonical") {
          if (!resolveCurrentPlan) {
            await retainWork(client, null, "canonical_outbox_required");
            await client.query("COMMIT"); inTransaction = false;
            fail("PUBLICATION_CANONICAL_OWNER_REQUIRED", "Legacy quantity writes cannot bypass canonical publication authority.");
          }
          // Shared gate/scope SESSION locks remain held; planning owns its own bounded transaction.
          await client.query("COMMIT"); inTransaction = false;
          planned = await resolveCurrentPlan!();
          await client.query("BEGIN"); inTransaction = true;
          for (const selectedPlan of planned) {
          const selectedScope = selectedPlan.scope;
          const desired = (await client.query<{ desired_quantity: string }>(`SELECT o.desired_quantity::text
            FROM inventory.inventory_publication_outbox o
            JOIN inventory.availability_runtime_authority a ON a.activation_run_id=o.activation_run_id AND a.authority='canonical'
            JOIN inventory.availability_activation_runs r ON r.id=o.activation_run_id AND r.state='active'
            WHERE o.id=$1 AND o.publication_phase='full' AND o.destination_kind_snapshot=$2
            AND COALESCE(o.channel_connection_id_snapshot,o.dropship_store_connection_id_snapshot)=$3
            AND o.provider_key_snapshot=$4 AND o.provider_scope_type_snapshot=$5 AND o.external_scope_id_snapshot=$6
            AND o.external_inventory_item_id_snapshot=$7
            AND NOT EXISTS (SELECT 1 FROM inventory.inventory_publication_outbox newer WHERE
              newer.publication_target_id=o.publication_target_id AND newer.product_variant_id=o.product_variant_id
              AND newer.desired_revision>o.desired_revision)`,
          [id(selectedPlan.outboxId),selectedScope.destinationKind,selectedScope.connectionId,selectedScope.providerKey,selectedScope.providerScopeType,
            selectedScope.externalScopeId,selectedScope.externalInventoryItemId])).rows[0];
          if (!Number.isSafeInteger(selectedPlan.quantity) || selectedPlan.quantity < 0 || !desired || desired.desired_quantity !== String(selectedPlan.quantity)) {
            fail("PUBLICATION_CANONICAL_LISTING_PLAN_CHANGED", "Listing quantity is not backed by the current exact canonical desired revision.");
          }
          }
        }
      }
      const unresolved = (await client.query<{ id: string }>(`SELECT id::text FROM inventory.quantity_publication_attempts
        WHERE affected_scope_keys && $1::text[] AND state IN ('running','uncertain') LIMIT 1`, [lockedScopeKeys])).rows[0];
      if (unresolved) {
        await retainWork(client, gate.activation_run_id, "uncertain_prior_quantity_write");
        await client.query("COMMIT"); inTransaction = false;
        fail("PUBLICATION_PRIOR_OUTCOME_UNRESOLVED", "A prior provider quantity outcome requires reconciliation.", { attemptId: unresolved.id });
      }
      // Per-scope session lock serializes providers without holding a DB transaction during HTTP.
      attemptId = (await client.query<{ id: string }>(`INSERT INTO inventory.quantity_publication_attempts
        (owner_token,owner_kind,gate_epoch,scope_key,scope,outbox_id,state,started_at,planned_outbox_id,affected_scope_keys,planned_outbox_ids,affected_scopes)
        VALUES ($1,$2,$3,$4,$5,$6,'running',$7,$8,$9,$10,$11) RETURNING id::text`,
      [ownerToken, claim ? "outbox" : "legacy", gate.epoch, key(scope), scope, claim?.outboxId ?? null, now(this.clock()),
        planned[0]?.outboxId ?? null,lockedScopeKeys,planned.map(row => row.outboxId),
        JSON.stringify(lockedScopeKeys.map(scopeKey => [scope, ...memberScopes].find(member => key(member) === scopeKey)))])).rows[0].id;
      await client.query("COMMIT"); inTransaction = false;
      let result: T;
      try {
        result = await session.run({ scope, externalSku: claim?.externalSku ?? null, memberKeys: new Set(memberScopes.map(key)) }, work);
      } catch (error) {
        await client.query("BEGIN"); inTransaction = true;
        await client.query(`UPDATE inventory.quantity_publication_attempts SET state='uncertain',error_code=$3
          WHERE id=$1 AND owner_token=$2 AND state='running'`,
        [attemptId, ownerToken, error instanceof Error && "code" in error ? String(error.code) : "PROVIDER_OUTCOME_UNCERTAIN"]);
        await retainWork(client, gate.activation_run_id, "uncertain_provider_outcome");
        await client.query("COMMIT"); inTransaction = false;
        throw error;
      }
      const completed = await client.query(`UPDATE inventory.quantity_publication_attempts
        SET state='succeeded',completed_at=$3,outcome_hash=$4,resolution_basis='owner_completion'
        WHERE id=$1 AND owner_token=$2 AND state='running' RETURNING id`,
      [attemptId, ownerToken, now(this.clock()), hash(result ?? null)]);
      if (completed.rowCount !== 1) fail("PUBLICATION_COMPLETION_CONFLICT", "Provider completion conflicts with recorded terminal evidence.", { attemptId });
      return result;
    } catch (error) {
      if (client && inTransaction) {
        try { await client.query("ROLLBACK"); } catch (rollbackError) { discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)); }
      }
      if (client && !discard && attemptId === null && error instanceof Error
        && "code" in error && error.code === "INVENTORY_PUBLICATION_TARGET_BUSY") {
        await retainWork(client, null, "canonical_planner_target_busy");
      }
      // A durable running row intentionally remains unresolved if acknowledgement persistence fails.
      throw error;
    } finally {
      for (const scopeKey of lockedScopeKeys.reverse()) if (client) {
        try {
          if (!(await client.query<{ released: boolean }>("SELECT pg_advisory_unlock(hashtextextended($1,918420)) AS released", [scopeKey])).rows[0]?.released) {
            discard = new Error("Publication exact-scope session lock release was not confirmed.");
          }
        } catch (error) { discard = error instanceof Error ? error : new Error(String(error)); }
      }
      if (client && locked) {
        try {
          const released = (await client.query<{ released: boolean }>("SELECT pg_advisory_unlock_shared($1,0) AS released",
            [QUANTITY_PUBLICATION_LOCK_NAMESPACE])).rows[0]?.released;
          if (!released) discard = new Error("Publication shared session lock release was not confirmed.");
        } catch (error) { discard = error instanceof Error ? error : new Error(String(error)); }
      }
      client?.release(discard); this.active -= 1;
      if (discard) throw new QuantityPublicationAdmissionError("PUBLICATION_CONNECTION_CLEANUP_UNCERTAIN", discard.message, { attemptId });
    }
  }

  private async validateOutbox(client: Client, claim: QuantityPublicationOutboxClaim, suppressedRunId: string | null): Promise<void> {
    const row = (await client.query<Record<string, unknown>>(`SELECT outbox.*,run.state AS run_state
      FROM inventory.inventory_publication_outbox outbox JOIN inventory.availability_activation_runs run ON run.id=outbox.activation_run_id
      WHERE outbox.id=$1 AND outbox.lease_expires_at>$2
      AND (outbox.publication_phase<>'full' OR EXISTS (SELECT 1 FROM inventory.availability_runtime_authority authority
        WHERE authority.singleton_key=true AND authority.authority='canonical' AND authority.activation_run_id=outbox.activation_run_id))
      AND NOT EXISTS (SELECT 1 FROM inventory.inventory_publication_outbox newer
        WHERE newer.publication_target_id=outbox.publication_target_id AND newer.product_variant_id=outbox.product_variant_id
        AND newer.desired_revision>outbox.desired_revision)
      FOR SHARE OF outbox,run`, [id(claim.outboxId),now(this.clock())])).rows[0];
    const values: Array<[string, unknown]> = [["activation_run_id",claim.activationRunId],["publication_target_id",claim.publicationTargetId],
      ["product_variant_id",claim.productVariantId],["lease_token",claim.leaseToken],["desired_revision",claim.desiredRevision],
      ["desired_quantity",claim.desiredQuantity],["destination_kind_snapshot",claim.destinationKind],
      ["channel_connection_id_snapshot",claim.channelConnectionId],["dropship_store_connection_id_snapshot",claim.dropshipStoreConnectionId],
      ["provider_key_snapshot",claim.providerKey],["provider_scope_type_snapshot",claim.providerScopeType],
      ["external_scope_id_snapshot",claim.externalScopeId],["external_inventory_item_id_snapshot",claim.externalInventoryItemId]];
    if (!row || row.state !== "leased" || values.some(([field, expected]) =>
      expected === null ? row[field] !== null : String(row[field]) !== String(expected))) {
      fail("PUBLICATION_OUTBOX_AUTHORIZATION_INVALID", "Provider admission does not match a persisted current outbox lease.");
    }
    if (row.publication_phase === "conservative") {
      if (suppressedRunId !== claim.activationRunId || row.run_state !== "publishing") {
        fail("PUBLICATION_CONSERVATIVE_GATE_INVALID", "Conservative publication requires its durable suppressed run.");
      }
      if ((await client.query(`SELECT id FROM inventory.quantity_publication_attempts
        WHERE owner_kind='legacy' AND state IN ('running','uncertain') LIMIT 1`)).rows.length) {
        fail("PUBLICATION_LEGACY_DRAIN_UNRESOLVED", "Conservative publication waits for definitive prior legacy outcomes.");
      }
    } else if (row.publication_phase !== "full" || row.run_state !== "active") {
      fail("PUBLICATION_OUTBOX_PHASE_INVALID", "Only a current active full publication may run.");
    }
  }

  async listDue(limit: number): Promise<QuantityPublicationCatchup[]> {
    const client = await this.pool.connect();
    try { return (await client.query<{ id: string; revision: string; attempt_boundary_id: string; scope: unknown }>(`SELECT id::text,revision::text,attempt_boundary_id::text,scope
      FROM inventory.quantity_publication_catchup WHERE completed_revision<revision AND next_attempt_at<=$1
      AND NOT EXISTS (SELECT 1 FROM inventory.quantity_publication_gate WHERE activation_run_id IS NOT NULL)
      ORDER BY next_attempt_at,id LIMIT $2`, [now(this.clock()),limit])).rows.map(row => ({
      catchupId: row.id, revision: row.revision, attemptBoundaryId: row.attempt_boundary_id, scope: quantityPublicationScopeSchema.parse(row.scope) }));
    } finally { client.release(); }
  }
  async complete(claim: QuantityPublicationCatchup, evidence?: { outboxId: string }): Promise<boolean> {
    const client = await this.pool.connect();
    try { return (await client.query(`UPDATE inventory.quantity_publication_catchup SET completed_revision=$2,
      last_error_code=NULL,last_error_message=NULL WHERE id=$1 AND revision=$2 AND (
      EXISTS (SELECT 1 FROM inventory.quantity_publication_attempts a WHERE a.affected_scope_keys @> ARRAY[quantity_publication_catchup.scope_key]
        AND a.id>quantity_publication_catchup.attempt_boundary_id AND a.state='succeeded')
      OR EXISTS (SELECT 1 FROM inventory.inventory_publication_outbox o
        JOIN inventory.availability_runtime_authority auth ON auth.activation_run_id=o.activation_run_id AND auth.authority='canonical'
        JOIN inventory.availability_activation_runs run ON run.id=o.activation_run_id AND run.state='active'
        WHERE o.id=$3 AND o.publication_phase='full' AND o.state IN ('desired','queued','leased','acknowledged','verified','retryable')
        AND o.destination_kind_snapshot=quantity_publication_catchup.scope->>'destinationKind'
        AND COALESCE(o.channel_connection_id_snapshot,o.dropship_store_connection_id_snapshot)::text=quantity_publication_catchup.scope->>'connectionId'
        AND o.external_scope_id_snapshot=quantity_publication_catchup.scope->>'externalScopeId'
        AND o.provider_key_snapshot=quantity_publication_catchup.scope->>'providerKey'
        AND o.provider_scope_type_snapshot=quantity_publication_catchup.scope->>'providerScopeType'
        AND o.external_inventory_item_id_snapshot=quantity_publication_catchup.scope->>'externalInventoryItemId'
        AND NOT EXISTS (SELECT 1 FROM inventory.inventory_publication_outbox newer WHERE newer.publication_target_id=o.publication_target_id
          AND newer.product_variant_id=o.product_variant_id AND newer.desired_revision>o.desired_revision))) RETURNING id`,
      [id(claim.catchupId),id(claim.revision),evidence ? id(evidence.outboxId) : null])).rowCount === 1;
    } finally { client.release(); }
  }
  async fail(claim: QuantityPublicationCatchup, errorCode: string, message: string): Promise<void> {
    const client = await this.pool.connect();
    try { await client.query(`UPDATE inventory.quantity_publication_catchup SET next_attempt_at=$3::timestamptz+interval '1 minute',
      last_error_code=$4,last_error_message=$5 WHERE id=$1 AND revision=$2`,
    [id(claim.catchupId),id(claim.revision),now(this.clock()),errorCode.slice(0,200),message.slice(0,2000)]);
    } finally { client.release(); }
  }
}

/** Operator evidence attestation, NOT a provider-verified fact. Caller enforces inventory_planning.activate. */
export async function attestQuantityPublicationAttemptInsideTransaction(client: Client,
  input: QuantityPublicationRecovery & { actor: string; now: Date }): Promise<{ attemptId: string; basis: "operator_attestation"; replay: boolean }> {
  const { actor: inputActor, now: timestamp, ...command } = input;
  const parsed = quantityPublicationRecoverySchema.parse(command); const auditActor = actor(inputActor);
  await tryExclusive(client);
  const commandHash = hash({ ...parsed, actor: auditActor });
  const prior = (await client.query<{ command_hash: string }>(`SELECT command_hash FROM inventory.quantity_publication_attempt_resolutions
    WHERE idempotency_key=$1 OR attempt_id=$2`, [parsed.idempotencyKey,parsed.attemptId])).rows;
  if (prior.length) {
    if (prior.length !== 1 || prior[0].command_hash !== commandHash) fail("PUBLICATION_RECOVERY_REPLAY_CONFLICT", "Recovery evidence cannot be changed on replay.");
    return { attemptId: parsed.attemptId, basis: "operator_attestation", replay: true };
  }
  const attempt = (await client.query<{ state: string }>("SELECT state FROM inventory.quantity_publication_attempts WHERE id=$1 FOR UPDATE",
    [parsed.attemptId])).rows[0];
  if (!attempt || !["running","uncertain"].includes(attempt.state)) fail("PUBLICATION_RECOVERY_STATE_INVALID", "Only an unresolved provider attempt can be attested.");
  await client.query(`INSERT INTO inventory.quantity_publication_attempt_resolutions
    (attempt_id,idempotency_key,actor,reason,evidence_kind,terminal_outcome,evidence_reference,evidence_hash,command_hash,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  [parsed.attemptId,parsed.idempotencyKey,auditActor,parsed.reason,parsed.evidenceKind,parsed.terminalOutcome,
    parsed.evidenceReference,parsed.evidenceHash,commandHash,now(timestamp)]);
  await client.query(`UPDATE inventory.quantity_publication_attempts SET state='resolved',completed_at=$2,
    outcome_hash=$3,resolution_basis='operator_attestation' WHERE id=$1`, [parsed.attemptId,now(timestamp),commandHash]);
  return { attemptId: parsed.attemptId, basis: "operator_attestation", replay: false };
}
