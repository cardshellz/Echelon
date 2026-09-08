import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql, cutoverCompositionSeedSql, installCutoverCompositionMigrations, seedCompositionReviewedDryRun } from "../fixtures/inventory-cutover-composition-database.fixture";
import { PostgresQuantityPublicationAdmission, suppressQuantityPublicationInsideTransaction,
  captureQuantityPublicationDrainInsideTransaction, releaseQuantityPublicationSuppressionInsideTransaction,
  attestQuantityPublicationAttemptInsideTransaction } from "../../infrastructure/quantity-publication-admission.repository";
import { QuantityPublicationCatchupService } from "../../application/quantity-publication-admission.port";
import type { QuantityPublicationScope } from "../../domain/quantity-publication-admission";
import { createProviderRequestDeadline } from "../../../channels/provider-request-limits";

vi.mock("../../../../db", () => ({ pool: {} }));
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = databaseUrl && disposable ? describe : describe.skip;

dbDescribe.sequential("durable external quantity admission with actual migration237", () => {
  let database: InventoryCutoverTestDatabase;
  let runId: string;
  let sequence = 0;
  const clock = () => new Date("2026-09-08T15:00:00.000Z");
  let admission: PostgresQuantityPublicationAdmission;
  const scope = (): QuantityPublicationScope => ({ destinationKind: "channel_connection", connectionId: 1,
    providerKey: "ebay", providerScopeType: "account", externalScopeId: "verified-account",
    externalInventoryItemId: `SKU-${++sequence}`, productId: 20, productVariantId: 101 });
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, cutoverCompositionBaseSql);
    await installCutoverCompositionMigrations(database.pool);
    await database.pool.query(cutoverCompositionSeedSql);
    runId = (await seedCompositionReviewedDryRun(database.pool)).activationRunId;
    admission = new PostgresQuantityPublicationAdmission(database.pool, clock);
  }, 30000);
  afterAll(async () => { await database?.close(); });
  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await database.pool.connect();
    try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  const suppress = () => transaction(client => suppressQuantityPublicationInsideTransaction(client,
    { activationRunId: runId, actor: "operator", now: clock() }));
  const release = () => transaction(client => releaseQuantityPublicationSuppressionInsideTransaction(client,
    { activationRunId: runId, outcome: "aborted", actor: "operator", now: clock() }));

  it("journals before mocked provider I/O without an open database transaction and drains only after completion", async () => {
    const target = scope();
    await admission.run(target, async () => {
      const rows = (await database.pool.query("SELECT state FROM inventory.quantity_publication_attempts WHERE scope->>'externalInventoryItemId'=$1",
        [target.externalInventoryItemId])).rows;
      expect(rows).toEqual([{ state: "running" }]);
      const transactions = (await database.pool.query(`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND state='idle in transaction'`)).rows[0].count;
      expect(transactions).toBe(0);
      await expect(suppress()).rejects.toMatchObject({ code: "QUANTITY_PUBLICATION_DRAIN_BUSY" });
      return { providerRequest: "confirmed" };
    });
    const proof = await suppress();
    expect(proof.suppressed).toBe(true);
    expect(proof.unresolvedAttempts).toEqual([]);
    expect(proof.latestAttemptsByScope.find(row => row.scope.externalInventoryItemId === target.externalInventoryItemId))
      .toMatchObject({ owner: "legacy", outboxId: null, resolutionBasis: "owner_completion" });
    await release();
  });

  it("coalesces duplicate suppressed events durably, keeps them on abort, and replans current state on restart", async () => {
    const target = scope(); const provider = vi.fn();
    await suppress();
    await expect(admission.run(target, provider)).rejects.toMatchObject({ code: "QUANTITY_PUBLICATION_SUPPRESSED" });
    await expect(admission.run(target, provider)).rejects.toMatchObject({ code: "QUANTITY_PUBLICATION_SUPPRESSED" });
    expect(provider).not.toHaveBeenCalled();
    const rows = (await database.pool.query(`SELECT revision::text,completed_revision::text FROM inventory.quantity_publication_catchup
      WHERE scope->>'externalInventoryItemId'=$1`, [target.externalInventoryItemId])).rows;
    expect(rows).toEqual([{ revision: "2", completed_revision: "0" }]);
    expect(await admission.listDue(25)).toEqual([]);
    await release();
    const restarted = new PostgresQuantityPublicationAdmission(database.pool, clock);
    const currentPlanner = vi.fn(async (currentScope: QuantityPublicationScope) => {
      await restarted.run(currentScope, async () => ({ quantityFromCurrentState: 14 }));
    });
    await new QuantityPublicationCatchupService(restarted, currentPlanner).processDue();
    expect(currentPlanner).toHaveBeenCalledWith(target, expect.objectContaining({ scope: target, revision: "2" }));
    expect((await restarted.listDue(25)).some(row => row.scope.externalInventoryItemId === target.externalInventoryItemId)).toBe(false);
  });

  it("preserves a new coalesced event arriving during catch-up instead of marking its newer revision complete", async () => {
    const target = scope();
    await suppress(); await expect(admission.run(target, async () => undefined)).rejects.toThrow(); await release();
    const claim = (await admission.listDue(25)).find(row => row.scope.externalInventoryItemId === target.externalInventoryItemId)!;
    await suppress(); await expect(admission.run(target, async () => undefined)).rejects.toThrow(); await release();
    expect(await admission.complete(claim)).toBe(false);
    expect((await admission.listDue(25)).find(row => row.catchupId === claim.catchupId)?.revision).not.toBe(claim.revision);
  });

  it("retains uncertain provider outcomes across suppression and requires an audited operator attestation, not elapsed time", async () => {
    const target = scope();
    await expect(admission.run(target, async () => { throw new Error("Connection ended after provider may have applied request"); })).rejects.toThrow();
    const proof = await suppress();
    const attempt = proof.unresolvedAttempts.find(row => row.scope.externalInventoryItemId === target.externalInventoryItemId)!;
    expect(attempt.state).toBe("uncertain");
    const repeated = await transaction(client => captureQuantityPublicationDrainInsideTransaction(client, runId));
    expect(repeated).toEqual(proof);
    const command = { attemptId: attempt.attemptId, idempotencyKey: "provider-terminal-review-1", actor: "operator",
      reason: "Reviewed provider terminal request record and stopped owner process",
      evidenceKind: "provider_terminal_request_record" as const, terminalOutcome: "completed" as const,
      evidenceReference: "provider-support-request-123", evidenceHash: "a".repeat(64), now: clock() };
    expect(await transaction(client => attestQuantityPublicationAttemptInsideTransaction(client, command)))
      .toMatchObject({ basis: "operator_attestation", replay: false });
    expect(await transaction(client => attestQuantityPublicationAttemptInsideTransaction(client, command)))
      .toMatchObject({ replay: true });
    await expect(transaction(client => attestQuantityPublicationAttemptInsideTransaction(client,
      { ...command, terminalOutcome: "not_sent" }))).rejects.toMatchObject({ code: "PUBLICATION_RECOVERY_REPLAY_CONFLICT" });
    await expect(database.pool.query("DELETE FROM inventory.quantity_publication_attempt_resolutions WHERE attempt_id=$1", [attempt.attemptId]))
      .rejects.toMatchObject({ code: "23514" });
    expect((await suppress()).unresolvedAttempts.some(row => row.attemptId === attempt.attemptId)).toBe(false);
    await release();
  });

  it("does not mistake remote success followed by lost local acknowledgement for a completed provider attempt", async () => {
    let failCompletion = true;
    const pool = { connect: async () => {
      const client = await database.pool.connect();
      return new Proxy(client, { get(target, property) {
        if (property === "query") return async (sql: string, args?: unknown[]) => {
          if (failCompletion && sql.includes("SET state='succeeded'")) { failCompletion = false; throw new Error("Lost completion persistence"); }
          return client.query(sql, args);
        };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
    } };
    const target = scope();
    const provider = vi.fn(async () => ({ applied: true }));
    await expect(new PostgresQuantityPublicationAdmission(pool, clock).run(target, provider)).rejects.toThrow("Lost completion persistence");
    expect(provider).toHaveBeenCalledOnce();
    const proof = await suppress();
    const attempt = proof.unresolvedAttempts.find(row => row.scope.externalInventoryItemId === target.externalInventoryItemId)!;
    expect(attempt.state).toBe("running");
    await transaction(client => attestQuantityPublicationAttemptInsideTransaction(client, { attemptId: attempt.attemptId,
      idempotencyKey: "ack-lost-reviewed", reason: "Owner request completion was confirmed against terminal provider record",
      evidenceKind: "provider_terminal_request_record", terminalOutcome: "completed", evidenceReference: "terminal-456",
      evidenceHash: "b".repeat(64), actor: "operator", now: clock() }));
    await release();
  });

  it("serializes exact-scope writes and retains the duplicate as catch-up", async () => {
    const target = scope(); const duplicate = vi.fn();
    let entered!: () => void; let releaseOwner!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const releasePromise = new Promise<void>(resolve => { releaseOwner = resolve; });
    const first = admission.run(target, async () => { entered(); await releasePromise; });
    await enteredPromise;
    try {
      await expect(new PostgresQuantityPublicationAdmission(database.pool, clock).run(target, duplicate))
        .rejects.toMatchObject({ code: "PUBLICATION_SCOPE_BUSY" });
    } finally { releaseOwner(); await first; }
    expect(duplicate).not.toHaveBeenCalled();
    expect((await admission.listDue(25)).some(row => row.scope.externalInventoryItemId === target.externalInventoryItemId)).toBe(true);
  });

  it("does not acknowledge a skipped callback and preserves proof across a lost catch-up completion", async () => {
    const target = scope();
    await suppress(); await expect(admission.run(target, async () => undefined)).rejects.toThrow(); await release();
    const claim = (await admission.listDue(100)).find(row => row.scope.externalInventoryItemId === target.externalInventoryItemId)!;
    expect(await admission.complete(claim)).toBe(false);
    await admission.run(target, async () => ({ currentQuantity: 14 }));
    // Simulate a process restart after provider success but before catch-up acknowledgement.
    const restarted = new PostgresQuantityPublicationAdmission(database.pool, clock);
    const replay = (await restarted.listDue(100)).find(row => row.catchupId === claim.catchupId)!;
    expect(replay.attemptBoundaryId).toBe(claim.attemptBoundaryId);
    expect(await restarted.complete(replay)).toBe(true);
  });

  it("acknowledges exact delivered work before calling an unrelated failing planner after restart", async () => {
    const target = scope();
    await suppress(); await expect(admission.run(target, async () => undefined)).rejects.toThrow(); await release();
    const claim = (await admission.listDue(100)).find(row => row.scope.externalInventoryItemId === target.externalInventoryItemId)!;
    await admission.run(target, async () => ({ currentQuantity: 14 }));
    const restarted = new PostgresQuantityPublicationAdmission(database.pool, clock);
    const replan = vi.fn(async () => { throw new Error("Unrelated marketplace resolver is broken"); });
    const fail = vi.fn(restarted.fail.bind(restarted));
    const service = new QuantityPublicationCatchupService({ listDue: async () => [claim], complete: restarted.complete.bind(restarted), fail }, replan);
    expect(await service.processDue()).toEqual({ completed: 1, failed: 0 });
    expect(replan).not.toHaveBeenCalled(); expect(fail).not.toHaveBeenCalled();
    expect(await restarted.complete(claim)).toBe(false); // Already completed is not a newly completed revision.
  });

  it("does not let a forged boundary or different provider scope acknowledge a delivered revision", async () => {
    const target = scope();
    await suppress(); await expect(admission.run(target, async () => undefined)).rejects.toThrow(); await release();
    const claim = (await admission.listDue(100)).find(row => row.scope.externalInventoryItemId === target.externalInventoryItemId)!;
    await admission.run(target, async () => ({ currentQuantity: 14 }));
    expect(await admission.complete({ ...claim, attemptBoundaryId: String(BigInt(claim.attemptBoundaryId) + 1n) })).toBe(false);
    expect(await admission.complete({ ...claim, scope: { ...claim.scope, externalScopeId: "different-account" } })).toBe(false);
    expect(await admission.complete(claim)).toBe(true);
  });

  it("does not reuse an older success hidden by a newer running or uncertain attempt", async () => {
    const target = scope();
    await suppress(); await expect(admission.run(target, async () => undefined)).rejects.toThrow(); await release();
    const claim = (await admission.listDue(100)).find(row => row.scope.externalInventoryItemId === target.externalInventoryItemId)!;
    await admission.run(target, async () => ({ currentQuantity: 14 }));
    // A real provider-owner completion persistence failure leaves the new
    // running journal row durable without rewriting the pending catch-up row.
    const lostAckPool = { connect: async () => {
      const client = await database.pool.connect();
      return new Proxy(client, { get(_target, property) {
        if (property === "query") return async (sql: string, args?: unknown[]) => {
          if (sql.includes("SET state='succeeded'")) throw new Error("Lost new acknowledgement");
          return client.query(sql, args);
        };
        const value = Reflect.get(client, property); return typeof value === "function" ? value.bind(client) : value;
      } });
    } };
    await expect(new PostgresQuantityPublicationAdmission(lostAckPool, clock).run(target, async () => ({ currentQuantity: 13 }))).rejects.toThrow("Lost new acknowledgement");
    expect(await admission.complete(claim)).toBe(false);
    // Valid persisted uncertainty is also insufficient; this fixture transition
    // intentionally retains the same old pending boundary to test proof choice.
    await database.pool.query(`UPDATE inventory.quantity_publication_attempts SET state='uncertain'
      WHERE scope->>'externalInventoryItemId'=$1 AND state='running'`, [target.externalInventoryItemId]);
    expect(await admission.complete(claim)).toBe(false);
  });

  it("refuses success during suppression and from a previous publication gate epoch", async () => {
    const target = scope();
    await suppress(); await expect(admission.run(target, async () => undefined)).rejects.toThrow(); await release();
    const claim = (await admission.listDue(100)).find(row => row.scope.externalInventoryItemId === target.externalInventoryItemId)!;
    await admission.run(target, async () => ({ currentQuantity: 14 }));
    await suppress(); expect(await admission.complete(claim)).toBe(false);
    await release(); expect(await admission.complete(claim)).toBe(false);
    await admission.run(target, async () => ({ currentQuantity: 13 }));
    expect(await admission.complete(claim)).toBe(true);
  });

  it("holds off completion while a newer exact-scope provider request is still running", async () => {
    const target = scope();
    await suppress(); await expect(admission.run(target, async () => undefined)).rejects.toThrow(); await release();
    const claim = (await admission.listDue(100)).find(row => row.scope.externalInventoryItemId === target.externalInventoryItemId)!;
    await admission.run(target, async () => ({ currentQuantity: 14 }));
    let entered!: () => void; let finish!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const finishPromise = new Promise<void>(resolve => { finish = resolve; });
    const running = admission.run(target, async () => { entered(); await finishPromise; return { currentQuantity: 13 }; });
    await enteredPromise;
    try { expect(await admission.complete(claim)).toBe(false); }
    finally { finish(); await running; }
    expect(await admission.complete(claim)).toBe(true);
  });

  it("journals group member lineage and blocks a member after an uncertain group request", async () => {
    const members = [scope(), scope()]; const group = { ...scope(), externalInventoryItemId: `group:test-${sequence}` };
    await expect(admission.runListingGroup(group, members, vi.fn(), async () => { throw new Error("Unknown group publish outcome"); })).rejects.toThrow();
    const publish = vi.fn();
    await expect(admission.run(members[1], publish)).rejects.toMatchObject({ code: "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED" });
    expect(publish).not.toHaveBeenCalled();
    const proof = await suppress();
    const attempt = proof.unresolvedAttempts.find(row => row.scope.externalInventoryItemId === group.externalInventoryItemId)!;
    for (const member of members) expect(proof.latestAttemptsByScope.find(row => row.scope.externalInventoryItemId === member.externalInventoryItemId))
      .toMatchObject({ attemptId: attempt.attemptId, outboxId: null });
    await transaction(client => attestQuantityPublicationAttemptInsideTransaction(client, { attemptId: attempt.attemptId,
      idempotencyKey: `group-terminal-${sequence}`, reason: "Confirmed the group provider request terminated before retry",
      evidenceKind: "owner_process_and_request_termination_record", terminalOutcome: "not_sent", evidenceReference: "terminal-group",
      evidenceHash: "c".repeat(64), actor: "operator", now: clock() }));
    await release();
    const due = await admission.listDue(100);
    for (const member of members) expect(due.some(row => row.scope.externalInventoryItemId === member.externalInventoryItemId)).toBe(true);
    expect(due.some(row => row.scope.externalInventoryItemId === group.externalInventoryItemId)).toBe(false);
  });

  it("returns bounded owner capacity after a token factory failure", async () => {
    let first = true;
    const owner = new PostgresQuantityPublicationAdmission(database.pool, clock, () => {
      if (first) { first = false; throw new Error("Entropy source unavailable"); }
      return "66666666-6666-4666-8666-666666666666";
    }, 1);
    await expect(owner.run(scope(), async () => undefined)).rejects.toThrow("Entropy source unavailable");
    await expect(owner.run(scope(), async () => "done")).resolves.toBe("done");
  });

  it("does not journal preflight resolver failure within a non-admitting catch-up scope", async () => {
    const target = scope();
    await expect(admission.withLegacyCatchupScope(target, async () => { throw new Error("Missing exact mapping"); })).rejects.toThrow("Missing exact mapping");
    expect((await database.pool.query("SELECT id FROM inventory.quantity_publication_attempts WHERE scope->>'externalInventoryItemId'=$1",
      [target.externalInventoryItemId])).rows).toEqual([]);
  });

  it("rejects mismatched actual publication before creating an attempt or calling the provider", async () => {
    const target = scope(); const other = scope(); const provider = vi.fn();
    await expect(admission.withLegacyCatchupScope(target, () => admission.run(other, provider)))
      .rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_SCOPE_MISMATCH" });
    expect(provider).not.toHaveBeenCalled();
    expect((await database.pool.query("SELECT id FROM inventory.quantity_publication_attempts WHERE scope->>'externalInventoryItemId'=ANY($1)",
      [[target.externalInventoryItemId, other.externalInventoryItemId]])).rows).toEqual([]);
  });

  it("records exactly the actual provider owner, never a synthetic outer catch-up attempt", async () => {
    const target = scope(); const provider = vi.fn(async () => ({ quantity: 14 }));
    await admission.withLegacyCatchupScope(target, () => admission.run(target, provider));
    expect(provider).toHaveBeenCalledOnce();
    expect((await database.pool.query("SELECT state,resolution_basis FROM inventory.quantity_publication_attempts WHERE scope->>'externalInventoryItemId'=$1",
      [target.externalInventoryItemId])).rows).toEqual([{ state: "succeeded", resolution_basis: "owner_completion" }]);
  });

  it("retains a real uncertain HTTP outcome normally inside the non-admitting expectation", async () => {
    const target = scope(); const provider = vi.fn(async () => { throw new Error("Lost actual HTTP response"); });
    await expect(admission.withLegacyCatchupScope(target, () => admission.run(target, provider))).rejects.toThrow("Lost actual HTTP response");
    expect(provider).toHaveBeenCalledOnce();
    expect((await database.pool.query("SELECT state FROM inventory.quantity_publication_attempts WHERE scope->>'externalInventoryItemId'=$1",
      [target.externalInventoryItemId])).rows).toEqual([{ state: "uncertain" }]);
    expect((await admission.listDue(100)).some(claim => claim.scope.externalInventoryItemId === target.externalInventoryItemId)).toBe(true);
  });

  it("retains timeout uncertainty and releases session ownership without claiming remote cancellation", async () => {
    const target = scope();
    await expect(admission.run(target, async () => {
      const deadline = createProviderRequestDeadline(5);
      try { await new Promise<void>((_resolve, reject) => deadline.signal.addEventListener("abort", () => reject(deadline.signal.reason), { once: true })); }
      finally { deadline.dispose(); }
    })).rejects.toMatchObject({ code: "QUANTITY_PROVIDER_REQUEST_TIMEOUT", outcome: "uncertain" });
    const proof = await suppress();
    const attempt = proof.unresolvedAttempts.find(row => row.scope.externalInventoryItemId === target.externalInventoryItemId)!;
    expect(attempt.state).toBe("uncertain");
    await transaction(client => attestQuantityPublicationAttemptInsideTransaction(client, { attemptId: attempt.attemptId,
      idempotencyKey: "timeout-terminal-review", reason: "Reviewed definitive provider request outcome after local abort",
      evidenceKind: "provider_terminal_request_record", terminalOutcome: "completed", evidenceReference: "provider-terminal-timeout",
      evidenceHash: "d".repeat(64), actor: "operator", now: clock() }));
    await release();
  });

  it("rejects legacy retry when authority switches after expectation capture but before actual admission", async () => {
    // Last case in this fixture: the real authority trigger intentionally forbids
    // returning to legacy. Only this suite's disposable database is changed.
    const target = scope(); const provider = vi.fn();
    await expect(admission.withLegacyCatchupScope(target, async () => {
      const activation = (await database.pool.query<{ id: string }>(`INSERT INTO inventory.availability_activation_runs
        (mode,state,request_hash,expected_catalog_input_hash,expected_catalog_result_hash,captured_catalog_input_hash,
         captured_catalog_result_hash,evidence_payload,idempotency_key,reason,requested_by,started_at,source_dry_run_id)
        SELECT 'activation','activating',request_hash,expected_catalog_input_hash,expected_catalog_result_hash,
          captured_catalog_input_hash,captured_catalog_result_hash,evidence_payload,'scope-expectation-authority-change',
          'Test authority changed before actual admission','operator',started_at,id
        FROM inventory.availability_activation_runs WHERE id=$1 RETURNING id::text`, [runId])).rows[0].id;
      await database.pool.query(`UPDATE inventory.availability_runtime_authority SET authority='canonical',activation_run_id=$1,
        revision=revision+1,changed_by='operator',change_reason='Test authority race' WHERE singleton_key=true`, [activation]);
      await database.pool.query("UPDATE inventory.availability_activation_runs SET state='active',runtime_authority_changed=true WHERE id=$1", [activation]);
      return admission.run(target, provider);
    })).rejects.toMatchObject({ code: "PUBLICATION_AUTHORITY_CHANGED" });
    expect(provider).not.toHaveBeenCalled();
    expect((await database.pool.query("SELECT id FROM inventory.quantity_publication_attempts WHERE scope->>'externalInventoryItemId'=$1",
      [target.externalInventoryItemId])).rows).toEqual([]);
  });
});
