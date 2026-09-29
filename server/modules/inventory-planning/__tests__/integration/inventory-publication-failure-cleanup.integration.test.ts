import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql, cutoverCompositionSeedSql, cutoverCompositionChannelSeedSql,
  installCutoverCompositionMigrations, seedCompositionReviewedDryRun } from "../fixtures/inventory-cutover-composition-database.fixture";
import { installCutoverAdmissionFixturePrerequisites } from "../fixtures/inventory-cutover-admission.fixture";
import { installQuantityCutoverFixture, saveCompositionQuantityOpening } from "../fixtures/inventory-quantity-cutover.fixture";
import { InventoryAvailabilityActivationService } from "../../application/inventory-availability-activation.service";
import { PostgresInventoryAvailabilityActivationRepository } from "../../infrastructure/inventory-availability-activation.repository";
import { PostgresInventoryPublicationOutboxRepository } from "../../infrastructure/inventory-publication-outbox.repository";
import { InventoryPublicationOutboxService } from "../../application/inventory-publication-outbox.service";
import { InventoryPublicationTransportRegistry, InventoryPublicationTransportError } from "../../application/inventory-publication-transport";
import { PostgresQuantityPublicationAdmission } from "../../infrastructure/quantity-publication-admission.repository";

vi.mock("../../../../db", () => ({ pool: {} }));
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;

dbDescribe.sequential("publication failure cleanup with real admission and publication guards", () => {
  let database: InventoryCutoverTestDatabase;
  let now: Date;
  let runId: string;
  let outbox: PostgresInventoryPublicationOutboxRepository;
  let activation: InventoryAvailabilityActivationService;

  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    await installCutoverCompositionMigrations(database.pool);
    await database.pool.query(cutoverCompositionSeedSql);
    await database.pool.query(cutoverCompositionChannelSeedSql);
    await installCutoverAdmissionFixturePrerequisites(database.pool);
    for (const file of ["236_inventory_cutover_admission.sql", "240_inventory_cutover_verified_opening.sql"]) {
      await database.pool.query(readFileSync(resolve(process.cwd(), "migrations", file), "utf8"));
    }
    await installQuantityCutoverFixture(database.pool);
    await saveCompositionQuantityOpening(database.pool);
    const dryRun = await seedCompositionReviewedDryRun(database.pool);
    now = new Date(Date.parse(dryRun.completedAt) + 10);
    activation = new InventoryAvailabilityActivationService(new PostgresInventoryAvailabilityActivationRepository(database.pool), { now: () => now });
    const prepared = await activation.prepare({ sourceDryRunId: dryRun.activationRunId,
      expectedDryRunResultHash: dryRun.resultHash, idempotencyKey: "cleanup-prepare",
      reason: "Prove failed publication cleanup without changing inventory" }, "operator");
    runId = prepared.activationRunId;
    expect(prepared.state).toBe("publishing");
    outbox = new PostgresInventoryPublicationOutboxRepository(database.pool);
  }, 30_000);
  afterEach(async () => { await database?.close(); });

  async function claim() {
    const claims = await outbox.claimDue({ batchSize: 25, leaseSeconds: 60, leaseToken: "test-worker", now });
    expect(claims.length).toBeGreaterThan(0);
    return claims;
  }
  const permanentFailure = () => ({ errorClass: "TEST_PROVIDER_REJECTED", errorMessage: "Definitive test rejection",
    retryable: false, completedAt: now });
  async function state() {
    return (await database.pool.query(`SELECT run.state, authority.authority,
      configured_freeze.released_at IS NOT NULL AS released, gate.activation_run_id::text AS gate
      FROM inventory.availability_activation_runs run
      JOIN inventory.availability_activation_freezes configured_freeze ON configured_freeze.activation_run_id=run.id
      CROSS JOIN inventory.availability_runtime_authority authority
      CROSS JOIN inventory.quantity_publication_gate gate WHERE run.id=$1`, [runId])).rows[0];
  }
  async function expectCleaned() {
    expect(await state()).toEqual({ state: "failed", authority: "legacy", released: true, gate: null });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.inventory_publication_outbox WHERE state='leased'")).rows[0].count).toBe(0);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.quantity_publication_catchup WHERE completed_revision<revision")).rows[0].count).toBe(1);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.availability_activation_events WHERE activation_run_id=$1 AND to_state='failed'", [runId])).rows[0].count).toBe(1);
  }
  async function addSecondRevision() {
    // Two queued revisions reproduce an outstanding lease alongside a permanent
    // failure; no provider call or fabricated success is used to set up the test.
    await database.pool.query(`INSERT INTO inventory.inventory_publication_outbox (
      activation_run_id,publication_target_id,product_variant_id,desired_revision,desired_quantity,
      publication_phase,publication_target_revision_snapshot,channel_id_snapshot,provider_key_snapshot,
      destination_kind_snapshot,channel_connection_id_snapshot,dropship_store_connection_id_snapshot,
      provider_scope_type_snapshot,external_scope_id_snapshot,external_inventory_item_id_snapshot,
      external_sku_snapshot,state,idempotency_key,payload_hash,available_at)
      SELECT activation_run_id,publication_target_id,product_variant_id,desired_revision+1,desired_quantity,
      publication_phase,publication_target_revision_snapshot,channel_id_snapshot,provider_key_snapshot,
      destination_kind_snapshot,channel_connection_id_snapshot,dropship_store_connection_id_snapshot,
      provider_scope_type_snapshot,external_scope_id_snapshot,external_inventory_item_id_snapshot,
      external_sku_snapshot,'desired','second-test-revision',payload_hash,available_at
      FROM inventory.inventory_publication_outbox WHERE activation_run_id=$1`, [runId]);
    await database.pool.query("UPDATE inventory.inventory_publication_outbox SET state='queued' WHERE state='desired'");
  }

  it("persists a failure under the provider lock, then releases freeze/gate through the admitted owner", async () => {
    const stockBefore = (await database.pool.query("SELECT * FROM inventory.inventory_levels ORDER BY id")).rows;
    await expect(database.pool.query("UPDATE inventory.availability_activation_freezes SET released_at=now() WHERE activation_run_id=$1", [runId]))
      .rejects.toMatchObject({ code: "55000", message: "CUTOVER_EXCLUSIVE_ADMISSION_REQUIRED" });
    const [work] = await claim();
    await outbox.runIfCurrent(work!, () => outbox.recordFailure(work!, permanentFailure()));
    expect(await state()).toEqual({ state: "publishing", authority: "legacy", released: false, gate: runId });
    expect((await database.pool.query("SELECT state,lease_token FROM inventory.inventory_publication_outbox")).rows)
      .toEqual([{ state: "dead_letter", lease_token: null }]);
    await outbox.finalizeFailedRuns(now);
    await expectCleaned();
    await outbox.finalizeFailedRuns(now);
    await expectCleaned();
    expect((await database.pool.query("SELECT * FROM inventory.inventory_levels ORDER BY id")).rows).toEqual(stockBefore);
  });

  it("rolls back failed cleanup without undoing the already committed provider result, then retries concurrently", async () => {
    const [work] = await claim();
    await outbox.recordFailure(work!, permanentFailure());
    await database.pool.query(`CREATE FUNCTION inventory.test_cleanup_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected cleanup failure'; END $$;
      CREATE TRIGGER zz_test_cleanup_failure BEFORE UPDATE ON inventory.availability_activation_freezes
      FOR EACH ROW EXECUTE FUNCTION inventory.test_cleanup_failure()`);
    await expect(outbox.finalizeFailedRuns(now)).rejects.toThrow("injected cleanup failure");
    expect(await state()).toEqual({ state: "publishing", authority: "legacy", released: false, gate: runId });
    expect((await database.pool.query("SELECT state,lease_token FROM inventory.inventory_publication_outbox")).rows)
      .toEqual([{ state: "dead_letter", lease_token: null }]);
    expect((await database.pool.query("SELECT * FROM inventory.quantity_publication_catchup")).rowCount).toBe(0);
    await database.pool.query("DROP TRIGGER zz_test_cleanup_failure ON inventory.availability_activation_freezes; DROP FUNCTION inventory.test_cleanup_failure()");
    await Promise.all([outbox.finalizeFailedRuns(now), outbox.finalizeFailedRuns(now)]);
    await expectCleaned();
  });

  it("recovers the stopped run with a dead letter plus an expired lease, retaining the uncertainty audit", async () => {
    await addSecondRevision();
    const [failed, expired] = await claim();
    await outbox.recordFailure(failed!, permanentFailure());
    now = new Date(now.getTime() + 61_000);
    await outbox.finalizeFailedRuns(now);
    await expectCleaned();
    expect((await database.pool.query("SELECT error_class,outcome FROM inventory.inventory_publication_attempts WHERE outbox_id=$1", [expired!.outboxId])).rows)
      .toEqual([{ error_class: "LEASE_EXPIRED", outcome: "cancelled" }]);
    expect(await outbox.recordFailure(expired!, permanentFailure())).toBe(false);
    await expectCleaned();
  });

  it("does not retire an expired lease while its provider lock is still held", async () => {
    await addSecondRevision();
    const [failed, owned] = await claim();
    await outbox.recordFailure(failed!, permanentFailure());
    now = new Date(now.getTime() + 61_000);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const worker = outbox.runIfCurrent(owned!, async () => { entered(); await pending; });
    await started;
    try {
      await outbox.finalizeFailedRuns(now);
      expect(await state()).toEqual({ state: "publishing", authority: "legacy", released: false, gate: runId });
      expect((await database.pool.query("SELECT state FROM inventory.inventory_publication_outbox WHERE id=$1", [owned!.outboxId])).rows[0].state).toBe("leased");
    } finally { release(); await worker; }
    await outbox.finalizeFailedRuns(now);
    await expectCleaned();
  });

  it("aborts expired unowned work but refuses a still-current worker lease", async () => {
    await claim();
    const request = { activationRunId: runId, idempotencyKey: "cleanup-abort", reason: "Stop the failed preparation" };
    await expect(activation.abort(request, "operator")).rejects.toMatchObject({ code: "ACTIVATION_PROVIDER_WRITE_IN_FLIGHT" });
    now = new Date(now.getTime() + 61_000);
    await expect(activation.abort(request, "operator")).resolves.toMatchObject({ state: "failed", runtimeAuthority: "legacy", alreadyApplied: false });
    await expect(activation.abort(request, "operator")).resolves.toMatchObject({ alreadyApplied: true });
    await expectCleaned();
  });

  it("cleans up through the complete worker after provider locks are released", async () => {
    const registry = new InventoryPublicationTransportRegistry();
    const send = vi.fn(async () => { throw new InventoryPublicationTransportError("TEST_PROVIDER_REJECTED", "Test rejection", false); });
    registry.register({ destinationKind: "channel_connection", providerKey: "shopify", supportedScopeTypes: ["location"],
      publishAbsolute: send, readAbsolute: vi.fn() });
    const service = new InventoryPublicationOutboxService(outbox, registry, { now: () => now }, () => "worker-cleanup-test",
      new PostgresQuantityPublicationAdmission(database.pool, () => now));
    expect(await service.processDue()).toEqual({ claimed: 1, failed: 1, verified: 0, superseded: 0 });
    expect(send).toHaveBeenCalledOnce();
    await expectCleaned();
  });
});
